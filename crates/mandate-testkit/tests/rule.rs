//! The pending-list rule and the comparisons, on items made up here.

#![allow(clippy::unwrap_used, clippy::panic, missing_docs)]

use mandate_testkit::{Golden, compare_digest, compare_text, parse_json, run_gate, sha256};

/// Items `a1`, `a2`, `b1`; those in `failing` fail.
fn gate(pending: &[&str], failing: &[&str]) -> Result<String, String> {
    let items = ["a1", "a2", "b1"].map(|n| (n.to_owned(), n));
    run_gate("made up", pending, items, |n| {
        if failing.contains(n) {
            Err(format!("{n} is wrong"))
        } else {
            Ok(())
        }
    })
}

#[test]
fn every_item_not_on_the_list_passes() {
    assert_eq!(
        gate(&[], &[]).unwrap(),
        "made up: ran 3, passed 3, pending 0"
    );
    assert_eq!(
        gate(&["a*"], &["a1", "a2"]).unwrap(),
        "made up: ran 3, passed 1, pending 2"
    );
    let report = gate(&["a1"], &["a1", "b1"]).unwrap_err();
    assert!(report.starts_with("made up: ran 3, passed 1, pending 1\n1 problem(s):\n"));
    assert!(report.contains("b1: b1 is wrong"), "{report}");
}

#[test]
fn an_item_on_the_list_that_passes_is_an_error() {
    let report = gate(&["a*"], &["a1"]).unwrap_err();
    assert!(report.starts_with("made up: ran 3, passed 2, pending 1\n"));
    assert!(
        report.contains("a2: passes, but the pending entry \"a*\" lists it"),
        "{report}"
    );
}

#[test]
fn an_entry_that_names_no_item_is_an_error() {
    let report = gate(&["a*", "c1"], &["a1", "a2"]).unwrap_err();
    assert!(
        report.contains("the pending entry \"c1\" names no item"),
        "{report}"
    );
}

#[test]
fn a_name_given_twice_is_an_error() {
    let items = [("x", ()), ("x", ())].map(|(n, t)| (n.to_owned(), t));
    let report = run_gate("twice", &[], items, |()| Ok(())).unwrap_err();
    assert!(
        report.contains("x: the gate names this item twice"),
        "{report}"
    );
}

#[test]
fn a_mismatch_shows_where_it_is() {
    assert_eq!(compare_text("a\nb\n", "a\nb\n"), Ok(()));
    assert_eq!(
        compare_text("a\nb\nc", "a\nx\nc").unwrap_err(),
        "first difference at line 2\n    expected: \"b\"\n    actual:   \"x\""
    );
    assert_eq!(
        compare_text("a\n", "a").unwrap_err(),
        "first difference at line 2\n    expected: \"\"\n    actual:   (end of text)"
    );
    assert_eq!(compare_digest(&sha256("[]\n"), "[]\n"), Ok(()));
    let wrong = compare_digest(&sha256("[]\n"), "{}\n").unwrap_err();
    assert!(
        wrong.contains("got sha256:") && wrong.contains("\"{}\""),
        "{wrong}"
    );
}

#[test]
fn the_golden_file_is_read_in_its_order() {
    let golden = Golden::from_value(
        &parse_json(br#"{"p.mdt": {"load": "sha256:1", "fmt": "sha256:2"}, "q.ir.json": {"load": "sha256:3"}}"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        golden.programs().collect::<Vec<_>>(),
        ["p.mdt", "q.ir.json"]
    );
    assert_eq!(golden.output_names(), ["load", "fmt"]);
    assert_eq!(golden.digest("q.ir.json", "load"), Some("sha256:3"));
    assert_eq!(golden.digest("q.ir.json", "fmt"), None);
    let names: Vec<String> = golden.outputs().map(|o| o.name()).collect();
    assert_eq!(names, ["load @ p.mdt", "fmt @ p.mdt", "load @ q.ir.json"]);
    // `[]\n` is what `load` prints for a program without diagnostics.
    assert_eq!(
        sha256("[]\n"),
        "sha256:37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570"
    );
}
