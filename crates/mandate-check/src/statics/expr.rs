//! The typer of expressions, slice R11: `expectBool`, `typeClass`, `use`,
//! `expr`, `exprInner` and the forms it calls (`prompt`, `field`, `call`,
//! `record`, `infer`, `verify`, `switchExpr`), and the leaves the other
//! slices call too (`person`, `critical`, `waits`, `asksApproval`,
//! `fnWaits`, `approvedByHuman`, `isModuleRoot`, `tagsOf`,
//! `variantFields`). `exprInner` calls the authority slice's `delegate`,
//! `map` and `effectCall`, the system slice's `changeset` and `dataRead`,
//! and the authority's `evalCap` for `cap.narrow(…)`.

use std::collections::{HashMap, HashSet};

use mandate_ir::{
    DefKind, Expr, ExprOp, JsObject, Language, Pattern, PatternKind, Value, VerifierForm,
};

use super::{Checker, Frame, Usage, Val, callee_is, max_class, sub, sub_i};
use crate::caps::callee_path;
use crate::path::path_problem;
use crate::stdlib::{
    DataClass, MAX_CHOICE_OPTIONS, PROTECTED_TYPES, StdType, is_decision_policy,
    is_out_of_scope_option, is_protected_type, std_fn,
};
use crate::ty::{
    Level, Ty, UNKNOWN, bool_ty, epistemic, field, fields_of, from_type_expr, join_level, mentions,
    named, named0, show, text_ty, unalias, with_level,
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
/// to nothing).
fn bind_pattern(
    p: Option<Pattern<'_>>,
    subject: &Ty,
    arm: &dyn Fn(&str) -> Vec<Ty>,
    into: &mut HashMap<String, Val>,
    cls: DataClass,
) {
    let Some(p) = p else { return };
    match p.kind() {
        Some(PatternKind::Bind) => {
            into.insert(
                p.name().unwrap_or_default().to_owned(),
                Val {
                    ty: subject.clone(),
                    cls,
                },
            );
        }
        Some(PatternKind::Tag) => {
            let fields = arm(p.tag().unwrap_or_default());
            for (i, a) in p.args().iter().enumerate() {
                let t = fields.get(i).cloned().unwrap_or(UNKNOWN);
                bind_pattern(Pattern::of(a), &t, &|_| Vec::new(), into, cls);
            }
        }
        _ => {}
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
        self.raised(v)
    }

    /// `{ ty: v.ty, cls: maxClass(v.cls, typeClass(v.ty)) }`.
    fn raised(&self, v: Val) -> Val {
        let cls = v.cls.max(self.type_class(&v.ty));
        Val { ty: v.ty, cls }
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
    fn list(&mut self, e: Expr<'a>, op: ExprOp, frame: &mut Frame<'a>, path: &str) -> Val {
        let mut items: Vec<Val> = Vec::new();
        for (i, x) in e.item_values().iter().enumerate() {
            let at = sub_i(path, "items", i, "");
            items.push(self.expr_or_unknown(Expr::of(x), frame, &at));
        }
        Self::list_of(&items, op)
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
        }
    }

    /// A `template`: text, of the highest class of its parts.
    fn template(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let mut cls = DataClass::Public;
        for (i, p) in e.parts().iter().enumerate() {
            if let Some(x) = p.get("expr").and_then(Expr::of) {
                let at = sub_i(path, "parts", i, "/expr");
                let v = self.expr(x, frame, &at);
                cls = cls.max(v.cls);
            }
        }
        Val { ty: text_ty(), cls }
    }

    /// A `var`: a variable in scope, a constant, a capability, or unknown.
    fn var(&mut self, e: Expr<'a>, frame: &Frame<'a>) -> Val {
        let name = e.name().unwrap_or_default();
        if let Some(v) = Self::lookup(name, &frame.scope) {
            return v;
        }
        match self.def(name).and_then(|d| d.kind()) {
            Some(DefKind::Const) => self.const_val(name),
            Some(DefKind::Capability) => Val::public(named0("Capability")),
            _ => Val::unknown(),
        }
    }

    /// A `unary`: `not` is a Bool known as its operand is (a verified one
    /// becomes plain); any other operator gives its operand.
    fn unary(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let at = sub(path, "of");
        let v = self.expr_or_unknown(e.operand(), frame, &at);
        Self::unary_of(e, v)
    }

    fn unary_of(e: Expr<'a>, v: Val) -> Val {
        if e.get("uop").and_then(Value::as_str) == Some("not") {
            let lvl = epistemic(&v.ty).level;
            return Val {
                ty: with_level(bool_ty(), unverified(lvl), None),
                cls: v.cls,
            };
        }
        v
    }

    /// A `binary`: an arithmetic one has its left operand's inner type, any
    /// other is a Bool, known as the weaker operand is.
    fn binary(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let l = self.operand(e.left(), frame, path, "left");
        let at = sub(path, "right");
        let r = match e.right() {
            Some(x) => self.expr(x, frame, &at),
            None => Val::unknown(),
        };
        Self::binary_of(e, &l, &r)
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
        }
    }

    /// A `range`: both ends typed, the range unknown.
    fn range(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let at = sub(path, "from");
        self.expr_or_unknown(e.from(), frame, &at);
        let at = sub(path, "to");
        self.expr_or_unknown(e.to(), frame, &at);
        Val::unknown()
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

    /// An `await`: its operand typed, the value unknown.
    fn await_expr(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let at = sub(path, "of");
        self.expr_or_unknown(e.operand(), frame, &at);
        Val::unknown()
    }

    /// An `escalate`: it waits for a person (E1708 in a map), and whom it
    /// asks is typed.
    fn escalate(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        self.person(frame, path, "escalate", None);
        let at = sub(path, "to");
        self.expr_or_unknown(e.to(), frame, &at);
        Val::unknown()
    }

    /// A `pause`: with `then`, that typed; without, it waits for a person.
    fn pause(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        match e.then() {
            Some(t) => {
                let at = sub(path, "then");
                self.expr(t, frame, &at);
            }
            None => self.person(frame, path, "pause", None),
        }
        Val::unknown()
    }

    /// A `try` (`x?`): the `T` of a `Result<T>`, known as `x` is (a verified
    /// one becomes plain).
    fn try_expr(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let at = sub(path, "of");
        let v = self.expr_or_unknown(e.operand(), frame, &at);
        Self::try_of(v)
    }

    fn try_of(v: Val) -> Val {
        let ep = epistemic(&v.ty);
        let inner = if ep.inner.is_named("Result") {
            ep.inner.arg(0)
        } else {
            UNKNOWN
        };
        Val {
            ty: with_level(inner, unverified(ep.level), None),
            cls: v.cls,
        }
    }

    /// `prompt(e, frame, path)`: untrusted content and model output stand in
    /// a prompt's instructions only quoted (E0215).
    fn prompt(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let mut cls = DataClass::Public;
        for (i, p) in e.parts().iter().enumerate() {
            if p.get("expr").is_none() {
                continue;
            }
            let Some(x) = p.get("expr").and_then(Expr::of) else {
                continue;
            };
            let pp = sub_i(path, "parts", i, "/expr");
            let v = self.expr(x, frame, &pp);
            cls = cls.max(v.cls);
            self.prompt_part(x, &v, &pp);
        }
        Val {
            ty: named0("Prompt"),
            cls,
        }
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
    fn field(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        // Module members (fs.read, human.ask) are not values with fields.
        if self.is_module_member(e, frame) {
            return Val::unknown();
        }
        let at = sub(path, "of");
        let base = self.expr_or_unknown(e.operand(), frame, &at);
        self.field_of(e, base, path)
    }

    /// `calleePath(e) && isModuleRoot(e, frame)`.
    fn is_module_member(&self, e: Expr<'a>, frame: &Frame<'a>) -> bool {
        callee_path(e).is_some_and(|p| !p.is_empty()) && self.is_module_root(e, frame)
    }

    /// The member `e.name` of the value `base`.
    fn field_of(&mut self, e: Expr<'a>, base: Val, path: &str) -> Val {
        let ep = epistemic(&base.ty);
        let Some(fields) = fields_of(&ep.inner, self) else {
            return Val {
                ty: with_level(UNKNOWN, unverified(ep.level), None),
                cls: base.cls,
            };
        };
        let name = e.name().unwrap_or_default();
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
                    ty: UNKNOWN,
                    cls: base.cls,
                }
            }
            Some(f) => Val {
                ty: with_level(f.clone(), unverified(ep.level), None),
                cls: base.cls,
            },
        }
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
    fn call(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let args = self.call_args(e, frame, path);
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
        let p = e.callee().and_then(callee_path);
        let cls = max_class(args.iter().map(|a| a.cls));
        let local = p
            .as_deref()
            .filter(|p| {
                !p.is_empty() && !p.contains('.') && Self::lookup(p, &frame.scope).is_none()
            })
            .and_then(|p| self.def(p));
        match (local.filter(|d| d.kind() == Some(DefKind::Fn)), p) {
            (Some(d), Some(p)) => self.call_fn(d, &p, frame, path, &args, cls),
            (_, p) => self.call_other(e, p.unwrap_or_default(), frame, path, &args, cls),
        }
    }

    /// A call of the program's function `p` (`d`): its arguments against
    /// its parameters (E0201 and the rest of `assignable`), what in it waits
    /// for a person in a map (E1708), and what it does, done here.
    fn call_fn(
        &mut self,
        d: mandate_ir::Definition<'a>,
        p: &str,
        frame: &mut Frame<'a>,
        path: &str,
        args: &[Val],
        cls: DataClass,
    ) -> Val {
        self.call_fn_args(d, p, path, args);
        if frame.in_map.is_some() {
            self.fn_waits_in_map(p, frame, path);
        }
        // What the function does is done here, with what the call hands it:
        // a model call or a delegation in it may receive the arguments, so it
        // has at least their class.
        let usages = self.fn_usages(p);
        Self::call_usages(frame, usages, p, path, cls);
        Val {
            ty: self.ty(d.returns()),
            cls,
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
                self.expect(&a.ty, &t, &sub_i(path, "args", i, "/value"));
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
    /// `cap.narrow(…)`, or something unknown.
    fn call_other(
        &mut self,
        e: Expr<'a>,
        p: String,
        frame: &mut Frame<'a>,
        path: &str,
        args: &[Val],
        cls: DataClass,
    ) -> Val {
        match p.as_str() {
            "quote" => return Val { ty: text_ty(), cls },
            "len" => {
                return Val {
                    ty: named0("Int"),
                    cls,
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
                return Val {
                    ty: epistemic(&ty).inner,
                    cls,
                };
            }
            _ => {}
        }
        if !p.is_empty()
            && is_decision_policy(&p)
            && let Some(first) = args.first()
        {
            let ep = epistemic(&first.ty);
            let dec = if ep.inner.is_named("Decision") {
                ep.inner.arg(0)
            } else {
                UNKNOWN
            };
            return Val {
                ty: named("DecisionOutcome", vec![dec]),
                cls,
            };
        }
        let callee = e.callee();
        let module_root = |c: &Checker<'a>| callee.is_some_and(|x| c.is_module_root(x, frame));
        if p == "data.read" && module_root(self) {
            return self.data_read(e, frame, path);
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
            return Val {
                ty: std_ty(&f.returns),
                cls,
            };
        }
        if let Some(c) = callee
            && c.is(ExprOp::Field)
            && c.name() == Some("narrow")
        {
            self.eval_cap(e, path, frame);
            return Val {
                ty: named0("Capability"),
                cls,
            };
        }
        Val { ty: UNKNOWN, cls }
    }

    /// `record(e, frame, path)`: a record of a local type, field by field
    /// (E0202, E0203), never of a protected type (E0213).
    fn record(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let fields = self.record_fields(e, path);
        let mut acc = Val {
            ty: UNKNOWN,
            cls: DataClass::Public,
        };
        let mut level = Level::Plain;
        for (fname, fe) in e.fields() {
            let at = sub(&sub(path, "fields"), fname);
            let v = self.expr_or_unknown(Expr::of(fe), frame, &at);
            level = self.record_field(e, fields.as_deref(), fname, v, &at, level, &mut acc);
        }
        self.record_end(e, fields.as_deref(), path, level, acc.cls)
    }

    /// The fields of a record's type (E0213 for a protected type first).
    fn record_fields(&mut self, e: Expr<'a>, path: &str) -> Option<Vec<(String, Ty)>> {
        let type_name = e.record_type().unwrap_or_default();
        if is_protected_type(type_name) {
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

    /// One field of a record, its value typed (`v`): its class and level
    /// into the record's, and it against the type's field (E0202, and the
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
                    let actual = with_level(ep.inner, epistemic(&ft).level, None);
                    self.expect(&actual, &ft, at);
                }
            }
        }
        level
    }

    /// The fields a record leaves out (E0203), and its value.
    fn record_end(
        &mut self,
        e: Expr<'a>,
        fields: Option<&[(String, Ty)]>,
        path: &str,
        level: Level,
        cls: DataClass,
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
        Val {
            ty: with_level(named0(type_name), level, None),
            cls,
        }
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
        if let Some(prot) = mentions(&target, &PROTECTED_TYPES) {
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
        Val {
            ty: named("Inferred", vec![target]),
            cls,
        }
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
    fn verify(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let v = self.operand(e.value_expr(), frame, path, "value");
        let args = self.call_args(e, frame, path);
        self.verify_args(e, frame, path, &args);
        if let Some(u) = e.on_unmet() {
            self.verify_unmet(u, frame, path);
        }
        let contract = e.contract().unwrap_or_default();
        Val {
            ty: with_level(epistemic(&v.ty).inner, Level::Verified, Some(contract)),
            cls: v.cls,
        }
    }

    /// `on unmet(bind) => then`, typed with `bind` a `List<Text>`.
    fn verify_unmet(&mut self, u: mandate_ir::OnUnmet<'a>, frame: &Frame<'a>, path: &str) {
        let mut vars = HashMap::new();
        vars.insert(
            u.bind().unwrap_or_default().to_owned(),
            Val::public(named("List", vec![text_ty()])),
        );
        let mut inner = Self::child_box(frame, vars);
        let at = sub(path, "on_unmet/then");
        self.expr_or_unknown(u.then(), &mut inner, &at);
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
    fn switch_expr(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        let subj = self.operand(e.on(), frame, path, "on");
        let arm = self.switch_checks(e, &subj, path);
        let mut result: Option<Val> = None;
        for (i, c) in e.cases().enumerate() {
            let binds = self.switch_binds(c, &subj, &arm);
            let v = self.switch_case(c, frame, binds, path, i);
            if result.is_none() {
                result = Some(v);
            }
        }
        result.unwrap_or(Val {
            ty: UNKNOWN,
            cls: subj.cls,
        })
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
        match arm {
            Arm::None => bind_pattern(c.pattern(), &subj.ty, &|_| Vec::new(), &mut binds, subj.cls),
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
                subj.cls,
            ),
            Arm::Variant(inner) => bind_pattern(
                c.pattern(),
                &subj.ty,
                &|tag| self.variant_fields(inner, tag),
                &mut binds,
                subj.cls,
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

    // ── the leaves the other slices call too ────────────────────────────

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

    #[expect(dead_code, reason = "R12 tests it for E0405 of effectCall")]
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
