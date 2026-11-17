//! Language 0.7 in `mandate-ir`: its schemas and its lock format
//! (spec/attention.md "Version gating", "The IR", "Lock 0.7"). No TypeScript
//! reads 0.7, so nothing here is held to a stored result; each expectation
//! is written by hand.
//!
//! - The schemas the crate embeds are the files in `spec/`, and they differ
//!   from those of 0.6 exactly where the lists below say: in their names and
//!   their version, and in the statements, which 0.7 adds `stage` to. A
//!   slice of 0.7 that adds a construct adds its pointers to the list.
//! - A `stage` is a statement of the 0.7 schema alone, closed, its title a
//!   string of 1 to 80 code points.
//! - Each document is read by the schema of its own version, chosen by the
//!   exact value of its `language` or `lock`, and a document of an earlier
//!   version as before; each schema is closed.
//! - A lock of format 0.7 has every field of 0.6 and is at least every
//!   earlier format.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_ir::{
    IR_0_6_SCHEMA_TEXT, IR_0_7_SCHEMA_TEXT, LOCK_0_6_SCHEMA_TEXT, LOCK_0_7_SCHEMA_TEXT,
    LOCK_FORMAT_0_6, LOCK_FORMAT_0_7, Language, Value, canonicalize, ir_schema, ir_schema_0_6,
    ir_schema_0_7, ir_schema_of, load_json, lock_at_least, lock_schema, lock_schema_0_6,
    lock_schema_0_7, lock_schema_of, parse, ptr_token, validate_lock,
};
use mandate_testkit::{read_json, read_text};

fn json(text: &str) -> Value {
    parse(text).expect("strict JSON").value
}

/// Every JSON Pointer at which `a` and `b` differ: a member one has and the
/// other not, or a value that is not the same (an array is compared whole,
/// at its pointer).
fn differences(a: &Value, b: &Value, pointer: &str, out: &mut Vec<String>) {
    match (a.as_object(), b.as_object()) {
        (Some(x), Some(y)) => {
            for (k, v) in x.iter() {
                let at = format!("{pointer}/{}", ptr_token(k));
                match y.get(k) {
                    Some(w) => differences(v, w, &at, out),
                    None => out.push(at),
                }
            }
            for (k, _) in y.iter() {
                if x.get(k).is_none() {
                    out.push(format!("{pointer}/{}", ptr_token(k)));
                }
            }
        }
        _ => {
            if canonicalize(a) != canonicalize(b) {
                out.push(pointer.to_owned());
            }
        }
    }
}

fn differences_of(a: &str, b: &str) -> Vec<String> {
    let mut out = Vec::new();
    differences(&json(a), &json(b), "", &mut out);
    out.sort();
    out
}

#[test]
fn the_embedded_schemas_of_0_7_are_the_files_in_spec_and_prepare() {
    for (text, file) in [
        (IR_0_7_SCHEMA_TEXT, "spec/ir-0.7.schema.json"),
        (LOCK_0_7_SCHEMA_TEXT, "spec/lock-0.7.schema.json"),
    ] {
        assert!(read_text(file).expect("the file") == text, "{file}");
        read_json(file).expect("strict JSON");
    }
    ir_schema_0_7().expect("the 0.7 IR schema");
    lock_schema_0_7().expect("the 0.7 lock schema");
}

