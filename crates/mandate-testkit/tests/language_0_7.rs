//! Language 0.7 across the compiler (spec/attention.md "Version gating"):
//! a 0.6 program relabelled `mandate @ 0.7` checks as it did.
//!
//! - Every 0.6 program of the golden fixtures (`fixtures/library/`, the
//!   programs `vectors/golden/0.6.json` pins), its header (or its
//!   `language`) rewritten to 0.7 and nothing else, gives every output it
//!   gives as 0.6: the checks with their diagnostics whole (messages, spans,
//!   facts), `load`, the IR, `fmt`, the hashes, the views, the document, the
//!   comparison with itself, `sandbox`, the card and the sub-programs.
//! - Every compile case of 0.6 (`"language": "mandate/0.6"`) whose program
//!   declares 0.6 gives, with that program relabelled 0.7, the whole result
//!   its door gives: `check`, `check_patched` (the patched program
//!   relabelled), `apply_ops`, `check_subprogram` and `check_amendment` (the
//!   parent relabelled).
//!
//! What may differ, and nothing else: the version's text (`mandate/0.7`
//! for `mandate/0.6`, `mandate @ 0.7` for `mandate @ 0.6`), and the hashes,
//! whose domain prefix names the version, each only as a renaming (one hash
//! of 0.6 is the same hash of 0.7 wherever it stands, and no two of 0.6 are
//! one of 0.7). What is left out is left out by name: a library case
//! (`"library"`), which has no program to relabel, and a case of 0.6 whose
//! program declares another version (an unknown one, E0103; one of 0.5 that
//! meets what 0.6 adds), which is no program of 0.6. Each list is printed
//! and its length held. Of the rules of 0.7 that every 0.7 program meets,
//! the version of `std.patterns` it resolves is in the language (RL6): a
//! program of 0.7 without a pin reads 2.0.0, with its stages and reports,
//! where the same program of 0.6 read 1.0.0. The relabelling of a program
//! of 0.6 that imports `std.patterns` pins 1.0.0, its faithful translation:
//! its checks, and the checks of its sub-programs, are given the module of
//! 1.0.0 (`common::relabelled_modules`, the one helper of the Rust gates
//! that says so), and both gates print what it touched. E1909 with a lock is
//! not in the language yet; its slice adds its rule here. E1509 is, and
//! no program or case of 0.6 above has a criterion it refuses, so none is
//! left out for it (`crates/mandate-check/tests/reserved_methods.rs` holds
//! the 0.6 program that has one, clean).
//!
//! - Every code that 0.7 adds (`mandate_ir::codes::CODES_0_7`) has a
//!   conformance case of 0.7 that expects it, and every code a 0.7 case
//!   expects is in the table.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;
mod outputs;
mod rust_diagnostics;

use std::collections::{BTreeMap, BTreeSet};

use mandate_ir::codes::{self, Reference};
use mandate_ir::{JsValue, Language, Value, stringify};
use mandate_syntax::SourceKind;
use mandate_testkit::rust_vectors::programs_0_6;
use mandate_testkit::{compare_text, read_json, run_gate, subdirectories};

/// The compile cases of 0.6 whose door has no program to relabel: the
/// library cases (`add`, `upgrade`, `publish`, `verify`), by directory. The
/// whole list: a case of 0.6 added or taken away changes it.
const LIBRARY_CASES: &[&str] = &["L02", "L03", "L04", "L05", "L06"];

/// The compile cases of 0.6 whose program declares no 0.6, by directory:
/// one of an unknown version (`S02h`), and programs of 0.4 and 0.5 that
/// show what 0.6 changes (a `pub type`, `///` lines, `doc`, `pub` or
/// `shapes` in the IR, an effect named like a built-in one, the
/// constructors of `requires caps` compared, a module of 0.6 imported). The
/// whole list: a case of 0.6 added or taken away changes it.
const NOT_OF_0_6: &[&str] = &[
    "E0101e", "E0101f", "E0104d", "E0104g", "E0121b", "E0301b", "E1603", "E1603a", "S02h",
];

/// `text` with its one header `mandate @ 0.6` (or `language` member
/// `"mandate/0.6"`) written as 0.7: `None` when it has none (it is not a
/// program of 0.6), an error when it has more than one, since then which
/// one is the header is not known here.
fn as_0_7(text: &str, kind: SourceKind) -> Result<Option<String>, String> {
    let (from, to) = match kind {
        SourceKind::Mdt => ("mandate @ 0.6", "mandate @ 0.7"),
        SourceKind::Json => ("\"mandate/0.6\"", "\"mandate/0.7\""),
    };
    match text.matches(from).count() {
        0 => Ok(None),
        1 => Ok(Some(text.replacen(from, to, 1))),
        n => Err(format!("{n} times {from}: no one header to relabel")),
    }
}

