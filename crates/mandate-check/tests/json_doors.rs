//! The JSON doors of `mandate-check` (`src/json_doors/`) against the
//! TypeScript compiler, call for call, by the shared tests of
//! `mandate_testkit::json_doors`.
//!
//! `crates/mandate-check/tests/json_doors/` holds three files:
//! `doors.json`, the table of doors as data, which must equal
//! [`mandate_check::json_doors::DOORS`]; `inputs.json`, calls written by hand
//! over the golden programs, the fixtures and their locks (a call may name a
//! file instead of holding its text); and `expected.json`, what the
//! TypeScript function each door stands for gives for each call, as the door
//! contract writes it, which `scripts/json-doors-vectors.mjs` writes. Each
//! call goes through the Rust door, twice, and its output text must be the
//! TypeScript's, or `bad_input` where the TypeScript throws, with one rule:
//! the Rust reads language 0.6, so the `tables` door's `LANGUAGE_VERSIONS`
//! and an E0103 are compared without `mandate/0.6`, and its
//! `LANGUAGE_VERSION` (`mandate/0.6`) as the TypeScript's `mandate/0.5`; the
//! calls that needs are counted (`mandate_testkit::rust_only`). Every door must
//! have a call. Then each door is given inputs that are not what it takes and
//! must answer `bad_input`, never panic; and an optional member that is
//! `null` must be the same as one left out.
//!
//! A second crate with a table of doors copies this file, with its own
//! table, directory and lists.

#![allow(clippy::panic, clippy::expect_used, missing_docs)]

use mandate_check::json_doors::{DOORS, door};
use mandate_testkit::json_doors::{
    Answer, JsonDoor, Rules, check_calls, check_malformed, check_table,
};

const DIR: &str = "crates/mandate-check/tests/json_doors";

/// The table, as the test kit reads it.
fn doors() -> Vec<JsonDoor<'static>> {
    DOORS
        .iter()
        .map(|d| JsonDoor {
            name: d.name,
            ts: d.ts,
            params: d.params,
            note: d.note,
            call: Box::new(move |input| match (d.call)(input) {
                Ok(output) => Answer::Output(output),
                Err(e) => Answer::Refused {
                    kind: e.kind.as_str().to_owned(),
                    message: e.message,
                },
            }),
        })
        .collect()
}

