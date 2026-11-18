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

use mandate_check::asks::{OnNoAnswer, OpSite, SiteKind, StmtSite, site_of, statement_site};
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

#[test]
fn a_restarted_branch_and_each_escalation_ask_again() {
    // The numbers are held to the runtime's in
    // `crates/mandate-testkit/tests/attention_constants_0_7.rs`. Here, what
    // makes each of them a question asked again: a par under restart_all
    // runs its branches a second time under new command ids (`#all1`), and
    // each escalation of a delegation is a wait of its own attempt
    // (`<path>#<attempt>/escalate`), so no answer of an earlier one stands
    // for it.
    let interp = read_text("runtime/src/interp.ts").unwrap();
    assert!(interp.contains("`${path}/branches/${bn}#all${round}`"));
    assert!(interp.contains("const id = attempt ? `${path}#${attempt}` : path;"));
    assert!(interp.contains("await this.wait(`${id}/escalate`, \"input\""));
    assert_eq!((RESTART_ALL_ROUNDS, SUPERVISE_ESCALATIONS), (2, 5));
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
        std_patterns: None,
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
fn an_application_is_counted_on_its_expansion_and_reported_at_the_application() {
    // shapes.mdt's pattern asks its reviewer once; a workflow of the program
    // that applies it with asks: 0 is above its asks (E1906, at its own
    // budget), and with the question in a loop the bound cannot count, at
    // the application (E1907, with the pattern's path).
    let applied = "\n\nworkflow Applied = Noted(work: Writer.write, reviewer: accountant, topic: \"the rest\")\n  caps   ModelStd\n  budget { steps: 4, asks: 0 }\n";
    let text = format!("{}{applied}", read_text(SHAPES).unwrap());
    let r = checked(&text);
    let d: Vec<String> = r
        .diagnostics
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(d, ["MDT-E1906 at /defs/Applied/budget/asks"]);
    let looped = text.replace(
        "  human.ask(\"Is {w} right?\", role: reviewer)",
        "  loop until true {\n    human.ask(\"Is {w} right?\", role: reviewer)\n  }\n  w",
    );
    let r = checked(&looped);
    let e1907: Vec<(String, Option<String>)> = r
        .diagnostics
        .iter()
        .filter(|d| d.code == "MDT-E1907")
        .map(|d| {
            (
                d.at.path.clone().unwrap_or_default(),
                d.facts
                    .as_ref()
                    .and_then(|f| f.get("pattern_path"))
                    .and_then(JsValue::as_str)
                    .map(str::to_owned),
            )
        })
        .collect();
    assert_eq!(
        e1907,
        [(
            "/defs/Applied/apply".to_owned(),
            Some("/defs/Noted/body/4/body/0/value".to_owned())
        )],
        "{:?}",
        shown(&r)
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
// has the samples of what it can write (`op_samples`), each with the
// questions a person counting them by hand finds in it: its total and its
// kinds. In a workflow's body the bound must give exactly those. Each sample
// is also put in a map's body, where the static checks refuse what they
// hold to wait for a person (E1708, `kind: "person"`); every sample they
// refuse must be one the hand count says asks, but the one exception the
// runtime does not wait on. An operation added to the IR does not build
// until it has its samples here and its class in `site_of`; a kind added to
// `SiteKind` does not build until it has its sample (`kind_sample`), and a
// statement added to the IR until it has its class in `statement_site` and
// its sample (`stmt_sample`).
//
// What this does not prove: that the runtime opens no wait these samples do
// not show. The places the runtime opens a wait are held to the kinds of
// the facts in the runtime's own slice (spec/attention.md "`asks` at run
// time": every wait it opens carries its static site). The effects, the
// change sets, a review and a `plan` are counted by hand on the fixture,
// which has the system model and an envelope.

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

/// One sample: its text, the total a hand count gives, and the kinds of its
/// questions in the order of the body.
type Sample = (&'static str, u64, &'static [SiteKind]);

/// The statements that write an expression of `op`, each the form of it
/// that waits for a person when it has one, with the hand count; none for
/// one no program that checks can hold here (`spawn`, `await`), or that
/// needs what the fixture has (a change set, a `plan`).
fn op_samples(op: ExprOp) -> &'static [Sample] {
    use SiteKind::{Ask, Escalate, Governance, Pause, SuperviseEscalate, Verify};
    match op {
        ExprOp::Int => &[("  let x = 1", 0, &[])],
        ExprOp::Dec => &[("  let x = 1.5", 0, &[])],
        ExprOp::Text => &[("  let x = \"a\"", 0, &[])],
        ExprOp::Bool => &[("  let x = true", 0, &[])],
        ExprOp::Money => &[("  let x = 2 USD", 0, &[])],
        ExprOp::Duration => &[("  let x = 1d", 0, &[])],
        ExprOp::List => &[("  let x = [1, 2]", 0, &[])],
        ExprOp::Set => &[("  let x = {}", 0, &[])],
        ExprOp::Template => &[("  let x = \"a {t}\"", 0, &[])],
        ExprOp::Prompt => &[("  let x = prompt\"Say {quote(t)}\"", 0, &[])],
        ExprOp::Var => &[("  let x = t", 0, &[])],
        ExprOp::Field => &[("  let x = n.text", 0, &[])],
        ExprOp::Call => &[
            (
                "  let x = human.ask(\"Go on?\", role: accountant)",
                1,
                &[Ask],
            ),
            // confirm asks once, at each call.
            ("  let x = confirm(t)", 1, &[Ask]),
            ("  let x = len(t)", 0, &[]),
            // Not a wait: the runtime hands it to the host's read adapter
            // (`STD_FNS` in `runtime/src/interp.ts`).
            ("  let x = human.approve(role: accountant)", 0, &[]),
        ],
        ExprOp::Unary => &[("  let x = not true", 0, &[])],
        ExprOp::Binary => &[("  let x = 1 + 2", 0, &[])],
        ExprOp::Range => &[("  let x = 1 in 1..3", 0, &[])],
        ExprOp::Record => &[("  let x = Note { text: t }", 0, &[])],
        ExprOp::Infer => &[("  let x = infer Text from t using ModelStd", 0, &[])],
        ExprOp::Delegate => &[
            (
                "  let x = delegate Writer.write(t) supervise escalate(human, role: accountant)",
                5,
                &[SuperviseEscalate],
            ),
            ("  let x = delegate Writer.write(t)", 0, &[]),
        ],
        ExprOp::Spawn | ExprOp::Await | ExprOp::Changeset | ExprOp::Plan => &[],
        ExprOp::Verify => &[
            ("  let x = verify n against Approved(n)", 1, &[Verify]),
            // The invariant's approval: E1708 reads `accept` alone.
            ("  let x = verify n against Kept(n)", 1, &[Verify]),
            ("  let x = verify n against Short(n)", 0, &[]),
        ],
        // Critical and not irreversible: authorized by policy, so its owner's
        // gate alone.
        ExprOp::Effect => &[(
            "  let x = effect git.comment(t, \"note\") idempotent_by t",
            1,
            &[Governance],
        )],
        ExprOp::Escalate => &[
            (
                "  let x = escalate human(\"Look\", role: accountant)",
                1,
                &[Escalate],
            ),
            ("  let x = escalate human(\"Look\")", 1, &[Escalate]),
        ],
        ExprOp::Pause => &[
            ("  let x = pause", 1, &[Pause]),
            ("  let x = pause and t", 0, &[]),
        ],
        ExprOp::Switch => &[("  let x = switch t { _ => 1 }", 0, &[])],
        ExprOp::Try => &[("  let x = t?", 0, &[])],
        ExprOp::Block => &[("  let x = switch t { _ => { t } }", 0, &[])],
        ExprOp::Map => &[("  let x = map it in notes max 2 { it.text }", 0, &[])],
    }
}

/// A statement of each kind, holding one question where it can hold one,
/// with the hand count of `T` and of `R`; none for `run`, which stands in a
/// test and in no workflow's body.
fn stmt_sample(op: StmtOp) -> Option<(&'static str, u64, u64)> {
    match op {
        StmtOp::Let => Some(("  let x = human.ask(\"Go on?\", role: accountant)", 1, 0)),
        StmtOp::Expr => Some(("  human.ask(\"Go on?\", role: accountant)", 1, 0)),
        StmtOp::If => Some((
            "  if len(t) > 1 {\n    human.ask(\"Go on?\", role: accountant)\n  }",
            1,
            0,
        )),
        StmtOp::Loop => Some((
            "  loop max_iter 3 {\n    human.ask(\"Go on?\", role: accountant)\n  }",
            3,
            0,
        )),
        StmtOp::Par => Some((
            "  par {\n    a = human.ask(\"Go on?\", role: accountant)\n    b = human.ask(\"And?\", role: finance_lead)\n  }",
            2,
            0,
        )),
        StmtOp::OnError => Some((
            "  let w = delegate Writer.write(t)\n  on error(_) => human.ask(\"It failed; now?\", role: accountant)",
            1,
            0,
        )),
        StmtOp::Report => Some(("  report to accountant \"Done\" { n: len(t) }", 0, 1)),
        StmtOp::Stage => Some(("  stage s \"A stage\"\n  let x = 1", 0, 0)),
        // `return` in a workflow's body ends it: its value is what `W` gives.
        StmtOp::Return => Some(("  return human.ask(\"Go on?\", role: accountant)", 1, 0)),
        StmtOp::Run => None,
    }
}

#[test]
fn every_statement_holds_what_the_bound_counts() {
    let mut seen = 0;
    for op in StmtOp::ALL {
        let site = statement_site(*op);
        let Some((body, questions, reports)) = stmt_sample(*op) else {
            assert_eq!(*op, StmtOp::Run);
            continue;
        };
        let text = sites_program(body).replace("-> Text\n", "-> Untrusted<Text>\n");
        let f = attention_facts(&text, SourceKind::Mdt, &CheckOptions::default(), "W")
            .unwrap_or_else(|| panic!("{body}: does not check: {:?}", shown(&checked(&text))));
        assert_eq!(f.bound.asks.total, Count::Finite(questions), "{body}");
        assert_eq!(f.bound.reports.total, Count::Finite(reports), "{body}");
        // A report is counted in R, a stage holds nothing, every other
        // statement what it holds.
        match site {
            StmtSite::Report => assert_eq!(reports, 1, "{op}"),
            StmtSite::Marker => assert_eq!(questions + reports, 0, "{op}"),
            StmtSite::Holds => assert!(questions > 0, "{op}"),
        }
        seen += 1;
    }
    assert_eq!(seen + 1, StmtOp::ALL.len());
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
        for (body, total, kinds) in op_samples(*op) {
            samples += 1;
            let (got, got_total) = counted(body);
            // Exactly the hand count.
            assert_eq!(got_total, Count::Finite(*total), "{body}");
            assert_eq!(got.as_slice(), *kinds, "{body}");
            // Of the kinds its operation's class names (a function's sites
            // are a call's).
            for k in &got {
                assert!(
                    site_of(*op).kinds().contains(k) || *op == ExprOp::Call,
                    "{body}: {} is not a kind of {op}",
                    k.as_str()
                );
            }
            if waits_in_a_map(body) {
                waits += 1;
                // What the checks hold to wait asks, by the hand count: but
                // the one exception, which opens no wait at run time.
                assert!(
                    *total > 0 || body.contains("human.approve("),
                    "{body}: the checks hold it to wait for a person, and the hand count is 0"
                );
            }
        }
    }
    // A verify against a contract whose invariant a person approves waits
    // (the runtime runs `accept` and `invariant` alike), though E1708 reads
    // `accept` alone.
    assert!(!waits_in_a_map("  let x = verify n against Kept(n)"));
    println!(
        "sites: {} operations, {samples} samples counted as by hand, {waits} held to wait for a person in a map's body",
        ExprOp::ALL.len()
    );
    assert_eq!(waits, 8, "the samples E1708 refuses in a map's body");
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

// ── F1: a role is a role definition ───────────────────────────────────────

/// `code at path` of each diagnostic but W0310.
fn codes(r: &CheckResult) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d.code != "MDT-W0310")
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// The fact `key` of the first diagnostic of `code`.
fn fact(r: &CheckResult, code: &str, key: &str) -> Option<String> {
    r.diagnostics
        .iter()
        .find(|d| d.code == code)
        .and_then(|d| d.facts.as_ref())
        .and_then(|f| f.get(key))
        .and_then(JsValue::as_str)
        .map(str::to_owned)
}

#[test]
fn a_role_a_question_names_is_no_name_the_scope_binds() {
    // The probe: a contract's parameter has the role's name, and the
    // runtime reads the approval's role in the contract's scope.
    let contract = sites_program("  let x = verify n against C(n, \"finance_lead\")").replace(
        "fn confirm(",
        "contract C(n: Note, accountant: Text) {\n  accept ok \"approved\" by human.approve(role: accountant)\n}\n\nfn confirm(",
    );
    let r = checked(&contract);
    assert_eq!(
        codes(&r),
        ["MDT-E1501 at /defs/C/accept/ok/by/call/args/0/value"]
    );
    assert_eq!(
        fact(&r, "MDT-E1501", "shadowed_by").as_deref(),
        Some("parameter")
    );
    assert_eq!(
        fact(&r, "MDT-E1501", "where").as_deref(),
        Some("human.approve")
    );
    // Every kind of question that names a role: by a parameter of the
    // workflow, or by a name its body binds.
    let with_param = |body: &str| {
        sites_program(body).replace(
            "workflow W(notes: List<Note>, n: Note, t: Text)",
            "workflow W(notes: List<Note>, n: Note, t: Text, accountant: Text)",
        )
    };
    let cases: [(String, &str, &str, &str); 3] = [
        (
            with_param("  let x = human.ask(\"Go on?\", role: accountant)"),
            "/defs/W/body/0/value/args/1/value",
            "human.ask",
            "parameter",
        ),
        (
            sites_program(
                "  let accountant = \"finance_lead\"\n  let x = escalate human(\"Look\", role: accountant)",
            ),
            "/defs/W/body/1/value/to/args/1/value",
            "escalate human(…)",
            "binding",
        ),
        (
            sites_program(
                "  let accountant = t\n  let x = delegate Writer.write(t) supervise escalate(human, role: accountant)",
            ),
            "/defs/W/body/1/value/supervise/args/1/value",
            "supervise escalate",
            "binding",
        ),
    ];
    for (text, path, site, by) in &cases {
        let r = checked(text);
        assert_eq!(codes(&r), [format!("MDT-E1501 at {path}")], "{site}");
        assert_eq!(fact(&r, "MDT-E1501", "where").as_deref(), Some(*site));
        assert_eq!(fact(&r, "MDT-E1501", "shadowed_by").as_deref(), Some(*by));
    }
    // An approval's `distinct_from:` too: here a parameter has the name of
    // the role of the approval before it, and both are refused.
    let two = sites_program("  let x = verify n against Two(n, t)").replace(
        "fn confirm(",
        "contract Two(n: Note, accountant: Text) {\n  accept ok \"two\" by human.approve(role: accountant) and human.approve(role: finance_lead, distinct_from: accountant)\n}\n\nfn confirm(",
    );
    let r = checked(&two);
    assert_eq!(
        codes(&r),
        [
            "MDT-E1501 at /defs/Two/accept/ok/by/all/0/call/args/0/value",
            "MDT-E1501 at /defs/Two/accept/ok/by/all/1/call/args/1/value"
        ]
    );
    let arguments: Vec<Option<&str>> = r
        .diagnostics
        .iter()
        .filter_map(|d| d.facts.as_ref())
        .map(|f| f.get("argument").and_then(JsValue::as_str))
        .collect();
    assert_eq!(arguments, [Some("role"), Some("distinct_from")]);
    // A review's `role:` and `escalate_to:` are held to name role
    // definitions by the review's own rule (E1507), in 0.6 already: a name
    // in scope is refused there, and once.
    for (text, path) in [
        (
            with_param(
                "  let c = map it in notes max 2 {\n    verify it against Short(it)\n  }\n  let x = human.review(c, role: accountant, deadline: 1d)",
            ),
            "/defs/W/body/1/value/args/1/value",
        ),
        (
            sites_program(
                "  let finance_lead = t\n  let c = map it in notes max 2 {\n    verify it against Short(it)\n  }\n  let x = human.review(c, role: accountant, deadline: 1d, escalate_to: finance_lead)",
            ),
            "/defs/W/body/2/value/args/3/value",
        ),
    ] {
        assert_eq!(codes(&checked(&text)), [format!("MDT-E1507 at {path}")]);
    }
    // A name the scope does not bind is the role definition: no diagnostic.
    for body in [
        "  let x = human.ask(\"Go on?\", role: accountant)",
        "  let y = t\n  let x = escalate human(\"Look\", role: accountant)",
    ] {
        assert_eq!(
            codes(&checked(&sites_program(body))),
            Vec::<String>::new(),
            "{body}"
        );
    }
    // In 0.6 the rule is not read: the diagnostics of 0.6 do not change.
    let older = with_param("  let x = human.ask(\"Go on?\", role: accountant)")
        .replace("mandate @ 0.7", "mandate @ 0.6");
    assert!(
        !codes(&checked(&older))
            .iter()
            .any(|c| c.starts_with("MDT-E1501")),
        "{:?}",
        codes(&checked(&older))
    );
}

// ── F2: recursion through a contract ──────────────────────────────────────

/// The probe of the review: a function that asks, verifies against a
/// contract whose `require` calls it again.
const THROUGH_A_CONTRACT: &str = "mandate @ 0.7\n\nmodule example.recursion @ 0.1\n\nuse std.{human, model}\n\nrole accountant \"Accountant\"\n\ncapability ModelStd = model.infer(tier: standard, max_class: internal)\n\ntype Note = { text: Text }\n\nagent Writer {\n  role   \"Writes.\"\n  caps   ModelStd\n  budget { time: 2m, steps: 2 }\n  skill write(t: Text) -> Inferred<Text> ! {Model}\n}\n\ncontract C(n: Note) {\n  require again(n)\n  accept ok \"ok\" by static true\n}\n\nfn ask(n: Note) -> Untrusted<Text> ! {Human} {\n  human.ask(\"Again {n.text}?\", role: accountant)\n}\n\nfn again(n: Note) -> Bool ! {Human} {\n  let a = ask(n)\n  let v = verify n against C(n)\n  true\n}\n\nworkflow V(n: Note) -> Bool\n  caps   ModelStd\n  budget { steps: 2 }\n{\n  let w = delegate Writer.write(n.text)\n  again(n)\n}\n";

/// The second probe: the cycle f → C → g → D → f, the question in g.
const TWO_CONTRACTS: &str = "mandate @ 0.7\n\nmodule example.recursion @ 0.1\n\nuse std.{human, model}\n\nrole accountant \"Accountant\"\n\ncapability ModelStd = model.infer(tier: standard, max_class: internal)\n\ntype Note = { text: Text }\n\nagent Writer {\n  role   \"Writes.\"\n  caps   ModelStd\n  budget { time: 2m, steps: 2 }\n  skill write(t: Text) -> Inferred<Text> ! {Model}\n}\n\ncontract C(n: Note) {\n  require g(n)\n  accept ok \"ok\" by static true\n}\n\ncontract D(n: Note) {\n  require f(n)\n  accept ok \"ok\" by static true\n}\n\nfn f(n: Note) -> Bool ! {Human} {\n  let v = verify n against C(n)\n  true\n}\n\nfn g(n: Note) -> Bool ! {Human} {\n  let a = human.ask(\"Again {n.text}?\", role: accountant)\n  let v = verify n against D(n)\n  true\n}\n\nworkflow V(n: Note) -> Bool\n  caps   ModelStd\n  budget { steps: 2 }\n{\n  let w = delegate Writer.write(n.text)\n  f(n)\n}\n";

/// The bound of `workflow` of `text` from the one pass, also when the
/// program does not check (E0502), and the pass's diagnostics.
fn bound_of(text: &str, workflow: &str) -> (mandate_check::WorkflowBound, Vec<String>) {
    let ir = load(text, SourceKind::Mdt).program.unwrap();
    let p = mandate_ir::Program::of(&ir).unwrap();
    let (d, typing) = mandate_check::static_check_shown(p, None, None, None);
    let b = typing
        .bounds
        .into_iter()
        .find(|b| b.workflow == workflow)
        .unwrap();
    let d = d
        .iter()
        .filter(|d| d.code != "MDT-W0310")
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect();
    (b, d)
}

#[test]
fn recursion_through_a_contract_is_refused_and_unbounded() {
    for (text, site, cycle) in [
        (
            THROUGH_A_CONTRACT,
            "/defs/ask/body/0/value",
            "C → again → C",
        ),
        (TWO_CONTRACTS, "/defs/g/body/0/value", "C → g → D → f → C"),
    ] {
        let (b, d) = bound_of(text, "V");
        // E0502, as a cycle of calls is.
        let r = checked(text);
        let e0502: Vec<&str> = r
            .diagnostics
            .iter()
            .filter(|d| d.code == "MDT-E0502")
            .map(|d| d.message.as_str())
            .collect();
        assert_eq!(e0502.len(), 1, "{d:?}");
        assert!(e0502[0].contains(cycle), "{}", e0502[0]);
        // The question the cycle reaches is unbounded, its role's count and
        // the total too.
        let q = b.questions.iter().find(|q| q.path == site).unwrap();
        assert_eq!(q.multiplicity, Count::Unbounded);
        assert_eq!(q.unbounded, Some("recursion"));
        assert_eq!(b.asks.of(Some("accountant")), Count::Unbounded);
        assert_eq!(b.asks.total, Count::Unbounded);
        // With asks, E1907 at the question, for the recursion.
        let declared = text.replace("budget { steps: 2 }\n{", "budget { steps: 2, asks: 1 }\n{");
        let r = checked(&declared);
        let e1907 = r
            .diagnostics
            .iter()
            .find(|d| d.code == "MDT-E1907")
            .unwrap();
        assert_eq!(e1907.at.path.as_deref(), Some(site));
        assert_eq!(fact(&r, "MDT-E1907", "why").as_deref(), Some("recursion"));
        // Before 0.7 a cycle through a contract is no E0502: 0.6 is as it was.
        let older = text.replace("mandate @ 0.7", "mandate @ 0.6");
        assert!(
            !checked(&older)
                .diagnostics
                .iter()
                .any(|d| d.code == "MDT-E0502"),
            "0.6"
        );
    }
}

// ── F3: one row for each kind and wait ────────────────────────────────────

#[test]
fn a_kind_and_a_wait_name_one_row() {
    let mut rows = 0;
    for file in [
        ASKS,
        SHAPES,
        "fixtures/attention/reports.mdt",
        "fixtures/attention/stages.mdt",
        "fixtures/attention/minimal.mdt",
    ] {
        let text = read_text(file).unwrap();
        let ir = load(&text, SourceKind::Mdt).program.unwrap();
        for (w, d) in ir.get("defs").and_then(Value::as_object).unwrap().iter() {
            if d.get("kind").and_then(Value::as_str) != Some("workflow") {
                continue;
            }
            let f = facts(&text, w);
            for list in [&f.bound.questions, &f.bound.budget_exceeded] {
                let mut seen: Vec<(SiteKind, &str, bool)> = Vec::new();
                for q in list {
                    let key = (
                        q.kind,
                        q.wait.as_str(),
                        q.only == Some(mandate_check::asks::Only::OnEscalation),
                    );
                    assert!(
                        !seen.contains(&key),
                        "{file} {w}: {} {} twice",
                        q.kind.as_str(),
                        q.wait
                    );
                    seen.push(key);
                    rows += 1;
                }
            }
        }
    }
    // A function called from two stages: one row, its stage none, both calls
    // counted.
    let text = sites_program(
        "  stage a \"One\"\n  let x = confirm(t)\n  stage b \"Two\"\n  let y = confirm(t)",
    );
    let f = facts(&text, "W");
    assert_eq!(f.bound.questions.len(), 1);
    assert_eq!(f.bound.questions[0].stage, None);
    assert_eq!(f.bound.questions[0].multiplicity, Count::Finite(2));
    println!("waits: {rows} rows of the fixtures, each one kind and wait");
}

// ── F4: a function's site shows what its calls hand it ────────────────────

#[test]
fn a_site_in_a_function_or_a_contract_shows_what_its_calls_hand_it() {
    let program = |body: &str, extra: &str| {
        format!(
            "mandate @ 0.7\n\nmodule example.handed @ 0.1\n\nuse std.{{human, model, tool}}\n\nrole accountant \"Accountant\"\n\ntype Note = {{ text: Text }}\n\nconnector erp = mcp(\"https://erp.example.com/mcp\")\n  version \"1.0\"\n  class   confidential\n{{\n  tool vendor_name(vendor_id: Text) -> Untrusted<Text>\n    read_only\n}}\n\ncapability ErpVendor = tool.call(erp, vendor_name)\ncapability ModelStd  = model.infer(tier: standard, max_class: confidential)\n\nagent Writer {{\n  role   \"Writes.\"\n  caps   ModelStd\n  budget {{ time: 2m, steps: 2 }}\n  skill write(t: Text) -> Inferred<Text> ! {{Model}}\n}}\n\nfn confirm(t: Untrusted<Text>) -> Untrusted<Text> ! {{Human}} {{\n  human.ask(\"Is {{t}} right?\", role: accountant)\n}}\n\nfn relay(t: Untrusted<Text>) -> Untrusted<Text> ! {{Human}} {{\n  confirm(t)\n}}\n\nfn plainly(t: Text) -> Untrusted<Text> ! {{Human}} {{\n  human.ask(\"Is {{t}} right?\", role: accountant)\n}}\n{extra}\nworkflow V(id: Text) -> Untrusted<Text>\n  caps   ErpVendor, ModelStd\n  budget {{ steps: 4 }}\n{{\n{body}\n}}\n"
        )
    };
    let site = |text: &str, path: &str| {
        let r = checked(text);
        assert!(r.ok, "{:?}", shown(&r));
        let f = facts(text, "V");
        let q = f
            .bound
            .questions
            .iter()
            .find(|q| q.path == path)
            .unwrap_or_else(|| panic!("no site at {path}"))
            .clone();
        (
            q.shown.as_str().to_owned(),
            mandate_check::reports::known_name(q.known).to_owned(),
        )
    };
    // The probe: a confidential value handed to a function whose parameter
    // is of a type of no class.
    let direct = program(
        "  let v = erp.vendor_name(id)\n  let w = delegate Writer.write(id)\n  confirm(v)",
        "",
    );
    assert_eq!(
        site(&direct, "/defs/confirm/body/0/value"),
        ("confidential".to_owned(), "external".to_owned())
    );
    // Through another function, which hands its own parameter on.
    let through = program(
        "  let v = erp.vendor_name(id)\n  let w = delegate Writer.write(id)\n  relay(v)",
        "",
    );
    assert_eq!(
        site(&through, "/defs/confirm/body/0/value").0,
        "confidential"
    );
    // A text made of a model's output is typed Text, and is a model's output:
    // the parameter's type would say `plain`, too well known.
    let model = program(
        "  let w = delegate Writer.write(id)\n  plainly(\"{w}\")",
        "",
    );
    assert_eq!(site(&model, "/defs/plainly/body/0/value").1, "model");
    // Called with a constant only: what its type says.
    let constant = program(
        "  let w = delegate Writer.write(id)\n  plainly(\"vendor\")",
        "",
    );
    assert_eq!(
        site(&constant, "/defs/plainly/body/0/value"),
        ("public".to_owned(), "plain".to_owned())
    );
    // A contract's own question shows at least what its verify hands it.
    let contract = program(
        "  let v = erp.vendor_name(id)\n  let w = delegate Writer.write(id)\n  let n = verify Note { text: id } against Asked(v, Note { text: id })\n  v",
        "\ncontract Asked(v: Untrusted<Text>, n: Note) {\n  require len(human.ask(\"Is {v} right?\", role: accountant)) > 0\n  accept ok \"ok\" by static true\n}\n",
    );
    assert_eq!(
        site(&contract, "/defs/Asked/require/0/left/args/0/value").0,
        "confidential"
    );
}

// ── F5: an amendment that raises the bound ────────────────────────────────

#[test]
fn an_amendment_that_raises_the_bound_above_asks_is_refused() {
    // The envelope allows two questions; the body asks one, and a comment on
    // a pull request asks its owner's gate. An amendment that hands the
    // comment to the code owner raises the bound to three.
    let parent_text = "mandate @ 0.7\n\nmodule example.amend @ 0.1\n\nuse std.{human, model, git}\n\nrole platform_lead \"Platform lead\"\nrole accountant \"Accountant\"\nrole code_owner \"Code owner\"\n\ncapability ModelStd = model.infer(tier: standard, max_class: internal)\ncapability Pr       = git.pr(\"example/api\")\n\nagent Writer {\n  role   \"Writes.\"\n  caps   ModelStd\n  budget { time: 2m, steps: 2 }\n  skill write(t: Text) -> Inferred<Text> ! {Model}\n}\n\nworkflow W(t: Text) -> Inferred<Text>\n  envelope {\n    owner   platform_lead\n    caps    ModelStd, Pr\n    budget  { steps: 10, agents: 2, asks: 2 }\n  }\n{\n  let a = human.ask(\"Start {t}?\", role: accountant)\n  let c = effect git.comment(t, \"started\") idempotent_by t\n  delegate Writer.write(t)\n}\n";
    let r = checked(parent_text);
    assert!(r.ok && r.diagnostics.is_empty(), "{:?}", shown(&r));
    let parent = load(parent_text, SourceKind::Mdt).program.unwrap();
    let mut envelope = parent
        .get("defs")
        .and_then(|d| d.get("W"))
        .and_then(|w| w.get("envelope"))
        .and_then(Value::as_object)
        .unwrap()
        .clone();
    let mut approve = mandate_ir::Map::new();
    approve.insert("git.comment", "code_owner");
    envelope.insert("approve", Value::Object(approve));
    let envelope = Value::Object(envelope);
    let a = mandate_check::check_amendment(&mandate_check::AmendmentInput {
        parent: &parent,
        modules: None,
        workflow: "W",
        envelope: Some(&envelope),
        std_patterns: None,
    })
    .unwrap();
    assert!(!a.ok);
    let d: Vec<String> = a
        .diagnostics
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(d, ["MDT-E1906 at /defs/W/envelope/budget/asks"]);
}

// ── F7: each part of the algebra, counted by hand ─────────────────────────

/// The total and each role's count of `W` in `text`.
fn totals(text: &str) -> (Count, Vec<String>) {
    let r = checked(text);
    assert!(r.ok, "{:?}", shown(&r));
    let f = facts(text, "W");
    (f.bound.asks.total, roles(&f))
}

/// `sites_program` with `extra` definitions before the workflow.
fn sites_with(body: &str, extra: &str) -> String {
    sites_program(body).replace("fn confirm(", &format!("{extra}\nfn confirm("))
}

#[test]
fn each_part_of_the_algebra_counts_as_a_hand_count_does() {
    let n = Count::Finite;
    // A map's body by its `max`: an invariant approval in each of 3 items.
    let by_max =
        sites_program("  let m = map it in notes max 3 {\n    verify it against Kept(it)\n  }");
    assert_eq!(totals(&by_max), (n(3), vec!["accountant: 3".to_owned()]));
    // By the envelope's `agents` when it has no `max`: 4 items.
    let by_agents = sites_program(
        "  let m = map it in notes {\n    let w = delegate Writer.write(it.text)\n    verify it against Kept(it)\n  }",
    )
    .replace(
        "  caps   ModelStd, Pr\n  budget {{ steps: 9 }}".replace("{{", "{").replace("}}", "}").as_str(),
        "  envelope {\n    owner   accountant\n    caps    ModelStd, Pr\n    budget  { steps: 9, agents: 4 }\n  }",
    );
    assert_eq!(totals(&by_agents), (n(4), vec!["accountant: 4".to_owned()]));
    // A non-critical effect in a map's body is no batch commit step: its
    // owner's gate, in each of 2 items.
    let effect = sites_with(
        "  let m = map it in notes max 2 {\n    effect note(it.text)\n  }",
        "effect note(t: Text) -> Text\n  requires caps git.pr(\"example/api\")\n",
    );
    assert_eq!(totals(&effect), (n(2), vec!["owner: 2".to_owned()]));
    // A switch: the larger case.
    let switch = sites_with(
        "  let x = switch m {\n    Fast => human.ask(\"Fast?\", role: accountant)\n    Slow => {\n      let a = human.ask(\"Slow?\", role: finance_lead)\n      human.ask(\"Sure?\", role: finance_lead)\n    }\n  }",
        "type Mode = Fast | Slow\n",
    )
    .replace("t: Text) -> Text", "t: Text, m: Mode) -> Text");
    assert_eq!(
        totals(&switch),
        (
            n(2),
            vec!["accountant: 1".to_owned(), "finance_lead: 2".to_owned()]
        )
    );
    // A loop's condition, at each of its rounds (IR: max_iter and until).
    let looped = sites_program("  loop max_iter 3 {\n    let x = 1\n  }");
    let mut ir = load(&looped, SourceKind::Mdt).program.unwrap();
    let until = parse(
        r#"{"op":"binary","bop":">","left":{"op":"call","callee":{"op":"var","name":"len"},"args":[{"value":{"op":"call","callee":{"op":"field","of":{"op":"var","name":"human"},"name":"ask"},"args":[{"value":{"op":"text","value":"Done?"}},{"name":"role","value":{"op":"var","name":"accountant"}}]}}]},"right":{"op":"int","value":0}}"#,
    )
    .unwrap()
    .value;
    set_in(&mut ir, &["defs", "W", "body", "0"], "until", until);
    let ir_text = stringify(&JsValue::from(&ir)).unwrap();
    let f = attention_facts(&ir_text, SourceKind::Json, &CheckOptions::default(), "W").unwrap();
    assert_eq!(f.bound.asks.total, n(3));
    // `ensures`, once at the end of the run.
    let ensures = sites_program("  let x = 1").replace(
        "  budget { steps: 9 }\n{",
        "  budget { steps: 9 }\n  ensures len(human.ask(\"Fine?\", role: accountant)) > 0\n{",
    );
    assert_eq!(totals(&ensures), (n(1), vec!["accountant: 1".to_owned()]));
    // A question in a contract's `require`, and in a verifier's arguments,
    // at each verify.
    let require = sites_with(
        "  let a = verify n against Asked(n)\n  let b = verify n against Asked(n)",
        "contract Asked(n: Note) {\n  require len(human.ask(\"Is {n.text} right?\", role: finance_lead)) > 0\n  accept ok \"approved\" by human.approve(role: accountant, note: human.ask(\"Why?\", role: finance_lead))\n}\n",
    );
    assert_eq!(
        totals(&require),
        (
            n(6),
            vec!["accountant: 2".to_owned(), "finance_lead: 4".to_owned()]
        )
    );
    // restart_all nested through a function: twice twice.
    let nested = sites_with(
        "  par supervise restart_all {\n    a = again(t)\n  }",
        "fn again(t: Text) -> Text ! {Human} {\n  par supervise restart_all {\n    b = human.ask(\"Again?\", role: accountant)\n  }\n  t\n}\n",
    );
    assert_eq!(totals(&nested), (n(4), vec!["accountant: 4".to_owned()]));
    // The envelope's `approve`, and without it an irreversible effect goes to
    // `owner`; its owner's gate either way.
    let text = read_text(ASKS).unwrap();
    let planning = facts(&text, "Planning");
    let merge = planning
        .bound
        .questions
        .iter()
        .find(|q| q.kind == SiteKind::Effect)
        .unwrap();
    assert_eq!(merge.role.as_deref(), Some("release_manager"));
    let unapproved = text.replace("    approve git.merge by release_manager\n", "");
    let planning = facts(&unapproved, "Planning");
    let merge = planning
        .bound
        .questions
        .iter()
        .find(|q| q.kind == SiteKind::Effect)
        .unwrap();
    assert_eq!(merge.role.as_deref(), Some("owner"));
    assert_eq!(planning.bound.asks.total, n(5));
    // A plan is a row of its own: the total without it is the same.
    let without_plan = text.replace(
        "  stage finish \"Plan the rest\"\n  plan Lead.finish(t) within envelope\n",
        "  stage finish \"Plan the rest\"\n  delegate Writer.write(t)\n",
    );
    let planning = facts(&without_plan, "Planning");
    assert!(planning.bound.plans.is_empty());
    assert_eq!(planning.bound.asks.total, n(5));
}

/// `v` at `path` gets the member `key`.
fn set_in(v: &mut Value, path: &[&str], key: &str, value: Value) {
    let mut at = v;
    for t in path {
        at = match at {
            Value::Array(a) => &mut a[t.parse::<usize>().unwrap()],
            Value::Object(m) => m.get_mut(t).unwrap(),
            _ => panic!("{t}"),
        };
    }
    let Value::Object(m) = at else { panic!() };
    m.insert(key, value);
}

// ── G1, G5: what the program reaches in another module ────────────────────

/// A module of 0.6 whose contract and function name a role by a name a
/// parameter of theirs also has, and a function that reaches the contract.
const LIB: &str = "mandate @ 0.6\n\nmodule example.lib @ 0.1\n\nuse std.{human}\n\npub role accountant \"Accountant\"\n\npub type Note = { text: Text }\n\n/// The role that approves is named by a parameter of a role's name.\npub contract C(n: Note, accountant: Text) {\n  accept ok \"approved\" by human.approve(role: accountant)\n}\n\n/// Asks a role a parameter's name shadows.\npub fn ask(n: Note, accountant: Text) -> Untrusted<Text> ! {Human} {\n  human.ask(\"Is {n.text} right?\", role: accountant)\n}\n\n/// Verifies against C: the program reaches C through it.\npub fn checked(n: Note) -> Bool ! {Human} {\n  let v = verify n against C(n, \"x\")\n  true\n}\n";

/// A module of 0.6 with a cycle through a contract (0.6 has no such E0502),
/// and one of functions alone (E0502 in every language).
const CYC: &str = "mandate @ 0.6\n\nmodule example.cyc @ 0.1\n\nuse std.{human}\n\npub role accountant \"Accountant\"\n\npub type Note = { text: Text }\n\npub contract C(n: Note) {\n  require again(n)\n  accept ok \"ok\" by static true\n}\n\npub fn again(n: Note) -> Bool ! {Human} {\n  let a = human.ask(\"Again {n.text}?\", role: accountant)\n  let v = verify n against C(n)\n  true\n}\n\npub fn f(n: Note) -> Bool ! {Human} {\n  g(n)\n}\n\npub fn g(n: Note) -> Bool ! {Human} {\n  f(n)\n}\n";

/// A program of `language` that imports `names` of `module` and runs
/// `body` in `W` (with `budget`).
fn importer(language: &str, module: &str, names: &str, budget: &str, body: &str) -> String {
    format!(
        "mandate @ {language}\n\nmodule example.importer @ 0.1\n\nuse std.{{human, model}}\nuse {module}.{{{names}}}\n\ncapability ModelStd = model.infer(tier: standard, max_class: internal)\n\nworkflow W(n: Note) -> Bool\n  caps   ModelStd\n  budget {{ {budget} }}\n{{\n{body}\n  true\n}}\n"
    )
}

/// The program `text` checked with the modules `mods`.
fn checked_with(text: &str, mods: &[&str]) -> CheckResult {
    let mut m = mandate_check::Modules::new();
    for t in mods {
        let p = load(t, SourceKind::Mdt).program.unwrap();
        let name = p.get("module").and_then(Value::as_str).unwrap().to_owned();
        m.insert(name, p);
    }
    let opts = CheckOptions {
        modules: Some(&m),
        ..CheckOptions::default()
    };
    check(text, SourceKind::Mdt, &opts)
}

/// `code at path` of each error.
fn errors(r: &CheckResult) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d.severity == mandate_ir::Severity::Error)
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// The facts of the first diagnostic of `code`.
fn facts_of(r: &CheckResult, code: &str) -> JsObject {
    r.diagnostics
        .iter()
        .find(|d| d.code == code)
        .and_then(|d| d.facts.clone())
        .unwrap_or_else(|| panic!("no {code}: {:?}", errors(r)))
}

