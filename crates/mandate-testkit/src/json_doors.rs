//! The tests of a crate's table of JSON doors, shared by every crate that
//! has one (`mandate-check` today, `mandate-views` next).
//!
//! A crate with a table keeps three files in `crates/<crate>/tests/json_doors/`:
//!
//! - `doors.json`, `{ format: "mandate/doors/0.1", doors: [{ name, ts,
//!   params, note? }] }`: the table as data, which [`check_table`] holds
//!   equal to the Rust table;
//! - `inputs.json`, `{ calls: [{ name, door, input }] }`: calls written by
//!   hand, whose inputs may name repository files ([`resolve`]);
//! - `expected.json`: what the TypeScript function each door stands for gives
//!   for each call, which `scripts/json-doors-vectors.mjs` writes for every
//!   such directory, and [`check_calls`] holds the doors to.
//!
//! [`check_malformed`] gives each door inputs that are not what it takes and
//! holds its answers to the door contract (`mandate_check::json_doors`).
//!
//! This crate does not depend on the crates whose doors it tests: a test
//! turns its table into [`JsonDoor`]s, and its doors' answers into
//! [`Answer`]s (see `crates/mandate-check/tests/json_doors.rs`, which a
//! second crate copies, changing the table and the lists of [`Rules`]).
//! Every function returns its failures as text and does not panic.

use std::collections::BTreeMap;

use mandate_ir::{Int, JsObject, JsValue, Map, Value, parse, stringify};

use crate::{read_json, read_text, rust_only, sha256};

/// The format of `doors.json`.
pub const DOORS_FORMAT: &str = "mandate/doors/0.1";

/// What a door answered: its output, or its failure.
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    /// The output value.
    Output(JsValue),
    /// The failure: its kind as the bridge names it (`bad_input`) and its
    /// message.
    Refused {
        /// The kind, such as `bad_input`.
        kind: String,
        /// The message.
        message: String,
    },
}

impl Answer {
    /// The answer as text: the output as `JSON.stringify` writes it (`null`
    /// for `undefined`), or the kind and the message of the failure.
    #[must_use]
    pub fn text(&self) -> String {
        match self {
            Answer::Output(v) => output_text(v),
            Answer::Refused { kind, message } => format!("error {kind}: {message}"),
        }
    }

    /// Whether it is a `bad_input` with a message.
    #[must_use]
    pub fn is_bad_input(&self) -> bool {
        matches!(self, Answer::Refused { kind, message } if kind == "bad_input" && !message.is_empty())
    }
}

/// A door's call, as a test gives it.
pub type DoorCall<'a> = Box<dyn Fn(&Value) -> Answer + 'a>;

/// One door of the table under test, as its crate's test describes it.
pub struct JsonDoor<'a> {
    /// Its name.
    pub name: &'a str,
    /// The TypeScript function it stands for, if any.
    pub ts: Option<&'a str>,
    /// Its parameters, in order.
    pub params: &'a [&'a str],
    /// Its note, if any.
    pub note: Option<&'a str>,
    /// The door.
    pub call: DoorCall<'a>,
}

/// What [`check_malformed`] needs to know of a table's parameters, which
/// the table does not say.
#[derive(Clone, Copy, Debug, Default)]
pub struct Rules<'a> {
    /// `(door, parameter)`: the parameters that may be left out (`null` is
    /// then the same as left out).
    pub optional: &'a [(&'a str, &'a str)],
    /// `(door, parameter)`: the parameters that take any JSON value.
    pub any: &'a [(&'a str, &'a str)],
    /// `(door, input as JSON text)`: inputs that must be `bad_input`, for
    /// what lies deeper than the top level (an options object's members, a
    /// fixed set of strings).
    pub refused: &'a [(&'a str, &'a str)],
}

/// The text of an output value: what `JSON.stringify` writes, `null` for
/// `undefined`.
#[must_use]
pub fn output_text(v: &JsValue) -> String {
    stringify(v).unwrap_or_else(|| "null".to_owned())
}

fn read_file(dir: &str, file: &str) -> Result<Value, String> {
    read_json(&format!("{dir}/{file}"))
}

