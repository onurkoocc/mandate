//! `shapes` in an envelope (language 0.6, spec/library.md "`shapes`"),
//! where a conformance case cannot say it: the shape an admitted
//! sub-program's result names, a result that is what it was for a parent
//! without shapes, the hash of a program that lists them, the semantic diff
//! and a patch's governance of a change to them, and the fixtures of
//! `fixtures/library/migrate-all.*`. No TypeScript reads 0.6, so every
//! expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::shapes::Shape;
use mandate_check::{
    AmendmentInput, CheckOptions, CheckResult, DataClass, GovernanceChangeKind, PatchOp, Room,
    SubprogramCheck, SubprogramInput, check, check_amendment, check_subprogram, envelope_changes,
    governance_changes, semantic_diff, skeleton,
};
use mandate_ir::{JsValue, Value, canonicalize, hash_program};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{read_json, read_text};

const MIGRATE: &str = "fixtures/library/migrate-all.mdt";
const MIGRATE_LOCK: &str = "fixtures/library/migrate-all.lock.json";
const FAN_OUT: &str = "fixtures/library/migrate-all.plans/fan-out.mdt";
const WRITTEN_OUT: &str = "fixtures/library/migrate-all.plans/written-out.mdt";
const SHAPED: &str = "conformance/N11/parent.mdt";
const UNSHAPED: &str = "conformance/P06/parent.mdt";

fn check_text(text: &str, lock: Option<&Value>) -> CheckResult {
    check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            lock,
            ..CheckOptions::default()
        },
    )
}