/// What the table does not say of its parameters.
const RULES: Rules<'static> = Rules {
    // The parameters a door may be called without (`null` is the same).
    optional: &[
        ("check", "opts"),
        ("domain_hash", "version"),
        ("link", "modules"),
        ("linked_program", "modules"),
        ("lead_classes", "linked"),
        ("caps_of", "opts"),
        ("caps_of", "within"),
        ("governance_files", "extra"),
        ("skeleton", "language"),
        ("subprogram_linked", "modules"),
        ("subprogram_linked", "std_patterns"),
        ("role_lock_checks", "spans"),
        ("binding_checks", "spans"),
        ("packaged_lock", "lock"),
        ("sandbox_requirements", "modules"),
        ("sandbox_requirements", "lock"),
        ("requirement_for", "opts"),
        ("apply_patch", "modules"),
        ("check_patch", "modules"),
        ("check_patch", "opts"),
        ("semantic_diff", "locks"),
        // The Rust's alone (0.6): the modules an applied pattern comes from.
        ("semantic_diff", "modules"),
        ("semantic_diff", "std_patterns"),
        ("governance_changes", "modules"),
        ("envelope_changes", "modules"),
    ],
    // The parameters whose TypeScript type takes any JSON value.
    any: &[
        ("canonicalize", "value"),
        ("hash_program", "program"),
        ("package_hash", "lock"),
        ("domain_hash", "value"),
        ("references", "d"),
        ("validate_lock", "value"),
        ("packaged_lock", "lock"),
        ("sandbox_requirements", "lock"),
        ("denial_diagnostics", "report"),
    ],
    // Deeper: members of an options object or of a sub-program's input, and
    // the fixed sets of strings.
    refused: &[
        (
            "check",
            r#"{"text":"module m @ 0.1\n","kind":"mdt","opts":{"modules":{"a":1}}}"#,
        ),
        ("check", r#"{"text":"module m @ 0.1\n","kind":"yaml"}"#),
        (
            "skeleton",
            r#"{"parent":"p","n":1,"language":"mandate/9.9"}"#,
        ),
        (
            "requirement_for",
            r#"{"subject":{"agent":"A"},"caps":[],"timeoutMs":null}"#,
        ),
        (
            "requirement_for",
            r#"{"subject":{"agent":"A","def":"d"},"caps":[{"ctor":"exec"}],"timeoutMs":null}"#,
        ),
        (
            "requirement_for",
            r#"{"subject":{"agent":"A","def":"d"},"caps":[],"timeoutMs":"60000"}"#,
        ),
        (
            "check_subprogram",
            r#"{"i":{"parent":{},"workflow":"W","number":1,"base":"b","ops":[1],"lead":"public","room":{"left":{},"writes":[]}}}"#,
        ),
        (
            "check_subprogram",
            r#"{"i":{"parent":{},"workflow":"W","number":1,"base":"b","ops":[],"lead":"secret","room":{"left":{},"writes":[]}}}"#,
        ),
        (
            "role_lock_checks",
            r#"{"program":{},"linked":{"defs":{},"origin":{}},"lock":{},"spans":{"":[1,2]}}"#,
        ),
        ("domain_hash", r#"{"domain":"nothing","value":1}"#),
        // The run-time authority decisions: inside `input`, a member left
        // out, `null` where a member is absent or has a type, and a member
        // of another JSON type, at each level.
        ("grant", r#"{"input":null}"#),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[],"given":[],"handed":[]}}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[],"given":[]},"delegation":null}}"#,
        ),
        ("grant", r#"{"input":{"context":null,"delegation":null}}"#),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[],"given":[{}],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[],"given":[],"handed":[]},"delegation":{"agent":"a","held":[],"remote":null,"own":[]}}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[],"given":[],"handed":[]},"delegation":{"agent":"a","held":[],"remote":1,"own":[]}}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[],"given":[],"handed":[]},"delegation":{"agent":null,"held":[],"remote":false,"own":[]}}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[],"given":[],"handed":[]},"delegation":{"agent":"a","held":[],"remote":false}}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"fs.read","effect":"Fs.Read","write":false,"scope":null}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"fs.read","effect":"Fs.Read","write":null}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"fs.read","effect":"Fs.Read"}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"fs.read","write":false}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"effect":"Fs.Read","write":false}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"model.infer","effect":"Model","write":false,"maxClass":1}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"model.infer","effect":"Model","write":false,"maxClass":null}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"model.infer","effect":"Model","write":false,"tier":null}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"net.https","effect":"Net","write":false,"methods":["GET",1]}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"exec","effect":"Exec","write":false,"argsPrefix":[["ci",null]]}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":[{"ctor":"fs.read","effect":"Fs.Read","write":false,"name":null}],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "grant",
            r#"{"input":{"context":{"bounds":["fs.read"],"given":[],"handed":[]},"delegation":null}}"#,
        ),
        (
            "narrow",
            r#"{"input":{"base":{"ctor":"fs.read","effect":"Fs.Read","write":false},"args":[],"complete":null}}"#,
        ),
        (
            "narrow",
            r#"{"input":{"base":{"ctor":"fs.read","effect":"Fs.Read","write":false},"args":"a","complete":true}}"#,
        ),
        (
            "narrow",
            r#"{"input":{"base":{"ctor":"fs.read","effect":"Fs.Read","write":false,"via":null},"args":[],"complete":true}}"#,
        ),
        (
            "narrow",
            r#"{"input":{"base":null,"args":[],"complete":true}}"#,
        ),
        ("narrow", r#"{"input":{"args":[],"complete":true}}"#),
        (
            "map_scopes",
            r#"{"input":{"map":"/m","par":"2","context":{"bounds":[],"given":[],"handed":[]},"items":[],"complete":true}}"#,
        ),
        (
            "map_scopes",
            r#"{"input":{"map":"/m","par":null,"context":{"bounds":[],"given":[],"handed":[]},"items":[],"complete":true}}"#,
        ),
        (
            "map_scopes",
            r#"{"input":{"map":null,"par":1,"context":{"bounds":[],"given":[],"handed":[]},"items":[],"complete":true}}"#,
        ),
        (
            "map_scopes",
            r#"{"input":{"map":"/m","par":1,"context":{"bounds":[],"given":[],"handed":[]},"items":[null],"complete":true}}"#,
        ),
        (
            "map_scopes",
            r#"{"input":{"map":"/m","par":1,"context":{"bounds":[],"given":[],"handed":[]},"items":[[{"ctor":"fs.write","effect":"Fs.Write","write":true,"components":null}]],"complete":true}}"#,
        ),
        (
            "map_scopes",
            r#"{"input":{"map":"/m","par":1,"context":{"bounds":[],"given":[],"handed":[]},"items":[]}}"#,
        ),
        (
            "in_flight_overlap",
            r#"{"input":{"map":"/m","writes":[],"programs":[{"command":null,"writes":[]}]}}"#,
        ),
        (
            "in_flight_overlap",
            r#"{"input":{"map":"/m","writes":[],"programs":[{"writes":[]}]}}"#,
        ),
        (
            "in_flight_overlap",
            r#"{"input":{"map":"/m","writes":[],"programs":["/p"]}}"#,
        ),
        (
            "in_flight_overlap",
            r#"{"input":{"map":"/m","writes":[[{"ctor":"fs.write","effect":"Fs.Write","write":true,"root":null}]],"programs":[]}}"#,
        ),
        (
            "in_flight_overlap",
            r#"{"input":{"map":"/m","writes":{},"programs":[]}}"#,
        ),
    ],
};

#[test]
fn doors_json_is_the_table() {
    match check_table(DIR, &doors()) {
        Ok(summary) => println!("{summary}"),
        Err(e) => panic!("{e}"),
    }
    for d in DOORS {
        assert!(door(d.name).is_some_and(|f| f.name == d.name));
    }
    assert!(door("no_such_door").is_none());
}

#[test]
fn every_door_answers_as_the_typescript() {
    match check_calls(DIR, &doors()) {
        Ok(summary) => println!("{summary}"),
        Err(e) => panic!("{e}"),
    }
}

/// The inputs on which the Rust is knowingly not the TypeScript (listed in
/// `vectors/README.md`, "What they do not reach"), each with what the Rust
/// gives, the TypeScript's answer beside it: when one gives the TypeScript's
/// answer, it comes off the list, and off this one.
const KNOWN_DIFFERENCES: [(&str, &str, &str, &str); 2] = [
    (
        // A lock that is a string with a character outside the Basic
        // Multilingual Plane: spread by code point here, by UTF-16 code unit
        // in the TypeScript, whose halves a Rust string cannot hold.
        "packaged_lock",
        r#"{"lock":"a😀"}"#,
        "",
        // TypeScript: {"0":"a","1":"\ud83d","2":"\ude00"}
        "{\"0\":\"a\",\"1\":\"\u{1F600}\"}",
    ),
    (
        // A `time.ms` that is not a number, which the schema refuses: the
        // TypeScript carries the value into the requirement.
        "sandbox_requirements",
        r#"{"program":{"$ir":"fixtures/boundary/reach.mdt","$set":[["/defs/Reacher/budget",{"tokens":900000,"time":{"ms":"20m"}}]]}}"#,
        "/Reacher/limits",
        // TypeScript: {"timeout_ms":"20m"}
        "{\"timeout_ms\":null}",
    ),
];

#[test]
fn known_differences_answer_as_written() {
    let doors = doors();
    for (name, input, at, rust) in KNOWN_DIFFERENCES {
        let d = doors.iter().find(|d| d.name == name).expect("a door");
        let input =
            mandate_testkit::json_doors::resolve(&mandate_ir::parse(input).expect("JSON").value)
                .expect("the input");
        let Answer::Output(out) = (d.call)(&input) else {
            panic!("{name}: no output");
        };
        let mut part = &out;
        for t in at.split('/').filter(|t| !t.is_empty()) {
            part = part.get(t).expect("the part");
        }
        assert_eq!(
            mandate_testkit::json_doors::output_text(part),
            rust,
            "{name}"
        );
    }
    println!(
        "json doors: {} known differences, as written",
        KNOWN_DIFFERENCES.len()
    );
}

#[test]
fn malformed_inputs_are_bad_input() {
    match check_malformed(DIR, &doors(), &RULES) {
        Ok(summary) => println!("{summary}"),
        Err(e) => panic!("{e}"),
    }
}
