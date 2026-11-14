//! The comparing functions, the patches and the documents against the
//! TypeScript on inputs written to reach their JavaScript:
//! `tests/data/inputs.json`, and in `tests/data/expected.json` what
//! `scripts/views-vectors.mjs` has the TypeScript compiler give for them
//! (`Number(text)`; `toMarkdown` and `toHtml`; `applyOps` and `applyPatch`;
//! `semanticDiff`, `governanceChanges`, `envelopeChanges`, `lockDiff`,
//! `lockLimitsDiff` and `diffDoc`; the steps of every workflow of the
//! repository). Each result is compared as the text the TypeScript writes
//! (`JSON.stringify(value, null, 2)`, the Markdown, the HTML) through its
//! digest, so the member order and every character are held; a mismatch
//! shows the start of what Rust gave.
//!
//! One test for each kind of input, and a gate-style report: every input is
//! run, and the test fails once with every input that differs.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeSet;

use mandate_check::{
    Locks, Modules, PatchOp, apply_ops, apply_patch, envelope_changes, governance_changes,
    js_to_number, lock_diff, lock_limits_diff, semantic_diff,
};
use mandate_ir::{
    JsObject, JsValue, Value, number_to_string, stringify, stringify_pretty, utf16_len,
};
use mandate_syntax::{SourceKind, kind_of, load};
use mandate_testkit::{read_json, read_text, sha256};
use mandate_views::{Block, Cell, Doc, diff_doc, to_html, to_markdown};

const INPUTS: &str = "crates/mandate-views/tests/data/inputs.json";
const EXPECTED: &str = "crates/mandate-views/tests/data/expected.json";

/// The first 16 hex digits of the SHA-256 of `text`: `digest` of the script.
fn digest(text: &str) -> String {
    sha256(text)
        .trim_start_matches("sha256:")
        .chars()
        .take(16)
        .collect()
}

/// `JSON.stringify(v, null, 2)`.
fn pretty(v: &JsValue) -> String {
    stringify_pretty(v).unwrap_or_default()
}

/// The start of a text, for a report.
fn head(text: &str) -> String {
    let start: String = text.chars().take(700).collect();
    format!("{start:?}")
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no text member {key}"))
}

/// What the test reads: the inputs and what the TypeScript gave.
struct Data {
    inputs: Value,
    expected: Value,
}

fn data() -> Data {
    Data {
        inputs: read_json(INPUTS).unwrap(),
        expected: read_json(EXPECTED).unwrap(),
    }
}

/// Fails with every problem found.
fn report(what: &str, ran: usize, problems: Vec<String>) {
    println!("{what}: ran {ran}, differing {}", problems.len());
    assert!(
        problems.is_empty(),
        "{what}: {} of {ran} differ\n{}",
        problems.len(),
        problems.join("\n")
    );
}

// ---- Number ------------------------------------------------------------------------------------------

/// `Object.is(n, -0) ? "-0" : String(n)`.
fn number_text(n: f64) -> String {
    if n == 0.0 && n.is_sign_negative() {
        "-0".to_owned()
    } else {
        number_to_string(n)
    }
}

#[test]
fn number_of_a_string_is_ecmascripts() {
    let d = data();
    let inputs = d.inputs.get("numbers").and_then(Value::as_array).unwrap();
    let expected = d.expected.get("numbers").and_then(Value::as_array).unwrap();
    assert_eq!(inputs.len(), expected.len());
    let mut problems = Vec::new();
    for (s, want) in inputs.iter().zip(expected) {
        let s = s.as_str().unwrap();
        let got = number_text(js_to_number(s));
        if Some(got.as_str()) != want.as_str() {
            problems.push(format!("Number({s:?}): expected {want:?}, got {got:?}"));
        }
    }
    report("numbers", inputs.len(), problems);
}

// ---- documents ---------------------------------------------------------------------------------------

fn cell(v: &Value) -> Cell {
    match v {
        Value::String(s) => Cell::plain(s.as_str()),
        other => Cell::Marked {
            text: text(other, "text").to_owned(),
            untrusted: other.get("untrusted") == Some(&Value::Bool(true)),
            mono: other.get("mono") == Some(&Value::Bool(true)),
        },
    }
}

