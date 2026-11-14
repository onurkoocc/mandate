//! The public API as the slices after the parser use it: the printer reads
//! `ParseResult::program`; `load` for text takes the program and its source
//! map to the schema validation. (The crate documentation's example, which
//! the WebAssembly test run cannot run, is checked here too.)

#![allow(
    clippy::panic,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeMap;

use mandate_ir::{Span, canonicalize};
use mandate_syntax::{RESERVED, SourceMap, parse_mdt};

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
