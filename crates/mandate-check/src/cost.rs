//! The static upper bound of what a body hands out (§8.6; spec/envelope.md
//! "Static checks"): a port of `compiler/src/check/cost.ts`. One model for
//! the checker's E0501 and for the views, so that the number a person reads
//! on an envelope's card is the number the check compared.
//!
//! Sequential statements add up. `par` branches add money, tokens, steps
//! and agents and take the longest time. `if` and `switch` take the larger
//! branch in each dimension. A loop multiplies by `max_iter`, and a map by
//! `max`, with `⌈max / par⌉ ×` one item's time.
//!
//! `agents` counts delegation attempts: a delegation is one,
//! `restart(max: n)` makes it `n + 1`, `degrade(to: F)` adds one for F, and
//! a `plan` is its lead's own delegation.
//!
//! Every amount is an `f64` and every sum, product and comparison is the
//! JavaScript one: past 2^53 a sum loses precision silently and never
//! overflows; `Math.max` is NaN when either side is; `Math.ceil(n / par)`
//! is a float division, and by a `par` of 0 it is `Infinity`. Where the
//! TypeScript tests an amount for truth (`inside.steps`, `!micros`), zero
//! (and NaN) counts as absent.

use std::collections::HashSet;

use mandate_ir::{
    Definition, Expr, ExprOp, JsObject, JsValue, Language, Map, Program, Stmt, StmtOp, Value,
    number_to_string,
};

use crate::walk::children;

/// A part of a cost: a delegation, or a budget that stands in for a body:
/// `CostPart`, `{ from, at, budget }`.
#[derive(Clone, Debug, PartialEq)]
pub struct CostPart {
    /// What it is, such as `A.s`, `fix`, `map`, `A.s ×3`.
    pub from: String,
    /// The JSON Pointer it is counted at.
    pub at: String,
    /// The amounts it shows, as the facts of E0501 write them.
    pub budget: JsObject,
}

impl CostPart {
    /// `{ from, at, budget }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("from", self.from.as_str())
            .with("at", self.at.as_str())
            .with("budget", self.budget.clone())
            .into()
    }
}

/// An upper bound in every budget dimension, with the delegations it is
/// made of: `StaticCost`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StaticCost {
    /// Micro-units by currency, in the order the currencies were first
    /// added (the order of the TypeScript object).
    pub spend: Vec<(String, f64)>,
    /// Tokens.
    pub tokens: f64,
    /// Wall-clock milliseconds.
    pub time: f64,
    /// Steps.
    pub steps: f64,
    /// Delegation attempts.
    pub agents: f64,
    /// The parts, in order.
    pub parts: Vec<CostPart>,
}

impl StaticCost {
    /// The micro-units in `currency`: `cost.spend[currency]`.
    #[must_use]
    pub fn spend_in(&self, currency: &str) -> Option<f64> {
        self.spend
            .iter()
            .find(|(c, _)| c == currency)
            .map(|(_, v)| *v)
    }

    /// `cost.spend[currency] = micros`.
    fn set_spend(&mut self, currency: &str, micros: f64) {
        match self.spend.iter_mut().find(|(c, _)| c == currency) {
            Some(slot) => slot.1 = micros,
            None => self.spend.push((currency.to_owned(), micros)),
        }
    }

    /// The object the TypeScript holds:
    /// `{ spend, tokens, time, steps, agents, parts }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let spend: JsObject = self.spend.iter().map(|(k, v)| (k.as_str(), *v)).collect();
        JsObject::new()
            .with("spend", spend)
            .with("tokens", self.tokens)
            .with("time", self.time)
            .with("steps", self.steps)
            .with("agents", self.agents)
            .with(
                "parts",
                self.parts.iter().map(CostPart::to_js).collect::<Vec<_>>(),
            )
            .into()
    }
}

