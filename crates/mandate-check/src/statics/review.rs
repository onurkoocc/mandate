//! What language 0.6 adds to the checks of people and of maps
//! (spec/library.md "`human.review` and waivers" and "The batch commit
//! step"), which only the Rust compiler reads.
//!
//! - **Waivers.** `waive by r…` after a criterion's method names the roles
//!   that may waive it (`"waive"` in the IR). A criterion a person approves
//!   is never waived (E1504, [`Checker::check_waivers`]). A value verified
//!   against a contract with a waiver may rest on a waiver, which
//!   [`super::Val::waivable`] carries from what a value is made of to the
//!   value, through a declared type too; such a value never reaches an
//!   irreversible effect, as an argument or as what stands for its approval
//!   (E1505, [`Checker::waivable_args`]), nor the plan of a change set that
//!   commits one.
//! - **`human.review(results, role: r, deadline: d [, escalate_to: r2])`**,
//!   one wait for a person about the outcomes of a map
//!   ([`Checker::human_review`]): `results` is a name a `let` of the same
//!   workflow body binds to a map whose body ends with `verify x against
//!   C(…)` with no `on unmet` (E1506, from what [`super::LetMap`] says of the
//!   `let`); its arguments are as spec/library.md gives them (E1507); its
//!   roles may waive every criterion of `C` that has a waiver (E1508). Its
//!   value is `Review<T, C>`, whose `accepted` are `Verified<T, C>` and whose
//!   declined items are `Declined<T>`, their value a model's output
//!   ([`Checker::review_fields`]); `T` is the verified value's type with its
//!   wrappers peeled, written `Untrusted<T>` when that value was untrusted,
//!   so that a declined one stays untrusted. Both are built-in types of 0.6
//!   that only the runtime makes (E0213). A review is a `human.*` step: in a
//!   map's body it is E1708, as before.
//! - **The batch commit step** ([`Checker::commit_step`]): a critical effect
//!   in a map's body is allowed when it is not irreversible, no envelope or
//!   environment hands it to a person, its `idempotent_by` key reads the
//!   map's item, the map runs its items one at a time and is in no other
//!   map; a change set in a map's body never is. Otherwise E1708, at the
//!   effect, with the condition that does not hold. A program of 0.1 to 0.5
//!   keeps E1708 as it was.

use std::collections::HashSet;
use std::rc::Rc;

use mandate_ir::{
    Criterion, DefKind, Definition, Envelope, Expr, ExprOp, JsObject, JsValue, Language, Map, Stmt,
    StmtOp, Tier, TierBy, TypeExpr, TypeForm, Value, canonicalize,
};

use super::{Checker, Frame, LetMap, MapSite, ReviewSource, Usage, Val, Where, callee_is, sub_i};
use crate::ty::{
    Level, Ty, UNKNOWN, epistemic, from_type_expr, mentions, named, named0, text_ty, with_level,
};
use crate::walk::walk_exprs;

/// The built-in type of a review's value, `Review<T, C>` (0.6).
pub(crate) const REVIEW: &str = "Review";

/// The built-in type of an item a review declined, `Declined<T>` (0.6).
pub(crate) const DECLINED: &str = "Declined";

/// Why a critical effect in a map's body is not a batch commit step: the
/// condition that does not hold, as E1708's facts name it, why, in words,
/// and what more the facts say.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Refusal {
    /// The condition, such as `key` or `par`.
    condition: &'static str,
    /// The part of the message that says why.
    why: String,
    /// More facts, such as the role an envelope hands the effect to.
    facts: Vec<(&'static str, String)>,
}

impl Refusal {
    fn new(condition: &'static str, why: impl Into<String>) -> Refusal {
        Refusal {
            condition,
            why: why.into(),
            facts: Vec::new(),
        }
    }

    fn with(mut self, key: &'static str, value: impl Into<String>) -> Refusal {
        self.facts.push((key, value.into()));
        self
    }

    /// A change set in a map's body: its members are never a batch commit
    /// step.
    pub(crate) fn change_set() -> Refusal {
        Refusal::new(
            "change_set",
            "it is a change set, and a member of a change set is never a batch commit step",
        )
    }
}

/// The roles `human.review` asks, each with the place of its argument, once
/// E1507 has held them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ReviewRoles {
    /// `role`.
    role: Option<(String, String)>,
    /// `escalate_to`.
    escalate: Option<(String, String)>,
}

