//! The attention bound of language 0.7 (spec/attention.md "The attention
//! bound", "`asks`"): for each workflow, how many questions one run can put
//! to people, per role and in all, and each place that can ask one. Rust
//! only. The same result gives E1906 (the total is above the declared
//! `asks`), E1907 (a question stands where the bound cannot count it), the
//! attention facts' question sites, effect sites and totals
//! (`crate::attention`), and the reservation of a lead's sub-program
//! (E1706, `crate::doors::check_subprogram`); E1908 (`asks` in a budget
//! that is neither a workflow's nor an envelope's) is [`asks_checks`].
//!
//! # What counts as a question
//!
//! A question is a wait for a person that the program, as it is built, can
//! open. Each kind of site is one row of the spec's table, named by
//! [`SiteKind`], a closed list the runtime tags every wait it opens with:
//!
//! | `kind` | The construct | Counts | To |
//! |---|---|---|---|
//! | `verify` | `verify x against C(…)` | 1 for each `human.approve` a criterion of `C` (`accept` or `invariant`) holds, the parts joined with `and` one by one | the approval's `role` |
//! | `ask` | `human.ask(…)` | 1 | its `role` |
//! | `escalate` | `escalate …` | 1, whatever its target | the role `human(…, role: r)` names, else none |
//! | `pause` | `pause` without `then` | 1 | none |
//! | `supervise_escalate` | `delegate … supervise escalate(…)` | [`SUPERVISE_ESCALATIONS`] | its `role`, else none |
//! | `effect` | `effect E(…)` the program hands to a person | 1 | the envelope's `approve E by r`; an environment's `by human` tier; `owner` for an irreversible one |
//! | `changeset` | `changeset` | 1 for each member, 1 for the set | each member's approver; the set's approver |
//! | `governance` | an effect or a member whose action may carry a governance-class file | 1 | the component's owner, else `owner` |
//! | `review` | `human.review(…)` | 1, and 1 more with `escalate_to` (`only: on_escalation`) | its `role`; its `escalate_to` |
//! | `plan` | `plan` | a row of its own, out of what is left of `asks` | the envelope's owner |
//!
//! The runtime cannot know before an action is prepared whether it carries
//! a governance-class file: the adapter's `prepare` says which files it
//! applies. So every effect and member that may carry files (all but a
//! connector's write tool, whose adapter carries none, and a batch commit
//! step, which never asks a person) counts its owner's gate once, marked
//! `only: governance_file`: the bound is a sum, sound and not tight.
//!
//! Not questions: the `on budget_exceeded` handler and the pause it falls
//! back to, which are rows of their own ([`WorkflowBound::budget_exceeded`])
//! out of the total, a raise of the limits, a reconciliation, a cancel and
//! a halt. A call of `human.approve(…)` outside a contract's criterion opens
//! no wait: the runtime hands it to the host's read adapter, as any other
//! standard function, so it is no site either.
//!
//! # The algebra
//!
//! [`Tally`] is `A` (a count by role, and by no role) with `T`, the total;
//! the reports to each role, `R`, are a tally of their own. A sequence and
//! the branches of a `par` are summed; `if` and `switch` take the larger
//! branch, role by role, and the larger total; `loop … max_iter n`, a map's
//! body (its `max`, or the envelope's `agents`) and the branches of a `par`
//! that `supervise restart_all` runs again ([`RESTART_ALL_ROUNDS`])
//! multiply; a loop without `max_iter`, a map without a bound, and a call
//! that recurses make what they hold unbounded. A function's and a
//! contract's sites count at each call, times what surrounds the call. A
//! statement with `on error`, a `verify` with `on unmet`: the statement's
//! own and the handler's, summed, as every other part of a block.
//!
//! A map's body holds no question the checks let through but two the
//! runtime can still ask, each item once: a `verify` whose contract's
//! `invariant` a person approves (E1708 reads `accept`), and the
//! authorization of an effect that is not critical (no batch commit step).
//! Both are counted here, times the map's bound.
//!
//! # What each question shows
//!
//! `shown` and `known` are the static checks' own: while the typing types
//! what a wait shows (the contract's arguments, the question's text, the
//! review's map outcomes, the effect's parameters), it records their class
//! and their level by the path of the construct ([`Asked`]), lowered by
//! everything typed for them as a report's field is. The bound reads that
//! record and computes nothing of its own about them.

use std::collections::{BTreeMap, HashMap, HashSet};

use mandate_ir::{
    DefKind, Definition, Diagnostic, Envelope, Expr, ExprOp, JsObject, JsValue, Language, Location,
    Map, Program, Spans, Stmt, StmtOp, Tier, TierBy, Value, budget_asks, canonicalize, ptr_token,
    workflow_bounds,
};

use crate::attention::{Count, RESTART_ALL_ROUNDS};
use crate::caps::callee_path;
use crate::statics::{Checker, Frame, ReviewSource, Val, max_class, sub_i};
use crate::stdlib::DataClass;
use crate::ty::{Level, level_rank};

/// The most escalations `supervise escalate` makes for one delegation: the
/// one constant of the specification, the compiler and the runtime
/// (`MAX_ESCALATIONS` in `runtime/src/interp.ts`; a test holds the two
/// equal).
pub const SUPERVISE_ESCALATIONS: u64 = 5;

