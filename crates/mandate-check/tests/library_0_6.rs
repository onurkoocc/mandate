//! Libraries (language 0.6, spec/library.md "Libraries" and "std.patterns"),
//! where a conformance case cannot say it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::library::ops::{Outcome, Published, Request, add, publish, upgrade};
use mandate_check::library::{LibrarySource, load_library};
use mandate_check::{CheckOptions, CheckResult, ModuleSource, Modules, check, load_modules};
use mandate_ir::Value;
use mandate_lib::Timestamp;
use mandate_syntax::SourceKind;
use mandate_testkit::{read_json, read_text};

/// `code at path: message` of each diagnostic but W0601.
fn shown(r: &CheckResult) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d.code != "MDT-W0601")
        .map(|d| {
            format!(
                "{} at {}: {}",
                d.code,
                d.at.path.as_deref().unwrap_or(""),
                d.message
            )
        })
        .collect()
}

fn std_patterns_as_module() -> Modules {
    let text = read_text("lib/std.patterns/patterns.mdt").unwrap();
    let sources = [ModuleSource {
        text: &text,
        kind: SourceKind::Mdt,
        file: "patterns.mdt",
    }];
    let r = load_modules(&sources);
    assert!(r.problems.is_empty(), "{:#?}", r.problems);
    r.modules
}

fn checked(text: &str, modules: Option<&Modules>) -> CheckResult {
    check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            modules,
            ..CheckOptions::default()
        },
    )
}

/// A program that applies `FanOutMerge`: each repository migrated by an
/// agent that may write only its own root, then one summary.
const FAN: &str = r#"mandate @ 0.6

module example.fan @ 0.1

use std.{fs, model}
use std.patterns.{FanOutMerge}

type Repo    = { name: Text, root: Path }
type Summary = { moved: Int }

capability RepoRead = fs.read("/work/repos")
capability SrcWrite = fs.write("/work/repos")
capability ModelStd = model.infer(tier: standard)

agent Migrator {
  role   "Moves one repository."
  caps   RepoRead, SrcWrite, ModelStd
  budget { tokens: 40k, spend: 0.5 USD, steps: 12 }
  skill migrate(repo: Repo) -> Inferred<Summary> ! {Fs.Read, Fs.Write, Model}
}

agent Reporter {
  role   "Sums up what was moved."
  caps   ModelStd
  budget { tokens: 20k, spend: 0.2 USD, steps: 4 }
  skill sum(done: List<Outcome<Inferred<Summary>>>) -> Inferred<Summary> ! {Model}
}

/// Migrates every repository, eight at a time, then sums up.
workflow MigrateAll = FanOutMerge<Repo, Summary, Summary>(
    work: Migrator.migrate, scope: SrcWrite, part: root,
    merge: Reporter.sum, max_items: 40, concurrency: 8)
  caps   RepoRead, SrcWrite, ModelStd
  budget { tokens: 2000k, spend: 25 USD, steps: 600, time: 2h }
"#;

/// A program that applies `MakerChecker`: one agent drafts, a reader looks
/// for what is wrong, and the contract decides.
const MAKER: &str = r#"mandate @ 0.6

module example.maker @ 0.1

use std.{fs, model}
use std.patterns.{MakerChecker}

role editor "Editor"

type Brief = { topic: Text }
type Draft = { title: Text, words: Int }

capability Notes    = fs.read("/work/notes")
capability Out      = fs.write("/work/out")
capability ModelStd = model.infer(tier: standard)

agent Writer {
  role   "Drafts a text."
  caps   Notes, Out, ModelStd
  budget { tokens: 40k, spend: 0.4 USD, steps: 8 }
  skill draft(b: Brief) -> Inferred<Draft> ! {Fs.Read, Fs.Write, Model}
}

agent Reader {
  role   "Looks for what is wrong with a draft. Writes nothing."
  caps   Notes, ModelStd
  budget { tokens: 20k, spend: 0.2 USD, steps: 4 }
  skill review(b: Brief, d: Inferred<Draft>) -> Inferred<Draft> ! {Fs.Read, Model}
}

contract Short(b: Brief, d: Draft) {
  accept short "The draft is at most 800 words"
    by static d.words <= 800
}

/// Drafts one text and has it checked.
workflow Write = MakerChecker<Brief, Draft>(
    make: Writer.draft, check: Reader.review, accepted: Short, owner: editor)
  caps   Notes, Out, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 20, time: 30m }
"#;