/// Whether `v` holds a call of `human.approve`, anywhere.
fn asks_approval(v: &Value) -> bool {
    match v {
        Value::Array(items) => items.iter().any(asks_approval),
        Value::Object(o) => {
            Expr::of(v).is_some_and(|e| e.is(ExprOp::Call) && callee_is(e, "human.approve"))
                || o.iter().any(|(_, x)| asks_approval(x))
        }
        _ => false,
    }
}

/// Whether `v` holds a `return` statement, anywhere.
fn holds_return(v: &Value) -> bool {
    match v {
        Value::Array(items) => items.iter().any(holds_return),
        Value::Object(o) => {
            o.get("op").and_then(Value::as_str) == Some("return")
                || o.iter().any(|(_, x)| holds_return(x))
        }
        _ => false,
    }
}

/// Whether the expression `m` reads the variable `name` where nothing in
/// it binds that name again: a `var` of it, outside any block, `switch` or
/// `map` (which may bind names) and outside a `verify`'s `on unmet`. A read
/// inside one of those is not counted, so a key that reads the item only
/// there is refused.
fn reads_free(m: &Map, name: &str) -> bool {
    let op = m.get("op").and_then(Value::as_str);
    match op {
        Some("var") => return m.get("name").and_then(Value::as_str) == Some(name),
        Some("block" | "switch" | "map") => return false,
        _ => {}
    }
    m.iter()
        .any(|(k, x)| !(op == Some("verify") && k == "on_unmet") && reads_free_in(x, name))
}

/// [`reads_free`] of what a member holds.
fn reads_free_in(v: &Value, name: &str) -> bool {
    match v {
        Value::Object(m) => reads_free(m, name),
        Value::Array(items) => items.iter().any(|x| reads_free_in(x, name)),
        _ => false,
    }
}

/// A role as an argument names it: `role: r` or `role: "r"`.
fn role_written<'e>(e: Expr<'e>) -> Option<&'e str> {
    match e.op() {
        Some(ExprOp::Var) => e.name(),
        Some(ExprOp::Text) => e.text(),
        _ => None,
    }
}

/// A duration literal above zero.
fn positive_duration(e: Expr<'_>) -> bool {
    e.is(ExprOp::Duration) && e.get("ms").and_then(Value::as_i64).is_some_and(|ms| ms > 0)
}

/// `role` of an envelope's approval or an environment's authorization, as
/// a message and the facts name it.
fn role_text(v: &Value) -> String {
    v.as_str().map_or_else(|| canonicalize(v), str::to_owned)
}

impl<'a> Checker<'a> {
    // ── the built-in types ──────────────────────────────────────────────

    /// Whether `name` is the built-in `Review` or `Declined` of this program:
    /// one of 0.6 that defines no type of that name itself.
    pub(crate) fn review_type(&self, name: &str) -> bool {
        self.at_least(Language::V0_6)
            && (name == REVIEW || name == DECLINED)
            && self.def_of(name, DefKind::Type).is_none()
    }

