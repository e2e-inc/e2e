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

/// The element's AX role and its role in the snapshot's vocabulary. A read the app did not answer in time fails as a
/// stall, and a gone element as a stale ref, so either is retried rather than read as a control without the role; any
/// other failure reads as none.
fn role_of(element: &Element, what: &str) -> Outcome<(String, &'static str)> {
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
fn toggle_state(element: &Element) -> Option<u8> {
    crate::snapshot::parse_toggle(element.attribute("AXValue").ok().as_ref())
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
    let forward = until(deadline, || {
        app.boolean("AXFrontmost") == Some(true) && app.element("AXFocusedWindow").is_some_and(|focused| windows::holds_focus(&focused, window))
    });
    if forward { Ok(()) } else { Err(Failure::refused(codes::ACTION_FAILED, "the window could not be brought forward")) }
}

/// What the pointer lands on at a point.
#[derive(Debug, PartialEq)]
enum Aim {
    /// The element, or content inside it that takes no press of its own.
    Target,
    /// A control inside the element (a row's inline button): a click there presses it, not the element.
    Control,
    /// Something outside the element.
    Other,
}

/// Roles whose element takes a click of its own: a press, or the text a double-click selects.
fn presses(ax_role: &str) -> bool {
    matches!(
        ax_role,
        "AXButton"
            | "AXCheckBox"
            | "AXSwitch"
            | "AXRadioButton"
            | "AXPopUpButton"
            | "AXMenuButton"
            | "AXLink"
            | "AXDisclosureTriangle"
            | "AXIncrementor"
            | "AXSlider"
            | "AXTextField"
            | "AXTextArea"
            | "AXComboBox"
    )
}

/// The most steps a walk up from the element under the pointer takes: deeper than any window a snapshot reads.
const MAX_WALK: usize = 256;

/// Whether an element under the pointer takes a click of its own: by its role, or, for a role that may be decoration or
/// a control (an image, a group), by the press it offers.
fn takes_click(ax_role: &str, actions: impl FnOnce() -> Result<Vec<String>, AXError>) -> Result<bool, AXError> {
    if presses(ax_role) {
        return Ok(true);
    }
    // A role that never takes input (a separator, a splitter) is content. Any other one (a text label, an image, a group
    // a custom control draws itself in) is a control of its own when it offers a press, as the snapshot gives it a ref for one.
    if roles::inert(roles::role(ax_role, None)) {
        return Ok(false);
    }
    match actions() {
        Ok(names) => Ok(names.iter().any(|name| matches!(name.as_str(), "AXPress" | "AXOpen" | "AXConfirm"))),
        Err(ax::AX_CANNOT_COMPLETE) => Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => Ok(false),
    }
}

/// Folds the walk up from the element under the pointer: each step says whether it is the element, and else whether it
/// takes a click of its own. The walk ends (`None`) at the top, or after `MAX_WALK` steps, without reaching the element.
fn aim_along(mut walk: impl FnMut() -> Option<Result<(bool, bool), AXError>>) -> Result<Aim, AXError> {
    let mut control = false;
    for _ in 0..MAX_WALK {
        match walk() {
            Some(Ok((true, _))) => return Ok(if control { Aim::Control } else { Aim::Target }),
            Some(Ok((false, clicks))) => control = control || clicks,
            Some(Err(error)) => return Err(error),
            None => return Ok(Aim::Other),
        }
    }
    Ok(Aim::Other)
}

/// What the pointer lands on at a point on screen, relative to `element`, asked of the whole system: a floating panel
/// of another app over the element is what a click there reaches. `Err` when the app did not answer.
fn aim_at(element: &Element, x: f64, y: f64) -> Result<Aim, AXError> {
    let mut next = Element::system_wide().element_at(x, y)?;
    aim_along(|| {
        let hit = next.take()?;
        if &hit == element {
            return Some(Ok((true, false)));
        }
        let ax_role = match hit.attribute("AXRole") {
            Ok(value) => value.text().unwrap_or_default().to_owned(),
            Err(ax::AX_CANNOT_COMPLETE) => return Some(Err(ax::AX_CANNOT_COMPLETE)),
            Err(_) => String::new(),
        };
        let clicks = match takes_click(&ax_role, || hit.actions()) {
            Ok(clicks) => clicks,
            Err(error) => return Some(Err(error)),
        };
        next = match hit.attribute("AXParent") {
            Ok(Value::Element(parent)) => Some(parent),
            Err(ax::AX_CANNOT_COMPLETE) => return Some(Err(ax::AX_CANNOT_COMPLETE)),
            _ => None,
        };
        Some(Ok((false, clicks)))
    })
}

/// Whether the pointer may go where `aim` says it lands: `clicks` refuses a control inside the element, which a hover
/// does not press. A hit test the app did not answer is a stall, never a covering element.
fn aimed(aim: Result<Aim, AXError>, clicks: bool, when: &str) -> Outcome<()> {
    match aim {
        Ok(Aim::Target) => Ok(()),
        Ok(Aim::Control) if !clicks => Ok(()),
        Ok(Aim::Control) => {
            Err(Failure::refused(codes::ACTION_FAILED, format!("{when}, a control inside this element is under the pointer, so the click would press it")))
        }
        Ok(Aim::Other) => Err(Failure::refused(codes::ACTION_FAILED, format!("{when}, another element is under the pointer, so no click was sent there"))),
        Err(error) => Err(unread(error, "find the element under the pointer")),
    }
}

/// Physical pointer input at the element's center, once its window is forward and nothing covers it.
fn physical(entry: &Entry, action: Pointer) -> Outcome<()> {
    let window = windows::find(entry.pid, entry.window)?;
    go("pointer")?;
    raise(entry.pid, &window)?;
    let (x, y) = center(&entry.element)?;
    let clicks = matches!(action, Pointer::Click { .. });
    aimed(aim_at(&entry.element, x, y), clicks, "before the move")?;
    // Raising the window and the hit test can take a second on a slow app: the caller may have given up meanwhile. The
    // pointer's move can reveal a control over the element (a row's inline button): the first click checks the point
    // again. A double-click's second click follows at once, as part of the same gesture.
    input::pointer(x, y, action, &|click| if click == 1 { still_aimed(|| aim_at(&entry.element, x, y)) } else { go("pointer") })
}

/// Whether a click may go: the caller still wants it, the point still lands on the element, and the caller still
/// wants it after that check, which waits on the app.
fn still_aimed(aim: impl FnOnce() -> Result<Aim, AXError>) -> Outcome<()> {
    go("pointer")?;
    aimed(aim(), true, "after the move")?;
    go("pointer")
}

/// Waits a moment for a menu an action opened to show, so the next read finds it; an action that opens none waits it out and is still done.
fn menu_shown(pid: i32, before: usize, deadline: Instant) {
    until(deadline.min(Instant::now() + MENU_SHOW_WAIT), || windows::open_menus(pid) > before);
}

/// Waits within the action's budget for a control to be enabled, as an actionability wait does, and refuses it if it
/// stays disabled: a disabled AppKit control may still offer AXPress and acknowledge it while ignoring it. A control
/// with no enabled state goes at once.
fn enabled(element: &Element, deadline: Instant, what: &str) -> Outcome<()> {
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
fn reveal(element: &Element, deadline: Instant, what: &str) -> Outcome<bool> {
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
    if until(deadline, || placement(element) == Ok(Placement::Shown)) {
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
        let opens_menu = ax_role == "AXPopUpButton" || ax_role == "AXMenuButton";
        let before = windows::open_menus(entry.pid);
        perform(element, action, "click")?;
        if opens_menu {
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
    let holds = || match element.pid() {
        Some(pid) => Element::application(pid).element("AXFocusedUIElement").as_ref() == Some(element),
        None => element.boolean("AXFocused") == Some(true),
    };
    if holds() {
        return Ok(());
    }
    go("focus")?;
    // A focus write that failed after the app took it (a focus handler that replaced the element) may have run its
    // handlers: only a refusal shows nothing was sent, as for `set_value`.
    element.set_bool("AXFocused", true).map_err(|error| write_failed(error, "focus"))?;
    if until(deadline, holds) { Ok(()) } else { Err(Failure::unconfirmed(codes::ACTION_FAILED, "focus: the element did not take keyboard focus")) }
}

/// Whether an uncheck asks a selected radio button to clear itself, which only selecting another does: a press would
/// run its handler and leave it selected.
fn clears_only_by_another(role: &str, wanted: bool, shown: Option<u8>) -> bool {
    role == "radiobutton" && !wanted && shown == Some(1)
}

fn check(element: &Element, wanted: bool, deadline: Instant) -> Outcome<()> {
    // A press on anything but a box would run its handler (a submit, a delete) before the check could fail.
    let (_, role) = role_of(element, "check")?;
    if !roles::toggleable(role) {
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("a {role} has no checked state to set")));
    }
    let target = wanted as u8;
    let what = if wanted { "check" } else { "uncheck" };
    let read = || match element.attribute("AXValue") {
        Err(error @ (ax::AX_CANNOT_COMPLETE | ax::AX_INVALID_ELEMENT)) => Err(unread(error, what)),
        value => Ok(crate::snapshot::parse_toggle(value.ok().as_ref())),
    };
    let mut shown = read()?;
    if shown != Some(target) {
        // A disabled AppKit box acknowledges a press and ignores it: wait for it to be enabled, then read it again, as
        // the app may have set it meanwhile. A box that already shows the state asked for is left alone, disabled or not.
        enabled(element, deadline, what)?;
        shown = read()?;
    }
    // A box whose state cannot be read may already show the one asked for: a press would turn it the other way. Both
    // refusals come before the scroll below, as a refusal says nothing reached the app.
    if shown.is_none() {
        return Err(Failure::refused(
            codes::ACTION_NOT_SUPPORTED,
            format!("the {role} shows no checked state the engine can read, so pressing it could undo the one asked for"),
        ));
    }
    if clears_only_by_another(role, wanted, shown) {
        return Err(Failure::refused(codes::ACTION_FAILED, "a selected radio button is cleared only by selecting another one; nothing was pressed"));
    }
    // A box a scroll area holds out of view is pressed all the same through accessibility, out of the user's reach.
    let scrolled = if shown != Some(target) { reveal(element, deadline, what)? } else { false };
    if scrolled {
        // The list moved: the app may have set the box as it came into view, and a press now could undo that.
        shown = after_scroll(true, read())?;
        match shown {
            Some(state) if state == target => return Ok(()),
            Some(_) => {}
            None => {
                return Err(Failure::unconfirmed(
                    codes::ACTION_FAILED,
                    format!("the {role}'s state could not be read once it was scrolled into view, so it was not pressed"),
                ));
            }
        }
    }
    let reached = after_scroll(
        scrolled,
        press_to_state(
            target,
            shown,
            || perform(element, "AXPress", what),
            || {
                let before = shown;
                until(deadline, || toggle_state(element) != before);
                shown = toggle_state(element);
                shown
            },
        ),
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

/// Whether two stepper values are the same number: a step of 0.1 sums to 0.30000000000000004, not 0.3. `step`, once
/// a press showed it, bounds the tolerance to half a step, so no rounding allowance hides a whole step.
fn same(a: f64, b: f64, step: Option<f64>) -> bool {
    // Whole numbers a float holds exactly compare exactly: a step of 1 apart is a step, however large the value (a Unix
    // time in microseconds). Others compare up to a few hundred float epsilons of the larger, the error of summing
    // fractional steps such as 0.1.
    const EXACT: f64 = 9_007_199_254_740_992.0;
    if a.fract() == 0.0 && b.fract() == 0.0 && a.abs() <= EXACT && b.abs() <= EXACT {
        return a == b;
    }
    let rounding = f64::EPSILON * 256.0 * a.abs().max(b.abs()).max(1.0);
    (a - b).abs() <= step.map_or(rounding, |step| rounding.min(step.abs() / 2.0))
}

/// Steps a value toward `target`, one increment or decrement at a time, until it shows it. It stops when the value
/// cannot be read or a step changed nothing. When a step goes past the target (the step does not divide the distance),
/// it steps back to the value it started from, so a value the stepper cannot take leaves it as it was. It never steps past `deadline`: the steps
/// sent by then stay sent, delivered but unverified. A failed first step sent nothing; a failed later one follows steps
/// that landed. A step that answered with an error but may have landed is judged by the value it led to.
///
/// A start within rounding of the target, but not equal to it, may be the target summed by earlier steps or a value a
/// small step away from it: one step tells which, and when it was the target, a step back puts it as it was.
fn step_to(
    target: f64,
    shown: Option<f64>,
    deadline: Instant,
    mut step: impl FnMut(bool) -> Outcome<()>,
    mut settle: impl FnMut() -> Option<f64>,
) -> Outcome<bool> {
    let Some(start) = shown else { return Ok(false) };
    if start == target {
        return Ok(true);
    }
    let probing = same(start, target, None);
    let mut size = None;
    let mut now = start;
    for attempt in 0..MAX_STEPS {
        if !(probing && attempt == 0) && same(now, target, size) {
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
        // A press that changed nothing leaves the very number it found: any difference is a step, however small.
        if next == now {
            return stepped.map(|()| false);
        }
        // A step that went the other way wrapped around the stepper's range: stepping on would only cycle through it.
        if (up && next < now) || (!up && next > now) {
            return Err(Failure::unconfirmed(
                codes::ACTION_FAILED,
                format!("the stepper went from {now} to {next} on a step toward {target}: it wraps, and cannot reach the value"),
            ));
        }
        size = Some((next - now).abs());
        let start_was_target = probing && attempt == 0 && same(start, target, size);
        if start_was_target || (!same(next, target, size) && ((up && next > target) || (!up && next < target))) {
            // Put back the value it had before the fill, a step at a time: a fill the stepper cannot take must not leave
            // it changed. As many steps back as went forward, and none more once a step changes nothing.
            let mut value = next;
            for _ in 0..=attempt {
                if same(value, start, size) || step(!up).is_err() {
                    break;
                }
                match settle() {
                    Some(back) if !same(back, value, size) => value = back,
                    _ => break,
                }
            }
            if start_was_target {
                return if same(value, start, size) {
                    Ok(true)
                } else {
                    Err(Failure::unconfirmed(
                        codes::ACTION_FAILED,
                        format!("the stepper already showed {start}; a step to tell it from {target} left it at {value}"),
                    ))
                };
            }
            let failure = Failure::unconfirmed(codes::ACTION_FAILED, format!("the stepper steps from {now} to {next}, past {target}"));
            return Err(if same(value, start, size) {
                Failure { message: format!("{}; it was stepped back to {start}", failure.message), ..failure }
            } else {
                Failure { message: format!("{}, and could not be stepped back to {start}", failure.message), ..failure }
            });
        }
        now = next;
    }
    Ok(same(now, target, size))
}

/// Whether a stepper's target lies outside the range it reports: below `min` or above `max`. A bound it does not report
/// limits nothing.
fn outside(target: f64, min: Option<f64>, max: Option<f64>) -> bool {
    min.is_some_and(|min| target < min) || max.is_some_and(|max| target > max)
}

/// The number a text names, when it names a finite one: `NaN` or `inf` is no value a control can take.
fn finite(text: &str) -> Result<f64, ()> {
    text.trim().parse::<f64>().ok().filter(|number| number.is_finite()).ok_or(())
}

fn set_value(element: &Element, text: &str, deadline: Instant) -> Outcome<()> {
    // A disabled field takes no value: wait for it to be enabled, as a fill's actionability wait does.
    enabled(element, deadline, "set value")?;
    let (ax_role, role) = role_of(element, "set value")?;
    let secure = ax_role == "AXSecureTextField" || element.text("AXSubrole").as_deref() == Some("AXSecureTextField");
    if !settable(element, "AXValue", "set value")? {
        // A stepper whose value cannot be written still steps toward a number.
        let names = action_names(element, "set value")?;
        let steps = names.iter().any(|name| name == "AXIncrement" || name == "AXDecrement");
        if let (true, Ok(Value::Number(_)), Ok(target)) = (steps, element.attribute("AXValue"), finite(text)) {
            // A value outside the range the stepper reports is one no step reaches: refused before any press.
            let bound = |name: &str| match element.attribute(name) {
                Ok(Value::Number(number)) => Some(number),
                _ => None,
            };
            if outside(target, bound("AXMinValue"), bound("AXMaxValue")) {
                return Err(Failure::refused(codes::ACTION_FAILED, format!("{} is outside the range of this {role}", text.trim())));
            }
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
    // A focus write that failed after the app took it (a focus handler that replaced the field) may still have run its
    // handlers: only a refusal shows it did not.
    let moved_focus = roles::takes_text(role) && settable(element, "AXFocused", "set value")? && element.boolean("AXFocused") != Some(true) && {
        go("set value")?;
        element.set_bool("AXFocused", true).map_or_else(|error| !refuses(error), |()| true)
    };
    let numeric = matches!(element.attribute("AXValue"), Ok(Value::Number(_)));
    // The reads above can take long on a slow app; the caller may have given up since.
    go("set value").map_err(|failure| if moved_focus { failure.delivered() } else { failure })?;
    let written = match (numeric, finite(text)) {
        (true, Ok(number)) => element.set_number("AXValue", number),
        _ => element.set_text("AXValue", text),
    };
    // A write the app answered with anything but a refusal may have run its change handler (one that replaced the
    // field answers a gone element): only a refusal says nothing was sent.
    written.map_err(|error| if moved_focus { refused(error, "set value").delivered() } else { write_failed(error, "set value") })?;
    if secure {
        // A secure field shows no value, but counts its characters: the count says the text landed whole (one a
        // formatter cut short does not), with no secret read. A field that counts none is taken at the write's word.
        // `Err` for a read the app did not answer in time, which is no proof the field counts none: it is read again.
        let count = || match element.attribute("AXNumberOfCharacters") {
            Ok(Value::Number(count)) => Ok(Some(count as usize)),
            Err(ax::AX_CANNOT_COMPLETE) => Err(()),
            _ => Ok(None),
        };
        let wanted = text.encode_utf16().count();
        if count() == Ok(None) || until(deadline, || count() == Ok(Some(wanted))) {
            return Ok(());
        }
        return Err(Failure::unconfirmed(codes::ACTION_FAILED, "the secure field did not take the whole text set"));
    }
    let expected = if numeric { finite(text).map(ax::format_number).unwrap_or_else(|_| text.to_owned()) } else { text.to_owned() };
    if until(deadline, || value_text(element).as_deref() == Some(expected.as_str())) {
        Ok(())
    } else {
        Err(Failure::unconfirmed(codes::ACTION_FAILED, "the value did not change to the text set"))
    }
}

/// Selects all the text of a field through accessibility. A select-all key (Cmd+A) sent to an app in the background
/// goes to its menu bar, not the field, so the delete after it would remove one character.
fn select_all(element: &Element, deadline: Instant) -> Outcome<()> {
    if !settable(element, "AXSelectedTextRange", "select all")? {
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "select all: the field's selection cannot be set"));
    }
    // A secure field shows no value, but still counts its characters. A field with neither cannot be shown to be
    // selected whole: a range of 0 would read as done and leave its text in place.
    let length = match element.attribute("AXNumberOfCharacters") {
        Ok(Value::Number(count)) if count >= 0.0 => count as usize,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(unread(ax::AX_CANNOT_COMPLETE, "select all")),
        _ => match value_text(element) {
            Some(text) => text.encode_utf16().count(),
            None => return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "select all: the field's length cannot be read")),
        },
    };
    go("select all")?;
    element.set_range("AXSelectedTextRange", 0, length).map_err(|error| refused(error, "select all"))?;
    if until(deadline, || matches!(element.attribute("AXSelectedTextRange"), Ok(Value::Range(0, selected)) if selected == length)) {
        Ok(())
    } else {
        Err(Failure::unconfirmed(codes::ACTION_FAILED, "select all: the field's text did not become selected"))
    }
}

/// How deep `row_label` reads into a row for its text. A row deeper than this has a label it cannot read whole, which
/// counts as a read the app did not answer: never a match, and never proof the option is missing.
const ROW_TEXT_DEPTH: usize = 16;

/// The name a list's row shows, as the snapshot names it: its own title or description (a text item's value), else,
/// with none, every text inside it in reading order, joined by spaces.
fn row_label(element: &Element) -> Result<Option<String>, AXError> {
    if let Some(own) = own_label(element)? {
        return Ok(Some(own));
    }
    let mut texts = Vec::new();
    row_texts(element, 0, &mut texts)?;
    Ok(crate::snapshot::content_name(&texts))
}

/// An element's own name, as the snapshot gives it: its title, else the text of the element that labels it
/// (`AXTitleUIElement`), else its description, else, for a text, its value.
fn own_label(element: &Element) -> Result<Option<String>, AXError> {
    let values = match element.attributes(&["AXRole", "AXTitle", "AXDescription", "AXValue", "AXTitleUIElement"]) {
        Ok(values) => values,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => return Ok(None),
    };
    let text = |index: usize| values[index].as_ref().and_then(Value::text).map(str::to_owned).filter(|text| !text.trim().is_empty());
    let role = values[0].as_ref().and_then(Value::text).unwrap_or_default();
    let labelled = match &values[4] {
        Some(Value::Element(label)) => crate::snapshot::label_of(label)?,
        _ => None,
    };
    Ok(text(1).or(labelled).or_else(|| text(2)).or_else(|| if roles::text(roles::role(role, None)) { text(3) } else { None }))
}

/// The texts inside an element, in reading order, as the snapshot gathers a row's name from them.
fn row_texts(element: &Element, depth: usize, texts: &mut Vec<String>) -> Result<(), AXError> {
    // Every child is read, as the snapshot reads them: a label cut short could match a prefix of the one asked for.
    let children = match element.elements("AXChildren", crate::snapshot::MAX_CHILDREN) {
        Ok(children) => children,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => Vec::new(),
    };
    if !children.is_empty() && depth >= ROW_TEXT_DEPTH {
        return Err(ax::AX_CANNOT_COMPLETE);
    }
    for child in children {
        let role = match child.attribute("AXRole") {
            Ok(value) => value.text().unwrap_or_default().to_owned(),
            Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
            Err(_) => String::new(),
        };
        if roles::text(roles::role(&role, None)) {
            if let Some(text) = own_label(&child)? {
                texts.push(text);
            }
        } else {
            row_texts(&child, depth + 1, texts)?;
        }
    }
    Ok(())
}

/// The pop-up button's menu, if it is already open.
/// `Err` when the app did not answer in time: a stall is no proof the menu is closed.
fn current_menu(button: &Element) -> Result<Option<Element>, AXError> {
    let children = match button.elements("AXChildren", 4) {
        Ok(children) => children,
        Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
        Err(_) => return Ok(None),
    };
    for child in children {
        match child.attribute("AXRole") {
            Ok(role) if role.text() == Some("AXMenu") => return Ok(Some(child)),
            Err(ax::AX_CANNOT_COMPLETE) => return Err(ax::AX_CANNOT_COMPLETE),
            _ => {}
        }
    }
    Ok(None)
}

/// The open menu of a pop-up button, once it shows.
fn open_menu(button: &Element, deadline: Instant) -> Option<Element> {
    let mut menu = None;
    until(deadline, || {
        menu = current_menu(button).ok().flatten();
        menu.is_some()
    });
    menu
}

/// How often the wait for a typed key reads the field.
const KEY_POLL: Duration = Duration::from_millis(2);

/// The longest wait for the app to take a typed key before the next one goes.
const KEY_SETTLE: Duration = Duration::from_millis(250);

/// The wait after a typed key when the field's length cannot be read, so its effect cannot be seen.
const KEY_SETTLE_UNREAD: Duration = Duration::from_millis(30);

/// How long each way of closing a menu nothing was chosen from waits for it, past the action's deadline too: an open
/// menu covers the window.
const MENU_CLOSE_WAIT: Duration = Duration::from_millis(500);

/// How long a menu that refused `AXCancel` is watched before Escape: the refusal may still have closed it.
const MENU_CLOSE_GLANCE: Duration = Duration::from_millis(100);

/// Closes a menu nothing was chosen from, and answers whether it closed. It runs after the action's deadline too: each
/// way of closing gets a wait of its own, so an `AXCancel` that used its wait still leaves Escape time to be seen.
fn close_menu(pid: i32, menu: &Element) -> bool {
    close_menu_with(
        cancelled,
        || windows::open_menus(pid) == 0,
        || menu.perform("AXCancel").is_ok(),
        || {
            // Escape goes to the process, which may have closed this menu and opened another: it is sent only while this
            // menu is still there, and a menu left open then makes the failure delivered.
            // The read waits on the app, and the caller may cancel meanwhile: it is checked again just before the key.
            if menu.attribute("AXRole").is_ok() && !cancelled() {
                let _ = input::parse_combo("escape").and_then(|combo| input::press(&combo, Route::Process(pid)));
            }
        },
    )
}

/// `close_menu`'s steps, over `stopped` (the caller cancelled), `closed` (no menu is open), `cancel` (sends `AXCancel`,
/// and says whether the menu took it), and `escape` (sends Escape).
fn close_menu_with(stopped: impl Fn() -> bool, closed: impl Fn() -> bool, cancel: impl FnOnce() -> bool, escape: impl FnOnce()) -> bool {
    // A cancelled action's caller has moved on, and may be working with this menu or another: nothing more is sent, and
    // the menu may be open.
    if stopped() {
        return closed();
    }
    // A menu that answered the action with an error gets only a glance: an Escape sent once the menu closed would reach
    // the window under it (a sheet it cancels), so even then the driver looks before it sends one.
    let wait = if cancel() { MENU_CLOSE_WAIT } else { MENU_CLOSE_GLANCE };
    if until(Instant::now() + wait, &closed) {
        return true;
    }
    // A cancel that came while the menu was watched: an Escape now could close a menu the caller's next action opened.
    if stopped() {
        return false;
    }
    escape();
    until(Instant::now() + MENU_CLOSE_WAIT, closed)
}

/// The first `limit` items `matches` takes, and whether a read of one the app did not answer in time left an item
/// unread: that item may be the one asked for. Each read waits on the app, and a list can hold thousands of items: the
/// scan stops with the cut-off once the caller gave up or ran out of time.
fn scan<T>(items: Vec<T>, what: &str, limit: usize, mut matches: impl FnMut(&T) -> Result<bool, AXError>) -> Outcome<(Vec<T>, bool)> {
    let mut found = Vec::new();
    let mut stalled = false;
    for item in items {
        go(what)?;
        match matches(&item) {
            Ok(true) => {
                found.push(item);
                if found.len() >= limit {
                    break;
                }
            }
            Ok(false) => {}
            Err(error) => stalled |= error == ax::AX_CANNOT_COMPLETE,
        }
    }
    Ok((found, stalled))
}

/// A select's failure before anything was chosen, once its menu was closed or failed to close. A menu that stayed open
/// changed the screen, and covers the window for the next action, so the failure is no longer "nothing sent".
fn unclosed(failure: Failure, closed: bool) -> Failure {
    if closed { failure } else { failure.delivered().with_details(serde_json::json!({ "menu": "open" })) }
}

fn select(entry: &Entry, label: &str, deadline: Instant) -> Outcome<()> {
    let element = &entry.element;
    let (ax_role, role) = role_of(element, "select")?;
    // A pull-down keeps its own title, so a choice cannot be read back from it: tap it and the menu item instead.
    if ax_role == "AXMenuButton" {
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "a pull-down menu shows no selected option; tap it, then tap the menu item"));
    }
    // A disabled pop-up ignores the press that would open its list.
    enabled(element, deadline, "select")?;
    if ax_role == "AXPopUpButton" {
        // A menu the user or a tap already opened on this button is the list: a press would close it. With it open, the
        // option shown is chosen from it too, so the menu does not stay open over the window.
        let already_open = current_menu(element).map_err(|error| unread(error, "read the list's menu"))?;
        if already_open.is_none() && value_text(element).as_deref() == Some(label) {
            return Ok(());
        }
        let menu = if let Some(menu) = already_open {
            menu
        } else {
            // A menu still closing (the last select's) would take the press.
            until(deadline, || windows::open_menus(entry.pid) == 0);
            perform(element, "AXPress", "open the list")?;
            open_menu(element, deadline).ok_or_else(|| Failure::unconfirmed(codes::ACTION_FAILED, "the list's menu did not open"))?
        };
        // Until the item is pressed nothing is chosen: a failure closes the menu again, and says when it stayed open,
        // since an open menu covers the window for the next action.
        let unchosen = |failure: Failure| unclosed(failure, close_menu(entry.pid, &menu));
        let items = all(&menu, "AXChildren", "read the list's options").map_err(unchosen)?;
        // A title the app did not answer in time may be the option asked for: that is no proof it is missing.
        let (found, stalled) =
            scan(items, "read the list's options", usize::MAX, |candidate| candidate.attribute("AXTitle").map(|title| title.text() == Some(label)))
                .map_err(unchosen)?;
        // An enabled option of that title is the one; a disabled one that comes first must not hide it. With none
        // enabled, the first is waited for below.
        let chosen = found.iter().find(|candidate| candidate.boolean("AXEnabled") != Some(false)).or(found.first()).cloned();
        let Some(item) = chosen else {
            return Err(unchosen(if stalled {
                unread(ax::AX_CANNOT_COMPLETE, "read the list's options")
            } else {
                Failure::refused(codes::ELEMENT_NOT_FOUND, format!("the list has no option \"{label}\""))
            }));
        };
        // A disabled option takes the press and ignores it: it is waited for, and refused as disabled, not as missing.
        enabled(&item, deadline, "select").map_err(unchosen)?;
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
    // An editable combo box is refused before this (a fill sets it); one that takes no typed value shows its list only
    // when opened.
    if ax_role == "AXComboBox" {
        return Err(Failure::refused(
            codes::ACTION_NOT_SUPPORTED,
            "a combo box that takes no typed value cannot be selected by label yet; tap it, then tap the option",
        ));
    }
    if roles::collection(role) {
        let rows = match all(element, "AXRows", "read the list's rows")? {
            rows if rows.is_empty() => all(element, "AXChildren", "read the list's rows")?,
            rows => rows,
        };
        // A row the app did not answer in time may be the option asked for: that is no proof it is missing.
        // Two rows that show the label leave the choice open: neither is selected, as no handler of the wrong one may run.
        let (found, stalled) = scan(rows, "read the list's rows", 2, |candidate| row_label(candidate).map(|text| text.as_deref() == Some(label)))?;
        if found.len() > 1 {
            return Err(Failure::refused(codes::ACTION_FAILED, format!("more than one option of the list is \"{label}\"; select it another way")));
        }
        // A row whose label could not be read may show the label too: one match is no proof it is the only one.
        if stalled {
            return Err(unread(ax::AX_CANNOT_COMPLETE, "read the list's rows"));
        }
        let Some(row) = found.into_iter().next() else {
            return Err(Failure::refused(codes::ELEMENT_NOT_FOUND, format!("the list has no option \"{label}\"")));
        };
        let (_, row_role) = role_of(&row, "select")?;
        if matches!(row_role, "radiobutton" | "tab") {
            // An app can refuse the choice (an NSTabViewDelegate's shouldSelect) while the press itself succeeds: the
            // option must show it is the selected one.
            let selected = || row.boolean("AXSelected") == Some(true) || toggle_state(&row) == Some(1);
            if !selected() {
                // A disabled option takes the press and ignores it.
                enabled(&row, deadline, "select")?;
                perform(&row, "AXPress", "choose the option")?;
                if !until(deadline, selected) {
                    return Err(Failure::unconfirmed(codes::ACTION_FAILED, format!("\"{label}\" did not become selected")));
                }
            }
            return Ok(());
        }
        if choose_row(Some(element), &row, deadline, &format!("\"{label}\" did not become selected"))? {
            return Ok(());
        }
        return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, "the list takes no selection through accessibility"));
    }
    Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("a {role} has no options to select")))
}