fn block(v: &Value) -> Block {
    if let Some(h) = v.get("h").and_then(Value::as_str) {
        Block::H(h.to_owned())
    } else if let Some(p) = v.get("p").and_then(Value::as_str) {
        Block::P(p.to_owned())
    } else if let Some(n) = v.get("note").and_then(Value::as_str) {
        Block::Note(n.to_owned())
    } else if let Some(list) = v.get("list").and_then(Value::as_array) {
        Block::List(list.iter().map(cell).collect())
    } else if let Some(t) = v.get("table") {
        Block::Table {
            head: strings(t.get("head")),
            rows: t
                .get("rows")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .map(|r| r.as_array().unwrap().iter().map(cell).collect())
                .collect(),
        }
    } else {
        Block::Code {
            code: text(v, "code").to_owned(),
            lang: v.get("lang").and_then(Value::as_str).map(str::to_owned),
            untrusted: v.get("untrusted") == Some(&Value::Bool(true)),
        }
    }
}

fn doc(v: &Value) -> Doc {
    Doc {
        title: text(v, "title").to_owned(),
        meta: v
            .get("meta")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .map(|m| {
                let m = m.as_array().unwrap();
                (
                    m[0].as_str().unwrap().to_owned(),
                    m[1].as_str().unwrap().to_owned(),
                )
            })
            .collect(),
        blocks: v
            .get("blocks")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .map(block)
            .collect(),
    }
}

#[test]
fn documents_are_the_typescripts() {
    let d = data();
    let inputs = d.inputs.get("docs").and_then(Value::as_array).unwrap();
    let expected = d.expected.get("docs").unwrap();
    let mut problems = Vec::new();
    for input in inputs {
        let name = text(input, "name");
        let doc = doc(input.get("doc").unwrap());
        let want = expected.get(name).unwrap();
        let markdown = to_markdown(&doc);
        if want.get("markdown").and_then(Value::as_str) != Some(markdown.as_str()) {
            problems.push(format!(
                "{name}: the Markdown is {}, expected {:?}",
                head(&markdown),
                want.get("markdown")
            ));
        }
        let html = to_html(&doc);
        if want.get("html_sha256").and_then(Value::as_str) != Some(digest(&html).as_str())
            || want.get("html_length").and_then(Value::as_i64)
                != i64::try_from(utf16_len(&html)).ok()
        {
            problems.push(format!("{name}: the HTML is {}", head(&html)));
        }
    }
    report("documents", inputs.len(), problems);
}

// ---- programs and edits -------------------------------------------------------------------------------

/// The program of a file: `load(text, kindOf(file))`, which must give one.
fn program_of_file(file: &str) -> Value {
    let kind: SourceKind = kind_of(file);
    load(&read_text(file).unwrap(), kind)
        .program
        .unwrap_or_else(|| panic!("{file} does not load"))
}

/// One step into a program: an object member by name, an array element by index.
fn step<'a>(node: &'a mut Value, key: &Value) -> &'a mut Value {
    match (node, key) {
        (Value::Object(m), Value::String(k)) => {
            m.get_mut(k).unwrap_or_else(|| panic!("no member {k}"))
        }
        (Value::Array(a), Value::Number(n)) => a
            .get_mut(usize::try_from(n.get()).unwrap())
            .unwrap_or_else(|| panic!("no element {n}")),
        _ => panic!("cannot step into {key:?}"),
    }
}

/// `edited(program, edits)` of the script: `set` a member (an assignment: a
/// member that is there keeps its place, a new one comes last, in
/// ECMAScript order) or `delete` one.
fn edit(program: &mut Value, e: &Value) {
    let (path, to) = match e.get("set") {
        Some(p) => (p, Some(e.get("to").unwrap().clone())),
        None => (e.get("delete").unwrap(), None),
    };
    let path = path.as_array().unwrap();
    let (last, init) = path.split_last().unwrap();
    let mut node = program;
    for k in init {
        node = step(node, k);
    }
    match (node, last, to) {
        (Value::Object(m), Value::String(k), Some(to)) => {
            m.insert(k.as_str(), to);
        }
        (Value::Object(m), Value::String(k), None) => {
            m.remove(k);
        }
        (Value::Array(a), Value::Number(n), Some(to)) => {
            let i = usize::try_from(n.get()).unwrap();
            if i == a.len() {
                a.push(to);
            } else {
                a[i] = to;
            }
        }
        (Value::Array(a), Value::Number(n), None) => {
            a.remove(usize::try_from(n.get()).unwrap());
        }
        other => panic!("cannot edit {other:?}"),
    }
}

