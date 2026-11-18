//! The card of a program of 0.7 (spec/attention.md "The card of a 0.7
//! program"), RP2: what it does by its stages, when it asks whom as the
//! attention view says it (a review's two deadlines exact), what it tells
//! whom, who approves it (the owner), the bound on questions and the
//! promotion ladder. No TypeScript reads 0.7, so every expectation is
//! written by hand, from the spec's own sentences. The card of a program of
//! 0.6 is held by `card_0_6.rs`, the golden files and the views vectors,
//! which these changes leave as they were.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::library::LibrarySource;
use mandate_check::{CheckOptions, Modules};
use mandate_ir::{JsValue, Value, parse, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{library_files, read_json, read_text};
use mandate_views::{
    Block, Cell, Doc, card, card_doc, card_doc_given, card_given, cell_text, envelope_workflows,
    to_html, to_markdown,
};

const INVOICES: &str = "fixtures/attention/invoices.mdt";
const INVOICES_LOCK: &str = "fixtures/attention/invoices.lock.json";

fn program_of(text: &str) -> Value {
    load(text, SourceKind::Mdt).program.unwrap()
}

fn program(file: &str) -> Value {
    program_of(&read_text(file).unwrap())
}

fn source() -> LibrarySource {
    let (manifest, files) = library_files("fixtures/library/acme.connectors").unwrap();
    LibrarySource { manifest, files }
}

/// The modules of the `acme.connectors` library, as its package carries
/// them (the views add the built-in `std.patterns` themselves).
fn library_modules() -> Modules {
    mandate_check::library::load_library(&source(), false, "acme")
        .unwrap()
        .modules
}

/// The card of the invoice flow, as the CLI and the tool make it: its
/// check is given the libraries the lock pins.
fn invoices_doc(lock: Option<&Value>) -> Doc {
    let (p, m, libs) = (program(INVOICES), library_modules(), [source()]);
    let given = CheckOptions {
        lock,
        modules: Some(&m),
        libraries: Some(&libs),
        ..CheckOptions::default()
    };
    card_doc_given(&p, "MatchInvoices", lock, Some(&m), &given)
        .unwrap()
        .unwrap()
}

fn invoices_lock() -> Value {
    read_json(INVOICES_LOCK).unwrap()
}

fn text_of(v: &JsValue) -> String {
    stringify(v).unwrap()
}

fn json(text: &str) -> Value {
    parse(text).unwrap().value
}

/// The blocks of the section headed `heading`, up to the next heading.
fn section<'a>(doc: &'a Doc, heading: &str) -> Vec<&'a Block> {
    let at = doc
        .blocks
        .iter()
        .position(|b| matches!(b, Block::H(h) if h == heading))
        .unwrap_or_else(|| panic!("no section {heading}"));
    doc.blocks
        .iter()
        .skip(at)
        .skip(1)
        .take_while(|b| !matches!(b, Block::H(_)))
        .collect()
}

fn has_heading(doc: &Doc, heading: &str) -> bool {
    doc.blocks
        .iter()
        .any(|b| matches!(b, Block::H(h) if h == heading))
}

fn paragraphs(blocks: &[&Block]) -> Vec<String> {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::P(p) => Some(p.clone()),
            _ => None,
        })
        .collect()
}

fn notes(blocks: &[&Block]) -> Vec<String> {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Note(p) => Some(p.clone()),
            _ => None,
        })
        .collect()
}

fn list(blocks: &[&Block]) -> Vec<String> {
    blocks
        .iter()
        .find_map(|b| match b {
            Block::List(items) => Some(items.iter().map(|c| cell_text(c).to_owned()).collect()),
            _ => None,
        })
        .unwrap_or_default()
}

/// The rows of the table whose first head is `first`, as text.
fn rows(blocks: &[&Block], first: &str) -> Vec<Vec<String>> {
    let text = |c: &Cell| cell_text(c).to_owned();
    blocks
        .iter()
        .find_map(|b| match b {
            Block::Table { head, rows } if head.first().map(String::as_str) == Some(first) => {
                Some(rows.iter().map(|r| r.iter().map(text).collect()).collect())
            }
            _ => None,
        })
        .unwrap_or_default()
}

