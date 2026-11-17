//! Patterns and their expansion (language 0.6, spec/library.md "Patterns"),
//! which only the Rust compiler reads.
//!
//! [`expand`] runs in [`crate::check()`] after the role checks and the check
//! of imported method limits (E1804), and before the static checks, on a
//! program with no error so far. It checks every pattern the program
//! defines (E1301, E1302, E1306, E1307 inside its body; `pattern.rs`), and
//! every workflow that applies one: the application is the whole definition
//! of the workflow (E1307), names a pattern (E1303), gives each slot one
//! argument of its kind (E1304) that fits (E1305, `apply.rs`), and means
//! one thing by every name (E1306, E1602). It then writes the expanded
//! program: each such workflow with the pattern's run parameters, result and
//! body, the slots filled in (`subst.rs`), its own `caps` and `budget`.
//!
//! The expanded program is an ordinary program of 0.6 with no `apply` in
//! it, which the static checks, the lock checks and every other rule read
//! as if it had been written out. It names a definition of an imported
//! pattern's module through its `use` list, as any program does: the
//! definition is added to the list of that module's `use` (and a module of
//! the standard library the body names, `human` of `human.review`, to the
//! `use std`), so a pattern applied from another module may name only that
//! module's `pub` definitions (E1602 at the application), and a name it adds
//! may not mean something else in the applying program already (E1306).
//! New names and new `use`s are put after the ones written, so that every
//! path into the program's `uses` stays where it was.
//!
//! A diagnostic found in the expansion comes back to the program through the
//! origin map ([`Expansion::map`]): at the slot argument whose value it is
//! about (with `slot` and `expanded_path` in its facts), or at the
//! application, `/defs/W/apply`, with the pattern's own path in its facts
//! (`pattern`, `pattern_path`, and `module` for an imported pattern). Its
//! `at.path` always points into the program that was checked.

mod apply;
mod pattern;
mod subst;
mod walk;

use std::collections::HashMap;
use std::rc::Rc;

use mandate_ir::{
    Application, DefKind, Definition, Diagnostic, JsObject, JsValue, Language, Location, Map,
    PatternDef, Program, Spans, Value, has_errors, nearest_span, ptr,
};

use crate::caps::CapOptions;
use crate::modules::{Linked, Modules, link};

use apply::{Env, Names, Reader};
use pattern::{Meaning, Problem, Site, article, check_pattern, places, slots_of};
use subst::{Origin, Subst};
use walk::{Named, Scope};

/// What one workflow's expansion records of where its places come from.
#[derive(Clone, Debug, PartialEq)]
struct Origins {
    /// The workflow's path, `/defs/W`.
    base: String,
    /// The application's path, `/defs/W/apply`.
    apply: String,
    /// The pattern's name.
    pattern: String,
    /// The module that defines it, when it is imported.
    module: Option<String>,
    /// Each place written, by its path in the expansion, longest first.
    records: Vec<(String, Origin)>,
}

/// What [`expand`] gives.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Expansion {
    /// The expanded program, when the program applies a pattern and every
    /// application expanded.
    pub program: Option<Value>,
    /// What the checks of the patterns and the applications found, at
    /// paths into the program.
    pub diagnostics: Vec<Diagnostic>,
    origins: Vec<Origins>,
    /// The `use`s the expansion added, by index, with the application that
    /// needs each.
    added_uses: Vec<(usize, String)>,
}

/// Whether `program` applies a pattern: a workflow of it carries `apply`.
#[must_use]
pub fn applies_pattern(program: &Value) -> bool {
    Program::of(program).is_some_and(|p| {
        p.definitions()
            .any(|(_, d)| d.kind() == Some(DefKind::Workflow) && d.value().get("apply").is_some())
    })
}

/// The expanded program of `program` with `modules`, when it applies a
/// pattern and every application expands; `None` otherwise. For the views
/// of a program, which read a workflow's body: it checks nothing more, and
/// a program that does not check should not be shown.
#[must_use]
pub fn expanded_program(program: &Value, modules: Option<&Modules>) -> Option<Value> {
    expanded_program_reaching(program, modules, None)
}

/// [`expanded_program`], the modules linked through `reach` (0.6: the
/// modules of libraries, [`crate::Reach`]).
#[must_use]
pub fn expanded_program_reaching(
    program: &Value,
    modules: Option<&Modules>,
    reach: Option<&crate::modules::Reach>,
) -> Option<Value> {
    let view = Program::of(program)?;
    if !applies_pattern(program) {
        return None;
    }
    // 0.6: the built-in `std.patterns`, when the program imports it and the
    // modules do not hold it.
    let with_builtin = crate::library::with_builtin(view, modules);
    let modules = with_builtin.as_ref().or(modules);
    let linked = crate::modules::link_reaching(view, modules, reach);
    let e = expand(
        view,
        &linked,
        &ExpandOptions {
            modules,
            reach,
            applications: true,
            ..ExpandOptions::default()
        },
    );
    if has_errors(&e.diagnostics) {
        None
    } else {
        e.program
    }
}

