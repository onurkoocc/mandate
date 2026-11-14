//! The span gate: for each program `vectors/programs/` pins, the whole
//! span table the Rust reader gives is the one in `vectors/spans/`: by
//! `mandate-syntax` for a program in Mandate text, by `mandate-ir`'s JSON
//! reader for the one given as JSON IR.

#![allow(
    clippy::panic,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use mandate_ir::Value;
use mandate_syntax::parse_mdt;
use mandate_testkit::{files, read_json, read_text, run_gate};

use common::{rows, same_lines, vector_rows};

/// The span tables not given yet, by source path. None.
const PENDING: &[&str] = &[];

const DIR: &str = "vectors/spans";

/// The table the Rust reader gives for `source` of `kind`.
fn table(source: &str, kind: &str) -> Result<Vec<String>, String> {
    let text = read_text(source)?;
    match kind {
        "mdt" => {
            let read = parse_mdt(&text);
            if read.program.is_none() {
                return Err(format!("does not read: {:?}", read.diagnostics));
            }
            Ok(rows(read.spans.iter()))
        }
        "json" => {
            let parsed = mandate_ir::parse(&text).map_err(|d| format!("does not read: {d:?}"))?;
            Ok(rows(parsed.spans.iter().map(|(p, s)| (p.as_str(), *s))))
        }
        other => Err(format!("unknown kind {other:?}")),
    }
}

fn check(vector: &Value) -> Result<(), String> {
    let source = vector
        .get("source")
        .and_then(Value::as_str)
        .ok_or("no source")?;
    let kind = vector
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("no kind")?;
    let expected = vector_rows(vector.get("spans"))?;
    let count = vector
        .get("count")
        .and_then(Value::as_i64)
        .ok_or("no count")?;
    if usize::try_from(count).ok() != Some(expected.len()) {
        return Err(format!("count {count} but {} rows", expected.len()));
    }
    same_lines("spans", &expected, &table(source, kind)?)
}

#[test]
fn span_tables() {
    let mut items: Vec<(String, Value)> = Vec::new();
    for file in files(DIR).expect("the span vectors") {
        let vector = read_json(&format!("{DIR}/{file}")).expect("a span vector");
        let source = vector
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or(&file)
            .to_owned();
        items.push((source, vector));
    }
    if let Err(report) = run_gate("span tables", PENDING, items, check) {
        panic!("{report}");
    }
}