fn row(cells: &[&str]) -> Vec<String> {
    cells.iter().map(|c| (*c).to_owned()).collect()
}

const LADDER: &str = "Every run in read_only mode and in live mode needs a promotion signed by a member of accountant (ana): a run in read_only needs a succeeded design run of this package and workflow, and a run in live needs a succeeded read_only run of them, with the shadow diff of that run against its design run. A promotion holds for every later run of the same package hash and workflow in its target mode; a changed package is a new hash and needs new promotions.";

#[test]
fn the_card_of_the_invoice_flow_lists_its_stages_and_asks_whom() {
    let doc = invoices_doc(Some(&invoices_lock()));
    // What it does: the stages, by title, in order.
    assert_eq!(
        list(&section(&doc, "What it does")),
        [
            "Collect the items",
            "Work on each item",
            "Decide on the exceptions",
            "Commit what was accepted"
        ]
    );
    // When it asks whom: the attention view's, bound first.
    let asks = section(&doc, "When it asks whom");
    assert_eq!(
        paragraphs(&asks)[0],
        "At most 2 questions in all (asks: 2)."
    );
    let questions = rows(&asks, "Role");
    assert_eq!(
        questions[0],
        row(&[
            "accountant",
            "ana",
            "up to confidential",
            "Decide on the exceptions",
            "Waive or decline the open items of the batch (Matched.totals may be waived); one decision about up to 60 items",
            "1 decision",
            "1 day from when it is asked",
            "It goes to finance_lead, who has 1 day of their own",
        ])
    );
    // The escalated question: its deadline counts from the escalation, which
    // comes at the first tick after the first deadline has passed.
    assert_eq!(
        questions[1],
        row(&[
            "finance_lead",
            "ben",
            "up to confidential",
            "Decide on the exceptions, only after the accountant's deadline",
            "The same decision",
            "1 decision",
            "1 day from the escalation, which comes at the first tick after the accountant's deadline",
            "Every open item is declined, by nobody, and the run goes on with the items that were accepted",
        ])
    );
    assert_eq!(questions.len(), 3);
    // The 0.6 sentence of the review, which would say the longest wait as
    // twice the deadline, is not shown beside it. This flow has no wait by
    // role and no authorization, so the tables of 0.6 for them have no rows.
    assert!(
        !paragraphs(&asks)
            .iter()
            .any(|p| p.starts_with("At most one batch decision"))
    );
    assert!(rows(&asks, "Wait").is_empty());
    assert!(rows(&asks, "Effect").is_empty());
    // The criteria a person may waive stay, as does what it commits.
    assert_eq!(rows(&asks, "Contract").len(), 3);
    assert!(has_heading(&doc, "What it commits"));
}

#[test]
fn a_reviews_wait_is_apart_from_the_time_budget_and_says_where_its_deadlines_are() {
    let doc = invoices_doc(Some(&invoices_lock()));
    let spends = section(&doc, "The most it spends");
    // The name the note is about is shown as code, in a list, not inside
    // the sentence.
    assert_eq!(
        notes(&spends),
        [
            "The review of each of these waits apart from the time budget; its deadlines are given under \"When it asks whom\"."
        ]
    );
    assert_eq!(list(&spends), ["checked"]);
    let html = to_html(&doc);
    assert!(
        html.contains("<li><span class=\"mono\">checked</span></li>"),
        "{html}"
    );
    let md = to_markdown(&doc);
    assert!(md.contains("- ` checked `"), "{md}");
    // The 0.6 figure, twice the deadline, is not said.
    let md = to_markdown(&doc);
    assert!(!md.contains("at most 2d"), "{md}");
    assert!(!md.contains("1d, then 1d more"), "{md}");
}

