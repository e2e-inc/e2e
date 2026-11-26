//! Actions on the element a ref names, through the accessibility API
//! unless they need the real pointer or keyboard. Each one says whether
//! anything reached the app when it fails, and checks its effect where the
//! element shows it (a box's state, a field's value, a list's choice).

use crate::ax::{self, AXError, Element, Value};
use crate::failure::{Failure, Outcome, codes};
use crate::input::{self, Pointer, Route};
use crate::refs::{self, Entry};
use crate::roles;
use crate::windows;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// How long an action that opens a menu or a modal waits for the app to answer before it counts as delivered.
const BLOCKING_ACTION_SECONDS: f32 = 0.5;

/// How long an effect is polled for before the action is reported unconfirmed.
const EFFECT_WAIT: Duration = Duration::from_millis(1_000);

/// How long an action that opens a menu waits for it to show.
const MENU_SHOW_WAIT: Duration = Duration::from_millis(1_000);

/// How often an effect is polled.
const POLL: Duration = Duration::from_millis(30);

/// What `act` does.
pub enum Action {
    Click,
    DoubleClick,
    RightClick,
    Focus,
    Clear,
    Check(bool),
    ScrollTo,
    Hover,
    SetValue(String),
    Select(String),
    Scroll {
        direction: String,
        pages: f64,
    },
    /// `id` names the run for `input::cancel_typing`.
    Type {
        text: String,
        physical: bool,
        id: Option<u32>,
    },
}

/// The failure for an AX error of a request that changed nothing.
fn refused(error: AXError, what: &str) -> Failure {
    match error {
        ax::AX_INVALID_ELEMENT => Failure::refused(codes::STALE_REF, format!("{what}: the element no longer exists")),
        ax::AX_ACTION_UNSUPPORTED | ax::AX_ATTRIBUTE_UNSUPPORTED | ax::AX_NOT_IMPLEMENTED => {
            Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("{what}: {}", ax::describe(error)))
        }
        ax::AX_API_DISABLED => Failure::refused(codes::PERM_DENIED, format!("{what}: {}", ax::describe(error))),
        ax::AX_ILLEGAL_ARGUMENT => Failure::refused(codes::ACTION_FAILED, format!("{what}: {}", ax::describe(error))),
        _ => Failure::unconfirmed(codes::ACTION_FAILED, format!("{what}: {}", ax::describe(error))),
    }
}

/// The element a ref names, checked to still exist.
fn resolve(reference: &str) -> Outcome<Entry> {
    let entry = refs::get(reference).ok_or_else(|| Failure::refused(codes::STALE_REF, format!("{reference} names no element of a recent snapshot")))?;
    match entry.element.attribute("AXRole") {
        Err(ax::AX_INVALID_ELEMENT) => Err(Failure::refused(codes::STALE_REF, format!("{reference}: the element no longer exists"))),
        Err(ax::AX_CANNOT_COMPLETE) => {
            Err(Failure::refused(codes::APP_UNRESPONSIVE, "the app did not answer in time").with_details(serde_json::json!({ "retryable": true })))
        }
        _ => Ok(entry),
    }
}

/// Polls `check` until it holds or the effect wait (bounded by the deadline) ends.
fn until(deadline: Instant, mut check: impl FnMut() -> bool) -> bool {
    let end = (Instant::now() + EFFECT_WAIT).min(deadline);
    loop {
        if check() {
            return true;
        }
        if Instant::now() + POLL >= end {
            return check();
        }
        sleep(POLL);
    }
}

/// Performs an AX action. An action that opens a menu or a modal runs inside the app's handler and answers only once it
/// closes, so the call times out: the action is running if the app still answers another request meanwhile, which it
/// does only from inside that handler's own event loop. An app that answers nothing may never have taken the action.
fn perform(element: &Element, action: &str, what: &str) -> Outcome<()> {
    element.set_timeout(BLOCKING_ACTION_SECONDS);
    let result = element.perform(action);
    let outcome = match result {
        Ok(()) => Ok(()),
        Err(ax::AX_CANNOT_COMPLETE) if element.attribute("AXRole").is_ok() => Ok(()),
        Err(ax::AX_CANNOT_COMPLETE) => {
            Err(Failure::unconfirmed(codes::APP_UNRESPONSIVE, format!("{what}: the app did not answer the action, or anything after it")))
        }
        Err(error) => Err(refused(error, what)),
    };
    element.set_timeout(0.0);
    outcome
}

