//! The static checks (Gate 1): a port of `compiler/src/check/static.ts`,
//! the class `Checker` and the function `staticCheck` that runs it.
//!
//! It runs after name resolution on a program whose names all resolve. One
//! pass per definition types every expression, tracking for each value its
//! type, how it is known (§5.2) and its data class (§5.5), and records which
//! effects it uses.
//!
//! The checker is in three parts, one file each, all of them `impl` blocks of
//! the one [`Checker`]:
//!
//! - the core (this file and `expr.rs`): the state, the pass
//!   order of `run`, constants, functions, contracts, recursion, statements,
//!   the typer of expressions, budgets and the node count;
//! - the authority (`authority.rs`): capabilities, agents,
//!   workflows, delegation, `map`, `par`, effects and envelopes;
//! - the system model (`system.rs`): providers, working copies,
//!   declared reads, `data.read` and change sets, and `leadClasses`.
//!
//! Two more parts are the Rust's alone, for language 0.6: connectors and
//! their tools (`tools.rs`), and `human.review`, waivers and the batch commit
//! step (`review.rs`). A value also carries, the Rust's alone, whether a
//! waiver may be what it rests on ([`Val::waivable`]), which is `false` in
//! every program of 0.1 to 0.5.
//!
//! The diagnostics come out in the order the checker meets them, never
//! sorted or de-duplicated, so what fixes that order is copied: the program
//! and the definitions are first put in the order `JSON.parse(canonicalize(…))`
//! gives them ([`canonical`]), the passes of [`Checker::run`] are in the
//! TypeScript's order with no early return, `constVal` and `fnUsages` are
//! memoized with a pending mark so that their diagnostics appear where the
//! thing is first needed, and a [`Frame`] shares `usages` and `delegated`
//! with its children while it copies the rest.

mod authority;
mod expr;
mod review;
mod system;
mod tools;
mod typing;

pub use system::lead_classes;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use mandate_ir::{
    DefKind, Definition, Diagnostic, Envelope, Expr, ExprOp, JsObject, JsValue, Language, Location,
    Map, Param, Pattern, PatternKind, Program, Spans, Stmt, StmtOp, TypeExpr, Value, VerifierForm,
    compare_utf16, limits, nearest_span, ptr, workflow_bounds,
};

use crate::caps::{CapOptions, CapVal, callee_path};
use crate::cost::{Budget, CostEnv, StaticCost, block_cost, micros_text};
use crate::stdlib::DataClass;
use crate::ty::{
    Level, Problem, Ty, TypeEnv, UNKNOWN, assignable, bool_ty, from_type_expr, named, peeled_type,
    ty_of, weaker_level,
};
use crate::walk::{walk_exprs, walk_stmt_exprs};

/// A value's type and data class: `Val`, `{ ty, cls }`; and, the Rust's
/// alone, whether it rests on a verification a person may waive.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Val {
    /// Its type.
    pub(crate) ty: Ty,
    /// Its data class.
    pub(crate) cls: DataClass,
    /// 0.6 (spec/library.md "waive by"): the value comes from one verified
    /// against a contract with a `waive by` criterion, so a waiver may be
    /// what it rests on, and it never clears an irreversible effect (E1505).
    /// It flows as the data class does, from what a value is made of to the
    /// value, and through a `let`'s or a function's declared type, which
    /// the type alone would not show; a value no waiver can touch starts
    /// without it: a literal, a model's or a tool's answer, an effect's
    /// receipt, and the result of a `verify` against a contract without a
    /// waiver. Always `false` before 0.6, where no contract has a waiver.
    pub(crate) waivable: bool,
    /// 0.6 (Rust only): the unknowns in its type (`?`) are silent: the value
    /// comes from a form the checker cannot type and did not refuse, so no
    /// diagnostic stands for what it is. Such a value is never accepted
    /// where a verified one is required (E0201, [`Checker::expect_val`]).
    /// It flows as `waivable` does, from what a value is made of to the
    /// value. An unknown that is not silent is one a diagnostic already
    /// stands for (a refused call, a field a type does not have), or a
    /// statement that yields no value (a `return`): one mistake is one
    /// diagnostic. Always `false` before 0.6.
    pub(crate) silent: bool,
    /// 0.7 (Rust only): how the weakest value it is made of is known, where
    /// its type does not say so: a text that interpolates a model's output,
    /// a function's `Text` made of an outside one, a binding of either.
    /// `Verified`, which lowers nothing, for a value made of nothing known
    /// worse than its type says. It flows as the data class does, from what
    /// a value is made of to the value, through a binding and a function's
    /// result; a verification starts it again, and a count (`len`) is the
    /// run's own. How a value is known is the weaker of this and its type's
    /// level ([`Checker::level_of`]). Only the attention facts read it, so
    /// no diagnostic of any language does.
    pub(crate) made: Level,
}

impl Val {
    /// `{ ty, cls: PUBLIC }`.
    pub(crate) fn public(ty: Ty) -> Val {
        Val::new(ty, DataClass::Public)
    }

    /// `{ ty, cls }`, resting on no waiver.
    pub(crate) fn new(ty: Ty, cls: DataClass) -> Val {
        Val {
            ty,
            cls,
            waivable: false,
            silent: false,
            made: Level::Verified,
        }
    }

    /// A value of type `ty` made from `from`: of its class, and resting on
    /// what it rests on.
    pub(crate) fn like(ty: Ty, from: &Val) -> Val {
        Val {
            ty,
            cls: from.cls,
            waivable: from.waivable,
            silent: from.silent,
            made: from.made,
        }
    }

    /// `{ ty: UNKNOWN, cls: PUBLIC }`: before 0.6 any value the checker does
    /// not type; in 0.6 one a diagnostic stands for, or no value at all.
    pub(crate) fn unknown() -> Val {
        Val::public(UNKNOWN)
    }
}

/// Whether any of `vals` rests on a waiver: what a value made of them rests
/// on, as its class is their highest.
pub(crate) fn any_waivable<'v>(vals: impl IntoIterator<Item = &'v Val>) -> bool {
    vals.into_iter().any(|v| v.waivable)
}

/// Whether any of `vals` has a silent unknown in it ([`Val::silent`]).
pub(crate) fn any_silent<'v>(vals: impl IntoIterator<Item = &'v Val>) -> bool {
    vals.into_iter().any(|v| v.silent)
}

/// 0.6: what a map whose body ends with `verify x against C(…)` lets a
/// review ask about (spec/library.md "human.review").
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ReviewSource {
    /// The contract `C`.
    pub(crate) contract: String,
    /// What was verified, its wrappers peeled: the `T` of `Verified<T, C>`.
    pub(crate) item: Ty,
    /// Whether what was verified was untrusted content, which a declined
    /// item stays.
    pub(crate) untrusted: bool,
    /// 0.7: how what was verified was known before it was verified, as a
    /// review shows its open items (`crate::asks`).
    pub(crate) level: Level,
    /// 0.7: the map's `max`, the most items the review decides on (or,
    /// without one, the envelope's `agents`, `crate::asks`).
    pub(crate) items: Option<i64>,
}

/// 0.6: what a `let` bound its name to, as `human.review` reads its source
/// (E1506): a map whose body ends with a `verify`, or how it is not one.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum LetMap {
    /// Not a `map`.
    NotMap,
    /// A map whose body does not end with `verify`.
    NotVerifying,
    /// A map whose body ends with a `verify` that has `on unmet`.
    OnUnmet,
    /// A map whose body holds a `return`, which ends an item otherwise.
    Returns,
    /// A map the `let` binds, after which an `on error` handler gives a
    /// value of its own when the map fails: the name may be either.
    OnError,
    /// A map whose body ends with `verify x against C(…)`.
    Verifying(ReviewSource),
}

/// 0.6: the map whose body a frame is in, as the batch commit step reads it
/// (spec/library.md "The batch commit step").
#[derive(Debug)]
pub(crate) struct MapSite {
    /// The name the map binds each item to.
    pub(crate) bind: String,
    /// The scope that binds it.
    pub(crate) scope: Rc<Scope>,
    /// The map's `par`, when it has one.
    pub(crate) par: Option<i64>,
    /// Whether the map is itself in the body of another map.
    pub(crate) nested: bool,
}

/// One effect use: `Usage`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Usage {
    /// The effect.
    pub(crate) effect: String,
    /// Its scope, when it has one (a change set member's repository, a
    /// declared read, an environment).
    pub(crate) scope: Option<Vec<String>>,
    /// For `Model`: the data class sent to the model. For `Delegate`: the
    /// data class handed to the agent.
    pub(crate) cls: Option<DataClass>,
    /// For `Delegate`: the `Agent.skill` it runs.
    pub(crate) to: Option<String>,
    /// The function this usage came through, when the body calls a
    /// function that does it.
    pub(crate) via: Option<String>,
    /// Where it is.
    pub(crate) path: String,
}

impl Usage {
    /// `{ effect, path }`.
    pub(crate) fn new(effect: &str, path: &str) -> Usage {
        Usage {
            effect: effect.to_owned(),
            scope: None,
            cls: None,
            to: None,
            via: None,
            path: path.to_owned(),
        }
    }
}

/// 0.7: where the program's own text reaches a definition of another module
/// that a diagnostic is about ([`Checker::elsewhere`]): the diagnostic is
/// reported there, since the other module's text is not the program's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Elsewhere {
    /// The call or `verify` of the program that reaches it.
    pub(crate) site: String,
    /// The definition.
    pub(crate) def: String,
    /// Its module, when the checks were told it.
    pub(crate) module: Option<String>,
    /// The path of what the diagnostic is about, in the definition.
    pub(crate) at: String,
}

impl Elsewhere {
    /// What a message adds: where it is.
    pub(crate) fn said(&self) -> String {
        match &self.module {
            Some(m) => format!(
                " It is in {} of the module {m}, which the program reaches here.",
                self.def
            ),
            None => format!(
                " It is in {}, of another module, which the program reaches here.",
                self.def
            ),
        }
    }

    /// `facts` with the definition, its module and `at`.
    pub(crate) fn facts(&self, facts: JsObject) -> JsObject {
        facts
            .with("definition", self.def.as_str())
            .with_some("module", self.module.as_deref())
            .with("at", self.at.as_str())
    }
}

/// The variables of a scope, and the scope around it: `Scope`. A scope is
/// never changed once made, so frames share it.
#[derive(Debug, Default)]
pub(crate) struct Scope {
    vars: HashMap<String, Val>,
    parent: Option<Rc<Scope>>,
    /// 0.6: for the scope of a `let`, what it bound its one name to, as a
    /// review's source; `None` for every other scope (E1506).
    let_map: Option<LetMap>,
}

