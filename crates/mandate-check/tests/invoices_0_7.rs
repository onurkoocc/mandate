//! The acceptance program of release 0.7 (spec/attention.md "Acceptance"):
//! `fixtures/attention/invoices.mdt`, the invoice flow of 0.6 with four lines
//! changed, and its lock. It checks clean with its lock and its libraries;
//! its facts are what the spec's attention view of the invoice flow says
//! (four stages, two reports to the accountant, an attention bound of 2);
//! and the single patches of the plan's table of mutations that the compiler
//! can refuse today each give their code, E1909 (the accountant's class)
//! among them (RL5b). No TypeScript reads 0.7, so every expectation is
//! written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_check::library::LibrarySource;
use mandate_check::{CheckOptions, CheckResult, attention_facts, check};
use mandate_ir::{Value, parse, stringify, validate_lock};
use mandate_syntax::SourceKind;
use mandate_testkit::{library_files, read_json, read_text};

const INVOICES: &str = "fixtures/attention/invoices.mdt";
const LOCK: &str = "fixtures/attention/invoices.lock.json";
const CONNECTORS: &str = "fixtures/library/acme.connectors";

fn libraries() -> Vec<LibrarySource> {
    let (manifest, files) = library_files(CONNECTORS).unwrap();
    vec![LibrarySource { manifest, files }]
}

fn checked_with(text: &str, lock: &Value) -> CheckResult {
    let libraries = libraries();
    check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            lock: Some(lock),
            libraries: Some(&libraries),
            ..CheckOptions::default()
        },
    )
}

/// `code at path` of each diagnostic but the warnings the 0.6 program has
/// too (W0601: a static criterion that becomes a run-time check).
fn found(r: &CheckResult) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d.code != "MDT-W0601")
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// The text with `from` (which must be in it once) written `to`.
fn patched(from: &str, to: &str) -> String {
    let t = read_text(INVOICES).unwrap();
    assert_eq!(t.matches(from).count(), 1, "{from}");
    t.replace(from, to)
}

#[test]
fn it_is_the_invoice_flow_of_0_6_with_four_lines_changed() {
    let old = read_text("fixtures/library/invoices.mdt").unwrap();
    let new = read_text(INVOICES).unwrap();
    let (old, new): (Vec<&str>, Vec<&str>) = (old.lines().collect(), new.lines().collect());
    // Four lines of the new program are not in the old: the header, the
    // module, `owner` and the budget; three of the old are not in the new.
    let added = new.iter().filter(|l| !old.contains(l)).count();
    let gone = old.iter().filter(|l| !new.contains(l)).count();
    assert_eq!((old.len() + 1, added, gone), (new.len(), 4, 3));
}

#[test]
fn it_checks_with_its_lock_and_the_lock_is_one_its_schema_takes() {
    let lock = read_json(LOCK).unwrap();
    assert!(validate_lock(&lock).is_empty());
    let r = checked_with(&read_text(INVOICES).unwrap(), &lock);
    assert!(r.ok, "{:?}", found(&r));
    assert_eq!(found(&r), Vec::<String>::new());
    // Its lock pins the 0.7 version of the pattern and gives its roles a
    // class that makes the reports it makes legitimate.
    assert_eq!(
        lock.get("libraries")
            .and_then(|l| l.get("std.patterns"))
            .and_then(|p| p.get("version"))
            .and_then(Value::as_str),
        Some("2.0.0")
    );
    for role in ["accountant", "finance_lead"] {
        assert_eq!(
            lock.get("role_classes")
                .and_then(|c| c.get(role))
                .and_then(Value::as_str),
            Some("confidential")
        );
    }
    assert_eq!(
        lock.get("promotion").and_then(Value::as_str),
        Some("required")
    );
}

