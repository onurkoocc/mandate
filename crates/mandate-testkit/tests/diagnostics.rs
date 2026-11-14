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
    check_text, check_with, kind_named, modules_of, patched_source, read_source, value_text,
};
use mandate_check::Modules;
use mandate_ir::{Diagnostic, JsValue, Value, stringify_pretty};
use mandate_syntax::{SourceKind, kind_of, load};
use mandate_testkit::{
    check_pending, compare_text, item_name, read_json, repo_path, result_codes, run_gate,
    stored_cases, stored_programs,
};

/// The items the Rust compiler does not give yet: a glob for each family of
/// codes whose stage is not ported (the slice that ports it beside it), and
/// one for each front door that is not.
const PENDING: &[&str] = &[
    // R11: the static core (types, expressions, budgets, cost).
    "*MDT-E02*",
    "*MDT-E0501*",
    "*MDT-E0502*",
    // R12: the static authority (capabilities, delegation, effects, envelopes, methods).
    "*MDT-E03*",
    "*MDT-W0310*",
    "*MDT-E04*",
    "*MDT-W06*",
    "*MDT-E07*",
    "*MDT-E17*",
    "*MDT-E1801*",
    // R13: the system model, change sets, reads.
    "*MDT-E10*",
    "*MDT-E12*",
    // R13: the doors of patches, sub-programs and amendments.
    "apply_ops @ *",
    "check_subprogram @ *",
    "check_amendment @ *",
];

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

fn run(item: &Item, cache: &mut ModuleCache) -> Result<(), String> {
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
            if door != "check" && door != "check_patched" {
                return Err(format!("the {door} door is not ported"));
            }
            let case = read_json(&format!("{dir}/case.json"))?;
            let text = if input.is_empty() {
                case.get("input")
                    .and_then(|i| i.get("text"))
                    .and_then(Value::as_str)
                    .ok_or("no input text")?
                    .to_owned()
            } else {
                read_source(input)?
            };
            let mods = if modules.is_empty() {
                None
            } else {
                Some(cache.get(modules, modules)?)
            };
            // `check_patched`: the case's patch applied to the loaded IR,
            // and the patched IR checked as `JSON.stringify` text.
            let (text, kind) = match case.get("patch").and_then(Value::as_array) {
                Some(patch) if door == "check_patched" => (
                    patched_source(&text, kind_named(kind), patch)?,
                    SourceKind::Json,
                ),
                _ => (text, kind_named(kind)),
            };
            let r = check_with(&text, kind, mods, lock.as_deref())?;
            compare_text(expected, &check_text(&r))
        }
        Item::Program {
            program,
            slot,
            modules,
            lock,
            expected,
        } => {
            let text = read_source(program)?;
            let kind = kind_of(program);
            let actual = match slot.as_str() {
                "load" => {
                    let diagnostics = load(&text, kind).diagnostics;
                    let mut t = stringify_pretty(&JsValue::Array(
                        diagnostics.iter().map(Diagnostic::to_js).collect(),
                    ))
                    .unwrap_or_default();
                    t.push('\n');
                    t
                }
                "check" => check_text(&check_with(&text, kind, None, None)?),
                "check_module" => {
                    let mods = cache.get(modules, modules)?;
                    check_text(&check_with(&text, kind, Some(mods), None)?)
                }
                "check_lock" => {
                    let mods = cache.get(modules, modules)?;
                    check_text(&check_with(&text, kind, Some(mods), lock.as_deref())?)
                }
                other => return Err(format!("no slot {other}")),
            };
            compare_text(expected, &actual)
        }
    }
}

#[test]
fn diagnostics_gate() {
    check_pending(PENDING).expect("the pending list");
    let mut cache = ModuleCache(BTreeMap::new());
    let gate = run_gate("diagnostic vectors", PENDING, items(), |item| {
        run(item, &mut cache)
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
}
