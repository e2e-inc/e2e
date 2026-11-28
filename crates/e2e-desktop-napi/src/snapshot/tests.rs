use super::{content_name, expanded, inner_clip, level_of, missed, outside, selected};
use crate::ax;
use crate::windows::Rect;

#[test]
fn names_a_row_from_the_text_inside_it() {
    let texts = |items: &[&str]| items.iter().map(|text| (*text).to_owned()).collect::<Vec<_>>();
    assert_eq!(content_name(&texts(&["Item 1"])).as_deref(), Some("Item 1"));
    assert_eq!(content_name(&texts(&["Invoice 42", " ", "Paid "])).as_deref(), Some("Invoice 42 Paid"));
    assert_eq!(content_name(&texts(&[])), None);
    assert_eq!(content_name(&texts(&["  "])), None);
}

const WINDOW: Rect = Rect { x: 0.0, y: 0.0, width: 800.0, height: 600.0 };

#[test]
fn reads_a_heading_level_only_from_a_whole_number_from_one() {
    type Value = ax::Value<ax::Element>;
    assert_eq!(level_of(Some(Value::Number(2.0))), Some(2));
    for value in [Some(Value::Number(0.0)), Some(Value::Number(1.5)), Some(Value::Number(-1.0)), Some(Value::Bool(true)), None] {
        assert_eq!(level_of(value), None);
    }
}

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
fn reads_a_disclosure_triangle_by_its_value_and_no_menu_item_as_selected() {
    assert!(expanded("disclosure", None, Some(1)));
    assert!(!expanded("disclosure", None, Some(0)));
    assert!(!expanded("checkbox", None, Some(1)));
    assert!(expanded("treeitem", Some(true), None));
    assert!(!selected("menuitem", Some(true), None));
    assert!(selected("row", Some(true), None));
    // An AppKit tab is the active one by its value, and no other role is selected by it.
    assert!(selected("tab", None, Some(1)));
    assert!(!selected("tab", None, Some(0)));
    assert!(!selected("radiobutton", None, Some(1)));
}

#[test]
fn leaves_a_popover_or_menu_past_the_window_unclipped() {
    // A SwiftUI popover hangs off its window: its text sits above the window's top edge.
    let above = Rect { x: 10.0, y: -37.0, width: 100.0, height: 20.0 };
    assert!(outside(above, inner_clip("group", None, Some(WINDOW)).expect("the window's clip")));
    assert_eq!(inner_clip("popover", None, Some(WINDOW)), None);
    assert_eq!(inner_clip("menu", None, Some(WINDOW)), None);
}

#[test]
fn reads_a_box_state_from_a_number_a_boolean_or_a_word() {
    use super::parse_toggle;
    type Value = crate::ax::Value<crate::ax::Element>;
    assert_eq!(parse_toggle(Some(&Value::Text("on".into()))), Some(1));
    assert_eq!(parse_toggle(Some(&Value::Text("off".into()))), Some(0));
    assert_eq!(parse_toggle(Some(&Value::Text("mixed".into()))), Some(2));
    assert_eq!(parse_toggle(Some(&Value::Number(1.0))), Some(1));
    assert_eq!(parse_toggle(Some(&Value::Bool(false))), Some(0));
    assert_eq!(parse_toggle(Some(&Value::Text("maybe".into()))), None);
}

#[test]
fn never_reads_a_zero_size_node_as_outside() {
    // An open context menu on macOS 27: its `AXMenu` is 0x0 at the screen's corner, its items are in the window.
    assert!(!outside(Rect { x: 0.0, y: 1080.0, width: 0.0, height: 0.0 }, WINDOW));
}

mod walk {
    use super::super::{RawNode, Settings, Tree, read_tree};
    use crate::ax::{self, Value};
    use crate::failure::{Outcome, codes};
    use crate::fake::Fake;
    use std::time::{Duration, Instant};

