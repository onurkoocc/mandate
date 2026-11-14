//! The syntax gates: every input of `vectors/syntax.json` (written by
//! `compiler/test/syntax-vectors.ts`; `vectors/README.md` says what each
//! field is) read by `mandate-syntax`, and compared exactly with what
//! `load(text, "mdt")` gave in TypeScript.
//!
//! Three gates, so that what the parser alone determines is checked now for
//! every input, and what needs a later slice is listed by name:
//!
//! - `syntax vectors: what the parser reads`, every input: whether a program
//!   comes back; when one does, its IR as JSON text in the parser's member
//!   order (or its depth, for one too deep to sit in the file), its
//!   canonical text (or its digest) and its span table (or its count and
//!   digest), and the parser's own diagnostics, which `load` puts first;
//!   when none does, the diagnostics in full, which are the parser's alone.
//! - `syntax vectors: the diagnostics of load`, every input that reads: all
//!   the diagnostics of `mandate_syntax::load`, the parser's followed by the
//!   schema validation's, and `ok`.
//! - `syntax vectors: fmt`, every input that reads without an error: the
//!   text `mandate fmt` prints and whether it reads back.

#![allow(
    clippy::panic,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use std::collections::BTreeMap;

use mandate_ir::{
    Diagnostic, JsObject, JsValue, Loaded, Value, canonicalize, has_errors, stringify,
};
use mandate_syntax::{ParseResult, SourceKind, parse_mdt, print_program};
use mandate_testkit::{compare_text, read_json, run_gate, sha256};

use common::{depth_of, json, rows, same_lines, vector_rows};

const SYNTAX: &str = "vectors/syntax.json";

/// The inputs whose diagnostics from `load` are not given yet. None.
const PENDING_LOAD: &[&str] = &[];

/// Nothing: every input that reads without an error prints as the
/// TypeScript prints it (`compiler/src/print/printer.ts`, slice R8).
const PENDING_FMT: &[&str] = &[];

/// One vector: what TypeScript gave, and what the Rust parser and `load`
/// give for its input.
struct Case {
    vector: Value,
    read: ParseResult,
    loaded: Loaded,
}

/// The text a vector stands for: `input`, or `input_parts` expanded as
/// `textOf` in `syntax-vectors.ts` does (each text repeated, all joined).
fn input_of(vector: &Value) -> Result<String, String> {
    if let Some(input) = vector.get("input").and_then(Value::as_str) {
        return Ok(input.to_owned());
    }
    let parts = vector
        .get("input_parts")
        .and_then(Value::as_array)
        .ok_or("no input and no input_parts")?;
    let mut text = String::new();
    for part in parts {
        let (Some(piece), Some(count)) = (
            part.as_array()
                .and_then(|p| p.first())
                .and_then(Value::as_str),
            part.as_array()
                .and_then(|p| p.get(1))
                .and_then(Value::as_i64),
        ) else {
            return Err(format!("a part that is not [text, count]: {}", json(part)));
        };
        let count = usize::try_from(count).map_err(|e| e.to_string())?;
        text.push_str(&piece.repeat(count));
    }
    Ok(text)
}

fn diagnostics_text(diags: &[Diagnostic]) -> Vec<String> {
    diags
        .iter()
        .map(|d| stringify(&d.to_js()).unwrap_or_default())
        .collect()
}

fn vector_diagnostics(vector: &Value) -> Result<Vec<String>, String> {
    Ok(vector
        .get("diagnostics")
        .and_then(Value::as_array)
        .ok_or("no diagnostics")?
        .iter()
        .map(json)
        .collect())
}

fn loads(vector: &Value) -> bool {
    vector.get("canonical").is_some() || vector.get("canonical_sha256").is_some()
}

fn str_field<'v>(vector: &'v Value, key: &str) -> Result<&'v str, String> {
    vector
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("no {key}"))
}

