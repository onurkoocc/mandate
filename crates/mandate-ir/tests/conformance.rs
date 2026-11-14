//! Runs, with this crate alone, the conformance cases that need only reading
//! a program given as JSON IR and the hashes (`conformance/`, see its README).
//! The cases are written for any implementation; most of them need a
//! compiler (the text reader, name resolution, the static checks) and are
//! counted as skipped, with the reason.
//!
//! A case is decided by `load` alone when it goes through `check` (no
//! `patch`, `base`, `subprogram` or `amendment`), its input is JSON, and
//! `load(input, "json")` reports an error: `check` then returns `{ ok: false,
//! diagnostics }` with load's diagnostics at its first line, whatever the
//! modules and the lock. Load's errors have only the codes of the reader
//! (MDT-E0102, E0105, E0106, E0107, E0108) and of `validateIr` (E0103,
//! E0104, E0105), so a stored result that is `ok` or holds another code is
//! not one of these. Such a case is run: [`load_json`] must refuse the input
//! with exactly the diagnostics of its vector in
//! `vectors/diagnostics/conformance-1.json` (every member, in order), and
//! they must also meet the case's own `expect` (one to one by code and JSON
//! Pointer, facts as a subset).
//!
//! A case with a JSON input and none of `patch`, `modules`, `lock`,
//! `subprogram`, `amendment` and `base` that expects `ok` with `hashes` and
//! no diagnostics is run too: [`load_json`] must accept the input with no
//! diagnostic, and `hash_program` must give the program hash (and the
//! definition hashes, when the case gives them).
//!
//! The case files are read with this crate's own reader.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeMap;

use mandate_ir::{
    Diagnostic, JsValue, Value, canonicalize, hash_program, load_json, stringify, stringify_pretty,
};
use mandate_testkit::{compare_text, read_bytes, read_json, subdirectories};

/// The codes `load(text, "json")` gives: the strict JSON reader's and
/// `validateIr`'s.
const LOAD_CODES: [&str; 7] = [
    "MDT-E0102",
    "MDT-E0103",
    "MDT-E0104",
    "MDT-E0105",
    "MDT-E0106",
    "MDT-E0107",
    "MDT-E0108",
];

/// The whole results the TypeScript compiler gives for the cases, by name.
fn vectors() -> BTreeMap<String, Value> {
    let first = read_json("vectors/diagnostics/conformance-1.json").expect("the vectors");
    let parts = first.get("parts").and_then(Value::as_i64).expect("parts");
    let mut out = BTreeMap::new();
    for n in 1..=parts {
        let file = if n == 1 {
            first.clone()
        } else {
            read_json(&format!("vectors/diagnostics/conformance-{n}.json")).expect("a part")
        };
        for case in file.get("cases").and_then(Value::as_array).expect("cases") {
            out.insert(str_of(case, "name").to_owned(), case.clone());
        }
    }
    out
}

/// Members of a case that only a compiler can honour.
const NEEDS_A_COMPILER: [&str; 6] = [
    "patch",
    "modules",
    "lock",
    "subprogram",
    "amendment",
    "base",
];

/// Reads a case file with this crate's own reader.
fn read_case(rel: &str) -> Value {
    read_json(rel).unwrap_or_else(|e| panic!("{e}"))
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no string member {key} in {}", canonicalize(v)))
}

/// What a case asks of this crate.
enum Plan<'a> {
    /// `load` refuses the input: with the diagnostics of the stored result,
    /// whole, which meet the case's own expected diagnostics.
    Refuse {
        result: &'a Value,
        expected: &'a [Value],
    },
    /// `load` accepts the input, and its hashes are these.
    Hashes(&'a Value),
}

/// What the case asks of this crate, or why a compiler is needed instead.
fn plan<'a>(case: &'a Value, vector: Option<&'a Value>) -> Result<Plan<'a>, String> {
    if str_of(case, "kind") != "compile" {
        return Err("a run case".to_owned());
    }
    let input = case.get("input").expect("a case has an input");
    let expect = case.get("expect").expect("a case has an expect");
    let diags = expect
        .get("diagnostics")
        .and_then(Value::as_array)
        .expect("expect has diagnostics");
    let vector = vector.ok_or("it has no vector")?;
    let result = vector.get("result").expect("a vector has a result");
    let load_only = str_of(vector, "door") == "check"
        && str_of(input, "kind") == "json"
        && result.get("ok") == Some(&Value::Bool(false))
        && result
            .get("diagnostics")
            .and_then(Value::as_array)
            .is_some_and(|ds| ds.iter().all(|d| LOAD_CODES.contains(&str_of(d, "code"))));
    if load_only {
        return Ok(Plan::Refuse {
            result,
            expected: diags,
        });
    }
    for key in NEEDS_A_COMPILER {
        if case.get(key).is_some() {
            return Err(format!("it has `{key}`, which needs a compiler"));
        }
    }
    if str_of(input, "kind") != "json" {
        return Err("its input is Mandate text, which needs a compiler to read".to_owned());
    }
    if expect.get("ok") == Some(&Value::Bool(false)) {
        Err("it expects diagnostics that only a compiler gives".to_owned())
    } else {
        match expect.get("hashes") {
            Some(hashes) if diags.is_empty() => Ok(Plan::Hashes(hashes)),
            _ => Err("it expects ok with no hashes, or with warnings: a compiler".to_owned()),
        }
    }
}

/// The JSON input of a case, given inline or as a file next to it, as text:
/// a file is decoded as `readFileSync(file, "utf8")` decodes it.
fn read_input(dir: &str, input: &Value) -> String {
    if let Some(text) = input.get("text") {
        return text.as_str().expect("text is a string").to_owned();
    }
    let rel = format!("{dir}/{}", str_of(input, "file"));
    String::from_utf8_lossy(&read_bytes(&rel).unwrap_or_else(|e| panic!("{e}"))).into_owned()
}