fn str_fact(f: &JsObject, key: &str) -> Option<String> {
    f.get(key).and_then(JsValue::as_str).map(str::to_owned)
}

#[test]
fn a_question_another_module_defines_is_the_programs_where_the_program_reaches_it() {
    let lib7 = LIB.replace("mandate @ 0.6", "mandate @ 0.7");
    let names = "C, Note, accountant, ask, checked";
    for module in [LIB, lib7.as_str()] {
        // A verify against the contract: E1501 at the verify, naming the
        // contract, its module and the place in it.
        let text = importer(
            "0.7",
            "example.lib",
            names,
            "steps: 2",
            "  let v = verify n against C(n, \"finance_lead\")",
        );
        let r = checked_with(&text, &[module]);
        assert_eq!(errors(&r), ["MDT-E1501 at /defs/W/body/0/value"]);
        let f = facts_of(&r, "MDT-E1501");
        assert_eq!(str_fact(&f, "definition").as_deref(), Some("C"));
        assert_eq!(str_fact(&f, "module").as_deref(), Some("example.lib"));
        assert_eq!(
            str_fact(&f, "at").as_deref(),
            Some("/defs/C/accept/ok/by/call/args/0/value")
        );
        assert_eq!(str_fact(&f, "shadowed_by").as_deref(), Some("parameter"));
        assert!(
            r.diagnostics
                .iter()
                .any(|d| d.message.contains("It is in C of the module example.lib")),
            "{:?}",
            shown(&r)
        );
        // A call of the function: at the call.
        let text = importer(
            "0.7",
            "example.lib",
            names,
            "steps: 2",
            "  let a = ask(n, \"finance_lead\")",
        );
        let r = checked_with(&text, &[module]);
        assert_eq!(errors(&r), ["MDT-E1501 at /defs/W/body/0/value"]);
        let f = facts_of(&r, "MDT-E1501");
        assert_eq!(str_fact(&f, "definition").as_deref(), Some("ask"));
        assert_eq!(
            str_fact(&f, "at").as_deref(),
            Some("/defs/ask/body/0/value/args/1/value")
        );
        // Through a function of the module that verifies against it: at the
        // call of that function, the contract named.
        let text = importer(
            "0.7",
            "example.lib",
            names,
            "steps: 2",
            "  let c = checked(n)",
        );
        let r = checked_with(&text, &[module]);
        assert_eq!(errors(&r), ["MDT-E1501 at /defs/W/body/0/value"]);
        assert_eq!(
            str_fact(&facts_of(&r, "MDT-E1501"), "definition").as_deref(),
            Some("C")
        );
    }
    // A program of 0.6 that does the same with the 0.6 module gets what it
    // got: nothing.
    let text = importer(
        "0.6",
        "example.lib",
        names,
        "steps: 2",
        "  let v = verify n against C(n, \"finance_lead\")\n  let a = ask(n, \"finance_lead\")",
    );
    let r = checked_with(&text, &[LIB]);
    assert!(errors(&r).is_empty(), "{:?}", errors(&r));
    // The module checked on its own: as before in 0.6, refused in 0.7.
    assert!(
        errors(&checked(LIB)).is_empty(),
        "{:?}",
        errors(&checked(LIB))
    );
    assert_eq!(
        errors(&checked(&lib7)),
        [
            "MDT-E1501 at /defs/C/accept/ok/by/call/args/0/value",
            "MDT-E1501 at /defs/ask/body/0/value/args/1/value"
        ]
    );
}