#[test]
fn the_card_tells_whom_it_reports_to_with_each_fields_class_and_how_it_is_known() {
    let doc = invoices_doc(Some(&invoices_lock()));
    let tells = section(&doc, "What it tells whom");
    assert_eq!(
        rows(&tells, "To"),
        [
            row(&[
                "accountant",
                "Collect the items",
                "Items collected",
                "items (Int · confidential · counted or given by the run)"
            ]),
            row(&[
                "accountant",
                "Commit what was accepted",
                "Batch done",
                "posted, declined, failed (Int · confidential · counted or given by the run)"
            ]),
        ]
    );
}

#[test]
fn the_owner_approves_the_card_with_the_members_the_lock_binds_and_the_ladder_follows() {
    let doc = invoices_doc(Some(&invoices_lock()));
    let who = section(&doc, "Who approves it, and who may amend it");
    let p = paragraphs(&who);
    assert_eq!(
        p[0],
        "The role accountant (Accountant) approves this card before any run. Nobody may amend a workflow without an envelope."
    );
    assert_eq!(rows(&who, "Member"), [row(&["ana", "1"])]);
    assert_eq!(p[1], LADDER);
    assert!(p[2].starts_with("An approval is signed for package sha256:"));
    // No sentence of a workflow that has no owner or no envelope is left.
    let md = to_markdown(&doc);
    assert!(!md.contains("No envelope is approved before a run"));
}

#[test]
fn without_a_lock_nobody_can_approve_and_no_ladder_is_asked() {
    let (p, m) = (program(INVOICES), library_modules());
    let doc = card_doc(&p, "MatchInvoices", None, Some(&m)).unwrap();
    // The door is not given the libraries, but with no lock none is pinned,
    // so the check passes with the modules alone.
    assert!(!to_markdown(&doc).contains("incomplete"));
    let who = section(&doc, "Who approves it, and who may amend it");
    assert_eq!(
        paragraphs(&who)[0],
        "The role accountant (Accountant) approves this card before any run. Nobody may amend a workflow without an envelope."
    );
    assert_eq!(
        notes(&who),
        ["Nobody can approve it yet: there is no lock, so no member holds the role accountant."]
    );
    assert!(rows(&who, "Member").is_empty());
    assert!(paragraphs(&who).iter().all(|p| !p.starts_with("Every run")));
    // The bound and the questions are told without members and classes.
    let asks = section(&doc, "When it asks whom");
    assert!(
        notes(&asks)
            .iter()
            .all(|n| !n.starts_with("This card is incomplete"))
    );
    assert_eq!(rows(&asks, "Role")[0][1], "no lock was given");
}

#[test]
fn a_lock_without_the_promotion_field_gives_no_ladder() {
    let text = read_text(INVOICES_LOCK).unwrap();
    assert!(text.contains("\"promotion\": \"required\""));
    let lock = json(&text.replace("\"promotion\": \"required\",", ""));
    let doc = invoices_doc(Some(&lock));
    let who = section(&doc, "Who approves it, and who may amend it");
    assert!(paragraphs(&who).iter().all(|p| !p.starts_with("Every run")));
    let v = json(&text_of(&card_js_of(Some(&lock))));
    let ladder = v.get("ladder").unwrap();
    assert_eq!(ladder.get("required"), Some(&Value::Bool(false)));
    assert_eq!(ladder.get("text"), Some(&Value::Null));
}

fn card_js_of(lock: Option<&Value>) -> JsValue {
    let (p, m, libs) = (program(INVOICES), library_modules(), [source()]);
    let given = CheckOptions {
        lock,
        modules: Some(&m),
        libraries: Some(&libs),
        ..CheckOptions::default()
    };
    card_given(&p, "MatchInvoices", lock, Some(&m), &given)
        .unwrap()
        .unwrap()
        .to_js()
}

