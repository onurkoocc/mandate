//! `mandate-check` against what the TypeScript compiler gives: the files in
//! `tests/data/`, written by `scripts/caps-vectors.mjs` from the built
//! compiler (see the script for their form). Each case is a function, its
//! arguments and the TypeScript's result; the Rust result must be the same
//! JSON, member for member. A gate per source (the programs of the
//! repository, the hand-written edges, the pseudo-random sweep) prints
//! `ran N, passed M, pending K`; nothing is pending. The programs are the
//! ones the committed list `tests/data/sources.json` names, not a listing of
//! the directories, so that a change adding a conformance case does not
//! change this data (`--rescan` takes new ones in).

#![allow(
    clippy::arithmetic_side_effects,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use std::collections::BTreeMap;

use mandate_check::{
    BUILTIN_EFFECTS, CAP_CTORS, CapOptions, CapVal, DATA_CLASSES, DECISION_POLICIES,
    DEFAULT_MODEL_MAX_CLASS, DataClass, GOVERNANCE_FILES, GOVERNANCE_KINDS, HTTP_METHODS,
    MAX_CHOICE_OPTIONS, MAX_RESTARTS, OUT_OF_SCOPE_OPTIONS, PATH_PATTERN, PROTECTED_TYPES,
    STD_EFFECTS, STD_FNS, UNGATED_EFFECTS, callee_path, cap_authorizes, cap_covers, cap_ctor,
    cap_from_call, caps_from_call, caps_of, class_rank, glob_reg_exp, governance_files,
    governance_kind, imported_methods, is_builtin_effect, is_decision_policy,
    is_out_of_scope_option, is_path, is_protected_type, is_ungated_effect, path_problem,
    paths_overlap, pattern_problem, posix, prefixes_within, read_methods, reads_methods,
    scope_within, segments, show_cap, std_effect, std_fn, within, writes_overlap,
};
use mandate_ir::{Expr, JsObject, JsValue, Language, Map, Program, Value, stringify};
use mandate_testkit::{files, read_json, run_gate};

const DATA: &str = "crates/mandate-check/tests/data";
const FORMAT: &str = "mandate-check/caps-vectors/0.1";
const HOW: &str = "the test data is written by `node scripts/caps-vectors.mjs`, \
                   after `npm ci --ignore-scripts && npm run build`";

/// Every function the data must have cases of: each exported function of
/// caps.ts, governance.ts and path.ts, and posix's two.
const FUNCTIONS: [&str; 25] = [
    "calleePath",
    "capFromCall",
    "capsFromCall",
    "capsOf",
    "readMethods",
    "readsMethods",
    "importedMethods",
    "segments",
    "within",
    "pathsOverlap",
    "scopeWithin",
    "prefixesWithin",
    "capCovers",
    "capAuthorizes",
    "writesOverlap",
    "showCap",
    "posix.normalize",
    "posix.isAbsolute",
    "patternProblem",
    "globRegExp.source",
    "globRegExp.test",
    "governanceKind",
    "governanceFiles",
    "pathProblem",
    "isPath",
];

fn read(name: &str) -> Value {
    let file = read_json(&format!("{DATA}/{name}")).unwrap_or_else(|e| panic!("{e}\n{HOW}"));
    assert_eq!(
        file.get("format").and_then(Value::as_str),
        Some(FORMAT),
        "{name}: not of format {FORMAT}; {HOW}"
    );
    file
}

/// The parts of a source, `<source>-<k>.json`, in order.
fn parts(source: &str) -> Vec<Value> {
    let names = files(DATA).unwrap_or_else(|e| panic!("{e}\n{HOW}"));
    let mut found: Vec<(u32, String)> = names
        .into_iter()
        .filter_map(|n| {
            let k = n
                .strip_prefix(&format!("{source}-"))?
                .strip_suffix(".json")?;
            Some((k.parse().ok()?, n))
        })
        .collect();
    found.sort();
    assert!(!found.is_empty(), "no {DATA}/{source}-*.json; {HOW}");
    found.iter().map(|(_, n)| read(n)).collect()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v:?}"))
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().unwrap_or_else(|| panic!("not a list: {v:?}"))
}

fn strings(v: &Value) -> Vec<String> {
    arr(v).iter().map(|x| s(x).to_owned()).collect()
}

