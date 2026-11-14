//! The diagnostic vectors of language 0.6, `vectors/diagnostics-0.6/`: the
//! whole result the Rust compiler gives for every compile case of 0.6 in
//! `conformance/` and for the checks of every 0.6 program of
//! `fixtures/library/`, in the layout and formats of `vectors/diagnostics/`
//! (`conformance-N.json`, `golden-N.json`, `summary.json`, written as
//! `vectorText` in `compiler/test/diagnostic-vectors.test.ts` writes them).
//! No TypeScript reads 0.6, so the Rust writes them.
//!
//! A normal run makes them again and fails when one differs from the
//! committed file; `MANDATE_UPDATE_0_6=1` writes them instead
//! (`mandate_testkit::rust_vectors`). They hold messages and spans, which the
//! conformance cases do not compare: they catch a change of either; the
//! cases say which codes and paths are right.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;
mod outputs;

use std::collections::BTreeMap;

use common::{
    Applied, applied_source, check_with, kind_named, modules_of, patched_source, read_source,
    run_amendment, run_subprogram, subprogram_case,
};
use mandate_ir::{Diagnostic, JsObject, JsValue, Value};
use mandate_syntax::{SourceKind, kind_of, load};
use mandate_testkit::rust_only::RUST_ONLY_LANGUAGES;
use mandate_testkit::rust_vectors::{DIAGNOSTICS_0_6, pin, programs_0_6, vector_text};
use mandate_testkit::{parse_json, read_json, repo_path, subdirectories};

/// The front door of a case, as `doorOf` names it.
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

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn js_strings(xs: &[String]) -> JsValue {
    JsValue::Array(xs.iter().map(|x| JsValue::from(x.as_str())).collect())
}

/// What the case's door returns, as the vectors store it.
fn result_of(id: &str, case: &Value, door: &str) -> Result<JsValue, String> {
    let dir = format!("conformance/{id}");
    let input = case.get("input").ok_or("no input")?;
    let kind = kind_named(input.get("kind").and_then(Value::as_str).unwrap_or("mdt"));
    let text = match input.get("text").and_then(Value::as_str) {
        Some(t) => t.to_owned(),
        None => read_source(&repo_path(
            &dir,
            input.get("file").and_then(Value::as_str).ok_or("no file")?,
        ))?,
    };
    let names = strings(case.get("modules"));
    let files: Vec<String> = names.iter().map(|m| repo_path(&dir, m)).collect();
    let modules = modules_of(&files, &names)?;
    let lock = case
        .get("lock")
        .and_then(Value::as_str)
        .map(|l| repo_path(&dir, l));
    let door_value = |text: &str| parse_json(text.as_bytes()).map(|v| JsValue::from(&v));
    match door {
        "check_subprogram" | "check_amendment" => {
            let parent = check_with(&text, kind, Some(&modules), None)?;
            let (Some(program), true) = (parent.program.as_ref(), parent.ok) else {
                return Err("the parent must check without errors".to_owned());
            };
            let r = match case.get("subprogram") {
                Some(s) => run_subprogram(&subprogram_case(&dir, s, program)?, program, &modules)?,
                None => run_amendment(
                    case.get("amendment").ok_or("no amendment")?,
                    program,
                    &modules,
                )?,
            };
            door_value(&r.text)
        }
        _ => {
            let (text, kind) = match case.get("patch").and_then(Value::as_array) {
                Some(patch) if door == "apply_ops" => {
                    let base = case.get("base").and_then(Value::as_str).ok_or("no base")?;
                    match applied_source(&text, kind, base, patch)? {
                        Applied::Source(patched) => (patched, SourceKind::Json),
                        Applied::Refused(refused) => return Ok(refused.to_js()),
                    }
                }
                Some(patch) => (patched_source(&text, kind, patch)?, SourceKind::Json),
                None => (text, kind),
            };
            Ok(check_with(&text, kind, Some(&modules), lock.as_deref())?.to_js())
        }
    }
}

/// The diagnostics of a stored result: its `diagnostics`, or the array it is.
fn diagnostics_of(v: &JsValue) -> Vec<&JsValue> {
    match v {
        JsValue::Array(items) => items.iter().collect(),
        other => other
            .get("diagnostics")
            .and_then(JsValue::as_array)
            .unwrap_or_default()
            .iter()
            .collect(),
    }
}

