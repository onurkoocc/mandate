//! E1604 names the language of the program it is raised for (spec/library.md
//! "Imports"): a program of 0.6 is told of `mandate/0.6`, one of 0.7 of
//! `mandate/0.7`, and the message of 0.6 is byte for byte what it was.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_check::{CheckOptions, ModuleSource, Modules, check, load_modules};
use mandate_syntax::SourceKind;

const DOMAIN: &str =
    "mandate @ 0.5\n\nmodule example.older.domain @ 0.1\n\ntype Ticket = { id: Text }\n";

/// A program of `version` that imports a module nobody gave, and one that is
/// given and imported with no list of names.
fn program(version: &str) -> String {
    format!(
        "mandate @ {version}\n\nmodule example.reader @ 0.1\n\nuse example.older.unknown.{{Mystery}}\nuse example.older.domain\n\ntype Pair = {{ m: Mystery }}\n"
    )
}

/// The messages of E1604 for a program of `version`.
fn messages(version: &str) -> Vec<String> {
    let sources = [ModuleSource {
        text: DOMAIN,
        kind: SourceKind::Mdt,
        file: "domain.mdt",
    }];
    let loaded = load_modules(&sources);
    assert!(loaded.problems.is_empty());
    let modules: Modules = loaded.modules;
    let r = check(
        &program(version),
        SourceKind::Mdt,
        &CheckOptions {
            modules: Some(&modules),
            ..CheckOptions::default()
        },
    );
    r.diagnostics
        .iter()
        .filter(|d| d.code == "MDT-E1604")
        .map(|d| d.message.clone())
        .collect()
}

#[test]
fn a_program_of_0_6_is_told_of_mandate_0_6_as_before() {
    assert_eq!(
        messages("0.6"),
        vec![
            "The use of example.older.domain lists no names: in a program of mandate/0.6 an import of a module that is not the standard library's brings only the names it lists. List them, as in use example.older.domain.{…}.",
            "Module example.older.unknown is not known to this check: a program of mandate/0.6 imports only std, std.decision, std.patterns, the modules the check was given and those of the libraries the lock pins. Give the module, or remove the use.",
        ]
    );
}

#[test]
fn a_program_of_0_7_is_told_of_mandate_0_7() {
    let of_0_6 = messages("0.6");
    let of_0_7 = messages("0.7");
    assert_eq!(of_0_7.len(), 2, "{of_0_7:?}");
    for (new, old) in of_0_7.iter().zip(&of_0_6) {
        assert!(new.contains("a program of mandate/0.7 "), "{new}");
        assert!(!new.contains("mandate/0.6"), "{new}");
        assert_eq!(new.replace("mandate/0.7", "mandate/0.6"), *old);
    }
}
