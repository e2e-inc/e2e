//! Actions on the element a ref names, through the accessibility API
//! unless they need the real pointer or keyboard. Each one says whether
//! anything reached the app when it fails, and checks its effect where the
//! element shows it (a box's state, a field's value, a list's choice).

use crate::ax::{self, AXError, Accessible, Element, Value};
use crate::failure::{Delivery, Failure, Outcome, codes};
use crate::input::{self, Pointer, Route};
use crate::refs::{self, Entry};
use crate::roles;
use crate::windows;
use std::thread::sleep;
use std::time::{Duration, Instant};

mod menu;
mod pointer;
mod scroll;
mod select;
mod typing;
mod values;

pub use menu::back;
use pointer::*;
pub use pointer::{PointTarget, Sheet, pointer_at};
pub use scroll::scroll_bar;
use scroll::*;
use select::*;
use typing::*;
use values::*;

/// How long an action that opens a menu or a modal waits for the app to answer before it counts as delivered.
const BLOCKING_ACTION_SECONDS: f32 = 0.5;

/// How long an effect is polled for before the action is reported unconfirmed.
const EFFECT_WAIT: Duration = Duration::from_millis(1_000);

/// How long an action that opens a menu waits for it to show.
const MENU_SHOW_WAIT: Duration = Duration::from_millis(1_000);

/// How often an effect is polled.
const POLL: Duration = Duration::from_millis(30);
/// How long before the deadline a wait that ends in a refusal gives up: the engine cuts the call off at that same
/// deadline, and a refusal that came after it would read as input that may have reached the app.
const ANSWER_MARGIN: Duration = Duration::from_millis(200);

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
    SelectAll,
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

/// The failure of an AX attribute write: only a refusal says nothing was sent. Any other answer may follow a write
/// the app took, whose handler ran (one that replaced the element answers a gone element), so it counts as delivered.
fn write_failed(error: AXError, what: &str) -> Failure {
    if refuses(error) { refused(error, what) } else { refused(error, what).delivered() }
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

/// Whether the caller cancelled the running action. Unlike `go`, a deadline that passed does not count: cleanup such as
/// closing a menu runs past it, but never past a cancel, after which the caller has moved on.
fn cancelled() -> bool {
    CURRENT.with(|current| current.borrow().as_ref().is_some_and(|(run, _)| run.cancelled()))
}

/// The failure for a read that failed before anything was sent: nothing reached the app. A read the app did not answer
/// in time is a stall, which a retry may get past.
pub(crate) fn unread(error: AXError, what: &str) -> Failure {
    match error {
        ax::AX_CANNOT_COMPLETE => {
            Failure::refused(codes::APP_UNRESPONSIVE, format!("{what}: the app did not answer in time")).with_details(serde_json::json!({ "retryable": true }))
        }
        ax::AX_INVALID_ELEMENT => Failure::refused(codes::STALE_REF, format!("{what}: the element no longer exists")),
        ax::AX_API_DISABLED => Failure::refused(codes::PERM_DENIED, format!("{what}: {}", ax::describe(error))),
        _ => Failure::refused(codes::ACTION_FAILED, format!("{what}: {}", ax::describe(error))),
    }
}

/// A read whose only failure that counts is a stall: the app did not answer in time, which says nothing about the
/// answer and passes up as `AX_CANNOT_COMPLETE`. Any other failure reads as no answer.
pub(crate) fn stalled<T>(read: Result<T, AXError>) -> Result<Option<T>, AXError> {
    match read {
        Ok(value) => Ok(Some(value)),
        Err(ax::AX_CANNOT_COMPLETE) => Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => Ok(None),
    }
}

/// The element an attribute names, such as the app's focused element or key window. A read the app did not answer in
/// time fails as a stall, which a retry may get past, never as focus that moved; any other failure reads as none.
pub(crate) fn element_attribute<E: Accessible>(element: &E, name: &str, what: &str) -> Outcome<Option<E>> {
    Ok(stalled(element.attribute(name)).map_err(|error| unread(error, what))?.and_then(|value| value.element().cloned()))
}

/// Whether `focused`, the app's focused window, holds `window`'s focus (`windows::holds_focus`). A stall fails as one.
pub(crate) fn holds<E: Accessible>(focused: &E, window: &E, what: &str) -> Outcome<bool> {
    windows::holds_focus(focused, window).map_err(|error| unread(error, what))
}

/// Whether an attribute can be set. A stall fails, so a busy app does not read as one whose control takes no input;
/// any other failure reads as not settable.
fn settable<E: Accessible>(element: &E, name: &str, what: &str) -> Outcome<bool> {
    match element.settable(name) {
        Ok(settable) => Ok(settable),
        Err(ax::AX_CANNOT_COMPLETE) => Err(unread(ax::AX_CANNOT_COMPLETE, what)),
        Err(_) => Ok(false),
    }
}

/// The actions an element takes. A stall, a gone element, or no permission fails; any other failure reads as none.
fn action_names<E: Accessible>(element: &E, what: &str) -> Outcome<Vec<String>> {
    match element.actions() {
        Ok(names) => Ok(names),
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT | ax::AX_API_DISABLED)) => Err(unread(error, what)),
        Err(_) => Ok(Vec::new()),
    }
}

