//! The static authority, slice R12: capabilities, agents and their skills,
//! workflows, `par`, delegation, `map`, effects, and the envelope's rules
//! of `compiler/src/check/envelope.ts`.
//!
//! Each function here has the TypeScript's name and the signature R12
//! keeps. Until R12 fills them, each does everything its TypeScript
//! function does except the diagnostics written in its own body: the same
//! walk, in the same order, with the same calls into the core (`expr`,
//! `body`, `person`, `critical`, `over_budget`, `check_budget`,
//! `count_nodes`, …) and into the other functions here, and the same values
//! and state (the capabilities evaluated, `avail`, `handed`, `inMap`,
//! `maxClass`, `envelope`, `delegated`, `capDefs`, `skillUsage`,
//! `enveloped`, `askedInMap`). So the core's diagnostics inside workflows,
//! skills and maps come out now, in the order they will have once R12 is
//! in, and R12 adds only its own `report` and `problem` calls, each at the
//! place marked `// R12:` with the line of `static.ts` it is on. One
//! diagnostic written here is the core's and is already given: the node
//! count of `checkWorkflow` (E0105).
//!
//! Functions whose TypeScript only reports (`effectNames`,
//! `checkUsagesDeclared`, `reach`, `checkEnvelope`, `plansOutside`,
//! `methodsCheck`) do nothing yet.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use mandate_ir::{CallSpec, DefKind, Definition, Expr, ExprOp, JsObject, Language, Value, ptr};

use super::{Bound, Checker, Delegated, Enveloped, Frame, Usage, Val, Where, max_class};
use crate::caps::{CapVal, cap_covers, caps_from_call, caps_of, scope_within};
use crate::cost::Budget;
use crate::stdlib::{DataClass, std_effect};
use crate::ty::{Level, UNKNOWN, epistemic, named, unalias, with_level};

/// Where a supervision stands: `site` of `supervise`.
#[expect(
    dead_code,
    reason = "R12 reads skill and given in supervise, for E0715"
)]
pub(crate) enum Site<'s> {
    /// `{ kind: "par" }`.
    Par,
    /// `{ kind: "delegate", agent, skill, given }`.
    Delegate {
        /// The agent delegated to.
        agent: &'s str,
        /// The skill.
        skill: &'s str,
        /// What the call hands over with `with caps`.
        given: &'s [CapVal],
    },
}

impl<'a> Checker<'a> {
    // ── capabilities ────────────────────────────────────────────────────

    /// R12: `capDef(name)`, what a capability definition evaluates to, once.
    /// A capability that names itself, directly or through another, is
    /// nothing: while it is evaluated it holds no value.
    ///
    /// Now: complete but for the reports of `evalCap` (an own capability is
    /// evaluated with [`Checker::eval_cap`], an imported one with
    /// `capsOf`), memoized in `cap_defs`.
    pub(crate) fn cap_def(&mut self, name: &str) -> Vec<CapVal> {
        if let Some(known) = self.cap_defs.get(name) {
            return known.clone();
        }
        let Some(d) = self.def_of(name, DefKind::Capability) else {
            return Vec::new();
        };
        self.cap_defs.insert(name.to_owned(), Vec::new());
        // An imported capability was checked in its module; here it is only
        // evaluated.
        let own = self.program.defs().is_some_and(|o| o.get(name).is_some());
        let caps = match d.value_expr() {
            Some(e) if own => {
                let mut frame = self.const_frame();
                self.eval_cap(e, &ptr(&[&"defs", &name, &"value"]), &mut frame)
            }
            Some(e) => caps_of(&self.defs, e, self.cap_opts()),
            None => Vec::new(),
        };
        let caps: Vec<CapVal> = caps
            .into_iter()
            .map(|mut c| {
                c.set_name(Some(name.to_owned()));
                c
            })
            .collect();
        self.cap_defs.insert(name.to_owned(), caps.clone());
        caps
    }

