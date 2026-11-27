//! The app's menu bar, read through accessibility: which item a key equivalent triggers, whether the app has it
//! enabled, and a press of the item a path of titles names.

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

/// Why a menu item is disabled while its app is in the background, for a refusal that names one.
const BACKGROUND_DISABLES: &str = "macOS disables a menu command of the focused control or window (Select All, Find) while the app is in the background; choose it with desktop({ headed: true })";

/// The titles a menu shows, for a refusal that names what it has instead of what was asked; separators have none.
fn titles(items: &[(Element, Item)]) -> String {
    const SHOWN: usize = 30;
    let named: Vec<&str> = items.iter().map(|(_, item)| item.title.as_str()).filter(|title| !title.is_empty()).collect();
    let more = if named.len() > SHOWN { format!(", and {} more", named.len() - SHOWN) } else { String::new() };
    format!("{}{more}", named.iter().take(SHOWN).map(|title| format!("\"{title}\"")).collect::<Vec<_>>().join(", "))
}

/// Chooses the item of the app's menu bar that `path` names, title by title from the menu bar down, with a press of the
/// item itself: no menu opens on screen, so it works on an app in the background, for an item the app has enabled there.
/// With `physical` the app comes forward first, with `window` when it has one, so the items its focused control
/// handles are enabled; an item still disabled is waited for within the budget, as a disabled control is. Without it a
/// disabled item is refused at once: it stays disabled for as long as the app is in the background. Of two items of
/// one title, an enabled one is chosen. The Apple menu is the system's and is not searched.
pub fn choose(pid: i32, path: &[String], window: Option<u32>, physical: bool, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    if path.is_empty() {
        return Err(Failure::refused(codes::INVALID_ARGS, "a menu item is named by its path of titles, such as Edit, Select All"));
    }
    guarded(input_id, deadline, || {
        let app = Element::application(pid);
        if physical {
            match window {
                Some(id) => raise(pid, &windows::find(pid, id)?)?,
                None => {
                    go("bring the app forward")?;
                    let _ = app.set_bool("AXFrontmost", true);
                    if !until(deadline, || app.boolean("AXFrontmost") == Some(true)) {
                        return Err(Failure::refused(codes::ACTION_FAILED, "the app could not be brought forward"));
                    }
                }
            }
        }
        let bar = app.element("AXMenuBar").ok_or_else(|| Failure::refused(codes::ACTION_FAILED, "the app has no menu bar"))?;
        let mut level: Vec<Element> = below(&bar)?.into_iter().skip(1).collect();
        let mut holder = "the menu bar".to_owned();
        let mut chosen = None;
        for title in path {
            let items = level.iter().map(|element| Ok((element.clone(), read(element)?))).collect::<Outcome<Vec<_>>>()?;
            let named = || items.iter().filter(|(_, item)| item.title == *title);
            let Some((element, item)) = named().find(|(_, item)| item.enabled).or_else(|| named().next()) else {
                return Err(Failure::refused(codes::ACTION_FAILED, format!("{holder} has no item \"{title}\"; it has {}", titles(&items))));
            };
            level = Vec::new();
            for menu in below(element)? {
                level.extend(below(&menu)?);
            }
            holder = format!("the menu \"{title}\"");
            chosen = Some((element.clone(), item.enabled));
        }
        let Some((element, enabled_now)) = chosen else { return Err(Failure::refused(codes::INVALID_ARGS, "no menu item was named")) };
        let name = path.join(" > ");
        if !level.is_empty() {
            let items = level.iter().map(|element| Ok((element.clone(), read(element)?))).collect::<Outcome<Vec<_>>>()?;
            return Err(Failure::refused(codes::ACTION_FAILED, format!("\"{name}\" opens a menu; name one of its items: {}", titles(&items))));
        }
        if physical {
            enabled(&element, deadline, "choose the menu item").map_err(|failure| {
                if failure.code == codes::ACTION_FAILED { Failure { message: format!("the menu item \"{name}\" is disabled"), ..failure } } else { failure }
            })?;
        } else if !enabled_now {
            return Err(Failure::refused(codes::ACTION_FAILED, format!("the menu item \"{name}\" is disabled, so nothing was sent. {BACKGROUND_DISABLES}")));
        }
        perform(&element, "AXPress", "choose the menu item")
    })
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