/// Defines [`SiteKind`]: each kind with its name, `ALL`, `as_str` and
/// `from_tag`, so that the list of kinds is the enum's and nothing a person
/// keeps beside it.
macro_rules! site_kinds {
    ($($(#[$doc:meta])* $variant:ident = $tag:literal,)+) => {
        /// The kind of a question site: one name for each row of the
        /// table of spec/attention.md "What counts as a question", a closed
        /// list. The runtime tags every wait it opens with one of them.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum SiteKind {
            $($(#[$doc])* $variant,)+
        }

        impl SiteKind {
            /// Every kind, in the order of the table.
            pub const ALL: &'static [SiteKind] = &[$(SiteKind::$variant,)+];

            /// The kind's name, as the facts write it.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(SiteKind::$variant => $tag,)+
                }
            }

            /// The kind named `tag`, if the list has one.
            #[must_use]
            pub fn from_tag(tag: &str) -> Option<SiteKind> {
                match tag {
                    $($tag => Some(SiteKind::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

site_kinds! {
    /// A `human.approve` held by a criterion of the contract a `verify`
    /// checks against.
    Verify = "verify",
    /// `human.ask(…)`.
    Ask = "ask",
    /// `escalate …`.
    Escalate = "escalate",
    /// `pause` without `then`.
    Pause = "pause",
    /// An escalation of `supervise escalate`.
    SuperviseEscalate = "supervise_escalate",
    /// The authorization of an effect the program hands to a person.
    Effect = "effect",
    /// The authorization of a change set's member, or of the set.
    Changeset = "changeset",
    /// The gate of the owner of a governance-class file.
    Governance = "governance",
    /// `human.review(…)`, and its escalation.
    Review = "review",
    /// A lead's amendment request under `plan`.
    Plan = "plan",
}

/// What happens to a question nobody answers (spec/attention.md "What each
/// question records").
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OnNoAnswer {
    /// The run waits.
    Waits,
    /// Past the approval's deadline its criterion is unmet.
    Unmet,
    /// Past the deadline it goes to another role, who has a deadline of
    /// their own.
    Escalates {
        /// The role it goes to.
        to: String,
        /// That role's deadline, counted from the escalation, when a
        /// constant gives it.
        deadline_ms: Option<i64>,
    },
    /// Every open item is declined, by nobody.
    Declined,
    /// The lead's request is refused to the lead.
    RefusedToLead,
}

impl OnNoAnswer {
    /// Its name, as the facts write it.
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            OnNoAnswer::Waits => "waits",
            OnNoAnswer::Unmet => "unmet",
            OnNoAnswer::Escalates { .. } => "escalates",
            OnNoAnswer::Declined => "declined",
            OnNoAnswer::RefusedToLead => "refused_to_lead",
        }
    }
}

/// When a question is asked only in part of the runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Only {
    /// A review's escalation: only once its first role's deadline passed.
    OnEscalation,
    /// The owner's gate: only when the action carries a governance-class
    /// file.
    GovernanceFile,
    /// A row of the `on budget_exceeded` handler: only if the budget runs
    /// out, and out of the total.
    BudgetExceeded,
}

impl Only {
    /// Its name, as the facts write it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Only::OnEscalation => "on_escalation",
            Only::GovernanceFile => "governance_file",
            Only::BudgetExceeded => "budget_exceeded",
        }
    }
}

/// What the typing gave what one wait shows: the highest data class of it
/// (`Val.cls`), and how it is known (the level of its type, the weakest
/// deciding, lowered by everything typed for it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asked {
    /// Its data class.
    pub cls: DataClass,
    /// How it is known.
    pub known: Level,
}

/// What the typing gave each wait, by the path of the construct that opens
/// it (a change set's member by `…/members/<component>`).
pub type AskedMap = HashMap<String, Asked>;

/// One question site of a workflow.
#[derive(Clone, Debug, PartialEq)]
pub struct QuestionFact {
    /// The IR path of the construct that asks it, in the running program
    /// (in a function or a contract, the path in its definition).
    pub path: String,
    /// The path of the wait, as the runtime names its command without the
    /// iterations it adds (`@i`, `#allN`, `[i]`): `path`, or `path` with
    /// the part the runtime adds (`/contract/accept/<criterion>/call`,
    /// `/authorize`, `/governance`, `/members/<m>/authorize`, `/escalate`).
    pub wait: String,
    /// Its kind.
    pub kind: SiteKind,
    /// The role asked, if the program names one.
    pub role: Option<String>,
    /// The highest data class of what it shows.
    pub shown: DataClass,
    /// How what it shows is known.
    pub known: Level,
    /// Whether `shown` and `known` are the typing's; otherwise they are
    /// the most a value can be (`restricted`, `external`). A program that
    /// checks has every site typed.
    pub typed: bool,
    /// Its deadline, when a constant `deadline:` gives one.
    pub deadline_ms: Option<i64>,
    /// What happens when nobody answers.
    pub on_no_answer: OnNoAnswer,
    /// The stage of the top-level statement it stands in (of the call, for
    /// a site in a function or a contract).
    pub stage: Option<String>,
    /// How many times one run can ask it.
    pub multiplicity: Count,
    /// When it is asked only in part of the runs.
    pub only: Option<Only>,
    /// Why its multiplicity is unbounded: `loop` (a loop without
    /// `max_iter`), `map` (a map without a bound), `recursion`, `overflow`
    /// (past the largest count). `None` when it is a number.
    pub unbounded: Option<&'static str>,
}

/// One effect site: an `effect`, or a member of a change set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EffectFact {
    /// The IR path of the effect, or of the change set's member.
    pub path: String,
    /// The effect's name.
    pub effect: String,
    /// How many times one run can authorize it.
    pub multiplicity: Count,
    /// Whether the static total counts its authorization: the program
    /// hands it to a person.
    pub counted: bool,
    /// Whom the program hands it to.
    pub role: Option<String>,
    /// A batch commit step: an item that would ask a person is refused
    /// instead, whatever the runtime's configuration says, so it never asks.
    pub batch: bool,
    /// The stage it stands in.
    pub stage: Option<String>,
}

/// One `plan`: a row of its own, out of what is left of `asks`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanFact {
    /// Its path.
    pub path: String,
    /// Who decides a lead's amendment request: the envelope's owner.
    pub role: Option<String>,
    /// The class of what its lead is handed, which its requests are made
    /// of.
    pub shown: DataClass,
    /// The stage it stands in.
    pub stage: Option<String>,
    /// How many times one run can run it.
    pub multiplicity: Count,
}

/// `A` and `T`: a count for each role (and for no role, `None`), and the
/// total. The total takes the larger of two branches as each role does, so
/// the roles' counts may add up to more than it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tally {
    /// By role.
    pub by_role: BTreeMap<Option<String>, Count>,
    /// In all.
    pub total: Count,
}

impl Default for Tally {
    fn default() -> Tally {
        Tally {
            by_role: BTreeMap::new(),
            total: Count::ZERO,
        }
    }
}

impl Tally {
    /// `n` more, to `role`.
    fn add(&mut self, role: Option<&str>, n: Count) {
        let slot = self
            .by_role
            .entry(role.map(str::to_owned))
            .or_insert(Count::ZERO);
        *slot = slot.plus(n);
        self.total = self.total.plus(n);
    }

    /// One after the other: the sum, role by role.
    fn plus(&mut self, other: &Tally) {
        for (role, n) in &other.by_role {
            let slot = self.by_role.entry(role.clone()).or_insert(Count::ZERO);
            *slot = slot.plus(*n);
        }
        self.total = self.total.plus(other.total);
    }

    /// One or the other: the larger, role by role, and the larger total.
    fn or(&self, other: &Tally) -> Tally {
        let mut out = self.clone();
        for (role, n) in &other.by_role {
            let slot = out.by_role.entry(role.clone()).or_insert(Count::ZERO);
            *slot = slot.max(*n);
        }
        out.total = self.total.max(other.total);
        out
    }

    /// `k` times.
    fn times(&self, k: Count) -> Tally {
        Tally {
            by_role: self
                .by_role
                .iter()
                .map(|(r, n)| (r.clone(), n.times(k)))
                .collect(),
            total: self.total.times(k),
        }
    }

    /// The count of `role` (`None`: no role).
    #[must_use]
    pub fn of(&self, role: Option<&str>) -> Count {
        self.by_role
            .get(&role.map(str::to_owned))
            .copied()
            .unwrap_or(Count::ZERO)
    }
}

/// The questions and the reports of one part of a body, per run of it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Counts {
    asks: Tally,
    reports: Tally,
}

impl Counts {
    fn plus(&mut self, other: &Counts) {
        self.asks.plus(&other.asks);
        self.reports.plus(&other.reports);
    }

    fn or(&self, other: &Counts) -> Counts {
        Counts {
            asks: self.asks.or(&other.asks),
            reports: self.reports.or(&other.reports),
        }
    }

    fn times(&self, k: Count) -> Counts {
        Counts {
            asks: self.asks.times(k),
            reports: self.reports.times(k),
        }
    }
}

/// The attention bound of one workflow.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowBound {
    /// The workflow.
    pub workflow: String,
    /// Every question site, in the order of the body (a depth-first walk),
    /// a site in a function or a contract where it is first called.
    pub questions: Vec<QuestionFact>,
    /// Every effect site, in the same order.
    pub effects: Vec<EffectFact>,
    /// Every `plan`.
    pub plans: Vec<PlanFact>,
    /// The questions of the `on budget_exceeded` handler, or the pause it
    /// falls back to without one: only if the budget runs out, out of the
    /// total, and asked again each time it runs out (`multiplicity` is per
    /// time).
    pub budget_exceeded: Vec<QuestionFact>,
    /// `A` and `T`.
    pub asks: Tally,
    /// `R`: the reports to each role.
    pub reports: Tally,
    /// The `asks` the workflow's budget declares, or its envelope's.
    pub declared: Option<i64>,
    /// Where it is declared.
    pub declared_at: Option<String>,
}

/// What a walk found: the sites, merged by place and stage.
#[derive(Clone, Debug, Default, PartialEq)]
struct Found {
    questions: Vec<QuestionFact>,
    effects: Vec<EffectFact>,
    plans: Vec<PlanFact>,
}

impl Found {
    fn question(&mut self, q: QuestionFact) {
        let same = |x: &QuestionFact| {
            x.path == q.path
                && x.wait == q.wait
                && x.kind == q.kind
                && x.role == q.role
                && x.stage == q.stage
                && x.only == q.only
        };
        match self.questions.iter_mut().find(|x| same(x)) {
            Some(x) => {
                x.multiplicity = x.multiplicity.plus(q.multiplicity);
                x.unbounded = x.unbounded.or(q.unbounded);
                if x.multiplicity == Count::Unbounded && x.unbounded.is_none() {
                    x.unbounded = Some("overflow");
                }
            }
            None => self.questions.push(q),
        }
    }

