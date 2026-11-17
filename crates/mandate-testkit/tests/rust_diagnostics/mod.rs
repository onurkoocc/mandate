//! The diagnostic vectors of a language only the Rust compiler reads, as
//! `diagnostics_0_6.rs` and `diagnostics_0_7.rs` write them: the whole
//! result the Rust compiler gives for every compile case of that language in
//! `conformance/` (the case's `language` is exactly it) and for the checks
//! of every program of its directory of fixtures, in the layout and formats
//! of `vectors/diagnostics/` (`conformance-N.json`, `golden-N.json`,
//! `summary.json`, written as `vectorText` in
//! `compiler/test/diagnostic-vectors.test.ts` writes them).

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeMap;

use crate::common::{
    Applied, applied_source, case_config, case_libraries, check_with_libraries, kind_named,
    modules_of, patched_source, read_source, run_amendment, run_library_case, run_subprogram,
    subprogram_case, with_library_modules,
};
use crate::outputs;
use mandate_ir::{Diagnostic, JsObject, JsValue, Value};
use mandate_syntax::{SourceKind, kind_of, load};
use mandate_testkit::rust_vectors::vector_text;
use mandate_testkit::{parse_json, read_json, repo_path, subdirectories};

/// The front door of a case, as `doorOf` names it.
pub fn door_of(case: &Value) -> &'static str {
    if case.get("library").is_some() {
        "library"
    } else if case.get("amendment").is_some() {
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

/// How the program a case checks is read: its text as it is
/// ([`as_it_is`]), or another text made of it (a relabelling), or `None`
/// when the case is not one the caller compares.
pub type TextOf<'a> = &'a dyn Fn(&str, SourceKind) -> Result<Option<String>, String>;

/// The program's text as it is: what the vectors store the result of.
pub fn as_it_is(text: &str, _kind: SourceKind) -> Result<Option<String>, String> {
    Ok(Some(text.to_owned()))
}

/// What the case's door returns, as the vectors store it.
fn result_of(id: &str, case: &Value, door: &str) -> Result<JsValue, String> {
    result_of_text(id, case, door, &as_it_is)?
        .ok_or_else(|| "the case has no program text".to_owned())
}

/// What the case's door returns when the program it checks is read by
/// `text_of`: the program of a `check` case, the patched program of a
/// `check_patched` one (as JSON IR), the program a patch applies to, and the
/// parent of a sub-program or an amendment. `None` when `text_of` gives
/// none. A library case has no program: its door's result as it is.
///
/// # Errors
///
/// What keeps the case from being run, or `text_of`'s error.
pub fn result_of_text(
    id: &str,
    case: &Value,
    door: &str,
    text_of: TextOf<'_>,
) -> Result<Option<JsValue>, String> {
    result_of_text_given(id, case, door, text_of, None)
}

/// [`result_of_text`] of a program of 0.6 relabelled 0.7 by `text_of`: the
/// program checked (and the parent of a sub-program or an amendment) is
/// given besides its modules what
/// [`crate::common::relabelled_modules`] says a relabelled program is given;
/// and whether it was given something (`std.patterns` 1.0.0).
///
/// # Errors
///
/// As [`result_of_text`].
pub fn result_of_relabelled(
    id: &str,
    case: &Value,
    door: &str,
    text_of: TextOf<'_>,
) -> Result<Option<(JsValue, bool)>, String> {
    let given = std::cell::Cell::new(false);
    let r = result_of_text_given(id, case, door, text_of, Some(&given))?;
    Ok(r.map(|v| (v, given.get())))
}

fn result_of_text_given(
    id: &str,
    case: &Value,
    door: &str,
    text_of: TextOf<'_>,
    relabelled: Option<&std::cell::Cell<bool>>,
) -> Result<Option<JsValue>, String> {
    // What the program checked is given besides its modules, when it is a
    // relabelled one.
    let more = |text: &str, kind: SourceKind| {
        let more = relabelled.and_then(|_| crate::common::relabelled_modules(text, kind));
        if let (Some(given), true) = (relabelled, more.is_some()) {
            given.set(true);
        }
        more
    };
    let dir = format!("conformance/{id}");
    if door == "library" {
        let r = run_library_case(&dir, case)?;
        return parse_json(r.text.as_bytes()).map(|v| Some(JsValue::from(&v)));
    }
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
    let door_value = |text: &str| parse_json(text.as_bytes()).map(|v| Some(JsValue::from(&v)));
    match door {
        "check_subprogram" | "check_amendment" => {
            let Some(text) = text_of(&text, kind)? else {
                return Ok(None);
            };
            // 0.6: a parent whose lock pins libraries is checked with them, and
            // the door is handed their modules as the package carries them.
            let libraries = case_libraries(&dir, case);
            let modules = crate::common::with_more(Some(&modules), more(&text, kind).as_ref())
                .unwrap_or(modules);
            let parent = check_with_libraries(&text, kind, Some(&modules), None, &libraries, None)?;
            let modules = with_library_modules(&modules, &libraries)?;
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
                    let Some(text) = text_of(&text, kind)? else {
                        return Ok(None);
                    };
                    let base = case.get("base").and_then(Value::as_str).ok_or("no base")?;
                    match applied_source(&text, kind, base, patch)? {
                        Applied::Source(patched) => (patched, SourceKind::Json),
                        Applied::Refused(refused) => return Ok(Some(refused.to_js())),
                    }
                }
                Some(patch) => {
                    let patched = patched_source(&text, kind, patch)?;
                    let Some(patched) = text_of(&patched, SourceKind::Json)? else {
                        return Ok(None);
                    };
                    (patched, SourceKind::Json)
                }
                None => {
                    let Some(text) = text_of(&text, kind)? else {
                        return Ok(None);
                    };
                    (text, kind)
                }
            };
            let revoked = case_config(&dir, case)?.map(|c| c.revoked().clone());
            let modules = crate::common::with_more(Some(&modules), more(&text, kind).as_ref())
                .unwrap_or(modules);
            Ok(Some(
                check_with_libraries(
                    &text,
                    kind,
                    Some(&modules),
                    lock.as_deref(),
                    &case_libraries(&dir, case),
                    revoked.as_ref(),
                )?
                .to_js(),
            ))
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

/// What the vectors of one language are made of: its `language` tag
/// (`"mandate/0.6"`), the version as the messages name it (`"0.6"`), the
/// directory of its vectors, its programs, and how a file of them is held
/// (`mandate_testkit::rust_vectors::pin` or `pin_0_7`).
pub struct Vectors<'a> {
    pub language: &'a str,
    pub version: &'a str,
    pub dir: &'a str,
    pub programs: Vec<String>,
    pub pin: fn(&str, &str) -> Result<String, String>,
}

/// Makes the vectors of `v.language` and holds each file of `v.dir` to them
/// (or writes them, with the language's update variable); nothing else is in
/// the directory. Panics with every problem found.
pub fn hold(v: &Vectors<'_>) {
    let version = v.version;
    let mut problems: Vec<String> = Vec::new();
    let mut by_code: BTreeMap<String, usize> = BTreeMap::new();
    let mut count = |result: &JsValue| {
        for d in diagnostics_of(result) {
            if let Some(code) = d.get("code").and_then(JsValue::as_str) {
                *by_code.entry(code.to_owned()).or_default() += 1;
            }
        }
    };

    // The compile cases of the language, by name.
    let mut cases: Vec<JsValue> = Vec::new();
    let mut by_door: BTreeMap<&str, usize> = BTreeMap::new();
    for id in subdirectories("conformance").expect("the conformance directory") {
        let case = read_json(&format!("conformance/{id}/case.json")).expect("a case");
        let ours = case.get("language").and_then(Value::as_str) == Some(v.language);
        if !ours || case.get("kind").and_then(Value::as_str) != Some("compile") {
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
        // A library case (0.6) has no program of its own.
        let input = match case.get("input") {
            None => JsObject::new().with("library", true),
            Some(input) => {
                let kind = input.get("kind").and_then(Value::as_str).unwrap_or("mdt");
                match input.get("file").and_then(Value::as_str) {
                    Some(file) => JsObject::new().with("file", file).with("kind", kind),
                    None => JsObject::new().with("inline", true).with("kind", kind),
                }
            }
        };
        let uses: Vec<String> = [
            "patch",
            "base",
            "subprogram",
            "amendment",
            "libraries",
            "config",
            "library",
        ]
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

    // The checks of the programs.
    let mut programs: Vec<JsValue> = Vec::new();
    let mut golden_results: usize = 0;
    for p in &v.programs {
        let lock = outputs::lock_file_of(p);
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
            match outputs::checked(p, with_modules, with_lock) {
                Ok(r) => {
                    let checked = r.to_js();
                    count(&checked);
                    results.insert(slot, checked);
                }
                Err(e) => problems.push(format!("{p} {slot}: {e}")),
            }
        }
        match read_source(p) {
            Ok(text) => {
                let loaded = JsValue::Array(
                    load(&text, kind_of(p))
                        .diagnostics
                        .iter()
                        .map(Diagnostic::to_js)
                        .collect(),
                );
                count(&loaded);
                results.insert("load", loaded);
            }
            Err(e) => problems.push(e),
        }
        golden_results += results.len();
        programs.push(
            JsObject::new()
                .with("program", p.as_str())
                .with("modules", js_strings(&outputs::module_files_of(p)))
                .with("lock", lock.map_or(JsValue::Null, JsValue::from))
                .with("results", results)
                .with("texts", JsObject::new())
                .into(),
        );
    }
    assert!(!cases.is_empty(), "no compile case of {version}");
    assert!(!programs.is_empty(), "no program of {version}");

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
    let dir = v.dir;
    let files = [
        (
            format!("{dir}/conformance-1.json"),
            part(
                "mandate/vectors/diagnostics/conformance/0.1",
                "cases",
                cases,
            ),
        ),
        (
            format!("{dir}/golden-1.json"),
            part(
                "mandate/vectors/diagnostics/golden/0.1",
                "programs",
                programs,
            ),
        ),
        (format!("{dir}/summary.json"), summary),
    ];
    for (rel, value) in &files {
        match (v.pin)(rel, &vector_text(value)) {
            Ok(line) => println!("{line}"),
            Err(e) => problems.push(e),
        }
    }
    println!(
        "diagnostic vectors of {version}: {n_cases} cases, {golden_results} results of programs, {diagnostics} diagnostics"
    );
    // Nothing else is in the directory.
    let mut want: Vec<String> = files
        .iter()
        .map(|(rel, _)| rel.rsplit('/').next().unwrap_or_default().to_owned())
        .collect();
    want.sort();
    match mandate_testkit::files(dir) {
        Ok(found) if found == want => {}
        Ok(found) => problems.push(format!("{dir} holds {found:?}, expected {want:?}")),
        Err(e) => problems.push(e),
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