fn list<'v>(v: &'v Value, member: &str, file: &str) -> Result<&'v [Value], String> {
    v.get(member)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{file} has no list `{member}`"))
}

fn text_member<'v>(v: &'v Value, member: &str) -> Result<&'v str, String> {
    v.get(member).and_then(Value::as_str).ok_or_else(|| {
        format!(
            "an entry has no text `{member}`: {}",
            output_text(&JsValue::from(v))
        )
    })
}

// ---------------------------------------------------------------------------
// The references of an input to files (the header of
// scripts/json-doors-vectors.mjs is the authority).

/// The kinds of reference an input may hold.
const REFERENCES: [&str; 5] = ["$text", "$json", "$ir", "$lock", "$hash"];

fn tokens(pointer: &str) -> Result<Vec<String>, String> {
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    let rest = pointer
        .strip_prefix('/')
        .ok_or_else(|| format!("{pointer} is not a JSON Pointer"))?;
    Ok(rest
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect())
}

fn at<'v>(v: &'v Value, pointer: &str) -> Result<&'v Value, String> {
    let mut here = v;
    for t in tokens(pointer)? {
        here = match here {
            Value::Object(m) => m.get(&t),
            Value::Array(a) => t.parse::<usize>().ok().and_then(|i| a.get(i)),
            _ => None,
        }
        .ok_or_else(|| format!("nothing at {pointer}"))?;
    }
    Ok(here)
}

fn put(v: &mut Value, pointer: &str, x: Value) -> Result<(), String> {
    let mut here = v;
    for t in tokens(pointer)? {
        here = match here {
            Value::Object(m) => m.get_mut(&t),
            Value::Array(a) => t.parse::<usize>().ok().and_then(|i| a.get_mut(i)),
            _ => None,
        }
        .ok_or_else(|| format!("nothing at {pointer}"))?;
    }
    *here = x;
    Ok(())
}

/// The file of `vectors/programs/` of the golden program `source`.
fn golden(source: &str) -> Result<Value, String> {
    read_json(&format!(
        "vectors/programs/{}.json",
        source.replace('/', ".")
    ))
}

fn golden_member(source: &str, pointer: &str) -> Result<Value, String> {
    let file = golden(source)?;
    at(&file, pointer).cloned()
}

fn referenced(kind: &str, path: &str) -> Result<Value, String> {
    match kind {
        "$text" => read_text(path).map(Value::String),
        "$json" => read_json(path),
        "$ir" => golden_member(path, "/ir"),
        "$lock" => golden_member(path, "/lock"),
        "$hash" => golden_member(path, "/hashes/program"),
        other => Err(format!("no reference {other}")),
    }
}

/// An input of `inputs.json` with every reference to a file replaced by
/// what it names: `{ "$text": path }` the file's text, `{ "$json": path }`
/// the file read as JSON, `{ "$ir": path }`, `{ "$lock": path }` and
/// `{ "$hash": path }` the IR, the packaged lock and the program hash of a
/// golden program (`vectors/programs/`). A path may end in `#<pointer>`, for
/// the value there, and `"$set": [[pointer, value], ...]` beside the
/// reference puts each value at its pointer, in order.
///
/// # Errors
///
/// A file that cannot be read, a pointer to nothing, or a malformed
/// reference.
pub fn resolve(v: &Value) -> Result<Value, String> {
    match v {
        Value::Array(items) => items
            .iter()
            .map(resolve)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(m) => {
            let refs: Vec<&str> = m.keys().filter(|k| REFERENCES.contains(k)).collect();
            match refs.as_slice() {
                [] => {
                    let mut out = Map::new();
                    for (k, x) in m.iter() {
                        out.insert(k, resolve(x)?);
                    }
                    Ok(Value::Object(out))
                }
                [kind] => {
                    if let Some(other) = m.keys().find(|k| k != kind && *k != "$set") {
                        return Err(format!("a reference has another member, {other}"));
                    }
                    let target = m
                        .get(kind)
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("{kind} is not a path"))?;
                    let (path, pointer) = target.split_once('#').unwrap_or((target, ""));
                    let mut out = at(&referenced(kind, path)?, pointer)?.clone();
                    let sets = m.get("$set").and_then(Value::as_array).unwrap_or_default();
                    for pair in sets {
                        let Some([p, x]) = pair.as_array() else {
                            return Err("an item of $set is not [pointer, value]".to_owned());
                        };
                        let p = p.as_str().ok_or("a pointer of $set is not text")?;
                        put(&mut out, p, resolve(x)?)?;
                    }
                    Ok(out)
                }
                _ => Err("an object has more than one reference".to_owned()),
            }
        }
        other => Ok(other.clone()),
    }
}

