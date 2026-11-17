//! The attention bound of language 0.7 (spec/attention.md "The attention
//! bound", "`asks`") where a conformance case cannot say it: the bound of
//! every workflow of the fixture, role by role, with its rows and its effect
//! sites; that what each question shows is what the typing gave; the
//! messages of E1906 to E1908; `SUPERVISE_ESCALATIONS` and the rounds of
//! `supervise restart_all` held equal to the runtime's; the facts of a
//! sub-program through the door, with the paths of its running program; and
//! that a sub-program's admission reserves its total, or nothing under an
//! envelope without `asks`. No TypeScript reads 0.7, so every expectation is
//! written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_check::asks::{OnNoAnswer, OpSite, SiteKind, site_of, statement_asks};
use mandate_check::attention::RESTART_ALL_ROUNDS;
use mandate_check::doors::{SubprogramInput, check_subprogram};
use mandate_check::json_doors::library_door;
use mandate_check::{
    AttentionFacts, CheckOptions, CheckResult, Count, PatchOp, Room, SUPERVISE_ESCALATIONS,
    attention_facts, check, opened, skeleton,
};
use mandate_ir::{ExprOp, StmtOp};
use mandate_ir::{JsObject, JsValue, Language, Value, parse, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::read_text;

const ASKS: &str = "fixtures/attention/asks.mdt";
const SHAPES: &str = "fixtures/attention/shapes.mdt";
const NOTED: &str = "fixtures/attention/shapes.plans/noted.mdt";

fn facts(text: &str, workflow: &str) -> AttentionFacts {
    attention_facts(text, SourceKind::Mdt, &CheckOptions::default(), workflow)
        .unwrap_or_else(|| panic!("no facts of {workflow}"))
}

fn checked(text: &str) -> CheckResult {
    check(text, SourceKind::Mdt, &CheckOptions::default())
}

/// `code at path: message` of each diagnostic but W0310 (a program below
/// holds a capability not every body uses).
fn shown(r: &CheckResult) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d.code != "MDT-W0310")
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

/// `role: n` of each role of the total, `-` for no role, in the order of
/// the tally.
fn roles(f: &AttentionFacts) -> Vec<String> {
    f.bound
        .asks
        .by_role
        .iter()
        .map(|(r, n)| format!("{}: {}", r.as_deref().unwrap_or("-"), show(*n)))
        .collect()
}

fn show(n: Count) -> String {
    match n {
        Count::Finite(n) => n.to_string(),
        Count::Unbounded => "unbounded".to_owned(),
    }
}

/// `kind role ×n` of each question site, `[only]` when it has one.
fn sites(f: &AttentionFacts) -> Vec<String> {
    f.bound
        .questions
        .iter()
        .map(|q| {
            format!(
                "{} {} ×{}{}",
                q.kind.as_str(),
                q.role.as_deref().unwrap_or("-"),
                show(q.multiplicity),
                q.only
                    .map(|o| format!(" [{}]", o.as_str()))
                    .unwrap_or_default()
            )
        })
        .collect()
}

