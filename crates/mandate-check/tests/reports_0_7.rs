//! The reports of a program of 0.7 (spec/attention.md "`report`", "The
//! facts") where a conformance case cannot say it: the attention facts of
//! the fixture, field by field (a model's output, a verified value, outside
//! content, a mix, a count), through the door and the function; the
//! messages of E1903 to E1905 and of E1705; the reports of an imported
//! pattern held to the rules on its expansion, at the application; and that
//! a report counts as no node. No TypeScript reads 0.7, so every
//! expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::json_doors::library_door;
use mandate_check::{
    AttentionFacts, CheckOptions, CheckResult, Count, Modules, attention_facts, check,
    workflow_nodes,
};
use mandate_ir::{JsObject, JsValue, Program, Value, parse, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::read_text;

const REPORTS: &str = "fixtures/attention/reports.mdt";

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

fn facts_of(text: &str, workflow: &str) -> AttentionFacts {
    attention_facts(text, SourceKind::Mdt, &CheckOptions::default(), workflow)
        .unwrap_or_else(|| panic!("no facts of {workflow}"))
}

/// `name: type · class · known` of each field of the report at `path`.
fn fields(f: &AttentionFacts, path: &str) -> Vec<String> {
    let r = f
        .reports
        .iter()
        .find(|r| r.path == path)
        .unwrap_or_else(|| panic!("no report at {path}"));
    r.fields
        .iter()
        .map(|x| {
            format!(
                "{}: {} · {} · {}",
                x.name,
                mandate_check::ty::show(&x.shown.ty),
                x.shown.cls.as_str(),
                mandate_check::reports::known_name(x.shown.known)
            )
        })
        .collect()
}

#[test]
fn the_facts_say_how_each_field_is_known() {
    let text = read_text(REPORTS).unwrap();
    let r = checked(&text, None);
    assert!(r.ok, "{:?}", shown(&r));
    assert_eq!(shown(&r), Vec::<String>::new());
    let greet = facts_of(&text, "Greet");
    assert_eq!(
        fields(&greet, "/defs/Greet/body/3"),
        [
            // A delegation's result is a model's output.
            "draft: Inferred<Text> · public · model",
            // What a connector's tool gives is outside content, of the
            // connector's class.
            "vendor: Untrusted<Text> · confidential · external",
            // A text made of both is typed Text, and known as the weakest of
            // what it interpolates: outside content.
            "both: Text · confidential · external",
            // A count is the run's, whatever it counts.
            "words: Int · public · plain",
            // A record with a model's output in a field is one.
            "note: Inferred<Draft> · public · model",
        ]
    );
    assert_eq!(
        fields(&greet, "/defs/Greet/body/8"),
        [
            // What a contract verified.
            "greeting: Verified<Text, Greeted> · public · verified",
            // A text of a verified value and a model's output: the model's.
            "mixed: Text · public · model",
        ]
    );
    // Where each report stands, and how many times it can be shown.
    let at: Vec<(String, Option<String>, Count)> = greet
        .reports
        .iter()
        .map(|r| (r.path.clone(), r.stage.clone(), r.multiplicity))
        .collect();
    assert_eq!(
        at,
        [
            (
                "/defs/Greet/body/3".to_owned(),
                Some("draft".to_owned()),
                Count::ONE
            ),
            (
                "/defs/Greet/body/4/then/0".to_owned(),
                Some("draft".to_owned()),
                Count::ONE
            ),
            (
                "/defs/Greet/body/7/body/0".to_owned(),
                Some("check".to_owned()),
                Count::Finite(3)
            ),
            (
                "/defs/Greet/body/8".to_owned(),
                Some("check".to_owned()),
                Count::ONE
            ),
        ]
    );
    let stages: Vec<(&str, &str, usize)> = greet
        .stages
        .iter()
        .map(|s| (s.path.as_str(), s.name.as_str(), s.index))
        .collect();
    assert_eq!(
        stages,
        [
            ("/defs/Greet/body/0", "draft", 0),
            ("/defs/Greet/body/5", "check", 1)
        ]
    );
    // The expansion of MatchAll reports to the role its application binds,
    // at the paths of the running program, in the pattern's stages.
    let all = facts_of(&text, "MatchAll");
    let roles: Vec<(&str, &str, &str)> = all
        .reports
        .iter()
        .map(|r| {
            (
                r.path.as_str(),
                r.role.as_str(),
                r.stage.as_deref().unwrap_or(""),
            )
        })
        .collect();
    assert_eq!(
        roles,
        [
            ("/defs/MatchAll/body/2", "accountant", "collect"),
            ("/defs/MatchAll/body/9", "accountant", "commit")
        ]
    );
    assert_eq!(
        fields(&all, "/defs/MatchAll/body/9"),
        [
            "posted: Int · confidential · plain",
            "declined: Int · confidential · plain",
            "failed: Int · confidential · plain",
        ]
    );
    // Those paths are the running program's: a report stands there.
    let running = check(
        &text,
        SourceKind::Mdt,
        &CheckOptions {
            linked: true,
            ..CheckOptions::default()
        },
    )
    .linked
    .unwrap();
    for r in greet.reports.iter().chain(&all.reports) {
        let mut v = &running;
        for t in r.path.trim_start_matches('/').split('/') {
            v = match v {
                Value::Array(items) => &items[t.parse::<usize>().unwrap()],
                _ => v.get(t).unwrap(),
            };
        }
        assert_eq!(v.get("op").and_then(Value::as_str), Some("report"));
        assert_eq!(
            v.get("title").and_then(Value::as_str),
            Some(r.title.as_str())
        );
    }
}

/// A program of 0.7 with a role, a capability, an agent and `defs`.
fn program(defs: &str) -> String {
    format!(
        "mandate @ 0.7\n\nmodule example.reports @ 0.1\n\nuse std.{{model}}\n\nrole accountant \"Accountant\"\n\ncapability ModelStd = model.infer(tier: standard, max_class: internal)\n\nagent Greeter {{\n  role   \"Writes one line of greeting.\"\n  caps   ModelStd\n  budget {{ time: 2m, steps: 2 }}\n  skill greet(name: Text) -> Inferred<Text> ! {{Model}}\n}}\n\n{defs}\n"
    )
}

/// A workflow `W` whose body is `body`.
fn workflow(body: &str) -> String {
    program(&format!(
        "workflow W(name: Text) -> Inferred<Text>\n  caps   ModelStd\n  budget {{ time: 5m, steps: 4 }}\n{{\n{body}\n}}"
    ))
}

#[test]
fn a_field_is_known_as_the_weakest_thing_it_is_made_of() {
    let text = workflow(
        "  let line = delegate Greeter.greet(name)\n  report to accountant \"Drafted\" {\n    plain: name,\n    first: [name, line],\n    counted: len([line]),\n    compared: line == \"hi\",\n    chosen: if_long(line),\n  }\n  line",
    )
    .replace(
        "workflow W",
        "fn if_long(t: Inferred<Text>) -> Bool ! {} {\n  true\n}\n\nworkflow W",
    );
    // A call of a function is no field: E1904 at it, and nothing typed.
    let r = checked(&text, None);
    assert_eq!(
        shown(&r),
        [
            "MDT-E1904 at /defs/W/body/1/fields/4/value: Field 'chosen' of the report \"Drafted\" to accountant holds a call of if_long: a report's field is pure, and the one call it may hold is the built-in len, since a report shows values and does nothing (spec/attention.md \"report\")."
        ]
    );
    let text = text.replace("    chosen: if_long(line),\n", "");
    let f = facts_of(&text, "W");
    assert_eq!(
        fields(&f, "/defs/W/body/1"),
        [
            "plain: Text · public · plain",
            // A list is typed by its first item; it is known as its weakest.
            "first: List<Text> · public · model",
            "counted: Int · public · plain",
            "compared: Inferred<Bool> · public · model",
        ]
    );
}

#[test]
fn the_door_gives_the_facts_of_the_function_and_null_without_them() {
    let door = library_door("attention_facts").unwrap();
    let text = read_text(REPORTS).unwrap();
    let call = |text: &str, workflow: &str| {
        let input: JsValue = JsObject::new()
            .with("text", text)
            .with("kind", "mdt")
            .with("opts", JsObject::new().with("linked", false))
            .with("workflow", workflow)
            .into();
        let input = parse(&stringify(&input).unwrap()).unwrap().value;
        stringify(&(door.call)(&input).unwrap()).unwrap()
    };
    for w in ["Greet", "MatchAll"] {
        assert_eq!(
            call(&text, w),
            stringify(&facts_of(&text, w).to_js()).unwrap()
        );
        assert!(call(&text, w).starts_with(r#"{"format":"mandate/attention/0.1","workflow":""#));
    }
    // No such workflow, a definition that is none, a program that does not
    // check, a program older than 0.7: nothing.
    assert_eq!(call(&text, "Nobody"), "null");
    assert_eq!(call(&text, "Greeter"), "null");
    let broken = text.replace(
        "report to accountant \"Greeting checked\"",
        "report to nobody \"Greeting checked\"",
    );
    assert_eq!(call(&broken, "Greet"), "null");
    let older = read_text("fixtures/library/minimal.mdt").unwrap();
    assert_eq!(call(&older, "Greet"), "null");
    // A program of 0.7 with no stage and no report has facts, and no stage
    // and no report in them; after them, the members of the attention bound
    // (RL4): no question, no effect, no declared asks, and the pause the
    // budget's running out falls back to.
    let minimal = read_text("fixtures/attention/minimal.mdt").unwrap();
    assert_eq!(
        call(&minimal, "Greet"),
        format!(
            r#"{{"format":"mandate/attention/0.1","workflow":"Greet","program":"{}","stages":[],"reports":[],"questions":[],"effects":[],"totals":{{"questions":0,"by_role":[],"reports":[]}},"asks":null,"budget_exceeded":[{{"path":"/defs/Greet","wait":"/defs/Greet/on/budget_exceeded","kind":"pause","role":null,"shown":"public","known":"plain","deadline_ms":null,"on_no_answer":"waits","stage":null,"multiplicity":1,"only":"budget_exceeded"}}],"plans":[]}}"#,
            checked(&minimal, None).hashes.unwrap().program
        )
    );
}

#[test]
fn the_messages_of_the_rules_of_a_report() {
    // A title, two fields of one name in IR, in a pattern a role that is no
    // role slot.
    let r = checked(
        &workflow(
            "  report to accountant \"Drafted\u{7}\" { n: 1 }\n  delegate Greeter.greet(name)",
        ),
        None,
    );
    assert_eq!(
        shown(&r),
        [
            "MDT-E1903 at /defs/W/body/0/title: The title of the report to accountant holds the control character U+0007; a title is constant text of 1 to 80 characters with no control, format, bidirectional, line separator or paragraph separator character, since a person reads it on one line of an approval card."
        ]
    );
    let r = checked(
        &program(
            "pattern Tell(who: role, work: skill(Text) -> Inferred<Text>)(name: Text) -> Inferred<Text>\n{\n  report to accountant \"Told\" { n: 1 }\n  delegate work(name)\n}",
        ),
        None,
    );
    assert_eq!(
        shown(&r),
        [
            "MDT-E1903 at /defs/Tell/body/0/role: The report \"Told\" of pattern Tell is to accountant, which is not one of its role slots; a pattern's report goes to a role slot, which each application binds to a role of its own (spec/attention.md \"report\")."
        ]
    );
    // A field of a type no person is shown.
    let r = checked(
        &workflow(
            "  report to accountant \"Drafted\" { names: [[name]] }\n  delegate Greeter.greet(name)",
        ),
        None,
    );
    assert_eq!(
        shown(&r),
        [
            "MDT-E1904 at /defs/W/body/0/fields/0/value: Field 'names' of the report \"Drafted\" to accountant is of type List<List<Text>>, which a person is not shown: a List is shown when it holds a scalar or an enum, and this one holds List<Text>. A field is of a type a person can read: Int, Dec, Bool, Text, Money, Duration, Time, an enum, an Option or a List of one of these, or a record of these one level deep, each of them optionally inside Verified, Inferred or Untrusted (spec/attention.md \"report\")."
        ]
    );
    // Every place a report may not stand, in one program.
    let r = checked(
        &program(
            "fn one() -> Int ! {} {\n  report to accountant \"One\" { n: 1 }\n  1\n}\n\nworkflow W(name: Text) -> Inferred<Text>\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }\n{\n  loop until true {\n    report to accountant \"Three\" { n: 3 }\n  }\n  let all = map x in [name] max 2 {\n    report to accountant \"Four\" { n: 4 }\n    x\n  }\n  let line = delegate Greeter.greet(name)\n  on error(e) => switch e {\n    _ => {\n      report to accountant \"Five\" { n: 5 }\n      line\n    }\n  }\n  report to accountant \"Six\" { n: 6 }\n  on error(_) => line\n  line\n}\n\non budget_exceeded in W => switch 1 {\n  _ => {\n    report to accountant \"Two\" { n: 2 }\n    pause\n  }\n}\n\ntest \"reports\" {\n  report to accountant \"Seven\" { n: 7 }\n}",
        ),
        None,
    );
    let mut places: Vec<String> = r
        .diagnostics
        .iter()
        .filter(|d| d.code == "MDT-E1905")
        .map(|d| {
            let f = d.facts.as_ref().unwrap();
            format!(
                "{}:{}",
                f.get("title").and_then(JsValue::as_str).unwrap(),
                f.get("place").and_then(JsValue::as_str).unwrap()
            )
        })
        .collect();
    places.sort();
    assert_eq!(
        places,
        [
            "Five:on_error",
            "Four:map",
            "One:fn",
            "Seven:test",
            "Six:before_on_error",
            "Three:loop",
            "Two:on_budget_exceeded",
        ]
    );
    assert!(
        shown(&r).iter().any(|m| m
            == "MDT-E1905 at /defs/W/body/4: The report \"Six\" to accountant stands directly before an on error, which would handle the statement before the report; a report changes no value of the run and is no statement a handler handles: put it after the handler (spec/attention.md \"report\")."),
        "{:?}",
        shown(&r)
    );
}

/// A module of 0.7 with a pattern whose report breaks the rules: its title
/// holds a bidirectional control, and it stands in a map's body.
fn tells_text() -> String {
    "mandate @ 0.7\n\nmodule example.tells @ 0.1\n\nuse std.{model}\n\npub pattern Telling(work: skill(Text) -> Inferred<Text>, who: role)(name: Text) -> Inferred<Text>\n{\n  let all = map x in [name] max 2 {\n    report to who \"Told \u{202E}one\" { n: 1 }\n    x\n  }\n  delegate work(name)\n}\n".to_owned()
}

fn module(text: &str) -> Modules {
    let loaded = load(text, SourceKind::Mdt);
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let mut modules = Modules::new();
    modules.insert("example.tells", loaded.program.unwrap());
    modules
}

#[test]
fn a_patterns_reports_are_held_to_the_rules_in_its_expansion() {
    let text = program(
        "workflow W = Telling(work: Greeter.greet, who: accountant)\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }",
    )
    .replace("use std.{model}\n", "use std.{model}\nuse example.tells.{Telling}\n");
    let r = checked(&text, Some(&module(&tells_text())));
    let got: Vec<(String, String, String, String)> = r
        .diagnostics
        .iter()
        .map(|d| {
            let f = d.facts.as_ref().unwrap();
            let s = |k: &str| f.get(k).and_then(JsValue::as_str).unwrap_or("").to_owned();
            (
                d.code.clone(),
                d.at.path.clone().unwrap_or_default(),
                s("pattern_path"),
                s("role"),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            (
                "MDT-E1905".to_owned(),
                "/defs/W/apply".to_owned(),
                "/defs/Telling/body/0/value/body/0".to_owned(),
                // The role the application binds.
                "accountant".to_owned()
            ),
            (
                "MDT-E1903".to_owned(),
                "/defs/W/apply".to_owned(),
                "/defs/Telling/body/0/value/body/0/title".to_owned(),
                "accountant".to_owned()
            ),
        ]
    );
    // The same pattern with its report in the body and a plain title
    // expands and checks; its report is the application's role's.
    let fixed = tells_text()
        .replace("    report to who \"Told \u{202E}one\" { n: 1 }\n", "")
        .replace(
            "  delegate work(name)",
            "  report to who \"Told\" { n: len(all) }\n  delegate work(name)",
        );
    let r = checked(&text, Some(&module(&fixed)));
    assert!(r.ok, "{:?}", shown(&r));
    let body = r.expanded.unwrap();
    let report = &body
        .get("defs")
        .unwrap()
        .get("W")
        .unwrap()
        .get("body")
        .unwrap()
        .as_array()
        .unwrap()[1];
    assert_eq!(
        report.get("role").and_then(Value::as_str),
        Some("accountant")
    );
}

#[test]
fn a_sub_program_that_writes_a_stage_or_a_report_is_refused() {
    let sub = |body: &str| {
        parse(&format!(
            r#"{{"language":"mandate/0.7","module":"m.plan_1","version":"0.1","defs":{{"Look":{{"kind":"workflow","params":[],"returns":{{"ref":"Int"}},"caps":[],"body":[{body}]}}}}}}"#
        ))
        .unwrap()
        .value
    };
    let stage = sub(
        r#"{"op":"stage","name":"s","title":"S"},{"op":"expr","value":{"op":"int","value":1}}"#,
    );
    let d = mandate_check::subprogram_attention(&stage);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].at.path.as_deref(), Some("/defs/Look/body/0"));
    assert_eq!(
        d[0].message,
        "A sub-program cannot write a stage ('Look'): what a person is shown is written by the program a person approved, and a sub-program shows only the stages and reports of a pattern its envelope's shapes list (spec/attention.md \"Sub-programs and amendments\")."
    );
    let report = sub(
        r#"{"op":"report","role":"r","title":"T","fields":[{"name":"n","value":{"op":"int","value":1}}]},{"op":"if","cond":{"op":"bool","value":true},"then":[{"op":"report","role":"r","title":"U","fields":[{"name":"n","value":{"op":"int","value":2}}]}]},{"op":"expr","value":{"op":"int","value":1}}"#,
    );
    let d = mandate_check::subprogram_attention(&report);
    let at: Vec<(&str, &str)> = d
        .iter()
        .map(|x| {
            (
                x.at.path.as_deref().unwrap(),
                x.facts
                    .as_ref()
                    .unwrap()
                    .get("construct")
                    .and_then(JsValue::as_str)
                    .unwrap(),
            )
        })
        .collect();
    assert_eq!(
        at,
        [
            ("/defs/Look/body/0", "report"),
            ("/defs/Look/body/1/then/0", "report")
        ]
    );
    // Before 0.7 there is neither.
    let older = parse(&mandate_ir::canonicalize(&report).replace("mandate/0.7", "mandate/0.6"))
        .unwrap()
        .value;
    assert!(mandate_check::subprogram_attention(&older).is_empty());
}

#[test]
fn a_report_counts_as_no_node_and_costs_nothing() {
    let with = workflow(
        "  let line = delegate Greeter.greet(name)\n  report to accountant \"Drafted\" { draft: line, words: len(line) }\n  loop max_iter 4 {\n    report to accountant \"Again\" { n: 1 }\n  }\n  line",
    );
    let without =
        workflow("  let line = delegate Greeter.greet(name)\n  loop max_iter 4 {\n  }\n  line");
    let nodes = |text: &str| {
        let r = checked(text, None);
        assert!(r.ok, "{:?}", shown(&r));
        let p = r.program.unwrap();
        (
            workflow_nodes(Program::of(&p).unwrap(), None),
            mandate_check::static_cost(Program::of(&p).unwrap(), "W", None).map(|c| c.to_js()),
        )
    };
    let (a, ca) = nodes(&with);
    let (b, cb) = nodes(&without);
    assert_eq!(a, b);
    assert_eq!(
        ca.map(|c| stringify(&c).unwrap()),
        cb.map(|c| stringify(&c).unwrap())
    );
}
