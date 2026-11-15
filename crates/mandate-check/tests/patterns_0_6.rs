//! Patterns and their expansion (language 0.6, spec/library.md "Patterns"),
//! where a conformance case cannot say it: the expanded program itself (it
//! loads, passes the closed schema, and checks to the same result with the
//! same modules), the program hash of an application, the origin of a
//! diagnostic of the expansion, and a program of 0.5 that reads as it always
//! did. No TypeScript reads 0.6, so every expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{CheckOptions, CheckResult, ModuleSource, Modules, check, load_modules};
use mandate_ir::{JsValue, Value};
use mandate_ir::{canonicalize, hash_program};
use mandate_syntax::SourceKind;
use mandate_testkit::read_text;

const PATTERNS: &str = "fixtures/library/batch.patterns.mdt";
const BATCH: &str = "fixtures/library/batch.mdt";
const REVIEW: &str = "fixtures/library/review.mdt";

/// The modules `files`, loaded.
fn modules_of(files: &[&str]) -> Modules {
    let texts: Vec<(String, String)> = files
        .iter()
        .map(|f| ((*f).to_owned(), read_text(f).unwrap()))
        .collect();
    let sources: Vec<ModuleSource<'_>> = texts
        .iter()
        .map(|(file, text)| ModuleSource {
            text,
            kind: SourceKind::Mdt,
            file,
        })
        .collect();
    let r = load_modules(&sources);
    assert!(r.problems.is_empty(), "{:?}", r.problems);
    r.modules
}

/// The modules of the acceptance program: the connectors and the pattern.
fn acceptance_modules() -> Modules {
    modules_of(&[
        "fixtures/library/acme.connectors/types.mdt",
        "fixtures/library/acme.connectors/connectors.mdt",
        PATTERNS,
    ])
}

fn check_with(text: &str, kind: SourceKind, modules: Option<&Modules>) -> CheckResult {
    check(
        text,
        kind,
        &CheckOptions {
            modules,
            ..CheckOptions::default()
        },
    )
}

/// `code at path` of each diagnostic but W0601.
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

fn json(v: &Value) -> String {
    mandate_ir::stringify(&JsValue::from(v)).unwrap()
}