/// The program a view of `program` reads (spec/library.md "Expansion"):
/// its expansion when it applies a pattern, with `modules` the modules its
/// patterns come from. When an application cannot be expanded (its pattern
/// is in a module the view is not given), that workflow is a stand-in that
/// shows no less than the expansion may do: a step that names the
/// application, `P(slot: argument, …)`, then, for what each argument names
/// (read with the modules that are given), a delegation for a skill of an
/// agent, an effect for an effect (one of the program's, or a std effect)
/// and for a tool `c.t` that is not known to be read-only (a write tool runs
/// only as an effect), and a review by each role, which is how a pattern
/// asks a person by a role slot (an approval or an escalation the view
/// cannot tell apart without the pattern). The stand-in carries
/// `unexpanded: { pattern, module? }`, by which a view says that what it
/// bounds (the cost) is unknown rather than show a number. `None` when the
/// program applies no pattern, which a view reads as it is.
#[must_use]
pub fn for_views(program: &Value, modules: Option<&Modules>) -> Option<Value> {
    if !applies_pattern(program) {
        return None;
    }
    if let Some(e) = expanded_program(program, modules) {
        return Some(e);
    }
    let view = Program::of(program)?;
    let with_builtin = crate::library::with_builtin(view, modules);
    let modules = with_builtin.as_ref().or(modules);
    let linked = link(view, modules).defs;
    let mut members = view.members().clone();
    let mut defs = Map::new();
    for (n, d) in view.definitions() {
        let Some(a) = Application::of_workflow(d.value()) else {
            defs.insert(n, d.value().clone());
            continue;
        };
        let args: Vec<Value> = a
            .args()
            .map(|arg| {
                let mut m = Map::new();
                m.insert("name", arg.name().unwrap_or_default());
                let value = arg.members().get("value").cloned().unwrap_or_else(|| {
                    let mut v = Map::new();
                    v.insert("op", "var");
                    v.insert(
                        "name",
                        crate::view_shared::js_text(arg.members().get("type")),
                    );
                    Value::Object(v)
                });
                m.insert("value", value);
                Value::Object(m)
            })
            .collect();
        let mut callee = Map::new();
        callee.insert("op", "var");
        callee.insert("name", a.pattern().unwrap_or_default());
        let mut call = Map::new();
        call.insert("op", "call");
        call.insert("callee", Value::Object(callee));
        call.insert("args", Value::Array(args));
        let step = |value: Map| {
            let mut s = Map::new();
            s.insert("op", "expr");
            s.insert("value", Value::Object(value));
            Value::Object(s)
        };
        let mut body = vec![step(call)];
        // And what the definitions the view can see say of its arguments.
        let def = |name: &str| linked.get(name).map(Definition::of);
        let kind = |name: &str| def(name).and_then(Definition::kind);
        for arg in a.args() {
            let Some(e) = arg.value() else { continue };
            // `Agent.skill`: a delegation the expansion may make.
            if e.is(mandate_ir::ExprOp::Field)
                && let Some(agent) = e
                    .operand()
                    .filter(|o| o.is(mandate_ir::ExprOp::Var))
                    .and_then(mandate_ir::Expr::name)
                && kind(agent) == Some(DefKind::Agent)
            {
                let mut dl = Map::new();
                dl.insert("op", "delegate");
                dl.insert("agent", agent);
                dl.insert("skill", e.name().unwrap_or_default());
                dl.insert("args", Value::Array(Vec::new()));
                body.push(step(dl));
                continue;
            }
            let name = apply::dotted(e).unwrap_or_default();
            // A role: a person the expansion may ask.
            if e.is(mandate_ir::ExprOp::Var) && kind(&name) == Some(DefKind::Role) {
                let mut callee = Map::new();
                callee.insert("op", "field");
                callee.insert("of", var_of("human"));
                callee.insert("name", "review");
                let mut role = Map::new();
                role.insert("name", "role");
                role.insert("value", var_of(&name));
                let mut call = Map::new();
                call.insert("op", "call");
                call.insert("callee", Value::Object(callee));
                call.insert("args", Value::Array(vec![Value::Object(role)]));
                body.push(step(call));
                continue;
            }
            // An effect, or a tool `c.t` not known to be read-only (its
            // connector in a module the view is not given, or a write tool):
            // an effect the expansion may run.
            let maybe_write = name.split_once('.').is_some_and(|(c, t)| match def(c) {
                None => true,
                Some(d) => mandate_ir::ConnectorDef::of(d.value())
                    .is_some_and(|conn| conn.tool(t).is_none_or(|tool| tool.is_write())),
            });
            let effect = match kind(&name) {
                Some(k) => k == DefKind::Effect,
                None => crate::stdlib::std_effect(&name).is_some() || maybe_write,
            };
            if effect {
                let mut ef = Map::new();
                ef.insert("op", "effect");
                ef.insert("name", name);
                ef.insert("args", Value::Array(Vec::new()));
                body.push(step(ef));
            }
        }
        let mut wf = d.value().as_object().cloned().unwrap_or_default();
        wf.remove("apply");
        wf.insert("params", Value::Array(Vec::new()));
        wf.insert("returns", subst::type_ref("?"));
        wf.insert("body", Value::Array(body));
        let mut unexpanded = Map::new();
        let pattern = a.pattern().unwrap_or_default();
        unexpanded.insert("pattern", pattern);
        if let Some(m) = imported_from(view, pattern) {
            unexpanded.insert("module", m);
        }
        wf.insert("unexpanded", Value::Object(unexpanded));
        defs.insert(n, Value::Object(wf));
    }
    members.insert("defs", defs);
    Some(Value::Object(members))
}