/// `programOf(ref)` of the script.
fn program_of(inputs: &Value, r: &Value) -> Value {
    let mut program = match r.get("file").and_then(Value::as_str) {
        Some(file) => program_of_file(file),
        None => inputs
            .get("programs")
            .and_then(|p| p.get(text(r, "program")))
            .unwrap()
            .clone(),
    };
    for e in r.get("edit").and_then(Value::as_array).unwrap_or_default() {
        edit(&mut program, e);
    }
    program
}

/// `modulesOf(files)` of the script.
fn modules_of(files: &[String]) -> Modules {
    let texts: Vec<String> = files.iter().map(|f| read_text(f).unwrap()).collect();
    let sources: Vec<mandate_check::ModuleSource<'_>> = files
        .iter()
        .zip(&texts)
        .map(|(f, t)| mandate_check::ModuleSource {
            text: t,
            kind: kind_of(f),
            file: f,
        })
        .collect();
    let loaded = mandate_check::load_modules(&sources);
    assert!(loaded.problems.is_empty(), "the modules do not load");
    loaded.modules
}

// ---- patches -------------------------------------------------------------------------------------------

fn diagnostics(ds: &[mandate_ir::Diagnostic]) -> JsValue {
    JsValue::Array(ds.iter().map(mandate_ir::Diagnostic::to_js).collect())
}

/// `programText(x)`: the digest of the program as `JSON.stringify` writes it, or `null`.
fn program_digest(p: Option<&Value>) -> JsValue {
    match p {
        None => JsValue::Null,
        Some(p) => JsValue::from(digest(&stringify(&JsValue::from(p)).unwrap_or_default())),
    }
}

/// The inputs on which the Rust patch is known to differ from the TypeScript,
/// with why. Each is a case of the TypeScript's own behavior on a value that a
/// patch of a program does not have in practice, kept as it is (the port
/// carries behavior, it does not fix); each stays an input, so that the day
/// one is ported the test says so (an input listed here that passes fails the
/// test).
const KNOWN_PATCH_DIFFERENCES: &[(&str, &str)] = &[
    // `parent["__proto__"] = value` on a plain object sets its prototype. The members of that
    // prototype are then seen by the schema validation (Ajv reads `data.kind` and loops with
    // `for in`), as if the object had them: an unknown field is reported at `/x` for a prototype
    // `{ x: 1 }`, and a definition `{}` whose prototype has a `kind` and a `type` passes. Rust adds no
    // member and sets no prototype, so the patch applies and does nothing.
    (
        "proto-add-defs",
        "the prototype of the definitions is seen by the validation",
    ),
    (
        "proto-add-root",
        "the prototype of the program is seen by the validation",
    ),
    (
        "proto-then-add",
        "the prototype of the definitions is seen by the validation",
    ),
    // `path` and `op` that are no strings: the TypeScript throws a TypeError at `path.startsWith`
    // (its message names what it read) and puts the value itself in `at.path`. Rust reads the
    // value as the text a template gives (`undefined`, `5`, `null`, `a`), and the pointer fails to be one.
    (
        "path-missing",
        "the TypeError's message, and `at.path` that is no string",
    ),
    (
        "path-number",
        "the TypeError's message, and `at.path` that is no string",
    ),
    (
        "path-null",
        "the TypeError's message, and `at.path` that is no string",
    ),
    (
        "path-array",
        "the TypeError's message, and `at.path` that is no string",
    ),
];

