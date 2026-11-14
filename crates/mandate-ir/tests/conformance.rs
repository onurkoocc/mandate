//! Runs, with this crate alone, the conformance cases whose pinned hashes
//! need only reading a program given as JSON IR (`conformance/`, see its
//! README): a case with a JSON input and none of `patch`, `modules`,
//! `lock`, `subprogram`, `amendment` and `base` that expects `ok` with
//! `hashes` and no diagnostics. [`load_json`] must accept the input with no
//! diagnostic, and `hash_program` must give the program hash (and the
//! definition hashes, when the case gives them). The other cases are
//! counted as skipped, with the reason.
//!
//! Every compile case that goes through `check`, with what it expects of
//! the reader and of every later stage, is run by the conformance gate of
//! the compiler (`crates/mandate-testkit/tests/conformance.rs`), and its
//! whole stored result by the diagnostics gate
//! (`crates/mandate-testkit/tests/diagnostics.rs`); this test keeps what
//! `mandate-ir` gives without them.
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

use mandate_ir::{Value, canonicalize, hash_program, load_json};
use mandate_testkit::{read_bytes, read_json, subdirectories};

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

/// The hashes the case pins, or why a compiler is needed instead.
fn plan(case: &Value) -> Result<&Value, String> {
    if str_of(case, "kind") != "compile" {
        return Err("not a compile case".to_owned());
    }
    let input = case.get("input").expect("a case has an input");
    let expect = case.get("expect").expect("a case has an expect");
    let diags = expect
        .get("diagnostics")
        .and_then(Value::as_array)
        .expect("expect has diagnostics");
    for key in NEEDS_A_COMPILER {
        if case.get(key).is_some() {
            return Err(format!("it has `{key}`, which needs a compiler"));
        }
    }
    if str_of(input, "kind") != "json" {
        return Err("its input is Mandate text, which needs a compiler to read".to_owned());
    }
    if expect.get("ok") == Some(&Value::Bool(false)) {
        Err("it expects diagnostics: the compiler's gates run it".to_owned())
    } else {
        match expect.get("hashes") {
            Some(hashes) if diags.is_empty() => Ok(hashes),
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
fn cases_whose_hashes_need_only_loading_json() {
    let dirs = subdirectories("conformance").expect("the conformance directory");
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
        match plan(&case) {
            Err(reason) => *skipped.entry(reason).or_default() += 1,
            Ok(want) => {
                ran += 1;
                run.push(name.clone());
                let input = case.get("input").expect("a case has an input");
                let loaded = load_json(&read_input(&dir, input));
                let problems = match loaded.program {
                    Some(program) if loaded.diagnostics.is_empty() => check_hashes(&program, want),
                    _ => vec![format!(
                        "load refused an input the case hashes, or warned: {:?}",
                        loaded.diagnostics
                    )],
                };
                failures.extend(problems.into_iter().map(|p| format!("{name}: {p}")));
            }
        }
    }

    let skipped_total: usize = skipped.values().sum();
    println!(
        "conformance cases with hashes mandate-ir alone gives: ran {ran}, skipped {skipped_total} (of {})",
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