#[test]
fn a_cycle_another_module_defines_is_reported_where_the_program_reaches_it() {
    let names = "C, Note, accountant, again, f";
    // Through a contract: E0502 of 0.7, at the verify.
    let text = importer(
        "0.7",
        "example.cyc",
        names,
        "steps: 2",
        "  let v = verify n against C(n)",
    );
    let r = checked_with(&text, &[CYC]);
    let found = errors(&r);
    assert!(
        found.contains(&"MDT-E0502 at /defs/W/body/0/value".to_owned()),
        "{found:?}"
    );
    assert!(
        !found.iter().any(|d| d.contains(" at /defs/C")),
        "{found:?}"
    );
    let e = r
        .diagnostics
        .iter()
        .find(|d| {
            d.code == "MDT-E0502"
                && d.facts
                    .as_ref()
                    .is_some_and(|f| str_fact(f, "definition").as_deref() == Some("C"))
        })
        .unwrap();
    let f = e.facts.as_ref().unwrap();
    assert_eq!(str_fact(f, "module").as_deref(), Some("example.cyc"));
    assert_eq!(str_fact(f, "at").as_deref(), Some("/defs/C"));
    // With asks declared, the question the cycle reaches is E1907 there too.
    let text = importer(
        "0.7",
        "example.cyc",
        names,
        "steps: 2, asks: 1",
        "  let v = verify n against C(n)",
    );
    let r = checked_with(&text, &[CYC]);
    let e1907 = r
        .diagnostics
        .iter()
        .find(|d| d.code == "MDT-E1907")
        .unwrap_or_else(|| panic!("{:?}", errors(&r)));
    assert_eq!(e1907.at.path.as_deref(), Some("/defs/W/body/0/value"));
    let f = e1907.facts.as_ref().unwrap();
    assert_eq!(str_fact(f, "why").as_deref(), Some("recursion"));
    assert_eq!(str_fact(f, "definition").as_deref(), Some("again"));
    assert_eq!(
        str_fact(f, "at").as_deref(),
        Some("/defs/again/body/0/value")
    );
    // A cycle of functions alone: in 0.6 at the module's definition, as
    // before; in 0.7 at the call.
    let six = importer("0.6", "example.cyc", names, "steps: 2", "  let x = f(n)");
    let r6 = checked_with(&six, &[CYC]);
    assert!(
        errors(&r6).contains(&"MDT-E0502 at /defs/f".to_owned()),
        "{:?}",
        errors(&r6)
    );
    let seven = importer("0.7", "example.cyc", names, "steps: 2", "  let x = f(n)");
    let r7 = checked_with(&seven, &[CYC]);
    assert!(
        errors(&r7).contains(&"MDT-E0502 at /defs/W/body/0/value".to_owned()),
        "{:?}",
        errors(&r7)
    );
    // A 0.6 program that reaches the cycle through the contract: no E0502
    // for it, as before (0.6 has no cycle through a contract).
    let six = importer(
        "0.6",
        "example.cyc",
        names,
        "steps: 2",
        "  let v = verify n against C(n)",
    );
    let r6 = checked_with(&six, &[CYC]);
    assert!(
        !errors(&r6)
            .iter()
            .any(|d| d.starts_with("MDT-E0502 at /defs/C") || d.starts_with("MDT-E0502 at /defs/W")),
        "{:?}",
        errors(&r6)
    );
}