    fn effect(&mut self, e: EffectFact) {
        match self
            .effects
            .iter_mut()
            .find(|x| x.path == e.path && x.stage == e.stage)
        {
            Some(x) => x.multiplicity = x.multiplicity.plus(e.multiplicity),
            None => self.effects.push(e),
        }
    }

    fn plan(&mut self, p: PlanFact) {
        match self
            .plans
            .iter_mut()
            .find(|x| x.path == p.path && x.stage == p.stage)
        {
            Some(x) => x.multiplicity = x.multiplicity.plus(p.multiplicity),
            None => self.plans.push(p),
        }
    }

    /// What a function or a contract found, met `ctx.times` times at a call
    /// in `ctx.stage`.
    fn called(&mut self, unit: &Found, ctx: Ctx<'_>) {
        for q in &unit.questions {
            let multiplicity = q.multiplicity.times(ctx.times);
            self.question(QuestionFact {
                stage: ctx.stage.map(str::to_owned),
                multiplicity,
                unbounded: q
                    .unbounded
                    .or(ctx.cause)
                    .or_else(|| (multiplicity == Count::Unbounded).then_some("overflow")),
                ..q.clone()
            });
        }
        for e in &unit.effects {
            self.effect(EffectFact {
                stage: ctx.stage.map(str::to_owned),
                multiplicity: e.multiplicity.times(ctx.times),
                ..e.clone()
            });
        }
        for p in &unit.plans {
            self.plan(PlanFact {
                stage: ctx.stage.map(str::to_owned),
                multiplicity: p.multiplicity.times(ctx.times),
                ..p.clone()
            });
        }
    }
}

/// Where a walk is: how many times one run meets the node, the stage of
/// its top-level statement, whether it is in a map's body, and why the
/// count is unbounded.
#[derive(Clone, Copy, Debug)]
struct Ctx<'s> {
    times: Count,
    stage: Option<&'s str>,
    in_map: bool,
    cause: Option<&'static str>,
}

impl Ctx<'_> {
    /// The context once, at the top of a body.
    fn once() -> Ctx<'static> {
        Ctx {
            times: Count::ONE,
            stage: None,
            in_map: false,
            cause: None,
        }
    }
}

/// A function or a contract, whose sites count at each call or `verify`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Unit<'a> {
    Fn(&'a str),
    Contract(&'a str),
}

/// What one function or contract asks, per call.
#[derive(Clone, Debug, Default)]
struct UnitBound {
    counts: Counts,
    found: Found,
}

/// What the bound reads of the program.
struct Env<'a> {
    /// The definitions the program sees.
    defs: &'a Map,
    /// The envelope the workflow runs under: its own, or for a lead's
    /// sub-program its parent's.
    envelope: Option<&'a Value>,
    /// What the typing gave each wait.
    asked: &'a AskedMap,
    /// The class of what each `plan` hands its lead.
    leads: &'a [(String, DataClass)],
    /// The program is of 0.6 or later (`human.review`, the batch commit
    /// step).
    v0_6: bool,
    /// For a lead's sub-program: the class of what its lead received, a
    /// floor of everything it shows.
    floor: DataClass,
}

impl<'a> Env<'a> {
    fn def(&self, name: &str) -> Option<Definition<'a>> {
        self.defs.get(name).map(Definition::of)
    }

    fn def_of(&self, name: &str, kind: DefKind) -> Option<Definition<'a>> {
        self.def(name).filter(|d| d.kind() == Some(kind))
    }

    /// What the typing gave the wait at `key`; the most a value can be when
    /// it gave nothing.
    fn shown(&self, key: &str) -> (DataClass, Level, bool) {
        match self.asked.get(key) {
            Some(a) => (a.cls, a.known, true),
            None => (DataClass::Restricted, Level::Untrusted, false),
        }
    }

    /// The bound of a map's body: its `max`, else the envelope's `agents`
    /// (the runtime's `e.max ?? envelope.budget.agents`).
    fn map_bound(&self, v: &Value) -> Option<i64> {
        v.get("max").and_then(Value::as_i64).or_else(|| {
            self.envelope
                .and_then(|e| e.get("budget"))
                .and_then(|b| b.get("agents"))
                .and_then(Value::as_i64)
        })
    }
}

/// A walk over one body, or one function's or contract's definition.
struct Walk<'e, 'a> {
    env: &'e Env<'a>,
    /// The functions and contracts walked so far.
    units: &'e Units<'a>,
    /// Those being walked: a call of one recurses.
    pending: &'e HashSet<Unit<'a>>,
    found: Found,
    /// The calls that recurse: the unit called, and where.
    cycles: Vec<(Unit<'a>, String)>,
}

/// The role a `role:` argument names: a name, or a text.
fn role_name(e: Option<Expr<'_>>) -> Option<String> {
    let e = e?;
    match e.op() {
        Some(ExprOp::Var) => e.name().map(str::to_owned),
        Some(ExprOp::Text) => e.text().map(str::to_owned),
        _ => None,
    }
}

/// The argument named `name` of a call's (or a strategy's) arguments.
fn named<'v>(args: &'v [Value], name: &str) -> Option<Expr<'v>> {
    args.iter()
        .find(|a| a.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|a| a.get("value"))
        .and_then(Expr::of)
}

/// The role an envelope's approval or an environment's tier names, as
/// written.
fn role_text(v: &Value) -> String {
    v.as_str().map_or_else(|| canonicalize(v), str::to_owned)
}

impl<'e, 'a> Walk<'e, 'a> {
    fn new(env: &'e Env<'a>, units: &'e Units<'a>, pending: &'e HashSet<Unit<'a>>) -> Walk<'e, 'a> {
        Walk {
            env,
            units,
            pending,
            found: Found::default(),
            cycles: Vec::new(),
        }
    }

    /// A constant duration: a `duration` literal, or a constant whose value
    /// is one.
    fn constant_ms(&self, e: Option<Expr<'a>>) -> Option<i64> {
        let e = e?;
        match e.op() {
            Some(ExprOp::Duration) => e.get("ms").and_then(Value::as_i64),
            Some(ExprOp::Var) => self
                .env
                .def_of(e.name()?, DefKind::Const)?
                .value_expr()
                .filter(|v| v.is(ExprOp::Duration))?
                .get("ms")
                .and_then(Value::as_i64),
            _ => None,
        }
    }

    /// One question, `n` times per run of its construct, to `role`.
    #[allow(clippy::too_many_arguments)]
    fn ask(
        &mut self,
        tally: &mut Counts,
        ctx: Ctx<'_>,
        site: Site<'_>,
        n: Count,
        deadline_ms: Option<i64>,
        on_no_answer: OnNoAnswer,
        only: Option<Only>,
    ) {
        let key = site.shown;
        let (cls, known, typed) = self.env.shown(key);
        let multiplicity = n.times(ctx.times);
        tally.asks.add(site.role.as_deref(), n);
        self.found.question(QuestionFact {
            path: site.path.to_owned(),
            wait: site.wait,
            kind: site.kind,
            role: site.role,
            shown: cls.max(self.env.floor),
            known,
            typed,
            deadline_ms,
            on_no_answer,
            stage: ctx.stage.map(str::to_owned),
            multiplicity,
            only,
            unbounded: ctx
                .cause
                .or_else(|| (multiplicity == Count::Unbounded).then_some("overflow")),
        });
    }

    /// The parts of a body, one after the other. `top` keeps the stage of
    /// each top-level statement.
    fn block(&mut self, stmts: &'a [Value], base: &str, ctx: Ctx<'a>, top: bool) -> Counts {
        let mut out = Counts::default();
        let mut stage = ctx.stage;
        for (i, s) in stmts.iter().enumerate() {
            if top && let Some(st) = Stmt::of(s).filter(|st| st.op() == Some(StmtOp::Stage)) {
                stage = st.name();
            }
            let here = Ctx { stage, ..ctx };
            out.plus(&self.node(s, &format!("{base}/{i}"), here));
        }
        out
    }

