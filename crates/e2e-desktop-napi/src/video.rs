//! Video of one window through ScreenCaptureKit: a stream on a filter that
//! holds that window alone (`initWithDesktopIndependentWindow`), written to
//! an MPEG-4 file with H.264 by an `SCRecordingOutput`. The filter follows
//! the window, not a rectangle of the screen: a window that moves stays in
//! the frame, and one that covers it is not recorded. The window is drawn
//! as the app drew it, so a secure field shows its bullets and nothing is
//! masked. `SCRecordingOutput` came in macOS 15; on an older macOS video is
//! refused.

use crate::failure::{Failure, Outcome, codes};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_screen_capture_kit::{
    SCContentFilter, SCRecordingOutput, SCRecordingOutputConfiguration, SCRecordingOutputDelegate, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamErrorCode, SCStreamErrorDomain,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The longest side of a frame, in pixels: H.264 encoders refuse larger ones, so a bigger window is scaled down to it.
const MAX_SIDE: f64 = 4096.0;
/// How long a start waits for the first frame on its own before it asks for one.
const NUDGE_AFTER: Duration = Duration::from_millis(300);
/// How long a start waits for the first frame once it asked for one.
const FIRST_FRAME_WAIT: Duration = Duration::from_millis(2_000);
/// The shortest recording: one stopped sooner after its first frame fails to write it, so a stop waits out the rest.
const MIN_LENGTH: Duration = Duration::from_millis(500);
/// How long a stop waits for a recording that wrote no frame to write one or end.
const UNSTARTED_STOP_WAIT: Duration = Duration::from_millis(300);

/// What the recording output reports.
enum Event {
    /// The first frame was written, at this time.
    Started(Instant),
    Failed(String),
    Finished,
}

struct Ivars {
    events: Mutex<Sender<Event>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and `Delegate` does not implement `Drop`.
    #[unsafe(super(NSObject))]
    #[ivars = Ivars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl SCRecordingOutputDelegate for Delegate {
        #[unsafe(method(recordingOutputDidStartRecording:))]
        fn did_start(&self, _output: &SCRecordingOutput) {
            self.send(Event::Started(Instant::now()));
        }

        #[unsafe(method(recordingOutput:didFailWithError:))]
        fn did_fail(&self, _output: &SCRecordingOutput, error: &NSError) {
            self.send(Event::Failed(error.localizedDescription().to_string()));
        }

        #[unsafe(method(recordingOutputDidFinishRecording:))]
        fn did_finish(&self, _output: &SCRecordingOutput) {
            self.send(Event::Finished);
        }
    }
);

impl Delegate {
    fn new(events: Sender<Event>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars { events: Mutex::new(events) });
        unsafe { msg_send![super(this), init] }
    }

    fn send(&self, event: Event) {
        if let Ok(events) = self.ivars().events.lock() {
            let _ = events.send(event);
        }
    }
}

/// One recording that runs. ScreenCaptureKit's objects are used from whichever blocking thread the next call runs on;
/// its own queues call the delegate.
struct Recording {
    stream: Retained<SCStream>,
    output: Retained<SCRecordingOutput>,
    _delegate: Retained<Delegate>,
    events: Receiver<Event>,
    /// Whether the first frame was written: a recording with none has no file to finish.
    wrote: bool,
    /// When the first frame was written, or the start answered when none was yet.
    began: Instant,
}

// SAFETY: ScreenCaptureKit's stream and recording output may be stopped from any thread; nothing here touches AppKit.
unsafe impl Send for Recording {}

/// A value moved across the thread a completion handler runs on.
struct Handed<T>(T);
// SAFETY: only retained ScreenCaptureKit objects are handed over, which are safe to use from another thread.
unsafe impl<T> Send for Handed<T> {}

