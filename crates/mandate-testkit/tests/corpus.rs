//! The corpus gate: every call the TypeScript compiler's own tests make to
//! a front door of the compiler, made again against the Rust compiler and
//! compared with what TypeScript gave, byte for byte
//! (`vectors/README.md`, section "corpus/"; `crates/mandate-testkit/src/corpus.rs`
//! reads the corpus, builds each call's arguments and writes a Rust result as
//! the corpus stores it).
//!
//! One gate per door, each named `corpus <door>` and printing
//! `corpus <door>: ran N, passed M, pending K`, over the entries of that
//! door, named `<door> @ <id> [<codes>]` (the codes are those of the stored
//! result, sorted, so a pending list can name a family: `*MDT-E03??*`).
//! Today only `load` exists in Rust, so every other door is pending as a
//! whole, with the slice that will end it named below. Plugging a door in
//! takes two edits in this file: an arm in [`replay`], and taking the door's
//! pattern off its pending list (or narrowing it to the entries that still
//! fail).
//!
//! Two things are neither passed nor pending, and are counted and printed
//! (`corpus <door>: excluded N: ...`): the entries in [`EXCLUDED`], by id
//! and with the reason, which are not run; and the doors in [`OUT_OF_SCOPE`].
//! An excluded id that names no entry fails the gate, and so does a total
//! that is not the corpus's: nothing leaves the gate unseen.

#![allow(clippy::panic, clippy::expect_used, missing_docs)]

use mandate_ir::{Span, Spans, Value, parse};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::corpus::{
    Actual, Corpus, Door, Entry, Input, Kind, digest_of, ir_text, render_load, spans_text,
};
use mandate_testkit::run_gate;

// ---------------------------------------------------------------------------
// What is not ported yet, by door, and what is not compared

/// `check`: the check port, R9 (in progress).
const PENDING_CHECK: &[&str] = &["check @ *"];
/// `load_modules`: it calls `check`'s linker, so it waits for the check port,
/// R9 (in progress).
const PENDING_LOAD_MODULES: &[&str] = &["load_modules @ *"];
/// `check_patch`: the patch and subprogram checks, R13.
const PENDING_CHECK_PATCH: &[&str] = &["check_patch @ *"];
/// `check_subprogram`: R13.
const PENDING_CHECK_SUBPROGRAM: &[&str] = &["check_subprogram @ *"];
/// `check_amendment`: R13.
const PENDING_CHECK_AMENDMENT: &[&str] = &["check_amendment @ *"];
/// `apply_patch`: R13.
const PENDING_APPLY_PATCH: &[&str] = &["apply_patch @ *"];
/// `validate_lock`: the lock checks, R14.
const PENDING_VALIDATE_LOCK: &[&str] = &["validate_lock @ *"];
/// `denial_diagnostics`: the sandbox target, R15.
const PENDING_DENIAL_DIAGNOSTICS: &[&str] = &["denial_diagnostics @ *"];

/// The pending list of a door. `acs_target` has none: see [`OUT_OF_SCOPE`].
fn pending(door: Door) -> &'static [&'static str] {
    match door {
        Door::Load => &[],
        Door::Check => PENDING_CHECK,
        Door::LoadModules => PENDING_LOAD_MODULES,
        Door::CheckPatch => PENDING_CHECK_PATCH,
        Door::CheckSubprogram => PENDING_CHECK_SUBPROGRAM,
        Door::CheckAmendment => PENDING_CHECK_AMENDMENT,
        Door::ApplyPatch => PENDING_APPLY_PATCH,
        Door::ValidateLock => PENDING_VALIDATE_LOCK,
        Door::AcsTarget => &[],
        Door::DenialDiagnostics => PENDING_DENIAL_DIAGNOSTICS,
    }
}

