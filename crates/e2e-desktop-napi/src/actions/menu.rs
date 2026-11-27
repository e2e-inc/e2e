//! The app's menu bar, read through accessibility: which item a key equivalent triggers, and whether the app has it
//! enabled.

use super::*;
use crate::input::{Combo, KeyEquivalent};

/// The most menu items one walk reads: past any app's menu bar, short of a menu that never ends.
const MAX_ITEMS: usize = 5_000;

/// How deep submenus are followed.
const MAX_DEPTH: usize = 8;

/// One item of a menu, as the walk reads it.
struct Item {
    title: String,
    enabled: bool,
    key: Option<KeyEquivalent>,
}

/// The children of a menu-bar element, or of the menu an item opens.
fn below(element: &Element) -> Outcome<Vec<Element>> {
    all(element, "AXChildren", "read the menu bar")
}

fn read(element: &Element) -> Outcome<Item> {
    let values = match element.attributes(&["AXTitle", "AXEnabled", "AXMenuItemCmdChar", "AXMenuItemCmdVirtualKey", "AXMenuItemCmdModifiers"]) {
        Ok(values) => values,
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_API_DISABLED)) => return Err(unread(error, "read the menu bar")),
        Err(_) => vec![None; 5],
    };
    let number = |value: &Option<Value>| match value {
        Some(Value::Number(number)) => Some(*number),
        _ => None,
    };
    let character = values[2].as_ref().and_then(Value::text).and_then(key_character);
    let code = number(&values[3]).map(|code| code as u16);
    let key = (character.is_some() || code.is_some()).then(|| KeyEquivalent { character, code, modifiers: number(&values[4]).unwrap_or(0.0) as u32 });
    Ok(Item {
        title: values[0].as_ref().and_then(Value::text).unwrap_or_default().to_owned(),
        // An item that does not say counts as enabled: only one the app reports disabled is refused.
        enabled: values[1].as_ref().and_then(Value::boolean) != Some(false),
        key,
    })
}

/// The one character of a key equivalent, in lowercase, as a combo names its key.
fn key_character(text: &str) -> Option<char> {
    let mut characters = text.chars();
    match (characters.next(), characters.next()) {
        (Some(character), None) => character.to_lowercase().next(),
        _ => None,
    }
}

/// Every item of the app's own menus whose key equivalent is `combo`: its path of titles, and whether it is enabled.
/// The Apple menu, the menu bar's first, is the system's (Force Quit, Log Out) and is left out. `None` when the menu
/// bar could not be read whole (a menu that did not answer, no time left, more items than a walk reads): what was not
/// read may hold an enabled item with the same key.
fn triggered(pid: i32, combo: &Combo, deadline: Instant) -> Option<Vec<(Vec<String>, bool)>> {
    let Some(bar) = Element::application(pid).element("AXMenuBar") else { return Some(Vec::new()) };
    // The answer must reach the caller before its deadline, with time left to send the key.
    let stop = deadline.checked_sub(ANSWER_MARGIN).unwrap_or(deadline);
    let mut found = Vec::new();
    let mut read_items = 0;
    // Each entry: the item's element, and the titles above it.
    let mut pending: Vec<(Element, Vec<String>)> = below(&bar).ok()?.into_iter().skip(1).rev().map(|menu| (menu, Vec::new())).collect();
    while let Some((element, above)) = pending.pop() {
        read_items += 1;
        if read_items > MAX_ITEMS || Instant::now() >= stop {
            return None;
        }
        let item = read(&element).ok()?;
        let mut path = above;
        path.push(item.title);
        if let Some(key) = &item.key
            && combo.triggers(key)
        {
            found.push((path.clone(), item.enabled));
        }
        // Most items open no menu: one count says so, where reading the children takes two requests.
        if path.len() >= MAX_DEPTH || element.count("AXChildren") == Ok(0) {
            continue;
        }
        // An item's children are the one menu it opens, whose children are the items.
        for menu in below(&element).ok()? {
            for child in below(&menu).ok()?.into_iter().rev() {
                pending.push((child, path.clone()));
            }
        }
    }
    Some(found)
}

/// The item to name in a refusal: the first the shortcut triggers, when it triggers some and the app has none of them
/// enabled.
fn all_disabled(items: &[(Vec<String>, bool)]) -> Option<&[String]> {
    let (path, _) = items.first()?;
    if items.iter().any(|(_, enabled)| *enabled) { None } else { Some(path) }
}

/// Refuses a Command shortcut sent into the event queue of an app in the background when the menu item it triggers is
/// disabled: the app has no key window there, so AppKit hands a Command key to the menu bar only, the key would do
/// nothing, and the press would pass. Every item whose command the focused control or window handles (Copy, Select
/// All, Find) is disabled in the background. The item is not waited for, as a disabled control is: such an item stays
/// disabled for as long as the app is in the background. A shortcut goes on when no item has it, when one that has it
/// is enabled, when the menu bar could not be read whole, and when the app is in front, where its key window can take
/// the key before the menu does.
pub(super) fn refuse_disabled_shortcut(pid: i32, combo: &Combo, deadline: Instant) -> Outcome<()> {
    if !combo.command() || Element::application(pid).boolean("AXFrontmost") == Some(true) {
        return Ok(());
    }
    let items = triggered(pid, combo, deadline).unwrap_or_default();
    let Some(path) = all_disabled(&items) else { return Ok(()) };
    Err(Failure::refused(
        codes::ACTION_FAILED,
        format!(
            "the menu item \"{}\" this shortcut triggers is disabled, so the key would do nothing and was not sent. macOS disables a menu command of the focused control or window (Select All, Find) while the app is in the background; press it with desktop({{ headed: true }})",
            path.join(" > ")
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::{all_disabled, key_character};

    #[test]
    fn refuses_only_when_every_item_the_shortcut_triggers_is_disabled() {
        let item = |title: &str, enabled: bool| (vec!["Edit".to_owned(), title.to_owned()], enabled);
        assert_eq!(all_disabled(&[]), None);
        assert_eq!(all_disabled(&[item("Find", true)]), None);
        assert_eq!(all_disabled(&[item("Find", false), item("Find Again", true)]), None);
        assert_eq!(all_disabled(&[item("Find", false), item("Find Again", false)]).map(|path| path.join(" > ")), Some("Edit > Find".to_owned()));
    }

    #[test]
    fn reads_a_key_equivalents_character_in_lowercase() {
        assert_eq!(key_character("D"), Some('d'));
        assert_eq!(key_character("]"), Some(']'));
        assert_eq!(key_character(""), None);
        assert_eq!(key_character("ab"), None);
    }
}
