//! The views of a program of 0.6 that defines or applies a pattern
//! (spec/library.md "Patterns"): none fails, and none shows a workflow that
//! applies a pattern as one that does nothing. A workflow is shown as its
//! expansion when the view can expand it (its pattern is the program's, or
//! in a module the view is given), else as one step that names the
//! application. Another chain presents patterns later; this holds only that
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

#[test]
fn a_module_of_patterns_has_views() {
    let p = program("fixtures/library/batch.patterns.mdt");
    // A module of a type and a pattern runs nothing: no workflow is shown.
    assert!(architecture(&p).workflows.is_empty());
    assert!(cost(&p, None).workflows.is_empty());
    assert!(text(&authority(&p).to_js()).contains("batch.patterns"));
    assert!(to_markdown(&program_doc(&p, None, None)).contains("batch.patterns"));
}