    /// A node and everything it holds.
    fn node(&mut self, v: &'a Value, path: &str, ctx: Ctx<'a>) -> Counts {
        match v {
            Value::Array(items) => {
                let mut out = Counts::default();
                for (i, x) in items.iter().enumerate() {
                    out.plus(&self.node(x, &format!("{path}/{i}"), ctx));
                }
                out
            }
            Value::Object(m) => {
                let op = v.get("op").and_then(Value::as_str);
                let mut out = Counts::default();
                if op.is_some() {
                    out.plus(&self.own(v, path, ctx));
                }
                match op {
                    // `if` takes the larger branch; `switch` the largest case.
                    Some("if") => {
                        for (k, x) in m.iter() {
                            if k != "then" && k != "else" {
                                out.plus(&self.node(x, &format!("{path}/{}", ptr_token(k)), ctx));
                            }
                        }
                        let then = self.member(v, "then", path, ctx);
                        let other = self.member(v, "else", path, ctx);
                        out.plus(&then.or(&other));
                    }
                    Some("switch") => {
                        for (k, x) in m.iter() {
                            if k != "cases" {
                                out.plus(&self.node(x, &format!("{path}/{}", ptr_token(k)), ctx));
                            }
                        }
                        let mut largest = Counts::default();
                        for (i, c) in v
                            .get("cases")
                            .and_then(Value::as_array)
                            .unwrap_or_default()
                            .iter()
                            .enumerate()
                        {
                            let case = self.node(c, &format!("{path}/cases/{i}"), ctx);
                            largest = largest.or(&case);
                        }
                        out.plus(&largest);
                    }
                    _ => {
                        for (k, x) in m.iter() {
                            let (k_times, cause, in_map) = self.multiplier(v, op, k);
                            let times = ctx.times.times(k_times);
                            let cause = ctx.cause.or_else(|| {
                                (times == Count::Unbounded).then(|| cause.unwrap_or("overflow"))
                            });
                            let inner = Ctx {
                                times,
                                cause,
                                in_map: ctx.in_map || in_map,
                                ..ctx
                            };
                            let held = self.node(x, &format!("{path}/{}", ptr_token(k)), inner);
                            out.plus(&held.times(k_times));
                        }
                    }
                }
                out
            }
            _ => Counts::default(),
        }
    }

    /// The member `k` of `v`, when it is there.
    fn member(&mut self, v: &'a Value, k: &str, path: &str, ctx: Ctx<'a>) -> Counts {
        match v.get(k) {
            Some(x) => self.node(x, &format!("{path}/{}", ptr_token(k)), ctx),
            None => Counts::default(),
        }
    }

    /// How many times the member `k` of `v` (of `op`) runs each time `v`
    /// does, why that is unbounded, and whether it is a map's body: a
    /// loop's body and condition its `max_iter`, a map's body and its
    /// items' `with caps` its bound, the branches of a `par` that
    /// `supervise restart_all` runs again [`RESTART_ALL_ROUNDS`] times.
    fn multiplier(
        &self,
        v: &Value,
        op: Option<&str>,
        k: &str,
    ) -> (Count, Option<&'static str>, bool) {
        match (op, k) {
            (Some("loop"), "body" | "until") => match v.get("max_iter").and_then(Value::as_i64) {
                Some(n) => (Count::of(n), None, false),
                None => (Count::Unbounded, Some("loop"), false),
            },
            (Some("map"), "body" | "caps") => match self.env.map_bound(v) {
                Some(n) => (Count::of(n), None, true),
                None => (Count::Unbounded, Some("map"), true),
            },
            (Some("par"), "branches")
                if v.get("supervise")
                    .and_then(|s| s.get("name"))
                    .and_then(Value::as_str)
                    == Some("restart_all") =>
            {
                (Count::Finite(RESTART_ALL_ROUNDS), None, false)
            }
            _ => (Count::ONE, None, false),
        }
    }

    /// What the node itself asks, per run of it.
    fn own(&mut self, v: &'a Value, path: &str, ctx: Ctx<'a>) -> Counts {
        let mut out = Counts::default();
        if let Some(s) = Stmt::of(v).filter(|s| s.op() == Some(StmtOp::Report)) {
            out.reports.add(s.role(), Count::ONE);
            return out;
        }
        let Some(e) = Expr::of(v) else { return out };
        let Some(op) = e.op() else { return out };
        match site_of(op) {
            OpSite::None => {}
            OpSite::Call => self.call(e, path, ctx, &mut out),
            OpSite::Verify => self.verify(e, path, ctx, &mut out),
            OpSite::Escalate => {
                let to = e.to();
                let role = to
                    .filter(|t| {
                        t.is(ExprOp::Call)
                            && t.callee().and_then(callee_path).as_deref() == Some("human")
                    })
                    .and_then(|t| role_name(named(t.arg_values(), "role")));
                self.ask(
                    &mut out,
                    ctx,
                    Site::new(path, SiteKind::Escalate, role, path),
                    Count::ONE,
                    None,
                    OnNoAnswer::Waits,
                    None,
                );
            }
            OpSite::Pause => {
                if e.then().is_none() {
                    self.ask(
                        &mut out,
                        ctx,
                        Site::new(path, SiteKind::Pause, None, path),
                        Count::ONE,
                        None,
                        OnNoAnswer::Waits,
                        None,
                    );
                }
            }
            OpSite::Delegate => {
                if let Some(s) = e.supervise().filter(|s| s.name() == Some("escalate")) {
                    let role = role_name(named(s.args(), "role"));
                    let mut site = Site::new(path, SiteKind::SuperviseEscalate, role, path);
                    site.wait = format!("{path}/escalate");
                    self.ask(
                        &mut out,
                        ctx,
                        site,
                        Count::Finite(SUPERVISE_ESCALATIONS),
                        None,
                        OnNoAnswer::Waits,
                        None,
                    );
                }
            }
            OpSite::Effect => {
                let name = e.name().unwrap_or_default();
                self.effect(name, e.arg_values(), path, None, ctx, &mut out);
            }
            OpSite::Changeset => self.changeset(e, path, ctx, &mut out),
            OpSite::Plan => {
                let envelope = self.env.envelope.and_then(Envelope::of);
                let shown = self
                    .env
                    .leads
                    .iter()
                    .find(|(p, _)| p == path)
                    .map_or(DataClass::Restricted, |(_, c)| *c);
                self.found.plan(PlanFact {
                    path: path.to_owned(),
                    role: envelope.and_then(Envelope::owner).map(str::to_owned),
                    shown: shown.max(self.env.floor),
                    stage: ctx.stage.map(str::to_owned),
                    multiplicity: ctx.times,
                });
            }
        }
        out
    }

    /// A call: `human.ask`, `human.review`, or a function of the program,
    /// whose sites count here.
    fn call(&mut self, e: Expr<'a>, path: &str, ctx: Ctx<'a>, out: &mut Counts) {
        let Some(p) = e.callee().and_then(callee_path) else {
            return;
        };
        // A tool of a connector named `human` is a tool call, as the
        // runtime reads it first.
        let connector = |n: &str| self.env.def_of(n, DefKind::Connector).is_some();
        match p.as_str() {
            "human.ask" if !connector("human") => {
                let role = role_name(named(e.arg_values(), "role"));
                self.ask(
                    out,
                    ctx,
                    Site::new(path, SiteKind::Ask, role, path),
                    Count::ONE,
                    None,
                    OnNoAnswer::Waits,
                    None,
                );
            }
            "human.review" if self.env.v0_6 && !connector("human") => {
                let args = e.arg_values();
                let role = role_name(named(args, "role"));
                let to = role_name(named(args, "escalate_to"));
                let deadline = self.constant_ms(named(args, "deadline"));
                let first = match &to {
                    Some(to) => OnNoAnswer::Escalates {
                        to: to.clone(),
                        deadline_ms: deadline,
                    },
                    None => OnNoAnswer::Declined,
                };
                self.ask(
                    out,
                    ctx,
                    Site::new(path, SiteKind::Review, role, path),
                    Count::ONE,
                    deadline,
                    first,
                    None,
                );
                if to.is_some() {
                    self.ask(
                        out,
                        ctx,
                        Site::new(path, SiteKind::Review, to, path),
                        Count::ONE,
                        deadline,
                        OnNoAnswer::Declined,
                        Some(Only::OnEscalation),
                    );
                }
            }
            name if !name.contains('.') && self.env.def_of(name, DefKind::Fn).is_some() => {
                let Some(unit) = key_of(self.env.defs, name).map(Unit::Fn) else {
                    return;
                };
                self.unit(unit, path, ctx, out);
            }
            _ => {}
        }
    }

