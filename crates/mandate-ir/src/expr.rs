//! Typed views of expressions and call arguments (`Expr` and `Arg` in
//! `compiler/src/ir/types.ts`), in the pattern of [`crate::Program`]: a
//! `Copy` struct that borrows the value, one method per member, and a member
//! that is missing or of another type reads as `None` or as nothing.
//!
//! An expression is an object with an `op`; which other members it has
//! depends on the `op`. The methods are by member name, not by `op`: `name`
//! is the name of a `var` and of a `field`, `items` the items of a `list` and
//! of a `set`. A method that the `op` does not have reads as `None`.

use crate::tags::ExprOp;
use crate::value::{Map, Value};

/// One expression: an object with an `op`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Expr<'a> {
    map: &'a Map,
}

impl<'a> Expr<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Expr<'a>> {
        v.as_object().map(|map| Expr { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// The member `key`, as read.
    #[must_use]
    pub fn get(self, key: &str) -> Option<&'a Value> {
        self.map.get(key)
    }

    /// `op`, when it is one the schema has.
    #[must_use]
    pub fn op(self) -> Option<ExprOp> {
        self.map.get("op").and_then(ExprOp::from_value)
    }

    /// Whether `op` is `op`: `e.op === "…"`.
    #[must_use]
    pub fn is(self, op: ExprOp) -> bool {
        self.op() == Some(op)
    }

    /// `name`: of a `var`, and the member a `field` reads.
    #[must_use]
    pub fn name(self) -> Option<&'a str> {
        self.map.get("name").and_then(Value::as_str)
    }

    /// `value`, as read: a number for `int`, a string for `text` and `dec`,
    /// a boolean for `bool`, an expression for others.
    #[must_use]
    pub fn value(self) -> Option<&'a Value> {
        self.map.get("value")
    }

    /// `value` when it is a string: the text of a `text` (and of a `dec`).
    #[must_use]
    pub fn text(self) -> Option<&'a str> {
        self.value().and_then(Value::as_str)
    }

    /// `items` of a `list` or a `set`, as read, every element included,
    /// so that an element's index is its index in the IR.
    #[must_use]
    pub fn item_values(self) -> &'a [Value] {
        self.map
            .get("items")
            .and_then(Value::as_array)
            .unwrap_or_default()
    }

    /// `items` of a `list` or a `set`, in order; the ones that are not
    /// objects are left out.
    pub fn items(self) -> impl Iterator<Item = Expr<'a>> {
        self.item_values().iter().filter_map(Expr::of)
    }

    /// `of`: the expression a `field`, `unary`, `await` or `try` applies to.
    #[must_use]
    pub fn operand(self) -> Option<Expr<'a>> {
        self.map.get("of").and_then(Expr::of)
    }

    /// `callee` of a `call`.
    #[must_use]
    pub fn callee(self) -> Option<Expr<'a>> {
        self.map.get("callee").and_then(Expr::of)
    }

    /// `args` of a `call` (and of `delegate`, `spawn`, `verify`, `effect`),
    /// in order; the ones that are not objects are left out.
    pub fn args(self) -> impl Iterator<Item = Arg<'a>> {
        self.map
            .get("args")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(|a| a.as_object().map(|map| Arg { map }))
    }
}

/// One argument of a call: `{ name?, value }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Arg<'a> {
    map: &'a Map,
}

impl<'a> Arg<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Arg<'a>> {
        v.as_object().map(|map| Arg { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `name`; a positional argument has none.
    #[must_use]
    pub fn name(self) -> Option<&'a str> {
        self.map.get("name").and_then(Value::as_str)
    }

    /// `value`.
    #[must_use]
    pub fn value(self) -> Option<Expr<'a>> {
        self.map.get("value").and_then(Expr::of)
    }
}