#[test]
fn its_facts_are_what_the_spec_says_of_the_invoice_flow() {
    let lock = read_json(LOCK).unwrap();
    let libraries = libraries();
    let facts = attention_facts(
        &read_text(INVOICES).unwrap(),
        SourceKind::Mdt,
        &CheckOptions {
            lock: Some(&lock),
            libraries: Some(&libraries),
            ..CheckOptions::default()
        },
        "MatchInvoices",
    )
    .expect("the facts of a program that checks");
    let f: Value = parse(&stringify(&facts.to_js()).unwrap()).unwrap().value;
    let names = |member: &str, key: &str| -> Vec<String> {
        f.get(member)
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .map(|s| s.get(key).and_then(Value::as_str).unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        names("stages", "title"),
        [
            "Collect the items",
            "Work on each item",
            "Decide on the exceptions",
            "Commit what was accepted"
        ]
    );
    assert_eq!(names("reports", "title"), ["Items collected", "Batch done"]);
    assert_eq!(names("reports", "role"), ["accountant", "accountant"]);
    assert_eq!(names("reports", "stage"), ["collect", "commit"]);
    // Every field is a whole number the run counts, shown confidential.
    for r in f.get("reports").and_then(Value::as_array).unwrap() {
        for field in r.get("fields").and_then(Value::as_array).unwrap() {
            assert_eq!(field.get("type").and_then(Value::as_str), Some("Int"));
            assert_eq!(field.get("known").and_then(Value::as_str), Some("plain"));
            assert_eq!(
                field.get("class").and_then(Value::as_str),
                Some("confidential")
            );
        }
    }
    // The bound: two questions in all, one for each role of the review, the
    // finance lead's only after the accountant's deadline.
    assert_eq!(f.get("asks").and_then(Value::as_i64), Some(2));
    assert_eq!(names("questions", "role"), ["accountant", "finance_lead"]);
    let totals = f.get("totals").unwrap();
    assert_eq!(totals.get("questions").and_then(Value::as_i64), Some(2));
}

#[test]
fn a_bound_below_the_questions_is_refused() {
    let lock = read_json(LOCK).unwrap();
    let r = checked_with(&patched("asks: 2", "asks: 1"), &lock);
    assert_eq!(
        found(&r).iter().map(|s| &s[..9]).collect::<Vec<_>>(),
        ["MDT-E1906"],
        "{:?}",
        found(&r)
    );
}

#[test]
fn a_lock_that_requires_promotion_refuses_a_flow_nobody_owns() {
    let lock = read_json(LOCK).unwrap();
    let r = checked_with(&patched("  owner  accountant\n", ""), &lock);
    assert_eq!(
        found(&r).iter().map(|s| &s[..9]).collect::<Vec<_>>(),
        ["MDT-E1910"],
        "{:?}",
        found(&r)
    );
}

#[test]
fn a_lock_that_lowers_the_accountant_refuses_what_the_flow_shows_it() {
    // The plan's mutation of E1909: the accountant's class lowered to
    // internal. Every site of the flow that shows it confidential invoices
    // is refused, the finance lead keeping its class; a site the expansion
    // brings is reported at the application.
    let mut lock = read_json(LOCK).unwrap();
    if let Value::Object(m) = &mut lock
        && let Some(Value::Object(c)) = m.get_mut("role_classes")
    {
        c.insert("accountant", "internal");
    }
    let r = checked_with(&read_text(INVOICES).unwrap(), &lock);
    let got = found(&r);
    assert!(!r.ok);
    assert!(!got.is_empty());
    assert!(
        got.iter()
            .all(|d| d.starts_with("MDT-E1909 at /defs/MatchInvoices")),
        "{got:?}"
    );
    let e1909 = r.diagnostics.iter().filter(|d| d.code == "MDT-E1909");
    for d in e1909 {
        let facts = stringify(&mandate_ir::JsValue::Object(
            d.facts.clone().unwrap_or_default(),
        ))
        .unwrap();
        assert!(
            facts.contains(r#""role":"accountant""#)
                && facts.contains(r#""class":"internal""#)
                && facts.contains(r#""shown":"confidential""#),
            "{facts}"
        );
        assert!(
            d.message
                .contains("Role accountant may be shown data up to internal"),
            "{}",
            d.message
        );
    }
    // With the lock as it is, the flow checks (it_checks_with_its_lock_…).
    assert!(checked_with(&read_text(INVOICES).unwrap(), &read_json(LOCK).unwrap()).ok);
}
