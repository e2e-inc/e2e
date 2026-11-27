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

/// The menus of the app's own menu bar. The Apple menu, the bar's first, is the system's (Force Quit, Log Out) and is
/// left out.
fn app_menus(pid: i32) -> Outcome<Vec<Element>> {
    let bar = match Element::application(pid).attribute("AXMenuBar") {
        Ok(Value::Element(bar)) => bar,
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_API_DISABLED)) => return Err(unread(error, "read the menu bar")),
        _ => return Err(Failure::refused(codes::ACTION_FAILED, "the app has no menu bar")),
    };
    Ok(below(&bar)?.into_iter().skip(1).collect())
}

/// The items of the menu an item opens; none for an item that opens no menu.
fn items_under(item: &Element) -> Outcome<Option<Vec<Element>>> {
    // Most items open no menu: one count says so, where reading the children takes two requests.
    if item.count("AXChildren") == Ok(0) {
        return Ok(None);
    }
    // An item's children are the one menu it opens, whose children are the items.
    let menus = below(item)?;
    let mut items = Vec::new();
    for menu in &menus {
        items.extend(below(menu)?);
    }
    Ok((!menus.is_empty()).then_some(items))
}

/// The first disabled item of the app's own menus whose key equivalent is `combo`, as its path of titles: the one a
/// refusal names. `None` when no item has the key, when an item that has it is enabled, and when the menu bar could
/// not be read whole (no menu bar, a menu that did not answer, no time left, more items than a walk reads): what was
/// not read may hold an enabled item with the same key.
fn disabled_item(pid: i32, combo: &Combo, deadline: Instant) -> Option<Vec<String>> {
    // The answer must reach the caller before its deadline, with time left to send the key.
    let stop = deadline.checked_sub(ANSWER_MARGIN).unwrap_or(deadline);
    let mut disabled = None;
    let mut read_items = 0;
    // Each entry: the item's element, and the titles above it.
    let mut pending: Vec<(Element, Vec<String>)> = app_menus(pid).ok()?.into_iter().rev().map(|menu| (menu, Vec::new())).collect();
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
            if item.enabled {
                return None;
            }
            disabled.get_or_insert_with(|| path.clone());
        }
        if path.len() >= MAX_DEPTH {
            continue;
        }
        for child in items_under(&element).ok()?.unwrap_or_default().into_iter().rev() {
            pending.push((child, path.clone()));
        }
    }
    disabled
}

/// Why a menu item is disabled while its app is in the background, for a refusal that names one.
const BACKGROUND_DISABLES: &str =
    "macOS disables a menu command of the focused control or window (Select All, Find) while the app is in the background; use desktop({ headed: true })";

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
    let Some(path) = disabled_item(pid, combo, deadline) else { return Ok(()) };
    Err(Failure::refused(
        codes::ACTION_FAILED,
        format!(
            "the menu item \"{}\" this shortcut triggers is disabled, so the key would do nothing and was not sent. {BACKGROUND_DISABLES}",
            path.join(" > ")
        ),
    ))
}

/// The titles a menu shows, for a refusal that names what it has instead of what was asked; separators have none.
fn listed(titles: &[String]) -> String {
    const SHOWN: usize = 30;
    let named: Vec<&String> = titles.iter().filter(|title| !title.is_empty()).collect();
    let more = if named.len() > SHOWN { format!(", and {} more", named.len() - SHOWN) } else { String::new() };
    format!("{}{more}", named.iter().take(SHOWN).map(|title| format!("\"{title}\"")).collect::<Vec<_>>().join(", "))
}

fn titles_of(items: &[Element]) -> Outcome<Vec<String>> {
    items.iter().map(|item| read(item).map(|item| item.title)).collect()
}

/// Every item of `level` titled `title`; with none, a refusal that lists what `holder` has.
fn titled(level: &[Element], title: &str, holder: &str) -> Outcome<Vec<Element>> {
    let titles = titles_of(level)?;
    let found: Vec<Element> = level.iter().zip(&titles).filter(|(_, own)| *own == title).map(|(item, _)| item.clone()).collect();
    if found.is_empty() {
        // Not a select's ELEMENT_NOT_FOUND for a missing option: the engine reads that code as a stale node and
        // retries, and the menu will lack the title again.
        return Err(Failure::refused(codes::ACTION_FAILED, format!("{holder} has no item \"{title}\"; it has {}", listed(&titles))));
    }
    Ok(found)
}

