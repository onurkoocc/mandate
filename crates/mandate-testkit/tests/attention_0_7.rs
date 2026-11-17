//! The attention facts of language 0.7 (spec/attention.md "The facts"):
//! the door `attention_facts` asked, for every workflow of every 0.7
//! program of the repository (`fixtures/attention/`), checked with its
//! modules as `check --module` checks it, gives what the function gives,
//! and its answers are pinned in `vectors/attention-0.7/facts.json`, which
//! the Rust writes with `MANDATE_UPDATE_0_7=1` (no TypeScript reads 0.7).
//! Asking for the facts changes nothing the check gives.
//!
//! The file is `{ "<program>": { "<workflow>": <facts> } }`, the workflows
//! in the order of the program's definitions. A program that does not
//! check, or an empty file, would pin nothing: every program here checks,
//! and the file has at least one stage, one report and one field of each
//! way a value is known.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;
mod outputs;

use mandate_check::json_doors::library_door;
use mandate_check::{CheckOptions, attention_facts};
use mandate_ir::{JsObject, JsValue, Value, parse, stringify};
use mandate_syntax::{kind_of, load};
use mandate_testkit::rust_vectors::{ATTENTION_0_7, json_text, pin_0_7, programs_0_7};

/// `mdt` or `json`, as the door names a kind.
fn kind_name(program: &str) -> &'static str {
    if program.ends_with(".json") {
        "json"
    } else {
        "mdt"
    }
}

#[test]
fn the_facts_of_every_workflow_of_0_7() {
    let door = library_door("attention_facts").expect("the door");
    let programs = programs_0_7().expect("the 0.7 programs");
    let mut file = JsObject::new();
    let (mut workflows, mut stages, mut reports) = (0_usize, 0_usize, 0_usize);
    let mut known: Vec<String> = Vec::new();
    for p in &programs {
        let text = common::read_source(p).unwrap();
        let files = outputs::module_files_of(p);
        let modules = common::modules_of(&files, &files).unwrap();
        let ir = load(&text, kind_of(p)).program.expect("it loads");
        let mut row = JsObject::new();
        let defs = ir.get("defs").and_then(Value::as_object).unwrap();
        for (name, d) in defs.iter() {
            if d.get("kind").and_then(Value::as_str) != Some("workflow") {
                continue;
            }
            let modules_js: JsObject = modules.iter().map(|(m, v)| (m, JsValue::from(v))).collect();
            let input: JsValue = JsObject::new()
                .with("text", text.as_str())
                .with("kind", kind_name(p))
                .with("opts", JsObject::new().with("modules", modules_js))
                .with("workflow", name)
                .into();
            let input = parse(&stringify(&input).unwrap()).unwrap().value;
            let out = (door.call)(&input).unwrap();
            // The door is the function.
            let direct = attention_facts(
                &text,
                kind_of(p),
                &CheckOptions {
                    modules: Some(&modules),
                    ..CheckOptions::default()
                },
                name,
            )
            .expect("the facts of a program that checks");
            assert_eq!(
                stringify(&out).unwrap(),
                stringify(&direct.to_js()).unwrap(),
                "{p} {name}"
            );
            // Asking for them changes nothing of the check.
            let plain = mandate_check::check(
                &text,
                kind_of(p),
                &CheckOptions {
                    modules: Some(&modules),
                    linked: true,
                    ..CheckOptions::default()
                },
            );
            assert!(plain.ok, "{p}");
            assert_eq!(
                plain.hashes.as_ref().map(|h| h.program.as_str()),
                Some(direct.program.as_str())
            );
            workflows += 1;
            stages += direct.stages.len();
            reports += direct.reports.len();
            for r in &direct.reports {
                for f in &r.fields {
                    known.push(mandate_check::reports::known_name(f.shown.known).to_owned());
                }
            }
            row.insert(name, out);
        }
        file.insert(p.as_str(), row);
    }
    // 0.7: the facts of a lead's sub-program that applies a listed shape,
    // as the runtime asks for them at its admission (RL4): the door given
    // the sub-program as its check reads it (`opened(sub, parent)`), its
    // parent among the modules and the claim of its check; its paths are in
    // the program it runs as.
    let mut subs = 0_usize;
    for (sub, parent, workflow, number) in SUBPROGRAMS_0_7 {
        let parent_ir = load(&common::read_source(parent).unwrap(), kind_of(parent))
            .program
            .expect("the parent loads");
        let module = parent_ir.get("module").and_then(Value::as_str).unwrap();
        let mut view = mandate_check::skeleton(
            module,
            f64::from(*number),
            mandate_check::language_of(&parent_ir),
        );
        let own = load(&common::read_source(sub).unwrap(), kind_of(sub))
            .program
            .expect("the sub-program loads");
        if let (Value::Object(v), Some(defs)) = (&mut view, own.get("defs")) {
            v.insert("defs", defs.clone());
        }
        let view = mandate_check::opened(&view, &parent_ir);
        let envelope = parent_ir
            .get("defs")
            .and_then(|d| d.get(workflow))
            .and_then(|w| w.get("envelope"))
            .unwrap();
        let mut row = JsObject::new();
        for (name, d) in own.get("defs").and_then(Value::as_object).unwrap().iter() {
            if d.get("kind").and_then(Value::as_str) != Some("workflow") {
                continue;
            }
            let input: JsValue = JsObject::new()
                .with("text", stringify(&JsValue::from(&view)).unwrap())
                .with("kind", "json")
                .with(
                    "opts",
                    JsObject::new()
                        .with(
                            "modules",
                            JsObject::new().with(module, JsValue::from(&parent_ir)),
                        )
                        .with(
                            "claim",
                            JsObject::new()
                                .with("envelope", JsValue::from(envelope))
                                .with("lead", "public"),
                        ),
                )
                .with("workflow", name)
                .into();
            let out = (door.call)(&parse(&stringify(&input).unwrap()).unwrap().value).unwrap();
            assert!(!matches!(out, JsValue::Null), "{sub} {name}: no facts");
            row.insert(name, out);
            subs += 1;
        }
        file.insert(*sub, row);
    }
    known.sort();
    known.dedup();
    match pin_0_7(ATTENTION_0_7, &json_text(&JsValue::Object(file))) {
        Ok(line) => println!(
            "attention facts of 0.7: {} programs, {workflows} workflows, {stages} stages, {reports} reports, fields known as {known:?}, {subs} workflows of sub-programs; {line}",
            programs.len()
        ),
        Err(e) => panic!("{e}"),
    }
    assert!(stages > 0 && reports > 0 && subs > 0);
    assert_eq!(known, ["external", "model", "plain", "verified"]);
}

/// The sub-programs of 0.7 whose facts are pinned with the programs: each
/// file, its parent, the workflow whose envelope bounds it, and its number.
const SUBPROGRAMS_0_7: &[(&str, &str, &str, u32)] = &[(
    "fixtures/attention/shapes.plans/noted.mdt",
    "fixtures/attention/shapes.mdt",
    "Planning",
    1,
)];
