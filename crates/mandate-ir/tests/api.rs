//! The public API's own behaviour, where the vectors do not reach.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::cmp::Ordering;

use mandate_ir::{
    Diagnostic, Int, JsObject, JsValue, Location, Map, Repair, RepairOp, RepairOpKind, Risk,
    Severity, Span, Value, canonicalize, compare_utf16, format_diagnostic, has_errors, limits,
    parse, ptr, ptr_token, stringify,
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
        stringify(&e.to_js()).unwrap(),
        r#"{"code":"MDT-E0108","severity":"error","message":"m","at":{},"docs":"mandate explain MDT-E0108"}"#
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

fn span(line: usize, col: usize) -> Span {
    Span {
        start_line: line,
        start_col: col,
        end_line: line,
        end_col: col + 1,
    }
}

fn written(at: &Location) -> String {
    stringify(&JsValue::Object(at.to_js())).unwrap()
}

#[test]
fn locations_keep_the_member_order_of_their_call_site() {
    assert_eq!(written(&Location::default()), "{}");
    assert_eq!(written(&Location::path("/a")), r#"{"path":"/a"}"#);
    assert_eq!(
        written(&Location::span(span(1, 2))),
        r#"{"span":[1,2,1,3]}"#
    );
    assert_eq!(
        written(&Location::path_span("/a", Some(span(1, 2)))),
        r#"{"path":"/a","span":[1,2,1,3]}"#
    );
    assert_eq!(
        written(&Location::path_span("/a", None)),
        r#"{"path":"/a"}"#
    );
    let reader = Location::span_path(span(1, 2), "");
    assert_eq!(written(&reader), r#"{"span":[1,2,1,3],"path":""}"#);
    // `{ ...at, span }`: a span already there keeps its place, a new one is last.
    assert_eq!(
        written(&reader.with_span(span(3, 4))),
        r#"{"span":[3,4,3,5],"path":""}"#
    );
    assert_eq!(
        written(&Location::path("/a").with_span(span(3, 4))),
        r#"{"path":"/a","span":[3,4,3,5]}"#
    );
}

#[test]
fn a_diagnostic_is_written_as_diag_builds_it() {
    // As resolve.ts reports E0120: a did_you_mean fact and a repair.
    let at = Location::path_span("/defs/a/body/0", Some(span(2, 5)));
    let facts = JsObject::new()
        .with("name", "fixr")
        .with("expected", "agent")
        .with_some("did_you_mean", Some("fixer"))
        .with_some("module", None::<&str>);
    let repair = Repair {
        id: "r1".to_owned(),
        summary: "Use 'fixer'".to_owned(),
        patch: vec![RepairOp {
            op: RepairOpKind::Replace,
            path: "/defs/a/body/0".to_owned(),
            value: Some(JsValue::from("fixer")),
        }],
        risk: Risk::Low,
        requires_approval: None,
    };
    let d = Diagnostic::new("E0120", "No agent 'fixr'.", at, Some(facts)).with_repair(vec![repair]);
    assert_eq!(
        stringify(&d.to_js()).unwrap(),
        concat!(
            r#"{"code":"MDT-E0120","severity":"error","message":"No agent 'fixr'.","#,
            r#""at":{"path":"/defs/a/body/0","span":[2,5,2,6]},"docs":"mandate explain MDT-E0120","#,
            r#""facts":{"name":"fixr","expected":"agent","did_you_mean":"fixer"},"#,
            r#""repair":[{"id":"r1","summary":"Use 'fixer'","patch":[{"op":"replace","path":"/defs/a/body/0","value":"fixer"}],"risk":"low"}]}"#
        )
    );
    assert_eq!(
        format_diagnostic(&d, Some("a.mdt")),
        "a.mdt:2:5: error MDT-E0120: No agent 'fixr'. [/defs/a/body/0]"
    );
    let w = Diagnostic::new("W0907", "Not carried.", Location::default(), None);
    assert_eq!(
        format_diagnostic(&w, None),
        "<input>: warning MDT-W0907: Not carried."
    );
    assert!(has_errors(&[w.clone(), d]));
    assert!(!has_errors(&[w]));
}

#[test]
fn pointers_escape_each_token() {
    assert_eq!(ptr(&[]), "");
    assert_eq!(ptr(&[&"uses", &3_usize, &"names"]), "/uses/3/names");
    assert_eq!(ptr(&[&"defs", &String::from("a/b~c")]), "/defs/a~1b~0c");
    assert_eq!((limits::DEFINITIONS, limits::EXPANDED_NODES), (64, 1000));
}