    fn read(window: &Fake, app: &Fake, max_depth: usize, interactive: bool, deadline: Instant) -> Outcome<Tree<Fake>> {
        read_tree(window, app, Settings { snapshot: "s".into(), window: 7, max_depth, interactive, deadline })
    }

    /// The whole window read, as a snapshot reads it by default.
    fn whole(window: &Fake) -> Tree<Fake> {
        read(window, &Fake::default(), 30, false, Instant::now() + Duration::from_secs(60)).unwrap_or_else(|failure| panic!("{}", failure.message))
    }

    fn window(children: Vec<Fake>) -> Fake {
        Fake::new("AXWindow").frame(0.0, 0.0, 800.0, 600.0).children(children)
    }

    /// Every node of a tree, depth first.
    fn nodes(node: &RawNode) -> Vec<&RawNode> {
        let mut all = vec![node];
        for child in &node.children {
            all.extend(nodes(child));
        }
        all
    }

    fn named<'a>(tree: &'a Tree<Fake>, name: &str) -> &'a RawNode {
        nodes(&tree.tree).into_iter().find(|node| node.name.as_deref() == Some(name)).unwrap_or_else(|| panic!("no node {name}"))
    }

    fn has(tree: &Tree<Fake>, name: &str) -> bool {
        nodes(&tree.tree).into_iter().any(|node| node.name.as_deref() == Some(name))
    }

    fn button(title: &str) -> Fake {
        Fake::new("AXButton").title(title).frame(10.0, 10.0, 80.0, 20.0).actions(&["AXPress"])
    }

    #[test]
    fn leaves_a_hole_for_a_node_the_app_did_not_answer_and_none_for_one_that_went_away() {
        let stalled = button("Stalled").batch_failing(ax::AX_CANNOT_COMPLETE);
        let tree = whole(&window(vec![Fake::new("AXGroup").title("Pane").children(vec![button("OK"), stalled])]));
        assert!(!tree.complete);
        assert!(named(&tree, "Pane").subtree_truncated, "the pane lost a node");
        assert!(has(&tree, "OK") && !has(&tree, "Stalled"));

        let gone = button("Gone").batch_failing(ax::AX_INVALID_ELEMENT);
        let tree = whole(&window(vec![Fake::new("AXGroup").title("Pane").children(vec![button("OK"), gone])]));
        assert!(tree.complete, "a node gone since its parent listed it is no hole");
        assert!(!named(&tree, "Pane").subtree_truncated);
    }

    #[test]
    fn leaves_a_hole_for_children_the_app_did_not_list() {
        let pane = Fake::new("AXGroup").title("Pane").failing("AXChildren", ax::AX_CANNOT_COMPLETE);
        let tree = whole(&window(vec![pane]));
        assert!(!tree.complete);
        assert!(named(&tree, "Pane").subtree_truncated);

        // A list's children are counted, then read: a stall in either is a hole.
        let counted = Fake::new("AXList").title("Counted").counting("AXChildren", Err(ax::AX_CANNOT_COMPLETE));
        let tree = whole(&window(vec![counted]));
        assert!(!tree.complete);
        assert!(named(&tree, "Counted").subtree_truncated);
        let listed = Fake::new("AXList").title("Listed").counting("AXChildren", Ok(2)).failing("AXChildren", ax::AX_CANNOT_COMPLETE);
        let tree = whole(&window(vec![listed]));
        assert!(!tree.complete);
        assert!(named(&tree, "Listed").subtree_truncated);

        // A group that has no children to list answers with an error of its own: no hole.
        let empty = Fake::new("AXGroup").title("Empty").failing("AXChildren", ax::AX_NO_VALUE);
        let tree = whole(&window(vec![empty]));
        assert!(tree.complete);
        assert!(!named(&tree, "Empty").subtree_truncated);
    }

    #[test]
    fn counts_the_children_past_the_depth_limit_and_a_stalled_count_as_a_hole() {
        let deep = |count: Result<usize, ax::AXError>| Fake::new("AXGroup").title("Deep").counting("AXChildren", count);
        let tree = read(&window(vec![deep(Ok(3))]), &Fake::default(), 2, false, Instant::now() + Duration::from_secs(60)).expect("a tree");
        assert!(tree.complete);
        assert_eq!(named(&tree, "Deep").children_count, Some(3));
        assert!(!named(&tree, "Deep").subtree_truncated);

        let tree =
            read(&window(vec![deep(Err(ax::AX_CANNOT_COMPLETE))]), &Fake::default(), 2, false, Instant::now() + Duration::from_secs(60)).expect("a tree");
        assert!(!tree.complete);
        assert!(named(&tree, "Deep").subtree_truncated, "children the count did not answer for may be there");
        assert_eq!(named(&tree, "Deep").children_count, None);

        let tree =
            read(&window(vec![deep(Err(ax::AX_ATTRIBUTE_UNSUPPORTED))]), &Fake::default(), 2, false, Instant::now() + Duration::from_secs(60)).expect("a tree");
        assert!(tree.complete);
        assert!(!named(&tree, "Deep").subtree_truncated);
    }

    #[test]
    fn refuses_a_window_that_closed_before_or_while_it_was_read() {
        let failure = |window: Fake| read(&window, &Fake::default(), 30, false, Instant::now() + Duration::from_secs(60)).err().expect("a refusal");
        let closed = failure(window(vec![]).failing("AXRole", ax::AX_INVALID_ELEMENT));
        assert_eq!((closed.code, closed.message.as_str()), (codes::WINDOW_NOT_FOUND, "window 7 closed"));
        // It answered for its role, then closed before its attributes were read: no tree, rather than an empty one
        // that reads as complete.
        let mid_read = failure(window(vec![button("OK")]).batch_failing(ax::AX_INVALID_ELEMENT));
        assert_eq!((mid_read.code, mid_read.message.as_str()), (codes::WINDOW_NOT_FOUND, "window 7 could not be read"));
        assert_eq!(failure(window(vec![]).failing("AXRole", ax::AX_CANNOT_COMPLETE)).code, codes::APP_UNRESPONSIVE);
        assert_eq!(failure(window(vec![]).failing("AXRole", ax::AX_API_DISABLED)).code, codes::PERM_DENIED);

        // A window whose attributes stall is a bare window, read as no window yet.
        let tree = whole(&window(vec![button("OK")]).batch_failing(ax::AX_CANNOT_COMPLETE));
        assert!(tree.root_unread && !tree.complete);
        assert_eq!(tree.tree.role, "window");
    }

    #[test]
    fn leaves_out_the_title_bar_buttons_the_window_names_and_keeps_a_tab_close_button() {
        let close = Fake::new("AXButton").subrole("AXCloseButton").frame(5.0, 5.0, 12.0, 12.0).actions(&["AXPress"]);
        let tab_close = Fake::new("AXButton").subrole("AXCloseButton").description("Close Tab").frame(100.0, 40.0, 12.0, 12.0).actions(&["AXPress"]);
        let named_window = window(vec![close.clone(), tab_close.clone()]).with("AXCloseButton", Value::Element(close));
        let tree = whole(&named_window);
        assert!(has(&tree, "Close Tab"), "a button of the app's content with the subrole stays");
        assert_eq!(nodes(&tree.tree).len(), 2, "the window's own close button is left out");

        // A window that names no button falls back to the subrole.
        let tree = whole(&window(vec![tab_close]));
        assert_eq!(nodes(&tree.tree).len(), 1);
    }

    #[test]
    fn leaves_out_the_menu_button_macos_puts_in_the_title_bar_and_keeps_the_apps_own() {
        let close = Fake::new("AXButton").subrole("AXCloseButton").frame(5.0, 5.0, 12.0, 12.0).actions(&["AXPress"]);
        // macOS 27 adds it, a direct child of the window, beside the close button, while the window is recorded.
        let sharing = Fake::new("AXMenuButton").title("Window sharing").frame(300.0, 3.0, 30.0, 16.0).actions(&["AXPress"]);
        let app_menu = Fake::new("AXMenuButton").title("Sort").frame(300.0, 60.0, 30.0, 16.0).actions(&["AXPress"]);
        // A unified toolbar puts the app's own menu button at the close button's height, inside the toolbar.
        let toolbar_menu = Fake::new("AXMenuButton").title("Filter").frame(400.0, 3.0, 30.0, 16.0).actions(&["AXPress"]);
        let toolbar = Fake::new("AXToolbar").frame(80.0, 0.0, 600.0, 22.0).children(vec![toolbar_menu]);
        let named_window = window(vec![close.clone(), sharing, app_menu, toolbar]).with("AXCloseButton", Value::Element(close));
        let tree = whole(&named_window);
        assert!(!has(&tree, "Window sharing"), "the title bar's menu button is window chrome");
        assert!(has(&tree, "Sort"), "a menu button of the app's content stays");
        assert!(has(&tree, "Filter"), "a menu button in the toolbar stays, in the title bar's band too");
        assert!(crate::snapshot::system_title_bar_control(
            "AXMenuButton",
            Some(crate::snapshot::Rect { x: 0.0, y: 3.0, width: 10.0, height: 16.0 }),
            Some((5.0, 17.0))
        ));
        assert!(!crate::snapshot::system_title_bar_control(
            "AXButton",
            Some(crate::snapshot::Rect { x: 0.0, y: 3.0, width: 10.0, height: 16.0 }),
            Some((5.0, 17.0))
        ));
        assert!(!crate::snapshot::system_title_bar_control("AXMenuButton", Some(crate::snapshot::Rect { x: 0.0, y: 3.0, width: 10.0, height: 16.0 }), None));
    }

    #[test]
    fn offers_scroll_on_a_scroll_area_only_with_a_scroll_bar_for_the_axis() {
        let pages = ["AXScrollDownByPage", "AXScrollUpByPage", "AXScrollLeftByPage", "AXScrollRightByPage"];
        let area = |title: &str| Fake::new("AXScrollArea").title(title).frame(0.0, 0.0, 400.0, 300.0).actions(&pages);
        let bar = Fake::new("AXScrollBar").text("AXOrientation", "AXVerticalOrientation").frame(390.0, 0.0, 10.0, 300.0);
        let tree = whole(&window(vec![
            area("Attribute").with("AXVerticalScrollBar", Value::Element(Fake::new("AXScrollBar"))),
            area("Child").children(vec![bar]),
            area("Fits"),
            area("Null").with("AXVerticalScrollBar", Value::Other),
            Fake::new("AXList").title("Pages").frame(0.0, 0.0, 400.0, 300.0).actions(&["AXScrollDownByPage"]),
        ]));
        for name in ["Attribute", "Child"] {
            let node = named(&tree, name);
            assert!(node.available_actions.contains(&"Scroll"), "{name}");
            assert_eq!(node.scroll_axes, ["vertical"], "{name}");
        }
        // SwiftUI offers every scroll area the page actions, also one whose content fits; an attribute that is no
        // element is no scroll bar.
        for name in ["Fits", "Null"] {
            assert!(!named(&tree, name).available_actions.contains(&"Scroll"), "{name}");
        }
        assert_eq!(named(&tree, "Pages").scroll_axes, ["vertical"]);
    }

    #[test]
    fn gives_a_row_a_ref_whatever_it_offers_and_text_none_unless_it_takes_a_press() {
        let row = Fake::new("AXRow").description("Row").frame(0.0, 0.0, 100.0, 20.0);
        let label = Fake::new("AXStaticText").text("AXValue", "Label").frame(0.0, 0.0, 100.0, 20.0);
        let link = Fake::new("AXStaticText").text("AXValue", "Pressable").frame(0.0, 20.0, 100.0, 20.0).actions(&["AXPress"]);
        let tree = whole(&window(vec![row, label, link]));
        assert!(named(&tree, "Row").ref_id.is_some());
        assert!(named(&tree, "Label").ref_id.is_none());
        assert!(named(&tree, "Pressable").ref_id.is_some());
        assert_eq!(tree.refs.len(), 2);
    }

    #[test]
    fn reads_focus_only_from_the_app_and_none_when_it_did_not_answer() {
        let field = |name: &str| Fake::new("AXTextField").description(name).frame(0.0, 0.0, 100.0, 20.0).with("AXFocused", Value::Bool(true));
        let (first, second) = (field("First"), field("Second"));
        let app = Fake::default().with("AXFocusedUIElement", Value::Element(second.clone()));
        let tree = read(&window(vec![first.clone(), second.clone()]), &app, 30, false, Instant::now() + Duration::from_secs(60)).expect("a tree");
        assert!(tree.complete);
        assert!(!named(&tree, "First").states.contains(&"focused"), "a table's cells report the table's focus as their own");
        assert!(named(&tree, "Second").states.contains(&"focused"));

        let stalled = Fake::default().failing("AXFocusedUIElement", ax::AX_CANNOT_COMPLETE);
        let tree = read(&window(vec![first, second]), &stalled, 30, false, Instant::now() + Duration::from_secs(60)).expect("a tree");
        assert!(!tree.complete);
        assert!(nodes(&tree.tree).iter().all(|node| !node.states.contains(&"focused")));
    }

    #[test]
    fn leaves_a_hole_for_a_label_actions_or_a_setting_the_app_did_not_answer() {
        let label = Fake::new("AXStaticText").batch_failing(ax::AX_CANNOT_COMPLETE);
        let labelled = Fake::new("AXTextField").frame(0.0, 0.0, 100.0, 20.0).with("AXTitleUIElement", Value::Element(label));
        assert!(!whole(&window(vec![labelled])).complete);
        let named_by = Fake::new("AXStaticText").text("AXValue", "Email");
        let labelled = Fake::new("AXTextField").frame(0.0, 0.0, 100.0, 20.0).with("AXTitleUIElement", Value::Element(named_by));
        let tree = whole(&window(vec![labelled]));
        assert!(tree.complete && has(&tree, "Email"));

        assert!(!whole(&window(vec![button("OK").actions_failing(ax::AX_CANNOT_COMPLETE)])).complete);
        let field = Fake::new("AXTextField").description("Name").frame(0.0, 0.0, 100.0, 20.0).settable("AXValue", Err(ax::AX_CANNOT_COMPLETE));
        let tree = whole(&window(vec![field]));
        assert!(!tree.complete);
        // Any other failure is the element's own answer.
        assert!(whole(&window(vec![button("OK").actions_failing(ax::AX_FAILURE)])).complete);
    }

    #[test]
    fn offers_set_value_on_a_stepper_only_when_it_shows_a_number() {
        let stepper = |name: &str, value: Value<Fake>| {
            Fake::new("AXIncrementor").description(name).frame(0.0, 0.0, 20.0, 20.0).actions(&["AXIncrement", "AXDecrement"]).with("AXValue", value)
        };
        let tree = whole(&window(vec![stepper("Number", Value::Number(3.0)), stepper("Words", Value::Text("three".into()))]));
        assert!(named(&tree, "Number").available_actions.contains(&"SetValue"));
        assert!(!named(&tree, "Words").available_actions.contains(&"SetValue"));
    }

    #[test]
    fn says_the_deadline_stopped_a_read_that_ran_out_of_time() {
        let tree = read(&window(vec![button("OK")]), &Fake::default(), 30, false, Instant::now()).expect("a tree");
        assert!(tree.timed_out && !tree.complete);
        assert!(tree.tree.subtree_truncated, "the window's children were not read");
        assert!(!has(&tree, "OK"));
        // Out of time before the walk began, even a window with nothing in it was not read whole.
        let tree = read(&window(vec![]), &Fake::default(), 30, false, Instant::now()).expect("a tree");
        assert!(tree.timed_out && !tree.complete);
    }

    #[test]
    fn reads_an_element_listed_under_two_parents_once_where_it_is_first_found() {
        // A SwiftUI toolbar `Menu`: its open menu is the button's child and the button's sibling.
        let menu = Fake::new("AXMenu").frame(10.0, 40.0, 95.0, 58.0).children(vec![
            Fake::new("AXMenuItem").title("By Title").frame(10.0, 45.0, 95.0, 24.0).actions(&["AXPress"]),
            Fake::new("AXMenuItem").title("By Priority").frame(10.0, 69.0, 95.0, 24.0).actions(&["AXPress"]),
        ]);
        let sort = Fake::new("AXMenuButton").title("Sort").frame(10.0, 10.0, 50.0, 30.0).actions(&["AXPress"]).children(vec![menu.clone()]);
        let toolbar = Fake::new("AXToolbar").frame(0.0, 0.0, 800.0, 52.0).children(vec![sort, menu]);
        let tree = whole(&window(vec![toolbar]));
        assert_eq!(nodes(&tree.tree).iter().filter(|node| node.name.as_deref() == Some("By Priority")).count(), 1);
        assert_eq!(nodes(&tree.tree).iter().filter(|node| node.role == "menu").count(), 1);
        let sort = named(&tree, "Sort");
        assert_eq!(sort.children.first().map(|menu| menu.role), Some("menu"), "the menu stays under its button");
        assert!(tree.complete);
    }

    /// A row of a list at `y`, 20 points tall, whose box reads only when the walk reads inside the row.
    fn row(title: &str, y: f64) -> Fake {
        Fake::new("AXRow").frame(0.0, y, 300.0, 20.0).children(vec![Fake::new("AXCheckBox").title(title).frame(4.0, y, 200.0, 20.0).actions(&["AXPress"])])
    }

    /// A list of `rows` in a scroll area that shows y 100 to 200 of the window.
    fn scrolled(rows: Vec<Fake>) -> Fake {
        window(vec![Fake::new("AXScrollArea").frame(0.0, 100.0, 300.0, 100.0).children(vec![Fake::new("AXOutline").description("Tasks").children(rows)])])
    }

    #[test]
    fn folds_the_rows_a_scroll_area_holds_out_of_view_into_one_node_per_run() {
        // Rows 0 to 19, 20 points apart: rows 5 to 9 show; 4 and 10 only touch the edges, so they are out of view
        // with the rest. A folded row's children stall, so reading inside one would leave a hole.
        let rows: Vec<Fake> = (0..20)
            .map(|index| {
                let row = row(&format!("Task {index}"), f64::from(index) * 20.0 + 0.0);
                if !(5..=9).contains(&index) { row.failing("AXChildren", ax::AX_CANNOT_COMPLETE) } else { row }
            })
            .collect();
        let tree = whole(&scrolled(rows));
        assert!(tree.complete, "nothing inside a folded row was read");
        let list = named(&tree, "Tasks");
        let folded: Vec<usize> = list.children.iter().map(|child| child.folded).collect();
        assert_eq!(folded, [5, 0, 0, 0, 0, 0, 10], "rows 0-4 and 10-19 fold, 5-9 are read");
        assert!(list.children.iter().filter(|child| child.folded > 0).all(|child| child.role == "folded" && child.ref_id.is_none()));
        assert!(has(&tree, "Task 5") && has(&tree, "Task 9") && !has(&tree, "Task 4") && !has(&tree, "Task 10"));
        assert!(!list.subtree_truncated);
    }

    #[test]
    fn reads_a_row_partly_in_view_and_folds_only_rows_wholly_out_of_it() {
        // Rows 10 points off the grid: row 4 (90-110) and row 9 (190-210) are partly in view, so they are read.
        let rows: Vec<Fake> = (0..20)
            .map(|index| {
                let row = row(&format!("Task {index}"), f64::from(index) * 20.0 + 10.0);
                if !(4..=9).contains(&index) { row.failing("AXChildren", ax::AX_CANNOT_COMPLETE) } else { row }
            })
            .collect();
        let tree = whole(&scrolled(rows));
        assert!(tree.complete, "nothing inside a folded row was read");
        let folded: Vec<usize> = named(&tree, "Tasks").children.iter().map(|child| child.folded).collect();
        assert_eq!(folded, [4, 0, 0, 0, 0, 0, 0, 10], "rows 0-3 and 10-19 fold, 4-9 are read");
        assert!(has(&tree, "Task 4") && has(&tree, "Task 9"));
    }

    #[test]
    fn folds_no_row_that_holds_the_focus_and_nothing_outside_a_list() {
        let field = Fake::new("AXTextField").description("Note").frame(4.0, 400.0, 200.0, 20.0).with("AXFocused", Value::Bool(true));
        let editing = Fake::new("AXRow").frame(0.0, 400.0, 300.0, 20.0).children(vec![field.clone()]);
        let app = Fake::default().with("AXFocusedUIElement", Value::Element(field));
        let tree = read(&scrolled(vec![row("Task 0", 100.0), editing]), &app, 30, false, Instant::now() + Duration::from_secs(60)).expect("a tree");
        assert!(named(&tree, "Note").states.contains(&"focused"), "the row being typed into is read whole");

        // Nor a selected row: a select chose it, and the selection reads it out of view.
        let chosen = row("Task 40", 900.0).with("AXSelected", Value::Bool(true));
        let tree = whole(&scrolled(vec![row("Task 0", 100.0), row("Task 39", 880.0), chosen]));
        let folded: Vec<usize> = named(&tree, "Tasks").children.iter().map(|child| child.folded).collect();
        assert_eq!(folded, [0, 1, 0], "only the row neither selected nor in view folds");
        assert!(has(&tree, "Task 40") && nodes(&tree.tree).iter().any(|node| node.role == "row" && node.states.contains(&"selected")));

        // A pane's child out of view is read as offscreen: only a list's rows fold.
        let pane = Fake::new("AXGroup").description("Pane").children(vec![button("Far").frame(0.0, 900.0, 80.0, 20.0)]);
        let tree = whole(&window(vec![Fake::new("AXScrollArea").frame(0.0, 0.0, 300.0, 100.0).children(vec![pane])]));
        assert!(named(&tree, "Far").states.contains(&"offscreen"));
        // A list's scroll bar never folds.
        let bar = Fake::new("AXScrollBar").frame(0.0, 900.0, 10.0, 100.0);
        let tree = whole(&scrolled(vec![row("Task 0", 100.0), bar]));
        assert!(nodes(&tree.tree).iter().any(|node| node.role == "scrollbar"));
    }

    #[test]
    fn keeps_only_controls_and_what_holds_them_in_an_interactive_read() {
        let pane = Fake::new("AXGroup").children(vec![Fake::new("AXStaticText").text("AXValue", "Note")]);
        let holder = Fake::new("AXGroup").description("Holder").children(vec![button("OK")]);
        let secure = Fake::new("AXTextField").subrole("AXSecureTextField").description("Password").frame(0.0, 0.0, 100.0, 20.0);
        let tree = read(&window(vec![pane, holder, secure]), &Fake::default(), 30, true, Instant::now() + Duration::from_secs(60)).expect("a tree");
        assert!(!has(&tree, "Note"));
        assert!(has(&tree, "Holder") && has(&tree, "OK") && has(&tree, "Password"));
    }
}
