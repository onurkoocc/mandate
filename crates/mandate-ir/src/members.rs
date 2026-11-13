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
//! The cost. An object of [`INDEXED_FROM`] members or more also keeps each
//! name's place in a hash map, so looking a member up, assigning one and
//! appending a new name take constant time, however large the object (one
//! read from a 1 MiB input has some 100,000). Assigning a new array-index
//! name before others and deleting a member move the members after it, and
//! their places, as a `Vec` does. Building from a list sorts its
//! array-index names once.

use std::collections::{HashMap, HashSet};
use std::fmt;

/// The size from which an object keeps the places of its names.
const INDEXED_FROM: usize = 16;

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
#[derive(Clone)]
pub(crate) struct Members<V> {
    entries: Vec<(String, V)>,
    /// How many of the first entries have array-index names.
    indexed: usize,
    /// Each name's place in `entries`, once there are `INDEXED_FROM` of them.
    places: Option<HashMap<String, usize>>,
}

impl<V> Default for Members<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V: PartialEq> PartialEq for Members<V> {
    /// The members in order; the places follow from them.
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
}

impl<V: Eq> Eq for Members<V> {}

impl<V: fmt::Debug> fmt::Debug for Members<V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map()
            .entries(self.entries.iter().map(|(k, v)| (k, v)))
            .finish()
    }
}

impl<V> Members<V> {
    pub(crate) const fn new() -> Self {
        Members {
            entries: Vec::new(),
            indexed: 0,
            places: None,
        }
    }

    /// The place of `key` in `entries`.
    fn place(&self, key: &str) -> Option<usize> {
        match &self.places {
            Some(places) => places.get(key).copied(),
            None => self.entries.iter().position(|(k, _)| k == key),
        }
    }

    /// Keeps the places once the object is large enough.
    fn index_if_large(&mut self) {
        if self.places.is_none() && self.entries.len() >= INDEXED_FROM {
            let places = self
                .entries
                .iter()
                .enumerate()
                .map(|(i, (k, _))| (k.clone(), i))
                .collect();
            self.places = Some(places);
        }
    }

    /// Updates the places of the entries from `from` on, after they moved.
    fn moved_from(&mut self, from: usize) {
        if let Some(places) = &mut self.places {
            for (i, (k, _)) in self.entries.iter().enumerate().skip(from) {
                if let Some(slot) = places.get_mut(k.as_str()) {
                    *slot = i;
                }
            }
        }
    }

    /// Assignment, `object[key] = value`: a present name keeps its place.
    pub(crate) fn insert(&mut self, key: String, value: V) -> Option<V> {
        match self.get_mut(&key) {
            Some(slot) => Some(std::mem::replace(slot, value)),
            None => {
                self.insert_new(key, value);
                None
            }
        }
    }

    /// Adds a name the caller knows is not present.
    fn insert_new(&mut self, key: String, value: V) {
        let place = match array_index(&key) {
            None => self.entries.len(),
            Some(index) => {
                let before = self
                    .entries
                    .get(..self.indexed)
                    .unwrap_or_default()
                    .partition_point(|(k, _)| array_index(k).is_some_and(|n| n < index));
                self.indexed = self.indexed.saturating_add(1);
                before
            }
        };
        if let Some(places) = &mut self.places {
            places.insert(key.clone(), place);
        }
        self.entries.insert(place, (key, value));
        self.moved_from(place.saturating_add(1));
        self.index_if_large();
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

    /// The object these assignments make, in this order: a name assigned
    /// again keeps its first place and takes the last value. In one pass,
    /// with one sort.
    pub(crate) fn from_assignments(items: impl IntoIterator<Item = (String, V)>) -> Self {
        let mut entries: Vec<(String, V)> = Vec::new();
        let mut seen: HashMap<String, usize> = HashMap::new();
        for (k, v) in items {
            match seen.get(&k) {
                Some(&at) => {
                    if let Some(slot) = entries.get_mut(at) {
                        slot.1 = v;
                    }
                }
                None => {
                    seen.insert(k.clone(), entries.len());
                    entries.push((k, v));
                }
            }
        }
        Self::from_unique(entries)
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
        let mut members = Members {
            entries,
            indexed: count,
            places: None,
        };
        members.index_if_large();
        members
    }

    /// `delete object[key]`; the value it had, if any.
    pub(crate) fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.place(key)?;
        if at < self.indexed {
            self.indexed = self.indexed.saturating_sub(1);
        }
        if let Some(places) = &mut self.places {
            places.remove(key);
        }
        let (_, value) = self.entries.remove(at);
        self.moved_from(at);
        Some(value)
    }

    pub(crate) fn get(&self, key: &str) -> Option<&V> {
        let at = self.place(key)?;
        self.entries.get(at).map(|(_, v)| v)
    }

    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        let at = self.place(key)?;
        self.entries.get_mut(at).map(|(_, v)| v)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}