    /// R12: `evalCap(e, path, frame)`: a capability expression (a name, a
    /// constructor call, `cap.narrow(…)`) evaluated. `frame` is
    /// `constFrame()` where the TypeScript gives none.
    ///
    /// Now: the values, and the walk of the arguments a capability's scope
    /// is not literal in (`untrustedInCapArg`), which types them with the
    /// core; the reports (E1002, E0305, E1801 through `methodsCheck`, E0215)
    /// are R12's.
    pub(crate) fn eval_cap(
        &mut self,
        e: Expr<'a>,
        path: &str,
        frame: &mut Frame<'a>,
    ) -> Vec<CapVal> {
        // Before 0.4 a capability that names one evaluated after it, in
        // name order, comes out empty.
        if e.is(ExprOp::Var) {
            let name = e.name().unwrap_or_default();
            if let Some(known) = self.cap_defs.get(name) {
                return known.clone();
            }
            return if self.at_least(Language::V0_4) {
                self.cap_def(name)
            } else {
                Vec::new()
            };
        }
        if e.is(ExprOp::Call)
            && let Some(callee) = e.callee()
            && callee.is(ExprOp::Field)
            && callee.name() == Some("narrow")
        {
            let bases = match callee.operand() {
                Some(of) => self.eval_cap(of, &format!("{path}/callee/of"), frame),
                None => Vec::new(),
            };
            if bases.len() > 1 {
                // R12: report E1002 (static.ts 337), then return the bases.
                return bases;
            }
            let Some(base) = bases.into_iter().next() else {
                return Vec::new();
            };
            let mut scope: Vec<String> = Vec::new();
            let mut known = true;
            for (i, a) in e.arg_values().iter().enumerate() {
                let value = a.get("value").and_then(Expr::of);
                match value.filter(|v| v.is(ExprOp::Text)) {
                    Some(t) => scope.push(t.text().unwrap_or_default().to_owned()),
                    None => {
                        known = false;
                        if let Some(v) = value {
                            self.untrusted_in_cap_arg(v, &format!("{path}/args/{i}/value"), frame);
                        }
                    }
                }
            }
            // A scope known only at run time is intersected with the base
            // then, so it cannot widen; statically it is bounded by the base.
            if !known {
                return vec![base];
            }
            let mut narrowed = base.clone();
            narrowed.set_scope(Some(scope));
            if !scope_within(base.ctor(), narrowed.scope(), base.scope()) {
                // R12: report E0305 (static.ts 356), then return [base].
                return vec![base];
            }
            return vec![narrowed];
        }
        if e.is(ExprOp::Call) {
            for (i, a) in e.arg_values().iter().enumerate() {
                if let Some(v) = a.get("value").and_then(Expr::of) {
                    self.untrusted_in_cap_arg(v, &format!("{path}/args/{i}/value"), frame);
                }
            }
            let r = caps_from_call(e, &self.defs, self.cap_opts());
            // R12: report E1002 when r.problem (static.ts 367), and from
            // 0.5 `methodsCheck(e, path)` for net.https (static.ts 368).
            return r.map(|r| r.caps).unwrap_or_default();
        }
        Vec::new()
    }

    /// R12: `methodsCheck(e, path)`, E1801. Now: nothing (it only reports).
    #[expect(dead_code, reason = "R12 calls it from evalCap for net.https from 0.5")]
    pub(crate) fn methods_check(&mut self, e: Expr<'a>, path: &str) {
        let _ = (e, path);
    }

    /// R12: `untrustedInCapArg(e, path, frame)`, R5: untrusted content
    /// cannot pick a capability's scope (E0215).
    ///
    /// Now: the value of a `var` or `field` argument is typed by
    /// `tryVal` (so a constant it names is typed here, where it is first
    /// needed); E0215 is R12's.
    pub(crate) fn untrusted_in_cap_arg(&mut self, e: Expr<'a>, path: &str, frame: &mut Frame<'a>) {
        if e.is(ExprOp::Var) || e.is(ExprOp::Field) {
            let v = self.try_val(e, frame);
            let _level = v.map(|v| epistemic(&v.ty).level);
            // R12: report E0215 when the level is untrusted or inferred (static.ts 399), at `path`.
            let _ = path;
        }
    }

    /// `tryVal(e, frame)`: the value of `e`, or none for a name nothing
    /// defines. It types the expression at path `""`.
    pub(crate) fn try_val(&mut self, e: Expr<'a>, frame: &mut Frame<'a>) -> Option<Val> {
        if e.is(ExprOp::Var) {
            let name = e.name().unwrap_or_default();
            if Self::lookup(name, &frame.scope).is_none() && self.def(name).is_none() {
                return None;
            }
        }
        Some(self.expr(e, frame, ""))
    }

    /// R12: `capList(list, base)`: every capability expression of a list
    /// evaluated, each with a fresh `constFrame()`.
    ///
    /// Now: complete but for the reports of `evalCap`.
    pub(crate) fn cap_list(&mut self, list: &'a [Value], base: &str) -> Vec<CapVal> {
        let mut out = Vec::new();
        for (i, c) in list.iter().enumerate() {
            if let Some(c) = Expr::of(c) {
                let mut frame = self.const_frame();
                out.extend(self.eval_cap(c, &format!("{base}/{i}"), &mut frame));
            }
        }
        out
    }

