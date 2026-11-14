//! Typed views of the parts of definitions (`Skill`, `RemoteBinding`,
//! `Envelope`, `OnHandler`, `Criterion`, `Verifier`, `ReadSource`, `Tier`
//! and `TestDef` in `compiler/src/ir/types.ts`), in the pattern of
//! [`crate::Program`].

use crate::expr::Expr;
use crate::tags::{TierBy, VerifierForm};
use crate::type_expr::TypeExpr;
use crate::value::{Map, Value};
use crate::view::{entries, list, list_given, string};

/// One skill of an agent: `{ params, returns, effects, budget?, body? }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Skill<'a> {
    map: &'a Map,
}

impl<'a> Skill<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Skill<'a>> {
        v.as_object().map(|map| Skill { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `params`, every element included.
    #[must_use]
    pub fn params(self) -> &'a [Value] {
        list(self.map, "params")
    }

    /// `returns`.
    #[must_use]
    pub fn returns(self) -> Option<TypeExpr<'a>> {
        self.map.get("returns").and_then(TypeExpr::of)
    }

    /// `body`, when there: statements, every element included.
    #[must_use]
    pub fn body(self) -> Option<&'a [Value]> {
        list_given(self.map, "body")
    }
}

/// A remote agent's binding: `RemoteBinding`, `{ bind, version?, require?,
/// trust? }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Remote<'a> {
    map: &'a Map,
}

impl<'a> Remote<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Remote<'a>> {
        v.as_object().map(|map| Remote { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `bind`.
    #[must_use]
    pub fn bind(self) -> Option<Expr<'a>> {
        self.map.get("bind").and_then(Expr::of)
    }

    /// `require`, every element included; none when missing.
    #[must_use]
    pub fn require(self) -> &'a [Value] {
        list(self.map, "require")
    }
}

/// A workflow's envelope (0.4): `{ owner?, caps?, budget?, spawn?, approve? }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Envelope<'a> {
    map: &'a Map,
}

impl<'a> Envelope<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Envelope<'a>> {
        v.as_object().map(|map| Envelope { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `owner`: the role that owns it.
    #[must_use]
    pub fn owner(self) -> Option<&'a str> {
        string(self.map, "owner")
    }

    /// `caps`, when there, every element included.
    #[must_use]
    pub fn caps(self) -> Option<&'a [Value]> {
        list_given(self.map, "caps")
    }

    /// `approve`: by effect, the role that approves it.
    pub fn approve(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        entries(self.map, "approve")
    }
}

/// A workflow's handler: `OnHandler`, `{ event, then }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OnHandler<'a> {
    map: &'a Map,
}

impl<'a> OnHandler<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<OnHandler<'a>> {
        v.as_object().map(|map| OnHandler { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `event`.
    #[must_use]
    pub fn event(self) -> Option<&'a str> {
        string(self.map, "event")
    }

    /// `then`.
    #[must_use]
    pub fn then(self) -> Option<Expr<'a>> {
        self.map.get("then").and_then(Expr::of)
    }
}

/// One criterion of a contract: `{ description, by }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Criterion<'a> {
    map: &'a Map,
}

impl<'a> Criterion<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Criterion<'a>> {
        v.as_object().map(|map| Criterion { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `description`.
    #[must_use]
    pub fn description(self) -> Option<&'a str> {
        string(self.map, "description")
    }

    /// `by`.
    #[must_use]
    pub fn by(self) -> Option<Verifier<'a>> {
        self.map.get("by").and_then(Verifier::of)
    }
}

/// A verifier: `{ static }`, `{ call }` or `{ all }`, told apart by which
/// member it has ([`Verifier::has`] is `"all" in v`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Verifier<'a> {
    map: &'a Map,
}

impl<'a> Verifier<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Verifier<'a>> {
        v.as_object().map(|map| Verifier { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// Whether it has the member of `form`.
    #[must_use]
    pub fn has(self, form: VerifierForm) -> bool {
        self.map.contains_key(form.as_str())
    }

    /// `all`: verifiers, every element included.
    #[must_use]
    pub fn all(self) -> &'a [Value] {
        list(self.map, "all")
    }

    /// `static`.
    #[must_use]
    pub fn static_expr(self) -> Option<Expr<'a>> {
        self.map.get("static").and_then(Expr::of)
    }

    /// `call`.
    #[must_use]
    pub fn call(self) -> Option<Expr<'a>> {
        self.map.get("call").and_then(Expr::of)
    }
}

/// One declared read of an environment: `ReadSource` in `types.ts`,
/// `{ from, query, params, returns, max_rows }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Read<'a> {
    map: &'a Map,
}

impl<'a> Read<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Read<'a>> {
        v.as_object().map(|map| Read { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `from`: the component it reads.
    #[must_use]
    pub fn from(self) -> Option<&'a str> {
        string(self.map, "from")
    }

    /// `query`, as read: `{ sql }` or `{ logs }`.
    #[must_use]
    pub fn query(self) -> Option<&'a Map> {
        self.map.get("query").and_then(Value::as_object)
    }

    /// `query.logs`: the filter of a log read.
    #[must_use]
    pub fn logs(self) -> Option<Expr<'a>> {
        self.query().and_then(|q| q.get("logs")).and_then(Expr::of)
    }

    /// `params`, every element included.
    #[must_use]
    pub fn params(self) -> &'a [Value] {
        list(self.map, "params")
    }

    /// `returns`.
    #[must_use]
    pub fn returns(self) -> Option<TypeExpr<'a>> {
        self.map.get("returns").and_then(TypeExpr::of)
    }
}

/// An authorization tier: `{ by: "policy" }` or `{ by: "human", role }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tier<'a> {
    map: &'a Map,
}

impl<'a> Tier<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Tier<'a>> {
        v.as_object().map(|map| Tier { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `by`, when it is one the schema has.
    #[must_use]
    pub fn by(self) -> Option<TierBy> {
        self.map.get("by").and_then(TierBy::from_value)
    }

    /// `role`, of a human tier.
    #[must_use]
    pub fn role(self) -> Option<&'a str> {
        string(self.map, "role")
    }
}

/// One test of a program: `TestDef`, `{ handlers?, body }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TestDef<'a> {
    map: &'a Map,
}

impl<'a> TestDef<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<TestDef<'a>> {
        v.as_object().map(|map| TestDef { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `handlers`, by name, in the order of the object.
    pub fn handlers(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        entries(self.map, "handlers")
    }

    /// `body`: statements, every element included.
    #[must_use]
    pub fn body(self) -> &'a [Value] {
        list(self.map, "body")
    }
}
