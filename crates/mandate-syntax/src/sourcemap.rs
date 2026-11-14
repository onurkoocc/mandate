//! The table from JSON Pointers into the IR to the spans of text they came
//! from: the `Map<string, Span>` that `sourceMap` in
//! `compiler/src/ir/sourcemap.ts` makes and `load` returns.

use std::collections::{BTreeMap, HashMap};

use mandate_ir::Span;

/// JSON Pointer → span, in the order the entries were made, as a
/// JavaScript `Map` iterates them.
///
/// [`crate::parse_mdt`] makes the entries depth first, an object before its
/// members (the walk of `sourceMap`). The phases after the parser look a
/// pointer up ([`SourceMap::get`]); none reads the order, but it is kept, so
/// that a table compares entry for entry with the TypeScript one.
#[derive(Clone, Debug, Default)]
pub struct SourceMap {
    entries: Vec<(String, Span)>,
    places: HashMap<String, usize>,
}

impl SourceMap {
    /// An empty table.
    #[must_use]
    pub fn new() -> SourceMap {
        SourceMap::default()
    }

    /// `map.set(pointer, span)`: a pointer already present keeps its place
    /// and takes the new span.
    pub fn insert(&mut self, pointer: impl Into<String>, span: Span) {
        let pointer = pointer.into();
        match self.places.get(&pointer) {
            Some(&at) => {
                if let Some(slot) = self.entries.get_mut(at) {
                    slot.1 = span;
                }
            }
            None => {
                self.places.insert(pointer.clone(), self.entries.len());
                self.entries.push((pointer, span));
            }
        }
    }

    /// The span of `pointer`, when it has an entry.
    #[must_use]
    pub fn get(&self, pointer: &str) -> Option<Span> {
        let at = *self.places.get(pointer)?;
        self.entries.get(at).map(|(_, span)| *span)
    }

    /// The entries, in order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, Span)> {
        self.entries.iter().map(|(p, s)| (p.as_str(), *s))
    }

    /// The number of entries.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether there are none.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl PartialEq for SourceMap {
    /// The same entries in the same order.
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
}

impl Eq for SourceMap {}

impl<K: Into<String>> FromIterator<(K, Span)> for SourceMap {
    /// The table these `set` calls make, in order.
    fn from_iter<I: IntoIterator<Item = (K, Span)>>(iter: I) -> Self {
        let mut map = SourceMap::new();
        for (pointer, span) in iter {
            map.insert(pointer, span);
        }
        map
    }
}

impl From<&SourceMap> for BTreeMap<String, Span> {
    /// The table keyed in Rust's string order, the form
    /// [`mandate_ir::Parsed`] gives the JSON reader's.
    fn from(map: &SourceMap) -> Self {
        map.iter().map(|(p, s)| (p.to_owned(), s)).collect()
    }
}