fn raw_role(element: &Element) -> (String, &'static str) {
    let values = element.attributes(&["AXRole", "AXSubrole"]).unwrap_or_else(|_| vec![None, None]);
    let ax_role = values[0].as_ref().and_then(|value| value.text().map(str::to_owned)).unwrap_or_default();
    let subrole = values[1].as_ref().and_then(|value| value.text().map(str::to_owned));
    let role = roles::role(&ax_role, subrole.as_deref());
    (ax_role, role)
}

fn toggle_state(element: &Element) -> Option<u8> {
    match element.attribute("AXValue").ok()? {
        Value::Number(number) => Some(number as u8),
        Value::Bool(value) => Some(value as u8),
        Value::Text(text) => text.trim().parse::<u8>().ok(),
        _ => None,
    }
}

/// The text a value attribute holds now.
fn value_text(element: &Element) -> Option<String> {
    element.attribute("AXValue").ok().and_then(|value| value.display())
}

/// The element's center on screen.
fn center(element: &Element) -> Outcome<(f64, f64)> {
    let (x, y, width, height) = element.frame().ok_or_else(|| Failure::refused(codes::ACTION_FAILED, "the element has no frame on screen"))?;
    if width <= 0.0 || height <= 0.0 {
        return Err(Failure::refused(codes::ACTION_FAILED, "the element has no area on screen"));
    }
    Ok((x + width / 2.0, y + height / 2.0))
}

/// Brings the window forward and the app with it, for physical input.
pub fn raise(pid: i32, window: &Element) -> Outcome<()> {
    let app = Element::application(pid);
    let _ = app.set_bool("AXFrontmost", true);
    let _ = window.perform("AXRaise");
    let _ = window.set_bool("AXMain", true);
    let deadline = Instant::now() + Duration::from_millis(1_500);
    let forward = until(deadline, || app.boolean("AXFrontmost") == Some(true) && app.element("AXFocusedWindow").as_ref() == Some(window));
    if forward { Ok(()) } else { Err(Failure::refused(codes::ACTION_FAILED, "the window could not be brought forward")) }
}

/// Whether the element at a point on screen is `element` or inside it.
fn hits(pid: i32, element: &Element, x: f64, y: f64) -> bool {
    let app = Element::application(pid);
    let Some(mut hit) = app.element_at(x, y) else { return false };
    for _ in 0..32 {
        if &hit == element {
            return true;
        }
        match hit.element("AXParent") {
            Some(parent) => hit = parent,
            None => return false,
        }
    }
    false
}

/// Physical pointer input at the element's center, once its window is forward and nothing covers it.
fn physical(entry: &Entry, action: Pointer) -> Outcome<()> {
    let window = windows::find(entry.pid, entry.window)?;
    raise(entry.pid, &window)?;
    let (x, y) = center(&entry.element)?;
    if !hits(entry.pid, &entry.element, x, y) {
        return Err(Failure::refused(codes::ACTION_FAILED, "another element covers the center of this one, so the pointer would land there"));
    }
    input::pointer(x, y, action).map_err(Failure::delivered)
}

/// Waits a moment for a menu an action opened to show, so the next read finds it; an action that opens none waits it out and is still done.
fn menu_shown(pid: i32, before: usize, deadline: Instant) {
    until(deadline.min(Instant::now() + MENU_SHOW_WAIT), || windows::open_menus(pid) > before);
}

