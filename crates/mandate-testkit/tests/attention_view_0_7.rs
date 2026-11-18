//! The attention view of language 0.7 (spec/attention.md "The attention
//! view"): the door `attention` asked, for every workflow of every 0.7
//! program of the repository (`fixtures/attention/`) with its lock (the
//! `<name>.lock.json` beside it, as `check --lock` reads it) and its
//! modules, gives what the function gives in each of its three formats, and
//! its answers are pinned in `vectors/attention-0.7/view.json`, which the
//! Rust writes with `MANDATE_UPDATE_0_7=1` (no TypeScript reads 0.7). The
//! Node `view --attention` and the MCP server's `project` must give these
//! texts.
//!
//! The file is `{ "<program>": { "<workflow>": { "json": <the view>, "md":
//! <its Markdown>, "html": <its page> } } }`, the workflows in the order of
//! the program's definitions, each as the door gives it. The view is made
//! from the attention facts, which `attention_0_7.rs` pins, and the lock:
//! the file catches a change of its wording, not a change of what the facts
//! hold.

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

use mandate_ir::{JsObject, JsValue, Value, parse, stringify};
use mandate_syntax::{kind_of, load};
use mandate_testkit::rust_vectors::{ATTENTION_VIEW_0_7, json_text, pin_0_7, programs_0_7};
use mandate_views::json_doors::rust_door;

/// `mdt` or `json`, as the door names a kind.
fn kind_name(program: &str) -> &'static str {
    if program.ends_with(".json") {
        "json"
    } else {
        "mdt"
    }
}

#[test]
fn the_attention_view_of_every_workflow_of_0_7() {
    let door = rust_door("attention").expect("the door");
    let programs = programs_0_7().expect("the 0.7 programs");
    let mut file = JsObject::new();
    let (mut workflows, mut rows, mut reports) = (0_usize, 0_usize, 0_usize);
    for p in &programs {
        let text = common::read_source(p).unwrap();
        let files = outputs::module_files_of(p);
        let modules = common::modules_of(&files, &files).unwrap();
        let modules_js: JsObject = modules.iter().map(|(m, v)| (m, JsValue::from(v))).collect();
        let libraries = outputs::library_sources_js_of(p).unwrap();
        let lock = outputs::lock_file_of(p).map(|l| mandate_testkit::read_json(&l).unwrap());
        let ir = load(&text, kind_of(p)).program.expect("it loads");
        let mut row = JsObject::new();
        let defs = ir.get("defs").and_then(Value::as_object).unwrap();
        for (name, d) in defs.iter() {
            if d.get("kind").and_then(Value::as_str) != Some("workflow") {
                continue;
            }
            let mut by_format = JsObject::new();
            for format in ["json", "md", "html"] {
                let mut opts = JsObject::new().with("modules", modules_js.clone());
                if let Some(l) = &libraries {
                    opts.insert("libraries", l.clone());
                }
                if let Some(l) = &lock {
                    opts.insert("lock", JsValue::from(l));
                }
                let input: JsValue = JsObject::new()
                    .with("text", text.as_str())
                    .with("kind", kind_name(p))
                    .with("opts", opts)
                    .with("workflow", name)
                    .with("format", format)
                    .into();
                let input = parse(&stringify(&input).unwrap()).unwrap().value;
                let out = (door.call)(&input).unwrap();
                // The door is the function, asked twice the same.
                assert_eq!(
                    stringify(&out).unwrap(),
                    stringify(&(door.call)(&input).unwrap()).unwrap(),
                    "{p} {name} {format}: two answers"
                );
                if format == "json" {
                    let JsValue::Object(v) = &out else {
                        panic!("{p} {name}: no view")
                    };
                    if let Some(JsValue::Array(q)) = v.get("questions") {
                        rows += q.len();
                    }
                    if let Some(JsValue::Array(r)) = v.get("reports") {
                        reports += r.len();
                    }
                } else {
                    assert!(matches!(out, JsValue::String(_)), "{p} {name} {format}");
                }
                by_format.insert(format, out);
            }
            workflows += 1;
            row.insert(name, by_format);
        }
        file.insert(p.as_str(), row);
    }
    match pin_0_7(ATTENTION_VIEW_0_7, &json_text(&JsValue::Object(file))) {
        Ok(line) => println!(
            "attention view of 0.7: {} programs, {workflows} workflows, {rows} rows, {reports} reports; {line}",
            programs.len()
        ),
        Err(e) => panic!("{e}"),
    }
    assert!(rows > 0 && reports > 0);
}
