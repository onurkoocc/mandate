//! The reports of a program of 0.7 (spec/attention.md "`report`") where a
//! conformance case cannot say it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{CheckOptions, CheckResult, Modules, attention_facts, check};
use mandate_ir::JsValue;
use mandate_syntax::SourceKind;
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

#[test]
fn the_fixture_checks() {
    let text = read_text(REPORTS).unwrap();
    let r = checked(&text, None);
    println!("{:#?}", shown(&r));
    assert!(r.ok, "{:?}", shown(&r));
    for w in ["Greet", "MatchAll"] {
        let f = attention_facts(&text, SourceKind::Mdt, &CheckOptions::default(), w).unwrap();
        println!("{}", mandate_ir::stringify_pretty(&f.to_js()).unwrap());
    }
    let _ = JsValue::Null;
}