// ── G4: how a value is known travels with it ──────────────────────────────

const KNOWN: &str = "mandate @ 0.7\n\nmodule example.known @ 0.1\n\nuse std.{human, model, tool}\n\nrole accountant \"Accountant\"\n\ntype Note = { text: Text }\n\nconnector erp = mcp(\"https://erp.example.com/mcp\")\n  version \"1.0\"\n  class   confidential\n{\n  tool vendor_name(vendor_id: Text) -> Untrusted<Text>\n    read_only\n}\n\ncapability ErpVendor = tool.call(erp, vendor_name)\ncapability ModelStd  = model.infer(tier: standard, max_class: confidential)\n\n/// A model's text, typed Text.\nfn summary(id: Text) -> Text ! {Model} {\n  let w = infer Text from id using ModelStd\n  \"{w}\"\n}\n\n/// Hands back the text it is given.\nfn keep(t: Text) -> Text ! {} {\n  t\n}\n\n/// Hands back the text it is given, by a return.\nfn early(t: Text) -> Text ! {} {\n  return \"{t}\"\n}\n\ncontract Seen(n: Note) {\n  accept seen \"Seen\" by human.approve(role: accountant)\n}\n\nworkflow W(id: Text) -> Untrusted<Text>\n  caps   ErpVendor, ModelStd\n  budget { steps: 4 }\n{\n  let v = erp.vendor_name(id)\n  let k = \"{v}\"\n  let a = human.ask(\"Kept {k}?\", role: accountant)\n  let m = summary(id)\n  let b = human.ask(\"Model {m}?\", role: accountant)\n  let c = human.ask(\"Kept {keep(k)}?\", role: accountant)\n  let r = early(k)\n  let d = human.ask(\"Early {r}?\", role: accountant)\n  let s = verify Note { text: k } against Seen(Note { text: k })\n  let e = human.ask(\"Count {len([k])}?\", role: accountant)\n  report to accountant \"Known\" { kept: k, model: m, count: len([k]), seen: s.text }\n  a\n}\n";

