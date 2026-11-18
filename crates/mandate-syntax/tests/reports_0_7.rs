//! `report to <role> "<title>" { name: expr, … }` (language 0.7,
//! spec/attention.md "`report`"): read only under `mandate @ 0.7`, at the
//! start of a statement and only in that shape, its fields an array in the
//! order written, a trailing comma allowed, two fields of one name E0121;
//! printed on one line when it fits, one field a line when not; and print,
//! read, print gives the same text. No TypeScript reads 0.7, so each
//! expectation is written by hand.

#![allow(
    clippy::panic,
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_ir::{Value, canonicalize, has_errors};
use mandate_syntax::{RESERVED, SourceKind, load, parse_mdt, print_program};

/// A program of `version` whose one function's body is `body`.
fn program(version: &str, body: &str) -> String {
    format!(
        "mandate @ {version}\n\nmodule m @ 0.1\n\nfn f(report: Int, to: Int) -> Int\n{{\n{body}\n}}\n"
    )
}

/// The IR of `text`, which must read without an error.
fn read(text: &str) -> Value {
    let r = parse_mdt(text);
    assert!(!has_errors(&r.diagnostics), "{:?}", r.diagnostics);
    r.program.expect("a program")
}

/// The statements of the function's body.
fn body(ir: &Value) -> Vec<Value> {
    ir.get("defs")
        .and_then(|d| d.get("f"))
        .and_then(|f| f.get("body"))
        .and_then(Value::as_array)
        .unwrap()
        .to_vec()
}

/// The `op` of each statement of the function's body.
fn ops(ir: &Value) -> Vec<String> {
    body(ir)
        .iter()
        .map(|s| s.get("op").and_then(Value::as_str).unwrap().to_owned())
        .collect()
}

#[test]
fn a_report_is_read_under_0_7_as_a_statement_of_its_own() {
    let text = program(
        "0.7",
        "  report to accountant \"Items collected\" { items: report + to, total: 3, }\n  report",
    );
    let ir = read(&text);
    assert_eq!(ops(&ir), ["report", "expr"]);
    assert_eq!(
        canonicalize(&body(&ir)[0]),
        r#"{"fields":[{"name":"items","value":{"bop":"+","left":{"name":"report","op":"var"},"op":"binary","right":{"name":"to","op":"var"}}},{"name":"total","value":{"op":"int","value":3}}],"op":"report","role":"accountant","title":"Items collected"}"#
    );
    // The fields stay in the order written: the canonical form sorts no
    // array.
    let ir = read(&program(
        "0.7",
        "  report to r \"T\" { zeta: 1, alpha: 2 }\n  1",
    ));
    let first = body(&ir)[0].clone();
    let fields: Vec<&str> = first
        .get("fields")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|f| f.get("name").and_then(Value::as_str).unwrap())
        .collect();
    assert_eq!(fields, ["zeta", "alpha"]);
    // The spans: the statement's lines, and each field's name to value.
    let text = program(
        "0.7",
        "  report to accountant \"Done\" {\n    posted: 1,\n    failed: 2\n  }\n  1",
    );
    let r = parse_mdt(&text);
    let span = r.spans.get("/defs/f/body/0").expect("a span");
    assert_eq!(
        (span.start_line, span.start_col, span.end_line, span.end_col),
        (7, 3, 10, 4)
    );
    let span = r.spans.get("/defs/f/body/0/fields/1").expect("a span");
    assert_eq!(
        (span.start_line, span.start_col, span.end_line, span.end_col),
        (9, 5, 9, 14)
    );
    assert!(r.spans.get("/defs/f/body/0/fields/1/value").is_some());
    // It loads: the 0.7 schema has the statement.
    let loaded = load(&text, SourceKind::Mdt);
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
}

