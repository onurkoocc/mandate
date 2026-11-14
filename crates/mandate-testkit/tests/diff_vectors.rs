//! The diff gate: the comparing functions of the Rust compiler against
//! `vectors/diff/` (see `vectors/README.md`, "diff/"; written by
//! `compiler/test/diff-vectors.test.ts`), for every one of the 183 pairs of
//! programs and locks. Each case is built as the TypeScript test builds it
//! (`build` and `diffCase` there) and every stored result is compared whole,
//! as the JSON text `JSON.stringify(value, null, 2)` writes (so the member
//! order is held too): `results.diff` (`semanticDiff`), `results.governance_changes`
//! (`governanceChanges`), `results.envelope_changes` (`envelopeChanges` for
//! each workflow both programs define), `results.lock_diff` and
//! `results.lock_limits_diff` (`lockDiff` and `lockLimitsDiff`, where a lock
//! is given), `markdown` (`toMarkdown(diffDoc(...))`), and the page
//! `toHtml(diffDoc(...))`: its SHA-256, its length in UTF-16 code units and,
//! where the case stores it, the whole text.
//!
//! The programs are what `mandate_check::check` gives for the side's text
//! with the case's modules and no lock; the static checks are not ported
//! yet, which does not matter here because every stored program checks in
//! TypeScript and `check` gives the loaded program unchanged. A side
//! `patch_of` is the case's patch applied (`applyOps` with the case's
//! `base`, else the RFC 6902 patch of the runner, `common::apply_json_patch`),
//! and a side `amend_of` is the parent with its workflow's envelope replaced
//! (`amendmentInput` of the runner, `common::amendment_envelope`).
//!
//! The files are read as `summary.json` says they are: the same number of
//! cases, of each source, in parts that say what part of how many they are,
//! with no member this reader does not know, so no case is left unread.
//! Items are named `<source> @ <case name>`.

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

use common::{
    amended_program, amendment_envelope, kind_named, modules_of, patched_source, read_source,
};
use mandate_check::{
    CheckOptions, Locks, Modules, PatchOp, apply_ops, check, envelope_changes, governance_changes,
    lock_diff, lock_limits_diff, semantic_diff,
};
use mandate_ir::{
    JsObject, JsValue, Value, parse, sort_utf16, stringify, stringify_pretty, utf16_len,
};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{compare_text, read_json, run_gate, sha256};
use mandate_views::{diff_doc, to_html, to_markdown};

/// What the gate has left pending, and why: nothing.
const PENDING: &[&str] = &[];

const CASE_MEMBERS: [&str; 12] = [
    "name",
    "source",
    "note",
    "before",
    "after",
    "modules",
    "locks",
    "results",
    "texts",
    "markdown",
    "html_sha256",
    "html_length",
];

/// The text of a member that must be one.
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("no text member \"{key}\""))
}

