//! Language 0.6 across the compiler (spec/library.md): a 0.6 program that
//! uses nothing of what 0.6 adds is a 0.5 program under a new header.
//!
//! - Every 0.5 program of the repository, its header (or its `language`)
//!   rewritten to 0.6 and nothing else, gives what it gives as 0.5: every
//!   output of a fixture (the checks with their diagnostics whole, `load`,
//!   the IR, `fmt`, the views, `sandbox`), and the result of every 0.5
//!   conformance case, with the version's text and the hashes (which the
//!   version is part of) taken out. A program that 0.6 reads otherwise on
//!   purpose is left out by a named rule ([`EXCEPTIONS`]), which lists the
//!   programs it applies to; a program that falls under a rule and is not
//!   listed fails, and so does one listed that does not. None does today:
//!   the 0.5 programs rewritten import only `std` (or modules their checks
//!   are given) and have no `///` line.
//! - Every code whose reference is the Rust compiler has a conformance case
//!   of 0.6 that expects it, and every code a 0.6 case expects is in the
//!   table.
//! - The `domain_hash` door takes the library domain, as the crate does.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;
mod outputs;

use std::collections::BTreeSet;

use common::{check_text, check_with, kind_named, modules_of, patched_source, read_source};
use mandate_ir::codes::{self, Reference};
use mandate_ir::{Value, canonicalize, parse};
use mandate_syntax::SourceKind;
use mandate_testkit::rust_only::RUST_ONLY_LANGUAGES;
use mandate_testkit::{
    compare_text, files, read_json, repo_path, run_gate, sha256, subdirectories,
};

/// A program of 0.5 that imports a module its check is not given: as 0.5 the
/// import is taken on trust; as 0.6 it is E1604 (closed imports). A fixture
/// is checked once with no module at all (`check`), so any import of a
/// module but `std` and `std.decision` puts it here.
const CLOSED_IMPORTS: &str = "an import of a module the check is not given (E1604 in 0.6)";

/// A program of 0.5 with a `///` line: as 0.5 a comment; as 0.6 a doc line,
/// in the IR and the hashes, or E0101 where it documents nothing.
const DOC_LINES: &str = "a /// line (a doc line or E0101 in 0.6)";

/// For each rule by which 0.6 reads a 0.5 program otherwise on purpose, the
/// programs (a fixture's path, a case's directory) it applies to, which the
/// comparison leaves out. Each list is the whole list: a program that falls
/// under a rule and is not in it fails the test, as does one in it that does
/// not.
const EXCEPTIONS: &[(&str, &[&str])] = &[(CLOSED_IMPORTS, &[]), (DOC_LINES, &[])];

/// The rules of [`EXCEPTIONS`] that `text`, checked with the modules named
/// `given` (or, for a fixture's plain `check`, none), falls under.
fn rules_of(text: &str, kind: SourceKind, given: &[String]) -> Vec<&'static str> {
    let mut out = Vec::new();
    let loaded = mandate_syntax::load(text, kind);
    let open = loaded
        .program
        .as_ref()
        .and_then(|p| p.get("uses"))
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(|u| u.get("module").and_then(Value::as_str))
        .any(|m| !mandate_check::STD_MODULES.contains(&m) && !given.iter().any(|g| g == m));
    if open {
        out.push(CLOSED_IMPORTS);
    }
    if kind == SourceKind::Mdt && text.contains("///") {
        out.push(DOC_LINES);
    }
    out
}

/// Whether `item` is left out of the comparison by [`EXCEPTIONS`], and an
/// error when `rules` (the rules it falls under) and the lists disagree.
fn excepted(item: &str, rules: &[&str]) -> Result<bool, String> {
    for (rule, listed) in EXCEPTIONS {
        let falls = rules.contains(rule);
        let named = listed.contains(&item);
        if falls && !named {
            return Err(format!(
                "{item} falls under the rule \"{rule}\" and is not listed in EXCEPTIONS: 0.6 reads it otherwise on purpose; list it"
            ));
        }
        if named && !falls {
            return Err(format!(
                "{item} is listed under the rule \"{rule}\" and does not fall under it: take it off"
            ));
        }
    }
    Ok(!rules.is_empty())
}

