//! The attention view of language 0.7 (spec/attention.md "The attention
//! view"): its wording on the fixtures of `fixtures/attention/`, what it
//! says of a bound, a plan, an escalation, an owner and a lock, that it
//! escapes what an author wrote, the door `attention` and the document of
//! a program. No TypeScript reads 0.7, so every expectation is written by
//! hand; the golden file `vectors/golden/0.7.json` and the vectors of
//! `vectors/attention-0.7/` pin the outputs.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeSet;

use mandate_check::asks::OnNoAnswer;
use mandate_check::ty::Level;
use mandate_check::{CheckOptions, SiteKind};
use mandate_ir::{JsValue, Value, parse, stringify};
use mandate_syntax::{SourceKind, kind_of, load};
use mandate_testkit::json_doors::{Answer, JsonDoor, check_table, resolve};
use mandate_testkit::{read_json, read_text};
use mandate_views::json_doors::{RUST_DOORS, rust_door};
use mandate_views::{
    AttentionView, attention_blocks, attention_doc, attention_view, if_no_answer, known_text,
    program_doc, to_html, to_markdown, what_is_asked,
};

const VIEW: &str = "fixtures/attention/view.mdt";
const VIEW_LOCK: &str = "fixtures/attention/view.lock.json";
const OWNER: &str = "fixtures/attention/owner.mdt";
const OWNER_LOCK: &str = "fixtures/attention/owner.lock.json";
const REPORTS: &str = "fixtures/attention/reports.mdt";
const ASKS: &str = "fixtures/attention/asks.mdt";
const DIR: &str = "crates/mandate-views/tests/rust_doors";

fn view_of_text(text: &str, workflow: &str, lock: Option<&Value>) -> AttentionView {
    let opts = CheckOptions {
        lock,
        ..CheckOptions::default()
    };
    attention_view(text, SourceKind::Mdt, &opts, workflow)
        .unwrap_or_else(|| panic!("{workflow} has no view"))
}

fn view(file: &str, workflow: &str, lock: Option<&str>) -> AttentionView {
    let lock = lock.map(|l| read_json(l).unwrap());
    view_of_text(&read_text(file).unwrap(), workflow, lock.as_ref())
}

fn md(file: &str, workflow: &str, lock: Option<&str>) -> String {
    to_markdown(&attention_doc(&view(file, workflow, lock)))
}

fn html(file: &str, workflow: &str, lock: Option<&str>) -> String {
    to_html(&attention_doc(&view(file, workflow, lock)))
}

/// The lines of `text` that start with `start`.
fn line<'a>(text: &'a str, start: &str) -> &'a str {
    text.lines()
        .find(|l| l.starts_with(start))
        .unwrap_or_else(|| panic!("no line starts with {start:?} in\n{text}"))
}

// ── the closed lists ─────────────────────────────────────────────────────

#[test]
fn every_kind_of_question_and_every_outcome_has_its_sentence() {
    // The matches that give them are exhaustive, with no catch-all arm, so a
    // kind added to the facts does not compile without one; this holds that
    // they say something, and something of their own.
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for kind in SiteKind::ALL {
        for effect in [None, Some("erp.post_draft")] {
            let s = what_is_asked(*kind, effect);
            assert!(!s.trim().is_empty(), "{kind:?}");
            if effect.is_some() {
                seen.insert(s);
            }
        }
    }
    // Plain kinds say the same with or without a name; every other kind's
    // sentence is its own.
    let plain: BTreeSet<String> = SiteKind::ALL
        .iter()
        .map(|k| what_is_asked(*k, Some("erp.post_draft")))
        .collect();
    assert_eq!(
        plain.len(),
        SiteKind::ALL.len(),
        "two kinds share a sentence"
    );
    assert!(seen.contains(&what_is_asked(SiteKind::Effect, Some("erp.post_draft"))));
    assert!(what_is_asked(SiteKind::Effect, Some("erp.post_draft")).contains("erp.post_draft"));
    assert!(what_is_asked(SiteKind::Governance, Some("erp.post_draft")).contains("governance"));

    let outcomes = [
        OnNoAnswer::Waits,
        OnNoAnswer::Unmet,
        OnNoAnswer::Escalates {
            to: "finance_lead".to_owned(),
            deadline_ms: Some(86_400_000),
        },
        OnNoAnswer::Declined,
        OnNoAnswer::RefusedToLead,
    ];
    let words: BTreeSet<String> = outcomes.iter().map(if_no_answer).collect();
    assert_eq!(words.len(), outcomes.len());
    assert_eq!(
        if_no_answer(&outcomes[2]),
        "It goes to finance_lead, who has 1 day of their own"
    );
    assert_eq!(
        if_no_answer(&OnNoAnswer::Escalates {
            to: "x".to_owned(),
            deadline_ms: None
        }),
        "It goes to x, who has no deadline of their own"
    );

    let known: BTreeSet<&str> = [
        Level::Verified,
        Level::Plain,
        Level::Inferred,
        Level::Untrusted,
    ]
    .into_iter()
    .map(known_text)
    .collect();
    assert_eq!(known.len(), 4);
    assert!(known.contains("counted or given by the run"));
    assert!(known.contains("a model's output"));
    assert!(known.contains("outside content"));
    assert!(known.contains("verified"));
}

