//! Scrolling a list or scroll area by its scroll bar, or by the page actions an element takes.

use super::*;

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
pub(super) fn scroll(element: &Element, direction: &str, pages: f64) -> Outcome<()> {
    let vertical = matches!(direction, "up" | "down");
    // A node that scrolls itself (a scroll bar of its own, or the page action for the direction) is the one moved; one
    // with neither, a list or table, scrolls through the scroll area that holds it. The enclosing pane comes last, so a
    // swipe on a nested list never moves the pane around it.
    let own = scroll_bar(element, vertical).is_some() || action_names(element, "scroll")?.iter().any(|name| name == page_action(direction));
    let target = if own { None } else { enclosing_scroll_area(element, vertical) };
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
pub(super) fn enclosing_scroll_area(element: &Element, vertical: bool) -> Option<Element> {
    let mut current = element.element("AXParent")?;
    for _ in 0..4 {
        if current.text("AXRole").as_deref() == Some("AXScrollArea") && scroll_bar(&current, vertical).is_some() {
            return Some(current);
        }
        current = current.element("AXParent")?;
    }
    None
}

/// How long a scroll area's content is along one axis: the span its contents cover. `AXContents` lists the document
/// view, or, where AppKit leaves that view out, every control in it (a sidebar of buttons); with no `AXContents`, the
/// children but the scroll bars. Zero when none has a frame.
fn content_length(area: &Element, vertical: bool) -> f64 {
    let listed = area.elements("AXContents", 4096).ok().filter(|contents| !contents.is_empty());
    let contents = listed.unwrap_or_else(|| {
        area.elements("AXChildren", 4096).unwrap_or_default().into_iter().filter(|child| child.text("AXRole").as_deref() != Some("AXScrollBar")).collect()
    });
    let spans = contents.iter().filter_map(Element::frame).map(|(x, y, width, height)| if vertical { (y, y + height) } else { (x, x + width) });
    let (start, end) = spans.fold((f64::INFINITY, f64::NEG_INFINITY), |(start, end), (from, to)| (start.min(from), end.max(to)));
    if end > start { end - start } else { 0.0 }
}

/// The accessibility action that scrolls an element a page in `direction`.
fn page_action(direction: &str) -> &'static str {
    match direction {
        "down" => "AXScrollDownByPage",
        "up" => "AXScrollUpByPage",
        "right" => "AXScrollRightByPage",
        _ => "AXScrollLeftByPage",
    }
}

/// About how many of a scroll bar's increments make a page.
pub(super) const LINES_PER_PAGE: f64 = 8.0;

/// Performs a scroll action `count` times. Each goes through the cancel check; a failure after the first follows a
/// scroll that landed.
pub(super) fn repeat(element: &Element, action: &str, count: usize) -> Outcome<()> {
    for sent in 0..count {
        perform(element, action, "scroll").map_err(|failure| if sent == 0 { failure } else { failure.delivered() })?;
    }
    Ok(())
}

pub(super) fn scroll_by(element: &Element, direction: &str, pages: f64) -> Outcome<()> {
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
        let content = content_length(element, vertical);
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
    let action = page_action(direction);
    if names.iter().any(|name| name == action) {
        return repeat(element, action, (pages.round() as usize).max(1));
    }
    Err(Failure::refused(codes::ACTION_NOT_SUPPORTED, format!("nothing here scrolls {direction}")))
}

/// How far a scroll area must move along one axis to show the span `start..end` inside its view `view_start..view_end`:
/// the least that brings the span in, its start first when it is longer than the view. Zero when any of it shows.
pub(super) fn offset_to_show(start: f64, end: f64, view_start: f64, view_end: f64) -> f64 {
    if end > view_start && start < view_end {
        0.0
    } else if start < view_start {
        start - view_start
    } else {
        (end - view_end).min(start - view_start)
    }
}

/// Moves the scroll bar of every scroll area around `element`, nearest first, so the element's frame comes inside each;
/// `Ok(true)` when it moved one. An area whose bar takes no value moves nothing, and the element stays out of view.
pub(super) fn bring_into_view(element: &Element, what: &str) -> Outcome<bool> {
    let mut moved = false;
    // Once one scroll bar moved, the app's content moved: no later failure can say nothing was sent.
    scroll_areas_to(element, what, &mut moved).map_err(|failure| if moved { failure.delivered() } else { failure })?;
    Ok(moved)
}

/// The walk `bring_into_view` makes, setting `moved` once a scroll bar took a new value.
fn scroll_areas_to(element: &Element, what: &str, moved: &mut bool) -> Outcome<()> {
    let mut next = element.element("AXParent");
    for _ in 0..crate::snapshot::MAX_ANCESTORS {
        let Some(area) = next else { break };
        let role = area.text("AXRole");
        if role.as_deref() == Some("AXWindow") {
            break;
        }
        if role.as_deref() == Some("AXScrollArea") {
            for vertical in [true, false] {
                // Read again for each: the move of an inner area, or of the other axis, moved the element.
                let (Some(frame), Some(view)) = (element.frame(), area.frame()) else { continue };
                let span = |(x, y, width, height): (f64, f64, f64, f64)| if vertical { (y, y + height) } else { (x, x + width) };
                let ((start, end), (view_start, view_end)) = (span(frame), span(view));
                let offset = offset_to_show(start, end, view_start, view_end);
                let Some(bar) = scroll_bar(&area, vertical) else { continue };
                let room = content_length(&area, vertical) - (view_end - view_start);
                if offset == 0.0 || room <= 0.0 {
                    continue;
                }
                let current = match bar.attribute("AXValue") {
                    Ok(Value::Number(number)) => number,
                    Err(ax::AX_CANNOT_COMPLETE) => return Err(unread(ax::AX_CANNOT_COMPLETE, what)),
                    _ => continue,
                };
                if !settable(&bar, "AXValue", what)? {
                    continue;
                }
                go(what)?;
                bar.set_number("AXValue", (current + offset / room).clamp(0.0, 1.0)).map_err(|error| write_failed(error, what))?;
                *moved = true;
            }
        }
        next = area.element("AXParent");
    }
    Ok(())
}
