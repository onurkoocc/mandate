//! The conformance gate: every compile case of `conformance/` whose front
//! door is `check` or `check_patched` goes through `mandate_check::check`
//! with its modules and its lock (a `check_patched` case: its input loaded,
//! the case's RFC 6902 `patch` applied to the IR as the TypeScript runner
//! applies it, `common::apply_json_patch`, and the patched IR checked as
//! `JSON.stringify` text), and the result must meet the case's `expect` under the rule of
//! `conformance/README.md` ("How a result is compared"): `ok`; the
//! diagnostics in order, one to one, by code and path (a diagnostic without
//! a path is at `""`); `facts` as a subset, each deeply equal; `hashes`
//! exactly, when given. Messages and spans are not compared here (the
//! diagnostics gate compares them).
//!
//! An item is named `<door> @ conformance/<id> [codes]`, the codes being
//! those the case expects (see `mandate_testkit::codes`). The cases of the
//! other doors (a `patch` with a `base`, which goes through `applyOps`, a
//! `subprogram`, an `amendment`) are items too, pending by door until R13
//! ports them; a case
//! with a lock goes through `check` like the others, its lock passed to the
//! seam that R14 fills. The journal cases are not compile cases: they are
//! counted as skipped, with the reason (the Rust verifier runs them in
//! `crates/verify-journal/tests/conformance.rs`).
//!
//! This supersedes the part of `crates/mandate-ir/tests/conformance.rs` that
//! ran the cases a JSON reader alone decides; that test keeps the cases
//! whose pinned hashes `mandate-ir` alone gives.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use std::collections::BTreeMap;

use common::{check_with, kind_named, modules_of, patched_source, read_source};
use mandate_check::CheckResult;
use mandate_ir::{JsValue, Value, canonicalize, parse, stringify};
use mandate_syntax::SourceKind;
use mandate_testkit::{check_pending, item_name, read_json, repo_path, run_gate, subdirectories};

/// The items the Rust compiler does not give yet: a glob for each family of
/// codes whose stage is not ported (the slice that ports it beside it), and
/// one for each front door that is not.
const PENDING: &[&str] = &[
    // R11: the static core (types, expressions, budgets, cost).
    "*MDT-E02*",
    "*MDT-E05*",
    // R12: the static authority (capabilities, delegation, effects, envelopes, methods).
    "*MDT-E03*",
    "*MDT-W0310*",
    "*MDT-E04*",
    "*MDT-W06*",
    "*MDT-E07*",
    "*MDT-E17*",
    "*MDT-E1801*",
    // R14: the lock.
    "*MDT-E1502*",
    "*MDT-E1802*",
    "*MDT-E1803*",
    // R13: the doors of patches, sub-programs and amendments.
    "apply_ops @ *",
    "check_subprogram @ *",
    "check_amendment @ *",
];

/// The front door a compile case goes through, as `doorOf` in
/// `compiler/test/diagnostic-vectors.test.ts` names it.
fn door_of(case: &Value) -> &'static str {
    if case.get("amendment").is_some() {
        "check_amendment"
    } else if case.get("subprogram").is_some() {
        "check_subprogram"
    } else if case.get("patch").is_some() {
        if case.get("base").is_some() {
            "apply_ops"
        } else {
            "check_patched"
        }
    } else {
        "check"
    }
}

/// `deepEqual(a, b)` of `compiler/test/cases-runner.ts` for JSON values: the
/// same canonical text (members in any order, arrays in order).
fn deep_equal(a: &JsValue, b: &Value) -> bool {
    stringify(a)
        .and_then(|t| parse(&t).ok())
        .is_some_and(|p| canonicalize(&p.value) == canonicalize(b))
}

/// `compareResult(expect, got)`: every difference, none when the case holds.
fn compare_result(expect: &Value, got: &CheckResult) -> Vec<String> {
    let mut problems = Vec::new();
    let want_ok = expect.get("ok").and_then(|v| match v {
        Value::Bool(b) => Some(*b),
        _ => None,
    });
    if want_ok != Some(got.ok) {
        problems.push(format!("ok: expected {want_ok:?}, got {}", got.ok));
    }
    let want = expect
        .get("diagnostics")
        .and_then(Value::as_array)
        .unwrap_or_default();
    let n = want.len().max(got.diagnostics.len());
    for i in 0..n {
        let (w, h) = (want.get(i), got.diagnostics.get(i));
        let (w, h) = match (w, h) {
            (None, Some(h)) => {
                problems.push(format!(
                    "diagnostic {i}: unexpected {} at {:?}",
                    h.code,
                    h.at.path.as_deref().unwrap_or("")
                ));
                continue;
            }
            (Some(w), None) => {
                problems.push(format!("diagnostic {i}: missing {}", canonicalize(w)));
                continue;
            }
            (Some(w), Some(h)) => (w, h),
            (None, None) => continue,
        };
        let code = w.get("code").and_then(Value::as_str).unwrap_or_default();
        if h.code != code {
            problems.push(format!(
                "diagnostic {i}: expected code {code}, got {}",
                h.code
            ));
        }
        let path = w.get("path").and_then(Value::as_str).unwrap_or_default();
        let have = h.at.path.as_deref().unwrap_or("");
        if have != path {
            problems.push(format!(
                "diagnostic {i} ({code}): expected path {path:?}, got {have:?}"
            ));
        }
        if let Some(facts) = w.get("facts").and_then(Value::as_object) {
            for (key, value) in facts.iter() {
                let found = h.facts.as_ref().and_then(|f| f.get(key));
                if !found.is_some_and(|f| deep_equal(f, value)) {
                    problems.push(format!(
                        "diagnostic {i} ({code}): fact {key}: expected {}, got {:?}",
                        canonicalize(value),
                        found.and_then(stringify)
                    ));
                }
            }
        }
    }
    if let Some(hashes) = expect.get("hashes") {
        let got_hashes = got.hashes.as_ref().map(|h| JsValue::Object(h.to_js()));
        if !got_hashes.as_ref().is_some_and(|h| deep_equal(h, hashes)) {
            problems.push(format!(
                "hashes: expected {}, got {:?}",
                canonicalize(hashes),
                got_hashes.as_ref().and_then(stringify)
            ));
        }
    }
    problems
}

