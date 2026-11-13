//! Runs every `kind: "journal"` case in `conformance/` (see its README, "A
//! journal case"): the verifier, given the case's export and keys, must give
//! the case's report, compared as JSON values, and the exit status the
//! report's status means (spec/journal.md "The report": 0 verified, 1 broken
//! or unchained, 2 unreadable). Each case is run twice: through the library,
//! and through the `verify-journal` binary, whose stdout must also be the
//! report file byte for byte (it prints what `mandate journal verify --json`
//! prints).
//!
//! The cases are discovered, not listed. The case files and the expected
//! reports are read with `mandate-ir`'s reader, not this crate's.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use mandate_ir::{Value, canonicalize, parse_bytes};
use mandate_testkit::repo;
use verify_journal::{PublicKey, Report, public_keys_in, verify_export};

fn read_ir(path: &Path) -> Value {
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    parse_bytes(&bytes)
        .unwrap_or_else(|d| panic!("{} does not read: {d:?}", path.display()))
        .value
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no string member {key} in {}", canonicalize(v)))
}

/// The exit status a report's status means, from the spec's table.
fn exit_for(status: &str) -> i32 {
    match status {
        "verified" => 0,
        "broken" | "unchained" => 1,
        "unreadable" => 2,
        other => panic!("no status {other}"),
    }
}

struct Case {
    id: String,
    dir: PathBuf,
    export: PathBuf,
    keys: Vec<PathBuf>,
    report: PathBuf,
}

fn journal_cases() -> (Vec<Case>, usize) {
    let mut dirs: Vec<PathBuf> = fs::read_dir(repo().join("conformance"))
        .expect("the conformance directory")
        .map(|entry| entry.expect("an entry").path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    let total = dirs.len();
    let mut cases = Vec::new();
    for dir in dirs {
        let case = read_ir(&dir.join("case.json"));
        if str_of(&case, "kind") != "journal" {
            continue;
        }
        let name = dir.file_name().and_then(|n| n.to_str()).expect("a name");
        assert_eq!(str_of(&case, "id"), name, "the id is the directory name");
        let j = case.get("journal").expect("a journal case has journal");
        let keys = j
            .get("keys")
            .and_then(Value::as_array)
            .expect("keys")
            .iter()
            .map(|k| dir.join(k.as_str().expect("a key file")))
            .collect();
        cases.push(Case {
            id: name.to_owned(),
            export: dir.join(str_of(j, "export")),
            report: dir.join(str_of(j, "report")),
            keys,
            dir,
        });
    }
    (cases, total)
}

fn keys_of(case: &Case) -> Vec<PublicKey> {
    case.keys
        .iter()
        .flat_map(|k| {
            let text = fs::read_to_string(k).unwrap_or_else(|e| panic!("{}: {e}", k.display()));
            assert!(
                !text.contains("PRIVATE"),
                "{}: a case holds public keys only",
                k.display()
            );
            public_keys_in(&text).unwrap_or_else(|e| panic!("{}: {e}", k.display()))
        })
        .collect()
}

/// The report as a value of the IR's domain: it holds only strings, safe
/// integers and nulls.
fn as_ir(report: &Report) -> Value {
    report
        .to_json()
        .to_ir()
        .expect("a report is in the IR's domain")
}

#[test]
fn every_journal_case_gives_its_report_and_exit_status() {
    let (cases, total) = journal_cases();
    let mut failures: Vec<String> = Vec::new();
    for case in &cases {
        let want = read_ir(&case.report);
        let want_text = canonicalize(&want);
        let status = str_of(&want, "status");
        let keys = keys_of(case);
        assert!(!keys.is_empty(), "{}: no key", case.id);

        let bytes = fs::read(&case.export).expect("the export");
        let got = verify_export(&bytes, &keys);
        let got_text = canonicalize(&as_ir(&got));
        if got_text != want_text {
            failures.push(format!(
                "{} (library): expected {want_text}\n  got {got_text}",
                case.id
            ));
        }
        if i32::from(got.status.exit_code()) != exit_for(status) {
            failures.push(format!(
                "{} (library): exit {} for {status}",
                case.id,
                got.status.exit_code()
            ));
        }

        let mut cmd = Command::new(env!("CARGO_BIN_EXE_verify-journal"));
        cmd.current_dir(&case.dir).arg(&case.export);
        for k in &case.keys {
            cmd.arg("--key").arg(k);
        }
        let out = cmd.output().expect("verify-journal runs");
        if out.status.code() != Some(exit_for(status)) {
            failures.push(format!(
                "{} (binary): exit {:?} for {status}; stderr: {}",
                case.id,
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        match parse_bytes(&out.stdout) {
            Ok(parsed) if canonicalize(&parsed.value) == want_text => {}
            Ok(parsed) => failures.push(format!(
                "{} (binary): expected {want_text}\n  got {}",
                case.id,
                canonicalize(&parsed.value)
            )),
            Err(d) => failures.push(format!(
                "{} (binary): stdout is not a report: {d:?}",
                case.id
            )),
        }
        let file = fs::read(&case.report).expect("the report file");
        if out.stdout != file {
            failures.push(format!(
                "{} (binary): stdout is not the report file byte for byte:\n{}",
                case.id,
                String::from_utf8_lossy(&out.stdout)
            ));
        }
    }
    println!(
        "journal cases: ran {} (of {total} case directories), each through the library and the binary",
        cases.len()
    );
    assert!(!cases.is_empty(), "no journal case was run");
    assert!(
        failures.is_empty(),
        "{} problem(s) in the journal cases:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn every_status_and_every_finding_is_in_some_case() {
    // The cases are meant to hold every status and every finding code; this
    // says when a case set no longer does, so a code is not left unchecked.
    let (cases, _) = journal_cases();
    let mut seen: Vec<String> = Vec::new();
    for case in &cases {
        let want = read_ir(&case.report);
        seen.push(str_of(&want, "status").to_owned());
        for f in want
            .get("findings")
            .and_then(Value::as_array)
            .expect("findings")
        {
            seen.push(str_of(f, "code").to_owned());
        }
    }
    for name in [
        "verified",
        "broken",
        "unchained",
        "unreadable",
        "malformed_export",
        "export_over_limit",
        "seq_gap",
        "hash_missing",
        "chain_broken",
        "manifest_mismatch",
        "package_mismatch",
        "anchor_unknown_key",
        "anchor_signature_invalid",
        "anchor_beyond_end",
        "anchor_mismatch",
        "anchor_missing",
        "unanchored_tail",
    ] {
        assert!(seen.iter().any(|s| s == name), "no case gives {name}");
    }
}