/// What the cost model is counted with: `CostEnv`. `'d` is the lifetime
/// of the definitions, `'e` of what the environment borrows.
pub struct CostEnv<'e, 'd> {
    /// The definition `name`, as `def(name)` finds it.
    pub def: &'e dyn Fn(&str) -> Option<Definition<'d>>,
    /// Functions on a call cycle, which E0502 reports: their bodies are not
    /// counted.
    pub recursive: &'e HashSet<String>,
    /// Counting for an envelope, whose budget bounds steps and agents too:
    /// a part's budget then shows them, and a delegation with no budget is
    /// still a part.
    pub envelope: bool,
    /// The envelope's `agents`: how many items a map with no `max` accepts
    /// at most.
    pub agents: Option<f64>,
}

/// JavaScript's truth of a number: neither zero nor NaN.
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// `Math.max(a, b)`: NaN when either is, and `+0` over `-0`.
#[must_use]
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_negative() {
        b
    } else {
        a
    }
}

/// `Math.ceil(x)`.
fn js_ceil(x: f64) -> f64 {
    x.ceil()
}

/// `microsText(micros, currency)`: whole units and the fraction without
/// trailing zeros, then the currency, as JavaScript computes it
/// (`Math.floor(micros / 1e6)`, `String(micros % 1e6).padStart(6, "0")`
/// with `/0+$/` taken off).
#[must_use]
pub fn micros_text(micros: f64, currency: &str) -> String {
    let whole = (micros / 1_000_000.0).floor();
    let mut frac = number_to_string(micros % 1_000_000.0);
    // `padStart(6, "0")`: the text is ASCII, so its length is its UTF-16 length.
    while frac.len() < 6 {
        frac.insert(0, '0');
    }
    let frac = frac.trim_end_matches('0');
    let dot = if frac.is_empty() {
        String::new()
    } else {
        format!(".{frac}")
    };
    format!("{}{dot} {currency}", number_to_string(whole))
}

/// A budget of the IR, read as the cost model reads one: `Budget`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Budget<'a> {
    map: &'a Map,
}

impl<'a> Budget<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Budget<'a>> {
        v.as_object().map(|map| Budget { map })
    }

    fn number(self, key: &str) -> Option<f64> {
        self.map.get(key).and_then(number)
    }

    /// `tokens`, when it is there.
    #[must_use]
    pub fn tokens(self) -> Option<f64> {
        self.number("tokens")
    }

    /// `steps`, when it is there.
    #[must_use]
    pub fn steps(self) -> Option<f64> {
        self.number("steps")
    }

    /// `agents`, when it is there.
    #[must_use]
    pub fn agents(self) -> Option<f64> {
        self.number("agents")
    }

    /// `time.ms`, when `time` is there (an object is truthy) with its `ms`.
    #[must_use]
    pub fn time_ms(self) -> Option<f64> {
        self.map
            .get("time")
            .and_then(|t| t.get("ms"))
            .and_then(number)
    }

    /// Whether `time` is there: `b.time !== undefined`.
    #[must_use]
    pub fn has_time(self) -> bool {
        self.map.contains_key("time")
    }

    /// `spend`: `(currency, micros)`, when it is there with both.
    #[must_use]
    pub fn spend(self) -> Option<(&'a str, f64)> {
        let s = self.map.get("spend")?;
        Some((
            s.get("currency").and_then(Value::as_str)?,
            s.get("micros").and_then(number)?,
        ))
    }
}

/// An IR number as JavaScript holds it.
fn number(v: &Value) -> Option<f64> {
    v.as_i64().map(|n| n as f64)
}

/// `budget` of `v`, when it is an object.
fn budget_of(v: Option<&Value>) -> Option<Budget<'_>> {
    v.and_then(Budget::of)
}

/// `shownBudget(b)`.
fn shown_budget(b: Option<Budget<'_>>) -> JsObject {
    let mut shown = JsObject::new();
    if let Some(b) = b {
        if let Some((currency, micros)) = b.spend() {
            shown.insert("spend", micros_text(micros, currency));
        }
        if let Some(t) = b.tokens() {
            shown.insert("tokens", t);
        }
        if let Some(ms) = b.time_ms() {
            shown.insert("time_ms", ms);
        }
    }
    shown
}

