//! The golden gate of language 0.7: the digest of every output text of
//! every 0.7 program of the repository (`fixtures/attention/`), pinned in
//! `vectors/golden/0.7.json`, which the Rust writes (no TypeScript reads
//! 0.7). The file has the shape of `vectors/golden/0.6.json` and its
//! outputs are made by the same code, `outputs::outputs_of`, which
//! `golden_0_6.rs` holds to every digest of the TypeScript's golden file.
//!
//! A normal run compares; `MANDATE_UPDATE_0_7=1` writes the file again
//! (`mandate_testkit::rust_vectors`). The file catches a regression; it does
//! not say a rule is right, which the hand-written 0.7 conformance cases do.

#![allow(clippy::expect_used, missing_docs)]

mod common;
mod outputs;

use mandate_ir::{JsObject, JsValue};
use mandate_testkit::rust_vectors::{GOLDEN_0_7, json_text, pin_0_7, programs_0_7};
use mandate_testkit::sha256;

#[test]
fn every_program_of_0_7_gives_the_outputs_it_gave() {
    let programs = programs_0_7().expect("the 0.7 programs");
    assert!(!programs.is_empty(), "no 0.7 program");
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
        // A pin of nothing would pass for ever: every 0.7 program here
        // checks with its modules and its libraries, and so has every output
        // of a program that checks; one that imports nothing but std checks
        // alone too, and has its hash. One that imports a module of a library
        // (the acceptance program) is refused alone, at that import (closed
        // imports, E1604), and nothing else, as in 0.6.
        let output = |name: &str| outs.iter().find(|(n, _)| n == name).map(|(_, t)| t);
        let alone = output("check").is_some_and(|t| t.contains("\"ok\": true"));
        let with_modules = output("check --module").is_some_and(|t| t.contains("\"ok\": true"));
        let only_closed = output("check").is_some_and(|t| t.contains("\"MDT-E1604\""));
        for needed in [
            "check",
            "check --module",
            "load",
            "ir --canonical",
            "fmt",
            "view --format json",
            // The attention view of every workflow, as the command writes it.
            "view --attention --format json",
            "view --attention --format md",
            "view --attention --format html",
        ] {
            if !names.contains(&needed) {
                problems.push(format!("{p}: no {needed}"));
            }
        }
        if alone != names.contains(&"hash") {
            problems.push(format!("{p}: a hash only when it checks alone"));
        }
        if !(with_modules && (alone || only_closed)) {
            problems.push(format!("{p}: does not check"));
        }
        if output("ir --canonical").is_some_and(|t| !t.contains("\"mandate/0.7\"")) {
            problems.push(format!("{p}: its IR does not say mandate/0.7"));
        }
        let row: JsObject = outs
            .iter()
            .map(|(n, t)| (n.as_str(), JsValue::from(sha256(t))))
            .collect();
        count = count.saturating_add(outs.len());
        file.insert(p.as_str(), row);
    }
    match pin_0_7(GOLDEN_0_7, &json_text(&JsValue::Object(file))) {
        Ok(line) => println!(
            "golden outputs of 0.7: {} programs, {count} outputs; {line}",
            programs.len()
        ),
        Err(e) => problems.push(e),
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
