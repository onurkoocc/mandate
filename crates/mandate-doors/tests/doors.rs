//! The dispatcher against the two tables of doors and against what a
//! request may be.
//!
//! - Every call of both `inputs.json` files (`crates/mandate-check/tests/json_doors/`
//!   and `crates/mandate-views/tests/json_doors/`) goes through
//!   [`mandate_doors::answer`] as a request, and its answer must be the
//!   committed expectation of the TypeScript (`expected.json` beside it), by
//!   the test kit's `check_calls`; every door of each table has a call.
//! - Each answer, given the same request text twice, is the same text, and is
//!   written as `JSON.stringify` writes it; so are the answers to the calls
//!   of the views' doors of 0.7 (`crates/mandate-views/tests/rust_doors/inputs.json`),
//!   which no TypeScript function stands for.
//! - The door `doors` gives the four committed `doors.json` files (the
//!   checker's, the views', the library doors of 0.6 and 0.7, the views'
//!   doors of 0.7), one after the other, and its own row; no name is in two
//!   tables.
//! - Requests that are not requests: every sort of malformed text, value and
//!   member, each answered with its kind; an unknown door; a request at the
//!   limit of its length and one byte over; the depth of a request.

#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use common::{kind, read_answer, request, through, through_answer};
use mandate_doors::{
    MAX_REQUEST_BYTES, MAX_REQUEST_DEPTH, answer, answer_bytes, door, doors, tables,
};
use mandate_ir::{JsObject, JsValue, Value, stringify};
use mandate_testkit::json_doors::{Answer, check_calls, output_text, resolve};
use mandate_testkit::read_json;

const CHECK_DIR: &str = "crates/mandate-check/tests/json_doors";
const VIEWS_DIR: &str = "crates/mandate-views/tests/json_doors";
const LIBRARY_DIR: &str = "crates/mandate-check/tests/library_doors";
const RUST_DIR: &str = "crates/mandate-views/tests/rust_doors";

/// The directories of the two tables, with each table.
fn tables_and_dirs() -> [(&'static str, &'static [mandate_doors::Door]); 2] {
    [
        (CHECK_DIR, mandate_check::json_doors::DOORS),
        (VIEWS_DIR, mandate_views::json_doors::DOORS),
    ]
}

/// The directories whose calls are sent through the dispatcher and answered
/// twice with the same text, and turned into malformed requests: the two
/// tables held to the TypeScript, and the views' doors of 0.7.
fn answered_dirs() -> [&'static str; 3] {
    [CHECK_DIR, VIEWS_DIR, RUST_DIR]
}

/// Every call of `dir/inputs.json`: its name, its door and its input,
/// resolved.
fn calls(dir: &str) -> Vec<(String, String, Value)> {
    let inputs = read_json(&format!("{dir}/inputs.json")).expect("inputs.json");
    inputs
        .get("calls")
        .and_then(Value::as_array)
        .expect("calls")
        .iter()
        .map(|c| {
            let name = c.get("name").and_then(Value::as_str).expect("a name");
            let door = c.get("door").and_then(Value::as_str).expect("a door");
            let input = resolve(c.get("input").expect("an input")).expect("the input");
            (name.to_owned(), door.to_owned(), input)
        })
        .collect()
}

#[test]
fn every_call_of_both_tables_answers_as_the_typescript() {
    for (dir, table) in tables_and_dirs() {
        match check_calls(dir, &through_answer(table)) {
            Ok(summary) => println!("through answer, {dir}: {summary}"),
            Err(e) => panic!("through answer, {dir}: {e}"),
        }
    }
}

#[test]
fn the_same_request_gives_the_same_answer_text() {
    let mut n = 0;
    for dir in answered_dirs() {
        for (name, d, input) in calls(dir) {
            let r = request(&d, &input);
            let first = answer(&r);
            let second = answer(&r);
            assert_eq!(first, second, "{name}: two answers");
            read_answer(&first).unwrap_or_else(|why| panic!("{name}: {why}"));
            n += 1;
        }
    }
    println!("{n} requests, each answered twice with the same text");
}

