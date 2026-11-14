//! The cost view: what each workflow hands out, a budget per delegation and
//! the static upper bound, with the lock's per-call bound
//! (`compiler/src/views/views.ts`, lines 159-168 `delegateBudget` and
//! 540-668, and `costBlocks`, lines 1540-1547).
//!
//! The sums are doubles, as in JavaScript: a count of times that is the
//! product of limits is a `Number`, and the micro-units of a currency are
//! divided by 1,000,000 as doubles and written as `Number::toString` writes
//! them. The currencies of a sum are an object's members, kept in an
//! object's order ([`JsObject`]).
//!
//! A workflow with an envelope adds to its total the delegations a run
//! starts, as the checker counts them: `staticCost(program, name)?.agents`
//! of `check/cost.ts` ([`mandate_check::static_cost`]), so that the view and
//! E0501 agree.

use mandate_check::{
    CapVal, Lock, ProgramRef, VIEW_FORMAT, defs_of, grant_of, handed_by, is_kind, js_text,
    per_call_bound, program_ref, static_cost, to_number, view_children,
};
use mandate_ir::{
    Definition, Expr, ExprOp, JsObject, JsValue, Map, Program, Stmt, StmtOp, Value, compare_utf16,
    number_to_string, workflow_bounds,
};

use crate::doc::{Block, Cell};
use crate::shown::{num, num_or, show, sorted_defs};

/// Where a delegation's budget comes from: the `from` of `delegateBudget`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetFrom {
    /// The call's own.
    Call,
    /// The skill's.
    Skill,
    /// The agent's.
    Agent,
    /// None: the agent is unknown or has no budget.
    None,
}

impl BudgetFrom {
    /// Its name in the view.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            BudgetFrom::Call => "call",
            BudgetFrom::Skill => "skill",
            BudgetFrom::Agent => "agent",
            BudgetFrom::None => "none",
        }
    }
}

/// A delegation's budget and where it comes from: what `delegateBudget`
/// gives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DelegateBudget<'a> {
    /// The budget, when there is one.
    pub budget: Option<&'a Value>,
    /// Where it comes from.
    pub from: BudgetFrom,
}

/// A delegation's budget: the call's, else the skill's, else the agent's
/// (what the runtime reserves): `delegateBudget(program, e, agentName)`.
/// `agent_name` is the delegation's agent when it is `None`.
#[must_use]
pub fn delegate_budget<'a>(
    program: Program<'a>,
    e: Expr<'a>,
    agent_name: Option<&str>,
) -> DelegateBudget<'a> {
    let none = DelegateBudget {
        budget: None,
        from: BudgetFrom::None,
    };
    let name = agent_name.or_else(|| e.agent()).unwrap_or_default();
    let Some(agent) = defs_of(program).get(name).filter(|a| is_kind(a, "agent")) else {
        return none;
    };
    // `Object.hasOwn(agent.skills, e.skill) ? agent.skills[e.skill] : undefined`.
    let skill = e.skill().and_then(|s| Definition::of(agent).skill(s));
    let given = |v: Option<&'a Value>| v.filter(|b| b.is_truthy());
    if let Some(b) = given(e.get("budget")) {
        return DelegateBudget {
            budget: Some(b),
            from: BudgetFrom::Call,
        };
    }
    if let Some(b) = given(skill.and_then(|s| s.get("budget"))) {
        return DelegateBudget {
            budget: Some(b),
            from: BudgetFrom::Skill,
        };
    }
    if let Some(b) = given(agent.get("budget")) {
        return DelegateBudget {
            budget: Some(b),
            from: BudgetFrom::Agent,
        };
    }
    none
}

