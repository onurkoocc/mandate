//! Typed views of statements, patterns and named calls (`Stmt`, `Pattern`
//! and `CallSpec` in `compiler/src/ir/types.ts`), in the pattern of
//! [`crate::Program`].
//!
//! As with [`crate::Expr`], the methods are by member name, not by `op`.
//! Where one member name holds different things in different statements,
//! there is a method for each: `then` is a block in `if` and an expression
//! in `on_error` ([`Stmt::then_block`], [`Stmt::then_expr`]).

use crate::expr::Expr;
use crate::tags::{PatternKind, StmtOp};
use crate::type_expr::TypeExpr;
use crate::value::{Map, Value};
use crate::view::{entries, list, list_given, string};

/// One statement: an object with an `op`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stmt<'a> {
    map: &'a Map,
}

impl<'a> Stmt<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Stmt<'a>> {
        v.as_object().map(|map| Stmt { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `op`, when it is one the schema has.
    #[must_use]
    pub fn op(self) -> Option<StmtOp> {
        self.map.get("op").and_then(StmtOp::from_value)
    }

    /// `name`: of a `let`.
    #[must_use]
    pub fn name(self) -> Option<&'a str> {
        string(self.map, "name")
    }

    /// `type`: of a `let`.
    #[must_use]
    pub fn type_expr(self) -> Option<TypeExpr<'a>> {
        self.map.get("type").and_then(TypeExpr::of)
    }

    /// `value`: of a `let`, a `return` and an `expr`.
    #[must_use]
    pub fn value(self) -> Option<Expr<'a>> {
        self.map.get("value").and_then(Expr::of)
    }

    /// `branches` of a `par`, by name, in the order of the object.
    pub fn branches(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        entries(self.map, "branches")
    }

    /// `supervise` of a `par`.
    #[must_use]
    pub fn supervise(self) -> Option<CallSpec<'a>> {
        self.map.get("supervise").and_then(CallSpec::of)
    }

    /// `cond` of an `if`.
    #[must_use]
    pub fn cond(self) -> Option<Expr<'a>> {
        self.map.get("cond").and_then(Expr::of)
    }

    /// `then` of an `if`: its statements, every element included.
    #[must_use]
    pub fn then_block(self) -> &'a [Value] {
        list(self.map, "then")
    }

    /// `else` of an `if`, when there.
    #[must_use]
    pub fn else_block(self) -> Option<&'a [Value]> {
        list_given(self.map, "else")
    }

    /// `until` of a `loop`.
    #[must_use]
    pub fn until(self) -> Option<Expr<'a>> {
        self.map.get("until").and_then(Expr::of)
    }

    /// `max_iter` of a `loop`.
    #[must_use]
    pub fn max_iter(self) -> Option<i64> {
        self.map.get("max_iter").and_then(Value::as_i64)
    }

    /// `body` of a `loop`: its statements, every element included.
    #[must_use]
    pub fn body(self) -> &'a [Value] {
        list(self.map, "body")
    }

    /// `pattern` of an `on_error`.
    #[must_use]
    pub fn pattern(self) -> Option<Pattern<'a>> {
        self.map.get("pattern").and_then(Pattern::of)
    }

    /// `then` of an `on_error`: an expression.
    #[must_use]
    pub fn then_expr(self) -> Option<Expr<'a>> {
        self.map.get("then").and_then(Expr::of)
    }

    /// `target` of a `run`.
    #[must_use]
    pub fn target(self) -> Option<Expr<'a>> {
        self.map.get("target").and_then(Expr::of)
    }

    /// `expect` of a `run`.
    #[must_use]
    pub fn expect(self) -> Option<&'a str> {
        string(self.map, "expect")
    }
}

/// One pattern: `{ p: "wild" }`, `{ p: "bind", name }` or
/// `{ p: "tag", tag, args? }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pattern<'a> {
    map: &'a Map,
}

impl<'a> Pattern<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Pattern<'a>> {
        v.as_object().map(|map| Pattern { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `p`, when it is one the schema has.
    #[must_use]
    pub fn kind(self) -> Option<PatternKind> {
        self.map.get("p").and_then(PatternKind::from_value)
    }

    /// `name` of a `bind`.
    #[must_use]
    pub fn name(self) -> Option<&'a str> {
        string(self.map, "name")
    }

    /// `tag` of a `tag`.
    #[must_use]
    pub fn tag(self) -> Option<&'a str> {
        string(self.map, "tag")
    }

    /// `args` of a `tag`: patterns, every element included.
    #[must_use]
    pub fn args(self) -> &'a [Value] {
        list(self.map, "args")
    }
}

/// A call by name with arguments: `CallSpec`, `{ name, args? }`, as a
/// `supervise` is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CallSpec<'a> {
    map: &'a Map,
}

impl<'a> CallSpec<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<CallSpec<'a>> {
        v.as_object().map(|map| CallSpec { map })
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

    /// `args`: arguments, every element included; none when missing.
    #[must_use]
    pub fn args(self) -> &'a [Value] {
        list(self.map, "args")
    }
}
