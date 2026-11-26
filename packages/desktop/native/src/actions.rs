//! Actions on the element a ref names, through the accessibility API
//! unless they need the real pointer or keyboard. Each one says whether
//! anything reached the app when it fails, and checks its effect where the
//! element shows it (a box's state, a field's value, a list's choice).

use crate::ax::{self, AXError, Element, Value};
use crate::failure::{Delivery, Failure, Outcome, codes};
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
    Scroll { direction: String, pages: f64 },
    Type { text: String, physical: bool },
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

thread_local! {
    /// The action this thread runs: its input run, which a cancel marks, and its deadline.
    static CURRENT: std::cell::RefCell<Option<(input::TypingRun, Instant)>> = const { std::cell::RefCell::new(None) };
}

/// Refuses to send input once the caller gave up on the action: it was cancelled, or its deadline passed. The reads
/// before an input can take long on a slow app, and input sent after the caller moved on would land unasked.
fn go(what: &str) -> Outcome<()> {
    CURRENT.with(|current| match current.borrow().as_ref() {
        Some((run, _)) if run.cancelled() => Err(Failure::refused(codes::TIMEOUT, format!("{what}: the action was cancelled before its input was sent"))),
        Some((_, deadline)) if Instant::now() >= *deadline => {
            Err(Failure::refused(codes::TIMEOUT, format!("{what}: the action's time ran out before its input was sent")))
        }
        _ => Ok(()),
    })
}

/// The failure for a read that failed before anything was sent: nothing reached the app. A read the app did not answer
/// in time is a stall, which a retry may get past.
fn unread(error: AXError, what: &str) -> Failure {
    match error {
        ax::AX_CANNOT_COMPLETE => {
            Failure::refused(codes::APP_UNRESPONSIVE, format!("{what}: the app did not answer in time")).with_details(serde_json::json!({ "retryable": true }))
        }
        ax::AX_INVALID_ELEMENT => Failure::refused(codes::STALE_REF, format!("{what}: the element no longer exists")),
        ax::AX_API_DISABLED => Failure::refused(codes::PERM_DENIED, format!("{what}: {}", ax::describe(error))),
        _ => Failure::refused(codes::ACTION_FAILED, format!("{what}: {}", ax::describe(error))),
    }
}

/// Whether an attribute can be set. A stall fails, so a busy app does not read as one whose control takes no input;
/// any other failure reads as not settable.
fn settable(element: &Element, name: &str, what: &str) -> Outcome<bool> {
    match element.settable(name) {
        Ok(settable) => Ok(settable),
        Err(ax::AX_CANNOT_COMPLETE) => Err(unread(ax::AX_CANNOT_COMPLETE, what)),
        Err(_) => Ok(false),
    }
}

/// The actions an element takes. A stall, a gone element, or no permission fails; any other failure reads as none.
fn action_names(element: &Element, what: &str) -> Outcome<Vec<String>> {
    match element.actions() {
        Ok(names) => Ok(names),
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT | ax::AX_API_DISABLED)) => Err(unread(error, what)),
        Err(_) => Ok(Vec::new()),
    }
}