/// One delegation in a workflow's cost: `CostRow`.
#[derive(Clone, Debug, PartialEq)]
pub struct CostRow {
    /// `agent.skill`.
    pub call: String,
    /// How many times it may run: par branches once each, loops `max_iter`
    /// times, a restart's attempts, a fallback once.
    pub times: f64,
    /// Its budget as one line.
    pub budget: String,
    /// Where the budget comes from.
    pub from: BudgetFrom,
    /// With a lock: the per-call upper bound of a model turn.
    pub per_call: Option<String>,
    /// With a lock: `steps` times that bound (W0504).
    pub steps_bound: Option<String>,
}

impl CostRow {
    /// `{ call, times, budget, from, per_call?, steps_bound? }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("call", self.call.as_str())
            .with("times", self.times)
            .with("budget", self.budget.as_str())
            .with("from", self.from.as_str())
            .with_some("per_call", self.per_call.as_deref())
            .with_some("steps_bound", self.steps_bound.as_deref())
            .into()
    }
}

/// The cost of one workflow: `WorkflowCost`.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowCost {
    /// Its name.
    pub workflow: String,
    /// Its limit as one line.
    pub limit: String,
    /// Its delegations, in the order the walk found them.
    pub rows: Vec<CostRow>,
    /// The static upper bound of what the workflow hands out: sequences and
    /// `par` add up, `if` and `switch` take the larger branch.
    pub total: String,
}

impl WorkflowCost {
    /// `{ workflow, limit, rows, total }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("workflow", self.workflow.as_str())
            .with("limit", self.limit.as_str())
            .with(
                "rows",
                JsValue::Array(self.rows.iter().map(CostRow::to_js).collect()),
            )
            .with("total", self.total.as_str())
            .into()
    }
}

/// The cost of a program: `CostView`.
#[derive(Clone, Debug, PartialEq)]
pub struct CostView {
    /// The program it shows.
    pub program: ProgramRef,
    /// Its workflows, by name in the order of UTF-16 code units.
    pub workflows: Vec<WorkflowCost>,
}

impl CostView {
    /// `{ format, kind, program, workflows }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("format", VIEW_FORMAT)
            .with("kind", "cost")
            .with("program", self.program.to_js())
            .with(
                "workflows",
                JsValue::Array(self.workflows.iter().map(WorkflowCost::to_js).collect()),
            )
            .into()
    }
}

/// A static sum: the micro-units spent by currency, the tokens and the steps
/// (`Sum`). All of them doubles; the currencies are members of an object, in
/// its order.
#[derive(Clone, Debug, PartialEq)]
pub struct Sum {
    /// Micro-units by currency.
    pub spend: JsObject,
    /// Tokens.
    pub tokens: f64,
    /// Steps.
    pub steps: f64,
}

/// `Math.max(a, b)`: `NaN` when either is.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

impl Sum {
    /// `zero()`: nothing.
    #[must_use]
    pub const fn zero() -> Sum {
        Sum {
            spend: JsObject::new(),
            tokens: 0.0,
            steps: 0.0,
        }
    }

    /// `add(a, b, times)`: `b` times `times` added to `self`.
    pub fn add(&mut self, b: &Sum, times: f64) {
        for (c, v) in b.spend.iter() {
            let have = self
                .spend
                .get(c)
                .and_then(JsValue::as_f64)
                .unwrap_or_default();
            let add = v.as_f64().unwrap_or(f64::NAN) * times;
            self.spend.insert(c, have + add);
        }
        self.tokens += b.tokens * times;
        self.steps += b.steps * times;
    }

    /// `max(a, b)`: the larger of each dimension, over the currencies of
    /// both (those of `a` first).
    #[must_use]
    pub fn max(a: &Sum, b: &Sum) -> Sum {
        let mut out = Sum::zero();
        let currencies = mandate_ir::unique_in_order(a.spend.keys().chain(b.spend.keys()));
        for c in currencies {
            let of = |s: &Sum| s.spend.get(c).and_then(JsValue::as_f64).unwrap_or_default();
            out.spend.insert(c, js_max(of(a), of(b)));
        }
        out.tokens = js_max(a.tokens, b.tokens);
        out.steps = js_max(a.steps, b.steps);
        out
    }