/// Selects `row`, through `list`'s `AXSelectedRows` when the list takes it, else through the row's own `AXSelected`, and
/// waits for the row to show it is selected (`unselected` when it does not). `Ok(false)` when neither can be written:
/// nothing was sent.
fn choose_row(list: Option<&Element>, row: &Element, deadline: Instant, unselected: &str) -> Outcome<bool> {
    let by_rows = match list {
        Some(list) => settable(list, "AXSelectedRows", "select")?,
        None => false,
    };
    if !by_rows && !settable(row, "AXSelected", "select")? {
        return Ok(false);
    }
    // The reads before can take long on a slow app; the caller may have given up since.
    go("select")?;
    let written = match list {
        Some(list) if by_rows => list.set_elements("AXSelectedRows", std::slice::from_ref(row)),
        _ => row.set_bool("AXSelected", true),
    };
    written.map_err(|error| write_failed(error, "select the row"))?;
    if until(deadline, || row.boolean("AXSelected") == Some(true)) {
        return Ok(true);
    }
    Err(Failure::unconfirmed(codes::ACTION_FAILED, unselected))
}

/// A scroll area's scroll bar for one axis. A SwiftUI `List` lists it only as a child, with no `AXVerticalScrollBar`.
pub fn scroll_bar(element: &Element, vertical: bool) -> Option<Element> {
    element.element(if vertical { "AXVerticalScrollBar" } else { "AXHorizontalScrollBar" }).or_else(|| {
        let orientation = if vertical { "AXVerticalOrientation" } else { "AXHorizontalOrientation" };
        element.elements("AXChildren", 16).ok()?.into_iter().find(|child| {
            child.text("AXRole").as_deref() == Some("AXScrollBar")
                && match child.text("AXOrientation") {
                    Some(shown) => shown == orientation,
                    // No orientation: a vertical bar is taller than it is wide.
                    None => child.frame().is_some_and(|(_, _, width, height)| (height > width) == vertical),
                }
        })
    })
}

