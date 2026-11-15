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
        let texts: [(String, String); 3] = [
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
    let e0105: Vec<&mandate_ir::Diagnostic> = r
        .diagnostics
        .iter()
        .filter(|d| d.code == "MDT-E0105")
        .collect();
    assert_eq!(e0105.len(), 1, "{:#?}", shown(&r));
    assert_eq!(e0105[0].at.path.as_deref(), Some("/defs/W/apply"));
    // The expansion stops at the copy that passes the limit, rather than
    // copying all ten and counting after: what it copied is the limit and
    // one argument at most (the argument, `{"op":"text","value":"x…"}`, is
    // its canonical text), never the 2,000,000 bytes of every use.
    let number = |k: &str| {
        e0105[0]
            .facts
            .as_ref()
            .and_then(|f| f.get(k))
            .and_then(JsValue::as_f64)
            .unwrap()
    };
    // 200,000 characters and the 24 of `{"op":"text","value":""}`.
    let argument = 200_024.0;
    let (copied, limit) = (number("copied"), number("limit"));
    assert!(copied > limit, "{copied}");
    assert!(copied <= limit + argument, "{copied}");
    assert_eq!(limit, 1_048_576.0);
}

/// A slot's argument is copied whole into the expansion: one that would
/// nest deeper than the reader allows where the body uses it is refused at
/// the argument (E0105), as a type argument is. (A constant is a scalar or
/// the name of one, so the argument that can nest is a `type` slot's.)
#[test]
fn a_slot_argument_nests_no_deeper_than_the_reader_allows() {
    // A type 28 levels of List deep, given to a type slot and used in a let
    // three ifs down.
    let deep = (0..28).fold("Int".to_owned(), |t, _| format!("List<{t}>"));
    let text = format!(
        "mandate @ 0.6\n\nmodule m @ 0.1\n\nuse std.{{fs}}\n\ncapability R = fs.read(\"/w\")\n\npattern Deep(t: type, n: const Int) -> Int {{\n  if true {{\n    if true {{\n      if true {{\n        let x: Option<t> = n\n      }}\n    }}\n  }}\n  n\n}}\n\nworkflow W = Deep(t: {deep}, n: 1)\n  caps R\n"
    );
    let r = check_with(&text, SourceKind::Mdt, None);
    let errors: Vec<String> = r
        .diagnostics
        .iter()
        .filter(|d| d.code.starts_with("MDT-E"))
        .map(|d| format!("{} {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(
        errors,
        ["MDT-E0105 /defs/W/apply/args/0/type"],
        "{:#?}",
        shown(&r)
    );
}

/// `static_cost` is the checker's count of a workflow written out; an
/// application has none until it is expanded, and the count of its
/// expansion is that of the workflow it becomes.
#[test]
fn the_static_cost_of_an_application_is_that_of_its_expansion() {
    let text = read_text("conformance/P02/program.mdt").unwrap();
    let p = mandate_syntax::load(&text, SourceKind::Mdt)
        .program
        .unwrap();
    let view = mandate_ir::Program::of(&p).unwrap();
    assert!(mandate_check::static_cost(view, "MatchAll", None).is_none());
    let r = check_with(&text, SourceKind::Mdt, None);
    let expanded = r.expanded.as_ref().unwrap();
    let view = mandate_ir::Program::of(expanded).unwrap();
    let c = mandate_check::static_cost(view, "MatchAll", None).unwrap();
    // 60 delegations of the map, 0.30 USD each.
    assert_eq!(c.spend, [("USD".to_owned(), 18_000_000.0)]);
}

/// A program that applies a pattern and does not check gives no expanded
/// program, as it gives no hashes; and the parts of an E0501's breakdown,
/// places of the expansion, are reported at places of the program, as the
/// diagnostic is.
#[test]
fn a_refused_expansion_is_not_given_and_its_cost_is_at_places_of_the_program() {
    let text = read_text("conformance/P02/program.mdt").unwrap().replace(
        "budget { spend: 20 USD, time: 2h }",
        "budget { spend: 5 USD, time: 2h }",
    );
    let r = check_with(&text, SourceKind::Mdt, None);
    assert!(!r.ok);
    assert!(r.expanded.is_none());
    assert!(r.hashes.is_none());
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == "MDT-E0501")
        .expect("E0501");
    assert_eq!(d.at.path.as_deref(), Some("/defs/MatchAll/budget"));
    let parts = d
        .facts
        .as_ref()
        .and_then(|f| f.get("breakdown"))
        .and_then(JsValue::as_array)
        .unwrap();
    assert!(!parts.is_empty());
    // Each part a delegation of the map's body, written by the slot `work`:
    // at its argument, `Matcher.match`, with the place in the expansion.
    for part in parts {
        let fact = |k: &str| part.get(k).and_then(JsValue::as_str);
        assert_eq!(fact("at"), Some("/defs/MatchAll/apply/args/1/value"));
        assert_eq!(fact("slot"), Some("work"));
        let expanded = fact("expanded_path").unwrap();
        assert!(
            expanded.starts_with("/defs/MatchAll/body/1/value/body"),
            "{expanded}"
        );
    }
    // The door says the same: no `expanded` beside `ok: false`.
    let mut input = mandate_ir::Map::new();
    input.insert("text", text.as_str());
    input.insert("kind", "mdt");
    let door = mandate_check::json_doors::door("check").unwrap();
    let out = (door.call)(&Value::Object(input)).unwrap();
    assert_eq!(out.get("ok").and_then(JsValue::as_bool), Some(false));
    assert!(out.get("expanded").is_none());
}

