//! What the checker knows about the standard library: capability
//! constructors, built-in effects (Doc 4 §6.1), the std effects that need a
//! capability, and the signatures of the std functions the examples use. A
//! port of `compiler/src/std/std.ts`.
//!
//! Anything not listed here is still accepted by name resolution, but its
//! type is unknown and contributes no effects, so checks that depend on it
//! pass rather than guess.
//!
//! Every table keeps the TypeScript's order, since where the TypeScript
//! iterates one the order is observable. The TypeScript tables are made
//! without a prototype, so a name such as `toString` is no entry of them;
//! the lookups here ([`cap_ctor`], [`std_effect`], [`std_fn`]) find only the
//! names listed.

use mandate_ir::{JsObject, JsValue, Map, Value};

/// A data class (§5.5), from the least to the most sensitive:
/// `DataClass` and `DATA_CLASSES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DataClass {
    /// `public`.
    Public,
    /// `internal`.
    Internal,
    /// `confidential`.
    Confidential,
    /// `restricted`.
    Restricted,
}

impl DataClass {
    /// Every class, in order: `DATA_CLASSES`.
    pub const ALL: [DataClass; 4] = [
        DataClass::Public,
        DataClass::Internal,
        DataClass::Confidential,
        DataClass::Restricted,
    ];

    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            DataClass::Public => "public",
            DataClass::Internal => "internal",
            DataClass::Confidential => "confidential",
            DataClass::Restricted => "restricted",
        }
    }

    /// The class named `name`, if there is one:
    /// `DATA_CLASSES.includes(name)`.
    #[must_use]
    pub fn from_name(name: &str) -> Option<DataClass> {
        DataClass::ALL.into_iter().find(|c| c.as_str() == name)
    }
}

impl std::fmt::Display for DataClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `DATA_CLASSES`: every data class, from the least to the most sensitive.
pub const DATA_CLASSES: [DataClass; 4] = DataClass::ALL;

/// `classRank(c)`: the place of `c` in [`DATA_CLASSES`].
#[must_use]
pub const fn class_rank(c: DataClass) -> usize {
    match c {
        DataClass::Public => 0,
        DataClass::Internal => 1,
        DataClass::Confidential => 2,
        DataClass::Restricted => 3,
    }
}

/// Built-in effects (§6.1), in order: `BUILTIN_EFFECTS`. `External`
/// effects are named by their declaration, e.g. `git.open_pr`.
pub const BUILTIN_EFFECTS: [&str; 12] = [
    "Fs.Read",
    "Fs.Write",
    "Net",
    "Model",
    "Tool",
    "Exec",
    "Human",
    "Delegate",
    "Spend",
    "Time",
    "Random",
    "Data.Read",
];

/// `BUILTIN_EFFECTS.has(name)`.
#[must_use]
pub fn is_builtin_effect(name: &str) -> bool {
    BUILTIN_EFFECTS.contains(&name)
}

/// Effects that need no capability, in order: `UNGATED_EFFECTS`. Waiting on
/// a person, reading the clock, drawing a random number, delegating.
pub const UNGATED_EFFECTS: [&str; 4] = ["Human", "Time", "Random", "Delegate"];

/// `UNGATED_EFFECTS.has(name)`.
#[must_use]
pub fn is_ungated_effect(name: &str) -> bool {
    UNGATED_EFFECTS.contains(&name)
}

/// How a capability constructor's scope is read from its arguments:
/// `CapCtor["scope"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScopeKind {
    /// `positional`: the positional arguments, each literal text or a list
    /// of it.
    Positional,
    /// `hosts`: the argument `hosts`.
    Hosts,
    /// `commands`: the argument `commands`, and `args_prefix`.
    Commands,
    /// `none`: no scope.
    None,
}

impl ScopeKind {
    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            ScopeKind::Positional => "positional",
            ScopeKind::Hosts => "hosts",
            ScopeKind::Commands => "commands",
            ScopeKind::None => "none",
        }
    }
}

/// A capability constructor: `CapCtor`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CapCtor {
    /// The effect the capability authorizes. External effects use the
    /// namespace, e.g. `git.*`.
    pub effect: &'static str,
    /// True for capabilities that change shared state; these must be
    /// disjoint across `par` branches (C5).
    pub write: bool,
    /// How the scope is read from the arguments.
    pub scope: ScopeKind,
}

impl CapCtor {
    /// The object the TypeScript table holds: `{ effect, write, scope }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new()
            .with("effect", self.effect)
            .with("write", self.write)
            .with("scope", self.scope.as_str())
    }
}

const fn ctor(effect: &'static str, write: bool, scope: ScopeKind) -> CapCtor {
    CapCtor {
        effect,
        write,
        scope,
    }
}