#[test]
fn the_card_as_json_adds_the_attention_ladder_and_shapes_after_the_old_members() {
    let lock = invoices_lock();
    let v = json(&text_of(&card_js_of(Some(&lock))));
    let keys: Vec<&str> = v.as_object().unwrap().iter().map(|(k, _)| k).collect();
    assert_eq!(
        keys.split_at(keys.len().saturating_sub(3)).1,
        ["attention", "ladder", "shapes"]
    );
    let attention = v.get("attention").unwrap();
    assert_eq!(
        attention.get("kind").and_then(Value::as_str),
        Some("attention")
    );
    assert_eq!(
        attention.get("workflow").and_then(Value::as_str),
        Some("MatchInvoices")
    );
    let ladder = v.get("ladder").unwrap();
    assert_eq!(
        ladder.get("role").and_then(Value::as_str),
        Some("accountant")
    );
    assert_eq!(ladder.get("text").and_then(Value::as_str), Some(LADDER));
    assert_eq!(
        v.get("shapes")
            .and_then(Value::as_array)
            .map(<[Value]>::len),
        Some(0)
    );
    // A review's longest wait is told exactly.
    let library = v.get("library").unwrap();
    let reviews = library.get("reviews").and_then(Value::as_array).unwrap();
    assert_eq!(
        reviews[0].get("longest").and_then(Value::as_str),
        Some(
            "1d from when it is asked, then 1d from the escalation, which comes at the first tick after the first deadline has passed"
        )
    );
}

#[test]
fn the_card_of_a_program_of_0_6_has_none_of_what_0_7_adds() {
    let p = program("fixtures/library/invoices.mdt");
    let lock = read_json("fixtures/library/invoices.lock.json").unwrap();
    let m = library_modules();
    let v = json(&text_of(
        &card(&p, "MatchInvoices", Some(&lock), Some(&m))
            .unwrap()
            .to_js(),
    ));
    for k in ["attention", "ladder", "shapes"] {
        assert!(v.get(k).is_none(), "{k}");
    }
    let md = to_markdown(&card_doc(&p, "MatchInvoices", Some(&lock), Some(&m)).unwrap());
    assert!(md.contains("at most 2d"), "{md}");
    assert!(!md.contains("What it tells whom"));
}

/// The card of the invoice flow with the libraries given, or not.
fn given_card(
    p: &Value,
    lock: Option<&Value>,
    libraries: Option<&[LibrarySource]>,
) -> Result<Option<mandate_views::CardView>, mandate_views::CardRefused> {
    let m = library_modules();
    let given = CheckOptions {
        lock,
        modules: Some(&m),
        libraries,
        ..CheckOptions::default()
    };
    card_given(p, "MatchInvoices", lock, Some(&m), &given)
}

/// No card, in any form, from a program of 0.7 whose facts cannot be made;
/// the refusal's message.
fn assert_no_card_in_any_form(
    p: &Value,
    workflow: &str,
    lock: Option<&Value>,
    modules: &Modules,
    given: &CheckOptions<'_>,
) -> String {
    let refused = card_given(p, workflow, lock, Some(modules), given).unwrap_err();
    let again = card_doc_given(p, workflow, lock, Some(modules), given).unwrap_err();
    assert_eq!(refused, again);
    // The doors that give no reason give no card either.
    assert!(card(p, workflow, lock, Some(modules)).is_none());
    assert!(card_doc(p, workflow, lock, Some(modules)).is_none());
    refused.message
}

#[test]
fn a_program_that_needs_libraries_that_were_not_given_has_no_card() {
    // The invoice flow needs the library its lock pins: without it the
    // program does not check, so its attention part cannot be made, and the
    // card is not made without it, in any form.
    let (p, m, lock) = (program(INVOICES), library_modules(), invoices_lock());
    let given = CheckOptions {
        lock: Some(&lock),
        modules: Some(&m),
        ..CheckOptions::default()
    };
    let message = assert_no_card_in_any_form(&p, "MatchInvoices", Some(&lock), &m, &given);
    assert!(
        message.starts_with("the card of MatchInvoices is not made: "),
        "{message}"
    );
    assert!(
        message.contains("the libraries the lock pins were not given"),
        "{message}"
    );
    assert!(message.contains("MDT-E1605"), "{message}");
    // The libraries make it whole.
    let libs = [source()];
    assert!(given_card(&p, Some(&lock), Some(&libs)).unwrap().is_some());
}

