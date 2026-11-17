//! The reports of a program of language 0.7 (spec/attention.md "`report`",
//! "Titles"), which only the Rust compiler reads: a report shows one role a
//! few values, and is held to what makes what it shows the compiler's word.
//!
//! - **E1903, malformed report** ([`report_checks`]): its title follows the
//!   title rules ([`crate::stages::title_problem`], the rules of a stage's
//!   title); two of its fields do not have one name (the text refuses that
//!   as E0121, so this is the IR's); and in a pattern its role is one of the
//!   pattern's role slots, which the expansion fills with the role the
//!   application binds. The fact `problem` says which (`title`,
//!   `duplicate_field`, `role`).
//! - **E1904, field not shown**: a field's expression is pure
//!   ([`impurity`], an allow-list over the kinds of expression, here), and
//!   its type is one a person can be shown ([`not_shown`], which the static
//!   checks apply to the type their typing gives the field, `problem:
//!   "type"`).
//! - **E1905, report out of place**: not in a map's body, a loop without
//!   `max_iter`, a function, an `on error`, `on unmet` or `on budget_exceeded`
//!   handler, or a test, nor anywhere else but the body of a workflow written
//!   out or of a pattern. Nor directly before an `on error`: a report changes
//!   no value of the run, so it is no statement an `on error` could handle,
//!   and the handler after it would handle the statement before it, which a
//!   reader cannot tell (fact `place: "before_on_error"`). The fact `place`
//!   says where it stands.
//!
//! The role of a report is a role site of the program (`crate::roles`):
//! E1501 when no role definition has the name, and with a lock E1502.
//!
//! [`report_checks`] runs in [`crate::check()`] after the stages, on the
//! program as written, and again on what an expansion wrote (a workflow that
//! applies a pattern has the pattern's reports, its role the bound one),
//! each diagnostic of the expansion reported at the application. A report
//! costs nothing, counts in no budget and toward no limit of nodes, adds no
//! step to a view, and is no statement of its block's value: every walker of
//! the compiler names it.

use mandate_ir::{
    DefKind, Definition, Diagnostic, Expr, ExprOp, JsObject, JsValue, Language, Location, Map,
    PatternDef, Program, ReportField, Spans, Stmt, StmtOp, TypeForm, Value, nearest_span,
    ptr_token,
};

use crate::caps::callee_path;
use crate::stages::{TITLE_RULES, title_problem};
use crate::ty::{Level, Ty, TypeEnv, epistemic, fields_of, level_rank, peeled_type, unalias};

/// Where the diagnostics go, and with which spans.
struct Out<'s> {
    spans: Option<&'s Spans>,
    found: Vec<Diagnostic>,
}

impl Out<'_> {
    fn report(&mut self, code: &str, message: String, path: &str, facts: JsObject) {
        let span = nearest_span(self.spans, path);
        self.found.push(Diagnostic::new(
            code,
            message,
            Location::path_span(path, span),
            Some(facts),
        ));
    }
}

/// Where a report stands, as the walk goes down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place<'n> {
    /// Where one may stand: the body of a workflow written out or of a
    /// pattern, outside every place below.
    Allowed,
    /// Where none may: the fact `place` (`map`, `loop`, `on_error`,
    /// `on_unmet`, `on_budget_exceeded`, `fn`, `test`, the kind of another
    /// definition, or a member of a workflow or a pattern other than its
    /// body).
    Not(&'n str),
}

/// What the walk knows of the definition it is in.
struct Within<'a> {
    /// `workflow`, `pattern`, the kind of another definition, or `test`.
    what: &'a str,
    /// Its name.
    name: &'a str,
    /// In a pattern: the names of its role slots.
    role_slots: Option<Vec<&'a str>>,
    /// The names a call may not be the built-in `len` under: a function of
    /// the program named `len`, a slot of the pattern named `len`.
    len_taken: bool,
}