/// What a budget bounds, as a cost: `budgetCost(env, b, from, at)`.
fn budget_cost(env: &CostEnv<'_, '_>, b: Budget<'_>, from: &str, at: &str) -> StaticCost {
    let mut c = StaticCost::default();
    if let Some((currency, micros)) = b.spend() {
        c.set_spend(currency, micros);
    }
    c.tokens = b.tokens().unwrap_or(0.0);
    c.time = b.time_ms().unwrap_or(0.0);
    c.steps = b.steps().unwrap_or(0.0);
    c.agents = b.agents().unwrap_or(0.0);
    let mut shown = shown_budget(Some(b));
    if env.envelope {
        if let Some(s) = b.steps() {
            shown.insert("steps", s);
        }
        if let Some(a) = b.agents() {
            shown.insert("agents", a);
        }
    }
    c.parts.push(CostPart {
        from: from.to_owned(),
        at: at.to_owned(),
        budget: shown,
    });
    c
}

/// One attempt of a delegation: its budget, if it has one, and one agent:
/// `attemptCost(env, b, from, at)`.
fn attempt_cost(env: &CostEnv<'_, '_>, b: Option<Budget<'_>>, from: &str, at: &str) -> StaticCost {
    let mut c = StaticCost::default();
    if let Some((currency, micros)) = b.and_then(Budget::spend) {
        c.set_spend(currency, micros);
    }
    c.tokens = b.and_then(Budget::tokens).unwrap_or(0.0);
    c.time = b.and_then(Budget::time_ms).unwrap_or(0.0);
    c.steps = b.and_then(Budget::steps).unwrap_or(0.0);
    c.agents = 1.0;
    let mut shown = shown_budget(b);
    if env.envelope {
        if let Some(s) = b.and_then(Budget::steps) {
            shown.insert("steps", s);
        }
        shown.insert("agents", 1.0);
    }
    if b.is_some() || env.envelope {
        c.parts.push(CostPart {
            from: from.to_owned(),
            at: at.to_owned(),
            budget: shown,
        });
    }
    c
}

/// A budget that stands in for a body: `standIn(env, b, from, at, body, every)`.
fn stand_in(
    env: &CostEnv<'_, '_>,
    b: Budget<'_>,
    from: &str,
    at: &str,
    body: &dyn Fn() -> StaticCost,
    every: bool,
) -> StaticCost {
    let mut c = budget_cost(env, b, from, at);
    if b.steps().is_some() && b.agents().is_some() && !every {
        return c;
    }
    let inside = body();
    let mut more = JsObject::new();
    if b.steps().is_none() && truthy(inside.steps) {
        c.steps = inside.steps;
        more.insert("steps", inside.steps);
    }
    if b.agents().is_none() && truthy(inside.agents) {
        c.agents = inside.agents;
        more.insert("agents", inside.agents);
    }
    if every {
        let own = b.spend().map(|(currency, _)| currency);
        for (currency, micros) in &inside.spend {
            if own == Some(currency.as_str()) || !truthy(*micros) {
                continue;
            }
            c.set_spend(currency, *micros);
            more.insert(format!("spend_{currency}"), micros_text(*micros, currency));
        }
        if b.tokens().is_none() && truthy(inside.tokens) {
            c.tokens = inside.tokens;
            more.insert("tokens", inside.tokens);
        }
        if !b.has_time() && truthy(inside.time) {
            c.time = inside.time;
            more.insert("time_ms", inside.time);
        }
    }
    if (env.envelope || every) && !more.is_empty() {
        c.parts.push(CostPart {
            from: format!("{from} (its body)"),
            at: at.to_owned(),
            budget: more,
        });
    }
    c
}

/// `addSeq(into, c)`.
pub fn add_seq(into: &mut StaticCost, c: StaticCost) {
    for (k, v) in &c.spend {
        let sum = into.spend_in(k).unwrap_or(0.0) + v;
        into.set_spend(k, sum);
    }
    into.tokens += c.tokens;
    into.time += c.time;
    into.steps += c.steps;
    into.agents += c.agents;
    into.parts.extend(c.parts);
}

