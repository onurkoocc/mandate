//! The system model's checks and the three front doors of `check.ts`
//! (`checkPatch`, `checkSubprogram`, `checkAmendment`, `subprogramLinked`)
//! against the TypeScript, on what no stored result reaches.
//! `scripts/doors-vectors.mjs` has the TypeScript compiler answer the inputs
//! of `crates/mandate-check/tests/doors/inputs.json` and writes the answers
//! to `expected.json` beside it; this test gives the same inputs to the Rust
//! and compares: the codes of each rule and each branch of a rule that has
//! several, the doors' order and shape (what they throw, what they leave
//! out), the locations in the re-written JSON text, and the JavaScript the
//! code depends on (sorting by UTF-16 code units, the white space `trim`
//! takes off, the member order of the objects the doors build).
//!
//! An answer is held as the digest of the text the door's result is written
//! as (a program as its own digest), with the code and path of each
//! diagnostic to read a difference by. An entry that is `held` is one whose
//! TypeScript result holds a diagnostic of a rule the Rust does not give yet
//! (none today): its whole result is kept and Rust's must be it
//! with some diagnostics left out, in order; once the Rust gives the rule,
//! the mark comes off (this test fails an entry that passes whole while marked).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_check::{
    AmendmentInput, CapVal, CheckOptions, DataClass, Modules, PatchOp, Room, SubprogramInput,
    cap_ctor, check, check_amendment, check_patch, check_subprogram, language_of, skeleton,
    subprogram_linked,
};
use mandate_ir::{Diagnostic, JsObject, JsValue, Value, hash_program, stringify, stringify_pretty};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{omission, read_json, read_text, sha256};

const DIR: &str = "crates/mandate-check/tests/doors";

/// The inputs file, whole: its programs, and the sections of inputs.
struct Inputs {
    all: Value,
}

impl Inputs {
    /// A program of the inputs: itself, a name of `programs`, or `{ from, ... }`,
    /// the program `from` names with the other members given in its place.
    fn resolve(&self, p: &Value) -> Value {
        if let Some(name) = p.as_str() {
            return self
                .all
                .get("programs")
                .and_then(|p| p.get(name))
                .unwrap()
                .clone();
        }
        let Some(from) = p.get("from").and_then(Value::as_str) else {
            return p.clone();
        };
        let mut out = self
            .all
            .get("programs")
            .and_then(|p| p.get(from))
            .unwrap()
            .as_object()
            .unwrap()
            .clone();
        for (k, v) in p.as_object().unwrap().iter() {
            if k != "from" {
                out.insert(k, v.clone());
            }
        }
        Value::Object(out)
    }

    /// The text and kind of a program of the inputs.
    fn source(&self, spec: &Value) -> (String, SourceKind) {
        let p = self.resolve(spec);
        if let Some(ir) = p.get("ir") {
            return (
                stringify_pretty(&JsValue::from(ir)).unwrap(),
                SourceKind::Json,
            );
        }
        let mut text = match p.get("file").and_then(Value::as_str) {
            Some(file) => read_text(file).unwrap(),
            None => {
                let lines: Vec<&str> = p
                    .get("mdt")
                    .and_then(Value::as_array)
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                format!("{}\n", lines.join("\n"))
            }
        };
        for pair in p
            .get("replace")
            .and_then(Value::as_array)
            .unwrap_or_default()
        {
            let pair = pair.as_array().unwrap();
            let (from, to) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
            assert!(
                text.contains(from),
                "the text to replace is not there: {from}"
            );
            text = text.replacen(from, to, 1);
        }
        for line in p
            .get("append")
            .and_then(Value::as_array)
            .unwrap_or_default()
        {
            text.push_str(line.as_str().unwrap());
            text.push('\n');
        }
        (text, SourceKind::Mdt)
    }

    /// The text a check is given: the program, or its IR as JSON text once
    /// `edit` has edited it.
    fn check_source(&self, spec: &Value) -> (String, SourceKind) {
        let p = self.resolve(spec);
        if p.get("edit").is_none() {
            return self.source(&p);
        }
        let program = self.program_of(&p);
        (
            stringify_pretty(&JsValue::from(&program)).unwrap(),
            SourceKind::Json,
        )
    }

    /// The program IR as `load` gives it, edited.
    fn program_of(&self, spec: &Value) -> Value {
        let p = self.resolve(spec);
        let (text, kind) = self.source(&p);
        let mut program = load(&text, kind).program.expect("a program that loads");
        for e in p.get("edit").and_then(Value::as_array).unwrap_or_default() {
            edit(&mut program, e);
        }
        program
    }