/// Every element of an array attribute, however many it holds. A read the app did not answer fails: a list read in
/// part cannot show an option is missing.
fn all<E: Accessible>(element: &E, name: &str, what: &str) -> Outcome<Vec<E>> {
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

/// When the watch for an element going away ends: after `GONE_WAIT`, and in time for the answer to reach the caller
/// before the action's deadline. An answer that comes after it is cut off, and reads as an action that may have
/// landed even when the app refused it.
fn gone_wait_end(now: Instant, deadline: Option<Instant>) -> Instant {
    let end = now + GONE_WAIT;
    match deadline {
        Some(deadline) => end.min(deadline.checked_sub(ANSWER_MARGIN).unwrap_or(deadline)),
        None => end,
    }
}

/// Performs an AX action. Once the action is sent, an error answer cannot show that nothing happened, so the element is
/// read again to tell (`answered`).
fn perform<E: Accessible>(element: &E, action: &str, what: &str) -> Outcome<()> {
    go(what)?;
    element.set_timeout(BLOCKING_ACTION_SECONDS);
    let result = element.perform(action);
    let outcome = match result {
        Ok(()) => Ok(()),
        Err(error) => {
            let then = match error {
                // "No such attribute" is watched too: a SwiftUI alert's button answers it once its press closed the alert.
                _ if error != ax::AX_ATTRIBUTE_UNSUPPORTED && (refuses(error) || error == ax::AX_INVALID_ELEMENT) => None,
                // The app answers again or not: one read tells, and another would wait out the same stall.
                ax::AX_CANNOT_COMPLETE => element.attribute("AXRole").err(),
                // A press that closes what holds its element (a dismissed alert) can leave it readable a moment more.
                _ => {
                    let deadline = CURRENT.with(|current| current.borrow().as_ref().map(|(_, deadline)| *deadline));
                    let end = gone_wait_end(Instant::now(), deadline);
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
/// - "no such attribute" with the element gone after: a SwiftUI alert's button answers so once its press closed the
///   alert, so it landed; with the element unread after (the button's handler keeps the app busy), it may have landed;
/// - the element gone as the action was sent: the action may have closed what held it, so it may have landed;
/// - gone after: the action closed what held it (an alert's button, a panel's), so it landed;
/// - a timeout while the app still answers: the action opened a menu or a modal and runs inside the app's handler;
/// - a timeout the app does not answer after: it may never have taken the action, delivered but unverified;
/// - any other error: it may have landed, delivered but unverified. The caller reads the effect where it can.
fn answered(error: AXError, then: Option<AXError>, what: &str) -> Outcome<()> {
    match (error, then) {
        (ax::AX_ATTRIBUTE_UNSUPPORTED, Some(ax::AX_INVALID_ELEMENT)) => Ok(()),
        (ax::AX_ATTRIBUTE_UNSUPPORTED, Some(_)) => Err(refused(error, what).delivered()),
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

/// The element's AX role and its role in the snapshot's vocabulary. A read the app did not answer in time fails as a
/// stall, and a gone element as a stale ref, so either is retried rather than read as a control without the role; any
/// other failure reads as none.
fn role_of<E: Accessible>(element: &E, what: &str) -> Outcome<(String, &'static str)> {
    let values = match element.attributes(&["AXRole", "AXSubrole"]) {
        Ok(values) => values,
        // A stall is retried, and so is an element gone since it was resolved: the locator finds its replacement.
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT)) => return Err(unread(error, what)),
        Err(_) => vec![None, None],
    };
    let ax_role = values[0].as_ref().and_then(|value| value.text().map(str::to_owned)).unwrap_or_default();
    let subrole = values[1].as_ref().and_then(|value| value.text().map(str::to_owned));
    let role = roles::role(&ax_role, subrole.as_deref());
    Ok((ax_role, role))
}

/// The state a box shows, read as the snapshot reads it, so a check confirms the state an observation would report:
/// `1`, `true`, and `on` are checked, `0` and `off` unchecked, `2` and `mixed` mixed.
fn toggle_state<E: Accessible>(element: &E) -> Option<u8> {
    crate::snapshot::parse_toggle(element.attribute("AXValue").ok().as_ref())
}

/// The text a value attribute holds now.
fn value_text<E: Accessible>(element: &E) -> Option<String> {
    element.attribute("AXValue").ok().and_then(|value| value.display())
}

/// The element's center on screen.
fn center<E: Accessible>(element: &E) -> Outcome<(f64, f64)> {
    let (x, y, width, height) = element.frame().ok_or_else(|| Failure::refused(codes::ACTION_FAILED, "the element has no frame on screen"))?;
    if width <= 0.0 || height <= 0.0 {
        return Err(Failure::refused(codes::ACTION_FAILED, "the element has no area on screen"));
    }
    Ok((x + width / 2.0, y + height / 2.0))
}

/// Brings the window forward and the app with it, for physical input. A sheet or an alert on it may take focus.
pub fn raise(pid: i32, window: &Element) -> Outcome<()> {
    let app = Element::application(pid);
    // Each write moves the focus: none goes once the caller gave up.
    go("bring the window forward")?;
    let _ = app.set_bool("AXFrontmost", true);
    go("bring the window forward")?;
    let _ = window.perform("AXRaise");
    go("bring the window forward")?;
    let _ = window.set_bool("AXMain", true);
    let deadline = Instant::now() + Duration::from_millis(1_500);
    let mut last = Ok(false);
    until(deadline, || {
        last = forward(&app, window);
        last == Ok(true)
    });
    match last {
        Ok(true) => Ok(()),
        // An app that did not answer in time may have come forward: no proof it did not, and a retry may get past it.
        Err(error) => Err(unread(error, "bring the window forward")),
        Ok(false) => Err(Failure::refused(codes::ACTION_FAILED, "the window could not be brought forward")),
    }
}

/// Whether the app is frontmost with `window` holding its focus. A stall fails as `AX_CANNOT_COMPLETE`.
fn forward(app: &Element, window: &Element) -> Result<bool, AXError> {
    if stalled(app.attribute("AXFrontmost"))?.and_then(|value| value.boolean()) != Some(true) {
        return Ok(false);
    }
    match stalled(app.attribute("AXFocusedWindow"))?.and_then(|value| value.element().cloned()) {
        Some(focused) => windows::holds_focus(&focused, window),
        None => Ok(false),
    }
}

/// Waits a moment for a menu an action opened to show, so the next read finds it; an action that opens none waits it out and is still done.
fn menu_shown(pid: i32, before: usize, deadline: Instant) {
    until(deadline.min(Instant::now() + MENU_SHOW_WAIT), || windows::open_menus(pid) > before);
}

/// Waits within the action's budget for a control to be enabled, as an actionability wait does, and refuses it if it
/// stays disabled: a disabled AppKit control may still offer AXPress and acknowledge it while ignoring it. A control
/// with no enabled state goes at once.
fn enabled<E: Accessible>(element: &E, deadline: Instant, what: &str) -> Outcome<()> {
    let refuse_at = deadline.checked_sub(ANSWER_MARGIN).unwrap_or(deadline);
    loop {
        match element.attribute("AXEnabled") {
            Ok(value) if value.boolean() == Some(false) => {
                if Instant::now() + POLL >= refuse_at {
                    return Err(Failure::refused(codes::ACTION_FAILED, "the control is disabled"));
                }
                go(what)?;
                sleep(POLL);
            }
            Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT | ax::AX_API_DISABLED)) => return Err(unread(error, what)),
            _ => return Ok(()),
        }
    }
}

/// Brings an element a scroll area holds out of view into view (`AXScrollToVisible`), and waits for it to show. An
/// element already on screen gets nothing; one in a minimized window, one with no size, or one that cannot be scrolled, is refused, as an
/// action on it would reach a control the user cannot. `Ok(true)` when it scrolled the list.
fn reveal<E: Accessible>(element: &E, deadline: Instant, what: &str) -> Outcome<bool> {
    use crate::snapshot::{Placement, placement};
    match placement(element).map_err(|error| unread(error, what))? {
        Placement::Shown => return Ok(false),
        Placement::Minimized => {
            return Err(Failure::refused(codes::ACTION_FAILED, "the element's window is minimized, so the user cannot reach it; restore the window first"));
        }
        Placement::Collapsed => return Err(Failure::refused(codes::ACTION_FAILED, "the element has no size on screen, so the user cannot reach it")),
        Placement::ScrolledOut => {}
    }
    if !action_names(element, what)?.iter().any(|name| name == "AXScrollToVisible") {
        return Err(Failure::refused(codes::ACTION_FAILED, "the element is off screen and cannot be scrolled into view; scroll its list first"));
    }
    perform(element, "AXScrollToVisible", "scroll into view")?;
    // A list can replace a row's element as it scrolls the row in: the element is gone then, and no wait shows it.
    let mut gone = false;
    let shown = until(deadline, || match placement(element) {
        Ok(Placement::Shown) => true,
        Err(ax::AX_INVALID_ELEMENT) => {
            gone = true;
            true
        }
        _ => false,
    });
    if gone {
        return Err(Failure::unconfirmed(codes::STALE_REF, "the list replaced the element as it scrolled it into view"));
    }
    if shown {
        return Ok(true);
    }
    Err(Failure::unconfirmed(codes::ACTION_FAILED, "the element is still off screen after it was scrolled into view"))
}

/// What an action did once `reveal` scrolled its list: the scroll moved the app's content, so a failure after it is no
/// longer "nothing sent".
fn after_scroll<T>(scrolled: bool, outcome: Outcome<T>) -> Outcome<T> {
    outcome.map_err(|failure| if scrolled { failure.delivered() } else { failure })
}

fn click(entry: &Entry, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    enabled(element, deadline, "click")?;
    // The engine checked the node shows before the call; the wait above can outlast that, as the window minimizes or
    // a list scrolls meanwhile.
    let scrolled = reveal(element, deadline, "click")?;
    after_scroll(scrolled, click_shown(entry, deadline))
}

/// `click` on an element that shows.
fn click_shown(entry: &Entry, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    let (ax_role, role) = role_of(element, "click")?;
    // A tap on a text field puts the keyboard there. AppKit's password field also offers AXConfirm, which the action
    // choice below would send in its place, leaving the keyboard in the field before.
    if role == "textfield" && settable(element, "AXFocused", "click")? {
        return focus(element, deadline);
    }
    let names = action_names(element, "click")?;
    if let Some(action) = ["AXPress", "AXOpen", "AXConfirm"].into_iter().find(|name| names.iter().any(|candidate| candidate == name)) {
        // Only a press that opens a menu waits for it, so only it counts the open menus, a read of every window there is.
        let before = (ax_role == "AXPopUpButton" || ax_role == "AXMenuButton").then(|| windows::open_menus(entry.pid));
        perform(element, action, "click")?;
        if let Some(before) = before {
            menu_shown(entry.pid, before, deadline);
        }
        return Ok(());
    }
    // An NSTableView's row is selected through its table (`AXSelectedRows`), and a cell in a row through that row: neither
    // takes a press, and the row's own `AXSelected` may not be writable.
    let row = match role {
        "row" | "treeitem" => Some(element.clone()),
        "cell" => element.element("AXParent").filter(|parent| matches!(parent.text("AXRole").as_deref(), Some("AXRow" | "AXOutlineRow"))),
        _ => None,
    };
    if let Some(row) = row {
        let list = row.element("AXParent");
        if choose_row(list.as_ref(), &row, deadline, "the row did not become selected")? {
            return Ok(());
        }
    }
    if matches!(role, "cell" | "option" | "tab") && settable(element, "AXSelected", "click")? {
        go("select")?;
        element.set_bool("AXSelected", true).map_err(|error| write_failed(error, "select"))?;
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
    // The app's focused element is the one source, as the snapshot reads it: a table's cell reports the table's focus as
    // its own `AXFocused`.
    let holds = || -> Result<bool, AXError> {
        Ok(match element.pid() {
            Some(pid) => {
                stalled(Element::application(pid).attribute("AXFocusedUIElement"))?.and_then(|value| value.element().cloned()).as_ref() == Some(element)
            }
            None => stalled(element.attribute("AXFocused"))?.and_then(|value| value.boolean()) == Some(true),
        })
    };
    // A stall before the write is no proof the element lacks focus: nothing is sent, and a retry may get past it.
    if holds().map_err(|error| unread(error, "focus"))? {
        return Ok(());
    }
    go("focus")?;
    // A focus write that failed after the app took it (a focus handler that replaced the element) may have run its
    // handlers: only a refusal shows nothing was sent, as for `set_value`.
    element.set_bool("AXFocused", true).map_err(|error| write_failed(error, "focus"))?;
    let mut last = Ok(false);
    until(deadline, || {
        last = holds();
        last == Ok(true)
    });
    match last {
        Ok(true) => Ok(()),
        Err(_) => Err(Failure::unconfirmed(codes::APP_UNRESPONSIVE, "focus: the app did not answer in time after the element was focused")),
        Ok(false) => Err(Failure::unconfirmed(codes::ACTION_FAILED, "focus: the element did not take keyboard focus")),
    }
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
        // A press on a disabled control is acknowledged and ignored: each wait for it to be enabled, as a tap does. A
        // hover presses nothing, so it goes to a disabled control too.
        Action::DoubleClick => {
            enabled(element, deadline, "double click")?;
            physical(&entry, Pointer::Click { right: false, count: 2 })
        }
        Action::Hover => physical(&entry, Pointer::Move),
        Action::RightClick => {
            enabled(element, deadline, "right click")?;
            // Refused before the scroll below, which would move the list for nothing.
            if !action_names(element, "right click")?.iter().any(|name| name == "AXShowMenu") {
                return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "this element has no context menu"));
            }
            let scrolled = reveal(element, deadline, "right click")?;
            let before = windows::open_menus(entry.pid);
            after_scroll(scrolled, perform(element, "AXShowMenu", "right click"))?;
            menu_shown(entry.pid, before, deadline);
            Ok(())
        }
        Action::Focus => focus(element, deadline),
        Action::Clear => set_value(element, "", deadline),
        Action::Check(wanted) => check(element, wanted, deadline),
        Action::ScrollTo => reveal(element, deadline, "scroll into view").map(|_| ()),
        Action::SetValue(text) => set_value(element, &text, deadline),
        Action::SelectAll => select_all(element, deadline),
        Action::Select(label) => select(&entry, &label, deadline),
        Action::Scroll { direction, pages } => scroll(element, &direction, pages),
        Action::Type { text, physical } => type_text(&entry, &text, physical, deadline),
    }
}

/// Presses a key combo into a window of `pid`. Without physical input the
/// key goes to the process, which hands it to its key window: the window
/// must be that one. With it, the window comes forward first. No key goes
/// out once `input_id` was cancelled or `deadline` passed.
/// With `focused`, the key goes only while the element that ref names holds the app's focus: a window that came forward
/// can open a sheet that takes it, and a locator's key must reach its own control.
pub fn press(pid: i32, window: u32, combo: &str, physical: bool, focused: Option<&str>, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
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
        let control = match focused {
            Some(reference) => {
                Some(refs::get(reference).ok_or_else(|| Failure::refused(codes::STALE_REF, format!("{reference} names no element of a recent snapshot")))?)
            }
            None => None,
        };
        // A key sent as physical input goes to whatever app is frontmost: the user may have switched apps since the raise,
        // while the app still names its own focused control. The window check waits on the app, so it comes first.
        if physical {
            key_window(pid, &element)?;
        }
        // The control a locator's key is for must hold the app's focus, read after the window check: a sheet that opened
        // during it took the focus, and its default button would take the key.
        if let Some(entry) = &control
            && element_attribute(&Element::application(pid), "AXFocusedUIElement", "press")?.as_ref() != Some(&entry.element)
        {
            return Err(Failure::refused(codes::ACTION_FAILED, "the control lost keyboard focus before the key was sent, so nothing was sent"));
        }
        // The frontmost check is the last read before a physical key, so a switch to another app is still caught.
        if physical && !frontmost(pid)? {
            return Err(Failure::refused(codes::ACTION_FAILED, "another app came forward before the key was sent, so nothing was sent"));
        }
        go("press")?;
        input::press(&combo, route).map_err(Failure::delivered)
    })
}