/// Parallel branches: everything adds up but wall-clock time, which is the
/// longest branch's: `parallel(cs)`.
fn parallel(cs: Vec<StaticCost>) -> StaticCost {
    let mut out = StaticCost::default();
    for c in cs {
        for (k, v) in &c.spend {
            let sum = out.spend_in(k).unwrap_or(0.0) + v;
            out.set_spend(k, sum);
        }
        out.tokens += c.tokens;
        out.time = js_max(out.time, c.time);
        out.steps += c.steps;
        out.agents += c.agents;
        out.parts.extend(c.parts);
    }
    out
}

/// Alternatives (if/else, switch arms): the larger branch in each
/// dimension: `alternative(cs)`.
fn alternative(cs: Vec<StaticCost>) -> StaticCost {
    let mut out = StaticCost::default();
    for c in cs {
        for (k, v) in &c.spend {
            let m = js_max(out.spend_in(k).unwrap_or(0.0), *v);
            out.set_spend(k, m);
        }
        out.tokens = js_max(out.tokens, c.tokens);
        out.time = js_max(out.time, c.time);
        out.steps = js_max(out.steps, c.steps);
        out.agents = js_max(out.agents, c.agents);
        out.parts.extend(c.parts);
    }
    out
}

/// `scale(c, n)`.
fn scale(c: &StaticCost, n: f64) -> StaticCost {
    let shown = number_to_string(n);
    StaticCost {
        spend: c.spend.iter().map(|(k, v)| (k.clone(), v * n)).collect(),
        tokens: c.tokens * n,
        time: c.time * n,
        steps: c.steps * n,
        agents: c.agents * n,
        parts: c
            .parts
            .iter()
            .map(|p| CostPart {
                from: format!("{} ×{shown}", p.from),
                at: p.at.clone(),
                budget: p.budget.clone(),
            })
            .collect(),
    }
}

/// The functions being counted around a call: `inFns`, a `Set`.
pub type InFns = Vec<String>;

/// Upper bound of a block. Inside a called function (`in_fns` not empty),
/// costs are reported at the call site, `base`: `blockCost(env, stmts,
/// base, inFns)`.
#[must_use]
pub fn block_cost(
    env: &CostEnv<'_, '_>,
    stmts: &[Value],
    base: &str,
    in_fns: &InFns,
) -> StaticCost {
    let mut total = StaticCost::default();
    let at = |p: String| {
        if in_fns.is_empty() {
            p
        } else {
            base.to_owned()
        }
    };
    for (i, s) in stmts.iter().enumerate() {
        let Some(s) = Stmt::of(s) else { continue };
        let path = format!("{base}/{i}");
        let ec = |e: Option<Expr<'_>>, p: String| -> StaticCost {
            e.map(|e| expr_cost(env, e, &at(p), in_fns))
                .unwrap_or_default()
        };
        match s.op() {
            Some(StmtOp::Let | StmtOp::Expr) => {
                add_seq(&mut total, ec(s.value(), format!("{path}/value")));
            }
            Some(StmtOp::Return) => {
                if let Some(v) = s.value() {
                    add_seq(&mut total, ec(Some(v), format!("{path}/value")));
                }
            }
            Some(StmtOp::Par) => {
                let branches: Vec<StaticCost> = s
                    .branches()
                    .map(|(bn, e)| ec(Expr::of(e), format!("{path}/branches/{bn}")))
                    .collect();
                add_seq(&mut total, parallel(branches));
            }
            Some(StmtOp::If) => {
                let then = block_cost(env, s.then_block(), &at(format!("{path}/then")), in_fns);
                let other = block_cost(
                    env,
                    s.else_block().unwrap_or_default(),
                    &at(format!("{path}/else")),
                    in_fns,
                );
                add_seq(&mut total, alternative(vec![then, other]));
            }
            Some(StmtOp::Loop) => {
                let once = block_cost(env, s.body(), &at(format!("{path}/body")), in_fns);
                match s.max_iter() {
                    Some(n) => add_seq(&mut total, scale(&once, n as f64)),
                    None => add_seq(&mut total, once),
                }
            }
            _ => {}
        }
    }
    total
}