/// E1903, E1904 (purity) and E1905 for `program`, whose linked definitions
/// are `linked` (a function named `len` there makes `len(…)` a call of it),
/// in the order of its definitions and then of its tests and other members.
/// A program older than 0.7 has no report (its schema refuses one, and its
/// text reads none), and is given nothing.
#[must_use]
pub fn report_checks(program: Program<'_>, linked: &Map, spans: Option<&Spans>) -> Vec<Diagnostic> {
    if !program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_7))
    {
        return Vec::new();
    }
    let mut out = Out {
        spans,
        found: Vec::new(),
    };
    let len_fn = linked
        .get("len")
        .is_some_and(|d| Definition::of(d).kind() == Some(DefKind::Fn));
    for (name, d) in program.definitions() {
        let base = format!("/defs/{}", ptr_token(name));
        let value = d.value();
        let kind = d.kind();
        let Some(m) = value.as_object() else { continue };
        let holder = match kind {
            Some(DefKind::Workflow) if value.get("apply").is_none() => Some("workflow"),
            Some(DefKind::Pattern) => Some("pattern"),
            _ => None,
        };
        let pattern = (kind == Some(DefKind::Pattern))
            .then(|| PatternDef::of(value))
            .flatten();
        let role_slots = pattern.map(|p| {
            p.slots()
                .filter(|s| s.kind() == Some("role"))
                .filter_map(|s| s.name())
                .collect::<Vec<_>>()
        });
        let len_slot = pattern.is_some_and(|p| p.slots().any(|s| s.name() == Some("len")));
        let within = Within {
            what: holder.unwrap_or_else(|| kind.map_or("definition", DefKind::as_str)),
            name,
            role_slots,
            len_taken: len_fn || len_slot,
        };
        for (k, x) in m.iter() {
            let at = format!("{base}/{}", ptr_token(k));
            let place = match (holder, k) {
                (Some(_), "body") => Place::Allowed,
                (Some(_), "on") => Place::Not("on_budget_exceeded"),
                (Some(_), member) => Place::Not(member),
                (None, _) => Place::Not(within.what),
            };
            walk(x, &at, place, &within, &mut out);
        }
    }
    for (k, x) in program.members().iter() {
        if k == "defs" {
            continue;
        }
        let at = format!("/{}", ptr_token(k));
        if k == "tests" {
            for (t, test) in x.as_object().into_iter().flat_map(Map::iter) {
                let within = Within {
                    what: "test",
                    name: t,
                    role_slots: None,
                    len_taken: len_fn,
                };
                walk(
                    test,
                    &format!("{at}/{}", ptr_token(t)),
                    Place::Not("test"),
                    &within,
                    &mut out,
                );
            }
        } else {
            let within = Within {
                what: k,
                name: "",
                role_slots: None,
                len_taken: len_fn,
            };
            walk(x, &at, Place::Not(k), &within, &mut out);
        }
    }
    out.found
}

/// Whether `v` is a statement whose `op` is `op`.
fn is_op(v: Option<&Value>, op: StmtOp) -> bool {
    v.and_then(Stmt::of).is_some_and(|s| s.op() == Some(op))
}

/// Every report in `v` (at `path`), which stands at `place`: each is held
/// to its rules, and the walk goes on into what may hold a report.
fn walk(v: &Value, path: &str, place: Place<'_>, w: &Within<'_>, out: &mut Out<'_>) {
    match v {
        Value::Array(items) => {
            for (i, x) in items.iter().enumerate() {
                let at = format!("{path}/{i}");
                if is_op(Some(x), StmtOp::Report) {
                    // An `on error` stands only in a list of statements, after
                    // the statement it handles.
                    let before_on_error = is_op(items.get(i.saturating_add(1)), StmtOp::OnError);
                    let place = match place {
                        Place::Allowed if before_on_error => Place::Not("before_on_error"),
                        other => other,
                    };
                    one_report(x, &at, place, w, out);
                } else {
                    walk(x, &at, place, w, out);
                }
            }
        }
        Value::Object(m) => {
            let op = v.get("op").and_then(Value::as_str);
            for (k, x) in m.iter() {
                let at = format!("{path}/{}", ptr_token(k));
                let inner = match (op, k) {
                    (Some("loop"), "body" | "until") if v.get("max_iter").is_none() => {
                        Place::Not("loop")
                    }
                    (Some("map"), "body") => Place::Not("map"),
                    (Some("on_error"), "then") => Place::Not("on_error"),
                    (Some("verify"), "on_unmet") => Place::Not("on_unmet"),
                    _ => place,
                };
                if is_op(Some(x), StmtOp::Report) {
                    one_report(x, &at, inner, w, out);
                } else {
                    walk(x, &at, inner, w, out);
                }
            }
        }
        _ => {}
    }
}