/// Entries that are not run, by id, with the reason: a call whose result
/// cannot be compared with Rust's. The kinds that were looked for in the
/// `load` entries, none of which the corpus has:
///
/// - a call the TypeScript parser dies on with `RangeError` (stack
///   overflow) where Rust refuses with `MDT-E0105` on purpose: the corpus
///   has no `throws` entry of `load`, and no `load` result with `MDT-E0105`;
/// - an input with a lone UTF-16 surrogate, which is not a Rust `&str`: the
///   corpus holds none (its files are strict JSON with no lone surrogate,
///   and `summary.json` lists the calls left out for one).
///
/// Each item is `(id, reason)`; one that names no entry fails the gate.
const EXCLUDED: &[(&str, &str)] = &[];

/// Doors that are not compared at all, with the reason.
const OUT_OF_SCOPE: &[(Door, &str)] = &[(
    Door::AcsTarget,
    "the ACS/Rego target stays in TypeScript for release 0.5; it is not part of the Rust port",
)];

// ---------------------------------------------------------------------------
// The doors

/// The Rust function for the door of `input`, and its result as the corpus
/// stores it. This is where a door is plugged in: one arm, which calls the
/// Rust door, and builds the result with the `render_*` function of its
/// shape in `mandate_testkit::corpus` (or `Actual::Throws(message)` for a
/// call that raises). A door without an arm gives `Err`, and is on its
/// pending list.
fn replay(input: &Input<'_>) -> Result<Actual, String> {
    match input {
        Input::Load { source, kind } => {
            let kind = match kind {
                Kind::Mdt => SourceKind::Mdt,
                Kind::Json => SourceKind::Json,
            };
            Ok(Actual::Result(render_load(&load(source, kind))))
        }
        other => Err(format!(
            "the Rust door for {} is not ported yet",
            other.door().name()
        )),
    }
}

/// One entry: its input built, the door called, the result compared.
fn run(corpus: &Corpus, entry: &Entry) -> Result<(), String> {
    let input = corpus
        .input(entry)
        .map_err(|e| format!("{} (from {}): {e}", entry.id, entry.files.join(", ")))?;
    let actual = replay(&input)
        .map_err(|e| format!("{} (from {}): {e}", entry.id, entry.files.join(", ")))?;
    mandate_testkit::corpus::compare(entry, &actual)
}

/// The totals of the gates of all doors.
#[derive(Default)]
struct Totals {
    entries: usize,
    ran: usize,
    excluded: usize,
}

/// The gate of one door. Fails with its report.
fn gate(corpus: &Corpus, door: Door, totals: &mut Totals) -> Result<(), String> {
    let of_door: Vec<&Entry> = corpus.entries.iter().filter(|e| e.door == door).collect();
    totals.entries = totals.entries.saturating_add(of_door.len());
    let title = format!("corpus {}", door.name());

    if let Some((_, reason)) = OUT_OF_SCOPE.iter().find(|(d, _)| *d == door) {
        totals.excluded = totals.excluded.saturating_add(of_door.len());
        println!(
            "{title}: ran 0, excluded {} (the whole door: {reason})",
            of_door.len()
        );
        return if of_door.is_empty() {
            Err(format!("{title}: the corpus has no entry of this door"))
        } else {
            Ok(())
        };
    }

    // The entries named in EXCLUDED, which are not run.
    let mut problems: Vec<String> = Vec::new();
    let mut excluded: Vec<String> = Vec::new();
    let mut items: Vec<(String, &Entry)> = Vec::new();
    for entry in &of_door {
        match EXCLUDED.iter().find(|(id, _)| *id == entry.id) {
            Some((id, reason)) => excluded.push(format!("{id} ({reason})")),
            None => items.push((entry.name(), entry)),
        }
    }
    totals.excluded = totals.excluded.saturating_add(excluded.len());
    totals.ran = totals.ran.saturating_add(items.len());
    if door == Door::Load || !excluded.is_empty() {
        println!(
            "{title}: excluded {}{}",
            excluded.len(),
            if excluded.is_empty() {
                String::new()
            } else {
                format!(": {}", excluded.join("; "))
            }
        );
    }

    if let Err(report) = run_gate(&title, pending(door), items, |entry| run(corpus, entry)) {
        problems.push(report);
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n"))
    }
}

