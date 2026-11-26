//! One window's accessibility tree, read into the raw snapshot shape
//! `nodes.ts` projects: a node per element, a ref for every control, and the
//! tree cut where the depth limit, the node budget, or the deadline stops it.

use crate::ax::{self, Element, Value};
use crate::failure::{Failure, Outcome, codes};
use crate::refs::{self, Entry};
use crate::roles;
use crate::windows::{self, Rect};
use serde::Serialize;
use std::time::Instant;

/// The most nodes one snapshot reads; a window with more is read in part (`truncated`).
const MAX_NODES: usize = 8_000;

/// The most children read under one node; the rest are left out, and the node says so.
const MAX_CHILDREN: usize = 1_000;

/// The longest value read, in characters.
const MAX_VALUE_CHARS: usize = 1_000_000;

/// Every attribute one request reads of a node.
const ATTRIBUTES: [&str; 17] = [
    "AXRole",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXValue",
    "AXIdentifier",
    "AXEnabled",
    "AXFocused",
    "AXSelected",
    "AXExpanded",
    "AXPosition",
    "AXSize",
    "AXPlaceholderValue",
    "AXHelp",
    "AXTitleUIElement",
    "AXVerticalScrollBar",
    "AXHorizontalScrollBar",
];

#[derive(Serialize)]
pub struct NativeId {
    kind: &'static str,
    value: String,
}

/// One node of a snapshot, as `nodes.ts` reads it.
#[derive(Serialize)]
pub struct RawNode {
    #[serde(skip_serializing_if = "Option::is_none")]
    ref_id: Option<String>,
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_id: Option<NativeId>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    states: Vec<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    available_actions: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bounds: Option<Rect>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    subtree_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children_count: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<RawNode>,
}