#[test]
fn the_acceptance_program_checks_on_its_expansion() {
    let modules = acceptance_modules();
    let r = check_with(&read_text(BATCH).unwrap(), SourceKind::Mdt, Some(&modules));
    assert!(r.ok, "{:#?}", shown(&r));
    let expanded = r.expanded.as_ref().expect("an expansion");
    // The expanded program is a program of 0.6 with no `apply` in it, which
    // checks to the same result with the same modules.
    let text = json(expanded);
    assert!(!text.contains("\"apply\""), "{text}");
    let again = check_with(&text, SourceKind::Json, Some(&modules));
    assert!(again.ok, "{:#?}", shown(&again));
    assert!(again.expanded.is_none());
    let codes =
        |r: &CheckResult| -> Vec<String> { r.diagnostics.iter().map(|d| d.code.clone()).collect() };
    assert_eq!(codes(&r), codes(&again));
    // It comes to the checks of the flow written out by hand, review.mdt:
    // the same body, caps and budget, which check alike.
    let review = check_with(&read_text(REVIEW).unwrap(), SourceKind::Mdt, Some(&modules));
    assert!(review.ok);
    assert_eq!(codes(&r), codes(&review));
    let written = review.program.as_ref().unwrap();
    let workflow = |p: &Value, member: &str| {
        p.get("defs")
            .and_then(|d| d.get("MatchInvoices"))
            .and_then(|w| w.get(member))
            .map(canonicalize)
    };
    for member in ["body", "caps", "budget", "params"] {
        assert_eq!(
            workflow(expanded, member),
            workflow(written, member),
            "{member}"
        );
    }
    // Its result is the pattern's, with the type arguments put in.
    assert_eq!(
        workflow(expanded, "returns").as_deref(),
        Some(r#"{"args":[{"ref":"Match"},{"ref":"DraftId"}],"ref":"Batch"}"#)
    );
    // It names what the expansion needs through its use lists: Batch of the
    // pattern's module, and the module human of the standard library.
    assert_eq!(
        expanded.get("uses").map(canonicalize).as_deref(),
        Some(
            r#"[{"module":"acme.connectors","names":["erp","mailbox"]},{"module":"acme.connectors.types","names":["DraftId","Invoice","Match","near"]},{"module":"batch.patterns","names":["BatchWithExceptions","Batch"]},{"module":"std","names":["model","tool","human"]}]"#
        )
    );
}

/// `MatchInvoices` of the acceptance program with the argument of `slot`
/// replaced by `value`.
fn with_argument(text: &str, slot: &str, value: &str) -> String {
    let start = text.find(&format!("{slot}: ")).unwrap();
    let rest = &text[start..];
    let end = rest.find([',', ')']).unwrap();
    format!("{}{slot}: {value}{}", &text[..start], &rest[end..])
}

/// spec/library.md "Hashes": the program hash covers the application, not
/// the expansion; a changed slot argument is a new program, a changed
/// pattern (in its module) is not, though its expansion is another.
#[test]
fn the_program_hash_covers_the_application_and_not_the_expansion() {
    let modules = acceptance_modules();
    let text = read_text(BATCH).unwrap();
    let base = check_with(&text, SourceKind::Mdt, Some(&modules));
    assert!(base.ok);
    let hash = base.hashes.as_ref().unwrap().program.clone();
    // A slot argument changed: another hash.
    let more = check_with(
        &with_argument(&text, "max_items", "61"),
        SourceKind::Mdt,
        Some(&modules),
    );
    assert!(more.ok, "{:#?}", shown(&more));
    assert_ne!(more.hashes.as_ref().unwrap().program, hash);
    // The pattern's body changed in its module: the same hash, another
    // expansion.
    let pattern = read_text(PATTERNS).unwrap().replace(
        "human.review(checked, role: reviewer, deadline: deadline, escalate_to: escalate_to)",
        "human.review(checked, role: reviewer, deadline: deadline)",
    );
    let changed = {
        let texts: Vec<(String, String)> = vec![
            (
                "types.mdt".to_owned(),
                read_text("fixtures/library/acme.connectors/types.mdt").unwrap(),
            ),
            (
                "connectors.mdt".to_owned(),
                read_text("fixtures/library/acme.connectors/connectors.mdt").unwrap(),
            ),
            ("patterns.mdt".to_owned(), pattern),
        ];
        let sources: Vec<ModuleSource<'_>> = texts
            .iter()
            .map(|(file, text)| ModuleSource {
                text,
                kind: SourceKind::Mdt,
                file,
            })
            .collect();
        load_modules(&sources).modules
    };
    let other = check_with(&text, SourceKind::Mdt, Some(&changed));
    assert!(other.ok, "{:#?}", shown(&other));
    assert_eq!(other.hashes.as_ref().unwrap().program, hash);
    let (a, b) = (base.expanded.unwrap(), other.expanded.unwrap());
    assert_ne!(canonicalize(&a), canonicalize(&b));
    assert_ne!(hash_program(&a).program, hash_program(&b).program);
    // And the expanded program's own hash is not the program's.
    assert_ne!(hash_program(&a).program, hash);
}

/// `check` gives `expanded` only for a program that applies a pattern, and
/// so does its JSON door; a program that applies none, of 0.6 or before,
/// gives what it gave.
#[test]
fn expanded_is_given_only_for_a_program_that_applies_a_pattern() {
    let modules = acceptance_modules();
    let review = check_with(&read_text(REVIEW).unwrap(), SourceKind::Mdt, Some(&modules));
    assert!(review.expanded.is_none());
    let patterns = check_with(&read_text(PATTERNS).unwrap(), SourceKind::Mdt, None);
    assert!(patterns.ok, "{:#?}", shown(&patterns));
    assert!(patterns.expanded.is_none(), "a pattern applied by nothing");
    let door = |text: &str| {
        let mut input = mandate_ir::Map::new();
        input.insert("text", text);
        input.insert("kind", "mdt");
        let mut opts = mandate_ir::Map::new();
        opts.insert("modules", Value::Object(modules.clone()));
        input.insert("opts", Value::Object(opts));
        let d = mandate_check::json_doors::door("check").unwrap();
        (d.call)(&Value::Object(input)).unwrap()
    };
    let with = door(&read_text(BATCH).unwrap());
    assert!(with.get("expanded").is_some());
    assert_eq!(with.get("ok").and_then(JsValue::as_bool), Some(true));
    let without = door(&read_text(REVIEW).unwrap());
    assert!(without.get("expanded").is_none());
    let old = door(&read_text("fixtures/fixbug/fixbug.mdt").unwrap());
    assert!(old.get("expanded").is_none());
}

/// A pattern of a module the check is given is checked again where it is
/// applied: a module that was never checked (one a caller hands over as IR)
/// carries no authority into the expansion unseen, and every diagnostic is
/// at the application, with the module and the pattern's own path.
#[test]
fn an_imported_pattern_is_checked_again_where_it_is_applied() {
    let mut modules = acceptance_modules();
    // The pattern delegates to an agent of its own module, which no slot
    // names: the module's own check would refuse it, and it is not run.
    let text = read_text(PATTERNS).unwrap().replace(
        "let out = delegate work(it)",
        "let out = delegate Helper.help(it)",
    ) + "\nagent Helper {\n  role   \"Helps.\"\n  caps   Wide\n  skill help(i: Untrusted<Invoice>) -> Inferred<Text> ! {Fs.Write}\n}\n\ncapability Wide = fs.write(\"/\")\n";
    let module = mandate_syntax::load(&text, SourceKind::Mdt)
        .program
        .unwrap();
    modules.insert("batch.patterns", module);
    let r = check_with(&read_text(BATCH).unwrap(), SourceKind::Mdt, Some(&modules));
    assert!(!r.ok);
    let e1302: Vec<&mandate_ir::Diagnostic> = r
        .diagnostics
        .iter()
        .filter(|d| d.code == "MDT-E1302")
        .collect();
    assert_eq!(e1302.len(), 1, "{:#?}", shown(&r));
    let d = e1302[0];
    assert_eq!(d.at.path.as_deref(), Some("/defs/MatchInvoices/apply"));
    let fact = |k: &str| {
        d.facts
            .as_ref()
            .and_then(|f| f.get(k))
            .and_then(JsValue::as_str)
            .map(str::to_owned)
    };
    assert_eq!(fact("module").as_deref(), Some("batch.patterns"));
    assert_eq!(fact("names").as_deref(), Some("agent"));
    assert_eq!(
        fact("pattern_path").as_deref(),
        Some("/defs/BatchWithExceptions/body/1/value/body/0/value/agent")
    );
    assert!(r.expanded.is_none());
}

/// Linking is not transitive: a module's definitions that name a third
/// module's are not linked into the applying program. A pattern whose
/// signature or body names a definition its module imports, rather than
/// defines, is refused at the application (E1602) rather than read as an
/// unknown type, or as the applying program's own definition of that name.
#[test]
fn a_pattern_that_names_what_its_module_imports_is_refused_where_it_is_applied() {
    let mut modules = acceptance_modules();
    let text = read_text(PATTERNS)
        .unwrap()
        .replace(
            "use std.{human}",
            "use std.{human}\nuse acme.connectors.types.{Order}",
        )
        .replace(
            ") -> Batch<Out, R>\n",
            ") (hint: Option<Order>) -> Batch<Out, R>\n",
        );
    let module = mandate_syntax::load(&text, SourceKind::Mdt)
        .program
        .unwrap();
    modules.insert("batch.patterns", module);
    let r = check_with(&read_text(BATCH).unwrap(), SourceKind::Mdt, Some(&modules));
    let found: Vec<String> = r
        .diagnostics
        .iter()
        .filter(|d| d.code != "MDT-W0601")
        .map(|d| format!("{} {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(
        found,
        ["MDT-E1602 /defs/MatchInvoices/apply"],
        "{:#?}",
        shown(&r)
    );
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == "MDT-E1602")
        .unwrap();
    let from = d
        .facts
        .as_ref()
        .and_then(|f| f.get("from"))
        .and_then(JsValue::as_str);
    assert_eq!(from, Some("acme.connectors.types"));
}

/// The static checks read a workflow's body; a workflow that still applies
/// a pattern when they meet it is refused (E1307), never read as one that
/// does nothing.
#[test]
fn the_static_checks_refuse_a_workflow_that_was_not_expanded() {
    let p = mandate_syntax::load(
        &read_text("conformance/P02/program.mdt").unwrap(),
        SourceKind::Mdt,
    )
    .program
    .unwrap();
    let view = mandate_ir::Program::of(&p).unwrap();
    let found: Vec<String> = mandate_check::static_check(view, None, None, None)
        .iter()
        .filter(|d| d.code.starts_with("MDT-E"))
        .map(|d| format!("{} {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(found, ["MDT-E1307 /defs/MatchAll/apply"]);
}

/// A program of 0.5 reads an application and a pattern as it always did: as
/// IR its schema has no such kind or member (E0104).
#[test]
fn a_program_of_0_5_has_no_patterns() {
    let r = check_with(
        r#"{"language":"mandate/0.5","module":"m","version":"0.1","defs":{"P":{"kind":"pattern","slots":[],"returns":{"ref":"Int"},"body":[]}}}"#,
        SourceKind::Json,
        None,
    );
    assert!(!r.ok);
    assert!(
        r.diagnostics.iter().all(|d| d.code == "MDT-E0104"),
        "{:#?}",
        shown(&r)
    );
    let r = check_with(
        r#"{"language":"mandate/0.5","module":"m","version":"0.1","defs":{"W":{"kind":"workflow","caps":[],"apply":{"pattern":"P","args":[]}}}}"#,
        SourceKind::Json,
        None,
    );
    assert!(!r.ok);
    assert!(
        r.diagnostics.iter().all(|d| d.code == "MDT-E0104"),
        "{:#?}",
        shown(&r)
    );
    assert!(r.expanded.is_none());
}

/// The limits of the reader hold for an expansion: one that nests an
/// argument deeper than 64 levels, or copies more than 1 MiB of arguments,
/// is refused (E0105) rather than handed to the checks.
#[test]
fn an_expansion_nests_and_copies_no_more_than_the_reader_allows() {
    // A type argument 28 levels of List deep, used in a let three ifs down.
    let deep = (0..28).fold("Int".to_owned(), |t, _| format!("List<{t}>"));
    let text = format!(
        "mandate @ 0.6\n\nmodule m @ 0.1\n\nuse std.{{fs}}\n\ncapability R = fs.read(\"/w\")\n\npattern Deep<T>(n: const Int) -> Int {{\n  if true {{\n    if true {{\n      if true {{\n        let x: Option<T> = n\n      }}\n    }}\n  }}\n  n\n}}\n\nworkflow W = Deep<{deep}>(n: 1)\n  caps R\n"
    );
    let r = check_with(&text, SourceKind::Mdt, None);
    let e0105: Vec<&mandate_ir::Diagnostic> = r
        .diagnostics
        .iter()
        .filter(|d| d.code == "MDT-E0105")
        .collect();
    assert_eq!(e0105.len(), 1, "{:#?}", shown(&r));
    assert_eq!(e0105[0].at.path.as_deref(), Some("/defs/W/apply/types/0"));
    assert!(r.expanded.is_none());
    // A text of 200,000 characters copied ten times.
    let big = "x".repeat(200_000);
    let uses: String = (0..10).map(|i| format!("  let a{i} = n\n")).collect();
    let text = format!(
        "mandate @ 0.6\n\nmodule m @ 0.1\n\nuse std.{{fs}}\n\ncapability R = fs.read(\"/w\")\n\npattern Many(n: const Text) -> Int {{\n{uses}  1\n}}\n\nworkflow W = Many(n: \"{big}\")\n  caps R\n"
    );
    let r = check_with(&text, SourceKind::Mdt, None);
    let e0105: Vec<String> = r
        .diagnostics
        .iter()
        .filter(|d| d.code == "MDT-E0105")
        .map(|d| d.at.path.clone().unwrap_or_default())
        .collect();
    assert_eq!(e0105, ["/defs/W/apply"], "{:#?}", shown(&r));
}

/// A diagnostic of the expansion is reported in the program that was
/// checked, never at a path into the expansion: at the slot argument, or at
/// the application with the pattern's own path.
#[test]
fn every_diagnostic_of_an_expansion_is_at_a_path_of_the_program() {
    let text = read_text("conformance/P02/program.mdt").unwrap();
    for (from, to) in [
        // A deadline of no Duration: at the argument.
        ("deadline: 1d", "deadline: 0ms"),
        // The capability of the commit taken away: at the commit's argument.
        (
            "caps   Inbox, ErpRead, ErpDraft, ModelStd",
            "caps   Inbox, ErpRead, ModelStd",
        ),
        // A person asked in the map: at the application.
        (
            "    verify out against accepted(it, out)",
            "    human.approve(role: reviewer)\n    verify out against accepted(it, out)",
        ),
    ] {
        let r = check_with(&text.replace(from, to), SourceKind::Mdt, None);
        assert!(!r.ok, "{to}");
        for d in &r.diagnostics {
            let path = d.at.path.as_deref().unwrap_or("");
            assert!(
                !path.starts_with("/defs/MatchAll/body")
                    && !path.starts_with("/defs/MatchAll/params"),
                "{to}: {path}"
            );
            if d.code.starts_with("MDT-E") {
                assert!(path.starts_with("/defs/MatchAll/apply"), "{to}: {path}");
                assert!(d.at.span.is_some(), "{to}: a span of the program");
            }
        }
    }
}

/// The semantic diff: a change that would be a governance change had the
/// expansion been written in the workflow is never reported as less. Every
/// change of an application, and of a pattern a workflow applies, is a
/// governance change (`application_changed`); a change of a pattern nobody
/// applies is a behavior change.
#[test]
fn a_change_of_an_application_or_of_its_pattern_is_a_governance_change() {
    let text = read_text("conformance/P02/program.mdt").unwrap();
    let ir = |t: &str| mandate_syntax::load(t, SourceKind::Mdt).program.unwrap();
    let before = ir(&text);
    let kinds = |after: &str| -> Vec<String> {
        mandate_check::governance_changes(&before, &ir(after), None)
            .iter()
            .map(|c| format!("{} {}", c.kind.as_str(), c.path))
            .collect()
    };
    let at_apply = vec!["application_changed /defs/MatchAll/apply".to_owned()];
    // A slot argument swapped for an effect of a higher class.
    let irreversible = text.replace(
        "capability Inbox",
        "effect file(m: Verified<Match>) -> Receipt<DraftId>\n  requires caps ErpDraft\n  critical\n  irreversible\n  idempotency required\n\ncapability Inbox",
    );
    let swapped = irreversible.replace("commit: erp.post_draft", "commit: file");
    let mut want = at_apply.clone();
    want.push("irreversible_added /defs/file".to_owned());
    assert_eq!(kinds(&swapped), want);
    // A contract swapped for a weaker one.
    let weaker = text
        .replace(
            "agent Matcher",
            "contract Any(inv: Invoice, m: Match) {\n  accept any \"Anything\" by static true\n}\n\nagent Matcher",
        )
        .replace("accepted: Matched", "accepted: Any");
    assert_eq!(kinds(&weaker), at_apply);
    // Another reviewer.
    assert_eq!(
        kinds(
            &text
                .replace("reviewer: accountant", "reviewer: finance_lead")
                .replace("escalate_to: finance_lead", "escalate_to: accountant")
        ),
        at_apply
    );
    // max_items raised.
    assert_eq!(
        kinds(&text.replace("max_items: 60", "max_items: 600")),
        at_apply
    );
    // The pattern's body changed, which the workflow applies.
    assert_eq!(
        kinds(&text.replace(
            "map v in reviewed.accepted max max_items",
            "map v in reviewed.accepted max 600"
        )),
        ["application_changed /defs/BatchWithExceptions"]
    );
    // A pattern nobody applies: a behavior change.
    let alone = text.replace(
        "/// Matches every invoice",
        "pattern Spare(n: const Int) -> Int {\n  n\n}\n\n/// Matches every invoice",
    );
    let changed = alone.replace(
        "pattern Spare(n: const Int) -> Int {\n  n\n}",
        "pattern Spare(n: const Int) -> Int {\n  1\n}",
    );
    assert!(mandate_check::governance_changes(&ir(&alone), &ir(&changed), None).is_empty());
    // A new workflow that applies a pattern adds its caps and its application.
    let added = mandate_check::governance_changes(
        &ir(&alone.replace(
            "workflow MatchAll",
            "workflow Other = Spare(n: 1)\n  caps   Inbox\n\nworkflow MatchAll",
        )),
        &ir(&alone),
        None,
    );
    assert!(added.is_empty(), "the other way round");
    let added: Vec<String> = mandate_check::governance_changes(
        &ir(&alone),
        &ir(&alone.replace(
            "workflow MatchAll",
            "workflow Other = Spare(n: 1)\n  caps   Inbox\n\nworkflow MatchAll",
        )),
        None,
    )
    .iter()
    .map(|c| format!("{} {}", c.kind.as_str(), c.path))
    .collect();
    assert_eq!(
        added,
        [
            "capability_added /defs/Other/caps/0",
            "application_changed /defs/Other/apply"
        ]
    );
}