    /// What a function or a contract asks, at a call of it.
    fn unit(&mut self, unit: Unit<'a>, path: &str, ctx: Ctx<'a>, out: &mut Counts) {
        if self.pending.contains(&unit) {
            self.cycles.push((unit, path.to_owned()));
            return;
        }
        if let Some(b) = self.units.get(&unit) {
            out.plus(&b.counts);
            self.found.called(&b.found, ctx);
        }
    }

    /// `verify x against C(…)`: each `human.approve` a criterion of `C`
    /// holds, and what the contract's own expressions ask.
    fn verify(&mut self, e: Expr<'a>, path: &str, ctx: Ctx<'a>, out: &mut Counts) {
        let Some(name) = e.contract().and_then(|c| key_of(self.env.defs, c)) else {
            return;
        };
        let Some(contract) = self.env.def_of(name, DefKind::Contract) else {
            return;
        };
        for group in ["accept", "invariant"] {
            let criteria: Vec<(&'a str, &'a Value)> = match group {
                "accept" => contract.accept().collect(),
                _ => contract.invariant().collect(),
            };
            for (cn, c) in criteria {
                let mut approvals: Vec<(String, Expr<'a>)> = Vec::new();
                if let Some(by) = c.get("by") {
                    approvals_in(by, "", &mut approvals);
                }
                for (part, call) in approvals {
                    let args = call.arg_values();
                    let role = named(args, "role").and_then(|r| match r.op() {
                        Some(ExprOp::Var) => r
                            .name()
                            .filter(|n| self.env.def_of(n, DefKind::Role).is_some())
                            .map(str::to_owned),
                        Some(ExprOp::Text) => r.text().map(str::to_owned),
                        _ => None,
                    });
                    let deadline = named(args, "deadline");
                    let on_no_answer = if deadline.is_some() {
                        OnNoAnswer::Unmet
                    } else {
                        OnNoAnswer::Waits
                    };
                    let deadline_ms = self.constant_ms(deadline);
                    let mut site = Site::new(path, SiteKind::Verify, role, path);
                    site.wait = format!("{path}/contract/{group}/{}{part}/call", ptr_token(cn));
                    self.ask(out, ctx, site, Count::ONE, deadline_ms, on_no_answer, None);
                }
            }
        }
        self.unit(Unit::Contract(name), path, ctx, out);
    }

    /// An effect at `path` (a change set's member when `member` gives its
    /// component and approver): who authorizes it, as the runtime decides
    /// it without a configuration of its own (`authorization` in
    /// `runtime/src/interp.ts`), and the owner's gate of a governance-class
    /// file it may carry.
    fn effect(
        &mut self,
        name: &str,
        args: &'a [Value],
        path: &str,
        member: Option<(&str, String)>,
        ctx: Ctx<'a>,
        out: &mut Counts,
    ) {
        let kind = self.effect_kind(name);
        // A critical effect in a map's body is a batch commit step (0.6),
        // which never asks a person: an item that would is refused.
        let batch = member.is_none() && ctx.in_map && kind.critical && self.env.v0_6;
        let owed = self.env.envelope.and_then(Envelope::of).and_then(|env| {
            env.approve()
                .find(|(k, _)| *k == name)
                .map(|(_, r)| role_text(r))
        });
        let tier = args.iter().find_map(|a| {
            let n = a
                .get("value")
                .and_then(Expr::of)
                .filter(|v| v.is(ExprOp::Var))?
                .name()?;
            let env = self.env.def_of(n, DefKind::Environment)?;
            env.authorize()
                .find(|(k, _)| *k == name)
                .and_then(|(_, t)| Tier::of(t))
        });
        let by_tier = tier
            .filter(|t| t.by() == Some(TierBy::Human))
            .map(|t| t.role().unwrap_or_default().to_owned());
        let base = owed.or_else(|| member.as_ref().map(|(_, approver)| approver.clone()));
        let base = base.or_else(|| kind.irreversible.then(|| "owner".to_owned()));
        let role = by_tier.or(base);
        // A member's facts are by its own path, `…/members/<component>`.
        let key = path;
        let effect_kind = if member.is_some() {
            SiteKind::Changeset
        } else {
            SiteKind::Effect
        };
        let auth_wait = format!("{path}/authorize");
        self.found.effect(EffectFact {
            path: path.to_owned(),
            effect: name.to_owned(),
            multiplicity: ctx.times,
            counted: !batch && role.is_some(),
            role: if batch { None } else { role.clone() },
            batch,
            stage: ctx.stage.map(str::to_owned),
        });
        if batch {
            return;
        }
        if let Some(r) = &role {
            let mut site = Site::new(path, effect_kind, Some(r.clone()), key);
            site.wait = auth_wait.clone();
            self.ask(out, ctx, site, Count::ONE, None, OnNoAnswer::Waits, None);
        }
        if kind.carries_files {
            let owner = match &member {
                Some((m, _)) => self
                    .env
                    .def_of(m, DefKind::Component)
                    .and_then(Definition::owner)
                    .unwrap_or("owner")
                    .to_owned(),
                None => "owner".to_owned(),
            };
            let mut site = Site::new(path, SiteKind::Governance, Some(owner), key);
            site.wait = if role.is_some() {
                format!("{path}/governance")
            } else {
                auth_wait
            };
            self.ask(
                out,
                ctx,
                site,
                Count::ONE,
                None,
                OnNoAnswer::Waits,
                Some(Only::GovernanceFile),
            );
        }
    }

    /// Whether the effect `name` is critical, cannot be undone, and may
    /// carry files: a connector's write tool is critical and carries none.
    fn effect_kind(&self, name: &str) -> EffectKind {
        if let Some((c, t)) = name.split_once('.')
            && let Some(conn) = self.env.def_of(c, DefKind::Connector)
            && let Some(tool) = mandate_ir::ConnectorDef::of(conn.value()).and_then(|d| d.tool(t))
        {
            return EffectKind {
                critical: tool.is_write(),
                irreversible: false,
                carries_files: false,
            };
        }
        match self.env.def_of(name, DefKind::Effect) {
            Some(d) => {
                let irreversible = truthy(d.value().get("irreversible"));
                EffectKind {
                    critical: truthy(d.value().get("critical")) || irreversible,
                    irreversible,
                    carries_files: true,
                }
            }
            None => {
                let std = crate::stdlib::std_effect(name);
                EffectKind {
                    critical: std.is_some_and(|s| s.critical),
                    irreversible: std.is_some_and(|s| s.irreversible),
                    carries_files: true,
                }
            }
        }
    }

    /// A change set: each member's authorization and owner's gate, in the
    /// order it commits them, then the set's approver.
    fn changeset(&mut self, e: Expr<'a>, path: &str, ctx: Ctx<'a>, out: &mut Counts) {
        let members: Vec<(&'a str, mandate_ir::ChangesetMember<'a>)> =
            e.changeset_members().collect();
        let order: Vec<&str> = e
            .get("order")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let mut seen: Vec<&str> = Vec::new();
        let ordered = order
            .iter()
            .copied()
            .chain(members.iter().map(|(m, _)| *m))
            .filter(|m| {
                let first = !seen.contains(m);
                seen.push(m);
                first
            })
            .collect::<Vec<_>>();
        for m in ordered {
            let Some((_, mem)) = members.iter().find(|(n, _)| *n == m) else {
                continue;
            };
            let owner = self
                .env
                .def_of(m, DefKind::Component)
                .and_then(Definition::owner)
                .unwrap_or_default();
            let approver = mem.approver().unwrap_or(owner).to_owned();
            let effect = mem.effect().unwrap_or_default();
            let mp = format!("{path}/members/{}", ptr_token(m));
            self.effect(effect, mem.arg_values(), &mp, Some((m, approver)), ctx, out);
        }
        let approver = e.approver().map(str::to_owned);
        let mut site = Site::new(path, SiteKind::Changeset, approver, path);
        site.wait = format!("{path}/authorize");
        self.ask(out, ctx, site, Count::ONE, None, OnNoAnswer::Waits, None);
    }
}

/// What kind of effect an effect is.
#[derive(Clone, Copy, Debug)]
struct EffectKind {
    critical: bool,
    irreversible: bool,
    carries_files: bool,
}

/// A question site, before its counts.
struct Site<'k> {
    path: &'k str,
    wait: String,
    kind: SiteKind,
    role: Option<String>,
    /// The key of what the typing recorded of what it shows ([`Asked`]).
    shown: &'k str,
}