// ---------------------------------------------------------------------------

/// `checkSubprogram` as `check_subprogram`.
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

/// Whether `dir/doors.json` is the table `doors`, whole and in order, and
/// the table is well made: every name once, a door named for its TypeScript
/// function (`checkSubprogram` is `check_subprogram`), a note for a door
/// that has none.
///
/// # Errors
///
/// What differs, one line each.
pub fn check_table(dir: &str, doors: &[JsonDoor<'_>]) -> Result<String, String> {
    let file = read_file(dir, "doors.json")?;
    let rows: Vec<JsValue> = doors
        .iter()
        .map(|d| {
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
    let ours: JsValue = JsObject::new()
        .with("format", DOORS_FORMAT)
        .with("doors", rows)
        .into();
    let mut wrong: Vec<String> = Vec::new();
    let (want, got) = (output_text(&JsValue::from(&file)), output_text(&ours));
    if want != got {
        wrong.push(format!(
            "doors.json is not the table: {}",
            difference(&want, &got)
        ));
    }
    let mut seen: Vec<&str> = Vec::new();
    for d in doors {
        if seen.contains(&d.name) {
            wrong.push(format!("{} is in the table twice", d.name));
        }
        seen.push(d.name);
        match d.ts {
            Some(ts) if snake(ts) != d.name => {
                wrong.push(format!("{} is not named for its function {ts}", d.name));
            }
            None if d.note.is_none() => {
                wrong.push(format!("{} has no function and no note", d.name));
            }
            _ => {}
        }
    }
    if wrong.is_empty() {
        Ok(format!("doors.json: {} doors, the table", doors.len()))
    } else {
        Err(wrong.join("\n"))
    }
}

/// Where two texts first differ, with some of each around it.
#[must_use]
pub fn difference(expected: &str, actual: &str) -> String {
    let at = expected
        .char_indices()
        .zip(actual.chars())
        .find(|((_, a), b)| a != b)
        .map_or(expected.len().min(actual.len()), |((i, _), _)| i);
    let window = |s: &str| -> String {
        let start = s.floor_char_boundary(at.saturating_sub(60));
        let end = s.ceil_char_boundary(at.saturating_add(100).min(s.len()));
        s.get(start..end).unwrap_or_default().to_owned()
    };
    format!(
        "first difference at byte {at}\n    expected: …{}…\n    actual:   …{}…",
        window(expected),
        window(actual)
    )
}

/// One call of `inputs.json`: its name, its door and its input, resolved.
struct Call<'v> {
    name: &'v str,
    door: &'v str,
    input: Value,
}

fn calls(inputs: &Value) -> Result<Vec<Call<'_>>, String> {
    list(inputs, "calls", "inputs.json")?
        .iter()
        .map(|c| {
            let name = text_member(c, "name")?;
            let input = c
                .get("input")
                .ok_or_else(|| format!("{name}: no input"))
                .and_then(|i| resolve(i).map_err(|e| format!("{name}: {e}")))?;
            Ok(Call {
                name,
                door: text_member(c, "door")?,
                input,
            })
        })
        .collect()
}

fn find<'d, 'a>(doors: &'d [JsonDoor<'a>], name: &str) -> Option<&'d JsonDoor<'a>> {
    doors.iter().find(|d| d.name == name)
}