/// Every case of `vectors/diff/`, in the order of the files.
fn read_cases() -> Result<Vec<Value>, String> {
    let summary = read_json("vectors/diff/summary.json")?;
    if text(&summary, "format")? != "mandate/vectors/diff/summary/0.1" {
        return Err("summary.json: the format is not known".to_owned());
    }
    let mut cases: Vec<Value> = Vec::new();
    let mut part: i64 = 1;
    loop {
        let rel = format!("vectors/diff/cases-{part}.json");
        let file = read_json(&rel)?;
        if text(&file, "format")? != "mandate/vectors/diff/cases/0.1" {
            return Err(format!("{rel}: the format is not known"));
        }
        let parts = file
            .get("parts")
            .and_then(Value::as_i64)
            .ok_or("no parts")?;
        if file.get("part").and_then(Value::as_i64) != Some(part) {
            return Err(format!("{rel}: is not part {part}"));
        }
        cases.extend(
            file.get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{rel}: no cases"))?
                .iter()
                .cloned(),
        );
        if part >= parts {
            break;
        }
        part += 1;
    }
    let want = summary
        .get("cases")
        .and_then(Value::as_i64)
        .ok_or("no cases in summary.json")?;
    if i64::try_from(cases.len()).ok() != Some(want) {
        return Err(format!(
            "summary.json says {want} cases, the files hold {}",
            cases.len()
        ));
    }
    let mut by_source: BTreeMap<String, i64> = BTreeMap::new();
    for c in &cases {
        let known: Vec<&str> = c.as_object().map_or_else(Vec::new, |m| m.keys().collect());
        for k in &known {
            if !CASE_MEMBERS.contains(k) && *k != "html" {
                return Err(format!(
                    "{}: has the member \"{k}\", which is not known",
                    text(c, "name")?
                ));
            }
        }
        for k in CASE_MEMBERS {
            if !known.contains(&k) {
                return Err(format!("{}: has no member \"{k}\"", text(c, "name")?));
            }
        }
        // No result is stored as text (every number is an integer).
        if c.get("texts")
            .and_then(Value::as_object)
            .is_none_or(|t| !t.is_empty())
        {
            return Err(format!("{}: has results stored as text", text(c, "name")?));
        }
        *by_source.entry(text(c, "source")?.to_owned()).or_default() += 1;
    }
    let stored: BTreeMap<String, i64> = summary
        .get("by_source")
        .and_then(Value::as_object)
        .ok_or("no by_source in summary.json")?
        .iter()
        .filter_map(|(k, v)| v.as_i64().map(|n| (k.to_owned(), n)))
        .collect();
    if stored != by_source {
        return Err(format!(
            "summary.json says {stored:?} cases by source, the files hold {by_source:?}"
        ));
    }
    Ok(cases)
}

/// The modules of a list of repository files, loaded once for each list.
struct ModuleCache(BTreeMap<Vec<String>, Modules>);

impl ModuleCache {
    fn get(&mut self, files: &[String]) -> Result<&Modules, String> {
        if !self.0.contains_key(files) {
            self.0.insert(files.to_vec(), modules_of(files, files)?);
        }
        self.0.get(files).ok_or_else(|| "no modules".to_owned())
    }
}

/// The strings of a list member.
fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// A side's text and form: `sideText` of the TypeScript test.
fn side(v: &Value) -> Result<(String, SourceKind), String> {
    let kind = kind_named(v.get("kind").and_then(Value::as_str).unwrap_or("mdt"));
    let text = match v.get("text").and_then(Value::as_str) {
        Some(t) => t.to_owned(),
        None => read_source(text(v, "file")?)?,
    };
    Ok((text, kind))
}