#[derive(Serialize)]
pub struct WindowRef {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

/// A snapshot, as `snapshot` answers.
#[derive(Serialize)]
pub struct RawSnapshot {
    snapshot_id: String,
    /// False when the read missed part of the window: the deadline stopped it, or the app did not answer for an
    /// element that still exists. What it did not reach may be there.
    complete: bool,
    /// True when the node budget stopped the read.
    truncated: bool,
    ref_count: usize,
    tree: RawNode,
    window: WindowRef,
}

/// What a snapshot is asked for.
pub struct Request {
    pub pid: i32,
    pub window: u32,
    pub max_depth: usize,
    /// Keep only controls and the nodes that hold them.
    pub interactive: bool,
    pub deadline: Instant,
}

struct Walk {
    pid: i32,
    window: u32,
    snapshot: String,
    max_depth: usize,
    interactive: bool,
    deadline: Instant,
    focused: Option<Element>,
    nodes: usize,
    complete: bool,
    /// How many reads of an element that still exists failed; a parent whose subtree lost one is truncated.
    lost: usize,
    truncated: bool,
    refs: Vec<(String, Entry)>,
}

/// Whether a failed read leaves a hole: the app did not answer in time (it stalled), so an element that is there was
/// not read. Any other error is the element's own answer (gone, no such value, a SwiftUI element that answers
/// `kAXErrorFailure`), which a read of it again would give too, so it is left out as before.
fn missed(error: ax::AXError) -> bool {
    error == ax::AX_CANNOT_COMPLETE
}

fn label(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

fn cap(text: String) -> String {
    if text.len() <= MAX_VALUE_CHARS { text } else { text.chars().take(MAX_VALUE_CHARS).collect() }
}

/// What a node's attributes say, read in one request.
struct Read {
    role: &'static str,
    ax_role: String,
    subrole: Option<String>,
    title: Option<String>,
    description: Option<String>,
    value: Option<Value>,
    identifier: Option<String>,
    enabled: Option<bool>,
    focused: Option<bool>,
    selected: Option<bool>,
    expanded: Option<bool>,
    bounds: Option<Rect>,
    placeholder: Option<String>,
    help: Option<String>,
    title_element: Option<Element>,
    scrollbar: bool,
}

fn read(element: &Element) -> Result<Read, ax::AXError> {
    let mut values = element.attributes(&ATTRIBUTES)?;
    let mut take = |index: usize| values[index].take();
    let ax_role = take(0).and_then(|value| value.text().map(str::to_owned)).unwrap_or_default();
    let subrole = take(1).and_then(|value| value.text().map(str::to_owned));
    let title = label(take(2).and_then(|value| value.text().map(str::to_owned)));
    let description = label(take(3).and_then(|value| value.text().map(str::to_owned)));
    let value = take(4);
    let identifier = label(take(5).and_then(|value| value.text().map(str::to_owned)));
    let enabled = take(6).and_then(|value| value.boolean());
    let focused = take(7).and_then(|value| value.boolean());
    let selected = take(8).and_then(|value| value.boolean());
    let expanded = take(9).and_then(|value| value.boolean());
    let bounds = match (take(10), take(11)) {
        (Some(Value::Point(x, y)), Some(Value::Size(width, height))) => Some(Rect { x, y, width, height }),
        _ => None,
    };
    let placeholder = label(take(12).and_then(|value| value.text().map(str::to_owned)));
    let help = label(take(13).and_then(|value| value.text().map(str::to_owned)));
    let title_element = take(14).and_then(|value| value.element().cloned());
    let scrollbar = take(15).is_some() || take(16).is_some();
    let role = roles::role(&ax_role, subrole.as_deref());
    Ok(Read {
        role,
        ax_role,
        subrole,
        title,
        description,
        value,
        identifier,
        enabled,
        focused,
        selected,
        expanded,
        bounds,
        placeholder,
        help,
        title_element,
        scrollbar,
    })
}

/// The text of the element that labels another (`AXTitleUIElement`).
fn label_of(element: &Element) -> Option<String> {
    let values = element.attributes(&["AXValue", "AXTitle"]).ok()?;
    values.into_iter().flatten().find_map(|value| label(value.text().map(str::to_owned)))
}

fn parse_toggle(value: Option<&Value>) -> Option<u8> {
    match value? {
        Value::Number(number) => Some(*number as u8),
        Value::Bool(value) => Some(*value as u8),
        Value::Text(text) => match text.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "on" | "checked" => Some(1),
            "0" | "false" | "off" | "unchecked" => Some(0),
            "2" | "mixed" | "indeterminate" => Some(2),
            _ => None,
        },
        _ => None,
    }
}

/// The overlap of two rectangles, empty when they do not meet.
fn intersect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    Rect { x, y, width: (right - x).max(0.0), height: (bottom - y).max(0.0) }
}

/// Whether `inner` lies wholly outside `outer`.
fn outside(inner: Rect, outer: Rect) -> bool {
    // A node with no size has no place to judge: an open menu reports a zero frame while its items have real ones.
    if inner.width <= 0.0 || inner.height <= 0.0 {
        return false;
    }
    outer.width <= 0.0
        || outer.height <= 0.0
        || inner.x + inner.width <= outer.x
        || inner.x >= outer.x + outer.width
        || inner.y + inner.height <= outer.y
        || inner.y >= outer.y + outer.height
}

fn push(actions: &mut Vec<&'static str>, action: &'static str) {
    if !actions.contains(&action) {
        actions.push(action);
    }
}

impl Walk {
    fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    /// Notes a read of an element that still exists and did not answer: the snapshot is no longer complete.
    fn lose(&mut self) {
        self.complete = false;
        self.lost += 1;
    }

