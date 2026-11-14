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
//! result, sorted, so a pending list can name a family: `*MDT-E03*`).
//! Six doors exist in Rust: `load` (`mandate_syntax::load`), `check`,
//! `load_modules`, `validate_lock`, `denial_diagnostics` and `apply_patch`
//! (`mandate_check`; `apply_patch` runs no static check, so none of its
//! entries is pending).
//! The entries of `check` and `load_modules` are pending only by the family
//! of codes of a stage not ported yet (`mandate_check::UNPORTED`; the
//! families are `mandate_testkit::codes::FAMILIES`, and
//! `mandate_testkit::check_pending` holds each list to them), with the slice
//! named beside each, and by name the entries that fail although every code
//! they hold is of a ported family, with the function of the later slice
//! that gives it; the other doors of Rust have none pending. Every other door is pending as a whole, with the
//! slice that will end it named below.
//! Plugging a door in takes two edits in this file: an arm in [`replay`],
//! and taking the door's pattern off its pending list (or narrowing it to
//! the entries that still fail).
//!
//! A `check` entry also passes when TypeScript ran a stage Rust does not
//! have yet and that stage happened to give nothing (its static checks on a
//! result with no error, and the claim of a sub-program); the gate prints how
//! many of the passing entries are such. The lock checks are ported, so they
//! are not among them.
//!
//! Two things are neither passed nor pending, and are counted and printed
//! (`corpus <door>: excluded N: ...`): the entries in [`EXCLUDED`], by id
//! and with the reason, which are not run; and the doors in [`OUT_OF_SCOPE`].
//! An excluded id that names no entry fails the gate, and so does a total
//! that is not the corpus's: nothing leaves the gate unseen.

#![allow(clippy::panic, clippy::expect_used, missing_docs)]

use mandate_check::{
    CheckOptions, ModuleSource, Modules, PatchOp, apply_patch, check, denial_diagnostics,
    load_modules, validate_lock,
};
use mandate_ir::{Diagnostic, JsValue, Span, Spans, Value, parse, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::corpus::{
    Actual, Corpus, Door, Entry, Input, Kind, Outcome, digest_of, ir_text, render_apply_patch,
    render_check, render_diagnostics, render_load, render_load_modules, spans_text,
};
use mandate_testkit::{Miss, check_pending, omission, run_held_gate};

// ---------------------------------------------------------------------------
// What is not ported yet, by door, and what is not compared

/// `check`: the entries that expect a code of a stage `mandate_check::check`
/// does not run yet (`mandate_check::UNPORTED`), by family of codes
/// (`mandate_testkit::codes::FAMILIES`), with the slice that ports it.
const PENDING_CHECK: &[&str] = &[
    // R13: the system model, change sets, reads.
    "*MDT-E1001*",
    "*MDT-E1003*",
    "*MDT-E1004*",
    "*MDT-E1005*",
    "*MDT-E1006*",
    "*MDT-E1007*",
    "*MDT-E11*",
    "*MDT-E12*",
    // An entry whose codes are all of ported families, but which the
    // TypeScript raises in a function of R13: `changeset`, E0403 of a
    // member without `idempotent_by` (1).
    "check @ check-9f16a85a913f6058 [MDT-E0403 MDT-W0601]",
];
/// `load_modules`: a module that does not check against the others for a
/// reason of a later slice, by family of codes.
const PENDING_LOAD_MODULES: &[&str] = &[
    // R13: the system model.
    "*MDT-E1001*",
];
/// `check_patch`: the patch and subprogram checks, R13.
const PENDING_CHECK_PATCH: &[&str] = &["check_patch @ *"];
/// `check_subprogram`: R13.
const PENDING_CHECK_SUBPROGRAM: &[&str] = &["check_subprogram @ *"];
/// `check_amendment`: R13.
const PENDING_CHECK_AMENDMENT: &[&str] = &["check_amendment @ *"];

/// The pending list of a door. `acs_target` has none: see [`OUT_OF_SCOPE`].
fn pending(door: Door) -> &'static [&'static str] {
    match door {
        Door::Load => &[],
        Door::Check => PENDING_CHECK,
        Door::LoadModules => PENDING_LOAD_MODULES,
        Door::CheckPatch => PENDING_CHECK_PATCH,
        Door::CheckSubprogram => PENDING_CHECK_SUBPROGRAM,
        Door::CheckAmendment => PENDING_CHECK_AMENDMENT,
        Door::ApplyPatch => &[],
        Door::ValidateLock => &[],
        Door::AcsTarget => &[],
        Door::DenialDiagnostics => &[],
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
        Input::Load { source, kind } => Ok(Actual::Result(render_load(&load(
            source,
            source_kind(*kind),
        )))),
        Input::Check {
            source,
            kind,
            modules,
            lock,
            claim,
        } => {
            let modules = modules.as_ref().map(|m| modules_map(m));
            let r = check(
                source,
                source_kind(*kind),
                &CheckOptions {
                    lock: *lock,
                    modules: modules.as_ref(),
                    claim: *claim,
                },
            );
            Ok(Actual::Result(render_check(
                r.program.as_ref(),
                &r.spans,
                &r.diagnostics,
                r.ok,
                r.hashes.as_ref().map(|h| JsValue::Object(h.to_js())),
            )))
        }
        Input::LoadModules { sources } => {
            let sources: Vec<ModuleSource<'_>> = sources
                .iter()
                .map(|s| ModuleSource {
                    text: s.text,
                    kind: source_kind(s.kind),
                    file: s.file,
                })
                .collect();
            let r = load_modules(&sources);
            let modules: Vec<(&str, &Value)> = r.modules.iter().collect();
            let problems: Vec<(&str, &[Diagnostic])> = r
                .problems
                .iter()
                .map(|p| (p.file.as_str(), p.diagnostics.as_slice()))
                .collect();
            Ok(Actual::Result(render_load_modules(&modules, &problems)))
        }
        // `validateLock(value)`; a value that is not there is `undefined`, which
        // the schema refuses as it refuses `null`.
        Input::ValidateLock { value } => Ok(Actual::Result(render_diagnostics(&validate_lock(
            value.unwrap_or(&Value::Null),
        )))),
        // `denialDiagnostics(program, report)`, which throws a `TypeError` for
        // a report it cannot read.
        Input::DenialDiagnostics { program, report } => {
            Ok(match denial_diagnostics(program, report) {
                Ok(diagnostics) => Actual::Result(render_diagnostics(&diagnostics)),
                Err(message) => Actual::Throws(message),
            })
        }
        Input::ApplyPatch(p) => {
            let ops: Vec<PatchOp> = p.ops.iter().map(PatchOp::from_value).collect();
            let modules = p.modules.as_ref().map(|m| modules_map(m));
            let r = apply_patch(p.program, p.base, &ops, modules.as_ref());
            let governance = JsValue::Array(
                r.governance
                    .iter()
                    .map(mandate_check::GovernanceChange::to_js)
                    .collect(),
            );
            Ok(Actual::Result(render_apply_patch(
                r.ok,
                &r.diagnostics,
                governance,
                r.program.as_ref(),
                r.hash.as_deref(),
            )))
        }
        other => Err(format!(
            "the Rust door for {} is not ported yet",
            other.door().name()
        )),
    }
}