/// Every element of an array attribute, however many it holds. A read the app did not answer fails: a list read in
/// part cannot show an option is missing.
fn all(element: &Element, name: &str, what: &str) -> Outcome<Vec<Element>> {
    let count = match element.count(name) {
        Ok(count) => count.max(1),
        Err(ax::AX_CANNOT_COMPLETE) => return Err(unread(ax::AX_CANNOT_COMPLETE, what)),
        // A count the element does not give: read up to a generous cap instead.
        Err(_) => 4096,
    };
    match element.elements(name, count) {
        Ok(elements) => Ok(elements),
        Err(ax::AX_CANNOT_COMPLETE) => Err(unread(ax::AX_CANNOT_COMPLETE, what)),
        Err(_) => Ok(Vec::new()),
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

/// How long an action that answered with an error is watched for its element going away, the sign that it landed.
const GONE_WAIT: Duration = Duration::from_millis(300);

/// Performs an AX action. Once the action is sent, an error answer cannot show that nothing happened, so the element is
/// read again to tell (`answered`).
fn perform(element: &Element, action: &str, what: &str) -> Outcome<()> {
    go(what)?;
    element.set_timeout(BLOCKING_ACTION_SECONDS);
    let result = element.perform(action);
    let outcome = match result {
        Ok(()) => Ok(()),
        Err(error) => {
            let then = match error {
                _ if refuses(error) || error == ax::AX_INVALID_ELEMENT => None,
                // The app answers again or not: one read tells, and another would wait out the same stall.
                ax::AX_CANNOT_COMPLETE => element.attribute("AXRole").err(),
                // A press that closes what holds its element (a dismissed alert) can leave it readable a moment more.
                _ => {
                    let end = Instant::now() + GONE_WAIT;
                    loop {
                        let then = element.attribute("AXRole").err();
                        if then == Some(ax::AX_INVALID_ELEMENT) || Instant::now() >= end {
                            break then;
                        }
                        sleep(POLL);
                    }
                }
            };
            answered(error, then, what)
        }
    };
    element.set_timeout(0.0);
    outcome
}

/// Errors with which the app refuses an action before taking it: no such action or attribute, no permission, a bad
/// argument.
fn refuses(error: AXError) -> bool {
    matches!(error, ax::AX_ACTION_UNSUPPORTED | ax::AX_ATTRIBUTE_UNSUPPORTED | ax::AX_NOT_IMPLEMENTED | ax::AX_API_DISABLED | ax::AX_ILLEGAL_ARGUMENT)
}

/// What an action's error answer means, from the error and a read of the element after it (`then`, its error, `None`
/// when the element still answers):
/// - refused outright: nothing reached the app;
/// - the element gone as the action was sent: the action may have closed what held it, so it may have landed;
/// - gone after: the action closed what held it (an alert's button, a panel's), so it landed;
/// - a timeout while the app still answers: the action opened a menu or a modal and runs inside the app's handler;
/// - a timeout the app does not answer after: it may never have taken the action, delivered but unverified;
/// - any other error: it may have landed, delivered but unverified. The caller reads the effect where it can.
fn answered(error: AXError, then: Option<AXError>, what: &str) -> Outcome<()> {
    match (error, then) {
        _ if refuses(error) => Err(refused(error, what)),
        (ax::AX_INVALID_ELEMENT, _) => Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("{what}: the element went away as the action was sent"))),
        (_, Some(ax::AX_INVALID_ELEMENT)) => Ok(()),
        (ax::AX_CANNOT_COMPLETE, None) => Ok(()),
        (ax::AX_CANNOT_COMPLETE, Some(_)) => {
            Err(Failure::unconfirmed(codes::APP_UNRESPONSIVE, format!("{what}: the app did not answer the action, or anything after it")))
        }
        (error, _) => Err(refused(error, what).delivered()),
    }
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
    go("pointer")?;
    raise(entry.pid, &window)?;
    let (x, y) = center(&entry.element)?;
    if !hits(entry.pid, &entry.element, x, y) {
        return Err(Failure::refused(codes::ACTION_FAILED, "another element covers the center of this one, so the pointer would land there"));
    }
    // Raising the window and the hit test can take a second on a slow app: the caller may have given up meanwhile.
    go("pointer")?;
    input::pointer(x, y, action).map_err(Failure::delivered)
}

/// Waits a moment for a menu an action opened to show, so the next read finds it; an action that opens none waits it out and is still done.
fn menu_shown(pid: i32, before: usize, deadline: Instant) {
    until(deadline.min(Instant::now() + MENU_SHOW_WAIT), || windows::open_menus(pid) > before);
}

fn click(entry: &Entry, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    let names = action_names(element, "click")?;
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
    if matches!(role, "row" | "cell" | "treeitem" | "option" | "tab") && settable(element, "AXSelected", "click")? {
        go("select")?;
        element.set_bool("AXSelected", true).map_err(|error| refused(error, "select"))?;
        if until(deadline, || element.boolean("AXSelected") == Some(true)) {
            return Ok(());
        }
        return Err(Failure::unconfirmed(codes::ACTION_FAILED, "the element did not become selected"));
    }
    if roles::takes_text(role) && settable(element, "AXFocused", "click")? {
        return focus(element, deadline);
    }
    Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("this {role} takes no click through accessibility")))
}

fn focus(element: &Element, deadline: Instant) -> Outcome<()> {
    if element.boolean("AXFocused") == Some(true) {
        return Ok(());
    }
    go("focus")?;
    element.set_bool("AXFocused", true).map_err(|error| refused(error, "focus"))?;
    if until(deadline, || element.boolean("AXFocused") == Some(true)) {
        Ok(())
    } else {
        Err(Failure::unconfirmed(codes::ACTION_FAILED, "focus: the element did not take keyboard focus"))
    }
}

