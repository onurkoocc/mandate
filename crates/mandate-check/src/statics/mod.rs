//! The static checks (Gate 1): a port of `compiler/src/check/static.ts`,
//! the class `Checker` and the function `staticCheck` that runs it.
//!
//! It runs after name resolution on a program whose names all resolve. One
//! pass per definition types every expression, tracking for each value its
//! type, how it is known (§5.2) and its data class (§5.5), and records which
//! effects it uses.
//!
//! The port is in three slices, one file each, all of them `impl` blocks of
//! the one [`Checker`]:
//!
//! - the core (this file and `expr.rs`, slice R11): the state, the pass
//!   order of `run`, constants, functions, contracts, recursion, statements,
//!   the typer of expressions, budgets and the node count;
//! - the authority (`authority.rs`, slice R12): capabilities, agents,
//!   workflows, delegation, `map`, `par`, effects and envelopes;
//! - the system model (`system.rs`, slice R13): providers, working copies,
//!   declared reads, `data.read` and change sets, and `leadClasses`.
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
mod system;

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
    Problem, Ty, TypeEnv, UNKNOWN, assignable, bool_ty, from_type_expr, peeled_type, ty_of,
};
use crate::walk::{walk_exprs, walk_stmt_exprs};

/// A value's type and data class: `Val`, `{ ty, cls }`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Val {
    /// Its type.
    pub(crate) ty: Ty,
    /// Its data class.
    pub(crate) cls: DataClass,
}

impl Val {
    /// `{ ty, cls: PUBLIC }`.
    pub(crate) fn public(ty: Ty) -> Val {
        Val {
            ty,
            cls: DataClass::Public,
        }
    }

    /// `{ ty: UNKNOWN, cls: PUBLIC }`.
    pub(crate) fn unknown() -> Val {
        Val::public(UNKNOWN)
    }
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

/// The variables of a scope, and the scope around it: `Scope`. A scope is
/// never changed once made, so frames share it.
#[derive(Debug, Default)]
pub(crate) struct Scope {
    vars: HashMap<String, Val>,
    parent: Option<Rc<Scope>>,
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
    #[expect(dead_code, reason = "R12 writes it in E0408 of effectCall")]
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
    #[expect(dead_code, reason = "R12 compares it with a map's par, E1703")]
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
}

impl<'a> Frame<'a> {
    /// `{ where, def, scope: { vars }, usages: [], approved: false, delegated: [] }`.
    fn new(where_: Where, def: &str, vars: HashMap<String, Val>) -> Frame<'a> {
        Frame {
            where_,
            def: def.to_owned(),
            scope: Rc::new(Scope { vars, parent: None }),
            usages: Rc::new(RefCell::new(Vec::new())),
            avail: None,
            returns: None,
            approved: false,
            delegated: Rc::new(RefCell::new(Vec::new())),
            handed: None,
            max_class: None,
            envelope: None,
            in_map: None,
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

/// The checker: `class Checker`. Its fields are those of all three slices;
/// each slice reads and writes its own.
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
    /// R12, `capDefs`: what each capability definition evaluates to.
    pub(crate) cap_defs: HashMap<String, Vec<CapVal>>,
    /// R11, `fnUsage`: the effects each function uses.
    fn_usage: HashMap<String, Memo<Vec<Usage>>>,
    /// R12, `skillUsage`: what the body of each of the program's own skills
    /// uses, by `Agent.skill`.
    pub(crate) skill_usage: HashMap<String, Vec<Usage>>,
    /// R12, `askedInMap`: the `human.*` steps already reported as standing
    /// in a map's body (E1708).
    pub(crate) asked_in_map: HashSet<String>,
    /// R12, `enveloped`: the program's workflows with an envelope, in push
    /// order.
    pub(crate) enveloped: Vec<Enveloped>,
    /// R11, `constVals`.
    const_vals: HashMap<String, Memo<Val>>,
    /// R11, `recursive`: the functions and workflows on a call cycle.
    pub(crate) recursive: HashSet<String>,
    /// R12 writes it (`plan`), R13 reads it (`leadClasses`), `leads`: the
    /// data class of what each `plan` hands its lead, by the plan's path,
    /// in insertion order (a `Map`).
    pub(crate) leads: Vec<(String, DataClass)>,
}

impl TypeEnv for Checker<'_> {
    fn type_def(&self, name: &str) -> Option<&Value> {
        self.def(name)
            .filter(|d| d.kind() == Some(DefKind::Type))
            .map(Definition::value)
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
    let defs = match linked {
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
        }
    }