#[test]
fn a_value_is_known_as_what_it_is_made_of_through_bindings_and_functions() {
    use mandate_check::ty::Level;
    let r = checked(KNOWN);
    assert!(r.ok, "{:?}", shown(&r));
    let f = facts(KNOWN, "W");
    let known = |path: &str| {
        let q = f
            .bound
            .questions
            .iter()
            .find(|q| q.path == path)
            .unwrap_or_else(|| panic!("{path}"));
        (q.known, q.shown.as_str())
    };
    // A binding of a template of a tool's output: outside content, of the
    // connector's class (before, `plain`).
    assert_eq!(
        known("/defs/W/body/2/value"),
        (Level::Untrusted, "confidential")
    );
    // A function's Text made of a model's output.
    assert_eq!(known("/defs/W/body/4/value"), (Level::Inferred, "public"));
    // A function's result, handed outside content: no better than it, by
    // its last value and by a return.
    assert_eq!(
        known("/defs/W/body/5/value"),
        (Level::Untrusted, "confidential")
    );
    assert_eq!(
        known("/defs/W/body/7/value"),
        (Level::Untrusted, "confidential")
    );
    // A count is the run's own.
    assert_eq!(known("/defs/W/body/9/value").0, Level::Plain);
    // A report's fields are known the same way; a verified value starts
    // again.
    let fields: Vec<(String, Level)> = f.reports[0]
        .fields
        .iter()
        .map(|x| (x.name.clone(), x.shown.known))
        .collect();
    assert_eq!(
        fields,
        [
            ("kept".to_owned(), Level::Untrusted),
            ("model".to_owned(), Level::Inferred),
            ("count".to_owned(), Level::Plain),
            ("seen".to_owned(), Level::Plain),
        ]
    );
}