/// The kind of body a frame is in: `Where`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Where {
    /// `workflow`.
    Workflow,
    /// `fn`.
    Fn,
    /// `skill`.
    Skill,
    /// `contract`.
    Contract,
    /// `const`.
    Const,
    /// `handler`.
    Handler,
}

impl Where {
    /// Its name, as messages write it.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Where::Workflow => "workflow",
            Where::Fn => "fn",
            Where::Skill => "skill",
            Where::Contract => "contract",
            Where::Const => "const",
            Where::Handler => "handler",
        }
    }
}

/// One delegation's effective capabilities: an element of `Frame.delegated`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Delegated {
    /// The capabilities it is handed.
    pub(crate) caps: Vec<CapVal>,
    /// Where it is.
    pub(crate) path: String,
    /// Whether the agent is remote.
    pub(crate) external: bool,
}

/// The envelope a body stands under: what `under` gives, a workflow's own
/// envelope or for a sub-program's workflow `{ spawn?, budget? }` of its
/// parent's. Only `spawn` and `budget` are read of it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Bound<'a> {
    /// `spawn`.
    pub(crate) spawn: Option<&'a Value>,
    /// `budget`.
    pub(crate) budget: Option<&'a Value>,
}

impl<'a> Bound<'a> {
    /// The bound of a workflow's own envelope.
    pub(crate) fn of(e: Envelope<'a>) -> Bound<'a> {
        Bound {
            spawn: e.members().get("spawn"),
            budget: e.members().get("budget"),
        }
    }

    /// `spawn?.max_class`.
    pub(crate) fn max_class(self) -> Option<DataClass> {
        self.spawn
            .and_then(|s| s.get("max_class"))
            .and_then(Value::as_str)
            .and_then(DataClass::from_name)
    }

    /// `spawn?.max_concurrent`.
    pub(crate) fn max_concurrent(self) -> Option<f64> {
        self.spawn
            .and_then(|s| s.get("max_concurrent"))
            .and_then(Value::as_i64)
            .map(|n| n as f64)
    }

    /// `budget?.agents`.
    pub(crate) fn agents(self) -> Option<f64> {
        self.budget.and_then(Budget::of).and_then(Budget::agents)
    }
}

/// The context of a body: `Frame`. [`Checker::child`] copies it as
/// `{ ...frame, scope }` does: `usages` and `delegated` are shared (the
/// same array), every other member is copied, so an `approved` set on a
/// frame is seen only by frames made from it afterwards.
#[derive(Clone, Debug)]
pub(crate) struct Frame<'a> {
    /// `where`.
    pub(crate) where_: Where,
    /// `def`: the definition (or `Agent.skill`, or `env.read`).
    pub(crate) def: String,
    /// `scope`.
    pub(crate) scope: Rc<Scope>,
    /// `usages`, shared by reference.
    pub(crate) usages: Rc<RefCell<Vec<Usage>>>,
    /// `avail`: the capabilities available in this context; `None` in
    /// functions (checked at the call site).
    pub(crate) avail: Option<Rc<Vec<CapVal>>>,
    /// `returns`: the declared return type of the enclosing body.
    pub(crate) returns: Option<Ty>,
    /// `approved`: a `human.approve` has run earlier in this body (E0405).
    pub(crate) approved: bool,
    /// `delegated`, shared by reference: the effective capabilities handed
    /// to delegates in this body (W0310, C5).
    pub(crate) delegated: Rc<RefCell<Vec<Delegated>>>,
    /// `handed`: inside a map's body, what its `with caps` hands each
    /// delegation.
    pub(crate) handed: Option<Rc<Vec<CapVal>>>,
    /// `maxClass`: in a workflow with an envelope, the highest data class a
    /// delegation or a model may receive.
    pub(crate) max_class: Option<DataClass>,
    /// `envelope`: in the body of a workflow with an envelope, the envelope.
    pub(crate) envelope: Option<Bound<'a>>,
    /// `inMap`: inside a map's body, the map's path.
    pub(crate) in_map: Option<String>,
    /// 0.6: inside a map's body, the map, as the batch commit step reads it.
    pub(crate) map_site: Option<Rc<MapSite>>,
    /// 0.6 (Rust only): typed in a workflow's frame without being its body:
    /// its `ensures`, where no connector's tool is called (E1405).
    pub(crate) beside_body: bool,
}

impl<'a> Frame<'a> {
    /// `{ where, def, scope: { vars }, usages: [], approved: false, delegated: [] }`.
    fn new(where_: Where, def: &str, vars: HashMap<String, Val>) -> Frame<'a> {
        Frame {
            where_,
            def: def.to_owned(),
            scope: Rc::new(Scope {
                vars,
                parent: None,
                let_map: None,
            }),
            usages: Rc::new(RefCell::new(Vec::new())),
            avail: None,
            returns: None,
            approved: false,
            delegated: Rc::new(RefCell::new(Vec::new())),
            handed: None,
            max_class: None,
            envelope: None,
            in_map: None,
            map_site: None,
            beside_body: false,
        }
    }

    /// A copy of the usages so far.
    pub(crate) fn usages(&self) -> Vec<Usage> {
        self.usages.borrow().clone()
    }

    /// How many usages there are so far.
    pub(crate) fn usage_count(&self) -> usize {
        self.usages.borrow().len()
    }

    /// A copy of the usages from `from` on: `frame.usages.slice(from)`.
    pub(crate) fn usages_from(&self, from: usize) -> Vec<Usage> {
        self.usages
            .borrow()
            .get(from..)
            .map(<[Usage]>::to_vec)
            .unwrap_or_default()
    }
}

/// Where a sub-program stands in its parent's run: `Claim`,
/// `{ envelope, lead }`. Its workflow is checked as a body under the
/// parent's envelope, and what it sends on has at least the class of what
/// its lead received.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Claim<'a> {
    /// The envelope of the workflow whose `plan` runs the lead.
    pub(crate) envelope: Option<&'a Value>,
    /// The data class of what the lead received, when the claim gives one.
    pub(crate) lead: Option<DataClass>,
}

impl<'a> Claim<'a> {
    /// The claim `{ envelope, lead }` given to `check`.
    pub(crate) fn of(v: &'a Value) -> Claim<'a> {
        Claim {
            envelope: v.get("envelope"),
            lead: v
                .get("lead")
                .and_then(Value::as_str)
                .and_then(DataClass::from_name),
        }
    }
}

/// A memo of `constVal` and `fnUsages`: `"pending"` while it is computed.
#[derive(Clone, Debug)]
pub(crate) enum Memo<T> {
    /// Being computed: a cycle reads the stand-in.
    Pending,
    /// Computed.
    Done(T),
}

/// A workflow with an envelope, for `reach`: `{ name, max, usages }`, the
/// usages shared with the workflow's frame.
#[derive(Clone, Debug)]
pub(crate) struct Enveloped {
    /// The workflow.
    pub(crate) name: String,
    /// Its `spawn.max_class`.
    pub(crate) max: DataClass,
    /// What its body uses, shared with its frame.
    pub(crate) usages: Rc<RefCell<Vec<Usage>>>,
}

/// The checker: `class Checker`. Its fields are those of all three parts;
/// each part reads and writes its own.
pub(crate) struct Checker<'a> {
    /// `out`: every diagnostic, in the order reported.
    out: Vec<Diagnostic>,
    /// `program`, in canonical order.
    pub(crate) program: Program<'a>,
    /// `defs`: the program's own definitions and the linked imported ones,
    /// in canonical order.
    pub(crate) defs: &'a Map,
    /// `spans`.
    spans: Option<&'a Spans>,
    /// `claim`: given for a lead's sub-program.
    pub(crate) claim: Option<Claim<'a>>,
    /// `floor`: in a sub-program, the class of what its lead received;
    /// `public` elsewhere.
    pub(crate) floor: DataClass,
    /// Authority, `capDefs`: what each capability definition evaluates to.
    pub(crate) cap_defs: HashMap<String, Vec<CapVal>>,
    /// Core, `fnUsage`: the effects each function uses.
    fn_usage: HashMap<String, Memo<Vec<Usage>>>,
    /// Authority, `skillUsage`: what the body of each of the program's own skills
    /// uses, by `Agent.skill`.
    pub(crate) skill_usage: HashMap<String, Vec<Usage>>,
    /// Authority, `askedInMap`: the `human.*` steps already reported as standing
    /// in a map's body (E1708).
    pub(crate) asked_in_map: HashSet<String>,
    /// Authority, `enveloped`: the program's workflows with an envelope, in push
    /// order.
    pub(crate) enveloped: Vec<Enveloped>,
    /// Core, `constVals`.
    const_vals: HashMap<String, Memo<Val>>,
    /// Core, `recursive`: the functions and workflows on a call cycle.
    pub(crate) recursive: HashSet<String>,
    /// The authority writes it (`plan`), the system model reads it
    /// (`leadClasses`), `leads`: the
    /// data class of what each `plan` hands its lead, by the plan's path,
    /// in insertion order (a `Map`).
    pub(crate) leads: Vec<(String, DataClass)>,
    /// 0.6: what each `verify` verified, by its path: the type with its
    /// wrappers peeled, and how it was known (`human.review` reads the
    /// one a review's source map ends with).
    pub(crate) verified: HashMap<String, (Ty, Level)>,
    /// 0.7: what the typing gave each field of a report, by the path of
    /// the field's value: its type, its data class and how it is known
    /// (spec/attention.md "What is shown"). The attention facts read it
    /// ([`Shown`]).
    pub(crate) shown: Shown,
    /// 0.7: while a report's field is typed, the weakest level of every
    /// value typed for it (but what `len` counts): a field is known as
    /// weakly as the weakest thing it is made of, also where the type the
    /// typing gives it does not say so (a text template is `Text` whatever
    /// it interpolates, a list is of its first item's type). `None` outside
    /// a report's field.
    ///
    /// The same floor is set while the typing types what a wait for a
    /// person shows ([`Checker::asked`]): a question is known as weakly as
    /// what it is made of.
    pub(crate) report_floor: Option<Level>,
    /// 0.7: what the typing gave what each wait for a person shows, by the
    /// path of the construct that opens it (`crate::asks::Asked`). The
    /// attention bound reads it for each question's `shown` and `known`.
    pub(crate) asked: crate::asks::AskedMap,
    /// 0.7: the attention bound of each of the program's own workflows, in
    /// the order of the definitions, computed once every definition is
    /// typed (`crate::asks`).
    pub(crate) bounds: Vec<crate::asks::WorkflowBound>,
    /// 0.7: what each call of a function of the program and each `verify`
    /// hands its function or contract, with the definition the call stands
    /// in: `(caller, callee, handed)` (`crate::asks`, the floor of what a
    /// site in a function or a contract shows).
    pub(crate) handed_calls: Vec<(String, String, crate::asks::Handed)>,
    /// 0.7: what each function returns, as its body typed it with its
    /// parameters of their declared types: the highest class and the
    /// weakest level of its last value and of every `return`'s. A call's
    /// value is of that class at least, and known no better
    /// ([`Checker::fn_usages`], `call_fn`).
    pub(crate) fn_result: HashMap<String, (DataClass, Level)>,
    /// 0.7: while a function's body is typed, what its `return`s gave so
    /// far, the innermost function last (a body is typed at its first call,
    /// so one is typed inside another).
    pub(crate) returning: Vec<(DataClass, Level)>,
    /// 0.7: the module each definition another module defines comes from
    /// (`crate::modules::Linked::origin`), so that a diagnostic in it names
    /// its module. Empty when the checks were given no modules.
    pub(crate) origin: HashMap<String, String>,
    /// 0.7: above 0, the checks type a definition of another module only to
    /// find what a question of the program reaches there (E1501, `crate::asks`),
    /// and report nothing else of it.
    pub(crate) muted: usize,
    /// 0.7: what each review decides on, by its path: the bound of its
    /// items and the criteria a person may waive (`crate::asks::Detail`).
    pub(crate) reviewed: HashMap<String, (crate::attention::Count, Vec<String>)>,
}