/// One report, at `path`, standing at `place`: where it stands (E1905), its
/// role in a pattern, its title and the names of its fields (E1903), and
/// what each field holds (E1904).
fn one_report(v: &Value, path: &str, place: Place<'_>, w: &Within<'_>, out: &mut Out<'_>) {
    let Some(s) = Stmt::of(v) else { return };
    let role = s.role().unwrap_or_default();
    let title = s.title().unwrap_or_default();
    if let Place::Not(place) = place {
        out.report(
            "E1905",
            format!(
                "The report \"{title}\" to {role} stands {}; a report stands in the body of a workflow or a pattern, outside a map's body, a loop without max_iter and a handler, since what it shows is shown a known number of times (spec/attention.md \"report\").",
                where_said(place, w)
            ),
            path,
            JsObject::new()
                .with("role", role)
                .with("title", title)
                .with("place", place),
        );
    }
    if let Some(slots) = &w.role_slots
        && !slots.contains(&role)
    {
        out.report(
            "E1903",
            format!(
                "The report \"{title}\" of pattern {} is to {role}, which is not one of its role slots; a pattern's report goes to a role slot, which each application binds to a role of its own (spec/attention.md \"report\").",
                w.name
            ),
            &format!("{path}/role"),
            JsObject::new()
                .with("pattern", w.name)
                .with("role", role)
                .with("problem", "role")
                .with(
                    "slots",
                    JsValue::Array(slots.iter().map(|s| JsValue::from(*s)).collect()),
                ),
        );
    }
    if let Some(p) = title_problem(title) {
        out.report(
            "E1903",
            format!(
                "The title of the report to {role} {}; {TITLE_RULES}.",
                p.said()
            ),
            &format!("{path}/title"),
            p.facts(JsObject::new().with("role", role).with("problem", "title")),
        );
    }
    let mut names: Vec<&str> = Vec::new();
    for (i, f) in s.fields().iter().enumerate() {
        let Some(f) = ReportField::of(f) else {
            continue;
        };
        let name = f.name().unwrap_or_default();
        let at = format!("{path}/fields/{i}");
        if names.contains(&name) {
            out.report(
                "E1903",
                format!(
                    "The report \"{title}\" to {role} has two fields named '{name}'; a person reads each field by its name."
                ),
                &format!("{at}/name"),
                JsObject::new()
                    .with("role", role)
                    .with("problem", "duplicate_field")
                    .with("field", name),
            );
        } else {
            names.push(name);
        }
        let Some(e) = f.value() else { continue };
        if let Some((what, where_at, callee)) = impurity(e, &format!("{at}/value"), w.len_taken) {
            out.report(
                "E1904",
                format!(
                    "Field '{name}' of the report \"{title}\" to {role} holds {}: a report's field is pure, and the one call it may hold is the built-in len, since a report shows values and does nothing (spec/attention.md \"report\").",
                    impure_said(what, callee.as_deref())
                ),
                &where_at,
                JsObject::new()
                    .with("role", role)
                    .with("field", name)
                    .with("problem", "impure")
                    .with("what", what)
                    .with_some("callee", callee.as_deref()),
            );
        }
    }
}

/// Where a message says a report stands.
fn where_said(place: &str, w: &Within<'_>) -> String {
    match place {
        "map" => "in a map's body".to_owned(),
        "loop" => "in a loop without max_iter".to_owned(),
        "on_error" => "in an on error handler".to_owned(),
        "on_unmet" => "in an on unmet handler".to_owned(),
        "on_budget_exceeded" => format!("in an on budget_exceeded handler of {}", w.name),
        "before_on_error" => {
            "directly before an on error, which would handle the statement before the report"
                .to_owned()
        }
        "test" => format!("in test \"{}\"", w.name),
        _ if w.name.is_empty() => format!("in the program's {place}"),
        _ if place == w.what => format!("in {} {}", w.what, w.name),
        _ => format!("in the {place} of {} {}", w.what, w.name),
    }
}