/// The capability constructors by name, in order: `CAP_CTORS`.
/// `data.read` is the declared reads of an environment through the read
/// broker (design doc 9 §5.1), scoped `env.read`; `env.deploy` and
/// `env.migrate` are effects on an environment (design doc 9 §5.3, §9 L4),
/// scoped by environment name.
pub const CAP_CTORS: [(&str, CapCtor); 10] = [
    ("fs.read", ctor("Fs.Read", false, ScopeKind::Positional)),
    ("fs.write", ctor("Fs.Write", true, ScopeKind::Positional)),
    ("net.https", ctor("Net", false, ScopeKind::Hosts)),
    ("model.infer", ctor("Model", false, ScopeKind::None)),
    ("exec", ctor("Exec", false, ScopeKind::Commands)),
    ("git.pr", ctor("git.*", true, ScopeKind::Positional)),
    ("money.spend", ctor("Spend", false, ScopeKind::None)),
    ("data.read", ctor("Data.Read", false, ScopeKind::None)),
    ("env.deploy", ctor("deploy", true, ScopeKind::Positional)),
    ("env.migrate", ctor("migrate", true, ScopeKind::Positional)),
];

/// `CAP_CTORS[name]`.
#[must_use]
pub fn cap_ctor(name: &str) -> Option<&'static CapCtor> {
    CAP_CTORS.iter().find(|(n, _)| *n == name).map(|(_, c)| c)
}

/// Default highest data class a model capability may receive when it does
/// not say (§5.5): `DEFAULT_MODEL_MAX_CLASS`.
pub const DEFAULT_MODEL_MAX_CLASS: DataClass = DataClass::Internal;

/// A type expression of the tables below: `{ ref, args? }` in the IR
/// (`TypeExpr`), as `t(ref, ...args)` in `std.ts` builds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StdType {
    /// `ref`: the type's name; `?` is the unknown type.
    pub reference: &'static str,
    /// `args`; written only when there are some.
    pub args: &'static [StdType],
}

impl StdType {
    /// The IR value: `{ ref, args }`, or `{ ref }` without arguments.
    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("ref", self.reference);
        if !self.args.is_empty() {
            map.insert(
                "args",
                Value::Array(self.args.iter().map(StdType::to_value).collect()),
            );
        }
        Value::Object(map)
    }
}

/// `UNKNOWN`: `{ ref: "?" }`.
pub const UNKNOWN: StdType = StdType {
    reference: "?",
    args: &[],
};

const fn t(reference: &'static str) -> StdType {
    StdType {
        reference,
        args: &[],
    }
}

/// A std effect called with `effect name(…)`: `StdEffect`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StdEffect {
    /// Its parameters' types.
    pub params: &'static [StdType],
    /// Its result's type.
    pub returns: StdType,
    /// Whether it is critical: it expands to prepare → authorize → commit.
    pub critical: bool,
    /// Whether it cannot be undone.
    pub irreversible: bool,
    /// The capability constructor that authorizes it.
    pub cap: &'static str,
    /// The effect that undoes it, offered to a person after a partial
    /// failure (§8.5); never run automatically.
    pub compensation: Option<&'static str>,
}

impl StdEffect {
    /// The object the TypeScript table holds:
    /// `{ params, returns, critical?, irreversible?, cap, compensation? }`,
    /// `critical` and `irreversible` only when true.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let params: Vec<JsValue> = self.params.iter().map(|p| (&p.to_value()).into()).collect();
        JsObject::new()
            .with("params", params)
            .with("returns", &self.returns.to_value())
            .with_some("critical", self.critical.then_some(true))
            .with_some("irreversible", self.irreversible.then_some(true))
            .with("cap", self.cap)
            .with_some("compensation", self.compensation)
    }
}

const VERIFIED_UNKNOWN: StdType = StdType {
    reference: "Verified",
    args: &[UNKNOWN],
};
const RECEIPT_UNKNOWN: StdType = StdType {
    reference: "Receipt",
    args: &[UNKNOWN],
};

const fn critical(params: &'static [StdType], returns: StdType, cap: &'static str) -> StdEffect {
    StdEffect {
        params,
        returns,
        critical: true,
        irreversible: false,
        cap,
        compensation: None,
    }
}

const fn irreversible(
    params: &'static [StdType],
    returns: StdType,
    cap: &'static str,
    compensation: Option<&'static str>,
) -> StdEffect {
    StdEffect {
        params,
        returns,
        critical: true,
        irreversible: true,
        cap,
        compensation,
    }
}