/// A function that reads a confidential row itself and hands it back as
/// `Text`, its result handed to a model that may see public data only.
const READS: &str = "mandate @ 0.7\n\nmodule example.reads @ 0.1\n\nuse std.{data, model, human}\n\nrole accountant \"Accountant\"\nrole core_owner \"Core owner\"\n\ntype CustomerName = Text classified confidential\ntype Row = { tracking_no: Text, full_name: CustomerName }\n\ncomponent core {\n  repo  \"acme/core\"\n  root  \"/work/acme-core\"\n  lang  java\n  owner role \"core_owner\"\n}\n\nenvironment prod_sim {\n  class confidential\n  read customers from core\n    sql \"select tracking_no, full_name from customers where tracking_no = :tracking_no\"\n    params (tracking_no: Text)\n    returns Row\n    max_rows 1\n}\n\ncapability Reads    = data.read(prod_sim, customers)\ncapability ModelPub = model.infer(tier: standard, max_class: public)\n\n/// Reads a customer's row and hands back its text, typed Text.\nfn text_of(t: Text) -> Text ! {Data.Read} {\n  let rows = data.read(prod_sim.customers, tracking_no: t, max_class: confidential)\n  \"{rows}\"\n}\n\nworkflow ViaText(t: Text) -> Inferred<Text>\n  caps   Reads, ModelPub\n  budget { steps: 4 }\n{\n  let n = text_of(t)\n  let q = human.ask(\"Is {n} right?\", role: accountant)\n  infer Text from n using ModelPub\n}\n";