/// Scrolls a scroll area by moving its scroll bar, `pages` of its visible size.
fn scroll(element: &Element, direction: &str, pages: f64) -> Outcome<()> {
    let vertical = matches!(direction, "up" | "down");
    // A list or table scrolls through the scroll area that holds it: a swipe on the list moves that one.
    let target = if scroll_bar(element, vertical).is_some() { None } else { enclosing_scroll_area(element, vertical) };
    scroll_by(target.as_ref().unwrap_or(element), direction, pages).map_err(|failure| {
        // An element that takes none of the ways to scroll: say so, not which attribute it lacks.
        if failure.code == codes::ACTION_NOT_SUPPORTED && failure.delivery == Delivery::NotDelivered {
            Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("nothing here scrolls {direction}"))
        } else {
            failure
        }
    })
}

/// The nearest scroll area above `element`, a few levels up, with a scroll bar for the axis.
fn enclosing_scroll_area(element: &Element, vertical: bool) -> Option<Element> {
    let mut current = element.element("AXParent")?;
    for _ in 0..4 {
        if current.text("AXRole").as_deref() == Some("AXScrollArea") && scroll_bar(&current, vertical).is_some() {
            return Some(current);
        }
        current = current.element("AXParent")?;
    }
    None
}

/// About how many of a scroll bar's increments make a page.
const LINES_PER_PAGE: f64 = 8.0;