/// The value of the argument named `name` of a supervision.
fn supervise_arg<'a>(args: &'a [Value], name: &str) -> Option<Expr<'a>> {
    args.iter()
        .find(|a| a.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|a| a.get("value"))
        .and_then(Expr::of)
}

/// The skill `skill` of an agent: `Object.hasOwn(agent.skills, skill) ? … : undefined`.
fn skill_of<'d>(agent: Definition<'d>, skill: &str) -> Option<&'d Value> {
    agent.skill(skill)
}

/// Upper bound of what an expression hands out, delegates and budgeted
/// functions it runs: `exprCost(env, e, path, inFns)`.
#[must_use]
pub fn expr_cost(env: &CostEnv<'_, '_>, e: Expr<'_>, path: &str, in_fns: &InFns) -> StaticCost {
    let mut c = StaticCost::default();
    let sub = |x: Expr<'_>| expr_cost(env, x, path, in_fns);
    let within = |p: String| {
        if in_fns.is_empty() {
            p
        } else {
            path.to_owned()
        }
    };
    if e.is(ExprOp::Switch) {
        // Only one arm runs.
        if let Some(on) = e.on() {
            add_seq(&mut c, sub(on));
        }
        let arms: Vec<StaticCost> = e
            .cases()
            .enumerate()
            .map(|(i, k)| {
                k.then()
                    .map(|t| expr_cost(env, t, &within(format!("{path}/cases/{i}/then")), in_fns))
                    .unwrap_or_default()
            })
            .collect();
        add_seq(&mut c, alternative(arms));
        return c;
    }
    if e.is(ExprOp::Block) {
        return block_cost(env, e.body(), &within(format!("{path}/body")), in_fns);
    }
    for k in children(e) {
        add_seq(&mut c, sub(k));
    }
    if e.is(ExprOp::Map) {
        let body_at = within(format!("{path}/body"));
        let body = || block_cost(env, e.body(), &body_at, in_fns);
        let once = match budget_of(e.get("budget")) {
            Some(b) => stand_in(env, b, "map", path, &body, true),
            None => body(),
        };
        let n = e.get("max").and_then(number).or(env.agents);
        match n {
            None => add_seq(&mut c, once),
            Some(n) => {
                let mut all = scale(&once, n);
                let par = e.get("par").and_then(number).unwrap_or(1.0);
                all.time = once.time * js_ceil(n / par);
                add_seq(&mut c, all);
            }
        }
        return c;
    }
    let agent_name = e.agent().unwrap_or_default();
    let skill_name = e.skill().unwrap_or_default();
    if e.is(ExprOp::Plan) {
        // The lead's own delegation; its sub-programs are held to what is
        // left when they are submitted.
        let Some(lead) =
            (env.def)(agent_name).filter(|d| d.kind() == Some(mandate_ir::DefKind::Agent))
        else {
            return c;
        };
        let skill = skill_of(lead, skill_name);
        let b = budget_of(e.get("budget"))
            .or_else(|| budget_of(skill.and_then(|s| s.get("budget"))))
            .or_else(|| budget_of(lead.value().get("budget")));
        add_seq(
            &mut c,
            attempt_cost(env, b, &format!("{agent_name}.{skill_name}"), path),
        );
        return c;
    }
    if e.is(ExprOp::Delegate) {
        let Some(agent) =
            (env.def)(agent_name).filter(|d| d.kind() == Some(mandate_ir::DefKind::Agent))
        else {
            return c;
        };
        let skill = skill_of(agent, skill_name);
        let b = budget_of(e.get("budget"))
            .or_else(|| budget_of(skill.and_then(|s| s.get("budget"))))
            .or_else(|| budget_of(agent.value().get("budget")));
        // Every attempt reserves again: restart(max: n) runs up to n + 1
        // times, and degrade(to: F) may run F after it.
        let sup = e.supervise();
        let sup_name = sup.and_then(|s| s.name());
        let sup_args = sup.map(|s| s.args()).unwrap_or_default();
        let attempts = if sup_name == Some("restart") {
            let max = supervise_arg(sup_args, "max");
            let n = match max {
                Some(m) if m.is(ExprOp::Int) => m.value().and_then(number).unwrap_or(f64::NAN),
                _ => 1.0,
            };
            n + 1.0
        } else {
            1.0
        };
        let one = attempt_cost(env, b, &format!("{agent_name}.{skill_name}"), path);
        if attempts > 1.0 {
            add_seq(&mut c, scale(&one, attempts));
        } else {
            add_seq(&mut c, one);
        }
        let to = if sup_name == Some("degrade") {
            supervise_arg(sup_args, "to")
        } else {
            None
        };
        let to_name = to
            .filter(|t| t.is(ExprOp::Var))
            .map(|t| t.name().unwrap_or_default());
        let fb = to_name
            .and_then(|n| (env.def)(n))
            .filter(|d| d.kind() == Some(mandate_ir::DefKind::Agent));
        if let (Some(fb), Some(to_name)) = (fb, to_name) {
            let fb_skill = skill_of(fb, skill_name);
            let b = budget_of(e.get("budget"))
                .or_else(|| budget_of(fb_skill.and_then(|s| s.get("budget"))))
                .or_else(|| budget_of(fb.value().get("budget")));
            add_seq(
                &mut c,
                attempt_cost(env, b, &format!("{to_name}.{skill_name}"), path),
            );
        }
    } else if e.is(ExprOp::Call)
        && let Some(callee) = e.callee().filter(|x| x.is(ExprOp::Var))
    {
        let name = callee.name().unwrap_or_default();
        let Some(f) = (env.def)(name).filter(|d| d.kind() == Some(mandate_ir::DefKind::Fn)) else {
            return c;
        };
        let counted = !in_fns.iter().any(|n| n == name) && !env.recursive.contains(name);
        let body = || {
            if counted {
                let mut deeper = in_fns.clone();
                if !deeper.iter().any(|n| n == name) {
                    deeper.push(name.to_owned());
                }
                block_cost(env, f.body(), path, &deeper)
            } else {
                StaticCost::default()
            }
        };
        // A function's own budget bounds everything it runs; without one,
        // count its body.
        match budget_of(f.value().get("budget")) {
            Some(b) => add_seq(&mut c, stand_in(env, b, name, path, &body, false)),
            None => add_seq(&mut c, body()),
        }
    }
    c
}