fn source_kind(kind: Kind) -> SourceKind {
    match kind {
        Kind::Mdt => SourceKind::Mdt,
        Kind::Json => SourceKind::Json,
    }
}

/// The modules of a call as `mandate_check::Modules`, in the order the call
/// gave them.
fn modules_map(modules: &[(&str, &Value)]) -> Modules {
    modules
        .iter()
        .map(|(name, ir)| (*name, (*ir).clone()))
        .collect()
}

/// One entry: its input built, the door called, the result compared; an
/// entry that differs is held to differing only by omission.
fn run(corpus: &Corpus, entry: &Entry) -> Result<(), Miss> {
    let from = || format!("{} (from {})", entry.id, entry.files.join(", "));
    let input = corpus
        .input(entry)
        .map_err(|e| Miss::Differs(format!("{}: {e}", from())))?;
    let actual = replay(&input).map_err(|e| Miss::Excluded {
        rule: "the door is not ported, so there is no Rust result to hold",
        why: format!("{}: {e}", from()),
    })?;
    mandate_testkit::corpus::compare(entry, &actual).map_err(|why| held(entry, &actual, why))
}

/// The stored diagnostics `expected` against Rust's `actual`, each whole.
fn omits(expected: &JsValue, actual: &JsValue) -> Result<(), String> {
    let texts = |v: &JsValue| -> Vec<String> {
        v.as_array()
            .unwrap_or_default()
            .iter()
            .map(|d| stringify(d).unwrap_or_default())
            .collect()
    };
    omission(
        &texts(expected),
        &texts(actual),
        |w, g| w == g,
        Clone::clone,
    )
    .map(|_| ())
}