fn recordings() -> &'static Mutex<HashMap<u32, Recording>> {
    static RECORDINGS: OnceLock<Mutex<HashMap<u32, Recording>>> = OnceLock::new();
    RECORDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// The frame size for a window of `width` by `height` points at `scale` pixels per point: whole, even pixels (H.264
/// counts in pairs), at least 2, and no side longer than `MAX_SIDE`, the aspect kept.
pub fn frame_size(width: f64, height: f64, scale: f64) -> (usize, usize) {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let (mut pixels_wide, mut pixels_high) = ((width * scale).max(1.0), (height * scale).max(1.0));
    let longest = pixels_wide.max(pixels_high);
    if longest > MAX_SIDE {
        pixels_wide *= MAX_SIDE / longest;
        pixels_high *= MAX_SIDE / longest;
    }
    let even = |value: f64| ((value / 2.0).round() as usize * 2).max(2);
    (even(pixels_wide), even(pixels_high))
}

/// What a start answers.
#[derive(Serialize)]
pub struct Started {
    pub id: u32,
    pub width: usize,
    pub height: usize,
}

/// What a stop answers: the size of the file written.
#[derive(Serialize)]
pub struct Stopped {
    pub bytes: i64,
}

fn unsupported_before_15() -> Option<Failure> {
    AnyClass::get(c"SCRecordingOutput")
        .is_none()
        .then(|| Failure::refused(codes::ACTION_NOT_SUPPORTED, "video of a window needs macOS 15 or later, where ScreenCaptureKit records to a file"))
}

/// Whether an error is ScreenCaptureKit's refusal for want of the Screen Recording permission: told by its domain and
/// code, since its text is localized.
fn declined(domain: &str, code: isize) -> bool {
    // SAFETY: a static string ScreenCaptureKit exports.
    domain == unsafe { SCStreamErrorDomain }.to_string() && code == SCStreamErrorCode::UserDeclined.0
}

fn error_text(error: *mut NSError) -> Option<String> {
    // SAFETY: a completion handler's error is nil or an NSError that lives for the call.
    unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string())
}

/// Waits for one answer until `deadline`; `None` once it passed or the sender went away.
fn answer<T>(receiver: &Receiver<T>, deadline: Instant) -> Option<T> {
    receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok()
}