    /// `sumOf(b)`: what a budget hands out.
    #[must_use]
    pub fn sum_of(b: Option<&Value>) -> Sum {
        let mut s = Sum::zero();
        if let Some(spend) = b.and_then(|b| b.get("spend")).filter(|s| s.is_truthy()) {
            s.spend
                .insert(js_text(spend.get("currency")), num(spend.get("micros")));
        }
        s.tokens = num_or(&[b.and_then(|b| b.get("tokens"))], 0.0);
        s.steps = num_or(&[b.and_then(|b| b.get("steps"))], 0.0);
        s
    }

    /// `showSum(s)`: the sum as one line.
    #[must_use]
    pub fn show_sum(&self) -> String {
        let mut parts: Vec<String> = self
            .spend
            .iter()
            .map(|(c, v)| {
                format!(
                    "{} {c}",
                    number_to_string(v.as_f64().unwrap_or(f64::NAN) / 1_000_000.0)
                )
            })
            .collect();
        // `s.tokens ? … : []`: a count that is zero or `NaN` is falsy.
        if self.tokens != 0.0 && !self.tokens.is_nan() {
            parts.push(format!("{} tokens", number_to_string(self.tokens)));
        }
        if self.steps != 0.0 && !self.steps.is_nan() {
            parts.push(format!("{} steps", number_to_string(self.steps)));
        }
        let line = parts.join(" · ");
        if line.is_empty() {
            "—".to_owned()
        } else {
            line
        }
    }
}

/// How many delegations a run of the workflow starts at most, in the
/// checker's count: `staticCost(program, name)?.agents ?? 0` of
/// `check/cost.ts`, which is called without the linked definitions.
fn static_cost_agents(program: Program<'_>, workflow: &str) -> f64 {
    static_cost(program, workflow, None).map_or(0.0, |c| c.agents)
}

/// The walk of one workflow: what it hands out, and the rows of its
/// delegations.
struct Walk<'a> {
    program: Program<'a>,
    wf: &'a Value,
    lock: Option<Lock<'a>>,
    /// Inside a map's body: what the map hands each delegation.
    handed: Vec<CapVal>,
    rows: Vec<CostRow>,
}

impl<'a> Walk<'a> {
    /// The row of one delegation (`e` may be the delegation a `plan` stands
    /// for), and what it hands out `times` times.
    fn row(&mut self, e: Expr<'_>, agent_name: Option<&str>, times: f64) -> Sum {
        let DelegateBudget { budget, from } = delegate_budget(self.program, e, agent_name);
        let name = agent_name.or_else(|| e.agent()).unwrap_or_default();
        let agent = defs_of(self.program)
            .get(name)
            .filter(|a| is_kind(a, "agent"));
        let tier: Option<String> = agent.and_then(|agent| {
            grant_of(
                self.program,
                self.wf,
                agent,
                e.caps().unwrap_or_default(),
                &self.handed,
            )
            .iter()
            .find(|c| c.ctor() == "model.infer")
            .and_then(|c| c.tier().map(str::to_owned))
        });
        // `lock && tier ? perCallBound(lock, tier) : undefined`.
        let bound = match (self.lock, tier.as_deref().filter(|t| !t.is_empty())) {
            (Some(lock), Some(tier)) if lock.value().is_truthy() => per_call_bound(lock, tier),
            _ => None,
        };
        let mut r = CostRow {
            call: format!("{name}.{}", js_text(e.get("skill"))),
            times,
            budget: show(budget),
            from,
            per_call: None,
            steps_bound: None,
        };
        if let Some(bound) = bound {
            r.per_call = Some(format!(
                "{} {} · {} tokens",
                number_to_string(bound.micros / 1_000_000.0),
                bound.currency.to_js_string(),
                bound.tokens.to_js_string()
            ));
            if let Some(steps) = budget.and_then(|b| b.get("steps")) {
                let steps = num(Some(steps));
                r.steps_bound = Some(format!(
                    "{} {} · {} tokens",
                    number_to_string((steps * bound.micros) / 1_000_000.0),
                    bound.currency.to_js_string(),
                    number_to_string(steps * to_number(&bound.tokens))
                ));
            }
        }
        self.rows.push(r);
        let mut sum = Sum::zero();
        sum.add(&Sum::sum_of(budget), times);
        sum
    }

