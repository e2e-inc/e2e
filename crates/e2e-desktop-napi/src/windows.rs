//! The windows of one process: the window server's list (ids, bounds,
//! whether on screen, layer) joined with the app's accessibility windows
//! (title, focus, minimized), matched by the window server id.

use crate::ax::{self, Element};
use crate::failure::{Failure, Outcome, codes};
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex};
use core_foundation_sys::base::CFTypeRef;
use core_foundation_sys::dictionary::{CFDictionaryGetValue, CFDictionaryRef};
use core_graphics::geometry::CGRect;
use core_graphics::window;
use serde::Serialize;

/// The window level menus open at (`kCGPopUpMenuWindowLevel`).
const MENU_LAYER: i64 = 101;

/// A rectangle in screen points, top-left origin.
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One entry of the window server's list.
struct ServerWindow {
    id: u32,
    pid: i32,
    layer: i64,
    bounds: Option<Rect>,
    onscreen: bool,
    title: Option<String>,
}

/// One window of the app, as `listWindows` answers.
#[derive(Serialize)]
pub struct WindowInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub is_focused: bool,
    /// Focus is in a sheet or an alert on this window, not the window itself: a click at a point may land on the sheet.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sheet_focused: bool,
    /// A key naming that sheet or alert (`Element::sheet_key`): its window server id, else one for its accessibility
    /// element. A sheet that replaced it has another.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_id: Option<String>,
    /// The app's main window (`AXMain`), which an app in the background still names while none has focus.
    pub is_main: bool,
    pub visible: bool,
    pub accessible: bool,
    pub minimized: bool,
    pub pid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Rect>,
    /// A dialog macOS itself adds to the app's windows (Siri's, on macOS 27), which a test never means by default.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub system: bool,
}

fn dictionary_value(dictionary: CFDictionaryRef, key: CFStringRefStatic) -> CFTypeRef {
    unsafe { CFDictionaryGetValue(dictionary, key as *const _) }
}

type CFStringRefStatic = core_foundation_sys::string::CFStringRef;

fn number(dictionary: CFDictionaryRef, key: CFStringRefStatic) -> Option<i64> {
    let value = dictionary_value(dictionary, key);
    if value.is_null() {
        return None;
    }
    unsafe { CFNumber::wrap_under_get_rule(value as _) }.to_i64()
}

fn boolean(dictionary: CFDictionaryRef, key: CFStringRefStatic) -> bool {
    let value = dictionary_value(dictionary, key);
    !value.is_null() && unsafe { CFBoolean::wrap_under_get_rule(value as _) }.into()
}

fn string(dictionary: CFDictionaryRef, key: CFStringRefStatic) -> Option<String> {
    let value = dictionary_value(dictionary, key);
    if value.is_null() {
        return None;
    }
    Some(crate::ax::text_of(value as _))
}

fn bounds(dictionary: CFDictionaryRef) -> Option<Rect> {
    let value = dictionary_value(dictionary, unsafe { window::kCGWindowBounds });
    if value.is_null() {
        return None;
    }
    let description: CFDictionary = unsafe { CFDictionary::wrap_under_get_rule(value as _) };
    let rect = CGRect::from_dict_representation(&description)?;
    Some(Rect { x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height })
}

/// Every window the window server lists, front to back.
fn server_windows() -> Vec<ServerWindow> {
    let Some(list) = window::copy_window_info(window::kCGWindowListOptionAll | window::kCGWindowListExcludeDesktopElements, window::kCGNullWindowID) else {
        return Vec::new();
    };
    let raw = list.as_concrete_TypeRef();
    let count = unsafe { CFArrayGetCount(raw) };
    let mut out = Vec::with_capacity(count.max(0) as usize);
    for index in 0..count {
        let dictionary = unsafe { CFArrayGetValueAtIndex(raw, index) } as CFDictionaryRef;
        let (Some(id), Some(pid)) = (number(dictionary, unsafe { window::kCGWindowNumber }), number(dictionary, unsafe { window::kCGWindowOwnerPID })) else {
            continue;
        };
        out.push(ServerWindow {
            id: id as u32,
            pid: pid as i32,
            layer: number(dictionary, unsafe { window::kCGWindowLayer }).unwrap_or(0),
            bounds: bounds(dictionary),
            onscreen: boolean(dictionary, unsafe { window::kCGWindowIsOnscreen }),
            title: string(dictionary, unsafe { window::kCGWindowName }),
        });
    }
    out
}

