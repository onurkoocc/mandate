//! The IR value domain: the `Json` type of `compiler/src/json/strict-json.ts`.
//!
//! It is narrower than JSON. Numbers are integers within ±(2^53−1), with no
//! negative zero ([`Int`]); strings are Unicode scalar values, so they cannot
//! hold the lone surrogates that JCS cannot encode; an object never has two
//! members with the same name ([`Map`]). Every value of this type therefore
//! has exactly one canonical text, and [`crate::canonicalize`] cannot fail.

use std::fmt;

use crate::members::Members;

/// A value of the IR domain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// An integer within ±(2^53−1).
    Number(Int),
    /// A string, kept exactly as written (no Unicode normalisation).
    String(String),
    /// An array.
    Array(Vec<Value>),
    /// An object.
    Object(Map),
}

impl Value {
    /// The member `key` when this is an object that has one.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(map) => map.get(key),
            _ => None,
        }
    }

    /// The string when this is a string.
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    /// The integer when this is a number.
    #[must_use]
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Number(n) => Some(n.get()),
            _ => None,
        }
    }

    /// The elements when this is an array.
    #[must_use]
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    /// The members when this is an object.
    #[must_use]
    pub fn as_object(&self) -> Option<&Map> {
        match self {
            Value::Object(map) => Some(map),
            _ => None,
        }
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}

impl From<Int> for Value {
    fn from(n: Int) -> Self {
        Value::Number(n)
    }
}

impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::String(s)
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::String(s.to_owned())
    }
}

impl From<Vec<Value>> for Value {
    fn from(items: Vec<Value>) -> Self {
        Value::Array(items)
    }
}

impl From<Map> for Value {
    fn from(map: Map) -> Self {
        Value::Object(map)
    }
}

/// An integer within ±(2^53−1), the numbers the IR admits (ECMAScript's
/// `Number.isSafeInteger`). Zero has one sign.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Int(i64);

impl Int {
    /// 2^53−1, `Number.MAX_SAFE_INTEGER`.
    pub const MAX: Int = Int(9_007_199_254_740_991);
    /// −(2^53−1), `Number.MIN_SAFE_INTEGER`.
    pub const MIN: Int = Int(-9_007_199_254_740_991);

    /// The integer `n` when it is within ±(2^53−1).
    #[must_use]
    pub fn new(n: i64) -> Option<Int> {
        (Self::MIN.0..=Self::MAX.0).contains(&n).then_some(Int(n))
    }

    /// The integer `n`, or the nearest bound when it is outside ±(2^53−1).
    #[must_use]
    pub fn saturating(n: i64) -> Int {
        Int(n.clamp(Self::MIN.0, Self::MAX.0))
    }

    /// The integer `n`, or [`Int::MAX`] when it is larger.
    #[must_use]
    pub fn from_usize_saturating(n: usize) -> Int {
        i64::try_from(n).map_or(Self::MAX, Self::saturating)
    }

    /// Its value.
    #[must_use]
    pub const fn get(self) -> i64 {
        self.0
    }
}

impl fmt::Display for Int {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// The members of an object, in the order an ECMAScript object holds them
/// (`OrdinaryOwnPropertyKeys`): array-index names such as `"0"`
/// and `"10"` first, ascending, then the others in the order they were read
/// or inserted. So iterating a `Map` read by [`crate::parse`] gives the order
/// of `Object.keys` on what `JSON.parse` gives in TypeScript.
///
/// Names are unique: [`Map::insert`] replaces the value of a name already
/// present and keeps its place, as assignment to an ECMAScript object does.
/// Canonical text sorts the members, so the order never changes a hash. `==`
/// compares members in order; compare canonical text to compare IR values.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Map {
    members: Members<Value>,
}

impl Map {
    /// An empty object.
    #[must_use]
    pub const fn new() -> Map {
        Map {
            members: Members::new(),
        }
    }

    /// Sets member `key` to `value`; the value it had, if any.
    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<Value>) -> Option<Value> {
        self.members.insert(key.into(), value.into())
    }

    /// An object of these members; `None` when two have the same name.
    /// Unlike inserting them one by one, it takes time O(n log n) at worst,
    /// for objects read from large untrusted input.
    #[must_use]
    pub fn from_entries(entries: Vec<(String, Value)>) -> Option<Map> {
        Members::from_entries(entries).map(|members| Map { members })
    }

    /// An object of members whose names the caller knows are unique.
    pub(crate) fn from_unique(entries: Vec<(String, Value)>) -> Map {
        Map {
            members: Members::from_unique(entries),
        }
    }

    /// Removes member `key`; the value it had, if any.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.members.remove(key)
    }

    /// The value of member `key`.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.members.get(key)
    }

    /// Whether member `key` is present.
    #[must_use]
    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// The members, in order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.members.iter()
    }

    /// The member names, in order.
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

impl<K: Into<String>, V: Into<Value>> FromIterator<(K, V)> for Map {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        let mut map = Map::new();
        for (k, v) in iter {
            map.insert(k, v);
        }
        map
    }
}