fn click(entry: &Entry, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    let names = element.actions().map_err(|error| refused(error, "click"))?;
    if let Some(action) = ["AXPress", "AXOpen", "AXConfirm"].into_iter().find(|name| names.iter().any(|candidate| candidate == name)) {
        let (ax_role, _) = raw_role(element);
        let opens_menu = ax_role == "AXPopUpButton" || ax_role == "AXMenuButton";
        let before = windows::open_menus(entry.pid);
        perform(element, action, "click")?;
        if opens_menu {
            menu_shown(entry.pid, before, deadline);
        }
        return Ok(());
    }
    let (_, role) = raw_role(element);
    if matches!(role, "row" | "cell" | "treeitem" | "option" | "tab") && element.settable("AXSelected").unwrap_or(false) {
        element.set_bool("AXSelected", true).map_err(|error| refused(error, "select"))?;
        if until(deadline, || element.boolean("AXSelected") == Some(true)) {
            return Ok(());
        }
        return Err(Failure::unconfirmed(codes::ACTION_FAILED, "the element did not become selected"));
    }
    if roles::takes_text(role) && element.settable("AXFocused").unwrap_or(false) {
        return focus(element, deadline);
    }
    Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("this {role} takes no click through accessibility")))
}

fn focus(element: &Element, deadline: Instant) -> Outcome<()> {
    if element.boolean("AXFocused") == Some(true) {
        return Ok(());
    }
    element.set_bool("AXFocused", true).map_err(|error| refused(error, "focus"))?;
    if until(deadline, || element.boolean("AXFocused") == Some(true)) {
        Ok(())
    } else {
        Err(Failure::unconfirmed(codes::ACTION_FAILED, "focus: the element did not take keyboard focus"))
    }
}

fn check(element: &Element, wanted: bool, deadline: Instant) -> Outcome<()> {
    let target = wanted as u8;
    let mut shown = toggle_state(element);
    let reached = press_to_state(
        target,
        shown,
        || perform(element, "AXPress", if wanted { "check" } else { "uncheck" }),
        || {
            let before = shown;
            until(deadline, || toggle_state(element) != before);
            shown = toggle_state(element);
            shown
        },
    )?;
    if reached {
        Ok(())
    } else {
        Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("the box is still not {}", if wanted { "checked" } else { "unchecked" })))
    }
}

/// The states a box can show: off, on, and mixed.
const BOX_STATES: usize = 3;

/// Presses a box until it shows `target`, at most once per state it can show: an AppKit box goes mixed, on, off, so
/// unchecking a mixed box takes two presses. `settle` waits for the state a press led to. It stops early when the state
/// cannot be read or a press changed nothing, so a box that does not answer is not pressed again and again. A failed
/// first press sent nothing; a failed later one follows a press that landed.
fn press_to_state(target: u8, shown: Option<u8>, mut press: impl FnMut() -> Outcome<()>, mut settle: impl FnMut() -> Option<u8>) -> Outcome<bool> {
    if shown == Some(target) {
        return Ok(true);
    }
    let mut before = shown;
    for attempt in 0..BOX_STATES {
        press().map_err(|failure| if attempt == 0 { failure } else { failure.delivered() })?;
        let now = settle();
        if now == Some(target) {
            return Ok(true);
        }
        if now.is_none() || now == before {
            return Ok(false);
        }
        before = now;
    }
    Ok(false)
}

fn set_value(element: &Element, text: &str, deadline: Instant) -> Outcome<()> {
    let (ax_role, role) = raw_role(element);
    let secure = ax_role == "AXSecureTextField" || element.text("AXSubrole").as_deref() == Some("AXSecureTextField");
    if !element.settable("AXValue").unwrap_or(false) {
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("the value of this {role} cannot be set")));
    }
    // A field that holds focus commits its text the way typing does; one that cannot take focus still takes the value.
    // Focus moved by this call has reached the app (its handlers may have run), so a later failure is no longer "nothing sent".
    let moved_focus = roles::takes_text(role)
        && element.settable("AXFocused").unwrap_or(false)
        && element.boolean("AXFocused") != Some(true)
        && element.set_bool("AXFocused", true).is_ok();
    let numeric = matches!(element.attribute("AXValue"), Ok(Value::Number(_)));
    let written = match (numeric, text.trim().parse::<f64>()) {
        (true, Ok(number)) => element.set_number("AXValue", number),
        _ => element.set_text("AXValue", text),
    };
    written.map_err(|error| if moved_focus { refused(error, "set value").delivered() } else { refused(error, "set value") })?;
    if secure {
        return Ok(());
    }
    let expected = if numeric { text.trim().parse::<f64>().map(ax::format_number).unwrap_or_else(|_| text.to_owned()) } else { text.to_owned() };
    if until(deadline, || value_text(element).as_deref() == Some(expected.as_str())) {
        Ok(())
    } else {
        Err(Failure::unconfirmed(codes::ACTION_FAILED, "the value did not change to the text set"))
    }
}