fn check(element: &Element, wanted: bool, deadline: Instant) -> Outcome<()> {
    // A press on anything but a box would run its handler (a submit, a delete) before the check could fail.
    let (_, role) = raw_role(element);
    if !roles::toggleable(role) {
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("a {role} has no checked state to set")));
    }
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
/// first press sent nothing; a failed later one follows a press that landed. A press that answered with an error but
/// may have landed is judged by the state it led to: a SwiftUI control in a sheet answers its first press so.
fn press_to_state(target: u8, shown: Option<u8>, mut press: impl FnMut() -> Outcome<()>, mut settle: impl FnMut() -> Option<u8>) -> Outcome<bool> {
    if shown == Some(target) {
        return Ok(true);
    }
    let mut before = shown;
    for attempt in 0..BOX_STATES {
        let pressed = press().map_err(|failure| if attempt == 0 { failure } else { failure.delivered() });
        if let Err(failure) = &pressed
            && failure.delivery == Delivery::NotDelivered
        {
            return pressed.map(|()| false);
        }
        let now = settle();
        if now == Some(target) {
            return Ok(true);
        }
        if now.is_none() || now == before {
            return pressed.map(|()| false);
        }
        before = now;
    }
    Ok(false)
}

/// The most presses a stepper gets to reach a value.
const MAX_STEPS: usize = 500;

/// Whether two stepper values are the same number: a step of 0.1 sums to 0.30000000000000004, not 0.3.
fn same(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}

/// Steps a value toward `target`, one increment or decrement at a time, until it shows it. It stops when the value
/// cannot be read or a step changed nothing. A step that went past the target (the step does not divide the distance)
/// is stepped back, so a value the stepper cannot take leaves it as it was. It never steps past `deadline`: the steps
/// sent by then stay sent, delivered but unverified. A failed first step sent nothing; a failed later one follows steps
/// that landed. A step that answered with an error but may have landed is judged by the value it led to.
fn step_to(
    target: f64,
    shown: Option<f64>,
    deadline: Instant,
    mut step: impl FnMut(bool) -> Outcome<()>,
    mut settle: impl FnMut() -> Option<f64>,
) -> Outcome<bool> {
    let Some(mut now) = shown else { return Ok(false) };
    for attempt in 0..MAX_STEPS {
        if same(now, target) {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            let failure = Failure::refused(codes::TIMEOUT, "the stepper ran out of time before it reached the value");
            return Err(if attempt == 0 { failure } else { failure.delivered() });
        }
        let up = now < target;
        let stepped = step(up).map_err(|failure| if attempt == 0 { failure } else { failure.delivered() });
        if let Err(failure) = &stepped
            && failure.delivery == Delivery::NotDelivered
        {
            return stepped.map(|()| false);
        }
        let Some(next) = settle() else { return stepped.map(|()| false) };
        if same(next, now) {
            return stepped.map(|()| false);
        }
        if !same(next, target) && ((up && next > target) || (!up && next < target)) {
            // Put back the value it had: a fill the stepper cannot take must not leave it changed.
            let back = step(!up).is_ok() && settle().is_some_and(|value| same(value, now));
            let failure = Failure::unconfirmed(codes::ACTION_FAILED, format!("the stepper steps from {now} to {next}, past {target}"));
            return Err(if back {
                Failure { message: format!("{}; it was stepped back to {now}", failure.message), ..failure }
            } else {
                Failure { message: format!("{}, and could not be stepped back", failure.message), ..failure }
            });
        }
        now = next;
    }
    Ok(same(now, target))
}

/// The number a text names, when it names a finite one: `NaN` or `inf` is no value a control can take.
fn finite(text: &str) -> Result<f64, ()> {
    text.trim().parse::<f64>().ok().filter(|number| number.is_finite()).ok_or(())
}