/// 0.7: what the one pass of the static checks gives the attention facts:
/// what its typing gave each field of a report ([`Shown`]), and the
/// attention bound of each workflow, with what each question shows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Typing {
    /// Each report's fields, by the path of the field's value.
    pub shown: Shown,
    /// The bound of each of the program's own workflows, in the order of
    /// the definitions.
    pub bounds: Vec<crate::asks::WorkflowBound>,
}

/// 0.7: what the typing of a program gave one field of a report.
#[derive(Clone, Debug, PartialEq)]
pub struct ShownField {
    /// The role its report is addressed to (in a workflow that applies a
    /// pattern, the role the application binds to the pattern's slot): who
    /// is shown it, which E1909 compares [`ShownField::cls`] with the class
    /// of, in the lock's `role_classes`.
    pub role: String,
    /// Its type, [`Val::ty`].
    pub ty: Ty,
    /// Its data class, [`Val::cls`].
    pub cls: DataClass,
    /// How it is known: the level of its type, the weakest wrapper deciding
    /// ([`crate::reports::known`]).
    pub known: Level,
}

/// 0.7: what the typing of a program gave each field of its reports, by the
/// path of the field's value (`/defs/W/body/i/fields/j/value`). The pass
/// that checks a workflow fills it ([`static_check_shown`]); the attention
/// facts read it (`crate::attention`).
pub type Shown = HashMap<String, ShownField>;

impl TypeEnv for Checker<'_> {
    fn type_def(&self, name: &str) -> Option<&Value> {
        self.def_of(name, DefKind::Type).map(Definition::value)
    }

    fn is_contract(&self, name: &str) -> bool {
        self.def(name).and_then(Definition::kind) == Some(DefKind::Contract)
    }
}

/// `JSON.parse(canonicalize(v))`: the same value, every object's members in
/// the order the TypeScript then holds them, names that are array indices
/// first in numeric order and the others by UTF-16 code units.
#[must_use]
pub fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut entries: Vec<(String, Value)> = m
                .iter()
                .map(|(k, x)| (k.to_owned(), canonical(x)))
                .collect();
            entries.sort_by(|a, b| compare_utf16(&a.0, &b.0));
            Value::Object(Map::from_entries(entries).unwrap_or_default())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// The checks of `program` (a program whose names all resolve):
/// `staticCheck(program, spans, linked, claim)`. `linked` is the table of
/// definitions the program sees with its imported modules loaded; only the
/// program's own definitions are checked. `claim` (`{ envelope, lead }`) is
/// given for a lead's sub-program.
#[must_use]
pub fn static_check(
    program: Program<'_>,
    spans: Option<&Spans>,
    linked: Option<&Map>,
    claim: Option<&Value>,
) -> Vec<Diagnostic> {
    let (canonical_program, defs) = canonical_parts(program, linked);
    match Program::of(&canonical_program) {
        Some(p) => Checker::new(p, &defs, spans, claim).run(),
        None => Vec::new(),
    }
}

/// [`static_check`], and what its typing gave each field of a report of
/// 0.7 and the attention bound of each workflow ([`Typing`]): the one pass,
/// whose diagnostics are those of [`static_check`], and what it typed on the
/// way.
#[must_use]
pub fn static_check_shown(
    program: Program<'_>,
    spans: Option<&Spans>,
    linked: Option<&Map>,
    claim: Option<&Value>,
) -> (Vec<Diagnostic>, Typing) {
    static_check_from(program, spans, linked, claim, &[])
}

/// [`static_check_shown`], told the module each definition of another
/// module comes from (`origin`, [`crate::modules::Linked::origin`]): a
/// diagnostic of 0.7 that a definition of another module gives is reported
/// where the program reaches it, and names the module (E1501, E0502, E1907).
pub(crate) fn static_check_from(
    program: Program<'_>,
    spans: Option<&Spans>,
    linked: Option<&Map>,
    claim: Option<&Value>,
    origin: &[(String, String)],
) -> (Vec<Diagnostic>, Typing) {
    let (canonical_program, defs) = canonical_parts(program, linked);
    match Program::of(&canonical_program) {
        Some(p) => {
            let mut checker = Checker::new(p, &defs, spans, claim);
            checker.origin = origin.iter().cloned().collect();
            checker.run_passes();
            (
                checker.out,
                Typing {
                    shown: checker.shown,
                    bounds: checker.bounds,
                },
            )
        }
        None => (Vec::new(), Typing::default()),
    }
}

/// The static nodes each workflow of `program` expands to: `countNodes` of
/// its body, which E0105 holds to `LIMITS.expandedNodes`, by the workflow's
/// name in the order of the canonical program. `linked` is as for
/// [`static_check`]. What a test compares where no count is over the limit,
/// and so in no diagnostic (a stage of 0.7 counts as none).
#[must_use]
pub fn workflow_nodes(program: Program<'_>, linked: Option<&Map>) -> Vec<(String, f64)> {
    let (canonical_program, defs) = canonical_parts(program, linked);
    let Some(p) = Program::of(&canonical_program) else {
        return Vec::new();
    };
    let mut checker = Checker::new(p, &defs, None, None);
    checker.find_recursion();
    p.definitions()
        .filter(|(_, d)| d.kind() == Some(DefKind::Workflow))
        .map(|(name, d)| (name.to_owned(), checker.count_nodes(d.body(), &[])))
        .collect()
}

/// `checker(program, …)` of `static.ts`: the canonical program, and the
/// canonical `{ ...linked, ...canonical.defs }` (or the program's own
/// definitions without `linked`).
pub(crate) fn canonical_parts(program: Program<'_>, linked: Option<&Map>) -> (Value, Map) {
    let canonical_program = canonical(&Value::Object(program.members().clone()));
    let own = canonical_program
        .get("defs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut defs = match linked {
        Some(linked) => {
            let mut merged = linked.clone();
            for (k, v) in own.iter() {
                merged.insert(k, v.clone());
            }
            match canonical(&Value::Object(merged)) {
                Value::Object(m) => m,
                _ => Map::new(),
            }
        }
        None => own,
    };
    // 0.6: the program's own connectors are of its module (an imported one
    // says its module already, `crate::modules::link`).
    if let Some(module) = program.module() {
        let own: Vec<&str> = program
            .defs()
            .map(|d| d.keys().collect())
            .unwrap_or_default();
        crate::modules::mark_own_connectors(&mut defs, &own, module);
    }
    (canonical_program, defs)
}

/// `maxClass(...cs)`: the highest class, `public` for none.
pub(crate) fn max_class(cs: impl IntoIterator<Item = DataClass>) -> DataClass {
    cs.into_iter().fold(DataClass::Public, |a, b| a.max(b))
}

/// The names `patternVars(p)` binds.
fn pattern_vars(p: Option<Pattern<'_>>, out: &mut Vec<String>) {
    let Some(p) = p else { return };
    match p.kind() {
        Some(PatternKind::Bind) => out.push(p.name().unwrap_or_default().to_owned()),
        Some(PatternKind::Tag) => {
            for a in p.args() {
                pattern_vars(Pattern::of(a), out);
            }
        }
        _ => {}
    }
}

/// The parameters of a definition, as `{ name, type }`.
fn params_of(params: &[Value]) -> impl Iterator<Item = (&str, Option<TypeExpr<'_>>)> {
    params
        .iter()
        .filter_map(Param::of)
        .map(|p| (p.name().unwrap_or_default(), p.type_expr()))
}

