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

use crate::def_parts::{Envelope, Remote};
use crate::expr::Expr;
use crate::tags::{DefKind, Language};
use crate::type_expr::TypeExpr;
use crate::value::{Map, Value};
use crate::view::{entries, list, list_given};

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

    /// `defs`, as read: the table of definitions by name.
    #[must_use]
    pub fn defs(self) -> Option<&'a Map> {
        self.map.get("defs").and_then(Value::as_object)
    }

    /// `uses`, as read, every element included, so that an import's index
    /// is its index in the IR.
    #[must_use]
    pub fn use_values(self) -> &'a [Value] {
        list(self.map, "uses")
    }

    /// `tests`, by name, in the order of the object.
    pub fn tests(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        entries(self.map, "tests")
    }
}

/// One import: `{ module, names? }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Import<'a> {
    map: &'a Map,
}

impl<'a> Import<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Import<'a>> {
        v.as_object().map(|map| Import { map })
    }

    /// `names` when it is there (an empty list is there, and is truthy in
    /// TypeScript: `if (u.names)`), every element included.
    #[must_use]
    pub fn names_given(self) -> Option<&'a [Value]> {
        list_given(self.map, "names")
    }

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
    /// The view of the definition whose value is `value`.
    #[must_use]
    pub fn of(value: &'a Value) -> Definition<'a> {
        Definition { value }
    }

    fn get(self, key: &str) -> Option<&'a Value> {
        self.value.get(key)
    }

    fn list(self, key: &str) -> &'a [Value] {
        self.value.as_object().map_or(&[], |m| list(m, key))
    }

    fn list_given(self, key: &str) -> Option<&'a [Value]> {
        self.value.as_object().and_then(|m| list_given(m, key))
    }

    fn entries(self, key: &str) -> impl Iterator<Item = (&'a str, &'a Value)> {
        self.value
            .as_object()
            .into_iter()
            .flat_map(move |m| entries(m, key))
    }

    /// `generics` of a `type`: the names of its type parameters.
    pub fn generics(self) -> impl Iterator<Item = &'a str> {
        self.list("generics").iter().filter_map(Value::as_str)
    }

    /// `type` of a `type` or a `const`.
    #[must_use]
    pub fn type_expr(self) -> Option<TypeExpr<'a>> {
        self.get("type").and_then(TypeExpr::of)
    }

    /// `value` of a `capability` or a `const`: an expression.
    #[must_use]
    pub fn value_expr(self) -> Option<Expr<'a>> {
        self.get("value").and_then(Expr::of)
    }

    /// `params` of a `fn`, `extern`, `effect`, `workflow` or `contract`,
    /// every element included.
    #[must_use]
    pub fn params(self) -> &'a [Value] {
        self.list("params")
    }

    /// `returns`.
    #[must_use]
    pub fn returns(self) -> Option<TypeExpr<'a>> {
        self.get("returns").and_then(TypeExpr::of)
    }

    /// `body` of a `fn` or a `workflow`: statements, every element included.
    #[must_use]
    pub fn body(self) -> &'a [Value] {
        self.list("body")
    }

    /// `idempotent_by` of an `extern`.
    #[must_use]
    pub fn idempotent_by(self) -> Option<Expr<'a>> {
        self.get("idempotent_by").and_then(Expr::of)
    }

    /// `requires_caps` of an `effect`, every element included.
    #[must_use]
    pub fn requires_caps(self) -> &'a [Value] {
        self.list("requires_caps")
    }

    /// `compensation` of an `effect`: the effect that undoes it.
    #[must_use]
    pub fn compensation(self) -> Option<&'a str> {
        self.get("compensation").and_then(Value::as_str)
    }

    /// `remote` of an `agent`.
    #[must_use]
    pub fn remote(self) -> Option<Remote<'a>> {
        self.get("remote").and_then(Remote::of)
    }

    /// `caps` of an `agent` or a `workflow`, every element included.
    #[must_use]
    pub fn caps(self) -> &'a [Value] {
        self.list("caps")
    }

    /// `skills` of an `agent`, by name, in the order of the object.
    pub fn skills(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        self.entries("skills")
    }

    /// The skill `name` of an `agent`: `Object.hasOwn(agent.skills, name)`.
    #[must_use]
    pub fn skill(self, name: &str) -> Option<&'a Value> {
        self.get("skills").and_then(|s| s.get(name))
    }

    /// `envelope` of a `workflow`.
    #[must_use]
    pub fn envelope(self) -> Option<Envelope<'a>> {
        self.get("envelope").and_then(Envelope::of)
    }

    /// `ensures` of a `workflow`.
    #[must_use]
    pub fn ensures(self) -> Option<Expr<'a>> {
        self.get("ensures").and_then(Expr::of)
    }

    /// `on` of a `workflow`: its handlers, every element included.
    #[must_use]
    pub fn on(self) -> &'a [Value] {
        self.list("on")
    }

    /// `require` of a `contract`, every element included.
    #[must_use]
    pub fn require(self) -> &'a [Value] {
        self.list("require")
    }

    /// `accept` of a `contract`: its criteria by name.
    pub fn accept(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        self.entries("accept")
    }

    /// `invariant` of a `contract`: its criteria by name.
    pub fn invariant(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        self.entries("invariant")
    }

    /// `provides` of a `component`, when there, every element included.
    #[must_use]
    pub fn provides(self) -> Option<&'a [Value]> {
        self.list_given("provides")
    }

    /// `consumes` of a `component`, when there, every element included.
    #[must_use]
    pub fn consumes(self) -> Option<&'a [Value]> {
        self.list_given("consumes")
    }

    /// `owner` of a `component`.
    #[must_use]
    pub fn owner(self) -> Option<&'a str> {
        self.get("owner").and_then(Value::as_str)
    }

    /// `reads` of an `environment`, by name, in the order of the object.
    pub fn reads(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        self.entries("reads")
    }

    /// `authorize` of an `environment`: by effect, its tier.
    pub fn authorize(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        self.entries("authorize")
    }

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