#[test]
fn a_functions_result_is_of_the_class_of_what_it_returns_in_0_7() {
    // 0.7: the confidential row the function returns keeps its class.
    let r = checked(READS);
    assert_eq!(errors(&r), ["MDT-E0220 at /defs/ViaText/body/2/value"]);
    let asked = READS.replace(
        "  infer Text from n using ModelPub\n",
        "  infer Text from \"public\" using ModelPub\n",
    );
    let f = facts(&asked, "ViaText");
    assert_eq!(f.bound.questions[0].shown.as_str(), "confidential");
    // 0.6 as well since 2026-11-18 (spec/attention.md, the security note):
    // the same function's result was of its arguments' class alone, public,
    // and the model was handed the row unrefused; it is refused now, the
    // one 0.6 diagnostic that changed after release (more routes in
    // tests/class_0_6.rs).
    let six = READS.replace("mandate @ 0.7", "mandate @ 0.6").replace(
        "  let q = human.ask(\"Is {n} right?\", role: accountant)\n",
        "",
    );
    let r6 = checked(&six);
    assert_eq!(errors(&r6), ["MDT-E0220 at /defs/ViaText/body/1/value"]);
}

// ── G6, G3: what a verify's, a review's and a plan's row say ──────────────

/// The rows of `list` of `workflow` of `text`, as the facts write them.
fn rows_js(text: &str, workflow: &str, list: &str) -> Vec<Value> {
    let f = facts(text, workflow);
    let v = parse(&stringify(&f.to_js()).unwrap()).unwrap().value;
    v.get(list)
        .and_then(Value::as_array)
        .unwrap_or_default()
        .to_vec()
}

