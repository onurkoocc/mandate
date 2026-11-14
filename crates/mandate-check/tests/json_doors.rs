//! The JSON doors of `mandate-check` (`src/json_doors/`) against the
//! TypeScript compiler, call for call.
//!
//! `crates/mandate-check/tests/json_doors/` holds three files:
//! `doors.json`, the table of doors as data, which must equal
//! [`mandate_check::json_doors::DOORS`]; `inputs.json`, calls written by hand
//! over the golden programs, the fixtures and their locks (a call may name a
//! file instead of holding its text: see `scripts/json-doors-vectors.mjs`);
//! and `expected.json`, what the TypeScript function each door stands for
//! gives for each call, as the door contract writes it, which that script
//! writes. Here each call goes through the Rust door, twice, and its output
//! text must be the TypeScript's (its digest, and the text itself when the
//! file keeps it), or `bad_input` where the TypeScript throws. Every door
//! must have a call.
//!
//! Then each door is given inputs that are not what it takes (not an object,
//! a member that is not a parameter, a required member left out, a member of
//! another JSON type) and must answer `bad_input`, never panic; and an
//! optional member that is `null` must be the same as one left out.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeMap;

use mandate_check::json_doors::{DOORS, Door, DoorErrorKind, door};
use mandate_ir::{Int, JsObject, JsValue, Map, Value, stringify};
use mandate_testkit::{read_json, read_text, sha256};

const DIR: &str = "crates/mandate-check/tests/json_doors";

/// The parameters a door may be called without (`null` is the same).
const OPTIONAL: &[(&str, &str)] = &[
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
    ("role_lock_checks", "spans"),
    ("binding_checks", "spans"),
    ("packaged_lock", "lock"),
    ("sandbox_requirements", "modules"),
    ("sandbox_requirements", "lock"),
    ("requirement_for", "opts"),
    ("apply_patch", "modules"),
    ("check_patch", "modules"),
    ("semantic_diff", "locks"),
    ("governance_changes", "modules"),
    ("envelope_changes", "modules"),
];

/// The parameters whose TypeScript type takes any JSON value.
const ANY: &[(&str, &str)] = &[
    ("canonicalize", "value"),
    ("hash_program", "program"),
    ("package_hash", "lock"),
    ("domain_hash", "value"),
    ("references", "d"),
    ("validate_lock", "value"),
    ("packaged_lock", "lock"),
    ("sandbox_requirements", "lock"),
    ("denial_diagnostics", "report"),
];

fn listed(list: &[(&str, &str)], door: &str, param: &str) -> bool {
    list.iter().any(|(d, p)| *d == door && *p == param)
}

fn read(file: &str) -> Value {
    read_json(&format!("{DIR}/{file}")).unwrap()
}

fn text(v: &JsValue) -> String {
    stringify(v).unwrap_or_else(|| "null".to_owned())
}

// ---------------------------------------------------------------------------
// The references of inputs.json to files (scripts/json-doors-vectors.mjs).

fn tokens(pointer: &str) -> Vec<String> {
    if pointer.is_empty() {
        return Vec::new();
    }
    pointer[1..]
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect()
}

fn at<'a>(v: &'a Value, pointer: &str) -> &'a Value {
    let mut at = v;
    for t in tokens(pointer) {
        at = match at {
            Value::Object(m) => m.get(&t),
            Value::Array(a) => t.parse::<usize>().ok().and_then(|i| a.get(i)),
            _ => None,
        }
        .unwrap_or_else(|| panic!("nothing at {pointer}"));
    }
    at
}

fn put(v: &mut Value, pointer: &str, x: Value) {
    let mut at = v;
    for t in tokens(pointer) {
        at = match at {
            Value::Object(m) => m.get_mut(&t),
            Value::Array(a) => t.parse::<usize>().ok().and_then(|i| a.get_mut(i)),
            _ => None,
        }
        .unwrap_or_else(|| panic!("nothing at {pointer}"));
    }
    *at = x;
}

fn golden(source: &str) -> Value {
    read_json(&format!(
        "vectors/programs/{}.json",
        source.replace('/', ".")
    ))
    .unwrap()
}

fn referenced(kind: &str, path: &str) -> Value {
    match kind {
        "$text" => Value::String(read_text(path).unwrap()),
        "$json" => read_json(path).unwrap(),
        "$ir" => golden(path).get("ir").unwrap().clone(),
        "$lock" => golden(path).get("lock").unwrap().clone(),
        "$hash" => golden(path)
            .get("hashes")
            .and_then(|h| h.get("program"))
            .unwrap()
            .clone(),
        _ => unreachable!(),
    }
}