/// Every program [`EXCEPTIONS`] lists is among `items`, and each rule's
/// count is printed.
fn exceptions_all_seen(items: &[String], gate: &str) {
    for (rule, listed) in EXCEPTIONS {
        for p in *listed {
            // A listed program of the other gate is that gate's.
            let ours = p.starts_with("conformance/") == gate.contains("cases");
            assert!(
                !ours || items.iter().any(|i| i == p),
                "{p}, listed under \"{rule}\", is not a program of {gate}"
            );
        }
        let ours = listed
            .iter()
            .filter(|p| p.starts_with("conformance/") == gate.contains("cases"))
            .count();
        println!("{gate}: {ours} left out by the rule \"{rule}\"");
    }
}

/// A text with what tells 0.6 from 0.5 taken out: the version's text, and
/// every hash, whose domain prefix names the version.
fn without_version(text: &str) -> String {
    let text = text
        .replace("mandate/0.6", "mandate/0.5")
        .replace("mandate @ 0.6", "mandate @ 0.5");
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(at) = rest.find("sha256:") {
        let (head, tail) = rest.split_at(at);
        out.push_str(head);
        out.push_str("sha256:<hash>");
        let hex = tail
            .get(7..)
            .unwrap_or_default()
            .bytes()
            .take_while(u8::is_ascii_hexdigit)
            .count();
        rest = tail.get(7 + hex..).unwrap_or_default();
    }
    out.push_str(rest);
    out
}

/// `text` with its one header `mandate @ 0.5` (or `language` member
/// `mandate/0.5`) written as 0.6, or `None` when it has not exactly one.
fn as_0_6(text: &str, kind: SourceKind) -> Option<String> {
    let (from, to) = match kind {
        SourceKind::Mdt => ("mandate @ 0.5", "mandate @ 0.6"),
        SourceKind::Json => ("\"mandate/0.5\"", "\"mandate/0.6\""),
    };
    (text.matches(from).count() == 1).then(|| text.replacen(from, to, 1))
}

/// Every `.mdt` and `.ir.json` file below `dir`, recursively.
fn programs_below(dir: &str, out: &mut Vec<String>) {
    for f in files(dir).unwrap_or_default() {
        if f.ends_with(".mdt") || f.ends_with(".ir.json") {
            out.push(format!("{dir}/{f}"));
        }
    }
    for d in subdirectories(dir).unwrap_or_default() {
        programs_below(&format!("{dir}/{d}"), out);
    }
}

