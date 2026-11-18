//! The door `check_patch` with `opts` (`{ lock, libraries, config }`, language
//! 0.7, the Rust's alone): the patched program is checked as `check` checks
//! it, with the lock and the libraries the lock pins. No TypeScript reads the
//! parameter, so every expectation is written by hand.
//!
//! - With the lock and the libraries, a patch to a program that applies a
//!   pattern of a pinned library checks; without them the library is not
//!   there (E1604), and a lock that pins another digest breaks the pin
//!   (E1605): the answer is `check`'s for the patched program.
//! - Without `opts` (absent, `null` or empty) the door is what it was, and a
//!   program of 0.1 to 0.5 is checked as before whatever `opts` holds.
//! - A malformed `opts` is refused in `check`'s words.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::json_doors::door;
use mandate_check::library::LibrarySource;
use mandate_check::{CheckOptions, PatchOptions, check, check_patch};
use mandate_ir::{Diagnostic, JsValue, Value, hash_program, parse, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{library_files, read_json, read_text};

const INVOICES: &str = "fixtures/library/invoices.mdt";
const LOCK: &str = "fixtures/library/invoices.lock.json";
const CONNECTORS: &str = "fixtures/library/acme.connectors";
/// A program of 0.5, which reads no library.
const OLD: &str = "fixtures/boundary/reach.mdt";

fn program(file: &str) -> Value {
    load(&read_text(file).unwrap(), SourceKind::Mdt)
        .program
        .unwrap()
}

fn connectors() -> Vec<LibrarySource> {
    let (manifest, files) = library_files(CONNECTORS).unwrap();
    vec![LibrarySource { manifest, files }]
}

/// The lock with the digest of acme.connectors made another.
fn broken_lock() -> Value {
    let text = read_text(LOCK).unwrap();
    let digest = "sha256:a595b65236947513762e57701405a1069cebdbe97f3daa48aff59ca3b50e3220";
    assert!(text.contains(digest));
    parse(&text.replace(digest, &format!("sha256:{}", "a".repeat(64))))
        .unwrap()
        .value
}

fn codes(diagnostics: &[Diagnostic]) -> Vec<&str> {
    diagnostics
        .iter()
        .filter(|d| d.severity == mandate_ir::Severity::Error)
        .map(|d| d.code.as_str())
        .collect()
}

fn text(v: &Value) -> String {
    stringify(&JsValue::from(v)).unwrap()
}

#[test]
fn a_patch_to_a_program_that_applies_a_pinned_library_is_checked_with_the_lock_and_the_libraries() {
    let p = program(INVOICES);
    let base = hash_program(&p).program;
    let lock = read_json(LOCK).unwrap();
    let libraries = connectors();
    // The patched program is what `check` says of it, with the same options.
    let with = PatchOptions {
        lock: Some(&lock),
        libraries: Some(&libraries),
        revoked: None,
    };
    let r = check_patch(&p, &base, &[], None, &with);
    assert!(r.ok, "{:?}", codes(&r.diagnostics));
    assert_eq!(r.hash.as_deref(), Some(base.as_str()));
    let c = check(
        &text(&p),
        SourceKind::Json,
        &CheckOptions {
            lock: Some(&lock),
            libraries: Some(&libraries),
            ..CheckOptions::default()
        },
    );
    assert!(c.ok);
    assert_eq!(r.diagnostics, c.diagnostics);
    // Without them the library is not there: what the door said before.
    let none = check_patch(&p, &base, &[], None, &PatchOptions::default());
    assert!(!none.ok);
    assert!(codes(&none.diagnostics).contains(&"MDT-E1604"));
    // The lock alone does not bring the library either.
    let lock_only = check_patch(
        &p,
        &base,
        &[],
        None,
        &PatchOptions {
            lock: Some(&lock),
            ..PatchOptions::default()
        },
    );
    assert!(codes(&lock_only.diagnostics).contains(&"MDT-E1604"));
    // A lock that pins another digest of the library breaks the pin, which
    // the libraries alone do not: the answer differs with the lock.
    let broken = broken_lock();
    let pinned = check_patch(
        &p,
        &base,
        &[],
        None,
        &PatchOptions {
            lock: Some(&broken),
            libraries: Some(&libraries),
            revoked: None,
        },
    );
    assert!(!pinned.ok);
    assert!(codes(&pinned.diagnostics).contains(&"MDT-E1605"));
    let unlocked = check_patch(
        &p,
        &base,
        &[],
        None,
        &PatchOptions {
            libraries: Some(&libraries),
            ..PatchOptions::default()
        },
    );
    assert!(!codes(&unlocked.diagnostics).contains(&"MDT-E1605"));
}

/// The door `check_patch` called with `extra` members.
fn call(file: &str, extra: &str) -> Result<String, String> {
    let p = program(file);
    let input = format!(
        r#"{{"program":{},"base":"{}","ops":[]{extra}}}"#,
        text(&p),
        hash_program(&p).program
    );
    let d = door("check_patch").unwrap();
    (d.call)(&parse(&input).unwrap().value)
        .map(|o| stringify(&o).unwrap())
        .map_err(|e| e.message)
}

/// The door `check` called with the same `opts`, for its refusal.
fn refused_by_check(opts: &str) -> String {
    let input = format!(r#"{{"text":"module m @ 0.1\n","kind":"mdt","opts":{opts}}}"#);
    let d = door("check").unwrap();
    (d.call)(&parse(&input).unwrap().value).unwrap_err().message
}

fn quote(s: &str) -> String {
    stringify(&JsValue::from(s)).unwrap()
}

fn libraries_json() -> String {
    let (manifest, files) = library_files(CONNECTORS).unwrap();
    let files: Vec<String> = files
        .iter()
        .map(|(f, t)| format!("{}:{}", quote(f), quote(t)))
        .collect();
    format!(
        r#"[{{"manifest":{},"files":{{{}}}}}]"#,
        quote(&manifest),
        files.join(",")
    )
}

#[test]
fn the_json_door_reads_opts_as_the_door_check_reads_them() {
    let lock = text(&read_json(LOCK).unwrap());
    let opts = format!(
        r#","opts":{{"lock":{lock},"libraries":{}}}"#,
        libraries_json()
    );
    let answer = call(INVOICES, &opts).unwrap();
    assert!(
        answer.starts_with(r#"{"ok":true,"hash":"sha256:"#),
        "{answer}"
    );
    // The same as the library function's.
    let p = program(INVOICES);
    let (l, libs) = (read_json(LOCK).unwrap(), connectors());
    let r = check_patch(
        &p,
        &hash_program(&p).program,
        &[],
        None,
        &PatchOptions {
            lock: Some(&l),
            libraries: Some(&libs),
            revoked: None,
        },
    );
    assert_eq!(answer, stringify(&r.to_js()).unwrap());
    // Without `opts`, with it `null`, `{}` or a list of no libraries: as it was.
    let before = call(INVOICES, "").unwrap();
    assert!(before.contains("MDT-E1604"));
    for same in [
        r#","opts":null"#,
        r#","opts":{}"#,
        r#","opts":{"lock":null,"libraries":null,"config":null}"#,
        r#","opts":{"libraries":[]}"#,
    ] {
        assert_eq!(call(INVOICES, same).unwrap(), before, "{same}");
    }
    // A program of 0.5 is checked as before whatever `opts` holds.
    let old = call(OLD, "").unwrap();
    assert_eq!(call(OLD, &opts).unwrap(), old);
}

#[test]
fn a_malformed_opts_is_refused_in_the_words_of_check() {
    for opts in [
        "5",
        r#""x""#,
        "[]",
        r#"{"libraries":5}"#,
        r#"{"libraries":[5]}"#,
        r#"{"libraries":[{}]}"#,
        r#"{"libraries":[{"manifest":"x","files":[]}]}"#,
        r#"{"libraries":[{"manifest":"x","files":{"a.mdt":5}}]}"#,
        r#"{"config":5}"#,
        r#"{"config":{"revoked":5}}"#,
    ] {
        let theirs = refused_by_check(opts);
        let ours = call(INVOICES, &format!(r#","opts":{opts}"#)).unwrap_err();
        assert_eq!(ours, theirs, "{opts}");
    }
}