    /// The actions a control takes, in the raw vocabulary.
    fn actions(&self, element: &Element, read: &Read) -> Vec<&'static str> {
        let mut out = Vec::new();
        let role = read.role;
        let names = if roles::inert(role) { Vec::new() } else { element.actions().unwrap_or_default() };
        let has = |name: &str| names.iter().any(|candidate| candidate == name);
        if has("AXPress")
            || has("AXOpen")
            || has("AXConfirm")
            || (matches!(role, "row" | "cell" | "treeitem" | "option" | "tab") && element.settable("AXSelected").unwrap_or(false))
        {
            push(&mut out, "Click");
            if roles::toggleable(role) {
                push(&mut out, "Toggle");
            }
        }
        if has("AXShowMenu") && !matches!(role, "window" | "sheet" | "dialog" | "application") {
            push(&mut out, "RightClick");
        }
        if has("AXScrollToVisible") {
            push(&mut out, "ScrollTo");
        }
        if (role == "scrollarea" && read.scrollbar)
            || ["AXScrollDownByPage", "AXScrollUpByPage", "AXScrollLeftByPage", "AXScrollRightByPage"].into_iter().any(&has)
        {
            push(&mut out, "Scroll");
        }
        let value_settable = roles::bears_value(role) && element.settable("AXValue").unwrap_or(false);
        // A stepper steps toward a number only when it shows one.
        let steps = (has("AXIncrement") || has("AXDecrement")) && matches!(read.value, Some(Value::Number(_)));
        if steps || value_settable {
            push(&mut out, "SetValue");
        }
        if (role == "combobox" && (value_settable || read.ax_role == "AXPopUpButton")) || roles::collection(role) {
            push(&mut out, "Select");
        }
        if (roles::interactive(role) || roles::collection(role)) && element.settable("AXFocused").unwrap_or(false) {
            push(&mut out, "SetFocus");
        }
        if roles::takes_text(role) && element.settable("AXSelectedText").unwrap_or(false) {
            push(&mut out, "TypeText");
        }
        if (roles::expandable(role) && element.settable("AXExpanded").unwrap_or(false)) || (has("AXPress") && roles::expandable(role)) {
            push(&mut out, "Expand");
            push(&mut out, "Collapse");
        }
        out
    }

    /// The children of an element, at most `MAX_CHILDREN`, and how many it has.
    fn children(&mut self, element: &Element, role: &str) -> (Vec<Element>, usize) {
        if roles::large(role) {
            let count = match element.count("AXChildren") {
                Ok(count) => count,
                Err(error) => {
                    if missed(error) {
                        self.lose();
                    }
                    0
                }
            };
            let children = if count == 0 {
                Vec::new()
            } else {
                element.elements("AXChildren", MAX_CHILDREN).unwrap_or_else(|error| {
                    if missed(error) {
                        self.lose();
                    }
                    Vec::new()
                })
            };
            return (children, count);
        }
        let children = match element.attribute("AXChildren") {
            Ok(Value::Array(items)) => {
                items.into_iter().filter_map(|item| if let Value::Element(element) = item { Some(element) } else { None }).collect::<Vec<_>>()
            }
            Err(error) if missed(error) => {
                self.lose();
                Vec::new()
            }
            _ => Vec::new(),
        };
        let count = children.len();
        (children.into_iter().take(MAX_CHILDREN).collect(), count)
    }

    /// Reads one node and the levels under it. `None` for a node an interactive read leaves out, or one that is gone.
    /// `clip` is the part of the screen the node can show in: the window, cut by every scroll area above it.
    fn node(&mut self, element: &Element, level: usize, root: bool, clip: Option<Rect>) -> Option<RawNode> {
        if self.nodes >= MAX_NODES {
            self.truncated = true;
            return None;
        }
        self.nodes += 1;
        let read = match read(element) {
            Ok(read) => read,
            // Still there, but the app did not answer: the read has a hole.
            Err(error) if !root && missed(error) => {
                self.lose();
                return None;
            }
            // Gone since its parent listed it, or an element that refuses reads: nothing a later read would find.
            Err(_) if !root => return None,
            Err(_) => Read {
                role: "window",
                ax_role: "AXWindow".into(),
                subrole: None,
                title: None,
                description: None,
                value: None,
                identifier: None,
                enabled: None,
                focused: None,
                selected: None,
                expanded: None,
                bounds: None,
                placeholder: None,
                help: None,
                title_element: None,
                scrollbar: false,
            },
        };
        let role = if root && read.role == "unknown" { "window" } else { read.role };
        let secure = read.subrole.as_deref() == Some("AXSecureTextField") || read.ax_role == "AXSecureTextField";
        let actions = self.actions(element, &read);

        let labelled = read.title_element.as_ref().and_then(label_of);
        let text_value = if secure { None } else { read.value.as_ref().and_then(Value::display).map(cap) };
        let name = read
            .title
            .clone()
            .or(labelled)
            .or_else(|| read.description.clone())
            .or_else(|| roles::window_control_name(read.subrole.as_deref()).map(str::to_owned))
            .or_else(|| if roles::text(role) { label(text_value.clone()) } else { None })
            .or_else(|| if roles::takes_text(role) { read.placeholder.clone() } else { None });
        let description = read.description.clone().filter(|description| Some(description) != name.as_ref());

        let mut states = Vec::new();
        // The app's focused element is the one source: a table's cells report the table's focus as their own.
        let focused = match &self.focused {
            Some(focused) => focused == element,
            None => read.focused == Some(true),
        };
        if focused {
            states.push("focused");
        }
        if read.enabled == Some(false) {
            states.push("disabled");
        }
        if secure {
            states.push("secure");
        }
        if read.expanded == Some(true) {
            states.push("expanded");
        }
        let toggle = parse_toggle(read.value.as_ref());
        if roles::toggleable(role) {
            match toggle {
                Some(1) => states.push("checked"),
                Some(2) => states.push("indeterminate"),
                _ => {}
            }
        }
        if read.selected == Some(true) {
            states.push("selected");
        }
        if role == "button" && toggle == Some(1) && read.subrole.as_deref() == Some("AXToggleButton") {
            states.push("pressed");
        }
        if matches!(role, "textfield" | "combobox") && !actions.contains(&"SetValue") {
            states.push("readonly");
        }
        if let (false, Some(bounds), Some(clip)) = (root, read.bounds, clip)
            && outside(bounds, clip)
        {
            states.push("offscreen");
        }

        let ref_id = if !root
            && (roles::interactive(role)
                || actions.iter().any(|action| matches!(*action, "Click" | "SetValue" | "Select" | "Scroll" | "RightClick" | "TypeText" | "Expand")))
        {
            let reference = format!("@{}:e{}", self.snapshot, self.refs.len() + 1);
            self.refs.push((reference.clone(), Entry { element: element.clone(), pid: self.pid, window: self.window }));
            Some(reference)
        } else {
            None
        };

        let mut node = RawNode {
            ref_id,
            role,
            name,
            value: text_value,
            description,
            hint: read.help.clone(),
            placeholder: read.placeholder.clone(),
            native_id: read.identifier.clone().map(|value| NativeId { kind: "ax_identifier", value }),
            states,
            available_actions: actions,
            bounds: read.bounds,
            subtree_truncated: false,
            children_count: None,
            children: Vec::new(),
        };

        // What a scroll area shows is its own frame: its children outside it are scrolled out of view.
        let inner = match (role, read.bounds) {
            ("scrollarea", Some(bounds)) => clip.map(|clip| intersect(clip, bounds)).or(Some(bounds)),
            // An open menu floats above the window, so its items are not cut by the window's frame.
            ("menu", _) => None,
            _ => clip,
        };
        if role == "scrollbar" {
            // A scroll bar's arrows and page areas are its parts, not controls of their own.
        } else if level >= self.max_depth {
            let count = match element.count("AXChildren") {
                Ok(count) => count,
                Err(error) => {
                    // A stalled count could hide children past the depth limit: the read has a hole.
                    if missed(error) {
                        self.lose();
                        node.subtree_truncated = true;
                    }
                    0
                }
            };
            if count > 0 {
                node.children_count = Some(count);
            }
        } else if self.expired() {
            self.complete = false;
            node.subtree_truncated = element.count("AXChildren").unwrap_or(0) > 0;
        } else {
            let lost = self.lost;
            let (children, count) = self.children(element, role);
            if count > children.len() {
                node.subtree_truncated = true;
            }
            for child in &children {
                if self.expired() {
                    self.complete = false;
                    node.subtree_truncated = true;
                    break;
                }
                if self.nodes >= MAX_NODES {
                    self.truncated = true;
                    node.subtree_truncated = true;
                    break;
                }
                if let Some(child) = self.node(child, level + 1, false, inner) {
                    node.children.push(child);
                }
            }
            if self.lost > lost {
                node.subtree_truncated = true;
            }
        }

        if self.interactive
            && !root
            && node.ref_id.is_none()
            && node.children.is_empty()
            && !node.subtree_truncated
            && node.children_count.is_none()
            && !node.states.contains(&"secure")
        {
            return None;
        }
        Some(node)
    }
}