fn set_value(element: &Element, text: &str, deadline: Instant) -> Outcome<()> {
    let (ax_role, role) = raw_role(element);
    let secure = ax_role == "AXSecureTextField" || element.text("AXSubrole").as_deref() == Some("AXSecureTextField");
    if !settable(element, "AXValue", "set value")? {
        // A stepper whose value cannot be written still steps toward a number.
        let names = action_names(element, "set value")?;
        let steps = names.iter().any(|name| name == "AXIncrement" || name == "AXDecrement");
        if let (true, Ok(Value::Number(_)), Ok(target)) = (steps, element.attribute("AXValue"), finite(text)) {
            let number = || match element.attribute("AXValue") {
                Ok(Value::Number(number)) => Some(number),
                _ => None,
            };
            let mut shown = number();
            let reached = step_to(
                target,
                shown,
                deadline,
                |up| perform(element, if up { "AXIncrement" } else { "AXDecrement" }, "step the value"),
                || {
                    let before = shown;
                    until(deadline, || number() != before);
                    shown = number();
                    shown
                },
            )?;
            return if reached { Ok(()) } else { Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("the {role} stopped short of {}", text.trim()))) };
        }
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("the value of this {role} cannot be set")));
    }
    // A field that holds focus commits its text the way typing does; one that cannot take focus still takes the value.
    // Focus moved by this call has reached the app (its handlers may have run), so a later failure is no longer "nothing sent".
    let moved_focus = roles::takes_text(role) && settable(element, "AXFocused", "set value")? && element.boolean("AXFocused") != Some(true) && {
        go("set value")?;
        element.set_bool("AXFocused", true).is_ok()
    };
    let numeric = matches!(element.attribute("AXValue"), Ok(Value::Number(_)));
    // The reads above can take long on a slow app; the caller may have given up since.
    go("set value").map_err(|failure| if moved_focus { failure.delivered() } else { failure })?;
    let written = match (numeric, finite(text)) {
        (true, Ok(number)) => element.set_number("AXValue", number),
        _ => element.set_text("AXValue", text),
    };
    written.map_err(|error| if moved_focus { refused(error, "set value").delivered() } else { refused(error, "set value") })?;
    if secure {
        return Ok(());
    }
    let expected = if numeric { finite(text).map(ax::format_number).unwrap_or_else(|_| text.to_owned()) } else { text.to_owned() };
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

/// How long closing a menu nothing was chosen from may take past the action's deadline: an open menu covers the window.
const MENU_CLOSE_WAIT: Duration = Duration::from_millis(500);

/// Closes a menu nothing was chosen from, and answers whether it closed. It runs after the action's deadline too.
fn close_menu(pid: i32, menu: &Element, deadline: Instant) -> bool {
    let deadline = deadline.max(Instant::now() + MENU_CLOSE_WAIT);
    let _ = menu.perform("AXCancel");
    if until(deadline, || windows::open_menus(pid) == 0) {
        return true;
    }
    let _ = input::parse_combo("escape").and_then(|combo| input::press(&combo, Route::Process(pid)));
    until(deadline, || windows::open_menus(pid) == 0)
}

/// A select's failure before anything was chosen, once its menu was closed or failed to close. A menu that stayed open
/// changed the screen, and covers the window for the next action, so the failure is no longer "nothing sent".
fn unclosed(failure: Failure, closed: bool) -> Failure {
    if closed { failure } else { failure.delivered().with_details(serde_json::json!({ "menu": "open" })) }
}