/// The text an item of a list or menu shows.
fn item_label(element: &Element) -> Option<String> {
    let values = element.attributes(&["AXTitle", "AXValue", "AXDescription"]).ok()?;
    if let Some(text) = values.into_iter().flatten().find_map(|value| value.text().map(str::to_owned).filter(|text| !text.trim().is_empty())) {
        return Some(text);
    }
    // A row's text is in a cell or a text inside it.
    for child in element.elements("AXChildren", 16).unwrap_or_default() {
        if let Some(text) = item_label(&child) {
            return Some(text);
        }
    }
    None
}

/// The open menu of a pop-up button, once it shows.
fn open_menu(button: &Element, deadline: Instant) -> Option<Element> {
    let mut menu = None;
    until(deadline, || {
        menu = button.elements("AXChildren", 4).unwrap_or_default().into_iter().find(|child| child.text("AXRole").as_deref() == Some("AXMenu"));
        menu.is_some()
    });
    menu
}

fn close_menu(pid: i32, menu: &Element, deadline: Instant) -> bool {
    let _ = menu.perform("AXCancel");
    if until(deadline, || windows::open_menus(pid) == 0) {
        return true;
    }
    let _ = input::parse_combo("escape").and_then(|combo| input::press(&combo, Route::Process(pid)));
    until(deadline, || windows::open_menus(pid) == 0)
}

fn select(entry: &Entry, label: &str, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    let (ax_role, role) = raw_role(element);
    if ax_role == "AXPopUpButton" || ax_role == "AXMenuButton" {
        if value_text(element).as_deref() == Some(label) {
            return Ok(());
        }
        // A menu still closing (the last select's) would take the press.
        until(deadline, || windows::open_menus(entry.pid) == 0);
        perform(element, "AXPress", "open the list")?;
        let Some(menu) = open_menu(element, deadline) else {
            return Err(Failure::unconfirmed(codes::ACTION_FAILED, "the list's menu did not open"));
        };
        let items = menu.elements("AXChildren", 512).unwrap_or_default();
        let Some(item) = items.into_iter().find(|item| item.text("AXTitle").as_deref() == Some(label) && item.boolean("AXEnabled") != Some(false)) else {
            // Nothing was chosen: the menu opened and closed again, and the list's value is as it was.
            if close_menu(entry.pid, &menu, deadline) {
                return Err(Failure::refused(codes::ELEMENT_NOT_FOUND, format!("the list has no option \"{label}\"")));
            }
            return Err(Failure::unconfirmed(codes::ELEMENT_NOT_FOUND, format!("the list has no option \"{label}\", and its menu did not close"))
                .with_details(serde_json::json!({ "menu": "open" })));
        };
        perform(&item, "AXPress", "choose the option").map_err(Failure::delivered)?;
        if until(deadline, || value_text(element).as_deref() == Some(label)) {
            // The menu fades out after the choice; the next action must not land on it.
            until(deadline, || windows::open_menus(entry.pid) == 0);
            return Ok(());
        }
        return Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("the list does not show \"{label}\" after it was chosen")));
    }
    if ax_role == "AXComboBox" {
        return set_value(element, label, deadline);
    }
    if roles::collection(role) {
        let rows =
            element.elements("AXRows", 4096).ok().filter(|rows| !rows.is_empty()).unwrap_or_else(|| element.elements("AXChildren", 4096).unwrap_or_default());
        let Some(row) = rows.into_iter().find(|row| item_label(row).as_deref() == Some(label)) else {
            return Err(Failure::refused(codes::ELEMENT_NOT_FOUND, format!("the list has no option \"{label}\"")));
        };
        let (_, row_role) = raw_role(&row);
        if matches!(row_role, "radiobutton" | "tab") {
            return perform(&row, "AXPress", "choose the option");
        }
        let written = if element.settable("AXSelectedRows").unwrap_or(false) {
            element.set_elements("AXSelectedRows", std::slice::from_ref(&row))
        } else {
            row.set_bool("AXSelected", true)
        };
        written.map_err(|error| refused(error, "choose the option"))?;
        if until(deadline, || row.boolean("AXSelected") == Some(true)) {
            return Ok(());
        }
        return Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("\"{label}\" did not become selected")));
    }
    Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("a {role} has no options to select")))
}