fn opt_strings(v: &Value) -> Option<Vec<String>> {
    (!matches!(v, Value::Null)).then(|| strings(v))
}

fn opt_prefixes(v: &Value) -> Option<Vec<Vec<String>>> {
    (!matches!(v, Value::Null)).then(|| arr(v).iter().map(strings).collect())
}

fn expr(v: &Value) -> Expr<'_> {
    Expr::of(v).unwrap_or_else(|| panic!("not an expression: {v:?}"))
}

fn options(v: &Value) -> CapOptions {
    CapOptions {
        language: v.as_str().and_then(Language::from_tag),
    }
}

/// A capability value from the JSON the TypeScript has.
fn cap(v: &Value) -> CapVal {
    let m = v.as_object().expect("a capability");
    let mut c = CapVal::new(
        s(m.get("ctor").unwrap()),
        s(m.get("effect").unwrap()),
        matches!(m.get("write"), Some(Value::Bool(true))),
    );
    for (k, x) in m.iter() {
        match k {
            "ctor" | "effect" | "write" => {}
            "name" => c.set_name(Some(s(x).to_owned())),
            "via" => c.set_via(Some(s(x).to_owned())),
            "components" => c.set_components(Some(strings(x))),
            "root" => c.set_root(Some(s(x).to_owned())),
            "scope" => c.set_scope(Some(strings(x))),
            "maxClass" => c.set_max_class(Some(DataClass::from_name(s(x)).unwrap())),
            "tier" => c.set_tier(Some(s(x).to_owned())),
            "argsPrefix" => c.set_args_prefix(opt_prefixes(x)),
            "methods" => c.set_methods(Some(strings(x))),
            other => panic!("a capability member {other}"),
        }
    }
    c
}

fn caps_js(caps: &[CapVal]) -> JsValue {
    JsValue::Array(caps.iter().map(|c| c.to_js().into()).collect())
}

fn strs_js<S: AsRef<str>>(xs: &[S]) -> JsValue {
    JsValue::Array(xs.iter().map(|x| JsValue::from(x.as_ref())).collect())
}

fn opt_str_js(x: Option<&str>) -> JsValue {
    x.map_or(JsValue::Null, JsValue::from)
}

fn table<'a>(tables: &'a [Value], v: &Value) -> &'a Map {
    let i = usize::try_from(v.as_i64().expect("a table index")).unwrap();
    tables[i].as_object().expect("a table")
}

