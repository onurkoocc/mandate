//! The two versions of `std.patterns` the compiler embeds (spec/attention.md
//! "`std.patterns` 2.0.0"), where a conformance case cannot say it: the
//! digests of both, held as literals; their slots, the same; which one a
//! program reads; what `mandate add` pins and writes; E1609 for every kind
//! of module; and the attention facts of a lead's sub-program whose parent
//! pins 2.0.0. No TypeScript reads 0.7, so every expectation is written by
//! hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::library::ops::{Request, add, upgrade};
use mandate_check::library::{
    STD_PATTERNS_EMBEDDED, std_patterns_digest, std_patterns_for, std_patterns_pin,
};
use mandate_check::{
    CheckOptions, CheckResult, DataClass, Modules, PatchOp, Room, SubprogramInput, attention_facts,
    check, check_subprogram, skeleton,
};
use mandate_ir::{
    Diagnostic, JsValue, Language, Map, Value, canonicalize, hash_program, parse, stringify,
};
use mandate_lib::{Timestamp, Version};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{read_json, read_text};

/// The digest of `std.patterns` 1.0.0, which every lock of 0.6 in the
/// repository pins.
const DIGEST_1_0_0: &str =
    "sha256:cea6319dba99a4e2790b07038eba90a87a4cb9b036f3c7d87e4b26d68fbacd26";

/// The program hash of its module.
const MODULE_1_0_0: &str =
    "sha256:092932757be73f0b172d1638d5ab62cdf400cc5273682714633c95dc3864c941";

/// The digest of `std.patterns` 2.0.0, which the locks of
/// `fixtures/attention/` pin.
const DIGEST_2_0_0: &str =
    "sha256:7a690cb097e22b999be322ff02b2c145dc7292a968b01bd9cadd4bc7c7ee33b7";

/// The program hash of its module.
const MODULE_2_0_0: &str =
    "sha256:6318fc65ec6213dfbe1d3f390a1b3d8020608ffe7cc8e4b9006a86dd1140d755";

const BATCH: &str = "fixtures/attention/batch.mdt";
const BATCH_LOCK: &str = "fixtures/attention/batch.lock.json";
const FAN_OUT: &str = "fixtures/attention/fan-out.mdt";
const FAN_OUT_LOCK: &str = "fixtures/attention/fan-out.lock.json";
const MAKER_CHECKER: &str = "fixtures/attention/maker-checker.mdt";
const MAKER_CHECKER_LOCK: &str = "fixtures/attention/maker-checker.lock.json";

fn version(v: &str) -> Version {
    Version::parse(v).unwrap()
}

fn checked(text: &str, lock: Option<&Value>, modules: Option<&Modules>) -> CheckResult {
    check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            lock,
            modules,
            ..CheckOptions::default()
        },
    )
}