#[test]
fn patches_are_the_typescripts() {
    let d = data();
    let inputs = d.inputs.get("patches").and_then(Value::as_array).unwrap();
    let expected = d.expected.get("patches").unwrap();
    let mut problems = Vec::new();
    let mut known: usize = 0;
    for p in inputs {
        let name = text(p, "name");
        let program = program_of(&d.inputs, p.get("program").unwrap());
        let base = match text(p, "base") {
            "current" => mandate_ir::hash_program(&program).program,
            "stale" => format!("sha256:{}", "0".repeat(64)),
            other => other.to_owned(),
        };
        let modules_files = strings(p.get("modules"));
        let modules = modules_of(&modules_files);
        let modules = (!modules.is_empty()).then_some(&modules);
        let ops: Vec<PatchOp> = p
            .get("ops")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .map(PatchOp::from_value)
            .collect();
        let applied = apply_ops(&program, &base, &ops);
        let patched = apply_patch(&program, &base, &ops, modules);
        let ops_result = JsObject::new()
            .with("program", program_digest(applied.program.as_ref()))
            .with("diagnostics", diagnostics(&applied.diagnostics));
        let patch_result = JsObject::new()
            .with("ok", patched.ok)
            .with("diagnostics", diagnostics(&patched.diagnostics))
            .with(
                "governance",
                JsValue::Array(
                    patched
                        .governance
                        .iter()
                        .map(mandate_check::GovernanceChange::to_js)
                        .collect(),
                ),
            )
            .with(
                "hash",
                patched.hash.as_deref().map_or(JsValue::Null, JsValue::from),
            )
            .with("program", program_digest(patched.program.as_ref()));
        let want = expected.get(name).unwrap();
        let mut codes: Vec<&str> = Vec::new();
        for d in &patched.diagnostics {
            if !codes.contains(&d.code.as_str()) {
                codes.push(&d.code);
            }
        }
        let want_codes: Vec<String> = strings(want.get("codes"));
        let (ops_text, patch_text) = (
            pretty(&JsValue::Object(ops_result)),
            pretty(&JsValue::Object(patch_result)),
        );
        let mut wrong = Vec::new();
        if want.get("ok") != Some(&Value::Bool(patched.ok)) {
            wrong.push(format!("ok {}", patched.ok));
        }
        if want_codes != codes {
            wrong.push(format!("codes {codes:?} (expected {want_codes:?})"));
        }
        if want.get("governance").and_then(Value::as_i64)
            != i64::try_from(patched.governance.len()).ok()
        {
            wrong.push(format!("{} governance changes", patched.governance.len()));
        }
        if want.get("apply_ops").and_then(Value::as_str) != Some(digest(&ops_text).as_str()) {
            wrong.push(format!("applyOps gives {}", head(&ops_text)));
        }
        if want.get("apply_patch").and_then(Value::as_str) != Some(digest(&patch_text).as_str()) {
            wrong.push(format!("applyPatch gives {}", head(&patch_text)));
        }
        match (
            wrong.is_empty(),
            KNOWN_PATCH_DIFFERENCES.iter().find(|(n, _)| *n == name),
        ) {
            (true, None) => {}
            (false, None) => problems.push(format!("{name}: {}", wrong.join("; "))),
            (false, Some(_)) => known = known.saturating_add(1),
            (true, Some(_)) => problems.push(format!(
                "{name}: passes, but it is listed in KNOWN_PATCH_DIFFERENCES; take it off the list"
            )),
        }
    }
    for (name, _) in KNOWN_PATCH_DIFFERENCES {
        if !inputs.iter().any(|p| text(p, "name") == *name) {
            problems.push(format!(
                "{name}: is listed in KNOWN_PATCH_DIFFERENCES and is no input"
            ));
        }
    }
    println!(
        "patches: {known} of {} known to differ (KNOWN_PATCH_DIFFERENCES)",
        inputs.len()
    );
    report("patches", inputs.len(), problems);
}

// ---- diffs ---------------------------------------------------------------------------------------------

fn changes(cs: &[mandate_check::Change]) -> JsValue {
    JsValue::Array(cs.iter().map(mandate_check::Change::to_js).collect())
}

