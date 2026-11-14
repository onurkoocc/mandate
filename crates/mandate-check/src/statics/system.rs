//! The system model, slice R13 (design doc 9 §2, §3, §5): providers and
//! working copies, governance patterns, declared reads and their tiers
//! (`checkSystem`, `checkRead`), `data.read` (`dataRead`), change sets
//! (`changeset`, `findCycle`), and `leadClasses`, which reads what `plan`
//! hands each lead.
//!
//! Each function has the TypeScript's name in snake case, does what its
//! TypeScript function does in the same order, and gives its diagnostics at
//! the place the TypeScript does; the line of `static.ts` is beside each.
//! JavaScript imitated: `.sort()` without a comparator and `<` on text by
//! UTF-16 code units, `Set` in insertion order, `||` against `""`, a regular
//! expression matched by hand (no regular expression engine is used), and
//! `JSON.stringify` of a string.

use std::collections::HashMap;

use mandate_ir::{
    ComponentDef, DefKind, Expr, ExprOp, JsObject, JsValue, Map, Program, Value, compare_utf16,
    ptr, sort_utf16, trim, unique_in_order, write_json_string,
};

use super::{Checker, Frame, Usage, Val, Where, canonical_parts};
use crate::caps::paths_overlap;
use crate::governance::pattern_problem;
use crate::stdlib::{DATA_CLASSES, DataClass, class_rank, is_builtin_effect, std_effect};
use crate::ty::{Level, Ty, epistemic, fields_of, named, named0, show, unalias, with_level};

/// Types a read parameter may have: values, never structure that could
/// become query text (`SCALARS`).
const SCALARS: [&str; 10] = [
    "Bool", "Int", "Dec", "Text", "Path", "Url", "Time", "Duration", "Id", "Money",
];

/// A list of text as an array of facts.
fn strings_js<S: AsRef<str>>(items: &[S]) -> JsValue {
    JsValue::Array(items.iter().map(|s| JsValue::from(s.as_ref())).collect())
}

/// `JSON.stringify(text)`.
fn json_text(text: &str) -> String {
    let mut out = String::new();
    write_json_string(&mut out, text);
    out
}

/// `/^(select|with)\b/i.test(sql)`: the keyword in ASCII letters of either
/// case, and a word boundary (ASCII word characters) after it.
fn starts_with_select_or_with(sql: &str) -> bool {
    let lower = sql.to_ascii_lowercase();
    ["select", "with"].iter().any(|word| {
        lower.strip_prefix(word).is_some_and(|rest| {
            !rest
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    })
}

/// The names `sql.matchAll(/(?<![:\w]):([A-Za-z_]\w*)/g)` finds, in order
/// (`\w` is ASCII), a repeated one repeated.
fn placeholders(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = Vec::new();
    let mut i = 0_usize;
    while let Some(&c) = chars.get(i) {
        let before = i.checked_sub(1).and_then(|p| chars.get(p)).copied();
        let from = i.saturating_add(1);
        let first = chars.get(from).copied();
        if c == ':'
            && !before.is_some_and(|b| b == ':' || word(b))
            && first.is_some_and(|f| f.is_ascii_alphabetic() || f == '_')
        {
            let mut end = from.saturating_add(1);
            while chars.get(end).is_some_and(|c| word(*c)) {
                end = end.saturating_add(1);
            }
            if let Some(name) = chars.get(from..end) {
                out.push(name.iter().collect::<String>());
            }
            i = end;
            continue;
        }
        i = i.saturating_add(1);
    }
    out
}

/// `[...stack.slice(stack.indexOf(n)), n]`.
fn cycle_at<'n>(stack: &[&'n str], n: &'n str) -> Vec<&'n str> {
    let from = stack.iter().position(|s| *s == n).unwrap_or(0);
    let mut cycle: Vec<&'n str> = stack.get(from..).map(<[&str]>::to_vec).unwrap_or_default();
    cycle.push(n);
    cycle
}

/// An edge of the interface graph: provider, consumer, interface.
type Edge<'n> = (&'n str, &'n str, &'n str);

