//! The static checks, the types and the cost model against the TypeScript
//! on inputs written to reach what no stored result does:
//! `tests/statics/inputs.json`, and in `tests/statics/expected.json` what
//! `scripts/static-vectors.mjs` has the TypeScript compiler give for them.
//!
//! - `check` of each program, its `{ ok, diagnostics }` as
//!   `JSON.stringify` text, byte for byte; a program marked `held` (its
//!   result has a diagnostic of a rule the Rust does not give yet; none
//!   today) is held to giving the expected diagnostics with some left out, in order, and must not pass
//!   whole (then its mark is taken off);
//! - `staticCost` of every workflow of every program that loads and of the
//!   fixtures listed, and `leadClasses` of every program that checks;
//! - `assignable` of pairs of types in a type environment, `show`, and
//!   `microsText` of amounts past 2^53, negative, fractional and not
//!   finite;
//! - the deepest programs that load, one of each form that nests, checked
//!   within a stated stack (WebAssembly's 1 MiB; natively 8 MiB, since a
//!   debug build's frames do not fit a test thread's 2 MiB), against the
//!   digest of what the TypeScript gives them with a stack large enough.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_check::ty::{Ty, TypeEnv, assignable, show};
use mandate_check::{
    CheckOptions, ModuleSource, Modules, check, lead_classes, link, load_modules, micros_text,
    static_cost,
};
use mandate_ir::{JsObject, JsValue, Map, Program, Value, stringify, stringify_pretty};
use mandate_syntax::{SourceKind, kind_of, load};
use mandate_testkit::{omission, read_json};

const DIR: &str = "crates/mandate-check/tests/statics";

/// The checks TypeScript throws on, which a Rust result cannot be, with
/// what Rust gives instead: a known difference between the two compilers
/// (`vectors/README.md`, "Where the Rust compiler is not held to the
/// TypeScript").
const THROWS_IN_TYPESCRIPT: &[(&str, &str)] = &[(
    // `NUMERIC_WIDENING[ua.name] ?? []` in ty.ts reads Object.prototype's
    // toString, a function, whose `.includes` is not one: `check` throws a
    // TypeError. The Rust has no such member and gives the mismatch.
    "a type named toString where another is expected",
    r#"{"ok":false,"diagnostics":[{"code":"MDT-E0201","severity":"error","message":"Expected Int but got toString.","at":{"path":"/defs/f/body/0/value","span":[1,1,1,1]},"docs":"mandate explain MDT-E0201"}]}"#,
)];

/// A check input's text and kind, as the script gives them to `check`.
fn source(c: &Value) -> (String, SourceKind) {
    match c.get("mdt").and_then(Value::as_array) {
        Some(lines) => {
            let lines: Vec<&str> = lines.iter().filter_map(Value::as_str).collect();
            (format!("{}\n", lines.join("\n")), SourceKind::Mdt)
        }
        None => (
            stringify_pretty(&JsValue::from(c.get("ir").unwrap())).unwrap(),
            SourceKind::Json,
        ),
    }
}

/// `JSON.stringify` of a diagnostic list's `{ ok, diagnostics }`.
fn result_text(ok: bool, diagnostics: &[mandate_ir::Diagnostic]) -> String {
    stringify(
        &JsObject::new()
            .with("ok", ok)
            .with(
                "diagnostics",
                diagnostics
                    .iter()
                    .map(mandate_ir::Diagnostic::to_js)
                    .collect::<Vec<_>>(),
            )
            .into(),
    )
    .unwrap()
}

/// The diagnostics of a `{ ok, diagnostics }` text, each as its text.
fn diagnostic_texts(text: &str) -> Vec<String> {
    let v = mandate_testkit::parse_json(text.as_bytes()).unwrap();
    v.get("diagnostics")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .map(|d| stringify(&JsValue::from(d)).unwrap())
        .collect()
}

/// A workflow's static cost as the script lists it: the program's name, the
/// workflow, and the cost as JSON text.
type CostLine = (String, String, String);

/// A program's lead classes as the script lists them: the program's name and
/// the classes as JSON text.
type LeadsLine = (String, String);

