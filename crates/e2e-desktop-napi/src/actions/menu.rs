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

/// The children of a menu-bar element, or of the menu an item opens. A stall fails the walk: a menu bar read in part
/// cannot show that no item has a key equivalent.
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
/// The Apple menu, the menu bar's first, is the system's (Force Quit, Log Out) and is left out. None for an app with no
/// menu bar.
fn triggered(pid: i32, combo: &Combo, deadline: Instant) -> Outcome<Vec<(Vec<String>, bool)>> {
    let Some(bar) = Element::application(pid).element("AXMenuBar") else { return Ok(Vec::new()) };
    let mut found = Vec::new();
    let mut read_items = 0;
    // Each entry: the item's element, and the titles above it.
    let mut pending: Vec<(Element, Vec<String>)> = below(&bar)?.into_iter().skip(1).rev().map(|menu| (menu, Vec::new())).collect();
    while let Some((element, above)) = pending.pop() {
        if Instant::now() >= deadline {
            return Err(Failure::timeout("reading the menu bar"));
        }
        read_items += 1;
        if read_items > MAX_ITEMS {
            break;
        }
        let item = read(&element)?;
        let mut path = above;
        path.push(item.title);
        if let Some(key) = &item.key
            && combo.triggers(key)
        {
            found.push((path.clone(), item.enabled));
        }
        if path.len() >= MAX_DEPTH {
            continue;
        }
        // An item's children are the one menu it opens, whose children are the items.
        for menu in below(&element)? {
            for child in below(&menu)?.into_iter().rev() {
                pending.push((child, path.clone()));
            }
        }
    }
    Ok(found)
}

/// Refuses a Command shortcut sent into the process's event queue when the menu item it triggers is disabled: AppKit
/// hands a Command key to key equivalents only, so the key would do nothing, and the press would pass. An app in the
/// background has no key window, so every item whose command the focused control or window handles (Copy, Select All,
/// Find) is disabled there. The item is not waited for, as a disabled control is: it stays disabled for as long as the
/// app is in the background. A shortcut no item has, or one of an enabled item, goes on.
pub(super) fn refuse_disabled_shortcut(pid: i32, combo: &Combo, deadline: Instant) -> Outcome<()> {
    if !combo.command() {
        return Ok(());
    }
    let items = triggered(pid, combo, deadline)?;
    let Some((path, _)) = items.first() else { return Ok(()) };
    if items.iter().any(|(_, enabled)| *enabled) {
        return Ok(());
    }
    Err(Failure::refused(
        codes::ACTION_FAILED,
        format!(
            "the menu item \"{}\" this shortcut triggers is disabled, so the key would do nothing and was not sent. An app in the background has no key window, which disables the menu commands of its focused control; press it with desktop({{ headed: true }})",
            path.join(" > ")
        ),
    )
    .with_details(serde_json::json!({ "cause": "menu_item_disabled" })))
}

#[cfg(test)]
mod tests {
    use super::key_character;

    #[test]
    fn reads_a_key_equivalents_character_in_lowercase() {
        assert_eq!(key_character("D"), Some('d'));
        assert_eq!(key_character("]"), Some(']'));
        assert_eq!(key_character(""), None);
        assert_eq!(key_character("ab"), None);
    }
}
