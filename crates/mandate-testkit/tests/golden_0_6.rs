//! The golden gate of language 0.6: the digest of every output text of
//! every 0.6 program of the repository (`fixtures/library/`), pinned in
//! `vectors/golden/0.6.json`, which the Rust writes (no TypeScript reads
//! 0.6). The file has the shape of `compiler/test/golden/outputs.json` and
//! its outputs are made by the same code: `outputs::outputs_of`, which the
//! first test holds to every digest of the TypeScript's golden file.
//!
//! A normal run compares; `MANDATE_UPDATE_0_6=1` writes the file again
//! (`mandate_testkit::rust_vectors`). The file catches a regression; it does
//! not say a rule is right, which the hand-written 0.6 conformance cases do.

#![allow(clippy::panic, clippy::expect_used, missing_docs)]

mod common;
mod outputs;

use mandate_ir::{JsObject, JsValue};
use mandate_testkit::rust_vectors::{GOLDEN_0_6, json_text, pin, programs_0_6};
use mandate_testkit::{Golden, compare_digest, run_gate, sha256};

/// The shared output code gives what the TypeScript's golden file pins, for
/// every program and every output: it is the golden gate's code in what it
/// gives.
#[test]
fn the_outputs_are_those_of_the_golden_gate() {
    let golden = Golden::load().expect("the golden file");
    let items = golden.programs().map(|p| (p.to_owned(), p.to_owned()));
    let gate = run_gate("golden outputs, made by the code of 0.6", &[], items, |p| {
        let ours = outputs::outputs_of(p)?;
        let pinned: Vec<(&str, &str)> = golden
            .outputs()
            .filter(|o| o.program == p)
            .map(|o| (o.output, o.digest))
            .collect();
        let names: Vec<&str> = ours.iter().map(|(n, _)| n.as_str()).collect();
        let want: Vec<&str> = pinned.iter().map(|(n, _)| *n).collect();
        if names != want {
            return Err(format!("outputs {names:?}, the golden file pins {want:?}"));
        }
        for ((name, text), (_, digest)) in ours.iter().zip(&pinned) {
            compare_digest(digest, text).map_err(|e| format!("{name}: {e}"))?;
        }
        Ok(())
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
}

#[test]
fn every_program_of_0_6_gives_the_outputs_it_gave() {
    let programs = programs_0_6().expect("the 0.6 programs");
    assert!(!programs.is_empty(), "no 0.6 program");
    let mut file = JsObject::new();
    let mut problems: Vec<String> = Vec::new();
    let mut count: usize = 0;
    for p in &programs {
        let outs = match outputs::outputs_of(p) {
            Ok(outs) => outs,
            Err(e) => {
                problems.push(format!("{p}: {e}"));
                continue;
            }
        };
        let names: Vec<&str> = outs.iter().map(|(n, _)| n.as_str()).collect();
        // A pin of nothing would pass for ever: every 0.6 program here is
        // one that checks with its modules, so each has its views; one that
        // imports nothing but std checks alone too, and has its hash. One
        // that imports a module of fixtures/library/ is refused alone, at
        // that import (closed imports, E1604), and nothing else.
        let output = |name: &str| outs.iter().find(|(n, _)| n == name).map(|(_, t)| t);
        let alone = output("check").is_some_and(|t| t.contains("\"ok\": true"));
        let with_modules = output("check --module").is_some_and(|t| t.contains("\"ok\": true"));
        let only_closed = output("check").is_some_and(|t| t.contains("\"MDT-E1604\""));
        for needed in [
            "check",
            "load",
            "ir --canonical",
            "fmt",
            "view --format json",
        ] {
            if !names.contains(&needed) {
                problems.push(format!("{p}: no {needed}"));
            }
        }
        if alone != names.contains(&"hash") {
            problems.push(format!("{p}: a hash only when it checks alone"));
        }
        let checks = with_modules && (alone || only_closed);
        if !checks {
            problems.push(format!("{p}: does not check"));
        }
        let row: JsObject = outs
            .iter()
            .map(|(n, t)| (n.as_str(), JsValue::from(sha256(t))))
            .collect();
        count = count.saturating_add(outs.len());
        file.insert(p.as_str(), row);
    }
    match pin(GOLDEN_0_6, &json_text(&JsValue::Object(file))) {
        Ok(line) => println!(
            "golden outputs of 0.6: {} programs, {count} outputs; {line}",
            programs.len()
        ),
        Err(e) => problems.push(e),
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
