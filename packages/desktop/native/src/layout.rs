//! The keyboard layout a shortcut is typed on. A key combo with Command,
//! Control, or Option carries only a key code, and macOS reads its
//! character from the layout, so the code for `ControlOrMeta+a` must be
//! the one that types `a` on this Mac's layout: on French AZERTY the key
//! that types `a` on a US keyboard types `q`.

use core_foundation_sys::base::{CFRelease, CFTypeRef};
use core_foundation_sys::data::{CFDataGetBytePtr, CFDataRef};
use std::ffi::c_void;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> CFTypeRef;
    fn TISGetInputSourceProperty(source: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    static kTISPropertyUnicodeKeyLayoutData: CFTypeRef;
    fn LMGetKbdType() -> u8;
    fn UCKeyTranslate(
        layout: *const c_void,
        code: u16,
        action: u16,
        modifiers: u32,
        keyboard_type: u32,
        options: u32,
        dead_keys: *mut u32,
        max: usize,
        actual: *mut usize,
        characters: *mut u16,
    ) -> i32;
}

/// `kUCKeyActionDown`.
const KEY_DOWN: u16 = 0;
/// `kUCKeyTranslateNoDeadKeysMask`: a dead key answers its own character, not nothing.
const NO_DEAD_KEYS: u32 = 1;
/// Every virtual key code a keyboard has.
const CODES: u16 = 128;

/// `cmdKey >> 8`, the Command bit of UCKeyTranslate's modifier state.
const COMMAND: u32 = 1;

/// What each key code types on the current ASCII-capable layout, the one macOS matches Command shortcuts against: with
/// Command held when `command`, since a layout such as Dvorak-QWERTY Command types other characters then, and with no
/// modifier otherwise. `None` when the layout cannot be read.
pub fn characters(command: bool) -> Option<Vec<(u16, char)>> {
    unsafe {
        let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
        if source.is_null() {
            return None;
        }
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) as CFDataRef;
        let table = if data.is_null() {
            None
        } else {
            let layout = CFDataGetBytePtr(data) as *const c_void;
            let keyboard = LMGetKbdType() as u32;
            let mut table = Vec::new();
            for code in 0..CODES {
                let mut dead = 0u32;
                let mut buffer = [0u16; 4];
                let mut length = 0usize;
                let status = UCKeyTranslate(
                    layout,
                    code,
                    KEY_DOWN,
                    if command { COMMAND } else { 0 },
                    keyboard,
                    NO_DEAD_KEYS,
                    &mut dead,
                    buffer.len(),
                    &mut length,
                    buffer.as_mut_ptr(),
                );
                if status != 0 || length != 1 {
                    continue;
                }
                if let Some(character) = char::from_u32(buffer[0] as u32) {
                    table.push((code, character));
                }
            }
            Some(table)
        };
        CFRelease(source);
        table
    }
}

/// The key code that types `character` in a layout's table, the lowest when several do.
pub fn code_for(character: char, table: &[(u16, char)]) -> Option<u16> {
    table.iter().filter(|(_, typed)| *typed == character).map(|(code, _)| *code).min()
}

#[cfg(test)]
mod tests {
    use super::code_for;

    #[test]
    fn finds_the_key_that_types_a_character_on_the_layout() {
        // French AZERTY: the keys a US keyboard has for a and q are swapped, as are z and w.
        let french = [(0, 'q'), (12, 'a'), (6, 'w'), (13, 'z')];
        assert_eq!(code_for('a', &french), Some(12));
        assert_eq!(code_for('q', &french), Some(0));
        assert_eq!(code_for('z', &french), Some(13));
        assert_eq!(code_for('k', &french), None);
    }
}