    // ── definitions ─────────────────────────────────────────────────────

    /// R12: `checkExtern(name, d, base)`: host code never produces a
    /// protected type (E0213), and the effects it declares exist (E0402,
    /// through `effectNames`).
    ///
    /// Now: nothing observable; E0213 (static.ts 439) is R12's.
    pub(crate) fn check_extern(&mut self, name: &str, d: Definition<'a>, base: &str) {
        let _ = name;
        // R12: `mentions(ty(d.returns), PROTECTED_TYPES)`, report E0213 at `${base}/returns` (static.ts 438-439).
        let effects = d
            .value()
            .get("effects")
            .and_then(Value::as_array)
            .unwrap_or_default();
        self.effect_names(effects, &format!("{base}/effects"));
    }

    /// R12: `checkEffectDecl(name, d, base)`: a critical effect declares
    /// `idempotency required` (E0403) and takes no model output (E0210).
    ///
    /// Now: nothing; both reports are R12's (static.ts 445, 451).
    pub(crate) fn check_effect_decl(&mut self, name: &str, d: Definition<'a>, base: &str) {
        let _ = (name, d, base);
    }

    /// R12: `effectNames(effects, base)`: every effect named exists (E0402).
    ///
    /// Now: nothing (it only reports).
    pub(crate) fn effect_names(&mut self, effects: &'a [Value], base: &str) {
        let _ = (effects, base);
    }

    /// R12: `checkUsagesDeclared(usages, declared, who)`: what a body uses
    /// it declares (E0401).
    ///
    /// Now: nothing (it only reports).
    pub(crate) fn check_usages_declared(
        &mut self,
        usages: &[Usage],
        declared: &'a [Value],
        who: &str,
    ) {
        let _ = (usages, declared, who);
    }

    /// R12: `checkAgent(name, d, base)`: an agent's capabilities and skills
    /// (E0213, E0402, E0408, E0301, E0503, E0401, W0310).
    ///
    /// Now: its capabilities are evaluated (`capList`), and the body of
    /// each skill that has one is typed by the core, in a skill frame with
    /// those capabilities, and its usages kept in `skill_usage`; every
    /// report is R12's.
    pub(crate) fn check_agent(&mut self, name: &str, d: Definition<'a>, base: &str) {
        let caps = self.cap_list(d.caps(), &format!("{base}/caps"));
        let skills: Vec<(&'a str, &'a Value)> = d.skills().collect();
        for (sn, s) in skills {
            let sb = format!("{base}/skills/{sn}");
            let ret = self.ty(s.get("returns").and_then(mandate_ir::TypeExpr::of));
            // R12: E0213 when `ret` mentions a protected type, at `${sb}/returns` (static.ts 486-487).
            let effects = s
                .get("effects")
                .and_then(Value::as_array)
                .unwrap_or_default();
            self.effect_names(effects, &format!("{sb}/effects"));
            if d.remote().is_some() {
                continue;
            }
            // R12: per effect, E0408 for a critical one or E0301 for one no capability covers (static.ts 490-506).
            match s.get("body").and_then(Value::as_array) {
                None => {
                    // R12: E0503 when neither the skill nor the agent sets `steps` (static.ts 508-509).
                }
                Some(body) => {
                    let who = format!("{name}.{sn}");
                    let params = s
                        .get("params")
                        .and_then(Value::as_array)
                        .unwrap_or_default();
                    let frame =
                        self.body_frame(Where::Skill, &who, params, Some(caps.clone()), Some(ret));
                    self.body(body, &frame, &format!("{sb}/body"), true);
                    let usages = frame.usages();
                    self.skill_usage.insert(who.clone(), usages.clone());
                    self.check_usages_declared(&usages, effects, &who);
                    // R12: the capabilities the usages need count as used (static.ts 516).
                }
            }
        }
        // R12: W0310 for each capability no skill uses, unless remote (static.ts 519-523).
    }