/// The app's accessibility windows, front to back, each with its window server id when it has one.
pub fn ax_windows(app: &Element) -> Outcome<Vec<(Element, Option<u32>)>> {
    // Every window, however many a document app restored, in one read: a count read first misses the last window when
    // one opens between the two reads, and a minimized window has no on-screen window to stand in for it.
    match app.elements("AXWindows", isize::MAX as usize) {
        Ok(windows) => Ok(windows
            .into_iter()
            .map(|element| {
                let id = element.window_id();
                (element, id)
            })
            .collect()),
        Err(ax::AX_NO_VALUE | ax::AX_ATTRIBUTE_UNSUPPORTED) => Ok(Vec::new()),
        Err(ax::AX_INVALID_ELEMENT) => Err(Failure::refused(codes::APP_NOT_FOUND, "the app is no longer running")),
        Err(ax::AX_API_DISABLED) => Err(Failure::refused(codes::PERM_DENIED, "this process has no Accessibility permission")),
        Err(ax::AX_CANNOT_COMPLETE) => Err(unanswered()),
        // An app that has no accessibility for its windows will not have it on a later read: say so, do not wait.
        Err(ax::AX_NOT_IMPLEMENTED) => Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "the app does not expose its windows to accessibility")),
        Err(error) => Err(Failure::refused(codes::APP_UNRESPONSIVE, format!("reading the app's windows failed: {}", ax::describe(error)))
            .with_details(serde_json::json!({ "retryable": true }))),
    }
}

/// The app did not answer a read of its windows in time: a stall, not an answer, so the list is read again.
fn unanswered() -> Failure {
    Failure::refused(codes::APP_UNRESPONSIVE, "the app did not answer its window list in time").with_details(serde_json::json!({ "retryable": true }))
}

/// The developer identifiers in a small subtree, `levels` deep and at most 8 children a level. A read the app did not
/// answer in time is an error: identifiers it holds back are no proof the dialog is the app's own.
fn identifiers(element: &Element, levels: usize) -> Result<Vec<String>, ax::AXError> {
    let mut found = Vec::new();
    match element.attribute("AXIdentifier") {
        Ok(value) => found.extend(value.text().map(str::to_owned)),
        Err(error @ ax::AX_CANNOT_COMPLETE) => return Err(error),
        Err(_) => {}
    }
    if levels > 0 {
        let children = match element.elements("AXChildren", 8) {
            Ok(children) => children,
            Err(error @ ax::AX_CANNOT_COMPLETE) => return Err(error),
            Err(_) => Vec::new(),
        };
        for child in children {
            found.extend(identifiers(&child, levels - 1)?);
        }
    }
    Ok(found)
}

/// Whether an untitled dialog with these identifiers inside is one macOS put among the app's windows: Siri's, which
/// macOS 27 shows over an app a few seconds after a press in a SwiftUI sheet, holds only its orb, identified `siri`.
fn system_dialog(identifiers: &[String]) -> bool {
    identifiers.iter().any(|identifier| identifier.eq_ignore_ascii_case("siri"))
}

/// Whether `window` holds the app's focused window: is it, or carries it as a sheet or an alert. The app's focused window
/// is the sheet then, and keys reach the window through it. A parent the app did not answer for in time is no proof
/// either way: it fails as `AX_CANNOT_COMPLETE`.
pub fn holds_focus(focused: &Element, window: &Element) -> Result<bool, ax::AXError> {
    if focused == window {
        return Ok(true);
    }
    Ok(crate::actions::stalled(focused.attribute("AXParent"))?.and_then(|parent| parent.element().cloned()).as_ref() == Some(window))
}