/// `code at path` of each error.
fn errors(diagnostics: &[Diagnostic]) -> Vec<String> {
    diagnostics
        .iter()
        .filter(|d| d.severity == mandate_ir::Severity::Error)
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// The facts of a diagnostic, as JSON.
fn facts(d: &Diagnostic) -> String {
    stringify(&JsValue::Object(d.facts.clone().unwrap_or_default())).unwrap_or_default()
}

/// `lock` with `std.patterns` pinned at the embedded `v`, and of `format`:
/// one older than 0.7 without the two fields 0.7 adds (`role_classes`,
/// `promotion`), which its schema does not have.
fn pinning(lock: &Value, v: &str, format: &str) -> Value {
    let l = std_patterns_for(None, Some(&version(v))).unwrap();
    let pin = stringify(&JsValue::Object(l.pin().to_js())).unwrap();
    let pin = parse(&pin).unwrap().value;
    let mut lock = lock.clone();
    if let Value::Object(m) = &mut lock {
        m.insert("lock", format);
        if format != "mandate/lock/0.7" {
            m.remove("role_classes");
            m.remove("promotion");
        }
        if let Some(Value::Object(libs)) = m.get_mut("libraries") {
            libs.insert("std.patterns", pin);
        }
    }
    lock
}

/// The names of the stages of the workflow `w` of the running program of
/// `r` (its `linked`, or the expansion).
fn stages_of(r: &CheckResult, w: &str) -> Vec<String> {
    let program = r.expanded.as_ref().expect("an expansion");
    program
        .get("defs")
        .and_then(|d| d.get(w))
        .and_then(|d| d.get("body"))
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter(|s| s.get("op").and_then(Value::as_str) == Some("stage"))
        .filter_map(|s| s.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

#[test]
fn both_versions_read_and_their_digests_are_held() {
    let found: Vec<(String, String, String, Language)> = STD_PATTERNS_EMBEDDED
        .iter()
        .map(|e| {
            let l = e.load().expect("an embedded version reads");
            assert_eq!(l.manifest.version().to_string(), e.version);
            let module = l.hashes.get("std.patterns").unwrap().to_string();
            let language = mandate_check::library::library_language(&l).unwrap();
            (e.version.to_owned(), l.digest.to_string(), module, language)
        })
        .collect();
    assert_eq!(
        found,
        vec![
            (
                "1.0.0".to_owned(),
                DIGEST_1_0_0.to_owned(),
                MODULE_1_0_0.to_owned(),
                Language::V0_6
            ),
            (
                "2.0.0".to_owned(),
                DIGEST_2_0_0.to_owned(),
                MODULE_2_0_0.to_owned(),
                Language::V0_7
            ),
        ]
    );
    // What the compiler embeds is what the repository holds, byte for byte.
    assert_eq!(
        STD_PATTERNS_EMBEDDED[0].module,
        read_text("lib/std.patterns/patterns.mdt").unwrap()
    );
    assert_eq!(
        STD_PATTERNS_EMBEDDED[0].manifest,
        read_text("lib/std.patterns/mandate.library.json").unwrap()
    );
    assert_eq!(
        STD_PATTERNS_EMBEDDED[1].module,
        read_text("lib/std.patterns@2/patterns.mdt").unwrap()
    );
    assert_eq!(
        STD_PATTERNS_EMBEDDED[1].manifest,
        read_text("lib/std.patterns@2/mandate.library.json").unwrap()
    );
    // Each checks as a module, with nothing given.
    for e in STD_PATTERNS_EMBEDDED {
        let r = checked(e.module, None, None);
        assert!(r.ok, "{}: {:#?}", e.version, errors(&r.diagnostics));
    }
}

/// The definitions of a version's module, each without what 2.0.0 may
/// change: a pattern's body and doc, a definition's doc.
fn signatures(e: &mandate_check::library::Embedded) -> Vec<(String, String)> {
    let ir = load(e.module, SourceKind::Mdt).program.unwrap();
    ir.get("defs")
        .and_then(Value::as_object)
        .unwrap()
        .iter()
        .map(|(n, d)| {
            let mut d = d.as_object().cloned().unwrap();
            d.remove("doc");
            if d.get("kind").and_then(Value::as_str) == Some("pattern") {
                d.remove("body");
            }
            (n.to_owned(), canonicalize(&Value::Object(d)))
        })
        .collect()
}

#[test]
fn the_two_versions_have_the_same_definitions_and_slots() {
    let (one, two) = (
        signatures(&STD_PATTERNS_EMBEDDED[0]),
        signatures(&STD_PATTERNS_EMBEDDED[1]),
    );
    assert_eq!(
        one.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
        [
            "Batch",
            "BatchWithExceptions",
            "FanOutMerge",
            "MakerChecker"
        ]
    );
    assert_eq!(one, two, "the slots, type parameters and results");
    // The bodies of 2.0.0 are those of 1.0.0 with stages and reports.
    let bodies = |e: &mandate_check::library::Embedded| -> Vec<(String, Vec<String>)> {
        let ir = load(e.module, SourceKind::Mdt).program.unwrap();
        ir.get("defs")
            .and_then(Value::as_object)
            .unwrap()
            .iter()
            .filter(|(_, d)| d.get("kind").and_then(Value::as_str) == Some("pattern"))
            .map(|(n, d)| {
                let kept: Vec<String> = d
                    .get("body")
                    .and_then(Value::as_array)
                    .unwrap()
                    .iter()
                    .filter(|s| {
                        !matches!(
                            s.get("op").and_then(Value::as_str),
                            Some("stage" | "report")
                        )
                    })
                    .map(canonicalize)
                    .collect();
                (n.to_owned(), kept)
            })
            .collect()
    };
    assert_eq!(
        bodies(&STD_PATTERNS_EMBEDDED[0]),
        bodies(&STD_PATTERNS_EMBEDDED[1])
    );
}

#[test]
fn which_version_a_program_reads() {
    let at = |language: Option<Language>, pin: Option<&str>| {
        std_patterns_for(language, pin.map(version).as_ref())
            .unwrap()
            .manifest
            .version()
            .to_string()
    };
    // Without a pin, by the program's language.
    assert_eq!(at(Some(Language::V0_6), None), "1.0.0");
    assert_eq!(at(Some(Language::V0_7), None), "2.0.0");
    assert_eq!(at(None, None), "1.0.0");
    // With one, the version it pins, whatever the language.
    assert_eq!(at(Some(Language::V0_7), Some("1.0.0")), "1.0.0");
    assert_eq!(at(Some(Language::V0_6), Some("2.0.0")), "2.0.0");
    // A pin of a version not embedded gets the version of the language,
    // which the lock's comparison refuses (E1605).
    assert_eq!(at(Some(Language::V0_7), Some("3.0.0")), "2.0.0");
    assert_eq!(at(Some(Language::V0_6), Some("1.0.1")), "1.0.0");
    assert_eq!(
        std_patterns_digest(Some(Language::V0_7)).unwrap().as_str(),
        DIGEST_2_0_0
    );
    assert_eq!(
        std_patterns_digest(Some(Language::V0_6)).unwrap().as_str(),
        DIGEST_1_0_0
    );
    let lock = read_json(BATCH_LOCK).unwrap();
    assert_eq!(std_patterns_pin(Some(&lock)), Some(version("2.0.0")));
    assert_eq!(std_patterns_pin(None), None);
}

#[test]
fn the_fixtures_of_2_0_0_check_alone_and_with_their_locks() {
    for (file, lock, workflow, stages) in [
        (
            BATCH,
            BATCH_LOCK,
            "MatchAll",
            vec!["collect", "work", "exceptions", "commit"],
        ),
        (FAN_OUT, FAN_OUT_LOCK, "MigrateTwo", vec!["work", "merge"]),
        (
            MAKER_CHECKER,
            MAKER_CHECKER_LOCK,
            "Billing",
            vec!["make", "check"],
        ),
    ] {
        let text = read_text(file).unwrap();
        let alone = checked(&text, None, None);
        assert!(alone.ok, "{file}: {:#?}", errors(&alone.diagnostics));
        assert_eq!(stages_of(&alone, workflow), stages, "{file}");
        let lock = read_json(lock).unwrap();
        let locked = checked(&text, Some(&lock), None);
        assert!(locked.ok, "{file}: {:#?}", errors(&locked.diagnostics));
        assert_eq!(stages_of(&locked, workflow), stages, "{file}");
        // The same program with its lock pinning 1.0.0 reads 1.0.0: it
        // checks, and has no stage (a module of 0.6 is read by 0.7).
        let one = pinning(&lock, "1.0.0", "mandate/lock/0.7");
        let older = checked(&text, Some(&one), None);
        assert!(older.ok, "{file}: {:#?}", errors(&older.diagnostics));
        assert!(stages_of(&older, workflow).is_empty(), "{file}");
        // A pin of a version not embedded is refused as a pin of another
        // version is.
        let mut other = lock.clone();
        if let Value::Object(m) = &mut other
            && let Some(Value::Object(libs)) = m.get_mut("libraries")
            && let Some(Value::Object(pin)) = libs.get_mut("std.patterns")
        {
            pin.insert("version", "2.0.1");
        }
        let r = checked(&text, Some(&other), None);
        assert_eq!(
            errors(&r.diagnostics),
            ["MDT-E1605 at /libraries/std.patterns"],
            "{file}"
        );
        assert!(
            facts(&r.diagnostics[0]).contains("version_differs"),
            "{file}"
        );
    }
}

#[test]
fn the_facts_of_batch_with_exceptions_2_0_0_are_the_invoice_flows() {
    let text = read_text(BATCH).unwrap();
    let lock = read_json(BATCH_LOCK).unwrap();
    let f = attention_facts(
        &text,
        SourceKind::Mdt,
        &CheckOptions {
            lock: Some(&lock),
            ..CheckOptions::default()
        },
        "MatchAll",
    )
    .expect("the facts");
    let titles: Vec<&str> = f.stages.iter().map(|s| s.title.as_str()).collect();
    assert_eq!(
        titles,
        [
            "Collect the items",
            "Work on each item",
            "Decide on the exceptions",
            "Commit what was accepted"
        ]
    );
    // A field as `(name, type, class, known)`, a report as `(role, title,
    // stage, fields)`.
    type Field = (String, String, String, String);
    type Row = (String, String, Option<String>, Vec<Field>);
    let reports: Vec<Row> = f
        .reports
        .iter()
        .map(|r| {
            (
                r.role.clone(),
                r.title.clone(),
                r.stage.clone(),
                r.fields
                    .iter()
                    .map(|x| {
                        (
                            x.name.clone(),
                            mandate_check::ty::show(&x.shown.ty),
                            x.shown.cls.as_str().to_owned(),
                            mandate_check::reports::known_name(x.shown.known).to_owned(),
                        )
                    })
                    .collect(),
            )
        })
        .collect();
    let field = |n: &str| {
        (
            n.to_owned(),
            "Int".to_owned(),
            "confidential".to_owned(),
            "plain".to_owned(),
        )
    };
    assert_eq!(
        reports,
        vec![
            (
                "accountant".to_owned(),
                "Items collected".to_owned(),
                Some("collect".to_owned()),
                vec![field("items")]
            ),
            (
                "accountant".to_owned(),
                "Batch done".to_owned(),
                Some("commit".to_owned()),
                vec![field("posted"), field("declined"), field("failed")]
            ),
        ]
    );
    // Its paths are of the running program, the expansion.
    assert_eq!(f.reports[0].path, "/defs/MatchAll/body/2");
    assert_eq!(f.stages[3].path, "/defs/MatchAll/body/7");
}

/// `batch.mdt` under the header of 0.6, with nothing else changed.
fn batch_as_0_6() -> String {
    read_text(BATCH)
        .unwrap()
        .replacen("mandate @ 0.7", "mandate @ 0.6", 1)
}

#[test]
fn a_program_of_0_6_reads_no_module_of_0_7() {
    let text = batch_as_0_6();
    let lock = read_json(BATCH_LOCK).unwrap();
    // Without a pin it reads 1.0.0, and checks.
    let alone = checked(&text, None, None);
    assert!(alone.ok, "{:#?}", errors(&alone.diagnostics));
    assert!(stages_of(&alone, "MatchAll").is_empty());
    // With 1.0.0 pinned, in a lock of 0.6, it checks.
    let one = pinning(&lock, "1.0.0", "mandate/lock/0.6");
    let r = checked(&text, Some(&one), None);
    assert!(r.ok, "{:#?}", errors(&r.diagnostics));
    // With 2.0.0 pinned it is refused: the pin, and the use.
    let two = pinning(&lock, "2.0.0", "mandate/lock/0.6");
    let r = checked(&text, Some(&two), None);
    assert_eq!(
        errors(&r.diagnostics),
        [
            "MDT-E1609 at /libraries/std.patterns",
            "MDT-E1609 at /uses/1"
        ]
    );
    assert_eq!(
        facts(&r.diagnostics[0]),
        r#"{"library":"std.patterns","version":"2.0.0","library_language":"mandate/0.7","language":"mandate/0.6"}"#
    );
    assert_eq!(
        facts(&r.diagnostics[1]),
        r#"{"module":"std.patterns","module_language":"mandate/0.7","language":"mandate/0.6"}"#
    );
    assert_eq!(
        r.diagnostics[0].message,
        "The lock pins library std.patterns 2.0.0, which is written in mandate/0.7, and this program is mandate/0.6, which cannot read it. Pin a version written in mandate/0.6 or earlier, or write the program in mandate/0.7 or later."
    );
}

/// A module of `language` with one `pub` type.
fn types_module(language: &str) -> String {
    format!(
        "mandate @ {language}\n\nmodule example.types @ 0.1\n\npub type Note = {{ text: Text }}\n"
    )
}

/// A program of `language` that imports `example.types`.
fn importer(language: &str) -> String {
    format!(
        "mandate @ {language}\n\nmodule example.importer @ 0.1\n\nuse example.types.{{Note}}\n\nlet N: Note = Note {{ text: \"a\" }}\n"
    )
}

fn module_of(text: &str) -> Modules {
    let mut m = Modules::new();
    m.insert(
        "example.types",
        load(text, SourceKind::Mdt).program.unwrap(),
    );
    m
}

#[test]
fn a_module_of_a_newer_language_given_to_the_check() {
    // 0.6 imports 0.7: E1609 at the use, and nothing more of it.
    let r = checked(
        &importer("0.6"),
        None,
        Some(&module_of(&types_module("0.7"))),
    );
    assert_eq!(errors(&r.diagnostics), ["MDT-E1609 at /uses/0"]);
    assert_eq!(
        r.diagnostics[0].message,
        "Module example.types is written in mandate/0.7, a newer language than this program's, mandate/0.6, which cannot read it. Import a version of it written in mandate/0.6 or earlier, or write the program in mandate/0.7 or later."
    );
    // 0.7 imports 0.6 and 0.7, and 0.6 imports 0.6: each checks.
    for (p, m) in [("0.7", "0.6"), ("0.7", "0.7"), ("0.6", "0.6")] {
        let r = checked(&importer(p), None, Some(&module_of(&types_module(m))));
        assert!(r.ok, "{p} importing {m}: {:#?}", errors(&r.diagnostics));
    }
    // 0.5 imports 0.7: E1603 as before 0.7.
    let r = checked(
        &importer("0.5")
            .replace("use example.types.{Note}", "use example.types")
            .replace("let N: Note = Note { text: \"a\" }", "let N: Int = 1"),
        None,
        Some(&module_of(&types_module("0.7"))),
    );
    assert_eq!(errors(&r.diagnostics)[0], "MDT-E1603 at /uses/0");
    assert!(facts(&r.diagnostics[0]).contains(r#""module_language":"mandate/0.7""#));
}

/// The library `example.notes`, written in `language`, with one module.
fn notes_library(language: &str) -> mandate_check::library::LibrarySource {
    mandate_check::library::LibrarySource {
        manifest: r#"{ "library": "mandate/library/0.6", "name": "example.notes", "version": "1.0.0", "modules": ["notes.mdt"] }"#.to_owned(),
        files: vec![(
            "notes.mdt".to_owned(),
            format!("mandate @ {language}\n\nmodule example.notes @ 1.0\n\npub type Note = {{ text: Text }}\n"),
        )],
    }
}

#[test]
fn a_library_of_a_newer_language_handed_in_or_pinned() {
    let program = |language: &str| {
        format!(
            "mandate @ {language}\n\nmodule example.importer @ 0.1\n\nuse example.notes.{{Note}}\n\nlet N: Note = Note {{ text: \"a\" }}\n"
        )
    };
    let libraries = [notes_library("0.7")];
    let with = |text: &str, lock: Option<&Value>| {
        check(
            text,
            SourceKind::Mdt,
            &CheckOptions {
                lock,
                libraries: Some(&libraries),
                ..CheckOptions::default()
            },
        )
    };
    // Handed in without a lock: the use.
    let r = with(&program("0.6"), None);
    assert_eq!(errors(&r.diagnostics), ["MDT-E1609 at /uses/0"]);
    // Pinned: the pin, and the use.
    let l = mandate_check::library::load_library(&libraries[0], false, "notes").unwrap();
    let pin = stringify(&JsValue::Object(l.pin().to_js())).unwrap();
    let lock = parse(&format!(
        r#"{{"lock":"mandate/lock/0.6","modules":{{}},"libraries":{{"example.notes":{pin}}}}}"#
    ))
    .unwrap()
    .value;
    let r = with(&program("0.6"), Some(&lock));
    assert_eq!(
        errors(&r.diagnostics),
        [
            "MDT-E1609 at /libraries/example.notes",
            "MDT-E1609 at /uses/0"
        ]
    );
    // A program of 0.7 reads it, with the lock and without.
    assert!(with(&program("0.7"), None).ok);
    assert!(with(&program("0.7"), Some(&lock)).ok);
}

fn now() -> Timestamp {
    Timestamp::parse("2026-11-17T00:00:00Z").unwrap()
}

/// `mandate add std.patterns[@range]` for a program of `language`, with
/// `lock`.
fn add_std(
    lock: &Value,
    range: Option<&str>,
    language: Option<Language>,
) -> mandate_check::library::ops::Outcome {
    add(&Request {
        library: "std.patterns",
        range,
        lock,
        versions: &[],
        libraries: &[],
        config: None,
        now: now(),
        language,
    })
}

#[test]
fn mandate_add_pins_the_newest_version_the_program_reads() {
    let empty = parse(r#"{"lock":"mandate/lock/0.6","modules":{}}"#)
        .unwrap()
        .value;
    let shown = |o: &mandate_check::library::ops::Outcome| {
        stringify(&JsValue::from(o.lock.as_ref().unwrap())).unwrap()
    };
    // A program of 0.6 (or one not named): 1.0.0, in a lock of 0.6, as
    // before 0.7.
    for language in [None, Some(Language::V0_6)] {
        let r = add_std(&empty, None, language);
        assert!(r.ok, "{:#?}", r.diagnostics);
        assert_eq!(
            shown(&r),
            format!(
                r#"{{"lock":"mandate/lock/0.6","modules":{{}},"libraries":{{"std.patterns":{{"version":"1.0.0","digest":"{DIGEST_1_0_0}","modules":{{"std.patterns":"{MODULE_1_0_0}"}}}}}}}}"#
            )
        );
    }
    // A program of 0.7: 2.0.0, in a lock of 0.7.
    let r = add_std(&empty, None, Some(Language::V0_7));
    assert!(r.ok, "{:#?}", r.diagnostics);
    assert_eq!(
        shown(&r),
        format!(
            r#"{{"lock":"mandate/lock/0.7","modules":{{}},"libraries":{{"std.patterns":{{"version":"2.0.0","digest":"{DIGEST_2_0_0}","modules":{{"std.patterns":"{MODULE_2_0_0}"}}}}}}}}"#
        )
    );
    // It may still pin 1.0.0, by its range.
    let r = add_std(&empty, Some("^1.0"), Some(Language::V0_7));
    assert_eq!(r.chosen.as_ref().unwrap().0.to_string(), "1.0.0");
    assert!(shown(&r).contains(r#""lock":"mandate/lock/0.7""#));
    // A program of 0.6 is offered nothing of 0.7.
    let r = add_std(&empty, Some("^2.0"), Some(Language::V0_6));
    assert!(!r.ok);
    assert_eq!(
        errors(&r.diagnostics),
        ["MDT-E1606 at /libraries/std.patterns"]
    );
    assert!(facts(&r.diagnostics[0]).contains("no_version"));
}

#[test]
fn upgrading_std_patterns_to_2_0_0_is_a_governance_change() {
    let lock = pinning(&read_json(BATCH_LOCK).unwrap(), "1.0.0", "mandate/lock/0.7");
    let request = Request {
        library: "std.patterns",
        range: None,
        lock: &lock,
        versions: &[],
        libraries: &[],
        config: None,
        now: now(),
        language: Some(Language::V0_7),
    };
    let held = upgrade(
        &request,
        &mandate_check::library::LibrarySource::default(),
        false,
    );
    assert!(held.ok, "{:#?}", held.diagnostics);
    assert!(
        held.lock.is_none(),
        "not written without --accept-governance"
    );
    let c = held.comparison.as_ref().unwrap();
    let kinds: Vec<(&str, &str)> = c
        .widenings
        .iter()
        .map(|w| (w.name.as_str(), w.what))
        .collect();
    println!("{kinds:#?}");
    assert!(kinds.contains(&("std.patterns.BatchWithExceptions", "report")));
    assert!(kinds.contains(&("std.patterns.BatchWithExceptions", "shape")));
    let accepted = upgrade(
        &request,
        &mandate_check::library::LibrarySource::default(),
        true,
    );
    let written = stringify(&JsValue::from(accepted.lock.as_ref().unwrap())).unwrap();
    assert!(written.contains(DIGEST_2_0_0));
}

// ---------------------------------------------------------------- a sub-program of a parent with a library

/// A parent of 0.7 whose envelope lists BatchWithExceptions, the
/// definitions of `batch.mdt` beside it.
fn parent_text() -> String {
    let batch = read_text(BATCH).unwrap();
    let defs = batch
        .split_once("/// Matches every invoice")
        .map(|(head, _)| head)
        .unwrap()
        .replacen(
            "module example.attention.batch @ 0.1",
            "module example.attention.shaped @ 0.1",
            1,
        );
    format!(
        "{defs}agent Lead {{\n  role   \"Plans what is left.\"\n  caps   ModelStd\n  budget {{ tokens: 5000, spend: 2 USD, steps: 20 }}\n  skill finish(n: Int) -> Inferred<Text> ! {{Model}}\n}}\n\nworkflow Run(n: Int) -> Inferred<Text>\n  envelope {{\n    owner   accountant\n    caps    Inbox, ErpRead, ErpDraft, ModelStd\n    budget  {{ tokens: 100000k, time: 6h, spend: 200 USD, steps: 2000, agents: 200 }}\n    spawn   {{ max_concurrent: 4, max_class: confidential }}\n    shapes  [BatchWithExceptions]\n  }}\n{{\n  plan Lead.finish(n) within envelope\n}}\n"
    )
}

/// The lead's sub-program: an application of BatchWithExceptions.
const SUB: &str = "workflow Invoices = BatchWithExceptions<Invoice, Match, DraftId>(\n    source: erp.list_invoices, work: Matcher.match, accepted: Matched,\n    reviewer: accountant, escalate_to: finance_lead,\n    commit: erp.post_draft, key: invoice_no,\n    max_items: 10, concurrency: 2, deadline: 1d)\n  caps   Inbox, ErpRead, ErpDraft, ModelStd\n  budget { tokens: 1000k, spend: 10 USD, time: 1h, steps: 100, agents: 20 }\n";

fn sub_ops() -> Vec<PatchOp> {
    let text = format!(
        "mandate @ 0.7\n\nmodule example.attention.shaped.plan_1 @ 0.1\n\nuse example.attention.shaped\n\n{SUB}"
    );
    let r = load(&text, SourceKind::Mdt);
    assert!(
        !mandate_ir::has_errors(&r.diagnostics),
        "{:?}",
        r.diagnostics
    );
    r.program
        .unwrap()
        .get("defs")
        .and_then(Value::as_object)
        .unwrap()
        .iter()
        .map(|(name, d)| PatchOp {
            op: "add".to_owned(),
            path: format!("/defs/{name}"),
            value: Some(d.clone()),
        })
        .collect()
}

fn room() -> Room {
    Room {
        left: vec![
            ("tokens".to_owned(), 50_000_000.0),
            ("steps".to_owned(), 1000.0),
            ("agents".to_owned(), 100.0),
            ("spend:USD".to_owned(), 100_000_000.0),
        ],
        time_left_ms: Some(18_000_000.0),
        writes: Vec::new(),
    }
}

/// The facts of a lead's sub-program whose parent's lock pins
/// std.patterns 2.0.0, asked of the door as the runtime asks it (slice B2,
/// `runtime/src/attention.ts`): the sub-program opened onto its parent, the
/// parent among the modules, and the claim of the envelope and the lead.
#[test]
fn the_facts_of_a_sub_program_of_a_parent_that_pins_2_0_0() {
    let text = parent_text();
    let mut lock = read_json(BATCH_LOCK).unwrap();
    if let Value::Object(m) = &mut lock
        && let Some(Value::Object(c)) = m.get_mut("connectors")
        && let Some(entry) = c.remove("example.attention.batch.erp")
    {
        c.insert("example.attention.shaped.erp", entry);
    }
    let parent_check = checked(&text, Some(&lock), None);
    assert!(parent_check.ok, "{:#?}", errors(&parent_check.diagnostics));
    let parent = parent_check.program.unwrap();
    let base = hash_program(&skeleton(
        "example.attention.shaped",
        1.0,
        mandate_check::language_of(&parent),
    ))
    .program;
    let ops = sub_ops();
    let room = room();
    let input = SubprogramInput {
        parent: &parent,
        modules: None,
        workflow: "Run",
        number: 1.0,
        base: &base,
        ops: &ops,
        lead: DataClass::Public,
        room: &room,
        std_patterns: None,
        role_classes: None,
    };
    let sub = check_subprogram(&input).unwrap();
    assert!(
        sub.ok,
        "{:#?}",
        sub.diagnostics
            .iter()
            .map(|d| (d.code.clone(), d.message.clone(), facts(d)))
            .collect::<Vec<_>>()
    );
    let workflow = sub.workflow.clone().unwrap();
    // The view the runtime builds: the sub-program, its `use` of the
    // parent naming every definition the parent has.
    let mut view = sub.program.clone().unwrap().as_object().cloned().unwrap();
    let mut uses: Vec<Value> = parent
        .get("uses")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .to_vec();
    let mut names: Vec<String> = parent
        .get("defs")
        .and_then(Value::as_object)
        .unwrap()
        .keys()
        .map(str::to_owned)
        .collect();
    names.sort();
    let mut u = Map::new();
    u.insert("module", "example.attention.shaped");
    u.insert(
        "names",
        Value::Array(names.into_iter().map(Value::from).collect()),
    );
    uses.push(Value::Object(u));
    view.insert("uses", Value::Array(uses));
    let view_text = canonicalize(&Value::Object(view));
    let mut modules = Modules::new();
    modules.insert("example.attention.shaped", parent.clone());
    let mut claim = Map::new();
    claim.insert(
        "envelope",
        parent
            .get("defs")
            .and_then(|d| d.get("Run"))
            .and_then(|w| w.get("envelope"))
            .cloned()
            .unwrap(),
    );
    claim.insert("lead", "public");
    let claim = Value::Object(claim);
    let f = attention_facts(
        &view_text,
        SourceKind::Json,
        &CheckOptions {
            modules: Some(&modules),
            claim: Some(&claim),
            ..CheckOptions::default()
        },
        &workflow,
    )
    .expect("the door gives the facts of the sub-program");
    let names: Vec<&str> = f.stages.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["collect", "work", "exceptions", "commit"]);
    let reports: Vec<(&str, &str)> = f
        .reports
        .iter()
        .map(|r| (r.role.as_str(), r.title.as_str()))
        .collect();
    assert_eq!(
        reports,
        [
            ("accountant", "Items collected"),
            ("accountant", "Batch done")
        ]
    );
    // The check of a sub-program is given no lock: it reads the version of
    // its parent's language (2.0.0 here, the version the parent pins), or
    // the one whose module it is handed as std.patterns. Handed 1.0.0's, the
    // version a parent of 0.7 whose lock pins 1.0.0 reads, it runs no stage,
    // and the door gives facts with none.
    let one = std_patterns_for(None, Some(&version("1.0.0"))).unwrap();
    let mut given = Modules::new();
    for (m, ir) in one.modules.iter() {
        given.insert(m, ir.clone());
    }
    let older = check_subprogram(&SubprogramInput {
        modules: Some(&given),
        ..input
    })
    .unwrap();
    assert!(older.ok, "{:#?}", errors(&older.diagnostics));
    let running = older.running.as_ref().unwrap();
    let body = running
        .get("defs")
        .and_then(|d| d.get(workflow.as_str()))
        .and_then(|w| w.get("body"))
        .and_then(Value::as_array)
        .unwrap();
    assert!(
        body.iter()
            .all(|s| s.get("op").and_then(Value::as_str) != Some("stage"))
    );
    modules.insert(
        "std.patterns",
        one.modules.get("std.patterns").unwrap().clone(),
    );
    let none = attention_facts(
        &view_text,
        SourceKind::Json,
        &CheckOptions {
            modules: Some(&modules),
            claim: Some(&claim),
            ..CheckOptions::default()
        },
        &workflow,
    )
    .expect("the facts");
    assert!(none.stages.is_empty() && none.reports.is_empty());
}

// ---------------------------------------------------------------- reports as governance

/// The library of a version directory of `conformance/L10/versions/`.
fn reports_library(version: &str) -> mandate_check::library::LibrarySource {
    let dir = format!("conformance/L10/versions/{version}");
    mandate_check::library::LibrarySource {
        manifest: read_text(&format!("{dir}/mandate.library.json")).unwrap(),
        files: vec![(
            "reports.mdt".to_owned(),
            read_text(&format!("{dir}/reports.mdt")).unwrap(),
        )],
    }
}

/// The authority signature of `library`, as JSON.
fn signature_of(library: &mandate_check::library::LibrarySource) -> String {
    let l = mandate_check::library::load_library(library, true, "the library").unwrap();
    let (sig, problems) = mandate_check::library::ops::signed_with(&l, &[]);
    assert!(problems.is_empty(), "{problems:#?}");
    stringify(&JsValue::Object(sig.to_js())).unwrap()
}

/// The signature of a library of 0.6 records no report, and is what it was
/// before 0.7: std.patterns 1.0.0's, byte for byte.
#[test]
fn the_signature_of_std_patterns_1_0_0_is_as_before() {
    assert_eq!(
        signature_of(&STD_PATTERNS_EMBEDDED[0].source()),
        r#"{"std.patterns.BatchWithExceptions":{"kind":"pattern","shape":"sha256:5fd7cf74323bc8e8f44a98d3b45af29bc47b1aaf7911e222b02ecf58fb995937"},"std.patterns.FanOutMerge":{"kind":"pattern","shape":"sha256:5faa1cdc1623b810a8d5b7e7551e8c333ad525f833e2bf4f12ce396e6f49ecab"},"std.patterns.MakerChecker":{"kind":"pattern","shape":"sha256:e0d3b2df9caa230194bf00f10b7620779990c5771eddf5b0b9c1c2d6e48f5ae5"}}"#
    );
}

/// The signature of 2.0.0 records the reports of each pattern, by role
/// slot, each field's class what the application binds.
#[test]
fn the_signature_of_std_patterns_2_0_0_records_its_reports() {
    assert_eq!(
        signature_of(&STD_PATTERNS_EMBEDDED[1].source()),
        r#"{"std.patterns.BatchWithExceptions":{"kind":"pattern","shape":"sha256:43987c714ee784490f13ae90db0e2235ae85de8f54aadf038e25494f6483df2a","reports":[{"role":"reviewer","title":"Items collected","class":"applied"},{"role":"reviewer","title":"Batch done","class":"applied"}]},"std.patterns.FanOutMerge":{"kind":"pattern","shape":"sha256:c00b2d49d8991c685f920b295481c1850a97f8e843e63b3ac1ca891dd94a9719","reports":[]},"std.patterns.MakerChecker":{"kind":"pattern","shape":"sha256:c9721e18396b5fa2213baae55a60bc138d770b9624fd40f1d8d20183ccec7417","reports":[]}}"#
    );
}

/// `kind at: text` of each governance change of the comparison of two
/// versions of acme.reports, then `behavior at: text` of each other one.
fn compared(from: &str, to: &str) -> Vec<String> {
    let load = |v: &str| {
        mandate_check::library::load_library(&reports_library(v), false, "acme.reports").unwrap()
    };
    let c = mandate_check::library::ops::compare(&load(from), &load(to), &[]);
    c.governance
        .iter()
        .map(|g| format!("{} {}: {}", g.kind, g.at, g.text))
        .chain(
            c.behavior
                .iter()
                .map(|b| format!("{} {}: {}", b.kind, b.at, b.text)),
        )
        .collect()
}

#[test]
fn a_report_added_or_raised_is_a_governance_change_and_one_removed_is_not() {
    let sig = signature_of(&reports_library("1.0.0"));
    assert!(
        sig.contains(r#""reports":[{"role":"clerk","title":"Counted","class":"internal"}]"#),
        "{sig}"
    );
    assert!(
        sig.contains(r#""reports":[{"role":"who","title":"Listed","class":"applied"}]"#),
        "{sig}"
    );
    // A report added: the signature widens, and so does the diff.
    assert_eq!(
        compared("1.0.0", "1.1.0"),
        [
            "widened acme.reports.Count: + acme.reports.Count: report \"Keys counted\" to clerk (shows confidential)",
            "report_widened acme.reports/defs/Count/body: + Count: report \"Keys counted\" to clerk (shows confidential)",
            "behavior acme.reports/defs/Count/body: ~ Count: the body changed, with the same steps",
        ]
    );
    // Its class risen.
    let raised = compared("1.0.0", "1.2.0");
    assert!(
        raised.contains(&"widened acme.reports.Count: ~ acme.reports.Count: report \"Counted\" to clerk shows internal → confidential".to_owned()),
        "{raised:#?}"
    );
    assert!(
        raised.contains(&"report_widened acme.reports/defs/Count/body: ~ Count: report \"Counted\" to clerk shows internal → confidential".to_owned()),
        "{raised:#?}"
    );
    // Taken away: no governance change.
    let removed = compared("1.0.0", "1.3.0");
    assert!(
        removed.iter().all(|c| c.starts_with("behavior ")),
        "{removed:#?}"
    );
    assert!(
        removed.contains(
            &"behavior acme.reports/defs/Count/body: - Count: report \"Counted\" to clerk removed"
                .to_owned()
        ),
        "{removed:#?}"
    );
    // A pattern's report to another role slot: another report, and another
    // shape.
    let moved = compared("1.0.0", "1.4.0");
    assert!(
        moved.contains(&"widened acme.reports.Tell: + acme.reports.Tell: report \"Listed\" to other (shows what the application binds)".to_owned()),
        "{moved:#?}"
    );
    assert!(
        moved.contains(
            &"widened acme.reports.Tell: ~ pattern acme.reports.Tell: another shape".to_owned()
        ),
        "{moved:#?}"
    );
    // The other way, each is a narrowing: nothing is a governance change of
    // reports.
    for v in ["1.1.0", "1.2.0"] {
        let back = compared(v, "1.0.0");
        assert!(
            back.iter()
                .all(|c| !c.contains("report \"") || c.starts_with("behavior ")),
            "{v}: {back:#?}"
        );
    }
}

// ---------------------------------------------------------------- the doors given no lock: `std_patterns`

/// The parent of the sub-program tests, checked with its lock pinning
/// `version` (in a lock of format 0.7), and that lock.
fn pinned_parent(version: &str) -> (Value, Value) {
    let mut lock = pinning(&read_json(BATCH_LOCK).unwrap(), version, "mandate/lock/0.7");
    if let Value::Object(m) = &mut lock
        && let Some(Value::Object(c)) = m.get_mut("connectors")
        && let Some(entry) = c.remove("example.attention.batch.erp")
    {
        c.insert("example.attention.shaped.erp", entry);
    }
    let r = checked(&parent_text(), Some(&lock), None);
    assert!(r.ok, "{version}: {:#?}", errors(&r.diagnostics));
    (r.program.unwrap(), lock)
}

/// A door's input as JSON.
fn input_of(text: &str) -> Value {
    parse(text).unwrap().value
}

/// The input of the door `check_subprogram` for the parent of
/// [`pinned_parent`], with `pin` as `i.std_patterns` when given.
fn subprogram_door_input(parent: &Value, pin: Option<&str>) -> Value {
    let base = hash_program(&skeleton(
        "example.attention.shaped",
        1.0,
        mandate_check::language_of(parent),
    ))
    .program;
    let ops: Vec<JsValue> = sub_ops()
        .iter()
        .map(|o| {
            mandate_ir::JsObject::new()
                .with("op", o.op.as_str())
                .with("path", o.path.as_str())
                .with("value", JsValue::from(o.value.as_ref().unwrap()))
                .into()
        })
        .collect();
    let mut i = mandate_ir::JsObject::new()
        .with("parent", JsValue::from(parent))
        .with("workflow", "Run")
        .with("number", 1)
        .with("base", base.as_str())
        .with("ops", ops)
        .with("lead", "public")
        .with(
            "room",
            JsValue::from(&input_of(
                r#"{"left":{"tokens":50000000,"steps":1000,"agents":100,"spend:USD":100000000},"time_left_ms":18000000,"writes":[]}"#,
            )),
        );
    if let Some(p) = pin {
        i.insert("std_patterns", p);
    }
    input_of(&stringify(&JsValue::Object(mandate_ir::JsObject::new().with("i", i))).unwrap())
}

/// The ops of the running program of a door's answer that are stages or
/// reports.
fn attention_ops(running: Option<&JsValue>) -> Vec<String> {
    let text = running.map(|r| stringify(r).unwrap()).unwrap_or_default();
    let v = input_of(&text);
    let mut out = Vec::new();
    for (_, d) in v.get("defs").and_then(Value::as_object).unwrap().iter() {
        for s in d.get("body").and_then(Value::as_array).unwrap_or_default() {
            if let Some(op) = s
                .get("op")
                .and_then(Value::as_str)
                .filter(|o| matches!(*o, "stage" | "report"))
            {
                out.push(op.to_owned());
            }
        }
    }
    out
}

/// A parent of 0.7 whose lock pins 1.0.0: the doors given no lock read the
/// version `std_patterns` names (no stage, no report), and without it the
/// version of the parent's language (2.0.0, as before).
#[test]
fn a_sub_program_of_a_parent_that_pins_1_0_0_reads_1_0_0_when_it_is_named() {
    let (parent, _) = pinned_parent("1.0.0");
    let door = mandate_check::json_doors::door("check_subprogram").unwrap();
    let with = (door.call)(&subprogram_door_input(&parent, Some("1.0.0"))).unwrap();
    assert_eq!(with.get("ok"), Some(&JsValue::Bool(true)), "{with:?}");
    assert!(attention_ops(with.get("running")).is_empty());
    // Without it, 2.0.0: the workflow's expansion and the pattern it holds.
    let without = (door.call)(&subprogram_door_input(&parent, None)).unwrap();
    assert_eq!(
        attention_ops(without.get("running")),
        ["stage", "report", "stage", "stage", "stage", "report"].repeat(2),
    );
    // The facts of the sub-program, as the runtime asks them, with the pin.
    let sub = with.get("program").unwrap();
    let workflow = with.get("workflow").and_then(JsValue::as_str).unwrap();
    let mut view = input_of(&stringify(sub).unwrap())
        .as_object()
        .cloned()
        .unwrap();
    let mut uses: Vec<Value> = parent
        .get("uses")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .to_vec();
    let mut names: Vec<String> = parent
        .get("defs")
        .and_then(Value::as_object)
        .unwrap()
        .keys()
        .map(str::to_owned)
        .collect();
    names.sort();
    let mut u = Map::new();
    u.insert("module", "example.attention.shaped");
    u.insert(
        "names",
        Value::Array(names.into_iter().map(Value::from).collect()),
    );
    uses.push(Value::Object(u));
    view.insert("uses", Value::Array(uses));
    let envelope = parent
        .get("defs")
        .and_then(|d| d.get("Run"))
        .and_then(|w| w.get("envelope"))
        .unwrap();
    let facts_input = |pin: Option<&str>, lock: Option<&Value>| {
        let mut opts = mandate_ir::JsObject::new()
            .with(
                "modules",
                mandate_ir::JsObject::new()
                    .with("example.attention.shaped", JsValue::from(&parent)),
            )
            .with(
                "claim",
                mandate_ir::JsObject::new()
                    .with("envelope", JsValue::from(envelope))
                    .with("lead", "public"),
            );
        if let Some(p) = pin {
            opts.insert("std_patterns", p);
        }
        if let Some(l) = lock {
            opts.insert("lock", JsValue::from(l));
        }
        input_of(
            &stringify(&JsValue::Object(
                mandate_ir::JsObject::new()
                    .with("text", canonicalize(&Value::Object(view.clone())))
                    .with("kind", "json")
                    .with("opts", opts)
                    .with("workflow", workflow),
            ))
            .unwrap(),
        )
    };
    let facts = mandate_check::json_doors::library_door("attention_facts").unwrap();
    let one = (facts.call)(&facts_input(Some("1.0.0"), None)).unwrap();
    let count = |f: &JsValue, k: &str| f.get(k).and_then(JsValue::as_array).map(<[JsValue]>::len);
    assert_eq!(
        (count(&one, "stages"), count(&one, "reports")),
        (Some(0), Some(0))
    );
    let two = (facts.call)(&facts_input(None, None)).unwrap();
    assert_eq!(
        (count(&two, "stages"), count(&two, "reports")),
        (Some(4), Some(2))
    );
    // A lock given with it must pin the version named.
    let (_, lock_two) = pinned_parent("2.0.0");
    let e = (facts.call)(&facts_input(Some("1.0.0"), Some(&lock_two))).unwrap_err();
    assert_eq!(
        e.message,
        "`opts.std_patterns`: the lock pins std.patterns 2.0.0, and std_patterns names 1.0.0: give the one the lock pins, or none"
    );
    // subprogram_linked: the definitions it links are 1.0.0's.
    let linked = mandate_check::json_doors::door("subprogram_linked").unwrap();
    let li = |pin: Option<&str>| {
        let mut o = mandate_ir::JsObject::new()
            .with("sub", JsValue::from(&input_of(&stringify(sub).unwrap())))
            .with("parent", JsValue::from(&parent));
        if let Some(p) = pin {
            o.insert("std_patterns", p);
        }
        input_of(&stringify(&JsValue::Object(o)).unwrap())
    };
    let body_of = |v: &JsValue| {
        let v = input_of(&stringify(v).unwrap());
        canonicalize(
            v.get("defs")
                .and_then(|d| d.get("BatchWithExceptions"))
                .and_then(|p| p.get("body"))
                .unwrap(),
        )
    };
    let l1 = (linked.call)(&li(Some("1.0.0"))).unwrap();
    let l2 = (linked.call)(&li(None)).unwrap();
    assert!(!body_of(&l1).contains("\"stage\""));
    assert!(body_of(&l2).contains("\"stage\""));
}

#[test]
fn a_pin_the_compiler_does_not_embed_is_refused_by_every_door_that_takes_one() {
    let (parent, _) = pinned_parent("1.0.0");
    let door = mandate_check::json_doors::door("check_subprogram").unwrap();
    for (pin, said) in [
        ("3.0.0", "\"3.0.0\""),
        ("1.0", "\"1.0\""),
        ("latest", "\"latest\""),
    ] {
        let e = (door.call)(&subprogram_door_input(&parent, Some(pin))).unwrap_err();
        assert_eq!(e.kind.as_str(), "bad_input");
        assert_eq!(
            e.message,
            format!(
                "`i.std_patterns`: {said} is not a version of std.patterns this compiler embeds (1.0.0, 2.0.0): a pin of std.patterns is one of them"
            )
        );
    }
    // Not a string at all.
    let mut bad = subprogram_door_input(&parent, None);
    if let Value::Object(m) = &mut bad
        && let Some(Value::Object(i)) = m.get_mut("i")
    {
        i.insert("std_patterns", Value::Bool(true));
    }
    assert!((door.call)(&bad).is_err());
    // The amendment's door and subprogram_linked refuse it as well.
    let amend = mandate_check::json_doors::door("check_amendment").unwrap();
    let input = input_of(&format!(
        r#"{{"i":{{"parent":{},"workflow":"Run","envelope":{{}},"std_patterns":"9.9.9"}}}}"#,
        stringify(&JsValue::from(&parent)).unwrap()
    ));
    let e = (amend.call)(&input).unwrap_err();
    assert!(
        e.message
            .starts_with("`i.std_patterns`: \"9.9.9\" is not a version"),
        "{}",
        e.message
    );
    let linked = mandate_check::json_doors::door("subprogram_linked").unwrap();
    let input = input_of(&format!(
        r#"{{"sub":{p},"parent":{p},"std_patterns":"2"}}"#,
        p = stringify(&JsValue::from(&parent)).unwrap()
    ));
    assert!(
        (linked.call)(&input)
            .unwrap_err()
            .message
            .starts_with("`std_patterns`: \"2\"")
    );
}

/// The admission of the lead's sub-program of a parent that pins 2.0.0 is
/// held to the classes of the parent's lock when its caller passes them
/// (RL5b, spec/attention.md "What a sub-program may show"): the pattern's
/// review, its escalation and its reports show the accountant and the
/// finance lead confidential invoices, which the lock lets them see and
/// `{}` (every role `internal`) does not. Without them, no E1909, as before.
#[test]
fn a_sub_program_is_held_to_the_role_classes_its_caller_passes() {
    let text = parent_text();
    let mut lock = read_json(BATCH_LOCK).unwrap();
    if let Value::Object(m) = &mut lock
        && let Some(Value::Object(c)) = m.get_mut("connectors")
        && let Some(entry) = c.remove("example.attention.batch.erp")
    {
        c.insert("example.attention.shaped.erp", entry);
    }
    let parent_check = checked(&text, Some(&lock), None);
    assert!(parent_check.ok, "{:#?}", errors(&parent_check.diagnostics));
    let parent = parent_check.program.unwrap();
    let base = hash_program(&skeleton(
        "example.attention.shaped",
        1.0,
        mandate_check::language_of(&parent),
    ))
    .program;
    let ops = sub_ops();
    let room = room();
    let none = Value::Object(Map::new());
    let admit = |role_classes: Option<&Value>| {
        check_subprogram(&SubprogramInput {
            parent: &parent,
            modules: None,
            workflow: "Run",
            number: 1.0,
            base: &base,
            ops: &ops,
            lead: DataClass::Public,
            room: &room,
            std_patterns: None,
            role_classes,
        })
        .unwrap()
    };
    for given in [None, lock.get("role_classes")] {
        let sub = admit(given);
        assert!(sub.ok, "{:#?}", errors(&sub.diagnostics));
    }
    let sub = admit(Some(&none));
    assert!(!sub.ok);
    let got: Vec<String> = sub
        .diagnostics
        .iter()
        .map(|d| {
            format!(
                "{} at {}: {}",
                d.code,
                d.at.path.as_deref().unwrap_or(""),
                facts(d)
            )
        })
        .collect();
    assert!(
        got.iter()
            .all(|d| d.starts_with("MDT-E1909 at /defs/Invoices")
                && d.contains(r#""class":"internal""#)
                && d.contains(r#""shown":"confidential""#)),
        "{got:#?}"
    );
    for site in ["review", "report"] {
        let want = format!(r#""site":"{site}""#);
        assert!(
            got.iter().any(|d| d.contains(want.as_str())),
            "{site}: {got:#?}"
        );
    }
    assert!(
        got.iter().any(|d| d.contains(r#""role":"finance_lead""#)),
        "{got:#?}"
    );
}
