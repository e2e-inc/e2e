//! Keyboard and pointer events. A key or text either goes to one process
//! (`CGEventPostToPid`, which its key window receives while the app stays in
//! the background) or, with physical input, through the HID system like a
//! real keyboard. Pointer events are always physical: a click carries only a
//! point on screen.

use crate::failure::{Failure, Outcome, codes};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::thread::sleep;
use std::time::Duration;

/// How far behind the newest run a leftover cancel mark is dropped.
const STALE_IDS: u32 = 4096;

/// The typing runs by the id their caller gave (one counter for the process), each marked once it is cancelled.
static TYPING: Mutex<Option<HashMap<u32, bool>>> = Mutex::new(None);

/// Marks the typing run `id` cancelled: it sends no more text. A cancel that comes before the run starts holds too.
pub fn cancel_typing(id: u32) {
    TYPING.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_with(HashMap::new).insert(id, true);
}

/// One typing run, registered while it lives so `cancel_typing` can reach it.
pub struct TypingRun(Option<u32>);

impl TypingRun {
    pub fn start(id: Option<u32>) -> Self {
        if let Some(id) = id {
            let mut guard = TYPING.lock().unwrap_or_else(PoisonError::into_inner);
            let runs = guard.get_or_insert_with(HashMap::new);
            // A cancel that came after its run ended left a mark; ids only grow, so marks far behind this one go.
            runs.retain(|other, _| id.wrapping_sub(*other) < STALE_IDS);
            runs.entry(id).or_insert(false);
        }
        TypingRun(id)
    }

    fn cancelled(&self) -> bool {
        self.0.is_some_and(|id| TYPING.lock().unwrap_or_else(PoisonError::into_inner).as_ref().and_then(|runs| runs.get(&id).copied()).unwrap_or(false))
    }
}

impl Drop for TypingRun {
    fn drop(&mut self) {
        if let Some(id) = self.0
            && let Some(runs) = TYPING.lock().unwrap_or_else(PoisonError::into_inner).as_mut()
        {
            runs.remove(&id);
        }
    }
}

/// Where an event goes.
#[derive(Clone, Copy)]
pub enum Route {
    /// Into one process's event queue.
    Process(i32),
    /// Through the HID system, as physical input.
    Physical,
}

/// One key of a combo, its virtual key code (ANSI layout) and the character it types, if any.
struct Key {
    code: u16,
    character: Option<char>,
}

fn named_key(name: &str) -> Option<u16> {
    Some(match name {
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "backspace" | "delete" => 51,
        "escape" | "esc" => 53,
        "forwarddelete" => 117,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        "f1" => 122,
        "f2" => 120,
        "f3" => 99,
        "f4" => 118,
        "f5" => 96,
        "f6" => 97,
        "f7" => 98,
        "f8" => 100,
        "f9" => 101,
        "f10" => 109,
        "f11" => 103,
        "f12" => 111,
        _ => return None,
    })
}

fn character_key(character: char) -> Option<u16> {
    Some(match character {
        'a' => 0,
        's' => 1,
        'd' => 2,
        'f' => 3,
        'h' => 4,
        'g' => 5,
        'z' => 6,
        'x' => 7,
        'c' => 8,
        'v' => 9,
        'b' => 11,
        'q' => 12,
        'w' => 13,
        'e' => 14,
        'r' => 15,
        'y' => 16,
        't' => 17,
        '1' => 18,
        '2' => 19,
        '3' => 20,
        '4' => 21,
        '6' => 22,
        '5' => 23,
        '=' => 24,
        '9' => 25,
        '7' => 26,
        '-' => 27,
        '8' => 28,
        '0' => 29,
        ']' => 30,
        'o' => 31,
        'u' => 32,
        '[' => 33,
        'i' => 34,
        'p' => 35,
        'l' => 37,
        'j' => 38,
        '\'' => 39,
        'k' => 40,
        ';' => 41,
        '\\' => 42,
        ',' => 43,
        '/' => 44,
        'n' => 45,
        'm' => 46,
        '.' => 47,
        '`' => 50,
        _ => return None,
    })
}

/// A parsed combo: its key and modifier flags.
pub struct Combo {
    key: Key,
    flags: CGEventFlags,
}

/// Parses `cmd+shift+a`: modifiers, then one key. A lone capital letter adds Shift.
pub fn parse_combo(combo: &str) -> Outcome<Combo> {
    let parts: Vec<&str> = combo.split('+').collect();
    let Some((last, modifiers)) = parts.split_last() else {
        return Err(Failure::refused(codes::INVALID_ARGS, "an empty key combo"));
    };
    let mut flags = CGEventFlags::CGEventFlagNull;
    for modifier in modifiers {
        flags |= match modifier.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" => CGEventFlags::CGEventFlagCommand,
            "shift" => CGEventFlags::CGEventFlagShift,
            "ctrl" | "control" => CGEventFlags::CGEventFlagControl,
            "alt" | "option" => CGEventFlags::CGEventFlagAlternate,
            other => return Err(Failure::refused(codes::INVALID_ARGS, format!("\"{other}\" is not a modifier"))),
        };
    }
    let mut characters = last.chars();
    let key = match (characters.next(), characters.next()) {
        (Some(character), None) => {
            if character.is_ascii_uppercase() {
                flags |= CGEventFlags::CGEventFlagShift;
            }
            let lower = character.to_ascii_lowercase();
            let code = character_key(lower).ok_or_else(|| Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("\"{character}\" has no key of its own")))?;
            Key { code, character: Some(character) }
        }
        _ => {
            let name = last.to_ascii_lowercase();
            let code = named_key(&name).ok_or_else(|| Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("\"{last}\" is not a key")))?;
            Key { code, character: if name == "space" { Some(' ') } else { None } }
        }
    };
    if key.code == 12 && flags.contains(CGEventFlags::CGEventFlagCommand) {
        return Err(Failure::refused(codes::POLICY_DENIED, "Command-Q quits the app; end it with closeApp"));
    }
    Ok(Combo { key, flags })
}

