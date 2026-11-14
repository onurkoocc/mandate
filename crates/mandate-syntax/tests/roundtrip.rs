//! `mandate fmt` on every program in Mandate text the repository holds: the
//! fixtures (`fixtures/`, `compiler/test/fixtures/syntax/`, the programs
//! `vectors/programs/` lists the outputs of) and the programs of the
//! conformance cases (`conformance/*/*.mdt`, the `input` of the compile
//! cases and the sub-programs and modules they bring).
//!
//! Each file must read (`load(text, "mdt")` with no error); what is printed
//! must read back to the same canonical IR; and printing that again must give
//! the same text. These do not say the text is the TypeScript's (the vectors
//! and the golden outputs do), only that the printer is the inverse of the
//! parser on real programs. A file that does not round trip in TypeScript
//! either is pinned by name in `PENDING` with the reason.

#![allow(
    clippy::panic,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeMap;

use mandate_ir::{Diagnostic, Value, canonicalize, has_errors};
use mandate_syntax::{parse_mdt, print_program};
use mandate_testkit::{files, read_text, run_gate, subdirectories};

/// Files that do not round trip, by path, with the reason.
const PENDING: &[&str] = &[
    // Not a program: the case `S11j` is that a non-ASCII identifier is
    // refused (`MDT-E0101`), so the file does not read, in TypeScript too.
    "conformance/S11j/program.mdt",
];

/// `load(text, "mdt")`: the program, when the text reads, and all the
/// diagnostics, the parser's first.
// replace with mandate_syntax::load once it exists
fn load_text(text: &str) -> (Option<Value>, Vec<Diagnostic>) {
    let read = parse_mdt(text);
    let mut diagnostics = read.diagnostics.clone();
    if let Some(program) = &read.program {
        let spans = BTreeMap::from(&read.spans);
        diagnostics.extend(mandate_ir::validate_ir(program, Some(&spans)));
    }
    (read.program, diagnostics)
}

/// The `.mdt` files directly in `dir`, as paths from the repository root.
fn mdt_files(dir: &str) -> Vec<String> {
    files(dir)
        .expect("a directory listing")
        .into_iter()
        .filter(|name| name.ends_with(".mdt"))
        .map(|name| format!("{dir}/{name}"))
        .collect()
}

/// The `.mdt` files in the directories of `dir`.
fn mdt_files_below(dir: &str) -> Vec<String> {
    subdirectories(dir)
        .expect("a directory listing")
        .into_iter()
        .flat_map(|sub| mdt_files(&format!("{dir}/{sub}")))
        .collect()
}

fn round_trip(path: &str) -> Result<(), String> {
    let text = read_text(path)?;
    let (program, diagnostics) = load_text(&text);
    let program = match program {
        Some(program) if !has_errors(&diagnostics) => program,
        _ => return Err(format!("does not read: {diagnostics:?}")),
    };
    let printed = print_program(&program)?;
    let (again, diagnostics) = load_text(&printed);
    let again = match again {
        Some(again) if !has_errors(&diagnostics) => again,
        _ => return Err(format!("the printed text does not read: {diagnostics:?}")),
    };
    if canonicalize(&again) != canonicalize(&program) {
        return Err("the printed text reads as another program".to_owned());
    }
    if print_program(&again)? != printed {
        return Err("printing the printed text gives another text".to_owned());
    }
    Ok(())
}

#[test]
fn fmt_round_trips() {
    let mut paths: Vec<String> = Vec::new();
    paths.extend(mdt_files_below("fixtures"));
    paths.extend(mdt_files("compiler/test/fixtures/syntax"));
    paths.extend(mdt_files_below("conformance"));
    let gate = run_gate(
        "fmt round trip: fixtures and conformance programs",
        PENDING,
        paths.into_iter().map(|p| (p.clone(), p)),
        |p| round_trip(p),
    );
    if let Err(report) = gate {
        panic!("{report}");
    }
}