    /// R12: `checkWorkflow(name, d, base)`: a workflow's capabilities, its
    /// envelope, its body and handlers, what its body uses against its
    /// capabilities and its envelope (E0220, E1706, E0301, W0310, E1701,
    /// E1704), its budget (E0501, E0504) and its node count (E0105).
    ///
    /// Now: everything but the authority's reports. Its capabilities are
    /// evaluated (`capList`), its frame made with them, the envelope it
    /// stands under set (`under`: `maxClass`, `envelope`, and the push to
    /// `enveloped`), `ensures`, the body and each handler typed by the
    /// core, then the core's `checkBudget` and node count, which report.
    pub(crate) fn check_workflow(&mut self, name: &str, d: Definition<'a>, base: &str) {
        // With an envelope, its capabilities are the workflow's.
        let (caps_list, caps_at) = match d.envelope() {
            None => (d.caps(), "caps"),
            Some(e) => (e.caps().unwrap_or_default(), "envelope/caps"),
        };
        let caps_at = format!("{base}/{caps_at}");
        let caps = self.cap_list(caps_list, &caps_at);
        let returns = self.ty(d.returns());
        let mut frame = self.body_frame(
            Where::Workflow,
            name,
            d.params(),
            Some(caps.clone()),
            Some(returns),
        );
        if d.envelope().is_some() {
            self.check_envelope(name, d, base, &caps);
        }
        // The envelope the body stands under.
        let under = self.under(d);
        if let Some(under) = under {
            // `internal` when the envelope does not say.
            let max = under.max_class().unwrap_or(DataClass::Internal);
            frame.max_class = Some(max);
            frame.envelope = Some(under);
            self.enveloped.push(Enveloped {
                name: name.to_owned(),
                max,
                usages: Rc::clone(&frame.usages),
            });
        }
        if let Some(ensures) = d.ensures() {
            let at = format!("{base}/ensures");
            let mut vars = HashMap::new();
            vars.insert(
                "result".to_owned(),
                Val::public(frame.returns.clone().unwrap_or(UNKNOWN)),
            );
            let mut inner = Self::child(&frame, vars);
            let v = self.expr(ensures, &mut inner, &at);
            self.expect_bool(&v, &at);
        }
        self.body(d.body(), &frame, &format!("{base}/body"), true);
        for (i, h) in d.on().iter().enumerate() {
            let mut handler = frame.clone();
            handler.where_ = Where::Handler;
            let then = h.get("then").and_then(Expr::of);
            self.expr_or_unknown(then, &mut handler, &format!("{base}/on/{i}/then"));
        }
        // R12: every usage against the envelope's class and the capabilities
        // (E0220 or E1706 through overEnvelope/overModel, E0301), the
        // delegated capabilities and those granted through functions
        // counted as used, and W0310 unless the envelope's body plans
        // (static.ts 618-674).
        self.check_budget(name, d, base, under);
        let nodes = self.count_nodes(d.body(), &[]);
        let limit = Self::expanded_nodes_limit();
        if nodes > limit {
            self.report(
                "E0105",
                format!(
                    "{name} expands to {} static nodes; the 0.1 limit is {}.",
                    mandate_ir::number_to_string(nodes),
                    mandate_ir::number_to_string(limit)
                ),
                base,
                Some(JsObject::new().with("nodes", nodes).with("limit", limit)),
            );
        }
    }

