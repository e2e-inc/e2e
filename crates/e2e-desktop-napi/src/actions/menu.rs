//! The app's Back command, read from its menu bar: `app.back()` presses the
//! menu item, never a key, so an app without one refuses instead of taking a
//! key that does nothing.

use super::{guarded, perform, unread};
use crate::ax::{self, Accessible, Element};
use crate::failure::{Failure, Outcome, codes};
use serde::Serialize;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// How deep submenus are read below a menu bar item: Back sits in a top menu (Go, History, View) or one level down.
const MAX_MENU_DEPTH: usize = 3;
/// How many menu items one read looks at, at most: an app that builds a huge menu (a bookmarks list) is not read to its end.
const MAX_ITEMS: usize = 4_000;
/// `kAXMenuItemModifierNone`: the item's shortcut is the Command key alone.
const COMMAND_ONLY: i64 = 0;
/// How long the item's enabled state is watched before it is trusted. AppKit validates menu items when a menu opens or
/// on its own about a second after the app's state changed, so until then `AXEnabled` can still say what was true
/// before: Back disabled right after the app went to a new page, or enabled right after it went back to the first.
/// Pressed then, the app ignores the press of an item it has not enabled, which would read as a Back that went.
const REVALIDATION: Duration = Duration::from_millis(1_200);
/// How often the enabled state is read while it is watched.
const REVALIDATION_POLL: Duration = Duration::from_millis(100);

/// How an item names the Back command; a title outranks a shortcut, which an app can give another command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum BackMatch {
    /// Command-[ with no other modifier: the Back shortcut of Finder, Safari, and System Settings.
    Shortcut,
    /// Titled Back or Go Back, whatever its shortcut.
    Title,
}

/// Whether a menu item is the app's Back command, from its title, its key equivalent (`AXMenuItemCmdChar`), and that
/// key's modifiers (`AXMenuItemCmdModifiers`, where 0 is the Command key alone and no value means the same).
pub fn back_match(title: Option<&str>, key: Option<&str>, modifiers: Option<i64>) -> Option<BackMatch> {
    if let Some(title) = title {
        let title = title.trim().trim_end_matches(['…', '.']).trim();
        if title.eq_ignore_ascii_case("back") || title.eq_ignore_ascii_case("go back") {
            return Some(BackMatch::Title);
        }
    }
    (key == Some("[") && modifiers.unwrap_or(COMMAND_ONLY) == COMMAND_ONLY).then_some(BackMatch::Shortcut)
}

/// One menu item that matched, with where it sits.
struct Candidate<E> {
    element: E,
    found: BackMatch,
    /// Whether the item, and every menu and submenu item above it, is enabled: an item under a disabled one is not
    /// one the app takes.
    enabled: bool,
    /// The menu bar item and every submenu item above it, each with what a missing `AXEnabled` reads as. The watch
    /// before the press reads them again with the item, since AppKit validates them as late as the item itself.
    above: Vec<(E, bool)>,
    /// How deep it sits: 1 in a menu of the menu bar, 2 in a submenu of one.
    depth: usize,
    title: String,
    menu: String,
}

/// Which item is the app's Back: of the best kind of match the menu bar has, the one nearest the menu bar, and of
/// those the first in menu order (Go comes before Window). It is pressed only when enabled. A disabled one is not
/// passed over for another, which would press another command: Shift Left for a lesser match in an editor, or a Back
/// in the Window menu or under Open Recent when the navigation menu's own Back is disabled at the first page.
fn choose<E>(candidates: &[Candidate<E>]) -> Result<&Candidate<E>, Option<&Candidate<E>>> {
    let Some(best) = candidates.iter().map(|candidate| candidate.found).max() else { return Err(None) };
    let nearest = candidates.iter().filter(|candidate| candidate.found == best).map(|candidate| candidate.depth).min();
    let chosen = candidates.iter().find(|candidate| candidate.found == best && Some(candidate.depth) == nearest);
    match chosen {
        Some(item) if item.enabled => Ok(item),
        other => Err(other),
    }
}

