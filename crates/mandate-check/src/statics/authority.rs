//! The static authority, slice R12: capabilities, agents and their skills,
//! workflows, `par`, delegation, `map`, effects, and the envelope's rules
//! of `compiler/src/check/envelope.ts`.
//!
//! Each function here has the TypeScript's name. Its diagnostics are
//! reported where the TypeScript reports them, in its order, never sorted
//! or de-duplicated: `capList` evaluates (and reports) a capability
//! expression each time it is called, as the TypeScript does.
//!
//! The functions on the path of the checker's recursion (`map`,
//! `delegate`, `effectCall`, `par`) keep their own frames small: what they
//! report is written in functions of its own, so that the deepest program
//! that loads is still checked within WebAssembly's 1 MiB stack.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use mandate_ir::{
    CallSpec, DefKind, Definition, Expr, ExprOp, JsObject, JsValue, Language, Map, Value,
    canonicalize, compare_utf16, ptr, ptr_token, stringify, workflow_bounds,
};

use super::{Bound, Checker, Delegated, Enveloped, Frame, Usage, Val, Where, max_class};
use crate::caps::{
    CapVal, HTTP_METHODS, MethodProblemKind, callee_path, cap_authorizes, cap_covers,
    caps_from_call, caps_of, read_methods, reads_methods, scope_within, show_cap, writes_overlap,
};
use crate::cost::Budget;
use crate::stdlib::{
    DATA_CLASSES, DataClass, MAX_RESTARTS, PROTECTED_TYPES, class_rank, is_builtin_effect,
    is_ungated_effect, std_effect,
};
use crate::ty::{
    Level, Ty, UNKNOWN, epistemic, mentions, named, named0, show, unalias, with_level,
};
use crate::walk::{reads_var, walk_exprs};

/// Where a supervision stands: `site` of `supervise`.
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

/// What a delegation's grant is, for `delegateRest`: the agent and the
/// skill delegated to, `who` (`Agent.skill`), the capabilities it is
/// granted (`effective`), what `with caps` hands over (`given`), and the
/// class of what it receives (`cls`).
struct Grant<'g, 'a> {
    agent_name: &'g str,
    skill_name: &'g str,
    agent: Definition<'a>,
    skill: &'a Value,
    who: &'g str,
    effective: &'g [CapVal],
    given: &'g [CapVal],
    cls: DataClass,
}

/// `JSON.stringify(s)` of a string.
fn json_text(s: &str) -> String {
    stringify(&JsValue::from(s)).unwrap_or_default()
}

/// `caps.map(showCap)`, as a fact.
fn shown(caps: &[CapVal]) -> Vec<JsValue> {
    caps.iter().map(|c| JsValue::from(show_cap(c))).collect()
}

/// `xs.map(String)`, as a fact.
fn texts(xs: &[String]) -> Vec<JsValue> {
    xs.iter().map(|x| JsValue::from(x.as_str())).collect()
}

/// `${scope ? `(${scope.join(", ")})` : ""}`: an empty scope is `()`.
fn scope_text(scope: Option<&[String]>) -> String {
    scope.map_or_else(String::new, |s| format!("({})", s.join(", ")))
}

/// `overlapText(a, b)`: the scope two write capabilities share.
fn overlap_text(a: &CapVal, b: &CapVal) -> String {
    let text = |c: &CapVal| {
        c.scope()
            .map_or_else(|| "an unknown scope".to_owned(), |s| s.join(", "))
    };
    let (sa, sb) = (text(a), text(b));
    if sa == sb { sa } else { format!("{sa} / {sb}") }
}

/// `list(xs)` of `envelope.ts`: `a`, `a and b`, `a, b and c`.
fn and_list(xs: &[&str]) -> String {
    match xs.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => xs.concat(),
    }
}

/// `who.slice(0, who.indexOf("."))`: the agent of `Agent.skill`. Without a
/// dot, `indexOf` is -1 and the last character is dropped, as in the
/// TypeScript (a `to` always has a dot).
fn agent_of(who: &str) -> &str {
    match who.find('.') {
        Some(i) => who.get(..i).unwrap_or_default(),
        None => who
            .char_indices()
            .last()
            .and_then(|(i, _)| who.get(..i))
            .unwrap_or_default(),
    }
}

/// `${x}` of a value from the IR that is a text: the text itself, or its
/// JSON for anything else.
fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => stringify(&JsValue::from(other)).unwrap_or_default(),
    }
}

/// `plans(v, path, found)` of `envelope.ts`: every `plan` under `v`, by
/// JSON Pointer, in the order of the members.
fn plans(v: &Value, path: &str, found: &mut Vec<String>) {
    match v {
        Value::Array(items) => {
            for (i, x) in items.iter().enumerate() {
                plans(x, &format!("{path}/{i}"), found);
            }
        }
        Value::Object(o) => {
            if o.get("op").and_then(Value::as_str) == Some("plan") {
                found.push(path.to_owned());
            }
            for (k, x) in o.iter() {
                plans(x, &format!("{path}/{}", ptr_token(k)), found);
            }
        }
        _ => {}
    }
}

impl<'a> Checker<'a> {
    // ── capabilities ────────────────────────────────────────────────────

    /// `capDef(name)`, what a capability definition evaluates to, once. A
    /// capability that names itself, directly or through another, is
    /// nothing: while it is evaluated it holds no value. An own capability
    /// is evaluated with [`Checker::eval_cap`] (which reports), an imported
    /// one with `capsOf`.
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
            Some(e) => caps_of(self.defs, e, self.cap_opts()),
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