    /// What an expression hands out, `times` times over.
    fn expr_cost(&mut self, e: Expr<'a>, times: f64) -> Sum {
        let mut total = Sum::zero();
        if e.is(ExprOp::Switch) {
            if let Some(on) = e.on() {
                let on = self.expr_cost(on, times);
                total.add(&on, 1.0);
            }
            let mut widest = Sum::zero();
            for c in e.cases() {
                if let Some(then) = c.then() {
                    let s = self.expr_cost(then, times);
                    widest = Sum::max(&widest, &s);
                }
            }
            total.add(&widest, 1.0);
            return total;
        }
        if e.is(ExprOp::Block) {
            return self.block_cost(e.body(), times);
        }
        for c in view_children(e) {
            let s = self.expr_cost(c, times);
            total.add(&s, 1.0);
        }
        // A map runs its body once per item: `max` items at most, or as many as the envelope has `agents`
        // (spec/envelope.md "map").
        if e.is(ExprOp::Map) {
            let outer = std::mem::take(&mut self.handed);
            self.handed = handed_by(self.program, &outer, e);
            let envelope_agents = self
                .wf
                .get("envelope")
                .filter(|v| v.is_truthy())
                .and_then(|v| v.get("budget"))
                .and_then(|b| b.get("agents"));
            let each = num_or(&[e.get("max"), envelope_agents], 1.0);
            let s = self.block_cost(e.body(), times * each);
            total.add(&s, 1.0);
            self.handed = outer;
            return total;
        }
        if e.is(ExprOp::Plan) {
            let delegation = delegate_of_plan(e);
            if let Some(d) = Expr::of(&delegation) {
                let s = self.row(d, e.agent(), times);
                total.add(&s, 1.0);
            }
            return total;
        }
        if e.is(ExprOp::Delegate) {
            let sup = e.supervise();
            let restart = sup.filter(|s| s.name() == Some("restart"));
            let attempts = match restart {
                Some(r) => {
                    let max = r
                        .args()
                        .iter()
                        .filter_map(mandate_ir::Arg::of)
                        .find(|a| a.name() == Some("max"))
                        .and_then(|a| a.value())
                        .filter(|v| v.is(ExprOp::Int));
                    max.map_or(1.0, |m| num(m.get("value"))) + 1.0
                }
                None => 1.0,
            };
            let s = self.row(e, e.agent(), times * attempts);
            total.add(&s, 1.0);
            let to = sup
                .filter(|s| s.name() == Some("degrade"))
                .and_then(|s| {
                    s.args()
                        .iter()
                        .filter_map(mandate_ir::Arg::of)
                        .find(|a| a.name() == Some("to"))
                })
                .and_then(|a| a.value())
                .filter(|v| v.is(ExprOp::Var));
            if let Some(to) = to {
                let s = self.row(e, Some(js_text(to.get("name")).as_str()), times);
                total.add(&s, 1.0);
            }
        }
        total
    }