/// What `back` pressed, for the engine's log.
#[derive(Serialize)]
pub struct Pressed {
    pub title: String,
    pub menu: String,
}

/// Presses the app's Back menu item with `AXPress`: the item titled Back or Go Back, else the one whose shortcut is
/// Command-[. Refuses, sending nothing, when the menu bar has none (`ACTION_NOT_SUPPORTED`) or the item is disabled
/// (`ACTION_FAILED`). No press goes out once `input_id` was cancelled or `deadline` passed.
pub fn back(pid: i32, input_id: Option<u32>, deadline: Instant) -> Outcome<Pressed> {
    guarded(input_id, deadline, || {
        let app = Element::application(pid);
        let bar = match app.attribute("AXMenuBar") {
            Ok(value) => value.element().cloned(),
            Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT | ax::AX_API_DISABLED)) => return Err(unread(error, "read the app's menu bar")),
            Err(_) => None,
        };
        let Some(bar) = bar else {
            return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "the app has no menu bar, so it has no Back command to press"));
        };
        press_back(&bar, deadline, sleep)
    })
}

/// Finds Back in `bar`, watches its enabled state through one validation (`pause` waits between reads), and presses
/// it only when it, and every menu above it, is enabled at the end.
fn press_back<E: Accessible>(bar: &E, deadline: Instant, pause: impl FnMut(Duration)) -> Outcome<Pressed> {
    let candidates = back_candidates(bar, deadline)?;
    let (item, enabled) = match choose(&candidates) {
        Ok(item) => (item, true),
        Err(Some(item)) => (item, false),
        Err(None) => {
            return Err(Failure::refused(
                codes::ACTION_NOT_SUPPORTED,
                "the app's menu bar has no Back command (an item titled Back or Go Back, or one with the shortcut Command-[), so nothing was pressed",
            ));
        }
    };
    let window = watch_window(deadline.saturating_duration_since(Instant::now()).saturating_sub(super::ANSWER_MARGIN))?;
    if !revalidated(enabled, window, REVALIDATION_POLL, || item.enabled_now(), pause)? {
        return Err(Failure::refused(
            codes::ACTION_FAILED,
            format!("{} in the {} menu is disabled: the app has nothing to go back to now, so nothing was pressed", item.title, item.menu),
        ));
    }
    perform(&item.element, "AXPress", &format!("press {} in the {} menu", item.title, item.menu))?;
    Ok(Pressed { title: item.title.clone(), menu: item.menu.clone() })
}