/// The text with the hashes taken out (each `sha256:` and the hexadecimal
/// digits after it, as `sha256:#`), and the hashes, in order.
fn split_hashes(text: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(text.len());
    let mut hashes = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("sha256:") {
        let (head, tail) = rest.split_at(at);
        out.push_str(head);
        out.push_str("sha256:#");
        let hex = tail
            .get(7..)
            .unwrap_or_default()
            .bytes()
            .take_while(u8::is_ascii_hexdigit)
            .count();
        hashes.push(tail.get(..7 + hex).unwrap_or_default().to_owned());
        rest = tail.get(7 + hex..).unwrap_or_default();
    }
    out.push_str(rest);
    (out, hashes)
}

/// The hashes a comparison found renamed, both ways: of 0.6 to 0.7, and
/// back.
#[derive(Default)]
struct Renamed {
    forth: BTreeMap<String, String>,
    back: BTreeMap<String, String>,
}

impl Renamed {
    /// Takes the pair `(a, b)`: the same hash, or a renaming that agrees
    /// with every one seen before.
    fn take(&mut self, a: &str, b: &str) -> Result<(), String> {
        let forth = self.forth.get(a).map(String::as_str);
        let back = self.back.get(b).map(String::as_str);
        match (forth, back) {
            (None, None) if a == b => Ok(()),
            (None, None) => {
                self.forth.insert(a.to_owned(), b.to_owned());
                self.back.insert(b.to_owned(), a.to_owned());
                Ok(())
            }
            (Some(x), Some(y)) if x == b && y == a => Ok(()),
            _ => Err(format!(
                "{a} of 0.6 is {b} of 0.7 here, and {} elsewhere ({} of 0.6 elsewhere): a hash that is not a renaming",
                forth.unwrap_or(a),
                back.unwrap_or(b)
            )),
        }
    }
}

/// Compares a text of 0.6 with the same output of the program relabelled
/// 0.7: the same once the version's text is 0.6's, but for hashes renamed
/// ([`Renamed`]).
fn same_but_relabelled(a: &str, b: &str, renamed: &mut Renamed) -> Result<(), String> {
    let b = b
        .replace("mandate/0.7", "mandate/0.6")
        .replace("mandate @ 0.7", "mandate @ 0.6");
    let (text_a, hashes_a) = split_hashes(a);
    let (text_b, hashes_b) = split_hashes(&b);
    compare_text(&text_a, &text_b)?;
    for (x, y) in hashes_a.iter().zip(&hashes_b) {
        renamed.take(x, y)?;
    }
    Ok(())
}

#[test]
fn a_hash_may_differ_only_as_a_renaming() {
    let mut r = Renamed::default();
    let (a1, a2, b1, b2) = ("sha256:aa", "sha256:bb", "sha256:cc", "sha256:dd");
    assert!(same_but_relabelled(a1, b1, &mut r).is_ok());
    assert!(same_but_relabelled(&format!("{a1} {a1}"), &format!("{b1} {b1}"), &mut r).is_ok());
    // The same hash of 0.6 as another of 0.7 elsewhere.
    assert!(same_but_relabelled(a1, b2, &mut r).is_err());
    // Two hashes of 0.6 as one of 0.7.
    assert!(same_but_relabelled(a2, b1, &mut r).is_err());
    // A hash renamed in one place is not kept in another.
    assert!(same_but_relabelled(a1, a1, &mut r).is_err());
    // A hash that is the same in both is fine.
    assert!(same_but_relabelled(a2, a2, &mut r).is_ok());
    // The version's text is the only text that may differ.
    assert!(same_but_relabelled("mandate @ 0.6 x", "mandate @ 0.7 x", &mut r).is_ok());
    assert!(same_but_relabelled("\"mandate/0.6\"", "\"mandate/0.7\"", &mut r).is_ok());
    assert!(same_but_relabelled("0.6", "0.7", &mut r).is_err());
    assert_eq!(
        as_0_7("mandate @ 0.6\n", SourceKind::Mdt)
            .unwrap()
            .as_deref(),
        Some("mandate @ 0.7\n")
    );
    assert_eq!(as_0_7("mandate @ 0.5\n", SourceKind::Mdt).unwrap(), None);
    assert!(as_0_7("mandate @ 0.6\n// mandate @ 0.6\n", SourceKind::Mdt).is_err());
}

