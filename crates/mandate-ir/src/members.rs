//! The members of an object in the order ECMAScript gives an ordinary
//! object's own keys (`OrdinaryOwnPropertyKeys`, ECMA-262 §10.1.11.1), which
//! is the order of `Object.keys`, `Object.entries`, `for…in`, spread and
//! `JSON.stringify`: first the names that are array indices, in ascending
//! numeric order, then every other name in the order it was first assigned.
//!
//! An array index is the canonical decimal form of an integer from 0 to
//! 2^32 − 2: `"0"`, `"10"` and `"4294967294"` are; `"007"`, `"-1"`, `"1.0"`
//! and `"4294967295"` are not. [`crate::Map`] and [`crate::JsObject`] keep
//! their members here, so iterating either is iterating the object the
//! TypeScript compiler holds, whether it was built by `JSON.parse` or by
//! assignments in the compiler.
//!
//! The cost: assigning a new array-index name moves the members after its
//! place (as assigning any new name already scans the members for a
//! duplicate), and building from a list sorts its array-index names once.

use std::collections::HashSet;

/// The numeric value of `key` when it is an array index.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    let canonical = match bytes {
        [b'0'] => true,
        [b'1'..=b'9', rest @ ..] => rest.len() < 10 && rest.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    if !canonical {
        return None;
    }
    // Ten digits may be over u32::MAX; u32::MAX itself, 2^32 − 1, is not an index.
    key.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// Members in ECMAScript order; names are unique.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Members<V> {
    entries: Vec<(String, V)>,
    /// How many of the first entries have array-index names.
    indexed: usize,
}

impl<V> Default for Members<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V> Members<V> {
    pub(crate) const fn new() -> Self {
        Members {
            entries: Vec::new(),
            indexed: 0,
        }
    }

    /// Assignment, `object[key] = value`: a present name keeps its place.
    pub(crate) fn insert(&mut self, key: String, value: V) -> Option<V> {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some((_, slot)) => Some(std::mem::replace(slot, value)),
            None => {
                self.insert_new(key, value);
                None
            }
        }
    }

    /// Adds a name the caller knows is not present.
    fn insert_new(&mut self, key: String, value: V) {
        let Some(index) = array_index(&key) else {
            self.entries.push((key, value));
            return;
        };
        let place = self
            .entries
            .get(..self.indexed)
            .unwrap_or_default()
            .partition_point(|(k, _)| array_index(k).is_some_and(|n| n < index));
        self.entries.insert(place, (key, value));
        self.indexed = self.indexed.saturating_add(1);
    }

    /// The members of `entries`, in ECMAScript order; `None` when two have
    /// the same name. Time O(n + k log k) for k array-index names.
    pub(crate) fn from_entries(entries: Vec<(String, V)>) -> Option<Self> {
        let unique = {
            let mut seen: HashSet<&str> = HashSet::with_capacity(entries.len());
            entries.iter().all(|(k, _)| seen.insert(k.as_str()))
        };
        unique.then(|| Self::from_unique(entries))
    }

    /// As [`Members::from_entries`], for names the caller knows are unique.
    pub(crate) fn from_unique(entries: Vec<(String, V)>) -> Self {
        let mut indexed: Vec<(u32, (String, V))> = Vec::new();
        let mut named: Vec<(String, V)> = Vec::with_capacity(entries.len());
        for (k, v) in entries {
            match array_index(&k) {
                Some(n) => indexed.push((n, (k, v))),
                None => named.push((k, v)),
            }
        }
        indexed.sort_by_key(|(n, _)| *n);
        let count = indexed.len();
        let mut entries: Vec<(String, V)> = indexed.into_iter().map(|(_, kv)| kv).collect();
        entries.append(&mut named);
        Members {
            entries,
            indexed: count,
        }
    }

    /// `delete object[key]`; the value it had, if any.
    pub(crate) fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.entries.iter().position(|(k, _)| k == key)?;
        if at < self.indexed {
            self.indexed = self.indexed.saturating_sub(1);
        }
        Some(self.entries.remove(at).1)
    }

    pub(crate) fn get(&self, key: &str) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}
