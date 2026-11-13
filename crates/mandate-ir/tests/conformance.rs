//! Runs, with this crate alone, the conformance cases that need only the
//! strict JSON reader and the hashes (`conformance/`, see its README). The
//! cases are written for any implementation; most of them need a compiler
//! (the text reader, schema validation, name resolution, the static checks)
//! and are counted as skipped, with the reason.
//!
//! A case is run when it is a `compile` case with a JSON input, given inline
//! or as a file, and none of `patch`, `modules`, `lock`, `subprogram`,
//! `amendment` and `base`, and either
//!
//! - every diagnostic it expects has a code of the reader (MDT-E0102, E0105,
//!   E0106, E0107, E0108): the input must be refused with those diagnostics,
//!   one to one, in order, by code and JSON Pointer (and by the facts the
//!   case names, as a subset); or
//! - it expects `ok` with `hashes` and no diagnostics: the input must be
//!   accepted, and `hash_program` must give the program hash (and the
//!   definition hashes, when the case gives them).
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
use std::fs;
use std::path::{Path, PathBuf};

use mandate_ir::{Diagnostic, Parsed, Value, canonicalize, hash_program, parse, parse_bytes};

/// The codes the strict JSON reader gives.
const READER_CODES: [&str; 5] = [
    "MDT-E0102",
    "MDT-E0105",
    "MDT-E0106",
    "MDT-E0107",
    "MDT-E0108",
];

/// Members of a case that only a compiler can honour.
const NEEDS_A_COMPILER: [&str; 6] = [
    "patch",
    "modules",
    "lock",
    "subprogram",
    "amendment",
    "base",
];

/// The repository root: `MANDATE_REPO` when it is set (`scripts/wasi-test.mjs`
/// sets it, since the compile-time path does not exist under WASI), else the
/// path from this crate's directory.
fn repo() -> PathBuf {
    match std::env::var_os("MANDATE_REPO") {
        Some(root) => PathBuf::from(root),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."),
    }
}

/// Reads a case file with this crate's own reader.
fn read_case(path: &Path) -> Value {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    match parse_bytes(&bytes) {
        Ok(parsed) => parsed.value,
        Err(d) => panic!("{} does not read: {d:?}", path.display()),
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no string member {key} in {}", canonicalize(v)))
}

/// What a case asks of this crate.
enum Plan<'a> {
    /// The reader refuses the input with these diagnostics.
    Refuse(&'a [Value]),
    /// The reader accepts the input, and its hashes are these.
    Hashes(&'a Value),
}

/// What the case asks of this crate, or why a compiler is needed instead.
fn plan(case: &Value) -> Result<Plan<'_>, String> {
    if str_of(case, "kind") != "compile" {
        return Err("a run case".to_owned());
    }
    for key in NEEDS_A_COMPILER {
        if case.get(key).is_some() {
            return Err(format!("it has `{key}`, which needs a compiler"));
        }
    }
    let input = case.get("input").expect("a case has an input");
    if str_of(input, "kind") != "json" {
        return Err("its input is Mandate text, which needs a compiler to read".to_owned());
    }
    let expect = case.get("expect").expect("a case has an expect");
    let diags = expect
        .get("diagnostics")
        .and_then(Value::as_array)
        .expect("expect has diagnostics");
    if expect.get("ok") == Some(&Value::Bool(false)) {
        let reader_only = !diags.is_empty()
            && diags
                .iter()
                .all(|d| READER_CODES.contains(&str_of(d, "code")));
        if reader_only {
            Ok(Plan::Refuse(diags))
        } else {
            Err("it expects diagnostics that only a compiler gives".to_owned())
        }
    } else {
        match expect.get("hashes") {
            Some(hashes) if diags.is_empty() => Ok(Plan::Hashes(hashes)),
            _ => Err("it expects ok with no hashes, or with warnings: a compiler".to_owned()),
        }
    }
}

/// Reads the JSON input of a case, given inline or as a file next to it.
fn read_input(dir: &Path, input: &Value) -> Result<Parsed, Vec<Diagnostic>> {
    if let Some(text) = input.get("text") {
        return parse(text.as_str().expect("text is a string"));
    }
    let path = dir.join(str_of(input, "file"));
    let bytes = fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    parse_bytes(&bytes)
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
                if found.map(canonicalize) != Some(canonicalize(value)) {
                    problems.push(format!(
                        "diagnostic {i} ({code}): fact {key}: expected {}, got {:?}",
                        canonicalize(value),
                        found.map(canonicalize)
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
fn cases_that_need_only_the_reader_and_the_hashes() {
    let mut dirs: Vec<PathBuf> = fs::read_dir(repo().join("conformance"))
        .expect("the conformance directory")
        .map(|entry| entry.expect("an entry").path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();

    let mut ran = 0_usize;
    let mut skipped: BTreeMap<String, usize> = BTreeMap::new();
    let mut failures: Vec<String> = Vec::new();
    for dir in &dirs {
        let name = dir
            .file_name()
            .and_then(|n| n.to_str())
            .expect("a case directory has a name");
        let case = read_case(&dir.join("case.json"));
        assert_eq!(
            str_of(&case, "format"),
            "mandate/conformance-case/0.1",
            "{name}"
        );
        assert_eq!(str_of(&case, "id"), name, "the id is the directory name");
        match plan(&case) {
            Err(reason) => *skipped.entry(reason).or_default() += 1,
            Ok(plan) => {
                ran += 1;
                let input = case.get("input").expect("a case has an input");
                let problems = match (plan, read_input(dir, input)) {
                    (Plan::Refuse(want), Err(got)) => check_refused(&got, want),
                    (Plan::Refuse(_), Ok(_)) => vec![
                        "the reader accepted an input that the case expects it to refuse"
                            .to_owned(),
                    ],
                    (Plan::Hashes(want), Ok(parsed)) => check_hashes(&parsed.value, want),
                    (Plan::Hashes(_), Err(got)) => {
                        vec![format!(
                            "the reader refused an input the case hashes: {got:?}"
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