#[test]
fn every_0_5_fixture_under_the_0_6_header_gives_what_it_gives_as_0_5() {
    let mut all = Vec::new();
    programs_below("fixtures", &mut all);
    programs_below("compiler/test/fixtures", &mut all);
    let items: Vec<(String, (String, String))> = all
        .into_iter()
        .filter(|p| !p.starts_with("fixtures/library/"))
        .filter_map(|p| {
            let text = read_source(&p).ok()?;
            let kind = mandate_syntax::kind_of(&p);
            let rewritten = as_0_6(&text, kind)?;
            // Only a program that reads as 0.5 is one.
            let loaded = mandate_syntax::load(&text, kind);
            let is_0_5 = loaded
                .program
                .as_ref()
                .and_then(|v| v.get("language"))
                .and_then(Value::as_str)
                == Some("mandate/0.5");
            is_0_5.then(|| (p.clone(), (p, rewritten)))
        })
        .collect();
    let n = items.len();
    let names: Vec<String> = items.iter().map(|(n, _)| n.clone()).collect();
    exceptions_all_seen(&names, "0.5 fixtures as 0.6");
    let gate = run_gate("0.5 fixtures as 0.6", &[], items, |(p, rewritten)| {
        let kind = mandate_syntax::kind_of(p);
        if excepted(p, &rules_of(&read_source(p)?, kind, &[]))? {
            return Ok(());
        }
        let as_0_5 = outputs::outputs_of(p)?;
        let as_0_6 = outputs::outputs_of_text(p, rewritten)?;
        let names = |o: &[(String, String)]| o.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
        if names(&as_0_5) != names(&as_0_6) {
            return Err(format!(
                "outputs {:?} as 0.5, {:?} as 0.6",
                names(&as_0_5),
                names(&as_0_6)
            ));
        }
        for ((name, a), (_, b)) in as_0_5.iter().zip(&as_0_6) {
            compare_text(&without_version(a), &without_version(b))
                .map_err(|e| format!("{name}: {e}"))?;
        }
        // The version is in the program, its hash and its header.
        let first = |o: &[(String, String)], n: &str| {
            o.iter().find(|(x, _)| x == n).map(|(_, t)| t.clone())
        };
        if first(&as_0_6, "ir --canonical").is_some_and(|t| !t.contains("\"mandate/0.6\"")) {
            return Err("the IR of 0.6 does not say mandate/0.6".to_owned());
        }
        if first(&as_0_5, "hash") == first(&as_0_6, "hash") {
            return Err("0.5 and 0.6 hash the same".to_owned());
        }
        Ok(())
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
    assert!(n >= 2, "only {n} programs of 0.5 among the fixtures");
}

#[test]
fn every_0_5_conformance_case_under_the_0_6_header_gives_what_it_gives_as_0_5() {
    let mut items: Vec<(String, String)> = Vec::new();
    for id in subdirectories("conformance").unwrap() {
        let case = read_json(&format!("conformance/{id}/case.json")).unwrap();
        let door_is_check = ["amendment", "subprogram", "base"]
            .iter()
            .all(|k| case.get(k).is_none());
        if case.get("language").and_then(Value::as_str) == Some("mandate/0.5")
            && case.get("kind").and_then(Value::as_str) == Some("compile")
            && door_is_check
        {
            items.push((format!("conformance/{id}"), id));
        }
    }
    let n = items.len();
    let names: Vec<String> = items.iter().map(|(n, _)| n.clone()).collect();
    exceptions_all_seen(&names, "0.5 cases as 0.6");
    let gate = run_gate("0.5 cases as 0.6", &[], items, |id| {
        let dir = format!("conformance/{id}");
        let case = read_json(&format!("{dir}/case.json"))?;
        let input = case.get("input").ok_or("no input")?;
        let kind = kind_named(input.get("kind").and_then(Value::as_str).unwrap_or("mdt"));
        let text = match input.get("text").and_then(Value::as_str) {
            Some(t) => t.to_owned(),
            None => read_source(&repo_path(
                &dir,
                input.get("file").and_then(Value::as_str).ok_or("no file")?,
            ))?,
        };
        let (text, kind) = match case.get("patch").and_then(Value::as_array) {
            Some(patch) => (patched_source(&text, kind, patch)?, SourceKind::Json),
            None => (text, kind),
        };
        let rewritten = as_0_6(&text, kind).ok_or("the input has no one 0.5 header")?;
        let names: Vec<String> = case
            .get("modules")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let module_files: Vec<String> = names.iter().map(|m| repo_path(&dir, m)).collect();
        let modules = modules_of(&module_files, &names)?;
        let given: Vec<String> = modules.keys().map(str::to_owned).collect();
        if excepted(&dir, &rules_of(&text, kind, &given))? {
            return Ok(());
        }
        let lock = case
            .get("lock")
            .and_then(Value::as_str)
            .map(|l| repo_path(&dir, l));
        let a = check_with(&text, kind, Some(&modules), lock.as_deref())?;
        let b = check_with(&rewritten, kind, Some(&modules), lock.as_deref())?;
        compare_text(
            &without_version(&check_text(&a)),
            &without_version(&check_text(&b)),
        )
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
    assert!(n >= 10, "only {n} conformance cases of 0.5");
}

/// The codes each compile case of 0.6 expects.
fn codes_of_0_6_cases() -> Vec<(String, BTreeSet<String>)> {
    let mut out = Vec::new();
    for id in subdirectories("conformance").unwrap() {
        let case = read_json(&format!("conformance/{id}/case.json")).unwrap();
        let language = case.get("language").and_then(Value::as_str);
        if !language.is_some_and(|l| RUST_ONLY_LANGUAGES.contains(&l)) {
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

/// Every code the Rust compiler is the reference for has a conformance case
/// of 0.6 that expects it, and every code a 0.6 case expects is a row of the
/// table: a case cannot expect a code the table does not have, nor a code be
/// added in Rust without a case.
#[test]
fn every_code_of_the_rust_compiler_has_a_case_of_0_6() {
    let cases = codes_of_0_6_cases();
    assert!(!cases.is_empty(), "no conformance case of 0.6");
    let expected: BTreeSet<&str> = cases
        .iter()
        .flat_map(|(_, c)| c.iter().map(String::as_str))
        .collect();
    assert!(
        !expected.is_empty(),
        "no case of 0.6 expects a code, so nothing below is checked"
    );
    let rust: Vec<&str> = codes::iter()
        .filter(|r| r.reference == Reference::Rust)
        .map(|r| r.code)
        .collect();
    let without_case: Vec<&&str> = rust.iter().filter(|c| !expected.contains(**c)).collect();
    assert!(
        without_case.is_empty(),
        "codes of the Rust compiler with no conformance case of 0.6 that expects them: {without_case:?}"
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
        "codes: {} of the Rust compiler, each with a case of 0.6; {} cases of 0.6 expect {} codes, each in the table",
        rust.len(),
        cases.len(),
        expected.len()
    );
}

/// The library domain is a domain of the door as it is of `mandate-ir`: one
/// list of domains, `HashDomain::from_name`. The TypeScript `domainHash`,
/// which the door stands for, takes the domain's name as text and gives the
/// same digest for it.
#[test]
fn the_domain_hash_door_takes_the_library_domain() {
    let door = mandate_check::json_doors::door("domain_hash").expect("the door");
    let input = parse(r#"{"domain":"library","value":{"name":"a.b","version":"1.0.0","requires":{},"modules":{}},"version":"0.6"}"#)
        .unwrap()
        .value;
    let out = (door.call)(&input).expect("an answer");
    let value = input.get("value").unwrap();
    assert_eq!(
        out.as_str(),
        Some(sha256(&format!("mandate/library/0.6\n{}", canonicalize(value))).as_str())
    );
    let refused = parse(r#"{"domain":"libraries","value":1}"#).unwrap().value;
    assert!(
        (door.call)(&refused).is_err(),
        "an unknown domain is refused"
    );
}

/// The front end reads the 0.6 header, writes it back, and an older header
/// as before.
#[test]
fn the_header_of_0_6_reads_and_prints() {
    let text = read_source("fixtures/library/minimal.mdt").unwrap();
    let loaded = mandate_syntax::load(&text, SourceKind::Mdt);
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let program = loaded.program.unwrap();
    assert_eq!(
        program.get("language").and_then(Value::as_str),
        Some("mandate/0.6")
    );
    let printed = mandate_syntax::print_program(&program).unwrap();
    assert!(printed.starts_with("mandate @ 0.6\n\nmodule example.library.minimal @ 0.1\n"));
    let again = mandate_syntax::load(&printed, SourceKind::Mdt);
    assert_eq!(
        again.program.as_ref().map(canonicalize),
        Some(canonicalize(&program))
    );
    // The words 0.6 adds are not reserved: each is a name, in 0.6 as before.
    for word in [
        "pattern",
        "connector",
        "tool",
        "waive",
        "shapes",
        "read_only",
    ] {
        assert!(
            !mandate_syntax::RESERVED.contains(&word),
            "{word} is reserved"
        );
    }
}