fn workflows(p: &Value) -> Vec<String> {
    p.get("defs")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|d| d.iter())
        .filter(|(_, d)| d.get("kind").and_then(Value::as_str) == Some("workflow"))
        .map(|(n, _)| n.to_owned())
        .collect()
}

#[test]
fn diffs_are_the_typescripts() {
    let d = data();
    let inputs = d.inputs.get("diffs").and_then(Value::as_array).unwrap();
    let expected = d.expected.get("diffs").unwrap();
    let mut problems = Vec::new();
    for c in inputs {
        let name = text(c, "name");
        let before = program_of(&d.inputs, c.get("before").unwrap());
        let after = program_of(&d.inputs, c.get("after").unwrap());
        let lock = |side: &str| {
            c.get("locks")
                .and_then(|l| l.get(side))
                .filter(|l| !matches!(l, Value::Null))
        };
        let (lb, la) = (lock("before"), lock("after"));
        let locks = (lb.is_some() || la.is_some()).then_some(Locks {
            before: lb,
            after: la,
        });
        let modules = modules_of(&strings(c.get("modules")));
        let modules = (!modules.is_empty()).then_some(&modules);

        let view = semantic_diff(&before, &after, locks);
        let mut both: Vec<String> = workflows(&before)
            .into_iter()
            .filter(|w| workflows(&after).contains(w))
            .collect();
        mandate_ir::sort_utf16(&mut both);
        let governance = governance_changes(&before, &after, modules);
        let mut slots: Vec<(&str, String)> = vec![
            ("diff", pretty(&view.to_js())),
            (
                "governance_changes",
                pretty(&JsValue::Array(
                    governance
                        .iter()
                        .map(mandate_check::KindedChange::to_js)
                        .collect(),
                )),
            ),
            (
                "envelope_changes",
                pretty(&JsValue::Array(
                    both.iter()
                        .map(|w| {
                            JsObject::new()
                                .with("workflow", w.as_str())
                                .with(
                                    "changes",
                                    changes(&envelope_changes(&before, &after, w, modules)),
                                )
                                .into()
                        })
                        .collect(),
                )),
            ),
        ];
        if let Some(locks) = locks {
            slots.push((
                "lock_diff",
                pretty(&changes(&lock_diff(locks.before, locks.after))),
            ));
            let limits = lock_limits_diff(locks.before, locks.after);
            slots.push((
                "lock_limits_diff",
                pretty(
                    &JsObject::new()
                        .with("governance", changes(&limits.governance))
                        .with("behavior", changes(&limits.behavior))
                        .into(),
                ),
            ));
        }
        let doc = diff_doc(&before, &after, locks);
        let markdown = to_markdown(&doc);
        let html = to_html(&doc);

        let want = expected.get(name).unwrap();
        let mut wrong = Vec::new();
        let counts: Vec<i64> = [
            view.governance.len(),
            view.behavior.len(),
            view.unchanged.len(),
            governance.len(),
        ]
        .iter()
        .filter_map(|n| i64::try_from(*n).ok())
        .collect();
        let want_counts: Vec<i64> = want
            .get("counts")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(Value::as_i64)
            .collect();
        if counts != want_counts {
            wrong.push(format!("counts {counts:?} (expected {want_counts:?})"));
        }
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        for (slot, got) in &slots {
            seen.insert(slot);
            if want.get(slot).and_then(Value::as_str) != Some(digest(got).as_str()) {
                wrong.push(format!("{slot} gives {}", head(got)));
            }
        }
        for slot in ["lock_diff", "lock_limits_diff"] {
            if want.get(slot).is_some() && !seen.contains(slot) {
                wrong.push(format!("{slot} is expected"));
            }
        }
        if want.get("markdown").and_then(Value::as_str) != Some(digest(&markdown).as_str()) {
            wrong.push(format!("the Markdown is {}", head(&markdown)));
        }
        if want.get("html").and_then(Value::as_str) != Some(digest(&html).as_str())
            || want.get("html_length").and_then(Value::as_i64)
                != i64::try_from(utf16_len(&html)).ok()
        {
            wrong.push("the HTML differs".to_owned());
        }
        if !wrong.is_empty() {
            problems.push(format!("{name}: {}", wrong.join("; ")));
        }
    }
    report("diffs", inputs.len(), problems);
}