/// Starts recording window `window` into the MPEG-4 file at `path`, and answers once the first frame is written, or
/// the stream runs and `FIRST_FRAME_WAIT` passed.
pub fn start(window: u32, path: &str, deadline: Instant) -> Outcome<Started> {
    if let Some(failure) = unsupported_before_15() {
        return Err(failure);
    }
    let (sender, receiver) = mpsc::channel::<Result<Handed<Retained<SCShareableContent>>, (bool, String)>>();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // SAFETY: the content is nil or a live object for the call; retaining it keeps it past the call.
        let content = unsafe { Retained::retain(content) };
        // SAFETY: the error is nil or an NSError that lives for the call.
        let refused = unsafe { error.as_ref() }.is_some_and(|error| declined(&error.domain().to_string(), error.code()));
        let _ = sender.send(content.map(Handed).ok_or_else(|| (refused, error_text(error).unwrap_or_else(|| "no windows were listed".into()))));
    });
    // Windows on screen or not, so one minimized or on another Space is found too.
    unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, false, &handler) };
    let content = match answer(&receiver, deadline) {
        Some(Ok(Handed(content))) => content,
        Some(Err((true, message))) => return Err(Failure::refused(codes::PERM_DENIED, format!("list windows for video: {message}"))),
        Some(Err((false, message))) => return Err(Failure::refused(codes::ACTION_FAILED, format!("list windows for video: {message}"))),
        None => return Err(Failure::timeout("listing windows for video")),
    };
    let windows = unsafe { content.windows() };
    let Some(target) = windows.iter().find(|candidate| unsafe { candidate.windowID() } == window) else {
        return Err(Failure::refused(codes::WINDOW_NOT_FOUND, format!("window {window} is not one ScreenCaptureKit can record")));
    };
    let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &target) };
    let rect = unsafe { filter.contentRect() };
    let (width, height) = frame_size(rect.size.width, rect.size.height, f64::from(unsafe { filter.pointPixelScale() }));
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(width);
        config.setHeight(height);
        config.setShowsCursor(false);
        config.setCapturesAudio(false);
        // A window resized later is drawn whole into the frame, not cropped.
        config.setScalesToFit(true);
        config.setPreservesAspectRatio(true);
        config.setIgnoreShadowsSingleWindow(true);
    }
    let stream = unsafe { SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None) };
    let (events_sender, events) = mpsc::channel();
    let delegate = Delegate::new(events_sender);
    let output_config = unsafe { SCRecordingOutputConfiguration::new() };
    unsafe { output_config.setOutputURL(&NSURL::fileURLWithPath(&NSString::from_str(path))) };
    let output = unsafe { SCRecordingOutput::initWithConfiguration_delegate(SCRecordingOutput::alloc(), &output_config, ProtocolObject::from_ref(&*delegate)) };
    unsafe { stream.addRecordingOutput_error(&output) }
        .map_err(|error| Failure::refused(codes::ACTION_FAILED, format!("record window {window}: {}", error.localizedDescription())))?;
    let (started_sender, started) = mpsc::channel::<Option<String>>();
    let handler = RcBlock::new(move |error: *mut NSError| {
        let _ = started_sender.send(error_text(error));
    });
    unsafe { stream.startCaptureWithCompletionHandler(Some(&handler)) };
    let recording = Recording { stream, output, _delegate: delegate, events, wrote: false, began: Instant::now() };
    match answer(&started, deadline) {
        Some(None) => {}
        Some(Some(message)) => return Err(Failure::refused(codes::ACTION_FAILED, format!("record window {window}: {message}"))),
        None => {
            halt(&recording.stream, Instant::now() + Duration::from_millis(500));
            return Err(Failure::timeout("starting the video"));
        }
    }
    // The file opens with the first frame, which ScreenCaptureKit sends only once the window draws: one that stays as
    // it is can send none for a while. A filter set again makes it send the window as it is now.
    let mut wrote = first_frame(&recording.events, deadline.min(Instant::now() + NUDGE_AFTER));
    if wrote == Some(false) {
        let (sender, receiver) = mpsc::channel::<()>();
        let handler = RcBlock::new(move |_error: *mut NSError| {
            let _ = sender.send(());
        });
        unsafe { recording.stream.updateContentFilter_completionHandler(&filter, Some(&handler)) };
        let _ = answer(&receiver, deadline);
        wrote = first_frame(&recording.events, deadline.min(Instant::now() + FIRST_FRAME_WAIT));
    }
    let Some(wrote) = wrote else {
        halt(&recording.stream, deadline);
        return Err(Failure::refused(codes::ACTION_FAILED, format!("record window {window}: the recording failed before its first frame")));
    };
    let recording = Recording { wrote, began: Instant::now(), ..recording };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    recordings().lock().map_err(|_| Failure::refused(codes::INTERNAL, "the video table is poisoned"))?.insert(id, recording);
    Ok(Started { id, width, height })
}

/// Whether the first frame was written by `deadline`: `Some(true)` once it was, `Some(false)` when none came, and `None`
/// when the recording failed.
fn first_frame(events: &Receiver<Event>, deadline: Instant) -> Option<bool> {
    match answer(events, deadline) {
        Some(Event::Started(_)) => Some(true),
        Some(Event::Failed(_) | Event::Finished) => None,
        None => Some(false),
    }
}

/// Stops a stream and waits for it to say so, until `deadline`; a stream that already stopped (its window closed)
/// answers with an error, which is the state wanted.
fn halt(stream: &SCStream, deadline: Instant) {
    let (sender, receiver) = mpsc::channel::<()>();
    let handler = RcBlock::new(move |_error: *mut NSError| {
        let _ = sender.send(());
    });
    unsafe { stream.stopCaptureWithCompletionHandler(Some(&handler)) };
    let _ = answer(&receiver, deadline);
}

