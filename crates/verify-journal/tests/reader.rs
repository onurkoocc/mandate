//! The reading rules and limits of an export (spec/journal.md "Reading an
//! export"), one by one, and the shape of an export (rule 8) on edits of a
//! real one, case J01.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::fs;
use std::path::Path;

use verify_journal::{
    Code, EXPORT_BYTES, EXPORT_DEPTH, Json, ReadError, Status, canonical, public_keys_in,
    read_json, verify_export,
};

/// A named edit of an export read as JSON.
type Edit<'a> = (&'a str, Box<dyn Fn(&mut Json)>);

fn malformed(text: &[u8]) -> bool {
    matches!(read_json(text), Err(ReadError::Malformed(_)))
}

fn over(text: &[u8]) -> bool {
    matches!(read_json(text), Err(ReadError::OverLimit(_)))
}

fn reads(text: &str) -> Json {
    read_json(text.as_bytes()).unwrap_or_else(|e| panic!("{text:?}: {e:?}"))
}

#[test]
fn rule_1_the_size_is_checked_first() {
    // Exactly the limit reads; one byte more is over it, whatever it holds.
    let mut at_limit = vec![b' '; EXPORT_BYTES];
    at_limit[0] = b'0';
    assert_eq!(read_json(&at_limit), Ok(Json::Number(0.0)));
    at_limit.push(b' ');
    assert!(over(&at_limit));
    let not_utf8 = vec![0xff_u8; EXPORT_BYTES + 1];
    assert!(over(&not_utf8));
}

#[test]
fn rule_2_utf8_without_a_byte_order_mark() {
    assert!(malformed(b"\xef\xbb\xbf{}"));
    assert!(malformed(b"\"\xff\""));
    // An encoded surrogate and an overlong form are not UTF-8.
    assert!(malformed(b"\"\xed\xa0\x80\""));
    assert!(malformed(b"\"\xc0\xaf\""));
    // Not UTF-8 after something deep is still not UTF-8: the whole is
    // checked before the JSON is read.
    let mut deep = vec![b'['; EXPORT_DEPTH + 1];
    deep.push(0xff);
    assert!(malformed(&deep));
    assert_eq!(reads("\"é😀\""), Json::String("é😀".to_owned()));
}

#[test]
fn rule_3_one_json_text() {
    for text in [
        "",
        " ",
        "01",
        "-01",
        "+1",
        "1.",
        ".5",
        "1e",
        "1e+",
        "-",
        "--1",
        "0x10",
        "[1,]",
        "{\"a\":1,}",
        "[,1]",
        "{,}",
        "/* */ 1",
        "1 // c",
        "1 2",
        "[1] x",
        "\u{c}1",
        "\u{a0}1",
        "nul",
        "True",
        "NaN",
        "Infinity",
        "'a'",
        "{a:1}",
        "[1 2]",
        "{\"a\" 1}",
        "{\"a\":1 \"b\":2}",
        "[",
        "{",
        "\"a",
    ] {
        assert!(malformed(text.as_bytes()), "{text:?} is malformed");
    }
    assert_eq!(
        reads(" \t\r\n[ 1 ,\t2 ]\r\n "),
        Json::Array(vec![Json::Number(1.0), Json::Number(2.0)])
    );
    assert_eq!(reads("true"), Json::Bool(true));
    assert_eq!(reads("null"), Json::Null);
    assert_eq!(reads("{}"), Json::Object(Vec::new()));
}

#[test]
fn rule_4_at_most_256_arrays_and_objects_nested() {
    let arrays = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
    assert!(read_json(arrays(EXPORT_DEPTH).as_bytes()).is_ok());
    assert!(over(arrays(EXPORT_DEPTH + 1).as_bytes()));
    let objects = |n: usize| format!("{}1{}", "{\"a\":".repeat(n), "}".repeat(n));
    assert!(read_json(objects(EXPORT_DEPTH).as_bytes()).is_ok());
    assert!(over(objects(EXPORT_DEPTH + 1).as_bytes()));
    // Scalars do not count: a number inside 256 arrays is within the limit.
    let deep_number = format!("{}0{}", "[".repeat(EXPORT_DEPTH), "]".repeat(EXPORT_DEPTH));
    assert!(read_json(deep_number.as_bytes()).is_ok());
    // Far deeper is over the limit, and does not exhaust the stack.
    assert!(over("[".repeat(1_000_000).as_bytes()));
    assert!(over("{\"a\":".repeat(1_000_000).as_bytes()));
}