/// Performs a scroll action `count` times. Each goes through the cancel check; a failure after the first follows a
/// scroll that landed.
fn repeat(element: &Element, action: &str, count: usize) -> Outcome<()> {
    for sent in 0..count {
        perform(element, action, "scroll").map_err(|failure| if sent == 0 { failure } else { failure.delivered() })?;
    }
    Ok(())
}

fn scroll_by(element: &Element, direction: &str, pages: f64) -> Outcome<()> {
    let vertical = matches!(direction, "up" | "down");
    let forward = matches!(direction, "down" | "right");
    if let Some(bar) = scroll_bar(element, vertical) {
        // A position the app did not answer is no position: one step from the top could move the view the wrong way.
        let current = match bar.attribute("AXValue") {
            Ok(Value::Number(number)) => Some(number),
            Err(ax::AX_CANNOT_COMPLETE) => return Err(unread(ax::AX_CANNOT_COMPLETE, "scroll")),
            _ => None,
        };
        let (_, _, width, height) = element.frame().unwrap_or((0.0, 0.0, 0.0, 0.0));
        let visible = if vertical { height } else { width };
        let content = element
            .element("AXContents")
            .or_else(|| element.elements("AXChildren", 16).ok()?.into_iter().find(|child| child.text("AXRole").as_deref() != Some("AXScrollBar")))
            .and_then(|contents| contents.frame())
            .map(|(_, _, width, height)| if vertical { height } else { width })
            .unwrap_or(0.0);
        let step = if content > visible && visible > 0.0 { pages * visible / (content - visible) } else { pages * 0.25 };
        if let Some(current) = current
            && settable(&bar, "AXValue", "scroll")?
        {
            let next = (current + if forward { step } else { -step }).clamp(0.0, 1.0);
            go("scroll")?;
            return bar.set_number("AXValue", next).map_err(|error| write_failed(error, "scroll"));
        }
        // A step is about a line: as many as make the pages asked for, so a fast swipe goes further than a slow one.
        return repeat(&bar, if forward { "AXIncrement" } else { "AXDecrement" }, ((pages * LINES_PER_PAGE).round() as usize).max(1));
    }
    let names = action_names(element, "scroll")?;
    let action = match direction {
        "down" => "AXScrollDownByPage",
        "up" => "AXScrollUpByPage",
        "right" => "AXScrollRightByPage",
        _ => "AXScrollLeftByPage",
    };
    if names.iter().any(|name| name == action) {
        return repeat(element, action, (pages.round() as usize).max(1));
    }
    Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("nothing here scrolls {direction}")))
}