/// The Rust result of one case, as the JSON the TypeScript result is.
fn run(name: &str, args: &[Value], tables: &[Value]) -> JsValue {
    match name {
        "calleePath" => opt_str_js(callee_path(expr(&args[0])).as_deref()),
        "capFromCall" => cap_from_call(expr(&args[0]), options(&args[1]))
            .map_or(JsValue::Null, |c| c.to_js().into()),
        "capsFromCall" => {
            caps_from_call(expr(&args[1]), table(tables, &args[0]), options(&args[2])).map_or(
                JsValue::Null,
                |r| {
                    JsObject::new()
                        .with("caps", caps_js(&r.caps))
                        .with_some("problem", r.problem)
                        .into()
                },
            )
        }
        "capsOf" => caps_js(&caps_of(
            table(tables, &args[0]),
            expr(&args[1]),
            options(&args[2]),
        )),
        "readMethods" => {
            let r = read_methods(expr(&args[0]));
            JsObject::new()
                .with("methods", strs_js(&r.methods))
                .with(
                    "problems",
                    JsValue::Array(r.problems.iter().map(|p| p.to_js().into()).collect()),
                )
                .into()
        }
        "readsMethods" => reads_methods(options(&args[0]).language).into(),
        "importedMethods" => {
            let program = Program::of(&args[0]).expect("a program");
            let defs = args[1].as_object().expect("definitions");
            let origin: Vec<(String, String)> = arr(&args[2])
                .iter()
                .map(|p| (s(&arr(p)[0]).to_owned(), s(&arr(p)[1]).to_owned()))
                .collect();
            let modules = args[3].as_object().expect("modules");
            JsValue::Array(
                imported_methods(program, defs, origin, modules)
                    .iter()
                    .map(|d| d.to_js())
                    .collect(),
            )
        }
        "segments" => strs_js(&segments(s(&args[0]))),
        "within" => within(s(&args[0]), s(&args[1])).into(),
        "pathsOverlap" => paths_overlap(s(&args[0]), s(&args[1])).into(),
        "scopeWithin" => scope_within(
            s(&args[0]),
            opt_strings(&args[1]).as_deref(),
            opt_strings(&args[2]).as_deref(),
        )
        .into(),
        "prefixesWithin" => prefixes_within(
            opt_prefixes(&args[0]).as_deref(),
            opt_prefixes(&args[1]).as_deref(),
        )
        .into(),
        "capCovers" => cap_covers(&cap(&args[0]), &cap(&args[1])).into(),
        "writesOverlap" => writes_overlap(&cap(&args[0]), &cap(&args[1])).into(),
        "capAuthorizes" => cap_authorizes(
            &cap(&args[0]),
            s(&args[1]),
            opt_strings(&args[2]).as_deref(),
        )
        .into(),
        "showCap" => show_cap(&cap(&args[0])).into(),
        "posix.normalize" => posix::normalize(s(&args[0])).into(),
        "posix.isAbsolute" => posix::is_absolute(s(&args[0])).into(),
        "patternProblem" => opt_str_js(pattern_problem(s(&args[0]))),
        "globRegExp.source" => glob_reg_exp(s(&args[0])).source().into(),
        "globRegExp.test" => glob_reg_exp(s(&args[0])).test(s(&args[1])).into(),
        "governanceKind" => {
            opt_str_js(governance_kind(s(&args[0]), &strings(&args[1])).map(|k| k.as_str()))
        }
        "governanceFiles" => JsValue::Array(
            governance_files(strings(&args[0]), &strings(&args[1]))
                .iter()
                .map(|f| f.to_js().into())
                .collect(),
        ),
        "pathProblem" => opt_str_js(path_problem(s(&args[0]))),
        "isPath" => is_path(s(&args[0])).into(),
        other => panic!("a function the test does not know: {other}"),
    }
}

fn text(v: &JsValue) -> String {
    stringify(v).unwrap_or_else(|| "undefined".to_owned())
}

/// Runs every case of `source`, as one gate; the number of cases of each
/// function.
fn gate(source: &str) -> BTreeMap<String, usize> {
    let parts = parts(source);
    let mut items: Vec<(String, (usize, usize))> = Vec::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for (p, part) in parts.iter().enumerate() {
        for (i, case) in arr(part.get("cases").expect("cases")).iter().enumerate() {
            let fn_name = s(&arr(case)[0]).to_owned();
            let n = counts.entry(fn_name.clone()).or_default();
            *n += 1;
            items.push((format!("{source} {fn_name} #{n}"), (p, i)));
        }
    }
    let result = run_gate(source, &[], items, |&(p, i)| {
        let tables = arr(parts[p].get("tables").expect("tables"));
        let c = arr(&arr(parts[p].get("cases").expect("cases"))[i]);
        let expected = text(&JsValue::from(&c[2]));
        let actual = text(&run(s(&c[0]), arr(&c[1]), tables));
        if expected == actual {
            Ok(())
        } else {
            Err(format!(
                "arguments {}\n    TypeScript: {expected}\n    Rust:       {actual}",
                text(&JsValue::from(&c[1]))
            ))
        }
    });
    for (f, n) in &counts {
        println!("  {source} {f}: {n}");
    }
    if let Err(e) = result {
        panic!("{e}");
    }
    counts
}

#[test]
fn programs() {
    gate("programs");
}

#[test]
fn edges() {
    gate("edges");
}

#[test]
fn sweep() {
    gate("sweep");
}

#[test]
fn every_function_has_cases() {
    let mut all: BTreeMap<String, usize> = BTreeMap::new();
    for source in ["programs", "edges", "sweep"] {
        for part in parts(source) {
            for case in arr(part.get("cases").expect("cases")) {
                *all.entry(s(&arr(case)[0]).to_owned()).or_default() += 1;
            }
        }
    }
    let missing: Vec<&str> = FUNCTIONS
        .iter()
        .copied()
        .filter(|f| !all.contains_key(*f))
        .collect();
    assert!(missing.is_empty(), "no cases of {missing:?}; {HOW}");
    let unknown: Vec<&String> = all
        .keys()
        .filter(|k| !FUNCTIONS.contains(&k.as_str()))
        .collect();
    assert!(
        unknown.is_empty(),
        "cases of functions the test does not list: {unknown:?}"
    );
}