/// Why an entry whose result is not the stored one fails: by omission when
/// every member of the result is the stored one but the diagnostics (and
/// the problems of `load_modules`, each with its diagnostics), which are
/// the stored ones with some left out, in order; `ok` and `hashes` follow
/// from the diagnostics and are not held.
fn held(entry: &Entry, actual: &Actual, why: String) -> Miss {
    let (stored, rendered) = match (&entry.outcome, actual) {
        (Outcome::Result(v), Actual::Result(r)) => (JsValue::from(v), &r.value),
        (Outcome::Throws(_), _) => {
            return Miss::Excluded {
                rule: "the TypeScript threw, and a Rust result cannot be held to a throw",
                why,
            };
        }
        (Outcome::ResultText(_), _) => {
            return Miss::Excluded {
                rule: "a stored result held as text, with a number the strict JSON reader does not read",
                why,
            };
        }
        (Outcome::Result(_), Actual::Throws(_)) => return Miss::Differs(why),
    };
    let (Some(e), Some(a)) = (stored.as_object(), rendered.as_object()) else {
        return Miss::Differs(why);
    };
    for (key, want) in e.iter() {
        let got = a.get(key).cloned().unwrap_or(JsValue::Undefined);
        let verdict = match key {
            "ok" | "hashes" => Ok(()),
            "diagnostics" => omits(want, &got),
            "problems" => {
                let file = |p: &JsValue| p.get("file").and_then(JsValue::as_str).map(str::to_owned);
                let empty = JsValue::Array(Vec::new());
                let wants = want.as_array().unwrap_or_default();
                let gots = got.as_array().unwrap_or_default();
                omission(
                    wants,
                    gots,
                    |w, g| {
                        file(w) == file(g)
                            && omits(
                                w.get("diagnostics").unwrap_or(&empty),
                                g.get("diagnostics").unwrap_or(&empty),
                            )
                            .is_ok()
                    },
                    |g| format!("the problem of {:?}", file(g)),
                )
                .map(|_| ())
            }
            _ if stringify(want) == stringify(&got) => Ok(()),
            _ => Err(format!("{key} is not the stored one")),
        };
        if let Err(differs) = verdict {
            return Miss::Differs(format!("{key}: {differs}\n{why}"));
        }
    }
    Miss::Omits(why)
}

/// Says how many of the `check` entries that pass did so although the
/// TypeScript ran a stage that `mandate_check::check` does not run yet
/// (`mandate_check::UNPORTED`): a stored result with no error is one the
/// static checks ran on (and gave nothing); one with a claim is one whose
/// claim the static checks read. Such an entry passes because that stage
/// happened to give nothing, so the numbers are printed rather than hidden.
/// (The lock checks, which a result with no error and a lock ran, are in
/// Rust: they are checked, not counted.)
fn print_unported_stages(corpus: &Corpus, title: &str, passed: &[&Entry]) {
    let (mut statics, mut claims) = (0_usize, 0_usize);
    for entry in passed {
        let Ok(Input::Check { claim, .. }) = corpus.input(entry) else {
            continue;
        };
        let ok = match &entry.outcome {
            mandate_testkit::corpus::Outcome::Result(r) => r.get("ok") == Some(&Value::Bool(true)),
            _ => false,
        };
        if ok {
            statics = statics.saturating_add(1);
        }
        if claim.is_some() {
            claims = claims.saturating_add(1);
        }
    }
    println!(
        "{title}: of the {} that pass, {statics} have no error, so TypeScript ran its static checks on them (the core, R11, and the authority, R12, are in Rust; the system model's diagnostics, R13, are not yet), and {claims} have a claim (R13)",
        passed.len()
    );
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

    let mut passed: Vec<&Entry> = Vec::new();
    let gate = run_held_gate(&title, pending(door), items, |entry| {
        let r = run(corpus, entry);
        if r.is_ok() {
            passed.push(entry);
        }
        r
    });
    if let Err(report) = gate {
        problems.push(report);
    }
    if door == Door::Check {
        print_unported_stages(corpus, &title, &passed);
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
    // A pending entry is a family of codes, a door, or entries by name, each
    // with why beside it.
    for door in Door::ALL {
        check_pending(pending(door))
            .unwrap_or_else(|e| panic!("the pending list of {}: {e}", door.name()));
    }
    let mut totals = Totals::default();
    let mut failures: Vec<String> = Vec::new();
    for (id, _) in EXCLUDED {
        if !corpus.entries.iter().any(|e| e.id == *id) {
            failures.push(format!("the excluded id {id} names no entry"));
        }
    }
    for door in Door::ALL {
        if let Err(report) = gate(&corpus, door, &mut totals) {
            failures.push(report);
        }
    }
    println!(
        "corpus: {} entries, ran {}, excluded {}",
        totals.entries, totals.ran, totals.excluded
    );
    if totals.entries != corpus.entries.len() {
        failures.push(format!(
            "the doors hold {} entries, the corpus has {}",
            totals.entries,
            corpus.entries.len()
        ));
    }
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
