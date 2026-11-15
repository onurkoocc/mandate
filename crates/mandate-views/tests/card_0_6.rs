//! The card of a program of 0.6 (spec/library.md "Views"), RP4: a card for a
//! workflow without an envelope, and what a 0.6 card adds: the pattern and
//! its library, the `///` doc lines, the most items of each map against the
//! budget, each review as one decision of its role, the criteria a person may
//! waive, the connector tools by what they are, and each batch commit step.
//! No TypeScript reads 0.6, so every expectation is written by hand, from the
//! spec's own sentences. The cards of 0.1 to 0.5 are held by the golden file
//! and the views vectors, which these changes leave as they were.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::Modules;
use mandate_ir::{JsValue, Value, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{library_files, read_json, read_text};
use mandate_views::{Block, Cell, Doc, card, card_doc, envelope_workflows, to_markdown};

fn program(file: &str) -> Value {
    load(&read_text(file).unwrap(), SourceKind::Mdt)
        .program
        .unwrap()
}

/// The modules of the `acme.connectors` library, as its package carries
/// them (the views add the built-in `std.patterns` themselves).
fn library_modules() -> Modules {
    let (manifest, files) = library_files("fixtures/library/acme.connectors").unwrap();
    mandate_check::library::load_library(
        &mandate_check::library::LibrarySource { manifest, files },
        false,
        "acme",
    )
    .unwrap()
    .modules
}

fn invoices_lock() -> Value {
    read_json("fixtures/library/invoices.lock.json").unwrap()
}

fn doc_of(p: &Value, lock: Option<&Value>, modules: Option<&Modules>) -> Doc {
    card_doc(p, "MatchInvoices", lock, modules).unwrap()
}

fn js(p: &Value, lock: Option<&Value>, modules: Option<&Modules>) -> JsValue {
    card(p, "MatchInvoices", lock, modules).unwrap().to_js()
}

fn has_p(doc: &Doc, text: &str) -> bool {
    doc.blocks
        .iter()
        .any(|b| matches!(b, Block::P(p) if p == text))
}

fn has_note(doc: &Doc, text: &str) -> bool {
    doc.blocks
        .iter()
        .any(|b| matches!(b, Block::Note(p) if p == text))
}

fn has_heading(doc: &Doc, text: &str) -> bool {
    doc.blocks
        .iter()
        .any(|b| matches!(b, Block::H(h) if h == text))
}

/// The rows of the table whose first head is `first`, as text.
fn rows(doc: &Doc, first: &str) -> Vec<Vec<String>> {
    let text = |c: &Cell| mandate_views::cell_text(c).to_owned();
    doc.blocks
        .iter()
        .find_map(|b| match b {
            Block::Table { head, rows } if head.first().map(String::as_str) == Some(first) => {
                Some(rows.iter().map(|r| r.iter().map(text).collect()).collect())
            }
            _ => None,
        })
        .unwrap_or_default()
}

fn text_of(v: &JsValue) -> String {
    stringify(v).unwrap()
}

#[test]
fn a_workflow_without_an_envelope_has_a_card_in_0_6_and_not_before() {
    let p = program("fixtures/library/invoices.mdt");
    let m = library_modules();
    assert_eq!(envelope_workflows(&p), ["MatchInvoices"]);
    let doc = doc_of(&p, Some(&invoices_lock()), Some(&m));
    // Its `caps` and `budget` stand in for the envelope's.
    assert_eq!(
        rows(&doc, "Dimension")[0],
        ["spend (USD)", "20 USD", "18 USD", "2 USD"]
    );
    assert_eq!(rows(&doc, "Dimension")[2][..2], ["time", "2 h"]);
    // The fifth question: no envelope is approved, nobody may amend it.
    assert!(has_heading(&doc, "Who approves it, and who may amend it"));
    assert!(has_p(
        &doc,
        "No envelope is approved before a run, and nobody may amend it."
    ));
    let js = text_of(&js(&p, Some(&invoices_lock()), Some(&m)));
    assert!(js.contains(r#""approves":{"role":null"#), "{js}");
    assert!(js.contains(r#""library":{"envelope":false"#), "{js}");
    // A program of 0.5 without an envelope still has no card.
    let old = program("fixtures/boundary/fetch.mdt");
    assert!(envelope_workflows(&old).is_empty());
    assert!(card(&old, "Summarize", None, None).is_none());
}

#[test]
fn the_card_names_the_pattern_and_the_library_the_lock_pins() {
    let p = program("fixtures/library/invoices.mdt");
    let m = library_modules();
    let lock = invoices_lock();
    let doc = doc_of(&p, Some(&lock), Some(&m));
    assert!(has_p(
        &doc,
        "Applies the pattern BatchWithExceptions (std.patterns 1.0.0)."
    ));
    assert!(has_p(
        &doc,
        "The library std.patterns has digest sha256:b1a7161ad2ea1dcdca950c189403b90cd65770f7e8143441a6836cacdace3548, pinned by the lock."
    ));
    let js = text_of(&js(&p, Some(&lock), Some(&m)));
    assert!(
        js.contains(r#""library":"std.patterns","version":"1.0.0""#),
        "{js}"
    );
    // Without a lock the library is the one built into the compiler.
    let doc = doc_of(&p, None, Some(&m));
    assert!(has_p(
        &doc,
        "Applies the pattern BatchWithExceptions (std.patterns 1.0.0)."
    ));
    assert!(
        doc.blocks.iter().any(|b| matches!(b, Block::P(t)
            if t.starts_with("The library std.patterns has digest sha256:") && t.ends_with("built into the compiler."))),
        "{doc:?}"
    );
    // A pattern the program defines is its own.
    let local = program("conformance/P02/program.mdt");
    let names = envelope_workflows(&local);
    let doc = card_doc(&local, &names[0], None, None).unwrap();
    assert!(
        doc.blocks.iter().any(|b| matches!(b, Block::P(t)
            if t.starts_with("Applies the pattern ") && t.ends_with("(defined in this program)."))),
        "{doc:?}"
    );
}

#[test]
fn the_card_shows_the_doc_lines_of_the_workflow_its_contract_and_its_pattern() {
    let p = program("fixtures/library/invoices.mdt");
    let m = library_modules();
    let doc = doc_of(&p, Some(&invoices_lock()), Some(&m));
    // The workflow's, under the title.
    assert_eq!(
        doc.blocks.first(),
        Some(&Block::P(
            "Matches the invoices in the mailbox to open orders and posts each match to the ERP as a draft. Asks the accountant once about the rest.".to_owned()
        ))
    );
    // The contract's, where its criteria are.
    assert!(has_p(
        &doc,
        "Contract Matched: An invoice is matched when the match is for it, names its vendor's order, and its total is within 2% of the order's; a larger gap may be accepted."
    ));
    // The pattern's, under the line that names it.
    assert!(has_p(
        &doc,
        "Works on every item of a list. What passes goes on; what does not is asked about once, as one list."
    ));
}

#[test]
fn a_review_is_one_decision_of_its_role_with_its_deadline_and_escalation() {
    let p = program("fixtures/library/invoices.mdt");
    let m = library_modules();
    let doc = doc_of(&p, Some(&invoices_lock()), Some(&m));
    assert!(has_p(
        &doc,
        "At most one batch decision to accountant (ana) about at most 60 items (those that failed only a criterion it may waive); if the deadline (1d) passes, to finance_lead (ben); if that passes too, every open item is declined. Nobody is asked about a single item, and nothing passes on its own."
    ));
    // The wait is bounded by its own deadlines, apart from the budget's time.
    assert!(has_note(
        &doc,
        "The review of checked waits apart from the time budget, for at most 2d (1d, then 1d more after it is escalated to finance_lead)."
    ));
    // No wait by role is claimed absent.
    assert!(!has_p(
        &doc,
        "No step it reaches waits for a person by role."
    ));
    // Without a lock nobody is bound to either role.
    let doc = doc_of(&p, None, Some(&m));
    assert!(
        doc.blocks.iter().any(|b| matches!(b, Block::P(t)
            if t.starts_with("At most one batch decision to accountant (nobody bound)"))),
        "{doc:?}"
    );
}

#[test]
fn the_card_says_which_criteria_may_be_waived_and_by_whom() {
    let p = program("fixtures/library/invoices.mdt");
    let m = library_modules();
    let doc = doc_of(&p, Some(&invoices_lock()), Some(&m));
    let waivers = rows(&doc, "Contract");
    assert_eq!(waivers.len(), 3);
    assert_eq!(
        waivers[2],
        [
            "Matched",
            "totals",
            "The total is within 2% of the order's",
            "accountant (ana), finance_lead (ben)"
        ]
    );
    // A criterion nobody may waive: an item that fails it is declined without
    // asking.
    assert_eq!(
        waivers[1][3],
        "nobody: an item that fails it is declined without asking"
    );
    // "Passed" and "waived" are two things.
    assert!(has_note(
        &doc,
        "A waived criterion is not a criterion that passed: the audit keeps the failed record and the waiver apart, as two methods."
    ));
}

#[test]
fn the_card_lists_the_connector_tools_read_and_write_apart() {
    let p = program("fixtures/library/invoices.mdt");
    let m = library_modules();
    let doc = doc_of(&p, Some(&invoices_lock()), Some(&m));
    let tools = rows(&doc, "Connector");
    assert_eq!(
        tools,
        [
            [
                "acme.connectors.erp",
                "confidential",
                "list_open_orders (held by workflow MatchInvoices, agent Matcher)",
                "post_draft_invoice (critical, retry reconcilable; held by workflow MatchInvoices)"
            ],
            [
                "acme.connectors.mailbox",
                "confidential",
                "list_invoices (held by workflow MatchInvoices)",
                "—"
            ]
        ]
    );
    let js = text_of(&js(&p, Some(&invoices_lock()), Some(&m)));
    assert!(
        js.contains(r#""tool":"post_draft_invoice","class":"confidential","kind":"write""#),
        "{js}"
    );
    assert!(
        js.contains(r#""tool":"list_open_orders","class":"confidential","kind":"read_only""#),
        "{js}"
    );
}

#[test]
fn the_commit_step_is_an_action_per_item_by_policy_idempotent_by_its_key() {
    let p = program("fixtures/library/invoices.mdt");
    let m = library_modules();
    let doc = doc_of(&p, Some(&invoices_lock()), Some(&m));
    assert!(has_heading(&doc, "What it commits"));
    assert!(has_p(
        &doc,
        "Each accepted item is posted as its own action by erp.post_draft_invoice (a critical write tool, retry class reconcilable), authorized by policy, idempotent by invoice_no. Nobody is asked about one item."
    ));
}

#[test]
fn the_bounds_are_the_most_items_times_the_agents_budget_against_the_workflows() {
    let p = program("fixtures/library/invoices.mdt");
    let m = library_modules();
    let doc = doc_of(&p, Some(&invoices_lock()), Some(&m));
    assert!(has_p(
        &doc,
        "Spend bound of map it: 60 × 0.30 USD = 18 USD ≤ 20 USD."
    ));
    let maps = rows(&doc, "Map");
    assert_eq!(maps[0][..3], ["map it", "items", "60"]);
    assert_eq!(maps[1][..3], ["map v", "reviewed.accepted", "60"]);
}

#[test]
fn a_write_tool_shows_its_declared_class_in_the_authority_view() {
    let p = program("fixtures/library/invoices.mdt");
    let m = library_modules();
    let view = mandate_views::authority_with(&p, Some(&m));
    let wf = view.rows.iter().find(|r| r.who == "MatchInvoices").unwrap();
    assert_eq!(
        wf.effects,
        ["erp.post_draft_invoice (critical; policy authorizes)"]
    );
    assert_eq!(
        wf.tools,
        [
            "erp.list_open_orders (read-only)",
            "erp.post_draft_invoice (write, critical, retry reconcilable)",
            "mailbox.list_invoices (read-only)"
        ]
    );
    let agent = view.rows.iter().find(|r| r.who == "Matcher").unwrap();
    assert_eq!(agent.tools, ["erp.list_open_orders (read-only)"]);
    // The tools are in the document too.
    let md = to_markdown(&mandate_views::program_doc(
        &p,
        Some(&invoices_lock()),
        Some(&m),
    ));
    assert!(md.contains("Connector tools"), "{md}");
}

/// A pattern whose application the card cannot expand (the connector's module
/// is not given) is the stand-in: the card shows no less than the expansion
/// does, shows no number that depends on it, and says what it does not know.
#[test]
fn a_workflow_that_cannot_be_expanded_shows_no_less_and_says_what_is_unknown() {
    let p = program("fixtures/library/invoices.mdt");
    let lock = invoices_lock();
    let full = doc_of(&p, Some(&lock), Some(&library_modules()));
    let stand_in = doc_of(&p, Some(&lock), None);
    let js = text_of(&js(&p, Some(&lock), None));
    assert!(js.contains(r#""unexpanded":true"#), "{js}");
    // It still names the pattern and what it asks and what it may call.
    assert!(has_p(
        &stand_in,
        "Applies the pattern BatchWithExceptions (std.patterns 1.0.0)."
    ));
    let tools = rows(&stand_in, "Connector");
    let named: Vec<String> = tools.iter().map(|r| r[4].clone()).collect();
    for tool in ["list_open_orders", "post_draft_invoice", "list_invoices"] {
        assert!(
            named.iter().any(|n| n.contains(tool)),
            "{tool} in {named:?}"
        );
        let was = rows(&full, "Connector")
            .iter()
            .flatten()
            .any(|c| c.contains(tool));
        assert!(was, "{tool} is not in the full card");
    }
    for role in ["accountant", "finance_lead"] {
        assert!(
            stand_in.blocks.iter().any(|b| matches!(b, Block::P(t)
                if t.starts_with(&format!("May ask {role}")))),
            "{role}: {stand_in:?}"
        );
    }
    // What depends on the expansion is unknown, not a smaller number.
    assert_eq!(rows(&stand_in, "Dimension")[0][2..], ["unknown", "unknown"]);
    assert_eq!(rows(&stand_in, "Dimension")[3][2..], ["unknown", "unknown"]);
    assert!(
        stand_in.blocks.iter().any(|b| matches!(b, Block::Note(t)
            if t.starts_with("BatchWithExceptions of module std.patterns could not be expanded"))),
        "{stand_in:?}"
    );
    assert!(
        stand_in.blocks.iter().any(|b| matches!(b, Block::Note(t)
            if t.starts_with("A connector a tool belongs to is not given to this card"))),
        "{stand_in:?}"
    );
    assert!(
        !stand_in
            .blocks
            .iter()
            .any(|b| matches!(b, Block::P(t) if t.starts_with("Spend bound")))
    );
    // The authority view does not call a write tool it cannot see "not critical".
    let view = mandate_views::authority_with(&p, None);
    let wf = view.rows.iter().find(|r| r.who == "MatchInvoices").unwrap();
    assert!(
        wf.effects.contains(
            &"erp.post_draft_invoice (class not known: its connector is not given)".to_owned()
        ),
        "{:?}",
        wf.effects
    );
}

#[test]
fn the_hand_written_flow_has_the_same_card_without_a_pattern() {
    let p = program("fixtures/library/review.mdt");
    let m = {
        let mut m = Modules::new();
        for (k, v) in library_modules().iter() {
            m.insert(k, v.clone());
        }
        m
    };
    let doc = doc_of(&p, None, Some(&m));
    assert!(
        !doc.blocks
            .iter()
            .any(|b| matches!(b, Block::P(t) if t.starts_with("Applies the pattern")))
    );
    assert!(has_p(
        &doc,
        "Matches the invoices in the mailbox to open orders and posts each match to the ERP as a draft. Asks the accountant once about the rest, and the finance lead after a day."
    ));
    assert!(has_p(
        &doc,
        "Spend bound of map it: 60 × 0.30 USD = 18 USD ≤ 20 USD."
    ));
    assert!(has_p(
        &doc,
        "Each accepted item is posted as its own action by erp.post_draft_invoice (a critical write tool, retry class reconcilable), authorized by policy, idempotent by invoice_no. Nobody is asked about one item."
    ));
    assert_eq!(rows(&doc, "Contract")[2][1], "totals");
    assert_eq!(rows(&doc, "Connector").len(), 2);
}

/// A workflow with an envelope that has nothing of 0.6 to say has the card it
/// has in 0.5: not a block more, and no `library` member.
#[test]
fn a_card_with_an_envelope_is_the_card_it_was() {
    let file = "fixtures/envelope/migrate-all.mdt";
    let text = read_text(file).unwrap();
    let domain = read_text("fixtures/envelope/domain.mdt").unwrap();
    let load_modules = |header: &str| {
        let domain = domain.replacen("mandate @ 0.4", header, 1);
        let m = mandate_check::load_modules(&[mandate_check::ModuleSource {
            text: &domain,
            kind: SourceKind::Mdt,
            file: "domain.mdt",
        }])
        .modules;
        m
    };
    let old = load(&text, SourceKind::Mdt).program.unwrap();
    let old_card = card(
        &old,
        "MigrateAll",
        None,
        Some(&load_modules("mandate @ 0.4")),
    )
    .unwrap();
    assert!(!text_of(&old_card.to_js()).contains("\"library\""));
    // The same under the 0.6 header: the one thing 0.6 has to say of it is the
    // bound of its map against its budget; every other block is the same.
    let rewritten = text.replacen("mandate @ 0.4", "mandate @ 0.6", 1);
    let new = load(&rewritten, SourceKind::Mdt).program.unwrap();
    let m = load_modules("mandate @ 0.6");
    let new_card = card(&new, "MigrateAll", None, Some(&m)).unwrap();
    let library = new_card.library.as_ref().unwrap();
    assert!(library.envelope);
    assert_eq!(library.bounds.len(), 1);
    assert!(library.pattern.is_none() && library.tools.is_empty() && library.reviews.is_empty());
    let without_bound: Vec<Block> = mandate_views::card_blocks(&new_card)
        .into_iter()
        .filter(|b| !matches!(b, Block::P(t) if t.starts_with("Spend bound of map")))
        .collect();
    // (The package is another one: the program says 0.6.)
    let signed = |b: &Block| matches!(b, Block::P(t) if t.starts_with("An approval is signed"));
    let before: Vec<Block> = mandate_views::card_blocks(&old_card)
        .into_iter()
        .filter(|b| !signed(b))
        .collect();
    let after: Vec<Block> = without_bound.into_iter().filter(|b| !signed(b)).collect();
    assert_eq!(before, after);
}