/// Scrolls a scroll area by moving its scroll bar, `pages` of its visible size.
fn scroll(element: &Element, direction: &str, pages: f64) -> Outcome<()> {
    let vertical = matches!(direction, "up" | "down");
    let forward = matches!(direction, "down" | "right");
    let bar = element.element(if vertical { "AXVerticalScrollBar" } else { "AXHorizontalScrollBar" });
    if let Some(bar) = bar {
        let current = match bar.attribute("AXValue") {
            Ok(Value::Number(number)) => number,
            _ => 0.0,
        };
        let (_, _, width, height) = element.frame().unwrap_or((0.0, 0.0, 0.0, 0.0));
        let visible = if vertical { height } else { width };
        let content = element
            .element("AXContents")
            .or_else(|| element.elements("AXChildren", 1).ok().and_then(|children| children.into_iter().next()))
            .and_then(|contents| contents.frame())
            .map(|(_, _, width, height)| if vertical { height } else { width })
            .unwrap_or(0.0);
        let step = if content > visible && visible > 0.0 { pages * visible / (content - visible) } else { pages * 0.25 };
        let next = (current + if forward { step } else { -step }).clamp(0.0, 1.0);
        if bar.settable("AXValue").unwrap_or(false) {
            return bar.set_number("AXValue", next).map_err(|error| refused(error, "scroll"));
        }
        return perform(&bar, if forward { "AXIncrement" } else { "AXDecrement" }, "scroll");
    }
    let names = element.actions().unwrap_or_default();
    let action = match direction {
        "down" => "AXScrollDownByPage",
        "up" => "AXScrollUpByPage",
        "right" => "AXScrollRightByPage",
        _ => "AXScrollLeftByPage",
    };
    if names.iter().any(|name| name == action) {
        return perform(element, action, "scroll");
    }
    Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("nothing here scrolls {direction}")))
}

fn type_text(entry: &Entry, text: &str, physical: bool, id: Option<u32>, deadline: Instant) -> Outcome<()> {
    let run = input::TypingRun::start(id);
    focus(&entry.element, deadline)?;
    let route = if physical {
        let window = windows::find(entry.pid, entry.window)?;
        raise(entry.pid, &window).map_err(Failure::delivered)?;
        Route::Physical
    } else {
        Route::Process(entry.pid)
    };
    input::type_text(text, route, &run, deadline).map_err(Failure::delivered)
}

/// Runs one action on the element `reference` names.
pub fn act(reference: &str, action: Action, deadline: Instant) -> Outcome<()> {
    let entry = resolve(reference)?;
    let element = &entry.element;
    match action {
        Action::Click => click(&entry, deadline),
        Action::DoubleClick => physical(&entry, Pointer::Click { right: false, count: 2 }),
        Action::Hover => physical(&entry, Pointer::Move),
        Action::RightClick => {
            let names = element.actions().map_err(|error| refused(error, "right click"))?;
            if names.iter().any(|name| name == "AXShowMenu") {
                let before = windows::open_menus(entry.pid);
                perform(element, "AXShowMenu", "right click")?;
                menu_shown(entry.pid, before, deadline);
                Ok(())
            } else {
                Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "this element has no context menu"))
            }
        }
        Action::Focus => focus(element, deadline),
        Action::Clear => set_value(element, "", deadline),
        Action::Check(wanted) => check(element, wanted, deadline),
        Action::ScrollTo => perform(element, "AXScrollToVisible", "scroll into view"),
        Action::SetValue(text) => set_value(element, &text, deadline),
        Action::Select(label) => select(&entry, &label, deadline),
        Action::Scroll { direction, pages } => scroll(element, &direction, pages),
        Action::Type { text, physical, id } => type_text(&entry, &text, physical, id, deadline),
    }
}