/// Stops recording `id` and waits, until `deadline`, for the file to be finished.
pub fn stop(id: u32, deadline: Instant) -> Outcome<Stopped> {
    let recording = recordings()
        .lock()
        .map_err(|_| Failure::refused(codes::INTERNAL, "the video table is poisoned"))?
        .remove(&id)
        .ok_or_else(|| Failure::refused(codes::INVALID_ARGS, format!("no video {id} is recording")))?;
    // A first frame that came after the start answered opened the file then: the minimum length counts from it.
    let mut wrote = recording.wrote;
    let mut began = recording.began;
    let mut pending = None;
    if !wrote {
        match recording.events.try_recv() {
            Ok(Event::Started(at)) => {
                wrote = true;
                began = at;
            }
            Ok(other) => pending = Some(other),
            Err(_) => {}
        }
    }
    if wrote {
        std::thread::sleep(MIN_LENGTH.saturating_sub(began.elapsed()).min(deadline.saturating_duration_since(Instant::now())));
    }
    halt(&recording.stream, deadline);
    // A recording that wrote no frame has no file to finish, and may never say it ended: a frame or an end is waited for
    // only briefly, and a first frame that comes meanwhile gets the whole deadline to finish its file.
    let mut wait = if wrote { deadline } else { deadline.min(Instant::now() + UNSTARTED_STOP_WAIT) };
    loop {
        let event = match pending.take() {
            Some(event) => Ok(event),
            None => recording.events.recv_timeout(wait.saturating_duration_since(Instant::now())),
        };
        match event {
            Ok(Event::Started(_)) => {
                wrote = true;
                wait = deadline;
            }
            Ok(Event::Finished) => return Ok(Stopped { bytes: unsafe { recording.output.recordedFileSize() } as i64 }),
            Ok(Event::Failed(_)) | Err(_) if !wrote => return Ok(Stopped { bytes: 0 }),
            Ok(Event::Failed(message)) => return Err(Failure::refused(codes::ACTION_FAILED, format!("the video could not be finished: {message}"))),
            Err(RecvTimeoutError::Timeout) => return Err(Failure::timeout("finishing the video")),
            Err(RecvTimeoutError::Disconnected) => return Err(Failure::refused(codes::ACTION_FAILED, "the video was never finished")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{declined, frame_size};
    use objc2_screen_capture_kit::{SCStreamErrorCode, SCStreamErrorDomain};

    #[test]
    fn tells_a_missing_screen_recording_permission_by_domain_and_code() {
        // SAFETY: a static string ScreenCaptureKit exports.
        let domain = unsafe { SCStreamErrorDomain }.to_string();
        assert!(declined(&domain, SCStreamErrorCode::UserDeclined.0));
        assert!(!declined(&domain, SCStreamErrorCode::FailedToStart.0));
        assert!(!declined("NSCocoaErrorDomain", SCStreamErrorCode::UserDeclined.0));
    }

    #[test]
    fn sizes_a_frame_in_whole_even_pixels() {
        assert_eq!(frame_size(420.0, 292.0, 2.0), (840, 584));
        assert_eq!(frame_size(421.0, 291.5, 1.0), (422, 292));
        // An unreadable scale counts as 1, and a window with no size still makes a frame.
        assert_eq!(frame_size(100.0, 50.0, f64::NAN), (100, 50));
        assert_eq!(frame_size(0.0, 0.0, 2.0), (2, 2));
    }

    #[test]
    fn scales_a_frame_too_large_for_h264_down_and_keeps_its_aspect() {
        assert_eq!(frame_size(2560.0, 1440.0, 2.0), (4096, 2304));
        assert_eq!(frame_size(1000.0, 3000.0, 2.0), (1366, 4096));
    }
}