/// Reads one window of a process.
pub fn snapshot(request: Request) -> Outcome<RawSnapshot> {
    let window = windows::find(request.pid, request.window)?;
    let app = Element::application(request.pid);
    let focused = app.element("AXFocusedUIElement");
    let window_bounds = window.frame().map(|(x, y, width, height)| Rect { x, y, width, height });
    let title = window.text("AXTitle");
    let mut walk = Walk {
        pid: request.pid,
        window: request.window,
        snapshot: refs::snapshot_id(),
        max_depth: request.max_depth.max(1),
        interactive: request.interactive,
        deadline: request.deadline,
        focused,
        nodes: 0,
        complete: true,
        lost: 0,
        truncated: false,
        refs: Vec::new(),
    };
    // The window must answer: one that does not is gone, or its app is.
    match window.attribute("AXRole") {
        Ok(_) => {}
        Err(ax::AX_INVALID_ELEMENT) => return Err(Failure::refused(codes::WINDOW_NOT_FOUND, format!("window {} closed", request.window))),
        Err(ax::AX_CANNOT_COMPLETE) => {
            return Err(Failure::refused(codes::APP_UNRESPONSIVE, "the app did not answer in time").with_details(serde_json::json!({ "retryable": true })));
        }
        Err(_) => {}
    }
    let tree = walk
        .node(&window, 1, true, window_bounds)
        .ok_or_else(|| Failure::refused(codes::WINDOW_NOT_FOUND, format!("window {} could not be read", request.window)))?;
    let ref_count = walk.refs.len();
    refs::insert_all(std::mem::take(&mut walk.refs));
    Ok(RawSnapshot {
        snapshot_id: walk.snapshot,
        complete: walk.complete,
        truncated: walk.truncated,
        ref_count,
        tree,
        window: WindowRef { id: request.window.to_string(), title },
    })
}

