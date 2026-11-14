//! Typed views of expressions and call arguments (`Expr` and `Arg` in
//! `compiler/src/ir/types.ts`), in the pattern of [`crate::Program`]: a
//! `Copy` struct that borrows the value, one method per member, and a member
//! that is missing or of another type reads as `None` or as nothing.
//!
//! An expression is an object with an `op`; which other members it has
//! depends on the `op`. The methods are by member name, not by `op`: `name`
//! is the name of a `var` and of a `field`, `items` the items of a `list` and
//! of a `set`. A method that the `op` does not have reads as `None`.

use crate::stmt::{CallSpec, Pattern};
use crate::tags::ExprOp;
use crate::type_expr::TypeExpr;
use crate::value::{Map, Value};
use crate::view::{entries, list, list_given, string};

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

    /// `args` as read, every element included, so that an argument's
    /// index is its index in the IR.
    #[must_use]
    pub fn arg_values(self) -> &'a [Value] {
        list(self.map, "args")
    }

    fn expr(self, key: &str) -> Option<Expr<'a>> {
        self.map.get(key).and_then(Expr::of)
    }

    /// `left` of a `binary`.
    #[must_use]
    pub fn left(self) -> Option<Expr<'a>> {
        self.expr("left")
    }

    /// `right` of a `binary`.
    #[must_use]
    pub fn right(self) -> Option<Expr<'a>> {
        self.expr("right")
    }

    /// `from`: of a `range`, and what an `infer` reads.
    #[must_use]
    pub fn from(self) -> Option<Expr<'a>> {
        self.expr("from")
    }

    /// `to`: of a `range`, and whom an `escalate` asks.
    #[must_use]
    pub fn to(self) -> Option<Expr<'a>> {
        self.expr("to")
    }

    /// `type` of a `record`: the name of its type.
    #[must_use]
    pub fn record_type(self) -> Option<&'a str> {
        string(self.map, "type")
    }

    /// `type` of an `infer`: a type expression.
    #[must_use]
    pub fn type_expr(self) -> Option<TypeExpr<'a>> {
        self.map.get("type").and_then(TypeExpr::of)
    }

    /// `fields` of a `record`, by name, in the order of the object.
    pub fn fields(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        entries(self.map, "fields")
    }

    /// `using` of an `infer`.
    #[must_use]
    pub fn using(self) -> Option<Expr<'a>> {
        self.expr("using")
    }

    /// `agent` of a `delegate`, `spawn` or `plan`.
    #[must_use]
    pub fn agent(self) -> Option<&'a str> {
        string(self.map, "agent")
    }

    /// `skill` of a `delegate`, `spawn` or `plan`.
    #[must_use]
    pub fn skill(self) -> Option<&'a str> {
        string(self.map, "skill")
    }

    /// `caps` of a `delegate` or a `map`, when there, every element
    /// included.
    #[must_use]
    pub fn caps(self) -> Option<&'a [Value]> {
        list_given(self.map, "caps")
    }

    /// `timeout` of a `delegate`.
    #[must_use]
    pub fn timeout(self) -> Option<Expr<'a>> {
        self.expr("timeout")
    }

    /// `supervise` of a `delegate` or a `map`.
    #[must_use]
    pub fn supervise(self) -> Option<CallSpec<'a>> {
        self.map.get("supervise").and_then(CallSpec::of)
    }

    /// `contract` of a `verify`.
    #[must_use]
    pub fn contract(self) -> Option<&'a str> {
        string(self.map, "contract")
    }

    /// `value` as an expression: what a `verify` checks.
    #[must_use]
    pub fn value_expr(self) -> Option<Expr<'a>> {
        self.expr("value")
    }

    /// `on_unmet` of a `verify`.
    #[must_use]
    pub fn on_unmet(self) -> Option<OnUnmet<'a>> {
        self.map
            .get("on_unmet")
            .and_then(Value::as_object)
            .map(|map| OnUnmet { map })
    }

    /// `idempotent_by` of an `effect` or a `changeset`.
    #[must_use]
    pub fn idempotent_by(self) -> Option<Expr<'a>> {
        self.expr("idempotent_by")
    }

    /// `compensate` of an `effect`.
    #[must_use]
    pub fn compensate(self) -> Option<&'a str> {
        string(self.map, "compensate")
    }

    /// `plan` of a `changeset`.
    #[must_use]
    pub fn plan(self) -> Option<Expr<'a>> {
        self.expr("plan")
    }

    /// `members` of a `changeset`, by component, in the order of the object.
    pub fn changeset_members(self) -> impl Iterator<Item = (&'a str, ChangesetMember<'a>)> {
        entries(self.map, "members")
            .filter_map(|(name, v)| v.as_object().map(|map| (name, ChangesetMember { map })))
    }

    /// `changes` of a `changeset`: by interface, the kind of change.
    pub fn changes(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        entries(self.map, "changes")
    }

    /// `approver` of a `changeset`.
    #[must_use]
    pub fn approver(self) -> Option<&'a str> {
        string(self.map, "approver")
    }

    /// `over` of a `map`.
    #[must_use]
    pub fn over(self) -> Option<Expr<'a>> {
        self.expr("over")
    }

    /// `bind` of a `map`.
    #[must_use]
    pub fn bind(self) -> Option<&'a str> {
        string(self.map, "bind")
    }

    /// `body` of a `map` or a `block`: statements, every element included.
    #[must_use]
    pub fn body(self) -> &'a [Value] {
        list(self.map, "body")
    }

    /// `then` of a `pause`.
    #[must_use]
    pub fn then(self) -> Option<Expr<'a>> {
        self.expr("then")
    }

    /// `on` of a `switch`.
    #[must_use]
    pub fn on(self) -> Option<Expr<'a>> {
        self.expr("on")
    }

    /// `cases` of a `switch`, in order; the ones that are not objects are
    /// left out.
    pub fn cases(self) -> impl Iterator<Item = SwitchCase<'a>> {
        list(self.map, "cases")
            .iter()
            .filter_map(|c| c.as_object().map(|map| SwitchCase { map }))
    }

    /// `parts` of a `template` or a `prompt`, every element included: each
    /// is `{ text }` or `{ expr }`.
    #[must_use]
    pub fn parts(self) -> &'a [Value] {
        list(self.map, "parts")
    }
}