    // ── TypeEnv and helpers ─────────────────────────────────────────────

    /// `def(name)`: `Object.hasOwn(this.defs, name) ? this.defs[name] : undefined`.
    pub(crate) fn def(&self, name: &str) -> Option<Definition<'a>> {
        self.defs.get(name).map(Definition::of)
    }

    /// The definition `name` when it is of kind `kind`.
    pub(crate) fn def_of(&self, name: &str, kind: DefKind) -> Option<Definition<'a>> {
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
                Some(DefKind::Workflow) => self.check_workflow(name, d, &base),
                Some(DefKind::Contract) => self.check_contract(name, d, &base),
                _ => {}
            }
        }
        for w in self.enveloped.clone() {
            let usages = w.usages.borrow().clone();
            self.reach(&w.name, w.max, &usages);
        }
    }

    // ── definitions ─────────────────────────────────────────────────────

    /// `constFrame()`.
    pub(crate) fn const_frame(&self) -> Frame<'a> {
        Frame::new(Where::Const, "", HashMap::new())
    }

    /// The value of a constant, typed on first request: `constVal(name)`.
    /// While it is typed it reads as unknown, so a constant on a cycle is
    /// typed once.
    pub(crate) fn const_val(&mut self, name: &str) -> Val {
        match self.const_vals.get(name) {
            Some(Memo::Pending) => return Val::unknown(),
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
                self.expect(&v.ty, &t, at);
                Val { ty: t, cls: v.cls }
            }
            None => v,
        }
    }

    /// `isCriticalEffect(name)`.
    pub(crate) fn is_critical_effect(&self, name: &str) -> bool {
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
            vars.insert(name.to_owned(), Val { ty, cls });
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
        self.body(d.body(), &frame, &at, true);
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
            } else if has(p, VerifierForm::Call) {
                if let Some(c) = p.get("call").and_then(Expr::of) {
                    self.expr(c, frame, &format!("{pp}/call"));
                }
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
        for (cycle, n) in found {
            for c in &cycle {
                self.recursive.insert((*c).to_owned());
            }
            let mut shown: Vec<&str> = cycle.clone();
            shown.push(n);
            self.report(
                "E0502",
                format!(
                    "Recursive call cycle {}; static node and budget bounds need an acyclic call graph.",
                    shown.join(" → ")
                ),
                &ptr(&[&"defs", &n]),
                Some(JsObject::new().with(
                    "cycle",
                    cycle.iter().map(|c| JsValue::from(*c)).collect::<Vec<_>>(),
                )),
            );
        }
    }

    // ── statements ──────────────────────────────────────────────────────

    /// `child(frame, vars)`: `{ ...frame, scope: { vars, parent: frame.scope } }`.
    pub(crate) fn child(frame: &Frame<'a>, vars: HashMap<String, Val>) -> Frame<'a> {
        Frame {
            scope: Rc::new(Scope {
                vars,
                parent: Some(Rc::clone(&frame.scope)),
            }),
            ..frame.clone()
        }
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
    pub(crate) fn body(
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

    /// The tail of a definition's body against its declared return type.
    fn body_result(&mut self, stmts: &[Value], outer: &Frame<'a>, base: &str, last: &Val) {
        if let Some(tail) = stmts.last().and_then(Stmt::of)
            && tail.op() == Some(StmtOp::Expr)
            && let Some(returns) = &outer.returns
        {
            let at = sub_n(base, stmts.len().saturating_sub(1));
            self.expect(&last.ty, returns, &sub(&at, "value"));
        }
    }

    /// One statement of a block in `frame`, which a `let` or a `par`
    /// replaces with its child; the value of an `expr` statement.
    fn stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) -> Option<Val> {
        match s.op() {
            Some(StmtOp::Let) => self.let_stmt(s, frame, path),
            Some(StmtOp::Par) => self.par_stmt(s, frame, path),
            Some(StmtOp::If) => self.if_stmt(s, frame, path),
            Some(StmtOp::Loop) => self.loop_stmt(s, frame, path),
            Some(StmtOp::Return) => self.return_stmt(s, frame, path),
            Some(StmtOp::OnError) => self.on_error_stmt(s, frame, path),
            Some(StmtOp::Run) => {
                self.operand(s.target(), frame, path, "target");
            }
            Some(StmtOp::Expr) => return Some(self.operand(s.value(), frame, path, "value")),
            None => {}
        }
        None
    }

    /// `par`: its branches' values bound in a child of the frame.
    fn par_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) {
        let vars = self.par(s, frame, path);
        *frame = Self::child(frame, vars);
    }

    /// `let`: the value, against the declared type if any, bound in a child
    /// of the frame.
    fn let_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) {
        let at = sub(path, "value");
        let v = self.expr_or_unknown(s.value(), frame, &at);
        let bound = self.declared(s, v, &at);
        let mut vars = HashMap::new();
        vars.insert(s.name().unwrap_or_default().to_owned(), bound);
        *frame = Self::child(frame, vars);
    }

    /// A `let`'s value as bound: of its declared type, when it has one.
    fn declared(&mut self, s: Stmt<'a>, v: Val, at: &str) -> Val {
        match s.type_expr() {
            Some(t) => {
                let t = self.ty(Some(t));
                self.expect(&v.ty, &t, at);
                Val { ty: t, cls: v.cls }
            }
            None => v,
        }
    }

    /// `if`: the condition a Bool, both blocks typed.
    fn if_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) {
        self.condition(s.cond(), frame, path, "cond");
        let at = sub(path, "then");
        self.body(s.then_block(), frame, &at, false);
        if let Some(e) = s.else_block() {
            let at = sub(path, "else");
            self.body(e, frame, &at, false);
        }
    }

    /// A condition typed and held to `Bool`.
    fn condition(&mut self, e: Option<Expr<'a>>, frame: &mut Frame<'a>, path: &str, tail: &str) {
        let at = sub(path, tail);
        let v = self.expr_or_unknown(e, frame, &at);
        self.expect_bool(&v, &at);
    }

    /// `loop`: bounded (E0502), `until` a Bool, the body typed.
    fn loop_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) {
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
        self.body(s.body(), frame, &at, false);
    }

    /// `return`: the value against the enclosing body's return type.
    fn return_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) {
        let at = sub(path, "value");
        let v = self.expr_or_unknown(s.value(), frame, &at);
        if let (Some(returns), Some(_)) = (frame.returns.clone(), s.value()) {
            self.expect(&v.ty, &returns, &at);
        }
    }

    /// `on error(pattern) => then`: an UnknownOutcome only reconciled
    /// (E0712), `then` typed with the pattern's names bound to unknown.
    fn on_error_stmt(&mut self, s: Stmt<'a>, frame: &mut Frame<'a>, path: &str) {
        let then = s.then_expr();
        let pattern = s.pattern();
        self.unknown_outcome(pattern, then, path);
        let mut names = Vec::new();
        pattern_vars(pattern, &mut names);
        let binds: HashMap<String, Val> = names.into_iter().map(|n| (n, Val::unknown())).collect();
        let mut inner = Self::child_box(frame, binds);
        let at = sub(path, "then");
        self.expr_or_unknown(then, &mut inner, &at);
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
    /// cycle (once per call, so a diamond of calls counts each path).
    pub(crate) fn count_nodes(&self, stmts: &'a [Value], seen: &[&'a str]) -> f64 {
        let mut n = 0.0;
        for s in stmts.iter().filter_map(Stmt::of) {
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
                _ => {}
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