/// Std effects called with `effect name(…)`, in order: `STD_EFFECTS`.
/// Critical ones expand to prepare → authorize → commit. `deploy` and
/// `migrate` are a release of a component's verified change into an
/// environment, and a schema migration there (doc 9 §9, L4).
pub const STD_EFFECTS: [(&str, StdEffect); 8] = [
    (
        "git.open_pr",
        critical(&[VERIFIED_UNKNOWN], UNKNOWN, "git.pr"),
    ),
    ("git.close_pr", critical(&[UNKNOWN], UNKNOWN, "git.pr")),
    (
        "git.comment",
        critical(&[UNKNOWN, t("Text")], UNKNOWN, "git.pr"),
    ),
    (
        "git.merge",
        irreversible(&[VERIFIED_UNKNOWN], UNKNOWN, "git.pr", Some("git.revert")),
    ),
    ("git.revert", critical(&[UNKNOWN], UNKNOWN, "git.pr")),
    (
        "money.spend",
        critical(&[t("Money")], RECEIPT_UNKNOWN, "money.spend"),
    ),
    (
        "deploy",
        irreversible(
            &[VERIFIED_UNKNOWN, UNKNOWN],
            RECEIPT_UNKNOWN,
            "env.deploy",
            None,
        ),
    ),
    (
        "migrate",
        irreversible(
            &[VERIFIED_UNKNOWN, UNKNOWN],
            RECEIPT_UNKNOWN,
            "env.migrate",
            None,
        ),
    ),
];

/// `STD_EFFECTS[name]`.
#[must_use]
pub fn std_effect(name: &str) -> Option<&'static StdEffect> {
    STD_EFFECTS.iter().find(|(n, _)| *n == name).map(|(_, e)| e)
}

/// A std function: `StdFn`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StdFn {
    /// Its parameters' types, when the table gives them (no entry does).
    pub params: Option<&'static [StdType]>,
    /// Its result's type.
    pub returns: StdType,
    /// The effects it has.
    pub effects: &'static [&'static str],
}

impl StdFn {
    /// The object the TypeScript table holds: `{ returns, effects }`, with
    /// `params` first when there are some.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let params = self.params.map(|ps| {
            ps.iter()
                .map(|p| (&p.to_value()).into())
                .collect::<Vec<JsValue>>()
        });
        let effects: Vec<JsValue> = self.effects.iter().map(|e| JsValue::from(*e)).collect();
        JsObject::new()
            .with_some("params", params)
            .with("returns", &self.returns.to_value())
            .with("effects", effects)
    }
}

const UNTRUSTED_TEXT: StdType = StdType {
    reference: "Untrusted",
    args: &[t("Text")],
};
const LIST_PATH: StdType = StdType {
    reference: "List",
    args: &[t("Path")],
};

const fn func(returns: StdType, effects: &'static [&'static str]) -> StdFn {
    StdFn {
        params: None,
        returns,
        effects,
    }
}

/// Std functions by dotted path, in order: `STD_FNS`. Reads from the
/// outside world are `Untrusted` (§5.2, §8.11).
pub const STD_FNS: [(&str, StdFn); 7] = [
    ("fs.read_text", func(UNTRUSTED_TEXT, &["Fs.Read"])),
    (
        "fs.list",
        func(
            StdType {
                reference: "Untrusted",
                args: &[LIST_PATH],
            },
            &["Fs.Read"],
        ),
    ),
    ("fs.write_text", func(t("Bool"), &["Fs.Write"])),
    (
        "net.https.get",
        func(
            StdType {
                reference: "Untrusted",
                args: &[t("Bytes")],
            },
            &["Net"],
        ),
    ),
    ("human.ask", func(UNTRUSTED_TEXT, &["Human"])),
    ("human.approve", func(t("Approval"), &["Human"])),
    ("time.now", func(t("Time"), &["Time"])),
];

/// `STD_FNS[name]`.
#[must_use]
pub fn std_fn(name: &str) -> Option<&'static StdFn> {
    STD_FNS.iter().find(|(n, _)| *n == name).map(|(_, f)| f)
}

/// `std.decision` policy functions (§8.10, D2), in order:
/// `DECISION_POLICIES`. `Inferred<Decision<T>>` → `DecisionOutcome<T>`.
pub const DECISION_POLICIES: [&str; 3] = ["threshold", "top_margin", "abstain_if"];

/// `DECISION_POLICIES.has(name)`.
#[must_use]
pub fn is_decision_policy(name: &str) -> bool {
    DECISION_POLICIES.contains(&name)
}

/// Nominal types only the runtime may produce (§5.2; S08, G03), in order:
/// `PROTECTED_TYPES`.
pub const PROTECTED_TYPES: [&str; 4] = ["Evidence", "Authorization", "Receipt", "Verified"];

/// `PROTECTED_TYPES.has(name)`.
#[must_use]
pub fn is_protected_type(name: &str) -> bool {
    PROTECTED_TYPES.contains(&name)
}

/// Choice option names that mean "this question does not apply" (D8), in
/// order: `OUT_OF_SCOPE_OPTIONS`.
pub const OUT_OF_SCOPE_OPTIONS: [&str; 4] = ["Other", "Irrelevant", "OutOfScope", "None"];

/// `OUT_OF_SCOPE_OPTIONS.has(name)`.
#[must_use]
pub fn is_out_of_scope_option(name: &str) -> bool {
    OUT_OF_SCOPE_OPTIONS.contains(&name)
}

/// `MAX_RESTARTS`.
pub const MAX_RESTARTS: usize = 5;

/// `MAX_CHOICE_OPTIONS`.
pub const MAX_CHOICE_OPTIONS: usize = 255;