/// `{ op: "var", name }`.
fn var_of(name: &str) -> Value {
    let mut m = Map::new();
    m.insert("op", "var");
    m.insert("name", name);
    Value::Object(m)
}

/// `problem` as a diagnostic at `base` + its path, with `spans`.
fn at_path(problem: Problem, base: &str, spans: Option<&Spans>) -> Diagnostic {
    let path = format!("{base}{}", problem.at);
    let span = nearest_span(spans, &path);
    Diagnostic::new(
        problem.code,
        problem.message,
        Location::path_span(path, span),
        Some(*problem.facts),
    )
}

/// A module an application's pattern comes from: its definitions with its
/// own imports linked, and the errors the resolver finds in it, read as
/// the module it is. A module handed to the check as IR was checked by no
/// one; a pattern of one whose names do not resolve there is not applied.
struct Home {
    linked: Map,
    unresolved: Vec<Diagnostic>,
}

/// The members a workflow that applies a pattern may have besides
/// `apply`: what the application writes, `caps` and `budget` (and in 0.7
/// its `owner`, which only a 0.7 schema lets a workflow hold), and what any
/// definition of 0.6 has.
const APPLICATION_MEMBERS: [&str; 7] = ["kind", "apply", "caps", "owner", "budget", "pub", "doc"];

/// What [`expand`] is given besides the program.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ExpandOptions<'a> {
    /// The modules the check was given.
    pub modules: Option<&'a Modules>,
    /// 0.6: what each module of a library reaches ([`crate::Reach`]): a
    /// pattern of one may name what its module imports from a module it
    /// reaches, which the expansion names through that module's `use`.
    pub reach: Option<&'a crate::modules::Reach>,
    /// The program's spans.
    pub spans: Option<&'a Spans>,
    /// The module whose definitions the program names as its own, `pub`
    /// or not: a sub-program's parent (`crate::imports::parent_of_subprogram`).
    pub own: Option<&'a str>,
    /// Whether the applications are checked and expanded: only in a program
    /// with no error so far, whose names all resolve. The patterns it
    /// defines are checked whatever it has.
    pub applications: bool,
}