#[test]
fn a_lock_that_fails_its_schema_has_no_card() {
    let (p, m) = (program(INVOICES), library_modules());
    let text = text_of(&JsValue::from(&invoices_lock()));
    assert!(text.contains("\"promotion\":\"required\""), "{text}");
    let lock = json(&text.replace("\"promotion\":\"required\"", "\"promotion\":\"always\""));
    let libs = [source()];
    let given = CheckOptions {
        lock: Some(&lock),
        modules: Some(&m),
        libraries: Some(&libs),
        ..CheckOptions::default()
    };
    let message = assert_no_card_in_any_form(&p, "MatchInvoices", Some(&lock), &m, &given);
    assert!(message.contains("MDT-E0140"), "{message}");
}

#[test]
fn a_program_that_does_not_check_has_no_card_in_markdown_html_or_json() {
    // The envelope names a pattern that no module gives.
    let text = read_text("fixtures/attention/shapes.mdt")
        .unwrap()
        .replace("shapes  [Noted]", "shapes  [Missing]");
    let p = program_of(&text);
    let m = Modules::new();
    let given = CheckOptions::default();
    let message = assert_no_card_in_any_form(&p, "Planning", None, &m, &given);
    assert!(
        message.starts_with("the card of Planning is not made: "),
        "{message}"
    );
    assert!(
        !message.contains("the libraries the lock pins"),
        "{message}"
    );
    assert!(message.contains("MDT-E"), "{message}");
    // The same program with the pattern the envelope names has one.
    assert!(
        card_doc(
            &program("fixtures/attention/shapes.mdt"),
            "Planning",
            None,
            None
        )
        .is_some()
    );
}

#[test]
fn a_program_of_0_6_still_has_a_card_without_what_it_needs_to_check() {
    // 0.1 to 0.6 are not changed: their card is made whatever the check says.
    let p = program("fixtures/library/invoices.mdt");
    let lock = read_json("fixtures/library/invoices.lock.json").unwrap();
    let m = library_modules();
    let doc = card_doc(&p, "MatchInvoices", Some(&lock), Some(&m)).unwrap();
    assert!(!has_heading(&doc, "What it tells whom"));
}

#[test]
fn a_workflow_without_stages_or_owner_keeps_its_steps_and_its_old_approval_text() {
    let p = program("fixtures/attention/minimal.mdt");
    let doc = card_doc(&p, "Greet", None, None).unwrap();
    assert_eq!(
        list(&section(&doc, "What it does")),
        ["delegate Greeter.greet [model standard (up to internal)]"]
    );
    let who = section(&doc, "Who approves it, and who may amend it");
    assert_eq!(
        paragraphs(&who)[0],
        "No envelope is approved before a run, and nobody may amend it."
    );
    assert_eq!(
        paragraphs(&section(&doc, "What it tells whom")),
        ["Nothing: it makes no report."]
    );
    assert_eq!(
        paragraphs(&section(&doc, "When it asks whom"))[0],
        "At most 0 questions in all; no bound is declared (asks is not set)."
    );
}

#[test]
fn a_workflow_with_an_owner_and_no_envelope_is_approved_by_the_owner_role() {
    let p = program("fixtures/attention/owner.mdt");
    let lock = read_json("fixtures/attention/owner.lock.json").unwrap();
    let doc = card_doc(&p, "Describe", Some(&lock), None).unwrap();
    assert_eq!(list(&section(&doc, "What it does")), ["Write the line"]);
    let who = section(&doc, "Who approves it, and who may amend it");
    assert_eq!(
        paragraphs(&who)[0],
        "The role accountant (Accountant) approves this card before any run. Nobody may amend a workflow without an envelope."
    );
    assert_eq!(rows(&who, "Member"), [row(&["ana", "1"])]);
    // The workflow the finance lead owns is approved by the finance lead.
    let doc = card_doc(&p, "Check", Some(&lock), None).unwrap();
    let who = section(&doc, "Who approves it, and who may amend it");
    assert!(
        paragraphs(&who)[0].starts_with("The role finance_lead (Finance lead) approves this card")
    );
    assert_eq!(rows(&who, "Member"), [row(&["ben", "1"])]);
}

