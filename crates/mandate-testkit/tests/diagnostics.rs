//! The diagnostics gate: the whole result `mandate_check::check` gives for
//! every input of `vectors/diagnostics/` (see `vectors/README.md`,
//! "diagnostics/") must be the stored one byte for byte, as JSON text in
//! the compiler's member order (`JSON.stringify(result, null, 2)`): `ok`,
//! `hashes`, and every diagnostic whole (`code`, `severity`, `message`, `at`
//! with its span, `docs`, `facts`, `repair`), in the same order. Nothing is
//! masked.
//!
//! The items are the stored result of every compile case of `conformance/`
//! (`<door> @ conformance/<id> [codes]`) and the four stored results of
//! every golden program (`check`, `check --module`, `check --lock`, `load`
//! `@ <program> [codes]`), named by the codes the stored result holds (see
//! `mandate_testkit::codes`), so that what is pending is listed by family.

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
    Applied, applied_source, check_text, check_with, kind_named, modules_of, patched_source,
    read_source, value_text,
};
use mandate_check::Modules;
use mandate_ir::{Diagnostic, JsValue, Value, stringify, stringify_pretty};
use mandate_syntax::{SourceKind, kind_of, load};
use mandate_testkit::{
    Miss, check_pending, compare_text, item_name, omission, read_json, repo_path, result_codes,
    run_held_gate, stored_cases, stored_programs,
};

/// The items the Rust compiler does not give yet: a glob for each family of
/// codes whose stage is not ported (the slice that ports it beside it), one
/// for each front door that is not, and by name the items that still fail
/// although every code they hold is of a ported family. Every pending item
/// is held to failing only by omission (`mandate_testkit::run_held_gate`).
const PENDING: &[&str] = &[
    // R12: the static authority (capabilities, delegation, effects, envelopes, methods).
    "*MDT-E022*",
    "*MDT-E03*",
    "*MDT-W0310*",
    "*MDT-E0408*",
    "*MDT-E070*",
    "*MDT-E1701*",
    "*MDT-E1702*",
    "*MDT-E1703*",
    "*MDT-E1704*",
    "*MDT-E1706*",
    "*MDT-E1707*",
    "*MDT-E1801*",
    // R13: the system model, reads, sub-programs, amendments.
    "*MDT-E10*",
    "*MDT-E12*",
    "*MDT-E1705*",
    "*MDT-E1709*",
    // R13: the doors of sub-programs and amendments.
    "check_subprogram @ *",
    "check_amendment @ *",
    // Stored results whose codes are all of ported families, but which the
    // core does not give, because the TypeScript raises them in a function
    // of a later slice (`statics/authority.rs` gives none of its own
    // diagnostics yet).
    // R12, `checkAgent`: E0213, a skill returns Evidence (1).
    "check @ conformance/S08a [MDT-E0213]",
    // R12, `checkExtern`: E0213, host code returns Verified (1).
    "check @ conformance/S08d [MDT-E0213]",
    // R12, `effectCall`: E0210 of an argument against a critical effect's
    // parameter (5).
    "check_patched @ conformance/V01a [MDT-E0210 MDT-W0601]",
    "check_patched @ conformance/V01b [MDT-E0210 MDT-W0601]",
    "check @ conformance/V01c [MDT-E0210]",
    "check @ conformance/V01d [MDT-E0210]",
    "check @ conformance/V08a [MDT-E0210]",
    // R12, `mapBudget`: E0501 of a map's budget (1).
    "check_patched @ conformance/E0501b [MDT-E0501]",
];