/// The texts of the array `key` of `row`.
fn texts<'v>(row: &'v Value, key: &str) -> Vec<&'v str> {
    row.get(key)
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .collect()
}

#[test]
fn a_verify_names_its_criterion_and_a_review_its_items_and_waivers() {
    let text = read_text(ASKS).unwrap();
    // A verify's rows: the contract and the criterion, as written.
    let approving = rows_js(&text, "Approving", "questions");
    let named: Vec<(String, String)> = approving
        .iter()
        .filter(|q| q.get("kind").and_then(Value::as_str) == Some("verify"))
        .map(|q| {
            (
                q.get("contract")
                    .and_then(Value::as_str)
                    .unwrap()
                    .to_owned(),
                q.get("criterion")
                    .and_then(Value::as_str)
                    .unwrap()
                    .to_owned(),
            )
        })
        .collect();
    assert!(
        named.contains(&("Approved".to_owned(), "checked".to_owned())),
        "{named:?}"
    );
    assert!(
        named.contains(&("Approved".to_owned(), "kept".to_owned())),
        "{named:?}"
    );
    // A review's rows: its items and the criteria it may waive; no other
    // row has these members, nor a verify's.
    let planning = rows_js(&text, "Planning", "questions");
    let mut reviews = 0;
    for q in &planning {
        let kind = q.get("kind").and_then(Value::as_str).unwrap();
        let has = |k: &str| q.get(k).is_some();
        assert_eq!(
            has("contract") && has("criterion"),
            kind == "verify",
            "{kind}"
        );
        assert_eq!(has("items") || has("waivable"), kind == "review", "{kind}");
        if kind == "review" {
            assert_eq!(q.get("items").and_then(Value::as_i64), Some(4));
            assert_eq!(texts(q, "waivable"), ["Short.short"]);
            reviews += 1;
        }
    }
    assert_eq!(reviews, 2);
    // The criteria in the order of the program, not of their names; and
    // the envelope's agents (4) when the map has no max, which a map whose
    // body delegates may lack (E1702 otherwise).
    let more = text
        .replace(
            "  accept short \"The note is short\" by static true\n    waive by accountant, finance_lead\n",
            "  accept short \"The note is short\" by static true\n    waive by accountant, finance_lead\n  accept alpha \"The note is plain\" by static true\n    waive by accountant, finance_lead\n",
        )
        .replace(
            "  let checked = map it in notes max 4 {\n    verify it against Short(it)",
            "  let checked = map it in notes {\n    let w = delegate Writer.write(it.text)\n    verify it against Short(it)",
        )
        .replace(
            "  plan Lead.finish(t) within envelope\n",
            "  infer Text from t using ModelStd\n",
        );
    assert!(checked(&more).ok, "{:?}", shown(&checked(&more)));
    let planning = rows_js(&more, "Planning", "questions");
    let review = planning
        .iter()
        .find(|q| q.get("kind").and_then(Value::as_str) == Some("review"))
        .unwrap();
    assert_eq!(texts(review, "waivable"), ["Short.short", "Short.alpha"]);
    assert_eq!(review.get("items").and_then(Value::as_i64), Some(4));
    // A review whose map has a max of its own: that max.
    let sixty = text.replace(
        "  let checked = map it in notes max 4 {",
        "  let checked = map it in notes max 3 {",
    );
    let review = rows_js(&sixty, "Planning", "questions")
        .into_iter()
        .find(|q| q.get("kind").and_then(Value::as_str) == Some("review"))
        .unwrap();
    assert_eq!(review.get("items").and_then(Value::as_i64), Some(3));
    // A plan's row: the static form of its amendment request's wait.
    let plans = rows_js(&text, "Planning", "plans");
    assert_eq!(plans.len(), 1);
    assert_eq!(
        plans[0].get("wait").and_then(Value::as_str),
        Some("/defs/Planning/body/7/value/amendment")
    );
    assert_eq!(
        plans[0].get("path").and_then(Value::as_str),
        Some("/defs/Planning/body/7/value")
    );
    // The rows these do not apply to keep the members they had.
    let asking = rows_js(&text, "Asking", "questions");
    for q in &asking {
        let keys: Vec<&str> = q
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, _)| k)
            .filter(|k| *k != "escalates")
            .collect();
        assert_eq!(
            keys,
            [
                "path",
                "wait",
                "kind",
                "role",
                "shown",
                "known",
                "deadline_ms",
                "on_no_answer",
                "stage",
                "multiplicity",
                "only"
            ]
        );
    }
}

// ── G2: a run's authorization is tagged by the rule, which the facts serve ──

#[test]
fn an_authorization_names_one_row_whatever_its_suffix() {
    let text = read_text(ASKS).unwrap();
    let ir = load(&text, SourceKind::Mdt).program.unwrap();
    let mut seen = 0;
    for (w, d) in ir.get("defs").and_then(Value::as_object).unwrap().iter() {
        if d.get("kind").and_then(Value::as_str) != Some("workflow") {
            continue;
        }
        let f = facts(&text, w);
        let b = &f.bound;
        let authorizing = |q: &&mandate_check::asks::QuestionFact| {
            matches!(
                q.kind,
                SiteKind::Effect | SiteKind::Changeset | SiteKind::Governance
            )
        };
        // A kind and a path name one row.
        let mut keys: Vec<(SiteKind, &str)> = Vec::new();
        for q in b.questions.iter().filter(authorizing) {
            assert!(
                !keys.contains(&(q.kind, q.path.as_str())),
                "{w}: {} at {} twice",
                q.kind.as_str(),
                q.path
            );
            keys.push((q.kind, q.path.as_str()));
        }
        // Every effect's and member's authorization and gate has one
        // effects row by its path; a change set's own approval, which the
        // configuration does not change, has none.
        for q in b.questions.iter().filter(authorizing) {
            let set = q.kind == SiteKind::Changeset && !q.path.contains("/members/");
            assert_eq!(
                b.effects.iter().filter(|e| e.path == q.path).count(),
                usize::from(!set),
                "{w}: {} at {}",
                q.kind.as_str(),
                q.path
            );
            seen += 1;
        }
        // The rule, for every effect: its owner's gate is its governance
        // row when it has one, its authorization by a role its questions
        // row when the total counts it, else its effects row.
        for e in &b.effects {
            let gates = b
                .questions
                .iter()
                .filter(|q| q.kind == SiteKind::Governance && q.path == e.path)
                .count();
            assert!(gates <= 1, "{w}: {}", e.path);
            let by_role = b
                .questions
                .iter()
                .filter(|q| {
                    matches!(q.kind, SiteKind::Effect | SiteKind::Changeset) && q.path == e.path
                })
                .count();
            assert_eq!(by_role, usize::from(e.counted), "{w}: {}", e.path);
        }
    }
    println!("authorizations: {seen} rows, each one by its kind and path");
    assert!(seen >= 5);
}