/// The windows of one process: every accessibility window, and every
/// normal-level window server window accessibility does not list.
pub fn list(pid: i32) -> Outcome<Vec<WindowInfo>> {
    if !crate::process::alive(pid) {
        return Err(Failure::refused(codes::APP_NOT_FOUND, format!("no process {pid} is running")));
    }
    let app = Element::application(pid);
    let accessible = ax_windows(&app)?;
    // The app's focus decides which window is focused: a stall reading it fails the list, which a retry may get past,
    // rather than list every window as unfocused.
    let focused = crate::actions::element_attribute(&app, "AXFocusedWindow", "list windows")?;
    let server: Vec<ServerWindow> = server_windows().into_iter().filter(|window| window.pid == pid).collect();
    let mut out = Vec::new();
    let mut listed = Vec::new();
    // The frames of the windows' sheets, which the window server lists as windows of their own.
    let mut sheets = Vec::new();
    let mut unresolved = 0;
    for (element, id) in &accessible {
        let Some(id) = *id else {
            // Only a window counts: an app's AXWindows can hold other elements that never get an id (Finder's desktop, an
            // app's own AXApplication element), and they are no window the list leaves out.
            let role = element.attribute("AXRole");
            if may_be_window(role.as_ref().map(|role| role.text()).map_err(|error| *error)) {
                unresolved += 1;
            }
            continue;
        };
        let entry = server.iter().find(|window| window.id == id);
        let values = match element.attributes(&["AXTitle", "AXMinimized", "AXPosition", "AXSize", "AXSubrole", "AXMain"]) {
            Ok(values) => values,
            Err(ax::AX_CANNOT_COMPLETE) => return Err(unanswered()),
            // A window that closed as it was read has none of them.
            Err(_) => vec![None; 6],
        };
        let title = values[0].as_ref().and_then(|value| value.text().map(str::to_owned));
        let minimized = values[1].as_ref().and_then(|value| value.boolean()).unwrap_or(false);
        let subrole = values[4].as_ref().and_then(|value| value.text());
        // Only an untitled dialog is read further: an app's own windows nearly all have titles.
        let system = subrole == Some("AXDialog")
            && title.as_deref().is_none_or(|title| title.trim().is_empty())
            && system_dialog(&identifiers(element, 3).map_err(|_| unanswered())?);
        let ax_bounds = match (&values[2], &values[3]) {
            (Some(ax::Value::Point(x, y)), Some(ax::Value::Size(width, height))) => Some(Rect { x: *x, y: *y, width: *width, height: *height }),
            _ => None,
        };
        let holds = match &focused {
            Some(focused) => crate::actions::holds(focused, element, "list windows")?,
            None => false,
        };
        listed.push(id);
        // A sheet is part of its window, which lists it as a child: the window server lists it as a window of its own,
        // which must not be listed again below as one accessibility cannot read. A read the app did not answer in time
        // is no proof the window holds no sheet.
        for sheet in window_sheets(element).map_err(|_| unanswered())? {
            listed.extend(sheet.window_id());
            sheets.extend(sheet.frame());
        }
        out.push(WindowInfo {
            id: id.to_string(),
            title: title.or_else(|| entry.and_then(|window| window.title.clone())),
            is_focused: holds,
            sheet_focused: holds && focused.as_ref() != Some(element),
            sheet_id: focused.as_ref().filter(|focused| holds && *focused != element).map(Element::sheet_key),
            is_main: values[5].as_ref().and_then(|value| value.boolean()).unwrap_or(false),
            visible: entry.is_some_and(|window| window.onscreen),
            accessible: true,
            minimized,
            pid,
            bounds: ax_bounds.or_else(|| entry.and_then(|window| window.bounds)),
            system,
        });
    }
    for window in &server {
        // A window accessibility does not list counts only while it is on screen: AppKit keeps hidden helper windows.
        if window.layer != 0 || listed.contains(&window.id) || !window.onscreen {
            continue;
        }
        // A SwiftUI alert's sheet names a window id of its own that is not the window server's: the server's window is
        // the sheet with its shadow, centered on it.
        if window.bounds.is_some_and(|bounds| sheets.iter().any(|&sheet| shadows(bounds, sheet))) {
            continue;
        }
        // A window the window server lists with no size is a placeholder, not something on screen.
        if window.bounds.is_none_or(|bounds| bounds.width < 1.0 || bounds.height < 1.0) {
            continue;
        }
        out.push(WindowInfo {
            id: window.id.to_string(),
            title: window.title.clone(),
            is_focused: false,
            sheet_focused: false,
            sheet_id: None,
            is_main: false,
            visible: window.onscreen,
            accessible: false,
            minimized: false,
            pid,
            bounds: window.bounds,
            system: false,
        });
    }
    complete(listed.len(), unresolved)?;
    Ok(out)
}

/// The sheets a window holds, among all its children. `Err(AX_CANNOT_COMPLETE)` for a read the app did not answer in
/// time.
pub(crate) fn window_sheets(window: &Element) -> Result<Vec<Element>, ax::AXError> {
    let count = match window.count("AXChildren") {
        Ok(count) => count,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => return Ok(Vec::new()),
    };
    let children = match window.elements("AXChildren", count.max(1)) {
        Ok(children) => children,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => return Ok(Vec::new()),
    };
    let mut sheets = Vec::new();
    for child in children {
        if crate::actions::stalled(child.attribute("AXRole"))?.as_ref().and_then(ax::Value::text) == Some("AXSheet") {
            sheets.push(child);
        }
    }
    Ok(sheets)
}

/// Whether a window server window is the sheet `sheet` (x, y, width, height) with its shadow around it: it holds the
/// sheet, centered on it.
fn shadows(window: Rect, sheet: (f64, f64, f64, f64)) -> bool {
    let (x, y, width, height) = sheet;
    let centered = |start: f64, size: f64, outer_start: f64, outer_size: f64| (start + size / 2.0 - (outer_start + outer_size / 2.0)).abs() < 2.0;
    window.width >= width && window.height >= height && centered(x, width, window.x, window.width) && centered(y, height, window.y, window.height)
}

