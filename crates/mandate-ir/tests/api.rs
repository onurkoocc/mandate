//! The public API's own behaviour, where the vectors do not reach.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use std::cmp::Ordering;

use mandate_ir::{
    Diagnostic, Int, Location, Map, Severity, Span, Value, canonicalize, compare_utf16, parse,
    ptr_token,
};

#[test]
fn int_is_the_safe_integers() {
    assert_eq!(Int::new(9_007_199_254_740_991), Some(Int::MAX));
    assert_eq!(Int::new(-9_007_199_254_740_991), Some(Int::MIN));
    assert_eq!(Int::new(9_007_199_254_740_992), None);
    assert_eq!(Int::new(i64::MIN), None);
    assert_eq!(Int::saturating(i64::MAX), Int::MAX);
    // On a 32-bit target (wasm32) usize::MAX is below Int::MAX.
    #[cfg(target_pointer_width = "64")]
    assert_eq!(Int::from_usize_saturating(usize::MAX), Int::MAX);
}

#[test]
fn map_insert_replaces_in_place() {
    let mut m = Map::new();
    assert_eq!(m.insert("b", true), None);
    assert_eq!(m.insert("a", false), None);
    assert_eq!(m.insert("b", "x"), Some(Value::Bool(true)));
    assert_eq!(m.keys().collect::<Vec<_>>(), ["b", "a"]);
    assert_eq!(m.len(), 2);
    assert_eq!(m.remove("b"), Some(Value::from("x")));
    assert!(!m.contains_key("b"));
    assert_eq!(canonicalize(&Value::Object(m)), r#"{"a":false}"#);
}

#[test]
fn map_puts_array_indices_first_as_an_ecmascript_object_does() {
    let read = parse(r#"{"b": 0, "10": 0, "a": 0, "007": 0, "2": 0, "4294967295": 0}"#).unwrap();
    let keys: Vec<&str> = read.value.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["2", "10", "b", "a", "007", "4294967295"]);
    let mut m = Map::new();
    for k in ["b", "10", "a", "0", "10"] {
        m.insert(k, true);
    }
    assert_eq!(m.keys().collect::<Vec<_>>(), ["0", "10", "b", "a"]);
    assert_eq!(m.remove("0"), Some(Value::Bool(true)));
    m.insert("1", false);
    assert_eq!(m.keys().collect::<Vec<_>>(), ["1", "10", "b", "a"]);
}

#[test]
fn utf16_order_is_not_code_point_order() {
    assert_eq!(compare_utf16("\u{1F600}", "\u{E000}"), Ordering::Less);
    assert_eq!("\u{1F600}".cmp("\u{E000}"), Ordering::Greater);
    assert_eq!(compare_utf16("a", "ab"), Ordering::Less);
    assert_eq!(compare_utf16("", ""), Ordering::Equal);
}

#[test]
fn half_of_a_surrogate_pair_is_quoted_as_u_fffd() {
    // TypeScript quotes the high surrogate alone (vectors/README.md); a Rust string cannot hold it.
    let d = parse("\u{1F600}").unwrap_err();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].code, "MDT-E0108");
    assert_eq!(
        d[0].message,
        "Unexpected '\u{FFFD}' where a JSON value was expected."
    );
    assert_eq!(
        d[0].at.span,
        Some(Span {
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 2
        })
    );
    let d = parse("\"\\\u{1F600}\"").unwrap_err();
    assert_eq!(d[0].message, "Invalid escape '\\\u{FFFD}'.");
}

#[test]
fn diagnostic_severity_follows_the_code() {
    let w = Diagnostic::new("W0504", "m", Location::default(), None);
    assert_eq!(w.code, "MDT-W0504");
    assert_eq!(w.severity, Severity::Warning);
    assert_eq!(w.docs(), "mandate explain MDT-W0504");
    let e = Diagnostic::new("E0108", "m", Location::default(), None);
    assert_eq!(e.severity, Severity::Error);
    assert_eq!(
        canonicalize(&e.to_value()),
        r#"{"at":{},"code":"MDT-E0108","docs":"mandate explain MDT-E0108","message":"m","severity":"error"}"#
    );
}

#[test]
fn pointer_tokens() {
    assert_eq!(ptr_token("a/b~c"), "a~1b~0c");
    assert_eq!(ptr_token("~1"), "~01");
}

#[test]
fn spans_are_recorded_by_pointer() {
    let p = parse("{\"a\": [true]}").unwrap();
    assert_eq!(p.spans.len(), 3);
    assert_eq!(
        p.spans.get("/a/0").copied(),
        Some(Span {
            start_line: 1,
            start_col: 8,
            end_line: 1,
            end_col: 12
        })
    );
    assert_eq!(
        p.value
            .get("a")
            .and_then(Value::as_array)
            .map(<[Value]>::len),
        Some(1)
    );
}