/// The first gate: what the parser alone determines.
fn check_read(case: &Case) -> Result<(), String> {
    let v = &case.vector;
    let expected_diags = vector_diagnostics(v)?;
    let actual_diags = diagnostics_text(&case.read.diagnostics);
    let Some(program) = &case.read.program else {
        if loads(v) {
            return Err(format!(
                "TypeScript reads a program, Rust does not: {}",
                actual_diags.join("\n    ")
            ));
        }
        return same_lines("diagnostics", &expected_diags, &actual_diags);
    };
    if !loads(v) {
        return Err(format!(
            "Rust reads a program, TypeScript does not: {}",
            expected_diags.join("\n    ")
        ));
    }

    let canonical = canonicalize(program);
    match v.get("canonical").and_then(Value::as_str) {
        Some(expected) => same_lines(
            "canonical text",
            &[expected.to_owned()],
            std::slice::from_ref(&canonical),
        )?,
        None => {
            let expected = format!("sha256:{}", str_field(v, "canonical_sha256")?);
            same_lines(
                "the digest of the canonical text",
                &[expected],
                &[sha256(&canonical)],
            )?;
        }
    }

    match v.get("ir") {
        Some(ir) => same_lines("ir", &[json(ir)], &[json(program)])?,
        None => {
            let depth = v
                .get("ir_depth")
                .and_then(Value::as_i64)
                .ok_or("no ir and no ir_depth")?;
            let actual = depth_of(program);
            if usize::try_from(depth).ok() != Some(actual) {
                return Err(format!("ir_depth {depth}, Rust's IR is {actual} deep"));
            }
        }
    }

    let actual_rows = rows(case.read.spans.iter());
    if v.get("spans").is_some() {
        same_lines("spans", &vector_rows(v.get("spans"))?, &actual_rows)?;
    } else {
        let count = v
            .get("spans_count")
            .and_then(Value::as_i64)
            .ok_or("no spans and no spans_count")?;
        if usize::try_from(count).ok() != Some(actual_rows.len()) {
            return Err(format!(
                "spans_count {count}, Rust gives {} rows",
                actual_rows.len()
            ));
        }
        let expected = format!("sha256:{}", str_field(v, "spans_sha256")?);
        same_lines(
            "the digest of the span rows",
            &[expected],
            &[sha256(&actual_rows.join("\n"))],
        )?;
    }

    // `load` gives the parser's diagnostics first, then the schema's.
    let prefix = expected_diags.get(..actual_diags.len()).ok_or_else(|| {
        format!(
            "Rust's parser gives {} diagnostics, load gave {} in all: {}",
            actual_diags.len(),
            expected_diags.len(),
            actual_diags.join("\n    ")
        )
    })?;
    same_lines("the parser's diagnostics", prefix, &actual_diags)
}

/// The second gate: all the diagnostics of `load`, and `ok`.
fn check_load(case: &Case) -> Result<(), String> {
    let v = &case.vector;
    same_lines(
        "diagnostics",
        &vector_diagnostics(v)?,
        &diagnostics_text(&case.loaded.diagnostics),
    )?;
    let ok = v
        .get("ok")
        .and_then(|o| JsValue::from(o).as_bool())
        .ok_or("no ok")?;
    let actual = case.loaded.program.is_some() && !has_errors(&case.loaded.diagnostics);
    if ok != actual {
        return Err(format!("ok is {ok}, Rust gives {actual}"));
    }
    Ok(())
}

/// `load(text, "mdt")`: the program, when the text reads, and all the
/// diagnostics, the parser's first.
// replace with mandate_syntax::load once it exists
fn load_text(text: &str) -> (Option<Value>, Vec<Diagnostic>) {
    let read = parse_mdt(text);
    let mut diagnostics = read.diagnostics.clone();
    if let Some(program) = &read.program {
        let spans = BTreeMap::from(&read.spans);
        diagnostics.extend(mandate_ir::validate_ir(program, Some(&spans)));
    }
    (read.program, diagnostics)
}

