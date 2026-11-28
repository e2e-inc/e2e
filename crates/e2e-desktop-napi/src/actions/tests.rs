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
    assert!(failure.message.contains("stepped back to where it started"), "{}", failure.message);
    assert!(!failure.message.contains('3'), "names no value: {}", failure.message);
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
    let set = |id: u32, deadline: Instant| super::CURRENT.with(|current| *current.borrow_mut() = Some((crate::input::TypingRun::start(Some(id)), deadline)));
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
    assert!(answer(AX_ATTRIBUTE_UNSUPPORTED, Some(AX_INVALID_ELEMENT)).is_ok(), "a SwiftUI alert's button, gone after the press");
    for unread in [AX_CANNOT_COMPLETE, AX_FAILURE] {
        let busy = answer(AX_ATTRIBUTE_UNSUPPORTED, Some(unread)).expect_err("unread after: no proof the element stayed");
        assert_eq!(busy.delivery, Delivery::Unknown);
    }
    assert_eq!(answer(AX_ACTION_UNSUPPORTED, Some(AX_INVALID_ELEMENT)).expect_err("no such action").delivery, Delivery::NotDelivered);
    assert!(answer(AX_CANNOT_COMPLETE, None).is_ok(), "a modal runs in the press's handler");
    let stalled = answer(AX_CANNOT_COMPLETE, Some(AX_CANNOT_COMPLETE)).expect_err("no answer after");
    assert_eq!((stalled.code, stalled.delivery), (codes::APP_UNRESPONSIVE, Delivery::Unknown));
    let failed = answer(AX_FAILURE, None).expect_err("still there");
    assert_eq!((failed.code, failed.delivery), (codes::ACTION_FAILED, Delivery::Unknown));
    let gone = answer(AX_INVALID_ELEMENT, None).expect_err("went away as it was sent");
    assert_eq!(gone.delivery, Delivery::Unknown);
}

#[test]
fn stops_watching_for_a_gone_element_in_time_to_answer() {
    use super::{ANSWER_MARGIN, GONE_WAIT, gone_wait_end};
    let now = Instant::now();
    assert_eq!(gone_wait_end(now, None), now + GONE_WAIT);
    assert_eq!(gone_wait_end(now, Some(now + Duration::from_secs(5))), now + GONE_WAIT);
    let soon = now + ANSWER_MARGIN + Duration::from_millis(40);
    assert_eq!(gone_wait_end(now, Some(soon)), now + Duration::from_millis(40));
}

#[test]
fn fails_a_stepper_value_read_that_stalled_or_went_away_before_any_step() {
    use super::shown_number;
    use crate::ax::{AX_CANNOT_COMPLETE, AX_FAILURE, AX_INVALID_ELEMENT, Value};
    use crate::failure::{Delivery, codes};
    assert_eq!(shown_number::<crate::ax::Element>(Ok(Value::Number(4.0)), "set value").unwrap(), Some(4.0));
    assert_eq!(shown_number::<crate::ax::Element>(Ok(Value::Text("four".into())), "set value").unwrap(), None);
    assert_eq!(shown_number::<crate::ax::Element>(Err(AX_FAILURE), "set value").unwrap(), None);
    let stall = shown_number::<crate::ax::Element>(Err(AX_CANNOT_COMPLETE), "set value").expect_err("a stall");
    assert_eq!((stall.code, stall.delivery), (codes::APP_UNRESPONSIVE, Delivery::NotDelivered));
    let gone = shown_number::<crate::ax::Element>(Err(AX_INVALID_ELEMENT), "set value").expect_err("gone");
    assert_eq!((gone.code, gone.delivery), (codes::STALE_REF, Delivery::NotDelivered));
}