fn resolve(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(items.iter().map(resolve).collect()),
        Value::Object(m) => {
            let refs: Vec<&str> = m
                .keys()
                .filter(|k| ["$text", "$json", "$ir", "$lock", "$hash"].contains(k))
                .collect();
            match refs.as_slice() {
                [] => Value::Object(m.iter().map(|(k, x)| (k, resolve(x))).collect::<Map>()),
                [kind] => {
                    let target = m.get(kind).and_then(Value::as_str).unwrap();
                    let (path, pointer) = target.split_once('#').unwrap_or((target, ""));
                    let mut out = at(&referenced(kind, path), pointer).clone();
                    for pair in m.get("$set").and_then(Value::as_array).unwrap_or_default() {
                        let pair = pair.as_array().unwrap();
                        put(&mut out, pair[0].as_str().unwrap(), resolve(&pair[1]));
                    }
                    out
                }
                _ => panic!("more than one reference"),
            }
        }
        other => other.clone(),
    }
}

// ---------------------------------------------------------------------------

fn snake(ts: &str) -> String {
    let mut out = String::new();
    for c in ts.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

#[test]
fn doors_json_is_the_table() {
    let file = read("doors.json");
    let rows: Vec<JsValue> = DOORS
        .iter()
        .map(|d: &Door| {
            JsObject::new()
                .with("name", d.name)
                .with("ts", d.ts.map_or(JsValue::Null, JsValue::from))
                .with(
                    "params",
                    JsValue::Array(d.params.iter().map(|p| JsValue::from(*p)).collect()),
                )
                .with_some("note", d.note)
                .into()
        })
        .collect();
    let ours = JsObject::new()
        .with("format", "mandate/doors/0.1")
        .with("doors", rows);
    assert_eq!(
        text(&JsValue::from(&file)),
        text(&ours.into()),
        "doors.json is not the table DOORS"
    );
    let mut seen = Vec::new();
    for d in DOORS {
        assert!(!seen.contains(&d.name), "{} is in the table twice", d.name);
        seen.push(d.name);
        assert!(door(d.name).is_some_and(|f| f.name == d.name));
        match d.ts {
            Some(ts) => assert_eq!(snake(ts), d.name, "a door is named for its function"),
            None => assert!(d.note.is_some(), "{} has no function and no note", d.name),
        }
    }
    assert!(door("no_such_door").is_none());
    println!("doors.json: {} doors, the table", DOORS.len());
}

/// Where two texts first differ, with some of each around it.
fn difference(expected: &str, actual: &str) -> String {
    let at = expected
        .char_indices()
        .zip(actual.chars())
        .find(|((_, a), b)| a != b)
        .map_or(expected.len().min(actual.len()), |((i, _), _)| i);
    let window = |s: &str| -> String {
        let start = s.floor_char_boundary(at.saturating_sub(60));
        let end = s.ceil_char_boundary((at + 100).min(s.len()));
        s[start..end].to_owned()
    };
    format!(
        "first difference at byte {at}\n    expected: …{}…\n    actual:   …{}…",
        window(expected),
        window(actual)
    )
}

#[test]
fn every_door_answers_as_the_typescript() {
    let inputs = read("inputs.json");
    let expected = read("expected.json");
    let calls = inputs.get("calls").and_then(Value::as_array).unwrap();
    let answers = expected.get("calls").and_then(Value::as_array).unwrap();
    assert_eq!(
        calls.len(),
        answers.len(),
        "expected.json has another number of calls than inputs.json: run scripts/json-doors-vectors.mjs"
    );
    let mut wrong: Vec<String> = Vec::new();
    let mut by_door: BTreeMap<&str, usize> = BTreeMap::new();
    for (call, answer) in calls.iter().zip(answers) {
        let name = call.get("name").and_then(Value::as_str).unwrap();
        let door_name = call.get("door").and_then(Value::as_str).unwrap();
        assert_eq!(
            Some(name),
            answer.get("name").and_then(Value::as_str),
            "expected.json is not in the order of inputs.json: run scripts/json-doors-vectors.mjs"
        );
        let Some(d) = door(door_name) else {
            wrong.push(format!("{name}: no door {door_name}"));
            continue;
        };
        *by_door.entry(d.name).or_default() += 1;
        let input = resolve(call.get("input").unwrap());
        let first = (d.call)(&input);
        let second = (d.call)(&input);
        let shown = |r: &Result<JsValue, mandate_check::json_doors::DoorError>| match r {
            Ok(v) => text(v),
            Err(e) => format!("error {}: {}", e.kind.as_str(), e.message),
        };
        if shown(&first) != shown(&second) {
            wrong.push(format!("{name}: two calls gave two answers"));
            continue;
        }
        match (answer.get("error"), first) {
            (Some(_), Err(e)) if e.kind == DoorErrorKind::BadInput => {}
            (Some(_), other) => wrong.push(format!(
                "{name}: the TypeScript throws ({}), the door gives {}",
                answer.get("throws").and_then(Value::as_str).unwrap_or(""),
                shown(&other)
            )),
            (None, Err(e)) => wrong.push(format!(
                "{name}: the door gives {} {}",
                e.kind.as_str(),
                e.message
            )),
            (None, Ok(v)) => {
                let got = text(&v);
                let digest = answer.get("sha256").and_then(Value::as_str).unwrap();
                if let Some(want) = answer.get("output").and_then(Value::as_str) {
                    if want != got {
                        wrong.push(format!("{name}: {}", difference(want, &got)));
                    }
                } else if sha256(&got) != digest {
                    wrong.push(format!(
                        "{name}: expected {digest}, got {}; the text begins {}",
                        sha256(&got),
                        got.chars().take(300).collect::<String>()
                    ));
                }
            }
        }
    }
    for d in DOORS {
        if !by_door.contains_key(d.name) {
            wrong.push(format!("the door {} has no call", d.name));
        }
    }
    let counts: Vec<String> = by_door.iter().map(|(d, n)| format!("{d} {n}")).collect();
    println!(
        "json doors: {} calls over {} doors ({})",
        calls.len(),
        by_door.len(),
        counts.join(", ")
    );
    assert!(
        wrong.is_empty(),
        "{} call(s) differ from the TypeScript:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

/// A value of another JSON type than `v`.
fn other_type(v: &Value) -> Value {
    match v {
        Value::String(_) => Value::Number(Int::new(7).unwrap()),
        _ => Value::String("made-up".to_owned()),
    }
}

fn is_bad_input(r: &Result<JsValue, mandate_check::json_doors::DoorError>) -> bool {
    matches!(r, Err(e) if e.kind == DoorErrorKind::BadInput && !e.message.is_empty())
}

#[test]
fn malformed_inputs_are_bad_input() {
    let inputs = read("inputs.json");
    let calls = inputs.get("calls").and_then(Value::as_array).unwrap();
    let mut wrong: Vec<String> = Vec::new();
    let mut tried: usize = 0;
    for d in DOORS {
        // Not an object.
        for v in [
            Value::Null,
            Value::Bool(true),
            Value::Number(Int::new(1).unwrap()),
            Value::String("made-up".to_owned()),
            Value::Array(vec![]),
        ] {
            tried += 1;
            if !is_bad_input(&(d.call)(&v)) {
                wrong.push(format!(
                    "{}: an input that is {v:?} is not bad_input",
                    d.name
                ));
            }
        }
        // A member that is not a parameter.
        let mut extra = Map::new();
        extra.insert("made_up", Value::Null);
        tried += 1;
        if !is_bad_input(&(d.call)(&Value::Object(extra))) {
            wrong.push(format!("{}: a member that is not a parameter", d.name));
        }
        // From each call that succeeds: each member left out, of another
        // type, and `null` for an optional one.
        let good: Vec<Value> = calls
            .iter()
            .filter(|c| c.get("door").and_then(Value::as_str) == Some(d.name))
            .map(|c| resolve(c.get("input").unwrap()))
            .filter(|i| (d.call)(i).is_ok())
            .collect();
        if good.is_empty() {
            wrong.push(format!("{}: no call that succeeds", d.name));
        }
        for input in &good {
            let members = input.as_object().unwrap();
            for p in d.params {
                let optional = listed(OPTIONAL, d.name, p);
                let mut without = members.clone();
                without.remove(p);
                let left_out = (d.call)(&Value::Object(without.clone()));
                tried += 1;
                if optional {
                    if left_out.is_err() {
                        wrong.push(format!(
                            "{}: without `{p}`, which is optional, fails",
                            d.name
                        ));
                    }
                    let mut null = without.clone();
                    null.insert(*p, Value::Null);
                    tried += 1;
                    let with_null = (d.call)(&Value::Object(null));
                    if with_null.as_ref().ok().map(text) != left_out.as_ref().ok().map(text) {
                        wrong.push(format!("{}: `{p}: null` is not `{p}` left out", d.name));
                    }
                } else if !is_bad_input(&left_out) {
                    wrong.push(format!("{}: without `{p}`, not bad_input", d.name));
                }
                let Some(v) = members.get(p) else { continue };
                let mut changed = members.clone();
                changed.insert(*p, other_type(v));
                tried += 1;
                let r = (d.call)(&Value::Object(changed));
                if !listed(ANY, d.name, p) && !is_bad_input(&r) {
                    wrong.push(format!(
                        "{}: `{p}` of another type is not bad_input",
                        d.name
                    ));
                }
            }
        }
    }
    // Deeper: members of an options object or of a sub-program's input.
    let nested: [(&str, &str); 8] = [
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
    ];
    for (name, input) in nested {
        let d = door(name).unwrap();
        let v = mandate_ir::parse(input).unwrap().value;
        tried += 1;
        if !is_bad_input(&(d.call)(&v)) {
            wrong.push(format!("{name}: {input} is not bad_input"));
        }
    }
    println!("json doors: {tried} malformed inputs, each bad_input or as the contract says");
    assert!(
        wrong.is_empty(),
        "{} input(s) not answered as the contract says:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}
