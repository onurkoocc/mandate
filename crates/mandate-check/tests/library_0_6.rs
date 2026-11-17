//! Libraries (language 0.6, spec/library.md "Libraries" and "std.patterns"),
//! where a conformance case cannot say it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
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
    items: [Repo { name: "api", root: "api" }, Repo { name: "web", root: "web" }],
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
    input: Brief { topic: "the release" },
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
/// The lock of the acceptance program pins what its libraries are, and so
/// does the lock of L01, which is that lock with one digit of the digest of
/// acme.connectors changed. Written from what the compiler computes: a
/// normal run compares, `MANDATE_UPDATE_0_6=1` writes both again (after
/// std.patterns changes, its digest does).
fn the_lock_of_the_acceptance_program_pins_what_the_libraries_are() {
    let mut lock = read_json("fixtures/library/invoices.lock.json").unwrap();
    for l in [
        mandate_check::library::std_patterns().unwrap(),
        load_library(&library("fixtures/library/acme.connectors"), false, "x").unwrap(),
    ] {
        let pin = mandate_ir::stringify(&mandate_ir::JsValue::Object(l.pin().to_js())).unwrap();
        let pin = mandate_ir::parse(&pin).unwrap().value;
        if let Value::Object(m) = &mut lock
            && let Some(Value::Object(libs)) = m.get_mut("libraries")
        {
            libs.insert(l.name(), pin);
        }
    }
    let text = |v: &Value| {
        let mut t = mandate_ir::stringify_pretty(&mandate_ir::JsValue::from(v)).unwrap();
        t.push('\n');
        t
    };
    let mut problems = Vec::new();
    match mandate_testkit::rust_vectors::pin("fixtures/library/invoices.lock.json", &text(&lock)) {
        Ok(line) => println!("{line}"),
        Err(e) => problems.push(e),
    }
    // L01: the digest of acme.connectors with its last digit changed.
    let mut l01 = lock.clone();
    if let Value::Object(m) = &mut l01
        && let Some(Value::Object(libs)) = m.get_mut("libraries")
        && let Some(Value::Object(acme)) = libs.get_mut("acme.connectors")
        && let Some(Value::String(d)) = acme.get_mut("digest")
    {
        let last = if d.ends_with('0') { '1' } else { '0' };
        d.pop();
        d.push(last);
    }
    match mandate_testkit::rust_vectors::pin("conformance/L01/mandate.lock.json", &text(&l01)) {
        Ok(line) => println!("{line}"),
        Err(e) => problems.push(e),
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
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

/// A `const` slot of a record type takes a named constant of that type as
/// well as a record literal; a record of another type, a literal of another
/// type, and a name that is no constant are E1305 at the argument.
#[test]
fn a_value_slot_takes_a_constant_of_its_type_and_nothing_else() {
    let modules = std_patterns_as_module();
    let named = MAKER
        .replace(
            "capability Notes",
            "let TheBrief: Brief = Brief { topic: \"the release\" }\n\ncapability Notes",
        )
        .replace("input: Brief { topic: \"the release\" }", "input: TheBrief");
    let r = checked(&named, Some(&modules));
    assert!(r.ok, "{:#?}", shown(&r));
    let expanded = mandate_ir::canonicalize(r.expanded.as_ref().unwrap());
    assert!(expanded.contains("TheBrief"), "{expanded}");
    for wrong in [
        "Draft { title: \"x\", words: 1 }",
        "Brief { topic: 1 }",
        "Brief { topic: \"x\", extra: 1 }",
        "\"a brief\"",
        "editor",
        "Writer",
        // A record of another type with the same fields.
        "Memo { topic: \"x\" }",
    ] {
        let text = MAKER
            .replace("type Draft", "type Memo  = { topic: Text }\ntype Draft")
            .replace(
                "input: Brief { topic: \"the release\" }",
                &format!("input: {wrong}"),
            );
        let r = checked(&text, Some(&modules));
        let codes: Vec<(&str, &str)> = r
            .diagnostics
            .iter()
            .filter(|d| d.severity == mandate_ir::Severity::Error)
            .map(|d| (d.code.as_str(), d.at.path.as_deref().unwrap_or("")))
            .collect();
        assert_eq!(
            codes,
            [("MDT-E1305", "/defs/Write/apply/args/0/value")],
            "{wrong}: {:#?}",
            shown(&r)
        );
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
    // Every diagnostic it has is a warning.
    assert!(r.diagnostics.iter().all(|d| d.code.starts_with("MDT-W")));
}

/// The pins against what is handed in: std.patterns imported and not
/// pinned, a pinned library not handed in, a library handed in and not
/// pinned (E1605 each), and a library that is not given at all (E1604).
#[test]
fn what_the_lock_pins_is_what_the_check_is_handed() {
    let text = read_text(INVOICES).unwrap();
    let lock = read_json("fixtures/library/invoices.lock.json").unwrap();
    let without = |name: &str| {
        let mut l = lock.clone();
        if let Value::Object(m) = &mut l
            && let Some(Value::Object(libs)) = m.get_mut("libraries")
        {
            libs.remove(name);
        }
        l
    };
    let found = |r: &CheckResult| -> Vec<String> {
        r.diagnostics
            .iter()
            .filter(|d| d.severity == mandate_ir::Severity::Error)
            .map(|d| {
                let problem = d
                    .facts
                    .as_ref()
                    .and_then(|f| f.get("problem"))
                    .and_then(mandate_ir::JsValue::as_str)
                    .unwrap_or_default()
                    .to_owned();
                format!(
                    "{} {} {problem}",
                    d.code,
                    d.at.path.as_deref().unwrap_or("")
                )
            })
            .collect()
    };
    let libs = [library(ACME)];
    let std_unpinned = with_libraries(&text, &libs, Some(&without("std.patterns")));
    assert_eq!(
        found(&std_unpinned),
        ["MDT-E1605 /libraries/std.patterns not_pinned"]
    );
    let acme_unpinned = with_libraries(&text, &libs, Some(&without("acme.connectors")));
    assert_eq!(
        found(&acme_unpinned),
        ["MDT-E1605 /libraries/acme.connectors not_pinned"]
    );
    let not_handed = with_libraries(&text, &[], Some(&lock));
    let f = found(&not_handed);
    assert_eq!(
        f.first().map(String::as_str),
        Some("MDT-E1605 /libraries/acme.connectors not_found"),
        "{f:#?}"
    );
    assert!(
        f.iter().skip(1).all(|d| d.starts_with("MDT-E1604")),
        "{f:#?}"
    );
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

/// The lock of the upgrade cases (L02, L05) pins acme.ops 1.0.0 as it is.
#[test]
fn the_lock_of_the_upgrade_cases_pins_acme_ops_1_0_0() {
    let written = ops_lock();
    for case in ["conformance/L02", "conformance/L05"] {
        let lock = read_json(&format!("{case}/mandate.lock.json")).unwrap();
        assert_eq!(
            mandate_ir::canonicalize(&lock),
            mandate_ir::canonicalize(&written),
            "{case}: {}",
            mandate_ir::canonicalize(&written)
        );
    }
}

/// A changed `requires`, and nothing else, is a governance change of an
/// upgrade: the library reaches other code.
#[test]
fn an_upgrade_that_changes_requires_writes_no_lock_without_acceptance() {
    let lock = ops_lock();
    let pinned = published("1.0.0").source;
    let mut requiring = published("1.0.1");
    requiring.source.manifest = requiring.source.manifest.replace(
        "\"modules\": [\"ops.mdt\"]",
        "\"modules\": [\"ops.mdt\"],\n  \"requires\": { \"std.patterns\": \"^1.0\" }",
    );
    assert!(requiring.source.manifest.contains("requires"));
    let versions = [published("1.0.0"), requiring];
    let at = now("2026-11-15T00:00:00Z");
    let r = upgrade(
        &request(Some("1.0.1"), &lock, &versions, None, at),
        &pinned,
        false,
    );
    assert!(r.ok, "{:#?}", r.diagnostics);
    assert!(r.lock.is_none());
    assert_eq!(kinds(&r), ["requires_changed + requires std.patterns ^1.0"]);
}

/// A write tool whose retry class changes, and a read-only tool that becomes
/// a write tool, widen the connector's signature.
#[test]
fn a_tool_whose_class_changes_widens_the_connector() {
    let base = load_library(&published("1.0.0").source, false, "x").unwrap();
    let changed = |from: &str, to: &str| {
        let mut s = published("1.0.0").source;
        for (_, text) in &mut s.files {
            assert!(text.contains(from), "{from}");
            *text = text.replace(from, to);
        }
        load_library(&s, false, "x").unwrap()
    };
    let retry = changed(
        "    retry_class reconcilable\n    reconcile by find_item\n",
        "    retry_class idempotent\n",
    );
    let c = mandate_check::library::ops::compare(&base, &retry, &[]);
    let texts: Vec<&str> = c.widenings.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(
        texts,
        ["~ connector acme.ops.store.put_item: write reconcilable → write idempotent"]
    );
    let writes = changed(
        "  tool list_items() -> Untrusted<List<Item>>\n    read_only\n",
        "  tool list_items(key: Text) -> Receipt<Text>\n    critical\n    idempotency key key\n    retry_class idempotent\n",
    );
    let c = mandate_check::library::ops::compare(&base, &writes, &[]);
    assert!(
        c.widenings.iter().any(
            |w| w.text == "~ connector acme.ops.store.list_items: read_only → write idempotent"
        ),
        "{:#?}",
        c.widenings
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

/// `add` writes its pin into a lock of format 0.6 when the lock is older
/// (the first format with `libraries`), and keeps the format of a lock of
/// 0.6 or later: a lock of 0.7 (spec/attention.md "Lock 0.7") stays one.
#[test]
fn add_keeps_a_lock_of_0_6_or_later_in_its_format() {
    let versions = every_version();
    let at = now("2026-11-13T12:00:00Z");
    let config = mandate_lib::read_libraries_config(
        &mandate_ir::parse(r#"{"dir":"libs","wait_days":0,"revoked":[]}"#)
            .unwrap()
            .value,
    )
    .unwrap();
    for (given, written) in [
        ("mandate/lock/0.5", "mandate/lock/0.6"),
        ("mandate/lock/0.6", "mandate/lock/0.6"),
        ("mandate/lock/0.7", "mandate/lock/0.7"),
    ] {
        let lock: Value = mandate_ir::parse(&format!(r#"{{"lock":"{given}","modules":{{}}}}"#))
            .unwrap()
            .value;
        let r = add(&request(Some("^1.0"), &lock, &versions, Some(&config), at));
        assert!(r.ok, "{given}: {:#?}", r.diagnostics);
        let out = r.lock.as_ref().expect("a lock");
        assert_eq!(
            out.get("lock").and_then(Value::as_str),
            Some(written),
            "{given}"
        );
        assert!(
            mandate_ir::validate_lock(out).is_empty(),
            "{given}: the lock written is one its schema takes"
        );
    }
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

/// The schema of a 0.6 lock names a library and its modules as the reader
/// of `mandate-lib` does, in lower case: an upper-case name is E0140, and
/// is not read as a pin the schema took and the reader refused.
#[test]
fn the_lock_schema_and_the_reader_agree_on_library_names() {
    for (key, module) in [("Acme.ops", "acme.ops"), ("acme.ops", "acme.Ops")] {
        let text = format!(
            r#"{{"lock":"mandate/lock/0.6","modules":{{}},"libraries":{{"{key}":{{"version":"1.0.0","digest":"sha256:{d}","modules":{{"{module}":"sha256:{d}"}}}}}}}}"#,
            d = "0".repeat(64)
        );
        let lock = mandate_ir::parse(&text).unwrap().value;
        let found = mandate_check::validate_lock(&lock);
        assert!(
            found.iter().any(|d| d.code == "MDT-E0140"),
            "{key} {module}: {found:#?}"
        );
        assert!(mandate_lib::read_lock_libraries(lock.get("libraries")).is_err());
    }
}

/// The acceptance library's modules, as given modules.
fn acme_modules() -> Modules {
    let files = [
        "fixtures/library/acme.connectors/types.mdt",
        "fixtures/library/acme.connectors/connectors.mdt",
    ];
    let texts: Vec<String> = files.iter().map(|f| read_text(f).unwrap()).collect();
    let sources: Vec<ModuleSource<'_>> = files
        .iter()
        .zip(&texts)
        .map(|(f, text)| ModuleSource {
            text,
            kind: SourceKind::Mdt,
            file: f,
        })
        .collect();
    load_modules(&sources).modules
}

/// The parent of conformance/L07 checks with the acceptance library's
/// modules: it imports the ERP connector and never calls it.
#[test]
fn the_parent_of_l07_checks() {
    let r = checked(
        &read_text("conformance/L07/parent.mdt").unwrap(),
        Some(&acme_modules()),
    );
    assert!(r.ok, "{:#?}", shown(&r));
}

/// A library of two modules: `acme.flows.types` defines `Note`, and
/// `acme.flows` a pattern whose run parameter and result are a `Note`, which
/// it imports from the other module of its library; `extra` is a `use` the
/// pattern's module adds.
fn flows(extra: &str, requires: &str) -> LibrarySource {
    LibrarySource {
        manifest: format!(
            r#"{{"library":"mandate/library/0.6","name":"acme.flows","version":"1.0.0","modules":["flows.mdt","types.mdt"]{requires}}}"#
        ),
        files: vec![
            (
                "flows.mdt".to_owned(),
                format!(
                    "mandate @ 0.6\n\nmodule acme.flows @ 1.0\n\nuse acme.flows.types.{{Note}}\n{extra}\n/// Gives the note back.\npub pattern Keep(times: const Int) (note: Note) -> Note {{\n  note\n}}\n"
                ),
            ),
            (
                "types.mdt".to_owned(),
                "mandate @ 0.6\n\nmodule acme.flows.types @ 1.0\n\n/// A note.\npub type Note = { text: Text }\n".to_owned(),
            ),
        ],
    }
}

const KEEP: &str = "mandate @ 0.6\n\nmodule app @ 0.1\n\nuse std.{fs}\nuse acme.flows.{Keep}\n\ncapability R = fs.read(\"/w\")\n\nworkflow W = Keep(times: 1)\n  caps   R\n  budget { time: 1m }\n";

/// Linking is transitive through a library: a pattern of a library's module
/// may name what its module imports from another module of its library, and
/// the expansion names it in the applying program through that module. A
/// module of a library may not import a module of a library its manifest
/// does not require (E1604, so the library is malformed, E1601).
#[test]
fn a_library_pattern_names_what_its_library_reaches() {
    let r = with_libraries(KEEP, &[flows("", "")], None);
    assert!(r.ok, "{:#?}", shown(&r));
    let uses = mandate_ir::canonicalize(r.expanded.as_ref().unwrap().get("uses").unwrap());
    assert!(
        uses.contains(r#"{"module":"acme.flows.types","names":["Note"]}"#),
        "{uses}"
    );
    // The same modules given as modules, not as a library: not transitive.
    let lib = load_library(&flows("", ""), false, "x").unwrap();
    let r = checked(KEEP, Some(&lib.modules));
    assert_eq!(
        r.diagnostics
            .iter()
            .filter(|d| d.severity == mandate_ir::Severity::Error)
            .map(|d| d.code.as_str())
            .collect::<Vec<_>>(),
        ["MDT-E1602"],
        "{:#?}",
        shown(&r)
    );
    // A module that imports a library its library does not require.
    let outside = with_libraries(
        KEEP,
        &[
            flows("use acme.connectors.types.{Order}\n", ""),
            library(ACME),
        ],
        None,
    );
    let e1601 = outside
        .diagnostics
        .iter()
        .find(|d| d.code == "MDT-E1601")
        .unwrap_or_else(|| panic!("{:#?}", shown(&outside)));
    let facts =
        mandate_ir::stringify(&mandate_ir::JsValue::Object(e1601.facts.clone().unwrap())).unwrap();
    assert!(
        facts.contains("module_does_not_check") && facts.contains("MDT-E1604"),
        "{facts}"
    );
    // Required, it may.
    let required = with_libraries(
        KEEP,
        &[
            flows(
                "use acme.connectors.types.{Order}\n",
                r#","requires":{"acme.connectors":"^2.3"}"#,
            ),
            library(ACME),
        ],
        None,
    );
    assert!(required.ok, "{:#?}", shown(&required));
}

/// 0.6 (B13): the semantic diff and a patch classify a change by one rule
/// set, with the modules: the governance changes of each are the same.
#[test]
fn the_diff_and_a_patch_classify_alike() {
    let before = check(
        &read_text(INVOICES).unwrap(),
        SourceKind::Mdt,
        &CheckOptions {
            libraries: Some(&[library(ACME)]),
            ..CheckOptions::default()
        },
    );
    let program = before.program.unwrap();
    let text = read_text(INVOICES).unwrap().replace(
        "budget { spend: 20 USD, time: 2h }",
        "budget { spend: 40 USD, time: 2h }",
    );
    let after = mandate_syntax::load(&text, SourceKind::Mdt)
        .program
        .unwrap();
    let lib = load_library(&library(ACME), false, "x").unwrap();
    let mut modules = lib.modules.clone();
    for (m, p) in mandate_check::library::std_patterns()
        .unwrap()
        .modules
        .iter()
    {
        modules.insert(m, p.clone());
    }
    let diff = mandate_check::semantic_diff_with(&program, &after, None, Some(&modules));
    let patch = mandate_check::governance_changes(&program, &after, Some(&modules));
    let from_diff: Vec<&str> = diff.governance.iter().map(|c| c.text.as_str()).collect();
    let from_patch: Vec<&str> = patch.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(from_diff, from_patch);
    assert!(!patch.is_empty());
}
