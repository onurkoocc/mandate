//! What language 0.6 adds to the checks so far (spec/library.md "The 0.6
//! surface"), where a conformance case cannot say it: a case's modules must
//! load, so the modules given to a check are held here (`load_modules`); and
//! the doors that stand on the checks (`apply_patch`, `check_subprogram`,
//! `semantic_diff`, `governance_changes`, `explain`, `codes`). No TypeScript
//! reads 0.6, so every expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{
    CheckOptions, ModuleSource, Modules, check, governance_changes, json_doors, load_modules,
    semantic_diff,
};
use mandate_ir::codes::{self, Reference};
use mandate_ir::{JsValue, Value, hash_program, parse};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::read_text;

/// The module `example.library.types` of the conformance cases: `pub`
/// `Invoice` and `LIMIT`, and `Note` and `SECRET`, which are not `pub`.
fn types_text() -> String {
    read_text("conformance/E1602/types.mdt").unwrap()
}

/// Modules loaded together, each checked against the others: the modules
/// that loaded, and for each one that did not, its file and codes.
fn loaded(sources: &[(&str, &str)]) -> (Modules, Vec<(String, Vec<String>)>) {
    let sources: Vec<ModuleSource<'_>> = sources
        .iter()
        .map(|(file, text)| ModuleSource {
            text,
            kind: SourceKind::Mdt,
            file,
        })
        .collect();
    let r = load_modules(&sources);
    let problems = r
        .problems
        .iter()
        .map(|p| {
            (
                p.file.clone(),
                p.diagnostics.iter().map(|d| d.code.clone()).collect(),
            )
        })
        .collect();
    (r.modules, problems)
}

/// `code at path` of every diagnostic of `check` of `text` with `modules`.
fn checked(text: &str, modules: &Modules) -> Vec<String> {
    let r = check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            modules: Some(modules),
            ..CheckOptions::default()
        },
    );
    r.diagnostics
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

const OLDER_REPORT: &str = "mandate @ 0.5

module example.older.report @ 0.1

use example.library.types.{Invoice}

type Report = { invoice: Invoice }
";

const NEWER_REPORT: &str = "mandate @ 0.6

module example.library.report @ 0.1

use example.library.types.{Invoice}
use example.library.ledger.{Entry}

type Report = { invoice: Invoice }
";

#[test]
fn a_module_given_to_a_check_is_held_to_the_rules_of_its_own_version() {
    let types = types_text();
    // A module of 0.5 that imports a module of 0.6 does not load (E1603);
    // one of 0.6 that imports a module nobody gave does not either (E1604).
    let (modules, problems) = loaded(&[
        ("types.mdt", &types),
        ("older.mdt", OLDER_REPORT),
        ("newer.mdt", NEWER_REPORT),
    ]);
    assert_eq!(
        problems,
        vec![
            ("older.mdt".to_owned(), vec!["MDT-E1603".to_owned()]),
            ("newer.mdt".to_owned(), vec!["MDT-E1604".to_owned()]),
        ]
    );
    assert!(modules.contains_key("example.library.types"));
    // Given the module it imports, the module of 0.6 loads.
    let ledger =
        "mandate @ 0.5\n\nmodule example.library.ledger @ 0.1\n\ntype Entry = { at: Text }\n";
    let (_, problems) = loaded(&[
        ("types.mdt", &types),
        ("ledger.mdt", ledger),
        ("newer.mdt", NEWER_REPORT),
    ]);
    assert_eq!(problems, Vec::new());
}

#[test]
fn an_older_program_names_every_definition_of_an_older_module() {
    // Neither is 0.6: nothing is pub, everything may be named, and an
    // import of a module that is not loaded is taken on trust, as before.
    let domain = "mandate @ 0.5\n\nmodule example.older.domain @ 0.1\n\ntype Ticket = { id: Text }\n\nlet MAX: Int = 3\n";
    let (modules, problems) = loaded(&[("domain.mdt", domain)]);
    assert!(problems.is_empty());
    let program = "mandate @ 0.5\n\nmodule example.older.reader @ 0.1\n\nuse example.older.domain.{Ticket, MAX}\nuse example.older.unknown.{Mystery}\n\ntype Pair = { t: Ticket, m: Mystery }\n\nlet MOST: Int = MAX\n";
    assert_eq!(checked(program, &modules), Vec::<String>::new());
    // The same program in 0.6: the module it was not given is E1604, and
    // the older module's definitions may still be named.
    let newer = program.replace("mandate @ 0.5", "mandate @ 0.6");
    assert_eq!(checked(&newer, &modules), vec!["MDT-E1604 at /uses/1"]);
}

