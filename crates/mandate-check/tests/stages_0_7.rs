//! The stages of a program of 0.7 (spec/attention.md "`stage`", "Titles")
//! where a conformance case cannot say it: the messages and facts of E1901
//! and E1902, every place a stage may not stand, the stages of an expanded
//! workflow, a pattern of a module whose stages break the rules (reported
//! at the application), and that a stage counts as no node. No TypeScript
//! reads 0.7, so every expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{CheckOptions, CheckResult, Modules, check, workflow_nodes};
use mandate_ir::{JsValue, Program, Value, canonicalize};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::read_text;

const STAGES: &str = "fixtures/attention/stages.mdt";

fn checked(text: &str, modules: Option<&Modules>) -> CheckResult {
    check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            modules,
            ..CheckOptions::default()
        },
    )
}

/// `code at path: message` of each diagnostic but W0601 and W0310.
fn shown(r: &CheckResult) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d.code != "MDT-W0601" && d.code != "MDT-W0310")
        .map(|d| {
            format!(
                "{} at {}: {}",
                d.code,
                d.at.path.as_deref().unwrap_or(""),
                d.message
            )
        })
        .collect()
}

/// The facts of the `i`-th diagnostic, as JSON.
fn facts(r: &CheckResult, i: usize) -> String {
    let f = r.diagnostics[i].facts.clone().unwrap_or_default();
    mandate_ir::stringify(&JsValue::Object(f)).unwrap_or_default()
}

/// A program of 0.7 with a role, a capability, an agent and `defs`.
fn program(defs: &str) -> String {
    format!(
        "mandate @ 0.7\n\nmodule example.stages @ 0.1\n\nuse std.{{model}}\n\ncapability ModelStd = model.infer(tier: standard, max_class: internal)\n\nagent Greeter {{\n  role   \"Writes one line of greeting.\"\n  caps   ModelStd\n  budget {{ time: 2m, steps: 2 }}\n  skill greet(name: Text) -> Inferred<Text> ! {{Model}}\n}}\n\n{defs}\n"
    )
}

/// A workflow `W` whose body is `body`.
fn workflow(body: &str) -> String {
    program(&format!(
        "workflow W(name: Text) -> Inferred<Text>\n  caps   ModelStd\n  budget {{ time: 5m, steps: 4 }}\n{{\n{body}\n}}"
    ))
}

#[test]
fn the_fixture_checks_and_its_expansion_has_the_patterns_stages() {
    let text = read_text(STAGES).unwrap();
    let r = checked(&text, None);
    assert!(r.ok, "{:?}", shown(&r));
    assert_eq!(shown(&r), Vec::<String>::new());
    // The expansion of MatchAll: the pattern's body, its four stages where
    // the pattern has them, copied as written.
    let expanded = r.expanded.expect("an expansion");
    let body = expanded
        .get("defs")
        .and_then(|d| d.get("MatchAll"))
        .and_then(|w| w.get("body"))
        .and_then(Value::as_array)
        .unwrap();
    let stages: Vec<(usize, String)> = body
        .iter()
        .enumerate()
        .filter(|(_, s)| s.get("op").and_then(Value::as_str) == Some("stage"))
        .map(|(i, s)| (i, canonicalize(s)))
        .collect();
    assert_eq!(
        stages,
        [
            (
                0,
                r#"{"name":"collect","op":"stage","title":"Collect the items"}"#.to_owned()
            ),
            (
                2,
                r#"{"name":"work","op":"stage","title":"Work on each item and check it"}"#
                    .to_owned()
            ),
            (
                4,
                r#"{"name":"review","op":"stage","title":"Ask once about what failed"}"#.to_owned()
            ),
            (
                6,
                r#"{"name":"post","op":"stage","title":"Post what was accepted"}"#.to_owned()
            ),
        ]
    );
    assert_eq!(body.len(), 9);
}