impl<E: Accessible> Candidate<E> {
    /// Whether the item, and every menu and submenu item above it, is enabled now. A stall or a gone element fails;
    /// any other failure reads as what a missing value means for that element.
    fn enabled_now(&self) -> Outcome<bool> {
        for (element, missing) in self.above.iter().chain(std::iter::once(&(self.element.clone(), false))) {
            let enabled = match element.attribute("AXEnabled") {
                Ok(value) => value.boolean().unwrap_or(*missing),
                Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT | ax::AX_API_DISABLED)) => {
                    return Err(unread(error, "read whether Back is enabled"));
                }
                Err(_) => *missing,
            };
            if !enabled {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// How long Back's enabled state is watched before the press: the whole validation, or a refusal when the budget left
/// cannot hold it, since a press on a state not yet validated could go back from a page with nowhere to go.
fn watch_window(left: Duration) -> Outcome<Duration> {
    if left < REVALIDATION {
        return Err(Failure::refused(codes::TIMEOUT, "too little time was left to see whether Back is enabled, so nothing was pressed"));
    }
    Ok(REVALIDATION)
}

/// The enabled state AppKit validated: `read` is polled every `poll` for `window`, and the first value that differs
/// from `first` is the fresh one; none that differs means `first` was already current.
fn revalidated(first: bool, window: Duration, poll: Duration, mut read: impl FnMut() -> Outcome<bool>, mut pause: impl FnMut(Duration)) -> Outcome<bool> {
    let mut waited = Duration::ZERO;
    while waited < window {
        let step = poll.min(window - waited);
        pause(step);
        waited += step;
        let now = read()?;
        if now != first {
            return Ok(now);
        }
    }
    Ok(first)
}

/// Every item of the menu bar's menus, and of their submenus down to `MAX_MENU_DEPTH`, that matches Back, in menu order.
fn back_candidates<E: Accessible>(bar: &E, deadline: Instant) -> Outcome<Vec<Candidate<E>>> {
    let mut candidates = Vec::new();
    let mut seen = 0;
    for top in children(bar, "read the app's menu bar")? {
        let menu = top.text("AXTitle").unwrap_or_default();
        // A menu the app disabled as a whole (no window to act on) disables every item in it.
        let enabled = top.attribute("AXEnabled").ok().and_then(|value| value.boolean()).unwrap_or(true);
        let path = Path { menu, depth: 1, enabled, above: vec![(top.clone(), true)] };
        for list in children(&top, "read a menu")? {
            collect(&list, &path, deadline, &mut seen, &mut candidates)?;
        }
    }
    Ok(candidates)
}

/// Where a menu sits below the menu bar.
struct Path<E> {
    /// The title of the menu bar item it is under.
    menu: String,
    /// 1 for a menu of the menu bar, 2 for a submenu of one.
    depth: usize,
    /// Whether the menu bar item and every item whose submenu holds it read as enabled.
    enabled: bool,
    /// Those items, each with what a missing `AXEnabled` reads as.
    above: Vec<(E, bool)>,
}

/// The items of one menu (`AXMenu`) at `path`, and those of their submenus down to `MAX_MENU_DEPTH`, that match Back.
fn collect<E: Accessible>(list: &E, path: &Path<E>, deadline: Instant, seen: &mut usize, found: &mut Vec<Candidate<E>>) -> Outcome<()> {
    for item in children(list, "read a menu")? {
        if Instant::now() >= deadline {
            return Err(Failure::timeout("reading the app's menu bar"));
        }
        *seen += 1;
        if *seen > MAX_ITEMS {
            return Ok(());
        }
        let values = match item.attributes(&["AXTitle", "AXMenuItemCmdChar", "AXMenuItemCmdModifiers", "AXEnabled"]) {
            Ok(values) => values,
            // A busy app is not read as one with no Back; a separator or an item that answers nothing is skipped.
            Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT | ax::AX_API_DISABLED)) => return Err(unread(error, "read a menu item")),
            Err(_) => continue,
        };
        let title = values[0].as_ref().and_then(|value| value.text().map(str::to_owned));
        let key = values[1].as_ref().and_then(|value| value.text().map(str::to_owned));
        let modifiers = values[2].as_ref().and_then(|value| if let ax::Value::Number(number) = value { Some(*number as i64) } else { None });
        let enabled = path.enabled && values[3].as_ref().and_then(ax::Value::boolean).unwrap_or(false);
        if let Some(kind) = back_match(title.as_deref(), key.as_deref(), modifiers) {
            let title = title.filter(|title| !title.trim().is_empty()).unwrap_or_else(|| "Command-[".into());
            let above = path.above.clone();
            found.push(Candidate { element: item.clone(), found: kind, enabled, above, depth: path.depth, title, menu: path.menu.clone() });
        }
        if path.depth < MAX_MENU_DEPTH {
            let mut above = path.above.clone();
            above.push((item.clone(), false));
            let below = Path { menu: path.menu.clone(), depth: path.depth + 1, enabled, above };
            for submenu in children(&item, "read a submenu")? {
                collect(&submenu, &below, deadline, seen, found)?;
            }
        }
    }
    Ok(())
}