/// The library in the repository directory `dir`.
fn library(dir: &str) -> LibrarySource {
    let (manifest, files) = mandate_testkit::library_files(dir).unwrap();
    LibrarySource { manifest, files }
}

#[test]
fn the_lock_of_the_acceptance_program_pins_what_the_libraries_are() {
    let lock = read_json("fixtures/library/invoices.lock.json").unwrap();
    for l in [
        mandate_check::library::std_patterns().unwrap(),
        load_library(&library("fixtures/library/acme.connectors"), false, "x").unwrap(),
    ] {
        let pin = mandate_ir::stringify(&mandate_ir::JsValue::Object(l.pin().to_js())).unwrap();
        let locked = lock.get("libraries").and_then(|x| x.get(l.name())).unwrap();
        assert_eq!(
            mandate_ir::canonicalize(&mandate_ir::parse(&pin).unwrap().value),
            mandate_ir::canonicalize(locked),
            "{}: the pin is {pin}",
            l.name()
        );
    }
}

#[test]
fn std_patterns_checks_as_a_module_and_each_pattern_applies() {
    let pat = read_text("lib/std.patterns/patterns.mdt").unwrap();
    let alone = checked(&pat, None);
    assert!(alone.ok, "{:#?}", shown(&alone));
    let modules = std_patterns_as_module();
    for (name, text) in [("FanOutMerge", FAN), ("MakerChecker", MAKER)] {
        let r = checked(text, Some(&modules));
        assert!(r.ok, "{name}: {:#?}", shown(&r));
        assert!(r.expanded.is_some(), "{name}");
    }
}

const INVOICES: &str = "fixtures/library/invoices.mdt";
const ACME: &str = "fixtures/library/acme.connectors";

/// `check` of `text` with the libraries and the lock given.
fn with_libraries(text: &str, libraries: &[LibrarySource], lock: Option<&Value>) -> CheckResult {
    check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            lock,
            libraries: Some(libraries),
            ..CheckOptions::default()
        },
    )
}

#[test]
fn the_acceptance_program_checks_with_its_library_and_its_lock() {
    let text = read_text(INVOICES).unwrap();
    assert!(text.lines().count() < 50, "{} lines", text.lines().count());
    let lock = read_json("fixtures/library/invoices.lock.json").unwrap();
    let libs = [library(ACME)];
    let r = with_libraries(&text, &libs, Some(&lock));
    assert!(r.ok, "{:#?}", shown(&r));
    assert!(r.expanded.is_some());
    let plain = with_libraries(&text, &libs, None);
    assert!(plain.ok, "{:#?}", shown(&plain));
}

const OPS: &str = "fixtures/library/upgrade/acme.ops";

/// The version directory `version` of acme.ops.
fn published(version: &str) -> Published {
    let dir = format!("{OPS}/{version}");
    Published {
        version: version.to_owned(),
        source: library(&dir),
        index: read_text(&format!("{dir}/index.json")).ok(),
    }
}

/// `source` with its manifest's version written as `version`.
fn as_version(source: &LibrarySource, version: &str) -> LibrarySource {
    let mut s = source.clone();
    let start = s.manifest.find("\"version\": \"").unwrap() + "\"version\": \"".len();
    let end = start + s.manifest[start..].find('"').unwrap();
    s.manifest.replace_range(start..end, version);
    s
}

fn every_version() -> Vec<Published> {
    ["1.0.0", "1.0.1", "1.1.0", "1.2.0", "2.0.0"]
        .iter()
        .map(|v| published(v))
        .collect()
}

/// A lock that pins acme.ops at 1.0.0.
fn ops_lock() -> Value {
    let base = load_library(&published("1.0.0").source, false, "x").unwrap();
    let pin = mandate_ir::stringify(&mandate_ir::JsValue::Object(base.pin().to_js())).unwrap();
    mandate_ir::parse(&format!(
        r#"{{"lock":"mandate/lock/0.6","modules":{{}},"libraries":{{"acme.ops":{pin}}}}}"#
    ))
    .unwrap()
    .value
}

fn now(text: &str) -> Timestamp {
    Timestamp::parse(text).unwrap()
}

fn request<'a>(
    range: Option<&'a str>,
    lock: &'a Value,
    versions: &'a [Published],
    config: Option<&'a mandate_lib::LibrariesConfig>,
    at: Timestamp,
) -> Request<'a> {
    Request {
        library: "acme.ops",
        range,
        lock,
        versions,
        libraries: &[],
        config,
        now: at,
    }
}