    /// The modules of an input, by the name it gives each, in order.
    fn modules_of(&self, m: Option<&Value>) -> Option<Modules> {
        let m = m?.as_object()?;
        let mut out = Modules::new();
        for (name, p) in m.iter() {
            out.insert(name, self.program_of(p));
        }
        Some(out)
    }
}

/// One edit: `{ path, value }` sets, `{ path, remove }` deletes. A member that
/// is there keeps its place, a new one comes last, and an element of a list
/// is taken out (`splice`).
fn edit(root: &mut Value, e: &Value) {
    let path = e.get("path").and_then(Value::as_str).unwrap();
    let tokens: Vec<String> = path
        .split('/')
        .skip(1)
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect();
    let (last, init) = tokens.split_last().unwrap();
    let mut node = root;
    for t in init {
        node = match node {
            Value::Array(items) => items.get_mut(t.parse::<usize>().unwrap()).unwrap(),
            Value::Object(m) => m.get_mut(t).unwrap(),
            _ => panic!("no member {t}"),
        };
    }
    let remove = e.get("remove").is_some();
    match node {
        Value::Array(items) => {
            let i = last.parse::<usize>().unwrap();
            if remove {
                items.remove(i);
            } else if i == items.len() {
                items.push(e.get("value").unwrap().clone());
            } else {
                items[i] = e.get("value").unwrap().clone();
            }
        }
        Value::Object(m) => {
            if remove {
                m.remove(last);
            } else {
                m.insert(last.clone(), e.get("value").unwrap().clone());
            }
        }
        _ => panic!("no parent"),
    }
}

/// What a door gave: its result as the text the script digests, or what it
/// threw.
enum Got {
    Text(String),
    Throws(String),
}

/// A result's object with its `program` as the digest of its text.
fn shown(mut o: JsObject) -> String {
    if let Some(JsValue::Object(_)) = o.get("program") {
        let text = stringify(o.get("program").unwrap()).unwrap();
        o.insert("program", sha256(&text));
    }
    stringify(&o.into()).unwrap()
}

/// A result object with its program as the digest of the program's text.
fn with_digest(v: JsValue) -> String {
    match v {
        JsValue::Object(o) => shown(o),
        other => stringify(&other).unwrap(),
    }
}

fn check_result(ok: bool, diagnostics: &[Diagnostic]) -> String {
    stringify(
        &JsObject::new()
            .with("ok", ok)
            .with(
                "diagnostics",
                diagnostics
                    .iter()
                    .map(Diagnostic::to_js)
                    .collect::<Vec<_>>(),
            )
            .into(),
    )
    .unwrap()
}

fn ops_of(v: Option<&Value>) -> Vec<PatchOp> {
    v.and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .map(PatchOp::from_value)
        .collect()
}

/// The operations of a sub-program written as text: one `add` for each
/// definition.
fn defs_ops(parent: &Value, defs: &[Value]) -> Vec<PatchOp> {
    let module = parent.get("module").and_then(Value::as_str).unwrap();
    let lines: Vec<&str> = defs.iter().filter_map(Value::as_str).collect();
    let text = format!(
        "mandate @ 0.4\n\nmodule {module}.plan_1 @ 0.1\n\nuse {module}\n\n{}\n",
        lines.join("\n")
    );
    let program = load(&text, SourceKind::Mdt)
        .program
        .expect("the defs of a sub-program load");
    program
        .get("defs")
        .and_then(Value::as_object)
        .unwrap()
        .iter()
        .map(|(name, value)| PatchOp {
            op: "add".to_owned(),
            path: format!("/defs/{name}"),
            value: Some(value.clone()),
        })
        .collect()
}

fn run_check(inputs: &Inputs, c: &Value) -> Got {
    let (text, kind) = inputs.check_source(c);
    let modules = inputs.modules_of(c.get("modules"));
    let r = check(
        &text,
        kind,
        &CheckOptions {
            lock: None,
            modules: modules.as_ref(),
            claim: c.get("claim"),
        },
    );
    Got::Text(check_result(r.ok, &r.diagnostics))
}

