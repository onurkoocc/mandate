//! Language 0.6 (Rust only): each form typed as the runtime evaluates it
//! (`runtime/src/interp.ts`). Where the runtime gives one of several values
//! the type is their join ([`Checker::join`]): a `switch`'s arms, a statement
//! and the `on error` handler after it, a `verify` and its `on unmet`
//! handler (but for [`unmet_keeps_verified`]), the branches of an `if`. A
//! value the checker cannot type and did not refuse is silent
//! ([`Val::silent`]): never accepted where a verified value is required
//! ([`Checker::expect_val`]). What it cannot know at all, a person's answer
//! or a fault's payload, is of the highest class and may rest on a waiver
//! ([`Checker::opaque`]). Before 0.6 nothing here is used: every program of
//! 0.1 to 0.5 is typed as it always was.

use std::collections::HashSet;

use mandate_ir::{DefKind, Expr, ExprOp, Language, TypeExpr, TypeForm, Value};

use super::expr::has_unknown;
use super::review::REVIEW;
use super::{Checker, Val};
use crate::resolve::SUPERVISION_STRATEGIES;
use crate::stdlib::DataClass;
use crate::ty::{
    Level, Ty, UNKNOWN, assignable, epistemic, fields_of, from_type_expr, join_level, named, show,
    unalias, with_level,
};

/// `verify … on unmet(c) => escalate …` and `verify … on unmet(c) => pause`:
/// a handler that is nothing but an escalation or a pause keeps the type of
/// the verified value, as in 0.5; every other handler joins.
///
/// This is the one exception to the joins of 0.6, and an open decision of
/// the user's, kept visible here. At run time the person's answer becomes
/// the `verify`'s value, and the runtime's check of a `Verified` parameter
/// (INV-13) refuses it at the effect. Without the exception the standing
/// idiom of the example programs (`fixtures/fixbug/fixbug.mdt`,
/// `fixtures/system/audience.mdt`, `fixtures/system/onboard.mdt`) would be
/// refused in 0.6, which is a decision about the language that a fix round
/// does not take. Cases: H08 (the idiom checks), E0201a (another handler
/// joins, and is refused where a verified value is required).
pub(crate) fn unmet_keeps_verified(then: Option<Expr<'_>>) -> bool {
    then.is_some_and(|t| t.is(ExprOp::Escalate) || (t.is(ExprOp::Pause) && t.then().is_none()))
}

/// Whether `then`, the handler of an `on error`, is a supervision strategy
/// (`restart`, `reconcile` …, alone or called): what the run does next, not
/// a value that replaces the failed statement's.
pub(crate) fn is_strategy(then: Option<Expr<'_>>) -> bool {
    let Some(t) = then else { return false };
    let name = match t.op() {
        Some(ExprOp::Var) => t.name(),
        Some(ExprOp::Call) => t
            .callee()
            .filter(|c| c.is(ExprOp::Var))
            .and_then(Expr::name),
        _ => None,
    };
    name.is_some_and(|n| SUPERVISION_STRATEGIES.contains(&n))
}

impl<'a> Checker<'a> {
    /// 0.6: a value the checker knows nothing of, a person's answer or a
    /// fault's payload: of the highest class, resting on a waiver for all
    /// the checker knows, and silent. Before 0.6, [`Val::unknown`].
    pub(crate) fn opaque(&self, ty: Ty) -> Val {
        if !self.at_least(Language::V0_6) {
            return Val::unknown();
        }
        Val {
            ty,
            cls: DataClass::Restricted,
            waivable: true,
            silent: true,
        }
    }

    /// 0.6: a value made of `from` whose type the checker cannot tell (a
    /// field of a type it sees no fields of, a range, a name the runtime
    /// gives as itself): of `from`'s class and resting on what it rests on,
    /// which is exact, with its type silent. Before 0.6, `Val::like(UNKNOWN,
    /// from)`.
    pub(crate) fn untyped(&self, ty: Ty, from: &Val) -> Val {
        Val {
            silent: from.silent || self.at_least(Language::V0_6),
            ..Val::like(ty, from)
        }
    }