/// Every call of `dir/inputs.json` through its door, twice, against
/// `dir/expected.json`: the same output text (its digest, and the text
/// itself where the file keeps it), or `bad_input` where the TypeScript
/// throws; the same answer both times; and a call for every door. An output
/// is compared without the language versions only the Rust reads
/// ([`rust_only`]: an E0103's list of versions, and the `tables` door's
/// `LANGUAGE_VERSIONS` and `LANGUAGE_VERSION`) and without the codes of 0.6
/// in the `codes` door's table ([`rust_only::RUST_CODES`]), and the calls that needs
/// are counted against [`rust_only::PINNED`].
///
/// # Errors
///
/// Each call that differs, and each door with no call, one line each.
pub fn check_calls(dir: &str, doors: &[JsonDoor<'_>]) -> Result<String, String> {
    let inputs = read_file(dir, "inputs.json")?;
    let expected = read_file(dir, "expected.json")?;
    let calls = calls(&inputs)?;
    let answers = list(&expected, "calls", "expected.json")?;
    if calls.len() != answers.len() {
        return Err(format!(
            "expected.json has {} calls and inputs.json {}: run scripts/json-doors-vectors.mjs",
            answers.len(),
            calls.len()
        ));
    }
    let mut wrong: Vec<String> = Vec::new();
    let mut by_door: BTreeMap<&str, usize> = BTreeMap::new();
    // The calls compared by a rule of `rust_only`.
    let mut changed: usize = 0;
    for (call, answer) in calls.iter().zip(answers) {
        let name = call.name;
        if answer.get("name").and_then(Value::as_str) != Some(name) {
            return Err(format!(
                "expected.json is not in the order of inputs.json at {name}: run scripts/json-doors-vectors.mjs"
            ));
        }
        let Some(d) = find(doors, call.door) else {
            wrong.push(format!("{name}: no door {}", call.door));
            continue;
        };
        let count = by_door.entry(d.name).or_default();
        *count = count.saturating_add(1);
        let first = (d.call)(&call.input);
        let second = (d.call)(&call.input);
        if first.text() != second.text() {
            wrong.push(format!("{name}: two calls gave two answers"));
            continue;
        }
        match (answer.get("error").is_some(), &first) {
            (true, a) if a.is_bad_input() => {}
            (true, a) => wrong.push(format!(
                "{name}: the TypeScript throws ({}), the door gives {}",
                answer.get("throws").and_then(Value::as_str).unwrap_or(""),
                a.text()
            )),
            (false, Answer::Refused { .. }) => {
                wrong.push(format!("{name}: the door gives {}", first.text()));
            }
            (false, Answer::Output(v)) => {
                // Compared without the versions only the Rust reads: in an
                // E0103 of any door's output, and in the tables.
                let mut v = v.clone();
                let mut as_typescript = rust_only::js_as_typescript(&mut v);
                if d.name == "tables" {
                    as_typescript |= rust_only::tables_as_typescript(&mut v);
                }
                // And in the table of codes, without the codes of 0.6.
                if d.name == "codes" {
                    as_typescript |= rust_only::codes_as_typescript(&mut v);
                }
                if as_typescript {
                    changed = changed.saturating_add(1);
                }
                let got = output_text(&v);
                let digest = answer.get("sha256").and_then(Value::as_str).unwrap_or("");
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
    for d in doors {
        if !by_door.contains_key(d.name) {
            wrong.push(format!("the door {} has no call", d.name));
        }
    }
    if let Err(e) = rust_only::check_count(&format!("json doors of {dir}"), changed) {
        wrong.push(e);
    }
    if !wrong.is_empty() {
        return Err(format!(
            "{} call(s) differ from the TypeScript:\n{}",
            wrong.len(),
            wrong.join("\n")
        ));
    }
    let counts: Vec<String> = by_door.iter().map(|(d, n)| format!("{d} {n}")).collect();
    Ok(format!(
        "json doors: {} calls over {} doors ({})",
        calls.len(),
        by_door.len(),
        counts.join(", ")
    ))
}

/// A value of another JSON type than `v`.
fn other_type(v: &Value) -> Value {
    match v {
        Value::String(_) => Value::from(Int::saturating(7)),
        _ => Value::String("made-up".to_owned()),
    }
}

fn listed(list: &[(&str, &str)], door: &str, param: &str) -> bool {
    list.iter().any(|(d, p)| *d == door && *p == param)
}

/// Each door given inputs it must refuse, and must answer `bad_input`
/// without panicking: an input that is not an object; a member that is not
/// a parameter; and, from each call of `dir/inputs.json` that succeeds, each
/// required member left out and each member of another JSON type (but those
/// of [`Rules::any`]). An optional member left out must succeed, and `null`
/// must answer as left out. Then each input of [`Rules::refused`].
///
/// # Errors
///
/// Each input not answered as the contract says, one line each.
pub fn check_malformed(
    dir: &str,
    doors: &[JsonDoor<'_>],
    rules: &Rules<'_>,
) -> Result<String, String> {
    let inputs = read_file(dir, "inputs.json")?;
    let calls = calls(&inputs)?;
    let mut wrong: Vec<String> = Vec::new();
    let mut tried: usize = 0;
    let mut attempt = |d: &JsonDoor<'_>, input: &Value| -> Answer {
        tried = tried.saturating_add(1);
        (d.call)(input)
    };
    for d in doors {
        for v in [
            Value::Null,
            Value::Bool(true),
            Value::from(Int::saturating(1)),
            Value::String("made-up".to_owned()),
            Value::Array(Vec::new()),
        ] {
            if !attempt(d, &v).is_bad_input() {
                wrong.push(format!(
                    "{}: an input that is {v:?} is not bad_input",
                    d.name
                ));
            }
        }
        let mut extra = Map::new();
        extra.insert("made_up", Value::Null);
        if !attempt(d, &Value::Object(extra)).is_bad_input() {
            wrong.push(format!(
                "{}: a member that is not a parameter is not bad_input",
                d.name
            ));
        }
        let good: Vec<&Map> = calls
            .iter()
            .filter(|c| c.door == d.name)
            .filter(|c| matches!((d.call)(&c.input), Answer::Output(_)))
            .filter_map(|c| c.input.as_object())
            .collect();
        if good.is_empty() {
            wrong.push(format!("{}: no call that succeeds", d.name));
        }
        for members in good {
            for p in d.params {
                let mut without = members.clone();
                without.remove(p);
                let left_out = attempt(d, &Value::Object(without.clone()));
                if listed(rules.optional, d.name, p) {
                    if !matches!(left_out, Answer::Output(_)) {
                        wrong.push(format!(
                            "{}: without `{p}`, which is optional, it fails",
                            d.name
                        ));
                    }
                    let mut null = without;
                    null.insert(*p, Value::Null);
                    if attempt(d, &Value::Object(null)).text() != left_out.text() {
                        wrong.push(format!("{}: `{p}: null` is not `{p}` left out", d.name));
                    }
                } else if !left_out.is_bad_input() {
                    wrong.push(format!("{}: without `{p}`, not bad_input", d.name));
                }
                let Some(v) = members.get(p) else { continue };
                let mut changed = members.clone();
                changed.insert(*p, other_type(v));
                let r = attempt(d, &Value::Object(changed));
                if !listed(rules.any, d.name, p) && !r.is_bad_input() {
                    wrong.push(format!(
                        "{}: `{p}` of another type is not bad_input",
                        d.name
                    ));
                }
            }
        }
    }
    for (name, input) in rules.refused {
        let Some(d) = find(doors, name) else {
            wrong.push(format!("{name}: no such door"));
            continue;
        };
        let v = match parse(input) {
            Ok(p) => p.value,
            Err(_) => {
                wrong.push(format!("{name}: {input} is not JSON"));
                continue;
            }
        };
        if !attempt(d, &v).is_bad_input() {
            wrong.push(format!("{name}: {input} is not bad_input"));
        }
    }
    if wrong.is_empty() {
        Ok(format!(
            "json doors: {tried} malformed inputs, each answered as the contract says"
        ))
    } else {
        Err(format!(
            "{} input(s) not answered as the contract says:\n{}",
            wrong.len(),
            wrong.join("\n")
        ))
    }
}
