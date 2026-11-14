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
    lock_schema_diagnostics, lock_schema_errors, parse, stringify_pretty,
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

/// `load(input, "json").diagnostics` of every invalid IR, whole: the schema
/// diagnostics and those of the version gates, in order.
#[test]
fn invalid_ir_diagnostics() {
    let items = named("ir", parted_cases("ir-invalid"));
    let gate = run_gate("invalid IR diagnostics", &[], items, |case| {
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

/// The version gates of `validateIr`: each row of the `SINCE` tables, the
/// budget placements, `progress.repeats` and the negative literals, accepted
/// with no diagnostic or refused with exactly these.
#[test]
fn version_gates() {
    let items = named("gate", cases_of("ir-gates.json"));
    let gate = run_gate("version gates", &[], items, |case| {
        let loaded = load_json(str_of(case, "input"));
        let accepted = str_of(case, "verdict") == "accepted";
        if accepted != loaded.program.is_some() {
            return Err(format!("expected {}", str_of(case, "verdict")));
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

/// The locks the schema accepts and the rules of `validateLock` after the
/// schema refuse: those rules are slice R14's.
const LOCK_PENDING: &[&str] = &[
    "lock: bindings in a lock of 0.2, and every field that needs 0.5",
    "lock: members and roles in a lock of 0.3",
    "lock: host, isolation and egress in a lock of 0.4",
    "lock: a key listed under two members",
    "lock: a role lists a member that is not in members",
    "lock: a tier maps to a model that has no tariff",
];

/// `validateLock(value)` of every invalid lock, whole: one E0140 for each raw
/// error of the lock schema.
#[test]
fn lock_diagnostics() {
    let items = named("lock", cases_of("lock-invalid.json"));
    let gate = run_gate("lock diagnostics", LOCK_PENDING, items, |case| {
        let value = input_value(case)?;
        compare_text(
            &stored(case, "diagnostics"),
            &diagnostics_text(&lock_schema_diagnostics(&value)),
        )
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
}

/// The `load` result of each golden program given as JSON IR
/// (`vectors/diagnostics/golden-N.json`), whole.
#[test]
fn golden_programs_given_as_json_load_as_their_vectors_say() {
    let first = read_json("vectors/diagnostics/golden-1.json").expect("the vectors");
    let parts = first.get("parts").and_then(Value::as_i64).expect("parts");
    let mut items: Vec<(String, Value)> = Vec::new();
    for n in 1..=parts {
        let file = if n == 1 {
            first.clone()
        } else {
            read_json(&format!("vectors/diagnostics/golden-{n}.json")).expect("a part")
        };
        for program in file
            .get("programs")
            .and_then(Value::as_array)
            .expect("programs")
        {
            let path = str_of(program, "program");
            if path.ends_with(".json") {
                items.push((format!("load @ {path}"), program.clone()));
            }
        }
    }
    let gate = run_gate("golden load vectors", &[], items, |program| {
        let text = mandate_testkit::read_text(str_of(program, "program"))?;
        let want = program
            .get("results")
            .and_then(|r| r.get("load"))
            .ok_or("no load")?;
        compare_text(
            &pretty(&JsValue::from(want)),
            &diagnostics_text(&load_json(&text).diagnostics),
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