#[test]
fn report_and_to_stay_names_wherever_the_shape_does_not_follow_and_before_0_7() {
    // Neither is reserved, and the list does not change.
    assert!(!RESERVED.contains(&"report") && !RESERVED.contains(&"to"));
    assert_eq!(RESERVED.len(), 34);
    for body in [
        "  report",
        "  report + to",
        "  to",
        "  let report2 = report\n  report2",
        // The shape broken across lines: `to`, the role or the title on the
        // next line.
        "  report\n  to",
        "  report to\n  accountant",
        "  report to accountant\n  \"Done\"",
        // `to` is not there, or the role is not a name.
        "  report accountant",
        "  report to \"Done\"",
        "  report to 1",
    ] {
        let r = parse_mdt(&program("0.7", body));
        if let Some(ir) = r.program.as_ref() {
            assert!(
                !ops(ir).iter().any(|o| o == "report"),
                "{body:?}: {:?}",
                ops(ir)
            );
        }
    }
    // Before 0.7 the shape itself is no statement.
    for version in ["0.6", "0.5", "0.1"] {
        let r = parse_mdt(&program(version, "  report to x\n  1"));
        let ir = r.program.expect("a program");
        assert_eq!(ops(&ir), ["expr", "expr", "expr", "expr"], "{version}");
        let r = parse_mdt(&program(version, "  report to x \"T\" { a: 1 }\n  1"));
        assert!(
            r.program
                .as_ref()
                .is_none_or(|ir| !ops(ir).iter().any(|o| o == "report")),
            "{version}"
        );
    }
}

#[test]
fn a_report_title_is_constant_text_and_its_fields_have_names_of_their_own() {
    let r = parse_mdt(&program(
        "0.7",
        "  report to r \"Collected {report}\" { n: 1 }\n  1",
    ));
    assert!(r.program.is_none());
    assert_eq!(r.diagnostics.len(), 1);
    assert_eq!(r.diagnostics[0].code, "MDT-E0101");
    assert_eq!(
        r.diagnostics[0].message,
        "Interpolation is not allowed in a report title."
    );
    // Two fields of one name: E0121 at the second, and the reading goes on.
    let r = parse_mdt(&program(
        "0.7",
        "  report to r \"T\" { n: 1, m: 2, n: 3 }\n  1",
    ));
    let e: Vec<(&str, &str)> = r
        .diagnostics
        .iter()
        .map(|d| (d.code.as_str(), d.message.as_str()))
        .collect();
    assert_eq!(e, [("MDT-E0121", "Duplicate report field 'n'.")]);
    let span = r.diagnostics[0].at.span.expect("a span");
    assert_eq!((span.start_line, span.start_col), (7, 33));
    // A field is a name, a colon and an expression: no shorthand, no empty
    // report.
    for body in [
        "  report to r \"T\" { n }\n  1",
        "  report to r \"T\" { }\n  1",
        "  report to r \"T\" { , }\n  1",
        "  report to r \"T\" { let: 1 }\n  1",
        "  report to r \"T\"\n  1",
    ] {
        let r = parse_mdt(&program("0.7", body));
        assert!(has_errors(&r.diagnostics), "{body:?}");
    }
}

#[test]
fn a_report_prints_on_one_line_when_it_fits_and_a_field_a_line_when_not() {
    let text = "mandate @ 0.7\n\nmodule m @ 0.1\n\nfn f(report: Int, to: Int) -> Int\n{\n  report to accountant \"Items \\\"collected\\\"\" { items: report + to, total: 3, }\n  if report > 2 {\n    report to accountant \"Batch done\" { posted: report, declined: to, failed: report - to, retried: report * to }\n  }\n  report to finance_lead \"Long\" {\n    a: 1\n  }\n  report\n}\n";
    let ir = read(text);
    let printed = print_program(&ir).expect("printed");
    assert_eq!(
        printed,
        "mandate @ 0.7\n\nmodule m @ 0.1\n\nfn f(report: Int, to: Int) -> Int\n{\n  report to accountant \"Items \\\"collected\\\"\" { items: report + to, total: 3 }\n  if report > 2 {\n    report to accountant \"Batch done\" {\n      posted: report,\n      declined: to,\n      failed: report - to,\n      retried: report * to\n    }\n  }\n  report to finance_lead \"Long\" { a: 1 }\n  report\n}\n"
    );
    let again = read(&printed);
    assert_eq!(canonicalize(&again), canonicalize(&ir));
    assert_eq!(print_program(&again).expect("printed again"), printed);
}
