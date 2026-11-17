//! The views of a program of 0.7 whose lock pins `std.patterns` 1.0.0
//! (spec/attention.md "Which version"): each view reads the version the
//! lock pins, or the version a caller that holds no lock names
//! (`std_patterns`), and with neither the version of the program's
//! language, as before. What a document says it was generated from does
//! not change with the version. No TypeScript reads 0.7, so every
//! expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::Modules;
use mandate_check::library::{Version, std_patterns_for};
use mandate_ir::{JsObject, JsValue, Value, parse, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{read_json, read_text};
use mandate_views::{
    architecture_pinned, architecture_with_lock, authority_pinned, authority_with, cost_pinned,
    cost_with, diff_doc_pinned, program_doc, program_doc_pinned,
};

const BATCH: &str = "fixtures/attention/batch.mdt";

/// A lock of 0.7 that pins std.patterns 1.0.0 (`conformance/E1609c`).
const LOCK_1_0_0: &str = "conformance/E1609c/mandate.lock.json";

fn program() -> Value {
    load(&read_text(BATCH).unwrap(), SourceKind::Mdt)
        .program
        .unwrap()
}

fn one() -> Version {
    Version::parse("1.0.0").unwrap()
}

/// The module of std.patterns 1.0.0, given as a module.
fn one_as_module() -> Modules {
    let mut m = Modules::new();
    for (name, ir) in std_patterns_for(None, Some(&one())).unwrap().modules.iter() {
        m.insert(name, ir.clone());
    }
    m
}

fn text(v: &JsValue) -> String {
    stringify(v).unwrap()
}

/// The stages of the workflow's expansion, as a view reads it.
fn stages(pin: Option<&Version>) -> usize {
    let e = mandate_check::expand::for_views_pinned(&program(), None, pin).unwrap();
    e.get("defs")
        .and_then(|d| d.get("MatchAll"))
        .and_then(|w| w.get("body"))
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter(|s| s.get("op").and_then(Value::as_str) == Some("stage"))
        .count()
}

#[test]
fn the_expansion_a_view_reads_is_of_the_version_pinned() {
    assert_eq!(stages(None), 4, "2.0.0, the version of 0.7");
    assert_eq!(stages(Some(&one())), 0, "1.0.0");
    assert_eq!(stages(Version::parse("2.0.0").ok().as_ref()), 4);
}

#[test]
fn each_view_reads_the_lock_s_pin_or_the_version_named() {
    let p = program();
    let lock = read_json(LOCK_1_0_0).unwrap();
    let given = one_as_module();
    // What the version 1.0.0 shows: the views of the program handed its
    // module.
    let arch = text(&architecture_with_lock(&p, None, Some(&given)).to_js());
    let auth = text(&authority_with(&p, Some(&given)).to_js());
    let cost = text(&cost_with(&p, None, Some(&given)).to_js());
    let cost_locked = text(&cost_with(&p, Some(&lock), Some(&given)).to_js());
    // With the lock, or with the version named, the same.
    assert_eq!(
        text(&architecture_with_lock(&p, Some(&lock), None).to_js()),
        arch
    );
    assert_eq!(
        text(&architecture_pinned(&p, None, None, Some(&one())).to_js()),
        arch
    );
    assert_eq!(
        text(&authority_pinned(&p, None, Some(&one())).to_js()),
        auth
    );
    assert_eq!(text(&cost_with(&p, Some(&lock), None).to_js()), cost_locked);
    assert_eq!(
        text(&cost_pinned(&p, None, None, Some(&one())).to_js()),
        cost
    );
    // The lock wins over a version named.
    let two = Version::parse("2.0.0").unwrap();
    assert_eq!(
        text(&cost_pinned(&p, Some(&lock), None, Some(&two)).to_js()),
        cost_locked
    );
}

#[test]
fn the_document_says_what_it_was_generated_from_whatever_the_version() {
    let p = program();
    let alone = program_doc(&p, None, None);
    let pinned = program_doc_pinned(&p, None, None, Some(&one()));
    assert_eq!(alone.meta, pinned.meta);
    assert!(
        pinned
            .meta
            .iter()
            .any(|(k, v)| k == "View" && v.ends_with("generated from the program alone")),
        "{:?}",
        pinned.meta
    );
    // The diff document of the program with itself, pinned, as well.
    let d = diff_doc_pinned(&p, &p, None, None, Some(&one()));
    assert!(
        d.meta
            .iter()
            .any(|(k, v)| k == "View" && v.ends_with("generated from the two programs"))
    );
}

/// The view doors take `std_patterns`, refuse one the compiler does not
/// embed, and refuse one that is not the version the lock they are given
/// pins.
#[test]
fn the_view_doors_take_std_patterns_and_refuse_a_wrong_one() {
    let p = program();
    let lock = read_json(LOCK_1_0_0).unwrap();
    let input = |door: &str, pin: &str, with_lock: bool| {
        let mut o = JsObject::new().with("program", JsValue::from(&p));
        if with_lock {
            o.insert("lock", JsValue::from(&lock));
        }
        o.insert("std_patterns", pin);
        let v = parse(&stringify(&JsValue::Object(o)).unwrap())
            .unwrap()
            .value;
        (mandate_views::json_doors::door(door).unwrap().call)(&v)
    };
    let direct = text(&architecture_pinned(&p, None, None, Some(&one())).to_js());
    assert_eq!(
        text(&input("architecture", "1.0.0", false).unwrap()),
        direct
    );
    assert_eq!(text(&input("architecture", "1.0.0", true).unwrap()), direct);
    for door in ["architecture", "authority", "cost", "program_doc"] {
        let e = input(door, "4.0.0", false).unwrap_err();
        assert_eq!(
            e.message,
            "`std_patterns`: \"4.0.0\" is not a version of std.patterns this compiler embeds (1.0.0, 2.0.0): a pin of std.patterns is one of them",
            "{door}"
        );
    }
    for door in ["architecture", "cost", "program_doc"] {
        let e = input(door, "2.0.0", true).unwrap_err();
        assert_eq!(
            e.message,
            "`std_patterns`: the lock pins std.patterns 1.0.0, and std_patterns names 2.0.0: give the one the lock pins, or none",
            "{door}"
        );
    }
}