#[test]
fn reads_a_stall_as_one_and_any_other_failure_as_no_answer() {
    use super::stalled;
    use crate::ax::{AX_CANNOT_COMPLETE, AX_FAILURE, AX_INVALID_ELEMENT, AX_NO_VALUE};
    assert_eq!(stalled(Ok(3)), Ok(Some(3)));
    assert_eq!(stalled::<i32>(Err(AX_CANNOT_COMPLETE)), Err(AX_CANNOT_COMPLETE));
    for none in [AX_FAILURE, AX_INVALID_ELEMENT, AX_NO_VALUE] {
        assert_eq!(stalled::<i32>(Err(none)), Ok(None), "{none}");
    }
    // The stall reaches the engine as one it may retry.
    let failure = super::unread(AX_CANNOT_COMPLETE, "type");
    assert_eq!((failure.code, failure.delivery), (crate::failure::codes::APP_UNRESPONSIVE, crate::failure::Delivery::NotDelivered));
    assert_eq!(failure.details, Some(serde_json::json!({ "retryable": true })));
}

#[test]
fn names_no_value_in_any_stepper_failure() {
    let digitless = |failure: crate::failure::Failure| {
        assert!(!failure.message.chars().any(|c| c.is_ascii_digit()), "names a value: {}", failure.message);
    };
    // Wraps: one step up from 42 goes to 0.
    let value = Cell::new(42.0);
    digitless(
        step_to(
            43.0,
            Some(42.0),
            later(),
            |_| {
                value.set(0.0);
                Ok(())
            },
            || Some(value.get()),
        )
        .expect_err("wraps"),
    );
    // Steps past and back: 40, 42, 44 past 43, then back to 40.
    let value = Cell::new(40.0);
    digitless(
        step_to(
            43.0,
            Some(40.0),
            later(),
            |up| {
                value.set(value.get() + if up { 2.0 } else { -2.0 });
                Ok(())
            },
            || Some(value.get()),
        )
        .expect_err("past"),
    );
    // Steps past and cannot go back.
    let value = Cell::new(40.0);
    digitless(
        step_to(
            43.0,
            Some(40.0),
            later(),
            |up| {
                if up {
                    value.set(value.get() + 2.0)
                }
                Ok(())
            },
            || Some(value.get()),
        )
        .expect_err("stuck past"),
    );
    // Already showed the target up to rounding, and the step to tell it left it changed.
    let summed = 0.1 + 0.1 + 0.1;
    let value = Cell::new(summed);
    digitless(
        step_to(
            0.3,
            Some(summed),
            later(),
            |up| {
                if !up {
                    value.set(value.get() - 0.1)
                }
                Ok(())
            },
            || Some(value.get()),
        )
        .expect_err("left changed"),
    );
    // Out of time before the first step.
    digitless(step_to(43.0, Some(40.0), Instant::now(), |_| Ok(()), || Some(40.0)).expect_err("no time"));
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

#[test]
fn lets_a_scroll_area_scroll_itself_only_with_a_scroll_bar_for_the_axis() {
    let pages = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
    let swiftui = pages(&["AXScrollDownByPage", "AXScrollUpByPage", "AXScrollLeftByPage", "AXScrollRightByPage"]);
    // A SwiftUI scroll area offers every page action: only its scroll bar for the axis says it scrolls along it.
    assert!(!super::scroll::scrolls_itself("scrollarea", false, &swiftui, "down"));
    assert!(super::scroll::scrolls_itself("scrollarea", true, &swiftui, "down"));
    assert!(super::scroll::scrolls_itself("scrollarea", true, &[], "left"));
    // Any other role scrolls itself by the page action for the direction.
    assert!(super::scroll::scrolls_itself("list", false, &pages(&["AXScrollDownByPage"]), "down"));
    assert!(!super::scroll::scrolls_itself("list", false, &pages(&["AXScrollDownByPage"]), "right"));
    assert!(!super::scroll::scrolls_itself("list", false, &[], "up"));
}

#[test]
fn confirms_no_secure_fill_by_a_field_that_went_away_or_did_not_answer() {
    use crate::ax::{AX_ATTRIBUTE_UNSUPPORTED, AX_CANNOT_COMPLETE, AX_INVALID_ELEMENT, Value};
    assert_eq!(super::secure_count(Ok(Value::<crate::ax::Element>::Number(8.0))), Ok(Some(8)));
    // A field that counts none is taken at the write's word.
    assert_eq!(super::secure_count::<crate::ax::Element>(Err(AX_ATTRIBUTE_UNSUPPORTED)), Ok(None));
    assert_eq!(super::secure_count::<crate::ax::Element>(Err(AX_CANNOT_COMPLETE)), Err(()));
    assert_eq!(super::secure_count::<crate::ax::Element>(Err(AX_INVALID_ELEMENT)), Err(()));
}

/// A node of a fake accessibility tree, for the text gathering that names a row.
#[derive(Clone)]
struct Fake {
    role: &'static str,
    label: Option<&'static str>,
    children: Vec<Fake>,
}

fn fake(role: &'static str, label: Option<&'static str>, children: Vec<Fake>) -> Fake {
    Fake { role, label, children }
}

fn gathered(row: &Fake) -> Option<String> {
    let mut texts = Vec::new();
    super::gather_texts(row, 0, &mut texts, &|node: &Fake| Ok(node.children.clone()), &|node: &Fake| Ok(node.role), &|node: &Fake| {
        Ok(node.label.map(str::to_owned))
    })
    .expect("read");
    crate::snapshot::content_name(&texts)
}

#[test]
fn names_a_row_from_the_texts_under_its_texts_as_the_snapshot_does() {
    // An untitled heading over "Paid": the snapshot walks into it, and so does the row's name.
    let row = fake("row", None, vec![fake("statictext", Some("Invoice"), vec![]), fake("heading", None, vec![fake("statictext", Some("Paid"), vec![])])]);
    assert_eq!(gathered(&row).as_deref(), Some("Invoice Paid"));
    // A titled text comes after the texts inside it, in the snapshot's order.
    let titled = fake("row", None, vec![fake("heading", Some("Total"), vec![fake("statictext", Some("42"), vec![])])]);
    assert_eq!(gathered(&titled).as_deref(), Some("42 Total"));
    // A scroll bar's parts are not read.
    let scrolled = fake("row", None, vec![fake("statictext", Some("Notes"), vec![]), fake("scrollbar", None, vec![fake("statictext", Some("50%"), vec![])])]);
    assert_eq!(gathered(&scrolled).as_deref(), Some("Notes"));
}

/// The actions' rules over a fake tree, where a live app would be needed.
mod fake_tree {
    use super::super::{check, enabled, perform, role_of, select_all, select_row};
    use crate::ax::{self, Value};
    use crate::failure::{Delivery, codes};
    use crate::fake::Fake;
    use crate::snapshot::{Placement, placement};
    use std::time::{Duration, Instant};

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(5)
    }

    fn row(label: &str) -> Fake {
        Fake::new("AXRow").children(vec![Fake::new("AXCell").children(vec![Fake::new("AXStaticText").text("AXValue", label)])])
    }

    fn list(rows: Vec<Fake>) -> Fake {
        Fake::new("AXTable").children(rows.clone()).with("AXRows", Value::Array(rows.into_iter().map(Value::Element).collect()))
    }

    #[test]
    fn refuses_to_select_one_of_two_rows_that_show_the_label() {
        let (first, second) = (row("Invoice"), row("Invoice"));
        let table = list(vec![row("Paid"), first.clone(), second.clone()]).settable("AXSelectedRows", Ok(true));
        let failure = select_row(&table, "Invoice", soon()).expect_err("two rows show the label");
        assert_eq!((failure.code, failure.delivery), (codes::ACTION_FAILED, Delivery::NotDelivered));
        assert!(table.sent().is_empty() && first.sent().is_empty() && second.sent().is_empty(), "nothing was selected");
    }

    #[test]
    fn selects_the_one_row_that_shows_the_label_through_the_list() {
        let wanted = row("Invoice").settable("AXSelected", Ok(true));
        let table = list(vec![row("Paid"), wanted.clone()]).settable("AXSelectedRows", Ok(true));
        // The table selects it: the fake row shows it selected once the table's selection names it.
        wanted.set("AXSelected", Ok(Value::Bool(true)));
        select_row(&table, "Invoice", soon()).unwrap_or_else(|failure| panic!("{}", failure.message));
        assert_eq!(table.sent(), ["set AXSelectedRows"]);
        assert!(wanted.sent().is_empty());

        // A list that takes no selection of its rows selects the row itself.
        let wanted = row("Invoice").settable("AXSelected", Ok(true));
        let table = list(vec![wanted.clone()]);
        select_row(&table, "Invoice", soon()).unwrap_or_else(|failure| panic!("{}", failure.message));
        assert_eq!(wanted.sent(), ["set AXSelected"]);
    }

    #[test]
    fn refuses_a_row_it_cannot_find_or_whose_label_the_app_did_not_answer() {
        let missing = select_row(&list(vec![row("Paid")]), "Invoice", soon()).expect_err("no such row");
        assert_eq!(missing.code, codes::ELEMENT_NOT_FOUND);
        // A row the app did not answer for may show the label: one match is no proof it is the only one.
        let stalled = Fake::new("AXRow").batch_failing(ax::AX_CANNOT_COMPLETE);
        let failure = select_row(&list(vec![row("Invoice"), stalled]), "Invoice", soon()).expect_err("a row went unread");
        assert_eq!(failure.code, codes::APP_UNRESPONSIVE);
        // A list with no `AXRows` lists its rows as children.
        let wanted = row("Invoice").settable("AXSelected", Ok(true));
        select_row(&Fake::new("AXList").children(vec![wanted.clone()]), "Invoice", soon()).unwrap_or_else(|failure| panic!("{}", failure.message));
        assert_eq!(wanted.sent(), ["set AXSelected"]);
    }

    #[test]
    fn counts_a_press_whose_element_went_away_a_moment_later_as_landed() {
        // An alert's button answers its press with an error, and stays readable for a moment after the alert closed.
        let button = Fake::new("AXButton").performing("AXPress", ax::AX_FAILURE);
        button.gone_after(4);
        perform(&button, "AXPress", "click").unwrap_or_else(|failure| panic!("{}", failure.message));
        // One that stays is delivered, unverified.
        let stays = Fake::new("AXButton").performing("AXPress", ax::AX_FAILURE);
        let failure = perform(&stays, "AXPress", "click").expect_err("no sign it landed");
        assert_eq!(failure.delivery, Delivery::Unknown);
        // Refused outright: nothing reached the app.
        let refused = Fake::new("AXButton").performing("AXPress", ax::AX_ACTION_UNSUPPORTED);
        assert_eq!(perform(&refused, "AXPress", "click").expect_err("refused").delivery, Delivery::NotDelivered);
    }

    #[test]
    fn reads_a_stalled_role_as_a_stall_and_a_gone_element_as_stale() {
        assert_eq!(role_of(&Fake::new("AXButton").batch_failing(ax::AX_CANNOT_COMPLETE), "click").expect_err("a stall").code, codes::APP_UNRESPONSIVE);
        assert_eq!(role_of(&Fake::new("AXButton").batch_failing(ax::AX_INVALID_ELEMENT), "click").expect_err("gone").code, codes::STALE_REF);
        assert_eq!(role_of(&Fake::new("AXButton").batch_failing(ax::AX_FAILURE), "click").expect("no role").1, "unknown");
    }

    #[test]
    fn refuses_to_check_a_control_with_no_state_it_can_read() {
        // A toggle button reports a value as a box does, but a press on it runs its handler.
        let button = Fake::new("AXButton").actions(&["AXPress"]).with("AXValue", Value::Number(0.0));
        assert_eq!(check(&button, true, soon()).expect_err("no checked state").code, codes::ACTION_NOT_SUPPORTED);
        // A box whose value says no state may already show the one asked for: a press could undo it.
        let unread = Fake::new("AXCheckBox").text("AXValue", "maybe");
        assert_eq!(check(&unread, true, soon()).expect_err("no state").code, codes::ACTION_NOT_SUPPORTED);
        assert!(button.sent().is_empty() && unread.sent().is_empty());
        // A box that already shows the state is left alone.
        let checked = Fake::new("AXCheckBox").with("AXValue", Value::Number(1.0));
        check(&checked, true, soon()).unwrap_or_else(|failure| panic!("{}", failure.message));
        assert!(checked.sent().is_empty());
    }

    #[test]
    fn refuses_a_disabled_control_once_its_wait_runs_out() {
        let disabled = Fake::new("AXButton").with("AXEnabled", Value::Bool(false));
        let failure = enabled(&disabled, Instant::now() + Duration::from_millis(250), "click").expect_err("disabled");
        assert_eq!((failure.code, failure.delivery), (codes::ACTION_FAILED, Delivery::NotDelivered));
        enabled(&Fake::new("AXButton"), soon(), "click").unwrap_or_else(|failure| panic!("{}", failure.message));
        let stalled = Fake::new("AXButton").failing("AXEnabled", ax::AX_CANNOT_COMPLETE);
        assert_eq!(enabled(&stalled, soon(), "click").expect_err("a stall").code, codes::APP_UNRESPONSIVE);
    }

    #[test]
    fn refuses_select_all_on_a_field_whose_length_it_cannot_read() {
        let field = Fake::new("AXTextField").settable("AXSelectedTextRange", Ok(true));
        assert_eq!(select_all(&field, soon()).expect_err("no length").code, codes::ACTION_NOT_SUPPORTED);
        assert!(field.sent().is_empty());
        let stalled = Fake::new("AXTextField").settable("AXSelectedTextRange", Ok(true)).failing("AXNumberOfCharacters", ax::AX_CANNOT_COMPLETE);
        assert_eq!(select_all(&stalled, soon()).expect_err("a stall").code, codes::APP_UNRESPONSIVE);
        let typed = Fake::new("AXTextField").settable("AXSelectedTextRange", Ok(true)).text("AXValue", "héllo");
        select_all(&typed, soon()).unwrap_or_else(|failure| panic!("{}", failure.message));
        assert_eq!(typed.sent(), ["set AXSelectedTextRange"]);
    }

    #[test]
    fn places_an_element_by_its_window_and_every_scroll_area_it_is_in() {
        let window = |child: Fake| Fake::new("AXWindow").frame(0.0, 0.0, 800.0, 600.0).children(vec![child]);
        let inside = |child: Fake| Fake::new("AXScrollArea").frame(0.0, 0.0, 400.0, 300.0).children(vec![child]);
        let shown = Fake::new("AXButton").frame(10.0, 10.0, 80.0, 20.0);
        let _held = window(inside(shown.clone()));
        assert_eq!(placement(&shown), Ok(Placement::Shown));
        // Below the scroll area, though inside the window.
        let below = Fake::new("AXButton").frame(10.0, 400.0, 80.0, 20.0);
        let _held = window(inside(below.clone()));
        assert_eq!(placement(&below), Ok(Placement::ScrolledOut));
        // An open menu floats above the window: its items are not cut by the window's frame.
        let item = Fake::new("AXMenuItem").frame(10.0, 700.0, 80.0, 20.0);
        let _held = window(Fake::new("AXMenu").frame(0.0, 0.0, 0.0, 0.0).children(vec![item.clone()]));
        assert_eq!(placement(&item), Ok(Placement::Shown));
        let minimized = Fake::new("AXButton").frame(10.0, 10.0, 80.0, 20.0);
        let _held = window(minimized.clone()).with("AXMinimized", Value::Bool(true));
        assert_eq!(placement(&minimized), Ok(Placement::Minimized));
        // A control with no size and nothing in it draws nothing; one whose count stalls may hold something.
        let collapsed = Fake::new("AXButton").frame(10.0, 10.0, 0.0, 20.0);
        assert_eq!(placement(&collapsed), Ok(Placement::Collapsed));
        let counted = Fake::new("AXGroup").frame(10.0, 10.0, 0.0, 20.0).counting("AXChildren", Err(ax::AX_CANNOT_COMPLETE));
        assert_eq!(placement(&counted), Err(ax::AX_CANNOT_COMPLETE));
        // A parent that went away: a gone element shows nowhere.
        let orphan = Fake::new("AXButton").frame(10.0, 10.0, 80.0, 20.0);
        let _held = Fake::new("AXGroup").gone(ax::AX_INVALID_ELEMENT).children(vec![orphan.clone()]);
        assert_eq!(placement(&orphan), Err(ax::AX_INVALID_ELEMENT));
    }
}
