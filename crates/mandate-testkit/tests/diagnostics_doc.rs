//! `spec/diagnostics.md` and the table of diagnostic codes
//! (`mandate_ir::codes`) say the same about which codes there are: the
//! document has a row (`| MDT-E0103 | … |`) for every code of the table, and
//! names no code the table does not have. The titles are not compared: the
//! document may say more than the table's one line (W0311), and the
//! explanations are the table's alone.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeSet;

use mandate_ir::codes;
use mandate_testkit::read_text;

const DOC: &str = "spec/diagnostics.md";

/// Codes the document names without the `MDT-` prefix although the table
/// does not have them: E0110 and E0601 are the design document's (Appendix
/// B), which the implementation did not take as they are; E0406 and E0407
/// are the runtime's, raised at commit and not by the compiler. A code
/// bare in the document that is neither in the table nor here fails the
/// test, and so does an entry here the document no longer names.
const BARE_NOT_IN_TABLE: &[&str] = &["E0110", "E0406", "E0407", "E0601"];

fn doc() -> String {
    read_text(DOC).unwrap_or_else(|e| panic!("{e}"))
}

/// The codes that rows of the document's tables begin with.
fn rows_of(text: &str) -> BTreeSet<String> {
    text.lines()
        .filter_map(|line| {
            let first = line.strip_prefix("| ")?.split(" |").next()?;
            first.starts_with("MDT-").then(|| first.to_owned())
        })
        .collect()
}

/// A code in `text`: a letter E or W and four digits, not part of a longer
/// word (`E0320a`, a conformance case, is none).
struct Named {
    /// The letter and the digits.
    bare: String,
    /// Whether `MDT-` comes just before it.
    prefixed: bool,
}

fn named_in(text: &str) -> Vec<Named> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    for (i, b) in bytes.iter().enumerate() {
        if !matches!(*b, b'E' | b'W') || i + 5 > bytes.len() {
            continue;
        }
        let digits = &bytes[i + 1..i + 5];
        if !digits.iter().all(u8::is_ascii_digit) {
            continue;
        }
        if bytes.get(i + 5).is_some_and(u8::is_ascii_alphanumeric) {
            continue;
        }
        let before = &bytes[..i];
        let prefixed = before.ends_with(b"MDT-");
        let part_of_word = before
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-');
        if !prefixed && part_of_word {
            continue;
        }
        out.push(Named {
            bare: text[i..i + 5].to_owned(),
            prefixed,
        });
    }
    out
}

#[test]
fn the_document_has_a_row_for_every_code_of_the_table() {
    let rows = rows_of(&doc());
    let missing: Vec<&str> = codes::iter()
        .map(|row| row.code)
        .filter(|code| !rows.contains(*code))
        .collect();
    assert!(
        missing.is_empty(),
        "{DOC} has no table row for {} of {} codes: {}",
        missing.len(),
        codes::CODES.len(),
        missing.join(", ")
    );
}

#[test]
fn the_document_names_no_code_the_table_does_not_have() {
    let text = doc();
    let rows = rows_of(&text);
    let mut unknown: Vec<String> = rows
        .iter()
        .filter(|code| codes::lookup(code).is_none())
        .cloned()
        .collect();
    let mut bare_seen: BTreeSet<String> = BTreeSet::new();
    for named in named_in(&text) {
        if named.prefixed {
            let code = format!("MDT-{}", named.bare);
            if codes::lookup(&code).is_none() {
                unknown.push(code);
            }
        } else if codes::lookup(&format!("MDT-{}", named.bare)).is_none() {
            bare_seen.insert(named.bare);
        }
    }
    unknown.sort();
    unknown.dedup();
    assert!(
        unknown.is_empty(),
        "{DOC} names codes the table does not have: {}",
        unknown.join(", ")
    );
    let bare_seen: Vec<&str> = bare_seen.iter().map(String::as_str).collect();
    assert_eq!(
        bare_seen, BARE_NOT_IN_TABLE,
        "the codes {DOC} names without the MDT- prefix and the table does not have"
    );
}

#[test]
fn the_scanner_reads_codes_as_the_document_writes_them() {
    let named = named_in(
        "| MDT-E0320 | x | V03, E0320a | y |\nE0406 and (MDT-W0504), W0207-like, SE0101, E01011",
    );
    let seen: Vec<(String, bool)> = named.into_iter().map(|n| (n.bare, n.prefixed)).collect();
    assert_eq!(
        seen,
        [
            ("E0320".to_owned(), true),
            ("E0406".to_owned(), false),
            ("W0504".to_owned(), true),
            ("W0207".to_owned(), false),
        ]
    );
    let rows =
        rows_of("| Code | T |\n|---|---|\n| MDT-E0101 | Syntax error | — | x |\ntext MDT-E0102\n");
    assert_eq!(rows.into_iter().collect::<Vec<_>>(), ["MDT-E0101"]);
}