fn codes(diagnostics: &[mandate_ir::Diagnostic]) -> Vec<String> {
    diagnostics
        .iter()
        .filter(|d| d.severity == mandate_ir::Severity::Error)
        .map(|d| d.code.clone())
        .collect()
}

fn kinds(o: &Outcome) -> Vec<String> {
    o.comparison
        .as_ref()
        .map(|c| {
            c.governance
                .iter()
                .map(|g| format!("{} {}", g.kind, g.text))
                .collect()
        })
        .unwrap_or_default()
}

/// The upgrade of acme.ops from 1.0.0: a doc line upgrades silently; a
/// raised budget of a workflow and a raised class of a connector are
/// governance changes, and no lock is given back without
/// `accept_governance`.
#[test]
fn an_upgrade_that_widens_the_signature_writes_no_lock_without_acceptance() {
    let lock = ops_lock();
    let versions = every_version();
    let pinned = published("1.0.0").source;
    let at = now("2026-11-15T00:00:00Z");
    // (c) A doc line: no governance change, the lock with the new pin.
    let doc = upgrade(
        &request(Some("1.0.1"), &lock, &versions, None, at),
        &pinned,
        false,
    );
    assert!(doc.ok, "{:#?}", doc.diagnostics);
    assert_eq!(kinds(&doc), Vec::<String>::new());
    let written = doc.lock.as_ref().expect("a lock");
    assert_eq!(
        written
            .get("libraries")
            .and_then(|l| l.get("acme.ops"))
            .and_then(|p| p.get("version"))
            .and_then(Value::as_str),
        Some("1.0.1")
    );
    // (a) A workflow's budget raised.
    let budget = upgrade(
        &request(Some("1.1.0"), &lock, &versions, None, at),
        &pinned,
        false,
    );
    assert!(budget.ok, "{:#?}", budget.diagnostics);
    assert!(budget.lock.is_none());
    let k = kinds(&budget);
    assert!(
        k.iter()
            .any(|g| g.starts_with("widened ~ acme.ops.Inventory.budget.time")),
        "{k:#?}"
    );
    assert!(
        k.iter().any(|g| g.starts_with("budget_increased")),
        "{k:#?}"
    );
    let accepted = upgrade(
        &request(Some("1.1.0"), &lock, &versions, None, at),
        &pinned,
        true,
    );
    assert!(accepted.lock.is_some());
    // (b) A connector's class raised.
    let class = upgrade(
        &request(Some("1.2.0"), &lock, &versions, None, at),
        &pinned,
        false,
    );
    assert!(class.lock.is_none());
    let k = kinds(&class);
    assert!(
        k.iter()
            .any(|g| g == "widened ~ connector acme.ops.store.class: internal → confidential"),
        "{k:#?}"
    );
}

/// Publish's version rule over acme.ops, with 1.0.0 published.
#[test]
fn a_minor_version_that_widens_is_refused_and_a_major_one_is_not() {
    let base = [published("1.0.0")];
    let at = now("2026-11-15T00:00:00Z");
    let of = |v: &str| publish(&published(v).source, &base, &[], at);
    let doc = of("1.0.1");
    assert!(doc.ok, "{:#?}", doc.diagnostics);
    assert_eq!(
        doc.index.as_deref(),
        Some("{ \"published_at\": \"2026-11-15T00:00:00Z\" }\n")
    );
    for v in ["1.1.0", "1.2.0"] {
        let r = of(v);
        assert_eq!(codes(&r.diagnostics), ["MDT-E1607"], "{v}");
        let facts = r.diagnostics[0].facts.as_ref().unwrap();
        assert_eq!(
            facts.get("problem").and_then(mandate_ir::JsValue::as_str),
            Some("needs_major")
        );
    }
    let major = of("2.0.0");
    assert!(major.ok, "{:#?}", major.diagnostics);
    // Already published.
    let again = publish(&published("1.0.0").source, &base, &[], at);
    assert_eq!(codes(&again.diagnostics), ["MDT-E1607"]);
}

