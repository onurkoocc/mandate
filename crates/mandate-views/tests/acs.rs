//! The ACS target against the TypeScript on inputs written to reach its
//! branches: `tests/data/acs/inputs.json`, and in `tests/data/acs/expected.json`
//! what `scripts/acs-vectors.mjs` has the TypeScript compiler give for them
//! from `acsTarget` (`compiler/src/target/acs.ts`).
//!
//! Each case is run twice, and the two results must be the same text. The
//! result is held as the text `JSON.stringify` writes for the whole target
//! (every manifest, every Rego text, the sandbox requirements, the
//! diagnostics, the profile), through its digest and its length, so that the
//! member order and every character are held; beside it the digests of the
//! parts of each agent, and the lines of the Rego that vary, so that a
//! difference can be read. The first case, `x05-fixbug-locked`, is the program
//! whose Rego the gated part of `compiler/test/acs.test.ts` evaluates on a real
//! OPA: its Implementer's Rego is also held as the whole text, which is the
//! text OPA was given. CI does not run OPA on the Rust's Rego; byte equality
//! with the TypeScript's is what carries that evidence over.
//!
//! The inputs that make the TypeScript throw (a program with no `defs`, an
//! agent with no `caps`, a lock that lists `null`) are cases of their own: the
//! Rust must not panic, and gives what `inputs.json` says it gives (the
//! `known_difference` of the case).
//!
//! The tests report rather than panic where they can: a panic aborts the
//! WebAssembly executable.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::{BTreeMap, BTreeSet};

use mandate_check::{ModuleSource, Modules, load_modules};
use mandate_ir::{JsValue, Value, package_hash, stringify, utf16_len};
use mandate_syntax::{kind_of, load};
use mandate_testkit::{read_json, read_text, sha256};
use mandate_views::{
    ACS_PROFILE, ACS_PROFILE_NOTES, ACS_TARGET_FORMAT, ACS_VERSION, AcsTarget, acs_target,
};

const INPUTS: &str = "crates/mandate-views/tests/data/acs/inputs.json";
const EXPECTED: &str = "crates/mandate-views/tests/data/acs/expected.json";

/// The first 16 hex digits of the SHA-256 of `text`: `digest` of the script.
fn digest(text: &str) -> String {
    sha256(text)
        .trim_start_matches("sha256:")
        .chars()
        .take(16)
        .collect()
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no text member {key}"))
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

// ---- the inputs ------------------------------------------------------------------------------------

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

/// `edited(program, edits)` of the script: a member set (a member that is
/// there keeps its place, a new one comes last, in ECMAScript order) or
/// deleted.
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

/// `programOf(ref)` of the script: a file, loaded, or a value as it is
/// written, then the edits.
fn program_of(r: &Value) -> Value {
    let mut program = match r.get("file").and_then(Value::as_str) {
        Some(file) => load(&read_text(file).unwrap(), kind_of(file))
            .program
            .unwrap_or_else(|| panic!("{file} does not load")),
        None => r.get("raw").unwrap().clone(),
    };
    for e in r.get("edit").and_then(Value::as_array).unwrap_or_default() {
        edit(&mut program, e);
    }
    program
}

/// `modulesOf(files)` of the script.
fn modules_of(files: &[String]) -> Modules {
    let texts: Vec<String> = files.iter().map(|f| read_text(f).unwrap()).collect();
    let sources: Vec<ModuleSource<'_>> = files
        .iter()
        .zip(&texts)
        .map(|(f, t)| ModuleSource {
            text: t,
            kind: kind_of(f),
            file: f,
        })
        .collect();
    let loaded = load_modules(&sources);
    assert!(loaded.problems.is_empty(), "the modules do not load");
    loaded.modules
}

/// The lock of a case: inline (`null` and every other value included), by
/// name in `locks`, or a file; none when the case gives none.
fn lock_of(inputs: &Value, c: &Value) -> Option<Value> {
    if let Some(file) = c.get("lock_file").and_then(Value::as_str) {
        return Some(read_json(file).unwrap());
    }
    if let Some(name) = c.get("lock_ref").and_then(Value::as_str) {
        return Some(inputs.get("locks").unwrap().get(name).unwrap().clone());
    }
    c.get("lock").cloned()
}

/// What the Rust gives for one case: the target, and the text of its object.
struct Run {
    target: AcsTarget,
    whole: String,
}

/// `acsTarget(program, modules, lock)` of a case, twice; the two texts must
/// be the same.
fn run(inputs: &Value, c: &Value) -> Result<Run, String> {
    let program = program_of(c.get("program").unwrap());
    let lock = lock_of(inputs, c);
    let modules = modules_of(&strings(c.get("modules")));
    let first = acs_target(&program, Some(&modules), lock.as_ref());
    let second = acs_target(&program, Some(&modules), lock.as_ref());
    let whole = stringify(&first.to_js()).unwrap_or_default();
    if whole != stringify(&second.to_js()).unwrap_or_default() {
        return Err("two runs give different text".to_owned());
    }
    Ok(Run {
        target: first,
        whole,
    })
}

// ---- what is held ----------------------------------------------------------------------------------

/// The lines of a Rego text that change from agent to agent: `lines` of the script.
fn lines(rego: &str) -> Vec<String> {
    const VARIES: [&str; 10] = [
        "package ",
        "cwd ",
        "read_roots ",
        "write_roots ",
        "commands ",
        "tools ",
        "limits ",
        "models ",
        "max_class ",
        "model_call ",
    ];
    rego.split('\n')
        .filter(|l| VARIES.iter().any(|p| l.starts_with(p)))
        .map(str::to_owned)
        .collect()
}

/// The diagnostics as the script writes them.
fn diagnostic_lines(t: &AcsTarget) -> Vec<String> {
    t.diagnostics
        .iter()
        .map(|d| {
            let path = d.at.path.clone().unwrap_or_default();
            if d.code == "MDT-W0907" {
                let n = d
                    .facts
                    .as_ref()
                    .and_then(|f| f.get("not_carried"))
                    .and_then(JsValue::as_array)
                    .map_or(0, <[JsValue]>::len);
                format!("{} {path} ({n} guarantees)", d.code)
            } else {
                format!("{} {path} {}", d.code, d.message)
            }
        })
        .collect()
}

fn codes(t: &AcsTarget) -> Vec<String> {
    t.diagnostics.iter().map(|d| d.code.clone()).collect()
}

fn agent_names(t: &AcsTarget) -> Vec<String> {
    t.agents.iter().map(|(n, _)| n.clone()).collect()
}

/// The start of a text, for a report.
fn head(text: &str) -> String {
    let start: String = text.chars().take(300).collect();
    format!("{start:?}")
}

fn first_difference(got: &[String], want: &[String]) -> String {
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        if g != w {
            return format!("line {i}: got {g:?}, expected {w:?}");
        }
    }
    format!("got {} lines, expected {}", got.len(), want.len())
}