/// What `static_cost` and `lead_classes` give for every workflow of a
/// loaded program, as the script lists them.
fn costs_and_leads(
    name: &str,
    program: &Value,
    modules: &Modules,
    leads_too: bool,
) -> (Vec<CostLine>, Option<LeadsLine>) {
    let p = Program::of(program).unwrap();
    let linked = link(p, Some(modules));
    let mut costs = Vec::new();
    for (wf, d) in p.definitions() {
        if d.kind() != Some(mandate_ir::DefKind::Workflow) {
            continue;
        }
        let c = static_cost(p, wf, Some(&linked.defs)).map(|c| stringify(&c.to_js()).unwrap());
        costs.push((
            name.to_owned(),
            wf.to_owned(),
            c.unwrap_or_else(|| "null".to_owned()),
        ));
    }
    let leads = leads_too.then(|| {
        let leads: JsObject = lead_classes(p, Some(&linked.defs))
            .into_iter()
            .map(|(path, c)| (path, c.as_str()))
            .collect();
        (name.to_owned(), stringify(&leads.into()).unwrap())
    });
    (costs, leads)
}

/// The program of a deep shape: `fns` functions (constants, types), each
/// calling the next under `depth` levels of the form `shape`. The same rule
/// as `deepProgram` in `scripts/static-vectors.mjs`.
fn deep_program(shape: &str, fns: usize, depth: usize) -> String {
    let nest = |mut e: String, wrap: &dyn Fn(&str) -> String| {
        for _ in 0..depth {
            e = wrap(&e);
        }
        e
    };
    let mut lines: Vec<String> = Vec::new();
    match shape {
        "const" => {
            lines.push("module m @ 0.1".to_owned());
            for i in 0..fns {
                let next = if i + 1 < fns {
                    format!("c{}", i + 1)
                } else {
                    "1".to_owned()
                };
                lines.push(format!("let c{i} = {}", nest(next, &|e| format!("{e}.a"))));
            }
        }
        "types" => {
            lines.push("module m @ 0.1".to_owned());
            for i in 0..fns.saturating_sub(1) {
                let next = if i + 2 < fns {
                    format!("T{}", i + 1)
                } else {
                    "Int".to_owned()
                };
                let t = nest(next, &|t| format!("List<{t}>"));
                lines.push(format!("type T{i} = {{ a: {t} }} classified internal"));
            }
            lines.push("fn f(x: T0) -> Int { x }".to_owned());
        }
        "field" | "not" | "list" | "paren" => {
            lines.push("module m @ 0.1".to_owned());
            for i in 0..fns {
                let next = if i + 1 < fns {
                    format!("f{}(n)", i + 1)
                } else {
                    "n".to_owned()
                };
                let e = nest(next, &|e| match shape {
                    "field" => format!("{e}.a"),
                    "not" => format!("not {e}"),
                    "list" => format!("[{e}]"),
                    _ => format!("(1 + {e})"),
                });
                lines.push(format!("fn f{i}(n: Int) -> Int {{ {e} }}"));
            }
        }
        _ => {
            for l in [
                "mandate @ 0.4",
                "module m @ 0.1",
                "use std.{model}",
                "type R = { a: Int }",
                "capability M = model.infer(tier: standard)",
                "agent A {",
                "  caps M",
                "  budget { steps: 3 }",
                "  skill s(t: Inferred<Int>) -> Int ! {Model}",
                "}",
            ] {
                lines.push(l.to_owned());
            }
            for i in 0..fns {
                let next = if i + 1 < fns {
                    format!("f{}(n)", i + 1)
                } else {
                    "n".to_owned()
                };
                let e = nest(next, &|e| match shape {
                    "if" => format!("if n == 1 {{\n{e}\n}}"),
                    "record" => format!("R {{ a: {e} }}"),
                    "switch" => format!("switch n {{\n_ => {e}\n}}"),
                    "delegate" => format!("delegate A.s({e})"),
                    _ => format!("map x in [n] max 1 {{\n{e}\n}}"),
                });
                lines.push(format!("fn f{i}(n: Int) -> Int {{\n{e}\n}}"));
            }
        }
    }
    format!("{}\n", lines.join("\n"))
}

/// The type environment of a program's definitions.
struct Env<'a>(&'a Map);