#[test]
fn the_door_doors_is_both_doors_json_and_its_own_row() {
    let mut rows: Vec<JsValue> = Vec::new();
    // The two tables held to the TypeScript, then the library doors of 0.6
    // and 0.7, then the views' doors of 0.7.
    let library = (LIBRARY_DIR, mandate_check::json_doors::LIBRARY_DOORS);
    let rust = (RUST_DIR, mandate_views::json_doors::RUST_DOORS);
    for (dir, table) in tables_and_dirs().into_iter().chain([library, rust]) {
        let file = read_json(&format!("{dir}/doors.json")).expect("doors.json");
        let listed = file.get("doors").and_then(Value::as_array).expect("doors");
        assert_eq!(listed.len(), table.len(), "{dir}");
        rows.extend(listed.iter().map(JsValue::from));
    }
    let own = door("doors").expect("the door doors");
    assert!(own.ts.is_none() && own.params.is_empty() && own.note.is_some());
    rows.push(
        JsObject::new()
            .with("name", "doors")
            .with("ts", JsValue::Null)
            .with("params", JsValue::Array(Vec::new()))
            .with("note", own.note.unwrap_or_default())
            .into(),
    );
    let want: JsValue = JsObject::new()
        .with("format", "mandate/doors/0.1")
        .with("doors", rows)
        .into();
    let Answer::Output(got) = through(r#"{"door":"doors","input":{}}"#) else {
        panic!("the door doors gave no output");
    };
    assert_eq!(output_text(&got), output_text(&want));
    assert_eq!(output_text(&got), output_text(&mandate_doors::table()));

    // No name twice, and each name finds its door.
    let mut names: Vec<&str> = doors().map(|d| d.name).collect();
    let all = names.len();
    assert_eq!(
        all,
        tables().iter().map(|t| t.len()).sum::<usize>(),
        "doors() is the five tables"
    );
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), all, "a name is in two tables");
    for d in doors() {
        assert!(std::ptr::eq(door(d.name).expect("found"), d), "{}", d.name);
    }
    for input in ["null", "[]", r#"{"x":1}"#, "\"\""] {
        let a = through(&format!(r#"{{"door":"doors","input":{input}}}"#));
        assert_eq!(kind(&a), "bad_input", "doors with {input}");
    }
    println!(
        "doors: {all} doors ({} of the checker, {} of the views, {} of libraries, {} of the views of 0.7, 1 its own), each once",
        tables()[0].len(),
        tables()[1].len(),
        tables()[2].len(),
        tables()[3].len()
    );
}

/// A request text and the kind its answer must have.
const FIXED: &[(&str, &str)] = &[
    // Not JSON.
    ("", "bad_request"),
    ("   \n", "bad_request"),
    ("{", "bad_request"),
    (r#"{"door":"codes","input":{}"#, "bad_request"),
    (r#"{"door":"codes","input":{}}}"#, "bad_request"),
    (r#"{"door":"codes","input":{}} x"#, "bad_request"),
    (r#"{"door":"codes","input":{},}"#, "bad_request"),
    (r#"{"door":"codes",,"input":{}}"#, "bad_request"),
    (r#"{door:"codes","input":{}}"#, "bad_request"),
    (r#"{'door':'codes','input':{}}"#, "bad_request"),
    (r#"{"door":"codes" "input":{}}"#, "bad_request"),
    (r#"{"door":"codes","input":{}} {}"#, "bad_request"),
    ("\u{feff}{\"door\":\"codes\",\"input\":{}}", "bad_request"),
    (
        r#"{"door":"codes","input":{},"door":"codes"}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":{"a":1,"a":1}}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":1.5}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":1e3}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":1E+0}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":-0}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":01}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":+1}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":.5}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":-}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":9007199254740992}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":-9007199254740992}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":99999999999999999999999}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":NaN}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":tru}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":nul}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":"\ud800"}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":"\udc00"}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":"\ud800A"}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":"\ud800x"}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":"\u12"}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":"\x"}}"#,
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":"\'"}}"#,
        "bad_request",
    ),
    (
        "{\"door\":\"canonicalize\",\"input\":{\"value\":\"a\u{1}b\"}}",
        "bad_request",
    ),
    (
        "{\"door\":\"canonicalize\",\"input\":{\"value\":\"a\tb\"}}",
        "bad_request",
    ),
    (
        "{\"door\":\"canonicalize\",\"input\":{\"value\":\"a\nb\"}}",
        "bad_request",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":"open}}"#,
        "bad_request",
    ),
    // JSON, not a request.
    ("null", "bad_request"),
    ("true", "bad_request"),
    ("1", "bad_request"),
    (r#""codes""#, "bad_request"),
    (r#"["codes",{}]"#, "bad_request"),
    ("{}", "bad_request"),
    (r#"{"door":"codes"}"#, "bad_request"),
    (r#"{"input":{}}"#, "bad_request"),
    (r#"{"door":null,"input":{}}"#, "bad_request"),
    (r#"{"door":1,"input":{}}"#, "bad_request"),
    (r#"{"door":true,"input":{}}"#, "bad_request"),
    (r#"{"door":["codes"],"input":{}}"#, "bad_request"),
    (r#"{"door":{"name":"codes"},"input":{}}"#, "bad_request"),
    (r#"{"door":"codes","input":{},"id":1}"#, "bad_request"),
    (r#"{"door":"nothing","input":{},"id":1}"#, "bad_request"),
    (r#"{"door":"codes"," input":{}}"#, "bad_request"),
    (r#"{"Door":"codes","input":{}}"#, "bad_request"),
    // No such door.
    (r#"{"door":"nothing","input":{}}"#, "unknown_door"),
    (r#"{"door":"","input":{}}"#, "unknown_door"),
    (r#"{"door":"Codes","input":{}}"#, "unknown_door"),
    (r#"{"door":"codes ","input":{}}"#, "unknown_door"),
    (r#"{"door":"checkSubprogram","input":{}}"#, "unknown_door"),
    (r#"{"door":"constructor","input":{}}"#, "unknown_door"),
    (r#"{"door":"__proto__","input":{}}"#, "unknown_door"),
    (r#"{"door":"nothing","input":null}"#, "unknown_door"),
    // A door, an input it refuses.
    (r#"{"door":"codes","input":null}"#, "bad_input"),
    (r#"{"door":"codes","input":[]}"#, "bad_input"),
    (r#"{"door":"codes","input":"{}"}"#, "bad_input"),
    (r#"{"door":"codes","input":{"x":1}}"#, "bad_input"),
    (r#"{"door":"check","input":{}}"#, "bad_input"),
    (r#"{"door":"to_html","input":{"doc":{}}}"#, "bad_input"),
    // Requests.
    (r#"{"door":"codes","input":{}}"#, "ok"),
    (r#"{"input":{},"door":"codes"}"#, "ok"),
    (" \t\r\n{ \"door\" : \"codes\" , \"input\" : { } } \n", "ok"),
    (r#"{"door":"codes","input":{}}"#, "ok"),
    (
        r#"{"door":"canonicalize","input":{"value":9007199254740991}}"#,
        "ok",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":-9007199254740991}}"#,
        "ok",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":"😀 é \/ \b\f\n\r\t"}}"#,
        "ok",
    ),
    (
        r#"{"door":"canonicalize","input":{"value":[0,-1,true,false,null,"",{},[]]}}"#,
        "ok",
    ),
];

#[test]
fn malformed_requests_are_answered_with_their_kind() {
    let mut wrong: Vec<String> = Vec::new();
    for (text, want) in FIXED {
        let first = answer(text);
        if first != answer(text) {
            wrong.push(format!("{text:?}: two answers"));
        }
        match read_answer(&first) {
            Ok(a) if kind(&a) == *want => {}
            Ok(a) => wrong.push(format!("{text:?}: {} ({}), not {want}", kind(&a), a.text())),
            Err(why) => wrong.push(format!("{text:?}: {why}")),
        }
    }
    // Bytes that are not UTF-8.
    for bytes in [
        &b"{\"door\":\"codes\",\"input\":{}}\xff"[..],
        b"\xc3",
        b"\xed\xa0\x80",
    ] {
        let a = read_answer(&answer_bytes(bytes)).expect("an answer");
        if kind(&a) != "bad_request" {
            wrong.push(format!("{bytes:?}: {}", a.text()));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    println!(
        "{} malformed and well-formed requests, each answered with its kind",
        FIXED.len() + 3
    );
}

/// The requests a call's request is turned into, each with the kind its
/// answer must have (`same` for the call's own answer).
fn variants(d: &str, input: &Value) -> Vec<(String, &'static str)> {
    let input_text = stringify(&JsValue::from(input)).expect("a text");
    let door_text = stringify(&JsValue::from(d)).expect("a text");
    let good = request(d, input);
    let mut out: Vec<(String, &'static str)> = vec![
        (
            format!(r#"{{"input":{input_text},"door":{door_text}}}"#),
            "same",
        ),
        (format!(" {good}\n"), "same"),
        (format!(r#"{{"input":{input_text}}}"#), "bad_request"),
        (format!(r#"{{"door":{door_text}}}"#), "bad_request"),
        (
            format!(r#"{{"door":{door_text},"input":{input_text},"made_up":null}}"#),
            "bad_request",
        ),
        (
            format!(r#"{{"door":{door_text},"door":{door_text},"input":{input_text}}}"#),
            "bad_request",
        ),
        (format!("[{door_text},{input_text}]"), "bad_request"),
        (format!("{good},"), "bad_request"),
        (format!("{good}{good}"), "bad_request"),
        (
            format!(
                r#"{{"door":{},"input":{input_text}}}"#,
                stringify(&JsValue::from(d.to_uppercase())).expect("a text")
            ),
            "unknown_door",
        ),
        (
            format!(r#"{{"door":"{d}_","input":{input_text}}}"#),
            "unknown_door",
        ),
        (
            format!(r#"{{"door":{door_text},"input":[{input_text}]}}"#),
            "bad_input",
        ),
        (
            format!(r#"{{"door":{door_text},"input":"made-up"}}"#),
            "bad_input",
        ),
        (
            format!(r#"{{"door":{door_text},"input":null}}"#),
            "bad_input",
        ),
    ];
    for other in ["null", "7", "true", "[]", "{}"] {
        out.push((
            format!(r#"{{"door":{other},"input":{input_text}}}"#),
            "bad_request",
        ));
    }
    // Cut short: a part of an object is never JSON.
    for cut in [1, good.len() / 3, good.len() / 2, good.len() - 1] {
        if let Some(part) = good.get(..cut) {
            out.push((part.to_owned(), "bad_request"));
        }
    }
    out
}

#[test]
fn every_call_turned_into_malformed_requests() {
    let mut wrong: Vec<String> = Vec::new();
    let mut n = 0;
    for dir in answered_dirs() {
        for (name, d, input) in calls(dir) {
            let own = answer(&request(&d, &input));
            for (text, want) in variants(&d, &input) {
                n += 1;
                let got = answer(&text);
                if want == "same" {
                    if got != own {
                        wrong.push(format!("{name}: {text:.120} is not answered as the call"));
                    }
                    continue;
                }
                match read_answer(&got) {
                    Ok(a) if kind(&a) == want => {}
                    Ok(a) => wrong.push(format!("{name}: {text:.120}: {}, not {want}", kind(&a))),
                    Err(why) => wrong.push(format!("{name}: {text:.120}: {why}")),
                }
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "{} wrong:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
    println!("{n} requests made from the calls, each answered with its kind");
}

#[test]
fn the_answer_escapes_as_javascript_does() {
    // A control character in an output string, and a canonical text that
    // holds escapes.
    assert_eq!(
        answer(
            "{\"door\":\"to_markdown\",\"input\":{\"doc\":{\"title\":\"a\\u0001b\\u001f\\u2028\",\"meta\":[],\"blocks\":[]}}}"
        ),
        "{\"ok\":true,\"output\":\"# a\\u0001b\\u001f\u{2028}\\n\\n\"}"
    );
    assert_eq!(
        answer(r#"{"door":"canonicalize","input":{"value":"a\u0001\"\\"}}"#),
        r#"{"ok":true,"output":"\"a\\u0001\\\"\\\\\""}"#
    );
    // `undefined` is `null`; an error's message is a string.
    assert_eq!(
        answer(r#"{"door":"explain","input":{"code":"E9999"}}"#),
        r#"{"ok":true,"output":null}"#
    );
    assert_eq!(
        answer(r#"{"door":"nothing","input":{}}"#),
        r#"{"ok":false,"error":{"kind":"unknown_door","message":"no door is named `nothing`"}}"#
    );
    assert_eq!(
        answer(r#"{"door":"codes","input":{},"x":1}"#),
        r#"{"ok":false,"error":{"kind":"bad_request","message":"the request has a member `x`: a request has only `door` and `input`"}}"#
    );
    assert_eq!(
        answer(r#"{"door":"canonicalize","input":{"value":1.5}}"#),
        r#"{"ok":false,"error":{"kind":"bad_request","message":"the request is not JSON: a number that is not an integer at byte 40"}}"#
    );
}

/// A request of exactly `len` bytes for the door `doors`, its input a long
/// string member that the door refuses: `bad_input` once it is read.
fn padded(len: usize) -> String {
    let head = r#"{"door":"doors","input":{"pad":""#;
    let tail = r#""}}"#;
    let mut out = String::with_capacity(len);
    out.push_str(head);
    out.push_str(&"x".repeat(len - head.len() - tail.len()));
    out.push_str(tail);
    assert_eq!(out.len(), len);
    out
}

#[test]
fn a_request_at_the_limit_is_read_and_one_byte_over_is_not() {
    let at = padded(MAX_REQUEST_BYTES);
    let a = through(&at);
    assert_eq!(kind(&a), "bad_input", "at the limit: {}", a.text());
    let over = padded(MAX_REQUEST_BYTES + 1);
    assert_eq!(
        answer(&over),
        format!(
            r#"{{"ok":false,"error":{{"kind":"too_large","message":"the request is longer than {MAX_REQUEST_BYTES} bytes, the most a request may be"}}}}"#
        )
    );
    // Over the limit it is not read: bytes that are not even UTF-8.
    let garbage = vec![0xff_u8; MAX_REQUEST_BYTES + 1];
    assert_eq!(answer_bytes(&garbage), answer(&over));
    println!("a request of {MAX_REQUEST_BYTES} bytes is read; one of a byte more is too_large");
}

#[test]
fn a_request_as_deep_as_the_limit_is_read_and_one_level_deeper_is_not() {
    // The request is depth 1, the input 2, its `value` 3: the value nests
    // `levels` arrays, the innermost holding a number.
    let deep = |levels: usize| {
        format!(
            r#"{{"door":"canonicalize","input":{{"value":{}0{}}}}}"#,
            "[".repeat(levels),
            "]".repeat(levels)
        )
    };
    // The number is at depth 3 + levels.
    let at = deep(MAX_REQUEST_DEPTH - 3);
    let a = through(&at);
    let Answer::Output(JsValue::String(text)) = &a else {
        panic!("at the limit: {}", a.text());
    };
    assert_eq!(text.len(), 2 * (MAX_REQUEST_DEPTH - 3) + 1);
    let a = through(&deep(MAX_REQUEST_DEPTH - 2));
    assert_eq!(kind(&a), "bad_request", "{}", a.text());
    // Much deeper, still an answer.
    let a = through(&deep(100_000));
    assert_eq!(kind(&a), "bad_request", "{}", a.text());
    println!("a request {MAX_REQUEST_DEPTH} deep is read; one deeper is bad_request");
}
