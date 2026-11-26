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

/// Marks the input run `id` cancelled: it sends nothing more. A cancel that comes before the run starts holds too.
pub fn cancel_input(id: u32) {
    TYPING.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_with(HashMap::new).insert(id, true);
}

/// One input run (an action, or the text it types), registered while it lives so `cancel_input` can reach it.
pub struct TypingRun(Option<u32>);

impl TypingRun {
    pub fn start(id: Option<u32>) -> Self {
        if let Some(id) = id {
            let mut guard = TYPING.lock().unwrap_or_else(PoisonError::into_inner);
            let runs = guard.get_or_insert_with(HashMap::new);
            // A cancel that came after its run ended left a mark; ids only grow, so marks far behind this one go. A newer id
            // stays whatever order the runs start in: its cancel may have come before it started.
            runs.retain(|other, _| *other >= id || id - *other < STALE_IDS);
            runs.entry(id).or_insert(false);
        }
        TypingRun(id)
    }

    pub fn cancelled(&self) -> bool {
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

/// What a key types with Shift held, on the US layout the key codes follow.
fn shifted(character: char) -> Option<char> {
    if character.is_ascii_lowercase() {
        return Some(character.to_ascii_uppercase());
    }
    Some(match character {
        '1' => '!',
        '2' => '@',
        '3' => '#',
        '4' => '$',
        '5' => '%',
        '6' => '^',
        '7' => '&',
        '8' => '*',
        '9' => '(',
        '0' => ')',
        '-' => '_',
        '=' => '+',
        '[' => '{',
        ']' => '}',
        '\\' => '|',
        ';' => ':',
        '\'' => '"',
        ',' => '<',
        '.' => '>',
        '/' => '?',
        '`' => '~',
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
            // With Shift the key types its shifted character; one with none on the US layout is left to the app to work out.
            let typed = if flags.contains(CGEventFlags::CGEventFlagShift) { shifted(lower) } else { Some(lower) };
            Key { code, character: typed }
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

/// One key event's worth of text to type: a chunk of characters, or Return or Tab.
#[derive(Debug, PartialEq)]
enum Piece {
    Text(Vec<u16>),
    Return,
    Tab,
}

/// Cuts text into key events: chunks of at most `CHUNK_UNITS` UTF-16 units, cut on a character boundary so a
/// surrogate pair never splits, and Return for a line break (`\r\n` is one) and Tab for a tab.
fn pieces(text: &str) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut chunk: Vec<u16> = Vec::with_capacity(CHUNK_UNITS);
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        let key = match character {
            '\r' => {
                characters.next_if_eq(&'\n');
                Some(Piece::Return)
            }
            '\n' => Some(Piece::Return),
            '\t' => Some(Piece::Tab),
            _ => None,
        };
        if let Some(key) = key {
            if !chunk.is_empty() {
                out.push(Piece::Text(std::mem::take(&mut chunk)));
            }
            out.push(key);
            continue;
        }
        let mut units = [0u16; 2];
        let encoded = character.encode_utf16(&mut units);
        if chunk.len() + encoded.len() > CHUNK_UNITS {
            out.push(Piece::Text(std::mem::take(&mut chunk)));
        }
        chunk.extend_from_slice(encoded);
    }
    if !chunk.is_empty() {
        out.push(Piece::Text(chunk));
    }
    out
}

/// Types text as keystrokes that carry their characters, whatever the keyboard layout (`pieces`).
/// Before each event it checks `run` and `deadline`: a cancelled run, or one out of time, sends nothing more, so keys never
/// keep going after the caller gave up, when another app may have taken the keyboard.
pub fn type_text(text: &str, route: Route, run: &TypingRun, deadline: std::time::Instant) -> Outcome<()> {
    let source = source()?;
    for piece in pieces(text) {
        if run.cancelled() {
            return Err(Failure::unconfirmed(codes::TIMEOUT, "typing was cancelled; the text sent before then stays sent"));
        }
        if std::time::Instant::now() >= deadline {
            return Err(Failure::unconfirmed(codes::TIMEOUT, "typing ran out of time; the text sent before then stays sent"));
        }
        let chunk = match piece {
            Piece::Return | Piece::Tab => {
                let code = if piece == Piece::Tab { 48 } else { 36 };
                press(&Combo { key: Key { code, character: None }, flags: CGEventFlags::CGEventFlagNull }, route)?;
                continue;
            }
            Piece::Text(chunk) => chunk,
        };
        for down in [true, false] {
            let event =
                CGEvent::new_keyboard_event(source.clone(), 0, down).map_err(|_| Failure::unconfirmed(codes::INTERNAL, "could not create a key event"))?;
            // No modifiers: a key the user holds would otherwise ride along on an HID-state event and turn text into a shortcut.
            event.set_flags(CGEventFlags::CGEventFlagNull);
            event.set_string_from_utf16_unchecked(&chunk);
            post(&event, route);
        }
        sleep(Duration::from_millis(3));
    }
    Ok(())
}

/// What a pointer does at a point.
pub enum Pointer {
    Move,
    Click { right: bool, count: i64 },
}

/// Moves the real pointer to a point on screen, and clicks there. `proceed` is asked before the move and before each
/// click, so nothing more is sent once the caller gave up; a failure after the move may have reached the app.
pub fn pointer(x: f64, y: f64, action: Pointer, proceed: &dyn Fn() -> Outcome<()>) -> Outcome<()> {
    let source = source()?;
    let point = CGPoint::new(x, y);
    let make = |kind: CGEventType, button: CGMouseButton| {
        CGEvent::new_mouse_event(source.clone(), kind, point, button).map_err(|_| Failure::refused(codes::INTERNAL, "could not create a pointer event"))
    };
    let moved = make(CGEventType::MouseMoved, CGMouseButton::Left)?;
    proceed()?;
    moved.post(CGEventTapLocation::HID);
    sleep(Duration::from_millis(30));
    let Pointer::Click { right, count } = action else { return Ok(()) };
    let (down, up, button) = if right {
        (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right)
    } else {
        (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left)
    };
    for click in 1..=count {
        let events = [make(down, button), make(up, button)];
        let [Ok(pressed), Ok(released)] = events else { return Err(Failure::unconfirmed(codes::INTERNAL, "could not create a pointer event")) };
        // Each click checks the caller still wants it; a button pressed is always released.
        proceed().map_err(Failure::delivered)?;
        for event in [pressed, released] {
            event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click);
            event.post(CGEventTapLocation::HID);
            sleep(Duration::from_millis(15));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{CHUNK_UNITS, Piece, TypingRun, cancel_input, parse_combo, pieces};
    use core_graphics::event::CGEventFlags;

    fn text(units: &Piece) -> String {
        match units {
            Piece::Text(units) => String::from_utf16(units).expect("a chunk holds whole characters"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn keeps_a_surrogate_pair_in_one_event() {
        let typed = pieces("123456789012345😀x");
        assert_eq!(typed.len(), 2);
        assert_eq!(text(&typed[0]), "123456789012345");
        assert_eq!(text(&typed[1]), "😀x");
        assert!(typed.iter().all(|piece| matches!(piece, Piece::Text(units) if units.len() <= CHUNK_UNITS)));
    }

    #[test]
    fn presses_return_once_for_a_windows_line_break() {
        assert_eq!(
            pieces("a\r\nb\nc\rd\te"),
            [
                Piece::Text("a".encode_utf16().collect()),
                Piece::Return,
                Piece::Text("b".encode_utf16().collect()),
                Piece::Return,
                Piece::Text("c".encode_utf16().collect()),
                Piece::Return,
                Piece::Text("d".encode_utf16().collect()),
                Piece::Tab,
                Piece::Text("e".encode_utf16().collect()),
            ]
        );
    }

    #[test]
    fn types_the_shifted_character_of_a_shift_combo() {
        for (combo, typed) in [("shift+a", Some('A')), ("A", Some('A')), ("shift+1", Some('!')), ("a", Some('a')), ("cmd+a", Some('a'))] {
            let parsed = parse_combo(combo).unwrap_or_else(|_| panic!("{combo} parses"));
            assert_eq!(parsed.key.character, typed, "{combo}");
        }
        assert!(parse_combo("shift+a").unwrap().flags.contains(CGEventFlags::CGEventFlagShift));
    }

    #[test]
    fn keeps_a_cancel_that_came_before_its_run_while_an_older_run_starts() {
        cancel_input(1_000_021);
        let older = TypingRun::start(Some(1_000_020));
        let cancelled = TypingRun::start(Some(1_000_021));
        assert!(!older.cancelled());
        assert!(cancelled.cancelled());
    }

    #[test]
    fn refuses_command_q_however_it_is_written() {
        for combo in ["cmd+q", "command+Q", "meta+q"] {
            assert!(parse_combo(combo).is_err(), "{combo}");
        }
        assert!(parse_combo("ctrl+q").is_ok());
    }
}
