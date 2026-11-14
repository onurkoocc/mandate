//! The values the TypeScript compiler writes out, and its two ways of
//! writing them: `JSON.stringify(v)` ([`stringify`]) and
//! `JSON.stringify(v, null, 2)` ([`stringify_pretty`]).
//!
//! Diagnostics' facts, the `check` output and the views hold doubles, so
//! they need a value wider than the IR's [`Value`], which admits only safe
//! integers so that canonical text cannot fail. [`JsValue`] also holds
//! `undefined`, so that a member the TypeScript sets to a value that may be
//! `undefined` is written exactly as `JSON.stringify` writes it: left out of
//! an object, `null` in an array. An object ([`JsObject`]) keeps its members
//! in ECMAScript order (array indices first; see `members.rs`).
//!
//! Strings are Unicode scalar values: a TypeScript string with a lone
//! surrogate, which `JSON.stringify` writes as a `\ud800` escape, has no
//! counterpart here (where the reader quotes one, U+FFFD stands for it; see
//! the crate's documentation of known differences).
//!
//! For porters: in TypeScript `o["__proto__"] = v` on a plain `{}` sets the
//! object's prototype and adds no member, while on an object made with
//! `Object.create(null)` (as the JSON reader makes its objects) it adds one.
//! [`JsObject::insert`] always adds one, so check how the TypeScript object
//! was made before porting an assignment of a name that may be `__proto__`.

use crate::jcs::write_json_string;
use crate::members::Members;
use crate::number::write_number;
use crate::value::{Int, Map, Value};

/// A value as `JSON.stringify` and `String` see it.
#[derive(Clone, Debug, PartialEq)]
pub enum JsValue {
    /// `undefined`: left out of an object, `null` in an array.
    Undefined,
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A double; `NaN` and the infinities are written `null`, `-0` as `0`.
    Number(f64),
    /// A string.
    String(String),
    /// An array.
    Array(Vec<JsValue>),
    /// An object.
    Object(JsObject),
}

impl JsValue {
    /// `String(v)`, ECMAScript's `ToString`: `undefined`, `null`, `true`,
    /// [`crate::number_to_string`] for a number, the string itself, the
    /// elements joined with `,` for an array (`Array.prototype.join`, where
    /// `null` and `undefined` are empty), and `[object Object]`.
    #[must_use]
    pub fn to_js_string(&self) -> String {
        let mut out = String::new();
        self.write_js_string(&mut out);
        out
    }

    fn write_js_string(&self, out: &mut String) {
        match self {
            JsValue::Undefined => out.push_str("undefined"),
            JsValue::Null => out.push_str("null"),
            JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            JsValue::Number(x) => write_number(out, *x),
            JsValue::String(s) => out.push_str(s),
            JsValue::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if !matches!(item, JsValue::Undefined | JsValue::Null) {
                        item.write_js_string(out);
                    }
                }
            }
            JsValue::Object(_) => out.push_str("[object Object]"),
        }
    }

    /// The member `key` when this is an object that has one: `v?.[key]`.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        match self {
            JsValue::Object(o) => o.get(key),
            _ => None,
        }
    }

    /// The string when this is a string.
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsValue::String(s) => Some(s),
            _ => None,
        }
    }

    /// The number when this is a number.
    #[must_use]
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            JsValue::Number(x) => Some(*x),
            _ => None,
        }
    }

    /// The boolean when this is one.
    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            JsValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// The elements when this is an array.
    #[must_use]
    pub fn as_array(&self) -> Option<&[JsValue]> {
        match self {
            JsValue::Array(items) => Some(items),
            _ => None,
        }
    }

    /// The members when this is an object.
    #[must_use]
    pub fn as_object(&self) -> Option<&JsObject> {
        match self {
            JsValue::Object(o) => Some(o),
            _ => None,
        }
    }

    /// Whether this is `undefined`.
    #[must_use]
    pub fn is_undefined(&self) -> bool {
        matches!(self, JsValue::Undefined)
    }

    /// Whether this is `null`.
    #[must_use]
    pub fn is_null(&self) -> bool {
        matches!(self, JsValue::Null)
    }
}

impl From<bool> for JsValue {
    fn from(b: bool) -> Self {
        JsValue::Bool(b)
    }
}