#[test]
fn the_bound_of_every_workflow_of_the_fixture_is_its_declared_asks() {
    let text = read_text(ASKS).unwrap();
    let r = checked(&text);
    assert!(r.ok && r.diagnostics.is_empty(), "{:?}", shown(&r));
    // Each workflow: its total, its declared asks, its roles, its sites.
    let asking = facts(&text, "Asking");
    assert_eq!(asking.bound.asks.total, Count::Finite(9));
    assert_eq!(asking.bound.declared, Some(9));
    // The roles add up to 10: the if asks one role or the other.
    assert_eq!(
        roles(&asking),
        ["-: 1", "accountant: 2", "code_owner: 5", "finance_lead: 2"]
    );
    assert_eq!(
        sites(&asking),
        [
            "ask accountant ×1",
            "escalate finance_lead ×1",
            "pause - ×1",
            "supervise_escalate code_owner ×5",
            "ask accountant ×1",
            "ask finance_lead ×1"
        ]
    );
    let stages: Vec<Option<&str>> = asking
        .bound
        .questions
        .iter()
        .map(|q| q.stage.as_deref())
        .collect();
    assert_eq!(
        stages,
        [
            Some("ask"),
            Some("ask"),
            Some("wait"),
            Some("wait"),
            Some("wait"),
            Some("wait")
        ]
    );
    let approving = facts(&text, "Approving");
    assert_eq!(approving.bound.asks.total, Count::Finite(8));
    assert_eq!(
        sites(&approving),
        [
            // confirm, called twice: its one site, at its own path.
            "ask accountant ×2",
            // In a loop of two rounds.
            "ask accountant ×2",
            // Four approvals: `and` one by one, the invariant too.
            "verify finance_lead ×1",
            "verify code_owner ×1",
            "verify accountant ×1",
            "verify release_manager ×1"
        ]
    );
    let q = &approving.bound.questions[0];
    assert_eq!(q.path, "/defs/confirm/body/0/value");
    let approval = approving
        .bound
        .questions
        .iter()
        .find(|q| q.role.as_deref() == Some("accountant") && q.kind == SiteKind::Verify)
        .unwrap();
    assert_eq!(approval.deadline_ms, Some(86_400_000));
    assert_eq!(approval.on_no_answer, OnNoAnswer::Unmet);
    assert_eq!(
        approval.wait,
        "/defs/Approving/body/4/value/contract/accept/checked/call"
    );
    let releasing = facts(&text, "Releasing");
    assert_eq!(releasing.bound.asks.total, Count::Finite(5));
    assert_eq!(
        sites(&releasing),
        [
            "verify code_owner ×1",
            // Irreversible: `owner` under the default policy.
            "effect owner ×1",
            "governance owner ×1 [governance_file]",
            // The environment's tier names the release manager.
            "effect release_manager ×1",
            "governance owner ×1 [governance_file]"
        ]
    );
    let effects: Vec<(String, bool, Option<&str>)> = releasing
        .bound
        .effects
        .iter()
        .map(|e| (e.effect.clone(), e.counted, e.role.as_deref()))
        .collect();
    assert_eq!(
        effects,
        [
            ("git.merge".to_owned(), true, Some("owner")),
            ("deploy".to_owned(), true, Some("release_manager"))
        ]
    );
    let landing = facts(&text, "Landing");
    assert_eq!(landing.bound.asks.total, Count::Finite(5));
    assert_eq!(
        sites(&landing),
        [
            "changeset api_owner ×1",
            "governance api_owner ×1 [governance_file]",
            "changeset web_owner ×1",
            "governance web_owner ×1 [governance_file]",
            "changeset architect ×1"
        ]
    );
    let handling = facts(&text, "Handling");
    assert_eq!(handling.bound.asks.total, Count::Finite(1));
    // The handler's question is a row of its own, out of the total.
    let rows: Vec<String> = handling
        .bound
        .budget_exceeded
        .iter()
        .map(|q| {
            format!(
                "{} {} {}",
                q.kind.as_str(),
                q.role.as_deref().unwrap_or("-"),
                q.path
            )
        })
        .collect();
    assert_eq!(rows, ["ask finance_lead /defs/Handling/on/0/then/then"]);
    let planning = facts(&text, "Planning");
    assert_eq!(planning.bound.asks.total, Count::Finite(5));
    assert_eq!(planning.bound.declared, Some(5));
    assert_eq!(
        sites(&planning),
        [
            "review accountant ×1",
            "review finance_lead ×1 [on_escalation]",
            "verify code_owner ×1",
            "effect release_manager ×1",
            "governance owner ×1 [governance_file]"
        ]
    );
    let review = &planning.bound.questions[0];
    assert_eq!(
        review.on_no_answer,
        OnNoAnswer::Escalates {
            to: "finance_lead".to_owned(),
            deadline_ms: Some(86_400_000)
        }
    );
    assert_eq!(
        planning.bound.questions[1].on_no_answer,
        OnNoAnswer::Declined
    );
    let plans: Vec<(String, Option<&str>, Option<&str>)> = planning
        .bound
        .plans
        .iter()
        .map(|p| (p.path.clone(), p.role.as_deref(), p.stage.as_deref()))
        .collect();
    assert_eq!(
        plans,
        [(
            "/defs/Planning/body/7/value".to_owned(),
            Some("platform_lead"),
            Some("finish")
        )]
    );
    // Without asks, an unbounded total is no error, and the facts say so.
    let endless = facts(&text, "Endless");
    assert_eq!(endless.bound.asks.total, Count::Unbounded);
    assert_eq!(endless.bound.declared, None);
    assert_eq!(endless.bound.questions[0].unbounded, Some("loop"));
    let js = stringify(&endless.to_js()).unwrap();
    assert!(js.contains(r#""totals":{"questions":"unbounded""#), "{js}");
    assert!(js.contains(r#""asks":null"#));
    // Every site is the typing's.
    for w in [
        "Asking",
        "Approving",
        "Releasing",
        "Landing",
        "Handling",
        "Planning",
        "Endless",
        "Open",
        "Spare",
    ] {
        let f = facts(&text, w);
        for q in f.bound.questions.iter().chain(&f.bound.budget_exceeded) {
            assert!(
                q.typed,
                "{w}: {} at {} is not typed",
                q.kind.as_str(),
                q.path
            );
        }
    }
}

/// A program of 0.7 whose one workflow's body is `body`.
fn program(body: &str) -> String {
    format!(
        "mandate @ 0.7\n\nmodule example.asks @ 0.1\n\nuse std.{{human, model}}\n\nrole accountant \"Accountant\"\n\ntype Secret = Text classified confidential\n\ncapability ModelStd = model.infer(tier: standard, max_class: confidential)\n\nagent Writer {{\n  role   \"Writes.\"\n  caps   ModelStd\n  budget {{ time: 2m, steps: 2 }}\n  skill write(t: Text) -> Inferred<Text> ! {{Model}}\n}}\n\nworkflow W(note: Text, secret: Secret) -> Text\n  caps   ModelStd\n  budget {{ steps: 4, asks: 1 }}\n{{\n{body}\n}}\n"
    )
}

#[test]
fn what_a_question_shows_is_what_the_typing_gave_it() {
    // What the last question of `body` shows.
    let shows = |body: &str| {
        let text = program(body).replace("asks: 1", "asks: 9");
        let r = checked(&text);
        assert!(r.ok, "{:?}", shown(&r));
        let f = facts(&text, "W");
        let q = f.bound.questions.last().unwrap();
        format!(
            "{} {}",
            q.shown.as_str(),
            mandate_check::reports::known_name(q.known)
        )
    };
    // A constant question: public, counted or given by the run.
    assert_eq!(
        shows("  human.ask(\"Go on?\", role: accountant)\n  \"done\""),
        "public plain"
    );
    // Of a confidential parameter: confidential.
    assert_eq!(
        shows("  human.ask(\"Is {secret} right?\", role: accountant)\n  \"done\""),
        "confidential plain"
    );
    // A text that interpolates a model's output is a model's output, though
    // its type is Text; the floor of the field's rule.
    assert_eq!(
        shows(
            "  let w = delegate Writer.write(note)\n  human.ask(\"Is {w} right?\", role: accountant)\n  \"done\""
        ),
        "public model"
    );
    // What a person answers an escalation with is outside content, of a
    // class the checks cannot tell (so the highest); asked about, it is
    // shown as such.
    assert_eq!(
        shows(
            "  let a = escalate human(\"What now?\")\n  let b = human.ask(\"And {a}?\", role: accountant)\n  \"done\""
        ),
        "restricted external"
    );
    // An approval shows the contract's arguments; an effect, its
    // parameters (the fixture: a verified change).
    let text = read_text(ASKS).unwrap();
    let f = facts(&text, "Releasing");
    let known: Vec<&str> = f
        .bound
        .questions
        .iter()
        .map(|q| mandate_check::reports::known_name(q.known))
        .collect();
    assert_eq!(known, ["plain", "verified", "verified", "plain", "plain"]);
    // The role a person is asked by, and only the question's text: a role
    // argument lowers nothing.
    let text = program(
        "  let w = delegate Writer.write(note)\n  human.ask(\"Fine?\", role: accountant)\n  \"done\"",
    );
    let f = facts(&text, "W");
    assert_eq!(f.bound.questions[0].known, mandate_check::ty::Level::Plain);
    // Asking for the facts changes nothing of the check.
    let text = program("  human.ask(\"Is {secret} right?\", role: accountant)\n  \"done\"");
    assert_eq!(
        checked(&text).to_js().to_js_string(),
        check(
            &text,
            SourceKind::Mdt,
            &CheckOptions {
                linked: true,
                ..CheckOptions::default()
            }
        )
        .to_js()
        .to_js_string()
    );
}

#[test]
fn the_messages_of_e1906_to_e1908() {
    let r = checked(&program(
        "  human.ask(\"One?\", role: accountant)\n  human.ask(\"Two?\", role: accountant)\n  \"done\"",
    ));
    assert_eq!(
        shown(&r),
        [
            "MDT-E1906 at /defs/W/budget/asks: W can put 2 questions to people in one run, and its budget allows 1 (asks: 1). Raise asks, or ask fewer: every question counts, a review's escalation and an owner's gate of a governance-class file among them (spec/attention.md \"The attention bound\")."
        ]
    );
    let r = checked(&program(
        "  loop until true {\n    human.ask(\"Again?\", role: accountant)\n  }\n  \"done\"",
    ));
    assert_eq!(
        shown(&r),
        [
            "MDT-E1907 at /defs/W/body/0/body/0/value: W declares asks: 1, and this question (ask) stands in a loop without max_iter: the bound cannot count it. Give the loop a max_iter, or ask outside it (spec/attention.md \"The algebra\")."
        ]
    );
    let text = program("  \"done\"").replace(
        "budget { time: 2m, steps: 2 }",
        "budget { time: 2m, steps: 2, asks: 1 }",
    );
    assert_eq!(
        shown(&checked(&text)),
        [
            "MDT-E1908 at /defs/Writer/budget/asks: asks bounds the questions a whole run may put to people, so it is a field of a workflow's budget or of an envelope's, and of no other: this one is in Writer's agent budget (spec/attention.md \"asks\")."
        ]
    );
    // In a program of 0.6, asks is no field of a budget.
    let older = program("  \"done\"").replace("mandate @ 0.7", "mandate @ 0.6");
    let d = shown(&checked(&older));
    assert_eq!(d.len(), 1, "{d:?}");
    assert!(
        d[0].starts_with(
            "MDT-E0101 at : Unknown budget field 'asks'; expected tokens, spend, time, steps or agents."
        ),
        "{d:?}"
    );
    // In 0.7 the message knows it.
    let bad = program("  \"done\"").replace("steps: 4, asks: 1", "steps: 4, ask: 1");
    let d = shown(&checked(&bad));
    assert!(
        d[0].starts_with(
            "MDT-E0101 at : Unknown budget field 'ask'; expected tokens, spend, time, steps, agents or asks."
        ),
        "{d:?}"
    );
    // The printer writes asks back.
    let text = program("  \"done\"");
    let ir = load(&text, SourceKind::Mdt).program.unwrap();
    let printed = mandate_syntax::print_program(&ir).unwrap();
    assert!(
        printed.contains("budget { steps: 4, asks: 1 }"),
        "{printed}"
    );
}

/// The number in `const <name> = <n>;` of the runtime's interpreter.
fn runtime_constant(source: &str, name: &str) -> Option<u64> {
    let at = source.find(&format!("const {name} = "))?;
    let rest = &source[at + name.len() + 9..];
    rest[..rest.find(';')?].trim().parse().ok()
}

#[test]
fn the_constants_of_the_bound_are_the_runtimes() {
    let interp = read_text("runtime/src/interp.ts").unwrap();
    assert_eq!(
        runtime_constant(&interp, "MAX_ESCALATIONS"),
        Some(SUPERVISE_ESCALATIONS),
        "runtime/src/interp.ts MAX_ESCALATIONS"
    );
    // A par under restart_all runs its branches twice at most, the second
    // time under new command ids (`#all1`), so that every wait is asked
    // again.
    assert!(
        interp.contains(&format!(
            "const rounds = strategy === \"restart_all\" ? {RESTART_ALL_ROUNDS} : 1;"
        )),
        "the rounds of restart_all"
    );
    assert!(interp.contains("`${path}/branches/${bn}#all${round}`"));
}

/// The parent of the sub-program cases: its program, and the envelope of
/// `Planning`.
fn parent(file: &str) -> Value {
    let text = read_text(file).unwrap();
    load(&text, SourceKind::Mdt).program.unwrap()
}

/// A sub-program of `parent` (number 1) whose definitions are those of the
/// file `file`, checked as `check_subprogram` checks it with `room`.
fn admit(parent: &Value, file: &str, room: &str) -> mandate_check::doors::SubprogramCheck {
    let text = read_text(file).unwrap();
    let defs = load(&text, SourceKind::Mdt).program.unwrap();
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
    let base = mandate_ir::hash_program(&skeleton(module, 1.0, Some(Language::V0_7))).program;
    let room = Room::from_value(&parse(room).unwrap().value).unwrap();
    check_subprogram(&SubprogramInput {
        parent,
        modules: None,
        workflow: "Planning",
        number: 1.0,
        base: &base,
        ops: &ops,
        lead: mandate_check::stdlib::DataClass::Public,
        room: &room,
    })
    .unwrap()
}

#[test]
fn a_sub_program_reserves_its_total_or_nothing_without_a_limit() {
    let p = parent(SHAPES);
    // Its total, 1, fits the 1 left.
    let r = admit(&p, NOTED, r#"{"left":{"steps":40,"agents":4,"asks":1}}"#);
    assert!(r.ok, "{:?}", r.diagnostics);
    // Not the 0 left.
    let r = admit(&p, NOTED, r#"{"left":{"steps":40,"agents":4,"asks":0}}"#);
    let d: Vec<String> = r
        .diagnostics
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(d, ["MDT-E1706 at /defs/Rest"]);
    // A run without an asks limit reserves nothing.
    let r = admit(&p, NOTED, r#"{"left":{"steps":40,"agents":4}}"#);
    assert!(r.ok, "{:?}", r.diagnostics);
}

#[test]
fn the_door_gives_the_facts_of_a_sub_program_in_its_running_program() {
    let p = parent(SHAPES);
    let r = admit(&p, NOTED, r#"{"left":{"steps":40,"agents":4,"asks":1}}"#);
    assert!(r.ok, "{:?}", r.diagnostics);
    let sub = r.program.clone().unwrap();
    let running = r
        .running
        .clone()
        .expect("a sub-program that applies a pattern runs its expansion");
    // What the runtime passes: the sub-program as its check reads it
    // (`opened(sub, parent)`), the parent among the modules, and the claim
    // its check is given.
    let view = opened(&sub, &p);
    let envelope = p
        .get("defs")
        .and_then(|d| d.get("Planning"))
        .and_then(|w| w.get("envelope"))
        .unwrap();
    let module = p.get("module").and_then(Value::as_str).unwrap();
    let input: JsValue = JsObject::new()
        .with("text", stringify(&JsValue::from(&view)).unwrap())
        .with("kind", "json")
        .with(
            "opts",
            JsObject::new()
                .with("modules", JsObject::new().with(module, JsValue::from(&p)))
                .with(
                    "claim",
                    JsObject::new()
                        .with("envelope", JsValue::from(envelope))
                        .with("lead", "public"),
                ),
        )
        .with("workflow", "Rest")
        .into();
    let door = library_door("attention_facts").unwrap();
    let out = (door.call)(&parse(&stringify(&input).unwrap()).unwrap().value).unwrap();
    let f = mandate_ir::parse(&stringify(&out).unwrap()).unwrap().value;
    // The pattern's stages, its report to the role the application binds,
    // and its question.
    let at = |member: &str| -> Vec<String> {
        f.get(member)
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .map(|x| x.get("path").and_then(Value::as_str).unwrap().to_owned())
            .collect()
    };
    assert_eq!(at("stages"), ["/defs/Rest/body/0", "/defs/Rest/body/3"]);
    assert_eq!(at("reports"), ["/defs/Rest/body/2"]);
    assert_eq!(at("questions"), ["/defs/Rest/body/4/value"]);
    let report = &f.get("reports").and_then(Value::as_array).unwrap()[0];
    assert_eq!(
        report.get("role").and_then(Value::as_str),
        Some("accountant")
    );
    // Each path is a node of the program the sub-program runs as.
    let node = |path: &str| {
        let mut v = &running;
        for t in path.trim_start_matches('/').split('/') {
            v = match v {
                Value::Array(a) => &a[t.parse::<usize>().unwrap()],
                _ => v.get(t).unwrap(),
            };
        }
        v.get("op").and_then(Value::as_str).unwrap().to_owned()
    };
    assert_eq!(node("/defs/Rest/body/0"), "stage");
    assert_eq!(node("/defs/Rest/body/2"), "report");
    assert_eq!(node("/defs/Rest/body/4/value"), "call");
    assert_eq!(
        f.get("totals")
            .and_then(|t| t.get("questions"))
            .and_then(Value::as_i64),
        Some(1)
    );
}

#[test]
fn raising_asks_is_a_governance_change() {
    // A patch that lets a run ask more, or without a limit, is one a person
    // approves, as for every other limit; lowering it is not.
    let text = read_text(ASKS).unwrap();
    let before = load(&text, SourceKind::Mdt).program.unwrap();
    let with = |n: Option<i64>| {
        let mut p = before.clone();
        let Value::Object(root) = &mut p else {
            panic!()
        };
        let mut defs = root.get("defs").and_then(Value::as_object).unwrap().clone();
        let mut w = defs
            .get("Asking")
            .and_then(Value::as_object)
            .unwrap()
            .clone();
        let mut b = w.get("budget").and_then(Value::as_object).unwrap().clone();
        match n {
            Some(n) => {
                b.insert("asks", Value::from(mandate_ir::Int::new(n).unwrap()));
            }
            None => {
                b.remove("asks");
            }
        }
        w.insert("budget", Value::Object(b));
        defs.insert("Asking", Value::Object(w));
        root.insert("defs", Value::Object(defs));
        p
    };
    let governance = |after: &Value| -> Vec<String> {
        mandate_check::governance_changes(&before, after, None)
            .iter()
            .map(|c| c.text.clone())
            .collect()
    };
    assert_eq!(
        governance(&with(Some(10))),
        ["~ Asking.budget.asks: 9 → 10"]
    );
    assert_eq!(
        governance(&with(None)),
        ["~ Asking.budget.asks: 9 → no limit"]
    );
    assert!(governance(&with(Some(8))).is_empty());
    let changes = mandate_check::budget_changes("W", None, Some(&with(Some(3))));
    assert!(changes.up.is_empty());
}

#[test]
fn the_parent_of_the_sub_program_checks_alone() {
    // With its pattern's stages, report and question, which only its
    // sub-programs run: its own workflow plans, and asks nothing itself.
    let text = read_text(SHAPES).unwrap();
    let r = checked(&text);
    assert!(r.ok && r.diagnostics.is_empty(), "{:?}", shown(&r));
    let f = facts(&text, "Planning");
    assert_eq!(f.bound.asks.total, Count::ZERO);
    assert_eq!(f.bound.plans.len(), 1);
}

// ── The proof that no site is missed ──────────────────────────────────────
//
// Every operation of the IR, through a `match` with no arm for the rest,
// has the samples of what it can write (`op_samples`); each sample is put in
// a map's body, where the static checks refuse whatever they hold to wait
// for a person (E1708, `kind: "person"`: `Checker::waits`, `Checker::person`,
// a function that holds one, every `human.*` step), and in a workflow's
// body, where the bound must count it. An operation added to the IR does not
// build until it has its samples here and its class in `site_of`; a kind
// added to `SiteKind` does not build until it has its sample (`kind_sample`).

/// A program of 0.7 whose workflow `W` has `body`, with what every sample
/// needs.
fn sites_program(body: &str) -> String {
    format!(
        r#"mandate @ 0.7

module example.sites @ 0.1

use std.{{human, model, git}}

role accountant   "Accountant"
role finance_lead "Finance lead"

type Note = {{ text: Text }}

capability ModelStd = model.infer(tier: standard, max_class: internal)
capability Pr       = git.pr("example/api")

agent Writer {{
  role   "Writes."
  caps   ModelStd
  budget {{ time: 2m, steps: 2 }}
  skill write(t: Text) -> Inferred<Text> ! {{Model}}
}}

contract Approved(n: Note) {{
  accept checked "The accountant approves it" by human.approve(role: accountant)
}}

contract Kept(n: Note) {{
  accept short "It is short" by static true
  invariant kept "The accountant keeps it" by human.approve(role: accountant)
}}

contract Short(n: Note) {{
  accept short "It is short" by static true
    waive by accountant, finance_lead
}}

fn confirm(t: Text) -> Untrusted<Text> ! {{Human}} {{
  human.ask("Confirm {{t}}", role: accountant)
}}

workflow W(notes: List<Note>, n: Note, t: Text) -> Text
  caps   ModelStd, Pr
  budget {{ steps: 9 }}
{{
{body}
  "done"
}}
"#
    )
}

/// The statements that write an expression of `op`, each the form of it
/// that waits for a person when it has one; none for one no program that
/// checks can hold here (`spawn`, `await`), or that needs what the fixture
/// has (a change set, a `plan`).
fn op_samples(op: ExprOp) -> &'static [&'static str] {
    match op {
        ExprOp::Int => &["  let x = 1"],
        ExprOp::Dec => &["  let x = 1.5"],
        ExprOp::Text => &["  let x = \"a\""],
        ExprOp::Bool => &["  let x = true"],
        ExprOp::Money => &["  let x = 2 USD"],
        ExprOp::Duration => &["  let x = 1d"],
        ExprOp::List => &["  let x = [1, 2]"],
        ExprOp::Set => &["  let x = {}"],
        ExprOp::Template => &["  let x = \"a {t}\""],
        ExprOp::Prompt => &["  let x = prompt\"Say {quote(t)}\""],
        ExprOp::Var => &["  let x = t"],
        ExprOp::Field => &["  let x = n.text"],
        ExprOp::Call => &[
            "  let x = human.ask(\"Go on?\", role: accountant)",
            "  let x = confirm(t)",
            "  let x = len(t)",
            // Not a wait: the runtime hands it to the host's read adapter
            // (`STD_FNS` in `runtime/src/interp.ts`).
            "  let x = human.approve(role: accountant)",
        ],
        ExprOp::Unary => &["  let x = not true"],
        ExprOp::Binary => &["  let x = 1 + 2"],
        ExprOp::Range => &["  let x = 1 in 1..3"],
        ExprOp::Record => &["  let x = Note { text: t }"],
        ExprOp::Infer => &["  let x = infer Text from t using ModelStd"],
        ExprOp::Delegate => &[
            "  let x = delegate Writer.write(t) supervise escalate(human, role: accountant)",
            "  let x = delegate Writer.write(t)",
        ],
        ExprOp::Spawn | ExprOp::Await | ExprOp::Changeset | ExprOp::Plan => &[],
        ExprOp::Verify => &[
            "  let x = verify n against Approved(n)",
            "  let x = verify n against Kept(n)",
            "  let x = verify n against Short(n)",
        ],
        ExprOp::Effect => &["  let x = effect git.comment(t, \"note\") idempotent_by t"],
        ExprOp::Escalate => &[
            "  let x = escalate human(\"Look\", role: accountant)",
            "  let x = escalate human(\"Look\")",
        ],
        ExprOp::Pause => &["  let x = pause", "  let x = pause and t"],
        ExprOp::Switch => &["  let x = switch t { _ => 1 }"],
        ExprOp::Try => &["  let x = t?"],
        ExprOp::Block => &["  let x = switch t { _ => { t } }"],
        ExprOp::Map => &["  let x = map it in notes max 2 { it.text }"],
    }
}

/// The kinds of the questions the bound counts of `body`, in `W`, and the
/// total.
fn counted(body: &str) -> (Vec<SiteKind>, Count) {
    let text = sites_program(body);
    let f = attention_facts(&text, SourceKind::Mdt, &CheckOptions::default(), "W")
        .unwrap_or_else(|| panic!("{body}: does not check: {:?}", shown(&checked(&text))));
    let kinds = f.bound.questions.iter().map(|q| q.kind).collect();
    (kinds, f.bound.asks.total)
}

/// Whether the static checks hold `body`, in a map's body, to wait for a
/// person (E1708, `kind: "person"`).
fn waits_in_a_map(body: &str) -> bool {
    let inner = body.replace('\n', "\n  ");
    let text = sites_program(&format!(
        "  let m = map it in notes max 2 {{\n  {inner}\n    it\n  }}"
    ));
    check(&text, SourceKind::Mdt, &CheckOptions::default())
        .diagnostics
        .iter()
        .any(|d| {
            d.code == "MDT-E1708"
                && d.facts
                    .as_ref()
                    .and_then(|f| f.get("kind"))
                    .and_then(JsValue::as_str)
                    == Some("person")
        })
}

#[test]
fn whatever_the_checks_hold_to_wait_for_a_person_is_a_site_of_the_bound() {
    let (mut samples, mut waits) = (0, 0);
    for op in ExprOp::ALL {
        for body in op_samples(*op) {
            samples += 1;
            let (kinds, total) = counted(body);
            // What the bound counts of a sample is a kind of its operation's
            // class (a function's sites are a call's).
            for k in &kinds {
                assert!(
                    site_of(*op).kinds().contains(k) || *op == ExprOp::Call,
                    "{body}: {} is not a kind of {op}",
                    k.as_str()
                );
            }
            if waits_in_a_map(body) {
                waits += 1;
                if body.contains("human.approve(") {
                    // The one exception, which opens no wait at run time.
                    assert_eq!(total, Count::ZERO, "{body}");
                } else {
                    assert!(
                        total != Count::ZERO,
                        "{body}: the checks hold it to wait for a person, and the bound counts nothing"
                    );
                }
            }
        }
    }
    // A verify against a contract whose invariant a person approves waits
    // (the runtime runs `accept` and `invariant` alike), though E1708 reads
    // `accept` alone: the bound counts it.
    assert_eq!(counted("  let x = verify n against Kept(n)").1, Count::ONE);
    assert!(!waits_in_a_map("  let x = verify n against Kept(n)"));
    // What is no wait counts nothing.
    for body in [
        "  let x = pause and t",
        "  let x = delegate Writer.write(t)",
        "  let x = verify n against Short(n)",
    ] {
        assert_eq!(counted(body).1, Count::ZERO, "{body}");
        assert!(!waits_in_a_map(body), "{body}");
    }
    println!(
        "sites: {} operations, {samples} samples, {waits} held to wait for a person in a map's body, each counted",
        ExprOp::ALL.len()
    );
    assert!(waits >= 7, "{waits}");
}

/// The sample of each kind of site, as a body of `W`; for a change set and a
/// plan, the fixture, which has the system model and an envelope.
fn kind_sample(kind: SiteKind) -> Option<&'static str> {
    match kind {
        SiteKind::Verify => Some("  let x = verify n against Approved(n)"),
        SiteKind::Ask => Some("  let x = human.ask(\"Go on?\", role: accountant)"),
        SiteKind::Escalate => Some("  let x = escalate human(\"Look\")"),
        SiteKind::Pause => Some("  let x = pause"),
        SiteKind::SuperviseEscalate => {
            Some("  let x = delegate Writer.write(t) supervise escalate(human)")
        }
        SiteKind::Effect => Some(
            "  let a = verify n against Approved(n)\n  let x = effect git.merge(a) idempotent_by t",
        ),
        SiteKind::Governance => Some("  let x = effect git.comment(t, \"note\") idempotent_by t"),
        SiteKind::Review => Some(
            "  let c = map it in notes max 2 {\n    verify it against Short(it)\n  }\n  let x = human.review(c, role: accountant, deadline: 1d)",
        ),
        SiteKind::Changeset | SiteKind::Plan => None,
    }
}

#[test]
fn every_kind_of_site_has_a_construct_the_bound_counts() {
    let mut seen = 0;
    for kind in SiteKind::ALL {
        let Some(body) = kind_sample(*kind) else {
            continue;
        };
        let (kinds, _) = counted(body);
        assert!(kinds.contains(kind), "{body}: no {} site", kind.as_str());
        seen += 1;
    }
    // A change set and a plan: in the fixture.
    let text = read_text(ASKS).unwrap();
    assert!(
        facts(&text, "Landing")
            .bound
            .questions
            .iter()
            .any(|q| q.kind == SiteKind::Changeset)
    );
    assert_eq!(facts(&text, "Planning").bound.plans.len(), 1);
    assert_eq!(seen + 2, SiteKind::ALL.len());
    // Every kind is some operation's, and each name reads back.
    for kind in SiteKind::ALL {
        assert!(
            ExprOp::ALL
                .iter()
                .any(|op| site_of(*op).kinds().contains(kind)),
            "{}",
            kind.as_str()
        );
        assert_eq!(SiteKind::from_tag(kind.as_str()), Some(*kind));
    }
    // No statement asks by itself: what it holds does.
    for op in StmtOp::ALL {
        assert!(!statement_asks(*op), "{op}");
    }
    let names: Vec<&str> = SiteKind::ALL.iter().map(|k| k.as_str()).collect();
    assert_eq!(
        names,
        [
            "verify",
            "ask",
            "escalate",
            "pause",
            "supervise_escalate",
            "effect",
            "changeset",
            "governance",
            "review",
            "plan"
        ]
    );
    let _ = OpSite::None;
}
