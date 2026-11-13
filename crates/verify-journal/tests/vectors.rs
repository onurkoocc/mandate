//! The canonical form of runtime values and the hashes over it, against what
//! ECMAScript and the reference runtime give: the number vectors in
//! `tests/data/numbers.json` (written by `tests/data/numbers.mjs` with Node)
//! and the vectors in spec/journal.md, which the reference gives too.

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

use verify_journal::export::Event;
use verify_journal::verify::anchor_message;
use verify_journal::{Json, canonical, digest, event_hash, number_to_string, read_json};

fn numbers() -> Json {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/numbers.json");
    read_json(&fs::read(path).expect("numbers.json")).expect("numbers.json reads")
}

fn pairs<'a>(v: &'a Json, key: &str) -> Vec<(&'a str, Option<&'a str>)> {
    v.get(key)
        .and_then(Json::as_array)
        .expect("a list of vectors")
        .iter()
        .map(|p| {
            let p = p.as_array().expect("a pair");
            (p[0].as_str().expect("a string"), p[1].as_str())
        })
        .collect()
}

fn double(bits: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(bits, 16).expect("hex bits"))
}

#[test]
fn doubles_are_written_as_ecmascript_writes_them() {
    let v = numbers();
    let vectors = pairs(&v, "write");
    assert!(vectors.len() > 4000, "the vectors are there");
    let wrong: Vec<String> = vectors
        .iter()
        .filter_map(|(bits, want)| {
            let want = want.expect("a string");
            let got = number_to_string(double(bits));
            (got != want).then(|| format!("{bits}: expected {want}, got {got}"))
        })
        .collect();
    println!("number vectors written: {}", vectors.len());
    assert!(
        wrong.is_empty(),
        "{} of {} differ:\n{}",
        wrong.len(),
        vectors.len(),
        wrong.join("\n")
    );
}

#[test]
fn decimals_are_read_as_ecmascript_reads_them() {
    let v = numbers();
    let vectors = pairs(&v, "read");
    assert!(vectors.len() > 500, "the vectors are there");
    let mut wrong = Vec::new();
    for (lexeme, want) in &vectors {
        let got = read_json(lexeme.as_bytes());
        match (want, got) {
            (Some(bits), Ok(Json::Number(x))) if x.to_bits() == double(bits).to_bits() => {}
            (None, Err(verify_journal::ReadError::Malformed(_))) => {}
            (want, got) => wrong.push(format!("{lexeme}: expected {want:?}, got {got:?}")),
        }
    }
    println!("number vectors read: {}", vectors.len());
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn the_edges_of_the_number_forms() {
    for (x, want) in [
        (0.0, "0"),
        (-0.0, "0"),
        (100.0, "100"),
        (123_456_789_012_345_680_000.0, "123456789012345680000"),
        (1e21, "1e+21"),
        (123.456, "123.456"),
        (0.1, "0.1"),
        (0.000_001, "0.000001"),
        (1e-7, "1e-7"),
        (5e-324, "5e-324"),
        (f64::MAX, "1.7976931348623157e+308"),
        (-2.5e-8, "-2.5e-8"),
        (9_007_199_254_740_992.0, "9007199254740992"),
        (f64::NAN, "null"),
        (f64::INFINITY, "null"),
    ] {
        assert_eq!(number_to_string(x), want, "{x:e}");
    }
}

fn event(seq: u64, kind: &str, data: &str, at: i64) -> Event {
    Event {
        seq,
        kind: kind.to_owned(),
        data: read_json(data.as_bytes()).expect("data reads"),
        at,
        hash: None,
    }
}

const H1: &str = "sha256:95c8de5afdb66c9d9227bd744e2682a7b4f40d799b5a6bfd71880a036774b778";

#[test]
fn the_event_hashes_of_the_spec() {
    let e1 = event(
        1,
        "run_accepted",
        r#"{ "workflow": "Ask", "limits": { "spend:USD": 1000000 } }"#,
        1_800_000_000_000,
    );
    assert_eq!(event_hash("r1", &e1, None), H1);
    let e2 = event(
        2,
        "probe",
        r#"{ "Ａ": 1, "😀": [0.1, -0, 1e21, 1e-7, "é\n"], "a": null }"#,
        1_800_000_000_250,
    );
    assert_eq!(
        event_hash("r1", &e2, Some(H1)),
        "sha256:631a160101da7d8c9b09f13dc47118c3818d3c6c4bb0c74b9d56815d42287c3a"
    );
    let hex: String = canonical(&e2.data)
        .bytes()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        hex,
        "7b2261223a6e756c6c2c22f09f9880223a5b302e312c302c31652b32312c31652d372c22c3a95c6e225d2c22efbca1223a317d"
    );
}

#[test]
fn the_anchor_statement_of_the_spec() {
    assert_eq!(
        anchor_message("r1", 1, H1, 1_800_000_000_000),
        format!(
            "mandate/journal-anchor/0.1\n{{\"at\":1800000000000,\"format\":\"mandate/journal-anchor/0.1\",\"hash\":\"{H1}\",\"run\":\"r1\",\"seq\":1}}"
        )
    );
}

#[test]
fn strings_and_member_order_as_the_reference_writes_them() {
    // The reference's canonical and digest("run", …) of this value, from
    // runtime/dist/values.js.
    let value = read_json(
        br#"{"\u007f": "\u2028\u2029\/\u001f\u0000\b\f\n\r\t\"\\", "": [true, false, null, -1.5e-300, 123e-20, 1e300], "\ud83d\ude00": 1, "\uff21": 2, "\u00e9": 3, "e\u0301": 4}"#,
    )
    .expect("reads");
    assert_eq!(
        canonical(&value),
        "{\"\":[true,false,null,-1.5e-300,1.23e-18,1e+300],\"e\u{301}\":4,\"\u{7f}\":\"\u{2028}\u{2029}/\\u001f\\u0000\\b\\f\\n\\r\\t\\\"\\\\\",\"\u{e9}\":3,\"\u{1f600}\":1,\"\u{ff21}\":2}"
    );
    assert_eq!(
        digest("run", &value),
        "sha256:0dd83f52836cf518c506d06ab365fc6a495e1e24144c9b5bcd5bd98cc93441cf"
    );
}

#[test]
fn the_ir_form_refuses_what_the_ir_does_not_admit() {
    let ir = |text: &str| read_json(text.as_bytes()).expect("reads").to_ir();
    assert!(ir(r#"{"a": [1, -1, 9007199254740991, -9007199254740991, 1.0, 10e-1]}"#).is_some());
    for text in [
        "0.5",
        "-0",
        "-0.0",
        "9007199254740992",
        "1e300",
        "[1, 2.5]",
        r#"{"a": -0}"#,
    ] {
        assert!(ir(text).is_none(), "{text}");
    }
    // 1e-400 reads as +0, which the IR admits; -1e-400 as -0, which it does not.
    assert!(ir("1e-400").is_some());
    assert!(ir("-1e-400").is_none());
}