fn select(entry: &Entry, label: &str, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    let (ax_role, role) = raw_role(element);
    // A pull-down keeps its own title, so a choice cannot be read back from it: tap it and the menu item instead.
    if ax_role == "AXMenuButton" {
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "a pull-down menu shows no selected option; tap it, then tap the menu item"));
    }
    if ax_role == "AXPopUpButton" {
        if value_text(element).as_deref() == Some(label) {
            return Ok(());
        }
        // A menu still closing (the last select's) would take the press.
        until(deadline, || windows::open_menus(entry.pid) == 0);
        perform(element, "AXPress", "open the list")?;
        let Some(menu) = open_menu(element, deadline) else {
            return Err(Failure::unconfirmed(codes::ACTION_FAILED, "the list's menu did not open"));
        };
        // Until the item is pressed nothing is chosen: a failure closes the menu again, and says when it stayed open,
        // since an open menu covers the window for the next action.
        let unchosen = |failure: Failure| unclosed(failure, close_menu(entry.pid, &menu, deadline));
        let items = all(&menu, "AXChildren", "read the list's options").map_err(unchosen)?;
        // A title the app did not answer in time may be the option asked for: that is no proof it is missing.
        let mut stalled = false;
        let item = items.into_iter().find(|item| match item.attribute("AXTitle") {
            Ok(title) => title.text() == Some(label) && item.boolean("AXEnabled") != Some(false),
            Err(error) => {
                stalled |= error == ax::AX_CANNOT_COMPLETE;
                false
            }
        });
        let Some(item) = item else {
            return Err(unchosen(if stalled {
                unread(ax::AX_CANNOT_COMPLETE, "read the list's options")
            } else {
                Failure::refused(codes::ELEMENT_NOT_FOUND, format!("the list has no option \"{label}\""))
            }));
        };
        perform(&item, "AXPress", "choose the option").map_err(|failure| match failure.delivery {
            // Refused before the press (out of time, cancelled, the item gone): nothing was chosen.
            Delivery::NotDelivered => unchosen(failure),
            Delivery::Unknown => failure,
        })?;
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
        let rows = match all(element, "AXRows", "read the list's rows")? {
            rows if rows.is_empty() => all(element, "AXChildren", "read the list's rows")?,
            rows => rows,
        };
        let Some(row) = rows.into_iter().find(|row| item_label(row).as_deref() == Some(label)) else {
            return Err(Failure::refused(codes::ELEMENT_NOT_FOUND, format!("the list has no option \"{label}\"")));
        };
        let (_, row_role) = raw_role(&row);
        if matches!(row_role, "radiobutton" | "tab") {
            return perform(&row, "AXPress", "choose the option");
        }
        go("select")?;
        let written = if settable(element, "AXSelectedRows", "select")? {
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
        if settable(&bar, "AXValue", "scroll")? {
            go("scroll")?;
            return bar.set_number("AXValue", next).map_err(|error| refused(error, "scroll"));
        }
        return perform(&bar, if forward { "AXIncrement" } else { "AXDecrement" }, "scroll");
    }
    let names = action_names(element, "scroll")?;
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

fn type_text(entry: &Entry, text: &str, physical: bool, deadline: Instant) -> Outcome<()> {
    let window = windows::find(entry.pid, entry.window)?;
    // Text sent to the app goes to its key window, which must be the one the field is in, as for `press`.
    if !physical {
        key_window(entry.pid, &window)?;
    }
    focus(&entry.element, deadline)?;
    let route = if physical {
        raise(entry.pid, &window).map_err(Failure::delivered)?;
        Route::Physical
    } else {
        Route::Process(entry.pid)
    };
    CURRENT
        .with(|current| match current.borrow().as_ref() {
            Some((run, _)) => input::type_text(text, route, run, deadline),
            None => Err(Failure::refused(codes::INTERNAL, "type ran outside an action")),
        })
        .map_err(Failure::delivered)
}

/// Runs `work` as the action `input_id` names: until it returns, every input it sends first checks that the action was
/// not cancelled and is still in time (`go`).
fn guarded<T>(input_id: Option<u32>, deadline: Instant, work: impl FnOnce() -> Outcome<T>) -> Outcome<T> {
    CURRENT.with(|current| *current.borrow_mut() = Some((input::TypingRun::start(input_id), deadline)));
    let outcome = work();
    CURRENT.with(|current| current.borrow_mut().take());
    outcome
}

/// Runs one action on the element `reference` names.
pub fn act(reference: &str, action: Action, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    guarded(input_id, deadline, || run(reference, action, deadline))
}

fn run(reference: &str, action: Action, deadline: Instant) -> Outcome<()> {
    let entry = resolve(reference)?;
    let element = &entry.element;
    match action {
        Action::Click => click(&entry, deadline),
        Action::DoubleClick => physical(&entry, Pointer::Click { right: false, count: 2 }),
        Action::Hover => physical(&entry, Pointer::Move),
        Action::RightClick => {
            let names = action_names(element, "right click")?;
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
        Action::Type { text, physical } => type_text(&entry, &text, physical, deadline),
    }
}

/// Presses a key combo into a window of `pid`. Without physical input the
/// key goes to the process, which hands it to its key window: the window
/// must be that one. With it, the window comes forward first. No key goes
/// out once `input_id` was cancelled or `deadline` passed.
pub fn press(pid: i32, window: u32, combo: &str, physical: bool, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    let combo = input::parse_combo(combo)?;
    guarded(input_id, deadline, || {
        let element = windows::find(pid, window)?;
        let route = if physical {
            raise(pid, &element)?;
            Route::Physical
        } else {
            key_window(pid, &element)?;
            Route::Process(pid)
        };
        go("press")?;
        input::press(&combo, route).map_err(Failure::delivered)
    })
}

/// Refuses unless `window` is the app's key window, or holds the focused sheet or alert: a key or text sent to the app
/// goes to its key window, and would land in another one.
fn key_window(pid: i32, window: &Element) -> Outcome<()> {
    let app = Element::application(pid);
    // A sheet or an alert on the window is the app's focused window then, and keys reach the window through it.
    let focused = app.element("AXFocusedWindow");
    let on_window = focused.as_ref() == Some(window) || focused.as_ref().and_then(|focused| focused.element("AXParent")).as_ref() == Some(window);
    if on_window {
        return Ok(());
    }
    Err(Failure::refused(codes::ACTION_FAILED, "the window is not the app's key window, so a key sent to the app would land elsewhere")
        .with_details(serde_json::json!({ "cause": "exact_window_focus_unconfirmed" })))
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
    use super::{press_to_state, step_to};
    use crate::failure::Outcome;
    use std::cell::Cell;
    use std::time::{Duration, Instant};

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
    fn steps_a_stepper_up_and_down_to_the_value() {
        for (start, target, presses) in [(1.0, 3.0, 2), (5.0, 2.0, 3), (4.0, 4.0, 0)] {
            let value = Cell::new(start);
            let count = Cell::new(0);
            let reached = step_to(
                target,
                Some(start),
                later(),
                |up| {
                    count.set(count.get() + 1);
                    value.set(value.get() + if up { 1.0 } else { -1.0 });
                    Ok(())
                },
                || Some(value.get()),
            );
            assert!(reached.unwrap());
            assert_eq!((value.get(), count.get()), (target, presses));
        }
    }

    #[test]
    fn stops_a_stepper_that_steps_past_the_value_or_does_not_move() {
        let value = Cell::new(0.0);
        let past = step_to(
            3.0,
            Some(0.0),
            later(),
            |up| {
                value.set(value.get() + if up { 2.0 } else { -2.0 });
                Ok(())
            },
            || Some(value.get()),
        );
        let failure = past.expect_err("2 does not divide 3");
        assert_eq!(failure.delivery, crate::failure::Delivery::Unknown);
        assert!(failure.message.contains("stepped back to 2"), "{}", failure.message);
        assert_eq!(value.get(), 2.0);
        let count = Cell::new(0);
        let stuck = step_to(
            3.0,
            Some(0.0),
            later(),
            |_| {
                count.set(count.get() + 1);
                Ok(())
            },
            || Some(0.0),
        );
        assert!(!stuck.unwrap());
        assert_eq!(count.get(), 1);
    }

    /// A deadline the test never reaches.
    fn later() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    #[test]
    fn stops_stepping_at_the_deadline_and_says_the_steps_landed() {
        let value = Cell::new(0.0);
        let steps = Cell::new(0);
        let deadline = Instant::now() + Duration::from_millis(30);
        let outcome = step_to(
            400.0,
            Some(0.0),
            deadline,
            |_| {
                steps.set(steps.get() + 1);
                std::thread::sleep(Duration::from_millis(10));
                value.set(value.get() + 1.0);
                Ok(())
            },
            || Some(value.get()),
        );
        let failure = outcome.expect_err("it ran out of time");
        assert_eq!(failure.code, crate::failure::codes::TIMEOUT);
        assert_eq!(failure.delivery, crate::failure::Delivery::Unknown);
        assert!(steps.get() < 10, "{} steps", steps.get());
        let none = step_to(3.0, Some(0.0), Instant::now(), |_| panic!("no step past the deadline"), || Some(0.0));
        assert_eq!(none.expect_err("out of time").delivery, crate::failure::Delivery::NotDelivered);
    }

    #[test]
    fn sends_no_input_once_the_action_was_cancelled_or_ran_out_of_time() {
        let set =
            |id: u32, deadline: Instant| super::CURRENT.with(|current| *current.borrow_mut() = Some((crate::input::TypingRun::start(Some(id)), deadline)));
        crate::input::cancel_input(2_000_001);
        set(2_000_001, later());
        assert!(super::go("press").is_err());
        set(2_000_002, Instant::now());
        assert!(super::go("press").is_err());
        set(2_000_003, later());
        assert!(super::go("press").is_ok());
        super::CURRENT.with(|current| current.borrow_mut().take());
    }

    #[test]
    fn says_a_select_menu_that_stayed_open_reached_the_app() {
        use crate::failure::{Delivery, Failure, codes};
        let stall = || super::unread(crate::ax::AX_CANNOT_COMPLETE, "read the list's options");
        let closed = super::unclosed(stall(), true);
        assert_eq!((closed.delivery, closed.details.as_ref().and_then(|details| details.get("menu"))), (Delivery::NotDelivered, None));
        let open = super::unclosed(stall(), false);
        assert_eq!(open.delivery, Delivery::Unknown);
        assert_eq!(open.details.and_then(|details| details.get("menu").cloned()), Some(serde_json::json!("open")));
        let missing = super::unclosed(Failure::refused(codes::ELEMENT_NOT_FOUND, "no option"), false);
        assert_eq!((missing.code, missing.delivery), (codes::ELEMENT_NOT_FOUND, Delivery::Unknown));
    }

    #[test]
    fn steps_by_a_fraction_to_a_value_it_reaches_only_up_to_rounding() {
        let value = Cell::new(0.0);
        let reached = step_to(
            0.3,
            Some(0.0),
            later(),
            |up| {
                value.set(value.get() + if up { 0.1 } else { -0.1 });
                Ok(())
            },
            || Some(value.get()),
        );
        assert!(reached.unwrap());
    }

    /// A failure that answered after the input was sent.
    fn landed_with_an_error() -> crate::failure::Failure {
        crate::failure::Failure::unconfirmed(crate::failure::codes::ACTION_FAILED, "the app's accessibility answered with a failure")
    }

    #[test]
    fn judges_a_press_that_answered_with_an_error_by_the_state_it_led_to() {
        let state = Cell::new(0);
        let toggled = press_to_state(
            1,
            Some(0),
            || {
                state.set(1);
                Err(landed_with_an_error())
            },
            || Some(state.get()),
        );
        assert!(toggled.unwrap());
        let unchanged = press_to_state(1, Some(0), || Err(landed_with_an_error()), || Some(0));
        assert_eq!(unchanged.expect_err("nothing changed").delivery, crate::failure::Delivery::Unknown);
        let value = Cell::new(1.0);
        let stepped = step_to(
            3.0,
            Some(1.0),
            later(),
            |_| {
                value.set(value.get() + 1.0);
                if value.get() == 2.0 { Err(landed_with_an_error()) } else { Ok(()) }
            },
            || Some(value.get()),
        );
        assert!(stepped.unwrap());
    }

    #[test]
    fn reads_an_action_answer_by_whether_the_element_stayed() {
        use crate::ax::{AX_ACTION_UNSUPPORTED, AX_ATTRIBUTE_UNSUPPORTED, AX_CANNOT_COMPLETE, AX_FAILURE, AX_INVALID_ELEMENT};
        use crate::failure::{Delivery, codes};
        let answer = |error, then| super::answered(error, then, "press");
        for refused in [AX_ACTION_UNSUPPORTED, AX_ATTRIBUTE_UNSUPPORTED] {
            assert_eq!(answer(refused, None).expect_err("refused").delivery, Delivery::NotDelivered);
        }
        assert!(answer(AX_FAILURE, Some(AX_INVALID_ELEMENT)).is_ok(), "gone after the press: it closed its alert");
        assert!(answer(AX_CANNOT_COMPLETE, None).is_ok(), "a modal runs in the press's handler");
        let stalled = answer(AX_CANNOT_COMPLETE, Some(AX_CANNOT_COMPLETE)).expect_err("no answer after");
        assert_eq!((stalled.code, stalled.delivery), (codes::APP_UNRESPONSIVE, Delivery::Unknown));
        let failed = answer(AX_FAILURE, None).expect_err("still there");
        assert_eq!((failed.code, failed.delivery), (codes::ACTION_FAILED, Delivery::Unknown));
        let gone = answer(AX_INVALID_ELEMENT, None).expect_err("went away as it was sent");
        assert_eq!(gone.delivery, Delivery::Unknown);
    }

    #[test]
    fn takes_only_a_finite_number() {
        assert_eq!(super::finite(" 3 "), Ok(3.0));
        for text in ["NaN", "inf", "-infinity", "three"] {
            assert!(super::finite(text).is_err(), "{text}");
        }
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