/// Presses a key combo into a window of `pid`. Without physical input the
/// key goes to the process, which hands it to its key window: the window
/// must be that one. With it, the window comes forward first.
pub fn press(pid: i32, window: u32, combo: &str, physical: bool) -> Outcome<()> {
    let combo = input::parse_combo(combo)?;
    let element = windows::find(pid, window)?;
    if physical {
        raise(pid, &element)?;
        return input::press(&combo, Route::Physical).map_err(Failure::delivered);
    }
    let app = Element::application(pid);
    if app.element("AXFocusedWindow").as_ref() != Some(&element) {
        return Err(Failure::refused(codes::ACTION_FAILED, "the window is not the app's key window, so a key sent to the app would land elsewhere")
            .with_details(serde_json::json!({ "cause": "exact_window_focus_unconfirmed" })));
    }
    input::press(&combo, Route::Process(pid)).map_err(Failure::delivered)
}

/// Brings a window of `pid` forward.
pub fn focus_window(pid: i32, window: u32) -> Outcome<()> {
    let element = windows::find(pid, window)?;
    raise(pid, &element)
}

/// Physical pointer input at a point on screen.
pub fn pointer_at(x: f64, y: f64, kind: &str) -> Outcome<()> {
    let action = match kind {
        "hover" => Pointer::Move,
        "tap" => Pointer::Click { right: false, count: 1 },
        "doubleTap" => Pointer::Click { right: false, count: 2 },
        "secondaryTap" => Pointer::Click { right: true, count: 1 },
        other => return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("no pointer action {other}"))),
    };
    input::pointer(x, y, action).map_err(Failure::delivered)
}

#[cfg(test)]
mod tests {
    use super::press_to_state;
    use crate::failure::Outcome;
    use std::cell::Cell;

    /// An AppKit box with mixed state: each press moves it mixed, on, off, mixed.
    fn appkit_box(start: u8) -> (Cell<u8>, Cell<usize>) {
        (Cell::new(start), Cell::new(0))
    }

    fn drive(target: u8, start: u8) -> (Outcome<bool>, u8, usize) {
        let (state, presses) = appkit_box(start);
        let outcome = press_to_state(
            target,
            Some(state.get()),
            || {
                presses.set(presses.get() + 1);
                state.set(match state.get() {
                    2 => 1,
                    1 => 0,
                    _ => 2,
                });
                Ok(())
            },
            || Some(state.get()),
        );
        (outcome, state.get(), presses.get())
    }

    #[test]
    fn unchecks_a_mixed_box_in_two_presses() {
        let (outcome, state, presses) = drive(0, 2);
        assert!(outcome.unwrap());
        assert_eq!((state, presses), (0, 2));
    }

    #[test]
    fn checks_a_mixed_box_in_one_press_and_leaves_a_checked_box_alone() {
        assert_eq!(drive(1, 2).1, 1);
        assert_eq!(drive(1, 2).2, 1);
        assert_eq!(drive(1, 1).2, 0);
    }

    #[test]
    fn stops_when_a_press_changes_nothing_or_the_state_cannot_be_read() {
        let presses = Cell::new(0);
        let stuck = press_to_state(
            1,
            Some(0),
            || {
                presses.set(presses.get() + 1);
                Ok(())
            },
            || Some(0),
        );
        assert!(!stuck.unwrap());
        assert_eq!(presses.get(), 1);
        let unreadable = press_to_state(1, None, || Ok(()), || None);
        assert!(!unreadable.unwrap());
    }
}