#[test]
fn the_first_rule_broken_in_the_text_is_the_one_reported() {
    let deep = "[".repeat(EXPORT_DEPTH + 1);
    // Too deep before it is malformed: over the limit.
    assert!(over(format!("{deep}x").as_bytes()));
    assert!(over(format!("{{\"a\":{deep}], \"a\": 1}}").as_bytes()));
    // Malformed before it is too deep: malformed.
    assert!(malformed(format!("[x, {deep}").as_bytes()));
    assert!(malformed(format!("[1e400, {deep}").as_bytes()));
    assert!(malformed(format!("[\"\\ud800\", {deep}").as_bytes()));
    // A duplicate name is found where the second name ends, before its value.
    assert!(malformed(format!("{{\"a\": 1, \"a\": {deep}").as_bytes()));
}

#[test]
fn rule_5_no_duplicate_member_names_once_their_escapes_are_read() {
    assert!(malformed(br#"{"a": 1, "a": 1}"#));
    assert!(malformed(br#"{"a": 1, "\u0061": 2}"#));
    assert!(malformed(r#"{"\u00e9": 1, "é": 2}"#.as_bytes()));
    assert!(malformed(br#"{"x": {"a": 1, "b": 2, "a": 3}}"#));
    // Not the same name: no Unicode normalisation, and case matters.
    assert!(read_json("{\"\u{e9}\": 1, \"e\u{301}\": 2, \"A\": 3, \"a\": 4}".as_bytes()).is_ok());
    // The same name in two objects is no duplicate.
    assert!(read_json(br#"[{"a": 1}, {"a": 2}]"#).is_ok());
    let proto = reads(r#"{"__proto__": {"x": 1}, "constructor": 2}"#);
    assert_eq!(
        proto.get("__proto__").and_then(|p| p.get("x")),
        Some(&Json::Number(1.0))
    );
    assert_eq!(proto.as_object().map(<[_]>::len), Some(2));
}

#[test]
fn rule_6_the_escapes_of_rfc_8259_and_no_lone_surrogate() {
    assert_eq!(
        reads(r#""\"\\\/\b\f\n\r\t\u00e9\u00E9\ud83d\ude00\u0000""#),
        Json::String("\"\\/\u{8}\u{c}\n\r\té\u{e9}😀\u{0}".to_owned())
    );
    assert_eq!(reads(r#""a\/b""#), reads(r#""a/b""#));
    for text in [
        r#""\ud800""#,
        r#""\udc00""#,
        r#""\ud800\u0041""#,
        r#""\ud800x""#,
        r#""\ud800\""#,
        r#""\ude00\ud83d""#,
        r#""\x41""#,
        r#""\u12""#,
        r#""\u12g4""#,
        r#""\U0041""#,
        r#""\'""#,
        "\"\\",
    ] {
        assert!(malformed(text.as_bytes()), "{text} is malformed");
    }
    for control in 0_u8..0x20 {
        assert!(
            malformed(&[b'"', control, b'"']),
            "U+{control:04X} unescaped"
        );
    }
    // U+007F and the line and paragraph separators need no escape.
    assert_eq!(
        reads("\"\u{7f}\u{2028}\u{2029}\""),
        Json::String("\u{7f}\u{2028}\u{2029}".to_owned())
    );
}

#[test]
fn rule_7_numbers_are_the_nearest_double() {
    for (text, want) in [
        ("1", 1.0),
        ("1.0", 1.0),
        ("1e0", 1.0),
        ("10e-1", 1.0),
        ("1E21", 1e21),
        ("0.10", 0.1),
        ("9007199254740993", 9_007_199_254_740_992.0),
        ("1.7976931348623157e308", f64::MAX),
        ("5e-324", 5e-324),
    ] {
        assert_eq!(reads(text), Json::Number(want), "{text}");
    }
    for text in ["1e400", "-1e400", "1.8e308", "1e99999999999"] {
        assert!(malformed(text.as_bytes()), "{text} is beyond a double");
    }
    // Below the smallest double reads as zero, with the sign it has; -0 as -0.
    for (text, negative) in [
        ("1e-400", false),
        ("-1e-400", true),
        ("-0", true),
        ("-0.0", true),
        ("0", false),
    ] {
        let Json::Number(x) = reads(text) else {
            panic!("{text} is a number");
        };
        assert!(x == 0.0 && x.is_sign_negative() == negative, "{text}");
    }
    assert_eq!(canonical(&reads("[-0, 1e-400, -1e-400]")), "[0,0,0]");
}

fn s(x: &str) -> Json {
    Json::String(x.to_owned())
}

fn n(x: f64) -> Json {
    Json::Number(x)
}

fn j01() -> Json {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/J01/export.json");
    read_json(&fs::read(path).expect("J01")).expect("J01 reads")
}

fn j01_keys() -> Vec<verify_journal::PublicKey> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/J01/key.pem");
    public_keys_in(&fs::read_to_string(path).expect("J01's key")).expect("a key")
}

/// The member at `path` (names, and indices of arrays), to edit.
fn at<'a>(v: &'a mut Json, path: &[&str]) -> &'a mut Json {
    let mut v = v;
    for step in path {
        v = match v {
            Json::Object(members) => {
                &mut members
                    .iter_mut()
                    .find(|(k, _)| k == step)
                    .unwrap_or_else(|| panic!("no member {step}"))
                    .1
            }
            Json::Array(items) => &mut items[step.parse::<usize>().expect("an index")],
            _ => panic!("{step}: not an object or array"),
        };
    }
    v
}

fn remove(v: &mut Json, path: &[&str], name: &str) {
    let Json::Object(members) = at(v, path) else {
        panic!("not an object");
    };
    members.retain(|(k, _)| k != name);
}

fn add(v: &mut Json, path: &[&str], name: &str, value: Json) {
    let Json::Object(members) = at(v, path) else {
        panic!("not an object");
    };
    members.push((name.to_owned(), value));
}

fn status_of(v: &Json) -> (Status, Vec<Code>) {
    let report = verify_export(canonical(v).as_bytes(), &j01_keys());
    (
        report.status,
        report.findings.iter().map(|f| f.code).collect(),
    )
}

fn assert_malformed(v: &Json, what: &str) {
    assert_eq!(
        status_of(v),
        (Status::Unreadable, vec![Code::MalformedExport]),
        "{what}"
    );
}

#[test]
fn j01_verifies_in_canonical_form_too() {
    assert_eq!(status_of(&j01()).0, Status::Verified);
}

#[test]
fn rule_8_the_shape_of_an_export() {
    let edits: Vec<Edit<'_>> = vec![
        ("no format", Box::new(|v| remove(v, &[], "format"))),
        (
            "another format",
            Box::new(|v| *at(v, &["format"]) = s("mandate/journal-export/0.2")),
        ),
        (
            "an extra member",
            Box::new(|v| add(v, &[], "extra", Json::Null)),
        ),
        ("an empty run", Box::new(|v| *at(v, &["run"]) = s(""))),
        (
            "a run that is not a string",
            Box::new(|v| *at(v, &["run"]) = n(1.0)),
        ),
        (
            "a tenant that is null",
            Box::new(|v| *at(v, &["tenant"]) = Json::Null),
        ),
        (
            "a manifest_hash that is a number",
            Box::new(|v| *at(v, &["manifest_hash"]) = n(1.0)),
        ),
        (
            "a manifest that is a list",
            Box::new(|v| *at(v, &["manifest"]) = Json::Array(Vec::new())),
        ),
        (
            "a manifest that is a string",
            Box::new(|v| *at(v, &["manifest"]) = s("m")),
        ),
        (
            "a package without modules",
            Box::new(|v| remove(v, &["package"], "modules")),
        ),
        (
            "a package with more",
            Box::new(|v| add(v, &["package"], "x", Json::Null)),
        ),
        (
            "a program that is a list",
            Box::new(|v| *at(v, &["package", "program"]) = Json::Array(Vec::new())),
        ),
        (
            "a lock that is null",
            Box::new(|v| *at(v, &["package", "lock"]) = Json::Null),
        ),
        (
            "a package hash that is null",
            Box::new(|v| *at(v, &["package", "hash"]) = Json::Null),
        ),
        (
            "no events",
            Box::new(|v| *at(v, &["events"]) = Json::Array(Vec::new())),
        ),
        (
            "events that are an object",
            Box::new(|v| *at(v, &["events"]) = Json::Object(Vec::new())),
        ),
        (
            "an event without data",
            Box::new(|v| remove(v, &["events", "0"], "data")),
        ),
        (
            "an event with more",
            Box::new(|v| add(v, &["events", "0"], "x", Json::Null)),
        ),
        (
            "a seq of 0",
            Box::new(|v| *at(v, &["events", "0", "seq"]) = n(0.0)),
        ),
        (
            "a seq of -0",
            Box::new(|v| *at(v, &["events", "0", "seq"]) = n(-0.0)),
        ),
        (
            "a seq of 1.5",
            Box::new(|v| *at(v, &["events", "0", "seq"]) = n(1.5)),
        ),
        (
            "a seq of 2^53",
            Box::new(|v| *at(v, &["events", "0", "seq"]) = n(9_007_199_254_740_992.0)),
        ),
        (
            "a seq that is a string",
            Box::new(|v| *at(v, &["events", "0", "seq"]) = s("1")),
        ),
        (
            "an at of 2^53",
            Box::new(|v| *at(v, &["events", "0", "at"]) = n(9_007_199_254_740_992.0)),
        ),
        (
            "an at of 0.5",
            Box::new(|v| *at(v, &["events", "0", "at"]) = n(0.5)),
        ),
        (
            "a type that is null",
            Box::new(|v| *at(v, &["events", "0", "type"]) = Json::Null),
        ),
        (
            "an event hash that is a number",
            Box::new(|v| *at(v, &["events", "0", "hash"]) = n(1.0)),
        ),
        (
            "anchors that are null",
            Box::new(|v| *at(v, &["anchors"]) = Json::Null),
        ),
        (
            "an anchor without a signature",
            Box::new(|v| remove(v, &["anchors", "0"], "signature")),
        ),
        (
            "an anchor hash that is null",
            Box::new(|v| *at(v, &["anchors", "0", "hash"]) = Json::Null),
        ),
        (
            "an anchor seq of 0",
            Box::new(|v| *at(v, &["anchors", "0", "seq"]) = n(0.0)),
        ),
        (
            "an anchor at of 1e300",
            Box::new(|v| *at(v, &["anchors", "0", "at"]) = n(1e300)),
        ),
        (
            "anchors out of order",
            Box::new(|v| {
                let Json::Array(anchors) = at(v, &["anchors"]) else {
                    panic!("anchors");
                };
                anchors.swap(0, 1);
            }),
        ),
        (
            "two anchors of one seq",
            Box::new(|v| {
                let Json::Array(anchors) = at(v, &["anchors"]) else {
                    panic!("anchors");
                };
                let first = anchors[0].clone();
                anchors.insert(0, first);
            }),
        ),
        (
            "keys that hold a number",
            Box::new(|v| *at(v, &["keys"]) = Json::Array(vec![n(1.0)])),
        ),
        (
            "keys that are a string",
            Box::new(|v| *at(v, &["keys"]) = s("k")),
        ),
        (
            "an export that is a list",
            Box::new(|v| *v = Json::Array(vec![v.clone()])),
        ),
    ];
    for (what, edit) in &edits {
        let mut v = j01();
        edit(&mut v);
        assert_malformed(&v, what);
    }

    // Within the shape: a negative time, -0 as a time, keys that name no key
    // given, anchors and keys empty. These are read, and checked.
    let readable: Vec<Edit<'_>> = vec![
        (
            "an at of -(2^53 - 1)",
            Box::new(|v| *at(v, &["events", "1", "at"]) = n(-9_007_199_254_740_991.0)),
        ),
        (
            "an at of -0",
            Box::new(|v| *at(v, &["events", "1", "at"]) = n(-0.0)),
        ),
        (
            "keys empty",
            Box::new(|v| *at(v, &["keys"]) = Json::Array(Vec::new())),
        ),
        (
            "keys of another key",
            Box::new(|v| *at(v, &["keys"]) = Json::Array(vec![s("sha256:00")])),
        ),
        (
            "a manifest that is null",
            Box::new(|v| *at(v, &["manifest"]) = Json::Null),
        ),
        (
            "a manifest_hash that is null",
            Box::new(|v| *at(v, &["manifest_hash"]) = Json::Null),
        ),
        (
            "anchors empty",
            Box::new(|v| *at(v, &["anchors"]) = Json::Array(Vec::new())),
        ),
        (
            "data that is any value",
            Box::new(|v| *at(v, &["events", "1", "data"]) = n(-1.5e-300)),
        ),
    ];
    for (what, edit) in &readable {
        let mut v = j01();
        edit(&mut v);
        assert_ne!(status_of(&v).0, Status::Unreadable, "{what} is read");
    }
}

#[test]
fn the_advisory_keys_are_never_trusted() {
    let mut v = j01();
    *at(&mut v, &["keys"]) = Json::Array(Vec::new());
    assert_eq!(status_of(&v).0, Status::Verified);
    // Without the key, every anchor is of an unknown key, whatever `keys` says.
    let report = verify_export(canonical(&j01()).as_bytes(), &[]);
    assert_eq!(report.status, Status::Broken);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.code == Code::AnchorUnknownKey)
    );
    assert!(report.signed_by.is_empty());
    assert_eq!(report.anchored_through, None);
}
