//! What the tests of the Rust Mandate crates share, so that none of them
//! writes it again: the repository and its files ([`repo`], [`read_text`],
//! [`read_json`], [`subdirectories`], [`files`]), digests ([`sha256`]), the
//! golden digests of the TypeScript compiler's outputs ([`Golden`]), the
//! stored results of its checks ([`stored_cases`], [`stored_programs`]), the
//! comparison of texts ([`compare_text`], [`compare_digest`]), the
//! pending-list rule of a gate test ([`run_gate`]), the table of which
//! slice of the port brings each diagnostic code, by which the gates name
//! their items ([`codes`]: [`item_name`], [`FAMILIES`], [`check_pending`])
//! and the compiled corpus of the TypeScript compiler's calls to its front
//! doors ([`corpus`]).
//!
//! It is a dev-dependency only, and it may read files and the environment;
//! the library crates may not. Every function returns its failures as text
//! instead of panicking: under `scripts/wasi-test.mjs` a panic aborts the
//! whole test executable, so a test collects what failed and fails once.
//!
//! Its types are for integration tests (a crate's `tests/`). A unit test
//! inside a crate's `src` that used them would see two copies of
//! `mandate-ir`, the one the crate under test is and the one this crate
//! links, whose types do not match.

#![forbid(unsafe_code)]

pub mod codes;
pub mod corpus;
mod diagnostic_vectors;
mod gate;
mod golden;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use mandate_ir::{Value, parse_bytes};
use sha2::{Digest, Sha256};

pub use codes::{FAMILIES, Family, check_pending, code_set, family_of, item_name};
pub use diagnostic_vectors::{
    DIAGNOSTICS, StoredCase, StoredProgram, repo_path, result_codes, stored_cases, stored_programs,
};
pub use gate::{Miss, omission, run_gate, run_held_gate};
pub use golden::{GOLDEN, Golden, GoldenOutput};

/// The repository root: the environment variable `MANDATE_REPO` when it is
/// set (`scripts/wasi-test.mjs` sets it to `/repo`, since the compile-time
/// path does not exist under WASI), else the path from this crate's
/// directory.
#[must_use]
pub fn repo() -> PathBuf {
    match std::env::var_os("MANDATE_REPO") {
        Some(root) => PathBuf::from(root),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."),
    }
}

/// The path of `rel`, a path relative to the repository root such as
/// `vectors/hash.json`.
#[must_use]
pub fn path(rel: &str) -> PathBuf {
    repo().join(rel)
}

/// The bytes of the repository file `rel`.
///
/// # Errors
///
/// When it cannot be read; the message names the file.
pub fn read_bytes(rel: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path(rel)).map_err(|e| format!("{rel}: {e}"))
}

/// The text of the repository file `rel`, which must be UTF-8.
///
/// # Errors
///
/// When it cannot be read or is not UTF-8.
pub fn read_text(rel: &str) -> Result<String, String> {
    String::from_utf8(read_bytes(rel)?).map_err(|e| format!("{rel}: not UTF-8: {e}"))
}

/// The repository file `rel` read with `mandate-ir`'s strict reader, as the
/// vectors and cases are.
///
/// # Errors
///
/// When it cannot be read or the reader refuses it.
pub fn read_json(rel: &str) -> Result<Value, String> {
    parse_json(&read_bytes(rel)?).map_err(|e| format!("{rel}: {e}"))
}

/// `bytes` read with `mandate-ir`'s strict reader.
///
/// # Errors
///
/// The reader's diagnostics, one a line.
pub fn parse_json(bytes: &[u8]) -> Result<Value, String> {
    parse_bytes(bytes).map(|p| p.value).map_err(|diags| {
        diags
            .iter()
            .map(|d| mandate_ir::format_diagnostic(d, None))
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn entries(rel: &str, dirs: bool) -> Result<Vec<String>, String> {
    let read = std::fs::read_dir(path(rel)).map_err(|e| format!("{rel}: {e}"))?;
    let mut names = Vec::new();
    for entry in read {
        let entry = entry.map_err(|e| format!("{rel}: {e}"))?;
        if entry.path().is_dir() == dirs {
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| format!("{rel}: a name that is not UTF-8"))?;
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(names)
}

/// The names of the directories in the repository directory `rel`, sorted.
///
/// # Errors
///
/// When it cannot be listed.
pub fn subdirectories(rel: &str) -> Result<Vec<String>, String> {
    entries(rel, true)
}

/// The names of the files in the repository directory `rel`, sorted.
///
/// # Errors
///
/// When it cannot be listed.
pub fn files(rel: &str) -> Result<Vec<String>, String> {
    entries(rel, false)
}

/// `sha256:` and the lowercase hex SHA-256 of the UTF-8 bytes of `text`,
/// as the golden file writes a digest.
#[must_use]
pub fn sha256(text: &str) -> String {
    let mut out = String::from("sha256:");
    for byte in Sha256::digest(text.as_bytes()).iter() {
        // Writing to a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// A line for a report, quoted and cut to 200 characters.
fn shown(line: Option<&str>) -> String {
    match line {
        None => "(end of text)".to_owned(),
        Some(l) if l.chars().count() > 200 => {
            let head: String = l.chars().take(200).collect();
            format!("{head:?}...")
        }
        Some(l) => format!("{l:?}"),
    }
}

/// Where two texts first differ, by line, or `None` when they are equal.
#[must_use]
pub fn first_difference(expected: &str, actual: &str) -> Option<String> {
    if expected == actual {
        return None;
    }
    let (mut e, mut a) = (expected.split('\n'), actual.split('\n'));
    let mut line: usize = 1;
    loop {
        match (e.next(), a.next()) {
            (Some(x), Some(y)) if x == y => line = line.saturating_add(1),
            (x, y) => {
                return Some(format!(
                    "first difference at line {line}\n    expected: {}\n    actual:   {}",
                    shown(x),
                    shown(y)
                ));
            }
        }
    }
}

/// `Ok` when `actual` is `expected`, else where they first differ.
///
/// # Errors
///
/// The first differing line of each.
pub fn compare_text(expected: &str, actual: &str) -> Result<(), String> {
    first_difference(expected, actual).map_or(Ok(()), Err)
}

/// `Ok` when `actual` has the digest `expected` (`sha256:<hex>`). The
/// expected text is not known, so a mismatch shows the digests and the
/// first lines of the actual text.
///
/// # Errors
///
/// The two digests and the start of `actual`.
pub fn compare_digest(expected: &str, actual: &str) -> Result<(), String> {
    let got = sha256(actual);
    if got == expected {
        return Ok(());
    }
    let start: Vec<String> = actual.split('\n').take(3).map(|l| shown(Some(l))).collect();
    Err(format!(
        "expected {expected}, got {got}; the text begins\n    {}",
        start.join("\n    ")
    ))
}