/// A cycle among `nodes` along `edges` (from, to), if there is one:
/// `findCycle(nodes, edges)`. The depth-first search is the TypeScript's,
/// with frames of its own in place of the call stack.
fn find_cycle<'n>(nodes: &[&'n str], edges: &[Edge<'n>]) -> Option<Vec<&'n str>> {
    let mut next: HashMap<&str, Vec<&str>> = nodes.iter().map(|n| (*n, Vec::new())).collect();
    for (a, b, _) in edges {
        if a != b
            && let Some(to) = next.get_mut(a)
        {
            to.push(b);
        }
    }
    // `false` is "open", `true` is "done".
    let mut state: HashMap<&str, bool> = HashMap::new();
    let mut stack: Vec<&str> = Vec::new();
    // `[...nodes].sort()`.
    let mut sorted: Vec<&str> = nodes.to_vec();
    sort_utf16(&mut sorted);
    for start in sorted {
        match state.get(start) {
            Some(true) => continue,
            Some(false) => return Some(cycle_at(&stack, start)),
            None => {}
        }
        state.insert(start, false);
        stack.push(start);
        // The frames of `visit`: a node and how many of its successors are done.
        let mut frames: Vec<(&str, usize)> = vec![(start, 0)];
        while let Some(&(n, i)) = frames.last() {
            match next.get(n).and_then(|v| v.get(i)).copied() {
                None => {
                    frames.pop();
                    stack.pop();
                    state.insert(n, true);
                }
                Some(m) => {
                    if let Some((_, k)) = frames.last_mut() {
                        *k = k.saturating_add(1);
                    }
                    match state.get(m) {
                        Some(true) => {}
                        Some(false) => return Some(cycle_at(&stack, m)),
                        None => {
                            state.insert(m, false);
                            stack.push(m);
                            frames.push((m, 0));
                        }
                    }
                }
            }
        }
    }
    None
}

impl<'a> Checker<'a> {
    /// `checkSystem()` (static.ts 775-813): an interface has one provider
    /// (E1001), two components never share a working copy (E1003), a
    /// component's governance patterns match files (E1007), an
    /// environment's declared reads (`checkRead`: E1004, E1005) and its
    /// tiers (E1006).
    pub(crate) fn check_system(&mut self) {
        let program = self.program;
        let defs: &'a Map = self.defs;
        // `Object.entries(this.defs).filter(component)`.
        let components: Vec<(&'a str, ComponentDef<'a>)> = defs
            .iter()
            .filter_map(|(n, v)| ComponentDef::of(v).map(|c| (n, c)))
            .collect();
        for (name, d) in program.definitions() {
            if d.kind() != Some(DefKind::Interface) {
                continue;
            }
            // An interface has one provider: who answers for a change to it.
            let mut providers: Vec<&str> = components
                .iter()
                .filter(|(_, c)| c.provides().any(|p| p == name))
                .map(|(n, _)| *n)
                .collect();
            sort_utf16(&mut providers);
            if providers.len() != 1 {
                let message = if providers.is_empty() {
                    format!("Interface {name} has no provider; one component must provide it.")
                } else {
                    format!(
                        "Interface {name} is provided by {}; an interface has exactly one provider.",
                        providers.join(" and ")
                    )
                };
                self.report(
                    "E1001",
                    message,
                    &ptr(&[&"defs", &name]),
                    Some(JsObject::new().with("providers", strings_js(&providers))),
                );
            }
        }
        // Two components never share a working copy: their sandboxes and
        // their changes are told apart by root (C5). `.sort(([a], [b]) => (a
        // < b ? -1 : 1))`: by UTF-16 code units, and the names are unique.
        let mut mine: Vec<(&'a str, ComponentDef<'a>)> = program
            .definitions()
            .filter_map(|(n, d)| ComponentDef::of(d.value()).map(|c| (n, c)))
            .collect();
        mine.sort_by(|(a, _), (b, _)| compare_utf16(a, b));
        for (i, (an, a)) in mine.iter().enumerate() {
            for (bn, b) in mine.iter().skip(i.saturating_add(1)) {
                let (ar, br) = (a.root().unwrap_or_default(), b.root().unwrap_or_default());
                if paths_overlap(ar, br) {
                    self.report(
                        "E1003",
                        format!(
                            "The working copies of {an} ({ar}) and {bn} ({br}) overlap; each component has a root of its own."
                        ),
                        &ptr(&[&"defs", bn, &"root"]),
                        Some(JsObject::new().with("components", strings_js(&[an, bn]))),
                    );
                }
            }
        }
        // A component's own governance-class patterns are relative to its
        // repository's root, like the files they match (K70).
        for (name, c) in &mine {
            let patterns = c
                .members()
                .get("governance")
                .and_then(Value::as_array)
                .unwrap_or_default();
            for (i, g) in patterns.iter().enumerate() {
                let Some(g) = g.as_str() else { continue };
                if let Some(why) = pattern_problem(g) {
                    self.report(
                        "E1007",
                        format!(
                            "{name}: governance pattern {} matches no file of the repository: {why}. A pattern is relative to the repository's root, e.g. \"deploy/**\".",
                            json_text(g)
                        ),
                        &ptr(&[&"defs", name, &"governance", &i]),
                        Some(
                            JsObject::new()
                                .with("component", *name)
                                .with("pattern", g),
                        ),
                    );
                }
            }
        }
        for (name, d) in program.definitions() {
            if d.kind() != Some(DefKind::Environment) {
                continue;
            }
            let reads: Vec<(&'a str, &'a Value)> = d.reads().collect();
            for (rn, r) in reads {
                let base = ptr(&[&"defs", &name, &"reads", &rn]);
                self.check_read(name, d.value(), rn, r, &base);
            }
            // A tier binds when an effect in this environment is authorized;
            // on anything never authorized it would bind nothing (INV-11).
            let tiers: Vec<&'a str> = d.authorize().map(|(effect, _)| effect).collect();
            for effect in tiers {
                // An unknown name is E0120's.
                let known = self.def_of(effect, DefKind::Effect).is_some()
                    || std_effect(effect).is_some()
                    || is_builtin_effect(effect);
                if !known || self.is_critical_effect(effect) {
                    continue;
                }
                self.report(
                    "E1006",
                    format!(
                        "{name} sets an authorization tier for {effect}, which is not a critical effect: nothing ever authorizes it."
                    ),
                    &ptr(&[&"defs", &name, &"authorize", &effect]),
                    Some(
                        JsObject::new()
                            .with("environment", name)
                            .with("effect", effect),
                    ),
                );
            }
        }
    }

    /// `checkRead(env, d, rn, r, base)` (static.ts 816-851): a declared
    /// read is one read-only query whose values come only through its
    /// typed, scalar parameters (E1004), returning rows no more sensitive
    /// than its environment (E1005).
    pub(crate) fn check_read(
        &mut self,
        env: &str,
        d: &'a Value,
        rn: &str,
        r: &'a Value,
        base: &str,
    ) {
        let params = r
            .get("params")
            .and_then(Value::as_array)
            .unwrap_or_default();
        let name_of = |p: &Value| {
            p.get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let names: Vec<String> = params.iter().map(name_of).collect();
        for (i, p) in params.iter().enumerate() {
            let t = unalias(&self.param_type(p), self);
            let scalar = t.name().is_some_and(|n| SCALARS.contains(&n));
            if !scalar {
                self.report(
                    "E1004",
                    format!(
                        "{env}.{rn}: parameter {} is {}; a read's parameters are scalars (text, numbers, times), never a query fragment.",
                        name_of(p),
                        show(&t)
                    ),
                    &format!("{base}/params/{i}/type"),
                    None,
                );
            }
        }
        let query = r.get("query");
        if let Some(sql) = query.and_then(|q| q.get("sql")) {
            // `.trim().replace(/;\s*$/, "")`: after the trim no white space
            // ends the text, so only a last `;` goes.
            let text = trim(sql.as_str().unwrap_or_default());
            let sql = text.strip_suffix(';').unwrap_or(text);
            if !starts_with_select_or_with(sql) || sql.contains(';') {
                self.report(
                    "E1004",
                    format!(
                        "{env}.{rn}: a read is one SELECT statement; the broker runs nothing else."
                    ),
                    &format!("{base}/query/sql"),
                    None,
                );
            }
            let used: Vec<String> = {
                let mut u = unique_in_order(placeholders(sql));
                sort_utf16(&mut u);
                u
            };
            let missing: Vec<&String> = used.iter().filter(|u| !names.contains(u)).collect();
            let unused: Vec<&String> = names.iter().filter(|n| !used.contains(n)).collect();
            if !missing.is_empty() || !unused.is_empty() {
                // `… || "none"` replaces an empty text.
                let or_none = |s: String| if s.is_empty() { "none".to_owned() } else { s };
                let shown_used = or_none(
                    used.iter()
                        .map(|u| format!(":{u}"))
                        .collect::<Vec<_>>()
                        .join(", "),
                );
                let shown_names = or_none(names.join(", "));
                self.report(
                    "E1004",
                    format!(
                        "{env}.{rn}: the query's placeholders ({shown_used}) and its parameters ({shown_names}) must match."
                    ),
                    &format!("{base}/query/sql"),
                    Some(
                        JsObject::new()
                            .with("missing", strings_js(&missing))
                            .with("unused", strings_js(&unused)),
                    ),
                );
            }
        } else {
            let row = self.ty(r.get("returns").and_then(mandate_ir::TypeExpr::of));
            let mut vars: HashMap<String, Val> = HashMap::new();
            for (f, t) in fields_of(&row, self).unwrap_or_default() {
                vars.insert(f, Val::public(t));
            }
            for p in params {
                vars.insert(name_of(p), Val::public(self.param_type(p)));
            }
            let mut frame = Frame::new(Where::Const, &format!("{env}.{rn}"), vars);
            let at = format!("{base}/query/logs");
            let logs = query.and_then(|q| q.get("logs")).and_then(Expr::of);
            let v = self.expr_or_unknown(logs, &mut frame, &at);
            self.expect_bool(&v, &at);
        }
        let cls = self.type_class(&self.ty(r.get("returns").and_then(mandate_ir::TypeExpr::of)));
        let held = d.get("class").and_then(Value::as_str);
        // `classRank(d.class)`; a class that is none has rank -1.
        let held_rank = held.and_then(DataClass::from_name).map(class_rank);
        if held_rank.is_none_or(|h| class_rank(cls) > h) {
            self.report(
                "E1005",
                format!(
                    "{env}.{rn} returns {cls} data, but {env} holds at most {}.",
                    held.unwrap_or("undefined")
                ),
                &format!("{base}/returns"),
                Some(
                    JsObject::new()
                        .with("data_class", cls.as_str())
                        .with("environment", held),
                ),
            );
        }
    }

    /// `dataRead(e, frame, path)` (static.ts 1505-1554): `data.read(env.read,
    /// p: v, …, max_class: c)`, a read the environment declares (E1201).
    /// The rows are `Untrusted<List<…>>`, a field above `max_class`
    /// `Masked`.
    pub(crate) fn data_read(&mut self, e: Expr<'a>, frame: &mut Frame<'a>, path: &str) -> Val {
        // `fail(message, at)`: E1201 at `at`, and this value.
        let fail = |this: &mut Self, message: &str, at: &str| {
            this.report("E1201", message, at, None);
            Val::public(named("Untrusted", vec![named("List", vec![Ty::Unknown])]))
        };
        let args = e.arg_values();
        let first = args.first();
        let read_of = first
            .filter(|a| a.get("name").is_none())
            .and_then(|a| a.get("value"))
            .and_then(Expr::of)
            .filter(|v| v.is(ExprOp::Field))
            .and_then(|v| v.operand().filter(|o| o.is(ExprOp::Var)).map(|o| (o, v)));
        let Some((env_var, read)) = read_of else {
            return fail(
                self,
                "data.read names a declared read first: data.read(env.read, param: value, …).",
                path,
            );
        };
        let env_name = env_var.name().unwrap_or_default();
        let first_at = format!("{path}/args/0/value");
        let Some(env) = self.def_of(env_name, DefKind::Environment) else {
            return fail(
                self,
                &format!("'{env_name}' is not an environment."),
                &first_at,
            );
        };
        let read_name = read.name().unwrap_or_default();
        let Some(src) = env.value().get("reads").and_then(|rs| rs.get(read_name)) else {
            return fail(
                self,
                &format!("{env_name} declares no read '{read_name}'."),
                &first_at,
            );
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
        let param_names: Vec<&str> = params
            .iter()
            .map(|p| p.get("name").and_then(Value::as_str).unwrap_or_default())
            .collect();
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
                        let classes: Vec<&str> = DATA_CLASSES.iter().map(|c| c.as_str()).collect();
                        self.report(
                            "E1201",
                            format!("max_class is a data class ({}).", classes.join(", ")),
                            &ap,
                            None,
                        );
                    }
                }
                continue;
            }
            let param = params
                .iter()
                .find(|p| p.get("name").and_then(Value::as_str) == name);
            let (Some(name), Some(param)) = (name.filter(|n| !n.is_empty()), param) else {
                let takes = if param_names.join(", ").is_empty() {
                    "no parameters".to_owned()
                } else {
                    param_names.join(", ")
                };
                // `a.name ? `, not '${a.name}'` : "; pass each by name"`.
                let tail = match name.filter(|n| !n.is_empty()) {
                    Some(n) => format!(", not '{n}'"),
                    None => "; pass each by name".to_owned(),
                };
                self.report(
                    "E1201",
                    format!("{env_name}.{read_name} takes {takes}{tail}."),
                    &ap,
                    None,
                );
                continue;
            };
            if given.contains(&name) {
                self.report("E1201", format!("{name} is given twice."), &ap, None);
            }
            given.push(name);
            // A parameter's value may come from a model or a person: it is
            // bound as a value, never spliced into the query.
            let v = self.expr_or_unknown(a.get("value").and_then(Expr::of), frame, &ap);
            let t = self.param_type(param);
            let plain = with_level(epistemic(&v.ty).inner, Level::Plain, None);
            self.expect(&plain, &t, &ap);
        }
        for p in &param_names {
            if !given.contains(p) {
                self.report(
                    "E1201",
                    format!("{env_name}.{read_name} needs {p}."),
                    path,
                    None,
                );
            }
        }
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

    /// `changeset(e, frame, path)` (static.ts 1815-1888): a change set
    /// (design doc 9 §3): a verified plan (E1105), only in a workflow
    /// (E0408) with `idempotent_by` (E0403), members that are critical
    /// effects on their component's repository (E0201, E1104), an order
    /// with every member once (E1102) and consistent with the interface
    /// graph (E1103, E1101), and in a map (E1708). Its value is
    /// `Receipt<?>` with the plan's class on every path.
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
        if epistemic(&plan.ty).level != Level::Verified {
            self.report(
                "E1105",
                format!(
                    "A change set lands an approved plan: its plan must be verified against a contract, not {} (doc 9 §3.4).",
                    show(&plan.ty)
                ),
                &format!("{path}/plan"),
                None,
            );
        }
        if frame.where_ != Where::Workflow {
            self.report(
                "E0408",
                format!(
                    "A change set commits external effects; it runs only in a workflow body, not in a {} (§8.8).",
                    frame.where_.as_str()
                ),
                path,
                None,
            );
        }
        if let Some(by) = e.idempotent_by() {
            self.expr(by, frame, &format!("{path}/idempotent_by"));
        } else {
            self.report(
                "E0403",
                "A change set needs 'idempotent_by' (§8.4).",
                path,
                Some(JsObject::new().with("repair_hint", "add `idempotent_by <business key>`")),
            );
        }
        let defs: &'a Map = self.defs;
        let components: Vec<(&'a str, ComponentDef<'a>)> = defs
            .iter()
            .filter_map(|(n, v)| ComponentDef::of(v).map(|c| (n, c)))
            .collect();
        let member_list: Vec<(&'a str, mandate_ir::ChangesetMember<'a>)> =
            e.changeset_members().collect();
        for (m, mem) in &member_list {
            let mp = format!("{path}/members/{m}");
            let mut typed: Vec<Val> = Vec::new();
            for (i, a) in mem.arg_values().iter().enumerate() {
                let at = format!("{mp}/args/{i}/value");
                typed.push(self.expr_or_unknown(a.get("value").and_then(Expr::of), frame, &at));
            }
            // E0120 from name resolution.
            let Some(comp) = self.def_of(m, DefKind::Component) else {
                continue;
            };
            let effect = mem.effect().unwrap_or_default();
            let params: Option<Vec<Ty>> = match self.def_of(effect, DefKind::Effect) {
                Some(decl) => Some(decl.params().iter().map(|p| self.param_type(p)).collect()),
                None => {
                    std_effect(effect).map(|s| s.params.iter().map(super::expr::std_ty).collect())
                }
            };
            if let Some(params) = params {
                if typed.len() != params.len() {
                    self.report(
                        "E0201",
                        format!(
                            "Effect {effect} takes {} argument(s) but got {}.",
                            params.len(),
                            typed.len()
                        ),
                        &mp,
                        None,
                    );
                }
                for (i, t) in params.iter().enumerate() {
                    if let Some(a) = typed.get(i) {
                        self.expect(&a.ty, t, &format!("{mp}/args/{i}/value"));
                    }
                }
            }
            if !self.is_critical_effect(effect) {
                self.report(
                    "E1104",
                    format!(
                        "Member {m} runs {effect}, which is not a critical effect; a change set's members are the external actions that land each component's change."
                    ),
                    &format!("{mp}/effect"),
                    None,
                );
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
        let members: Vec<&str> = member_list.iter().map(|(m, _)| *m).collect();
        let order: Vec<&str> = e
            .get("order")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        // `e.order.filter((m, i) => e.order.indexOf(m) !== i)`.
        let dupes: Vec<&str> = order
            .iter()
            .enumerate()
            .filter(|(i, m)| order.iter().position(|o| o == *m) != Some(*i))
            .map(|(_, m)| *m)
            .collect();
        let missing: Vec<&str> = members
            .iter()
            .filter(|m| !order.contains(m))
            .copied()
            .collect();
        let strangers: Vec<&str> = order
            .iter()
            .filter(|m| !members.contains(m))
            .copied()
            .collect();
        if !dupes.is_empty() || !missing.is_empty() || !strangers.is_empty() {
            let twice = unique_in_order(dupes.iter().copied());
            let mut parts: Vec<String> = Vec::new();
            if !missing.is_empty() {
                parts.push(format!("missing {}", missing.join(", ")));
            }
            if !strangers.is_empty() {
                parts.push(format!("not members: {}", strangers.join(", ")));
            }
            if !dupes.is_empty() {
                parts.push(format!("twice: {}", twice.join(", ")));
            }
            self.report(
                "E1102",
                format!(
                    "The order must list every member once: {}.",
                    parts.join("; ")
                ),
                &format!("{path}/order"),
                Some(
                    JsObject::new()
                        .with("missing", strings_js(&missing))
                        .with("not_members", strings_js(&strangers))
                        .with("twice", strings_js(&twice)),
                ),
            );
            return Val {
                ty: named("Receipt", vec![Ty::Unknown]),
                cls: plan.cls,
            };
        }
        let pos: HashMap<&str, usize> = order.iter().enumerate().map(|(i, m)| (*m, i)).collect();
        let mut edges: Vec<Edge<'a>> = Vec::new();
        for (iface, kind) in e.changes() {
            let cp = format!("{path}/changes/{iface}");
            if kind.as_str() == Some("breaking") {
                self.report(
                    "E1103",
                    format!(
                        "{iface} changes in a breaking way; that is never one change set. Plan it as expand → migrate → contract: add the new form, move every consumer, then remove the old one (doc 9 §3.3)."
                    ),
                    &cp,
                    Some(JsObject::new().with("interface", iface)),
                );
                continue;
            }
            if kind.as_str() == Some("none") {
                continue;
            }
            let provider = components
                .iter()
                .find(|(_, c)| c.provides().any(|p| p == iface))
                .map(|(n, _)| *n);
            // E1001 in the system model.
            let Some(provider) = provider else { continue };
            if !pos.contains_key(provider) {
                self.report(
                    "E1101",
                    format!(
                        "{iface} changes, but its provider {provider} is not a member of this change set."
                    ),
                    &cp,
                    Some(
                        JsObject::new()
                            .with("interface", iface)
                            .with("provider", provider),
                    ),
                );
                continue;
            }
            for (consumer, c) in &components {
                if c.consumes().any(|x| x == iface) && pos.contains_key(consumer) {
                    edges.push((provider, consumer, iface));
                }
            }
        }
        // An additive change lands at its provider before any consumer that uses it.
        for (p, c, iface) in &edges {
            if pos.get(p) > pos.get(c) {
                self.report(
                    "E1101",
                    format!(
                        "{c} consumes {iface}, which {p} provides and this change set extends; {p} must land before {c} (order {}).",
                        order.join(", ")
                    ),
                    &format!("{path}/order"),
                    Some(
                        JsObject::new()
                            .with("provider", *p)
                            .with("consumer", *c)
                            .with("interface", *iface),
                    ),
                );
            }
        }
        if let Some(cycle) = find_cycle(&members, &edges) {
            self.report(
                "E1101",
                format!(
                    "No order satisfies the interface graph: {}. Split the change into steps (doc 9 §3.3).",
                    cycle.join(" → ")
                ),
                &format!("{path}/order"),
                Some(JsObject::new().with("cycle", strings_js(&cycle))),
            );
        }
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