/// The JSON door `name` called with `input`.
fn door(name: &str, input: &str) -> JsValue {
    let d = json_doors::door(name).expect(name);
    (d.call)(&parse(input).unwrap().value).unwrap_or_else(|e| panic!("{name}: {e:?}"))
}

fn ir(text: &str) -> Value {
    load(text, SourceKind::Mdt).program.expect("a program")
}

fn json(v: &Value) -> String {
    mandate_ir::canonicalize(v)
}

#[test]
fn a_patch_is_held_to_the_visibility_of_the_modules_it_is_given() {
    let types = ir(&types_text());
    let program = ir(&read_text("conformance/E1602/program.mdt").unwrap());
    let base = hash_program(&program).program;
    let input = |names: &str| {
        format!(
            r#"{{"program":{},"base":"{base}","ops":[{{"op":"replace","path":"/uses/0/names","value":{names}}}],"modules":{{"example.library.types":{}}}}}"#,
            json(&program),
            json(&types)
        )
    };
    let refused = door("apply_patch", &input(r#"["Invoice","Note"]"#));
    let codes: Vec<&str> = refused
        .get("diagnostics")
        .and_then(JsValue::as_array)
        .unwrap()
        .iter()
        .filter_map(|d| d.get("code").and_then(JsValue::as_str))
        .collect();
    assert_eq!(codes, vec!["MDT-E1602"]);
    assert_eq!(refused.get("ok").and_then(JsValue::as_bool), Some(false));
    let taken = door("apply_patch", &input(r#"["Invoice","LIMIT"]"#));
    assert_eq!(taken.get("ok").and_then(JsValue::as_bool), Some(true));
}

#[test]
fn a_sub_program_names_every_definition_of_its_parent() {
    // The parent of the sub-program cases, in 0.6: none of its definitions
    // is pub, and its lead's sub-program names them all.
    let parent_text = read_text("fixtures/envelope/migrate-all.mdt")
        .unwrap()
        .replace("mandate @ 0.4", "mandate @ 0.6");
    let parent = ir(&parent_text);
    assert!(
        parent
            .get("defs")
            .and_then(Value::as_object)
            .unwrap()
            .iter()
            .all(|(_, d)| d.get("pub").is_none()),
        "no definition of the parent is pub"
    );
    let domain = ir(&read_text("fixtures/envelope/domain.mdt").unwrap());
    let skeleton = door(
        "skeleton",
        r#"{"parent":"company.migrations","n":1,"language":"mandate/0.6"}"#,
    );
    let skeleton = parse(&mandate_ir::stringify(&skeleton).unwrap())
        .unwrap()
        .value;
    let base = hash_program(&skeleton).program;
    let ops = r#"[{"op":"add","path":"/defs/Wa","value":{"kind":"capability","value":{"op":"call","callee":{"op":"field","of":{"op":"var","name":"SrcWrite"},"name":"narrow"},"args":[{"value":{"op":"text","value":"/work/repos/a"}}]}}},{"op":"add","path":"/defs/Finish","value":{"kind":"workflow","params":[],"returns":{"ref":"Inferred","args":[{"ref":"Summary"}]},"caps":[{"op":"var","name":"Build"},{"op":"var","name":"ModelStd"},{"op":"var","name":"RepoRead"},{"op":"var","name":"Wa"}],"body":[{"op":"expr","value":{"op":"delegate","agent":"Migrator","skill":"migrate","args":[{"value":{"op":"record","type":"Repo","fields":{"name":{"op":"text","value":"a"},"root":{"op":"text","value":"a"}}}}],"caps":[{"op":"var","name":"Build"},{"op":"var","name":"ModelStd"},{"op":"var","name":"RepoRead"},{"op":"var","name":"Wa"}]}}],"budget":{"tokens":500000,"time":{"ms":1800000},"spend":{"micros":1000000,"currency":"USD"},"steps":20,"agents":2}}}]"#;
    let input = format!(
        r#"{{"i":{{"parent":{},"modules":{{"company.domain":{}}},"workflow":"MigrateAll","number":1,"base":"{base}","ops":{ops},"lead":"internal","room":{{"left":{{"tokens":50000000,"steps":1000,"agents":100,"spend:USD":100000000}},"time_left_ms":3600000,"writes":[]}}}}}}"#,
        json(&parent),
        json(&domain)
    );
    let out = door("check_subprogram", &input);
    assert_eq!(
        out.get("ok").and_then(JsValue::as_bool),
        Some(true),
        "{}",
        mandate_ir::stringify(&out).unwrap_or_default()
    );
}

#[test]
fn a_changed_doc_is_a_behavior_change_and_never_a_governance_one() {
    let before = ir(&read_text("conformance/P01/module.mdt").unwrap());
    let mut after = before.clone();
    let set_doc = |p: &mut Value, name: &str, doc: &str| {
        if let Value::Object(program) = p
            && let Some(Value::Object(defs)) = program.get_mut("defs")
            && let Some(Value::Object(d)) = defs.get_mut(name)
        {
            d.insert("doc", doc);
        }
    };
    // A doc changed on a capability, a type and a workflow, and one added
    // where there was none.
    set_doc(&mut after, "LedgerRead", "Reading the ledger.");
    set_doc(&mut after, "Invoice", "An invoice, in cents.");
    set_doc(&mut after, "Summarize", "Summarizes.");
    set_doc(&mut after, "ModelStd", "The model.");
    let view = semantic_diff(&before, &after, None);
    assert!(view.governance.is_empty(), "{:?}", view.governance);
    let behavior: Vec<(&str, &str)> = view
        .behavior
        .iter()
        .map(|c| (c.path.as_str(), c.text.as_str()))
        .collect();
    assert_eq!(
        behavior,
        vec![
            ("/defs/Invoice/doc", "~ type Invoice: doc changed"),
            (
                "/defs/LedgerRead/doc",
                "~ capability LedgerRead: doc changed"
            ),
            ("/defs/ModelStd/doc", "~ capability ModelStd: doc changed"),
            ("/defs/Summarize/doc", "~ workflow Summarize: doc changed"),
        ]
    );
    assert!(governance_changes(&before, &after, None).is_empty());
    // With the doc, a change that is one is still one.
    if let Value::Object(program) = &mut after
        && let Some(Value::Object(defs)) = program.get_mut("defs")
        && let Some(Value::Object(d)) = defs.get_mut("Summarize")
    {
        d.insert("caps", Value::Array(Vec::new()));
    }
    let view = semantic_diff(&before, &after, None);
    assert!(view.governance.is_empty());
    assert!(
        view.behavior
            .iter()
            .any(|c| c.text.contains("Summarize") && c.text.contains("narrowed")),
        "{:?}",
        view.behavior
    );
}

#[test]
fn the_codes_of_0_6_are_explained_and_come_last_in_the_table() {
    let rust: Vec<&codes::CodeRow> = codes::iter()
        .filter(|r| r.reference == Reference::Rust)
        .collect();
    assert_eq!(
        rust.iter().map(|r| r.code).collect::<Vec<_>>(),
        vec!["MDT-E1602", "MDT-E1603", "MDT-E1604"]
    );
    for row in &rust {
        let bare = row.code.strip_prefix("MDT-").unwrap();
        let out = door("explain", &format!(r#"{{"code":"{bare}"}}"#));
        assert_eq!(out.get("code").and_then(JsValue::as_str), Some(row.code));
        assert_eq!(out.get("title").and_then(JsValue::as_str), Some(row.title));
        assert_eq!(
            out.get("explain").and_then(JsValue::as_str),
            Some(row.explain)
        );
    }
    let table = door("codes", "{}");
    let keys: Vec<&str> = table.as_object().unwrap().keys().collect();
    let all: Vec<&str> = codes::iter().map(|r| r.code).collect();
    assert_eq!(keys, all, "every row, in the table's order");
    assert_eq!(
        &keys[keys.len().saturating_sub(rust.len())..],
        ["MDT-E1602", "MDT-E1603", "MDT-E1604"]
    );
}

/// A module of `language` for the module-path tests: a record, a record
/// with a model's output in it, a constant, a lower-case constant and a
/// capability, all `pub` (in 0.5, the same without `pub`).
fn order_module(language: &str) -> String {
    let p = if language == "0.6" { "pub " } else { "" };
    format!(
        "mandate @ {language}

module example.library.order @ 1.0

use std.{{model}}

{p}type Order = {{ order_no: Text, total_cents: Int }}

{p}type Draft = {{ issue: Text, text: Inferred<Text> }}

{p}let LIMIT: Int = 100

{p}let limits: Int = 3

{p}capability ModelStd = model.infer(tier: standard, max_class: internal)
"
    )
}

/// A program of `language` with `uses` and the definitions `defs`.
fn order_program(language: &str, uses: &str, defs: &str) -> String {
    format!("mandate @ {language}\n\nmodule example.library.q @ 0.1\n\n{uses}\n\n{defs}\n")
}

/// One program of the module-path tests, in two forms: a name of the module
/// used through the `use` list, and written with the module's path (the
/// `use` without a list, or, for "the full path", the module's whole name
/// after a listed `use`). With what each gives in 0.6: through the list and
/// with the path.
struct ByPath {
    name: &'static str,
    listed_uses: &'static str,
    listed: &'static str,
    path_uses: &'static str,
    by_path: &'static str,
    gives_listed: &'static [&'static str],
    gives_by_path: &'static [&'static str],
}

const EFFECT_LISTED: &str = "capability PR = git.pr(\"company/backend\")\n\nworkflow W(d: Draft) -> Bool\n  caps PR\n{\n  effect git.comment(d.issue, d.text) idempotent_by d.issue\n  true\n}";
const EFFECT_BY_PATH: &str = "capability PR = git.pr(\"company/backend\")\n\nworkflow W(d: order.Draft) -> Bool\n  caps PR\n{\n  effect git.comment(d.issue, d.text) idempotent_by d.issue\n  true\n}";

const BY_PATH: &[ByPath] = &[
    // (a) a name the module does not define, as a type and as a value.
    ByPath {
        name: "a missing type",
        listed_uses: "use example.library.order.{Missing}",
        listed: "type Pair = { o: Missing }",
        path_uses: "use example.library.order",
        by_path: "type Pair = { o: order.Missing }",
        gives_listed: &["MDT-E0120 at /uses/0/names"],
        gives_by_path: &[
            "MDT-E1604 at /uses/0",
            "MDT-E0120 at /defs/Pair/type/record/o/ref",
        ],
    },
    ByPath {
        name: "a missing value",
        listed_uses: "use example.library.order.{MISSING}",
        listed: "let Y: Int = MISSING",
        path_uses: "use example.library.order",
        by_path: "let Y: Int = order.MISSING",
        gives_listed: &["MDT-E0120 at /uses/0/names"],
        gives_by_path: &["MDT-E1604 at /uses/0", "MDT-E0120 at /defs/Y/value/of"],
    },
    // (b) a parameter of type Order whose Int field is returned as Text, and
    // a field it does not have.
    ByPath {
        name: "an Int as Text",
        listed_uses: "use example.library.order.{Order}",
        listed: "fn label(o: Order) -> Text ! {} {\n  o.total_cents\n}",
        path_uses: "use example.library.order",
        by_path: "fn label(o: order.Order) -> Text ! {} {\n  o.total_cents\n}",
        gives_listed: &["MDT-E0201 at /defs/label/body/0/value"],
        gives_by_path: &[
            "MDT-E1604 at /uses/0",
            "MDT-E0120 at /defs/label/params/0/type/ref",
        ],
    },
    ByPath {
        name: "a field it does not have",
        listed_uses: "use example.library.order.{Order}",
        listed: "fn label(o: Order) -> Text ! {} {\n  o.nothing\n}",
        path_uses: "use example.library.order",
        by_path: "fn label(o: order.Order) -> Text ! {} {\n  o.nothing\n}",
        gives_listed: &["MDT-E0202 at /defs/label/body/0/value"],
        gives_by_path: &[
            "MDT-E1604 at /uses/0",
            "MDT-E0120 at /defs/label/params/0/type/ref",
        ],
    },
    // (c) a model's output carried to a critical effect (V01, E0210).
    ByPath {
        name: "a model's output to a critical effect",
        listed_uses: "use std.{git}\nuse example.library.order.{Draft}",
        listed: EFFECT_LISTED,
        path_uses: "use std.{git}\nuse example.library.order",
        by_path: EFFECT_BY_PATH,
        gives_listed: &["MDT-E0210 at /defs/W/body/0/value/args/1/value"],
        gives_by_path: &[
            "MDT-E1604 at /uses/0",
            "MDT-E0120 at /defs/W/params/0/type/ref",
        ],
    },
    // The whole name of a module after a listed `use`, and the bare last
    // segment of a module.
    ByPath {
        name: "the full path",
        listed_uses: "use example.library.order.{Order}",
        listed: "type Pair = { o: Order }",
        path_uses: "use example.library.order.{Order}",
        by_path: "type Pair = { o: example.library.order.Missing }",
        gives_listed: &[],
        gives_by_path: &["MDT-E0120 at /defs/Pair/type/record/o/ref"],
    },
    ByPath {
        name: "the last segment",
        listed_uses: "use example.library.order.{Order}",
        listed: "type Pair = { o: Order }",
        path_uses: "use example.library.order",
        by_path: "type Pair = { o: order }",
        gives_listed: &[],
        gives_by_path: &[
            "MDT-E1604 at /uses/0",
            "MDT-E0120 at /defs/Pair/type/record/o/ref",
        ],
    },
];

/// Before this slice closed it, a program of 0.6 that wrote a name with its
/// module path was given what its `use` list refuses: a definition the
/// module does not have (a), a value of another type (b), and a model's
/// output past the rule that keeps it from a critical effect (c), each with
/// no diagnostic. That is the trust an earlier program gives an import, and
/// 0.6 withdraws it: the path is no name in 0.6, and a `use` without a list
/// is E1604. A program of 0.5 keeps every acceptance: the path is taken on
/// trust, and what the list refuses it refuses as before.
#[test]
fn a_name_written_with_its_module_path_is_no_name_in_0_6() {
    for language in ["0.5", "0.6"] {
        let module = order_module(language);
        let (modules, problems) = loaded(&[("order.mdt", &module)]);
        assert!(problems.is_empty(), "{problems:?}");
        for p in BY_PATH {
            let listed = checked(&order_program(language, p.listed_uses, p.listed), &modules);
            let by_path = checked(&order_program(language, p.path_uses, p.by_path), &modules);
            assert_eq!(
                listed, p.gives_listed,
                "{language} {}: through the list",
                p.name
            );
            let want: &[&str] = if language == "0.6" {
                p.gives_by_path
            } else {
                &[]
            };
            assert_eq!(by_path, want, "{language} {}: with the path", p.name);
        }
    }
}

/// Documents today's behaviour, not a rule: other roads by which a program
/// of 0.6 gets a name of a module it was given with no type the checks can
/// see, which this slice leaves as they are (none is a module path). Each is
/// accepted with no diagnostic, where the same with a definition of the
/// program's own is refused. When one is closed, its line here changes.
#[test]
fn other_roads_to_an_unknown_type_documented_as_they_are() {
    let module = order_module("0.6");
    let (modules, problems) = loaded(&[("order.mdt", &module)]);
    assert!(problems.is_empty(), "{problems:?}");
    for (uses, defs) in [
        // A listed constant used as a type, and as a parameter's type whose
        // field is anything.
        ("use example.library.order.{LIMIT}", "type P = { x: LIMIT }"),
        (
            "use example.library.order.{LIMIT}",
            "fn f(x: LIMIT) -> Int ! {} {\n  x.anything\n}",
        ),
        // A listed capability as a parameter's type.
        (
            "use example.library.order.{ModelStd}",
            "fn f(x: ModelStd) -> Int ! {} {\n  x.anything\n}",
        ),
        // A listed type used as a value.
        ("use example.library.order.{Order}", "let X: Int = Order"),
        // A listed lower-case name, read as a module, used as a path.
        (
            "use example.library.order.{limits}",
            "type P = { x: limits.Anything }",
        ),
        (
            "use example.library.order.{limits}",
            "let X: Int = limits.anything",
        ),
    ] {
        assert_eq!(
            checked(&order_program("0.6", uses, defs), &modules),
            Vec::<String>::new(),
            "{uses} / {defs}"
        );
    }
    // The program's own constant as a type is refused.
    let own = order_program(
        "0.6",
        "use std.{model}",
        "let LIMIT: Int = 3\n\ntype P = { x: LIMIT }",
    );
    assert_eq!(
        checked(&own, &modules),
        vec!["MDT-E0120 at /defs/P/type/record/x/ref"]
    );
}