impl From<f64> for JsValue {
    fn from(x: f64) -> Self {
        JsValue::Number(x)
    }
}

impl From<i32> for JsValue {
    fn from(n: i32) -> Self {
        JsValue::Number(f64::from(n))
    }
}

impl From<u32> for JsValue {
    fn from(n: u32) -> Self {
        JsValue::Number(f64::from(n))
    }
}

impl From<usize> for JsValue {
    /// A count or an index, as the double TypeScript holds; exact below 2^53.
    fn from(n: usize) -> Self {
        JsValue::Number(n as f64)
    }
}

impl From<Int> for JsValue {
    /// Exact: an [`Int`] is within ±(2^53−1), where every integer is a double.
    fn from(n: Int) -> Self {
        JsValue::Number(n.get() as f64)
    }
}

impl From<&str> for JsValue {
    fn from(s: &str) -> Self {
        JsValue::String(s.to_owned())
    }
}

impl From<String> for JsValue {
    fn from(s: String) -> Self {
        JsValue::String(s)
    }
}

impl From<Vec<JsValue>> for JsValue {
    fn from(items: Vec<JsValue>) -> Self {
        JsValue::Array(items)
    }
}

impl From<JsObject> for JsValue {
    fn from(o: JsObject) -> Self {
        JsValue::Object(o)
    }
}

impl<T: Into<JsValue>> From<Option<T>> for JsValue {
    /// `None` is `undefined`.
    fn from(v: Option<T>) -> Self {
        v.map_or(JsValue::Undefined, Into::into)
    }
}

impl From<&Value> for JsValue {
    /// The IR value as TypeScript holds it.
    fn from(v: &Value) -> Self {
        match v {
            Value::Null => JsValue::Null,
            Value::Bool(b) => JsValue::Bool(*b),
            Value::Number(n) => JsValue::from(*n),
            Value::String(s) => JsValue::String(s.clone()),
            Value::Array(items) => JsValue::Array(items.iter().map(JsValue::from).collect()),
            Value::Object(map) => JsValue::Object(JsObject::from(map)),
        }
    }
}

impl From<&Map> for JsObject {
    /// The IR object as TypeScript holds it, its members in the same order.
    fn from(map: &Map) -> Self {
        JsObject {
            members: Members::from_unique(
                map.iter()
                    .map(|(k, v)| (k.to_owned(), JsValue::from(v)))
                    .collect(),
            ),
        }
    }
}

impl<K: Into<String>, V: Into<JsValue>> FromIterator<(K, V)> for JsObject {
    /// The object these assignments make, in order: a name given again keeps
    /// its first place and takes the last value, as [`JsObject::insert`] one
    /// by one would (`Object.fromEntries`), in one pass.
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        JsObject {
            members: Members::from_assignments(iter.into_iter().map(|(k, v)| (k.into(), v.into()))),
        }
    }
}

/// An object, its members in ECMAScript order: array-index names (`"0"`,
/// `"10"`, up to `"4294967294"`) first in ascending order, then the others
/// in the order they were first assigned, which is the order of
/// `Object.keys` and of `JSON.stringify`. A member may be
/// [`JsValue::Undefined`]: it holds its place, as `{ a: undefined }` does in
/// TypeScript, and is not written.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JsObject {
    members: Members<JsValue>,
}

impl JsObject {
    /// `{}`.
    #[must_use]
    pub const fn new() -> JsObject {
        JsObject {
            members: Members::new(),
        }
    }

    /// The object with member `key` set to `value`, as `{ ..., key: value }`
    /// or `o[key] = value`. A value that may be absent (an `Option`) is
    /// `undefined` when it is: the name is kept but not written.
    #[must_use]
    pub fn with(mut self, key: impl Into<String>, value: impl Into<JsValue>) -> JsObject {
        self.insert(key, value);
        self
    }

    /// The object with member `key` set to `value` only when there is one,
    /// as `...(value !== undefined ? { key: value } : {})`: when there is
    /// none, the name is not assigned at all, so a later assignment puts it
    /// last.
    #[must_use]
    pub fn with_some<T: Into<JsValue>>(self, key: impl Into<String>, value: Option<T>) -> JsObject {
        match value {
            Some(v) => self.with(key, v),
            None => self,
        }
    }