/// The Rego as the script commits it, the two hashes in it written out.
fn committed_rego(t: &AcsTarget, rego: &str) -> String {
    rego.replace(&t.binding, "BINDING")
        .replace(&t.program, "PROGRAM")
}

/// Everything one case holds, as the problems found; none when the Rust gives
/// what the TypeScript gave.
fn compare(inputs: &Value, c: &Value, want: &Value) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let run = match run(inputs, c) {
        Ok(r) => r,
        Err(e) => return vec![e],
    };
    let t = &run.target;
    // An input the TypeScript throws on: the Rust gives what the case says.
    if let Some(threw) = want.get("threw") {
        let known = c.get("known_difference");
        let Some(known) = known else {
            return vec![format!(
                "the TypeScript threw ({threw:?}) and the case is not a known difference"
            )];
        };
        let rust = known.get("rust").unwrap();
        if agent_names(t) != strings(rust.get("agents")) {
            wrong.push(format!(
                "agents {:?}, the case says {:?}",
                agent_names(t),
                strings(rust.get("agents"))
            ));
        }
        if codes(t) != strings(rust.get("codes")) {
            wrong.push(format!(
                "codes {:?}, the case says {:?}",
                codes(t),
                strings(rust.get("codes"))
            ));
        }
        return wrong;
    }
    if c.get("known_difference").is_some() {
        wrong.push("the case is a known difference and the TypeScript did not throw".to_owned());
    }
    if agent_names(t) != strings(want.get("agents")) {
        wrong.push(format!(
            "agents {:?}, expected {:?}",
            agent_names(t),
            strings(want.get("agents"))
        ));
    }
    if codes(t) != strings(want.get("codes")) {
        wrong.push(format!(
            "codes {:?}, expected {:?}",
            codes(t),
            strings(want.get("codes"))
        ));
    }
    let got = diagnostic_lines(t);
    let wanted = strings(want.get("diagnostics"));
    if got != wanted {
        wrong.push(format!("diagnostics: {}", first_difference(&got, &wanted)));
    }
    let slots = [
        ("program", digest(&t.program)),
        ("binding", digest(&t.binding)),
    ];
    for (slot, got) in slots {
        if want.get(slot).and_then(Value::as_str) != Some(got.as_str()) {
            wrong.push(format!("{slot} gives {got}"));
        }
    }
    let by_agent = want.get("by_agent").and_then(Value::as_object);
    for (name, agent) in &t.agents {
        let Some(w) = by_agent.and_then(|m| m.get(name)) else {
            continue;
        };
        let parts = [
            (
                "manifest",
                digest(&stringify(&agent.manifest).unwrap_or_default()),
            ),
            ("rego", digest(&agent.rego)),
            (
                "requirement",
                digest(&stringify(&JsValue::from(agent.requirement.to_js())).unwrap_or_default()),
            ),
        ];
        for (slot, got) in parts {
            if w.get(slot).and_then(Value::as_str) != Some(got.as_str()) {
                wrong.push(format!("{name}: {slot} gives {got}"));
            }
        }
        if let Some(wanted) = w.get("lines") {
            let got = lines(&agent.rego);
            let wanted = strings(Some(wanted));
            if got != wanted {
                wrong.push(format!("{name}: Rego {}", first_difference(&got, &wanted)));
            }
        }
    }
    if let Some(rego_text) = want.get("rego_text") {
        let name = text(rego_text, "agent");
        match t.agent(name) {
            Some(agent) if committed_rego(t, &agent.rego) == text(rego_text, "text") => {}
            Some(agent) => wrong.push(format!(
                "the Rego of {name} is not the committed text: {}",
                head(&committed_rego(t, &agent.rego))
            )),
            None => wrong.push(format!("no agent {name}")),
        }
    }
    if want.get("whole").and_then(Value::as_str) != Some(digest(&run.whole).as_str()) {
        wrong.push(format!(
            "the whole target gives {}: {}",
            digest(&run.whole),
            head(&run.whole)
        ));
    }
    if want.get("whole_length").and_then(Value::as_i64) != i64::try_from(utf16_len(&run.whole)).ok()
    {
        wrong.push(format!("whole_length {}", utf16_len(&run.whole)));
    }
    wrong
}

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