    /// `evalCap(e, path, frame)`: a capability expression (a name, a
    /// constructor call, `cap.narrow(…)`) evaluated (E1002, E0305, E1801,
    /// E0215). `frame` is `constFrame()` where the TypeScript gives none.
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
            return self.eval_narrow(e, callee, path, frame);
        }
        if e.is(ExprOp::Call) {
            for (i, a) in e.arg_values().iter().enumerate() {
                if let Some(v) = a.get("value").and_then(Expr::of) {
                    self.untrusted_in_cap_arg(v, &format!("{path}/args/{i}/value"), frame);
                }
            }
            let r = caps_from_call(e, self.defs, self.cap_opts());
            if let Some(problem) = r.as_ref().and_then(|r| r.problem.as_deref()) {
                self.report(
                    "E1002",
                    format!("{problem} (doc 9 §2.2)."),
                    path,
                    Some(JsObject::new().with("problem", problem)),
                );
            }
            if reads_methods(self.program.language())
                && e.callee().and_then(callee_path).as_deref() == Some("net.https")
            {
                self.methods_check(e, path);
            }
            return r.map(|r| r.caps).unwrap_or_default();
        }
        Vec::new()
    }

    /// `cap.narrow(…)` of `evalCap`: one base, narrowed by literal scopes
    /// inside it (E1002, E0305).
    fn eval_narrow(
        &mut self,
        e: Expr<'a>,
        callee: Expr<'a>,
        path: &str,
        frame: &mut Frame<'a>,
    ) -> Vec<CapVal> {
        let bases = match callee.operand() {
            Some(of) => self.eval_cap(of, &format!("{path}/callee/of"), frame),
            None => Vec::new(),
        };
        if bases.len() > 1 {
            let names: Vec<String> = bases.iter().map(show_cap).collect();
            self.report(
                "E1002",
                format!(
                    "{} cannot be narrowed as one; narrow what the component declares instead, e.g. component.write(c, \"src\") (doc 9 §2.2).",
                    names.join(" and ")
                ),
                path,
                None,
            );
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
        // A scope known only at run time is intersected with the base then,
        // so it cannot widen; statically it is bounded by the base.
        if !known {
            return vec![base];
        }
        let mut narrowed = base.clone();
        narrowed.set_scope(Some(scope.clone()));
        if !scope_within(base.ctor(), narrowed.scope(), base.scope()) {
            let asked: Vec<String> = scope.iter().map(|s| json_text(s)).collect();
            self.report(
                "E0305",
                format!(
                    "narrow({}) is not inside {}; capabilities can only be narrowed.",
                    asked.join(", "),
                    show_cap(&base)
                ),
                path,
                Some(
                    JsObject::new()
                        .with("base", show_cap(&base))
                        .with("requested", texts(&scope)),
                ),
            );
            return vec![base];
        }
        vec![narrowed]
    }

    /// `methodsCheck(e, path)`, E1801: a 0.5 `net.https(…, methods: […])`
    /// names a non-empty list of methods it knows, as bare names.
    pub(crate) fn methods_check(&mut self, e: Expr<'a>, path: &str) {
        let args = e.arg_values();
        let Some(i) = args
            .iter()
            .position(|a| a.get("name").and_then(Value::as_str) == Some("methods"))
        else {
            return;
        };
        let Some(value) = args.get(i).and_then(|a| a.get("value")).and_then(Expr::of) else {
            return;
        };
        let (last, rest) = HTTP_METHODS.split_last().unwrap_or((&"", &[]));
        let known = format!("{} or {last}", rest.join(", "));
        let expected: Vec<JsValue> = HTTP_METHODS.iter().map(|m| JsValue::from(*m)).collect();
        for p in read_methods(value).problems {
            let message = match p.problem {
                MethodProblemKind::Unknown => format!(
                    "Unknown method {}; net.https allows {known}.",
                    p.found.as_deref().unwrap_or("null")
                ),
                MethodProblemKind::NotAName => format!(
                    "A method is written as a bare name, such as GET, not {}; net.https allows {known}.",
                    p.found
                        .as_deref()
                        .map_or_else(|| "an expression".to_owned(), json_text)
                ),
                MethodProblemKind::Empty => "methods lists at least one method; without methods, net.https allows any method.".to_owned(),
                MethodProblemKind::NotAList => format!(
                    "methods takes a list of bare method names, such as methods: [GET]; net.https allows {known}."
                ),
            };
            let found = p.found.as_deref().map_or(JsValue::Null, JsValue::from);
            self.report(
                "E1801",
                message,
                &format!("{path}/args/{i}/value{}", p.at),
                Some(
                    JsObject::new()
                        .with("found", found)
                        .with("expected", expected.clone()),
                ),
            );
        }
    }

    /// `untrustedInCapArg(e, path, frame)`, R5: untrusted content cannot
    /// pick a capability's scope (E0215). The value of a `var` or `field`
    /// argument is typed by `tryVal` (so a constant it names is typed here,
    /// where it is first needed).
    pub(crate) fn untrusted_in_cap_arg(&mut self, e: Expr<'a>, path: &str, frame: &mut Frame<'a>) {
        if e.is(ExprOp::Var) || e.is(ExprOp::Field) {
            let v = self.try_val(e, frame);
            let level = v.map(|v| epistemic(&v.ty).level);
            if let Some(lvl @ (Level::Untrusted | Level::Inferred)) = level {
                let who = if lvl == Level::Untrusted {
                    "Untrusted content"
                } else {
                    "Model output"
                };
                self.report(
                    "E0215",
                    format!("{who} cannot choose a capability's scope (R5)."),
                    path,
                    Some(JsObject::new().with("level", lvl.as_str())),
                );
            }
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

    /// `capList(list, base)`: every capability expression of a list
    /// evaluated, each with a fresh `constFrame()`, reporting each time.
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

    /// `checkExtern(name, d, base)`: host code never produces a protected
    /// type (E0213), and the effects it declares exist (E0402, through
    /// `effectNames`).
    pub(crate) fn check_extern(&mut self, name: &str, d: Definition<'a>, base: &str) {
        let _ = name;
        let ret = self.ty(d.returns());
        if let Some(p) = mentions(&ret, &PROTECTED_TYPES) {
            self.report(
                "E0213",
                format!("Host code cannot produce {p}; only the runtime does (§12.3)."),
                &format!("{base}/returns"),
                Some(JsObject::new().with("type", p)),
            );
        }
        let effects = d
            .value()
            .get("effects")
            .and_then(Value::as_array)
            .unwrap_or_default();
        self.effect_names(effects, &format!("{base}/effects"));
    }

    /// `checkEffectDecl(name, d, base)`: a critical effect declares
    /// `idempotency required` (E0403) and takes no model output (E0210).
    pub(crate) fn check_effect_decl(&mut self, name: &str, d: Definition<'a>, base: &str) {
        let critical = super::truthy(d.value().get("critical"));
        if critical && !super::truthy(d.value().get("idempotency_required")) {
            self.report(
                "E0403",
                format!("Critical effect '{name}' must declare 'idempotency required'."),
                base,
                None,
            );
        }
        if critical || super::truthy(d.value().get("irreversible")) {
            for (i, p) in d.params().iter().enumerate() {
                let t = self.param_type(p);
                let lvl = epistemic(&t).level;
                if lvl == Level::Inferred || lvl == Level::Untrusted {
                    self.report(
                        "E0210",
                        format!(
                            "Critical effect '{name}' cannot take {}; critical parameters take only T or Verified<T> (R4).",
                            show(&t)
                        ),
                        &format!("{base}/params/{i}/type"),
                        None,
                    );
                }
            }
        }
    }

    /// `effectNames(effects, base)`: every effect named exists (E0402).
    pub(crate) fn effect_names(&mut self, effects: &'a [Value], base: &str) {
        for (i, e) in effects.iter().enumerate() {
            let effect = e.get("effect").and_then(Value::as_str).unwrap_or_default();
            if is_builtin_effect(effect)
                || std_effect(effect).is_some()
                || self.def_of(effect, DefKind::Effect).is_some()
            {
                continue;
            }
            let known: Vec<JsValue> = crate::stdlib::BUILTIN_EFFECTS
                .iter()
                .map(|k| JsValue::from(*k))
                .collect();
            self.report(
                "E0402",
                format!("Unknown effect '{effect}'."),
                &format!("{base}/{i}/effect"),
                Some(JsObject::new().with("known", known)),
            );
        }
    }

    /// `effectScope(e)`: the scope of an effect reference, when every
    /// argument is a text.
    fn effect_scope(e: &Value) -> Option<Vec<String>> {
        let args = e.get("args").and_then(Value::as_array).unwrap_or_default();
        if args.is_empty() {
            return None;
        }
        let mut out = Vec::new();
        for a in args {
            let v = a.get("value").and_then(Expr::of)?;
            if !v.is(ExprOp::Text) {
                return None;
            }
            out.push(v.text().unwrap_or_default().to_owned());
        }
        Some(out)
    }

    /// `requiredCap(effect)`: the capability constructor an effect needs.
    fn required_cap(&self, effect: &str) -> Option<String> {
        if let Some(d) = self.def_of(effect, DefKind::Effect) {
            let req = d.requires_caps().first().and_then(Expr::of)?;
            if req.is(ExprOp::Call) {
                return req.callee().and_then(callee_path);
            }
            return None;
        }
        std_effect(effect).map(|s| s.cap.to_owned())
    }

    /// `capsFor(u, caps)`: the indices of the capabilities among `caps`
    /// that authorize a usage. A usage with a scope needs a capability
    /// whose scope covers it.
    fn caps_for(&self, effect: &str, scope: Option<&[String]>, caps: &[CapVal]) -> Vec<usize> {
        let need = self.required_cap(effect).filter(|n| !n.is_empty());
        caps.iter()
            .enumerate()
            .filter(|(_, c)| match &need {
                Some(need) => {
                    c.ctor() == need
                        && (scope.is_none() || scope_within(c.ctor(), scope, c.scope()))
                }
                None => cap_authorizes(c, effect, scope),
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// `capsFor(u, caps)`, the capabilities themselves.
    fn caps_for_usage(&self, u: &Usage, caps: &[CapVal]) -> Vec<CapVal> {
        self.caps_for(&u.effect, u.scope.as_deref(), caps)
            .into_iter()
            .filter_map(|i| caps.get(i).cloned())
            .collect()
    }

    /// Whether a declared effect reference is authorized by one of `caps`,
    /// as `checkAgent` and `delegateRest` test it; the indices of those
    /// that do.
    fn authorizing(&self, x: &Value, caps: &[CapVal]) -> Vec<usize> {
        let effect = x.get("effect").and_then(Value::as_str).unwrap_or_default();
        let need = self.required_cap(effect).filter(|n| !n.is_empty());
        let scope = Self::effect_scope(x);
        caps.iter()
            .enumerate()
            .filter(|(_, c)| match &need {
                Some(need) => c.ctor() == need,
                None => cap_authorizes(c, effect, scope.as_deref()),
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// `checkUsagesDeclared(usages, declared, who)`: what a body uses it
    /// declares (E0401).
    pub(crate) fn check_usages_declared(
        &mut self,
        usages: &[Usage],
        declared: &'a [Value],
        who: &str,
    ) {
        for u in usages {
            if u.effect == "Delegate" {
                continue;
            }
            let ok = declared.iter().any(|d| {
                d.get("effect").and_then(Value::as_str) == Some(u.effect.as_str())
                    && (u.scope.is_none()
                        || Self::effect_scope(d)
                            .is_none_or(|s| scope_within("fs.", u.scope.as_deref(), Some(&s))))
            });
            if !ok {
                let names: Vec<JsValue> = declared
                    .iter()
                    .map(|d| d.get("effect").map_or(JsValue::Undefined, JsValue::from))
                    .collect();
                self.report(
                    "E0401",
                    format!("{who} uses effect {} but does not declare it.", u.effect),
                    &u.path,
                    Some(
                        JsObject::new()
                            .with("used", u.effect.as_str())
                            .with("declared", names),
                    ),
                );
            }
        }
    }

    /// `checkAgent(name, d, base)`: an agent's capabilities and skills
    /// (E0213, E0402, E0408, E0301, E0503, E0401, W0310).
    pub(crate) fn check_agent(&mut self, name: &str, d: Definition<'a>, base: &str) {
        let caps = self.cap_list(d.caps(), &format!("{base}/caps"));
        // `used` is a Set of the capabilities by identity: here, by index.
        let mut used = vec![false; caps.len()];
        let skills: Vec<(&'a str, &'a Value)> = d.skills().collect();
        for (sn, s) in skills {
            let sb = format!("{base}/skills/{sn}");
            let ret = self.ty(s.get("returns").and_then(mandate_ir::TypeExpr::of));
            if let Some(p) = mentions(&ret, &PROTECTED_TYPES) {
                self.report(
                    "E0213",
                    format!(
                        "Skill '{name}.{sn}' cannot return {p}; a model cannot produce {p} (§5.2, S08)."
                    ),
                    &format!("{sb}/returns"),
                    Some(JsObject::new().with("type", p)),
                );
            }
            let effects = s
                .get("effects")
                .and_then(Value::as_array)
                .unwrap_or_default();
            self.effect_names(effects, &format!("{sb}/effects"));
            if d.remote().is_some() {
                continue;
            }
            self.skill_effects(name, sn, &sb, effects, &caps, &mut used);
            match s.get("body").and_then(Value::as_array) {
                None => {
                    let steps = |b: Option<&Value>| b.and_then(|b| b.get("steps")).is_none();
                    if steps(s.get("budget")) && steps(d.value().get("budget")) {
                        self.report(
                            "E0503",
                            format!(
                                "Skill '{name}.{sn}' runs as an agent loop but neither it nor {name} sets a 'steps' budget (§8.2)."
                            ),
                            &sb,
                            None,
                        );
                    }
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
                    for u in &usages {
                        for i in self.caps_for(&u.effect, u.scope.as_deref(), &caps) {
                            if let Some(slot) = used.get_mut(i) {
                                *slot = true;
                            }
                        }
                    }
                }
            }
        }
        if d.remote().is_none() {
            for (i, c) in caps.iter().enumerate() {
                if !used.get(i).copied().unwrap_or(false) {
                    self.report(
                        "W0310",
                        format!("{name} holds {} but no skill uses it.", show_cap(c)),
                        &format!("{base}/caps/{i}"),
                        None,
                    );
                }
            }
        }
    }

    /// The effects a skill of a local agent declares: none critical
    /// (E0408), each held by a capability of the agent (E0301).
    fn skill_effects(
        &mut self,
        name: &str,
        sn: &str,
        sb: &str,
        effects: &'a [Value],
        caps: &[CapVal],
        used: &mut [bool],
    ) {
        for (i, e) in effects.iter().enumerate() {
            let effect = e.get("effect").and_then(Value::as_str).unwrap_or_default();
            if is_ungated_effect(effect) {
                continue;
            }
            if self.is_critical_effect(effect) {
                self.report(
                    "E0408",
                    format!(
                        "Skill '{name}.{sn}' declares the critical effect '{effect}'. External writes happen only in a workflow's commit step, never inside a delegated task."
                    ),
                    &format!("{sb}/effects/{i}"),
                    None,
                );
                continue;
            }
            let by = self.authorizing(e, caps);
            for j in &by {
                if let Some(slot) = used.get_mut(*j) {
                    *slot = true;
                }
            }
            if by.is_empty() {
                let scope = Self::effect_scope(e);
                self.report(
                    "E0301",
                    format!(
                        "{name}.{sn} uses {effect}{}, but {name} holds no capability for it.",
                        scope_text(scope.as_deref())
                    ),
                    &format!("{sb}/effects/{i}"),
                    Some(
                        JsObject::new()
                            .with("required", effect)
                            .with("available", shown(caps)),
                    ),
                );
            }
        }
    }

    /// `checkWorkflow(name, d, base)`: a workflow's capabilities, its
    /// envelope, its body and handlers, what its body uses against its
    /// capabilities and its envelope (E0220, E1706, E0301, W0310, E1701,
    /// E1704), its budget (E0501, E0504) and its node count (E0105).
    pub(crate) fn check_workflow(&mut self, name: &str, d: Definition<'a>, base: &str) {
        // With an envelope, its capabilities are the workflow's.
        let bounds = workflow_bounds(d.value());
        let caps_at = format!("{base}/{}", bounds.caps_at);
        let caps = self.cap_list(bounds.caps, &caps_at);
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
        let mut used = self.workflow_usages(name, &frame, &caps);
        for dl in frame.delegated.borrow().iter() {
            for c in &dl.caps {
                for (i, w) in caps.iter().enumerate() {
                    if cap_covers(w, c)
                        && let Some(slot) = used.get_mut(i)
                    {
                        *slot = true;
                    }
                }
            }
        }
        // A delegation inside a function the body calls is granted from
        // these capabilities too: an envelope's count as used by it, and so
        // do a sub-program's.
        if under.is_some() {
            for u in frame.usages() {
                let (Some(to), Some(via)) = (u.to.as_deref(), u.via.as_deref()) else {
                    continue;
                };
                if u.effect != "Delegate" || via.is_empty() || to.is_empty() {
                    continue;
                }
                for c in self.granted_through(to, &frame) {
                    for (i, w) in caps.iter().enumerate() {
                        if cap_covers(w, &c)
                            && let Some(slot) = used.get_mut(i)
                        {
                            *slot = true;
                        }
                    }
                }
            }
        }
        // An envelope whose workflow plans holds capabilities for
        // sub-programs that are not written yet.
        let mut plans = false;
        if d.envelope().is_some() {
            walk_exprs(d.body(), &mut |x| plans = plans || x.is(ExprOp::Plan));
        }
        if !plans {
            for (i, c) in caps.iter().enumerate() {
                if !used.get(i).copied().unwrap_or(false) {
                    self.report(
                        "W0310",
                        format!(
                            "{name} holds {} but neither its body nor its delegates use it.",
                            show_cap(c)
                        ),
                        &format!("{caps_at}/{i}"),
                        None,
                    );
                }
            }
        }
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

    /// The usage loop of `checkWorkflow`: every effect the body uses
    /// directly, against the envelope's class (E0220 or E1706) and the
    /// workflow's capabilities (E0301, then the model's class). It gives
    /// which capabilities the usages use, by index.
    fn workflow_usages(&mut self, name: &str, frame: &Frame<'a>, caps: &[CapVal]) -> Vec<bool> {
        let mut used = vec![false; caps.len()];
        for u in frame.usages() {
            if let (Some(max), Some(cls)) = (frame.max_class, u.cls)
                && class_rank(cls) > class_rank(max)
            {
                if u.effect == "Model" {
                    self.over_envelope(
                        format!(
                            "{} data is sent to a model, and {} allows at most {} in the run (spawn.max_class).",
                            cls.as_str(),
                            self.envelope_of(name),
                            max.as_str()
                        ),
                        &u.path,
                        Self::envelope_facts(cls, max),
                    );
                }
                if u.effect == "Delegate"
                    && let Some(via) = u.via.as_deref().filter(|v| !v.is_empty())
                {
                    self.over_envelope(
                        format!(
                            "{} receives {} data inside {via}, and {} allows at most {} in a delegation (spawn.max_class).",
                            u.to.as_deref().unwrap_or("undefined"),
                            cls.as_str(),
                            self.envelope_of(name),
                            max.as_str()
                        ),
                        &u.path,
                        Self::envelope_facts(cls, max).with("via", via),
                    );
                }
            }
            if is_ungated_effect(&u.effect) {
                continue;
            }
            let by = self.caps_for(&u.effect, u.scope.as_deref(), caps);
            for i in &by {
                if let Some(slot) = used.get_mut(*i) {
                    *slot = true;
                }
            }
            if by.is_empty() {
                self.report(
                    "E0301",
                    format!(
                        "{name} uses {}{}, but no capability in its caps authorizes it.",
                        u.effect,
                        scope_text(u.scope.as_deref())
                    ),
                    &u.path,
                    Some(
                        JsObject::new()
                            .with("required", u.effect.as_str())
                            .with("available", shown(caps)),
                    ),
                );
                continue;
            }
            if u.effect == "Model"
                && let Some(cls) = u.cls
            {
                let best = by
                    .iter()
                    .filter_map(|i| caps.get(*i))
                    .map(|c| class_rank(c.max_class().unwrap_or(DataClass::Internal)))
                    .max()
                    .unwrap_or(0);
                if class_rank(cls) > best {
                    let allowed = DATA_CLASSES.get(best).map_or("undefined", |c| c.as_str());
                    self.over_model(
                        format!(
                            "{} data is sent to a model whose capability allows at most {allowed}.",
                            cls.as_str()
                        ),
                        &u.path,
                        best,
                        JsObject::new()
                            .with("data_class", cls.as_str())
                            .with("allowed", allowed),
                    );
                }
            }
        }
        used
    }

    /// `{ data_class, allowed, by: "envelope" }`.
    fn envelope_facts(cls: DataClass, max: DataClass) -> JsObject {
        JsObject::new()
            .with("data_class", cls.as_str())
            .with("allowed", max.as_str())
            .with("by", "envelope")
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

    /// `envelopeOf(name)`: how a message names the envelope that bounds
    /// workflow `name`; a sub-program's is its parent's, the run's.
    fn envelope_of(&self, name: &str) -> String {
        if self.claim.is_some() {
            "the run's envelope".to_owned()
        } else {
            format!("{name}'s envelope")
        }
    }

    /// `overEnvelope(message, path, facts)`: data above the envelope's
    /// `spawn.max_class`; in a sub-program, a part of containment (E1706,
    /// dimension `data_class`), else E0220.
    fn over_envelope(&mut self, message: String, path: &str, facts: JsObject) {
        if self.claim.is_some() {
            let facts = JsObject::new()
                .with("dimension", "data_class")
                .spread(&facts);
            self.report("E1706", message, path, Some(facts));
        } else {
            self.report("E0220", message, path, Some(facts));
        }
    }

    /// `overModel(message, path, best, facts)`: data above what a model's
    /// capability allows, `best` the rank of the class it allows. In a
    /// sub-program, a model that may not receive even what the lead
    /// received is containment (E1706); else E0220.
    fn over_model(&mut self, message: String, path: &str, best: usize, facts: JsObject) {
        if self.claim.is_some() && class_rank(self.floor) > best {
            let lead = self.floor.as_str();
            let facts = JsObject::new()
                .with("dimension", "data_class")
                .spread(&facts)
                .with("by", "lead")
                .with("lead", lead);
            self.report(
                "E1706",
                format!(
                    "{message} The lead received {lead} data, and a sub-program is its output."
                ),
                path,
                Some(facts),
            );
        } else {
            self.report("E0220", message, path, Some(facts));
        }
    }

    /// `reach(name, max, usages)`: `spawn.max_class` in the skills a
    /// workflow with an envelope reaches, however deep (E0220, E1706). The
    /// skills are visited first in, first out, each once.
    pub(crate) fn reach(&mut self, name: &str, max: DataClass, usages: &[Usage]) {
        let mut seen: HashSet<String> = HashSet::new();
        let mut next: std::collections::VecDeque<String> = usages
            .iter()
            .filter(|u| u.effect == "Delegate")
            .filter_map(|u| u.to.clone().filter(|t| !t.is_empty()))
            .collect();
        while let Some(skill) = next.pop_front() {
            if !seen.insert(skill.clone()) {
                continue;
            }
            let inside = self.skill_usage.get(&skill).cloned().unwrap_or_default();
            for u in inside {
                if u.effect == "Delegate"
                    && let Some(to) = u.to.clone().filter(|t| !t.is_empty())
                {
                    next.push_back(to);
                }
                let Some(cls) = u.cls else { continue };
                if (u.effect != "Delegate" && u.effect != "Model")
                    || class_rank(cls) <= class_rank(max)
                {
                    continue;
                }
                let what = if u.effect == "Model" {
                    format!("{} data is sent to a model", cls.as_str())
                } else {
                    format!(
                        "{} receives {} data",
                        u.to.as_deref().unwrap_or("undefined"),
                        cls.as_str()
                    )
                };
                let message = format!(
                    "{what} inside {skill}, which {name} reaches, and {} allows at most {} in the run (spawn.max_class).",
                    self.envelope_of(name),
                    max.as_str()
                );
                self.over_envelope(
                    message,
                    &u.path,
                    Self::envelope_facts(cls, max)
                        .with("workflow", name)
                        .with("skill", skill.as_str()),
                );
            }
        }
    }

    // ── statements ──────────────────────────────────────────────────────

    /// `par(s, frame, path)`: each branch typed in the scope before the
    /// `par`, their write scopes disjoint (E0320), `restart_all` only
    /// without external effects (E0710), and the supervision (E0714). It
    /// gives the branches' values by name, the scope after the `par`.
    pub(crate) fn par(
        &mut self,
        s: mandate_ir::Stmt<'a>,
        frame: &mut Frame<'a>,
        path: &str,
    ) -> HashMap<String, Val> {
        let mut out = HashMap::new();
        let mut writes: Vec<(&'a str, Vec<CapVal>)> = Vec::new();
        let mut external = false;
        for (bn, e) in s.branches() {
            let before = frame.delegated.borrow().len();
            let usages_before = frame.usage_count();
            // Each branch sees the scope before the par, never a sibling's
            // result.
            let v = self.expr_or_unknown(Expr::of(e), frame, &format!("{path}/branches/{bn}"));
            out.insert(bn.to_owned(), v);
            let (caps, ext) = self.branch_writes(frame, before, usages_before);
            external = external || ext;
            writes.push((bn, caps));
        }
        self.par_overlaps(&writes, path);
        if external && s.supervise().and_then(|c| c.name()) == Some("restart_all") {
            self.report(
                "E0710",
                "restart_all would restart branches that have external effects; children must use their own retry classes (§8.7).",
                &format!("{path}/supervise"),
                None,
            );
        }
        if let Some(sup) = s.supervise() {
            self.supervise(sup, &format!("{path}/supervise"), &Site::Par);
        }
        out
    }

    /// What one branch of a `par` can write (what it delegated and the
    /// write capabilities of what it used), and whether it has an external
    /// effect (a critical one, or a remote agent).
    fn branch_writes(
        &self,
        frame: &Frame<'a>,
        before: usize,
        usages_before: usize,
    ) -> (Vec<CapVal>, bool) {
        let delegated: Vec<Delegated> = frame
            .delegated
            .borrow()
            .get(before..)
            .map(<[Delegated]>::to_vec)
            .unwrap_or_default();
        let mut caps: Vec<CapVal> = delegated.iter().flat_map(|d| d.caps.clone()).collect();
        let mut external = false;
        for u in frame.usages_from(usages_before) {
            if let Some(avail) = frame.avail.as_deref() {
                caps.extend(
                    self.caps_for_usage(&u, avail)
                        .into_iter()
                        .filter(CapVal::write),
                );
            }
            if self.is_critical_effect(&u.effect) {
                external = true;
            }
        }
        if delegated.iter().any(|d| d.external) {
            external = true;
        }
        (caps.into_iter().filter(CapVal::write).collect(), external)
    }

    /// E0320: two branches of a `par` that can write one scope, each pair
    /// of branches in order, each pair of their capabilities.
    fn par_overlaps(&mut self, writes: &[(&str, Vec<CapVal>)], path: &str) {
        for (i, (a, ca_all)) in writes.iter().enumerate() {
            for (b, cb_all) in writes.iter().skip(i.saturating_add(1)) {
                for ca in ca_all {
                    for cb in cb_all {
                        if writes_overlap(ca, cb) {
                            self.report(
                                "E0320",
                                format!(
                                    "par branches '{a}' and '{b}' can both write {}; write scopes in a par block must be disjoint (C5).",
                                    overlap_text(ca, cb)
                                ),
                                &format!("{path}/branches/{b}"),
                                Some(
                                    JsObject::new()
                                        .with(
                                            "branches",
                                            vec![JsValue::from(*a), JsValue::from(*b)],
                                        )
                                        .with("left", show_cap(ca))
                                        .with("right", show_cap(cb)),
                                ),
                            );
                        }
                    }
                }
            }
        }
    }

    /// `supervise(c, path, site)`: supervision strategies (§8.7, E0713,
    /// E0714, E0715). A `degrade` of a delegation evaluates the
    /// capabilities of the fallback and of the original agent (`capList`)
    /// to compare them.
    pub(crate) fn supervise(&mut self, c: CallSpec<'a>, path: &str, site: &Site<'_>) {
        let name = c.name().unwrap_or_default();
        let allowed: &[&str] = match site {
            Site::Par => &["fail_fast", "restart_all"],
            Site::Delegate { .. } => &["restart", "escalate", "degrade"],
        };
        if !allowed.contains(&name) {
            let for_what = match site {
                Site::Par => "a par block",
                Site::Delegate { .. } => "a delegation",
            };
            self.report(
                "E0714",
                format!(
                    "'{name}' is not a supervision strategy for {for_what}; use {} (§8.7).",
                    allowed.join(", ")
                ),
                path,
                Some(
                    JsObject::new().with("strategy", name).with(
                        "allowed",
                        allowed
                            .iter()
                            .map(|a| JsValue::from(*a))
                            .collect::<Vec<_>>(),
                    ),
                ),
            );
            return;
        }
        let args = c.args();
        let arg_name = |a: &'a Value| a.get("name").and_then(Value::as_str);
        let arg_value = |a: &'a Value| a.get("value").and_then(Expr::of);
        if name == "restart" {
            let max = args
                .iter()
                .find(|a| arg_name(a) == Some("max"))
                .and_then(arg_value);
            if let Some(m) = max.filter(|m| m.is(ExprOp::Int))
                && let Some(n) = m.value().and_then(Value::as_i64)
                && usize::try_from(n).is_ok_and(|n| n > MAX_RESTARTS)
            {
                self.report(
                    "E0713",
                    format!(
                        "restart(max: {n}) exceeds the limit of {MAX_RESTARTS} retries (§8.7)."
                    ),
                    path,
                    None,
                );
            }
        }
        if name == "escalate" {
            let since_0_4 = self.at_least(Language::V0_4);
            let first_ok = args.first().is_some_and(|a| {
                a.get("name").is_none()
                    && arg_value(a).is_some_and(|v| v.is(ExprOp::Var) && v.name() == Some("human"))
            });
            let rest_ok = args.iter().skip(1).all(|a| {
                arg_name(a) == Some("role")
                    && arg_value(a)
                        .is_some_and(|v| v.is(ExprOp::Text) || (v.is(ExprOp::Var) && since_0_4))
            });
            if !(first_ok && rest_ok) {
                self.report(
                    "E0714",
                    "escalate takes a person: escalate(human) or escalate(human, role: \"…\") (§8.7).",
                    path,
                    None,
                );
            }
        }
        if let Site::Delegate {
            agent,
            skill,
            given,
        } = site
            && name == "degrade"
        {
            let to = args
                .iter()
                .find(|a| arg_name(a) == Some("to"))
                .and_then(arg_value);
            let fallback_name = to
                .filter(|t| t.is(ExprOp::Var))
                .and_then(Expr::name)
                .filter(|n| !n.is_empty());
            let fallback = fallback_name.and_then(|n| self.def_of(n, DefKind::Agent));
            let (Some(fallback_name), Some(fallback)) = (fallback_name, fallback) else {
                self.report(
                    "E0715",
                    "degrade names its fallback agent: degrade(to: Agent) (§8.7).",
                    path,
                    None,
                );
                return;
            };
            self.degrade(fallback_name, fallback, agent, skill, given, path);
        }
    }

    /// A `degrade(to: Fallback)` of a delegation: the fallback does the
    /// same job with no more authority (E0715): the same skill signature,
    /// capabilities inside the original agent's, and the ones the call
    /// hands over.
    fn degrade(
        &mut self,
        name: &str,
        fallback: Definition<'a>,
        agent: &str,
        skill: &str,
        given: &[CapVal],
        path: &str,
    ) {
        let original = self.def_of(agent, DefKind::Agent);
        let want = original.and_then(|o| o.skill(skill));
        let have = fallback.skill(skill);
        let mut problems: Vec<String> = Vec::new();
        match have {
            None => problems.push(format!("{name} has no skill {skill}")),
            Some(have) => {
                if let Some(want) = want
                    && Self::signature(want) != Self::signature(have)
                {
                    problems.push(format!(
                        "{name}.{skill} has another signature than {agent}.{skill}"
                    ));
                }
            }
        }
        let fallback_caps = self.cap_list(fallback.caps(), &ptr(&[&"defs", &name, &"caps"]));
        let original_caps = match original {
            Some(o) => self.cap_list(o.caps(), &ptr(&[&"defs", &agent, &"caps"])),
            None => Vec::new(),
        };
        for fc in &fallback_caps {
            if !original_caps.iter().any(|oc| cap_covers(oc, fc)) {
                problems.push(format!(
                    "{name} holds {}, which {agent} does not",
                    show_cap(fc)
                ));
            }
        }
        for g in given {
            if !fallback_caps.iter().any(|fc| cap_covers(fc, g)) {
                problems.push(format!(
                    "{name} does not hold {}, which this call hands over",
                    show_cap(g)
                ));
            }
        }
        if !problems.is_empty() {
            self.report(
                "E0715",
                format!(
                    "degrade to {name} would not do the same job with no more authority: {} (§8.7).",
                    problems.join("; ")
                ),
                path,
                Some(
                    JsObject::new()
                        .with("fallback", name)
                        .with("problems", texts(&problems)),
                ),
            );
        }
    }

    /// `canonicalize({ params: s.params.map((p) => p.type), returns:
    /// s.returns })`: a skill's signature, compared as text.
    fn signature(s: &Value) -> String {
        let params: Vec<Value> = s
            .get("params")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .map(|p| p.get("type").cloned().unwrap_or(Value::Null))
            .collect();
        let mut m = Map::new();
        m.insert("params", Value::Array(params));
        if let Some(r) = s.get("returns") {
            m.insert("returns", r.clone());
        }
        canonicalize(&Value::Object(m))
    }

    // ── expressions ─────────────────────────────────────────────────────

    /// `map(e, frame, path)`: `map x in xs … { body }`, its body typed
    /// once with `x` an element of `xs`, the result `List<Outcome<T>>`
    /// (E0201, E0701, E0714, E1702, E1703, E1708, E0320, E0501).
    pub(crate) fn map(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let over = self.operand(e.over(), frame, path, "over");
        let (inner, by_item) = self.map_frame(e, frame, path, &over);
        self.map_supervise(e, path);
        let delegated_before = frame.delegated.borrow().len();
        let usages_before = frame.usage_count();
        let at = super::sub(path, "body");
        let body = self.body(e.body(), &inner, &at, false);
        self.map_after(
            e,
            frame,
            path,
            &inner,
            &by_item,
            usages_before,
            delegated_before,
        );
        Val {
            ty: named("List", vec![named("Outcome", vec![body.ty])]),
            cls: over.cls.max(body.cls),
        }
    }

    /// E0714: a map takes only `fail_fast`.
    fn map_supervise(&mut self, e: Expr<'a>, path: &str) {
        if let Some(sup) = e.supervise() {
            let name = sup.name().unwrap_or_default();
            if name != "fail_fast" {
                self.report(
                    "E0714",
                    format!(
                        "'{name}' is not a supervision strategy for a map; use fail_fast (spec/envelope.md)."
                    ),
                    &format!("{path}/supervise"),
                    Some(
                        JsObject::new()
                            .with("strategy", name)
                            .with("allowed", vec![JsValue::from("fail_fast")]),
                    ),
                );
            }
        }
    }

    /// The frame a map's body is typed in: the element bound, `inMap`, and
    /// the map's `with caps` in `handed` and `avail` (E0201, E0701); and
    /// `byItem`, the kinds whose scope the element chooses, in insertion
    /// order.
    fn map_frame(
        &mut self,
        e: Expr<'a>,
        frame: &Frame<'a>,
        path: &str,
        over: &Val,
    ) -> (Box<Frame<'a>>, Vec<String>) {
        let ep = epistemic(&over.ty);
        let list = unalias(&ep.inner, self);
        let mut elem = UNKNOWN;
        if list.is_named("List") {
            elem = list.arg(0);
        } else if !matches!(list, Ty::Unknown) {
            self.report(
                "E0201",
                format!("map runs its body over a List but got {}.", show(&over.ty)),
                &format!("{path}/over"),
                None,
            );
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
        let bind = e.bind().unwrap_or_default();
        let mut vars = HashMap::new();
        vars.insert(bind.to_owned(), item);
        let mut inner = Self::child_box(frame, vars);
        inner.in_map = Some(path.to_owned());
        let mut by_item: Vec<String> = Vec::new();
        // `with caps K`: inside the body, K takes the place of the
        // capability kinds it names.
        if let Some(caps) = e.caps() {
            let mut given: Vec<CapVal> = Vec::new();
            for (i, c) in caps.iter().enumerate() {
                let cp = format!("{path}/caps/{i}");
                let Some(c) = Expr::of(c) else { continue };
                let chosen = Self::chosen_by_item(c, bind);
                for v in self.eval_cap(c, &cp, &mut inner) {
                    if chosen && !by_item.iter().any(|k| k == v.ctor()) {
                        by_item.push(v.ctor().to_owned());
                    }
                    self.map_given(&v, frame, &cp);
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
        (inner, by_item)
    }

    /// Whether the element chooses a `with caps` scope: a `narrow(…)` with
    /// an argument that is not a text and reads the element.
    fn chosen_by_item(c: Expr<'a>, bind: &str) -> bool {
        c.is(ExprOp::Call)
            && c.callee()
                .is_some_and(|k| k.is(ExprOp::Field) && k.name() == Some("narrow"))
            && c.arg_values().iter().any(|a| {
                a.get("value").is_some_and(|v| {
                    !Expr::of(v).is_some_and(|x| x.is(ExprOp::Text)) && reads_var(v, bind)
                })
            })
    }

    /// E0701: what a map hands its body lies inside the context (C2).
    fn map_given(&mut self, v: &CapVal, frame: &Frame<'a>, cp: &str) {
        if let Some(avail) = frame.avail.as_deref()
            && !avail.iter().any(|a| cap_covers(a, v))
        {
            self.report(
                "E0701",
                format!(
                    "{} is not available in {}, so a map cannot hand it to its body (C2).",
                    show_cap(v),
                    frame.def
                ),
                cp,
                Some(
                    JsObject::new()
                        .with("capability", show_cap(v))
                        .with("available", shown(avail)),
                ),
            );
        }
    }

    /// What a map checks once its body is typed: its bound (E1702), its
    /// `par` (E1703), the people its items would wait for (E1708, the
    /// core's `person`), what its items may write (E0320), and its budget
    /// (E0501, E0504).
    #[allow(clippy::too_many_arguments)]
    fn map_after(
        &mut self,
        e: Expr<'a>,
        frame: &Frame<'a>,
        path: &str,
        inner: &Frame<'a>,
        by_item: &[String],
        usages_before: usize,
        delegated_before: usize,
    ) {
        let usages = frame.usages_from(usages_before);
        self.map_bound(e, frame, path, &usages);
        // A person is asked once about the list, after the map (E1708). A
        // step in a map inside this one was reported there, for that map.
        for u in &usages {
            if u.effect != "Human" || self.asked_in_map.contains(&u.path) {
                continue;
            }
            self.asked_in_map.insert(u.path.clone());
            self.person(inner, &u.path, "human step", None);
        }
        let par = e.get("par").and_then(Value::as_i64);
        if par.unwrap_or(1) > 1 {
            let delegated: Vec<Delegated> = frame
                .delegated
                .borrow()
                .get(delegated_before..)
                .map(<[Delegated]>::to_vec)
                .unwrap_or_default();
            self.map_writes(e, path, inner, by_item, &usages, &delegated);
        }
        if let Some(b) = e.get("budget").and_then(Budget::of) {
            self.map_budget(e, b, path, frame.envelope);
        }
    }

    /// E1702: a map's bound, `max` or inside an envelope its `agents` when
    /// the body starts a delegation; E1703: its `par` within the
    /// envelope's `max_concurrent`.
    fn map_bound(&mut self, e: Expr<'a>, frame: &Frame<'a>, path: &str, usages: &[Usage]) {
        if e.get("max").is_none() {
            if frame.envelope.is_none() {
                self.report(
                    "E1702",
                    "A map says how many elements it accepts at most: add 'max n'. Only in the body of a workflow with an envelope may it be left out (spec/envelope.md \"map\").",
                    path,
                    Some(JsObject::new().with("envelope", false)),
                );
            } else if !usages.iter().any(|u| u.effect == "Delegate") {
                self.report(
                    "E1702",
                    "This map has no 'max', and its body starts no delegation, so the envelope's agents do not bound it: add 'max n' (spec/envelope.md \"map\").",
                    path,
                    Some(
                        JsObject::new()
                            .with("envelope", true)
                            .with("delegates", false),
                    ),
                );
            }
        }
        let most = frame.envelope.and_then(Bound::max_concurrent);
        if let (Some(par), Some(most)) = (e.get("par").and_then(Value::as_i64), most)
            && (par as f64) > most
        {
            let most_text = mandate_ir::number_to_string(most);
            self.report(
                "E1703",
                format!(
                    "par {par} runs more items at once than the envelope lets delegations be in flight (spawn.max_concurrent: {most_text}) (spec/envelope.md \"map\")."
                ),
                &format!("{path}/par"),
                Some(
                    JsObject::new()
                        .with("par", par as f64)
                        .with("max_concurrent", most),
                ),
            );
        }
    }

    /// C5 of a map with `par k > 1` (E0320): what every item can write,
    /// unless the element chooses its scope, once per capability as shown
    /// (a `Map` keyed by `showCap`: the first place, the last value).
    fn map_writes(
        &mut self,
        e: Expr<'a>,
        path: &str,
        inner: &Frame<'a>,
        by_item: &[String],
        usages: &[Usage],
        delegated: &[Delegated],
    ) {
        let mut all: Vec<CapVal> = delegated.iter().flat_map(|d| d.caps.clone()).collect();
        if let Some(avail) = inner.avail.as_deref() {
            for u in usages {
                if !self.is_critical_effect(&u.effect) {
                    all.extend(self.caps_for_usage(u, avail));
                }
            }
        }
        // A delegation inside a function the body calls is granted here
        // too, with what the map hands it.
        for u in usages {
            if u.effect == "Delegate"
                && u.via.as_deref().is_some_and(|v| !v.is_empty())
                && let Some(to) = u.to.as_deref().filter(|t| !t.is_empty())
            {
                all.extend(self.granted_through(to, inner));
            }
        }
        let mut shared: Vec<(String, CapVal)> = Vec::new();
        for c in all {
            if !c.write() || by_item.iter().any(|k| k == c.ctor()) {
                continue;
            }
            let key = show_cap(&c);
            match shared.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = c,
                None => shared.push((key, c)),
            }
        }
        let mut sorted: Vec<String> = by_item.to_vec();
        sorted.sort_by(|a, b| compare_utf16(a, b));
        let par = e.get("par").and_then(Value::as_i64).unwrap_or(1);
        let bind = e.bind().unwrap_or_default();
        for (shown_cap, c) in shared {
            let scope = c
                .scope()
                .map_or_else(|| "an unknown scope".to_owned(), |s| s.join(", "));
            self.report(
                "E0320",
                format!(
                    "Every item of this map can write {scope} ({shown_cap}), and par {par} runs them side by side. Hand each item its own scope with the map's 'with caps', narrowed by '{bind}' (C5)."
                ),
                path,
                Some(
                    JsObject::new()
                        .with("par", par as f64)
                        .with("capability", shown_cap.as_str())
                        .with("by_item", texts(&sorted)),
                ),
            );
        }
    }

    /// `grantedThrough(who, frame)`: what a delegation to `who`
    /// (`Agent.skill`) inside a function is granted at most when the
    /// function is called in `frame`: what the agent holds inside the
    /// context, with a map's `with caps` in place of the kinds it hands.
    fn granted_through(&self, who: &str, frame: &Frame<'a>) -> Vec<CapVal> {
        let Some(agent) = self.def_of(agent_of(who), DefKind::Agent) else {
            return Vec::new();
        };
        let held: Vec<CapVal> = agent
            .caps()
            .iter()
            .filter_map(Expr::of)
            .flat_map(|c| caps_of(self.defs, c, self.cap_opts()))
            .collect();
        let remote = agent.remote().is_some();
        let handed: Vec<CapVal> = frame
            .handed
            .as_deref()
            .map(|h| {
                h.iter()
                    .filter(|k| remote || held.iter().any(|a| cap_covers(a, k)))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let kinds: HashSet<&str> = handed.iter().map(CapVal::ctor).collect();
        let avail = frame.avail.as_deref();
        let mut out: Vec<CapVal> = held
            .iter()
            .filter(|c| {
                !kinds.contains(c.ctor())
                    && avail.is_none_or(|a| a.iter().any(|x| cap_covers(x, c)))
            })
            .cloned()
            .collect();
        out.extend(handed.iter().cloned());
        out
    }

    /// `mapBudget(e, path, envelope)`: `budget b` on a map stands in for
    /// one item, so what the body hands out fits in it (E0501, at the map).
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
        let facts = self.over_budget(b, &cost, &at, "This map's budget", true);
        if !facts.is_empty() {
            let keys: Vec<&str> = facts.keys().collect();
            let message = format!(
                "One item of this map hands out more than the map's budget for an item ({}).",
                keys.join(", ")
            );
            let facts = facts.with(
                "breakdown",
                cost.parts.iter().map(|p| p.to_js()).collect::<Vec<_>>(),
            );
            self.report("E0501", message, &at, Some(facts));
        }
    }

    /// `delegate(e, frame, path)` (and `plan`, which is read as a
    /// delegation): the skill's arguments (E0201), the grant (C1, C2:
    /// E0701, E0301), the data it may receive (E0220, E1706), its timeout
    /// and supervision.
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
        self.delegate_args(skill, &who, path, args);
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
        let remote = agent.remote();
        let mut given: Vec<CapVal> = Vec::new();
        if let Some(caps) = e.caps() {
            for (i, c) in caps.iter().enumerate() {
                let cp = format!("{path}/caps/{i}");
                let Some(c) = Expr::of(c) else { continue };
                for v in self.eval_cap(c, &cp, frame) {
                    // `given(v, …)`, C2.
                    let held = remote.is_some() || agent_caps.iter().any(|a| cap_covers(a, &v));
                    self.given(
                        &v,
                        &cp,
                        in_context(&v),
                        held,
                        frame,
                        agent_name,
                        &agent_caps,
                    );
                    given.push(v);
                }
            }
        }
        // A map hands its `with caps` to each delegation of its body.
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
        let grant = Grant {
            agent_name,
            skill_name,
            agent,
            skill,
            who: &who,
            effective: &effective,
            given: &given,
            cls,
        };
        self.delegate_rest(e, frame, path, &grant);
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

    /// A delegation's arguments against the skill's parameters: their
    /// count (E0201) and each (the rest of `assignable`).
    fn delegate_args(&mut self, skill: &'a Value, who: &str, path: &str, args: &[Val]) {
        let params = skill
            .get("params")
            .and_then(Value::as_array)
            .unwrap_or_default();
        if args.len() != params.len() {
            self.report(
                "E0201",
                format!(
                    "{who} takes {} argument(s) but got {}.",
                    params.len(),
                    args.len()
                ),
                path,
                None,
            );
        }
        for (i, param) in params.iter().enumerate() {
            if let Some(a) = args.get(i) {
                let t = self.param_type(param);
                self.expect(&a.ty, &t, &format!("{path}/args/{i}/value"));
            }
        }
    }

    /// `given(v, …)`: one capability handed over with `with caps` lies
    /// inside both the context and the agent (C2, E0701). `in_context` and
    /// `held` are the two tests.
    #[allow(clippy::too_many_arguments)]
    fn given(
        &mut self,
        v: &CapVal,
        cp: &str,
        in_context: bool,
        held: bool,
        frame: &Frame<'a>,
        agent_name: &str,
        agent_caps: &[CapVal],
    ) {
        if !in_context {
            let available = frame
                .avail
                .as_deref()
                .map(Vec::as_slice)
                .map(shown)
                .unwrap_or_default();
            self.report(
                "E0701",
                format!(
                    "{} is not available in {}, so it cannot be delegated (C2).",
                    show_cap(v),
                    frame.def
                ),
                cp,
                Some(
                    JsObject::new()
                        .with("capability", show_cap(v))
                        .with("available", available),
                ),
            );
        }
        if !held {
            self.report(
                "E0701",
                format!(
                    "{agent_name} does not hold {}; 'with caps' can only narrow what the agent already holds (C2).",
                    show_cap(v)
                ),
                cp,
                Some(
                    JsObject::new()
                        .with("capability", show_cap(v))
                        .with("agent", shown(agent_caps)),
                ),
            );
        }
    }

    /// `delegateRest(e, frame, path, agent, skill, who, effective, given,
    /// cls)`: what a delegation's grant must cover (E0301), the data it may
    /// receive (E0220, E1706), its timeout and its supervision.
    fn delegate_rest(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str, g: &Grant<'_, 'a>) {
        self.delegate_grant(frame, path, g);
        if let Some(t) = e.timeout() {
            let at = format!("{path}/timeout");
            let v = self.expr(t, frame, &at);
            self.expect(&v.ty, &named0("Duration"), &at);
        }
        if let Some(sup) = e.supervise() {
            self.supervise(
                sup,
                &format!("{path}/supervise"),
                &Site::Delegate {
                    agent: g.agent_name,
                    skill: g.skill_name,
                    given: g.given,
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

    /// C1 at the delegation site (E0301), the model's class (§5.5) and the
    /// envelope's (E0220, E1706) of what the delegation hands over.
    fn delegate_grant(&mut self, frame: &Frame<'a>, path: &str, g: &Grant<'_, 'a>) {
        let effects = g
            .skill
            .get("effects")
            .and_then(Value::as_array)
            .unwrap_or_default();
        if g.agent.remote().is_none() {
            for x in effects {
                let effect = x.get("effect").and_then(Value::as_str).unwrap_or_default();
                if is_ungated_effect(effect) || self.is_critical_effect(effect) {
                    continue;
                }
                if self.authorizing(x, g.effective).is_empty() {
                    self.report(
                        "E0301",
                        format!(
                            "{} uses {effect}, but this delegation grants no capability for it ({} lacks it or 'with caps' left it out).",
                            g.who, frame.def
                        ),
                        path,
                        Some(
                            JsObject::new()
                                .with("required", effect)
                                .with("granted", shown(g.effective)),
                        ),
                    );
                }
            }
        }
        // §5.5: data sent to the agent's model may not exceed what its
        // model capability allows.
        let best = g
            .effective
            .iter()
            .filter(|c| c.ctor() == "model.infer")
            .map(|c| class_rank(c.max_class().unwrap_or(DataClass::Internal)))
            .max();
        if let Some(best) = best
            && effects
                .iter()
                .any(|x| x.get("effect").and_then(Value::as_str) == Some("Model"))
            && class_rank(g.cls) > best
        {
            let allowed = DATA_CLASSES.get(best).map_or("undefined", |c| c.as_str());
            self.over_model(
                format!(
                    "{} receives {} data, but its model capability allows at most {allowed} (§5.5).",
                    g.who,
                    g.cls.as_str()
                ),
                path,
                best,
                JsObject::new()
                    .with("data_class", g.cls.as_str())
                    .with("allowed", allowed),
            );
        }
        // An envelope bounds the data class of every delegation in the run.
        if let Some(max) = frame.max_class
            && class_rank(g.cls) > class_rank(max)
        {
            self.over_envelope(
                format!(
                    "{} receives {} data, and {} allows at most {} in a delegation (spawn.max_class).",
                    g.who,
                    g.cls.as_str(),
                    self.envelope_of(&frame.def),
                    max.as_str()
                ),
                path,
                Self::envelope_facts(g.cls, max),
            );
        }
    }

    /// `effectCall(e, frame, path)`: an `effect name(…)` call: its
    /// arguments against the effect's parameters (E0201), a critical one
    /// only in a workflow (E0408) with `idempotent_by` (E0403), an
    /// irreversible one after an approval (E0405), and in a map (E1708).
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
        let (critical, irreversible) = match decl {
            Some(d) => {
                let irreversible = super::truthy(d.value().get("irreversible"));
                (
                    super::truthy(d.value().get("critical")) || irreversible,
                    irreversible,
                )
            }
            None => (
                std.is_some_and(|s| s.critical),
                std.is_some_and(|s| s.irreversible),
            ),
        };
        self.effect_args(e, decl, std, path, args);
        if critical && frame.in_map.is_some() {
            self.critical(
                frame,
                path,
                &format!("The critical effect {name} runs"),
                name,
            );
        }
        if critical {
            self.effect_critical(e, frame, path);
        }
        if irreversible && !frame.approved && !args.iter().any(|a| self.approved_by_human(&a.ty)) {
            self.report(
                "E0405",
                format!(
                    "Irreversible effect {name} runs without a prior human.approve or a value verified by a contract that requires one (§6.3)."
                ),
                path,
                None,
            );
        }
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

    /// An effect call's arguments against the effect's parameters, when
    /// they are known: their count (E0201) and each.
    fn effect_args(
        &mut self,
        e: Expr<'a>,
        decl: Option<Definition<'a>>,
        std: Option<&'static crate::stdlib::StdEffect>,
        path: &str,
        args: &[Val],
    ) {
        let params: Vec<Ty> = match (decl, std) {
            (Some(d), _) => d.params().iter().map(|p| self.param_type(p)).collect(),
            (None, Some(s)) => s.params.iter().map(super::expr::std_ty).collect(),
            (None, None) => return,
        };
        if args.len() != params.len() {
            self.report(
                "E0201",
                format!(
                    "Effect {} takes {} argument(s) but got {}.",
                    e.name().unwrap_or_default(),
                    params.len(),
                    args.len()
                ),
                path,
                None,
            );
        }
        for (i, t) in params.iter().enumerate() {
            if let Some(a) = args.get(i) {
                self.expect(&a.ty, t, &format!("{path}/args/{i}/value"));
            }
        }
    }

    /// A critical effect: only in a workflow (E0408), with `idempotent_by`
    /// at the call (E0403).
    fn effect_critical(&mut self, e: Expr<'a>, frame: &Frame<'a>, path: &str) {
        let name = e.name().unwrap_or_default();
        if matches!(frame.where_, Where::Fn | Where::Skill | Where::Contract) {
            self.report(
                "E0408",
                format!(
                    "The critical effect {name} runs inside a {}. External writes happen only in a workflow, through prepare → authorize → commit (§8.8, S07).",
                    frame.where_.as_str()
                ),
                path,
                None,
            );
        }
        if e.idempotent_by().is_none() {
            self.report(
                "E0403",
                format!("Critical effect {name} needs 'idempotent_by' at the call site (§8.4)."),
                path,
                Some(JsObject::new().with("repair_hint", "add `idempotent_by <business key>`")),
            );
        }
    }

    // ── envelope.ts ─────────────────────────────────────────────────────

    /// `checkEnvelope(name, d, base, caps, env)` of `envelope.ts`: an
    /// envelope gives `owner`, `caps` and a `budget` with `agents`, and its
    /// workflow none of its own (E1701); what it asks to approve is a
    /// critical effect its caps cover (E1704).
    pub(crate) fn check_envelope(
        &mut self,
        name: &str,
        d: Definition<'a>,
        base: &str,
        caps: &[CapVal],
    ) {
        let Some(e) = d.envelope() else { return };
        let at = format!("{base}/envelope");
        let m = e.members();
        let mut missing: Vec<&str> = Vec::new();
        if m.get("owner").is_none() {
            missing.push("owner");
        }
        if m.get("caps").is_none() {
            missing.push("caps");
        }
        match m.get("budget") {
            None => missing.push("budget"),
            Some(b) if b.get("agents").is_none() => missing.push("budget.agents"),
            Some(_) => {}
        }
        if !missing.is_empty() {
            self.report(
                "E1701",
                format!(
                    "{name}'s envelope does not give {}. An envelope names its owner, its caps and a budget with agents: they are what a person approves (spec/envelope.md \"What it declares\").",
                    and_list(&missing)
                ),
                &at,
                Some(JsObject::new().with(
                    "missing",
                    missing.iter().map(|x| JsValue::from(*x)).collect::<Vec<_>>(),
                )),
            );
        }
        if !d.caps().is_empty() {
            self.report(
                "E1701",
                format!(
                    "{name} has an envelope and caps of its own. The envelope's caps take their place: write them there."
                ),
                &format!("{base}/caps"),
                Some(JsObject::new().with("field", "caps")),
            );
        }
        if super::truthy(d.value().get("budget")) {
            self.report(
                "E1701",
                format!(
                    "{name} has an envelope and a budget of its own. The envelope's budget takes its place: write it there."
                ),
                &format!("{base}/budget"),
                Some(JsObject::new().with("field", "budget")),
            );
        }
        let mut approve: Vec<(&'a str, &'a Value)> = e.approve().collect();
        approve.sort_by(|a, b| compare_utf16(a.0, b.0));
        for (effect, role) in approve {
            self.envelope_approval(name, &at, effect, role, caps);
        }
    }

    /// One approval of an envelope (E1704): of a critical effect, which a
    /// capability of the envelope covers.
    fn envelope_approval(
        &mut self,
        name: &str,
        at: &str,
        effect: &str,
        role: &Value,
        caps: &[CapVal],
    ) {
        let path = format!("{at}/approve/{}", ptr_token(effect));
        let role_text = value_text(role);
        let facts = JsObject::new()
            .with("effect", effect)
            .with("role", JsValue::from(role));
        if !self.is_critical_effect(effect) {
            self.report(
                "E1704",
                format!(
                    "{name}'s envelope asks {role_text} to approve '{effect}', which is not a critical effect. Only an effect that goes through prepare → authorize → commit is authorized by anyone."
                ),
                &path,
                Some(facts.with("critical", false)),
            );
            return;
        }
        if self.caps_for(effect, None, caps).is_empty() {
            self.report(
                "E1704",
                format!(
                    "{name}'s envelope asks {role_text} to approve '{effect}', but no capability in the envelope's caps covers it, so nothing in the run can do it."
                ),
                &path,
                Some(
                    facts
                        .with("critical", true)
                        .with("available", shown(caps)),
                ),
            );
        }
    }

    /// `plansOutside(program.defs, report)` of `envelope.ts`: a `plan`
    /// stands only in the body of a workflow with an envelope (E1707). Run
    /// only without a claim. Within a definition the plans are reported in
    /// the order of their paths, sorted as texts by UTF-16 code units
    /// (`/body/10` before `/body/2`).
    pub(crate) fn plans_outside(&mut self) {
        let program = self.program;
        for (name, d) in program.definitions() {
            let base = format!("/defs/{}", ptr_token(name));
            let kind = d
                .value()
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let in_envelope = kind == "workflow" && d.envelope().is_some();
            let mut found: Vec<String> = Vec::new();
            if let Some(members) = d.members() {
                for (k, x) in members.iter() {
                    if in_envelope && k == "body" {
                        continue;
                    }
                    plans(x, &format!("{base}/{}", ptr_token(k)), &mut found);
                }
            }
            found.sort_by(|a, b| compare_utf16(a, b));
            for path in found {
                let why = if kind != "workflow" {
                    let article = if kind.starts_with(['a', 'e', 'i', 'o', 'u']) {
                        "an"
                    } else {
                        "a"
                    };
                    format!("{name} is {article} {kind}")
                } else if in_envelope {
                    format!("this one is outside {name}'s body")
                } else {
                    format!("{name} has no envelope")
                };
                self.report(
                    "E1707",
                    format!(
                        "'plan … within envelope' stands only in the body of a workflow with an envelope, and {why} (spec/envelope.md \"plan\")."
                    ),
                    &path,
                    Some(
                        JsObject::new()
                            .with("def", name)
                            .with("kind", kind)
                            .with("envelope", in_envelope),
                    ),
                );
            }
        }
    }
}
