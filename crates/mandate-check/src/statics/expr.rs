//! The typer of expressions: `expectBool`, `typeClass`, `use`,
//! `expr`, `exprInner` and the forms it calls (`prompt`, `field`, `call`,
//! `record`, `infer`, `verify`, `switchExpr`), and the leaves the other
//! parts call too (`person`, `critical`, `waits`, `asksApproval`,
//! `fnWaits`, `approvedByHuman`, `isModuleRoot`, `tagsOf`,
//! `variantFields`). `exprInner` calls the authority's `delegate`,
//! `map` and `effectCall`, the system model's `changeset` and `dataRead`,
//! and the authority's `evalCap` for `cap.narrow(…)`.

use std::collections::{HashMap, HashSet};

use mandate_ir::{
    DefKind, Expr, ExprOp, JsObject, Language, Pattern, PatternKind, Value, VerifierForm,
};

use super::typing::unmet_keeps_verified;
use super::{
    Checker, Frame, Usage, Val, Where, any_silent, any_waivable, callee_is, max_class, sub, sub_i,
};
use crate::caps::callee_path;
use crate::path::path_problem;
use crate::resolve::SUPERVISION_STRATEGIES;
use crate::stdlib::{
    DataClass, MAX_CHOICE_OPTIONS, PROTECTED_TYPES, StdType, is_decision_policy,
    is_out_of_scope_option, is_protected_type, std_fn,
};
use crate::ty::{
    Level, Ty, UNKNOWN, assignable, bool_ty, epistemic, field, fields_of, from_type_expr,
    join_level, mentions, named, named0, show, text_ty, unalias, weaker_level, with_level,
};
use crate::walk::walk_exprs;

/// A std table's type as the checker's: `fromTypeExpr(t(ref, ...args))`.
pub(crate) fn std_ty(t: &StdType) -> Ty {
    if t.reference == "?" {
        return UNKNOWN;
    }
    named(t.reference, t.args.iter().map(std_ty).collect())
}

/// `ep.level === "verified" ? "plain" : ep.level`: what a value read out
/// of a verified one is.
fn unverified(l: Level) -> Level {
    if l == Level::Verified {
        Level::Plain
    } else {
        l
    }
}

/// The types the arms of a switch bind, `armType`: none, `opt` for
/// `Confident` of a decision outcome, or the fields of a variant.
enum Arm {
    None,
    Confident(Ty),
    Variant(Ty),
}

/// A pattern's kind.
fn kind(p: Option<Pattern<'_>>) -> Option<PatternKind> {
    p.and_then(|p| p.kind())
}

/// `bindPattern(p, subject, armType, into, cls)`: the names a pattern
/// binds, a tag's arguments to the arm's fields (and their own arguments
/// to nothing), each of the class of the switch's subject `of` and resting
/// on what it rests on. With `strict` (0.6), a name bound to a type with an
/// unknown in it (an argument the arm has no field for) is silent.
fn bind_pattern(
    p: Option<Pattern<'_>>,
    subject: &Ty,
    arm: &dyn Fn(&str) -> Vec<Ty>,
    into: &mut HashMap<String, Val>,
    of: &Val,
    strict: bool,
) {
    let Some(p) = p else { return };
    match p.kind() {
        Some(PatternKind::Bind) => {
            into.insert(
                p.name().unwrap_or_default().to_owned(),
                Val::like(subject.clone(), of),
            );
        }
        Some(PatternKind::Tag) => {
            let fields = arm(p.tag().unwrap_or_default());
            for (i, a) in p.args().iter().enumerate() {
                let t = fields.get(i).cloned().unwrap_or(UNKNOWN);
                let mut of_field = of.clone();
                of_field.silent = of.silent || (strict && has_unknown(&t));
                bind_pattern(Pattern::of(a), &t, &|_| Vec::new(), into, &of_field, strict);
            }
        }
        _ => {}
    }
}

/// Whether `t` is `human(message, role: r)`, whom an escalation asks.
fn is_person(t: Expr<'_>) -> bool {
    t.is(ExprOp::Call) && callee_is(t, "human")
}

/// Whether `ty` has an unknown anywhere in it.
pub(crate) fn has_unknown(ty: &Ty) -> bool {
    match ty {
        Ty::Unknown => true,
        Ty::Named(n) => n.args.iter().any(has_unknown),
        Ty::Record { fields } => fields.iter().any(|(_, f)| has_unknown(f)),
    }
}

/// 0.6: the fields of a variant of a standard union, as the runtime makes
/// them: `Ok(T)` of an `Outcome<T>` or a `Result<T>`, `Some(T)` of an
/// `Option<T>`, and a fault's payload, `Failed(…)` and `Err(…)`, untrusted.
fn std_variant_fields(inner: &Ty, tag: &str) -> Option<Vec<Ty>> {
    let fault = || vec![named("Untrusted", vec![UNKNOWN])];
    match (inner.name()?, tag) {
        ("Outcome" | "Result", "Ok") | ("Option", "Some") => Some(vec![inner.arg(0)]),
        ("Outcome", "Failed") | ("Result", "Err") => Some(fault()),
        _ => None,
    }
}

impl<'a> Checker<'a> {
    /// `typeClass(ty)`: the highest data class a type holds, through type
    /// definitions (each once), their arguments and record fields.
    pub(crate) fn type_class(&self, ty: &Ty) -> DataClass {
        self.type_class_seen(ty, &mut HashSet::new())
    }

    fn type_class_seen(&self, ty: &Ty, seen: &mut HashSet<String>) -> DataClass {
        let mut best = DataClass::Public;
        match ty {
            Ty::Named(n) => {
                let (name, args) = (&n.name, &n.args);
                if let Some(d) = self.def_of(name, DefKind::Type)
                    && !seen.contains(name)
                {
                    seen.insert(name.clone());
                    if let Some(c) = d
                        .value()
                        .get("class")
                        .and_then(Value::as_str)
                        .and_then(DataClass::from_name)
                    {
                        best = best.max(c);
                    }
                    let t = Self::def_type(d);
                    best = best.max(self.type_class_seen(&t, seen));
                }
                for a in args {
                    best = best.max(self.type_class_seen(a, seen));
                }
            }
            Ty::Record { fields } => {
                for (_, f) in fields {
                    best = best.max(self.type_class_seen(f, seen));
                }
            }
            Ty::Unknown => {}
        }
        best
    }

    /// `use(frame, u)`: the usage goes into the frame's shared list.
    pub(crate) fn use_effect(frame: &Frame<'a>, u: Usage) {
        frame.usages.borrow_mut().push(u);
    }

    /// `expr(e, frame, path)`: the value of `e`, its class raised to at
    /// least the class of its type.
    ///
    /// It is `exprInner` too: every form is a function of its own, called
    /// from here, so that each level of nesting costs as few and as small
    /// frames as it can (a debug build gives every local of a function a
    /// place in its frame).
    pub(crate) fn expr(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let v = self.expr_inner(e, frame, path);
        if self.report_floor.is_some() {
            return self.floored(v);
        }
        self.raised(v)
    }

    /// 0.7: [`Checker::raised`] of a value typed inside a report's field,
    /// whose level lowers the field's floor ([`Checker::report_floor`]).
    #[inline(never)]
    fn floored(&mut self, v: Val) -> Val {
        let v = self.raised(v);
        let l = self.level_of(&v);
        if let Some(f) = self.report_floor
            && crate::ty::level_rank(l) > crate::ty::level_rank(f)
        {
            self.report_floor = Some(l);
        }
        v
    }

    /// `{ ty: v.ty, cls: maxClass(v.cls, typeClass(v.ty)) }`.
    fn raised(&self, v: Val) -> Val {
        let cls = v.cls.max(self.type_class(&v.ty));
        Val { cls, ..v }
    }

