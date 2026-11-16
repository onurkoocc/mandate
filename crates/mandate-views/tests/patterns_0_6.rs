//! The views of a program of 0.6 that defines or applies a pattern
//! (spec/library.md "Patterns"): none fails, and none shows a workflow that
//! applies a pattern as one that does nothing. A workflow is shown as its
//! expansion when the view can expand it (its pattern is the program's, or
//! in a module the view is given), else as a stand-in that names the
//! application and what its arguments name, and says that its cost is
//! unknown. Another chain presents patterns later; this holds only that
//! much. No TypeScript reads 0.6, so every expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{ModuleSource, Modules, load_modules};
use mandate_ir::{JsValue, Value, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::read_text;
use mandate_views::{architecture, authority, cost, program_doc, to_markdown};

fn program(file: &str) -> Value {
    load(&read_text(file).unwrap(), SourceKind::Mdt)
        .program
        .unwrap()
}

fn modules() -> Modules {
    let files = [
        "fixtures/library/acme.connectors/types.mdt",
        "fixtures/library/acme.connectors/connectors.mdt",
        "fixtures/library/batch.patterns.mdt",
    ];
    let texts: Vec<(String, String)> = files
        .iter()
        .map(|f| ((*f).to_owned(), read_text(f).unwrap()))
        .collect();
    let sources: Vec<ModuleSource<'_>> = texts
        .iter()
        .map(|(file, text)| ModuleSource {
            text,
            kind: SourceKind::Mdt,
            file,
        })
        .collect();
    load_modules(&sources).modules
}

fn text(v: &JsValue) -> String {
    stringify(v).unwrap()
}

#[test]
fn a_workflow_that_applies_a_local_pattern_is_shown_as_its_expansion() {
    let p = program("conformance/P02/program.mdt");
    let arch = text(&architecture(&p).to_js());
    assert!(arch.contains("Matcher.match"), "{arch}");
    let auth = text(&authority(&p).to_js());
    assert!(auth.contains("erp.post_draft"), "{auth}");
    let c = text(&cost(&p, None).to_js());
    assert!(c.contains("MatchAll"), "{c}");
    let doc = to_markdown(&program_doc(&p, None, None));
    assert!(doc.contains("Matcher.match"), "{doc}");
}

#[test]
fn an_imported_pattern_is_expanded_with_its_module_and_named_without() {
    let p = program("fixtures/library/batch.mdt");
    // Without the module: the delegation an argument names, to an agent of
    // the program's own.
    let arch = text(&architecture(&p).to_js());
    assert!(arch.contains("Matcher.match"), "{arch}");
    let auth = text(&authority(&p).to_js());
    assert!(auth.contains("MatchInvoices"), "{auth}");
    assert!(text(&cost(&p, None).to_js()).contains("MatchInvoices"));
    // With it: the expansion, its delegation and its commit.
    let m = modules();
    let doc = to_markdown(&program_doc(&p, None, Some(&m)));
    assert!(doc.contains("Matcher.match"), "{doc}");
    assert!(doc.contains("erp.post_draft_invoice"), "{doc}");
    let diff = text(&mandate_check::semantic_diff(&p, &p, None).to_js());
    assert!(!diff.contains("no external effects"), "{diff}");
}

/// The effects the authority view shows a workflow commit, each without how
/// it is authorized.
fn effects_of(v: &mandate_views::AuthorityView, who: &str) -> Vec<String> {
    v.rows
        .iter()
        .filter(|r| r.who == who)
        .flat_map(|r| r.effects.iter())
        .map(|e| e.split(" (").next().unwrap_or_default().to_owned())
        .collect()
}

/// The views a door gives with the modules show the expansion of a pattern
/// of one of them: its commit, its review, and its cost, 60 delegations of
/// the map's bound. Without them, a stand-in shows no less authority than
/// the expansion has (the write tool its commit slot is given, a review by
/// each role it is given) and says that the cost is unknown rather than
/// print a number.
#[test]
fn the_views_of_an_imported_pattern_show_its_commit_its_review_and_its_cost() {
    let p = program("fixtures/library/batch.mdt");
    let m = modules();
    // With the modules: the expansion.
    let auth = mandate_views::authority_with(&p, Some(&m));
    assert_eq!(
        effects_of(&auth, "MatchInvoices"),
        ["erp.post_draft_invoice"]
    );
    let arch = mandate_views::architecture_with(&p, Some(&m));
    let kinds: Vec<(&str, &str)> = arch.workflows[0]
        .nodes
        .iter()
        .map(|n| (n.kind.as_str(), n.label.as_str()))
        .collect();
    assert_eq!(
        kinds,
        [
            ("map", "map it"),
            ("delegate", "Matcher.match"),
            ("verify", "verify Matched"),
            ("human", "person: review"),
            ("map", "map v"),
            ("effect", "erp.post_draft_invoice")
        ]
    );
    let review = &arch.workflows[0].nodes[3];
    assert_eq!(
        review.detail,
        ["role accountant", "escalate to finance_lead"]
    );
    let c = mandate_views::cost_with(&p, None, Some(&m));
    let w = &c.workflows[0];
    assert_eq!(w.rows[0].times, 60.0);
    assert_eq!(w.total, "18 USD · 3600000 tokens · 240 steps");
    // Without them: the stand-in.
    let alone = authority(&p);
    let shown = effects_of(&alone, "MatchInvoices");
    for e in effects_of(&auth, "MatchInvoices") {
        assert!(shown.contains(&e), "{e} is not in {shown:?}");
    }
    let arch = architecture(&p);
    let people: Vec<&[String]> = arch.workflows[0]
        .nodes
        .iter()
        .filter(|n| n.kind.as_str() == "human")
        .map(|n| n.detail.as_slice())
        .collect();
    assert_eq!(
        people,
        [
            ["role accountant".to_owned()],
            ["role finance_lead".to_owned()]
        ]
    );
    let c = cost(&p, None);
    let w = &c.workflows[0];
    assert!(w.total.starts_with("unknown: "), "{}", w.total);
    assert!(w.rows.iter().all(|r| r.times.is_nan()));
    let js = text(&c.to_js());
    assert!(js.contains(r#""times":null"#), "{js}");
    let md = to_markdown(&program_doc(&p, None, None));
    assert!(md.contains("| Matcher.match | unknown |"), "{md}");
    // The doors take the modules; without them they answer as before.
    let door = |name: &str, with: bool| {
        let mut input = mandate_ir::Map::new();
        input.insert("program", p.clone());
        if with {
            input.insert("modules", Value::Object(m.clone()));
        }
        let d = mandate_views::json_doors::door(name).unwrap();
        text(&(d.call)(&Value::Object(input)).unwrap())
    };
    assert_eq!(door("authority", true), text(&auth.to_js()));
    assert_eq!(door("authority", false), text(&alone.to_js()));
    assert!(door("cost", true).contains(r#""times":60"#));
    assert!(door("architecture", true).contains("person: review"));
    let mut input = mandate_ir::Map::new();
    input.insert("before", p.clone());
    input.insert("after", p.clone());
    input.insert("modules", Value::Object(m.clone()));
    let d = mandate_views::json_doors::door("diff_doc").unwrap();
    let doc = text(&(d.call)(&Value::Object(input)).unwrap());
    assert!(
        doc.contains("external effects unchanged: erp.post_draft_invoice"),
        "{doc}"
    );
}

/// A program that applies no pattern is shown the same with the modules and
/// without them, so a door given them answers what the TypeScript does. The
/// authority of a program of 0.6 is the one thing the modules add to: they
/// bring the connectors, so that its tools are what they declare, and a write
/// tool is the critical effect it declares; without them the tools and the
/// effect are said not to be known (RP4).
#[test]
fn the_views_of_a_program_that_applies_no_pattern_do_not_depend_on_the_modules() {
    let p = program("fixtures/library/review.mdt");
    let m = modules();
    let with = text(&mandate_views::authority_with(&p, Some(&m)).to_js());
    assert!(
        with.contains("erp.post_draft_invoice (critical; policy authorizes)"),
        "{with}"
    );
    assert!(
        with.contains("erp.post_draft_invoice (write, critical, retry reconcilable)"),
        "{with}"
    );
    let without = text(&authority(&p).to_js());
    assert!(
        without.contains("erp.post_draft_invoice (class not known: its connector is not given)"),
        "{without}"
    );
    assert!(!without.contains("not critical"), "{without}");
    assert_eq!(
        text(&architecture(&p).to_js()),
        text(&mandate_views::architecture_with(&p, Some(&m)).to_js())
    );
    assert_eq!(
        text(&cost(&p, None).to_js()),
        text(&mandate_views::cost_with(&p, None, Some(&m)).to_js())
    );
}

/// The acceptance program, whose pattern is the built-in std.patterns and
/// whose connectors and types are a library's: given the library's modules,
/// as a package carries them, the views show the expansion (the commit of
/// each draft, the review, the cost of 60 delegations at 0.30 USD); the
/// views add the built-in std.patterns themselves.
#[test]
fn the_acceptance_program_is_shown_as_its_expansion_with_its_library() {
    let p = program("fixtures/library/invoices.mdt");
    let (manifest, files) =
        mandate_testkit::library_files("fixtures/library/acme.connectors").unwrap();
    let lib = mandate_check::library::load_library(
        &mandate_check::library::LibrarySource { manifest, files },
        false,
        "acme",
    )
    .unwrap();
    let auth = text(&mandate_views::authority_with(&p, Some(&lib.modules)).to_js());
    assert!(auth.contains("erp.post_draft_invoice"), "{auth}");
    let arch = text(&mandate_views::architecture_with(&p, Some(&lib.modules)).to_js());
    assert!(arch.contains("person: review"), "{arch}");
    let c = text(&mandate_views::cost_with(&p, None, Some(&lib.modules)).to_js());
    assert!(c.contains("18 USD"), "{c}");
}

#[test]
fn a_module_of_patterns_has_views() {
    let p = program("fixtures/library/batch.patterns.mdt");
    // A module of a type and a pattern runs nothing: no workflow is shown.
    assert!(architecture(&p).workflows.is_empty());
    assert!(cost(&p, None).workflows.is_empty());
    assert!(text(&authority(&p).to_js()).contains("batch.patterns"));
    assert!(to_markdown(&program_doc(&p, None, None)).contains("batch.patterns"));
}