/// `code at path` of each diagnostic.
fn shown(diagnostics: &[mandate_ir::Diagnostic]) -> Vec<String> {
    diagnostics
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// The program `text` reads to, checked clean.
fn program_of(text: &str) -> Value {
    let r = check_text(text, None);
    assert!(r.ok, "{:#?}", r.diagnostics);
    r.program.unwrap()
}

/// One `add` for each definition of the module `text` (definitions alone
/// are given a header of 0.6), in order.
fn ops_of(text: &str) -> Vec<PatchOp> {
    let text = if text.contains("mandate @") {
        text.to_owned()
    } else {
        format!("mandate @ 0.6\n\nmodule example.sub @ 0.1\n\n{text}")
    };
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

/// Room enough for every sub-program here.
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

/// `check_subprogram` of the definitions of `text` as sub-program `number`
/// of `workflow` of `parent`.
fn sub_check(parent: &Value, workflow: &str, number: f64, text: &str) -> SubprogramCheck {
    let module = parent.get("module").and_then(Value::as_str).unwrap();
    let language = mandate_check::language_of(parent);
    let base = hash_program(&skeleton(module, number, language)).program;
    check_subprogram(&SubprogramInput {
        parent,
        modules: None,
        workflow,
        number,
        base: &base,
        ops: &ops_of(text),
        lead: DataClass::Public,
        room: &room(),
    })
    .unwrap()
}

/// The text of `parent` without its envelope's `shapes` line.
fn without_shapes(text: &str) -> String {
    text.lines()
        .filter(|l| !l.trim_start().starts_with("shapes "))
        .map(|l| format!("{l}\n"))
        .collect()
}

const EACH: &str = "workflow Look = Each(work: Worker.look, width: 2)\n  caps   M, R\n  budget { tokens: 2000, time: 10m, spend: 2 USD, steps: 10, agents: 2 }\n";

#[test]
fn the_shaped_migration_checks_alone_and_with_its_lock() {
    let text = read_text(MIGRATE).unwrap();
    let alone = check_text(&text, None);
    assert!(alone.ok, "{:#?}", shown(&alone.diagnostics));
    let lock = read_json(MIGRATE_LOCK).unwrap();
    let locked = check_text(&text, Some(&lock));
    assert!(locked.ok, "{:#?}", shown(&locked.diagnostics));
    let program = alone.program.unwrap();
    assert_eq!(
        program
            .get("defs")
            .and_then(|d| d.get("MigrateAll"))
            .and_then(|w| w.get("envelope"))
            .and_then(|e| e.get("shapes"))
            .map(canonicalize)
            .as_deref(),
        Some(r#"["FanOutMerge","MakerChecker"]"#)
    );
    // The program hash covers the shapes: without them, or with one, it is
    // another program; written in another order, the same.
    let hash = |t: &str| check_text(t, None).hashes.unwrap().program;
    let h = hash(&text);
    assert_ne!(h, hash(&without_shapes(&text)));
    assert_ne!(
        h,
        hash(&text.replace("[FanOutMerge, MakerChecker]", "[FanOutMerge]"))
    );
    assert_eq!(
        h,
        hash(&text.replace("[FanOutMerge, MakerChecker]", "[MakerChecker, FanOutMerge]"))
    );
}

#[test]
fn a_listed_shape_with_a_run_parameter_is_refused_as_a_workflow_with_parameters() {
    let parent = program_of(&read_text(MIGRATE).unwrap());
    let r = sub_check(&parent, "MigrateAll", 1.0, &read_text(FAN_OUT).unwrap());
    assert_eq!(shown(&r.diagnostics), ["MDT-E1705 at /defs/Rest/apply"]);
    assert!(!r.ok && r.shape.is_none());
}

#[test]
fn a_workflow_written_out_is_no_shape_and_would_be_admitted_without_them() {
    let text = read_text(MIGRATE).unwrap();
    let sub = read_text(WRITTEN_OUT).unwrap();
    let r = sub_check(&program_of(&text), "MigrateAll", 2.0, &sub);
    assert_eq!(shown(&r.diagnostics), ["MDT-E1710 at /defs/Rest"]);
    let facts = JsValue::Object(r.diagnostics[0].facts.clone().unwrap());
    assert_eq!(
        mandate_ir::stringify(&facts).unwrap(),
        r#"{"workflow":"Rest","problem":"not_an_application","shapes":["FanOutMerge","MakerChecker"]}"#
    );
    // E1710 is the one reason: the same sub-program under the envelope
    // without shapes is admitted, with no shape.
    let r = sub_check(&program_of(&without_shapes(&text)), "MigrateAll", 2.0, &sub);
    assert!(r.ok, "{:#?}", shown(&r.diagnostics));
    assert!(r.shape.is_none());
}

#[test]
fn an_admitted_sub_program_names_the_shape_it_applies() {
    let parent = program_of(&read_text(SHAPED).unwrap());
    let r = sub_check(&parent, "Run", 1.0, EACH);
    assert!(r.ok, "{:#?}", shown(&r.diagnostics));
    assert_eq!(
        r.shape,
        Some(Shape {
            pattern: "Each".to_owned(),
            module: "example.shaped".to_owned(),
        })
    );
    let js = mandate_ir::stringify(&r.to_js()).unwrap();
    assert!(
        js.ends_with(r#","workflow":"Look","shape":{"pattern":"Each","module":"example.shaped"}}"#),
        "{js}"
    );
    // Without shapes the result has no `shape` member, as before 0.6.
    let unshaped = program_of(&read_text(UNSHAPED).unwrap());
    let r = sub_check(&unshaped, "Run", 1.0, EACH);
    assert!(r.ok, "{:#?}", shown(&r.diagnostics));
    assert!(r.shape.is_none());
    let js = mandate_ir::stringify(&r.to_js()).unwrap();
    assert!(!js.contains("\"shape\""), "{js}");
}

#[test]
fn a_pattern_of_its_own_under_a_listed_name_is_not_the_shape() {
    let parent = program_of(&read_text(SHAPED).unwrap());
    // A pattern of its own is no definition a sub-program may make.
    let own = format!(
        "pattern Each(work: skill(Item) -> Inferred<Text>, width: const Int) -> List<Outcome<Inferred<Text>>> {{\n  let items = [Item {{ name: \"a\" }}]\n  map i in items max 1 par width {{\n    delegate work(i)\n  }}\n}}\n\n{EACH}"
    );
    let r = sub_check(&parent, "Run", 1.0, &own);
    assert_eq!(shown(&r.diagnostics), ["MDT-E1705 at /defs/Each"]);
    // A definition of another kind under the listed name is the
    // sub-program's own, not the parent's pattern.
    let typed = format!("type Each = {{ name: Text }}\n\n{EACH}");
    let r = sub_check(&parent, "Run", 1.0, &typed);
    assert_eq!(
        shown(&r.diagnostics),
        ["MDT-E1710 at /defs/Look/apply/pattern"]
    );
    let facts = r.diagnostics[0].facts.as_ref().unwrap();
    assert_eq!(
        facts.get("problem").and_then(JsValue::as_str),
        Some("other_definition")
    );
    assert_eq!(
        facts.get("module").and_then(JsValue::as_str),
        Some("example.shaped.plan_1")
    );
    assert_eq!(
        facts.get("shape_module").and_then(JsValue::as_str),
        Some("example.shaped")
    );
}

#[test]
fn the_shape_check_comes_after_what_a_sub_program_may_define() {
    let parent = program_of(&read_text(SHAPED).unwrap());
    let written = "role helper \"Helper\"\n\nworkflow Look() -> Inferred<Text>\n  caps   M, R\n  budget { tokens: 2000, time: 10m, spend: 2 USD, steps: 10, agents: 2 }\n{\n  delegate Worker.look(Item { name: \"a\" })\n}\n";
    let r = sub_check(&parent, "Run", 1.0, written);
    assert_eq!(shown(&r.diagnostics), ["MDT-E1705 at /defs/helper"]);
}

/// The envelope of `workflow` of `program`, edited by `f`.
fn amended(program: &Value, workflow: &str, f: impl FnOnce(&mut mandate_ir::Map)) -> Value {
    let mut envelope = program
        .get("defs")
        .and_then(|d| d.get(workflow))
        .and_then(|w| w.get("envelope"))
        .and_then(Value::as_object)
        .unwrap()
        .clone();
    f(&mut envelope);
    Value::Object(envelope)
}

fn amendment(parent: &Value, envelope: &Value) -> Vec<String> {
    let r = check_amendment(&AmendmentInput {
        parent,
        modules: None,
        workflow: "Run",
        envelope: Some(envelope),
    })
    .unwrap();
    assert_eq!(r.ok, r.diagnostics.is_empty());
    r.diagnostics
        .iter()
        .map(|d| {
            format!(
                "{} at {} {}",
                d.code,
                d.at.path.as_deref().unwrap_or(""),
                mandate_ir::stringify(&JsValue::Object(d.facts.clone().unwrap())).unwrap()
            )
        })
        .collect()
}

fn names(xs: &[&str]) -> Value {
    Value::Array(xs.iter().map(|x| Value::from(*x)).collect())
}

#[test]
fn an_amendment_keeps_every_shape_and_adds_no_list() {
    let shaped = program_of(&read_text(SHAPED).unwrap());
    // Each shape left out is one E1709.
    let one = amended(&shaped, "Run", |e| {
        e.insert("shapes", names(&["Each"]));
    });
    assert_eq!(
        amendment(&shaped, &one),
        [
            r#"MDT-E1709 at /defs/Run/envelope/shapes {"dimension":"shapes","shape":"FanOutMerge","was":["Each","FanOutMerge"],"asked":["Each"]}"#
        ]
    );
    // One more shape, or none at all, widens.
    let more = amended(&shaped, "Run", |e| {
        e.insert("shapes", names(&["Each", "FanOutMerge", "Spare"]));
    });
    assert_eq!(amendment(&shaped, &more), Vec::<String>::new());
    let any = amended(&shaped, "Run", |e| {
        e.remove("shapes");
    });
    assert_eq!(amendment(&shaped, &any), Vec::<String>::new());
    // A shape of the amendment is held to being a pattern, as any program's.
    let typed = amended(&shaped, "Run", |e| {
        e.insert("shapes", names(&["Each", "FanOutMerge", "Item"]));
    });
    assert_eq!(
        amendment(&shaped, &typed),
        [
            r#"MDT-E1711 at /defs/Run/envelope/shapes/2 {"workflow":"Run","shape":"Item","kind":"type"}"#
        ]
    );
    // A list where there was none narrows.
    let unshaped = program_of(&read_text(UNSHAPED).unwrap());
    let listed = amended(&unshaped, "Run", |e| {
        e.insert("shapes", names(&["Each"]));
    });
    assert_eq!(
        amendment(&unshaped, &listed),
        [
            r#"MDT-E1709 at /defs/Run/envelope/shapes {"dimension":"shapes","was":null,"asked":["Each"]}"#
        ]
    );
}

#[test]
fn a_shape_is_a_pattern_of_the_program_or_one_it_imports() {
    let text = read_text(SHAPED).unwrap();
    let with = |shapes: &str| {
        let r = check_text(&text.replace("[FanOutMerge, Each]", shapes), None);
        r.diagnostics
            .iter()
            .map(|d| {
                format!(
                    "{} at {} {}",
                    d.code,
                    d.at.path.as_deref().unwrap_or(""),
                    mandate_ir::stringify(&JsValue::Object(d.facts.clone().unwrap())).unwrap()
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(with("[Spare]"), Vec::<String>::new());
    assert_eq!(
        with("[Each, Batch, Nothing, Worker]"),
        [
            r#"MDT-E1711 at /defs/Run/envelope/shapes/0 {"workflow":"Run","shape":"Batch","kind":"type","module":"std.patterns"}"#,
            r#"MDT-E1711 at /defs/Run/envelope/shapes/2 {"workflow":"Run","shape":"Nothing","kind":null}"#,
            r#"MDT-E1711 at /defs/Run/envelope/shapes/3 {"workflow":"Run","shape":"Worker","kind":"agent"}"#,
        ]
    );
    // A pattern of std.patterns the program does not import is no name.
    assert_eq!(
        with("[MakerChecker]"),
        [
            r#"MDT-E1711 at /defs/Run/envelope/shapes/0 {"workflow":"Run","shape":"MakerChecker","kind":null}"#
        ]
    );
}

#[test]
fn a_change_of_shapes_is_a_governance_change() {
    let text = read_text(MIGRATE).unwrap();
    let before = program_of(&text);
    let after = program_of(&text.replace("[FanOutMerge, MakerChecker]", "[FanOutMerge]"));
    let changes = governance_changes(&before, &after, None);
    let kinds: Vec<(GovernanceChangeKind, String)> =
        changes.iter().map(|c| (c.kind, c.path.clone())).collect();
    assert_eq!(
        kinds,
        [(
            GovernanceChangeKind::EnvelopeChanged,
            "/defs/MigrateAll/envelope".to_owned()
        )]
    );
    let diff = mandate_ir::stringify(&semantic_diff(&before, &after, None).to_js()).unwrap();
    assert!(diff.contains("~ MigrateAll: envelope changed"), "{diff}");
    let lines = |b: &Value, a: &Value| -> Vec<String> {
        envelope_changes(b, a, "MigrateAll", None)
            .iter()
            .map(|c| format!("{} {}", c.path, c.text))
            .collect()
    };
    assert_eq!(
        lines(&before, &after),
        ["/defs/MigrateAll/envelope/shapes - MigrateAll.envelope.shapes: MakerChecker"]
    );
    assert_eq!(
        lines(&after, &before),
        ["/defs/MigrateAll/envelope/shapes + MigrateAll.envelope.shapes: MakerChecker"]
    );
    let none = program_of(&without_shapes(&text));
    assert_eq!(
        lines(&none, &before),
        [
            "/defs/MigrateAll/envelope/shapes ~ MigrateAll.envelope.shapes: any workflow → FanOutMerge, MakerChecker"
        ]
    );
    assert_eq!(
        lines(&before, &none),
        [
            "/defs/MigrateAll/envelope/shapes ~ MigrateAll.envelope.shapes: FanOutMerge, MakerChecker → any workflow"
        ]
    );
    // A patch that changes them reports the same governance change.
    let base = hash_program(&before).program;
    let std_patterns =
        mandate_check::library::with_builtin(mandate_ir::Program::of(&before).unwrap(), None);
    let patched = mandate_check::apply_patch(
        &before,
        &base,
        &[PatchOp {
            op: "remove".to_owned(),
            path: "/defs/MigrateAll/envelope/shapes/1".to_owned(),
            value: None,
        }],
        std_patterns.as_ref(),
    );
    assert!(patched.ok, "{:?}", patched.diagnostics);
    assert_eq!(
        patched
            .governance
            .iter()
            .map(|g| g.kind)
            .collect::<Vec<_>>(),
        [GovernanceChangeKind::EnvelopeChanged]
    );
}

#[test]
fn before_0_6_an_envelope_has_no_shapes() {
    let text = read_text(SHAPED).unwrap();
    // The IR of a program of 0.5 with shapes is refused at the member.
    let ir = program_of(&text);
    let mut old = ir.as_object().unwrap().clone();
    old.insert("language", "mandate/0.5");
    let old = mandate_ir::stringify(&JsValue::from(&Value::Object(old))).unwrap();
    let r = check(&old, SourceKind::Json, &CheckOptions::default());
    assert!(
        shown(&r.diagnostics).contains(&"MDT-E0104 at /defs/Run/envelope/shapes".to_owned()),
        "{:#?}",
        shown(&r.diagnostics)
    );
}