    /// `exprInner(e, frame, path)`.
    #[inline(always)]
    fn expr_inner(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let Some(op) = e.op() else {
            return Val::unknown();
        };
        match op {
            ExprOp::Int
            | ExprOp::Dec
            | ExprOp::Text
            | ExprOp::Bool
            | ExprOp::Money
            | ExprOp::Duration => Self::literal(e, op),
            ExprOp::List | ExprOp::Set => self.list(e, op, frame, path),
            ExprOp::Template => self.template(e, frame, path),
            ExprOp::Prompt => self.prompt(e, frame, path),
            ExprOp::Var => self.var(e, frame),
            ExprOp::Field => self.field(e, frame, path),
            ExprOp::Call => self.call(e, frame, path),
            ExprOp::Unary => self.unary(e, frame, path),
            ExprOp::Binary => self.binary(e, frame, path),
            ExprOp::Range => self.range(e, frame, path),
            ExprOp::Record => self.record(e, frame, path),
            ExprOp::Infer => self.infer(e, frame, path),
            ExprOp::Delegate => self.delegate(e, frame, path),
            ExprOp::Plan => self.plan(e, frame, path),
            ExprOp::Map => self.map(e, frame, path),
            ExprOp::Spawn => self.spawn(e, frame, path),
            ExprOp::Await => self.await_expr(e, frame, path),
            ExprOp::Verify => self.verify(e, frame, path),
            ExprOp::Effect => self.effect_call(e, frame, path),
            ExprOp::Changeset => self.changeset(e, frame, path),
            ExprOp::Escalate => self.escalate(e, frame, path),
            ExprOp::Pause => self.pause(e, frame, path),
            ExprOp::Switch => self.switch_expr(e, frame, path),
            ExprOp::Try => self.try_expr(e, frame, path),
            ExprOp::Block => self.body(e.body(), frame, &sub(path, "body"), false),
        }
    }

    /// A literal: `int`, `dec`, `text` (with its value as `lit`), `bool`,
    /// `money`, `duration`.
    fn literal(e: Expr<'a>, op: ExprOp) -> Val {
        Val::public(match op {
            ExprOp::Int => named0("Int"),
            ExprOp::Dec => named0("Dec"),
            ExprOp::Text => Ty::named_lit("Text", Vec::new(), e.text().map(str::to_owned)),
            ExprOp::Bool => bool_ty(),
            ExprOp::Money => named0("Money"),
            _ => named0("Duration"),
        })
    }

    /// A `list` or `set`: the items' type is the first item's; among text
    /// literals, the first that is not a Path, so that none passes for one.
    #[inline(never)]
    fn list(&mut self, e: Expr<'a>, op: ExprOp, frame: &mut Frame<'a>, path: &str) -> Val {
        let mut items: Vec<Val> = Vec::new();
        for (i, x) in e.item_values().iter().enumerate() {
            let at = sub_i(path, "items", i, "");
            items.push(self.expr_or_unknown(Expr::of(x), frame, &at));
        }
        let mut v = Self::list_of(&items, op);
        // 0.7: a list is typed by its first item, and known no better than
        // its weakest (spec/attention.md "What is shown").
        if self.at_least(Language::V0_7) {
            v.made = items
                .iter()
                .fold(v.made, |l, x| weaker_level(l, self.level_of(x)));
        }
        v
    }

    fn list_of(items: &[Val], op: ExprOp) -> Val {
        let bad = items
            .iter()
            .find(|x| x.ty.lit().is_some_and(|l| path_problem(l).is_some()));
        let plain_text = items
            .iter()
            .find(|x| x.ty.is_named("Text") && x.ty.lit().is_none());
        let item = plain_text.or(bad).or(items.first());
        let ty = item.map_or(UNKNOWN, |x| x.ty.clone());
        let name = if op == ExprOp::List { "List" } else { "Set" };
        Val {
            ty: named(name, vec![ty]),
            cls: max_class(items.iter().map(|x| x.cls)),
            waivable: any_waivable(items),
            silent: any_silent(items),
            made: items
                .iter()
                .fold(Level::Verified, |l, x| weaker_level(l, x.made)),
        }
    }

    /// A `template`: text, of the highest class of its parts, and in 0.7
    /// known no better than the weakest of them.
    #[inline(never)]
    fn template(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let mut out = Val::new(text_ty(), DataClass::Public);
        let v0_7 = self.at_least(Language::V0_7);
        for (i, p) in e.parts().iter().enumerate() {
            if let Some(x) = p.get("expr").and_then(Expr::of) {
                let at = sub_i(path, "parts", i, "/expr");
                let v = self.expr(x, frame, &at);
                out.cls = out.cls.max(v.cls);
                out.waivable = out.waivable || v.waivable;
                out.silent = out.silent || v.silent;
                if v0_7 {
                    out.made = weaker_level(out.made, self.level_of(&v));
                }
            }
        }
        out
    }

    /// A `var`: a variable in scope, a constant, a capability, or unknown.
    /// In 0.6 a name the runtime gives as itself (a role, a component, an
    /// interface, an environment, a type, any other definition, a module)
    /// is public and silent, and a bare variant name is of the one local
    /// union or enum that has it, else silent; a name that names nothing is
    /// E0120's, and stays unknown.
    #[inline(never)]
    fn var(&mut self, e: Expr<'a>, frame: &Frame<'a>) -> Val {
        let name = e.name().unwrap_or_default();
        if let Some(v) = Self::lookup(name, &frame.scope) {
            return v;
        }
        match self.def(name).and_then(|d| d.kind()) {
            Some(DefKind::Const) => self.const_val(name),
            Some(DefKind::Capability) => Val::public(named0("Capability")),
            _ if !self.at_least(Language::V0_6) => Val::unknown(),
            Some(_) => self.null_val(),
            None if name.starts_with(|c: char| c.is_ascii_uppercase()) => {
                match self.union_of_tag(name) {
                    Some(t) => Val::public(named0(t)),
                    None => self.null_val(),
                }
            }
            None if self.is_module_root(e, frame) => self.null_val(),
            None => Val::unknown(),
        }
    }