    /// `under(d)`: the envelope a workflow's body stands under, its own, or
    /// for a sub-program's workflow what its parent's leaves it,
    /// `{ spawn?, budget? }`.
    pub(crate) fn under(&self, d: Definition<'a>) -> Option<Bound<'a>> {
        if let Some(e) = d.envelope() {
            return Some(Bound::of(e));
        }
        let claim = self.claim?;
        let truthy = |v: Option<&'a Value>| v.filter(|v| super::truthy(Some(v)));
        let spawn = truthy(claim.envelope.and_then(|e| e.get("spawn")));
        let budget = truthy(d.value().get("budget"));
        Some(Bound { spawn, budget })
    }

    /// R12: `reach(name, max, usages)`: `spawn.max_class` in the skills a
    /// workflow with an envelope reaches (E0220, E1706).
    ///
    /// Now: nothing (it only reports).
    pub(crate) fn reach(&mut self, name: &str, max: DataClass, usages: &[Usage]) {
        let _ = (name, max, usages);
    }

    // ── statements ──────────────────────────────────────────────────────

    /// R12: `par(s, frame, path)`: each branch typed in the scope before the
    /// `par`, their write scopes disjoint (E0320), `restart_all` only
    /// without external effects (E0710), and the supervision (E0714). It
    /// gives the branches' values by name, the scope after the `par`.
    ///
    /// Now: each branch typed by the core, in order, and `supervise`; the
    /// reports are R12's.
    pub(crate) fn par(
        &mut self,
        s: mandate_ir::Stmt<'a>,
        frame: &mut Frame<'a>,
        path: &str,
    ) -> HashMap<String, Val> {
        let mut out = HashMap::new();
        for (bn, e) in s.branches() {
            // Each branch sees the scope before the par, never a sibling's
            // result.
            let v = self.expr_or_unknown(Expr::of(e), frame, &format!("{path}/branches/{bn}"));
            out.insert(bn.to_owned(), v);
            // R12: what the branch delegated and used, its write capabilities, and whether it is external (static.ts 974-985).
        }
        // R12: E0320 for two branches that can write one scope (static.ts 987-1004), E0710 (static.ts 1005-1007).
        if let Some(sup) = s.supervise() {
            self.supervise(sup, &format!("{path}/supervise"), &Site::Par);
        }
        out
    }

    /// R12: `supervise(c, path, site)`: supervision strategies (§8.7,
    /// E0713, E0714, E0715).
    ///
    /// Now: the walk only: a `degrade` of a delegation evaluates the
    /// capabilities of the fallback and of the original agent (`capList`),
    /// as the TypeScript does to compare them; the reports are R12's.
    pub(crate) fn supervise(&mut self, c: CallSpec<'a>, path: &str, site: &Site<'_>) {
        let name = c.name().unwrap_or_default();
        let allowed: &[&str] = match site {
            Site::Par => &["fail_fast", "restart_all"],
            Site::Delegate { .. } => &["restart", "escalate", "degrade"],
        };
        if !allowed.contains(&name) {
            // R12: report E0714 (static.ts 1027), then return.
            let _ = path;
            return;
        }
        // R12: E0713 for restart (static.ts 1031-1036); E0714 for an escalate that names no person (static.ts 1037-1040).
        if let Site::Delegate { agent, .. } = site
            && name == "degrade"
        {
            let to = c
                .args()
                .iter()
                .find(|a| a.get("name").and_then(Value::as_str) == Some("to"))
                .and_then(|a| a.get("value"))
                .and_then(Expr::of);
            let fallback_name = to.filter(|t| t.is(ExprOp::Var)).and_then(Expr::name);
            let fallback = fallback_name.and_then(|n| self.def_of(n, DefKind::Agent));
            let (Some(fallback_name), Some(fallback)) = (fallback_name, fallback) else {
                // R12: report E0715 (static.ts 1047), then return.
                return;
            };
            let _fallback_caps =
                self.cap_list(fallback.caps(), &ptr(&[&"defs", &fallback_name, &"caps"]));
            if let Some(original) = self.def_of(agent, DefKind::Agent) {
                let _original_caps =
                    self.cap_list(original.caps(), &ptr(&[&"defs", agent, &"caps"]));
            }
            // R12: the skill and signature comparison, and E0715 with the problems (static.ts 1050-1063).
        }
    }

    // ── expressions ─────────────────────────────────────────────────────

    /// R12: `map(e, frame, path)`: `map x in xs … { body }`, its body typed
    /// once with `x` an element of `xs`, the result `List<Outcome<T>>`
    /// (E0201, E0701, E0714, E1702, E1703, E1708, E0320, E0501).
    ///
    /// Now: everything but the authority's reports: `over` and the body
    /// typed, the body's frame with `inMap` and the map's `with caps` in
    /// `handed` and `avail` (evaluated in the body's frame), every human
    /// step in the body reported once for the innermost map (E1708, the
    /// core's `person`), and with a `budget` the core's `overBudget`
    /// (E0504); E0501 of the map's budget is R12's.
    pub(crate) fn map(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let over = self.operand(e.over(), frame, path, "over");
        let inner = self.map_frame(e, frame, path, &over);
        // R12: E0714 for a supervision other than fail_fast (static.ts 1260-1262).
        let usages_before = frame.usage_count();
        let at = super::sub(path, "body");
        let body = self.body(e.body(), &inner, &at, false);
        self.map_after(e, frame, path, &inner, usages_before);
        Val {
            ty: named("List", vec![named("Outcome", vec![body.ty])]),
            cls: over.cls.max(body.cls),
        }
    }

    /// The frame a map's body is typed in: the element bound, `inMap`, and
    /// the map's `with caps` in `handed` and `avail`.
    fn map_frame(
        &mut self,
        e: Expr<'a>,
        frame: &Frame<'a>,
        path: &str,
        over: &Val,
    ) -> Box<Frame<'a>> {
        let ep = epistemic(&over.ty);
        let list = unalias(&ep.inner, self);
        let mut elem = UNKNOWN;
        if list.is_named("List") {
            elem = list.arg(0);
        } else if !matches!(list, crate::ty::Ty::Unknown) {
            // R12: report E0201 at `${path}/over` (static.ts 1231).
        }
        let level = if ep.level == Level::Verified {
            Level::Plain
        } else {
            ep.level
        };
        let item = Val {
            ty: with_level(elem, level, None),
            cls: over.cls,
        };
        let mut vars = HashMap::new();
        vars.insert(e.bind().unwrap_or_default().to_owned(), item);
        let mut inner = Self::child_box(frame, vars);
        inner.in_map = Some(path.to_owned());
        // `with caps K`: inside the body, K takes the place of the
        // capability kinds it names.
        if let Some(caps) = e.caps() {
            let mut given: Vec<CapVal> = Vec::new();
            for (i, c) in caps.iter().enumerate() {
                let cp = format!("{path}/caps/{i}");
                let Some(c) = Expr::of(c) else { continue };
                // R12: whether the element chooses the scope (`byItem`, static.ts 1244).
                for v in self.eval_cap(c, &cp, &mut inner) {
                    // R12: E0701 when the context does not hold it (static.ts 1248-1253).
                    given.push(v);
                }
            }
            let narrowed: HashSet<String> = given.iter().map(|g| g.ctor().to_owned()).collect();
            let mut handed: Vec<CapVal> = frame
                .handed
                .as_deref()
                .map(|h| {
                    h.iter()
                        .filter(|c| !narrowed.contains(c.ctor()))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            handed.extend(given.iter().cloned());
            inner.handed = Some(Rc::new(handed));
            if let Some(avail) = frame.avail.as_deref() {
                let mut a: Vec<CapVal> = avail
                    .iter()
                    .filter(|c| !narrowed.contains(c.ctor()))
                    .cloned()
                    .collect();
                a.extend(given);
                inner.avail = Some(Rc::new(a));
            }
        }
        inner
    }

    /// What a map checks once its body is typed: its bound, the people its
    /// items would wait for (E1708, the core's `person`), what its items may
    /// write, and its budget (the core's `overBudget`, E0504).
    fn map_after(
        &mut self,
        e: Expr<'a>,
        frame: &Frame<'a>,
        path: &str,
        inner: &Frame<'a>,
        usages_before: usize,
    ) {
        let usages = frame.usages_from(usages_before);
        // R12: E1702 for a map with no bound, E1703 for a `par` above the envelope's (static.ts 1269-1280).
        // A person is asked once about the list, after the map (E1708). A
        // step in a map inside this one was reported there, for that map.
        for u in &usages {
            if u.effect != "Human" || self.asked_in_map.contains(&u.path) {
                continue;
            }
            self.asked_in_map.insert(u.path.clone());
            self.person(inner, &u.path, "human step", None);
        }
        // R12: with `par k > 1`, E0320 for what every item can write (static.ts 1290-1304).
        if let Some(b) = e.get("budget").and_then(Budget::of) {
            self.map_budget(e, b, path, frame.envelope);
        }
    }

    /// R12: `mapBudget(e, path, envelope)`: `budget b` on a map stands in
    /// for one item, so what the body hands out fits in it (E0501).
    ///
    /// Now: the body's cost and the core's `overBudget` (which reports
    /// E0504); E0501 is R12's.
    pub(crate) fn map_budget(
        &mut self,
        e: Expr<'a>,
        b: Budget<'a>,
        path: &str,
        envelope: Option<Bound<'a>>,
    ) {
        let at = format!("{path}/budget");
        // A map with no `max` in the body counts as many items as the
        // envelope has agents.
        let agents = envelope.and_then(Bound::agents);
        let cost = self.cost_of(
            e.body(),
            &format!("{path}/body"),
            envelope.is_some(),
            agents,
        );
        let _facts = self.over_budget(b, &cost, &at, "This map's budget", true);
        // R12: report E0501 with the facts and `breakdown: cost.parts` when there are any (static.ts 1330-1332).
    }

    /// R12: `delegate(e, frame, path)` (and `plan`, which is read as a
    /// delegation): the skill's arguments (E0201), the grant (C1, C2:
    /// E0701, E0301), the data it may receive (E0220, E1706), its timeout
    /// and supervision.
    ///
    /// Now: the arguments typed by the core; the grant computed as the
    /// TypeScript computes it (the agent's capabilities in the context, a
    /// `with caps` and what a map hands), since the result's type depends
    /// on it; the timeout typed, `supervise` walked, E1708 for
    /// `supervise escalate` in a map (the core's `person`), the delegation
    /// pushed to `delegated` and its usage; and the skill's return type.
    /// Every report written in `delegate`, `given` and `delegateRest` is
    /// R12's.
    pub(crate) fn delegate(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let args = self.call_args(e, frame, path);
        self.delegate_with(e, frame, path, &args)
    }

    /// A delegation, its arguments typed (`args`).
    fn delegate_with(
        &mut self,
        e: Expr<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        args: &[Val],
    ) -> Val {
        // In a sub-program, what an agent is handed is the lead's writing.
        let cls = self.floor.max(max_class(args.iter().map(|a| a.cls)));
        let agent_name = e.agent().unwrap_or_default();
        let Some(agent) = self.def_of(agent_name, DefKind::Agent) else {
            return Val { ty: UNKNOWN, cls };
        };
        let skill_name = e.skill().unwrap_or_default();
        let Some(skill) = agent.skill(skill_name) else {
            return Val { ty: UNKNOWN, cls };
        };
        let who = format!("{agent_name}.{skill_name}");
        // R12: E0201 when the arguments are not as many as the skill's parameters (static.ts 1633-1635),
        // and `problem(assignable(a.ty, ty(param.type)))` for each (static.ts 1636-1639).
        let agent_caps = self.cap_list(agent.caps(), &ptr(&[&"defs", &agent_name, &"caps"]));
        let avail = frame.avail.clone();
        let in_context = |c: &CapVal| {
            avail
                .as_deref()
                .is_none_or(|a| a.iter().any(|x| cap_covers(x, c)))
        };
        let mut effective: Vec<CapVal> = agent_caps
            .iter()
            .filter(|c| in_context(c))
            .cloned()
            .collect();
        let mut given: Vec<CapVal> = Vec::new();
        if let Some(caps) = e.caps() {
            for (i, c) in caps.iter().enumerate() {
                let cp = format!("{path}/caps/{i}");
                let Some(c) = Expr::of(c) else { continue };
                for v in self.eval_cap(c, &cp, frame) {
                    // R12: `given(v, …)` reports E0701 (static.ts 1683-1697).
                    given.push(v);
                }
            }
        }
        // A map hands its `with caps` to each delegation of its body.
        let remote = agent.remote();
        let own: HashSet<String> = given.iter().map(|g| g.ctor().to_owned()).collect();
        let handed: Vec<CapVal> = frame.handed.as_deref().cloned().unwrap_or_default();
        for k in &handed {
            if !own.contains(k.ctor())
                && (remote.is_some() || agent_caps.iter().any(|a| cap_covers(a, k)))
            {
                given.push(k.clone());
            }
        }
        if !given.is_empty() {
            let narrowed: HashSet<&str> = given.iter().map(CapVal::ctor).collect();
            effective.retain(|c| !narrowed.contains(c.ctor()));
            effective.extend(given.iter().cloned());
        }
        self.delegate_rest(e, frame, path, agent_name, skill_name, &given);
        frame.delegated.borrow_mut().push(Delegated {
            caps: effective.clone(),
            path: path.to_owned(),
            external: remote.is_some(),
        });
        let mut u = Usage::new("Delegate", path);
        u.cls = Some(cls);
        u.to = Some(who);
        Self::use_effect(frame, u);
        let mut ret = self.ty(skill.get("returns").and_then(mandate_ir::TypeExpr::of));
        let trusted = remote
            .and_then(|r| r.members().get("trust"))
            .and_then(Value::as_str)
            == Some("trusted");
        if remote.is_some() && !trusted {
            ret = named("Untrusted", vec![ret]);
        } else if remote.is_none()
            && skill.get("body").is_none()
            && effective.iter().any(|c| c.ctor() == "model.infer")
        {
            // A skill without a body runs as an agent loop, which talks to
            // the model its delegation grants: the result is that model's
            // answer, whatever type the skill declares.
            let lvl = epistemic(&ret).level;
            if lvl == Level::Plain || lvl == Level::Verified {
                ret = named("Inferred", vec![ret]);
            }
        }
        // Model output inherits the highest class of what went in (§5.5).
        Val { ty: ret, cls }
    }

    /// R12: `delegateRest(e, frame, path, agent, skill, who, effective,
    /// given, cls)`: what a delegation's grant must cover (E0301), the data
    /// it may receive (E0220, E1706), its timeout and its supervision.
    ///
    /// Now: the timeout typed by the core, `supervise` walked, and the
    /// core's `person` for `supervise escalate` (E1708); the reports are
    /// R12's. The arguments R12 needs besides these (the agent and skill
    /// views, `who`, `effective`, `cls`) are computed in `delegate`.
    pub(crate) fn delegate_rest(
        &mut self,
        e: Expr<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        agent: &str,
        skill: &str,
        given: &[CapVal],
    ) {
        // R12: E0301 for an effect of the skill the grant does not cover (static.ts 1702-1714),
        // overModel (static.ts 1717-1726) and overEnvelope (static.ts 1729-1735).
        if let Some(t) = e.timeout() {
            let at = format!("{path}/timeout");
            let _v = self.expr(t, frame, &at);
            // R12: `problem(assignable(v.ty, named("Duration")), at)` (static.ts 1738).
        }
        if let Some(sup) = e.supervise() {
            self.supervise(
                sup,
                &format!("{path}/supervise"),
                &Site::Delegate {
                    agent,
                    skill,
                    given,
                },
            );
        }
        if e.supervise().and_then(|s| s.name()) == Some("escalate") {
            self.person(
                frame,
                &format!("{path}/supervise"),
                "supervise escalate",
                None,
            );
        }
    }

    /// R12: `effectCall(e, frame, path)`: an `effect name(…)` call: its
    /// arguments against the effect's parameters (E0201), a critical one
    /// only in a workflow (E0408) with `idempotent_by` (E0403), an
    /// irreversible one after an approval (E0405), and in a map (E1708).
    ///
    /// Now: the arguments and `idempotent_by` typed by the core, the core's
    /// `critical` for a critical effect in a map (E1708), the usage (with
    /// the environments an `env.*` effect names), and the effect's return
    /// type; the other reports are R12's.
    pub(crate) fn effect_call(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let args = self.call_args(e, frame, path);
        self.effect_call_with(e, frame, path, &args)
    }

    /// An effect call, its arguments typed (`args`).
    fn effect_call_with(
        &mut self,
        e: Expr<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        args: &[Val],
    ) -> Val {
        let cls = max_class(args.iter().map(|a| a.cls));
        let name = e.name().unwrap_or_default();
        let decl = self.def_of(name, DefKind::Effect);
        let std = if decl.is_some() {
            None
        } else {
            std_effect(name)
        };
        let critical = match decl {
            Some(d) => {
                super::truthy(d.value().get("critical"))
                    || super::truthy(d.value().get("irreversible"))
            }
            None => std.is_some_and(|s| s.critical),
        };
        // R12: with the parameters known, E0201 for a wrong count and the
        // `problem(assignable(…))` of each argument (static.ts 1774-1782).
        if critical && frame.in_map.is_some() {
            self.critical(
                frame,
                path,
                &format!("The critical effect {name} runs"),
                name,
            );
        }
        // R12: E0408 in a fn, skill or contract, E0403 without `idempotent_by` (static.ts 1784-1793);
        // E0405 for an irreversible one with no approval before it (static.ts 1794-1796).
        if let Some(by) = e.idempotent_by() {
            self.expr(by, frame, &format!("{path}/idempotent_by"));
        }
        // An effect on an environment is scoped by the environment it names.
        let by_env = std.filter(|s| s.cap.starts_with("env.")).map(|_| {
            e.args()
                .filter_map(|a| a.value())
                .filter(|v| v.is(ExprOp::Var))
                .filter_map(|v| v.name())
                .filter(|n| self.def_of(n, DefKind::Environment).is_some())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
        let mut u = Usage::new(name, path);
        if let Some(envs) = by_env {
            u.scope = Some(if envs.is_empty() {
                vec!["an environment the program does not name".to_owned()]
            } else {
                envs
            });
        }
        Self::use_effect(frame, u);
        let ret = match (decl, std) {
            (Some(d), _) => self.ty(d.returns()),
            (None, Some(s)) => super::expr::std_ty(&s.returns),
            (None, None) => UNKNOWN,
        };
        Val { ty: ret, cls }
    }

    // ── envelope.ts ─────────────────────────────────────────────────────

    /// R12: `checkEnvelope(name, d, base, caps, env)` of `envelope.ts`:
    /// an envelope gives `owner`, `caps` and a `budget` with `agents`, and
    /// its workflow none of its own (E1701); what it asks to approve is a
    /// critical effect its caps cover (E1704).
    ///
    /// Now: nothing (it only reports).
    pub(crate) fn check_envelope(
        &mut self,
        name: &str,
        d: Definition<'a>,
        base: &str,
        caps: &[CapVal],
    ) {
        let _ = (name, d, base, caps);
    }

    /// R12: `plansOutside(program.defs, report)` of `envelope.ts`: a `plan`
    /// stands only in the body of a workflow with an envelope (E1707). Run
    /// only without a claim.
    ///
    /// Now: nothing (it only reports).
    pub(crate) fn plans_outside(&mut self) {}
}