#[test]
fn every_0_6_fixture_under_the_0_7_header_gives_what_it_gives_as_0_6() {
    let programs = programs_0_6().expect("the 0.6 programs");
    let n = programs.len();
    let mut renamed_total: usize = 0;
    let mut std_patterns: Vec<String> = Vec::new();
    let mut pinned_1_0_0: Vec<String> = Vec::new();
    let mut problems: Vec<String> = Vec::new();
    let items = programs.iter().map(|p| (p.clone(), p.clone()));
    let gate = run_gate("0.6 fixtures as 0.7", &[], items, |p| {
        let text = common::read_source(p)?;
        let kind = mandate_syntax::kind_of(p);
        let rewritten = as_0_7(&text, kind)?.ok_or("no header of 0.6")?;
        if text.contains("std.patterns") {
            std_patterns.push(p.clone());
        }
        if common::relabelled_modules(&rewritten, kind).is_some() {
            pinned_1_0_0.push(p.clone());
        }
        let as_0_6 = outputs::outputs_of(p)?;
        let as_0_7 = outputs::outputs_of_relabelled(p, &rewritten)?;
        let names = |o: &[(String, String)]| o.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
        if names(&as_0_6) != names(&as_0_7) {
            return Err(format!(
                "outputs {:?} as 0.6, {:?} as 0.7",
                names(&as_0_6),
                names(&as_0_7)
            ));
        }
        let mut renamed = Renamed::default();
        for ((name, a), (_, b)) in as_0_6.iter().zip(&as_0_7) {
            same_but_relabelled(a, b, &mut renamed).map_err(|e| format!("{name}: {e}"))?;
        }
        // The version is in the program, its IR and its hash.
        let first = |o: &[(String, String)], n: &str| {
            o.iter().find(|(x, _)| x == n).map(|(_, t)| t.clone())
        };
        if first(&as_0_7, "ir --canonical").is_some_and(|t| !t.contains("\"mandate/0.7\"")) {
            return Err("the IR of 0.7 does not say mandate/0.7".to_owned());
        }
        if first(&as_0_6, "hash").is_some() && renamed.forth.is_empty() {
            return Err("0.6 and 0.7 hash the same".to_owned());
        }
        renamed_total += renamed.forth.len();
        Ok(())
    });
    if let Err(report) = gate {
        problems.push(report);
    }
    println!(
        "0.6 fixtures as 0.7: {n} programs, {renamed_total} hashes renamed; {} import std.patterns 1.0.0, a module of 0.6: {}",
        std_patterns.len(),
        std_patterns.join(", ")
    );
    println!(
        "0.6 fixtures as 0.7: {} relabelled with std.patterns 1.0.0 pinned (common::relabelled_modules): {}",
        pinned_1_0_0.len(),
        pinned_1_0_0.join(", ")
    );
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    assert!(n >= 10, "only {n} programs of 0.6 among the fixtures");
    // A program of 0.7 that imports std.patterns 1.0.0 (a module of 0.6) and
    // applies its patterns checks as it did as 0.6.
    assert!(
        std_patterns.len() >= 3,
        "only {} programs import std.patterns",
        std_patterns.len()
    );
}

/// What a 0.6 case is to the relabelling, by name.
enum Kind {
    /// Compared.
    Compared,
    /// A library case: no program.
    Library,
    /// Its program declares no 0.6.
    NotOf06,
}