/// Whether the app is the frontmost one. A read the app did not answer in time is a stall.
fn frontmost(pid: i32) -> Outcome<bool> {
    match Element::application(pid).attribute("AXFrontmost") {
        Ok(value) => Ok(value.boolean() == Some(true)),
        Err(error) if error == ax::AX_CANNOT_COMPLETE => Err(unread(error, "read whether the app is frontmost")),
        Err(_) => Ok(false),
    }
}

/// Refuses unless `window` is the app's key window, or holds the focused sheet or alert: a key or text sent to the app
/// goes to its key window, and would land in another one.
fn key_window(pid: i32, window: &Element) -> Outcome<()> {
    if let Some(focused) = element_attribute(&Element::application(pid), "AXFocusedWindow", "read the app's key window")?
        && holds(&focused, window, "read the app's key window")?
    {
        return Ok(());
    }
    Err(Failure::refused(codes::ACTION_FAILED, "the window is not the app's key window, so a key sent to the app would land elsewhere")
        .with_details(serde_json::json!({ "cause": "exact_window_focus_unconfirmed" })))
}

/// Brings a window of `pid` forward, only while `input_id` is not cancelled and `deadline` has not passed: finding the
/// window can wait on the app, and the caller may have moved on by then.
pub fn focus_window(pid: i32, window: u32, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    guarded(input_id, deadline, || {
        // A call given up on before it began reads nothing either.
        go("bring the window forward")?;
        let element = windows::find(pid, window)?;
        raise(pid, &element)
    })
}

/// Closes a window of `pid` as its close button does, and waits for it to leave the app's windows. A window that asks
/// before it closes (unsaved changes) stays open: the press landed, and the failure says so.
pub fn close_window(pid: i32, window: u32, input_id: Option<u32>, deadline: Instant) -> Outcome<()> {
    guarded(input_id, deadline, || {
        // A call given up on before it began reads nothing either.
        go("close the window")?;
        let element = windows::find(pid, window)?;
        let Some(button) = element.element("AXCloseButton") else {
            return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "the window has no close button"));
        };
        if button.boolean("AXEnabled") == Some(false) {
            return Err(Failure::refused(codes::ACTION_FAILED, "the window's close button is disabled, as it is while a sheet is open on the window"));
        }
        // A press that closes its own window may answer with an error: the window lists tell whether it closed.
        let pressed = perform(&button, "AXPress", "close the window");
        if until(deadline, || windows::closed(pid, window)) {
            return Ok(());
        }
        pressed?;
        Err(Failure::unconfirmed(codes::ACTION_FAILED, "the window stayed open after its close button was pressed; it may be asking to save its changes"))
    })
}

#[cfg(test)]
mod tests;
