//! E1509, "Criterion method name reserved" (language 0.7, spec/attention.md
//! "Static rules"): a criterion whose verifier's callee path is `verify` or
//! `waiver`, the methods the runtime writes its own evidence records under,
//! which it refuses at load as `reserved_method` (`reservedMethods` of
//! `runtime/src/package.ts`: a record's method is the verifier's callee
//! path, `partMethod` of `runtime/src/criteria.ts`, and an `all` declares
//! each of its parts' methods). The conformance cases E1509, E1509a and
//! E1509b are 0.7 cases; the same program as 0.6 is held here, since a
//! conformance case of 0.6 would add to the stored results of 0.6.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{CheckOptions, check};
use mandate_syntax::SourceKind;

/// A program with the functions `waiver` and `touched`, a contract `Tested`
/// whose criteria are `body`, and nothing else.
fn program(version: &str, body: &str) -> String {
    format!(
        r#"mandate @ {version}

module example.reserved @ 0.1

use std.{{test}}

type Change = {{ files: List<Text> }}

fn touched(c: Change) -> Bool ! {{}} {{
  len(c.files) >= 1
}}

fn waiver(c: Change) -> Bool ! {{}} {{
  len(c.files) >= 1
}}

contract Tested(c: Change) {{
{body}
}}
"#
    )
}

/// `code at path` of each diagnostic of the program, warnings left out.
fn found(text: &str) -> Vec<String> {
    let r = check(text, SourceKind::Mdt, &CheckOptions::default());
    r.diagnostics
        .iter()
        .filter(|d| !d.code.starts_with("MDT-W"))
        .map(|d| {
            format!(
                "{} at {} {}",
                d.code,
                d.at.path.as_deref().unwrap_or(""),
                d.facts
                    .as_ref()
                    .and_then(|f| f.get("method"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
            )
            .trim_end()
            .to_owned()
        })
        .collect()
}

#[test]
fn a_program_of_0_6_with_a_reserved_method_checks_and_as_0_7_it_does_not() {
    let body = "  accept touched \"The change touches a file\"\n    by waiver(c)";
    assert_eq!(found(&program("0.6", body)), Vec::<String>::new());
    assert_eq!(
        found(&program("0.7", body)),
        ["MDT-E1509 at /defs/Tested/accept/touched/by waiver"]
    );
}

#[test]
fn the_criteria_it_names_are_the_ones_the_runtime_refuses_at_load() {
    let mut cases: Vec<(&str, &str, Vec<&str>)> = Vec::new();
    // A call whose callee path is exactly the name.
    cases.push((
        "alone",
        "  accept a \"A\"\n    by waiver(c)",
        vec!["MDT-E1509 at /defs/Tested/accept/a/by waiver"],
    ));
    // Among the parts joined by `and`, wherever it stands.
    cases.push((
        "last part",
        "  accept a \"A\"\n    by touched(c) and waiver(c)",
        vec!["MDT-E1509 at /defs/Tested/accept/a/by waiver"],
    ));
    cases.push((
        "first part",
        "  accept a \"A\"\n    by waiver(c) and touched(c)",
        vec!["MDT-E1509 at /defs/Tested/accept/a/by waiver"],
    ));
    // Once per criterion, however many parts.
    cases.push((
        "two parts",
        "  accept a \"A\"\n    by waiver(c) and waiver(c)",
        vec!["MDT-E1509 at /defs/Tested/accept/a/by waiver"],
    ));
    // In an invariant, and one per criterion.
    cases.push((
        "invariant and accept",
        "  accept a \"A\"\n    by touched(c)\n  invariant b \"B\"\n    by waiver(c)\n  accept d \"D\"\n    by waiver(c)",
        vec![
            "MDT-E1509 at /defs/Tested/accept/d/by waiver",
            "MDT-E1509 at /defs/Tested/invariant/b/by waiver",
        ],
    ));
    // Not the name: a longer path that ends in it, a name that contains it,
    // a `static` part (its method is `static`), and a criterion a person
    // approves (`human.approve`).
    cases.push((
        "a path that ends in it",
        "  accept a \"A\"\n    by test.waiver(c)",
        vec![],
    ));
    cases.push((
        "a static part",
        "  accept a \"A\"\n    by static waiver(c)",
        vec![],
    ));
    cases.push((
        "another function",
        "  accept a \"A\"\n    by touched(c)",
        vec![],
    ));
    for (name, body, want) in cases {
        let mut got = found(&program("0.7", body));
        // The checker reports in the order of the contract's members, accept
        // before invariant; the runtime sorts its list.
        got.sort();
        let mut want: Vec<String> = want.into_iter().map(str::to_owned).collect();
        want.sort();
        assert_eq!(got, want, "{name}");
        // Under 0.6, none is refused by the check.
        assert_eq!(
            found(&program("0.6", body)),
            Vec::<String>::new(),
            "{name} as 0.6"
        );
    }
}