impl TypeEnv for Env<'_> {
    fn type_def(&self, name: &str) -> Option<&Value> {
        self.0
            .get(name)
            .filter(|d| d.get("kind").and_then(Value::as_str) == Some("type"))
    }

    fn is_contract(&self, name: &str) -> bool {
        self.0
            .get(name)
            .is_some_and(|d| d.get("kind").and_then(Value::as_str) == Some("contract"))
    }
}

/// A type of the shape of `ty.ts`: `{ k, name, args, lit? }`, `{ k, fields }`
/// or `{ k: "unknown" }`.
fn ty_of(v: &Value) -> Ty {
    match v.get("k").and_then(Value::as_str) {
        Some("named") => Ty::named_lit(
            v.get("name").and_then(Value::as_str).unwrap(),
            v.get("args")
                .and_then(Value::as_array)
                .unwrap_or_default()
                .iter()
                .map(ty_of)
                .collect(),
            v.get("lit").and_then(Value::as_str).map(str::to_owned),
        ),
        Some("record") => Ty::Record {
            fields: v
                .get("fields")
                .and_then(Value::as_object)
                .unwrap()
                .iter()
                .map(|(k, x)| (k.to_owned(), ty_of(x)))
                .collect(),
        },
        _ => Ty::Unknown,
    }
}

/// The stack the deepest programs are checked within natively: what a main
/// thread has on Linux and macOS. The 2 MiB of a test thread is not enough
/// for a debug build on a 64-bit target, whose frames are several times
/// those of the WebAssembly build.
#[cfg(not(target_arch = "wasm32"))]
const NATIVE_STACK: usize = 8 * 1024 * 1024;

/// Runs `f` within the stack the deepest programs are held to. Under
/// WebAssembly that is the module's own stack, 1 MiB, on the thread the test
/// is on (there are no others).
#[cfg(target_arch = "wasm32")]
fn within_the_stack<T>(f: impl FnOnce() -> T) -> T {
    f()
}

/// Runs `f` within the stack the deepest programs are held to: natively a
/// thread of [`NATIVE_STACK`].
#[cfg(not(target_arch = "wasm32"))]
fn within_the_stack<T: Send>(f: impl FnOnce() -> T + Send) -> T {
    std::thread::scope(|s| {
        std::thread::Builder::new()
            .stack_size(NATIVE_STACK)
            .spawn_scoped(s, f)
            .unwrap()
            .join()
            .unwrap()
    })
}

