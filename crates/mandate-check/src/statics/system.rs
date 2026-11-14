//! The system model, slice R13 (design doc 9 §2, §3, §5): providers and
//! working copies, governance patterns, declared reads and their tiers
//! (`checkSystem`, `checkRead`), `data.read` (`dataRead`), change sets
//! (`changeset`, `findCycle`), and `leadClasses`, which reads what `plan`
//! hands each lead.
//!
//! As in `authority.rs`, each function has the TypeScript's name and the
//! signature R13 keeps, and until R13 fills it does everything its
//! TypeScript function does except the diagnostics written in its own
//! body: the same walk, with the same calls into the core and the same
//! values, so that the core's diagnostics inside a log read's filter, a
//! `data.read` and a change set come out now and in their order. Each of
//! R13's reports goes at the place marked `// R13:`, with the line of
//! `static.ts` it is on. `leadClasses` is complete.

use std::collections::HashMap;

use mandate_ir::{DefKind, Expr, ExprOp, Map, Program, Value, ptr};

use super::{Checker, Frame, Usage, Val, Where, canonical_parts};
use crate::stdlib::DataClass;
use crate::ty::{Ty, fields_of, named, named0};

impl<'a> Checker<'a> {
    /// R13: `checkSystem()`: an interface has one provider (E1001), two
    /// components never share a working copy (E1003), a component's
    /// governance patterns match files (E1007), an environment's declared
    /// reads (`checkRead`: E1004, E1005) and its tiers (E1006).
    ///
    /// Now: of all that, only what calls the core: the filter of each
    /// declared log read of each of the program's own environments, typed
    /// and held to `Bool` (`checkRead`), in the TypeScript's order.
    pub(crate) fn check_system(&mut self) {
        // R13: E1001 for each own interface without exactly one provider (static.ts 778-785),
        // E1003 for two own components whose roots overlap (static.ts 787-794),
        // E1007 for a governance pattern that matches nothing (static.ts 796-801).
        let program = self.program;
        for (name, d) in program.definitions() {
            if d.kind() != Some(DefKind::Environment) {
                continue;
            }
            let reads: Vec<(&'a str, &'a Value)> = d.reads().collect();
            for (rn, r) in reads {
                let base = ptr(&[&"defs", &name, &"reads", &rn]);
                self.check_read(name, d.value(), rn, r, &base);
            }
            // R13: E1006 for a tier set on an effect that is not critical (static.ts 806-811).
        }
    }

    /// R13: `checkRead(env, d, rn, r, base)`: a declared read is one
    /// read-only query whose values come only through its typed, scalar
    /// parameters (E1004), returning rows no more sensitive than its
    /// environment (E1005).
    ///
    /// Now: a log read's filter typed with the row's fields and the
    /// parameters in scope, and held to `Bool` (the core's `expectBool`);
    /// the reports are R13's.
    pub(crate) fn check_read(
        &mut self,
        env: &str,
        d: &'a Value,
        rn: &str,
        r: &'a Value,
        base: &str,
    ) {
        let _ = d;
        // R13: E1004 for each parameter that is not a scalar (static.ts 823-827).
        let query = r.get("query");
        if query.is_some_and(|q| q.get("sql").is_some()) {
            // R13: the SQL checks, E1004 (static.ts 828-838).
        } else {
            let row = self.ty(r.get("returns").and_then(mandate_ir::TypeExpr::of));
            let mut vars: HashMap<String, Val> = HashMap::new();
            for (f, t) in fields_of(&row, self).unwrap_or_default() {
                vars.insert(f, Val::public(t));
            }
            let params = r
                .get("params")
                .and_then(Value::as_array)
                .unwrap_or_default();
            for p in params {
                let name = p.get("name").and_then(Value::as_str).unwrap_or_default();
                vars.insert(name.to_owned(), Val::public(self.param_type(p)));
            }
            let mut frame = Frame::new(Where::Const, &format!("{env}.{rn}"), vars);
            let at = format!("{base}/query/logs");
            let logs = query.and_then(|q| q.get("logs")).and_then(Expr::of);
            let v = self.expr_or_unknown(logs, &mut frame, &at);
            self.expect_bool(&v, &at);
        }
        // R13: E1005 when the rows' class is above the environment's (static.ts 847-850).
    }