impl<'k> Site<'k> {
    fn new(path: &'k str, kind: SiteKind, role: Option<String>, shown: &'k str) -> Site<'k> {
        Site {
            path,
            wait: path.to_owned(),
            kind,
            role,
            shown,
        }
    }
}

/// The key of `defs` that is `name`, borrowed from the map.
fn key_of<'a>(defs: &'a Map, name: &str) -> Option<&'a str> {
    defs.iter().map(|(k, _)| k).find(|k| *k == name)
}

/// The kind of the definition `name`.
fn kind_of(defs: &Map, name: &str) -> Option<DefKind> {
    defs.get(name)
        .map(Definition::of)
        .and_then(Definition::kind)
}

/// `!!v` of an object member.
fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_truthy)
}

/// Every `human.approve(…)` of a verifier, with the path below the
/// criterion's `by` that the runtime gives its part (`/all/i`…), parts
/// joined with `and` one by one.
fn approvals_in<'a>(by: &'a Value, part: &str, out: &mut Vec<(String, Expr<'a>)>) {
    if let Some(all) = by.get("all").and_then(Value::as_array) {
        for (i, p) in all.iter().enumerate() {
            approvals_in(p, &format!("{part}/all/{i}"), out);
        }
        return;
    }
    if let Some(call) = by.get("call").and_then(Expr::of)
        && call.is(ExprOp::Call)
        && call.callee().and_then(callee_path).as_deref() == Some("human.approve")
    {
        out.push((part.to_owned(), call));
    }
}

/// Which kind of site an expression of `op` can be: the one classification
/// the bound reads, a `match` over every operation the IR has with no arm
/// for the rest, so that an operation added to the IR is classified before
/// the compiler builds. Whether a node of that operation asks a person
/// depends on its shape too (`pause` without `then`, `delegate` with
/// `supervise escalate`, a call of `human.ask` or `human.review`).
#[must_use]
pub fn site_of(op: ExprOp) -> OpSite {
    match op {
        // A call: `human.ask`, `human.review` (0.6), or a function of the
        // program, whose own sites count at the call. `human.approve`
        // outside a criterion is the host's read adapter, and no wait.
        ExprOp::Call => OpSite::Call,
        ExprOp::Verify => OpSite::Verify,
        ExprOp::Escalate => OpSite::Escalate,
        ExprOp::Pause => OpSite::Pause,
        ExprOp::Delegate => OpSite::Delegate,
        ExprOp::Effect => OpSite::Effect,
        ExprOp::Changeset => OpSite::Changeset,
        ExprOp::Plan => OpSite::Plan,
        // None of these opens a wait for a person: values, operators, a
        // model's inference, a map (whose body is walked), a `switch`, a
        // `try`, a block; `spawn` and `await` are refused (E0711).
        ExprOp::Int
        | ExprOp::Dec
        | ExprOp::Text
        | ExprOp::Bool
        | ExprOp::Money
        | ExprOp::Duration
        | ExprOp::List
        | ExprOp::Set
        | ExprOp::Template
        | ExprOp::Prompt
        | ExprOp::Var
        | ExprOp::Field
        | ExprOp::Unary
        | ExprOp::Binary
        | ExprOp::Range
        | ExprOp::Record
        | ExprOp::Infer
        | ExprOp::Spawn
        | ExprOp::Await
        | ExprOp::Switch
        | ExprOp::Try
        | ExprOp::Block
        | ExprOp::Map => OpSite::None,
    }
}

/// Which kind of site an operation can be ([`site_of`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpSite {
    /// It never asks a person itself.
    None,
    /// `human.ask`, `human.review`, or a function's sites.
    Call,
    /// [`SiteKind::Verify`], and the contract's own sites.
    Verify,
    /// [`SiteKind::Escalate`].
    Escalate,
    /// [`SiteKind::Pause`], without `then`.
    Pause,
    /// [`SiteKind::SuperviseEscalate`], under `supervise escalate`.
    Delegate,
    /// [`SiteKind::Effect`] and [`SiteKind::Governance`].
    Effect,
    /// [`SiteKind::Changeset`] and [`SiteKind::Governance`].
    Changeset,
    /// [`SiteKind::Plan`].
    Plan,
}

impl OpSite {
    /// The kinds of question a node of this classification can ask.
    #[must_use]
    pub const fn kinds(self) -> &'static [SiteKind] {
        match self {
            OpSite::None => &[],
            OpSite::Call => &[SiteKind::Ask, SiteKind::Review],
            OpSite::Verify => &[SiteKind::Verify],
            OpSite::Escalate => &[SiteKind::Escalate],
            OpSite::Pause => &[SiteKind::Pause],
            OpSite::Delegate => &[SiteKind::SuperviseEscalate],
            OpSite::Effect => &[SiteKind::Effect, SiteKind::Governance],
            OpSite::Changeset => &[SiteKind::Changeset, SiteKind::Governance],
            OpSite::Plan => &[SiteKind::Plan],
        }
    }
}

/// What a statement of `op` asks itself: none does, but through the
/// expressions it holds; a `report` is a report, no question. A `match`
/// with no arm for the rest, as [`site_of`].
#[must_use]
pub const fn statement_asks(op: StmtOp) -> bool {
    match op {
        StmtOp::Let
        | StmtOp::Par
        | StmtOp::If
        | StmtOp::Loop
        | StmtOp::Return
        | StmtOp::OnError
        | StmtOp::Run
        | StmtOp::Expr
        | StmtOp::Stage
        | StmtOp::Report => false,
    }
}

/// The functions and contracts `v` calls or verifies against, in order.
fn units_in<'a>(defs: &'a Map, v: &'a Value, out: &mut Vec<Unit<'a>>) {
    match v {
        Value::Array(items) => {
            for x in items {
                units_in(defs, x, out);
            }
        }
        Value::Object(m) => {
            if let Some(e) = Expr::of(v) {
                let found = match e.op() {
                    Some(ExprOp::Call) => e
                        .callee()
                        .and_then(callee_path)
                        .filter(|p| !p.contains('.'))
                        .and_then(|p| key_of(defs, &p))
                        .filter(|k| kind_of(defs, k) == Some(DefKind::Fn))
                        .map(Unit::Fn),
                    Some(ExprOp::Verify) => e
                        .contract()
                        .and_then(|c| key_of(defs, c))
                        .filter(|k| kind_of(defs, k) == Some(DefKind::Contract))
                        .map(Unit::Contract),
                    _ => None,
                };
                if let Some(u) = found
                    && !out.contains(&u)
                {
                    out.push(u);
                }
            }
            for (_, x) in m.iter() {
                units_in(defs, x, out);
            }
        }
        _ => {}
    }
}

/// The parts of a function's or a contract's definition the runtime runs,
/// with their paths: a function's body; a contract's `require` and each
/// criterion's verifier.
fn unit_parts<'a>(defs: &'a Map, unit: Unit<'a>) -> Vec<(String, &'a Value)> {
    let (Unit::Fn(name) | Unit::Contract(name)) = unit;
    let Some(d) = defs.get(name) else {
        return Vec::new();
    };
    let base = format!("/defs/{}", ptr_token(name));
    match unit {
        Unit::Fn(_) => d
            .get("body")
            .map(|b| vec![(format!("{base}/body"), b)])
            .unwrap_or_default(),
        Unit::Contract(_) => {
            let mut out = Vec::new();
            if let Some(r) = d.get("require") {
                out.push((format!("{base}/require"), r));
            }
            for group in ["accept", "invariant"] {
                for (cn, c) in d
                    .get(group)
                    .and_then(Value::as_object)
                    .into_iter()
                    .flat_map(Map::iter)
                {
                    if let Some(by) = c.get("by") {
                        out.push((format!("{base}/{group}/{}/by", ptr_token(cn)), by));
                    }
                }
            }
            out
        }
    }
}