impl<'a> Checker<'a> {
    /// The constructor: `floor = claim?.lead ?? PUBLIC`.
    pub(crate) fn new(
        program: Program<'a>,
        defs: &'a Map,
        spans: Option<&'a Spans>,
        claim: Option<&'a Value>,
    ) -> Checker<'a> {
        let claim = claim.map(Claim::of);
        Checker {
            out: Vec::new(),
            program,
            defs,
            spans,
            claim,
            floor: claim.and_then(|c| c.lead).unwrap_or(DataClass::Public),
            cap_defs: HashMap::new(),
            fn_usage: HashMap::new(),
            skill_usage: HashMap::new(),
            asked_in_map: HashSet::new(),
            enveloped: Vec::new(),
            const_vals: HashMap::new(),
            recursive: HashSet::new(),
            leads: Vec::new(),
            verified: HashMap::new(),
            shown: HashMap::new(),
            report_floor: None,
            asked: HashMap::new(),
            bounds: Vec::new(),
            handed_calls: Vec::new(),
            fn_result: HashMap::new(),
            returning: Vec::new(),
            origin: HashMap::new(),
            muted: 0,
            reviewed: HashMap::new(),
        }
    }

    // ── TypeEnv and helpers ─────────────────────────────────────────────

    /// `def(name)`: `Object.hasOwn(this.defs, name) ? this.defs[name] : undefined`.
    pub(crate) fn def(&self, name: &str) -> Option<Definition<'a>> {
        self.defs.get(name).map(Definition::of)
    }

    /// The definition `name` when it is of kind `kind`. In a program of 0.6
    /// a type named `Review` or `Declined` is the built-in one, never a
    /// definition (E0121 refuses one, and one a module the program does not
    /// list might still be linked), so that a review is typed as the language
    /// types it.
    pub(crate) fn def_of(&self, name: &str, kind: DefKind) -> Option<Definition<'a>> {
        if kind == DefKind::Type && self.review_type(name) {
            return None;
        }
        self.def(name).filter(|d| d.kind() == Some(kind))
    }

    /// `ty(t)`: `fromTypeExpr(t, this)`.
    pub(crate) fn ty(&self, t: Option<TypeExpr<'_>>) -> Ty {
        ty_of(t)
    }

    /// `capOpts`: capabilities are read in the program's language.
    pub(crate) fn cap_opts(&self) -> CapOptions {
        CapOptions {
            language: self.program.language(),
        }
    }

    /// Whether the program's language is `since` or later: `atLeast`.
    pub(crate) fn at_least(&self, since: Language) -> bool {
        self.program.language().is_some_and(|l| l.at_least(since))
    }

    /// The sink: `report(code, message, path, facts)`, with the nearest span.
    pub(crate) fn report(
        &mut self,
        code: &str,
        message: impl Into<String>,
        path: &str,
        facts: Option<JsObject>,
    ) {
        if self.muted > 0 {
            return;
        }
        self.report_through(code, message, path, facts);
    }

    /// [`Checker::report`], also while the checks type a definition of
    /// another module for what the program reaches there
    /// ([`Checker::muted`]): a diagnostic at `path`, in the program's text.
    pub(crate) fn report_through(
        &mut self,
        code: &str,
        message: impl Into<String>,
        path: &str,
        facts: Option<JsObject>,
    ) {
        let span = nearest_span(self.spans, path);
        self.out.push(Diagnostic::new(
            code,
            message,
            Location::path_span(path, span),
            facts,
        ));
    }

    /// `problem(p, path)`.
    pub(crate) fn problem(&mut self, p: Option<Problem>, path: &str) {
        if let Some(p) = p {
            self.report(p.code, p.message, path, None);
        }
    }

    /// `problem(assignable(actual, expected, this), path)`.
    pub(crate) fn expect(&mut self, actual: &Ty, expected: &Ty, path: &str) {
        let p = assignable(actual, expected, self);
        self.problem(p, path);
    }

    // ── driver ──────────────────────────────────────────────────────────

    /// `run()`: the passes in the TypeScript's order, with no early return;
    /// the diagnostics in the order reported.
    pub(crate) fn run(mut self) -> Vec<Diagnostic> {
        self.run_passes();
        self.out
    }

    /// The passes of `run()`, keeping the checker (for `leadClasses`).
    pub(crate) fn run_passes(&mut self) {
        let defs: &'a Map = self.defs;
        for (name, d) in defs.iter() {
            if Definition::of(d).kind() == Some(DefKind::Capability) {
                self.cap_def(name);
            }
        }
        self.find_recursion();
        self.check_system();
        // A sub-program has no `plan` at all (E1705, subprogram.ts), so
        // E1707 has nothing to add there.
        if self.claim.is_none() {
            self.plans_outside();
        }
        let program = self.program;
        for (name, d) in program.definitions() {
            let base = ptr(&[&"defs", &name]);
            match d.kind() {
                Some(DefKind::Const) => {
                    self.const_val(name);
                }
                Some(DefKind::Fn) => {
                    self.fn_usages(name);
                }
                Some(DefKind::Extern) => self.check_extern(name, d, &base),
                Some(DefKind::Effect) => self.check_effect_decl(name, d, &base),
                Some(DefKind::Agent) => self.check_agent(name, d, &base),
                // 0.6: a workflow that applies a pattern is read only as
                // its expansion (`crate::expand`); met here, it was not
                // expanded, and is refused rather than read as a workflow
                // that does nothing.
                Some(DefKind::Workflow) if d.value().get("apply").is_some() => {
                    self.unexpanded(name, &base);
                }
                Some(DefKind::Workflow) => self.check_workflow(name, d, &base),
                Some(DefKind::Contract) => self.check_contract(name, d, &base),
                Some(DefKind::Connector) => self.check_connector(name, d, &base),
                _ => {}
            }
        }
        for w in self.enveloped.clone() {
            let usages = w.usages.borrow().clone();
            self.reach(&w.name, w.max, &usages);
        }
        // 0.7: what the program reaches in another module's contracts and
        // functions, typed for what its questions ask there (E1501), and
        // then the attention bound of each workflow, once every definition
        // it may reach is typed (E1906, E1907; `crate::asks`).
        if self.at_least(Language::V0_7) {
            self.reached_elsewhere();
            self.attention_bounds();
        }
    }

    /// 0.7: each contract and function of another module that a definition
    /// of the program reaches by calls and `verify`s, through any number of
    /// others, typed as a definition of the program is, with everything
    /// but what [`Checker::report_through`] reports muted: a question there
    /// is one of this program's, whatever language its module is written
    /// in, and the role it names is held as a role the program names
    /// (E1501, reported where the program reaches it). Functions of the
    /// program, and those of other modules it calls, are typed already.
    fn reached_elsewhere(&mut self) {
        let program = self.program;
        let mut queue: Vec<&'a str> = Vec::new();
        for (_, d) in program.definitions() {
            self.callees_in(d.value(), &mut queue);
        }
        let mut next = 0;
        while let Some(&u) = queue.get(next) {
            next = next.saturating_add(1);
            let Some(d) = self.def(u) else { continue };
            if !self.is_own(u) {
                self.muted = self.muted.saturating_add(1);
                match d.kind() {
                    Some(DefKind::Contract) => {
                        self.check_contract(u, d, &ptr(&[&"defs", &u]));
                    }
                    Some(DefKind::Fn) => {
                        self.fn_usages(u);
                    }
                    _ => {}
                }
                self.muted = self.muted.saturating_sub(1);
            }
            self.callees_in(d.value(), &mut queue);
        }
    }

    /// Whether `name` is one of the program's own definitions, and none of
    /// another module's.
    pub(crate) fn is_own(&self, name: &str) -> bool {
        self.program.defs().is_some_and(|d| d.get(name).is_some())
    }

    /// 0.7: where the program's own text reaches `def`, a definition of
    /// another module: the first call of a function or a workflow, or
    /// `verify` against a contract, of its definitions (in their order, each
    /// in the order of its text) whose callee is of another module and is
    /// `def` or reaches it; else the `use` of `def`'s module; else `def`'s
    /// own path.
    pub(crate) fn reaching_site(&self, def: &str) -> String {
        let program = self.program;
        for (name, d) in program.definitions() {
            let mut calls: Vec<(String, &'a str)> = Vec::new();
            self.reaching_calls(d.value(), &ptr(&[&"defs", &name]), &mut calls);
            if let Some((at, _)) = calls
                .into_iter()
                .find(|(_, callee)| !self.is_own(callee) && self.reaches(callee, def))
            {
                return at;
            }
        }
        let module = self.origin.get(def);
        match program
            .imports()
            .position(|u| module.is_some_and(|m| u.module() == Some(m.as_str())))
        {
            Some(i) => format!("/uses/{i}"),
            None => ptr(&[&"defs", &def]),
        }
    }

    /// The calls and `verify`s [`Checker::callees_in`] finds in `v`, each
    /// with its path (`v` is at `path`), in the order of the text.
    fn reaching_calls(&self, v: &'a Value, path: &str, out: &mut Vec<(String, &'a str)>) {
        match v {
            Value::Array(items) => {
                for (i, x) in items.iter().enumerate() {
                    self.reaching_calls(x, &format!("{path}/{i}"), out);
                }
            }
            Value::Object(m) => {
                let mut one: Vec<&'a str> = Vec::new();
                self.callee_of(v, &mut one);
                if let Some(c) = one.first() {
                    out.push((path.to_owned(), c));
                }
                for (k, x) in m.iter() {
                    self.reaching_calls(x, &format!("{path}/{}", mandate_ir::ptr_token(k)), out);
                }
            }
            _ => {}
        }
    }

    /// Whether `from` is `to`, or reaches it by calls and `verify`s.
    fn reaches(&self, from: &'a str, to: &str) -> bool {
        let mut seen: Vec<&'a str> = Vec::new();
        let mut stack: Vec<&'a str> = vec![from];
        while let Some(u) = stack.pop() {
            if u == to {
                return true;
            }
            if seen.contains(&u) {
                continue;
            }
            seen.push(u);
            if let Some(d) = self.def(u) {
                self.callees_in(d.value(), &mut stack);
            }
        }
        false
    }

    /// 0.7: for a diagnostic of a definition of another module at `path`,
    /// where the program reaches it and what names it. `None` for a path in
    /// the program's own definitions, or before 0.7.
    pub(crate) fn elsewhere(&self, path: &str) -> Option<Elsewhere> {
        if !self.at_least(Language::V0_7) {
            return None;
        }
        let token = path.strip_prefix("/defs/")?.split('/').next()?;
        let def = token.replace("~1", "/").replace("~0", "~");
        if self.is_own(&def) || self.def(&def).is_none() {
            return None;
        }
        Some(Elsewhere {
            site: self.reaching_site(&def),
            module: self.origin.get(&def).cloned(),
            at: path.to_owned(),
            def,
        })
    }

    /// 0.6: E1307 for a workflow that still applies a pattern when the
    /// static checks read it: they read a body, and an application has
    /// none of its own.
    fn unexpanded(&mut self, name: &str, base: &str) {
        self.report(
            "E1307",
            format!(
                "Workflow {name} applies a pattern and was not expanded; the checks read a workflow's body, so it is refused rather than read as one that does nothing."
            ),
            &format!("{base}/apply"),
            Some(
                JsObject::new()
                    .with("workflow", name)
                    .with("problem", "unexpanded"),
            ),
        );
    }

    // ── definitions ─────────────────────────────────────────────────────

    /// `constFrame()`.
    pub(crate) fn const_frame(&self) -> Frame<'a> {
        Frame::new(Where::Const, "", HashMap::new())
    }

    /// The value of a constant, typed on first request: `constVal(name)`.
    /// While it is typed it reads as unknown, so a constant on a cycle is
    /// typed once (in 0.6 as what the checker knows nothing of).
    pub(crate) fn const_val(&mut self, name: &str) -> Val {
        match self.const_vals.get(name) {
            Some(Memo::Pending) => return self.opaque(UNKNOWN),
            Some(Memo::Done(v)) => return v.clone(),
            None => {}
        }
        self.const_vals.insert(name.to_owned(), Memo::Pending);
        let d = self.def(name);
        let mut frame = self.const_frame_box(name);
        let at = sub(&ptr(&[&"defs", &name]), "value");
        let v = self.expr_or_unknown(d.and_then(Definition::value_expr), &mut frame, &at);
        let out = self.const_typed(d, v, &at);
        self.const_vals
            .insert(name.to_owned(), Memo::Done(out.clone()));
        out
    }

    /// A constant's value as it is known: of its declared type, when it has
    /// one.
    fn const_typed(&mut self, d: Option<Definition<'a>>, v: Val, at: &str) -> Val {
        match d.and_then(Definition::type_expr) {
            Some(t) => {
                let t = self.ty(Some(t));
                self.expect_val(&v, &t, at);
                Val::like(t, &v)
            }
            None => v,
        }
    }

    /// `isCriticalEffect(name)`.
    pub(crate) fn is_critical_effect(&self, name: &str) -> bool {
        // 0.6: a connector's write tool is a critical effect, `c.t`.
        if let Some(r) = self.connector_tool(name) {
            return r.tool.is_write();
        }
        match self.def(name) {
            Some(d) if d.kind() == Some(DefKind::Effect) => {
                truthy(d.value().get("critical")) || truthy(d.value().get("irreversible"))
            }
            _ => crate::stdlib::std_effect(name).is_some_and(|e| e.critical),
        }
    }

    /// `bodyFrame(where, def, params, avail, returns)`.
    pub(crate) fn body_frame(
        &self,
        where_: Where,
        def: &str,
        params: &[Value],
        avail: Option<Vec<CapVal>>,
        returns: Option<Ty>,
    ) -> Frame<'a> {
        let mut vars = HashMap::new();
        for (name, t) in params_of(params) {
            let ty = self.ty(t);
            let cls = self.type_class(&ty);
            vars.insert(name.to_owned(), Val::new(ty, cls));
        }
        let mut f = Frame::new(where_, def, vars);
        f.avail = avail.map(Rc::new);
        f.returns = returns;
        f
    }

    /// The effects a function uses, typing its body on first request:
    /// `fnUsages(name)`. While it is typed it uses nothing, so a function
    /// on a cycle is typed once.
    pub(crate) fn fn_usages(&mut self, name: &str) -> Vec<Usage> {
        match self.fn_usage.get(name) {
            Some(Memo::Pending) => return Vec::new(),
            Some(Memo::Done(u)) => return u.clone(),
            None => {}
        }
        self.fn_usage.insert(name.to_owned(), Memo::Pending);
        let Some(d) = self.def(name) else {
            self.fn_usage
                .insert(name.to_owned(), Memo::Done(Vec::new()));
            return Vec::new();
        };
        let frame = self.fn_frame(name, d);
        let base = ptr(&[&"defs", &name]);
        let at = sub(&base, "body");
        // 0.7: a function's body is typed once, wherever it is first
        // called; what it holds lowers no floor of the expression that
        // calls it, whose value is of the function's declared type.
        let floor = self.report_floor.take();
        let v0_7 = self.at_least(Language::V0_7);
        if v0_7 {
            self.returning.push((DataClass::Public, Level::Verified));
        }
        let last = self.body(d.body(), &frame, &at, true);
        if v0_7 {
            let (c, l) = self
                .returning
                .pop()
                .unwrap_or((DataClass::Public, Level::Verified));
            let returned = (c.max(last.cls), weaker_level(l, self.level_of(&last)));
            self.fn_result.insert(name.to_owned(), returned);
        }
        self.report_floor = floor;
        let usages = frame.usages();
        self.fn_declared(name, d, &base, &usages);
        self.fn_usage
            .insert(name.to_owned(), Memo::Done(usages.clone()));
        usages
    }

    /// The frame a function's body is typed in.
    /// Boxed, as the frame of `constVal`: a chain of calls nests it.
    #[inline(never)]
    fn fn_frame(&self, name: &str, d: Definition<'a>) -> Box<Frame<'a>> {
        let returns = self.ty(d.returns());
        Box::new(self.body_frame(Where::Fn, name, d.params(), None, Some(returns)))
    }

    /// `{ ...constFrame(), def: name }` of `constVal`, boxed: a chain of
    /// constants nests it.
    #[inline(never)]
    fn const_frame_box(&self, name: &str) -> Box<Frame<'a>> {
        let mut frame = Box::new(self.const_frame());
        frame.def = name.to_owned();
        frame
    }

    /// What `fnUsages` checks once a function's body is typed: the effects
    /// it declares exist and cover what it uses, or it is not public.
    fn fn_declared(&mut self, name: &str, d: Definition<'a>, base: &str, usages: &[Usage]) {
        match d.value().get("effects").and_then(Value::as_array) {
            Some(effects) => {
                self.effect_names(effects, &sub(base, "effects"));
                self.check_usages_declared(usages, effects, &format!("fn {name}"));
            }
            None => {
                if truthy(d.value().get("pub")) {
                    self.report(
                        "E0401",
                        format!(
                            "Public function '{name}' must declare its effects with '! {{ … }}' (§6.2)."
                        ),
                        base,
                        None,
                    );
                }
            }
        }
    }

    /// `checkContract(name, d, base)`: contract parameters are the subjects
    /// under test, so they may hold unverified values.
    fn check_contract(&mut self, name: &str, d: Definition<'a>, base: &str) {
        // 0.6: what a person approves is never waived (E1504).
        self.check_waivers(name, d, base);
        // 0.7: a method name the runtime keeps for its own records (E1509).
        self.check_reserved_methods(name, d, base);
        let mut frame = self.body_frame(Where::Contract, name, d.params(), None, None);
        for (i, r) in d.require().iter().enumerate() {
            let at = format!("{base}/require/{i}");
            let v = match Expr::of(r) {
                Some(r) => self.expr(r, &mut frame, &at),
                None => Val::unknown(),
            };
            self.expect_bool(&v, &at);
        }
        for group in ["accept", "invariant"] {
            let criteria: Vec<(&'a str, &'a Value)> = d
                .value()
                .get(group)
                .and_then(Value::as_object)
                .map(|o| o.iter().collect())
                .unwrap_or_default();
            for (cn, c) in criteria {
                let Some(by) = c.get("by") else { continue };
                self.verifier(
                    by,
                    &mut frame,
                    &format!("{base}/{group}/{cn}/by"),
                    &format!("{name}.{cn}"),
                );
            }
        }
    }

    /// `verifier(v, frame, path, who)`: E0603 when only `review(…)`
    /// satisfies it, W0601 for a static criterion not proved now.
    fn verifier(&mut self, v: &'a Value, frame: &mut Frame<'a>, path: &str, who: &str) {
        let has = |x: &Value, form: VerifierForm| x.get(form.as_str()).is_some();
        let all = has(v, VerifierForm::All);
        let parts: Vec<&'a Value> = if all {
            v.get("all")
                .and_then(Value::as_array)
                .map(|xs| xs.iter().collect())
                .unwrap_or_default()
        } else {
            vec![v]
        };
        let reviews = parts
            .iter()
            .filter(|p| {
                has(p, VerifierForm::Call)
                    && p.get("call")
                        .and_then(Expr::of)
                        .is_some_and(|c| c.is(ExprOp::Call) && callee_is(c, "review"))
            })
            .count();
        if reviews == parts.len() {
            self.report(
                "E0603",
                format!(
                    "{who} is satisfied only by review(…). A second model agreeing is not evidence; pair it with a static check, a test or a human (§10.2)."
                ),
                path,
                None,
            );
        }
        for (i, p) in parts.iter().enumerate() {
            let pp = if all {
                format!("{path}/all/{i}")
            } else {
                path.to_owned()
            };
            if has(p, VerifierForm::Static) {
                let at = format!("{pp}/static");
                let s = p.get("static").and_then(Expr::of);
                let v = match s {
                    Some(s) => self.expr(s, frame, &at),
                    None => Val::unknown(),
                };
                self.expect_bool(&v, &at);
                if !s.is_some_and(|s| s.is(ExprOp::Bool)) {
                    self.report(
                        "W0601",
                        format!(
                            "{who}: this static criterion cannot be proved at compile time; it becomes a run-time check (§10.2)."
                        ),
                        &at,
                        None,
                    );
                }
            } else if has(p, VerifierForm::Call)
                && let Some(c) = p.get("call").and_then(Expr::of)
            {
                self.expr(c, frame, &format!("{pp}/call"));
            }
        }
    }

    // ── recursion (S04) ─────────────────────────────────────────────────

    /// `findRecursion()`: call cycles among functions and workflows (E0502),
    /// found depth first in the order of the definitions and of the calls,
    /// and every name on a cycle found marked `recursive`.
    fn find_recursion(&mut self) {
        let defs: &'a Map = self.defs;
        let mut calls: Vec<(&'a str, Vec<&'a str>)> = Vec::new();
        for (name, d) in defs.iter() {
            let d = Definition::of(d);
            if !matches!(d.kind(), Some(DefKind::Fn | DefKind::Workflow)) {
                continue;
            }
            let mut set: Vec<&'a str> = Vec::new();
            walk_exprs(d.body(), &mut |e| {
                if e.is(ExprOp::Call)
                    && let Some(callee) = e.callee().filter(|c| c.is(ExprOp::Var))
                {
                    let n = callee.name().unwrap_or_default();
                    let callable = self
                        .def(n)
                        .is_some_and(|t| matches!(t.kind(), Some(DefKind::Fn | DefKind::Workflow)));
                    if callable && !set.contains(&n) {
                        set.push(n);
                    }
                }
            });
            calls.push((name, set));
        }
        let mut state: HashMap<&'a str, bool> = HashMap::new();
        let mut found: Vec<(Vec<&'a str>, &'a str)> = Vec::new();
        for (n, _) in &calls {
            visit(n, &mut Vec::new(), &calls, &mut state, &mut found);
        }
        self.recursion_found(found);
        // 0.7: a cycle may go through a contract too: a `verify` runs its
        // contract's `require`, criteria and verifiers' arguments, which may
        // call a function that verifies against it again. Each such cycle
        // is refused as one of calls is; a cycle of functions and workflows
        // alone was found above, as before 0.7.
        if self.at_least(Language::V0_7) {
            let mut graph: Vec<(&'a str, Vec<&'a str>)> = Vec::new();
            for (name, d) in defs.iter() {
                let kind = Definition::of(d).kind();
                if !matches!(
                    kind,
                    Some(DefKind::Fn | DefKind::Workflow | DefKind::Contract)
                ) {
                    continue;
                }
                let mut set: Vec<&'a str> = Vec::new();
                let parts: Vec<&'a Value> = match kind {
                    Some(DefKind::Contract) => ["require", "accept", "invariant"]
                        .iter()
                        .filter_map(|k| d.get(k))
                        .collect(),
                    _ => d.get("body").into_iter().collect(),
                };
                for part in parts {
                    self.callees_in(part, &mut set);
                }
                graph.push((name, set));
            }
            let mut state: HashMap<&'a str, bool> = HashMap::new();
            let mut through: Vec<(Vec<&'a str>, &'a str)> = Vec::new();
            for (n, _) in &graph {
                visit(n, &mut Vec::new(), &graph, &mut state, &mut through);
            }
            through.retain(|(cycle, _)| {
                cycle
                    .iter()
                    .any(|c| self.def_of(c, DefKind::Contract).is_some())
            });
            self.recursion_found(through);
        }
    }

    /// The functions, workflows and (0.7) contracts `v` calls or verifies
    /// against, each once, in order.
    fn callees_in(&self, v: &'a Value, out: &mut Vec<&'a str>) {
        match v {
            Value::Array(items) => {
                for x in items {
                    self.callees_in(x, out);
                }
            }
            Value::Object(m) => {
                self.callee_of(v, out);
                for (_, x) in m.iter() {
                    self.callees_in(x, out);
                }
            }
            _ => {}
        }
    }

    /// The function or workflow the expression `v` calls, or the contract
    /// it verifies against, onto `out` (as the definition's own key) unless
    /// it is there already; nothing for any other node.
    fn callee_of(&self, v: &'a Value, out: &mut Vec<&'a str>) {
        let Some(e) = Expr::of(v) else { return };
        let callee = match e.op() {
            Some(ExprOp::Call) => e
                .callee()
                .filter(|c| c.is(ExprOp::Var))
                .and_then(Expr::name)
                .filter(|n| {
                    self.def(n)
                        .is_some_and(|t| matches!(t.kind(), Some(DefKind::Fn | DefKind::Workflow)))
                }),
            Some(ExprOp::Verify) => e
                .contract()
                .filter(|c| self.def_of(c, DefKind::Contract).is_some()),
            _ => None,
        };
        if let Some(c) = callee
            && let Some((key, _)) = self.defs.iter().find(|(k, _)| *k == c)
            && !out.contains(&key)
        {
            out.push(key);
        }
    }

    /// E0502 for each cycle `found`, every name on it marked `recursive`.
    fn recursion_found(&mut self, found: Vec<(Vec<&'a str>, &'a str)>) {
        for (cycle, n) in found {
            for c in &cycle {
                self.recursive.insert((*c).to_owned());
            }
            let mut shown: Vec<&str> = cycle.clone();
            shown.push(n);
            let message = format!(
                "Recursive call cycle {}; static node and budget bounds need an acyclic call graph.",
                shown.join(" → ")
            );
            let facts = JsObject::new().with(
                "cycle",
                cycle.iter().map(|c| JsValue::from(*c)).collect::<Vec<_>>(),
            );
            let at = ptr(&[&"defs", &n]);
            // 0.7: a cycle in another module's definitions is reported where
            // the program reaches it, with the definition and its module.
            match self.elsewhere(&at) {
                Some(e) => self.report(
                    "E0502",
                    format!("{message}{}", e.said()),
                    &e.site,
                    Some(e.facts(facts)),
                ),
                None => self.report("E0502", message, &at, Some(facts)),
            }
        }
    }

    // ── statements ──────────────────────────────────────────────────────

    /// `child(frame, vars)`: `{ ...frame, scope: { vars, parent: frame.scope } }`.
    pub(crate) fn child(frame: &Frame<'a>, vars: HashMap<String, Val>) -> Frame<'a> {
        Self::child_of(frame, vars, None)
    }

    /// [`Checker::child`], its scope that of a `let` when `let_map` says
    /// what the `let` bound its name to (0.6).
    fn child_of(
        frame: &Frame<'a>,
        vars: HashMap<String, Val>,
        let_map: Option<LetMap>,
    ) -> Frame<'a> {
        Frame {
            scope: Rc::new(Scope {
                vars,
                parent: Some(Rc::clone(&frame.scope)),
                let_map,
            }),
            ..frame.clone()
        }
    }

    /// The scope of `scope`'s chain that binds `name`, the innermost.
    pub(crate) fn binding<'s>(name: &str, scope: &'s Rc<Scope>) -> Option<&'s Rc<Scope>> {
        let mut s = Some(scope);
        while let Some(sc) = s {
            if sc.vars.contains_key(name) {
                return Some(sc);
            }
            s = sc.parent.as_ref();
        }
        None
    }

    /// [`Checker::child`], boxed: made in a frame of its own, so that the
    /// caller's frame holds a pointer and not a whole `Frame`.
    #[inline(never)]
    pub(crate) fn child_box(frame: &Frame<'a>, vars: HashMap<String, Val>) -> Box<Frame<'a>> {
        Box::new(Self::child(frame, vars))
    }

    /// `lookup(name, scope)`.
    pub(crate) fn lookup(name: &str, scope: &Scope) -> Option<Val> {
        let mut s = Some(scope);
        while let Some(sc) = s {
            if let Some(v) = sc.vars.get(name) {
                return Some(v.clone());
            }
            s = sc.parent.as_deref();
        }
        None
    }

    /// Types a block and returns the value of its last expression
    /// statement; with `result` the block is a definition's body, whose
    /// value must match the declared return type: `body(stmts, outer, base, result)`.
    ///
    /// Inlined, so that a block nested in a block nests one frame, the one
    /// of [`Checker::plain_body`] or of [`Checker::typed_body`], not two.
    #[inline(always)]
    pub(crate) fn body(
        &mut self,
        stmts: &'a [Value],
        outer: &Frame<'a>,
        base: &str,
        result: bool,
    ) -> Val {
        if self.at_least(Language::V0_6) {
            self.typed_body(stmts, outer, base, result)
        } else {
            self.plain_body(stmts, outer, base, result)
        }
    }

    /// [`Checker::body`] in 0.1 to 0.5.
    #[inline(never)]
    fn plain_body(
        &mut self,
        stmts: &'a [Value],
        outer: &Frame<'a>,
        base: &str,
        result: bool,
    ) -> Val {
        // Boxed: a block nested in a block nests this frame, and a `Frame` is
        // large.
        let mut frame = Self::child_box(outer, HashMap::new());
        let mut last = Val::unknown();
        for (i, s) in stmts.iter().enumerate() {
            let path = sub_n(base, i);
            last = Val::unknown();
            if let Some(s) = Stmt::of(s)
                && let Some(v) = self.stmt(s, &mut frame, &path)
            {
                last = v;
            }
        }
        if result {
            self.body_result(stmts, outer, base, &last);
        }
        last
    }

    /// [`Checker::body`] in 0.6: a block has the value of its last statement
    /// as the runtime gives it, an `on error` after a statement joining its
    /// handler's value into that statement's (and into the name a `let`
    /// binds). A function of its own, so that the frame of a block of 0.1 to
    /// 0.5 stays what it was.
    #[inline(never)]
    fn typed_body(
        &mut self,
        stmts: &'a [Value],
        outer: &Frame<'a>,
        base: &str,
        result: bool,
    ) -> Val {
        let mut frame = Self::child_box(outer, HashMap::new());
        let mut last = Val::unknown();
        let mut bound: Option<&'a str> = None;
        for (i, s) in stmts.iter().enumerate() {
            let path = sub_n(base, i);
            let s = Stmt::of(s);
            // 0.7: a stage is no statement of the block's value: what is
            // before it and after it is as if it were not there (an `on
            // error` never follows one, E1902).
            if s.is_some_and(|s| s.op() == Some(StmtOp::Stage)) {
                continue;
            }
            // 0.7: a report is typed, and is no statement of the block's
            // value either: it changes no value of the run (an `on error`
            // never follows one, E1905).
            if let Some(s) = s.filter(|s| s.op() == Some(StmtOp::Report)) {
                self.report_stmt(s, &mut frame, &path);
                continue;
            }
            if let Some(s) = s.filter(|s| s.op() == Some(StmtOp::OnError)) {
                self.after_error(s, &mut frame, &path, &mut last, bound);
                continue;
            }
            last = Val::unknown();
            bound = None;
            if let Some(s) = s {
                if let Some(v) = self.stmt(s, &mut frame, &path) {
                    last = v;
                }
                if s.op() == Some(StmtOp::Let) {
                    bound = s.name();
                }
            }
        }
        if result {
            self.body_result(stmts, outer, base, &last);
        }
        last
    }

    /// 0.6: an `on error` after a statement of a block: its handler typed,
    /// and its value, unless it is a strategy, joined into `last` and into
    /// the name the statement binds when it is a `let` (`bound`). Apart from
    /// [`Checker::body`], so that a block's frame stays as small as before.
    #[inline(never)]
    fn after_error(
        &mut self,
        s: Stmt<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        last: &mut Val,
        bound: Option<&str>,
    ) {
        if let Some(h) = self.on_error_stmt(s, frame, path) {
            *last = self.join(last, &h);
            if let Some(name) = bound {
                self.rebind_after_error(name, &h, frame);
            }
        }
    }

    /// 0.6: the name a `let` bound, bound again after an `on error` whose
    /// handler gives `h`: the name is the statement's value or `h`. It is no
    /// longer a map's outcomes for a review (E1506, `on_error`).
    fn rebind_after_error(&self, name: &str, h: &Val, frame: &mut Frame<'a>) {
        let Some(was) = Self::lookup(name, &frame.scope) else {
            return;
        };
        let let_map = Self::binding(name, &frame.scope)
            .and_then(|s| s.let_map.as_ref())
            .map(|m| match m {
                LetMap::NotMap => LetMap::NotMap,
                _ => LetMap::OnError,
            });
        let mut vars = HashMap::new();
        vars.insert(name.to_owned(), self.join(&was, h));
        *frame = Self::child_of(frame, vars, let_map);
    }

    /// The tail of a definition's body against its declared return type: an
    /// expression's value, and in 0.6 the value of a `let`, an `if` or a
    /// `loop` that ends it as well (an `on error` after the last statement
    /// joins its handler's value into it).
    fn body_result(&mut self, stmts: &[Value], outer: &Frame<'a>, base: &str, last: &Val) {
        let Some(returns) = outer.returns.clone() else {
            return;
        };
        let typed = self.at_least(Language::V0_6);
        let tail = stmts
            .iter()
            .enumerate()
            .rev()
            .filter_map(|(i, s)| Some((i, Stmt::of(s)?)))
            .find(|(_, s)| {
                !typed
                    || !matches!(
                        s.op(),
                        Some(StmtOp::OnError | StmtOp::Stage | StmtOp::Report)
                    )
            });
        let last_index = stmts.len().checked_sub(1);
        let Some((i, tail)) = tail.filter(|(i, _)| typed || Some(*i) == last_index) else {
            return;
        };
        let at = sub_n(base, i);
        match tail.op() {
            Some(StmtOp::Expr) => self.expect_val(last, &returns, &sub(&at, "value")),
            Some(StmtOp::Let) if typed => self.expect_val(last, &returns, &sub(&at, "value")),
            Some(StmtOp::If | StmtOp::Loop) if typed => self.expect_val(last, &returns, &at),
            Some(
                StmtOp::Let
                | StmtOp::If
                | StmtOp::Loop
                | StmtOp::Par
                | StmtOp::Return
                | StmtOp::OnError
                | StmtOp::Run
                | StmtOp::Stage
                | StmtOp::Report,
            )
            | None => {}
        }
    }

    /// One statement of a block in `frame`, which a `let` or a `par`
    /// replaces with its child; the value of an `expr` statement, and in 0.6
    /// the value the runtime gives for a `let`, an `if`, a `loop` and a
    /// `par` too.
    #[inline(always)]
    fn stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) -> Option<Val> {
        match s.op() {
            Some(StmtOp::Let) => self.let_stmt(s, frame, path),
            Some(StmtOp::Par) => self.par_stmt(s, frame, path),
            Some(StmtOp::If) => self.if_stmt(s, frame, path),
            Some(StmtOp::Loop) => self.loop_stmt(s, frame, path),
            Some(StmtOp::Return) => {
                self.return_stmt(s, frame, path);
                None
            }
            Some(StmtOp::OnError) => {
                self.on_error_stmt(s, frame, path);
                None
            }
            Some(StmtOp::Run) => {
                self.operand(s.target(), frame, path, "target");
                None
            }
            Some(StmtOp::Expr) => Some(self.expr_or_unknown(s.value(), frame, &sub(path, "value"))),
            // 0.7: a report's fields are typed, each held to a type a
            // person can be shown (E1904); it has no value, binds nothing
            // and opens no scope. Where it stands, its title and what its
            // fields may hold are `crate::reports`' (E1903 to E1905).
            Some(StmtOp::Report) => {
                self.report_stmt(s, frame, path);
                None
            }
            // 0.7: a stage has no value, binds nothing and opens no scope;
            // where it stands and what it is named are E1901 and E1902
            // (`crate::stages`).
            Some(StmtOp::Stage) | None => None,
        }
    }

    /// 0.7: a `report` (spec/attention.md "`report`"): each field's value
    /// typed in `frame`, as every expression is, and held to a type a person
    /// can be shown (E1904, [`crate::reports::not_shown`]). What the typing
    /// gives of each field, its type and its data class, is kept by the
    /// field's path ([`Checker::shown`]): the attention facts read it there
    /// ([`crate::attention`]), so that what a person is told of a field is
    /// what this pass found, and nothing computed a second way.
    fn report_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) {
        let role = s.role().unwrap_or_default();
        let title = s.title().unwrap_or_default();
        for (i, f) in s.fields().iter().enumerate() {
            let Some(f) = mandate_ir::ReportField::of(f) else {
                continue;
            };
            let at = format!("{path}/fields/{i}/value");
            // The weakest level of what the field is made of: from
            // verified up, lowered by each value typed for it.
            let outer = self.report_floor.replace(Level::Verified);
            let v = self.expr_or_unknown(f.value(), frame, &at);
            let floor = std::mem::replace(&mut self.report_floor, outer);
            if let Some(why) = crate::reports::not_shown(&v.ty, self) {
                let name = f.name().unwrap_or_default();
                let shown = crate::ty::show(&v.ty);
                self.report(
                    "E1904",
                    format!(
                        "Field '{name}' of the report \"{title}\" to {role} is of type {shown}, which a person is not shown: {why}. A field is of a type a person can read: Int, Dec, Bool, Text, Money, Duration, Time, an enum, an Option or a List of one of these, or a record of these one level deep, each of them optionally inside Verified, Inferred or Untrusted (spec/attention.md \"report\")."
                    ),
                    &at,
                    Some(
                        JsObject::new()
                            .with("role", role)
                            .with("field", name)
                            .with("problem", "type")
                            .with("type", shown.as_str()),
                    ),
                );
            }
            let typed = self.level_of(&v);
            let known = match floor {
                Some(f) if crate::ty::level_rank(f) > crate::ty::level_rank(typed) => f,
                _ => typed,
            };
            self.shown.insert(
                at,
                ShownField {
                    role: role.to_owned(),
                    ty: v.ty,
                    cls: v.cls,
                    known,
                },
            );
        }
    }

    /// `par`: its branches' values bound in a child of the frame; in 0.6
    /// the `null` the runtime gives for it.
    fn par_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) -> Option<Val> {
        let vars = self.par(s, frame, path);
        *frame = Self::child(frame, vars);
        self.at_least(Language::V0_6).then(|| self.null_val())
    }

    /// `let`: the value, against the declared type if any, bound in a child
    /// of the frame; in 0.6 the value as bound.
    fn let_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) -> Option<Val> {
        let at = sub(path, "value");
        let v = self.expr_or_unknown(s.value(), frame, &at);
        // 0.6: what the name is bound to, as a review's source reads it.
        let typed = self.at_least(Language::V0_6);
        let let_map = if typed {
            s.value().map(|e| self.let_map(e, &at))
        } else {
            None
        };
        let bound = self.declared(s, v, &at);
        let out = typed.then(|| bound.clone());
        let mut vars = HashMap::new();
        vars.insert(s.name().unwrap_or_default().to_owned(), bound);
        *frame = Self::child_of(frame, vars, let_map);
        out
    }

    /// A `let`'s value as bound: of its declared type, when it has one, and
    /// of the class and waivers of its value whatever the type says.
    fn declared(&mut self, s: Stmt<'a>, v: Val, at: &str) -> Val {
        match s.type_expr() {
            Some(t) => {
                let t = self.ty(Some(t));
                self.expect_val(&v, &t, at);
                Val::like(t, &v)
            }
            None => v,
        }
    }

    /// `if`: the condition a Bool, both blocks typed; in 0.6 the value is
    /// one of theirs, or `null` without `else`.
    fn if_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) -> Option<Val> {
        self.condition(s.cond(), frame, path, "cond");
        let at = sub(path, "then");
        let then = self.body(s.then_block(), frame, &at, false);
        self.if_else(s, frame, path, then)
    }

    /// The rest of an `if` once its `then` block is typed: the `else` block,
    /// and in 0.6 the value of the two. Apart from [`Self::if_stmt`], so that
    /// the frame of a nested `then`, which a chain of `if`s nests once per
    /// level, holds none of it.
    #[inline(never)]
    fn if_else(
        &mut self,
        s: Stmt<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        then: Val,
    ) -> Option<Val> {
        let other = s.else_block().map(|e| {
            let at = sub(path, "else");
            self.body(e, frame, &at, false)
        });
        if !self.at_least(Language::V0_6) {
            return None;
        }
        let other = other.unwrap_or_else(|| self.null_val());
        Some(self.join(&then, &other))
    }

    /// A condition typed and held to `Bool`.
    fn condition(&mut self, e: Option<Expr<'a>>, frame: &mut Frame<'a>, path: &str, tail: &str) {
        let at = sub(path, tail);
        let v = self.expr_or_unknown(e, frame, &at);
        self.expect_bool(&v, &at);
    }

    /// `loop`: bounded (E0502), `until` a Bool, the body typed; in 0.6 the
    /// value is the body's, the last time it runs.
    fn loop_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) -> Option<Val> {
        let m = s.members();
        if !m.contains_key("max_iter") && !m.contains_key("until") {
            self.report(
                "E0502",
                "A loop needs 'max_iter' or 'until' (§8.6).",
                path,
                None,
            );
        }
        if let Some(u) = s.until() {
            self.condition(Some(u), frame, path, "until");
        }
        let at = sub(path, "body");
        let v = self.body(s.body(), frame, &at, false);
        self.at_least(Language::V0_6).then_some(v)
    }

    /// `return`: the value against the enclosing body's return type.
    fn return_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) {
        let at = sub(path, "value");
        let v = self.expr_or_unknown(s.value(), frame, &at);
        if let (Some(returns), Some(_)) = (frame.returns.clone(), s.value()) {
            self.expect_val(&v, &returns, &at);
        }
        // 0.7: what a function returns ([`Checker::fn_result`]).
        if frame.where_ == Where::Fn && s.value().is_some() && self.at_least(Language::V0_7) {
            let level = self.level_of(&v);
            if let Some(top) = self.returning.last_mut() {
                *top = (top.0.max(v.cls), weaker_level(top.1, level));
            }
        }
    }

    /// `on error(pattern) => then`: an UnknownOutcome only reconciled
    /// (E0712), `then` typed with the pattern's names bound to what a
    /// fault carries (in 0.6 `Untrusted`, and of nothing the checker knows,
    /// [`Checker::opaque`]; before, unknown). The handler's value, which
    /// replaces the failed statement's, unless it is a supervision strategy.
    fn on_error_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) -> Option<Val> {
        let then = s.then_expr();
        let pattern = s.pattern();
        self.unknown_outcome(pattern, then, path);
        let mut names = Vec::new();
        pattern_vars(pattern, &mut names);
        let payload = self.opaque(named("Untrusted", vec![UNKNOWN]));
        let binds: HashMap<String, Val> = names.into_iter().map(|n| (n, payload.clone())).collect();
        let mut inner = Self::child_box(frame, binds);
        let at = sub(path, "then");
        let h = self.expr_or_unknown(then, &mut inner, &at);
        (!typing::is_strategy(then)).then_some(h)
    }

    /// E0712: `on error(UnknownOutcome)` handled by anything but reconcile.
    fn unknown_outcome(
        &mut self,
        pattern: Option<Pattern<'a>>,
        then: Option<Expr<'a>>,
        path: &str,
    ) {
        if let Some(p) = pattern
            && p.kind() == Some(PatternKind::Tag)
            && p.tag() == Some("UnknownOutcome")
        {
            let strategy = then.and_then(|t| match t.op() {
                Some(ExprOp::Call) => t.callee().and_then(callee_path),
                Some(ExprOp::Var) => t.name().map(str::to_owned),
                _ => None,
            });
            if strategy.as_deref() != Some("reconcile") {
                self.report(
                    "E0712",
                    "UnknownOutcome can only be handled with reconcile; restarting could repeat an external effect (§8.7, V06).",
                    &sub(path, "then"),
                    None,
                );
            }
        }
    }

    /// `expr(e)` of a member that should be there, or the unknown value when
    /// it is not (an IR that was not validated). Inlined, so that it costs no
    /// frame on the path of the recursion.
    #[inline(always)]
    pub(crate) fn expr_or_unknown(
        &mut self,
        e: Option<Expr<'a>>,
        frame: &mut Frame<'a>,
        path: &str,
    ) -> Val {
        match e {
            Some(e) => self.expr(e, frame, path),
            None => Val::unknown(),
        }
    }

    // ── budgets (§8.6) ──────────────────────────────────────────────────

    /// The cost of a block, counted as the checker counts it: `blockCost({
    /// def, recursive, envelope, agents? }, stmts, base)`.
    pub(crate) fn cost_of(
        &self,
        stmts: &[Value],
        base: &str,
        envelope: bool,
        agents: Option<f64>,
    ) -> StaticCost {
        let def = |n: &str| self.def(n);
        let env = CostEnv {
            def: &def,
            recursive: &self.recursive,
            envelope,
            agents,
        };
        block_cost(&env, stmts, base, &[])
    }

    /// `checkBudget(name, d, base, under)`: what the body hands out against
    /// the workflow's budget (E0501). `under` is the envelope the body
    /// stands under, if any.
    pub(crate) fn check_budget(
        &mut self,
        name: &str,
        d: Definition<'a>,
        base: &str,
        under: Option<Bound<'a>>,
    ) {
        let bounds = workflow_bounds(d.value());
        let Some(limit) = bounds.budget.and_then(Budget::of) else {
            return;
        };
        let at = format!("{base}/{}", bounds.budget_at);
        let agents = under.and_then(Bound::agents);
        let cost = self.cost_of(d.body(), &format!("{base}/body"), under.is_some(), agents);
        // An envelope bounds the whole run, so its static part is held to
        // steps and agents too, and so is a sub-program's budget.
        let facts = self.over_budget(
            limit,
            &cost,
            &at,
            &format!("{name}'s budget"),
            under.is_some(),
        );
        if !facts.is_empty() {
            let keys: Vec<&str> = facts.keys().collect();
            let message = format!(
                "The budgets {name} hands out exceed its own budget ({}).",
                keys.join(", ")
            );
            let facts = facts.with(
                "breakdown",
                cost.parts.iter().map(|p| p.to_js()).collect::<Vec<_>>(),
            );
            self.report("E0501", message, &at, Some(facts));
        }
    }

    /// The dimensions in which `cost` is above `limit`, as the facts of
    /// E0501, reporting E0504 for a currency the limit is not in; `all`
    /// compares steps and agents too: `overBudget(limit, cost, at, whose, all)`.
    pub(crate) fn over_budget(
        &mut self,
        limit: Budget<'a>,
        cost: &StaticCost,
        at: &str,
        whose: &str,
        all: bool,
    ) -> JsObject {
        let mut facts = JsObject::new();
        if let Some((currency, micros)) = limit.spend() {
            let currencies: Vec<&str> = cost.spend.iter().map(|(c, _)| c.as_str()).collect();
            let other: Vec<&str> = currencies
                .iter()
                .copied()
                .filter(|c| *c != currency)
                .collect();
            if !other.is_empty() {
                self.report(
                    "E0504",
                    format!(
                        "{whose} is in {currency} but delegates spend {}; currencies are never converted implicitly (§5.3).",
                        other.join(", ")
                    ),
                    &format!("{at}/spend"),
                    Some(JsObject::new().with(
                        "currencies",
                        currencies.iter().map(|c| JsValue::from(*c)).collect::<Vec<_>>(),
                    )),
                );
            }
            let total = cost.spend_in(currency).unwrap_or(0.0);
            if total > micros {
                facts.insert(
                    "spend",
                    JsObject::new()
                        .with("limit", micros_text(micros, currency))
                        .with("declared_by_children", micros_text(total, currency)),
                );
            }
        }
        let over = |limit: f64, have: f64| {
            JsObject::new()
                .with("limit", limit)
                .with("declared_by_children", have)
        };
        if let Some(t) = limit.tokens()
            && cost.tokens > t
        {
            facts.insert("tokens", over(t, cost.tokens));
        }
        if let Some(ms) = limit.time_ms()
            && cost.time > ms
        {
            facts.insert("time_ms", over(ms, cost.time));
        }
        if all {
            if let Some(s) = limit.steps()
                && cost.steps > s
            {
                facts.insert("steps", over(s, cost.steps));
            }
            if let Some(a) = limit.agents()
                && cost.agents > a
            {
                facts.insert("agents", over(a, cost.agents));
            }
        }
        facts
    }

    /// `countNodes(stmts, seen)`: the static nodes a body expands to, a
    /// statement each, a loop's body `max_iter` times, an `if`'s two
    /// blocks, a delegation, effect, inference, verification, map or plan
    /// each, and the body of every function it calls that is not on a
    /// cycle (once per call, so a diamond of calls counts each path). A
    /// stage and a report of 0.7 are no nodes: neither counts toward any
    /// limit, and a report's pure fields hold nothing that would
    /// (spec/attention.md "`stage`", "`report`").
    pub(crate) fn count_nodes(&self, stmts: &'a [Value], seen: &[&'a str]) -> f64 {
        let mut n = 0.0;
        for s in stmts.iter().filter_map(Stmt::of) {
            if matches!(s.op(), Some(StmtOp::Stage | StmtOp::Report)) {
                continue;
            }
            n += 1.0;
            match s.op() {
                Some(StmtOp::Loop) => {
                    let times = s.max_iter().map_or(1.0, |m| m as f64);
                    n += self.count_nodes(s.body(), seen) * times;
                }
                Some(StmtOp::If) => {
                    n += self.count_nodes(s.then_block(), seen)
                        + self.count_nodes(s.else_block().unwrap_or_default(), seen);
                }
                Some(
                    StmtOp::Let
                    | StmtOp::Par
                    | StmtOp::Return
                    | StmtOp::OnError
                    | StmtOp::Run
                    | StmtOp::Expr
                    | StmtOp::Stage
                    | StmtOp::Report,
                )
                | None => {}
            }
            walk_stmt_exprs(
                s,
                &mut |x| {
                    if matches!(
                        x.op(),
                        Some(
                            ExprOp::Delegate
                                | ExprOp::Effect
                                | ExprOp::Infer
                                | ExprOp::Verify
                                | ExprOp::Map
                                | ExprOp::Plan
                        )
                    ) {
                        n += 1.0;
                    }
                    if x.is(ExprOp::Call)
                        && let Some(callee) = x.callee().filter(|c| c.is(ExprOp::Var))
                    {
                        let name = callee.name().unwrap_or_default();
                        if let Some(f) = self.def_of(name, DefKind::Fn)
                            && !seen.contains(&name)
                            && !self.recursive.contains(name)
                        {
                            let mut deeper = seen.to_vec();
                            deeper.push(name);
                            n += self.count_nodes(f.body(), &deeper);
                        }
                    }
                },
                false,
            );
        }
        n
    }

    /// `LIMITS.expandedNodes`.
    pub(crate) fn expanded_nodes_limit() -> f64 {
        limits::EXPANDED_NODES as f64
    }

    /// `peeled_type` of a `type` definition: its type with refinements
    /// peeled.
    pub(crate) fn peeled(&self, name: &str) -> Option<TypeExpr<'a>> {
        self.def_of(name, DefKind::Type)
            .and_then(|d| peeled_type(d.value()))
    }

    /// `fromTypeExpr(d.type, this)` of a `type` definition.
    pub(crate) fn def_type(d: Definition<'_>) -> Ty {
        d.type_expr().map_or(UNKNOWN, |t| from_type_expr(t, &[]))
    }

    /// `expectBool(v, path)`.
    pub(crate) fn expect_bool(&mut self, v: &Val, path: &str) {
        self.expect(&v.ty, &bool_ty(), path);
    }
}