/// How `load`'s diagnostics differ from the stored ones: the whole text of
/// `{ ok: false, diagnostics }` as `JSON.stringify(v, null, 2)` writes it.
fn check_result(got: &[Diagnostic], result: &Value) -> Vec<String> {
    let mine = JsValue::Object(mandate_ir::JsObject::new().with("ok", false).with(
        "diagnostics",
        got.iter().map(Diagnostic::to_js).collect::<Vec<_>>(),
    ));
    let text = |v: &JsValue| stringify_pretty(v).unwrap_or_default();
    match compare_text(&text(&JsValue::from(result)), &text(&mine)) {
        Ok(()) => Vec::new(),
        Err(why) => vec![format!("the result differs from its vector: {why}")],
    }
}

/// How the reader's diagnostics differ from the ones the case expects: in
/// order, one to one, by code and path; facts as a subset.
fn check_refused(got: &[Diagnostic], want: &[Value]) -> Vec<String> {
    let mut problems = Vec::new();
    if got.len() != want.len() {
        let codes: Vec<&str> = got.iter().map(|d| d.code.as_str()).collect();
        problems.push(format!(
            "expected {} diagnostics, got {}: {codes:?}",
            want.len(),
            got.len()
        ));
        return problems;
    }
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        let code = str_of(w, "code");
        if g.code != code {
            problems.push(format!(
                "diagnostic {i}: expected code {code}, got {}",
                g.code
            ));
        }
        let path = str_of(w, "path");
        let have = g.at.path.as_deref().unwrap_or("");
        if have != path {
            problems.push(format!(
                "diagnostic {i} ({code}): expected path {path:?}, got {have:?}"
            ));
        }
        if let Some(facts) = w.get("facts").and_then(Value::as_object) {
            for (key, value) in facts.iter() {
                let found = g.facts.as_ref().and_then(|m| m.get(key));
                let expected = stringify(&JsValue::from(value));
                if found.and_then(stringify) != expected {
                    problems.push(format!(
                        "diagnostic {i} ({code}): fact {key}: expected {expected:?}, got {:?}",
                        found.and_then(stringify)
                    ));
                }
            }
        }
    }
    problems
}

/// How the hashes of `program` differ from the ones the case expects.
fn check_hashes(program: &Value, want: &Value) -> Vec<String> {
    let mut problems = Vec::new();
    let got = hash_program(program);
    if let Some(expected) = want.get("program").and_then(Value::as_str)
        && got.program != expected
    {
        problems.push(format!(
            "program hash: expected {expected}, got {}",
            got.program
        ));
    }
    if let Some(expected) = want.get("defs").and_then(Value::as_object) {
        let have: BTreeMap<&str, &str> = got
            .defs
            .iter()
            .map(|(name, hash)| (name.as_str(), hash.as_str()))
            .collect();
        let wanted: BTreeMap<&str, &str> = expected
            .iter()
            .map(|(name, hash)| (name, hash.as_str().expect("a definition hash is a string")))
            .collect();
        if have != wanted {
            problems.push(format!(
                "definition hashes: expected {wanted:?}, got {have:?}"
            ));
        }
    }
    problems
}

#[test]
fn cases_that_need_only_loading_json_and_the_hashes() {
    let dirs = subdirectories("conformance").expect("the conformance directory");
    let vectors = vectors();
    let mut run: Vec<String> = Vec::new();

    let mut ran = 0_usize;
    let mut skipped: BTreeMap<String, usize> = BTreeMap::new();
    let mut failures: Vec<String> = Vec::new();
    for name in &dirs {
        let dir = format!("conformance/{name}");
        let case = read_case(&format!("{dir}/case.json"));
        assert_eq!(
            str_of(&case, "format"),
            "mandate/conformance-case/0.1",
            "{name}"
        );
        assert_eq!(
            str_of(&case, "id"),
            name.as_str(),
            "the id is the directory name"
        );
        match plan(&case, vectors.get(name)) {
            Err(reason) => *skipped.entry(reason).or_default() += 1,
            Ok(plan) => {
                ran += 1;
                run.push(name.clone());
                let input = case.get("input").expect("a case has an input");
                let loaded = load_json(&read_input(&dir, input));
                let problems = match (plan, loaded.program) {
                    (Plan::Refuse { result, expected }, None) => {
                        let mut problems = check_result(&loaded.diagnostics, result);
                        problems.extend(check_refused(&loaded.diagnostics, expected));
                        problems
                    }
                    (Plan::Refuse { .. }, Some(_)) => {
                        vec!["load accepted an input that the case expects it to refuse".to_owned()]
                    }
                    (Plan::Hashes(want), Some(program)) if loaded.diagnostics.is_empty() => {
                        check_hashes(&program, want)
                    }
                    (Plan::Hashes(_), _) => {
                        vec![format!(
                            "load refused an input the case hashes, or warned: {:?}",
                            loaded.diagnostics
                        )]
                    }
                };
                failures.extend(problems.into_iter().map(|p| format!("{name}: {p}")));
            }
        }
    }

    let skipped_total: usize = skipped.values().sum();
    println!(
        "conformance cases: ran {ran}, skipped {skipped_total} (of {})",
        dirs.len()
    );
    println!("  ran: {}", run.join(" "));
    for (reason, n) in &skipped {
        println!("  skipped {n}: {reason}");
    }
    assert!(ran > 0, "no conformance case was run");
    assert!(
        failures.is_empty(),
        "{} problem(s) in the cases this crate runs:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
