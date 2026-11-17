//! `stage <name> "<title>"` (language 0.7, spec/attention.md "`stage`"):
//! read only under `mandate @ 0.7`, at the start of a statement and only in
//! that shape; printed on a line of its own, after a blank line unless it
//! starts its block; and print, read, print gives the same text. No
//! TypeScript reads 0.7, so each expectation is written by hand.

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
    format!("mandate @ {version}\n\nmodule m @ 0.1\n\nfn f(stage: Int) -> Int\n{{\n{body}\n}}\n")
}

/// The IR of `text`, which must read without an error.
fn read(text: &str) -> Value {
    let r = parse_mdt(text);
    assert!(!has_errors(&r.diagnostics), "{:?}", r.diagnostics);
    r.program.expect("a program")
}

/// The `op` of each statement of the function's body.
fn ops(ir: &Value) -> Vec<String> {
    ir.get("defs")
        .and_then(|d| d.get("f"))
        .and_then(|f| f.get("body"))
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|s| s.get("op").and_then(Value::as_str).unwrap().to_owned())
        .collect()
}

#[test]
fn a_stage_is_read_under_0_7_as_a_statement_of_its_own() {
    let text = program(
        "0.7",
        "  stage collect \"Collect the items\"\n  let n = stage + 1\n  stage give \"Give it back\"\n  n",
    );
    let ir = read(&text);
    assert_eq!(ops(&ir), ["stage", "let", "stage", "expr"]);
    let first = ir
        .get("defs")
        .and_then(|d| d.get("f"))
        .and_then(|f| f.get("body"))
        .and_then(Value::as_array)
        .and_then(|b| b.first())
        .unwrap();
    assert_eq!(
        canonicalize(first),
        r#"{"name":"collect","op":"stage","title":"Collect the items"}"#
    );
    // The span is the whole line of the marker.
    let r = parse_mdt(&text);
    let span = r.spans.get("/defs/f/body/0").expect("a span");
    assert_eq!(
        (span.start_line, span.start_col, span.end_line, span.end_col),
        (7, 3, 7, 36)
    );
    // It loads: the 0.7 schema has the statement.
    let loaded = load(&text, SourceKind::Mdt);
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
}

#[test]
fn stage_stays_a_name_wherever_the_shape_does_not_follow_and_before_0_7() {
    // Not a reserved word, and the list does not change.
    assert!(!RESERVED.contains(&"stage"));
    assert_eq!(RESERVED.len(), 34);
    // A name at the start of a statement: what follows it is no name and a
    // string on its line.
    for body in [
        "  stage",
        "  stage + 1",
        "  let stage2 = stage\n  stage2",
        // The name on the next line, or the title.
        "  stage\n  collect",
        "  stage collect\n  \"Collect\"",
        // Not a name: a reserved word, a string, a number.
        "  stage\n  if true { 1 } else { 2 }",
        "  stage \"Collect\"",
    ] {
        let ir = read(&program("0.7", body));
        assert!(
            !ops(&ir).iter().any(|o| o == "stage"),
            "{body:?}: {:?}",
            ops(&ir)
        );
    }
    // Before 0.7 the shape itself is ordinary names: three expressions.
    for version in ["0.6", "0.5", "0.1"] {
        let ir = read(&program(version, "  stage collect \"Collect the items\""));
        assert_eq!(ops(&ir), ["expr", "expr", "expr"], "{version}");
    }
}

#[test]
fn a_stage_title_is_constant_text() {
    let r = parse_mdt(&program("0.7", "  stage collect \"Collect {stage}\"\n  1"));
    assert!(r.program.is_none());
    assert_eq!(r.diagnostics.len(), 1);
    assert_eq!(r.diagnostics[0].code, "MDT-E0101");
    assert_eq!(
        r.diagnostics[0].message,
        "Interpolation is not allowed in a stage title."
    );
    // A reserved word is no stage name: the statement is not a stage, and
    // what follows `stage` is read as the next statement.
    let r = parse_mdt(&program("0.7", "  stage let \"Collect\"\n  1"));
    assert!(has_errors(&r.diagnostics));
}

#[test]
fn a_stage_prints_on_its_line_after_a_blank_line_unless_it_starts_its_block() {
    // Written without the blank line; a title with quotes, braces and a line
    // feed, each escaped (whether such a title may stand is the check's).
    let text = "mandate @ 0.7\n\nmodule m @ 0.1\n\nfn f(stage: Int) -> Int\n{\n  stage collect \"Collect the \\\"items\\\"\"\n  let n = stage + 1\n  if n > 2 {\n    stage inner \"Inner\"\n    n\n  } else {\n    0\n  }\n  stage give \"Give \\{it\\} back\\n\"\n  n\n}\n";
    let ir = read(text);
    let printed = print_program(&ir).expect("printed");
    assert_eq!(
        printed,
        "mandate @ 0.7\n\nmodule m @ 0.1\n\nfn f(stage: Int) -> Int\n{\n  stage collect \"Collect the \\\"items\\\"\"\n  let n = stage + 1\n  if n > 2 {\n    stage inner \"Inner\"\n    n\n  } else {\n    0\n  }\n\n  stage give \"Give \\{it\\} back\\n\"\n  n\n}\n"
    );
    let again = read(&printed);
    assert_eq!(canonicalize(&again), canonicalize(&ir));
    assert_eq!(print_program(&again).expect("printed again"), printed);
}