    /// What a block of statements hands out, `times` times over.
    fn block_cost(&mut self, stmts: &'a [Value], times: f64) -> Sum {
        let mut total = Sum::zero();
        for s in stmts {
            let Some(s) = Stmt::of(s) else { continue };
            match s.op() {
                Some(StmtOp::Let | StmtOp::Expr) => {
                    if let Some(v) = s.value() {
                        let c = self.expr_cost(v, times);
                        total.add(&c, 1.0);
                    }
                }
                Some(StmtOp::Return) => {
                    if let Some(v) = s.value() {
                        let c = self.expr_cost(v, times);
                        total.add(&c, 1.0);
                    }
                }
                Some(StmtOp::Par) => {
                    let mut branches: Vec<(&str, &Value)> = s.branches().collect();
                    branches.sort_by(|a, b| compare_utf16(a.0, b.0));
                    for (_, v) in branches {
                        if let Some(e) = Expr::of(v) {
                            let c = self.expr_cost(e, times);
                            total.add(&c, 1.0);
                        }
                    }
                }
                Some(StmtOp::If) => {
                    let then = self.block_cost(s.then_block(), times);
                    let otherwise = self.block_cost(s.else_block().unwrap_or_default(), times);
                    total.add(&Sum::max(&then, &otherwise), 1.0);
                }
                Some(StmtOp::Loop) => {
                    let n = num_or(&[s.members().get("max_iter")], 1.0);
                    let c = self.block_cost(s.body(), times * n);
                    total.add(&c, 1.0);
                }
                _ => {}
            }
        }
        total
    }
}

/// The delegation a `plan` is costed as: `{ op: "delegate", agent, skill,
/// args, ...(budget ? { budget } : {}) }`.
fn delegate_of_plan(e: Expr<'_>) -> Value {
    let mut m = Map::new();
    m.insert("op", "delegate");
    for key in ["agent", "skill", "args"] {
        if let Some(v) = e.get(key) {
            m.insert(key, v.clone());
        }
    }
    if let Some(b) = e.get("budget").filter(|b| b.is_truthy()) {
        m.insert("budget", b.clone());
    }
    Value::Object(m)
}

/// The cost of a program: `cost(program, lock)`. `lock` is the lock file as
/// read, when there is one; with it each delegation of a model tier also
/// shows the per-call bound.
#[must_use]
pub fn cost(program: &Value, lock: Option<&Value>) -> CostView {
    let mut workflows: Vec<WorkflowCost> = Vec::new();
    if let Some(p) = Program::of(program) {
        for (name, d) in sorted_defs(p) {
            if !is_kind(d, "workflow") {
                continue;
            }
            let mut walk = Walk {
                program: p,
                wf: d,
                lock: lock.map(Lock::of),
                handed: Vec::new(),
                rows: Vec::new(),
            };
            let mut total = walk.block_cost(Definition::of(d).body(), 1.0).show_sum();
            // An envelope bounds the delegations a run starts too: the checker's count, so the view and E0501 agree.
            if d.get("envelope").is_some_and(Value::is_truthy) {
                let agents = format!("{} agents", number_to_string(static_cost_agents(p, name)));
                total = if total == "—" {
                    agents
                } else {
                    format!("{total} · {agents}")
                };
            }
            workflows.push(WorkflowCost {
                workflow: name.to_owned(),
                limit: show(workflow_bounds(d).budget),
                rows: walk.rows,
                total,
            });
        }
    }
    CostView {
        program: program_ref(program),
        workflows,
    }
}

/// The blocks of the cost in a document: `costBlocks(v)`.
#[must_use]
pub fn cost_blocks(v: &CostView) -> Vec<Block> {
    let mut out = vec![Block::H("Cost (static upper bound)".to_owned())];
    for w in &v.workflows {
        out.push(Block::P(format!(
            "Workflow {}: limit {}; handed out at most {}.",
            w.workflow, w.limit, w.total
        )));
        out.push(Block::Table {
            head: [
                "Delegation",
                "Times",
                "Budget",
                "From",
                "Per-call bound",
                "Steps × bound",
            ]
            .map(str::to_owned)
            .to_vec(),
            rows: w
                .rows
                .iter()
                .map(|r| {
                    vec![
                        Cell::plain(r.call.as_str()),
                        Cell::plain(number_to_string(r.times)),
                        Cell::plain(r.budget.as_str()),
                        Cell::plain(r.from.as_str()),
                        Cell::plain(r.per_call.as_deref().unwrap_or("—")),
                        Cell::plain(r.steps_bound.as_deref().unwrap_or("—")),
                    ]
                })
                .collect(),
        });
    }
    out
}
