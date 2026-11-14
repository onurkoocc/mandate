//! The public API as the slices after the parser use it: the printer reads
//! `ParseResult::program`; `check` reads a program of either form through
//! `load`. (The crate documentation's example, which the WebAssembly test
//! run cannot run, is checked here too.)

#![allow(
    clippy::panic,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeMap;

use mandate_ir::{Span, canonicalize, nearest_span};
use mandate_syntax::{RESERVED, SourceKind, SourceMap, kind_of, load, parse_mdt};

fn span(a: usize, b: usize, c: usize, d: usize) -> Span {
    Span {
        start_line: a,
        start_col: b,
        end_line: c,
        end_col: d,
    }
}

#[test]
fn the_crate_documentation_example() {
    let read = parse_mdt("module m @ 0.1\nlet x = 1 + 2\n");
    let program = read.program.expect("a program");
    assert_eq!(
        canonicalize(program.get("defs").expect("defs")),
        r#"{"x":{"kind":"const","value":{"bop":"+","left":{"op":"int","value":1},"op":"binary","right":{"op":"int","value":2}}}}"#
    );
    assert_eq!(read.spans.get("/defs/x/value"), Some(span(2, 9, 2, 14)));
    assert!(read.diagnostics.is_empty());

    let refused = parse_mdt("module m @ 0.1\nlet = 1\n");
    assert!(refused.program.is_none());
    assert!(refused.spans.is_empty());
    assert_eq!(
        refused.diagnostics[0].message,
        "Expected a name but found '='."
    );
}

#[test]
fn the_source_map_is_in_the_order_of_the_walk() {
    let read = parse_mdt("module m @ 0.1\nlet b = f(x)\nlet a = 1\n");
    let order: Vec<&str> = read.spans.iter().map(|(p, _)| p).collect();
    assert_eq!(
        order,
        [
            "",
            "/defs/b",
            "/defs/b/value",
            "/defs/b/value/callee",
            "/defs/b/value/args/0",
            "/defs/b/value/args/0/value",
            "/defs/a",
            "/defs/a/value",
        ]
    );
    assert_eq!(read.spans.len(), 8);
    // The form the JSON reader gives its table in.
    let sorted: BTreeMap<String, Span> = (&read.spans).into();
    assert_eq!(sorted.keys().next().map(String::as_str), Some(""));
    assert_eq!(sorted.get("/defs/a"), Some(&span(3, 1, 3, 10)));
}

#[test]
fn a_source_map_set_twice_keeps_the_first_place() {
    let mut map: SourceMap = [("/a", span(1, 1, 1, 2)), ("/b", span(2, 1, 2, 2))]
        .into_iter()
        .collect();
    map.insert("/a", span(9, 9, 9, 9));
    let order: Vec<(&str, Span)> = map.iter().collect();
    assert_eq!(order, [("/a", span(9, 9, 9, 9)), ("/b", span(2, 1, 2, 2))]);
    assert_eq!(map.get("/c"), None);
}

#[test]
fn diagnostics_read_on_come_with_the_program() {
    let read = parse_mdt("module m @ 0.1\nlet a = 1\nlet a = 2\n");
    let program = read.program.expect("a program");
    assert_eq!(
        canonicalize(&program),
        r#"{"defs":{"a":{"kind":"const","value":{"op":"int","value":2}}},"language":"mandate/0.1","module":"m","version":"0.1"}"#
    );
    assert_eq!(read.diagnostics.len(), 1);
    assert_eq!(read.diagnostics[0].code, "MDT-E0121");
    assert_eq!(read.diagnostics[0].message, "Duplicate definition 'a'.");
}

#[test]
fn the_reserved_words() {
    assert_eq!(RESERVED.len(), 34);
    assert!(RESERVED.contains(&"workflow"));
    assert!(!RESERVED.contains(&"role"));
}

const ROLE_IN_0_1: &str = "module m @ 0.1\nlet a = 1\nlet a = 2\nrole r \"d\"\n";

/// `load(text, "mdt")` as `check` calls it: the program comes back although
/// the schema refuses it, the parser's diagnostics before the schema's, and
/// the schema's placed at the nearest span the parser gave.
#[test]
fn load_of_text_keeps_the_program_whatever_the_schema_says() {
    assert_eq!(kind_of("fixtures/fixbug/fixbug.mdt"), SourceKind::Mdt);
    let loaded = load(ROLE_IN_0_1, SourceKind::Mdt);
    assert!(loaded.program.is_some());
    let found: Vec<(&str, &str, Option<&str>)> = loaded
        .diagnostics
        .iter()
        .map(|d| (d.code.as_str(), d.message.as_str(), d.at.path.as_deref()))
        .collect();
    assert_eq!(
        found,
        [
            ("MDT-E0121", "Duplicate definition 'a'.", None),
            (
                "MDT-E0104",
                "r: 'role' is a mandate/0.4 definition; this program is mandate/0.1.",
                Some("/defs/r/kind")
            ),
        ]
    );
    let role = span(4, 1, 4, 11);
    assert_eq!(loaded.spans.get("/defs/r"), Some(&role));
    assert_eq!(loaded.diagnostics[1].at.span, Some(role));
    assert_eq!(
        nearest_span(Some(&loaded.spans), "/defs/r/kind"),
        Some(role)
    );

    let refused = load("module m @ 0.1\nlet = 1\n", SourceKind::Mdt);
    assert!(refused.program.is_none());
    assert!(refused.spans.is_empty());
    assert_eq!(refused.diagnostics.len(), 1);
}

/// `load(text, "json")`: no program when the schema refuses it, but the
/// spans; a program when it does not.
#[test]
fn load_of_json_gives_no_program_with_an_error() {
    assert_eq!(kind_of("fixtures/fixbug/fixbug.ir.json"), SourceKind::Json);
    let text = r#"{"language": "mandate/0.1", "module": "m", "version": "0.1",
        "defs": {"r": {"kind": "role", "description": "d"}}}"#;
    let refused = load(text, SourceKind::Json);
    assert!(refused.program.is_none());
    assert_eq!(refused.diagnostics.len(), 1);
    assert_eq!(refused.diagnostics[0].code, "MDT-E0104");
    assert_eq!(
        refused.diagnostics[0].at.path.as_deref(),
        Some("/defs/r/kind")
    );
    assert!(refused.spans.contains_key("/defs/r/kind"));

    let accepted = load(
        &text.replace("mandate/0.1", "mandate/0.4"),
        SourceKind::Json,
    );
    assert!(
        accepted.diagnostics.is_empty(),
        "{:?}",
        accepted.diagnostics
    );
    let program = accepted.program.expect("a program");
    assert_eq!(
        program.get("defs").map(canonicalize).as_deref(),
        Some(r#"{"r":{"description":"d","kind":"role"}}"#)
    );
}