    /// The `null` a statement gives that has no value of its own (an `if`
    /// without `else` whose condition fails, a `par`): public, of a type
    /// that is none the checker has, silent in 0.6.
    pub(crate) fn null_val(&self) -> Val {
        self.untyped(UNKNOWN, &Val::unknown())
    }

    /// The value one of `a` and `b` is, as the runtime may give either: the
    /// weaker level (both `Verified` stay so, with their contract when they
    /// agree on it), the wider type, the higher class, resting on what
    /// either rests on, silent when either is or when the types have no
    /// common one. An unknown that is not silent (one a diagnostic stands
    /// for, or a block that returns) adds nothing.
    #[inline(never)]
    pub(crate) fn join(&self, a: &Val, b: &Val) -> Val {
        let (ty, apart) = self.join_types(a, b);
        Val {
            ty,
            cls: a.cls.max(b.cls),
            waivable: a.waivable || b.waivable,
            silent: a.silent || b.silent || apart,
        }
    }

    /// The type of [`Checker::join`], and whether the two have none in
    /// common.
    fn join_types(&self, a: &Val, b: &Val) -> (Ty, bool) {
        match (&a.ty, &b.ty) {
            (Ty::Unknown, _) if !a.silent => return (b.ty.clone(), false),
            (_, Ty::Unknown) if !b.silent => return (a.ty.clone(), false),
            (Ty::Unknown, _) | (_, Ty::Unknown) => return (UNKNOWN, false),
            _ => {}
        }
        if a.ty == b.ty {
            return (a.ty.clone(), false);
        }
        let (ea, eb) = (epistemic(&a.ty), epistemic(&b.ty));
        let level = if ea.level == Level::Verified && eb.level == Level::Verified {
            Level::Verified
        } else {
            join_level(ea.level, eb.level)
        };
        let contract = ea
            .contract
            .as_deref()
            .filter(|c| level == Level::Verified && eb.contract.as_deref() == Some(*c));
        let (ua, ub) = (has_unknown(&ea.inner), has_unknown(&eb.inner));
        let inner = if ea.inner == eb.inner {
            ea.inner.clone()
        } else if let Some(t) = without_lit(&ea.inner, &eb.inner) {
            t
        } else if ua != ub {
            // An unknown in one of the two only (`[]`'s `List<?>`, a
            // person's `Untrusted<?>`): the other's type, which the unknown
            // would take in any place; none the checker has when that
            // unknown is silent, for it may stand for anything.
            let (silent, typed) = if ua {
                (a.silent, &eb.inner)
            } else {
                (b.silent, &ea.inner)
            };
            if silent {
                return (with_level(UNKNOWN, level, None), true);
            }
            typed.clone()
        } else if assignable(&ea.inner, &eb.inner, self).is_none() {
            eb.inner.clone()
        } else if assignable(&eb.inner, &ea.inner, self).is_none() {
            ea.inner.clone()
        } else {
            return (with_level(UNKNOWN, level, None), true);
        };
        (with_level(inner, level, contract), false)
    }

    /// `expect(v.ty, expected, path)`, and in 0.6 E0201 when nothing else
    /// is wrong but `v` is silent where `expected` requires a verified
    /// value: the checker cannot tell that the value is one.
    #[inline(never)]
    pub(crate) fn expect_val(&mut self, v: &Val, expected: &Ty, path: &str) {
        let p = assignable(&v.ty, expected, self);
        if p.is_some() {
            self.problem(p, path);
            return;
        }
        self.silent_where_verified(v, expected, path);
    }

    /// The E0201 of [`Checker::expect_val`] alone, for a place that checks
    /// the rest otherwise (a record's field, at the field's own level).
    #[inline(never)]
    pub(crate) fn silent_where_verified(&mut self, v: &Val, expected: &Ty, path: &str) {
        if v.silent
            && self.at_least(Language::V0_6)
            && self.unknown_where_verified(&v.ty, expected, &mut HashSet::new())
        {
            self.report(
                "E0201",
                format!(
                    "Expected {} but got {}, a value of a form whose type the checker cannot tell, so it cannot tell that the value is verified. A value goes where a verified one is required only when it is known to be one: verify it first.",
                    show(expected),
                    show(&v.ty)
                ),
                path,
                None,
            );
        }
    }

