//! The data class of a function's result in language 0.6 (spec/attention.md
//! "The class of a function's result", security note of 2026-11-18): a call
//! of a function is of the class of what the function returns, typed in its
//! body, as well as of its arguments'. A function that reads a confidential
//! row itself and hands it back as `Text` gave a public value in 0.6 as
//! released; each route below passed the check then and is refused now
//! (E0220, and E1706 in a sub-program), while a function that reads the row
//! and returns a constant stays public. A `plan` handed such a result gives
//! its lead that class (`lead_classes`). A program of 0.5 is checked as
//! before. No TypeScript reads 0.6, so every expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_check::doors::{SubprogramCheck, SubprogramInput, check_subprogram};
use mandate_check::library::LibrarySource;
use mandate_check::stdlib::DataClass;
use mandate_check::{
    CheckOptions, CheckResult, ModuleSource, Modules, PatchOp, Room, check, load_modules, skeleton,
};
use mandate_ir::{Diagnostic, JsValue, Language, Severity, Value, parse};
use mandate_syntax::{SourceKind, load};

/// `code at path` of each error of `diagnostics`.
fn errors_of(diagnostics: &[Diagnostic]) -> Vec<String> {
    diagnostics
        .iter()
        .filter(|d| d.severity == Severity::Error)
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

fn errors(r: &CheckResult) -> Vec<String> {
    errors_of(&r.diagnostics)
}

fn checked(text: &str) -> CheckResult {
    check(text, SourceKind::Mdt, &CheckOptions::default())
}

/// The definitions every program below starts with: a confidential row an
/// environment declares, a model that may see public data only, and
/// `text_of`, which reads the row itself and hands back its text as `Text`.
const HEAD: &str = r#"mandate @ 0.6

module example.reads @ 0.1

use std.{data, model}

role core_owner "Core owner"

type CustomerName = Text classified confidential
type Row  = { tracking_no: Text, full_name: CustomerName }
type Note = { text: Text }

component core {
  repo  "acme/core"
  root  "/work/acme-core"
  lang  java
  owner role "core_owner"
}

environment prod_sim {
  class confidential
  read customers from core
    sql "select tracking_no, full_name from customers where tracking_no = :tracking_no"
    params (tracking_no: Text)
    returns Row
    max_rows 1
}

capability Reads    = data.read(prod_sim, customers)
capability ModelPub = model.infer(tier: standard, max_class: public)

/// Reads a customer's row and hands back its text, typed Text.
fn text_of(t: Text) -> Text ! {Data.Read} {
  let rows = data.read(prod_sim.customers, tracking_no: t, max_class: confidential)
  "{rows}"
}
"#;

/// [`HEAD`], the functions `fns`, and a workflow `W(t: Text)` whose body is
/// `body`.
fn program(fns: &str, body: &str) -> String {
    format!(
        "{HEAD}\n{fns}\nworkflow W(t: Text) -> Inferred<Text>\n  caps   Reads, ModelPub\n  budget {{ steps: 4 }}\n{{\n{body}}}\n"
    )
}

/// A function that hands back `text_of`'s text.
const AGAIN: &str =
    "/// Hands back text_of's text.\nfn again(t: Text) -> Text ! {Data.Read} {\n  text_of(t)\n}\n";

/// A function that hands back the row's text by a `return`.
const EARLY: &str = "/// Hands back the row's text by a return.\nfn early(t: Text) -> Text ! {Data.Read} {\n  let rows = data.read(prod_sim.customers, tracking_no: t, max_class: confidential)\n  return \"{rows}\"\n}\n";

/// A function whose value is either branch of an `if`, `text_of`'s text
/// in `then` or in `else`.
fn pick(then_text_of: bool) -> String {
    let (a, b) = if then_text_of {
        ("text_of(t)", "\"none\"")
    } else {
        ("\"none\"", "text_of(t)")
    };
    format!(
        "/// Picks a text.\nfn pick(t: Text, b: Bool) -> Text ! {{Data.Read}} {{\n  if b {{\n    {a}\n  }} else {{\n    {b}\n  }}\n}}\n"
    )
}

/// A function that reads the row and hands back a constant.
const QUIET: &str = "/// Reads the row and hands back a constant.\nfn quiet(t: Text) -> Text ! {Data.Read} {\n  let rows = data.read(prod_sim.customers, tracking_no: t, max_class: confidential)\n  \"none\"\n}\n";

#[test]
fn a_functions_result_handed_to_a_model_is_of_the_class_of_what_it_returns() {
    let routes: Vec<(&str, String, &str)> = vec![
        (
            "directly",
            program(
                "",
                "  let n = text_of(t)\n  infer Text from n using ModelPub\n",
            ),
            "/defs/W/body/1/value",
        ),
        (
            "through a record's field",
            program(
                "",
                "  let r = Note { text: text_of(t) }\n  infer Text from r.text using ModelPub\n",
            ),
            "/defs/W/body/1/value",
        ),
        (
            "through a list",
            program(
                "",
                "  let xs = [text_of(t)]\n  infer Text from xs using ModelPub\n",
            ),
            "/defs/W/body/1/value",
        ),
        (
            "through a second function",
            program(AGAIN, "  infer Text from again(t) using ModelPub\n"),
            "/defs/W/body/0/value",
        ),
        (
            "through a template",
            program(
                "",
                "  infer Text from \"Name: {text_of(t)}\" using ModelPub\n",
            ),
            "/defs/W/body/0/value",
        ),
        (
            "through an if's then",
            program(
                &pick(true),
                "  infer Text from pick(t, t == \"a\") using ModelPub\n",
            ),
            "/defs/W/body/0/value",
        ),
        (
            "through an if's else",
            program(
                &pick(false),
                "  infer Text from pick(t, t == \"a\") using ModelPub\n",
            ),
            "/defs/W/body/0/value",
        ),
        (
            "by a return",
            program(EARLY, "  infer Text from early(t) using ModelPub\n"),
            "/defs/W/body/0/value",
        ),
    ];
    for (route, text, at) in &routes {
        let r = checked(text);
        assert_eq!(errors(&r), [format!("MDT-E0220 at {at}")], "{route}");
        let message = &r.diagnostics[0].message;
        assert_eq!(
            message, "confidential data is sent to a model whose capability allows at most public.",
            "{route}"
        );
        // A program of 0.5 is checked as before: its function's result is
        // of its arguments' class alone (spec/attention.md).
        let five = text.replace("mandate @ 0.6", "mandate @ 0.5");
        assert!(errors(&checked(&five)).is_empty(), "{route} in 0.5");
    }
}

#[test]
fn a_function_that_reads_classified_data_and_returns_a_constant_stays_public() {
    let quiet = program(QUIET, "  infer Text from quiet(t) using ModelPub\n");
    let r = checked(&quiet);
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    // The classified result bound and not handed on refuses nothing.
    let unused = program(
        "",
        "  let n = text_of(t)\n  infer Text from t using ModelPub\n",
    );
    let r = checked(&unused);
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
}

/// The module of `text_of`, its environment and its types, that another
/// program imports.
const MODULE: &str = r#"mandate @ 0.6

module example.custdata @ 0.1

use std.{data}

pub role core_owner "Core owner"

/// A customer's name.
pub type CustomerName = Text classified confidential

/// A customer's row.
pub type Row = { tracking_no: Text, full_name: CustomerName }

pub component core {
  repo  "acme/core"
  root  "/work/acme-core"
  lang  java
  owner role "core_owner"
}

pub environment prod_sim {
  class confidential
  read customers from core
    sql "select tracking_no, full_name from customers where tracking_no = :tracking_no"
    params (tracking_no: Text)
    returns Row
    max_rows 1
}

/// Reads a customer's row and hands back its text, typed Text.
pub fn text_of(t: Text) -> Text ! {Data.Read} {
  let rows = data.read(prod_sim.customers, tracking_no: t, max_class: confidential)
  "{rows}"
}
"#;

/// A program that calls the imported `text_of` and hands its result to a
/// model that may see public data only.
const USES: &str = r#"mandate @ 0.6

module example.uses @ 0.1

use std.{data, model}
use example.custdata.{prod_sim, text_of}

capability Reads    = data.read(prod_sim, customers)
capability ModelPub = model.infer(tier: standard, max_class: public)

workflow W(t: Text) -> Inferred<Text>
  caps   Reads, ModelPub
  budget { steps: 4 }
{
  let n = text_of(t)
  infer Text from n using ModelPub
}
"#;

#[test]
fn an_imported_function_and_a_librarys_function_keep_the_class_of_what_they_return() {
    assert!(errors(&checked(MODULE)).is_empty());
    let sources = [ModuleSource {
        text: MODULE,
        kind: SourceKind::Mdt,
        file: "custdata.mdt",
    }];
    let loaded = load_modules(&sources);
    assert!(loaded.problems.is_empty(), "{:#?}", loaded.problems);
    let modules: Modules = loaded.modules;
    let r = check(
        USES,
        SourceKind::Mdt,
        &CheckOptions {
            modules: Some(&modules),
            ..CheckOptions::default()
        },
    );
    assert_eq!(errors(&r), ["MDT-E0220 at /defs/W/body/1/value"]);
    let libraries = [LibrarySource {
        manifest: r#"{"library":"mandate/library/0.6","name":"example.custdata","version":"1.0.0","modules":["custdata.mdt"]}"#.to_owned(),
        files: vec![("custdata.mdt".to_owned(), MODULE.to_owned())],
    }];
    let r = check(
        USES,
        SourceKind::Mdt,
        &CheckOptions {
            libraries: Some(&libraries),
            ..CheckOptions::default()
        },
    );
    assert_eq!(errors(&r), ["MDT-E0220 at /defs/W/body/1/value"]);
}

/// A workflow `Run(t: Text)` under an envelope whose `spawn.max_class` is
/// public, its body `BODY`, with an agent whose model may see confidential
/// data, and a lead.
const ENVELOPE: &str = r#"
capability ModelConf = model.infer(tier: standard, max_class: confidential)

agent Summarizer {
  role   "Summarizes a text."
  caps   ModelConf
  budget { tokens: 1000, spend: 1 USD, steps: 5 }
  skill summarize(t: Text) -> Inferred<Text> ! {Model}
}

agent Lead {
  role   "Plans what is left."
  caps   ModelConf
  budget { tokens: 5000, spend: 2 USD, steps: 20 }
  skill finish(t: Text) -> Inferred<Text> ! {Model}
}

workflow Run(t: Text) -> Inferred<Text>
  envelope {
    owner   core_owner
    caps    Reads, ModelConf
    budget  { tokens: 100000, time: 1h, spend: 20 USD, steps: 200, agents: 20 }
    spawn   { max_concurrent: 4, max_class: public }
  }
{
  BODY
}
"#;

fn enveloped(body: &str) -> String {
    format!("{HEAD}{}", ENVELOPE.replace("BODY", body))
}

#[test]
fn an_envelopes_max_class_holds_a_functions_result() {
    for (body, message) in [
        (
            "delegate Summarizer.summarize(text_of(t))",
            "Summarizer.summarize receives confidential data, and Run's envelope allows at most public in a delegation (spawn.max_class).",
        ),
        (
            "infer Text from text_of(t) using ModelConf",
            "confidential data is sent to a model, and Run's envelope allows at most public in the run (spawn.max_class).",
        ),
    ] {
        let r = checked(&enveloped(body));
        assert_eq!(
            errors(&r),
            ["MDT-E0220 at /defs/Run/body/0/value"],
            "{body}"
        );
        assert_eq!(r.diagnostics[0].message, message);
    }
    let r = checked(&enveloped(
        "let n = text_of(t)\n  delegate Summarizer.summarize(t)",
    ));
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
}

/// A sub-program of `Run` whose workflow `Look` has the body `BODY`, and
/// its own function that reads the row and hands back its text.
const SUB: &str = r#"mandate @ 0.6

module example.reads.plan_1 @ 0.1

use example.reads

/// Reads a customer's row and hands back its text, typed Text.
fn name_of(t: Text) -> Text ! {Data.Read} {
  let rows = data.read(prod_sim.customers, tracking_no: t, max_class: confidential)
  "{rows}"
}

workflow Look() -> Inferred<Text>
  caps   Reads, ModelConf
  budget { tokens: 2000, time: 10m, spend: 2 USD, steps: 10, agents: 2 }
{
  BODY
}
"#;

/// The sub-program of [`SUB`] with `body`, checked as `check_subprogram`
/// checks a lead's sub-program of `Run` that received public data.
fn admit(body: &str) -> SubprogramCheck {
    let parent = load(
        &enveloped("plan Lead.finish(t) within envelope"),
        SourceKind::Mdt,
    )
    .program
    .unwrap();
    let defs = load(&SUB.replace("BODY", body), SourceKind::Mdt)
        .program
        .unwrap();
    let ops: Vec<PatchOp> = defs
        .get("defs")
        .and_then(Value::as_object)
        .unwrap()
        .iter()
        .map(|(n, d)| PatchOp {
            op: "add".to_owned(),
            path: format!("/defs/{n}"),
            value: Some(d.clone()),
        })
        .collect();
    let module = parent.get("module").and_then(Value::as_str).unwrap();
    let base = mandate_ir::hash_program(&skeleton(module, 1.0, Some(Language::V0_6))).program;
    let room = r#"{"left":{"tokens":50000,"steps":100,"agents":10,"spend:USD":10000000},"time_left_ms":1800000}"#;
    let room = Room::from_value(&parse(room).unwrap().value).unwrap();
    check_subprogram(&SubprogramInput {
        parent: &parent,
        modules: None,
        workflow: "Run",
        number: 1.0,
        base: &base,
        ops: &ops,
        lead: DataClass::Public,
        room: &room,
        std_patterns: None,
    })
    .unwrap()
}

#[test]
fn a_sub_programs_function_result_is_held_to_the_envelopes_max_class() {
    for (body, message) in [
        (
            "delegate Summarizer.summarize(name_of(\"a\"))",
            "Summarizer.summarize receives confidential data, and the run's envelope allows at most public in a delegation (spawn.max_class).",
        ),
        (
            "infer Text from name_of(\"a\") using ModelConf",
            "confidential data is sent to a model, and the run's envelope allows at most public in the run (spawn.max_class).",
        ),
    ] {
        let r = admit(body);
        assert!(!r.ok, "{body}");
        assert_eq!(
            errors_of(&r.diagnostics),
            ["MDT-E1706 at /defs/Look/body/0/value"],
            "{body}"
        );
        let d = &r.diagnostics[0];
        assert_eq!(d.message, message);
        let facts = d.facts.as_ref().unwrap();
        assert_eq!(
            facts.get("dimension").and_then(JsValue::as_str),
            Some("data_class")
        );
        assert_eq!(
            facts.get("data_class").and_then(JsValue::as_str),
            Some("confidential")
        );
    }
    let r = admit("let n = name_of(\"a\")\n  delegate Summarizer.summarize(\"a\")");
    assert!(r.ok, "{:?}", errors_of(&r.diagnostics));
}

/// The class `lead_classes` gives each `plan` of `text`, by its path.
fn leads(text: &str) -> Vec<(String, &'static str)> {
    let program = load(text, SourceKind::Mdt).program.unwrap();
    let p = mandate_ir::Program::of(&program).unwrap();
    mandate_check::lead_classes(p, None)
        .into_iter()
        .map(|(path, c)| (path, c.as_str()))
        .collect()
}

#[test]
fn a_plan_handed_a_functions_result_gives_its_lead_the_class_of_what_it_returns() {
    // Under an envelope that allows confidential data the plan checks, and
    // the lead receives the confidential row the function returns (in 0.6
    // as released, public), which the runtime hands to the check of each
    // sub-program the lead writes as the lead's class.
    let open =
        |body: &str| enveloped(body).replace("max_class: public }", "max_class: confidential }");
    let text = open("plan Lead.finish(text_of(t)) within envelope");
    let r = checked(&text);
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    assert_eq!(
        leads(&text),
        [("/defs/Run/body/0/value".to_owned(), "confidential")]
    );
    // Its parameter alone stays public; and in 0.5 the function's result is
    // of its arguments' class, as before.
    let plain = open("plan Lead.finish(t) within envelope");
    assert_eq!(
        leads(&plain),
        [("/defs/Run/body/0/value".to_owned(), "public")]
    );
    let five = text.replace("mandate @ 0.6", "mandate @ 0.5");
    assert_eq!(
        leads(&five),
        [("/defs/Run/body/0/value".to_owned(), "public")]
    );
}