fn type_text(entry: &Entry, text: &str, physical: bool, deadline: Instant) -> Outcome<()> {
    let window = windows::find(entry.pid, entry.window)?;
    // Text sent to the app goes to its key window, which must be the one the field is in, as for `press`.
    if !physical {
        key_window(entry.pid, &window)?;
    }
    // Focus this call moved into the field reached the app (its handlers may have run); focus it already had did not.
    let moved = entry.element.boolean("AXFocused") != Some(true);
    focus(&entry.element, deadline)?;
    let after_focus = |failure: Failure| if moved { failure.delivered() } else { failure };
    let route = if physical {
        raise(entry.pid, &window).map_err(after_focus)?;
        Route::Physical
    } else {
        Route::Process(entry.pid)
    };
    // Each key goes only while the window that held the keyboard when typing began still does: a Return that opened another
    // window, a sheet on this one included, or another app must not take the rest of the text with it. A field in a sheet
    // that was there from the start keeps its sheet. Read before the field's own check, so a window a focus handler opens
    // after it shows as a change at the first key, and one it opened before fails that check.
    let typing_in = Element::application(entry.pid).element("AXFocusedWindow");
    if typing_in.as_ref().is_some_and(|start| !windows::holds_focus(start, &window)) {
        return Err(after_focus(Failure::refused(codes::ACTION_FAILED, "another window took the keyboard before typing began, so nothing was typed")));
    }
    // Focusing the field can run a handler that opens a sheet or another window, and coming forward can too: the keys
    // would then go there. The field itself must hold the app's focus before the first key.
    if Element::application(entry.pid).element("AXFocusedUIElement").as_ref() != Some(&entry.element) {
        return Err(after_focus(Failure::refused(codes::ACTION_FAILED, "the field lost keyboard focus before typing began, so nothing was typed")));
    }
    // What an element holds, in characters, as the app answers it: a change says the app took the key sent last.
    let length = |element: &Element| match element.attribute("AXNumberOfCharacters") {
        Ok(Value::Number(count)) => Some(count),
        _ => None,
    };
    let focused_element = || Element::application(entry.pid).element("AXFocusedUIElement");
    // The element that held the keyboard when the last key went, and its length then; unset before the first key. It is
    // the field typing began in until a Tab, or a code field's next box, takes the keys within the window.
    let sent_to: std::cell::RefCell<Option<(Option<Element>, Option<f64>)>> = std::cell::RefCell::new(None);
    // Set once a key showed no change in its whole wait: a field that drops or caps characters would spend the wait on
    // every key after it, so the rest get the short one.
    let quiet = std::cell::Cell::new(false);
    let still = || -> Outcome<()> {
        // A key posted to the app is in its queue, not yet handled: wait until the element it went to shows it, or focus
        // moved, so a window the key opened (a handler on the text, a Return) holds the keyboard by the time the check
        // below reads it.
        let last = sent_to.borrow().clone();
        if let Some((target, before)) = &last {
            let settle = deadline.min(Instant::now() + if quiet.get() { KEY_SETTLE_UNREAD } else { KEY_SETTLE });
            match (target, *before) {
                (Some(target), Some(count)) => {
                    // A fine poll of its own: the app takes a key within a millisecond or two, and `until`'s coarse one
                    // would add its whole interval to every key.
                    let taken = || length(target) != Some(count) || focused_element().as_ref() != Some(target);
                    let mut seen = taken();
                    while !seen && Instant::now() < settle {
                        sleep(KEY_POLL);
                        seen = taken();
                    }
                    if !seen {
                        quiet.set(true);
                    }
                }
                _ => sleep(KEY_SETTLE_UNREAD.min(settle.saturating_duration_since(Instant::now()))),
            }
        }
        // The element the key will reach, read before the checks below, so nothing reads the app between them and the
        // key: focus that moves while they run is caught by them, not followed. The first key goes only to the field.
        let target = focused_element();
        let count = target.as_ref().and_then(&length);
        if last.is_none() && target.as_ref() != Some(&entry.element) {
            return Err(Failure::refused(codes::ACTION_FAILED, "the field lost keyboard focus before typing began, so nothing was typed"));
        }
        let app = Element::application(entry.pid);
        let focused = app.element("AXFocusedWindow");
        let held = match &typing_in {
            Some(start) => focused.as_ref() == Some(start),
            None => focused.is_some_and(|focused| windows::holds_focus(&focused, &window)),
        };
        let forward = !physical || app.boolean("AXFrontmost") == Some(true);
        if held && forward {
            sent_to.replace(Some((target, count)));
            Ok(())
        } else {
            Err(Failure::refused(codes::ACTION_FAILED, "typing stopped: the field's window lost the keyboard to another window or app"))
        }
    };
    CURRENT
        .with(|current| match current.borrow().as_ref() {
            Some((run, _)) => input::type_text(text, route, run, deadline, &still),
            None => Err(Failure::refused(codes::INTERNAL, "type ran outside an action")),
        })
        .map_err(after_focus)
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
        if let Some(reference) = focused {
            let entry = refs::get(reference).ok_or_else(|| Failure::refused(codes::STALE_REF, format!("{reference} names no element of a recent snapshot")))?;
            if Element::application(pid).element("AXFocusedUIElement").as_ref() != Some(&entry.element) {
                return Err(Failure::refused(codes::ACTION_FAILED, "the control lost keyboard focus before the key was sent, so nothing was sent"));
            }
        }
        // A key sent as physical input goes to whatever app is frontmost: the user may have switched apps since the raise,
        // while the app still names its own focused control.
        if physical {
            // The window check waits on the app: the frontmost check comes after it, the last read before the key, so a
            // switch to another app while it ran is still caught.
            key_window(pid, &element)?;
            if !frontmost(pid)? {
                return Err(Failure::refused(codes::ACTION_FAILED, "another app came forward before the key was sent, so nothing was sent"));
            }
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
    if Element::application(pid).element("AXFocusedWindow").is_some_and(|focused| windows::holds_focus(&focused, window)) {
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

/// The sheet on a window that held its focus when a point was taken.
#[derive(Clone, Debug, PartialEq)]
pub enum Sheet {
    None,
    /// A sheet, by its key (`Element::sheet_key`).
    Key(String),
    /// A sheet the caller could name no key for: no sheet now is known to be it.
    Unnamed,
}

/// Whether a click at a point taken in a window may go: the app is frontmost, the window holds its focus, and the sheet
/// on it (`now`) is the one that was there when the point was taken (`then`): none opened, none closed, and none took
/// another's place. A sheet with no key is never known to be the same one.
fn takes_point(frontmost: bool, holds: bool, now: &Sheet, then: &Sheet) -> Outcome<()> {
    if !frontmost {
        return Err(Failure::refused(codes::ACTION_FAILED, "another app came forward over the window the point was taken in, so no click was sent"));
    }
    if !holds {
        return Err(Failure::refused(codes::ACTION_FAILED, "another window took focus from the one the point was taken in, so no click was sent"));
    }
    let message = match (now, then) {
        (Sheet::None, Sheet::None) => return Ok(()),
        (_, Sheet::None) => "a sheet opened over the window the point was taken in, so no click was sent",
        (Sheet::None, _) => "the sheet the point was taken on closed, so no click was sent to what was under it",
        (Sheet::Key(now), Sheet::Key(then)) if now == then => return Ok(()),
        _ => "another sheet took the place of the one the point was taken on, or it cannot be told apart from one, so no click was sent",
    };
    Err(Failure::refused(codes::ACTION_FAILED, message))
}

/// The window a point was taken in, which must still take a click at it.
#[derive(Clone, Debug)]
pub struct PointTarget {
    pub pid: i32,
    pub window: u32,
    pub sheet: Sheet,
    /// The point is on a node that takes no click of its own (one the snapshot gave no ref): no control may be under it.
    pub content: bool,
}

/// `takes_point` for a window of `pid`, read now, and the point on top of that window, not of another app's or
/// window's over it. A read the app did not answer in time is a stall.
fn window_takes_point(target: &PointTarget, x: f64, y: f64) -> Outcome<()> {
    let PointTarget { pid, window: id, ref sheet, content } = *target;
    let window = windows::find(pid, id)?;
    let app = Element::application(pid);
    let frontmost = frontmost(pid)?;
    let focused = match app.attribute("AXFocusedWindow") {
        Ok(Value::Element(focused)) => Some(focused),
        Err(error) if error == ax::AX_CANNOT_COMPLETE => return Err(unread(error, "read the app's focused window")),
        _ => None,
    };
    let holds = focused.as_ref().is_some_and(|focused| windows::holds_focus(focused, &window));
    let now = match focused.filter(|focused| *focused != window) {
        None => Sheet::None,
        Some(on) => Sheet::Key(on.sheet_key()),
    };
    takes_point(frontmost, holds, &now, sheet)?;
    point_lands(aim_at(&window, x, y), content)
}

/// For a hover: the point is on the window it was taken in, not on another app's or window's over it, which the move
/// would reach. A hover presses nothing, so a control under the point, focus, and sheets are not checked.
fn window_on_point(target: &PointTarget, x: f64, y: f64) -> Outcome<()> {
    let window = windows::find(target.pid, target.window)?;
    match aim_at(&window, x, y) {
        Ok(Aim::Target | Aim::Control) => Ok(()),
        Ok(Aim::Other) => Err(Failure::refused(codes::ACTION_FAILED, "another window or app is on top at the point, so the pointer was not moved")),
        Err(error) => Err(unread(error, "find the element under the pointer")),
    }
}

/// Whether a click at a point may go where the hit test (relative to the window) says it lands. A tap at a point names
/// no element, so any control of the window may be there, unless the point was taken on `content`, a node that takes
/// no click of its own: a control there now (one coming forward revealed) would take the click.
fn point_lands(aim: Result<Aim, AXError>, content: bool) -> Outcome<()> {
    match aim {
        Ok(Aim::Target) => Ok(()),
        Ok(Aim::Control) if !content => Ok(()),
        Ok(Aim::Control) => Err(Failure::refused(
            codes::ACTION_FAILED,
            "a control is under the pointer at the node the point was taken on (over it, or one it is in), so no click was sent",
        )),
        Ok(Aim::Other) => Err(Failure::refused(codes::ACTION_FAILED, "another window or app is on top at the point, so no click was sent")),
        Err(error) => Err(unread(error, "find the element under the pointer")),
    }
}

/// Physical pointer input at a point on screen, sent only while `input_id` is not cancelled and `deadline` has not
/// passed. With `target` (the app, the window the point was taken in, the sheet on it then, and whether the point is on
/// a node that takes no click of its own), the first click goes only while that window still takes it, checked after
/// the move.
pub fn pointer_at(x: f64, y: f64, kind: &str, input_id: Option<u32>, deadline: Instant, target: Option<PointTarget>) -> Outcome<()> {
    let action = match kind {
        "hover" => Pointer::Move,
        "tap" => Pointer::Click { right: false, count: 1 },
        "doubleTap" => Pointer::Click { right: false, count: 2 },
        "secondaryTap" => Pointer::Click { right: true, count: 1 },
        other => return Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("no pointer action {other}"))),
    };
    guarded(input_id, deadline, || {
        // A point another window or app already covers is refused before the move, which would reach that window: nothing
        // is sent. The check after the move is for one that opens meanwhile, before a click. A hover presses nothing, so
        // it is checked only for a window or app over the point, which the move alone would reach.
        if let Some(target) = target.as_ref() {
            go("pointer")?;
            match action {
                Pointer::Click { .. } => window_takes_point(target, x, y)?,
                Pointer::Move => window_on_point(target, x, y)?,
            }
        }
        input::pointer(x, y, action, &|click| {
            go("pointer")?;
            match &target {
                // A sheet or window that opened during the move would take the click: the first one checks, and the
                // caller once more after that check, which waits on the app.
                Some(target) if click == 1 => {
                    window_takes_point(target, x, y)?;
                    go("pointer")
                }
                _ => Ok(()),
            }
        })
    })
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
        assert!(failure.message.contains("stepped back to 0"), "{}", failure.message);
        assert_eq!(value.get(), 0.0);
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
    fn counts_a_write_the_app_answered_with_anything_but_a_refusal_as_delivered() {
        use super::write_failed;
        use crate::failure::Delivery;
        assert_eq!(write_failed(crate::ax::AX_INVALID_ELEMENT, "set value").delivery, Delivery::Unknown, "a handler replaced the element");
        assert_eq!(write_failed(crate::ax::AX_ATTRIBUTE_UNSUPPORTED, "set value").delivery, Delivery::NotDelivered);
        assert_eq!(write_failed(crate::ax::AX_API_DISABLED, "set value").delivery, Delivery::NotDelivered);
    }

    #[test]
    fn counts_a_failure_after_a_scroll_into_view_as_delivered() {
        use super::after_scroll;
        use crate::failure::{Delivery, Failure, codes};
        let refused = || Err::<(), _>(Failure::refused(codes::ACTION_NOT_SUPPORTED, "no press"));
        assert_eq!(after_scroll(false, refused()).expect_err("refused").delivery, Delivery::NotDelivered);
        assert_eq!(after_scroll(true, refused()).expect_err("refused").delivery, Delivery::Unknown, "the list moved");
        assert!(after_scroll(true, Ok(())).is_ok());
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
        // Ids near the input tests' ids: tests share one registry, and a run 4096 ids past another drops that one's mark.
        let set =
            |id: u32, deadline: Instant| super::CURRENT.with(|current| *current.borrow_mut() = Some((crate::input::TypingRun::start(Some(id)), deadline)));
        crate::input::cancel_input(1_000_031);
        set(1_000_031, later());
        assert!(super::go("press").is_err());
        set(1_000_032, Instant::now());
        assert!(super::go("press").is_err());
        set(1_000_033, later());
        assert!(super::go("press").is_ok());
        super::CURRENT.with(|current| current.borrow_mut().take());
    }

    #[test]
    fn sends_nothing_to_close_a_menu_once_the_caller_cancelled() {
        use super::close_menu_with;
        let sent = Cell::new(0);
        // Cancelled before the cleanup: neither AXCancel nor Escape, and the menu is reported as it is.
        let open = close_menu_with(
            || true,
            || false,
            || {
                sent.set(sent.get() + 1);
                true
            },
            || sent.set(sent.get() + 1),
        );
        assert_eq!((open, sent.get()), (false, 0));
        // Cancelled while the menu was watched after AXCancel: no Escape follows.
        let calls = Cell::new(0);
        let stopped = || {
            calls.set(calls.get() + 1);
            calls.get() > 1
        };
        let escaped = Cell::new(false);
        assert!(!close_menu_with(stopped, || false, || false, || escaped.set(true)));
        assert!(!escaped.get());
        // Not cancelled: a menu that ignored AXCancel gets Escape, and is closed by it.
        let menu_open = Cell::new(true);
        assert!(close_menu_with(|| false, || !menu_open.get(), || false, || menu_open.set(false)));
    }

    #[test]
    fn brings_no_window_forward_once_the_call_was_cancelled() {
        crate::input::cancel_input(1_000_039);
        // No such process: past the guard, the window lookup would answer APP_NOT_FOUND or WINDOW_NOT_FOUND instead.
        let failure = super::focus_window(-1, 1, Some(1_000_039), later()).expect_err("cancelled first");
        assert_eq!((failure.code, failure.delivery), (crate::failure::codes::TIMEOUT, crate::failure::Delivery::NotDelivered));
        let late = super::focus_window(-1, 1, Some(1_000_040), Instant::now()).expect_err("out of time");
        assert_eq!(late.code, crate::failure::codes::TIMEOUT);
    }

    #[test]
    fn stops_scanning_a_list_once_the_caller_cancelled() {
        use super::scan;
        let read = Cell::new(0);
        let outcome = super::guarded(Some(1_000_051), later(), || {
            scan(vec![1, 2, 3], "read the list's rows", 1, |_| {
                read.set(read.get() + 1);
                crate::input::cancel_input(1_000_051);
                Ok(false)
            })
        });
        assert_eq!(outcome.expect_err("cancelled during the scan").code, crate::failure::codes::TIMEOUT);
        assert_eq!(read.get(), 1, "no row read after the cancel");
        // Not cancelled: the first matches up to the limit, and a stall on the way is reported with a miss.
        let found = super::guarded(Some(1_000_052), later(), || scan(vec![1, 2, 3], "scan", 1, |item| Ok(*item >= 2))).expect("scanned");
        assert_eq!(found, (vec![2], false));
        let both = super::guarded(Some(1_000_054), later(), || scan(vec![1, 2, 3, 4], "scan", 2, |item| Ok(*item >= 2))).expect("scanned");
        assert_eq!(both, (vec![2, 3], false), "a second match is found, and the scan stops there");
        let missed = super::guarded(Some(1_000_053), later(), || {
            scan(vec![1, 2], "scan", 1, |item| if *item == 1 { Err(crate::ax::AX_CANNOT_COMPLETE) } else { Ok(false) })
        })
        .expect("scanned");
        assert_eq!(missed, (vec![], true));
    }

    #[test]
    fn refuses_to_uncheck_a_selected_radio_button_before_pressing_it() {
        use super::clears_only_by_another;
        assert!(clears_only_by_another("radiobutton", false, Some(1)));
        assert!(!clears_only_by_another("radiobutton", false, Some(0)), "already clear: nothing to press");
        assert!(!clears_only_by_another("radiobutton", true, Some(0)), "a check selects it");
        assert!(!clears_only_by_another("checkbox", false, Some(1)), "a box unchecks itself");
    }

    #[test]
    fn counts_a_cancel_but_not_a_deadline_as_the_caller_moving_on() {
        assert!(!super::cancelled(), "no action runs");
        let during = |id: u32, deadline: Instant| super::guarded(Some(id), deadline, || Ok(super::cancelled())).expect("the check fails nothing");
        assert!(!during(1_000_037, Instant::now()), "a deadline that passed is no cancel");
        crate::input::cancel_input(1_000_038);
        assert!(during(1_000_038, later()));
    }

    #[test]
    fn sends_no_click_when_the_action_is_cancelled_during_the_hit_test() {
        use super::Aim;
        let outcome = super::guarded(Some(1_000_034), later(), || {
            super::still_aimed(|| {
                crate::input::cancel_input(1_000_034);
                Ok(Aim::Target)
            })
        });
        let failure = outcome.expect_err("cancelled while the hit test waited on the app");
        assert_eq!((failure.code, failure.delivery), (crate::failure::codes::TIMEOUT, crate::failure::Delivery::NotDelivered));
        let missed = super::guarded(Some(1_000_035), later(), || super::still_aimed(|| Ok(Aim::Other))).expect_err("the point hits another element");
        assert_eq!(missed.code, crate::failure::codes::ACTION_FAILED);
        assert!(super::guarded(Some(1_000_036), later(), || super::still_aimed(|| Ok(Aim::Target))).is_ok());
    }

    #[test]
    fn takes_a_control_at_a_point_unless_the_point_is_on_a_node_with_no_click_of_its_own() {
        use super::{Aim, point_lands};
        assert!(point_lands(Ok(Aim::Control), false).is_ok());
        assert!(point_lands(Ok(Aim::Target), true).is_ok());
        let revealed = point_lands(Ok(Aim::Control), true).expect_err("a control came over the node");
        assert_eq!((revealed.code, revealed.delivery), (crate::failure::codes::ACTION_FAILED, crate::failure::Delivery::NotDelivered));
        assert!(point_lands(Ok(Aim::Other), false).is_err());
        assert_eq!(point_lands(Err(crate::ax::AX_CANNOT_COMPLETE), false).expect_err("a stall").code, crate::failure::codes::APP_UNRESPONSIVE);
    }

    #[test]
    fn sends_a_coordinate_click_only_while_its_window_takes_it() {
        use super::{Sheet, takes_point};
        let key = |text: &str| Sheet::Key(text.to_owned());
        assert!(takes_point(true, true, &Sheet::None, &Sheet::None).is_ok());
        // A sheet that held the focus when the point was taken is where the point was taken, by window id or element.
        assert!(takes_point(true, true, &key("7"), &key("7")).is_ok());
        assert!(takes_point(true, true, &key("ax-1f"), &key("ax-1f")).is_ok());
        for (frontmost, holds, now, then) in [
            (false, true, Sheet::None, Sheet::None),
            (true, false, Sheet::None, Sheet::None),
            (true, true, key("7"), Sheet::None),
            (true, true, Sheet::None, key("7")),
            (true, true, key("8"), key("7")),
            (true, true, key("ax-2a"), key("7")),
            // A sheet the caller could name no key for is never known to be the same one.
            (true, true, key("7"), Sheet::Unnamed),
        ] {
            let refused = takes_point(frontmost, holds, &now, &then).expect_err("another window, sheet, or app would take the click");
            assert_eq!((refused.code, refused.delivery), (crate::failure::codes::ACTION_FAILED, crate::failure::Delivery::NotDelivered));
        }
    }

    #[test]
    fn tells_a_stalled_hit_test_and_a_control_inside_the_element_from_a_covering_element() {
        use super::{Aim, aim_along, aimed};
        use crate::failure::codes;
        let walk = |steps: Vec<Result<(bool, &str), crate::ax::AXError>>| {
            let mut steps = steps.into_iter();
            aim_along(move || steps.next().map(|step| step.map(|(target, role)| (target, super::presses(role)))))
        };
        // A row's text cell is content of the row; its inline button is a control of its own.
        assert_eq!(walk(vec![Ok((false, "AXStaticText")), Ok((false, "AXCell")), Ok((true, ""))]), Ok(Aim::Target));
        assert_eq!(walk(vec![Ok((false, "AXStaticText")), Ok((false, "AXButton")), Ok((true, ""))]), Ok(Aim::Control));
        assert_eq!(walk(vec![Ok((false, "AXButton")), Ok((false, "AXWindow"))]), Ok(Aim::Other));
        // An image is decoration unless it offers a press: then it is a button of its own.
        let image = |actions: Result<Vec<String>, crate::ax::AXError>| super::takes_click("AXImage", move || actions);
        assert_eq!(image(Ok(vec!["AXPress".into()])), Ok(true));
        assert_eq!(image(Ok(vec!["AXShowMenu".into()])), Ok(false));
        assert_eq!(image(Err(crate::ax::AX_ACTION_UNSUPPORTED)), Ok(false));
        assert_eq!(image(Err(crate::ax::AX_CANNOT_COMPLETE)), Err(crate::ax::AX_CANNOT_COMPLETE));
        assert_eq!(super::takes_click("AXSeparator", || panic!("no action read for a role that tells")), Ok(false));
        // A text label is content unless the app made it a button of its own.
        assert_eq!(super::takes_click("AXStaticText", || Ok(vec![])), Ok(false));
        assert_eq!(super::takes_click("AXStaticText", || Ok(vec!["AXPress".into()])), Ok(true));
        // A custom control drawn in a group, which offers a press, is a control of its own too.
        assert_eq!(super::takes_click("AXGroup", || Ok(vec!["AXPress".into()])), Ok(true));
        // An open or a confirm takes a click as a press does.
        assert_eq!(super::takes_click("AXGroup", || Ok(vec!["AXOpen".into()])), Ok(true));
        assert_eq!(super::takes_click("AXGroup", || Ok(vec!["AXConfirm".into()])), Ok(true));
        assert_eq!(super::takes_click("AXGroup", || Ok(vec!["AXScrollToVisible".into()])), Ok(false));
        // An inline editor of a row takes a double-click of its own.
        for editor in ["AXTextField", "AXComboBox", "AXTextArea"] {
            assert_eq!(walk(vec![Ok((false, editor)), Ok((false, "AXCell")), Ok((true, ""))]), Ok(Aim::Control), "{editor}");
        }
        assert_eq!(walk(vec![Ok((false, "AXStaticText")), Err(crate::ax::AX_CANNOT_COMPLETE)]), Err(crate::ax::AX_CANNOT_COMPLETE));
        // A click refuses the control, a hover does not; a stall is a retryable stall, not a covering element.
        assert_eq!(aimed(Ok(Aim::Control), true, "after the move").expect_err("the click would press the button").code, codes::ACTION_FAILED);
        assert!(aimed(Ok(Aim::Control), false, "before the move").is_ok());
        let stall = aimed(Err(crate::ax::AX_CANNOT_COMPLETE), true, "after the move").expect_err("the app did not answer");
        assert_eq!((stall.code, stall.delivery), (codes::APP_UNRESPONSIVE, crate::failure::Delivery::NotDelivered));
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
    fn stops_a_stepper_that_wraps_around_its_range() {
        // 0 to 10, and one step up from 10 goes to 0: 11 is never reached.
        let value = Cell::new(10.0);
        let presses = Cell::new(0);
        let wrapped = step_to(
            11.0,
            Some(10.0),
            later(),
            |up| {
                presses.set(presses.get() + 1);
                value.set(if up { if value.get() >= 10.0 { 0.0 } else { value.get() + 1.0 } } else { value.get() - 1.0 });
                Ok(())
            },
            || Some(value.get()),
        );
        assert_eq!(wrapped.expect_err("wraps").delivery, crate::failure::Delivery::Unknown);
        assert_eq!(presses.get(), 1);
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

    #[test]
    fn refuses_a_stepper_target_outside_the_range_it_reports() {
        use super::outside;
        assert!(outside(11.0, Some(0.0), Some(10.0)));
        assert!(outside(-1.0, Some(0.0), Some(10.0)));
        // The bounds themselves are in range.
        assert!(!outside(10.0, Some(0.0), Some(10.0)));
        assert!(!outside(0.0, Some(0.0), Some(10.0)));
        // A bound the stepper does not report limits nothing.
        assert!(!outside(1e9, Some(0.0), None));
        assert!(!outside(-1e9, None, Some(10.0)));
    }

    #[test]
    fn tells_a_large_value_from_the_next_step_after_it() {
        assert!(!super::same(1_800_000_000.0, 1_800_000_001.0, None));
        // Whole numbers past the reach of a relative tolerance (a Unix time in microseconds) still differ by one.
        assert!(!super::same(1_800_000_000_000_000.0, 1_800_000_000_000_001.0, None));
        assert!(super::same(0.1 + 0.1 + 0.1, 0.3, None));
        // A step smaller than the rounding allowance of a large value is still a step, once a press showed its size.
        assert!(super::same(1_800_000_000.0, 1_800_000_000.000_01, None));
        assert!(!super::same(1_800_000_000.0, 1_800_000_000.000_01, Some(0.000_01)));
        let value = Cell::new(1_800_000_000.0);
        let reached = step_to(
            1_800_000_001.0,
            Some(value.get()),
            later(),
            |up| {
                value.set(value.get() + if up { 1.0 } else { -1.0 });
                Ok(())
            },
            || Some(value.get()),
        );
        assert!(reached.unwrap());
        assert_eq!(value.get(), 1_800_000_001.0);
    }

    #[test]
    fn steps_a_large_value_by_a_step_smaller_than_its_rounding_allowance() {
        let small = 0.000_01;
        let value = Cell::new(1_800_000_000.0);
        let target = 1_800_000_000.0 + small;
        let presses = Cell::new(0);
        let reached = step_to(
            target,
            Some(value.get()),
            later(),
            |up| {
                presses.set(presses.get() + 1);
                value.set(value.get() + if up { small } else { -small });
                Ok(())
            },
            || Some(value.get()),
        );
        assert!(reached.unwrap());
        assert_eq!((value.get(), presses.get()), (target, 1));
    }

    #[test]
    fn leaves_a_value_that_differs_from_the_target_only_by_rounding_as_it_was() {
        let summed = 0.1 + 0.1 + 0.1;
        let value = Cell::new(summed);
        let presses = Cell::new(0);
        let reached = step_to(
            0.3,
            Some(value.get()),
            later(),
            |up| {
                presses.set(presses.get() + 1);
                value.set(value.get() + if up { 0.1 } else { -0.1 });
                Ok(())
            },
            || Some(value.get()),
        );
        assert!(reached.unwrap());
        // One step to learn the step's size, one back.
        assert_eq!(presses.get(), 2);
        assert!(super::same(value.get(), summed, Some(0.1)));
        // A stepper already at the exact value gets no press.
        assert!(step_to(0.3, Some(0.3), later(), |_| panic!("no press"), || Some(0.3)).unwrap());
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
