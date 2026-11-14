//! The ECMAScript behaviour this crate reproduces, against what Node gives:
//! `tests/data/js-semantics.json`, written by `scripts/js-semantics.mjs`
//! (see it for the tagged form of the values). Every mismatch is listed
//! before a test fails.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_ir::{
    Int, JsObject, JsValue, Map, Value, is_integer, is_js_whitespace, is_safe_integer,
    number_to_string, parse, sort_utf16, stringify, stringify_pretty, trim, trim_end, trim_start,
    unique_in_order, utf16_len, write_json_string,
};
use mandate_testkit::read_json;

fn data(key: &str) -> Vec<Value> {
    let file = read_json("crates/mandate-ir/tests/data/js-semantics.json").expect("the data file");
    assert_eq!(
        file.get("format").and_then(Value::as_str),
        Some("mandate-ir/js-semantics/0.1")
    );
    let vectors = file.get(key).and_then(Value::as_array).expect(key).to_vec();
    assert!(!vectors.is_empty(), "no {key} vectors");
    vectors
}

fn s(v: &Value) -> &str {
    v.as_str().expect("a string")
}

fn strings(v: &Value) -> Vec<&str> {
    v.as_array().expect("a list").iter().map(s).collect()
}

fn double(bits: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(s(bits), 16).expect("hex bits"))
}

/// The value of the tagged form.
fn tagged(t: &Value) -> JsValue {
    let Some(tag) = t.as_array() else {
        return match t {
            Value::Null => JsValue::Null,
            Value::Bool(b) => JsValue::Bool(*b),
            other => panic!("not a tagged value: {other:?}"),
        };
    };
    match s(&tag[0]) {
        "u" => JsValue::Undefined,
        "n" => JsValue::Number(double(&tag[1])),
        "s" => JsValue::String(s(&tag[1]).to_owned()),
        "a" => JsValue::Array(tag[1].as_array().unwrap().iter().map(tagged).collect()),
        "o" => {
            let mut o = JsObject::new();
            for kv in tag[1].as_array().unwrap() {
                let kv = kv.as_array().unwrap();
                o.insert(s(&kv[0]), tagged(&kv[1]));
            }
            JsValue::Object(o)
        }
        other => panic!("unknown tag {other}"),
    }
}