    /// Whether `actual` has an unknown where `expected` requires a verified
    /// value: at its top, or in the same place of their arguments and
    /// fields.
    fn unknown_where_verified(
        &self,
        actual: &Ty,
        expected: &Ty,
        seen: &mut HashSet<String>,
    ) -> bool {
        if matches!(actual, Ty::Unknown) {
            return self.requires_verified(expected, seen);
        }
        let (ea, ee) = (epistemic(actual), epistemic(expected));
        let (ia, ie) = (unalias(&ea.inner, self), unalias(&ee.inner, self));
        if matches!(ia, Ty::Unknown) {
            // A verified value of a type the checker cannot tell is verified;
            // what its type holds is asked of the expected inner type.
            return if ea.level == Level::Verified {
                self.requires_verified_inside(&ie, seen)
            } else {
                self.requires_verified(&ie, seen)
            };
        }
        match (&ia, &ie) {
            (Ty::Named(na), Ty::Named(ne)) if na.name == ne.name => na
                .args
                .iter()
                .zip(&ne.args)
                .any(|(x, y)| self.unknown_where_verified(x, y, seen)),
            _ => {
                let (Some(fa), Some(fe)) = (fields_of(&ia, self), fields_of(&ie, self)) else {
                    return false;
                };
                fe.iter().any(|(k, t)| {
                    fa.iter()
                        .find(|(g, _)| g == k)
                        .is_some_and(|(_, x)| self.unknown_where_verified(x, t, seen))
                })
            }
        }
    }

    /// Whether a value of `ty` must be, or must hold, a verified value: it
    /// is `Verified<…>` or a review, or holds one in its arguments, its
    /// fields, or the type definitions it names (an alias, a record's
    /// fields, a union's variants, a refinement), each once.
    fn requires_verified(&self, ty: &Ty, seen: &mut HashSet<String>) -> bool {
        epistemic(ty).level == Level::Verified || self.requires_verified_inside(ty, seen)
    }

    /// [`Checker::requires_verified`] of what `ty` holds, not of `ty`
    /// itself.
    fn requires_verified_inside(&self, ty: &Ty, seen: &mut HashSet<String>) -> bool {
        match ty {
            Ty::Unknown => false,
            Ty::Record { fields } => fields.iter().any(|(_, f)| self.requires_verified(f, seen)),
            Ty::Named(n) => {
                if n.name == REVIEW && self.review_type(&n.name) {
                    return true;
                }
                if n.args.iter().any(|a| self.requires_verified(a, seen)) {
                    return true;
                }
                let Some(d) = self.def_of(&n.name, DefKind::Type) else {
                    return false;
                };
                if !seen.insert(n.name.clone()) {
                    return false;
                }
                d.type_expr()
                    .is_some_and(|t| self.requires_verified_in_expr(t, seen))
            }
        }
    }

    /// [`Checker::requires_verified`] of a type definition's type.
    fn requires_verified_in_expr(&self, t: TypeExpr<'a>, seen: &mut HashSet<String>) -> bool {
        if t.has(TypeForm::Union) {
            return t.union().iter().any(|v| {
                v.get("fields")
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|f| f.get("type").and_then(TypeExpr::of))
                    .any(|f| self.requires_verified_in_expr(f, seen))
            });
        }
        if t.has(TypeForm::Refine) {
            return t
                .refine()
                .is_some_and(|r| self.requires_verified_in_expr(r, seen));
        }
        self.requires_verified(&from_type_expr(t, &[]), seen)
    }
}

/// Two named types that differ only in a text literal's value, as that
/// type without one: `"a"` and `"b"` join to `Text`.
fn without_lit(a: &Ty, b: &Ty) -> Option<Ty> {
    match (a, b) {
        (Ty::Named(x), Ty::Named(y)) if x.name == y.name && x.args == y.args && x.lit != y.lit => {
            Some(named(&x.name, x.args.clone()))
        }
        _ => None,
    }
}