#[test]
fn an_envelope_with_shapes_says_what_their_sub_programs_may_report() {
    let p = program("fixtures/attention/shapes.mdt");
    assert_eq!(envelope_workflows(&p), ["Planning"]);
    let doc = card_doc(&p, "Planning", None, None).unwrap();
    let tells = section(&doc, "What it tells whom");
    assert_eq!(paragraphs(&tells)[0], "Nothing: it makes no report.");
    assert_eq!(
        rows(&tells, "Shape"),
        [row(&[
            "Noted",
            "Write the note · Ask about it",
            "Note written (to the role bound to reviewer; fields words)"
        ])]
    );
    assert_eq!(notes(&tells).len(), 1);
    // The envelope's own text is that of 0.5, with the owner.
    let who = section(&doc, "Who approves it, and who may amend it");
    assert_eq!(
        paragraphs(&who)[0],
        "The role platform_lead (Platform lead) approves the envelope before any run, and every amendment."
    );
    let v = json(&text_of(&card(&p, "Planning", None, None).unwrap().to_js()));
    let shapes = v.get("shapes").and_then(Value::as_array).unwrap();
    assert_eq!(shapes.len(), 1);
    assert_eq!(
        shapes[0].get("pattern").and_then(Value::as_str),
        Some("Noted")
    );
    assert_eq!(shapes[0].get("known"), Some(&Value::Bool(true)));
}

/// Text that reaches the output from the program, in each place the card
/// shows program text: markup, a table separator, backticks, emphasis and a
/// link (a title is one line: E1902 refuses a line break).
const HOSTILE: &str = "<script>alert(1)</script> | `x` & *e* _u_ [l](http://x)";

fn hostile_program() -> Value {
    let text = read_text("fixtures/attention/shapes.mdt")
        .unwrap()
        .replace("\"Write the note\"", &format!("\"{HOSTILE} one\""))
        .replace("\"Note written\"", &format!("\"{HOSTILE} two\""))
        .replace("\"Ask about it\"", &format!("\"{HOSTILE} three\""))
        .replace("\"Platform lead\"", &format!("\"{HOSTILE} four\""))
        .replace(
            "  plan Lead.finish(t) within envelope\n",
            &format!(
                "  stage s0 \"{HOSTILE} five\"\n  report to accountant \"{HOSTILE} seven\" {{ words: len(t) }}\n  plan Lead.finish(t) within envelope\n"
            ),
        );
    program_of(&text)
}

#[test]
fn program_text_in_the_card_is_escaped_in_markdown_and_in_html() {
    let p = hostile_program();
    let doc = card_doc(&p, "Planning", None, None).unwrap();
    let md = to_markdown(&doc);
    let html = to_html(&doc);
    // Every place the card shows program text holds the text as it is.
    let all: String = format!("{:?}", doc.blocks);
    for place in ["one", "two", "three", "four", "five", "seven"] {
        assert!(
            all.contains(&format!("{HOSTILE} {place}")),
            "{place}: {all}"
        );
    }
    // The stage and the report of the workflow itself: in what it does and
    // in what it tells whom.
    assert_eq!(
        list(&section(&doc, "What it does")),
        [format!("{HOSTILE} five")]
    );
    let tells = section(&doc, "What it tells whom");
    assert_eq!(rows(&tells, "To")[0][1], format!("{HOSTILE} five"));
    assert_eq!(rows(&tells, "To")[0][2], format!("{HOSTILE} seven"));
    // The shape's stages and reports, in one table.
    let shape = &rows(&tells, "Shape")[0];
    assert_eq!(shape[1], format!("{HOSTILE} one · {HOSTILE} three"));
    assert!(shape[2].starts_with(&format!("{HOSTILE} two (to the role bound to reviewer")));
    // The owner's description.
    assert!(
        paragraphs(&section(&doc, "Who approves it, and who may amend it"))[0]
            .contains(&format!("({HOSTILE} four)"))
    );
    // Rendered: no markup of the program is live.
    assert!(!md.contains("<script>"), "{md}");
    assert!(!html.contains("<script"), "{html}");
    assert!(
        html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
        "{html}"
    );
    // A table's rows keep their columns: a `|` in a cell is escaped.
    let unescaped = |line: &str| line.replace("\\|", "").matches('|').count();
    let mut width = 0;
    for line in md.lines() {
        if !line.starts_with('|') {
            width = 0;
            continue;
        }
        if width == 0 {
            width = unescaped(line);
        }
        assert_eq!(unescaped(line), width, "{line}");
    }
}