/// An element's children. A stall or a gone element fails, so a busy app is not read as one with no Back; any other
/// failure reads as none.
fn children<E: Accessible>(element: &E, what: &str) -> Outcome<Vec<E>> {
    match element.elements("AXChildren", MAX_ITEMS) {
        Ok(children) => Ok(children),
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT | ax::AX_API_DISABLED)) => Err(unread(error, what)),
        Err(_) => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::{BackMatch, Candidate, back_candidates, back_match, choose, press_back, revalidated};
    use crate::ax::{self, Value};
    use crate::failure::{Failure, codes};
    use crate::fake::Fake;
    use std::time::Duration;
    use std::time::Instant;

    fn item(id: u32, found: BackMatch, enabled: bool) -> Candidate<u32> {
        Candidate { element: id, found, enabled, above: Vec::new(), depth: 1, title: format!("item {id}"), menu: "Go".into() }
    }

    #[test]
    fn names_back_by_its_title_whatever_its_shortcut() {
        assert_eq!(back_match(Some("Back"), Some("["), Some(0)), Some(BackMatch::Title));
        assert_eq!(back_match(Some("Go Back"), None, None), Some(BackMatch::Title));
        assert_eq!(back_match(Some(" back… "), Some("←"), Some(4)), Some(BackMatch::Title));
        assert_eq!(back_match(Some("Backup"), None, None), None);
        assert_eq!(back_match(Some("Go Back to Start"), None, None), None);
    }

    #[test]
    fn names_back_by_command_left_bracket_alone() {
        assert_eq!(back_match(Some("Zurück"), Some("["), Some(0)), Some(BackMatch::Shortcut));
        // No modifiers attribute is the Command key alone.
        assert_eq!(back_match(None, Some("["), None), Some(BackMatch::Shortcut));
        // Shift (1), Option (2), Control (4), or no Command key (8) makes another shortcut.
        for modifiers in [1, 2, 4, 8, 3] {
            assert_eq!(back_match(Some("Shift Left"), Some("["), Some(modifiers)), None, "modifiers {modifiers}");
        }
        assert_eq!(back_match(Some("Forward"), Some("]"), Some(0)), None);
        assert_eq!(back_match(None, None, None), None);
    }

    #[test]
    fn presses_the_first_item_of_the_best_kind_nearest_the_menu_bar() {
        let items = [item(1, BackMatch::Shortcut, true), item(2, BackMatch::Title, true), item(3, BackMatch::Title, true)];
        assert_eq!(choose(&items).ok().map(|chosen| chosen.element), Some(2));
        assert_eq!(choose(&items[..1]).ok().map(|chosen| chosen.element), Some(1));
        // A submenu's Back (File > Open Recent > Back) is not the app's while a menu's own Back is there.
        let nested = [Candidate { depth: 2, ..item(4, BackMatch::Title, true) }, item(5, BackMatch::Title, true)];
        assert_eq!(choose(&nested).ok().map(|chosen| chosen.element), Some(5));
    }

    #[test]
    fn refuses_a_disabled_back_rather_than_press_one_in_another_menu() {
        // Go > Back is disabled at the first page: Window > Back is another command, and is not pressed instead.
        let items = [item(1, BackMatch::Title, false), Candidate { menu: "Window".into(), ..item(2, BackMatch::Title, true) }];
        assert_eq!(choose(&items).err().flatten().map(|disabled| disabled.element), Some(1));
    }

    /// `revalidated` over scripted reads, with the time it paused in all.
    fn watch(first: bool, reads: &[bool]) -> (bool, Duration) {
        let mut reads = reads.iter().copied();
        let mut paused = Duration::ZERO;
        let read = || Ok(reads.next().unwrap_or(first));
        let fresh = revalidated(first, Duration::from_millis(1_200), Duration::from_millis(100), read, |step| paused += step).expect("reads answer");
        (fresh, paused)
    }

    #[test]
    fn trusts_the_first_change_appkit_makes_to_the_enabled_state() {
        // Disabled when read, enabled once AppKit validated the menu: the app has somewhere to go back to.
        assert_eq!(watch(false, &[false, false, true]), (true, Duration::from_millis(300)));
        // Enabled when read, disabled once validated: the app went back to its first page a moment ago.
        assert_eq!(watch(true, &[true, false]), (false, Duration::from_millis(200)));
    }

    #[test]
    fn keeps_a_state_that_stayed_through_a_whole_validation() {
        assert_eq!(watch(true, &[]), (true, Duration::from_millis(1_200)));
        assert_eq!(watch(false, &[]), (false, Duration::from_millis(1_200)));
        // No time left to watch: the state read is all there is.
        let fresh = revalidated(true, Duration::ZERO, Duration::from_millis(100), || Ok(false), |_| panic!("no pause"));
        assert!(fresh.expect("no read"));
    }

    #[test]
    fn refuses_to_press_when_the_budget_cannot_hold_the_watch() {
        assert_eq!(super::watch_window(Duration::from_secs(30)).ok(), Some(super::REVALIDATION));
        let short = super::watch_window(super::REVALIDATION - Duration::from_millis(1)).expect_err("too short");
        assert_eq!((short.code, short.delivery), (codes::TIMEOUT, crate::failure::Delivery::NotDelivered));
    }

    #[test]
    fn fails_on_a_read_the_app_did_not_answer() {
        let failed =
            revalidated(false, Duration::from_millis(500), Duration::from_millis(100), || Err(Failure::refused(codes::APP_UNRESPONSIVE, "busy")), |_| ());
        assert_eq!(failed.err().map(|failure| failure.code), Some(codes::APP_UNRESPONSIVE));
    }

    /// A menu item titled `title`, with an optional key equivalent, enabled or not.
    fn menu_item(title: &str, key: Option<&str>, enabled: bool) -> Fake {
        let item = Fake::new("AXMenuItem").title(title).with("AXEnabled", Value::Bool(enabled));
        match key {
            Some(key) => item.text("AXMenuItemCmdChar", key).with("AXMenuItemCmdModifiers", Value::Number(0.0)),
            None => item,
        }
    }

    /// A menu bar item titled `title` whose menu holds `items`.
    fn top(title: &str, items: Vec<Fake>) -> Fake {
        Fake::new("AXMenuBarItem").title(title).children(vec![Fake::new("AXMenu").children(items)])
    }

    #[test]
    fn walks_the_menu_bar_and_its_submenus_for_back() {
        // Edit binds Command-[ to Shift Left; History holds Back in a submenu.
        let history = top(
            "History",
            vec![
                menu_item("Show All History", None, true),
                menu_item("Recent", None, true).children(vec![Fake::new("AXMenu").children(vec![menu_item("Back", None, true)])]),
            ],
        );
        let bar = Fake::new("AXMenuBar").children(vec![top("Edit", vec![menu_item("Shift Left", Some("["), true)]), history]);
        let found = back_candidates(&bar, Instant::now() + Duration::from_secs(60)).expect("a walk");
        let summary: Vec<(&str, &str, BackMatch)> =
            found.iter().map(|candidate| (candidate.menu.as_str(), candidate.title.as_str(), candidate.found)).collect();
        assert_eq!(summary, [("Edit", "Shift Left", BackMatch::Shortcut), ("History", "Back", BackMatch::Title)]);
        assert_eq!(choose(&found).ok().map(|chosen| chosen.title.as_str()), Some("Back"), "a title outranks the shortcut");
    }

    #[test]
    fn reads_an_item_under_a_disabled_menu_or_submenu_as_disabled() {
        let open_recent = menu_item("Open Recent", None, false).children(vec![Fake::new("AXMenu").children(vec![menu_item("Back", None, true)])]);
        let bar = Fake::new("AXMenuBar")
            .children(vec![top("File", vec![open_recent]), top("Go", vec![menu_item("Back", None, true)]).with("AXEnabled", Value::Bool(false))]);
        let found = back_candidates(&bar, Instant::now() + Duration::from_secs(60)).expect("a walk");
        let summary: Vec<(&str, usize, bool)> = found.iter().map(|candidate| (candidate.menu.as_str(), candidate.depth, candidate.enabled)).collect();
        assert_eq!(summary, [("File", 2, false), ("Go", 1, false)]);
    }

    #[test]
    fn fails_a_menu_bar_walk_the_app_did_not_answer() {
        let busy = Fake::new("AXMenuBar").children(vec![top("Go", vec![menu_item("Back", None, true)]).failing("AXChildren", ax::AX_CANNOT_COMPLETE)]);
        let failed = back_candidates(&busy, Instant::now() + Duration::from_secs(60)).err();
        assert_eq!(failed.map(|failure| failure.code), Some(codes::APP_UNRESPONSIVE), "a busy app is not one with no Back");
    }

    #[test]
    fn refuses_a_disabled_back_rather_than_press_a_lesser_match() {
        // Back is disabled with nothing to go back to: Command-[ on another item (Shift Left) is not pressed instead.
        let items = [item(1, BackMatch::Shortcut, true), item(2, BackMatch::Title, false)];
        assert_eq!(choose(&items).err().flatten().map(|disabled| disabled.element), Some(2));
        let none: [Candidate<u32>; 0] = [];
        assert!(matches!(choose(&none), Err(None)));
    }

    /// `press_back` on `bar` with a minute left; `validate` runs at each pause, as AppKit validates the menus.
    fn press(bar: &Fake, mut validate: impl FnMut()) -> Result<(String, String), Failure> {
        press_back(bar, Instant::now() + Duration::from_secs(60), |_| validate()).map(|pressed| (pressed.menu, pressed.title))
    }

    #[test]
    fn never_presses_a_back_its_menu_keeps_disabled() {
        // Go is disabled as a whole while its Back reads enabled: the watch reads Go again and never presses.
        let back = menu_item("Back", None, true);
        let go = top("Go", vec![back.clone()]).with("AXEnabled", Value::Bool(false));
        let refused = press(&Fake::new("AXMenuBar").children(vec![go]), || ()).expect_err("refused");
        assert_eq!(refused.code, codes::ACTION_FAILED);
        assert!(back.sent().is_empty(), "nothing was pressed");
        // The same under a disabled submenu item: File > Open Recent > Back.
        let back = menu_item("Back", None, true);
        let open_recent = menu_item("Open Recent", None, false).children(vec![Fake::new("AXMenu").children(vec![back.clone()])]);
        let refused = press(&Fake::new("AXMenuBar").children(vec![top("File", vec![open_recent])]), || ()).expect_err("refused");
        assert_eq!(refused.code, codes::ACTION_FAILED);
        assert!(back.sent().is_empty(), "nothing was pressed");
    }

    #[test]
    fn presses_a_back_once_its_menu_and_itself_are_validated_enabled() {
        // Go and its Back both read disabled, then AppKit enables Go and Back: the press goes out.
        let back = menu_item("Back", None, false);
        let go = top("Go", vec![back.clone()]).with("AXEnabled", Value::Bool(false));
        let bar = Fake::new("AXMenuBar").children(vec![go.clone()]);
        let pressed = press(&bar, || {
            go.set("AXEnabled", Ok(Value::Bool(true)));
            back.set("AXEnabled", Ok(Value::Bool(true)));
        });
        assert_eq!(pressed.expect("pressed"), ("Go".to_owned(), "Back".to_owned()));
        assert_eq!(back.sent(), ["perform AXPress"]);
    }

    #[test]
    fn refuses_a_back_appkit_disables_during_the_watch() {
        let back = menu_item("Back", None, true);
        let bar = Fake::new("AXMenuBar").children(vec![top("Go", vec![back.clone()])]);
        let refused = press(&bar, || back.set("AXEnabled", Ok(Value::Bool(false)))).expect_err("refused");
        assert_eq!(refused.code, codes::ACTION_FAILED);
        assert!(back.sent().is_empty(), "nothing was pressed");
        let none = press(&Fake::new("AXMenuBar").children(vec![top("Edit", vec![menu_item("Undo", Some("z"), true)])]), || ()).expect_err("none");
        assert_eq!(none.code, codes::ACTION_NOT_SUPPORTED);
    }
}