#[test]
fn every_0_6_conformance_case_under_the_0_7_header_gives_what_it_gives_as_0_6() {
    let mut items: Vec<(String, String)> = Vec::new();
    for id in subdirectories("conformance").unwrap() {
        let case = read_json(&format!("conformance/{id}/case.json")).unwrap();
        if case.get("language").and_then(Value::as_str) == Some(Language::V0_6.as_str())
            && case.get("kind").and_then(Value::as_str) == Some("compile")
        {
            items.push((format!("conformance/{id}"), id));
        }
    }
    let n = items.len();
    let mut kinds: BTreeMap<String, Kind> = BTreeMap::new();
    let mut by_door: BTreeMap<&str, usize> = BTreeMap::new();
    let mut pinned_1_0_0: Vec<String> = Vec::new();
    let gate = run_gate("0.6 cases as 0.7", &[], items, |id| {
        let case = read_json(&format!("conformance/{id}/case.json"))?;
        let door = rust_diagnostics::door_of(&case);
        if door == "library" {
            kinds.insert(id.clone(), Kind::Library);
            return Ok(());
        }
        let as_0_6 =
            rust_diagnostics::result_of_text(id, &case, door, &rust_diagnostics::as_it_is)?
                .ok_or("no result")?;
        let Some((as_0_7, pinned)) =
            rust_diagnostics::result_of_relabelled(id, &case, door, &as_0_7)?
        else {
            kinds.insert(id.clone(), Kind::NotOf06);
            return Ok(());
        };
        let text = |v: &JsValue| stringify(v).unwrap_or_default();
        let mut renamed = Renamed::default();
        same_but_relabelled(&text(&as_0_6), &text(&as_0_7), &mut renamed)?;
        if pinned {
            pinned_1_0_0.push(id.clone());
        }
        kinds.insert(id.clone(), Kind::Compared);
        *by_door.entry(door).or_default() += 1;
        Ok(())
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
    let named = |k: fn(&Kind) -> bool| -> Vec<&str> {
        kinds
            .iter()
            .filter(|(_, v)| k(v))
            .map(|(id, _)| id.as_str())
            .collect()
    };
    let compared = named(|k| matches!(k, Kind::Compared));
    let library = named(|k| matches!(k, Kind::Library));
    let not_of_0_6 = named(|k| matches!(k, Kind::NotOf06));
    println!(
        "0.6 cases as 0.7: {n} cases; {} compared ({by_door:?}); left out, {} library cases with no program: {}; {} whose program declares no 0.6: {}",
        compared.len(),
        library.len(),
        library.join(", "),
        not_of_0_6.len(),
        not_of_0_6.join(", ")
    );
    println!(
        "0.6 cases as 0.7: {} relabelled with std.patterns 1.0.0 pinned (common::relabelled_modules): {}",
        pinned_1_0_0.len(),
        pinned_1_0_0.join(", ")
    );
    assert_eq!(library, LIBRARY_CASES, "the library cases");
    assert_eq!(not_of_0_6, NOT_OF_0_6, "the cases of 0.6 of no 0.6 program");
    assert!(
        compared.len() >= 200,
        "only {} cases compared",
        compared.len()
    );
}

/// The codes of `added` (the codes a version adds) that no case of `cases`
/// expects.
fn without_case<'a>(added: &[&'a str], cases: &[(String, BTreeSet<String>)]) -> Vec<&'a str> {
    added
        .iter()
        .filter(|c| !cases.iter().any(|(_, codes)| codes.contains(**c)))
        .copied()
        .collect()
}

/// The codes each compile case of 0.7 (whose `language` is `mandate/0.7`)
/// expects.
fn codes_of_0_7_cases() -> Vec<(String, BTreeSet<String>)> {
    let mut out = Vec::new();
    for id in subdirectories("conformance").unwrap() {
        let case = read_json(&format!("conformance/{id}/case.json")).unwrap();
        if case.get("language").and_then(Value::as_str) != Some(Language::V0_7.as_str()) {
            continue;
        }
        let codes: BTreeSet<String> = case
            .get("expect")
            .and_then(|e| e.get("diagnostics"))
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(|d| d.get("code").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        out.push((id, codes));
    }
    out
}

/// Every code 0.7 adds has a conformance case of 0.7 that expects it, and
/// every code a 0.7 case expects is a row of the table.
#[test]
fn every_code_of_0_7_has_a_case_of_0_7() {
    let cases = codes_of_0_7_cases();
    assert!(!cases.is_empty(), "no conformance case of 0.7");
    let added: Vec<&str> = codes::iter()
        .filter(|r| r.since() == Some(Language::V0_7))
        .map(|r| r.code)
        .collect();
    assert_eq!(added, codes::CODES_0_7, "the codes of 0.7, in the table");
    assert!(
        added
            .iter()
            .all(|c| codes::lookup(c).is_some_and(|r| r.reference == Reference::Rust)),
        "a code of 0.7 is a row of the Rust"
    );
    let missing = without_case(&added, &cases);
    assert!(
        missing.is_empty(),
        "codes of 0.7 with no conformance case of 0.7 that expects them: {missing:?}"
    );
    // The rule finds a code with no case: one no case of 0.7 expects (a
    // made-up code), beside two that cases of 0.7 expect.
    assert_eq!(
        without_case(&["MDT-E1999", "MDT-E1901", "MDT-E0104"], &cases),
        ["MDT-E1999"]
    );
    let table: BTreeSet<&str> = codes::iter().map(|r| r.code).collect();
    for (id, codes) in &cases {
        for code in codes {
            assert!(
                table.contains(code.as_str()),
                "conformance/{id} expects {code}, which the table of codes does not have"
            );
        }
    }
    println!(
        "codes: {} added by 0.7, each with a case of 0.7; {} cases of 0.7",
        added.len(),
        cases.len()
    );
}