    /// `o[key] = value`; the value it had, if any. A present name keeps its
    /// place.
    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<JsValue>) -> Option<JsValue> {
        self.members.insert(key.into(), value.into())
    }

    /// An object of these members, in ECMAScript order; `None` when two have
    /// the same name. In one pass and one sort, for large objects.
    #[must_use]
    pub fn from_entries(entries: Vec<(String, JsValue)>) -> Option<JsObject> {
        Members::from_entries(entries).map(|members| JsObject { members })
    }

    /// `{ ...this, ...other }`: each member of `other` assigned in its order.
    /// Into an empty object it is a copy.
    #[must_use]
    pub fn spread(mut self, other: &JsObject) -> JsObject {
        if self.is_empty() {
            return other.clone();
        }
        for (k, v) in other.iter() {
            self.insert(k, v.clone());
        }
        self
    }

    /// The value of member `key`, to change in place, as in
    /// `(o[k] ??= []).push(x)`.
    pub fn get_mut(&mut self, key: &str) -> Option<&mut JsValue> {
        self.members.get_mut(key)
    }

    /// `delete o[key]`; the value it had, if any.
    pub fn remove(&mut self, key: &str) -> Option<JsValue> {
        self.members.remove(key)
    }

    /// The value of member `key` (`undefined` members included).
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.members.get(key)
    }

    /// The members, in order (`Object.entries`).
    pub fn iter(&self) -> impl Iterator<Item = (&str, &JsValue)> {
        self.members.iter()
    }

    /// The member names, in order (`Object.keys`).
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.members.iter().map(|(k, _)| k)
    }

    /// The number of members.
    #[must_use]
    pub fn len(&self) -> usize {
        self.members.len()
    }

    /// Whether there are no members.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.members.len() == 0
    }
}

/// `JSON.stringify(v)`: no white space; `None` when `v` is `undefined`, for
/// which `JSON.stringify` gives `undefined`, not a string.
///
/// It recurses once per level of nesting; the values the compiler writes
/// are shallow, and a value built from one read by [`crate::parse`] is at
/// most [`crate::limits::JSON_DEPTH`] deep.
#[must_use]
pub fn stringify(v: &JsValue) -> Option<String> {
    let mut out = String::new();
    write(&mut out, v, None, 0).then_some(out)
}

/// `JSON.stringify(v, null, 2)`: each member and element on its own line,
/// indented two spaces a level, `"name": value`, and `[]` and `{}` for an
/// empty array and an object with nothing to write; `None` when `v` is
/// `undefined`. The files the CLI writes add a line feed:
/// `JSON.stringify(v, null, 2) + "\n"`.
#[must_use]
pub fn stringify_pretty(v: &JsValue) -> Option<String> {
    let mut out = String::new();
    write(&mut out, v, Some("  "), 0).then_some(out)
}

fn newline(out: &mut String, gap: &str, level: usize) {
    out.push('\n');
    for _ in 0..level {
        out.push_str(gap);
    }
}

/// Writes `v` at nesting `level`; false, writing nothing, for `undefined`
/// (`SerializeJSONProperty` giving undefined).
fn write(out: &mut String, v: &JsValue, gap: Option<&str>, level: usize) -> bool {
    let inner = level.saturating_add(1);
    match v {
        JsValue::Undefined => return false,
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Number(x) if x.is_finite() => write_number(out, *x),
        JsValue::Number(_) => out.push_str("null"),
        JsValue::String(s) => write_json_string(out, s),
        JsValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if let Some(gap) = gap {
                    newline(out, gap, inner);
                }
                if !write(out, item, gap, inner) {
                    out.push_str("null");
                }
            }
            if let (Some(gap), false) = (gap, items.is_empty()) {
                newline(out, gap, level);
            }
            out.push(']');
        }
        JsValue::Object(o) => {
            out.push('{');
            let mut any = false;
            for (key, item) in o.iter() {
                if matches!(item, JsValue::Undefined) {
                    continue;
                }
                if any {
                    out.push(',');
                }
                any = true;
                if let Some(gap) = gap {
                    newline(out, gap, inner);
                }
                write_json_string(out, key);
                out.push(':');
                if gap.is_some() {
                    out.push(' ');
                }
                write(out, item, gap, inner);
            }
            if let (Some(gap), true) = (gap, any) {
                newline(out, gap, level);
            }
            out.push('}');
        }
    }
    true
}
