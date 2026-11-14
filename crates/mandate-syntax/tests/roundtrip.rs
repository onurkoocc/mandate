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
//! parser on real programs.
//!
//! Some files under `conformance/` are inputs the cases expect to be refused
//! (a lexical error, say). Such a file is excluded by rule, not by name: it
//! must give at least one error and no program, and it is printed with the
//! codes it gave. A file excluded that reads after all fails the gate, so does
//! one that is refused with a program or with no error. A file that does not
//! round trip in TypeScript either would be pinned by name in `PENDING`
//! with the reason; none is.

#![allow(
    clippy::panic,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_ir::{canonicalize, has_errors};
use mandate_syntax::{SourceKind, load, print_program};
use mandate_testkit::{files, read_text, run_gate, subdirectories};

/// Files that do not round trip, by path, with the reason. None.
const PENDING: &[&str] = &[];

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

/// What a file that is not a program to print gave: `Some(codes)` for a file
/// refused as the rule requires (at least one error, no program), where
/// `Err` is a file that reads, or is refused another way.
fn refused(path: &str) -> Result<Option<Vec<String>>, String> {
    let loaded = load(&read_text(path)?, SourceKind::Mdt);
    let reads = loaded.program.is_some() && !has_errors(&loaded.diagnostics);
    if reads {
        return Ok(None);
    }
    if loaded.program.is_some() || !has_errors(&loaded.diagnostics) {
        return Err(format!(
            "{path}: does not read, but is not refused as an input is (no program, at least one error): {:?}",
            loaded.diagnostics
        ));
    }
    Ok(Some(
        loaded
            .diagnostics
            .iter()
            .map(|d| d.code.to_string())
            .collect(),
    ))
}

fn round_trip(path: &str) -> Result<(), String> {
    let text = read_text(path)?;
    let loaded = load(&text, SourceKind::Mdt);
    let program = match loaded.program {
        Some(program) if !has_errors(&loaded.diagnostics) => program,
        _ => return Err(format!("does not read: {:?}", loaded.diagnostics)),
    };
    let printed = print_program(&program)?;
    let loaded = load(&printed, SourceKind::Mdt);
    let again = match loaded.program {
        Some(again) if !has_errors(&loaded.diagnostics) => again,
        _ => {
            return Err(format!(
                "the printed text does not read: {:?}",
                loaded.diagnostics
            ));
        }
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
    let mut problems: Vec<String> = Vec::new();
    let mut excluded: Vec<(String, Vec<String>)> = Vec::new();
    let mut programs: Vec<String> = Vec::new();
    for path in paths {
        match refused(&path) {
            Ok(None) => programs.push(path),
            Ok(Some(codes)) => excluded.push((path, codes)),
            Err(why) => problems.push(why),
        }
    }
    let named: Vec<String> = excluded
        .iter()
        .map(|(path, codes)| format!("{path} ({})", codes.join(", ")))
        .collect();
    println!(
        "excluded {}: does not read (refused with no program): {}",
        excluded.len(),
        named.join("; ")
    );
    let gate = run_gate(
        "fmt round trip: fixtures and conformance programs",
        PENDING,
        programs.into_iter().map(|p| (p.clone(), p)),
        |p| round_trip(p),
    );
    if let Err(report) = gate {
        problems.push(report);
    }
    if !problems.is_empty() {
        panic!("{}", problems.join("\n"));
    }
}