/// What a `verify` does when the contract is not met: `{ bind, then }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OnUnmet<'a> {
    map: &'a Map,
}

impl<'a> OnUnmet<'a> {
    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `bind`.
    #[must_use]
    pub fn bind(self) -> Option<&'a str> {
        string(self.map, "bind")
    }

    /// `then`.
    #[must_use]
    pub fn then(self) -> Option<Expr<'a>> {
        self.map.get("then").and_then(Expr::of)
    }
}

/// One case of a `switch`: `{ pattern, then }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwitchCase<'a> {
    map: &'a Map,
}

impl<'a> SwitchCase<'a> {
    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `pattern`.
    #[must_use]
    pub fn pattern(self) -> Option<Pattern<'a>> {
        self.map.get("pattern").and_then(Pattern::of)
    }

    /// `then`.
    #[must_use]
    pub fn then(self) -> Option<Expr<'a>> {
        self.map.get("then").and_then(Expr::of)
    }
}

/// One member of a `changeset`: `{ effect, args, approver? }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChangesetMember<'a> {
    map: &'a Map,
}

impl<'a> ChangesetMember<'a> {
    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `effect`.
    #[must_use]
    pub fn effect(self) -> Option<&'a str> {
        string(self.map, "effect")
    }

    /// `args`, every element included.
    #[must_use]
    pub fn arg_values(self) -> &'a [Value] {
        list(self.map, "args")
    }

    /// `approver`.
    #[must_use]
    pub fn approver(self) -> Option<&'a str> {
        string(self.map, "approver")
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