/// The stored result `expected` (its text) against the diagnostics Rust
/// gives, for an item whose text differs (`difference`): whether Rust's are
/// the stored ones with some left out, in order, each compared whole.
fn held(expected: &str, actual: &[Diagnostic], difference: String) -> Miss {
    let Ok(stored) = mandate_testkit::parse_json(expected.as_bytes()) else {
        return Miss::Excluded {
            rule: "a stored result held as text, with a number the strict JSON reader does not read",
            why: difference,
        };
    };
    let want: Vec<String> = match &stored {
        Value::Array(items) => items.as_slice(),
        other => other
            .get("diagnostics")
            .and_then(Value::as_array)
            .unwrap_or_default(),
    }
    .iter()
    .map(|d| stringify(&JsValue::from(d)).unwrap_or_default())
    .collect();
    let got: Vec<String> = actual
        .iter()
        .map(|d| stringify(&d.to_js()).unwrap_or_default())
        .collect();
    match omission(&want, &got, |w, g| w == g, Clone::clone) {
        Ok(_) => Miss::Omits(difference),
        Err(why) => Miss::Differs(format!("{why}\n{difference}")),
    }
}

/// `compare_text(expected, actual)`, held to omission when it differs.
fn compare_held(expected: &str, actual: &str, diagnostics: &[Diagnostic]) -> Result<(), Miss> {
    compare_text(expected, actual).map_err(|why| held(expected, diagnostics, why))
}

/// What an item compares.
enum Item {
    /// A stored conformance result.
    Case {
        door: String,
        dir: String,
        input: String,
        kind: String,
        modules: Vec<String>,
        lock: Option<String>,
        expected: String,
    },
    /// A stored result of a golden program.
    Program {
        program: String,
        slot: String,
        modules: Vec<String>,
        lock: Option<String>,
        expected: String,
    },
}

/// The output a golden slot is: `check_module` is `check --module`.
fn output_of(slot: &str) -> String {
    match slot {
        "check_module" => "check --module".to_owned(),
        "check_lock" => "check --lock".to_owned(),
        other => other.to_owned(),
    }
}

fn items() -> Vec<(String, Item)> {
    let mut out = Vec::new();
    for c in stored_cases().expect("the conformance vectors") {
        let dir = format!("conformance/{}", c.name);
        let (codes, expected) = match (&c.result, &c.text) {
            (Some(v), _) => (result_codes(v), value_text(v)),
            (None, Some(t)) => (
                result_codes(&mandate_testkit::parse_json(t.as_bytes()).expect("text")),
                t.clone(),
            ),
            (None, None) => panic!("{}: no result", c.name),
        };
        let input = match &c.input_file {
            Some(f) => repo_path(&dir, f),
            None => String::new(),
        };
        out.push((
            item_name(&c.door, &dir, &codes),
            Item::Case {
                door: c.door.clone(),
                modules: c.modules.iter().map(|m| repo_path(&dir, m)).collect(),
                lock: c.lock.as_ref().map(|l| repo_path(&dir, l)),
                dir,
                input,
                kind: c.input_kind.clone(),
                expected,
            },
        ));
    }
    for p in stored_programs().expect("the golden vectors") {
        let results = p
            .results
            .iter()
            .map(|(slot, v)| (slot.clone(), result_codes(v), value_text(v)));
        let texts = p.texts.iter().map(|(slot, t)| {
            let v = mandate_testkit::parse_json(t.as_bytes()).expect("text");
            (slot.clone(), result_codes(&v), t.clone())
        });
        for (slot, codes, expected) in results.chain(texts) {
            out.push((
                item_name(&output_of(&slot), &p.program, &codes),
                Item::Program {
                    program: p.program.clone(),
                    slot,
                    modules: p.modules.clone(),
                    lock: p.lock.clone(),
                    expected,
                },
            ));
        }
    }
    out
}

/// The modules of a list of files, loaded once for each list.
struct ModuleCache(BTreeMap<Vec<String>, Result<Modules, String>>);

impl ModuleCache {
    fn get(&mut self, files: &[String], names: &[String]) -> Result<&Modules, String> {
        self.0
            .entry(files.to_vec())
            .or_insert_with(|| modules_of(files, names))
            .as_ref()
            .map_err(Clone::clone)
    }
}