fn finish(wrong: &[String], of: usize, what: &str) {
    println!("{what}: {of} vectors");
    assert!(
        wrong.is_empty(),
        "{} of {of} {what} vectors differ from Node:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

#[test]
fn numbers_are_written_and_tested_as_ecmascript_does() {
    let vectors = data("numbers");
    let mut wrong = Vec::new();
    for v in &vectors {
        let v = v.as_array().unwrap();
        let x = double(&v[0]);
        let got = (number_to_string(x), is_integer(x), is_safe_integer(x));
        let want = (
            s(&v[1]).to_owned(),
            v[2] == Value::Bool(true),
            v[3] == Value::Bool(true),
        );
        if got != want {
            wrong.push(format!("{}: expected {want:?}, got {got:?}", s(&v[0])));
        }
    }
    finish(&wrong, vectors.len(), "number");
}

#[test]
fn objects_keep_their_members_in_ecmascript_order() {
    let vectors = data("orders");
    let mut wrong = Vec::new();
    for v in &vectors {
        let v = v.as_array().unwrap();
        let (assigned, want, reparsed) = (strings(&v[0]), strings(&v[1]), strings(&v[2]));
        // Assigned one by one, to an output object and to an IR object.
        let mut js = JsObject::new();
        let mut map = Map::new();
        for (i, k) in assigned.iter().enumerate() {
            js.insert(*k, i);
            map.insert(*k, true);
        }
        let js_keys: Vec<&str> = js.keys().collect();
        let map_keys: Vec<&str> = map.keys().collect();
        // Read from text that has the members in the order first assigned, and built from a list.
        let mut text = String::from("{");
        for (i, k) in unique_in_order(assigned.iter().copied()).iter().enumerate() {
            if i > 0 {
                text.push(',');
            }
            write_json_string(&mut text, k);
            text.push_str(":0");
        }
        text.push('}');
        let read = parse(&text).expect("the text reads").value;
        let read_keys: Vec<&str> = read.as_object().unwrap().keys().collect();
        let entries = unique_in_order(assigned.iter().copied())
            .into_iter()
            .map(|k| (k.to_owned(), Value::Null))
            .collect();
        let built = Map::from_entries(entries).unwrap();
        let built_keys: Vec<&str> = built.keys().collect();
        // Written and read again: JSON.parse(JSON.stringify(o)).
        let again = parse(&stringify(&JsValue::Object(js.clone())).unwrap())
            .unwrap()
            .value;
        let again_keys: Vec<&str> = again.as_object().unwrap().keys().collect();
        for (how, got, want) in [
            ("assigned", &js_keys, &want),
            ("assigned to a Map", &map_keys, &want),
            ("read", &read_keys, &want),
            ("built", &built_keys, &want),
            ("written and read again", &again_keys, &reparsed),
        ] {
            if got != want {
                wrong.push(format!(
                    "{assigned:?} {how}: expected {want:?}, got {got:?}"
                ));
            }
        }
    }
    finish(&wrong, vectors.len(), "key order");
}

#[test]
fn assignments_and_deletes_keep_ecmascript_order_in_large_objects() {
    let vectors = data("edits");
    let mut wrong = Vec::new();
    for v in &vectors {
        let v = v.as_array().unwrap();
        let ops = v[0].as_array().unwrap();
        let want = s(&v[1]);
        let mut js = JsObject::new();
        let mut map = Map::new();
        for (step, op) in ops.iter().enumerate() {
            let op = strings(op);
            if op[0] == "set" {
                js.insert(op[1], step);
                map.insert(op[1], Int::new(i64::try_from(step).unwrap()).unwrap());
            } else {
                js.remove(op[1]);
                map.remove(op[1]);
            }
        }
        let got = stringify(&JsValue::Object(js)).unwrap();
        let want_map = parse(want).unwrap().value;
        if got != want || Value::Object(map) != want_map {
            wrong.push(format!("{} steps: expected {want}, got {got}", ops.len()));
        }
    }
    finish(&wrong, vectors.len(), "edit sequence");
}

#[test]
fn values_are_written_as_json_stringify_and_string_write_them() {
    let vectors = data("stringify");
    let mut wrong = Vec::new();
    for v in &vectors {
        let v = v.as_array().unwrap();
        let value = tagged(&v[0]);
        let want = (v[1].as_str(), v[2].as_str(), s(&v[3]));
        let (compact, pretty) = (stringify(&value), stringify_pretty(&value));
        let got = (compact.as_deref(), pretty.as_deref(), value.to_js_string());
        if (got.0, got.1, got.2.as_str()) != want {
            wrong.push(format!("{:?}: expected {want:?}, got {got:?}", v[0]));
        }
    }
    finish(&wrong, vectors.len(), "JSON.stringify");
}

#[test]
fn white_space_is_ecmascripts() {
    let list = &data("whitespace")[0];
    let want: Vec<u32> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|n| u32::try_from(n.as_i64().unwrap()).unwrap())
        .collect();
    let got: Vec<u32> = (0..=0x10_ffff_u32)
        .filter(|&c| char::from_u32(c).is_some_and(is_js_whitespace))
        .collect();
    assert_eq!(got, want);
    // Not Rust's: U+FEFF is ECMAScript white space, U+0085 is not.
    assert!(is_js_whitespace('\u{feff}') && !'\u{feff}'.is_whitespace());
    assert!(!is_js_whitespace('\u{85}') && '\u{85}'.is_whitespace());

    let vectors = data("trim");
    let mut wrong = Vec::new();
    for v in &vectors {
        let v = v.as_array().unwrap();
        let t = s(&v[0]);
        let got = (trim(t), trim_start(t), trim_end(t), utf16_len(t));
        let want = (
            s(&v[1]),
            s(&v[2]),
            s(&v[3]),
            usize::try_from(v[4].as_i64().unwrap()).unwrap(),
        );
        if got != want {
            wrong.push(format!("{t:?}: expected {want:?}, got {got:?}"));
        }
    }
    finish(&wrong, vectors.len(), "trim");
}

#[test]
fn strings_sort_by_utf16_code_units_and_sets_keep_insertion_order() {
    let vectors = data("sort");
    let mut wrong = Vec::new();
    for v in &vectors {
        let v = v.as_array().unwrap();
        let xs = strings(&v[0]);
        let mut sorted = xs.clone();
        sort_utf16(&mut sorted);
        let unique = unique_in_order(xs.iter().copied());
        if sorted != strings(&v[1]) || unique != strings(&v[2]) {
            wrong.push(format!("{xs:?}: sorted {sorted:?}, unique {unique:?}"));
        }
    }
    finish(&wrong, vectors.len(), "sort");
}