/// The first part of `e` (at `path`) that makes it impure, if one does:
/// what it is (the fact `what`, an expression's `op`), its path, and for a
/// call the callee's path. `len_taken`: a function or a slot named `len`
/// makes `len(…)` a call of it.
///
/// An allow-list, by the kind of expression: every kind is named, so that a
/// kind a later version adds is refused until someone decides. Pure are the
/// literals, a name, a field, a list, a set, a text template, a prompt, a
/// unary or a binary operator, a range, a record, a `switch`, each when
/// what it holds is pure; and a call of the built-in `len` with pure
/// arguments. Impure are every other call (a function's, a tool's,
/// `human.*`, another built-in), `delegate`, `spawn`, `await`, `infer`,
/// `verify`, `effect`, `changeset`, `map`, `plan`, `escalate`, `pause`
/// (spec/attention.md "What a field may be"), and two the specification's
/// list does not name: `try`, which can end the run, and a block, which
/// holds statements rather than a value.
pub(crate) fn impurity(
    e: Expr<'_>,
    path: &str,
    len_taken: bool,
) -> Option<(&'static str, String, Option<String>)> {
    let Some(op) = e.op() else {
        return Some(("unknown", path.to_owned(), None));
    };
    let impure = |what: &'static str| Some((what, path.to_owned(), None));
    match op {
        ExprOp::Int
        | ExprOp::Dec
        | ExprOp::Text
        | ExprOp::Bool
        | ExprOp::Money
        | ExprOp::Duration
        | ExprOp::Var => None,
        ExprOp::Field | ExprOp::Unary => e
            .operand()
            .and_then(|x| impurity(x, &format!("{path}/of"), len_taken)),
        ExprOp::List | ExprOp::Set => e
            .items()
            .enumerate()
            .find_map(|(i, x)| impurity(x, &format!("{path}/items/{i}"), len_taken)),
        ExprOp::Template | ExprOp::Prompt => e.parts().iter().enumerate().find_map(|(i, p)| {
            p.get("expr")
                .and_then(Expr::of)
                .and_then(|x| impurity(x, &format!("{path}/parts/{i}/expr"), len_taken))
        }),
        ExprOp::Binary => e
            .left()
            .and_then(|x| impurity(x, &format!("{path}/left"), len_taken))
            .or_else(|| {
                e.right()
                    .and_then(|x| impurity(x, &format!("{path}/right"), len_taken))
            }),
        ExprOp::Range => e
            .from()
            .and_then(|x| impurity(x, &format!("{path}/from"), len_taken))
            .or_else(|| {
                e.to()
                    .and_then(|x| impurity(x, &format!("{path}/to"), len_taken))
            }),
        ExprOp::Record => e.fields().find_map(|(k, v)| {
            Expr::of(v)
                .and_then(|x| impurity(x, &format!("{path}/fields/{}", ptr_token(k)), len_taken))
        }),
        ExprOp::Switch => e
            .on()
            .and_then(|x| impurity(x, &format!("{path}/on"), len_taken))
            .or_else(|| {
                e.cases().enumerate().find_map(|(i, c)| {
                    c.then()
                        .and_then(|x| impurity(x, &format!("{path}/cases/{i}/then"), len_taken))
                })
            }),
        ExprOp::Call => {
            let callee = e.callee().and_then(callee_path);
            let len = !len_taken
                && e.callee()
                    .is_some_and(|c| c.is(ExprOp::Var) && c.name() == Some("len"));
            if !len {
                return Some(("call", path.to_owned(), callee));
            }
            e.arg_values().iter().enumerate().find_map(|(i, a)| {
                a.get("value")
                    .and_then(Expr::of)
                    .and_then(|x| impurity(x, &format!("{path}/args/{i}/value"), len_taken))
            })
        }
        ExprOp::Infer => impure("infer"),
        ExprOp::Delegate => impure("delegate"),
        ExprOp::Spawn => impure("spawn"),
        ExprOp::Await => impure("await"),
        ExprOp::Verify => impure("verify"),
        ExprOp::Effect => impure("effect"),
        ExprOp::Escalate => impure("escalate"),
        ExprOp::Pause => impure("pause"),
        ExprOp::Try => impure("try"),
        ExprOp::Block => impure("block"),
        ExprOp::Changeset => impure("changeset"),
        ExprOp::Map => impure("map"),
        ExprOp::Plan => impure("plan"),
    }
}

