//! Typed views of types, parameters and variants (`TypeExpr`, `Param` and
//! `Variant` in `compiler/src/ir/types.ts`), in the pattern of
//! [`crate::Program`].
//!
//! A type is an object told apart by which member it has (`ref`, `record`,
//! `enum`, `union`, `refine`): [`TypeExpr::has`] is TypeScript's `"ref" in
//! t`, and the methods read the members of each form.

use crate::expr::Expr;
use crate::tags::TypeForm;
use crate::value::{Map, Value};
use crate::view::{entries, list, list_given, string, strings};

/// One type expression.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TypeExpr<'a> {
    map: &'a Map,
}

impl<'a> TypeExpr<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<TypeExpr<'a>> {
        v.as_object().map(|map| TypeExpr { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// Whether it has the member that makes the form `form`: `"ref" in t`.
    #[must_use]
    pub fn has(self, form: TypeForm) -> bool {
        self.map.contains_key(form.as_str())
    }

    /// The form: the first of [`TypeForm::ALL`] whose member it has.
    #[must_use]
    pub fn form(self) -> Option<TypeForm> {
        TypeForm::ALL.iter().copied().find(|f| self.has(*f))
    }

    /// `ref`: the name a reference names.
    #[must_use]
    pub fn ref_name(self) -> Option<&'a str> {
        string(self.map, "ref")
    }

    /// `args` of a reference, when there (an empty list is there), every
    /// element included.
    #[must_use]
    pub fn args(self) -> Option<&'a [Value]> {
        list_given(self.map, "args")
    }

    /// `record`: the fields by name, in the order of the object.
    pub fn record(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        entries(self.map, "record")
    }

    /// `enum`: the tags, in order.
    pub fn enum_tags(self) -> impl Iterator<Item = &'a str> {
        strings(self.map, "enum")
    }

    /// `union`: the variants, every element included.
    #[must_use]
    pub fn union(self) -> &'a [Value] {
        list(self.map, "union")
    }

    /// `refine`: the type refined.
    #[must_use]
    pub fn refine(self) -> Option<TypeExpr<'a>> {
        self.map.get("refine").and_then(TypeExpr::of)
    }

    /// `where`: the condition of a refinement.
    #[must_use]
    pub fn where_expr(self) -> Option<Expr<'a>> {
        self.map.get("where").and_then(Expr::of)
    }
}

/// One parameter: `{ name, type }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Param<'a> {
    map: &'a Map,
}

impl<'a> Param<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Param<'a>> {
        v.as_object().map(|map| Param { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `name`.
    #[must_use]
    pub fn name(self) -> Option<&'a str> {
        string(self.map, "name")
    }

    /// `type`.
    #[must_use]
    pub fn type_expr(self) -> Option<TypeExpr<'a>> {
        self.map.get("type").and_then(TypeExpr::of)
    }
}

/// One variant of a union: `{ tag, fields? }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Variant<'a> {
    map: &'a Map,
}

impl<'a> Variant<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Variant<'a>> {
        v.as_object().map(|map| Variant { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `tag`.
    #[must_use]
    pub fn tag(self) -> Option<&'a str> {
        string(self.map, "tag")
    }

    /// `fields`: parameters, every element included; none when missing.
    #[must_use]
    pub fn fields(self) -> &'a [Value] {
        list(self.map, "fields")
    }
}