/// The checks of the patterns `program` defines and of the applications it
/// makes, and the expanded program (spec/library.md "Expansion"). `linked`
/// is `link(program, opts.modules)`.
#[must_use]
pub fn expand(program: Program<'_>, linked: &Linked, opts: &ExpandOptions<'_>) -> Expansion {
    let (modules, spans) = (opts.modules, opts.spans);
    let mut out = Expansion::default();
    if !program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_6))
    {
        return out;
    }
    // The patterns the program defines, each checked on its own.
    let mut bad_local: Vec<&str> = Vec::new();
    for (name, d) in program.definitions() {
        if d.kind() != Some(DefKind::Pattern) {
            continue;
        }
        let site = Site {
            name,
            value: d.value(),
            home: program,
            linked: &linked.defs,
        };
        let problems = check_pattern(&site);
        if problems.iter().any(|p| p.code.starts_with('E')) {
            bad_local.push(name);
        }
        let base = site.base();
        out.diagnostics
            .extend(problems.into_iter().map(|p| at_path(p, &base, spans)));
    }
    if !opts.applications {
        return out;
    }
    // The modules an application's pattern comes from, linked and resolved
    // once.
    let mut homes: HashMap<String, Home> = HashMap::new();
    for (_, d) in program.definitions() {
        let Some(a) = Application::of_workflow(d.value()) else {
            continue;
        };
        let Some(p) = a.pattern() else { continue };
        if let Some(module) = imported_from(program, p)
            && let Some(m) = modules.and_then(|ms| ms.get(module)).and_then(Program::of)
        {
            homes.entry(module.to_owned()).or_insert_with(|| {
                let linked = crate::modules::link_reaching(m, modules, opts.reach).defs;
                let unresolved = crate::resolve::resolve_names(m, None, Some(&linked))
                    .into_iter()
                    .filter(|d| d.severity == mandate_ir::Severity::Error)
                    .collect();
                Home { linked, unresolved }
            });
        }
    }
    let mut expanded: Vec<(String, Value)> = Vec::new();
    let mut additions: Vec<(String, String, String)> = Vec::new();
    let mut failed = false;
    let mut any = false;
    for (name, d) in program.definitions() {
        let Some(a) = Application::of_workflow(d.value()) else {
            continue;
        };
        any = true;
        let base = ptr(&[&"defs", &name]);
        let before = out.diagnostics.len();
        match application(
            program,
            linked,
            opts,
            &homes,
            name,
            d.value(),
            a,
            &bad_local,
        ) {
            Ok((w, origins, adds)) => {
                expanded.push((name.to_owned(), w));
                out.origins.push(origins);
                additions.extend(
                    adds.into_iter()
                        .map(|(m, n)| (m, n, format!("{base}/apply"))),
                );
            }
            Err(diags) => {
                out.diagnostics.extend(diags);
                failed = true;
            }
        }
        if has_errors(out.diagnostics.get(before..).unwrap_or_default()) {
            failed = true;
        }
    }
    if !any || failed || has_errors(&out.diagnostics) {
        return out;
    }
    // The expanded program: every application replaced by its expansion,
    // the names it needs added to the `use`s.
    let mut members = program.members().clone();
    let mut defs = Map::new();
    for (n, d) in program.definitions() {
        match expanded.iter().find(|(e, _)| e == n) {
            Some((_, w)) => defs.insert(n, w.clone()),
            None => defs.insert(n, d.value().clone()),
        };
    }
    members.insert("defs", defs);
    let mut uses: Vec<Value> = program.use_values().to_vec();
    for (module, n, app) in additions {
        let found = uses.iter_mut().find(|u| {
            u.get("module").and_then(Value::as_str) == Some(module.as_str())
                && u.get("names").and_then(Value::as_array).is_some()
        });
        match found {
            Some(Value::Object(u)) => {
                if let Some(Value::Array(names)) = u.get_mut("names")
                    && !names.iter().any(|x| x.as_str() == Some(n.as_str()))
                {
                    names.push(Value::from(n.as_str()));
                }
            }
            _ => {
                let mut u = Map::new();
                u.insert("module", module.as_str());
                u.insert("names", Value::Array(vec![Value::from(n.as_str())]));
                out.added_uses.push((uses.len(), app));
                uses.push(Value::Object(u));
            }
        }
    }
    if !uses.is_empty() {
        members.insert("uses", Value::Array(uses));
    }
    out.program = Some(Value::Object(members));
    out
}

/// A diagnostic at `path`, with the span `spans` have for it.
fn push(
    diags: &mut Vec<Diagnostic>,
    spans: Option<&Spans>,
    code: &str,
    message: String,
    path: String,
    facts: JsObject,
) {
    let span = nearest_span(spans, &path);
    diags.push(Diagnostic::new(
        code,
        message,
        Location::path_span(path, span),
        Some(facts),
    ));
}

/// The module whose `use` list names `name`, when a `use` of a module that
/// is not the standard library's lists it.
fn imported_from<'a>(program: Program<'a>, name: &str) -> Option<&'a str> {
    program
        .imports()
        .find(|u| u.module().is_some_and(|m| m != "std") && u.names().any(|n| n == name))
        .and_then(|u| u.module())
}