/// What a message says an impure part is.
fn impure_said(what: &str, callee: Option<&str>) -> String {
    match what {
        "call" => match callee {
            Some(c) if c.starts_with("human.") || c == "human" => {
                format!("a call of {c}, which asks a person")
            }
            Some(c) => format!("a call of {c}"),
            None => "a call".to_owned(),
        },
        "infer" => "an inference".to_owned(),
        "delegate" => "a delegation".to_owned(),
        "spawn" => "a spawn".to_owned(),
        "await" => "an await".to_owned(),
        "verify" => "a verification".to_owned(),
        "effect" => "an effect".to_owned(),
        "escalate" => "an escalation".to_owned(),
        "pause" => "a pause".to_owned(),
        "try" => "a try, which can end the run".to_owned(),
        "block" => "a block of statements".to_owned(),
        "changeset" => "a change set".to_owned(),
        "map" => "a map".to_owned(),
        "plan" => "a plan".to_owned(),
        _ => "an expression the check does not know".to_owned(),
    }
}

/// The scalar types a person is shown as they are.
const SCALARS: [&str; 7] = ["Int", "Dec", "Bool", "Text", "Money", "Duration", "Time"];

/// `ty` with its aliases followed and its wrappers (`Verified`, `Inferred`,
/// `Untrusted`) taken off, as often as they stand around each other.
fn bare(ty: &Ty, env: &dyn TypeEnv) -> Ty {
    let mut t = ty.clone();
    for _ in 0..=crate::ty::UNALIAS_DEPTH {
        let next = epistemic(&unalias(&t, env)).inner;
        if next == t {
            break;
        }
        t = next;
    }
    t
}

/// Whether `t` (bare) is a scalar a person reads, or an enum.
fn scalar_or_enum(t: &Ty, env: &dyn TypeEnv) -> bool {
    match t {
        Ty::Named(n) if n.args.is_empty() && SCALARS.contains(&n.name.as_str()) => true,
        Ty::Named(n) => env
            .type_def(&n.name)
            .and_then(peeled_type)
            .is_some_and(|te| te.has(TypeForm::Enum)),
        _ => false,
    }
}

/// The element of an `Option` or a `List` (bare), with the container's name.
fn element(t: &Ty) -> Option<(&str, &Ty)> {
    match t {
        Ty::Named(n) if n.args.len() == 1 && (n.name == "Option" || n.name == "List") => {
            Some((n.name.as_str(), &n.args[0]))
        }
        _ => None,
    }
}

/// Whether `t` (bare) is a scalar, an enum, or an `Option` or a `List` of
/// one of them, each optionally wrapped.
fn flat(t: &Ty, env: &dyn TypeEnv) -> bool {
    scalar_or_enum(t, env) || element(t).is_some_and(|(_, x)| scalar_or_enum(&bare(x, env), env))
}

/// Why a person is not shown a value of type `ty`, when they are not: what
/// a report's field may be (spec/attention.md "What a field may be"), `Int`,
/// `Dec`, `Bool`, `Text`, `Money`, `Duration`, `Time`, an enum, an `Option`
/// or a `List` of one of these, or a record of these one level deep, each of
/// them optionally inside `Verified`, `Inferred` or `Untrusted` (an alias is
/// what it names). A type the check does not know is not shown either.
#[must_use]
pub fn not_shown(ty: &Ty, env: &dyn TypeEnv) -> Option<String> {
    let t = bare(ty, env);
    if flat(&t, env) {
        return None;
    }
    if let Some((c, x)) = element(&t) {
        let a = if c == "Option" { "an" } else { "a" };
        return Some(format!(
            "{a} {c} is shown when it holds a scalar or an enum, and this one holds {}",
            crate::ty::show(x)
        ));
    }
    if matches!(t, Ty::Unknown) {
        return Some("the check does not know its type".to_owned());
    }
    if let Some(fields) = fields_of(&t, env) {
        for (k, ft) in &fields {
            if !flat(&bare(ft, env), env) {
                return Some(format!(
                    "a record is shown one level deep, of scalars, enums and Options or Lists of them, and its field '{k}' is of type {}",
                    crate::ty::show(ft)
                ));
            }
        }
        return None;
    }
    Some("it is no scalar, enum, Option, List or record".to_owned())
}

