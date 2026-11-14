//! The schema validator, `validateIr` and the lock's schema diagnostics,
//! against the vectors the TypeScript compiler writes
//! (`vectors/schema/`, see `vectors/README.md`).
//!
//! Every comparison is of the text `stringify_pretty` gives, so a member out
//! of order is a difference too.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_ir::{
    Diagnostic, JsValue, Schema, SchemaError, SchemaOptions, Value, ir_schema_errors, load_json,
    lock_schema_errors, parse, stringify_pretty,
};
use mandate_testkit::{compare_text, read_json, run_gate};

/// The cases of a vector file in `vectors/schema/` that may come in parts
/// (`<stem>-1.json`, `<stem>-2.json`, …).
fn parted_cases(stem: &str) -> Vec<Value> {
    let first = read_json(&format!("vectors/schema/{stem}-1.json")).expect("the first part");
    let parts = first.get("parts").and_then(Value::as_i64).expect("parts");
    let mut cases: Vec<Value> = Vec::new();
    for n in 1..=parts {
        let file = if n == 1 {
            first.clone()
        } else {
            read_json(&format!("vectors/schema/{stem}-{n}.json")).expect("a part")
        };
        cases.extend(
            file.get("cases")
                .and_then(Value::as_array)
                .expect("cases")
                .to_vec(),
        );
    }
    cases
}

fn cases_of(file: &str) -> Vec<Value> {
    let file = read_json(&format!("vectors/schema/{file}")).expect("a vector file");
    file.get("cases")
        .and_then(Value::as_array)
        .expect("cases")
        .to_vec()
}

fn str_of<'a>(case: &'a Value, key: &str) -> &'a str {
    case.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no {key}"))
}

/// Named items for a gate, `<prefix>: <case name>`.
fn named(prefix: &str, cases: Vec<Value>) -> Vec<(String, Value)> {
    cases
        .into_iter()
        .map(|c| (format!("{prefix}: {}", str_of(&c, "name")), c))
        .collect()
}

/// The value the strict reader reads a case's input to.
fn input_value(case: &Value) -> Result<Value, String> {
    parse(str_of(case, "input"))
        .map(|p| p.value)
        .map_err(|d| format!("the reader refused the input: {}", d[0].message))
}

fn pretty(v: &JsValue) -> String {
    stringify_pretty(v).unwrap_or_default()
}

/// The stored member `key` of a case, as the text to compare with.
fn stored(case: &Value, key: &str) -> String {
    pretty(&JsValue::from(case.get(key).expect("a stored member")))
}

fn errors_text(errors: &[SchemaError]) -> String {
    pretty(&JsValue::Array(
        errors.iter().map(SchemaError::to_js).collect(),
    ))
}

/// The raw errors of every invalid IR and every invalid lock, whole and in
/// order.
#[test]
fn raw_errors() {
    let ir = named("ir", parted_cases("ir-invalid")).into_iter();
    let lock = named("lock", cases_of("lock-invalid.json")).into_iter();
    let items = ir
        .map(|(n, c)| (n, (false, c)))
        .chain(lock.map(|(n, c)| (n, (true, c))));
    let gate = run_gate("raw errors", &[], items, |(is_lock, case)| {
        let value = input_value(case)?;
        let errors = if *is_lock {
            lock_schema_errors(&value)
        } else {
            ir_schema_errors(&value)
        }
        .map_err(str::to_owned)?;
        compare_text(&stored(case, "raw_errors"), &errors_text(&errors))
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
}

fn diagnostics_text(diagnostics: &[Diagnostic]) -> String {
    pretty(&JsValue::Array(
        diagnostics.iter().map(Diagnostic::to_js).collect(),
    ))
}

/// The cases of invalid IR whose diagnostics need what this crate does not
/// give yet, with the reason.
const IR_PENDING: &[&str] = &[
    // The version gates of `validateIr` come in the next commit.
    "ir: agent_min: add unknown member \"loop\" to /defs/Support",
    "ir: agent_min: add unknown member \"progress\" to /defs/Support",
    "ir: agent_full: /defs/Peer/progress/window = 1",
];

/// `load(input, "json").diagnostics` of every invalid IR, whole: the schema
/// diagnostics and those of the version gates, in order.
#[test]
fn invalid_ir_diagnostics() {
    let items = named("ir", parted_cases("ir-invalid"));
    let gate = run_gate("invalid IR diagnostics", IR_PENDING, items, |case| {
        let loaded = load_json(str_of(case, "input"));
        if loaded.program.is_some() {
            return Err("the program was accepted".to_owned());
        }
        compare_text(
            &stored(case, "diagnostics"),
            &diagnostics_text(&loaded.diagnostics),
        )
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
}

/// A keyword the validator does not implement is refused when the schema is
/// prepared, wherever it is.
#[test]
fn an_unknown_keyword_is_refused_when_the_schema_is_prepared() {
    let refused = |text: &str| {
        let value = parse(text).expect("strict JSON").value;
        Schema::prepare(&value, SchemaOptions::default()).expect_err(text)
    };
    let found = refused(
        r#"{"type": "object", "properties": {"a": {"type": "string", "format": "email"}}}"#,
    );
    assert!(found.contains("\"format\""), "{found}");
    assert!(found.starts_with("/properties/a/format"), "{found}");
    let found = refused(
        r##"{"$defs": {"X": {"items": {"contains": {"const": 1}}}}, "$ref": "#/$defs/X"}"##,
    );
    assert!(found.starts_with("/$defs/X/items/contains"), "{found}");
    // A keyword Ajv knows but this validator does not run is refused too.
    refused(r#"{"anyOf": [{"type": "string"}]}"#);
    refused(r#"{"type": ["string", "null"]}"#);
    // So is a pattern with no hand-written matcher, and a discriminator
    // without the option.
    let found = refused(r#"{"type": "string", "pattern": "^[a-z]+$"}"#);
    assert!(found.contains("no hand-written matcher"), "{found}");
    refused(
        r#"{"type": "object", "discriminator": {"propertyName": "k"}, "required": ["k"], "oneOf": [{"properties": {"k": {"const": "a"}}}]}"#,
    );
    // The embedded schemas themselves prepare.
    mandate_ir::ir_schema().expect("the IR schema");
    mandate_ir::lock_schema().expect("the lock schema");
}