/// What each function and contract asks, per call.
type Units<'a> = HashMap<Unit<'a>, UnitBound>;

/// The calls that recur: the unit whose walk met it, the unit it calls,
/// and where.
type Cycles<'a> = Vec<(Unit<'a>, Unit<'a>, String)>;

/// The functions and contracts the parts `roots` reach, walked so that each
/// is walked after what it calls: depth first and without recursion of the
/// compiler's own, so that a chain of calls as long as a program may write
/// costs no stack. A call of one still being walked recurses: it is left
/// for [`bound`] to make unbounded.
fn walk_units<'a>(env: &Env<'a>, roots: &[&'a Value]) -> (Units<'a>, Cycles<'a>) {
    let mut done: Units<'a> = HashMap::new();
    let mut cycles: Cycles<'a> = Vec::new();
    let mut pending: HashSet<Unit<'a>> = HashSet::new();
    let mut start: Vec<Unit<'a>> = Vec::new();
    for r in roots {
        units_in(env.defs, r, &mut start);
    }
    // (unit, its callees, the next callee to visit)
    let mut stack: Vec<(Unit<'a>, Vec<Unit<'a>>, usize)> = Vec::new();
    for s in start {
        if done.contains_key(&s) || pending.contains(&s) {
            continue;
        }
        let mut callees = Vec::new();
        for (_, part) in unit_parts(env.defs, s) {
            units_in(env.defs, part, &mut callees);
        }
        pending.insert(s);
        stack.push((s, callees, 0));
        while let Some((unit, callees, next)) = stack.last_mut() {
            if let Some(c) = callees.get(*next).copied() {
                *next += 1;
                if done.contains_key(&c) || pending.contains(&c) {
                    continue;
                }
                let mut more = Vec::new();
                for (_, part) in unit_parts(env.defs, c) {
                    units_in(env.defs, part, &mut more);
                }
                pending.insert(c);
                stack.push((c, more, 0));
                continue;
            }
            let unit = *unit;
            let mut w = Walk::new(env, &done, &pending);
            let mut counts = Counts::default();
            for (at, part) in unit_parts(env.defs, unit) {
                counts.plus(&w.node(part, &at, Ctx::once()));
            }
            for (c, at) in std::mem::take(&mut w.cycles) {
                cycles.push((unit, c, at));
            }
            let found = std::mem::take(&mut w.found);
            pending.remove(&unit);
            done.insert(unit, UnitBound { counts, found });
            stack.pop();
        }
    }
    (done, cycles)
}

/// The attention bound of the workflow `name` (`d`, a workflow written
/// out: an application is bound on its expansion).
fn bound<'a>(env: &Env<'a>, name: &str, d: Definition<'a>) -> WorkflowBound {
    let base = format!("/defs/{}", ptr_token(name));
    let handler = d
        .on()
        .iter()
        .enumerate()
        .find(|(_, h)| h.get("event").and_then(Value::as_str) == Some("budget_exceeded"));
    let mut roots: Vec<&'a Value> = vec![d.value().get("body").unwrap_or(&Value::Null)];
    if let Some(e) = d.value().get("ensures") {
        roots.push(e);
    }
    if let Some((_, h)) = handler {
        roots.push(h);
    }
    let (units, unit_cycles) = walk_units(env, &roots);
    let none = HashSet::new();
    let mut w = Walk::new(env, &units, &none);
    let mut counts = w.block(d.body(), &format!("{base}/body"), Ctx::once(), true);
    if let Some(e) = d.value().get("ensures") {
        counts.plus(&w.node(e, &format!("{base}/ensures"), Ctx::once()));
    }
    let mut found = std::mem::take(&mut w.found);
    // The handler's questions, apart.
    let mut h = Walk::new(env, &units, &none);
    let mut budget_exceeded: Vec<QuestionFact> = match handler {
        Some((i, hv)) => {
            if let Some(then) = hv.get("then") {
                h.node(then, &format!("{base}/on/{i}/then"), Ctx::once());
            }
            std::mem::take(&mut h.found.questions)
        }
        None => vec![QuestionFact {
            path: base.clone(),
            wait: format!("{base}/on/budget_exceeded"),
            kind: SiteKind::Pause,
            role: None,
            shown: DataClass::Public.max(env.floor),
            known: Level::Plain,
            typed: true,
            deadline_ms: None,
            on_no_answer: OnNoAnswer::Waits,
            stage: None,
            multiplicity: Count::ONE,
            only: None,
            unbounded: None,
        }],
    };
    for q in &mut budget_exceeded {
        q.only = Some(Only::BudgetExceeded);
    }
    // A call that recurses into what holds a question makes it unbounded.
    let holds: HashSet<Unit<'a>> = {
        let mut holds: HashSet<Unit<'a>> = units
            .iter()
            .filter(|(_, b)| !b.found.questions.is_empty())
            .map(|(u, _)| *u)
            .collect();
        loop {
            let before = holds.len();
            for (from, to, _) in &unit_cycles {
                if holds.contains(to) {
                    holds.insert(*from);
                }
            }
            if holds.len() == before {
                break;
            }
        }
        holds
    };
    let recursing: Vec<(Unit<'a>, &str)> = unit_cycles
        .iter()
        .filter(|(_, to, _)| holds.contains(to))
        .map(|(_, to, at)| (*to, at.as_str()))
        .collect();
    if !recursing.is_empty() {
        let in_cycle = |path: &str| {
            recursing.iter().any(|(u, _)| {
                let (Unit::Fn(n) | Unit::Contract(n)) = u;
                path.starts_with(&format!("/defs/{}/", ptr_token(n)))
            })
        };
        for q in &mut found.questions {
            if in_cycle(&q.path) {
                q.multiplicity = Count::Unbounded;
                q.unbounded = Some("recursion");
                let slot = counts
                    .asks
                    .by_role
                    .entry(q.role.clone())
                    .or_insert(Count::ZERO);
                *slot = Count::Unbounded;
            }
        }
        counts.asks.total = Count::Unbounded;
    }
    let bounds = workflow_bounds(d.value());
    let declared = budget_asks(bounds.budget);
    WorkflowBound {
        workflow: name.to_owned(),
        questions: found.questions,
        effects: found.effects,
        plans: found.plans,
        budget_exceeded,
        asks: counts.asks,
        reports: counts.reports,
        declared,
        declared_at: declared.map(|_| format!("{base}/{}/asks", bounds.budget_at)),
    }
}

/// The weaker of two levels.
fn weaker(a: Level, b: Level) -> Level {
    if level_rank(a) > level_rank(b) { a } else { b }
}

impl<'a> Checker<'a> {
    /// A call's (or a `verify`'s, a delegation's, an effect's) arguments,
    /// typed as [`Checker::call_args`] types them; in 0.7, those `shows`
    /// selects typed as what a wait shows, and recorded at `key`.
    pub(crate) fn asked_args(
        &mut self,
        e: Expr<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        key: &str,
        shows: impl Fn(usize, &Value) -> bool,
    ) -> Vec<Val> {
        if !self.at_least(Language::V0_7) {
            return self.call_args(e, frame, path);
        }
        let mut args: Vec<Val> = Vec::new();
        let mut shown: Vec<(Val, Level)> = Vec::new();
        for (i, a) in e.arg_values().iter().enumerate() {
            let at = sub_i(path, "args", i, "/value");
            let x = a.get("value").and_then(Expr::of);
            if shows(i, a) {
                args.push(self.shown_expr(x, frame, &at, &mut shown));
            } else {
                args.push(self.expr_or_unknown(x, frame, &at));
            }
        }
        self.record_asked(key, &shown);
        args
    }

    /// `x` typed as what a wait shows, recorded at `key` (0.7).
    pub(crate) fn asked_expr(
        &mut self,
        x: Option<Expr<'a>>,
        frame: &mut Frame<'a>,
        at: &str,
        key: &str,
    ) -> Val {
        if !self.at_least(Language::V0_7) {
            return self.expr_or_unknown(x, frame, at);
        }
        let mut shown = Vec::new();
        let v = self.shown_expr(x, frame, at, &mut shown);
        self.record_asked(key, &shown);
        v
    }