fn cases(d: &Data) -> &[Value] {
    d.inputs
        .get("cases")
        .and_then(Value::as_array)
        .unwrap_or_default()
}

// ---- the tests -------------------------------------------------------------------------------------

#[test]
fn the_targets_of_the_cases_are_the_typescripts() {
    let d = data();
    let expected = d.expected.get("cases").and_then(Value::as_object).unwrap();
    let mut problems: Vec<String> = Vec::new();
    let mut per_group: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut names: BTreeSet<&str> = BTreeSet::new();
    for c in cases(&d) {
        let name = text(c, "name");
        let group = text(c, "group");
        if !names.insert(name) {
            problems.push(format!("{name}: two cases have this name"));
            continue;
        }
        let Some(want) = expected.get(name) else {
            problems.push(format!(
                "{name}: no expectation (run scripts/acs-vectors.mjs)"
            ));
            continue;
        };
        let wrong = compare(&d.inputs, c, want);
        let entry = per_group.entry(group.to_owned()).or_default();
        entry.0 += 1;
        if !wrong.is_empty() {
            entry.1 += 1;
            problems.push(format!("{name}: {}", wrong.join("; ")));
        }
    }
    for name in expected.keys() {
        if !names.contains(name) {
            problems.push(format!("{name}: an expectation with no input"));
        }
    }
    for (group, (ran, differing)) in &per_group {
        println!("acs {group}: ran {ran}, differing {differing}");
    }
    let ran: usize = per_group.values().map(|g| g.0).sum();
    println!("acs: ran {ran}, differing {}", problems.len());
    assert!(
        problems.is_empty(),
        "{} of {ran} cases differ\n{}",
        problems.len(),
        problems.join("\n")
    );
}

#[test]
fn every_group_has_cases_and_the_opa_case_is_among_them() {
    let d = data();
    let groups: BTreeSet<&str> = cases(&d).iter().map(|c| text(c, "group")).collect();
    for group in [
        "x05",
        "fixtures",
        "branches",
        "locks",
        "numbers",
        "errors",
        "names",
        "order",
        "malformed",
    ] {
        assert!(groups.contains(group), "no case in the group {group}");
    }
    // The first case is the one the gated test evaluates on OPA: its Rego is
    // committed whole.
    let opa: Vec<&Value> = cases(&d)
        .iter()
        .filter(|c| c.get("opa").is_some())
        .collect();
    assert_eq!(opa.len(), 1);
    assert_eq!(text(opa[0], "name"), "x05-fixbug-locked");
    assert_eq!(text(opa[0], "group"), "x05");
    let want = d
        .expected
        .get("cases")
        .and_then(|c| c.get("x05-fixbug-locked"))
        .unwrap();
    assert!(want.get("rego_text").is_some());
}