/// A version published below the lowest version above it within its MAJOR
/// may not make that one a widening against it: 1.0.0 and 1.1.0 both have
/// the raised budget, and 1.0.5 with the old one would be widened by 1.1.0.
#[test]
fn a_version_published_in_between_is_held_to_the_version_above() {
    let wide = published("1.1.0").source;
    let list = [
        Published {
            version: "1.0.0".to_owned(),
            source: as_version(&wide, "1.0.0"),
            index: Some("{ \"published_at\": \"2026-11-01T09:00:00Z\" }".to_owned()),
        },
        published("1.1.0"),
    ];
    let narrow = as_version(&published("1.0.0").source, "1.0.5");
    let r = publish(&narrow, &list, &[], now("2026-11-15T00:00:00Z"));
    assert_eq!(codes(&r.diagnostics), ["MDT-E1607"], "{:#?}", r.diagnostics);
    let facts = r.diagnostics[0].facts.as_ref().unwrap();
    assert_eq!(
        facts.get("problem").and_then(mandate_ir::JsValue::as_str),
        Some("next_needs_major")
    );
    // The same narrower version as 1.2.0's neighbour of another MAJOR: not held.
    let other = [published("2.0.0")];
    let fine = publish(&narrow, &other, &[], now("2026-11-15T00:00:00Z"));
    assert!(fine.ok, "{:#?}", fine.diagnostics);
}

/// `add`: the highest version within the range whose waiting period is
/// over and whose digest is not revoked; a range nothing meets is E1606,
/// and one whose versions all wait or are revoked is E1608.
#[test]
fn add_resolves_the_highest_eligible_version() {
    let empty: Value = mandate_ir::parse(r#"{"lock":"mandate/lock/0.6","modules":{}}"#)
        .unwrap()
        .value;
    let versions = every_version();
    let config = |wait: u32, revoked: &[&str]| {
        let text = format!(
            r#"{{"dir":"libs","wait_days":{wait},"revoked":[{}]}}"#,
            revoked
                .iter()
                .map(|r| format!("\"{r}\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        mandate_lib::read_libraries_config(&mandate_ir::parse(&text).unwrap().value).unwrap()
    };
    let at = now("2026-11-13T12:00:00Z");
    let none = config(0, &[]);
    let r = add(&request(Some("^1.0"), &empty, &versions, Some(&none), at));
    assert!(r.ok, "{:#?}", r.diagnostics);
    assert_eq!(r.chosen.as_ref().unwrap().0.to_string(), "1.2.0");
    // Two days' wait: 1.2.0, published on the 12th, waits; 1.1.0 is taken.
    let two = config(2, &[]);
    let r = add(&request(Some("^1.0"), &empty, &versions, Some(&two), at));
    assert_eq!(r.chosen.as_ref().unwrap().0.to_string(), "1.1.0");
    // 1.1.0 revoked as well: 1.0.1.
    let digest = load_library(&published("1.1.0").source, false, "x")
        .unwrap()
        .digest;
    let revoked = config(2, &[digest.as_str()]);
    let r = add(&request(
        Some("^1.0"),
        &empty,
        &versions,
        Some(&revoked),
        at,
    ));
    assert_eq!(r.chosen.as_ref().unwrap().0.to_string(), "1.0.1");
    // Exactly 1.2.0, which waits: E1608 naming the day.
    let r = add(&request(Some("1.2.0"), &empty, &versions, Some(&two), at));
    assert_eq!(codes(&r.diagnostics), ["MDT-E1608"]);
    assert!(
        r.diagnostics[0].message.contains("2026-11-14"),
        "{}",
        r.diagnostics[0].message
    );
    assert!(r.lock.is_none());
    // Exactly 1.1.0, revoked: E1608.
    let r = add(&request(
        Some("1.1.0"),
        &empty,
        &versions,
        Some(&revoked),
        at,
    ));
    assert_eq!(codes(&r.diagnostics), ["MDT-E1608"]);
    // Nothing within ^3: E1606.
    let r = add(&request(Some("^3"), &empty, &versions, Some(&none), at));
    assert_eq!(codes(&r.diagnostics), ["MDT-E1606"]);
    // A directory without index.json was never published.
    let mut unfinished = every_version();
    unfinished[4].index = None;
    let r = add(&request(None, &empty, &unfinished, Some(&none), at));
    assert_eq!(r.chosen.as_ref().unwrap().0.to_string(), "1.2.0");
    assert_eq!(
        r.resolution
            .get("unpublished")
            .and_then(mandate_ir::JsValue::as_array)
            .map(<[mandate_ir::JsValue]>::len),
        Some(1)
    );
    // The built-in std.patterns: its own copy, pinned by its digest.
    let r = add(&Request {
        library: "std.patterns",
        ..request(None, &empty, &[], Some(&two), at)
    });
    assert!(r.ok, "{:#?}", r.diagnostics);
    let digest = mandate_check::library::std_patterns_digest().unwrap();
    assert_eq!(r.chosen.as_ref().unwrap().1, digest.as_str());
}