#[test]
fn corpus_gates() {
    let corpus = Corpus::load().unwrap_or_else(|e| panic!("{e}"));
    let mut totals = Totals::default();
    let mut failures: Vec<String> = Vec::new();
    for (id, _) in EXCLUDED {
        if !corpus.entries.iter().any(|e| e.id == *id) {
            failures.push(format!("the excluded id {id} names no entry"));
        }
    }
    for door in [Door::Load] {
        if let Err(report) = gate(&corpus, door, &mut totals) {
            failures.push(report);
        }
    }
    println!(
        "corpus: {} entries, ran {}, excluded {}",
        totals.entries, totals.ran, totals.excluded
    );
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

// ---------------------------------------------------------------------------
// The digests, against values computed with Node from the README's rule
// (`JSON.stringify` of the value, UTF-8, SHA-256), so that a change to a
// writer is found here and not as 145 failures.

fn ir(text: &str) -> Value {
    parse(text).expect("the IR parses").value
}

#[test]
fn ir_digest_follows_the_member_order_of_javascript() {
    // Names that are array indices come first, in numeric order, at every
    // level; the others in the order they were written.
    let program = ir(r#"{"b":1,"10":2,"2":3,"a":{"z":[1,"x"],"1":null,"0":true}}"#);
    let text = ir_text(&program);
    assert_eq!(
        text,
        r#"{"2":3,"10":2,"b":1,"a":{"0":true,"1":null,"z":[1,"x"]}}"#
    );
    assert_eq!(
        digest_of(&text),
        "sha256:95972b7770a908caf0a121e34bc2c0c6e8fba63a48a56323772ac0d7dfab31f8"
    );
}

#[test]
fn ir_digest_escapes_as_json_stringify_does() {
    // Quote, backslash and the short escapes; \u00xx in lower case for the
    // other characters below U+0020; U+007F, U+2028, accented letters and a
    // character outside the BMP as themselves.
    let program = ir(r#"{"s":"a\"b\\c\b\f\n\r\t\u0001\u001f\u007f é😀/"}"#);
    let text = ir_text(&program);
    assert_eq!(
        text,
        "{\"s\":\"a\\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}\u{2028}\u{e9}\u{1F600}/\"}"
    );
    assert_eq!(
        digest_of(&text),
        "sha256:54d62f2fb30d0cc28aeb42aa115c73451d872da78aca4615bef261f1eaa6da9b"
    );
}

#[test]
fn span_digest_sorts_by_utf16_not_utf8() {
    // U+FF5E sorts before U+1F600 in UTF-8 and after it in UTF-16.
    let span = |a, b, c, d| Span {
        start_line: a,
        start_col: b,
        end_line: c,
        end_col: d,
    };
    let mut spans = Spans::new();
    spans.insert("/\u{ff5e}".to_owned(), span(1, 2, 3, 4));
    spans.insert("/\u{1F600}".to_owned(), span(5, 6, 7, 8));
    spans.insert("/a".to_owned(), span(1, 1, 1, 2));
    spans.insert("/Z".to_owned(), span(2, 1, 2, 9));
    spans.insert(String::new(), span(1, 1, 9, 1));
    spans.insert("/10".to_owned(), span(3, 3, 3, 4));
    spans.insert("/9".to_owned(), span(4, 4, 4, 5));
    let text = spans_text(&spans);
    assert_eq!(
        text,
        "[[\"\",[1,1,9,1]],[\"/10\",[3,3,3,4]],[\"/9\",[4,4,4,5]],[\"/Z\",[2,1,2,9]],[\"/a\",[1,1,1,2]],[\"/\u{1F600}\",[5,6,7,8]],[\"/\u{ff5e}\",[1,2,3,4]]]"
    );
    assert_eq!(
        digest_of(&text),
        "sha256:94b722200c6788c0c719a9c9e47a247270e99e87ebcd06bfa6102e2af8d646f9"
    );
    // No spans: the digest of `[]`.
    assert_eq!(
        digest_of(&spans_text(&Spans::new())),
        "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
    );
}
