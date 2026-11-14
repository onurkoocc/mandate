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