/// `fmt_roundtrip` as `syntax-vectors.ts` computes it: `true`, or
/// `{ reads, same_ir, stable }` with the diagnostics of the second reading
/// when it did not read.
fn roundtrip(printed: &str, canonical: &str) -> JsValue {
    let (again, diagnostics) = load_text(printed);
    let reads = again.is_some() && !has_errors(&diagnostics);
    let same_ir = reads && again.as_ref().is_some_and(|p| canonicalize(p) == canonical);
    let stable = reads
        && again
            .as_ref()
            .is_some_and(|p| print_program(p).is_ok_and(|text| text == printed));
    if reads && same_ir && stable {
        return JsValue::Bool(true);
    }
    let mut out = JsObject::new()
        .with("reads", reads)
        .with("same_ir", same_ir)
        .with("stable", stable);
    if !reads {
        out = out.with(
            "diagnostics",
            JsValue::Array(diagnostics.iter().map(Diagnostic::to_js).collect()),
        );
    }
    JsValue::Object(out)
}

/// The third gate: what `fmt` prints, and whether it reads back.
fn check_fmt(case: &Case) -> Result<(), String> {
    let v = &case.vector;
    let program = case
        .read
        .program
        .as_ref()
        .ok_or("TypeScript prints a program, Rust reads none")?;
    let printed = match print_program(program) {
        Ok(printed) => printed,
        Err(message) => {
            return same_lines(
                "fmt_error",
                &[str_field(v, "fmt_error")?.to_owned()],
                &[message],
            );
        }
    };
    compare_text(str_field(v, "fmt")?, &printed).map_err(|e| format!("fmt: {e}"))?;
    let expected = v.get("fmt_roundtrip").ok_or("no fmt_roundtrip")?;
    let actual = stringify(&roundtrip(&printed, &canonicalize(program))).unwrap_or_default();
    same_lines("fmt_roundtrip", &[json(expected)], &[actual])
}

fn name_of(vector: &Value) -> String {
    vector
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("(no name)")
        .to_owned()
}

#[test]
fn syntax_vectors() {
    let file = read_json(SYNTAX).expect("the syntax vectors");
    assert_eq!(
        file.get("format").and_then(Value::as_str),
        Some("mandate/vectors/syntax/0.1")
    );
    let vectors = file
        .get("vectors")
        .and_then(Value::as_array)
        .expect("a list of vectors");
    let mut cases: Vec<(String, Case)> = Vec::new();
    let mut problems: Vec<String> = Vec::new();
    for vector in vectors {
        let name = name_of(vector);
        match input_of(vector) {
            Ok(input) => {
                let read = parse_mdt(&input);
                let loaded = mandate_syntax::load(&input, SourceKind::Mdt);
                cases.push((
                    name,
                    Case {
                        vector: vector.clone(),
                        read,
                        loaded,
                    },
                ));
            }
            Err(why) => problems.push(format!("{name}: {why}")),
        }
    }

    let read = run_gate(
        "syntax vectors: what the parser reads",
        &[],
        cases.iter().map(|(n, c)| (n.clone(), c)),
        |c| check_read(c),
    );
    let load = run_gate(
        "syntax vectors: the diagnostics of load",
        PENDING_LOAD,
        cases
            .iter()
            .filter(|(_, c)| loads(&c.vector))
            .map(|(n, c)| (n.clone(), c)),
        |c| check_load(c),
    );
    let fmt = run_gate(
        "syntax vectors: fmt",
        PENDING_FMT,
        cases
            .iter()
            .filter(|(_, c)| c.vector.get("fmt").is_some())
            .map(|(n, c)| (n.clone(), c)),
        |c| check_fmt(c),
    );
    for gate in [read, load, fmt] {
        if let Err(report) = gate {
            problems.push(report);
        }
    }
    if !problems.is_empty() {
        panic!("{}", problems.join("\n\n"));
    }
}