fn run_patch(inputs: &Inputs, c: &Value) -> Got {
    let program = inputs.program_of(c.get("program").unwrap());
    let modules = inputs.modules_of(c.get("modules"));
    let base = match c.get("base").and_then(Value::as_str) {
        Some(b) => b.to_owned(),
        None => hash_program(&program).program,
    };
    let r = check_patch(&program, &base, &ops_of(c.get("ops")), modules.as_ref());
    Got::Text(with_digest(r.to_js()))
}

fn run_subprogram(inputs: &Inputs, c: &Value) -> Got {
    let parent = inputs.program_of(c.get("parent").unwrap());
    let modules = inputs.modules_of(c.get("modules"));
    let number: f64 = match c.get("number") {
        None => 1.0,
        Some(Value::String(s)) => s.parse().unwrap(),
        Some(v) => v.as_i64().unwrap() as f64,
    };
    let module = parent.get("module").and_then(Value::as_str).unwrap();
    let base = match c.get("base").and_then(Value::as_str) {
        Some(b) => b.to_owned(),
        None => hash_program(&skeleton(module, number, language_of(&parent))).program,
    };
    let mut ops = match c.get("defs").and_then(Value::as_array) {
        Some(defs) => defs_ops(&parent, defs),
        None => Vec::new(),
    };
    ops.extend(ops_of(c.get("ops")));
    let lead = c.get("lead").and_then(Value::as_str).unwrap_or("public");
    let room = c.get("room").unwrap();
    let writes: Vec<CapVal> = room
        .get("writes")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .map(|w| {
            let ctor = w.get("ctor").and_then(Value::as_str).unwrap();
            let spec = cap_ctor(ctor).unwrap();
            let mut cap = CapVal::new(ctor, spec.effect, spec.write);
            cap.set_scope(Some(
                w.get("scope")
                    .and_then(Value::as_array)
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            ));
            cap
        })
        .collect();
    let room = Room {
        left: room
            .get("left")
            .and_then(Value::as_object)
            .unwrap()
            .iter()
            .map(|(k, v)| (k.to_owned(), v.as_i64().unwrap() as f64))
            .collect(),
        time_left_ms: room
            .get("time_left_ms")
            .and_then(Value::as_i64)
            .map(|n| n as f64),
        writes,
    };
    match check_subprogram(&SubprogramInput {
        parent: &parent,
        modules: modules.as_ref(),
        workflow: c.get("workflow").and_then(Value::as_str).unwrap(),
        number,
        base: &base,
        ops: &ops,
        lead: DataClass::from_name(lead).unwrap(),
        room: &room,
    }) {
        Ok(r) => Got::Text(with_digest(r.to_js())),
        Err(message) => Got::Throws(format!("Error: {message}")),
    }
}

fn run_amendment(inputs: &Inputs, c: &Value) -> Got {
    let parent = inputs.program_of(c.get("parent").unwrap());
    let modules = inputs.modules_of(c.get("modules"));
    let workflow = c.get("workflow").and_then(Value::as_str).unwrap();
    let edited_envelope = c.get("envelope_edit").map(|edits| {
        let mut envelope = parent
            .get("defs")
            .and_then(|d| d.get(workflow))
            .and_then(|w| w.get("envelope"))
            .unwrap()
            .clone();
        for e in edits.as_array().unwrap() {
            edit(&mut envelope, e);
        }
        envelope
    });
    let envelope = edited_envelope.as_ref().or_else(|| c.get("envelope"));
    match check_amendment(&AmendmentInput {
        parent: &parent,
        modules: modules.as_ref(),
        workflow,
        envelope,
    }) {
        Ok(r) => Got::Text(with_digest(r.to_js())),
        Err(message) => Got::Throws(format!("Error: {message}")),
    }
}

fn run_linked(inputs: &Inputs, c: &Value) -> Got {
    let parent = inputs.program_of(c.get("parent").unwrap());
    let sub = inputs.program_of(c.get("sub").unwrap());
    let modules = inputs.modules_of(c.get("modules"));
    let linked = subprogram_linked(&sub, &parent, modules.as_ref());
    let names = |v: &Value| -> JsValue {
        JsValue::Array(
            v.as_object()
                .unwrap()
                .keys()
                .map(JsValue::from)
                .collect::<Vec<_>>(),
        )
    };
    let result = JsObject::new()
        .with("keys", names(&linked))
        .with("defs", names(linked.get("defs").unwrap()))
        .with("program", JsValue::from(&linked));
    Got::Text(shown(result))
}