/// The 0.7 IR schema is the 0.6 one under the new version, with the
/// statements of 0.7. Each slice of 0.7 that adds a construct (`stage`,
/// `report`, `owner`, `asks`) lists its pointers here.
#[test]
fn the_0_7_ir_schema_differs_from_the_0_6_one_only_where_listed() {
    assert_eq!(
        differences_of(IR_0_6_SCHEMA_TEXT, IR_0_7_SCHEMA_TEXT),
        [
            "/$defs/Stmt/oneOf",
            "/$id",
            "/description",
            "/properties/language/enum",
            "/title"
        ]
    );
    // The statements: those of 0.6 as they are, then `stage` (RL2), closed,
    // its title a string of 1 to 80 code points.
    let stmts = |text: &str| {
        json(text)
            .get("$defs")
            .and_then(|d| d.get("Stmt"))
            .and_then(|s| s.get("oneOf"))
            .and_then(Value::as_array)
            .unwrap()
            .to_vec()
    };
    let (old, new) = (stmts(IR_0_6_SCHEMA_TEXT), stmts(IR_0_7_SCHEMA_TEXT));
    assert_eq!(new.len(), old.len() + 1, "one statement added");
    for (a, b) in old.iter().zip(&new) {
        assert_eq!(canonicalize(a), canonicalize(b), "a statement of 0.6");
    }
    assert_eq!(
        new.last().map(canonicalize).as_deref(),
        Some(
            r##"{"additionalProperties":false,"properties":{"name":{"$ref":"#/$defs/Name"},"op":{"const":"stage"},"title":{"maxLength":80,"minLength":1,"type":"string"}},"required":["op","name","title"],"type":"object"}"##
        ),
        "the stage statement"
    );
    let v = json(IR_0_7_SCHEMA_TEXT);
    assert_eq!(
        v.get("properties")
            .and_then(|p| p.get("language"))
            .map(canonicalize)
            .as_deref(),
        Some(r#"{"enum":["mandate/0.7"]}"#)
    );
    assert_eq!(
        v.get("$id").and_then(Value::as_str),
        Some("https://mandate.dev/spec/ir/0.7/schema.json")
    );
}

/// The 0.7 lock schema is the 0.6 one under the new format. Slice RL5 adds
/// `role_classes` and `promotion` here.
#[test]
fn the_0_7_lock_schema_differs_from_the_0_6_one_only_where_listed() {
    assert_eq!(
        differences_of(LOCK_0_6_SCHEMA_TEXT, LOCK_0_7_SCHEMA_TEXT),
        ["/$id", "/description", "/properties/lock/enum", "/title"]
    );
    let v = json(LOCK_0_7_SCHEMA_TEXT);
    assert_eq!(
        v.get("properties")
            .and_then(|p| p.get("lock"))
            .map(canonicalize)
            .as_deref(),
        Some(r#"{"enum":["mandate/lock/0.7"]}"#)
    );
}

/// A minimal program of `language`, with `extra` members at its root.
fn program(language: &str, extra: &str) -> String {
    format!(
        r#"{{"language":"{language}","module":"example.minimal","version":"0.1"{extra},"defs":{{"Greeting":{{"kind":"type","type":{{"ref":"Text"}}}}}}}}"#
    )
}

/// What `load_json` gives, as `code at path` lines.
fn loaded(text: &str) -> Vec<String> {
    load_json(text)
        .diagnostics
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// The keyword and path of each raw error `schema` gives for `v`.
fn refused(schema: &mandate_ir::Schema, v: &Value) -> Vec<String> {
    schema
        .errors(v)
        .iter()
        .map(|e| format!("{} {}", e.keyword, e.instance_path))
        .collect()
}

#[test]
fn a_program_of_0_7_is_read_by_the_schema_of_0_7() {
    assert_eq!(loaded(&program("mandate/0.7", "")), Vec::<String>::new());
    let read = load_json(&program("mandate/0.7", ""));
    assert_eq!(
        read.program
            .as_ref()
            .and_then(|p| p.get("language"))
            .and_then(Value::as_str),
        Some("mandate/0.7")
    );
    // Closed in 0.7 too.
    assert_eq!(
        loaded(&program("mandate/0.7", r#","extra":1"#)),
        ["MDT-E0104 at /extra"]
    );
    // Each schema takes its own version alone: the 0.7 program is refused
    // by the schemas of 0.1 to 0.5 and of 0.6, and the 0.7 schema takes
    // neither a 0.6 nor a 0.5 program.
    let v07 = json(&program("mandate/0.7", ""));
    let v06 = json(&program("mandate/0.6", ""));
    let v05 = json(&program("mandate/0.5", ""));
    assert_eq!(refused(ir_schema().unwrap(), &v07), ["enum /language"]);
    assert_eq!(refused(ir_schema_0_6().unwrap(), &v07), ["enum /language"]);
    assert_eq!(refused(ir_schema_0_7().unwrap(), &v06), ["enum /language"]);
    assert_eq!(refused(ir_schema_0_7().unwrap(), &v05), ["enum /language"]);
    // The choice is by the exact value: 0.7, 0.6, and anything else to the
    // schema of 0.1 to 0.5 (which then refuses what it does not know).
    let same = |a: &mandate_ir::Schema, b: &mandate_ir::Schema| std::ptr::eq(a, b);
    assert!(same(ir_schema_of(&v07).unwrap(), ir_schema_0_7().unwrap()));
    assert!(same(ir_schema_of(&v06).unwrap(), ir_schema_0_6().unwrap()));
    assert!(same(ir_schema_of(&v05).unwrap(), ir_schema().unwrap()));
    let v08 = json(&program("mandate/0.8", ""));
    assert!(same(ir_schema_of(&v08).unwrap(), ir_schema().unwrap()));
    // An unknown version is E0103, which names 0.7 as the last version
    // read.
    let unknown = load_json(&program("mandate/0.8", ""));
    assert_eq!(unknown.diagnostics.len(), 1);
    let d = &unknown.diagnostics[0];
    assert_eq!(d.code, "MDT-E0103");
    assert!(
        d.message
            .contains("or \"mandate/0.6\" or \"mandate/0.7\". Use an explicit migration"),
        "{}",
        d.message
    );
    assert_eq!(Language::NEWEST, Language::V0_7);
}

/// A program of `language` whose function's body is `body` (statements, as
/// JSON).
fn with_body(language: &str, body: &str) -> String {
    format!(
        r#"{{"language":"{language}","module":"example.minimal","version":"0.1","defs":{{"f":{{"kind":"fn","params":[],"returns":{{"ref":"Int"}},"body":[{body}]}}}}}}"#
    )
}

/// A `stage` statement (spec/attention.md "The IR"): read by the 0.7
/// schema, closed, its title a string of 1 to 80 code points; refused by
/// the schemas of 0.6 and earlier, whose statements are closed. Where a
/// stage may stand is the check's (E1901), not the schema's.
#[test]
fn a_stage_is_a_statement_of_the_0_7_schema_alone() {
    let stage = |title: &str| {
        format!(
            r#"{{"op":"stage","name":"collect","title":{}}},{{"op":"return","value":{{"op":"int","value":1}}}}"#,
            mandate_ir::stringify(&mandate_ir::JsValue::from(title)).unwrap_or_default()
        )
    };
    let ok = stage("Collect the items");
    assert_eq!(loaded(&with_body("mandate/0.7", &ok)), Vec::<String>::new());
    // Eighty code points, each of them more than one UTF-16 unit or byte.
    let wide = "\u{1F600}".repeat(80);
    assert_eq!(
        loaded(&with_body("mandate/0.7", &stage(&wide))),
        Vec::<String>::new()
    );
    for title in [String::new(), "x".repeat(81), format!("{wide}x")] {
        assert_eq!(
            loaded(&with_body("mandate/0.7", &stage(&title))),
            ["MDT-E0104 at /defs/f/body/0/title"],
            "{title:?}"
        );
    }
    // Closed: no member but `op`, `name` and `title`, and each of them.
    assert_eq!(
        loaded(&with_body(
            "mandate/0.7",
            r#"{"op":"stage","name":"collect","title":"t","body":[]}"#
        )),
        ["MDT-E0104 at /defs/f/body/0/body"]
    );
    assert_eq!(
        loaded(&with_body(
            "mandate/0.7",
            r#"{"op":"stage","name":"collect"}"#
        ))
        .len(),
        1
    );
    assert_eq!(
        loaded(&with_body(
            "mandate/0.7",
            r#"{"op":"stage","name":"not a name","title":"t"}"#
        )),
        ["MDT-E0104 at /defs/f/body/0/name"]
    );
    // Not a statement before 0.7.
    for language in ["mandate/0.6", "mandate/0.5"] {
        let d = loaded(&with_body(language, &ok));
        assert!(
            !d.is_empty()
                && d.iter()
                    .all(|l| l.starts_with("MDT-E0104 at /defs/f/body/0")),
            "{language}: {d:?}"
        );
    }
}

/// A hash written as the lock fixtures write one: one digit, 64 times.
fn digest(digit: char) -> String {
    format!("sha256:{}", digit.to_string().repeat(64))
}

fn lock_07(members: &str) -> Value {
    json(&format!(
        r#"{{"lock":"mandate/lock/0.7","modules":{{}}{members}}}"#
    ))
}

/// What `validate_lock` gives, as `code at path` lines.
fn lock_diagnostics(lock: &Value) -> Vec<String> {
    validate_lock(lock)
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

#[test]
fn a_0_7_lock_has_every_field_of_0_6_and_is_read_by_its_own_schema() {
    let (one, two) = (digest('1'), digest('2'));
    let full = lock_07(&format!(
        r#","libraries":{{"acme.connectors":{{"version":"2.3.0","digest":"{one}","modules":{{"acme.connectors":"{two}"}}}}}},"connectors":{{"acme.connectors.erp":{{"credential":"acme_erp","url":"https://erp.acme.example/mcp","tools":{{"list_open_orders":"{one}"}}}}}},"host":{{"node":"22"}},"members":{{"ana":{{"keys":["{one}"]}}}},"roles":{{"lead":["ana"]}}"#
    ));
    assert_eq!(lock_diagnostics(&full), Vec::<String>::new());
    // At least every earlier format, 0.6 included; no older lock is at 0.7.
    assert!(lock_at_least(&full, LOCK_FORMAT_0_7));
    assert!(lock_at_least(&full, LOCK_FORMAT_0_6));
    assert!(lock_at_least(&full, "mandate/lock/0.5"));
    assert!(lock_at_least(&full, "mandate/lock/0.2"));
    let older = json(r#"{"lock":"mandate/lock/0.6","modules":{}}"#);
    assert!(lock_at_least(&older, LOCK_FORMAT_0_6));
    assert!(!lock_at_least(&older, LOCK_FORMAT_0_7));
    let unknown = json(r#"{"lock":"mandate/lock/0.8","modules":{}}"#);
    assert!(!lock_at_least(&unknown, "mandate/lock/0.2"));
    // The rules after the schema hold for it: a role's member.
    let unbound = lock_07(r#","roles":{"lead":["bo"]}"#);
    assert_eq!(lock_diagnostics(&unbound), ["MDT-E0140 at /roles/lead/0"]);
    // Closed: a field no format has is refused, and the message names the
    // schema it was read by.
    let refused = validate_lock(&lock_07(r#","extensions":{}"#));
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].at.path.as_deref(), Some(""));
    assert_eq!(
        refused[0].message,
        "The lock file does not match spec/lock-0.7.schema.json: / must NOT have additional properties"
    );
    // The schema is chosen by the exact format, whatever reads the lock.
    let same = |a: &mandate_ir::Schema, b: &mandate_ir::Schema| std::ptr::eq(a, b);
    assert!(same(
        lock_schema_of(&full).unwrap(),
        lock_schema_0_7().unwrap()
    ));
    assert!(same(
        lock_schema_of(&older).unwrap(),
        lock_schema_0_6().unwrap()
    ));
    assert!(same(
        lock_schema_of(&unknown).unwrap(),
        lock_schema().unwrap()
    ));
    // A format no compiler reads is refused by the earlier schema's enum, as
    // before.
    assert_eq!(lock_diagnostics(&unknown), ["MDT-E0140 at /lock"]);
    // The 0.6 schema does not take a lock of 0.7, nor the 0.7 one a lock of
    // 0.6.
    assert_eq!(
        lock_schema_0_6()
            .unwrap()
            .errors(&lock_07(""))
            .iter()
            .map(|e| format!("{} {}", e.keyword, e.instance_path))
            .collect::<Vec<_>>(),
        ["enum /lock"]
    );
    assert_eq!(
        lock_schema_0_7()
            .unwrap()
            .errors(&older)
            .iter()
            .map(|e| format!("{} {}", e.keyword, e.instance_path))
            .collect::<Vec<_>>(),
        ["enum /lock"]
    );
}