/// The JSON text of `v` with `from` replaced by `to` (once), read back.
fn edited(v: &Value, from: &str, to: &str) -> Value {
    let text = json(v);
    assert_eq!(text.matches(from).count(), 1, "{from}");
    mandate_ir::parse(&text.replace(from, to)).unwrap().value
}

/// A delegation names its skill slot or an `Agent.skill`, never both, and
/// no other statement or expression names a slot in a member of its own.
/// The reader of 0.6 refuses the shapes (E0104e); a module a caller hands
/// over as IR was read by no one, and its pattern is refused where it is
/// applied (E1301), the agent it names held as any agent the body names
/// (E1302): the expansion never runs an agent its slot was not given.
#[test]
fn a_slot_is_never_written_beside_what_it_stands_for() {
    let module = mandate_syntax::load(&read_text(PATTERNS).unwrap(), SourceKind::Mdt)
        .program
        .unwrap();
    for (to, problem, use_) in [
        (
            r#"{"op":"delegate","slot":"work","agent":"Matcher","skill":"match","#,
            "slot_beside",
            None,
        ),
        (
            r#"{"op":"spawn","slot":"work","agent":"Matcher","skill":"match","#,
            "slot_use",
            Some("spawn"),
        ),
    ] {
        let mut modules = acceptance_modules();
        modules.insert(
            "batch.patterns",
            edited(&module, r#"{"op":"delegate","slot":"work","#, to),
        );
        let r = check_with(&read_text(BATCH).unwrap(), SourceKind::Mdt, Some(&modules));
        assert!(!r.ok);
        assert!(r.expanded.is_none());
        let e1301 = r
            .diagnostics
            .iter()
            .find(|d| d.code == "MDT-E1301")
            .unwrap_or_else(|| panic!("{to}: {:#?}", shown(&r)));
        assert_eq!(e1301.at.path.as_deref(), Some("/defs/MatchInvoices/apply"));
        let fact = |k: &str| {
            e1301
                .facts
                .as_ref()
                .and_then(|f| f.get(k))
                .and_then(JsValue::as_str)
                .map(str::to_owned)
        };
        assert_eq!(fact("problem").as_deref(), Some(problem));
        assert_eq!(fact("slot").as_deref(), Some("work"));
        assert_eq!(fact("use").as_deref(), use_);
        // The agent written beside the slot is named by the body.
        assert!(
            r.diagnostics.iter().any(|d| d.code == "MDT-E1302"
                && d.facts
                    .as_ref()
                    .and_then(|f| f.get("name"))
                    .and_then(JsValue::as_str)
                    == Some("Matcher")),
            "{:#?}",
            shown(&r)
        );
    }
}

/// The module `m.pat` of one pattern `P`, as a caller may hand it over: read
/// and never checked, so that its names need not resolve in it.
fn raw_pattern_module(defs: &str, slots: &str, body: &str, returns: &str) -> Value {
    let text = format!(
        "mandate @ 0.6\n\nmodule m.pat @ 1.0\n\nuse std.{{human, model, fs}}\n\npub type Item = {{ name: Text }}\n\n{defs}\n\n/// The pattern.\npub pattern P({slots}) -> {returns} {{\n  {body}\n}}\n"
    );
    mandate_syntax::load(&text, SourceKind::Mdt)
        .program
        .unwrap()
}

/// A program `app` that applies `P` of `m.pat` (or defines its own, with
/// `uses` without it) as `apply`, with `caps`.
fn applying(uses: &str, defs: &str, apply: &str, caps: &str) -> String {
    format!(
        "mandate @ 0.6\n\nmodule app @ 1.0\n\n{uses}\n\nrole owner \"Owner\"\nrole admin \"Admin\"\n\ncapability Mo = model.infer(tier: standard)\n\nagent A {{\n  role   \"Looks.\"\n  caps   Mo\n  budget {{ tokens: 1000, spend: 1 USD, steps: 5 }}\n  skill look(i: Item) -> Inferred<Text> ! {{Model}}\n}}\n\n{defs}\n\n/// The workflow.\nworkflow W = {apply}\n  caps   {caps}\n  budget {{ tokens: 2000, spend: 2 USD, steps: 10, time: 10m }}\n"
    )
}

const SKILL_SLOT: &str = "work: skill(Item) -> Inferred<Text>";
const USES: &str = "use std.{model, fs, human, tool}\nuse m.pat.{P, Item}";

/// A name in an imported pattern means what it means in the pattern's own
/// module (spec/library.md "Declaration"): one the module does not know is
/// never read as the applying program's. When the program's definition of
/// that name would bring authority into the expansion, the application is
/// refused for it (E1302, as a pattern that names it in its own module is,
/// P03a); otherwise the name is unknown (E0120). Each at the application,
/// with the module and the pattern's own path. A module whose names do not
/// resolve elsewhere gives no pattern either.
#[test]
fn a_name_the_pattern_s_module_does_not_know_is_never_the_applying_program_s() {
    let connector = "/// A store.\nconnector store = mcp(\"https://store.example.com/mcp\")\n  version \"1.0\"\n  class   internal\n{\n  tool list_items() -> Untrusted<List<Item>>\n    read_only\n}\n\ncapability Read = tool.call(store, list_items)";
    let agent_b = "agent B {\n  role   \"Other.\"\n  caps   Mo\n  budget { tokens: 1000, spend: 1 USD, steps: 5 }\n  skill look(i: Item) -> Inferred<Text> ! {Model}\n}";
    let other = "/// Other.\nworkflow Other(i: Item) -> Inferred<Text>\n  caps   Mo\n  budget { tokens: 2000, spend: 2 USD, steps: 10, time: 10m }\n{\n  delegate A.look(i)\n}";
    // (what, module: defs, slots, body, returns; program: defs, apply, caps;
    // the code, `names`, `name`, the place in the module)
    let one = "let i = Item { name: \"a\" }\n  ";
    let rows: [[&str; 12]; 7] = [
        [
            "a capability",
            "",
            SKILL_SLOT,
            "let i = Item { name: \"a\" }\n  delegate work(i) with caps Mo",
            "Inferred<Text>",
            "",
            "P(work: A.look)",
            "Mo",
            "MDT-E1302",
            "capability",
            "Mo",
            "/defs/P/body/1/value/caps/0",
        ],
        [
            "a role",
            "",
            SKILL_SLOT,
            "let i = Item { name: \"a\" }\n  human.approve(\"go?\", role: admin)\n  delegate work(i)",
            "Inferred<Text>",
            "",
            "P(work: A.look)",
            "Mo",
            "MDT-E1302",
            "role",
            "admin",
            "/defs/P/body/1/value/args/1/value",
        ],
        [
            "an agent to degrade to",
            "",
            SKILL_SLOT,
            "let i = Item { name: \"a\" }\n  delegate work(i) supervise degrade(to: B)",
            "Inferred<Text>",
            agent_b,
            "P(work: A.look)",
            "Mo",
            "MDT-E1302",
            "agent",
            "B",
            "/defs/P/body/1/value/supervise/args/0/value",
        ],
        [
            "a workflow",
            "",
            "n: const Int",
            "Other(Item { name: \"a\" })",
            "Inferred<Text>",
            other,
            "P(n: 1)",
            "Mo",
            "MDT-E1302",
            "workflow",
            "Other",
            "/defs/P/body/0/value/callee",
        ],
        [
            "a connector's tool",
            "",
            "n: const Int",
            "store.list_items()",
            "Untrusted<List<Item>>",
            connector,
            "P(n: 1)",
            "Read",
            "MDT-E1302",
            "connector",
            "store",
            "/defs/P/body/0/value/callee/of",
        ],
        [
            "a type",
            "",
            "n: const Int",
            "let x: Extra = n\n  n",
            "Int",
            "type Extra = Int",
            "P(n: 1)",
            "Mo",
            "MDT-E0120",
            "",
            "Extra",
            "/defs/P/body/0/type/ref",
        ],
        // A supervision strategy after `on error`, which the module reads as
        // one, and which the program would read as its own constant.
        [
            "a strategy the program names otherwise",
            "",
            "n: const Int",
            "let x = n\n  on error(Timeout) => restart\n  x",
            "Int",
            "let restart: Int = 1",
            "P(n: 1)",
            "Mo",
            "MDT-E0120",
            "",
            "restart",
            "/defs/P/body/1/then",
        ],
    ];
    for [
        what,
        mdefs,
        slots,
        body,
        returns,
        pdefs,
        apply,
        caps,
        code,
        names,
        name,
        at,
    ] in rows
    {
        let mut modules = Modules::new();
        modules.insert("m.pat", raw_pattern_module(mdefs, slots, body, returns));
        let text = applying(USES, pdefs, apply, caps);
        let r = check_with(&text, SourceKind::Mdt, Some(&modules));
        let errors: Vec<String> = r
            .diagnostics
            .iter()
            .filter(|d| d.code.starts_with("MDT-E"))
            .map(|d| format!("{} {}", d.code, d.at.path.as_deref().unwrap_or("")))
            .collect();
        assert_eq!(
            errors,
            [format!("{code} /defs/W/apply")],
            "{what}: {:#?}",
            shown(&r)
        );
        let d = r.diagnostics.iter().find(|d| d.code == code).unwrap();
        let fact = |k: &str| {
            d.facts
                .as_ref()
                .and_then(|f| f.get(k))
                .and_then(JsValue::as_str)
                .map(str::to_owned)
        };
        assert_eq!(fact("module").as_deref(), Some("m.pat"), "{what}");
        assert_eq!(fact("name").as_deref(), Some(name), "{what}");
        assert_eq!(fact("pattern_path").as_deref(), Some(at), "{what}");
        if !names.is_empty() {
            assert_eq!(fact("names").as_deref(), Some(names), "{what}");
        }
        assert!(r.expanded.is_none(), "{what}");
    }
    // The same capability named by a pattern of the program's own: E1302 at
    // the pattern (P03a).
    let local = applying(
        "use std.{model, fs, human}",
        &format!(
            "type Item = {{ name: Text }}\n\n/// The pattern.\npattern P({SKILL_SLOT}) -> Inferred<Text> {{\n  {one}delegate work(i) with caps Mo\n}}"
        ),
        "P(work: A.look)",
        "Mo",
    );
    let r = check_with(&local, SourceKind::Mdt, None);
    let errors: Vec<String> = r
        .diagnostics
        .iter()
        .filter(|d| d.code.starts_with("MDT-E"))
        .map(|d| format!("{} {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(errors, ["MDT-E1302 /defs/P/body/1/value/caps/0"]);
    // A module one of whose other definitions names nothing it knows: its
    // pattern is not applied.
    let mut modules = Modules::new();
    modules.insert(
        "m.pat",
        raw_pattern_module(
            "/// Broken.\nfn broken() -> Int ! {} {\n  nothing\n}",
            "n: const Int",
            "n",
            "Int",
        ),
    );
    let r = check_with(
        &applying(USES, "", "P(n: 1)", "Mo"),
        SourceKind::Mdt,
        Some(&modules),
    );
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code.starts_with("MDT-E"))
        .unwrap();
    assert_eq!(d.code, "MDT-E0120", "{:#?}", shown(&r));
    assert_eq!(d.at.path.as_deref(), Some("/defs/W/apply"));
    let module_path = d
        .facts
        .as_ref()
        .and_then(|f| f.get("module_path"))
        .and_then(JsValue::as_str);
    assert_eq!(module_path, Some("/defs/broken/body/0/value"));
    assert!(r.expanded.is_none());
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

/// An application written the same before and after may still apply
/// another pattern: one its name means now (the program's own rather than a
/// module's, another module's), or one whose argument names a constant
/// whose value changed (a map's bound read from it). Each is a governance
/// change (`application_changed`, at the application), and the diff does
/// not say the external effects are unchanged when it cannot know them.
#[test]
fn an_application_written_the_same_that_means_another_is_a_governance_change() {
    let ir = |t: &str| mandate_syntax::load(t, SourceKind::Mdt).program.unwrap();
    let kinds = |before: &str, after: &str| -> Vec<String> {
        mandate_check::governance_changes(&ir(before), &ir(after), None)
            .iter()
            .map(|c| format!("{} {}", c.kind.as_str(), c.path))
            .collect()
    };
    // A constant an argument names, raised.
    let p02 = read_text("conformance/P02/program.mdt").unwrap();
    let with_n = |n: u32| {
        p02.replace("max_items: 60", "max_items: N")
            .replace("type DraftId", &format!("let N: Int = {n}\n\ntype DraftId"))
    };
    assert_eq!(
        kinds(&with_n(60), &with_n(6000)),
        ["application_changed /defs/MatchAll/apply"]
    );
    assert!(kinds(&with_n(60), &with_n(60)).is_empty());
    // The pattern a module gave, now the program's own.
    let imported = applying(USES, "", "P(work: A.look)", "Mo");
    let local = applying(
        "use std.{model, fs, human}",
        &format!(
            "type Item = {{ name: Text }}\n\n/// Now local.\npattern P({SKILL_SLOT}) -> Inferred<Text> {{\n  let i = Item {{ name: \"b\" }}\n  delegate work(i)\n}}"
        ),
        "P(work: A.look)",
        "Mo",
    );
    assert_eq!(
        kinds(&imported, &local),
        ["application_changed /defs/W/apply"]
    );
    assert_eq!(
        kinds(&local, &imported),
        [
            "application_changed /defs/P",
            "application_changed /defs/W/apply"
        ]
    );
    // Another module's.
    let elsewhere = applying(
        "use std.{model, fs, human, tool}\nuse evil.pat.{P, Item}",
        "",
        "P(work: A.look)",
        "Mo",
    );
    assert_eq!(
        kinds(&imported, &elsewhere),
        ["application_changed /defs/W/apply"]
    );
    let diff = mandate_check::semantic_diff(&ir(&imported), &ir(&elsewhere), None);
    assert!(
        !diff
            .unchanged
            .iter()
            .any(|u| u.starts_with("external effects unchanged")),
        "{:?}",
        diff.unchanged
    );
    // The same module, pinned by the locks to another hash.
    let lock = |hash: &str| {
        mandate_ir::parse(&format!(r#"{{"modules":{{"m.pat":"sha256:{hash}"}}}}"#))
            .unwrap()
            .value
    };
    let (a, b) = (lock(&"a".repeat(64)), lock(&"b".repeat(64)));
    let same = ir(&imported);
    let diff = mandate_check::semantic_diff(
        &same,
        &same,
        Some(mandate_check::Locks {
            before: Some(&a),
            after: Some(&b),
        }),
    );
    let lines: Vec<String> = diff
        .governance
        .iter()
        .map(|c| format!("{} {}", c.path, c.text))
        .collect();
    assert_eq!(
        lines,
        ["/defs/W/apply ~ W: P comes from module m.pat, which the lock pins to another hash"]
    );
    assert!(
        !diff
            .unchanged
            .iter()
            .any(|u| u.starts_with("external effects unchanged"))
    );
    let diff = mandate_check::semantic_diff(
        &same,
        &same,
        Some(mandate_check::Locks {
            before: Some(&a),
            after: Some(&a),
        }),
    );
    assert!(diff.governance.is_empty());
    assert!(
        diff.unchanged
            .iter()
            .any(|u| u.starts_with("external effects unchanged"))
    );
}