#[test]
fn the_rego_the_opa_evaluates_is_the_committed_text() {
    let d = data();
    let c = cases(&d)
        .iter()
        .find(|c| text(c, "name") == "x05-fixbug-locked")
        .unwrap();
    let run = run(&d.inputs, c).unwrap();
    let want = d
        .expected
        .get("cases")
        .and_then(|c| c.get("x05-fixbug-locked"))
        .and_then(|w| w.get("rego_text"))
        .unwrap();
    let agent = run.target.agent(text(want, "agent")).unwrap();
    assert_eq!(committed_rego(&run.target, &agent.rego), text(want, "text"));
    // The lines the TypeScript test looks for.
    assert!(
        agent
            .rego
            .contains(&format!("binding := \"{}\"", run.target.binding))
    );
    assert!(agent.rego.contains("write_roots := [\"/work/repo/src\"]"));
    assert!(agent.rego.contains("models := [\"claude-opus-5-5\"]"));
}

/// The assertions of `compiler/test/acs.test.ts`, on the Rust's target.
#[test]
fn the_target_of_fixbug_says_what_the_typescript_test_says() {
    let d = data();
    let c = cases(&d)
        .iter()
        .find(|c| text(c, "name") == "x05-fixbug-locked")
        .unwrap();
    let t = run(&d.inputs, c).unwrap().target;
    let mut names = agent_names(&t);
    names.sort();
    assert_eq!(
        names,
        [
            "Explorer",
            "Implementer",
            "Planner",
            "Reviewer",
            "TestWriter"
        ]
    );
    // The binding is the package hash: the program's hash and the lock without its `lock` member.
    let mut pinned = match lock_of(&d.inputs, c).unwrap() {
        Value::Object(m) => m,
        other => panic!("the lock is {other:?}"),
    };
    pinned.remove("lock");
    assert_eq!(t.binding, package_hash(&t.program, &Value::Object(pinned)));
    let js = t.to_js();
    assert_eq!(
        js.get("format").and_then(JsValue::as_str),
        Some(ACS_TARGET_FORMAT)
    );
    assert_eq!(
        js.get("acs_version").and_then(JsValue::as_str),
        Some(ACS_VERSION)
    );
    let implementer = t.agent("Implementer").unwrap();
    let m = implementer.manifest.clone();
    assert_eq!(
        m.get("agent_control_specification_version")
            .and_then(JsValue::as_str),
        Some("0.4.0-alpha.1")
    );
    let points: BTreeSet<&str> = m
        .get("intervention_points")
        .and_then(JsValue::as_object)
        .unwrap()
        .keys()
        .collect();
    assert_eq!(
        points.into_iter().collect::<Vec<_>>(),
        [
            "agent_shutdown",
            "agent_startup",
            "input",
            "output",
            "post_model_call",
            "post_tool_call",
            "pre_model_call",
            "pre_tool_call"
        ]
    );
    let tools: Vec<&str> = m
        .get("tools")
        .and_then(JsValue::as_object)
        .unwrap()
        .keys()
        .collect();
    assert_eq!(
        tools,
        [
            "read_file",
            "list_dir",
            "grep",
            "write_file",
            "run",
            "finish"
        ]
    );
    assert_eq!(
        stringify(m.get("policies").unwrap()).unwrap(),
        r#"{"mandate":{"type":"rego","bundle":"./Implementer","query":"data.mandate.implementer.verdict"}}"#
    );
    // The reviewer may not write: it gets no write_file tool.
    let reviewer = t.agent("Reviewer").unwrap();
    assert!(
        !reviewer
            .manifest
            .get("tools")
            .and_then(JsValue::as_object)
            .unwrap()
            .keys()
            .any(|k| k == "write_file")
    );
    // W0907, and the profile.
    assert_eq!(codes(&t), ["MDT-W0907"]);
    let level = |g: &str| {
        t.profile
            .iter()
            .find(|r| r.guarantee == g)
            .map(|r| r.level.as_str())
    };
    assert_eq!(level("effects.prepare_authorize_commit"), Some("none"));
    assert_eq!(level("caps.paths_commands"), Some("partial"));
    assert_eq!(level("static.checks"), Some("full"));
}

#[test]
fn an_agent_with_a_budget_in_euros_is_left_out() {
    let d = data();
    let c = cases(&d)
        .iter()
        .find(|c| text(c, "name") == "x05-eur-reader")
        .unwrap();
    let t = run(&d.inputs, c).unwrap().target;
    assert_eq!(codes(&t), ["MDT-E0906"]);
    assert!(t.agents.is_empty());
    assert_eq!(
        stringify(&t.to_js().get("agents").cloned().unwrap()).unwrap(),
        "{}"
    );
}

#[test]
fn the_profile_has_a_note_for_every_guarantee_in_the_same_order() {
    assert_eq!(ACS_PROFILE.len(), ACS_PROFILE_NOTES.len());
    for ((g, _), (n, note)) in ACS_PROFILE.iter().zip(ACS_PROFILE_NOTES.iter()) {
        assert_eq!(g, n);
        assert!(!note.is_empty());
    }
}