/// What a compile case is run with.
struct Case {
    id: String,
    door: &'static str,
    value: Value,
}

/// Runs a `check` case as `runCompileCase` does: the modules loaded
/// together (they must load), the lock read, then `check`; and the case's
/// `language`, when it gives one, is the one the program declares.
fn run(c: &Case) -> Result<(), String> {
    if c.door != "check" && c.door != "check_patched" {
        return Err(format!("the {} door is not ported", c.door));
    }
    let dir = format!("conformance/{}", c.id);
    let case = &c.value;
    let input = case.get("input").ok_or("no input")?;
    let kind = kind_named(input.get("kind").and_then(Value::as_str).unwrap_or("mdt"));
    let text = match input.get("text").and_then(Value::as_str) {
        Some(t) => t.to_owned(),
        None => read_source(&repo_path(
            &dir,
            input.get("file").and_then(Value::as_str).ok_or("no file")?,
        ))?,
    };
    let names: Vec<String> = case
        .get("modules")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let files: Vec<String> = names.iter().map(|m| repo_path(&dir, m)).collect();
    let modules = modules_of(&files, &names)?;
    let lock = case
        .get("lock")
        .and_then(Value::as_str)
        .map(|l| repo_path(&dir, l));
    // `check_patched`: the patch applied to the loaded IR, and the patched
    // IR checked as JSON text.
    let (text, kind) = match case.get("patch").and_then(Value::as_array) {
        Some(patch) => (patched_source(&text, kind, patch)?, SourceKind::Json),
        None => (text, kind),
    };
    let result = check_with(&text, kind, Some(&modules), lock.as_deref())?;
    if let Some(language) = case.get("language").and_then(Value::as_str) {
        // A program that does not load still declares a language: from the
        // JSON text when there is no program. The runner reads that text
        // with `JSON.parse`, which takes the fractions and lone surrogates
        // the strict reader refuses (the S11 cases); such a text is not
        // looked into here.
        let program_language = result
            .program
            .as_ref()
            .and_then(|p| p.get("language"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let from_text = || match parse(&text) {
            Ok(p) => Some(
                p.value
                    .get("language")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ),
            Err(_) => None,
        };
        let declared = match program_language {
            Some(l) => Some(l),
            None if kind == SourceKind::Json => match from_text() {
                Some(l) => l,
                None => Some(language.to_owned()),
            },
            None => None,
        };
        if declared.as_deref() != Some(language) {
            return Err(format!(
                "the case says language {language}, the program declares {declared:?}"
            ));
        }
    }
    let problems = compare_result(case.get("expect").ok_or("no expect")?, &result);
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n    "))
    }
}

#[test]
fn conformance_gate() {
    check_pending(PENDING).expect("the pending list");
    let dirs = subdirectories("conformance").expect("the conformance directory");
    let mut items: Vec<(String, Case)> = Vec::new();
    let mut skipped: BTreeMap<&str, usize> = BTreeMap::new();
    for id in &dirs {
        let value = read_json(&format!("conformance/{id}/case.json")).unwrap();
        assert_eq!(
            value.get("format").and_then(Value::as_str),
            Some("mandate/conformance-case/0.1"),
            "{id}"
        );
        assert_eq!(
            value.get("id").and_then(Value::as_str),
            Some(id.as_str()),
            "the id is the directory name"
        );
        match value.get("kind").and_then(Value::as_str) {
            Some("compile") => {}
            Some("journal") => {
                *skipped
                    .entry("journal cases: a run's journal, which crates/verify-journal checks")
                    .or_default() += 1;
                continue;
            }
            _ => {
                *skipped
                    .entry("run cases: the runtime's, with no runner in the compiler")
                    .or_default() += 1;
                continue;
            }
        }
        let codes: Vec<&str> = value
            .get("expect")
            .and_then(|e| e.get("diagnostics"))
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(|d| d.get("code").and_then(Value::as_str))
            .collect();
        let door = door_of(&value);
        let name = item_name(door, &format!("conformance/{id}"), &codes);
        items.push((
            name,
            Case {
                id: id.clone(),
                door,
                value,
            },
        ));
    }
    let gate = run_gate("conformance cases", PENDING, items, run);
    for (reason, n) in &skipped {
        println!("  skipped {n}: {reason}");
    }
    if let Err(report) = gate {
        panic!("{report}");
    }
}

/// `apply_json_patch` does what `applyJsonPatch` of
/// `compiler/test/cases-runner.ts` does on the edges the cases do not all
/// reach: `-` is the end only for `add`, an index has no leading zero and
/// stays within the array, `replace` and `remove` need a member that is
/// there, the root can be replaced but not removed, a member that is there
/// keeps its place, and the operations are checked in order with the
/// operation named in the message. Each expectation, message included, is
/// what `applyJsonPatch` gives on the same input in Node (its functions
/// taken from the file and run through `node:module`'s
/// `stripTypeScriptTypes`).
#[test]
fn the_runners_json_patch() {
    let doc = parse(r#"{"a":[1,2],"b":{"x":1,"y":2}}"#).unwrap().value;
    let ops = |text: &str| parse(text).unwrap().value;
    let apply = |text: &str| {
        common::apply_json_patch(&doc, ops(text).as_array().unwrap()).map(|v| canonical_order(&v))
    };
    let ok = |text: &str| apply(text).unwrap();
    assert_eq!(
        ok(r#"[{"op":"add","path":"/a/-","value":3}]"#),
        r#"{"a":[1,2,3],"b":{"x":1,"y":2}}"#
    );
    assert_eq!(
        ok(r#"[{"op":"add","path":"/a/0","value":0}]"#),
        r#"{"a":[0,1,2],"b":{"x":1,"y":2}}"#
    );
    assert_eq!(
        ok(r#"[{"op":"add","path":"/b/x","value":9}]"#),
        r#"{"a":[1,2],"b":{"x":9,"y":2}}"#
    );
    assert_eq!(
        ok(r#"[{"op":"add","path":"/b/z","value":3}]"#),
        r#"{"a":[1,2],"b":{"x":1,"y":2,"z":3}}"#
    );
    assert_eq!(
        ok(r#"[{"op":"replace","path":"/a/1","value":5}]"#),
        r#"{"a":[1,5],"b":{"x":1,"y":2}}"#
    );
    assert_eq!(
        ok(r#"[{"op":"remove","path":"/b/x"}]"#),
        r#"{"a":[1,2],"b":{"y":2}}"#
    );
    assert_eq!(
        ok(r#"[{"op":"replace","path":"","value":{"c":1}}]"#),
        r#"{"c":1}"#
    );
    let err = |text: &str| apply(text).unwrap_err();
    assert_eq!(
        err(r#"[{"op":"remove","path":"/a/0"},{"op":"replace","path":"/a/-","value":1}]"#),
        "patch operation 1 (replace /a/-): \"-\" is not an array index"
    );
    assert_eq!(
        err(r#"[{"op":"remove","path":"/a/01"}]"#),
        "patch operation 0 (remove /a/01): \"01\" is not an array index"
    );
    assert_eq!(
        err(r#"[{"op":"add","path":"/a/3","value":1}]"#),
        "patch operation 0 (add /a/3): index 3 is out of range"
    );
    assert_eq!(
        err(r#"[{"op":"replace","path":"/a/2","value":1}]"#),
        "patch operation 0 (replace /a/2): index 2 is out of range"
    );
    assert_eq!(
        err(r#"[{"op":"replace","path":"/b/z","value":1}]"#),
        "patch operation 0 (replace /b/z): there is no member \"z\""
    );
    assert_eq!(
        err(r#"[{"op":"add","path":"/c/z","value":1}]"#),
        "patch operation 0 (add /c/z): there is no member \"c\""
    );
    assert_eq!(
        err(r#"[{"op":"remove","path":""}]"#),
        "patch operation 0 (remove ): the document root cannot be removed"
    );
    assert_eq!(
        err(r#"[{"op":"move","path":"/a"}]"#),
        "patch operation 0 (move /a): op \"move\" is not supported; use add, replace or remove"
    );
    assert_eq!(
        err(r#"[{"op":"add","path":"a","value":1}]"#),
        "patch operation 0 (add a): \"a\" is not a JSON Pointer"
    );
    assert_eq!(
        err(r#"[{"op":"add","path":"/a/0/x","value":1}]"#),
        "patch operation 0 (add /a/0/x): the parent is not an object or an array"
    );
}

/// The value as compact JSON in its member order, as `JSON.stringify`.
fn canonical_order(v: &Value) -> String {
    stringify(&JsValue::from(v)).unwrap()
}