/// A path's last title, the item's, and the titles of the menus above it. A path with no title names nothing, and an
/// empty title would match a separator, which has none.
fn split(path: &[String]) -> Outcome<(&String, &[String])> {
    match path.split_last() {
        Some(split) if path.iter().all(|title| !title.is_empty()) => Ok(split),
        _ => Err(Failure::refused(
            codes::ACTION_FAILED,
            "a menu item is named by its titles from the menu bar down, none empty, such as desktop.menu('Edit', 'Select All')",
        )),
    }
}

/// Chooses the item of the app's menu bar that `path` names, title by title from the menu bar down, with a press of the
/// item itself: no menu opens on screen, so it works on an app in the background, for an item the app has enabled there.
/// With `physical` the app comes forward first, with `window` when it has one, so the items its focused control
/// handles are enabled; an item still disabled is waited for within the budget, as a disabled option is. Without it a
/// disabled item is refused at once: it stays disabled for as long as the app is in the background. Of two items of
/// one title, the first enabled one is chosen. The Apple menu is the system's and is not searched.
pub fn choose(pid: i32, path: &[String], window: Option<u32>, physical: bool, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    let (leaf, parents) = split(path)?;
    guarded(input_id, deadline, || {
        if physical {
            match window {
                Some(id) => raise(pid, &windows::find(pid, id)?)?,
                None => {
                    activate(pid)?;
                    if !until(deadline, || Element::application(pid).boolean("AXFrontmost") == Some(true)) {
                        return Err(Failure::refused(codes::ACTION_FAILED, "the app could not be brought forward"));
                    }
                }
            }
        }
        let mut level = app_menus(pid)?;
        let mut holder = "the menu bar".to_owned();
        for (depth, title) in parents.iter().enumerate() {
            let mut opened = None;
            for item in titled(&level, title, &holder)? {
                opened = items_under(&item)?;
                if opened.is_some() {
                    break;
                }
            }
            let Some(items) = opened else {
                let next = &path[depth + 1];
                return Err(Failure::refused(
                    codes::ACTION_FAILED,
                    format!("\"{}\" is a menu item, not a menu, so it has no item \"{next}\"", path[..=depth].join(" > ")),
                ));
            };
            level = items;
            holder = format!("the menu \"{title}\"");
        }
        let name = path.join(" > ");
        let mut found = Vec::new();
        let mut submenu = None;
        for item in titled(&level, leaf, &holder)? {
            match items_under(&item)? {
                Some(items) => submenu = submenu.or(Some(items)),
                None => found.push(item),
            }
        }
        // A press of an item that opens a menu would open it on screen.
        if let Some(items) = submenu.filter(|_| found.is_empty()) {
            return Err(Failure::refused(codes::ACTION_FAILED, format!("\"{name}\" opens a menu; name one of its items: {}", listed(&titles_of(&items)?))));
        }
        let (wait_until, disabled) = if physical {
            (deadline, format!("the menu item \"{name}\" is disabled"))
        } else {
            (Instant::now(), format!("the menu item \"{name}\" is disabled, so nothing was sent. {BACKGROUND_DISABLES}"))
        };
        let item = enabled_of(&found, wait_until, "choose the menu item", &disabled)?;
        perform(&item, "AXPress", "choose the menu item")
    })
}

#[cfg(test)]
mod tests {
    use super::{key_character, listed, split};

    fn path(titles: &[&str]) -> Vec<String> {
        titles.iter().map(|title| (*title).to_owned()).collect()
    }

    #[test]
    fn lists_a_menus_titles_without_its_separators() {
        assert_eq!(listed(&path(&["Undo", "", "Find…"])), "\"Undo\", \"Find…\"");
        let many: Vec<String> = (0..32).map(|index| format!("Item {index}")).collect();
        assert!(listed(&many).ends_with("\"Item 29\", and 2 more"));
    }

    #[test]
    fn splits_a_path_into_its_item_and_the_menus_above_and_refuses_one_that_names_nothing() {
        let named = path(&["Edit", "Find", "Find…"]);
        assert!(split(&named).is_ok_and(|(leaf, parents)| leaf == "Find…" && parents == &named[..2]));
        assert!(split(&path(&["Quit"])).is_ok_and(|(leaf, parents)| leaf == "Quit" && parents.is_empty()));
        assert!(split(&[]).is_err());
        assert!(split(&path(&["Edit", ""])).is_err());
        assert!(split(&path(&["", "Copy"])).is_err());
    }

    #[test]
    fn reads_a_key_equivalents_character_in_lowercase() {
        assert_eq!(key_character("D"), Some('d'));
        assert_eq!(key_character("]"), Some(']'));
        assert_eq!(key_character(""), None);
        assert_eq!(key_character("ab"), None);
    }
}