/// The program with every statement whose `op` is `stage` taken out.
fn without_stages(v: &Value) -> Value {
    match v {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .filter(|x| x.get("op").and_then(Value::as_str) != Some("stage"))
                .map(without_stages)
                .collect(),
        ),
        Value::Object(m) => {
            let mut out = mandate_ir::Map::new();
            for (k, x) in m.iter() {
                out.insert(k, without_stages(x));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

#[test]
fn a_stage_counts_as_no_node() {
    let text = read_text(STAGES).unwrap();
    let r = checked(&text, None);
    let expanded = r.expanded.expect("an expansion");
    let bare = without_stages(&expanded);
    let nodes = |v: &Value| workflow_nodes(Program::of(v).unwrap(), None);
    let with = nodes(&expanded);
    assert_eq!(with, nodes(&bare));
    // Greet: a let, its delegation, an expression; MatchAll: the pattern's
    // five statements, its two maps, and in their bodies the delegation,
    // the verification and the effect. No stage among them.
    assert_eq!(
        with,
        [("Greet".to_owned(), 3.0), ("MatchAll".to_owned(), 10.0)]
    );
}

#[test]
fn the_rules_of_a_list_of_stages_and_their_messages() {
    let r = checked(
        &workflow(
            "  let early = 1\n  stage draft \"Write the greeting\"\n  let line = delegate Greeter.greet(name)\n  stage draft \"Again\"\n  stage give \"Give\\tit back\"\n  on error(e) => line\n  line\n  stage end \"The end \u{200F}\"",
        ),
        None,
    );
    assert_eq!(
        shown(&r),
        [
            "MDT-E1902 at /defs/W/body/0: The body of workflow W has stages and does not start with one: the statements before stage 'draft' are in no stage. A body with stages starts with one.",
            "MDT-E1902 at /defs/W/body/3/name: Stage 'draft' is named twice in the body of workflow W; the stages of one body have names of their own.",
            "MDT-E1902 at /defs/W/body/3: Stage 'draft' of workflow W is directly followed by another stage and marks no statement; each stage is followed by at least one.",
            "MDT-E1902 at /defs/W/body/4: Stage 'give' of workflow W is directly followed by an on error, which handles the statement before the stage; a stage stands before the statement whose handler follows it.",
            "MDT-E1902 at /defs/W/body/4/title: The title of stage 'give' of workflow W holds the control character U+0009; a title is constant text of 1 to 80 characters with no control, format or bidirectional character, since a person reads it on an approval card.",
            "MDT-E1902 at /defs/W/body/7: Stage 'end' ends the body of workflow W and marks no statement; each stage is followed by at least one.",
            "MDT-E1902 at /defs/W/body/7/title: The title of stage 'end' of workflow W holds the format or bidirectional character U+200F; a title is constant text of 1 to 80 characters with no control, format or bidirectional character, since a person reads it on an approval card.",
        ]
    );
    assert_eq!(
        facts(&r, 0),
        r#"{"workflow":"W","stage":"draft","problem":"before_first"}"#
    );
    assert_eq!(
        facts(&r, 1),
        r#"{"workflow":"W","stage":"draft","problem":"duplicate"}"#
    );
    assert_eq!(
        facts(&r, 2),
        r#"{"workflow":"W","stage":"draft","problem":"empty"}"#
    );
    assert_eq!(
        facts(&r, 3),
        r#"{"workflow":"W","stage":"give","problem":"on_error"}"#
    );
    assert_eq!(
        facts(&r, 4),
        r#"{"workflow":"W","stage":"give","problem":"title","rule":"control","char":"U+0009"}"#
    );
    assert_eq!(
        facts(&r, 6),
        r#"{"workflow":"W","stage":"end","problem":"title","rule":"format","char":"U+200F"}"#
    );
    // Each diagnostic has the span of its statement, or of the member.
    assert!(r.diagnostics.iter().all(|d| d.at.span.is_some()));
    assert!(!r.ok);
}

#[test]
fn a_stage_anywhere_else_is_out_of_place() {
    let text = program(
        "fn near(a: Int) -> Int\n{\n  stage one \"In a function\"\n  a\n}\n\nworkflow W(name: Text) -> Inferred<Text>\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }\n{\n  stage draft \"Write\"\n  let line = delegate Greeter.greet(name)\n  if near(1) > 0 {\n    stage three \"In a branch\"\n    line\n  }\n  let xs = map n in [1, 2] max 2 {\n    stage four \"In a map's body\"\n    n\n  }\n  loop max_iter 2 {\n    stage five \"In a loop\"\n    1\n  }\n  line\n}\n\ntest \"t\" {\n  stage six \"In a test\"\n  run W(name: \"Ana\") expect ok\n}",
    );
    let r = checked(&text, None);
    let e1901: Vec<String> = shown(&r)
        .into_iter()
        .filter(|l| l.starts_with("MDT-E1901"))
        .collect();
    assert_eq!(
        e1901,
        [
            "MDT-E1901 at /defs/near/body/0: Stage 'one' stands in fn near; a stage marks only the top level of a workflow's or a pattern's body.",
            "MDT-E1901 at /defs/W/body/2/then/0: Stage 'three' stands inside a statement or a member of workflow W, not at the top level of its body; a stage marks only the top level of a workflow's or a pattern's body.",
            "MDT-E1901 at /defs/W/body/3/value/body/0: Stage 'four' stands inside a statement or a member of workflow W, not at the top level of its body; a stage marks only the top level of a workflow's or a pattern's body.",
            "MDT-E1901 at /defs/W/body/4/body/0: Stage 'five' stands inside a statement or a member of workflow W, not at the top level of its body; a stage marks only the top level of a workflow's or a pattern's body.",
            "MDT-E1901 at /tests/t/body/0: Stage 'six' stands in test \"t\"; a stage marks only the top level of a workflow's or a pattern's body.",
        ]
    );
    let places: Vec<String> = r
        .diagnostics
        .iter()
        .filter(|d| d.code == "MDT-E1901")
        .map(|d| {
            let f = d.facts.as_ref().unwrap();
            format!(
                "{}:{}",
                f.get("stage").and_then(JsValue::as_str).unwrap(),
                f.get("place").and_then(JsValue::as_str).unwrap()
            )
        })
        .collect();
    assert_eq!(
        places,
        [
            "one:fn",
            "three:nested",
            "four:nested",
            "five:nested",
            "six:test"
        ]
    );
}

/// A module of 0.7 with a pattern whose stages break the rules: two of one
/// name.
fn flows_text() -> String {
    "mandate @ 0.7\n\nmodule example.flows @ 0.1\n\nuse std.{model}\n\npub pattern Greeting(work: skill(Text) -> Inferred<Text>)(name: Text) -> Inferred<Text>\n{\n  stage draft \"Write the greeting\"\n  let line = delegate work(name)\n  stage draft \"Give it back\"\n  line\n}\n".to_owned()
}

/// [`flows_text`], given to the check as it is (a module is not checked by
/// the check it is given to).
fn flows_module() -> Modules {
    let text = flows_text();
    let loaded = load(&text, SourceKind::Mdt);
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let mut modules = Modules::new();
    modules.insert("example.flows", loaded.program.unwrap());
    modules
}

#[test]
fn a_patterns_stages_are_held_to_the_rules_in_its_expansion() {
    let modules = flows_module();
    let text = program(
        "workflow W = Greeting(work: Greeter.greet)\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }",
    )
    .replace("use std.{model}\n", "use std.{model}\nuse example.flows.{Greeting}\n");
    let r = checked(&text, Some(&modules));
    assert_eq!(
        shown(&r),
        [
            "MDT-E1902 at /defs/W/apply: Stage 'draft' is named twice in the body of workflow W; the stages of one body have names of their own."
        ]
    );
    let f = r.diagnostics[0].facts.as_ref().unwrap();
    assert_eq!(
        f.get("pattern_path").and_then(JsValue::as_str),
        Some("/defs/Greeting/body/2/name")
    );
    assert_eq!(
        f.get("expanded_path").and_then(JsValue::as_str),
        Some("/defs/W/body/2/name")
    );
    // The same pattern with its stages in order expands and checks.
    let mut fixed = Modules::new();
    let module = flows_text().replace(
        "stage draft \"Give it back\"",
        "stage give \"Give it back\"",
    );
    fixed.insert(
        "example.flows",
        load(&module, SourceKind::Mdt).program.unwrap(),
    );
    let r = checked(&text, Some(&fixed));
    assert!(r.ok, "{:?}", shown(&r));
    assert_eq!(
        f.get("problem").and_then(JsValue::as_str),
        Some("duplicate")
    );
}