/// The diagnostics of a result text, each as its text.
fn diagnostic_texts(text: &str) -> Vec<String> {
    let v = mandate_testkit::parse_json(text.as_bytes()).unwrap();
    v.get("diagnostics")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .map(|d| stringify(&JsValue::from(d)).unwrap())
        .collect()
}

/// One section: each input run and held to its expected answer. Fails with
/// what differs; gives how many answers are whole and how many are held.
fn section(
    inputs: &Inputs,
    expected: &Value,
    name: &str,
    run: fn(&Inputs, &Value) -> Got,
    failures: &mut Vec<String>,
) -> (usize, usize) {
    let list = |v: &Value| {
        v.get(name)
            .and_then(Value::as_array)
            .unwrap_or_default()
            .to_vec()
    };
    let cases = list(&inputs.all);
    let wants = list(expected);
    assert_eq!(
        cases.len(),
        wants.len(),
        "{name}: an answer for every input"
    );
    let (mut whole, mut held) = (0_usize, 0_usize);
    for (c, want) in cases.iter().zip(&wants) {
        let label = c.get("name").and_then(Value::as_str).unwrap();
        assert_eq!(want.get("name").and_then(Value::as_str), Some(label));
        let got = run(inputs, c);
        let marked = c.get("held").is_some();
        let told = want
            .get("told")
            .and_then(Value::as_array)
            .map(|t| {
                t.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        match (&got, want.get("throws").and_then(Value::as_str)) {
            (Got::Throws(g), Some(w)) if g == w => whole += 1,
            (Got::Throws(g), Some(w)) => {
                failures.push(format!(
                    "{name}: {label}: TypeScript throws {w:?}, Rust {g:?}"
                ));
            }
            (Got::Throws(g), None) => {
                failures.push(format!(
                    "{name}: {label}: Rust throws {g:?}, TypeScript gives {told}"
                ));
            }
            (Got::Text(_), Some(w)) => {
                failures.push(format!(
                    "{name}: {label}: TypeScript throws {w:?}, Rust gives a result"
                ));
            }
            (Got::Text(g), None) => {
                let digest = want.get("digest").and_then(Value::as_str).unwrap();
                let whole_text = want.get("result").and_then(Value::as_str);
                if sha256(g) == digest {
                    if marked {
                        failures.push(format!(
                            "{name}: {label}: passes whole, but is marked held; take the mark off"
                        ));
                    }
                    whole += 1;
                } else if let (true, Some(want_text)) = (marked, whole_text) {
                    match held_by_omission(want_text, g) {
                        Ok(()) => held += 1,
                        Err(why) => failures.push(format!("{name}: {label} (held): {why}")),
                    }
                } else {
                    failures.push(format!(
                        "{name}: {label}:\n    TypeScript gives {told}\n    Rust gives       {g}"
                    ));
                }
            }
        }
    }
    (whole, held)
}

/// Rust's result against the TypeScript's whole one: every member but `ok`
/// is the stored one, and the diagnostics are the stored ones with some left
/// out, in order.
fn held_by_omission(want: &str, got: &str) -> Result<(), String> {
    let (w, g) = (
        mandate_testkit::parse_json(want.as_bytes()).unwrap(),
        mandate_testkit::parse_json(got.as_bytes()).unwrap(),
    );
    for (k, v) in w.as_object().unwrap().iter() {
        if matches!(k, "ok" | "diagnostics") {
            continue;
        }
        if g.get(k) != Some(v) {
            return Err(format!("{k} is not the stored one"));
        }
    }
    let (wd, gd) = (diagnostic_texts(want), diagnostic_texts(got));
    omission(&wd, &gd, |a, b| a == b, Clone::clone).map(|_| ())
}

#[test]
fn the_system_model_and_the_front_doors_are_the_typescript_ones() {
    let file = read_json(&format!("{DIR}/inputs.json")).unwrap();
    let expected = read_json(&format!("{DIR}/expected.json")).unwrap();
    let inputs = Inputs { all: file };
    let mut failures = Vec::new();
    let (mut whole, mut held) = (0_usize, 0_usize);
    for (name, run) in [
        ("checks", run_check as fn(&Inputs, &Value) -> Got),
        ("patches", run_patch),
        ("subprograms", run_subprogram),
        ("amendments", run_amendment),
        ("linked", run_linked),
    ] {
        let (w, h) = section(&inputs, &expected, name, run, &mut failures);
        println!("{name}: {w} whole, {h} held");
        whole += w;
        held += h;
    }
    println!("doors: {whole} answers whole, {held} held to the TypeScript's with some left out");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