/// The expansion of one workflow, with its origins and the names it needs
/// added to the program's `use`s; or the diagnostics that stop it.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn application<'a>(
    program: Program<'a>,
    linked: &'a Linked,
    opts: &ExpandOptions<'a>,
    homes: &'a HashMap<String, Home>,
    name: &str,
    w: &'a Value,
    a: Application<'a>,
    bad_local: &[&str],
) -> Result<(Value, Origins, Vec<(String, String)>), Vec<Diagnostic>> {
    let (modules, spans) = (opts.modules, opts.spans);
    let base = ptr(&[&"defs", &name]);
    let apply_at = format!("{base}/apply");
    let mut diags: Vec<Diagnostic> = Vec::new();
    // The application is the whole definition of the workflow.
    for (k, _) in w.as_object().into_iter().flat_map(Map::iter) {
        if APPLICATION_MEMBERS.contains(&k) {
            continue;
        }
        let what = match k {
            "envelope" => "an envelope",
            "params" => "parameters",
            "returns" => "a result",
            "body" => "a body",
            "ensures" => "an 'ensures'",
            "on" => "event handlers",
            other => other,
        };
        push(
            &mut diags,
            spans,
            "E1307",
            format!(
                "Workflow {name} applies a pattern, which is the whole of its definition with its caps and its budget; it has {what} too. Its parameters, result and body are the pattern's (spec/library.md \"Application\")."
            ),
            format!("{base}/{}", mandate_ir::ptr_token(k)),
            JsObject::new()
                .with("workflow", name)
                .with("problem", "member")
                .with("member", k),
        );
    }
    let p = a.pattern().unwrap_or_default();
    let names = Names {
        program,
        linked: &linked.defs,
    };
    // The pattern: the program's own, or one a `use` list names from a
    // module the check was given.
    let module = if program.defs().is_some_and(|d| d.contains_key(p)) {
        None
    } else {
        imported_from(program, p)
    };
    let (value, home, home_linked): (&Value, Program<'_>, &Map) = match module {
        None => match program.defs().and_then(|d| d.get(p)) {
            Some(v) => (v, program, &linked.defs),
            None => {
                push(
                    &mut diags,
                    spans,
                    "E1303",
                    format!(
                        "Workflow {name} applies {p}, which names no definition of this program and no name a use list brings."
                    ),
                    format!("{apply_at}/pattern"),
                    JsObject::new().with("workflow", name).with("pattern", p),
                );
                return Err(diags);
            }
        },
        Some(m) => {
            let home = modules.and_then(|ms| ms.get(m)).and_then(Program::of);
            let found = home.and_then(|h| h.defs().and_then(|d| d.get(p)).map(|v| (v, h)));
            match (found, homes.get(m)) {
                (Some((v, h)), Some(l)) => (v, h, &l.linked),
                _ => {
                    push(
                        &mut diags,
                        spans,
                        "E1303",
                        format!(
                            "Workflow {name} applies {p}, which module {m} does not define here: the check is not given the module."
                        ),
                        format!("{apply_at}/pattern"),
                        JsObject::new()
                            .with("workflow", name)
                            .with("pattern", p)
                            .with("module", m),
                    );
                    return Err(diags);
                }
            }
        }
    };
    let Some(pdef) = PatternDef::of(value) else {
        let kind = Definition::of(value)
            .kind()
            .map_or("definition", DefKind::as_str);
        push(
            &mut diags,
            spans,
            "E1303",
            format!(
                "Workflow {name} applies {p}, which is {} {kind}, not a pattern.",
                article(kind)
            ),
            format!("{apply_at}/pattern"),
            JsObject::new()
                .with("workflow", name)
                .with("pattern", p)
                .with("kind", kind)
                .with_some("module", module),
        );
        return Err(diags);
    };
    let site = Site {
        name: p,
        value,
        home,
        linked: home_linked,
    };
    let pattern_base = site.base();
    // An imported pattern is checked again where it is applied, so that a
    // module that was not checked carries nothing in unseen.
    if let Some(m) = module {
        for problem in check_pattern(&site) {
            let mut facts = *problem.facts;
            facts.insert("module", m);
            facts.insert("pattern_path", format!("{pattern_base}{}", problem.at));
            push(
                &mut diags,
                spans,
                problem.code,
                problem.message,
                apply_at.clone(),
                facts,
            );
        }
        // Its names resolve in its module, or it is not applied: a name the
        // module does not know is never looked up in this program.
        let unresolved = homes
            .get(m)
            .map(|h| h.unresolved.as_slice())
            .unwrap_or_default();
        let foreign = Foreign {
            program,
            linked,
            pattern: p,
            value,
            module: m,
            apply_at: &apply_at,
            spans,
        };
        for d in unresolved {
            let at = d.at.path.as_deref().unwrap_or_default();
            if under(at, &pattern_base) {
                let n = d
                    .facts
                    .as_ref()
                    .and_then(|f| f.get("name"))
                    .and_then(JsValue::as_str);
                match n {
                    Some(n) if d.code == "MDT-E0120" => foreign.unknown(&mut diags, n, at),
                    _ => foreign.again(&mut diags, d, "pattern_path"),
                }
            } else {
                foreign.again(&mut diags, d, "module_path");
            }
        }
    } else if bad_local.contains(&p) {
        return Err(diags);
    }
    if has_errors(&diags) {
        return Err(diags);
    }
    let generics: Vec<&str> = pdef.generics().iter().filter_map(Value::as_str).collect();
    let slot_values: Vec<&Value> = pdef.slot_values().iter().collect();
    let all = places(pdef);
    let counted: Vec<String> = all
        .iter()
        .filter_map(|pl| match &pl.named {
            Named::Count(n) => Some(n.clone()),
            _ => None,
        })
        .collect();
    let reader = Reader {
        base: base.clone(),
        pattern: p,
        names,
        env: Env {
            first: &linked.defs,
            second: home_linked,
        },
        opts: CapOptions {
            language: program.language(),
        },
        counted,
    };
    let read = reader.read(a, &generics, &slot_values);
    for problem in read.problems {
        push(
            &mut diags,
            spans,
            problem.code,
            problem.message,
            problem.at,
            *problem.facts,
        );
    }
    if has_errors(&diags) {
        return Err(diags);
    }
    // What the expansion names in the pattern's home, which the applying
    // program names through its `use` list.
    let mut adds: Vec<(String, String)> = Vec::new();
    if let Some(m) = module {
        let slots = slots_of(pdef);
        let mut seen: Vec<String> = Vec::new();
        for place in &all {
            let n = match &place.named {
                Named::Var { name: n, .. } if !place.shadowed => n,
                Named::Type { name: n, .. } | Named::Record(n) | Named::Contract(n) => n,
                _ => continue,
            };
            if slots.iter().any(|(s, _)| s == n)
                || generics.contains(&n.as_str())
                || seen.contains(n)
            {
                continue;
            }
            seen.push(n.clone());
            let facts = || {
                JsObject::new()
                    .with("pattern", p)
                    .with("module", m)
                    .with("name", n.as_str())
                    .with("pattern_path", format!("{pattern_base}{}", place.path))
            };
            match site.meaning(n) {
                Meaning::Own(d) => {
                    // A sub-program names its parent's definitions freely.
                    if d.get("pub") != Some(&Value::Bool(true)) && opts.own != Some(m) {
                        push(
                            &mut diags,
                            spans,
                            "E1602",
                            format!(
                                "{p} names {n}, which is not a pub definition of {m}: its expansion names {n} in this program, which may name only what {m} makes pub."
                            ),
                            apply_at.clone(),
                            facts(),
                        );
                        continue;
                    }
                    match taken(program, n, Some(m)) {
                        Some(how) => push(
                            &mut diags,
                            spans,
                            "E1306",
                            format!(
                                "{p}'s expansion names {n} of {m}, and this program {how} {n} already."
                            ),
                            apply_at.clone(),
                            facts().with("problem", "taken"),
                        ),
                        None => adds.push((m.to_owned(), n.clone())),
                    }
                }
                // 0.6: a name the pattern's module, a module of a library,
                // imports from a module its library reaches (its own, or of
                // a library it requires): the expansion names it through
                // that module, as the program would.
                Meaning::Imported(_, from)
                    if opts
                        .reach
                        .and_then(|r| r.get(m))
                        .is_some_and(|allowed| allowed.iter().any(|a| a == from)) =>
                {
                    let def = modules
                        .and_then(|ms| ms.get(from))
                        .and_then(|x| x.get("defs"))
                        .and_then(|d| d.get(n));
                    if !def.is_some_and(|d| d.get("pub") == Some(&Value::Bool(true))) {
                        push(
                            &mut diags,
                            spans,
                            "E1602",
                            format!(
                                "{p} names {n}, which {m} imports from {from}, where it is not a pub definition: its expansion names {n} in this program, which may name only what {from} makes pub."
                            ),
                            apply_at.clone(),
                            facts().with("from", from),
                        );
                        continue;
                    }
                    match taken(program, n, Some(from)) {
                        Some(how) => push(
                            &mut diags,
                            spans,
                            "E1306",
                            format!(
                                "{p}'s expansion names {n} of {from}, and this program {how} {n} already."
                            ),
                            apply_at.clone(),
                            facts().with("problem", "taken").with("from", from),
                        ),
                        None => adds.push((from.to_owned(), n.clone())),
                    }
                }
                Meaning::Imported(_, from) => push(
                    &mut diags,
                    spans,
                    "E1602",
                    format!(
                        "{p} names {n}, which {m} imports from {from} and does not define: an application from another module cannot name it."
                    ),
                    apply_at.clone(),
                    facts().with("from", from),
                ),
                Meaning::StdModule => match taken(program, n, Some("std")) {
                    Some(how) => push(
                        &mut diags,
                        spans,
                        "E1306",
                        format!(
                            "{p}'s expansion names the module {n} of the standard library, and this program {how} {n} already."
                        ),
                        apply_at.clone(),
                        facts().with("problem", "taken"),
                    ),
                    None => adds.push(("std".to_owned(), n.clone())),
                },
                Meaning::BuiltinType | Meaning::BuiltinFn => {
                    if let Some(how) = taken(program, n, None) {
                        push(
                            &mut diags,
                            spans,
                            "E1306",
                            format!(
                                "{p}'s expansion names the built-in {n}, and this program {how} {n}."
                            ),
                            apply_at.clone(),
                            facts().with("problem", "taken"),
                        );
                    }
                }
                // A name the module's resolver lets stand without a
                // definition (a supervision strategy after `on error`): it
                // stays such a name only while this program does not name
                // something by it.
                Meaning::Unknown => {
                    if taken(program, n, None).is_some() {
                        Foreign {
                            program,
                            linked,
                            pattern: p,
                            value,
                            module: m,
                            apply_at: &apply_at,
                            spans,
                        }
                        .unknown(
                            &mut diags,
                            n,
                            &format!("{pattern_base}{}", place.path),
                        );
                    }
                }
            }
        }
    }
    if has_errors(&diags) {
        return Err(diags);
    }
    // The expansion.
    let mut subst = Subst::new(&read.bindings, &read.types, p);
    let root = Rc::new(Scope::default());
    let params: Vec<String> = pdef
        .params()
        .iter()
        .filter_map(|x| x.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    let scope = Scope::child(&root, params);
    let exp_params = subst.node(
        &Value::Array(pdef.params().to_vec()),
        &format!("{base}/params"),
        &format!("{pattern_base}/params"),
        &root,
        4,
    );
    let exp_returns = match pdef.members().get("returns") {
        Some(r) => subst.node(
            r,
            &format!("{base}/returns"),
            &format!("{pattern_base}/returns"),
            &root,
            4,
        ),
        None => Value::Null,
    };
    let exp_body = subst.block(
        pdef.body().unwrap_or_default(),
        &format!("{base}/body"),
        &format!("{pattern_base}/body"),
        &scope,
        4,
    );
    // The expansion stopped at the copy that passed the limit: `copied` is
    // at most the limit and one argument.
    if subst.over_size() {
        push(
            &mut diags,
            spans,
            "E0105",
            format!(
                "The expansion of {p} copies more than {} bytes of its arguments into {name}; the limit is the reader's.",
                mandate_ir::limits::SOURCE_BYTES
            ),
            apply_at.clone(),
            JsObject::new()
                .with("pattern", p)
                .with("limit", mandate_ir::limits::SOURCE_BYTES)
                .with("copied", subst.copied),
        );
    }
    for problem in std::mem::take(&mut subst.problems) {
        push(
            &mut diags,
            spans,
            problem.code,
            problem.message,
            problem.at,
            *problem.facts,
        );
    }
    if has_errors(&diags) {
        return Err(diags);
    }
    // The workflow, in the order a written one's members are read: kind,
    // params, returns, caps, body, owner (0.7), budget, then pub and doc.
    // The owner is the application's: it names the role that approves the
    // running program's card and signs its promotions.
    let mut wf = Map::new();
    wf.insert("kind", "workflow");
    wf.insert("params", exp_params);
    wf.insert("returns", exp_returns);
    wf.insert(
        "caps",
        w.get("caps").cloned().unwrap_or(Value::Array(Vec::new())),
    );
    wf.insert("body", exp_body);
    for k in ["owner", "budget", "pub", "doc"] {
        if let Some(x) = w.get(k) {
            wf.insert(k, x.clone());
        }
    }
    let body_origin = |k: &str| Origin::Body {
        pattern_path: format!("{pattern_base}/{k}"),
    };
    let mut records: Vec<(String, Origin)> = vec![
        (
            base.clone(),
            Origin::Body {
                pattern_path: pattern_base.clone(),
            },
        ),
        (format!("{base}/params"), body_origin("params")),
        (format!("{base}/returns"), body_origin("returns")),
        (format!("{base}/body"), body_origin("body")),
    ];
    for k in ["kind", "caps", "owner", "budget", "pub", "doc"] {
        records.push((format!("{base}/{k}"), Origin::Same));
    }
    records.extend(subst.origins);
    // Longest first, so that the first prefix found is the nearest.
    records.sort_by_key(|(p, _)| std::cmp::Reverse(p.len()));
    let origins = Origins {
        base,
        apply: apply_at,
        pattern: p.to_owned(),
        module: module.map(str::to_owned),
        records,
    };
    Ok((Value::Object(wf), origins, adds))
}

/// How the applying program already names `n` otherwise than as the
/// definition of `module` it would add (`Some(m)`: a module's definition;
/// `None`: a built-in): it defines it, or a `use` brings it from elsewhere.
fn taken(program: Program<'_>, n: &str, module: Option<&str>) -> Option<&'static str> {
    if program.defs().is_some_and(|d| d.contains_key(n)) {
        return Some("defines");
    }
    for u in program.imports() {
        if u.names().any(|x| x == n) && u.module() != module {
            return Some("imports");
        }
    }
    None
}

/// An imported pattern whose module does not resolve one of its names, as
/// the application reports it (spec/library.md "Declaration": a pattern's names
/// mean what they mean in its module, and nothing else).
struct Foreign<'a> {
    program: Program<'a>,
    linked: &'a Linked,
    pattern: &'a str,
    value: &'a Value,
    module: &'a str,
    apply_at: &'a str,
    spans: Option<&'a Spans>,
}

impl Foreign<'_> {
    /// `n`, at `at` in the module, a name the module does not know: E1302
    /// when this program's `n` would bring authority into the expansion
    /// (followed as E1302 follows a pattern's own names), else E0120.
    fn unknown(&self, diags: &mut Vec<Diagnostic>, n: &str, at: &str) {
        let (p, m) = (self.pattern, self.module);
        let here = Site {
            name: p,
            value: self.value,
            home: self.program,
            linked: &self.linked.defs,
        };
        let mut visited = std::collections::HashSet::new();
        match pattern::def_authority(&here, n, here.meaning(n), &mut visited) {
            Some((what, name, via)) => {
                let through = via
                    .as_deref()
                    .map(|v| format!(" (through {v})"))
                    .unwrap_or_default();
                push(
                    diags,
                    self.spans,
                    "E1302",
                    format!(
                        "Pattern {p} names {n}, which its module {m} does not know: in this program's expansion it would be this program's {what} {name}{through}, which no slot gave it. A pattern's names mean what they mean in its module, and a pattern brings no authority (spec/library.md \"What a pattern may not do\")."
                    ),
                    self.apply_at.to_owned(),
                    JsObject::new()
                        .with("pattern", p)
                        .with("names", what)
                        .with("name", name.as_str())
                        .with_some("via", via.as_deref())
                        .with("module", m)
                        .with("pattern_path", at),
                );
            }
            None => push(
                diags,
                self.spans,
                "E0120",
                format!(
                    "Pattern {p} names {n}, which its module {m} neither defines nor imports: a pattern's names mean what they mean in its module, never what this program names {n} (spec/library.md \"Declaration\")."
                ),
                self.apply_at.to_owned(),
                JsObject::new()
                    .with("pattern", p)
                    .with("module", m)
                    .with("name", n)
                    .with("pattern_path", at),
            ),
        }
    }

    /// Another error of the module's resolver, at the application, with its
    /// path in the module as `key`.
    fn again(&self, diags: &mut Vec<Diagnostic>, d: &Diagnostic, key: &str) {
        let (p, m) = (self.pattern, self.module);
        let mut facts = d.facts.clone().unwrap_or_default();
        facts.insert("pattern", p);
        facts.insert("module", m);
        facts.insert(key, d.at.path.as_deref().unwrap_or_default());
        push(
            diags,
            self.spans,
            d.code.strip_prefix("MDT-").unwrap_or(&d.code),
            format!(
                "Pattern {p} comes from {m}, whose names do not resolve, so it is not applied: {}",
                d.message
            ),
            self.apply_at.to_owned(),
            facts,
        );
    }
}