/// Whether an accessibility window entry with no window server id is a window the list leaves out: its role says so, or
/// the app did not answer the role in time, which may hide one, so a stall never reads as an app with no window.
fn may_be_window(role: Result<Option<&str>, ax::AXError>) -> bool {
    match role {
        Ok(role) => role == Some("AXWindow"),
        Err(error) => error == ax::AX_CANNOT_COMPLETE,
    }
}

/// Refuses a window list that holds none of the app's accessibility windows while some had no window server id yet: the
/// app has a window, and a list without it would read as an app with none, which a negative assertion could take as
/// proof. A retryable stall: the id is there a moment later.
fn complete(listed: usize, unresolved: usize) -> Outcome<()> {
    if listed == 0 && unresolved > 0 {
        return Err(Failure::refused(codes::APP_UNRESPONSIVE, format!("{unresolved} window(s) of the app have no window server id yet"))
            .with_details(serde_json::json!({ "retryable": true })));
    }
    Ok(())
}

/// Whether a window of `pid` has left both lists `list` reads: the app's accessibility windows, and the window server's
/// windows on screen, which keeps a closing window through its animation. An app that quits with its last window, as
/// Calculator does, took the window with it: its accessibility then answers nothing, so the process is asked first.
pub fn closed(pid: i32, id: u32) -> bool {
    if !crate::process::alive(pid) {
        return true;
    }
    let listed = match ax_windows(&Element::application(pid)) {
        Ok(open) => open.iter().any(|(_, window)| *window == Some(id)),
        Err(failure) => failure.code != codes::APP_NOT_FOUND,
    };
    !listed && !server_windows().iter().any(|window| window.pid == pid && window.id == id && window.onscreen)
}

/// The accessibility element of a window of `pid` by its window server id.
pub fn find(pid: i32, id: u32) -> Outcome<Element> {
    let app = Element::application(pid);
    for (element, window) in ax_windows(&app)? {
        if window == Some(id) {
            return Ok(element);
        }
    }
    if server_windows().iter().any(|window| window.pid == pid && window.id == id) {
        return Err(Failure::refused(codes::WINDOW_NOT_FOUND, format!("window {id} has no accessibility element"))
            .with_details(serde_json::json!({ "kind": "window_without_accessibility_element" })));
    }
    Err(Failure::refused(codes::WINDOW_NOT_FOUND, format!("the app has no window {id}")))
}

/// The window server's bounds of one window.
pub fn server_bounds(id: u32) -> Option<Rect> {
    server_windows().into_iter().find(|window| window.id == id).and_then(|window| window.bounds)
}

/// How many menus `pid` has open on screen: windows at the menu level.
pub fn open_menus(pid: i32) -> usize {
    server_windows().into_iter().filter(|window| window.pid == pid && window.layer == MENU_LAYER && window.onscreen).count()
}

#[cfg(test)]
mod tests {
    use super::{Rect, complete, may_be_window, shadows, system_dialog};
    use crate::ax;

    #[test]
    fn takes_a_server_window_centered_around_a_sheet_for_the_sheet() {
        // A SwiftUI alert's sheet, and the window server's window for it with its shadow, as macOS 27 lists them.
        let sheet = (850.0, 466.0, 260.0, 96.0);
        assert!(shadows(Rect { x: 775.0, y: 391.0, width: 410.0, height: 246.0 }, sheet));
        // A window of the same size elsewhere, or one centered on it that is smaller, is another.
        assert!(!shadows(Rect { x: 100.0, y: 391.0, width: 410.0, height: 246.0 }, sheet));
        assert!(!shadows(Rect { x: 880.0, y: 494.0, width: 200.0, height: 40.0 }, sheet));
    }

    #[test]
    fn counts_an_entry_whose_role_the_app_did_not_answer_as_a_window() {
        assert!(may_be_window(Ok(Some("AXWindow"))));
        assert!(!may_be_window(Ok(Some("AXApplication"))), "an app's own element in its windows");
        assert!(!may_be_window(Ok(None)));
        assert!(may_be_window(Err(ax::AX_CANNOT_COMPLETE)), "a stall may hide a window");
        assert!(!may_be_window(Err(ax::AX_FAILURE)), "a role the element does not have");
    }

    #[test]
    fn refuses_a_window_list_that_left_out_every_window_it_could_not_name() {
        assert!(complete(0, 0).is_ok(), "an app with no window");
        assert!(complete(2, 1).is_ok(), "another window was listed");
        let stall = complete(0, 1).expect_err("the only window has no id yet");
        assert_eq!(stall.code, crate::failure::codes::APP_UNRESPONSIVE);
        assert_eq!(stall.details.and_then(|details| details.get("retryable").cloned()), Some(serde_json::json!(true)));
    }

    #[test]
    fn tells_siri_from_an_app_dialog() {
        assert!(system_dialog(&["siri".into()]));
        assert!(!system_dialog(&["confirm-delete".into(), "ok".into()]));
        assert!(!system_dialog(&[]));
    }
}