/// One step of `findRecursion`'s depth-first `visit(n, stack)`: `state`
/// holds `false` for open and `true` for done.
fn visit<'a>(
    n: &'a str,
    stack: &mut Vec<&'a str>,
    calls: &[(&'a str, Vec<&'a str>)],
    state: &mut HashMap<&'a str, bool>,
    found: &mut Vec<(Vec<&'a str>, &'a str)>,
) {
    match state.get(n) {
        Some(true) => return,
        Some(false) => {
            let from = stack.iter().position(|s| *s == n).unwrap_or(0);
            found.push((stack.get(from..).unwrap_or_default().to_vec(), n));
            return;
        }
        None => {}
    }
    state.insert(n, false);
    let next = calls
        .iter()
        .find(|(c, _)| *c == n)
        .map(|(_, set)| set.as_slice())
        .unwrap_or_default();
    stack.push(n);
    for m in next {
        visit(m, stack, calls, state, found);
    }
    stack.pop();
    state.insert(n, true);
}

/// `${path}/${tail}`. The paths are built in functions of their own, so
/// that the frames on the path of the recursion do not each hold what
/// formatting takes.
#[inline(never)]
pub(crate) fn sub(path: &str, tail: &str) -> String {
    let mut out = String::with_capacity(path.len().saturating_add(tail.len()).saturating_add(1));
    out.push_str(path);
    out.push('/');
    out.push_str(tail);
    out
}

/// `${path}/${member}/${i}${tail}`.
#[inline(never)]
pub(crate) fn sub_i(path: &str, member: &str, i: usize, tail: &str) -> String {
    format!("{path}/{member}/{i}{tail}")
}

/// `${path}/${i}`.
#[inline(never)]
pub(crate) fn sub_n(path: &str, i: usize) -> String {
    format!("{path}/{i}")
}

/// JavaScript's truth of an optional IR member: there, and not `false`,
/// `0`, `""` or `null`.
pub(crate) fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.get() != 0,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// Whether a call's callee is the dotted path `path`: `calleePath(c.callee) === path`.
pub(crate) fn callee_is(call: Expr<'_>, path: &str) -> bool {
    call.callee()
        .and_then(callee_path)
        .is_some_and(|p| p == path)
}