#[test]
fn the_card_is_the_same_bytes_on_every_run() {
    let lock = invoices_lock();
    let first = (
        to_markdown(&invoices_doc(Some(&lock))),
        to_html(&invoices_doc(Some(&lock))),
        text_of(&card_js_of(Some(&lock))),
    );
    for _ in 0..3 {
        assert_eq!(
            first,
            (
                to_markdown(&invoices_doc(Some(&lock))),
                to_html(&invoices_doc(Some(&lock))),
                text_of(&card_js_of(Some(&lock))),
            )
        );
    }
    let p = hostile_program();
    let a = to_markdown(&card_doc(&p, "Planning", None, None).unwrap());
    assert_eq!(
        a,
        to_markdown(&card_doc(&p, "Planning", None, None).unwrap())
    );
}

#[test]
fn the_markdown_the_html_and_the_json_say_the_same() {
    let lock = invoices_lock();
    let doc = invoices_doc(Some(&lock));
    let (md, html) = (to_markdown(&doc), to_html(&doc));
    let v = json(&text_of(&card_js_of(Some(&lock))));
    let att = v.get("attention").unwrap();
    for stage in att.get("stages").and_then(Value::as_array).unwrap() {
        let title = stage.get("title").and_then(Value::as_str).unwrap();
        assert!(md.contains(title) && html.contains(title), "{title}");
    }
    for q in att.get("questions").and_then(Value::as_array).unwrap() {
        let what = q.get("what").and_then(Value::as_str).unwrap();
        // The markdown escapes `_`; the html does not need to.
        let escaped = what.replace('_', "\\_");
        assert!(md.contains(&escaped), "{what}");
    }
    for r in att.get("reports").and_then(Value::as_array).unwrap() {
        let title = r.get("title").and_then(Value::as_str).unwrap();
        assert!(md.contains(title) && html.contains(title), "{title}");
    }
}

/// The migration of `fixtures/envelope`, written as `language` says, with
/// its module.
fn migrate_all(language: &str) -> (Value, Modules) {
    let relabel = |t: String| t.replace("mandate @ 0.4", &format!("mandate @ {language}"));
    let p = program_of(&relabel(
        read_text("fixtures/envelope/migrate-all.mdt").unwrap(),
    ));
    let mut m = Modules::new();
    m.insert(
        "company.domain",
        program_of(&relabel(
            // A module of 0.6 or later lets another name only its pub definitions.
            read_text("fixtures/envelope/domain.mdt").unwrap().replace(
                "
type ",
                if language == "0.7" {
                    "
pub type "
                } else {
                    "
type "
                },
            ),
        )),
    );
    (p, m)
}

#[test]
fn the_card_of_0_7_names_an_authorization_the_envelope_declares_for_an_effect_no_step_reaches() {
    // The envelope says `approve git.merge by release_manager`; no step of
    // the workflow's own body merges, a lead's sub-program may. The card of
    // 0.4 says so, and the card of 0.7 keeps every question of it.
    let (old, old_modules) = migrate_all("0.4");
    let (new, new_modules) = migrate_all("0.7");
    let before = card_doc(&old, "MigrateAll", None, Some(&old_modules)).unwrap();
    let after = card_doc(&new, "MigrateAll", None, Some(&new_modules)).unwrap_or_else(|| {
        let given = CheckOptions {
            modules: Some(&new_modules),
            ..CheckOptions::default()
        };
        panic!(
            "{}",
            card_doc_given(&new, "MigrateAll", None, Some(&new_modules), &given).unwrap_err()
        )
    });
    let want = row(&[
        "git.merge",
        "release_manager",
        "release_manager is not in the lock, so no member can decide it",
    ]);
    let asked = |doc: &Doc| rows(&section(doc, "When it asks whom"), "Effect");
    assert_eq!(asked(&before).len(), 1);
    assert_eq!(asked(&before)[0][..2], want[..2]);
    // The same row, word for word, and the note that says what the table of
    // questions does not.
    assert_eq!(asked(&after), asked(&before));
    let asks = section(&after, "When it asks whom");
    assert!(
        notes(&asks)
            .iter()
            .any(|n| n
                .starts_with("These authorizations are decided by the role the table above names")),
        "{:?}",
        notes(&asks)
    );
    assert_eq!(list(&asks), ["git.merge"]);
    // Every role the card of 0.4 names is named on that of 0.7.
    let md = to_markdown(&after);
    for role in ["release\\_manager", "platform\\_lead"] {
        assert!(to_markdown(&before).contains(role), "{role}");
        assert!(md.contains(role), "{role}");
    }
}