// ---- the steps of every workflow of the repository ---------------------------------------------------

#[test]
fn the_steps_of_every_workflow_are_the_typescripts() {
    let d = data();
    let inputs = d.inputs.get("fixtures").and_then(Value::as_array).unwrap();
    let expected = d.expected.get("fixtures").unwrap();
    let mut problems = Vec::new();
    for f in inputs {
        let file = f.as_str().unwrap();
        let program = program_of_file(file);
        // The program with the body of each of its workflows emptied.
        let mut emptied = program.clone();
        if let Value::Object(root) = &mut emptied
            && let Some(Value::Object(defs)) = root.get_mut("defs")
        {
            for name in workflows(&program) {
                if let Some(Value::Object(def)) = defs.get_mut(&name) {
                    def.insert("body", Value::Array(Vec::new()));
                }
            }
        }
        let removed = semantic_diff(&program, &emptied, None).behavior;
        let added = semantic_diff(&emptied, &program, None).behavior;
        let both = JsObject::new()
            .with("removed", changes(&removed))
            .with("added", changes(&added));
        let got = pretty(&JsValue::Object(both));
        let want = expected.get(file).unwrap();
        let counts = (
            i64::try_from(removed.len()).ok(),
            i64::try_from(added.len()).ok(),
        );
        if want.get("removed").and_then(Value::as_i64) != counts.0
            || want.get("added").and_then(Value::as_i64) != counts.1
            || want.get("sha256").and_then(Value::as_str) != Some(digest(&got).as_str())
        {
            problems.push(format!(
                "{file}: {} removed, {} added: {}",
                removed.len(),
                added.len(),
                head(&got)
            ));
        }
    }
    report("fixtures", inputs.len(), problems);
}

// ---- the graph of a workflow -------------------------------------------------------------------------

#[test]
fn the_graph_of_a_workflow_is_the_typescripts() {
    let d = data();
    let inputs = d.inputs.get("graphs").and_then(Value::as_array).unwrap();
    let expected = d.expected.get("graphs").unwrap();
    let mut problems = Vec::new();
    for g in inputs {
        let name = text(g, "name");
        let value = program_of(&d.inputs, g.get("program").unwrap());
        let program = mandate_ir::Program::of(&value).unwrap();
        // The workflows by name in UTF-16 order, as `architecture` takes them.
        let mut names = workflows(&value);
        mandate_ir::sort_utf16(&mut names);
        let (mut node_count, mut edge_count) = (0_usize, 0_usize);
        let mut list = Vec::new();
        for w in &names {
            let def = program.definition(w).unwrap();
            let mut graph = mandate_check::Graph::new(program, def.value());
            graph.block(def.body(), Vec::new());
            node_count += graph.nodes.len();
            edge_count += graph.edges.len();
            list.push(JsValue::from(
                JsObject::new()
                    .with("workflow", w.as_str())
                    .with(
                        "nodes",
                        JsValue::Array(
                            graph
                                .nodes
                                .iter()
                                .map(mandate_check::ArchNode::to_js)
                                .collect(),
                        ),
                    )
                    .with(
                        "edges",
                        JsValue::Array(
                            graph
                                .edges
                                .iter()
                                .map(mandate_check::ArchEdge::to_js)
                                .collect(),
                        ),
                    ),
            ));
        }
        let got = pretty(&JsValue::Array(list));
        let want = expected.get(name).unwrap();
        let counts = [names.len(), node_count, edge_count].map(|n| i64::try_from(n).ok());
        if [
            want.get("workflows").and_then(Value::as_i64),
            want.get("nodes").and_then(Value::as_i64),
            want.get("edges").and_then(Value::as_i64),
        ] != counts
            || want.get("sha256").and_then(Value::as_str) != Some(digest(&got).as_str())
        {
            problems.push(format!("{name}: {counts:?} {}", head(&got)));
        }
    }
    report("graphs", inputs.len(), problems);
}