// ── the wording ──────────────────────────────────────────────────────────

#[test]
fn the_invoice_flow_reads_as_the_spec_says() {
    // `view.mdt`'s Settle is the invoice flow's review written out, with an
    // owner; its lock binds `ana` to the accountant and `ben` to the
    // finance lead, here each up to confidential.
    let mut lock = read_json(VIEW_LOCK).unwrap();
    let Value::Object(o) = &mut lock else {
        panic!("a lock is an object")
    };
    o.insert(
        "role_classes",
        parse(r#"{"accountant":"confidential","finance_lead":"confidential"}"#)
            .unwrap()
            .value,
    );
    let v = view_of_text(&read_text(VIEW).unwrap(), "Settle", Some(&lock));
    let text = to_markdown(&attention_doc(&v));
    assert!(text.starts_with("# Attention: Settle\n"), "{text}");
    assert!(text.contains("Stages: Work on each item · Decide on the exceptions · Settled"));
    assert!(text.contains(
        "At most 2 questions in all (asks: 2). Its card is approved, and it is promoted, by accountant (ana)."
    ));
    assert_eq!(
        line(&text, "| accountant | ana "),
        "| accountant | ana | up to confidential | Decide on the exceptions | Waive or decline the open items of the batch (Fits.same may be waived); one decision about up to 20 items | 1 decision | 1 day from when it is asked | It goes to finance\\_lead, who has 1 day of their own |"
    );
    assert_eq!(
        line(&text, "| finance\\_lead | ben "),
        "| finance\\_lead | ben | up to confidential | Decide on the exceptions, only after the accountant's deadline | The same decision | 1 decision | 1 day from the escalation, which comes at the first tick after the accountant's deadline | Every open item is declined, by nobody, and the run goes on with the items that were accepted |"
    );
    assert!(text.contains("What it tells whom:"));
    assert_eq!(
        line(&text, "| accountant | Settled "),
        "| accountant | Settled | Settled | accepted, declined, failed (Int · public · counted or given by the run) |"
    );
    // A lock was given: no sentence about its absence.
    assert!(!text.contains("No lock was given"));
    // The configuration may add authorizations.
    assert!(text.contains("The runtime's configuration may add authorizations by a person that this program does not name"));
    assert!(text.contains("does not start"));
    assert!(text.contains("not the count of each role"));
}

#[test]
fn the_reports_of_the_invoice_flow_say_class_and_how_each_field_is_known() {
    let text = md(REPORTS, "MatchAll", None);
    assert!(text.starts_with("# Attention: MatchAll\n"), "{text}");
    assert!(text.contains(
        "Stages: Collect the items · Work on each item · Decide on the exceptions · Commit what was accepted"
    ));
    // No owner in this program: the view says so and does not invent one.
    assert!(text.contains("At most 2 questions in all; no bound is declared"));
    assert!(text.contains("It names no owner, so no role approves its card."));
    assert_eq!(
        line(&text, "| accountant | Collect the items "),
        "| accountant | Collect the items | Items collected | items (Int · confidential · counted or given by the run) |"
    );
    assert_eq!(
        line(&text, "| accountant | Commit what was accepted "),
        "| accountant | Commit what was accepted | Batch done | posted, declined, failed (Int · confidential · counted or given by the run) |"
    );
    // A report in a loop says how many times at most.
    let text = md("fixtures/attention/reports.mdt", "Greet", None);
    assert!(text.contains("One round (at most 3 times)"), "{text}");
    assert!(text.contains("a model's output"), "{text}");
    assert!(text.contains("outside content"), "{text}");
    assert!(text.contains("verified"), "{text}");
}

#[test]
fn a_declared_bound_an_owner_and_the_ladder_are_said() {
    let text = md(VIEW, "Settle", Some(VIEW_LOCK));
    assert!(
        text.contains("At most 2 questions in all (asks: 2). Its card is approved, and it is promoted, by accountant (ana)."),
        "{text}"
    );
    assert!(line(&text, "| finance\\_lead | ben | up to confidential |").contains("1 decision"));
    // The observer is not in `role_classes`: internal, as the spec says.
    let notify = md(VIEW, "Notify", Some(VIEW_LOCK));
    assert!(line(&notify, "| observer | cai | up to internal |").contains("Answer a question"));
    assert!(line(&text, "| accountant | ana | up to confidential |").contains("1 decision"));
}

#[test]
fn a_question_that_asks_no_role_notifies_the_owner() {
    let text = md(VIEW, "Notify", Some(VIEW_LOCK));
    assert!(
        line(&text, "| no role |")
            .contains("no role is asked; the owner, finance\\_lead (ben), is notified"),
        "{text}"
    );
    // Without an owner nobody is notified, and the lock's roles can list it.
    let text = md(REPORTS, "MatchAll", None);
    assert!(text.contains("with no owner, nobody is notified"), "{text}");
}

#[test]
fn rows_of_the_budget_handler_are_not_part_of_the_total_and_are_not_bounded() {
    let text = md(REPORTS, "MatchAll", None);
    let row = line(&text, "| no role |");
    assert!(row.contains(
        "only if the budget runs out, and again each time it runs out after an answer that does not raise the limits"
    ));
    assert!(row.contains("not bounded (once each time it runs out)"));
    // The total stays what the body asks.
    assert!(text.contains("At most 2 questions in all"));
    let v = view(REPORTS, "MatchAll", None);
    assert_eq!(
        v.questions
            .iter()
            .filter(|r| r.only == Some(mandate_check::asks::Only::BudgetExceeded))
            .count(),
        1
    );
}

#[test]
fn without_a_lock_no_member_is_invented() {
    let text = md(REPORTS, "MatchAll", None);
    assert!(text.contains(
        "No lock was given, so the members who hold each role and the class each role may be shown are not known."
    ));
    assert!(
        line(
            &text,
            "| accountant | no lock was given | no lock was given |"
        )
        .contains("1 decision")
    );
    // With a lock every role a question names has a member (E1502), so a
    // row never says that nobody is bound; the lock's members are shown.
    let lock = read_json(VIEW_LOCK).unwrap();
    let v = view_of_text(&read_text(VIEW).unwrap(), "Settle", Some(&lock));
    let text = to_markdown(&attention_doc(&v));
    assert!(!text.contains("No lock was given"));
}

#[test]
fn a_plan_without_asks_has_no_bound_and_with_asks_comes_out_of_what_is_left() {
    // Declared: "at most", and the plan's row.
    let text = md(ASKS, "Planning", None);
    assert!(
        text.contains("At most 5 questions in all (asks: 5). Its own steps ask at most 5, which leaves nothing: a sub-program that asks, and a request to amend the envelope, are refused."),
        "{text}"
    );
    // With room left: both numbers.
    let more = read_text(ASKS).unwrap().replace(
        "budget  { steps: 40, agents: 4, asks: 5 }",
        "budget  { steps: 40, agents: 4, asks: 7 }",
    );
    let v = view_of_text(&more, "Planning", None);
    assert_eq!(v.bound.left, Some(2));
    let t = to_markdown(&attention_doc(&v));
    assert!(
        t.contains("At most 7 questions in all (asks: 7). Its own steps ask at most 5; what the lead's sub-programs and amendment requests ask comes out of the 2 that are left."),
        "{t}"
    );
    let row = line(&text, "| platform\\_lead |");
    assert!(row.contains("out of what is left of asks"));
    assert!(row.contains("Decide a request from the lead to amend the envelope"));
    assert!(row.contains("The request is refused to the lead"));

    // Not declared: the run has no bound, and the view never says "at most".
    let source = read_text(ASKS).unwrap().replace(
        "budget  { steps: 40, agents: 4, asks: 5 }",
        "budget  { steps: 40, agents: 4 }",
    );
    let v = view_of_text(&source, "Planning", None);
    assert_eq!(v.bound.asks, None);
    assert!(v.bound.leaves_out_plans);
    let text = to_markdown(&attention_doc(&v));
    assert!(
        text.contains("This run has no bound on its questions."),
        "{text}"
    );
    assert!(!text.contains("At most 5") && !text.contains("At most 4"));
    let bound = text
        .lines()
        .find(|l| l.contains("no bound on its questions"))
        .unwrap();
    assert!(!bound.to_lowercase().contains("at most"), "{bound}");
    assert!(bound.contains("plan") || bound.contains("amendment requests"));
}

#[test]
fn an_unbounded_question_says_why_and_the_bound_says_so() {
    let text = md(ASKS, "Endless", None);
    assert!(
        text.contains("This run has no bound on its questions: they are unbounded (it stands in a loop that has no max\\_iter), and no asks is declared."),
        "{text}"
    );
    assert!(
        line(&text, "| accountant |")
            .contains("unbounded (it stands in a loop that has no max\\_iter)")
    );
    let v = view(ASKS, "Endless", None);
    assert_eq!(v.bound.unbounded_because, ["loop"]);
}

#[test]
fn a_verify_row_and_a_review_row_say_what_only_their_facts_hold() {
    // The contract and the criterion of a verify, the criteria that may be
    // waived and the items of a review: in the sentence of the row and in
    // its JSON; every other row has null for them.
    let v = view(ASKS, "Approving", None);
    let verify = v
        .questions
        .iter()
        .find(|r| r.kind == SiteKind::Verify)
        .unwrap();
    assert_eq!(verify.contract.as_deref(), Some("Approved"));
    assert!(
        verify.what.starts_with("Approve the criterion "),
        "{}",
        verify.what
    );
    assert!(
        verify.what.contains("of the contract Approved"),
        "{}",
        verify.what
    );
    let js = verify.to_js();
    assert_eq!(js.get_member("contract"), &JsValue::from("Approved"));
    assert_eq!(js.get_member("items"), &JsValue::Null);
    assert_eq!(js.get_member("waivable"), &JsValue::Null);

    let lock = read_json(VIEW_LOCK).unwrap();
    let v = view_of_text(&read_text(VIEW).unwrap(), "Settle", Some(&lock));
    let reviews: Vec<_> = v
        .questions
        .iter()
        .filter(|r| r.kind == SiteKind::Review)
        .collect();
    assert_eq!(reviews.len(), 2, "the review and its escalation");
    let first = reviews[0];
    assert_eq!(
        first.what,
        "Waive or decline the open items of the batch (Fits.same may be waived); one decision about up to 20 items"
    );
    assert_eq!(reviews[1].what, "The same decision");
    let js = first.to_js();
    assert_eq!(stringify(js.get_member("items")).unwrap(), "20");
    assert_eq!(
        stringify(js.get_member("waivable")).unwrap(),
        "[\"Fits.same\"]"
    );
    assert_eq!(js.get_member("contract"), &JsValue::Null);
    assert_eq!(js.get_member("criterion"), &JsValue::Null);
    // The same two members are in the whole view's JSON, row by row.
    let all = stringify(&v.to_js()).unwrap();
    assert!(all.contains("\"waivable\":[\"Fits.same\"]"), "{all}");

    // A review that no criterion may be waived in, and one nothing bounds.
    use mandate_check::asks::Detail;
    use mandate_check::attention::Count;
    assert_eq!(
        mandate_views::detail_words(&Detail::Review {
            items: Count::Finite(1),
            waivable: vec![]
        }),
        "Decline the open items of the batch (no criterion may be waived); one decision about up to 1 item"
    );
    assert!(
        mandate_views::detail_words(&Detail::Review {
            items: Count::Unbounded,
            waivable: vec!["A.b".to_owned(), "A.c".to_owned()]
        })
        .starts_with("Waive or decline the open items of the batch (A.b, A.c may be waived); one decision about as many items")
    );
}

#[test]
fn rows_say_what_each_kind_asks_with_the_names_the_facts_give() {
    let text = md(ASKS, "Releasing", None);
    assert!(line(&text, "| owner |").contains("Authorize the effect git.merge"));
    assert!(text.contains("Approve what git.merge does to a governance file, as the file's owner"));
    assert!(text.contains("only if the action carries a governance file"));
    assert!(line(&text, "| release\\_manager |").contains("Authorize the effect deploy"));
    let text = md(ASKS, "Landing", None);
    assert!(text.contains("Authorize git.merge, a member of a change set"));
    assert!(text.contains("Approve a change set as a whole"));
    let text = md(ASKS, "Asking", None);
    assert!(text.contains("5 times"), "{text}");
    assert!(text.contains("Take a case the workflow escalates"));
    assert!(text.contains("Take a delegation that its supervision escalates"));
    let text = md(ASKS, "Approving", None);
    assert!(line(&text, "| accountant | no lock was given | no lock was given | outside any stage | Approve the criterion ").contains("1 day from when it is asked"));
    assert!(text.contains("Past the deadline the criterion is unmet"));
}

#[test]
fn the_view_shows_no_command_id_or_path() {
    for (file, w) in [
        (ASKS, "Approving"),
        (REPORTS, "MatchAll"),
        (ASKS, "Landing"),
    ] {
        let text = md(file, w, None);
        assert!(!text.contains("/defs/"), "{w}: {text}");
        assert!(!text.contains("/contract/"), "{w}");
    }
}

#[test]
fn effects_the_total_leaves_out_are_listed_beside_the_configuration() {
    let mut v = view(VIEW, "Settle", Some(VIEW_LOCK));
    assert!(v.uncounted_effects.is_empty());
    v.uncounted_effects.push(mandate_views::ViewEffect {
        effect: "erp.post_draft".to_owned(),
        multiplicity: mandate_check::Count::Finite(60),
    });
    let blocks = attention_blocks(&v);
    let text = to_markdown(&mandate_views::Doc {
        title: String::new(),
        meta: Vec::new(),
        blocks,
    });
    assert!(text.contains("which the runtime's configuration may hand to a person as well: erp.post\\_draft (60 times)."));
}

#[test]
fn what_an_author_wrote_is_escaped_and_the_page_runs_nothing() {
    let md = md(VIEW, "Notify", Some(VIEW_LOCK));
    assert!(
        md.contains("Stages: Ask \\<b\\>first\\</b\\> \\| \"quote\" & more · Tell"),
        "{md}"
    );
    assert!(!md.contains("<b>"));
    let page = html(VIEW, "Notify", Some(VIEW_LOCK));
    assert!(
        page.contains("Ask &lt;b&gt;first&lt;/b&gt; | &quot;quote&quot; &amp; more"),
        "{page}"
    );
    assert!(!page.contains("<b>") && !page.contains("<script") && !page.contains("<form"));
    assert!(page.contains("default-src 'none'"));
    // The JSON keeps the text as written.
    let v = view(VIEW, "Notify", Some(VIEW_LOCK));
    assert_eq!(v.stages[0].title, "Ask <b>first</b> | \"quote\" & more");
}

#[test]
fn the_structure_has_its_members_in_order() {
    let v = view(VIEW, "Settle", Some(VIEW_LOCK));
    let js = v.to_js();
    let keys = |v: &JsValue| -> Vec<String> {
        match v {
            JsValue::Object(o) => o.iter().map(|(k, _)| k.to_owned()).collect(),
            other => panic!("not an object: {other:?}"),
        }
    };
    assert_eq!(
        keys(&js),
        [
            "format",
            "kind",
            "program",
            "workflow",
            "stages",
            "lock",
            "bound",
            "owner",
            "configuration",
            "uncounted_effects",
            "questions",
            "reports"
        ]
    );
    let JsValue::Object(o) = &js else {
        unreachable!()
    };
    assert_eq!(o.get("format"), Some(&JsValue::from("mandate/view/0.1")));
    assert_eq!(o.get("kind"), Some(&JsValue::from("attention")));
    assert_eq!(
        keys(o.get("bound").unwrap()),
        [
            "total",
            "asks",
            "left",
            "declared",
            "unbounded_because",
            "leaves_out_plans",
            "text"
        ]
    );
    assert_eq!(
        keys(o.get("owner").unwrap()),
        ["role", "members", "from", "promotion", "text"]
    );
    let JsValue::Array(rows) = o.get("questions").unwrap() else {
        unreachable!()
    };
    assert_eq!(
        keys(&rows[0]),
        [
            "kind",
            "role",
            "members",
            "notified",
            "class",
            "shown",
            "known",
            "stage",
            "only",
            "effect",
            "at_most",
            "unbounded_because",
            "deadline_ms",
            "on_no_answer",
            "escalates_to",
            "contract",
            "criterion",
            "items",
            "waivable",
            "when",
            "what",
            "at_most_text",
            "deadline",
            "if_no_answer"
        ]
    );
    let JsValue::Array(reports) = o.get("reports").unwrap() else {
        unreachable!()
    };
    assert_eq!(
        keys(&reports[0]),
        ["role", "stage", "when", "title", "at_most", "fields"]
    );
    // The numbers are the facts'.
    assert_eq!(
        stringify(o.get("bound").unwrap().get_member("total")).unwrap(),
        "2"
    );
    assert_eq!(v.questions.len(), 3);
    assert_eq!(v.questions[0].deadline_ms, Some(86_400_000));
}

trait Member {
    fn get_member(&self, name: &str) -> &JsValue;
}

impl Member for JsValue {
    fn get_member(&self, name: &str) -> &JsValue {
        match self {
            JsValue::Object(o) => o.get(name).unwrap_or_else(|| panic!("no {name}")),
            other => panic!("not an object: {other:?}"),
        }
    }
}

// ── the door ─────────────────────────────────────────────────────────────

fn call(input: &str) -> Result<JsValue, String> {
    let door = rust_door("attention").unwrap();
    let input = resolve(&parse(input).unwrap().value).unwrap();
    (door.call)(&input).map_err(|e| format!("{}: {}", e.kind.as_str(), e.message))
}

#[test]
fn the_table_is_doors_json() {
    let doors: Vec<JsonDoor<'static>> = RUST_DOORS
        .iter()
        .map(|d| JsonDoor {
            name: d.name,
            ts: d.ts,
            params: d.params,
            note: d.note,
            call: Box::new(move |input| match (d.call)(input) {
                Ok(output) => Answer::Output(output),
                Err(e) => Answer::Refused {
                    kind: e.kind.as_str().to_owned(),
                    message: e.message,
                },
            }),
        })
        .collect();
    match check_table(DIR, &doors) {
        Ok(summary) => println!("{summary}"),
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn the_door_gives_the_view_in_each_format_and_the_same_every_time() {
    let lock = r#"{"$json":"fixtures/attention/view.lock.json"}"#;
    let input = |format: &str| {
        format!(
            r#"{{"text":{{"$text":"{VIEW}"}},"kind":"mdt","workflow":"Settle","opts":{{"lock":{lock}}}{format}}}"#
        )
    };
    let v = view(VIEW, "Settle", Some(VIEW_LOCK));
    let json = call(&input("")).unwrap();
    assert_eq!(stringify(&json).unwrap(), stringify(&v.to_js()).unwrap());
    assert_eq!(
        stringify(&call(&input(r#","format":"json""#)).unwrap()).unwrap(),
        stringify(&json).unwrap()
    );
    for (format, want) in [
        ("md", to_markdown(&attention_doc(&v))),
        ("html", to_html(&attention_doc(&v))),
    ] {
        let out = call(&input(&format!(r#","format":"{format}""#))).unwrap();
        assert_eq!(out, JsValue::from(want.as_str()), "{format}");
        let again = call(&input(&format!(r#","format":"{format}""#))).unwrap();
        assert_eq!(out, again, "{format} twice");
    }
    // The lock changes what it says: members and classes are the lock's.
    let bare = call(&format!(
        r#"{{"text":{{"$text":"{VIEW}"}},"kind":"mdt","workflow":"Settle","format":"md"}}"#
    ))
    .unwrap();
    let JsValue::String(bare) = bare else {
        panic!("not a string")
    };
    assert!(bare.contains("No lock was given"));
}

#[test]
fn the_door_gives_null_where_there_is_no_view_and_refuses_what_it_does_not_take() {
    for (name, text, workflow) in [
        (
            "no such workflow",
            r#"{"$text":"fixtures/attention/view.mdt"}"#,
            "Nothing",
        ),
        (
            "a program of 0.3",
            r#"{"$text":"fixtures/system/land.mdt"}"#,
            "Land",
        ),
        ("not a program", r#""this is not a program""#, "W"),
    ] {
        let out = call(&format!(
            r#"{{"text":{text},"kind":"mdt","workflow":"{workflow}"}}"#
        ))
        .unwrap();
        assert_eq!(out, JsValue::Null, "{name}");
    }
    let bad = |input: &str| call(input).expect_err(input);
    assert!(
        bad(r#"{"text":"x","kind":"mdt","workflow":"W","format":"pdf"}"#).starts_with("bad_input")
    );
    assert!(bad(r#"{"text":"x","kind":"txt","workflow":"W"}"#).starts_with("bad_input"));
    assert!(bad(r#"{"text":"x","kind":"mdt"}"#).starts_with("bad_input"));
    assert!(bad(r#"{"kind":"mdt","workflow":"W"}"#).starts_with("bad_input"));
    assert!(bad(r#"{"text":1,"kind":"mdt","workflow":"W"}"#).starts_with("bad_input"));
    assert!(
        bad(r#"{"text":"x","kind":"mdt","workflow":"W","made_up":1}"#).starts_with("bad_input")
    );
    assert!(bad(r#"{"text":"x","kind":"mdt","workflow":"W","opts":1}"#).starts_with("bad_input"));
    assert!(bad("null").starts_with("bad_input"));
    assert!(bad("[]").starts_with("bad_input"));
}

// ── the document ─────────────────────────────────────────────────────────

#[test]
fn the_document_of_a_program_of_0_7_holds_the_attention_view_after_the_others() {
    let text = read_text(VIEW).unwrap();
    let lock = read_json(VIEW_LOCK).unwrap();
    let p = load(&text, kind_of(VIEW)).program.unwrap();
    let doc = to_markdown(&program_doc(&p, Some(&lock), None));
    let at = |h: &str| doc.find(h).unwrap_or_else(|| panic!("no {h} in\n{doc}"));
    assert!(at("## Cost") < at("## Attention: Settle"));
    assert!(at("## Attention: Settle") < at("## Attention: Notify"));
    assert!(doc.contains("At most 2 questions in all (asks: 2)."));
    // The same text the view has, under its heading.
    let alone = md(VIEW, "Settle", Some(VIEW_LOCK));
    for l in alone
        .lines()
        .filter(|l| l.starts_with("| ") || l.starts_with("Stages:"))
    {
        assert!(doc.contains(l), "the document does not hold {l}");
    }
    // A program that does not check as given says that the view is not shown.
    let source = read_text(OWNER).unwrap();
    let p = load(&source, kind_of(OWNER)).program.unwrap();
    let bad_lock = parse(r#"{"lock":"mandate/lock/0.7","modules":{},"roles":{"nobody":["x"]}}"#)
        .unwrap()
        .value;
    let doc = to_markdown(&program_doc(&p, Some(&bad_lock), None));
    assert!(doc.contains("The attention view is not shown"), "{doc}");
}

#[test]
fn the_document_of_a_program_before_0_7_has_no_attention_view() {
    for file in [
        "fixtures/system/land.mdt",
        "fixtures/envelope/migrate-all.mdt",
    ] {
        let text = read_text(file).unwrap();
        let p = load(&text, kind_of(file)).program.unwrap();
        let doc = to_markdown(&program_doc(&p, None, None));
        assert!(!doc.contains("Attention"), "{file}");
        assert!(
            !to_html(&program_doc(&p, None, None)).contains("Attention"),
            "{file}"
        );
    }
}

#[test]
fn the_view_is_a_pure_function_of_its_input() {
    let a = md(OWNER, "Check", Some(OWNER_LOCK));
    let b = md(OWNER, "Check", Some(OWNER_LOCK));
    assert_eq!(a, b);
    let a = html(ASKS, "Approving", None);
    let b = html(ASKS, "Approving", None);
    assert_eq!(a, b);
}