/// `check(text, kind, { modules })`, which must be ok: `checked` of the
/// TypeScript test.
fn checked(text: &str, kind: SourceKind, modules: &Modules, what: &str) -> Result<Value, String> {
    let r = check(
        text,
        kind,
        &CheckOptions {
            lock: None,
            modules: Some(modules),
            claim: None,
        },
    );
    match r.program {
        Some(p) if r.ok => Ok(p),
        _ => Err(format!(
            "{what} does not check: {}",
            r.diagnostics
                .iter()
                .map(|d| format!("{} {}", d.code, d.at.path.as_deref().unwrap_or("")))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// The two programs of a case.
fn programs(case: &Value, modules: &Modules) -> Result<(Value, Value), String> {
    let (before_side, after_side) = (
        case.get("before").ok_or("no before")?,
        case.get("after").ok_or("no after")?,
    );
    let (before_text, before_kind) = side(before_side)?;
    if let Some(id) = after_side.get("patch_of").and_then(Value::as_str) {
        // A conformance case that patches a program: the base is the program as it loads (a patch
        // may be what makes it check), the after is the patched program, checked.
        let case_file = read_json(&format!("conformance/{id}/case.json"))?;
        let patch = case_file
            .get("patch")
            .and_then(Value::as_array)
            .ok_or("the case has no patch")?;
        let loaded = load(&before_text, before_kind);
        let base = match loaded.program {
            Some(p) if !mandate_ir::has_errors(&loaded.diagnostics) => p,
            _ => return Err(format!("{id}: the input does not load")),
        };
        let patched = match case_file.get("base").and_then(Value::as_str) {
            // `applyOps`: as `mandate.apply_patch` does, against a base.
            Some(hash) => {
                let ops: Vec<PatchOp> = patch.iter().map(PatchOp::from_value).collect();
                let applied = apply_ops(&base, hash, &ops);
                let program = applied
                    .program
                    .ok_or_else(|| format!("{id}: applyOps gave no program"))?;
                stringify(&JsValue::from(&program)).ok_or("no JSON text")?
            }
            None => patched_source(&before_text, before_kind, patch)?,
        };
        let after = checked(&patched, SourceKind::Json, modules, &format!("{id}: after"))?;
        return Ok((base, after));
    }
    if let Some(id) = after_side.get("amend_of").and_then(Value::as_str) {
        let case_file = read_json(&format!("conformance/{id}/case.json"))?;
        let amendment = case_file
            .get("amendment")
            .ok_or("the case has no amendment")?;
        let workflow = text(amendment, "workflow")?;
        let patch = amendment
            .get("patch")
            .and_then(Value::as_array)
            .ok_or("the amendment has no patch")?;
        let parent = checked(&before_text, before_kind, modules, &format!("{id}: parent"))?;
        let amended = amended_program(
            &parent,
            workflow,
            amendment_envelope(workflow, patch, &parent)?,
        )?;
        let json = stringify(&JsValue::from(&amended)).ok_or("no JSON text")?;
        let after = checked(&json, SourceKind::Json, modules, &format!("{id}: after"))?;
        return Ok((parent, after));
    }
    let (after_text, after_kind) = side(after_side)?;
    Ok((
        checked(&before_text, before_kind, modules, "before")?,
        checked(&after_text, after_kind, modules, "after")?,
    ))
}

/// A lock of the case: `lockOfRef`. A lock that is `null` is no lock.
fn lock_of(r: Option<&Value>) -> Result<Option<Value>, String> {
    let Some(r) = r.filter(|r| !matches!(r, Value::Null)) else {
        return Ok(None);
    };
    let lock = match r.get("file").and_then(Value::as_str) {
        Some(file) => read_json(file)?,
        None => {
            parse(text(r, "text")?)
                .map_err(|_| "a lock is not strict JSON".to_owned())?
                .value
        }
    };
    Ok((!matches!(lock, Value::Null)).then_some(lock))
}

/// `JSON.stringify(v, null, 2)`.
fn pretty(v: &JsValue) -> String {
    stringify_pretty(v).unwrap_or_default()
}

/// A list of changes as the compiler gives it.
fn changes(cs: &[mandate_check::Change]) -> JsValue {
    JsValue::Array(cs.iter().map(mandate_check::Change::to_js).collect())
}

/// The names of the workflows of a program, `Object.entries(p.defs).filter(...)`.
fn workflows(p: &Value) -> Vec<String> {
    p.get("defs")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|d| d.iter())
        .filter(|(_, d)| d.get("kind").and_then(Value::as_str) == Some("workflow"))
        .map(|(n, _)| n.to_owned())
        .collect()
}

/// One case: its programs built, every stored result compared.
fn run(case: &Value, cache: &mut ModuleCache) -> Result<(), String> {
    let files = strings(case.get("modules"));
    let modules = cache.get(&files)?;
    let modules_given = (!modules.is_empty()).then_some(modules);
    let (before, after) = programs(case, modules)?;
    let lock_before = lock_of(case.get("locks").and_then(|l| l.get("before")))?;
    let lock_after = lock_of(case.get("locks").and_then(|l| l.get("after")))?;
    let locked = lock_before.is_some() || lock_after.is_some();
    let locks = locked.then_some(Locks {
        before: lock_before.as_ref(),
        after: lock_after.as_ref(),
    });

    let mut got: Vec<(&str, JsValue)> = vec![
        ("diff", semantic_diff(&before, &after, locks).to_js()),
        (
            "governance_changes",
            JsValue::Array(
                governance_changes(&before, &after, modules_given)
                    .iter()
                    .map(mandate_check::KindedChange::to_js)
                    .collect(),
            ),
        ),
    ];
    let mut both: Vec<String> = workflows(&before)
        .into_iter()
        .filter(|w| workflows(&after).contains(w))
        .collect();
    sort_utf16(&mut both);
    got.push((
        "envelope_changes",
        JsValue::Array(
            both.iter()
                .map(|w| {
                    JsObject::new()
                        .with("workflow", w.as_str())
                        .with(
                            "changes",
                            changes(&envelope_changes(&before, &after, w, modules_given)),
                        )
                        .into()
                })
                .collect(),
        ),
    ));
    if let Some(locks) = locks {
        got.push(("lock_diff", changes(&lock_diff(locks.before, locks.after))));
        let limits = lock_limits_diff(locks.before, locks.after);
        got.push((
            "lock_limits_diff",
            JsObject::new()
                .with("governance", changes(&limits.governance))
                .with("behavior", changes(&limits.behavior))
                .into(),
        ));
    }

    let mut problems: Vec<String> = Vec::new();
    let results = case
        .get("results")
        .and_then(Value::as_object)
        .ok_or("no results")?;
    let want: Vec<&str> = results.keys().collect();
    let have: Vec<&str> = got.iter().map(|(n, _)| *n).collect();
    if want != have {
        problems.push(format!(
            "the stored results are {want:?}, the ones to compare {have:?}"
        ));
    }
    for (slot, value) in &got {
        match results.get(slot) {
            None => problems.push(format!("{slot}: no stored result")),
            Some(stored) => {
                if let Err(e) = compare_text(&pretty(&JsValue::from(stored)), &pretty(value)) {
                    problems.push(format!("{slot}: {e}"));
                }
            }
        }
    }

    let doc = diff_doc(&before, &after, locks);
    let markdown = to_markdown(&doc);
    if let Err(e) = compare_text(text(case, "markdown")?, &markdown) {
        problems.push(format!("markdown: {e}"));
    }
    let html = to_html(&doc);
    let digest = sha256(&html);
    if Some(digest.trim_start_matches("sha256:")) != case.get("html_sha256").and_then(Value::as_str)
    {
        problems.push(format!(
            "html_sha256: expected {:?}, got {digest}",
            case.get("html_sha256").and_then(Value::as_str)
        ));
    }
    let length = case.get("html_length").and_then(Value::as_i64);
    if length != i64::try_from(utf16_len(&html)).ok() {
        problems.push(format!(
            "html_length: expected {length:?}, got {}",
            utf16_len(&html)
        ));
    }
    if let Some(stored) = case.get("html").and_then(Value::as_str)
        && let Err(e) = compare_text(stored, &html)
    {
        problems.push(format!("html: {e}"));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n    "))
    }
}

#[test]
fn diff_gate() {
    let cases = read_cases().unwrap_or_else(|e| panic!("{e}"));
    let items: Vec<(String, Value)> = cases
        .into_iter()
        .map(|c| {
            let name = format!(
                "{} @ {}",
                c.get("source").and_then(Value::as_str).unwrap_or(""),
                c.get("name").and_then(Value::as_str).unwrap_or("")
            );
            (name, c)
        })
        .collect();
    let mut cache = ModuleCache(BTreeMap::new());
    let gate = run_gate("diff vectors", PENDING, items, |case| run(case, &mut cache));
    if let Err(report) = gate {
        panic!("{report}");
    }
}