    /// R13: `dataRead(e, frame, path)`: `data.read(env.read, p: v, …,
    /// max_class: c)`, a read the environment declares (E1201). The rows
    /// are `Untrusted<List<…>>`, a field above `max_class` `Masked`.
    ///
    /// Now: the same values and the walk of the parameters' values, which
    /// the core types; every E1201 and the parameters' `problem` are R13's.
    pub(crate) fn data_read(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        // `fail(message, at)`: R13 reports E1201 at `at`, and the value is
        // this (static.ts 1514-1517).
        let fail = || Val::public(named("Untrusted", vec![named("List", vec![Ty::Unknown])]));
        let args = e.arg_values();
        let first = args.first();
        let read_of = first
            .filter(|a| a.get("name").is_none())
            .and_then(|a| a.get("value"))
            .and_then(Expr::of)
            .filter(|v| v.is(ExprOp::Field))
            .and_then(|v| v.operand().filter(|o| o.is(ExprOp::Var)).map(|o| (o, v)));
        let Some((env_var, read)) = read_of else {
            // R13: E1201 "data.read names a declared read first…" (static.ts 1519).
            return fail();
        };
        let env_name = env_var.name().unwrap_or_default();
        let Some(env) = self.def_of(env_name, DefKind::Environment) else {
            // R13: E1201 "'…' is not an environment." (static.ts 1522).
            return fail();
        };
        let read_name = read.name().unwrap_or_default();
        let Some(src) = env.value().get("reads").and_then(|rs| rs.get(read_name)) else {
            // R13: E1201 "… declares no read '…'." (static.ts 1525).
            return fail();
        };
        let mut max_class = env
            .value()
            .get("class")
            .and_then(Value::as_str)
            .and_then(DataClass::from_name)
            .unwrap_or(DataClass::Public);
        let params = src
            .get("params")
            .and_then(Value::as_array)
            .unwrap_or_default();
        let mut given: Vec<&str> = Vec::new();
        for (k, a) in args.iter().enumerate().skip(1) {
            let ap = format!("{path}/args/{k}/value");
            let name = a.get("name").and_then(Value::as_str);
            if name == Some("max_class") {
                let value = a.get("value").and_then(Expr::of);
                let c = value
                    .filter(|v| v.is(ExprOp::Var))
                    .map(|v| v.name().unwrap_or_default())
                    .unwrap_or_default();
                match DataClass::from_name(c) {
                    Some(c) => max_class = c,
                    None => {
                        // R13: E1201 "max_class is a data class (…)." at `ap` (static.ts 1533).
                    }
                }
                continue;
            }
            let param = params
                .iter()
                .find(|p| p.get("name").and_then(Value::as_str) == name);
            let (Some(name), Some(param)) = (name.filter(|n| !n.is_empty()), param) else {
                // R13: E1201 "… takes …" at `ap` (static.ts 1538-1541).
                continue;
            };
            if given.contains(&name) {
                // R13: E1201 "… is given twice." at `ap` (static.ts 1542).
            }
            given.push(name);
            // A parameter's value may come from a model or a person: it is
            // bound as a value, never spliced into the query.
            let _v = self.expr_or_unknown(a.get("value").and_then(Expr::of), frame, &ap);
            let _t = self.param_type(param);
            // R13: `problem(assignable(withLevel(epistemic(v.ty).inner, "plain"), t), ap)` (static.ts 1546).
        }
        // R13: E1201 "… needs …" at `path` for each parameter not given (static.ts 1548).
        let row = self.ty(src.get("returns").and_then(mandate_ir::TypeExpr::of));
        let shown = match fields_of(&row, self) {
            Some(fields) => Ty::Record {
                fields: fields
                    .into_iter()
                    .map(|(f, t)| {
                        let masked = self.type_class(&t) > max_class;
                        (f, if masked { named0("Masked") } else { t })
                    })
                    .collect(),
            },
            None => row,
        };
        let mut u = Usage::new("Data.Read", path);
        u.scope = Some(vec![format!("{env_name}.{read_name}")]);
        Self::use_effect(frame, u);
        let cls = self.type_class(&shown);
        Val {
            ty: named("Untrusted", vec![named("List", vec![shown])]),
            cls,
        }
    }