fn run(item: &Item, cache: &mut ModuleCache) -> Result<(), Miss> {
    match item {
        Item::Case {
            door,
            dir,
            input,
            kind,
            modules,
            lock,
            expected,
        } => {
            if !matches!(door.as_str(), "check" | "check_patched" | "apply_ops") {
                return Err(Miss::Excluded {
                    rule: "its front door (checkSubprogram, checkAmendment) is not ported (R13), so there is no Rust result to hold",
                    why: format!("the {door} door is not ported"),
                });
            }
            let case = read_json(&format!("{dir}/case.json")).map_err(Miss::Differs)?;
            let text = if input.is_empty() {
                case.get("input")
                    .and_then(|i| i.get("text"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| Miss::Differs("no input text".to_owned()))?
                    .to_owned()
            } else {
                read_source(input).map_err(Miss::Differs)?
            };
            let mods = if modules.is_empty() {
                None
            } else {
                Some(cache.get(modules, modules).map_err(Miss::Differs)?)
            };
            // `check_patched`: the case's patch applied to the loaded IR,
            // and the patched IR checked as `JSON.stringify` text.
            let (text, kind) = match case.get("patch").and_then(Value::as_array) {
                // `apply_ops`: `applyOps(program, base, patch)`; a refused patch (E0130, E0131) is
                // the result, else the patched IR is checked.
                Some(patch) if door == "apply_ops" => {
                    let base = case
                        .get("base")
                        .and_then(Value::as_str)
                        .ok_or_else(|| Miss::Differs("no base".to_owned()))?;
                    match applied_source(&text, kind_named(kind), base, patch)
                        .map_err(Miss::Differs)?
                    {
                        Applied::Source(patched) => (patched, SourceKind::Json),
                        Applied::Refused(refused) => {
                            return compare_held(
                                expected,
                                &check_text(&refused),
                                &refused.diagnostics,
                            );
                        }
                    }
                }
                Some(patch) if door == "check_patched" => (
                    patched_source(&text, kind_named(kind), patch).map_err(Miss::Differs)?,
                    SourceKind::Json,
                ),
                _ => (text, kind_named(kind)),
            };
            let r = check_with(&text, kind, mods, lock.as_deref()).map_err(Miss::Differs)?;
            compare_held(expected, &check_text(&r), &r.diagnostics)
        }
        Item::Program {
            program,
            slot,
            modules,
            lock,
            expected,
        } => {
            let text = read_source(program).map_err(Miss::Differs)?;
            let kind = kind_of(program);
            let checked = |mods: Option<&Modules>, lock: Option<&str>| {
                check_with(&text, kind, mods, lock).map_err(Miss::Differs)
            };
            let (actual, diagnostics) = match slot.as_str() {
                "load" => {
                    let diagnostics = load(&text, kind).diagnostics;
                    let mut t = stringify_pretty(&JsValue::Array(
                        diagnostics.iter().map(Diagnostic::to_js).collect(),
                    ))
                    .unwrap_or_default();
                    t.push('\n');
                    (t, diagnostics)
                }
                "check" => {
                    let r = checked(None, None)?;
                    (check_text(&r), r.diagnostics)
                }
                "check_module" => {
                    let mods = cache.get(modules, modules).map_err(Miss::Differs)?;
                    let r = checked(Some(mods), None)?;
                    (check_text(&r), r.diagnostics)
                }
                "check_lock" => {
                    let mods = cache.get(modules, modules).map_err(Miss::Differs)?;
                    let r = checked(Some(mods), lock.as_deref())?;
                    (check_text(&r), r.diagnostics)
                }
                other => return Err(Miss::Differs(format!("no slot {other}"))),
            };
            compare_held(expected, &actual, &diagnostics)
        }
    }
}

#[test]
fn diagnostics_gate() {
    check_pending(PENDING).expect("the pending list");
    let mut cache = ModuleCache(BTreeMap::new());
    let gate = run_held_gate("diagnostic vectors", PENDING, items(), |item| {
        run(item, &mut cache)
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
}
