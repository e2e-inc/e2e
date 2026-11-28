//! A fake accessibility tree for unit tests: elements that answer every request the driver makes from a table the
//! test writes, so the snapshot walk's and the actions' rules run without an app.

use crate::ax::{self, AXError, Accessible, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

#[derive(Default)]
struct Data {
    /// Each attribute's answer: a value, or the error a read of it gives.
    attributes: HashMap<String, Result<Value<Fake>, AXError>>,
    /// The error every request of the element answers with: a gone element, or an app that stalls on it.
    every: Option<AXError>,
    /// The error a batch read answers with, while single reads still answer.
    batch: Option<AXError>,
    /// A count of an attribute that answers apart from the attribute: a number, or an error.
    counts: HashMap<String, Result<usize, AXError>>,
    /// How many more requests the element answers before it is gone.
    gone_in: Option<usize>,
    /// The error the action list answers with; otherwise `actions`.
    actions_error: Option<AXError>,
    actions: Vec<String>,
    settable: HashMap<String, Result<bool, AXError>>,
    /// The answer each action gets; `Ok` when not set.
    performs: HashMap<String, AXError>,
    /// What was sent, in order: `perform AXPress`, `set AXSelected`.
    sent: Vec<String>,
}

/// One element of a fake tree. Clones are the same element, as two `AXUIElementRef`s for one element are equal.
#[derive(Clone, Default)]
pub struct Fake(Rc<RefCell<Data>>);

impl PartialEq for Fake {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for Fake {}

impl Hash for Fake {
    fn hash<H: Hasher>(&self, state: &mut H) {
        (Rc::as_ptr(&self.0) as usize).hash(state);
    }
}

impl Fake {
    /// An element of an AX role, such as `AXButton`.
    pub fn new(role: &str) -> Self {
        Self::default().with("AXRole", Value::Text(role.into()))
    }

    /// Sets an attribute's value.
    pub fn with(self, name: &str, value: Value<Fake>) -> Self {
        self.0.borrow_mut().attributes.insert(name.into(), Ok(value));
        self
    }

    pub fn text(self, name: &str, text: &str) -> Self {
        self.with(name, Value::Text(text.into()))
    }

    pub fn title(self, title: &str) -> Self {
        self.text("AXTitle", title)
    }

    pub fn description(self, description: &str) -> Self {
        self.text("AXDescription", description)
    }

    pub fn subrole(self, subrole: &str) -> Self {
        self.text("AXSubrole", subrole)
    }

    /// Sets the element's frame in screen points.
    pub fn frame(self, x: f64, y: f64, width: f64, height: f64) -> Self {
        self.with("AXPosition", Value::Point(x, y)).with("AXSize", Value::Size(width, height))
    }

    /// Sets the element's children, and makes each one's parent this element.
    pub fn children(self, children: Vec<Fake>) -> Self {
        for child in &children {
            child.0.borrow_mut().attributes.insert("AXParent".into(), Ok(Value::Element(self.clone())));
        }
        self.with("AXChildren", Value::Array(children.into_iter().map(Value::Element).collect()))
    }

    /// Makes a read of one attribute fail.
    pub fn failing(self, name: &str, error: AXError) -> Self {
        self.0.borrow_mut().attributes.insert(name.into(), Err(error));
        self
    }

    /// Makes every request of the element fail.
    pub fn gone(self, error: AXError) -> Self {
        self.0.borrow_mut().every = Some(error);
        self
    }

    /// Makes a batch read of the element fail, while single reads still answer.
    pub fn batch_failing(self, error: AXError) -> Self {
        self.0.borrow_mut().batch = Some(error);
        self
    }

    /// Makes a count of an attribute answer apart from the attribute itself.
    pub fn counting(self, name: &str, count: Result<usize, AXError>) -> Self {
        self.0.borrow_mut().counts.insert(name.into(), count);
        self
    }

    /// Makes the element go away once it answered `requests` more requests, as a button does once its alert closes.
    pub fn gone_after(&self, requests: usize) {
        self.0.borrow_mut().gone_in = Some(requests);
    }

    pub fn actions(self, actions: &[&str]) -> Self {
        self.0.borrow_mut().actions = actions.iter().map(|action| (*action).to_owned()).collect();
        self
    }

    pub fn actions_failing(self, error: AXError) -> Self {
        self.0.borrow_mut().actions_error = Some(error);
        self
    }

    pub fn settable(self, name: &str, settable: Result<bool, AXError>) -> Self {
        self.0.borrow_mut().settable.insert(name.into(), settable);
        self
    }

    /// Makes an action answer with an error.
    pub fn performing(self, action: &str, error: AXError) -> Self {
        self.0.borrow_mut().performs.insert(action.into(), error);
        self
    }

    /// Changes the element after it was built, as an app changes it between two reads.
    pub fn set(&self, name: &str, answer: Result<Value<Fake>, AXError>) {
        self.0.borrow_mut().attributes.insert(name.into(), answer);
    }

    /// What was sent to the element, in order.
    pub fn sent(&self) -> Vec<String> {
        self.0.borrow().sent.clone()
    }

    fn answer(&self) -> Result<(), AXError> {
        let mut data = self.0.borrow_mut();
        match data.gone_in {
            Some(0) => data.every = Some(ax::AX_INVALID_ELEMENT),
            Some(left) => data.gone_in = Some(left - 1),
            None => {}
        }
        data.every.map_or(Ok(()), Err)
    }

    fn write(&self, name: &str, value: Value<Fake>) -> Result<(), AXError> {
        self.answer()?;
        let mut data = self.0.borrow_mut();
        data.sent.push(format!("set {name}"));
        data.attributes.insert(name.into(), Ok(value));
        Ok(())
    }
}

impl Accessible for Fake {
    fn attribute(&self, name: &str) -> Result<Value<Fake>, AXError> {
        self.answer()?;
        self.0.borrow().attributes.get(name).cloned().unwrap_or(Err(ax::AX_NO_VALUE))
    }

    fn attributes(&self, names: &[&str]) -> Result<Vec<Option<Value<Fake>>>, AXError> {
        self.answer()?;
        if let Some(error) = self.0.borrow().batch {
            return Err(error);
        }
        let data = self.0.borrow();
        ax::slots(names.iter().map(|name| data.attributes.get(*name).cloned().unwrap_or(Err(ax::AX_NO_VALUE))).collect())
    }

    fn count(&self, name: &str) -> Result<usize, AXError> {
        self.answer()?;
        if let Some(count) = self.0.borrow().counts.get(name) {
            return *count;
        }
        match self.0.borrow().attributes.get(name) {
            Some(Ok(Value::Array(items))) => Ok(items.len()),
            Some(Err(error)) => Err(*error),
            _ => Err(ax::AX_ATTRIBUTE_UNSUPPORTED),
        }
    }

    fn elements(&self, name: &str, max: usize) -> Result<Vec<Fake>, AXError> {
        match self.attribute(name) {
            Ok(Value::Array(items)) => {
                Ok(items.into_iter().filter_map(|item| if let Value::Element(element) = item { Some(element) } else { None }).take(max).collect())
            }
            Ok(_) => Ok(Vec::new()),
            Err(ax::AX_NO_VALUE) => Err(ax::AX_ATTRIBUTE_UNSUPPORTED),
            Err(error) => Err(error),
        }
    }

    fn settable(&self, name: &str) -> Result<bool, AXError> {
        self.answer()?;
        self.0.borrow().settable.get(name).cloned().unwrap_or(Ok(false))
    }

    fn set_text(&self, name: &str, value: &str) -> Result<(), AXError> {
        self.write(name, Value::Text(value.into()))
    }

    fn set_bool(&self, name: &str, value: bool) -> Result<(), AXError> {
        self.write(name, Value::Bool(value))
    }

    fn set_number(&self, name: &str, value: f64) -> Result<(), AXError> {
        self.write(name, Value::Number(value))
    }

    fn set_range(&self, name: &str, location: usize, length: usize) -> Result<(), AXError> {
        self.write(name, Value::Range(location, length))
    }

    fn set_elements(&self, name: &str, values: &[Fake]) -> Result<(), AXError> {
        self.write(name, Value::Array(values.iter().cloned().map(Value::Element).collect()))
    }

    fn perform(&self, action: &str) -> Result<(), AXError> {
        self.answer()?;
        let mut data = self.0.borrow_mut();
        data.sent.push(format!("perform {action}"));
        data.performs.get(action).map_or(Ok(()), |error| Err(*error))
    }

    fn actions(&self) -> Result<Vec<String>, AXError> {
        self.answer()?;
        let data = self.0.borrow();
        data.actions_error.map_or_else(|| Ok(data.actions.clone()), Err)
    }

    fn set_timeout(&self, _seconds: f32) {}
}