/// The static upper bound of what a workflow's body hands out, for a
/// program that passed the checks; `None` when `workflow` is not a
/// workflow: `staticCost(program, workflow, linked)`. `linked` is the table
/// of definitions it sees with its imported modules loaded; the program's
/// own definitions take the place of linked ones of the same name. Nothing
/// is canonicalized here: the body is walked in the program's own order.
#[must_use]
pub fn static_cost<'p>(
    program: Program<'p>,
    workflow: &str,
    linked: Option<&'p Map>,
) -> Option<StaticCost> {
    let own = program.defs();
    let def = |name: &str| -> Option<Definition<'p>> {
        own.and_then(|d| d.get(name))
            .or_else(|| linked.and_then(|l| l.get(name)))
            .map(Definition::of)
    };
    let wf = def(workflow).filter(|d| d.kind() == Some(mandate_ir::DefKind::Workflow))?;
    let enveloped = program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_4))
        && wf.envelope().is_some();
    let agents = if enveloped {
        wf.envelope()
            .and_then(|e| e.members().get("budget"))
            .and_then(Budget::of)
            .and_then(Budget::agents)
    } else {
        None
    };
    let recursive = HashSet::new();
    let env = CostEnv {
        def: &def,
        recursive: &recursive,
        envelope: enveloped,
        agents,
    };
    Some(block_cost(
        &env,
        wf.body(),
        &format!("/defs/{workflow}/body"),
        &Vec::new(),
    ))
}