fn entries<T>(xs: &[(&str, T)], f: impl Fn(&T) -> JsValue) -> JsValue {
    JsValue::Array(
        xs.iter()
            .map(|(k, v)| JsValue::Array(vec![JsValue::from(*k), f(v)]))
            .collect(),
    )
}

#[test]
fn std_tables() {
    let file = read("std.json");
    let expected = file.get("std").and_then(Value::as_object).expect("std");
    let classes: Vec<&str> = DATA_CLASSES.iter().map(|c| c.as_str()).collect();
    let lookups: Vec<JsValue> = expected
        .get("lookups")
        .map(arr)
        .unwrap_or_default()
        .iter()
        .map(|row| {
            let k = s(&arr(row)[0]);
            JsValue::Array(vec![
                k.into(),
                cap_ctor(k).map_or(JsValue::Null, |c| c.to_js().into()),
                std_effect(k).map_or(JsValue::Null, |e| e.to_js().into()),
                std_fn(k).map_or(JsValue::Null, |f| f.to_js().into()),
                is_builtin_effect(k).into(),
                is_ungated_effect(k).into(),
                is_decision_policy(k).into(),
                is_protected_type(k).into(),
                is_out_of_scope_option(k).into(),
            ])
        })
        .collect();
    let actual = JsObject::new()
        .with("DATA_CLASSES", strs_js(&classes))
        .with(
            "classRank",
            JsValue::Array(
                DATA_CLASSES
                    .iter()
                    .map(|c| JsValue::Array(vec![c.as_str().into(), class_rank(*c).into()]))
                    .collect(),
            ),
        )
        .with("BUILTIN_EFFECTS", strs_js(&BUILTIN_EFFECTS))
        .with("UNGATED_EFFECTS", strs_js(&UNGATED_EFFECTS))
        .with("CAP_CTORS", entries(&CAP_CTORS, |c| c.to_js().into()))
        .with("DEFAULT_MODEL_MAX_CLASS", DEFAULT_MODEL_MAX_CLASS.as_str())
        .with("STD_EFFECTS", entries(&STD_EFFECTS, |e| e.to_js().into()))
        .with("STD_FNS", entries(&STD_FNS, |f| f.to_js().into()))
        .with("DECISION_POLICIES", strs_js(&DECISION_POLICIES))
        .with("PROTECTED_TYPES", strs_js(&PROTECTED_TYPES))
        .with("OUT_OF_SCOPE_OPTIONS", strs_js(&OUT_OF_SCOPE_OPTIONS))
        .with("MAX_RESTARTS", MAX_RESTARTS)
        .with("MAX_CHOICE_OPTIONS", MAX_CHOICE_OPTIONS)
        .with("lookups", JsValue::Array(lookups))
        .with("HTTP_METHODS", strs_js(&HTTP_METHODS))
        .with(
            "GOVERNANCE_KINDS",
            strs_js(&GOVERNANCE_KINDS.map(|k| k.as_str())),
        )
        .with(
            "GOVERNANCE_FILES",
            JsValue::Array(
                GOVERNANCE_FILES
                    .iter()
                    .map(|(k, globs)| JsValue::Array(vec![k.as_str().into(), strs_js(globs)]))
                    .collect(),
            ),
        )
        .with("PATH_PATTERN", PATH_PATTERN);
    let mut wrong = Vec::new();
    for (k, v) in expected.iter() {
        let want = text(&JsValue::from(v));
        let got = actual.get(k).map(text).unwrap_or_default();
        if want != got {
            wrong.push(format!(
                "{k}\n    TypeScript: {want}\n    Rust:       {got}"
            ));
        }
    }
    let keys: Vec<&str> = expected.keys().collect();
    let ours: Vec<&str> = actual.keys().collect();
    assert_eq!(keys, ours, "the tables differ in which there are");
    assert!(
        wrong.is_empty(),
        "{} table(s) differ:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
    // And whole, in order.
    assert_eq!(
        text(&JsValue::from(file.get("std").unwrap())),
        text(&actual.into())
    );
    println!("std: {} tables, the same", keys.len());
}