/// Whether `path` is `prefix` or below it.
fn under(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

impl Expansion {
    /// A diagnostic found in the expanded program, reported in the program
    /// that was checked: at the slot argument whose value its place is, or
    /// at the application with the pattern's path in its facts; one about
    /// a `use` the expansion added, at the application that needs it.
    /// Anything else is as it was. `spans` are the program's.
    #[must_use]
    pub fn map(&self, mut d: Diagnostic, spans: Option<&Spans>) -> Diagnostic {
        // The places a fact names too: the `at` of each part of an E0501's
        // `breakdown`, a path into the expansion like the diagnostic's own.
        if let Some(facts) = d.facts.as_mut()
            && let Some(JsValue::Array(parts)) = facts.get_mut("breakdown")
        {
            for part in parts.iter_mut() {
                let JsValue::Object(part) = part else {
                    continue;
                };
                let Some(at) = part.get("at").and_then(JsValue::as_str).map(str::to_owned) else {
                    continue;
                };
                if let Some((to, more)) = self.place(&at) {
                    part.insert("at", to.as_str());
                    for (k, v) in more {
                        if part.get(k).is_none() {
                            part.insert(k, v);
                        }
                    }
                }
            }
        }
        let Some(path) = d.at.path.clone() else {
            return d;
        };
        match self.place(&path) {
            Some((to, facts)) => moved(d, &to, spans, facts),
            None => d,
        }
    }

    /// Where `path`, a place of the expanded program, is in the program
    /// that was checked, with the facts that say where it comes from; `None`
    /// for a place that is where it was.
    fn place(&self, path: &str) -> Option<(String, Vec<(&'static str, JsValue)>)> {
        for (i, app) in &self.added_uses {
            if under(path, &format!("/uses/{i}")) {
                return Some((app.clone(), vec![("expanded_path", JsValue::from(path))]));
            }
        }
        let o = self.origins.iter().find(|o| under(path, &o.base))?;
        let (prefix, origin) = o.records.iter().find(|(p, _)| under(path, p))?;
        let rest = path.get(prefix.len()..).unwrap_or_default();
        match origin {
            Origin::Same => None,
            Origin::Arg { at, slot, subtree } => {
                let to = if *subtree {
                    format!("{at}{rest}")
                } else {
                    at.clone()
                };
                Some((
                    to,
                    vec![
                        ("slot", JsValue::from(slot.as_str())),
                        ("expanded_path", JsValue::from(path)),
                    ],
                ))
            }
            Origin::Body { pattern_path } => {
                let mut facts = vec![
                    ("pattern", JsValue::from(o.pattern.as_str())),
                    (
                        "pattern_path",
                        JsValue::from(format!("{pattern_path}{rest}")),
                    ),
                    ("expanded_path", JsValue::from(path)),
                ];
                if let Some(m) = &o.module {
                    facts.push(("module", JsValue::from(m.as_str())));
                }
                Some((o.apply.clone(), facts))
            }
        }
    }

    /// Whether `path` is in a workflow the expansion wrote.
    #[must_use]
    pub fn expanded(&self, path: &str) -> bool {
        self.origins.iter().any(|o| under(path, &o.base))
            || self
                .added_uses
                .iter()
                .any(|(i, _)| under(path, &format!("/uses/{i}")))
    }
}

/// `d` at `to`, with the span of `to` and `facts` added; its repair, which
/// would patch the expansion, is left out.
fn moved(
    mut d: Diagnostic,
    to: &str,
    spans: Option<&Spans>,
    facts: Vec<(&str, JsValue)>,
) -> Diagnostic {
    let mut all = d.facts.take().unwrap_or_default();
    for (k, v) in facts {
        if all.get(k).is_none() {
            all.insert(k, v);
        }
    }
    d.facts = Some(all);
    d.at = Location::path_span(to, nearest_span(spans, to));
    d.repair = None;
    d
}