/// How a value of type `ty` is known, as a person is told (spec/attention.md
/// "Masking and how a value is known"): the level of its type, the weakest
/// wrapper deciding, among the wrappers around it and those around its
/// elements or fields (a list of a model's outputs is a model's output). A
/// position with no wrapper of its own says nothing: `Verified<List<Int>>`
/// is verified.
#[must_use]
pub fn known(ty: &Ty, env: &dyn TypeEnv) -> Level {
    let outer = epistemic(&unalias(ty, env));
    let mut level = outer_level(ty, env);
    let t = bare(&outer.inner, env);
    let mut inner: Vec<Ty> = Vec::new();
    if let Some((_, x)) = element(&t) {
        inner.push(x.clone());
    } else if let Some(fields) = fields_of(&t, env) {
        for (_, ft) in fields {
            match element(&bare(&ft, env)) {
                Some((_, x)) => {
                    inner.push(ft.clone());
                    inner.push(x.clone());
                }
                None => inner.push(ft),
            }
        }
    }
    for x in &inner {
        if let Some(l) = wrapped_level(x, env)
            && level_rank(l) > level_rank(level)
        {
            level = l;
        }
    }
    level
}

/// The level of the wrappers around `ty`, its aliases followed: the weakest
/// of them, `plain` with none.
fn outer_level(ty: &Ty, env: &dyn TypeEnv) -> Level {
    wrapped_level(ty, env).unwrap_or(Level::Plain)
}

/// The weakest level of the wrappers around `ty`, through its aliases, or
/// `None` when it has none.
fn wrapped_level(ty: &Ty, env: &dyn TypeEnv) -> Option<Level> {
    let mut t = ty.clone();
    let mut found: Option<Level> = None;
    for _ in 0..=crate::ty::UNALIAS_DEPTH {
        let u = unalias(&t, env);
        let e = epistemic(&u);
        let wrapped = e.inner != u;
        if wrapped {
            found = Some(match found {
                Some(f) if level_rank(f) >= level_rank(e.level) => f,
                _ => e.level,
            });
        }
        if e.inner == t {
            break;
        }
        t = e.inner;
    }
    found
}

/// The name a person is told how a value is known by (spec/attention.md
/// "Masking and how a value is known"): `verified`, `plain`, `model` for
/// `Inferred`, `external` for `Untrusted`.
#[must_use]
pub const fn known_name(level: Level) -> &'static str {
    match level {
        Level::Verified => "verified",
        Level::Plain => "plain",
        Level::Inferred => "model",
        Level::Untrusted => "external",
    }
}

#[cfg(test)]
mod tests {
    use super::{known, known_name, not_shown};
    use crate::ty::{Ty, TypeEnv, named, named0};
    use mandate_ir::{Value, parse};