    /// R13: `changeset(e, frame, path)`: a change set (design doc 9 §3):
    /// a verified plan (E1105), only in a workflow (E0408) with
    /// `idempotent_by` (E0403), members that are critical effects on their
    /// component's repository (E0201, E1104), an order with every member
    /// once (E1102) and consistent with the interface graph (E1103, E1101),
    /// and in a map (E1708).
    ///
    /// Now: the core's `critical` in a map (E1708), the plan, the
    /// `idempotent_by` and each member's arguments typed by the core, and
    /// the usage of each member that is a critical effect; the other
    /// reports are R13's. Its value is `Receipt<?>` with the plan's class
    /// on every path of the TypeScript.
    pub(crate) fn changeset(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        if frame.in_map.is_some() {
            self.critical(
                frame,
                path,
                "A change set commits critical effects, and this one stands",
                "changeset",
            );
        }
        let plan = self.expr_or_unknown(e.plan(), frame, &format!("{path}/plan"));
        // R13: E1105 when the plan is not verified (static.ts 1826-1828);
        // E0408 outside a workflow (static.ts 1829-1831).
        match e.idempotent_by() {
            Some(by) => {
                self.expr(by, frame, &format!("{path}/idempotent_by"));
            }
            None => {
                // R13: E0403 (static.ts 1833).
            }
        }
        let members: Vec<(&'a str, mandate_ir::ChangesetMember<'a>)> =
            e.changeset_members().collect();
        for (m, mem) in members {
            let mp = format!("{path}/members/{m}");
            for (i, a) in mem.arg_values().iter().enumerate() {
                let at = format!("{mp}/args/{i}/value");
                self.expr_or_unknown(a.get("value").and_then(Expr::of), frame, &at);
            }
            // E0120 from name resolution.
            let Some(comp) = self.def_of(m, DefKind::Component) else {
                continue;
            };
            let effect = mem.effect().unwrap_or_default();
            // R13: with the effect's parameters known, E0201 for a wrong count and the
            // `problem(assignable(…))` of each argument (static.ts 1840-1848).
            if !self.is_critical_effect(effect) {
                // R13: E1104 (static.ts 1850), then the next member.
                continue;
            }
            // The member acts on its component's repository: the workflow
            // must hold that authority.
            let mut u = Usage::new(effect, &mp);
            u.scope = Some(vec![
                comp.value()
                    .get("repo")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ]);
            Self::use_effect(frame, u);
        }
        // R13: E1102 for an order that does not list every member once, which ends the check
        // (static.ts 1856-1863); E1103, E1101 and the cycle of `findCycle` (static.ts 1864-1886).
        Val {
            ty: named("Receipt", vec![Ty::Unknown]),
            cls: plan.cls,
        }
    }
}

/// The data class of what each `plan` of a program hands its lead, by the
/// plan's path, sorted by path in UTF-16 order: the class a sub-program of
/// that lead has (`Claim.lead`). For a program that passed the checks:
/// `leadClasses(program, linked)`.
#[must_use]
pub fn lead_classes(program: Program<'_>, linked: Option<&Map>) -> Vec<(String, DataClass)> {
    let (canonical_program, defs) = canonical_parts(program, linked);
    let Some(p) = Program::of(&canonical_program) else {
        return Vec::new();
    };
    let mut c = Checker::new(p, &defs, None, None);
    c.run_passes();
    let mut leads = c.leads;
    leads.sort_by(|(a, _), (b, _)| mandate_ir::compare_utf16(a, b));
    leads
}