    /// The built-in `Review` or `Declined` that `ty` mentions, which only the
    /// runtime makes (E0213): no model, skill or host code produces one.
    pub(crate) fn review_type_in(&self, ty: &Ty) -> Option<&'static str> {
        if !self.at_least(Language::V0_6) {
            return None;
        }
        mentions(ty, &[REVIEW, DECLINED]).filter(|n| self.review_type(n))
    }

    /// The fields of the built-in `Review<T, C>` or `Declined<T>` (0.6), and
    /// whether it is a review; `None` for every other type.
    ///
    /// - `Review<T, C>`: `accepted: List<Verified<T', C>>` (`T'` is `T` with
    ///   its wrappers peeled, `C` the contract when it names one),
    ///   `declined: List<Declined<T>>`, `failed: List<Int>`;
    /// - `Declined<T>`: `index: Int`, `value: Inferred<T>`, `unmet:
    ///   List<Text>`, `by: Option<Text>`. Its value is never verified: it is
    ///   a model's output, or untrusted content when `T` says so.
    pub(crate) fn review_fields(&self, ty: &Ty) -> Option<(Vec<(String, Ty)>, bool)> {
        let name = ty.name()?;
        if !self.review_type(name) {
            return None;
        }
        let t = ty.arg(0);
        if name == REVIEW {
            let c = ty.arg(1);
            let contract = c
                .name()
                .filter(|c| self.def_of(c, DefKind::Contract).is_some());
            let verified = with_level(epistemic(&t).inner, Level::Verified, contract);
            return Some((
                vec![
                    ("accepted".to_owned(), named("List", vec![verified])),
                    (
                        "declined".to_owned(),
                        named("List", vec![named(DECLINED, vec![t])]),
                    ),
                    ("failed".to_owned(), named("List", vec![named0("Int")])),
                ],
                true,
            ));
        }
        Some((
            vec![
                ("index".to_owned(), named0("Int")),
                ("value".to_owned(), named("Inferred", vec![t])),
                ("unmet".to_owned(), named("List", vec![text_ty()])),
                ("by".to_owned(), named("Option", vec![text_ty()])),
            ],
            false,
        ))
    }

    // ── waivers ─────────────────────────────────────────────────────────

    /// The criteria of `contract` that have a waiver, each with its roles,
    /// in the contract's order (`accept`, then `invariant`).
    pub(crate) fn waivers(&self, contract: &str) -> Vec<(&'a str, Vec<&'a str>)> {
        let Some(c) = self.def_of(contract, DefKind::Contract) else {
            return Vec::new();
        };
        c.accept()
            .chain(c.invariant())
            .filter_map(|(n, cr)| {
                let roles: Vec<&'a str> = Criterion::of(cr)?
                    .waive()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                (!roles.is_empty()).then_some((n, roles))
            })
            .collect()
    }

    /// Whether `contract` has a criterion a person may waive (0.6).
    pub(crate) fn waivable_contract(&self, contract: &str) -> bool {
        self.at_least(Language::V0_6) && !self.waivers(contract).is_empty()
    }

    /// E1504: a criterion whose method is or includes `human.approve` has no
    /// waiver: the person who would waive it is the one it asks.
    pub(crate) fn check_waivers(&mut self, name: &str, d: Definition<'a>, base: &str) {
        let accept: Vec<(&'a str, &'a Value)> = d.accept().collect();
        let invariant: Vec<(&'a str, &'a Value)> = d.invariant().collect();
        for (group, criteria) in [("accept", accept), ("invariant", invariant)] {
            for (cn, c) in criteria {
                let Some(cr) = Criterion::of(c) else { continue };
                if cr.waive().is_empty() || !c.get("by").is_some_and(asks_approval) {
                    continue;
                }
                let roles: Vec<JsValue> = cr.waive().iter().map(JsValue::from).collect();
                self.report(
                    "E1504",
                    format!(
                        "{name}.{cn} is met by human.approve, so no one waives it: the person who would waive it is the one it asks. Remove the waiver, or the approval (spec/library.md \"waive by\")."
                    ),
                    &format!("{base}/{group}/{cn}/waive"),
                    Some(
                        JsObject::new()
                            .with("contract", name)
                            .with("criterion", cn)
                            .with("waive", roles),
                    ),
                );
            }
        }
    }

    /// The first contract with a waiver that `ty` mentions as what a value
    /// of it was verified against: `Verified<T, C>` or `Review<T, C>`, in
    /// its arguments, its fields and the types it names (each once).
    pub(crate) fn waivable_in(&self, ty: &Ty, seen: &mut HashSet<String>) -> Option<String> {
        match ty {
            Ty::Named(n) => {
                if (n.name == "Verified" || self.review_type(&n.name) && n.name == REVIEW)
                    && let Some(c) = n.args.get(1).and_then(Ty::name)
                    && self.waivable_contract(c)
                {
                    return Some(c.to_owned());
                }
                if let Some(c) = n.args.iter().find_map(|a| self.waivable_in(a, seen)) {
                    return Some(c);
                }
                let d = self.def_of(&n.name, DefKind::Type)?;
                if !seen.insert(n.name.clone()) {
                    return None;
                }
                self.waivable_in_type_expr(d.type_expr()?, seen)
            }
            Ty::Record { fields } => fields.iter().find_map(|(_, f)| self.waivable_in(f, seen)),
            Ty::Unknown => None,
        }
    }

    /// [`Checker::waivable_in`] of a type definition's type: a reference, a
    /// record's fields, each variant's fields, a refinement's type.
    fn waivable_in_type_expr(&self, t: TypeExpr<'a>, seen: &mut HashSet<String>) -> Option<String> {
        if t.has(TypeForm::Union) {
            return t.union().iter().find_map(|v| {
                v.get("fields")
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|f| f.get("type").and_then(TypeExpr::of))
                    .find_map(|f| self.waivable_in_type_expr(f, seen))
            });
        }
        if t.has(TypeForm::Refine) {
            return self.waivable_in_type_expr(t.refine()?, seen);
        }
        self.waivable_in(&from_type_expr(t, &[]), seen)
    }

    /// Whether `v` may rest on a waiver (0.6): it comes from a value
    /// verified against a contract with a waiver, or its type says it was.
    pub(crate) fn is_waivable(&self, v: &Val) -> bool {
        self.at_least(Language::V0_6)
            && (v.waivable || self.waivable_in(&v.ty, &mut HashSet::new()).is_some())
    }

    /// Whether the function `name` makes a value that may rest on a waiver:
    /// its body, or a function it calls, verifies against a contract with a
    /// waiver or holds a review (0.6).
    pub(crate) fn fn_waivable(&self, name: &str, seen: &mut HashSet<String>) -> bool {
        if !self.at_least(Language::V0_6) {
            return false;
        }
        let Some(f) = self.def_of(name, DefKind::Fn) else {
            return false;
        };
        if !seen.insert(name.to_owned()) {
            return false;
        }
        let mut found = false;
        walk_exprs(f.body(), &mut |x| {
            if found {
                return;
            }
            found = (x.is(ExprOp::Verify)
                && self.waivable_contract(x.contract().unwrap_or_default()))
                || (x.is(ExprOp::Call) && callee_is(x, "human.review"));
            if !found
                && x.is(ExprOp::Call)
                && let Some(callee) = x.callee().filter(|c| c.is(ExprOp::Var))
            {
                found = self.fn_waivable(callee.name().unwrap_or_default(), seen);
            }
        });
        found
    }

    /// Whether `effect` cannot be undone: a declared effect marked
    /// `irreversible`, or such a std effect. A connector's tool never is.
    pub(crate) fn is_irreversible(&self, effect: &str) -> bool {
        if self.connector_tool(effect).is_some() {
            return false;
        }
        match self.def_of(effect, DefKind::Effect) {
            Some(d) => super::truthy(d.value().get("irreversible")),
            None => crate::stdlib::std_effect(effect).is_some_and(|e| e.irreversible),
        }
    }

    /// E1505 at each argument of the irreversible effect `effect` (at
    /// `path`) that may rest on a waiver.
    pub(crate) fn waivable_args(&mut self, effect: &str, path: &str, args: &[Val]) {
        for (i, a) in args.iter().enumerate() {
            if !self.is_waivable(a) {
                continue;
            }
            let contract = self.waivable_in(&a.ty, &mut HashSet::new());
            let what = contract.as_deref().map_or_else(
                || "This value rests on a verification".to_owned(),
                |c| format!("This value rests on its verification against {c}"),
            );
            self.report(
                "E1505",
                format!(
                    "{what}, which a person may waive (waive by), so it never reaches the irreversible effect {effect}: a waiver does not clear what cannot be undone. Verify it against a contract without a waiver first (spec/library.md \"waive by\")."
                ),
                &sub_i(path, "args", i, "/value"),
                Some(
                    JsObject::new()
                        .with("effect", effect)
                        .with_some("contract", contract.as_deref()),
                ),
            );
        }
    }

    /// E1505 at the plan of a change set (at `path`) that commits an
    /// irreversible member and may rest on a waiver: the plan is what lets
    /// the set land.
    pub(crate) fn waivable_plan(&mut self, plan: &Val, path: &str) {
        let contract = self.waivable_in(&plan.ty, &mut HashSet::new());
        self.report(
            "E1505",
            "This change set's plan rests on a verification a person may waive (waive by), and the set commits an effect that cannot be undone: a waiver does not clear what cannot be undone. Verify the plan against a contract without a waiver (spec/library.md \"waive by\").",
            path,
            Some(
                JsObject::new()
                    .with("effect", "changeset")
                    .with_some("contract", contract.as_deref()),
            ),
        );
    }

    // ── human.review ────────────────────────────────────────────────────

    /// What a `let` of 0.6 binds its name to, as a review's source reads it:
    /// a map whose body ends with `verify x against C(…)` with no `on
    /// unmet`, the `verify` typed at `at/body/<last>/value`, or how it is
    /// not one.
    pub(crate) fn let_map(&self, e: Expr<'a>, at: &str) -> LetMap {
        if !e.is(ExprOp::Map) {
            return LetMap::NotMap;
        }
        let body = e.body();
        if body.iter().any(holds_return) {
            return LetMap::Returns;
        }
        let verify = body
            .last()
            .and_then(Stmt::of)
            .filter(|s| s.op() == Some(StmtOp::Expr))
            .and_then(Stmt::value)
            .filter(|v| v.is(ExprOp::Verify));
        let Some(verify) = verify else {
            return LetMap::NotVerifying;
        };
        if verify.on_unmet().is_some() || verify.get("on_unmet").is_some() {
            return LetMap::OnUnmet;
        }
        let at = format!("{at}/body/{}/value", body.len().saturating_sub(1));
        match self.verified.get(&at) {
            Some((item, level)) => LetMap::Verifying(ReviewSource {
                contract: verify.contract().unwrap_or_default().to_owned(),
                item: item.clone(),
                untrusted: *level == Level::Untrusted,
            }),
            None => LetMap::NotVerifying,
        }
    }

    /// `human.review(results, role: r, deadline: d [, escalate_to: r2])`
    /// (spec/library.md "human.review"): one wait for a person (the effect
    /// `Human`, so E1708 in a map's body), its source (E1506), its
    /// arguments (E1507) and its roles (E1508). Its value is `Review<T, C>`
    /// of the class of its arguments (`of`), resting on a waiver; unknown
    /// when its source is not one.
    #[inline(never)]
    pub(crate) fn human_review(
        &mut self,
        e: Expr<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        of: &Val,
    ) -> Val {
        Self::use_effect(frame, Usage::new("Human", path));
        let source = self.review_source(e, frame, path);
        let roles = self.review_arguments(e, frame, path);
        let Some(src) = source else {
            return Val::like(UNKNOWN, of);
        };
        self.review_roles(&src, &roles, path);
        let item = if src.untrusted {
            named("Untrusted", vec![src.item.clone()])
        } else {
            src.item.clone()
        };
        Val {
            ty: named(REVIEW, vec![item, named0(&src.contract)]),
            cls: of.cls,
            waivable: self.waivable_contract(&src.contract),
        }
    }

    /// E1506 for a review whose results are not the outcomes of a verifying
    /// map, with the problem.
    fn not_a_source(&mut self, at: &str, problem: &str, name: Option<&str>, why: &str) {
        self.report(
            "E1506",
            format!(
                "{why} human.review asks about the outcomes of one map: a name a let of the same workflow body binds to a map whose body ends with verify x against C(…), with no on unmet (spec/library.md \"human.review\")."
            ),
            at,
            Some(
                JsObject::new()
                    .with("problem", problem)
                    .with_some("source", name),
            ),
        );
    }

    /// The source of a review (E1506): its first argument, written with no
    /// name, a name the frame binds by a `let` to a verifying map.
    fn review_source(
        &mut self,
        e: Expr<'a>,
        frame: &Frame<'a>,
        path: &str,
    ) -> Option<ReviewSource> {
        let first = e.args().next().filter(|a| a.name().is_none());
        let Some(first) = first else {
            self.not_a_source(path, "missing", None, "This review names no results first.");
            return None;
        };
        let at = sub_i(path, "args", 0, "/value");
        if frame.where_ != Where::Workflow {
            let why = format!("This review is in a {}.", frame.where_.as_str());
            self.not_a_source(path, "outside_workflow", None, &why);
            return None;
        }
        let name = first
            .value()
            .filter(|v| v.is(ExprOp::Var))
            .and_then(Expr::name);
        let Some(name) = name else {
            self.not_a_source(&at, "not_a_name", None, "Its results are not a name.");
            return None;
        };
        let bound = Self::binding(name, &frame.scope).and_then(|s| s.let_map.as_ref());
        let (problem, why) = match bound {
            Some(LetMap::Verifying(src)) => return Some(src.clone()),
            None => (
                "not_let",
                format!("'{name}' is not bound by a let of this workflow's body."),
            ),
            Some(LetMap::NotMap) => ("not_a_map", format!("'{name}' is not bound to a map.")),
            Some(LetMap::NotVerifying) => (
                "not_verifying",
                format!("'{name}' is bound to a map whose body does not end with a verify."),
            ),
            Some(LetMap::OnUnmet) => (
                "on_unmet",
                format!("'{name}' is bound to a map whose verify handles what is unmet itself."),
            ),
            Some(LetMap::Returns) => (
                "returns",
                format!("'{name}' is bound to a map whose body holds a return."),
            ),
        };
        self.not_a_source(&at, problem, Some(name), &why);
        None
    }

    /// E1507 for an argument of a review, with the problem.
    fn malformed_review(&mut self, at: &str, problem: &str, argument: Option<&str>, why: &str) {
        self.report(
            "E1507",
            format!(
                "{why} human.review takes its results, then role: r and deadline: d, and escalate_to: r2 when it escalates, each once: r and r2 name role definitions, r2 another than r, and d is a constant Duration above zero (spec/library.md \"human.review\")."
            ),
            at,
            Some(
                JsObject::new()
                    .with("problem", problem)
                    .with_some("argument", argument),
            ),
        );
    }

    /// The role definition an argument names, when it names one: a name or
    /// its text, never a variable of the frame.
    fn review_role(&self, v: Option<Expr<'a>>, frame: &Frame<'a>) -> Option<String> {
        let v = v?;
        let name = role_written(v)?;
        if v.is(ExprOp::Var) && Self::lookup(name, &frame.scope).is_some() {
            return None;
        }
        self.def_of(name, DefKind::Role).map(|_| name.to_owned())
    }

    /// Whether `v` is a constant Duration above zero: a literal, or a
    /// constant whose value is one.
    fn review_deadline(&self, v: Option<Expr<'a>>, frame: &Frame<'a>) -> bool {
        let Some(v) = v else { return false };
        if positive_duration(v) {
            return true;
        }
        let Some(name) = v.name().filter(|_| v.is(ExprOp::Var)) else {
            return false;
        };
        Self::lookup(name, &frame.scope).is_none()
            && self
                .def_of(name, DefKind::Const)
                .and_then(Definition::value_expr)
                .is_some_and(positive_duration)
    }

    /// The arguments of a review after its results (E1507): the roles it
    /// asks, when they are role definitions.
    fn review_arguments(&mut self, e: Expr<'a>, frame: &Frame<'a>, path: &str) -> ReviewRoles {
        let mut roles = ReviewRoles::default();
        let mut seen: Vec<&'a str> = Vec::new();
        for (i, a) in e.args().enumerate() {
            let at = sub_i(path, "args", i, "/value");
            let Some(n) = a.name() else {
                if i > 0 {
                    self.malformed_review(
                        &at,
                        "positional",
                        None,
                        "This review has a second value without a name.",
                    );
                }
                continue;
            };
            if seen.contains(&n) {
                let why = format!("This review gives '{n}' twice.");
                self.malformed_review(&at, "repeated", Some(n), &why);
                continue;
            }
            seen.push(n);
            match n {
                "role" | "escalate_to" => match self.review_role(a.value(), frame) {
                    Some(r) if n == "role" => roles.role = Some((r, at)),
                    Some(r) => roles.escalate = Some((r, at)),
                    None => {
                        let why = format!("This review's {n} names no role definition.");
                        self.malformed_review(&at, "not_a_role", Some(n), &why);
                    }
                },
                "deadline" => {
                    if !self.review_deadline(a.value(), frame) {
                        self.malformed_review(
                            &at,
                            "deadline",
                            Some(n),
                            "This review's deadline is not a constant Duration above zero.",
                        );
                    }
                }
                _ => {
                    let why = format!("human.review has no argument '{n}'.");
                    self.malformed_review(&at, "unknown_argument", Some(n), &why);
                }
            }
        }
        for n in ["role", "deadline"] {
            if !seen.contains(&n) {
                let why = format!("This review gives no {n}.");
                self.malformed_review(path, "missing", Some(n), &why);
            }
        }
        if let (Some((r, _)), Some((x, at))) = (&roles.role, &roles.escalate)
            && r == x
        {
            let why = format!("This review escalates to {x}, the role it asks first.");
            let at = at.clone();
            self.malformed_review(&at, "same_role", Some("escalate_to"), &why);
            roles.escalate = None;
        }
        roles
    }

    /// E1508: the roles a review asks may waive every criterion of its
    /// contract that has a waiver, and it has one.
    fn review_roles(&mut self, src: &ReviewSource, roles: &ReviewRoles, path: &str) {
        let contract = src.contract.as_str();
        let waivers = self.waivers(contract);
        if waivers.is_empty() {
            self.report(
                "E1508",
                format!(
                    "{contract} has no criterion a person may waive (waive by), so a review of what failed it would waive nothing (spec/library.md \"human.review\")."
                ),
                path,
                Some(
                    JsObject::new()
                        .with("problem", "no_waiver")
                        .with("contract", contract),
                ),
            );
            return;
        }
        for (role, at) in [&roles.role, &roles.escalate].into_iter().flatten() {
            let cannot: Vec<&str> = waivers
                .iter()
                .filter(|(_, rs)| !rs.contains(&role.as_str()))
                .map(|(c, _)| *c)
                .collect();
            if cannot.is_empty() {
                continue;
            }
            self.report(
                "E1508",
                format!(
                    "{role} may not waive {} of {contract}: the role a review asks, and the one it escalates to, are among the waive by roles of every criterion of the contract that has a waiver (spec/library.md \"human.review\").",
                    cannot.join(", ")
                ),
                at,
                Some(
                    JsObject::new()
                        .with("problem", "cannot_waive")
                        .with("role", role.as_str())
                        .with("contract", contract)
                        .with(
                            "criteria",
                            cannot.iter().map(|c| JsValue::from(*c)).collect::<Vec<_>>(),
                        ),
                ),
            );
        }
    }

    // ── the batch commit step ───────────────────────────────────────────

    /// A critical effect `name` in a map's body (E1708): before 0.6 refused
    /// as it always was; in 0.6 a batch commit step, refused at the effect
    /// with the condition that does not hold (spec/library.md "The batch
    /// commit step").
    #[inline(never)]
    pub(crate) fn commit_step(
        &mut self,
        e: Expr<'a>,
        frame: &Frame<'a>,
        path: &str,
        name: &str,
        irreversible: bool,
    ) {
        if !self.at_least(Language::V0_6) {
            self.critical(
                frame,
                path,
                &format!("The critical effect {name} runs"),
                name,
            );
            return;
        }
        if let Some(r) = self.commit_refusal(e, frame, name, irreversible) {
            self.commit_refused(frame, path, name, &r);
        }
    }

    /// The first condition of a batch commit step that the critical effect
    /// `name`, called by `e` in `frame`, does not meet; none when it is one.
    fn commit_refusal(
        &self,
        e: Expr<'a>,
        frame: &Frame<'a>,
        name: &str,
        irreversible: bool,
    ) -> Option<Refusal> {
        if frame.where_ != Where::Workflow {
            return Some(Refusal::new(
                "workflow",
                format!(
                    "it is in a {}, not in a workflow's body",
                    frame.where_.as_str()
                ),
            ));
        }
        if irreversible {
            return Some(Refusal::new("irreversible", "it cannot be undone"));
        }
        if let Some(role) = self.envelope_approver(frame, name) {
            return Some(
                Refusal::new(
                    "envelope_approve",
                    format!("the envelope asks {role} to approve it"),
                )
                .with("role", role),
            );
        }
        if let Some((env, role)) = self.environment_approver(name) {
            return Some(
                Refusal::new(
                    "environment_authorize",
                    format!("the environment {env} asks a person ({role}) to authorize it"),
                )
                .with("environment", env)
                .with("role", role),
            );
        }
        let Some(site) = frame.map_site.as_deref() else {
            return Some(Refusal::new("nested_map", "its map is not known"));
        };
        if !Self::key_reads_item(e.idempotent_by(), frame, site) {
            let why = match e.idempotent_by() {
                None => "it has no idempotent_by key".to_owned(),
                Some(_) => format!(
                    "its idempotent_by key does not read the map's item '{}', so it would be the same for every item",
                    site.bind
                ),
            };
            return Some(Refusal::new("key", why));
        }
        if let Some(par) = site.par.filter(|p| *p > 1) {
            return Some(Refusal::new(
                "par",
                format!("the map runs par {par} items at once"),
            ));
        }
        if site.nested {
            return Some(Refusal::new(
                "nested_map",
                "the map is itself in the body of another map",
            ));
        }
        None
    }

    /// The role the envelope `frame`'s workflow stands under asks to approve
    /// `name`: its own, or a sub-program's parent's.
    fn envelope_approver(&self, frame: &Frame<'a>, name: &str) -> Option<String> {
        let own = self
            .def_of(&frame.def, DefKind::Workflow)
            .and_then(Definition::envelope);
        let parent = self.claim.and_then(|c| c.envelope).and_then(Envelope::of);
        [own, parent].into_iter().flatten().find_map(|env| {
            env.approve()
                .find(|(k, _)| *k == name)
                .map(|(_, r)| role_text(r))
        })
    }

    /// The environment of the program's system model that asks a person to
    /// authorize `name` (`authorize name by human(…)`), and the role.
    fn environment_approver(&self, name: &str) -> Option<(String, String)> {
        let defs: &'a Map = self.defs;
        defs.iter().find_map(|(env, d)| {
            let d = Definition::of(d);
            if d.kind() != Some(DefKind::Environment) {
                return None;
            }
            d.authorize().find_map(|(effect, tier)| {
                let tier = Tier::of(tier)?;
                (effect == name && tier.by() == Some(TierBy::Human))
                    .then(|| (env.to_owned(), tier.role().unwrap_or_default().to_owned()))
            })
        })
    }

    /// Whether the key `key` reads the map's item: the item's name, where
    /// the effect stands, is the map's own binding (no `let` of the body
    /// binds it again), and the key reads it where nothing in the key binds
    /// it again.
    fn key_reads_item(key: Option<Expr<'a>>, frame: &Frame<'a>, site: &MapSite) -> bool {
        let Some(key) = key else { return false };
        let the_item =
            Self::binding(&site.bind, &frame.scope).is_some_and(|s| Rc::ptr_eq(s, &site.scope));
        the_item && reads_free(key.members(), &site.bind)
    }

    /// E1708 for a critical effect `name` in a map's body that is not a
    /// batch commit step, at `path`, with the condition that does not hold.
    pub(crate) fn commit_refused(
        &mut self,
        frame: &Frame<'a>,
        path: &str,
        name: &str,
        r: &Refusal,
    ) {
        let mut facts = JsObject::new()
            .with("map", frame.in_map.as_deref())
            .with("kind", "critical_effect")
            .with("what", name)
            .with("condition", r.condition);
        for (k, v) in &r.facts {
            facts.insert(*k, v.as_str());
        }
        let what = if name == "changeset" {
            "A change set stands".to_owned()
        } else {
            format!("The critical effect {name} runs")
        };
        self.report(
            "E1708",
            format!(
                "{what} inside a map's body, and {}. In a map's body a critical effect is a batch commit step only when it is not irreversible, no envelope or environment hands it to a person, its idempotent_by key reads the item, and the map runs its items one at a time and is in no other map; else run it after the map (spec/library.md \"The batch commit step\").",
                r.why
            ),
            path,
            Some(facts),
        );
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use mandate_ir::parse;

    use super::{asks_approval, holds_return, reads_free};

    fn map(text: &str) -> mandate_ir::Map {
        parse(text)
            .ok()
            .and_then(|p| p.value.as_object().cloned())
            .unwrap_or_default()
    }

    #[test]
    fn a_key_reads_the_item_where_nothing_binds_it_again() {
        let field = r#"{"op":"field","of":{"op":"var","name":"v"},"name":"key"}"#;
        assert!(reads_free(&map(field), "v"));
        assert!(!reads_free(&map(field), "w"));
        let text = r#"{"op":"text","value":"v"}"#;
        assert!(!reads_free(&map(text), "v"));
        let call = r#"{"op":"call","callee":{"op":"var","name":"f"},"args":[{"name":"v","value":{"op":"int","value":1}}]}"#;
        assert!(
            !reads_free(&map(call), "v"),
            "an argument's name is no read"
        );
        let block = r#"{"op":"block","body":[{"op":"let","name":"v","value":{"op":"text","value":"same"}},{"op":"expr","value":{"op":"var","name":"v"}}]}"#;
        assert!(!reads_free(&map(block), "v"), "a block may bind it again");
        let template =
            r#"{"op":"template","parts":[{"text":"draft-"},{"expr":{"op":"var","name":"v"}}]}"#;
        assert!(reads_free(&map(template), "v"));
    }

    #[test]
    fn approvals_and_returns_anywhere() {
        let approve = parse(r#"{"all":[{"static":{"op":"bool","value":true}},{"call":{"op":"call","callee":{"op":"field","of":{"op":"var","name":"human"},"name":"approve"},"args":[]}}]}"#).unwrap().value;
        assert!(asks_approval(&approve));
        let not = parse(r#"{"static":{"op":"bool","value":true}}"#)
            .unwrap()
            .value;
        assert!(!asks_approval(&not));
        let ret = parse(r#"[{"op":"if","cond":{"op":"bool","value":true},"then":[{"op":"return","value":{"op":"int","value":1}}]}]"#).unwrap().value;
        assert!(holds_return(&ret));
    }
}
