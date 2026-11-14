//! Typed views of a program, over the [`Value`] it was read to.
//!
//! The pattern, for the views later phases add: a view is a `Copy` struct
//! that borrows the value (`&'a Map` or `&'a Value`) and has one method per
//! member, which reads it and converts it (a tag to its enum, a list to an
//! iterator of views). A member that is missing, or of another type than the
//! schema says, reads as `None` or as an empty iterator: a view never panics,
//! so it can be used on a value that was not validated. After
//! [`crate::load_json`] gave a program, every member the schema requires is
//! there. A view copies nothing: the value stays the one the hashes and the
//! spans are of.

use crate::tags::{DefKind, Language};
use crate::value::{Map, Value};

/// A program: the top of the IR.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Program<'a> {
    map: &'a Map,
}

impl<'a> Program<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Program<'a>> {
        v.as_object().map(|map| Program { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `language`, when it is one this compiler reads.
    #[must_use]
    pub fn language(self) -> Option<Language> {
        self.map.get("language").and_then(Language::from_value)
    }

    /// `module`.
    #[must_use]
    pub fn module(self) -> Option<&'a str> {
        self.map.get("module").and_then(Value::as_str)
    }

    /// `version`.
    #[must_use]
    pub fn version(self) -> Option<&'a str> {
        self.map.get("version").and_then(Value::as_str)
    }

    /// The imports (`uses`), in order; the ones that are not objects are
    /// left out.
    pub fn imports(self) -> impl Iterator<Item = Import<'a>> {
        self.map
            .get("uses")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(|u| u.as_object().map(|map| Import { map }))
    }

    /// The definitions (`defs`), by name, in the order of the object.
    pub fn definitions(self) -> impl Iterator<Item = (&'a str, Definition<'a>)> {
        self.map
            .get("defs")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(Map::iter)
            .map(|(name, value)| (name, Definition { value }))
    }

    /// The definition `name`.
    #[must_use]
    pub fn definition(self, name: &str) -> Option<Definition<'a>> {
        self.map
            .get("defs")
            .and_then(|defs| defs.get(name))
            .map(|value| Definition { value })
    }
}

/// One import: `{ module, names? }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Import<'a> {
    map: &'a Map,
}

impl<'a> Import<'a> {
    /// `module`.
    #[must_use]
    pub fn module(self) -> Option<&'a str> {
        self.map.get("module").and_then(Value::as_str)
    }

    /// `names`, in order; an import without `names` imports none by name.
    pub fn names(self) -> impl Iterator<Item = &'a str> {
        self.map
            .get("names")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
    }
}

/// One definition. It may be any value in a program that was not
/// validated, so the view holds the value, not an object.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Definition<'a> {
    value: &'a Value,
}

impl<'a> Definition<'a> {
    /// The value, as read.
    #[must_use]
    pub fn value(self) -> &'a Value {
        self.value
    }

    /// The members, when the definition is an object.
    #[must_use]
    pub fn members(self) -> Option<&'a Map> {
        self.value.as_object()
    }

    /// `kind`, when it is one the schema has.
    #[must_use]
    pub fn kind(self) -> Option<DefKind> {
        self.value.get("kind").and_then(DefKind::from_value)
    }
}