#[test]
fn an_authorization_with_a_row_in_the_table_of_questions_is_not_said_to_be_missing_from_it() {
    // `Planning` declares `approve git.merge by release_manager` in its envelope and
    // merges in its own body: the authorization is in the table of approvals and its
    // question is a row of the table of questions, so the card does not say it is
    // outside the table.
    let p = program("fixtures/attention/asks.mdt");
    let doc = card_doc(&p, "Planning", None, None).unwrap();
    let asks = section(&doc, "When it asks whom");
    let not_sites = |b: &&Block| match b {
        Block::Table { head, .. } => head.get(1).map(String::as_str) != Some("Sites"),
        _ => true,
    };
    let kept: Vec<&Block> = asks.iter().copied().filter(not_sites).collect();
    let approvals = rows(&kept, "Effect");
    assert!(
        approvals
            .iter()
            .any(|r| r[0] == "git.merge" && r[1] == "release_manager"),
        "{approvals:?}"
    );
    let questions = rows(&asks, "Role");
    assert!(
        questions
            .iter()
            .any(|r| r[0] == "release_manager" && r[4].contains("git.merge")),
        "{questions:?}"
    );
    assert!(
        !notes(&asks)
            .iter()
            .any(|n| n.starts_with("These authorizations")),
        "{:?}",
        notes(&asks)
    );
}

#[test]
fn two_waits_of_one_role_are_told_apart_by_where_they_are_asked() {
    let p = program("fixtures/attention/asks.mdt");
    let doc = card_doc(&p, "Approving", None, None).unwrap();
    let asks = section(&doc, "When it asks whom");
    let waits = rows(&asks, "Wait");
    let accountant: Vec<&Vec<String>> = waits.iter().filter(|w| w[1] == "accountant").collect();
    assert!(accountant.len() >= 2, "{waits:?}");
    let places: std::collections::BTreeSet<&str> =
        accountant.iter().map(|w| w[2].as_str()).collect();
    assert_eq!(places.len(), accountant.len(), "{waits:?}");
    assert!(places.contains("function confirm"), "{places:?}");
}

#[test]
fn the_doors_refuse_the_card_of_a_program_that_does_not_check_and_say_what_is_missing() {
    // The door is what the Node command and the tools call: no card, in any
    // form, and the reason where it can be read.
    let (p, m, lock) = (program(INVOICES), library_modules(), invoices_lock());
    let input = parse(&format!(
        r#"{{"program":{},"workflow":"MatchInvoices","opts":{{"lock":{},"modules":{}}}}}"#,
        text_of(&JsValue::from(&p)),
        text_of(&JsValue::from(&lock)),
        text_of(&JsValue::from(&Value::Object(m)))
    ))
    .unwrap()
    .value;
    for name in ["card", "card_doc"] {
        let door = mandate_views::json_doors::door(name).unwrap();
        let refused = (door.call)(&input).unwrap_err();
        assert_eq!(refused.kind.as_str(), "bad_input", "{name}");
        assert!(
            refused
                .message
                .starts_with("the card of MatchInvoices is not made: "),
            "{name}: {}",
            refused.message
        );
        assert!(
            refused
                .message
                .contains("the libraries the lock pins were not given"),
            "{name}: {}",
            refused.message
        );
    }
}