    /// `x` typed as what a wait shows: in 0.7 with the floor set from
    /// verified, so that everything typed for it lowers it (as a report's
    /// field is typed), the value and that floor pushed onto `shown`.
    pub(crate) fn shown_expr(
        &mut self,
        x: Option<Expr<'a>>,
        frame: &mut Frame<'a>,
        at: &str,
        shown: &mut Vec<(Val, Level)>,
    ) -> Val {
        if !self.at_least(Language::V0_7) || x.is_none() {
            return self.expr_or_unknown(x, frame, at);
        }
        let outer = self.report_floor.replace(Level::Verified);
        let v = self.expr_or_unknown(x, frame, at);
        let floor = std::mem::replace(&mut self.report_floor, outer).unwrap_or(Level::Verified);
        shown.push((v.clone(), floor));
        v
    }

    /// What a wait at `key` shows: the highest class of `shown`, and the
    /// weakest of their levels and floors (`plain` when it shows nothing).
    pub(crate) fn record_asked(&mut self, key: &str, shown: &[(Val, Level)]) {
        let cls = self.floor.max(max_class(shown.iter().map(|(v, _)| v.cls)));
        let known = if shown.is_empty() {
            Level::Plain
        } else {
            shown.iter().fold(Level::Verified, |k, (v, floor)| {
                weaker(weaker(k, crate::reports::known(&v.ty, self)), *floor)
            })
        };
        self.asked.insert(key.to_owned(), Asked { cls, known });
    }

    /// What a review at `path` shows: its map's outcomes, of class `cls`,
    /// each open item known as its value was before it was verified.
    pub(crate) fn asked_review(&mut self, path: &str, cls: DataClass, src: &ReviewSource) {
        let known = weaker(src.level, crate::reports::known(&src.item, self));
        let cls = self.floor.max(cls);
        self.asked.insert(path.to_owned(), Asked { cls, known });
    }

    /// The attention bound of each of the program's own workflows (0.7),
    /// and E1906 and E1907 for one that declares `asks`.
    pub(crate) fn attention_bounds(&mut self) {
        let program = self.program;
        let defs: &'a Map = self.defs;
        let claim_envelope = self.claim.and_then(|c| c.envelope);
        let mut found: Vec<WorkflowBound> = Vec::new();
        {
            for (name, d) in program.definitions() {
                if d.kind() != Some(DefKind::Workflow) || d.value().get("apply").is_some() {
                    continue;
                }
                let envelope = d
                    .value()
                    .get("envelope")
                    .filter(|e| e.is_truthy())
                    .or(claim_envelope);
                let env = Env {
                    defs,
                    envelope,
                    asked: &self.asked,
                    leads: &self.leads,
                    v0_6: true,
                    floor: if self.claim.is_some() {
                        self.floor
                    } else {
                        DataClass::Public
                    },
                };
                found.push(bound(&env, name, d));
            }
        }
        for b in &found {
            self.asks_diagnostics(b);
        }
        self.bounds = found;
    }

    /// E1906 and E1907 of one workflow's bound.
    fn asks_diagnostics(&mut self, b: &WorkflowBound) {
        let (Some(asks), Some(at)) = (b.declared, b.declared_at.as_deref()) else {
            return;
        };
        let name = b.workflow.as_str();
        match b.asks.total {
            Count::Finite(total) if i64::try_from(total).is_ok_and(|t| t > asks) => {
                let roles: Vec<JsValue> = b
                    .asks
                    .by_role
                    .iter()
                    .map(|(r, n)| {
                        JsObject::new()
                            .with("role", r.as_deref().map_or(JsValue::Null, JsValue::from))
                            .with("questions", n.to_js())
                            .into()
                    })
                    .collect();
                self.report(
                    "E1906",
                    format!(
                        "{name} can put {total} questions to people in one run, and its budget allows {asks} (asks: {asks}). Raise asks, or ask fewer: every question counts, a review's escalation and an owner's gate of a governance-class file among them (spec/attention.md \"The attention bound\")."
                    ),
                    at,
                    Some(
                        JsObject::new()
                            .with("workflow", name)
                            .with("asks", asks as f64)
                            .with("total", Count::Finite(total).to_js())
                            .with("roles", roles),
                    ),
                );
            }
            Count::Finite(_) => {}
            Count::Unbounded => {
                let mut reported: Vec<&str> = Vec::new();
                for q in &b.questions {
                    if q.multiplicity != Count::Unbounded || reported.contains(&q.path.as_str()) {
                        continue;
                    }
                    reported.push(&q.path);
                    let why = q.unbounded.unwrap_or("overflow");
                    let place = match why {
                        "loop" => "in a loop without max_iter",
                        "map" => "in a map without a bound",
                        "recursion" => "in a function that calls itself",
                        _ => "more times than the bound can count",
                    };
                    self.report(
                        "E1907",
                        format!(
                            "{name} declares asks: {asks}, and this question ({}) stands {place}: the bound cannot count it. Give the loop a max_iter, or ask outside it (spec/attention.md \"The algebra\").",
                            q.kind.as_str()
                        ),
                        &q.path,
                        Some(
                            JsObject::new()
                                .with("workflow", name)
                                .with("kind", q.kind.as_str())
                                .with("why", why)
                                .with("asks", asks as f64),
                        ),
                    );
                }
                if reported.is_empty() {
                    self.report(
                        "E1907",
                        format!(
                            "{name} declares asks: {asks}, and the questions it can ask are more than the bound can count (spec/attention.md \"The algebra\")."
                        ),
                        at,
                        Some(
                            JsObject::new()
                                .with("workflow", name)
                                .with("why", "overflow")
                                .with("asks", asks as f64),
                        ),
                    );
                }
            }
        }
    }
}

/// E1908 (spec/attention.md "`asks`"): `asks` in any budget but a
/// workflow's or an envelope's, in a program of 0.7. Nothing for an older
/// program, whose schema has no `asks`.
#[must_use]
pub fn asks_checks(program: Program<'_>, spans: Option<&Spans>) -> Vec<Diagnostic> {
    if !program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_7))
    {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (name, d) in program.definitions() {
        let base = format!("/defs/{}", ptr_token(name));
        let kind = d.kind();
        budgets(d.value(), &base, &mut |budget, at, holder| {
            if budget.get("asks").is_none() {
                return;
            }
            let own = kind == Some(DefKind::Workflow)
                && (at == format!("{base}/budget") || at == format!("{base}/envelope/budget"));
            if own {
                return;
            }
            let place = holder.unwrap_or_else(|| kind.map_or("definition", DefKind::as_str));
            let path = format!("{at}/asks");
            let span = mandate_ir::nearest_span(spans, &path);
            out.push(Diagnostic::new(
                "E1908",
                format!(
                    "asks bounds the questions a whole run may put to people, so it is a field of a workflow's budget or of an envelope's, and of no other: this one is in {name}'s {place} budget (spec/attention.md \"asks\")."
                ),
                Location::path_span(path, span),
                Some(JsObject::new().with("def", name).with("place", place)),
            ));
        });
    }
    out
}

/// Every budget under `v` (at `path`): `visit(budget, its path, the op of
/// the node that holds it)`.
fn budgets<'v>(
    v: &'v Value,
    path: &str,
    visit: &mut dyn FnMut(&'v Value, &str, Option<&'static str>),
) {
    match v {
        Value::Array(items) => {
            for (i, x) in items.iter().enumerate() {
                budgets(x, &format!("{path}/{i}"), visit);
            }
        }
        Value::Object(m) => {
            if let Some(b) = m.get("budget").filter(|b| b.as_object().is_some()) {
                let holder = v
                    .get("op")
                    .and_then(ExprOp::from_value)
                    .map(ExprOp::as_str)
                    .or_else(|| path.contains("/skills/").then_some("skill"));
                visit(b, &format!("{path}/budget"), holder);
            }
            for (k, x) in m.iter() {
                budgets(x, &format!("{path}/{}", ptr_token(k)), visit);
            }
        }
        _ => {}
    }
}