#[test]
fn the_diagnostic_vectors_of_0_6_are_what_the_rust_gives() {
    let mut problems: Vec<String> = Vec::new();
    let mut by_code: BTreeMap<String, usize> = BTreeMap::new();
    let mut count = |v: &JsValue| {
        for d in diagnostics_of(v) {
            if let Some(code) = d.get("code").and_then(JsValue::as_str) {
                *by_code.entry(code.to_owned()).or_default() += 1;
            }
        }
    };

    // The compile cases of 0.6, by name.
    let mut cases: Vec<JsValue> = Vec::new();
    let mut by_door: BTreeMap<&str, usize> = BTreeMap::new();
    for id in subdirectories("conformance").expect("the conformance directory") {
        let case = read_json(&format!("conformance/{id}/case.json")).expect("a case");
        let of_0_6 = case
            .get("language")
            .and_then(Value::as_str)
            .is_some_and(|l| RUST_ONLY_LANGUAGES.contains(&l));
        if !of_0_6 || case.get("kind").and_then(Value::as_str) != Some("compile") {
            continue;
        }
        let door = door_of(&case);
        *by_door.entry(door).or_default() += 1;
        let result = match result_of(&id, &case, door) {
            Ok(r) => r,
            Err(e) => {
                problems.push(format!("conformance/{id}: {e}"));
                continue;
            }
        };
        count(&result);
        let input = case.get("input").expect("an input");
        let kind = input.get("kind").and_then(Value::as_str).unwrap_or("mdt");
        let input = match input.get("file").and_then(Value::as_str) {
            Some(file) => JsObject::new().with("file", file).with("kind", kind),
            None => JsObject::new().with("inline", true).with("kind", kind),
        };
        let uses: Vec<String> = ["patch", "base", "subprogram", "amendment"]
            .iter()
            .filter(|k| case.get(k).is_some())
            .map(|k| (*k).to_owned())
            .collect();
        cases.push(
            JsObject::new()
                .with("name", id.as_str())
                .with("kind", "compile")
                .with("door", door)
                .with("input", input)
                .with("modules", js_strings(&strings(case.get("modules"))))
                .with(
                    "lock",
                    case.get("lock")
                        .and_then(Value::as_str)
                        .map_or(JsValue::Null, JsValue::from),
                )
                .with("uses", js_strings(&uses))
                .with("result", result)
                .into(),
        );
    }

    // The checks of the 0.6 programs.
    let mut programs: Vec<JsValue> = Vec::new();
    let mut golden_results: usize = 0;
    for p in programs_0_6().expect("the 0.6 programs") {
        let lock = outputs::lock_file_of(&p);
        let mut results = JsObject::new();
        let slots: [(&str, bool, bool); 3] = [
            ("check", false, false),
            ("check_module", true, false),
            ("check_lock", true, true),
        ];
        for (slot, with_modules, with_lock) in slots {
            if with_lock && lock.is_none() {
                continue;
            }
            match outputs::checked(&p, with_modules, with_lock) {
                Ok(r) => {
                    let v = r.to_js();
                    count(&v);
                    results.insert(slot, v);
                }
                Err(e) => problems.push(format!("{p} {slot}: {e}")),
            }
        }
        match read_source(&p) {
            Ok(text) => {
                let v = JsValue::Array(
                    load(&text, kind_of(&p))
                        .diagnostics
                        .iter()
                        .map(Diagnostic::to_js)
                        .collect(),
                );
                count(&v);
                results.insert("load", v);
            }
            Err(e) => problems.push(e),
        }
        golden_results += results.len();
        programs.push(
            JsObject::new()
                .with("program", p.as_str())
                .with("modules", js_strings(&outputs::module_files_of(&p)))
                .with("lock", lock.map_or(JsValue::Null, JsValue::from))
                .with("results", results)
                .with("texts", JsObject::new())
                .into(),
        );
    }
    assert!(!cases.is_empty(), "no compile case of 0.6");
    assert!(!programs.is_empty(), "no program of 0.6");

    let n_cases = cases.len();
    let diagnostics: usize = by_code.values().sum();
    let summary: JsValue = JsObject::new()
        .with("format", "mandate/vectors/diagnostics/summary/0.1")
        .with("conformance_cases", n_cases)
        .with(
            "conformance_by_door",
            by_door
                .iter()
                .map(|(d, n)| (*d, JsValue::from(*n)))
                .collect::<JsObject>(),
        )
        .with("golden_results", golden_results)
        .with("diagnostics", diagnostics)
        .with(
            "by_code",
            by_code
                .iter()
                .map(|(c, n)| (c.as_str(), JsValue::from(*n)))
                .collect::<JsObject>(),
        )
        .into();
    let part = |format: &str, member: &str, items: Vec<JsValue>| -> JsValue {
        JsObject::new()
            .with("format", format)
            .with("part", 1)
            .with("parts", 1)
            .with(member, JsValue::Array(items))
            .into()
    };
    let files = [
        (
            format!("{DIAGNOSTICS_0_6}/conformance-1.json"),
            part(
                "mandate/vectors/diagnostics/conformance/0.1",
                "cases",
                cases,
            ),
        ),
        (
            format!("{DIAGNOSTICS_0_6}/golden-1.json"),
            part(
                "mandate/vectors/diagnostics/golden/0.1",
                "programs",
                programs,
            ),
        ),
        (format!("{DIAGNOSTICS_0_6}/summary.json"), summary),
    ];
    for (rel, value) in &files {
        match pin(rel, &vector_text(value)) {
            Ok(line) => println!("{line}"),
            Err(e) => problems.push(e),
        }
    }
    println!(
        "diagnostic vectors of 0.6: {n_cases} cases, {golden_results} results of programs, {diagnostics} diagnostics"
    );
    // Nothing else is in the directory.
    let mut want: Vec<String> = files
        .iter()
        .map(|(rel, _)| rel.rsplit('/').next().unwrap_or_default().to_owned())
        .collect();
    want.sort();
    match mandate_testkit::files(DIAGNOSTICS_0_6) {
        Ok(found) if found == want => {}
        Ok(found) => problems.push(format!(
            "{DIAGNOSTICS_0_6} holds {found:?}, expected {want:?}"
        )),
        Err(e) => problems.push(e),
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