fn source() -> Outcome<CGEventSource> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| Failure::refused(codes::INTERNAL, "could not create an event source"))
}

fn post(event: &CGEvent, route: Route) {
    match route {
        Route::Process(pid) => event.post_to_pid(pid),
        Route::Physical => event.post(CGEventTapLocation::HID),
    }
}

/// Presses and releases one combo.
pub fn press(combo: &Combo, route: Route) -> Outcome<()> {
    let source = source()?;
    let plain = !combo.flags.intersects(CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagControl | CGEventFlags::CGEventFlagAlternate);
    for down in [true, false] {
        let event =
            CGEvent::new_keyboard_event(source.clone(), combo.key.code, down).map_err(|_| Failure::refused(codes::INTERNAL, "could not create a key event"))?;
        event.set_flags(combo.flags);
        if let (true, Some(character)) = (plain, combo.key.character) {
            event.set_string(&character.to_string());
        }
        post(&event, route);
        sleep(Duration::from_millis(4));
    }
    Ok(())
}

/// The most UTF-16 units one key event carries: some apps drop the rest of a longer string.
const CHUNK_UNITS: usize = 16;

/// Types text as keystrokes that carry their characters, whatever the keyboard layout. A newline presses Return and a tab Tab.
/// Before each event it checks `run` and `deadline`: a cancelled run, or one out of time, sends nothing more, so keys never
/// keep going after the caller gave up, when another app may have taken the keyboard.
pub fn type_text(text: &str, route: Route, run: &TypingRun, deadline: std::time::Instant) -> Outcome<()> {
    let source = source()?;
    let go_on = || -> Outcome<()> {
        if run.cancelled() {
            return Err(Failure::unconfirmed(codes::TIMEOUT, "typing was cancelled; the text sent before then stays sent"));
        }
        if std::time::Instant::now() >= deadline {
            return Err(Failure::unconfirmed(codes::TIMEOUT, "typing ran out of time; the text sent before then stays sent"));
        }
        Ok(())
    };
    let send = |chunk: &[u16]| -> Outcome<()> {
        go_on()?;
        for down in [true, false] {
            let event =
                CGEvent::new_keyboard_event(source.clone(), 0, down).map_err(|_| Failure::unconfirmed(codes::INTERNAL, "could not create a key event"))?;
            // No modifiers: a key the user holds would otherwise ride along on an HID-state event and turn text into a shortcut.
            event.set_flags(CGEventFlags::CGEventFlagNull);
            event.set_string_from_utf16_unchecked(chunk);
            post(&event, route);
        }
        sleep(Duration::from_millis(3));
        Ok(())
    };
    let mut chunk: Vec<u16> = Vec::with_capacity(CHUNK_UNITS);
    for character in text.chars() {
        if character == '\n' || character == '\r' || character == '\t' {
            if !chunk.is_empty() {
                send(&chunk)?;
                chunk.clear();
            }
            go_on()?;
            let combo = Combo { key: Key { code: if character == '\t' { 48 } else { 36 }, character: None }, flags: CGEventFlags::CGEventFlagNull };
            press(&combo, route)?;
            continue;
        }
        let mut units = [0u16; 2];
        let encoded = character.encode_utf16(&mut units);
        // A character never splits across events: both halves of a surrogate pair go in one.
        if chunk.len() + encoded.len() > CHUNK_UNITS {
            send(&chunk)?;
            chunk.clear();
        }
        chunk.extend_from_slice(encoded);
    }
    if !chunk.is_empty() {
        send(&chunk)?;
    }
    Ok(())
}

/// What a pointer does at a point.
pub enum Pointer {
    Move,
    Click { right: bool, count: i64 },
}

/// Moves the real pointer to a point on screen, and clicks there.
pub fn pointer(x: f64, y: f64, action: Pointer) -> Outcome<()> {
    let source = source()?;
    let point = CGPoint::new(x, y);
    let make = |kind: CGEventType, button: CGMouseButton| {
        CGEvent::new_mouse_event(source.clone(), kind, point, button).map_err(|_| Failure::refused(codes::INTERNAL, "could not create a pointer event"))
    };
    make(CGEventType::MouseMoved, CGMouseButton::Left)?.post(CGEventTapLocation::HID);
    sleep(Duration::from_millis(30));
    let Pointer::Click { right, count } = action else { return Ok(()) };
    let (down, up, button) = if right {
        (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right)
    } else {
        (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left)
    };
    for click in 1..=count {
        for kind in [down, up] {
            let event = make(kind, button)?;
            event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click);
            event.post(CGEventTapLocation::HID);
            sleep(Duration::from_millis(15));
        }
    }
    Ok(())
}