    /// A type environment of hand-written type definitions.
    struct Env(Vec<(&'static str, Value)>);

    impl TypeEnv for Env {
        fn type_def(&self, name: &str) -> Option<&Value> {
            self.0.iter().find(|(n, _)| *n == name).map(|(_, v)| v)
        }

        fn is_contract(&self, _: &str) -> bool {
            false
        }
    }

    fn def(text: &str) -> Value {
        parse(text).unwrap().value
    }

    fn env() -> Env {
        Env(vec![
            (
                "Color",
                def(r#"{"kind":"type","type":{"enum":["red","green"]}}"#),
            ),
            ("Cents", def(r#"{"kind":"type","type":{"ref":"Int"}}"#)),
            (
                "Guess",
                def(r#"{"kind":"type","type":{"ref":"Inferred","args":[{"ref":"Text"}]}}"#),
            ),
            (
                "Line",
                def(
                    r#"{"kind":"type","type":{"record":{"n":{"ref":"Int"},"tags":{"ref":"List","args":[{"ref":"Text"}]},"why":{"ref":"Inferred","args":[{"ref":"Text"}]}}}}"#,
                ),
            ),
            (
                "Deep",
                def(r#"{"kind":"type","type":{"record":{"line":{"ref":"Line"}}}}"#),
            ),
        ])
    }

    fn t(name: &str) -> Ty {
        named0(name)
    }

    #[test]
    fn what_a_person_is_shown() {
        let e = env();
        let wrap = |w: &str, x: Ty| named(w, vec![x]);
        for ty in [
            t("Int"),
            t("Dec"),
            t("Bool"),
            t("Text"),
            t("Money"),
            t("Duration"),
            t("Time"),
            t("Color"),
            t("Cents"),
            t("Guess"),
            wrap("Inferred", t("Text")),
            named("Verified", vec![t("Int"), t("C")]),
            wrap("Untrusted", t("Text")),
            wrap("List", t("Int")),
            wrap("Option", wrap("Inferred", t("Color"))),
            wrap("Inferred", wrap("List", wrap("Untrusted", t("Text")))),
            t("Line"),
            wrap("Verified", t("Line")),
            Ty::Record {
                fields: vec![("a".to_owned(), t("Int"))],
            },
        ] {
            assert_eq!(not_shown(&ty, &e), None, "{ty:?}");
        }
        for ty in [
            Ty::Unknown,
            t("Path"),
            t("Receipt"),
            wrap("Set", t("Int")),
            wrap("List", wrap("List", t("Int"))),
            wrap("Option", t("Line")),
            t("Deep"),
            named("Declined", vec![t("Text")]),
            named("Outcome", vec![t("Int")]),
            Ty::Record {
                fields: vec![("a".to_owned(), t("Line"))],
            },
        ] {
            assert!(not_shown(&ty, &e).is_some(), "{ty:?}");
        }
    }

    #[test]
    fn how_a_value_is_known_the_weakest_wrapper_deciding() {
        let e = env();
        let wrap = |w: &str, x: Ty| named(w, vec![x]);
        let k = |ty: Ty| known_name(known(&ty, &e));
        assert_eq!(k(t("Int")), "plain");
        assert_eq!(k(wrap("Inferred", t("Text"))), "model");
        assert_eq!(k(wrap("Untrusted", t("Text"))), "external");
        assert_eq!(k(named("Verified", vec![t("Text"), t("C")])), "verified");
        // An alias of a model's output is one.
        assert_eq!(k(t("Guess")), "model");
        assert_eq!(k(wrap("List", t("Guess"))), "model");
        // The weakest wrapper decides, around the value or its elements.
        assert_eq!(
            k(wrap("Inferred", wrap("Untrusted", t("Text")))),
            "external"
        );
        assert_eq!(k(wrap("Verified", wrap("Inferred", t("Text")))), "model");
        assert_eq!(k(wrap("List", wrap("Inferred", t("Text")))), "model");
        assert_eq!(k(wrap("Option", wrap("Untrusted", t("Color")))), "external");
        assert_eq!(
            k(wrap("Verified", wrap("List", wrap("Inferred", t("Int"))))),
            "model"
        );
        // A record of a model's output in one field is one.
        assert_eq!(k(t("Line")), "model");
        assert_eq!(k(wrap("Verified", t("Line"))), "model");
        // A position with no wrapper says nothing: a verified list is verified;
        // a list the run made of verified items is the run's.
        assert_eq!(k(wrap("Verified", wrap("List", t("Int")))), "verified");
        assert_eq!(k(wrap("List", wrap("Verified", t("Int")))), "plain");
        assert_eq!(
            k(Ty::Record {
                fields: vec![
                    ("a".to_owned(), wrap("Verified", t("Int"))),
                    ("b".to_owned(), wrap("Inferred", t("Int"))),
                ]
            }),
            "model"
        );
    }
}