/// The deepest programs that load (64 definitions, an IR 64 deep): the
/// static checks recurse as deep as a program lets them, within a stated
/// stack (1 MiB under WASM, [`NATIVE_STACK`] natively), and give what the
/// TypeScript gives with a stack large enough (Node's default is not: it
/// throws on most of these).
#[test]
fn the_deepest_programs_that_load_are_checked_as_the_typescript_checks_them() {
    let inputs = read_json(&format!("{DIR}/inputs.json")).unwrap();
    let expected = read_json(&format!("{DIR}/expected.json")).unwrap();
    let shapes = inputs
        .get("deep")
        .and_then(|d| d.get("shapes"))
        .and_then(Value::as_array)
        .unwrap();
    let want = expected.get("deep").and_then(Value::as_array).unwrap();
    assert_eq!(shapes.len(), want.len(), "a result for every shape");
    let mut failures = Vec::new();
    for (s, w) in shapes.iter().zip(want) {
        let s = s.as_array().unwrap();
        let shape = s[0].as_str().unwrap();
        let fns = usize::try_from(s[1].as_i64().unwrap()).unwrap();
        let depth = usize::try_from(s[2].as_i64().unwrap()).unwrap();
        let name = format!("{shape}:{fns}:{depth}");
        assert_eq!(w.get("name").and_then(Value::as_str), Some(name.as_str()));
        let text = deep_program(shape, fns, depth);
        let (ok, count, got) = within_the_stack(|| {
            let r = check(&text, SourceKind::Mdt, &CheckOptions::default());
            let got = mandate_testkit::sha256(&result_text(r.ok, &r.diagnostics));
            (r.ok, r.diagnostics.len(), got)
        });
        let digest = w.get("digest").and_then(Value::as_str);
        if digest != Some(got.as_str()) {
            failures.push(format!(
                "{name}: expected ok {:?} with {:?} diagnostics ({digest:?}), got ok {ok} with {count} ({got})",
                w.get("ok"),
                w.get("diagnostics").and_then(Value::as_i64),
            ));
        }
    }
    println!(
        "deep programs: {} checked as the TypeScript checks them",
        shapes.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn the_static_checks_types_and_costs_are_the_typescript_ones() {
    let inputs = read_json(&format!("{DIR}/inputs.json")).unwrap();
    let expected = read_json(&format!("{DIR}/expected.json")).unwrap();
    let list = |v: &Value, key: &str| v.get(key).and_then(Value::as_array).unwrap().to_vec();
    let mut failures: Vec<String> = Vec::new();

    // check
    let checks = list(&inputs, "checks");
    let want_checks = list(&expected, "checks");
    assert_eq!(checks.len(), want_checks.len(), "a result for every check");
    let (mut exact, mut held) = (0_usize, 0_usize);
    let mut costs: Vec<(String, String, String)> = Vec::new();
    let mut leads: Vec<(String, String)> = Vec::new();
    let empty = Modules::new();
    for (c, want) in checks.iter().zip(&want_checks) {
        let name = c.get("name").and_then(Value::as_str).unwrap();
        let (text, kind) = source(c);
        let modules = c.get("modules").and_then(Value::as_object);
        let r = check(
            &text,
            kind,
            &CheckOptions {
                lock: None,
                modules,
                claim: c.get("claim"),
            },
        );
        let got = result_text(r.ok, &r.diagnostics);
        let want_text = want.get("result").and_then(Value::as_str);
        match (want_text, want.get("throws").and_then(Value::as_str)) {
            (Some(want_text), _) => {
                let is_held = c.get("held").is_some();
                if got == want_text {
                    if is_held {
                        failures.push(format!(
                            "{name}: passes whole, but is marked held; take the mark off"
                        ));
                    }
                    exact = exact.saturating_add(1);
                } else if is_held {
                    match omission(
                        &diagnostic_texts(want_text),
                        &diagnostic_texts(&got),
                        |w, g| w == g,
                        Clone::clone,
                    ) {
                        Ok(_) => held = held.saturating_add(1),
                        Err(why) => failures.push(format!("{name} (held): {why}")),
                    }
                } else {
                    failures.push(format!(
                        "{name}:\n    expected {want_text}\n    got      {got}"
                    ));
                }
            }
            (None, Some(threw)) => match THROWS_IN_TYPESCRIPT.iter().find(|(n, _)| *n == name) {
                Some((_, instead)) => {
                    // Spans differ by input; compare without them.
                    let strip = |t: &str| {
                        let mut v = mandate_testkit::parse_json(t.as_bytes()).unwrap();
                        if let Some(Value::Array(ds)) = v.get("diagnostics").cloned() {
                            let ds: Vec<Value> = ds
                                .into_iter()
                                .map(|mut d| {
                                    if let Value::Object(m) = &mut d
                                        && let Some(Value::Object(at)) = m.get_mut("at")
                                    {
                                        at.remove("span");
                                    }
                                    d
                                })
                                .collect();
                            if let Value::Object(m) = &mut v {
                                m.insert("diagnostics", Value::Array(ds));
                            }
                        }
                        stringify(&JsValue::from(&v)).unwrap()
                    };
                    if strip(&got) != strip(instead) {
                        failures.push(format!(
                            "{name}: TypeScript throws ({threw}); Rust gives {got}, not the documented {instead}"
                        ));
                    }
                    println!(
                        "known difference: {name}: TypeScript throws {threw}; Rust gives {got}"
                    );
                }
                None => failures.push(format!(
                    "{name}: TypeScript throws ({threw}), and the test lists no difference for it"
                )),
            },
            (None, None) => failures.push(format!("{name}: no expected result")),
        }
        let loaded = load(&text, kind);
        if let Some(program) = &loaded.program {
            let passes = want_text.is_some_and(|t| t.starts_with(r#"{"ok":true"#));
            let (c, l) = costs_and_leads(name, program, modules.unwrap_or(&empty), passes);
            costs.extend(c);
            leads.extend(l);
        }
    }

    // staticCost and leadClasses of the fixtures
    for f in list(&inputs, "costs") {
        let file = f.get("file").and_then(Value::as_str).unwrap();
        let files: Vec<String> = f
            .get("modules")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let texts: Vec<String> = files
            .iter()
            .map(|m| mandate_testkit::read_text(m).unwrap())
            .collect();
        let sources: Vec<ModuleSource<'_>> = files
            .iter()
            .zip(&texts)
            .map(|(m, text)| ModuleSource {
                text,
                kind: kind_of(m),
                file: m,
            })
            .collect();
        let modules = load_modules(&sources).modules;
        let text = mandate_testkit::read_text(file).unwrap();
        let program = load(&text, kind_of(file)).program.unwrap();
        let (c, l) = costs_and_leads(file, &program, &modules, true);
        costs.extend(c);
        leads.extend(l);
    }
    let want_costs = list(&expected, "costs");
    assert_eq!(costs.len(), want_costs.len(), "a cost for every workflow");
    for ((name, wf, got), want) in costs.iter().zip(&want_costs) {
        assert_eq!(
            want.get("name").and_then(Value::as_str),
            Some(name.as_str())
        );
        assert_eq!(
            want.get("workflow").and_then(Value::as_str),
            Some(wf.as_str())
        );
        let want = want.get("result").and_then(Value::as_str).unwrap();
        if got != want {
            failures.push(format!(
                "staticCost of {wf} in {name}:\n    expected {want}\n    got      {got}"
            ));
        }
    }
    let want_leads = list(&expected, "leads");
    assert_eq!(leads.len(), want_leads.len(), "leads for every program");
    for ((name, got), want) in leads.iter().zip(&want_leads) {
        assert_eq!(
            want.get("name").and_then(Value::as_str),
            Some(name.as_str())
        );
        let want = want.get("result").and_then(Value::as_str).unwrap();
        if got != want {
            failures.push(format!(
                "leadClasses of {name}:\n    expected {want}\n    got      {got}"
            ));
        }
    }

    // assignable, show, microsText
    let type_lines = list(&inputs, "types");
    let lines: Vec<&str> = type_lines.iter().filter_map(Value::as_str).collect();
    let types = load(&format!("{}\n", lines.join("\n")), SourceKind::Mdt)
        .program
        .unwrap();
    let defs = types.get("defs").and_then(Value::as_object).unwrap();
    let env = Env(defs);
    let pairs = list(&inputs, "assignable");
    let want_pairs = list(&expected, "assignable");
    assert_eq!(pairs.len(), want_pairs.len());
    for (pair, want) in pairs.iter().zip(&want_pairs) {
        let pair = pair.as_array().unwrap();
        let p = assignable(&ty_of(&pair[0]), &ty_of(&pair[1]), &env);
        let got = match p {
            Some(p) => stringify(
                &JsObject::new()
                    .with("code", p.code)
                    .with("message", p.message)
                    .into(),
            )
            .unwrap(),
            None => "null".to_owned(),
        };
        let want = want.as_str().unwrap();
        if got != want {
            failures.push(format!(
                "assignable {}:\n    expected {want}\n    got      {got}",
                stringify(&JsValue::from(&Value::Array(pair.to_vec()))).unwrap()
            ));
        }
    }
    for (t, want) in list(&inputs, "show").iter().zip(&list(&expected, "show")) {
        let got = show(&ty_of(t));
        if Some(got.as_str()) != want.as_str() {
            failures.push(format!("show: expected {want:?}, got {got:?}"));
        }
    }
    for (m, want) in list(&inputs, "micros")
        .iter()
        .zip(&list(&expected, "micros"))
    {
        let m = m.as_array().unwrap();
        let micros: f64 = m[0].as_str().unwrap().parse().unwrap();
        let got = micros_text(micros, m[1].as_str().unwrap());
        if Some(got.as_str()) != want.as_str() {
            failures.push(format!(
                "microsText({micros}): expected {want:?}, got {got:?}"
            ));
        }
    }
    println!(
        "static vectors: {} checks ({exact} whole, {held} held to omission), {} costs, {} leads, {} assignable pairs",
        checks.len(),
        costs.len(),
        leads.len(),
        pairs.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