#[cfg(test)]
mod tests {
    use super::{missed, outside};
    use crate::ax;
    use crate::windows::Rect;

    const WINDOW: Rect = Rect { x: 0.0, y: 0.0, width: 800.0, height: 600.0 };

    #[test]
    fn reads_a_node_past_the_clip_as_outside() {
        assert!(outside(Rect { x: 0.0, y: 700.0, width: 100.0, height: 20.0 }, WINDOW));
        assert!(!outside(Rect { x: 10.0, y: 10.0, width: 100.0, height: 20.0 }, WINDOW));
    }

    #[test]
    fn counts_only_a_stall_as_a_hole_in_the_read() {
        assert!(missed(ax::AX_CANNOT_COMPLETE));
        for error in [ax::AX_INVALID_ELEMENT, ax::AX_NO_VALUE, ax::AX_ATTRIBUTE_UNSUPPORTED, ax::AX_FAILURE, ax::AX_NOT_IMPLEMENTED] {
            assert!(!missed(error), "{error}");
        }
    }

    #[test]
    fn never_reads_a_zero_size_node_as_outside() {
        // An open context menu on macOS 27: its `AXMenu` is 0x0 at the screen's corner, its items are in the window.
        assert!(!outside(Rect { x: 0.0, y: 1080.0, width: 0.0, height: 0.0 }, WINDOW));
    }
}