    /// 0.6: the one type of the program that is a union or an enum with the
    /// variant `tag`, when exactly one is.
    fn union_of_tag(&self, tag: &str) -> Option<&'a str> {
        let defs: &'a mandate_ir::Map = self.defs;
        let mut found = defs.iter().filter(|(n, d)| {
            mandate_ir::Definition::of(d).kind() == Some(DefKind::Type)
                && self
                    .tags_of(&named0(n))
                    .is_some_and(|ts| ts.iter().any(|t| t == tag))
        });
        let first = found.next().map(|(n, _)| n);
        if found.next().is_some() {
            return None;
        }
        first
    }

    /// A `unary`: `not` is a Bool known as its operand is (a verified one
    /// becomes plain); any other operator gives its operand.
    ///
    /// A chain of them (`not not not x`) is walked down here, on a list of
    /// its own, rather than through `expr` once per level: what each level
    /// gives is what `expr` would give for it (the operand typed, then
    /// raised), and nothing is reported in between, so the result and the
    /// diagnostics are the same, and a chain costs the stack no frame per
    /// level.
    fn unary(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let mut chain: Vec<Expr<'a>> = vec![e];
        let mut at = sub(path, "of");
        let mut cur = e.operand();
        while let Some(x) = cur.filter(|x| x.is(ExprOp::Unary)) {
            chain.push(x);
            at = sub(&at, "of");
            cur = x.operand();
        }
        let mut v = self.expr_or_unknown(cur, frame, &at);
        while let Some(u) = chain.pop() {
            v = Self::unary_of(u, v);
            if !chain.is_empty() {
                v = self.raised(v);
            }
        }
        v
    }

    fn unary_of(e: Expr<'a>, v: Val) -> Val {
        if e.get("uop").and_then(Value::as_str) == Some("not") {
            let lvl = epistemic(&v.ty).level;
            return Val::like(with_level(bool_ty(), unverified(lvl), None), &v);
        }
        v
    }

    /// A `binary`: an arithmetic one has its left operand's inner type, any
    /// other is a Bool, known as the weaker operand is.
    ///
    /// A chain of them nested on the right (`1 + (1 + (1 + x))`) is walked
    /// down here, each left operand typed in turn, rather than through
    /// `expr` once per level; each level's value is what `expr` would give
    /// for it (raised), so the result and the order of the diagnostics are
    /// the same, and a chain costs the stack no frame per level.
    fn binary(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let mut spine: Vec<(Expr<'a>, Val)> = Vec::new();
        let mut cur = e;
        let mut at = path.to_owned();
        let mut r = loop {
            let l = self.operand(cur.left(), frame, &at, "left");
            let right_at = sub(&at, "right");
            spine.push((cur, l));
            match cur.right() {
                Some(x) if x.is(ExprOp::Binary) => {
                    cur = x;
                    at = right_at;
                }
                Some(x) => break self.expr(x, frame, &right_at),
                None => break Val::unknown(),
            }
        };
        while let Some((b, l)) = spine.pop() {
            r = Self::binary_of(b, &l, &r);
            if !spine.is_empty() {
                r = self.raised(r);
            }
        }
        r
    }

    /// `expr(e, frame, path/tail)`, an operand typed in a frame of its own.
    pub(crate) fn operand(
        &mut self,
        e: Option<Expr<'a>>,
        frame: &mut Frame<'a>,
        path: &str,
        tail: &str,
    ) -> Val {
        let at = sub(path, tail);
        self.expr_or_unknown(e, frame, &at)
    }

    fn binary_of(e: Expr<'a>, l: &Val, r: &Val) -> Val {
        let el = epistemic(&l.ty);
        let lvl = join_level(el.level, epistemic(&r.ty).level);
        let arith = matches!(
            e.get("bop").and_then(Value::as_str),
            Some("+" | "-" | "*" | "/")
        );
        let inner = if arith { el.inner } else { bool_ty() };
        Val {
            ty: with_level(inner, lvl, None),
            cls: l.cls.max(r.cls),
            waivable: l.waivable || r.waivable,
            silent: l.silent || r.silent,
            made: weaker_level(l.made, r.made),
        }
    }

    /// A `range`: both ends typed, the range unknown (in 0.6 made of its
    /// ends, its type silent).
    #[inline(never)]
    fn range(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let at = sub(path, "from");
        let from = self.expr_or_unknown(e.from(), frame, &at);
        let at = sub(path, "to");
        let to = self.expr_or_unknown(e.to(), frame, &at);
        if !self.at_least(Language::V0_6) {
            return Val::unknown();
        }
        let ends = Val {
            ty: UNKNOWN,
            cls: from.cls.max(to.cls),
            waivable: from.waivable || to.waivable,
            silent: from.silent || to.silent,
            made: weaker_level(from.made, to.made),
        };
        self.untyped(UNKNOWN, &ends)
    }

    /// A `plan`: the lead's skill typed and granted as a delegation of it
    /// is, and the class of what the lead receives kept in `leads`. A plan
    /// has no `caps`, `timeout` or `supervise`, so `delegate` reads it as
    /// `{ op: "delegate", agent, skill, args, budget? }`.
    fn plan(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let v = self.delegate(e, frame, path);
        match self.leads.iter_mut().find(|(p, _)| p == path) {
            Some(slot) => slot.1 = v.cls,
            None => self.leads.push((path.to_owned(), v.cls)),
        }
        v
    }

    /// A `spawn`, refused (E0711), its arguments typed.
    fn spawn(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let message = if self.at_least(Language::V0_4) {
            "There is no 'spawn'. An agent plans work while a run is going with 'plan Agent.skill(…) within envelope', in a workflow that has an envelope; use delegate, par or a bounded map for work known beforehand (spec/envelope.md \"plan\", V05)."
        } else {
            "Dynamic spawn is not available in 0.1; use delegate, par, or a bounded map (§9.1, V05)."
        };
        self.report("E0711", message, path, None);
        for (i, a) in e.arg_values().iter().enumerate() {
            let at = sub_i(path, "args", i, "/value");
            self.expr_or_unknown(a.get("value").and_then(Expr::of), frame, &at);
        }
        Val::unknown()
    }

    /// An `await`: its operand typed, the value unknown. In 0.6 refused
    /// (E0711): the runtime has no `await`, and no program waits on one.
    #[inline(never)]
    fn await_expr(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        if self.at_least(Language::V0_6) {
            self.report(
                "E0711",
                "There is no 'await': nothing is spawned to wait for. A workflow runs work with delegate, par or a bounded map, and an agent plans work while a run is going with 'plan Agent.skill(…) within envelope' (spec/envelope.md \"plan\").",
                path,
                None,
            );
        }
        let at = sub(path, "of");
        self.expr_or_unknown(e.operand(), frame, &at);
        Val::unknown()
    }

    /// An `escalate`: it waits for a person (E1708 in a map), and whom it
    /// asks is typed. In 0.6 the value is the person's answer, `Untrusted`
    /// and of nothing the checker knows, and of `human(message, role: r)`
    /// only the arguments are typed: the runtime asks the person, it calls
    /// nothing.
    #[inline(never)]
    fn escalate(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        self.person(frame, path, "escalate", None);
        let at = sub(path, "to");
        // 0.7: what the person is shown: the message of `human(message, …)`,
        // or what the escalation is to (`crate::asks`).
        match e
            .to()
            .filter(|t| self.at_least(Language::V0_6) && is_person(*t))
        {
            Some(to) => {
                self.role_not_bound(to.arg_values(), frame, &at, "escalate human(…)");
                let first = to.arg_values().iter().position(|a| a.get("name").is_none());
                self.asked_args(to, frame, &at, path, |i, _| Some(i) == first);
            }
            None => {
                self.asked_expr(e.to(), frame, &at, path);
            }
        }
        self.opaque(named("Untrusted", vec![UNKNOWN]))
    }

    /// A `pause`: with `then`, that typed; without, it waits for a person.
    /// In 0.6 `pause and x` is `x`, which the runtime gives, and `pause`
    /// alone a person's answer, as an escalation's.
    #[inline(never)]
    fn pause(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        match e.then() {
            Some(t) => {
                let at = sub(path, "then");
                let v = self.expr(t, frame, &at);
                if self.at_least(Language::V0_6) {
                    return v;
                }
            }
            None => {
                self.person(frame, path, "pause", None);
                // 0.7: a pause shows a person nothing of the run's values.
                if self.at_least(Language::V0_7) {
                    self.record_asked(path, &[]);
                }
            }
        }
        self.opaque(named("Untrusted", vec![UNKNOWN]))
    }

    /// A `try` (`x?`): the `T` of a `Result<T>`, known as `x` is (a verified
    /// one becomes plain). Of anything else, unknown; in 0.6 `x` itself,
    /// which the runtime gives back.
    #[inline(never)]
    fn try_expr(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let at = sub(path, "of");
        let v = self.expr_or_unknown(e.operand(), frame, &at);
        let ep = epistemic(&v.ty);
        if ep.inner.is_named("Result") {
            return Val::like(with_level(ep.inner.arg(0), unverified(ep.level), None), &v);
        }
        if self.at_least(Language::V0_6) {
            return v;
        }
        Val::like(with_level(UNKNOWN, unverified(ep.level), None), &v)
    }

    /// `prompt(e, frame, path)`: untrusted content and model output stand in
    /// a prompt's instructions only quoted (E0215).
    #[inline(never)]
    fn prompt(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let mut out = Val::new(named0("Prompt"), DataClass::Public);
        for (i, p) in e.parts().iter().enumerate() {
            if p.get("expr").is_none() {
                continue;
            }
            let Some(x) = p.get("expr").and_then(Expr::of) else {
                continue;
            };
            let pp = sub_i(path, "parts", i, "/expr");
            let v = self.expr(x, frame, &pp);
            out.cls = out.cls.max(v.cls);
            out.waivable = out.waivable || v.waivable;
            out.silent = out.silent || v.silent;
            self.prompt_part(x, &v, &pp);
        }
        out
    }

    /// E0215 for a part of a prompt's instructions that is untrusted or
    /// model output and not quoted.
    fn prompt_part(&mut self, x: Expr<'a>, v: &Val, pp: &str) {
        let is_quote = x.is(ExprOp::Call) && callee_is(x, "quote");
        let lvl = epistemic(&v.ty).level;
        if !is_quote && matches!(lvl, Level::Untrusted | Level::Inferred) {
            let what = if lvl == Level::Untrusted {
                "Untrusted content"
            } else {
                "Model output"
            };
            self.report(
                "E0215",
                format!(
                    "{what} cannot appear in the instruction part of a prompt; pass it as data with quote(…) (R5, §5.4)."
                ),
                pp,
                Some(JsObject::new().with("level", lvl.as_str())),
            );
        }
    }

    /// `field(e, frame, path)`: a member of a value (E0202), or nothing for
    /// a module's member such as `fs.read`.
    #[inline(never)]
    ///
    /// A chain of them (`c.a.a.a`) is walked down here, on a list of its
    /// own, rather than through `expr` once per level: each level's value is
    /// what `expr` would give for it (raised), and a level is a module's
    /// member, or not, as it would be found there, outer first, so the
    /// result and the order of the diagnostics are the same, and a chain
    /// costs the stack no frame per level.
    fn field(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        // Module members (fs.read, human.ask) are not values with fields;
        // in 0.6 such a member read as a value is silent.
        if self.is_module_member(e, frame) {
            return self.null_val();
        }
        let mut chain: Vec<(Expr<'a>, String)> = vec![(e, path.to_owned())];
        let mut at = sub(path, "of");
        let mut next = e.operand();
        let mut base = loop {
            match next {
                Some(x) if x.is(ExprOp::Field) => {
                    if self.is_module_member(x, frame) {
                        let member = self.null_val();
                        break self.raised(member);
                    }
                    chain.push((x, at.clone()));
                    at = sub(&at, "of");
                    next = x.operand();
                }
                other => break self.expr_or_unknown(other, frame, &at),
            }
        };
        while let Some((f, p)) = chain.pop() {
            base = self.field_of(f, base, &p);
            if !chain.is_empty() {
                base = self.raised(base);
            }
        }
        base
    }

    /// `calleePath(e) && isModuleRoot(e, frame)`.
    fn is_module_member(&self, e: Expr<'a>, frame: &Frame<'a>) -> bool {
        callee_path(e).is_some_and(|p| !p.is_empty()) && self.is_module_root(e, frame)
    }

    /// The member `e.name` of the value `base`.
    fn field_of(&mut self, e: Expr<'a>, base: Val, path: &str) -> Val {
        let ep = epistemic(&base.ty);
        let name = e.name().unwrap_or_default();
        // 0.6: the built-in `Review<T, C>` and `Declined<T>` have the fields
        // spec/library.md "human.review" gives them; only `accepted` is
        // what a waiver may rest on.
        let builtin = self.review_fields(&unalias(&ep.inner, self));
        let waivable = match &builtin {
            Some(b) => b.review && name == "accepted" && base.waivable,
            None => base.waivable,
        };
        let Some(fields) = builtin
            .map(|b| b.fields)
            .or_else(|| fields_of(&ep.inner, self))
        else {
            return self.field_unseen(&ep.inner, ep.level, name, &base);
        };
        match field(&fields, name) {
            None => {
                let shown = show(&ep.inner);
                let names: Vec<mandate_ir::JsValue> =
                    fields.iter().map(|(k, _)| k.as_str().into()).collect();
                self.report(
                    "E0202",
                    format!("{shown} has no field '{name}'."),
                    path,
                    Some(
                        JsObject::new()
                            .with("type", shown.as_str())
                            .with("fields", names),
                    ),
                );
                Val {
                    silent: false,
                    ..Val::like(UNKNOWN, &base)
                }
            }
            Some(f) => Val {
                ty: with_level(f.clone(), unverified(ep.level), None),
                cls: base.cls,
                waivable,
                silent: base.silent,
                made: base.made,
            },
        }
    }

    /// The member `name` of `base`, whose type (`inner`, known at `level`)
    /// shows the checker no fields: unknown, as before 0.6. In 0.6 a list's
    /// `length` is the `Int` the runtime gives, and any other member is of
    /// the value with its type silent, but a member of a value a diagnostic
    /// already stands for, which is that diagnostic's.
    #[inline(never)]
    fn field_unseen(&self, inner: &Ty, level: Level, name: &str, base: &Val) -> Val {
        let ty = with_level(UNKNOWN, unverified(level), None);
        if !self.at_least(Language::V0_6) {
            return Val::like(ty, base);
        }
        let list = unalias(inner, self);
        if name == "length" && (list.is_named("List") || list.is_named("Set")) {
            return Val::like(with_level(named0("Int"), unverified(level), None), base);
        }
        if matches!(inner, Ty::Unknown) && !base.silent {
            return Val::like(ty, base);
        }
        self.untyped(ty, base)
    }

    /// `isModuleRoot(e, frame)`: `e` is a module's member, a dotted path
    /// whose root is no variable or definition but an imported module.
    pub(crate) fn is_module_root(&self, e: Expr<'a>, frame: &Frame<'a>) -> bool {
        let mut cur = e;
        while cur.is(ExprOp::Field) {
            match cur.operand() {
                Some(of) => cur = of,
                None => return false,
            }
        }
        if !cur.is(ExprOp::Var) {
            return false;
        }
        let name = cur.name().unwrap_or_default();
        if Self::lookup(name, &frame.scope).is_some() {
            return false;
        }
        if self.def(name).is_some() {
            return false;
        }
        self.program.imports().any(|u| {
            u.names_given()
                .is_some_and(|ns| ns.iter().any(|n| n.as_str() == Some(name)))
                || u.module().unwrap_or_default().split('.').next_back() == Some(name)
        })
    }

    /// `call(e, frame, path)`: a function of the program, a std function,
    /// a decision policy, `peek` (W0207), `quote`, `len`, `data.read` or
    /// `cap.narrow(…)`.
    #[inline(never)]
    fn call(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        // 0.7: inside a report's field, what `len` counts does not lower the
        // field's floor: a count is the run's, however what it counts is
        // known (spec/attention.md "The invoice flow": `len(items)` is
        // counted by the run).
        let held = if self.report_floor.is_some()
            && e.callee()
                .is_some_and(|c| c.is(ExprOp::Var) && c.name() == Some("len"))
        {
            self.report_floor.take()
        } else {
            None
        };
        // 0.7: `human.ask` shows a person its question, its first argument
        // without a name; a function of the program is handed what its
        // sites show at least (`crate::asks`). A role a person is asked as
        // is no name the scope binds (E1501; a review's roles are held to
        // be role definitions by E1507 already, and in every language).
        let v0_7 = self.at_least(Language::V0_7);
        let callee = if v0_7 {
            e.callee().and_then(callee_path)
        } else {
            None
        };
        if let Some(p @ ("human.ask" | "human.approve")) = callee.as_deref() {
            self.role_not_bound(e.arg_values(), frame, path, p);
        }
        let function = callee
            .as_deref()
            .filter(|p| !p.contains('.') && self.def_of(p, DefKind::Fn).is_some())
            .map(str::to_owned);
        let args = if callee.as_deref() == Some("human.ask") {
            let first = e.arg_values().iter().position(|a| a.get("name").is_none());
            self.asked_args(e, frame, path, path, |i, _| Some(i) == first)
        } else if let Some(f) = function {
            self.handed_args(e, frame, path, &f)
        } else {
            self.call_args(e, frame, path)
        };
        if held.is_some() {
            self.report_floor = held;
        }
        self.call_with(e, frame, path, args)
    }

    /// The values of a call's arguments, typed in order.
    pub(crate) fn call_args(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Vec<Val> {
        let mut args: Vec<Val> = Vec::new();
        for (i, a) in e.arg_values().iter().enumerate() {
            let at = sub_i(path, "args", i, "/value");
            args.push(self.expr_or_unknown(a.get("value").and_then(Expr::of), frame, &at));
        }
        args
    }

    /// The call `e`, its arguments typed (`args`).
    fn call_with(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str, args: Vec<Val>) -> Val {
        // 0.6: `c.t(…)`, a tool of a connector, a member of its definition.
        if let Some(v) = self.tool_call(e, frame, path, &args) {
            return v;
        }
        let p = e.callee().and_then(callee_path);
        // What a call gives is made of its arguments: of their class, and
        // resting on what they rest on.
        let made = if self.at_least(Language::V0_7) {
            args.iter()
                .fold(Level::Verified, |l, a| weaker_level(l, self.level_of(a)))
        } else {
            Level::Verified
        };
        let of = Val {
            ty: UNKNOWN,
            cls: max_class(args.iter().map(|a| a.cls)),
            waivable: any_waivable(&args),
            silent: any_silent(&args),
            made,
        };
        let local = p
            .as_deref()
            .filter(|p| {
                !p.is_empty() && !p.contains('.') && Self::lookup(p, &frame.scope).is_none()
            })
            .and_then(|p| self.def(p));
        match (local.filter(|d| d.kind() == Some(DefKind::Fn)), p) {
            (Some(d), Some(p)) => self.call_fn(d, &p, frame, path, &args, &of),
            (_, p) => self.call_other(e, p.unwrap_or_default(), frame, path, &args, &of),
        }
    }

    /// A call of the program's function `p` (`d`): its arguments against
    /// its parameters (E0201 and the rest of `assignable`), what in it waits
    /// for a person in a map (E1708), and what it does, done here. Its
    /// value is of the class of its arguments (`of`), and rests on what
    /// they rest on and on a verification in the function a person may
    /// waive. In 0.7 it is also of the class of what the function returns,
    /// typed in its body (a read of classified data in it, `fn_result`),
    /// and known no better than that and its arguments: before 0.7 a
    /// function's result was of its arguments' class alone, which a value
    /// the function reads itself and returns could be above.
    fn call_fn(
        &mut self,
        d: mandate_ir::Definition<'a>,
        p: &str,
        frame: &mut Frame<'a>,
        path: &str,
        args: &[Val],
        of: &Val,
    ) -> Val {
        let cls = of.cls;
        self.call_fn_args(d, p, path, args);
        if frame.in_map.is_some() {
            self.fn_waits_in_map(p, frame, path);
        }
        // What the function does is done here, with what the call hands it:
        // a model call or a delegation in it may receive the arguments, so it
        // has at least their class.
        let usages = self.fn_usages(p);
        Self::call_usages(frame, usages, p, path, cls);
        let (cls, made) = if self.at_least(Language::V0_7) {
            // A function on a cycle (E0502) is typed while it is called:
            // its result is known as the weakest a value can be.
            let (c, l) = self
                .fn_result
                .get(p)
                .copied()
                .unwrap_or((DataClass::Public, Level::Untrusted));
            (cls.max(c), weaker_level(of.made, l))
        } else {
            (cls, of.made)
        };
        Val {
            ty: self.ty(d.returns()),
            cls,
            waivable: of.waivable || self.fn_waivable(p, &mut HashSet::new()),
            silent: of.silent,
            made,
        }
    }

    /// The arguments of a call of `p` against its parameters.
    fn call_fn_args(&mut self, d: mandate_ir::Definition<'a>, p: &str, path: &str, args: &[Val]) {
        let params = d.params();
        if args.len() != params.len() {
            self.report(
                "E0201",
                format!(
                    "{p} takes {} argument(s) but got {}.",
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
                self.expect_val(a, &t, &sub_i(path, "args", i, "/value"));
            }
        }
    }

    /// `fnWaits(p)` and, when the function holds something that waits for a
    /// person, E1708 at the call.
    fn fn_waits_in_map(&mut self, p: &str, frame: &Frame<'a>, path: &str) {
        if let Some(what) = self.fn_waits(p, &mut HashSet::new()) {
            self.person(frame, path, &what, Some(p));
        }
    }

    /// A function's usages, used at the call: `{ ...u, path, cls?, via? }`.
    fn call_usages(frame: &Frame<'a>, usages: Vec<Usage>, p: &str, path: &str, cls: DataClass) {
        for u in usages {
            let sends = u.effect == "Model" || u.effect == "Delegate";
            let mut u2 = u.clone();
            u2.path = path.to_owned();
            if sends {
                u2.cls = Some(cls.max(u.cls.unwrap_or(DataClass::Public)));
            }
            if u.effect == "Delegate" {
                u2.via = Some(u.via.clone().unwrap_or_else(|| p.to_owned()));
            }
            Self::use_effect(frame, u2);
        }
    }

    /// A call of anything but the program's own function: `quote`, `len`,
    /// `peek` (W0207), a decision policy, `data.read`, a std function,
    /// `cap.narrow(…)`, or something unknown; in 0.6 `human.review`. Its
    /// value is made of its arguments (`of`).
    fn call_other(
        &mut self,
        e: Expr<'a>,
        p: String,
        frame: &mut Frame<'a>,
        path: &str,
        args: &[Val],
        of: &Val,
    ) -> Val {
        match p.as_str() {
            "quote" => return Val::like(text_ty(), of),
            // A count is the run's own, however what it counts is known
            // (spec/attention.md "What is shown").
            "len" => {
                return Val {
                    made: Level::Verified,
                    ..Val::like(named0("Int"), of)
                };
            }
            "peek" => {
                self.report(
                    "W0207",
                    "peek(…) reads model output as a plain value; use it only for read-only, effect-free inspection (R7).",
                    path,
                    None,
                );
                let ty = args.first().map_or(UNKNOWN, |a| a.ty.clone());
                let inner = epistemic(&ty).inner;
                // 0.6: peek of what the checker cannot tell (a name that
                // names nothing, which no one reports in a call's arguments,
                // among them) is of a type it cannot tell either.
                if self.at_least(Language::V0_6) && matches!(inner, Ty::Unknown) {
                    return self.untyped(inner, of);
                }
                return Val::like(inner, of);
            }
            _ => {}
        }
        if !p.is_empty()
            && is_decision_policy(&p)
            && let Some(first) = args.first()
        {
            let ep = epistemic(&first.ty);
            if ep.inner.is_named("Decision") {
                return Val::like(named("DecisionOutcome", vec![ep.inner.arg(0)]), of);
            }
            // 0.6: what a policy decides of anything but a decision is of a
            // type the checker cannot tell.
            return self.untyped(named("DecisionOutcome", vec![UNKNOWN]), of);
        }
        let callee = e.callee();
        let module_root = |c: &Checker<'a>| callee.is_some_and(|x| c.is_module_root(x, frame));
        if p == "data.read" && module_root(self) {
            return self.data_read(e, frame, path);
        }
        // 0.6: one wait for a person about the outcomes of a verifying map.
        // Every call written `human.review(…)` is held to its rules, also
        // where a variable is named `human`, so that none is a review the
        // checks did not see.
        if p == "human.review" && self.at_least(Language::V0_6) {
            return self.human_review(e, frame, path, of);
        }
        if let Some(f) = std_fn(&p).filter(|_| !p.is_empty() && module_root(self)) {
            for eff in f.effects {
                Self::use_effect(frame, Usage::new(eff, path));
            }
            if p == "human.approve" {
                frame.approved = true;
                // An approval may wait at most `deadline`; past it the
                // approval is not given (§8.8, R15).
                let i = e
                    .arg_values()
                    .iter()
                    .position(|a| a.get("name").and_then(Value::as_str) == Some("deadline"));
                if let Some(i) = i
                    && let Some(a) = args.get(i)
                {
                    self.expect(
                        &a.ty,
                        &named0("Duration"),
                        &format!("{path}/args/{i}/value"),
                    );
                }
            }
            return Val::like(std_ty(&f.returns), of);
        }
        if let Some(c) = callee
            && c.is(ExprOp::Field)
            && c.name() == Some("narrow")
        {
            self.eval_cap(e, path, frame);
            return Val::like(named0("Capability"), of);
        }
        if self.at_least(Language::V0_6) {
            return self.not_callable(e, &p, frame, path, of);
        }
        Val::like(UNKNOWN, of)
    }

    /// 0.6: a call of nothing the runtime calls (it calls a function of the
    /// program, a standard function under its module's name, a connector's
    /// tool, a decision policy, `quote`, `len`, `peek` and `human.review`,
    /// and throws `unsupported_call` for anything else), E0120 at the call:
    /// `x.m()` of a value, `a.b.c()`, a standard function whose module's
    /// name a variable of the body takes (`let human = …; human.ask(…)`,
    /// which the runtime would still dispatch by its path), another kind of
    /// definition (a workflow, an extern, an agent). Not refused, and of a
    /// silent type: a criterion's own method (`by review(…)`, `by eval(…)`),
    /// which the runtime runs as a criterion; a constant's call, which it
    /// keeps as a descriptor; a supervision strategy after `on error`. A
    /// callee that names nothing is the name resolution's E0120.
    fn not_callable(
        &mut self,
        e: Expr<'a>,
        p: &str,
        frame: &Frame<'a>,
        path: &str,
        of: &Val,
    ) -> Val {
        let method = frame.where_ == Where::Contract && path.ends_with("/call");
        let strategy = SUPERVISION_STRATEGIES.contains(&p) && path.ends_with("/then");
        if frame.where_ == Where::Const || method || strategy {
            return self.untyped(UNKNOWN, of);
        }
        let callee = e.callee();
        let unresolved = callee.is_some_and(|c| {
            c.is(ExprOp::Var)
                && Self::lookup(c.name().unwrap_or_default(), &frame.scope).is_none()
                && self.def(c.name().unwrap_or_default()).is_none()
        });
        if unresolved {
            return Val::unknown();
        }
        let root = p.split('.').next().unwrap_or_default();
        let message = if std_fn(p).is_some() && Self::lookup(root, &frame.scope).is_some() {
            format!(
                "'{p}' is not the standard function here: '{root}' is a variable of this body, so the call names nothing the program can call, though the runtime would call {p} by its path and type nothing of what it gives. Give the variable another name."
            )
        } else if p.is_empty() {
            "This call names nothing the program can call: a call is of a function of the program, a standard function under its module's name, a connector's tool, a decision policy, quote, len, peek or human.review (the runtime calls nothing else).".to_owned()
        } else {
            let what = callee
                .filter(|c| c.is(ExprOp::Var))
                .and_then(|c| self.def(c.name().unwrap_or_default()))
                .and_then(|d| d.kind())
                .map_or_else(String::new, |k| {
                    let kind = k.as_str();
                    let article = if kind.starts_with(['a', 'e', 'i', 'o', 'u']) {
                        "an"
                    } else {
                        "a"
                    };
                    format!(" is {article} {kind} and")
                });
            format!(
                "'{p}'{what} is nothing the program can call: a call is of a function of the program, a standard function under its module's name, a connector's tool, a decision policy, quote, len, peek or human.review (the runtime calls nothing else)."
            )
        };
        self.report(
            "E0120",
            message,
            &sub(path, "callee"),
            Some(JsObject::new().with("name", p).with("expected", "function")),
        );
        Val::unknown()
    }

    /// `record(e, frame, path)`: a record of a local type, field by field
    /// (E0202, E0203), never of a protected type (E0213).
    #[inline(never)]
    fn record(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let fields = self.record_fields(e, path);
        let mut acc = Val::unknown();
        let mut level = Level::Plain;
        for (fname, fe) in e.fields() {
            let at = sub(&sub(path, "fields"), fname);
            let v = self.expr_or_unknown(Expr::of(fe), frame, &at);
            level = self.record_field(e, fields.as_deref(), fname, v, &at, level, &mut acc);
        }
        self.record_end(e, fields.as_deref(), path, level, &acc)
    }

    /// The fields of a record's type (E0213 for a protected type first).
    fn record_fields(&mut self, e: Expr<'a>, path: &str) -> Option<Vec<(String, Ty)>> {
        let type_name = e.record_type().unwrap_or_default();
        // 0.6: so are a review and a declined item, `Review` and `Declined`.
        if is_protected_type(type_name) || self.makes_a_review(type_name) {
            self.report(
                "E0213",
                format!(
                    "{type_name} cannot be constructed by a program; only the runtime produces it (§5.2, S08)."
                ),
                &sub(path, "type"),
                None,
            );
        }
        fields_of(&named0(type_name), self)
    }

    /// One field of a record, its value typed (`v`): its class, its waivers
    /// and level into the record's, and it against the type's field (E0202, and the
    /// rest of `assignable` at the field's own level, R6). The record's
    /// level so far.
    #[allow(clippy::too_many_arguments)]
    fn record_field(
        &mut self,
        e: Expr<'a>,
        fields: Option<&[(String, Ty)]>,
        fname: &str,
        v: Val,
        at: &str,
        level: Level,
        acc: &mut Val,
    ) -> Level {
        acc.cls = acc.cls.max(v.cls);
        acc.waivable = acc.waivable || v.waivable;
        acc.silent = acc.silent || v.silent;
        if self.at_least(Language::V0_7) {
            acc.made = weaker_level(acc.made, self.level_of(&v));
        }
        let ep = epistemic(&v.ty);
        let level = join_level(level, ep.level);
        if let Some(fields) = fields {
            match field(fields, fname) {
                None => {
                    let names: Vec<mandate_ir::JsValue> =
                        fields.iter().map(|(k, _)| k.as_str().into()).collect();
                    let type_name = e.record_type().unwrap_or_default();
                    self.report(
                        "E0202",
                        format!("{type_name} has no field '{fname}'."),
                        at,
                        Some(JsObject::new().with("fields", names)),
                    );
                }
                Some(ft) => {
                    let ft = ft.clone();
                    let field_level = epistemic(&ft).level;
                    // 0.6: a field declared Verified holds the value it is
                    // given, as the runtime's record does: only a verified
                    // one, else the record would make it one when read.
                    let actual = if field_level == Level::Verified && self.at_least(Language::V0_6)
                    {
                        v.ty.clone()
                    } else {
                        with_level(ep.inner, field_level, None)
                    };
                    let p = assignable(&actual, &ft, self);
                    if p.is_some() {
                        self.problem(p, at);
                    } else {
                        self.silent_where_verified(&v, &ft, at);
                    }
                }
            }
        }
        level
    }

    /// The fields a record leaves out (E0203), and its value, made of its
    /// fields (`made`).
    fn record_end(
        &mut self,
        e: Expr<'a>,
        fields: Option<&[(String, Ty)]>,
        path: &str,
        level: Level,
        made: &Val,
    ) -> Val {
        let type_name = e.record_type().unwrap_or_default();
        if let Some(fields) = fields {
            let missing: Vec<&str> = fields
                .iter()
                .map(|(k, _)| k.as_str())
                .filter(|k| !e.fields().any(|(g, _)| g == *k))
                .collect();
            if !missing.is_empty() {
                self.report(
                    "E0203",
                    format!("{type_name} is missing field(s) {}.", missing.join(", ")),
                    path,
                    Some(
                        JsObject::new().with(
                            "missing",
                            missing
                                .iter()
                                .map(|m| mandate_ir::JsValue::from(*m))
                                .collect::<Vec<_>>(),
                        ),
                    ),
                );
            }
        }
        Val::like(with_level(named0(type_name), level, None), made)
    }

    /// `infer(e, frame, path)`: model output (`Inferred<T>`), never a
    /// protected type (E0213); a `Choice` is a `Decision` (E0233, W0232).
    fn infer(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let from = self.operand(e.from(), frame, path, "from");
        if let Some(u) = e.using() {
            self.operand(Some(u), frame, path, "using");
        }
        self.infer_of(e, frame, path, &from)
    }

    /// An `infer`, what it reads typed (`from`).
    fn infer_of(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str, from: &Val) -> Val {
        let mut target = self.ty(e.type_expr());
        if let Some(prot) =
            mentions(&target, &PROTECTED_TYPES).or_else(|| self.review_type_in(&target))
        {
            self.report(
                "E0213",
                format!(
                    "A model cannot produce {prot}; infer only yields Inferred values (§5.2, S08)."
                ),
                &format!("{path}/type"),
                Some(JsObject::new().with("type", prot)),
            );
        }
        if target.is_named("Choice") {
            let opt = target.arg(0);
            self.choice_options(&opt, &format!("{path}/type"));
            target = named("Decision", vec![opt]);
        }
        // In a sub-program the question is the lead's writing, whatever it
        // is asked about.
        let cls = from.cls.max(self.floor);
        let mut u = Usage::new("Model", path);
        u.cls = Some(cls);
        Self::use_effect(frame, u);
        // A model's answer rests on no verification, so on no waiver.
        Val::new(named("Inferred", vec![target]), cls)
    }

    /// `choiceOptions(opt, path)`.
    fn choice_options(&mut self, opt: &Ty, path: &str) {
        let Some(tags) = self.tags_of(opt) else {
            return;
        };
        if tags.len() > MAX_CHOICE_OPTIONS {
            self.report(
                "E0233",
                format!(
                    "A Choice may have at most {MAX_CHOICE_OPTIONS} options; {} has {}.",
                    show(opt),
                    tags.len()
                ),
                path,
                None,
            );
        }
        if !tags.iter().any(|t| is_out_of_scope_option(t)) {
            self.report(
                "W0232",
                format!(
                    "{} has no out-of-scope option (Other, Irrelevant, OutOfScope); the model will force every input into a listed option (D8).",
                    show(opt)
                ),
                path,
                None,
            );
        }
    }

    /// The variant names of a local union or enum type: `tagsOf(ty)`.
    pub(crate) fn tags_of(&self, ty: &Ty) -> Option<Vec<String>> {
        let u = unalias(ty, self);
        let te = self.peeled(u.name()?)?;
        if te.has(mandate_ir::TypeForm::Union) {
            return Some(
                te.union()
                    .iter()
                    .map(|v| {
                        v.get("tag")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned()
                    })
                    .collect(),
            );
        }
        if te.has(mandate_ir::TypeForm::Enum) {
            return Some(te.enum_tags().map(str::to_owned).collect());
        }
        None
    }

    /// The field types of variant `tag` of a local union: `variantFields(ty, tag)`.
    fn variant_fields(&self, ty: &Ty, tag: &str) -> Vec<Ty> {
        let u = unalias(ty, self);
        let Some(te) = u.name().and_then(|n| self.peeled(n)) else {
            return Vec::new();
        };
        if !te.has(mandate_ir::TypeForm::Union) {
            return Vec::new();
        }
        te.union()
            .iter()
            .find(|v| v.get("tag").and_then(Value::as_str) == Some(tag))
            .map(|v| {
                v.get("fields")
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .map(|f| self.ty(f.get("type").and_then(mandate_ir::TypeExpr::of)))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `verify(e, frame, path)`: `Verified<T, C>` of a value checked against
    /// contract `C`.
    #[inline(never)]
    fn verify(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let v = self.operand(e.value_expr(), frame, path, "value");
        // 0.7: a person who approves a criterion is shown the contract's
        // arguments, which the contract's own sites are handed too
        // (`crate::asks`).
        let args = self.asked_args(e, frame, path, path, |_, _| true);
        if self.at_least(Language::V0_7) {
            self.handed_verify(frame, path, e.contract().unwrap_or_default());
        }
        self.verify_args(e, frame, path, &args);
        let handler = e
            .on_unmet()
            .map(|u| (u.then(), self.verify_unmet(u, frame, path)));
        let contract = e.contract().unwrap_or_default();
        let ep = epistemic(&v.ty);
        // 0.6: what was verified, for a review of a map that ends here.
        if self.at_least(Language::V0_6) {
            self.verified
                .insert(path.to_owned(), (ep.inner.clone(), ep.level));
        }
        // The value rests on this verification alone: on a waiver when its
        // contract has one (0.6), and on nothing it rested on before.
        let verified = Val {
            ty: with_level(ep.inner, Level::Verified, Some(contract)),
            cls: v.cls,
            waivable: self.waivable_contract(contract),
            silent: v.silent,
            made: Level::Verified,
        };
        // 0.6: the value is the verified one or, when the contract is not
        // met, the handler's (but for the one exception).
        match handler {
            Some((then, h)) if self.at_least(Language::V0_6) && !unmet_keeps_verified(then) => {
                self.join(&verified, &h)
            }
            _ => verified,
        }
    }

    /// `on unmet(bind) => then`, typed with `bind` a `List<Text>`; the
    /// handler's value.
    fn verify_unmet(&mut self, u: mandate_ir::OnUnmet<'a>, frame: &Frame<'a>, path: &str) -> Val {
        let mut vars = HashMap::new();
        vars.insert(
            u.bind().unwrap_or_default().to_owned(),
            Val::public(named("List", vec![text_ty()])),
        );
        let mut inner = Self::child_box(frame, vars);
        let at = sub(path, "on_unmet/then");
        self.expr_or_unknown(u.then(), &mut inner, &at)
    }

    /// A `verify`'s arguments against its contract's parameters (E0201 and
    /// the rest of `assignable`), and E1708 for a contract a person approves.
    fn verify_args(&mut self, e: Expr<'a>, frame: &Frame<'a>, path: &str, args: &[Val]) {
        let contract = e.contract().unwrap_or_default();
        if let Some(c) = self.def_of(contract, DefKind::Contract) {
            let params = c.params();
            if args.len() != params.len() {
                self.report(
                    "E0201",
                    format!(
                        "Contract {contract} takes {} argument(s) but got {}.",
                        params.len(),
                        args.len()
                    ),
                    path,
                    None,
                );
            }
            for (i, param) in params.iter().enumerate() {
                if let Some(a) = args.get(i) {
                    // The subject of a contract may be unverified; that is
                    // what verify is for.
                    let actual = with_level(epistemic(&a.ty).inner, Level::Plain, None);
                    let t = self.ty(param.get("type").and_then(mandate_ir::TypeExpr::of));
                    self.expect(&actual, &t, &format!("{path}/args/{i}/value"));
                }
            }
        }
        if self.asks_approval(contract) {
            self.person(frame, path, &format!("verify against {contract}"), None);
        }
    }

    /// `switchExpr(e, frame, path)`: model output does not steer control
    /// flow unverified (E0210, E0231), and every variant is handled (E0230).
    #[inline(never)]
    fn switch_expr(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let subj = self.operand(e.on(), frame, path, "on");
        let arm = self.switch_checks(e, &subj, path);
        let mut result: Option<Val> = None;
        // 0.6: the runtime gives the arm that matches, any of them: the
        // switch's value is their join. Before, the first arm's.
        let joins = self.at_least(Language::V0_6);
        for (i, c) in e.cases().enumerate() {
            let binds = self.switch_binds(c, &subj, &arm);
            let v = self.switch_case(c, frame, binds, path, i);
            result = match result {
                None => Some(v),
                Some(r) if joins => Some(self.join(&r, &v)),
                keep => keep,
            };
        }
        result.unwrap_or_else(|| self.untyped(UNKNOWN, &subj))
    }

    /// What a switch is on, against how it is known and its cases (E0231,
    /// E0210, E0230); the types its arms bind.
    fn switch_checks(&mut self, e: Expr<'a>, subj: &Val, path: &str) -> Arm {
        let ep = epistemic(&subj.ty);
        let cases: Vec<mandate_ir::SwitchCase<'a>> = e.cases().collect();
        let is_tag = |c: &mandate_ir::SwitchCase<'a>, tag: &str| {
            c.pattern()
                .is_some_and(|p| p.kind() == Some(PatternKind::Tag) && p.tag() == Some(tag))
        };
        let catch_all = cases.iter().any(|c| {
            matches!(
                kind(c.pattern()),
                Some(PatternKind::Wild | PatternKind::Bind)
            )
        });
        let mut arm = Arm::None;
        if ep.inner.is_named("Decision") {
            self.report(
                "E0231",
                "Switch on a Decision only after a decision policy (threshold, top_margin, abstain_if) turns it into Confident(…) | Uncertain (D2).",
                &format!("{path}/on"),
                None,
            );
        } else if matches!(ep.level, Level::Inferred | Level::Untrusted) {
            self.report(
                "E0210",
                format!(
                    "Model output of type {} cannot steer control flow unverified; verify it or use a decision policy (R1, D1).",
                    show(&subj.ty)
                ),
                &format!("{path}/on"),
                None,
            );
        } else if ep.inner.is_named("DecisionOutcome") {
            let opt = ep.inner.arg(0);
            if !cases.iter().any(|c| is_tag(c, "Uncertain")) && !catch_all {
                self.report(
                    "E0230",
                    "A switch on a decision outcome must handle Uncertain (D2).",
                    path,
                    Some(
                        JsObject::new()
                            .with("missing", vec![mandate_ir::JsValue::from("Uncertain")]),
                    ),
                );
            }
            let confident: Vec<&mandate_ir::SwitchCase<'a>> =
                cases.iter().filter(|c| is_tag(c, "Confident")).collect();
            let first_arg = |c: &mandate_ir::SwitchCase<'a>| {
                c.pattern()
                    .and_then(|p| p.args().first())
                    .and_then(Pattern::of)
            };
            let whole = confident.iter().any(|c| {
                c.pattern().is_some_and(|p| p.args().is_empty())
                    || kind(first_arg(c)) != Some(PatternKind::Tag)
            });
            let tags = self.tags_of(&opt);
            if let Some(tags) = tags.filter(|_| !catch_all && !whole) {
                let covered: Vec<&str> = confident
                    .iter()
                    .map(|c| match first_arg(c) {
                        Some(a) if a.kind() == Some(PatternKind::Tag) => {
                            a.tag().unwrap_or_default()
                        }
                        _ => "",
                    })
                    .collect();
                let missing: Vec<String> = tags
                    .iter()
                    .filter(|t| !covered.contains(&t.as_str()))
                    .map(|t| format!("Confident({t})"))
                    .collect();
                if !missing.is_empty() {
                    self.report(
                        "E0230",
                        format!("Switch does not handle {}.", missing.join(", ")),
                        path,
                        Some(
                            JsObject::new().with(
                                "missing",
                                missing
                                    .iter()
                                    .map(|m| mandate_ir::JsValue::from(m.as_str()))
                                    .collect::<Vec<_>>(),
                            ),
                        ),
                    );
                }
            }
            arm = Arm::Confident(opt);
        } else {
            if let Some(tags) = self.tags_of(&ep.inner).filter(|_| !catch_all) {
                let covered: Vec<&str> = cases
                    .iter()
                    .map(|c| match c.pattern() {
                        Some(p) if p.kind() == Some(PatternKind::Tag) => {
                            p.tag().unwrap_or_default()
                        }
                        _ => "",
                    })
                    .collect();
                let missing: Vec<&str> = tags
                    .iter()
                    .map(String::as_str)
                    .filter(|t| !covered.contains(t))
                    .collect();
                if !missing.is_empty() {
                    self.report(
                        "E0230",
                        format!("Switch does not handle {}.", missing.join(", ")),
                        path,
                        Some(
                            JsObject::new().with(
                                "missing",
                                missing
                                    .iter()
                                    .map(|m| mandate_ir::JsValue::from(*m))
                                    .collect::<Vec<_>>(),
                            ),
                        ),
                    );
                }
            }
            arm = Arm::Variant(ep.inner.clone());
        }
        arm
    }

    /// The names a case's pattern binds, of the arm's types.
    fn switch_binds(
        &self,
        c: mandate_ir::SwitchCase<'a>,
        subj: &Val,
        arm: &Arm,
    ) -> HashMap<String, Val> {
        let mut binds = HashMap::new();
        let strict = self.at_least(Language::V0_6);
        match arm {
            Arm::None => bind_pattern(
                c.pattern(),
                &subj.ty,
                &|_| Vec::new(),
                &mut binds,
                subj,
                strict,
            ),
            Arm::Confident(opt) => bind_pattern(
                c.pattern(),
                &subj.ty,
                &|tag| {
                    if tag == "Confident" {
                        vec![opt.clone()]
                    } else {
                        Vec::new()
                    }
                },
                &mut binds,
                subj,
                strict,
            ),
            Arm::Variant(inner) => bind_pattern(
                c.pattern(),
                &subj.ty,
                &|tag| {
                    let local = self.variant_fields(inner, tag);
                    if strict && local.is_empty() {
                        return std_variant_fields(inner, tag).unwrap_or_default();
                    }
                    local
                },
                &mut binds,
                subj,
                strict,
            ),
        }
        binds
    }

    /// One case's `then`, typed with what its pattern binds.
    fn switch_case(
        &mut self,
        c: mandate_ir::SwitchCase<'a>,
        frame: &Frame<'a>,
        binds: HashMap<String, Val>,
        path: &str,
        i: usize,
    ) -> Val {
        let mut inner = Self::child_box(frame, binds);
        let at = sub_i(path, "cases", i, "/then");
        self.expr_or_unknown(c.then(), &mut inner, &at)
    }

    // ── the leaves the other parts call too ────────────────────────────

    /// `person(frame, path, what, via)`: a step that waits for a person
    /// inside a map's body (E1708); outside a map, nothing.
    pub(crate) fn person(&mut self, frame: &Frame<'a>, path: &str, what: &str, via: Option<&str>) {
        let Some(map) = frame.in_map.clone() else {
            return;
        };
        let via = via.filter(|v| !v.is_empty());
        let who = match via {
            Some(v) => format!("{v} holds '{what}', which"),
            None => format!("'{what}'"),
        };
        self.report(
            "E1708",
            format!(
                "{who} waits for a person inside a map's body, once for each item. Ask once about the list, after the map (spec/envelope.md \"map\")."
            ),
            path,
            Some(
                JsObject::new()
                    .with("map", map.as_str())
                    .with("kind", "person")
                    .with("what", what)
                    .with_some("via", via),
            ),
        );
    }

    /// `critical(frame, path, what, name)`: a critical effect inside a map's
    /// body (E1708). The callers test `frame.inMap` first.
    pub(crate) fn critical(&mut self, frame: &Frame<'a>, path: &str, what: &str, name: &str) {
        self.report(
            "E1708",
            format!(
                "{what} inside a map's body, where each item's would be authorized on its own. Run it after the map, or land a batch with a change set (spec/envelope.md \"map\")."
            ),
            path,
            Some(
                JsObject::new()
                    .with("map", frame.in_map.as_deref())
                    .with("kind", "critical_effect")
                    .with("what", name),
            ),
        );
    }

    /// `waits(e)`: what in `e` itself waits for a person without being a
    /// `human.*` call.
    pub(crate) fn waits(&self, e: Expr<'_>) -> Option<String> {
        match e.op() {
            Some(ExprOp::Escalate) => Some("escalate".to_owned()),
            Some(ExprOp::Pause) if e.then().is_none() => Some("pause".to_owned()),
            Some(ExprOp::Delegate) if e.supervise().and_then(|s| s.name()) == Some("escalate") => {
                Some("supervise escalate".to_owned())
            }
            Some(ExprOp::Verify) => {
                let c = e.contract().unwrap_or_default();
                self.asks_approval(c).then(|| format!("verify against {c}"))
            }
            _ => None,
        }
    }

    /// Whether a verifier, or one of `all` in it, is `human.approve(…)`:
    /// `hasHuman(v)`.
    fn has_human(v: &Value) -> bool {
        if v.get(VerifierForm::All.as_str()).is_some() {
            return v
                .get("all")
                .and_then(Value::as_array)
                .unwrap_or_default()
                .iter()
                .any(Self::has_human);
        }
        v.get(VerifierForm::Call.as_str()).is_some()
            && v.get("call")
                .and_then(Expr::of)
                .is_some_and(|c| c.is(ExprOp::Call) && callee_is(c, "human.approve"))
    }

    /// Whether a contract `accept`s anything only a person's approval
    /// gives: `Object.values(c.accept).some((cr) => hasHuman(cr.by))`.
    fn accepts_by_human(&self, contract: &str) -> bool {
        let Some(c) = self.def_of(contract, DefKind::Contract) else {
            return false;
        };
        c.accept()
            .any(|(_, cr)| cr.get("by").is_some_and(Self::has_human))
    }

    /// `asksApproval(contract)`: a contract with a criterion that a person
    /// approves.
    pub(crate) fn asks_approval(&self, contract: &str) -> bool {
        self.accepts_by_human(contract)
    }

    /// `approvedByHuman(ty)`: a value verified against a contract that a
    /// person approves.
    pub(crate) fn approved_by_human(&self, ty: &Ty) -> bool {
        let ep = epistemic(ty);
        match (ep.level, ep.contract.as_deref()) {
            (Level::Verified, Some(c)) if !c.is_empty() => self.accepts_by_human(c),
            _ => false,
        }
    }

    /// `fnWaits(name, seen)`: what a function holds that waits for a
    /// person, in its body or in a function it calls (each once).
    pub(crate) fn fn_waits(&self, name: &str, seen: &mut HashSet<String>) -> Option<String> {
        let f = self.def_of(name, DefKind::Fn)?;
        if seen.contains(name) {
            return None;
        }
        seen.insert(name.to_owned());
        let mut found: Option<String> = None;
        walk_exprs(f.body(), &mut |x| {
            if found.is_none() {
                found = self.waits(x);
            }
            if found.is_none()
                && x.is(ExprOp::Call)
                && let Some(callee) = x.callee().filter(|c| c.is(ExprOp::Var))
            {
                found = self.fn_waits(callee.name().unwrap_or_default(), seen);
            }
        });
        found
    }

    /// `fromTypeExpr` of a type expression value: the `type` of a parameter.
    pub(crate) fn param_type(&self, param: &Value) -> Ty {
        param
            .get("type")
            .and_then(mandate_ir::TypeExpr::of)
            .map_or(UNKNOWN, |t| from_type_expr(t, &[]))
    }
}
