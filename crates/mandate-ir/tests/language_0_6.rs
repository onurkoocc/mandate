//! Language 0.6 in `mandate-ir`: its schemas, its lock format and its hash
//! domain (spec/library.md). No TypeScript reads 0.6, so nothing here is held
//! to a stored result; each expectation is written by hand.
//!
//! - The schemas the crate embeds are the files in `spec/`, and they differ
//!   from those of 0.1 to 0.5 exactly where the lists below say. A slice of
//!   0.6 that adds a construct adds its pointers to the list.
//! - Each document is read by the schema of its own version, and a document
//!   of an earlier version as before.
//! - A lock of format 0.6 has every field of 0.5 and two more, held to their
//!   shape; an older lock that carries either is refused as before.
//! - The library domain hashes under `mandate/library/0.6`, the prefix
//!   spec/library.md gives a library's digest.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_ir::{
    HashDomain, IR_0_6_SCHEMA_TEXT, IR_SCHEMA_TEXT, LIBRARY_HASH_VERSION, LOCK_0_6_SCHEMA_TEXT,
    LOCK_FORMAT_0_6, LOCK_SCHEMA_TEXT, Value, canonicalize, domain_hash, ir_schema, ir_schema_0_6,
    load_json, lock_at_least, lock_schema, lock_schema_0_6, parse, ptr_token, validate_lock,
};
use mandate_testkit::{read_json, read_text, sha256};

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
fn the_embedded_schemas_are_the_files_in_spec_and_prepare() {
    for (text, file) in [
        (IR_SCHEMA_TEXT, "spec/ir.schema.json"),
        (LOCK_SCHEMA_TEXT, "spec/lock.schema.json"),
        (IR_0_6_SCHEMA_TEXT, "spec/ir-0.6.schema.json"),
        (LOCK_0_6_SCHEMA_TEXT, "spec/lock-0.6.schema.json"),
    ] {
        assert!(read_text(file).expect("the file") == text, "{file}");
        // The repository's strict reader takes each of them.
        read_json(file).expect("strict JSON");
    }
    ir_schema().expect("the IR schema");
    lock_schema().expect("the lock schema");
    ir_schema_0_6().expect("the 0.6 IR schema");
    lock_schema_0_6().expect("the 0.6 lock schema");
}

/// The 0.6 IR schema is the schema of 0.1 to 0.5 under the new version, with
/// the constructs of 0.6 so far: `pub` and `doc` on every kind of definition
/// (spec/library.md "The 0.6 surface"), connectors, and a criterion's
/// `waive` (spec/library.md "waive by"). Each slice that adds one lists its
/// pointers here.
#[test]
fn the_0_6_ir_schema_differs_from_the_earlier_one_only_where_listed() {
    assert_eq!(
        differences_of(IR_SCHEMA_TEXT, IR_0_6_SCHEMA_TEXT),
        [
            "/$defs/Criterion/properties/waive",
            "/$defs/Def/oneOf",
            "/$defs/Tool",
            "/$id",
            "/description",
            "/properties/language/enum",
            "/title"
        ]
    );
    // The definitions, branch by branch: the earlier branch with `pub`
    // (`true` alone) and `doc` (a string) among its properties, and nothing
    // else changed; a `fn` had `pub` already. After them, the kinds 0.6
    // adds: `connector` (spec/library.md "Connectors"), with a tool of
    // `$defs/Tool` by name.
    let branches = |text: &str| {
        json(text)
            .get("$defs")
            .and_then(|d| d.get("Def"))
            .and_then(|d| d.get("oneOf"))
            .and_then(Value::as_array)
            .expect("the branches of a definition")
            .to_vec()
    };
    let (old, new) = (branches(IR_SCHEMA_TEXT), branches(IR_0_6_SCHEMA_TEXT));
    assert_eq!(old.len(), 13);
    assert_eq!(new.len(), 14, "the kinds of 0.6 so far");
    let added: Vec<String> = new
        .iter()
        .skip(old.len())
        .filter_map(|n| n.get("properties")?.get("kind")?.get("const")?.as_str())
        .map(str::to_owned)
        .collect();
    assert_eq!(added, ["connector"]);
    for (o, n) in old.iter().zip(new.iter()) {
        let kind = n
            .get("properties")
            .and_then(|p| p.get("kind"))
            .map(canonicalize)
            .unwrap_or_default();
        let mut found = Vec::new();
        differences(o, n, "", &mut found);
        found.sort();
        let had_pub = o.get("properties").and_then(|p| p.get("pub")).is_some();
        let want: Vec<&str> = if had_pub {
            vec!["/properties/doc"]
        } else {
            vec!["/properties/doc", "/properties/pub"]
        };
        assert_eq!(found, want, "{kind}");
        let props = n.get("properties").expect("properties");
        assert_eq!(
            props.get("pub").map(canonicalize).as_deref(),
            Some(r#"{"const":true}"#),
            "{kind}"
        );
        assert_eq!(
            props.get("doc").map(canonicalize).as_deref(),
            Some(r#"{"type":"string"}"#),
            "{kind}"
        );
    }
    let v = json(IR_0_6_SCHEMA_TEXT);
    assert_eq!(
        v.get("properties")
            .and_then(|p| p.get("language"))
            .map(canonicalize)
            .as_deref(),
        Some(r#"{"enum":["mandate/0.6"]}"#)
    );
}

/// A criterion's `waive` (0.6) is a set of role names: at least one, each
/// once; and a program of 0.5 that has one is refused as before (E0104).
#[test]
fn a_criterions_waive_is_a_set_of_names_in_0_6_alone() {
    let v = json(IR_0_6_SCHEMA_TEXT);
    let waive = v
        .get("$defs")
        .and_then(|d| d.get("Criterion"))
        .and_then(|c| c.get("properties"))
        .and_then(|p| p.get("waive"))
        .map(canonicalize);
    assert_eq!(waive.as_deref(), Some(r##"{"$ref":"#/$defs/NameSet"}"##));
    let with = |language: &str, waive: &str| {
        format!(
            r#"{{"language":"{language}","module":"example.waive","version":"0.1","defs":{{"accountant":{{"kind":"role","description":"Accountant"}},"C":{{"kind":"contract","params":[{{"name":"x","type":{{"ref":"Int"}}}}],"accept":{{"small":{{"description":"Small","by":{{"static":{{"op":"bool","value":true}}}}{waive}}}}}}}}}}}"#
        )
    };
    assert_eq!(
        loaded(&with("mandate/0.6", r#","waive":["accountant"]"#)),
        Vec::<String>::new()
    );
    assert_eq!(
        loaded(&with("mandate/0.6", r#","waive":[]"#)),
        ["MDT-E0104 at /defs/C/accept/small/waive"]
    );
    assert_eq!(
        loaded(&with(
            "mandate/0.6",
            r#","waive":["accountant","accountant"]"#
        )),
        ["MDT-E0104 at /defs/C/accept/small/waive"]
    );
    assert_eq!(
        loaded(&with("mandate/0.5", r#","waive":["accountant"]"#)),
        ["MDT-E0104 at /defs/C/accept/small/waive"]
    );
}

/// The 0.6 lock schema is the schema of 0.2 to 0.5 with its own format and
/// the two members of spec/library.md "Lock 0.6", and the definitions they
/// use.
#[test]
fn the_0_6_lock_schema_differs_from_the_earlier_one_only_where_listed() {
    assert_eq!(
        differences_of(LOCK_SCHEMA_TEXT, LOCK_0_6_SCHEMA_TEXT),
        [
            "/$defs/Digest",
            "/$defs/LibraryVersion",
            "/$defs/QName",
            "/$id",
            "/description",
            "/properties/connectors",
            "/properties/libraries",
            "/properties/lock/enum",
            "/title"
        ]
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

#[test]
fn a_program_is_read_by_the_schema_of_its_own_language() {
    // A 0.6 program loads, and a 0.5 one as before.
    assert_eq!(loaded(&program("mandate/0.6", "")), Vec::<String>::new());
    assert!(load_json(&program("mandate/0.6", "")).program.is_some());
    assert_eq!(loaded(&program("mandate/0.5", "")), Vec::<String>::new());
    // The schema is closed in 0.6 too.
    assert_eq!(
        loaded(&program("mandate/0.6", r#","extra":1"#)),
        ["MDT-E0104 at /extra"]
    );
    // The schema of 0.1 to 0.5 does not take 0.6, and the schema of 0.6
    // takes nothing else: each is closed to its own versions.
    let v06 = json(&program("mandate/0.6", ""));
    let v05 = json(&program("mandate/0.5", ""));
    let refused = |schema: &mandate_ir::Schema, v: &Value| {
        schema
            .errors(v)
            .iter()
            .map(|e| format!("{} {}", e.keyword, e.instance_path))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        refused(ir_schema().unwrap(), &v06),
        ["enum /language".to_owned()]
    );
    assert_eq!(
        refused(ir_schema_0_6().unwrap(), &v05),
        ["enum /language".to_owned()]
    );
    // An unknown version is E0103, which names 0.6 among the versions read.
    let unknown = load_json(&program("mandate/0.7", ""));
    let d = &unknown.diagnostics[0];
    assert_eq!(d.code, "MDT-E0103");
    assert!(d.message.ends_with(
        "this compiler reads \"mandate/0.1\" or \"mandate/0.2\" or \"mandate/0.3\" or \"mandate/0.4\" or \"mandate/0.5\" or \"mandate/0.6\". Use an explicit migration instead of loading it as-is."
    ), "{}", d.message);
}

/// A hash written as the lock fixtures write one: one digit, 64 times.
fn digest(digit: char) -> String {
    format!("sha256:{}", digit.to_string().repeat(64))
}

fn lock_06(members: &str) -> Value {
    json(&format!(
        r#"{{"lock":"mandate/lock/0.6","modules":{{}}{members}}}"#
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
fn a_0_6_lock_has_every_field_of_0_5_and_libraries_and_connectors() {
    let (one, two, three) = (digest('1'), digest('2'), digest('3'));
    let libraries = format!(
        r#","libraries":{{"acme.connectors":{{"version":"2.3.0","digest":"{one}","modules":{{"acme.connectors":"{two}","acme.connectors.types":"{three}"}}}}}}"#
    );
    let connectors = format!(
        r#","connectors":{{"acme.connectors.erp":{{"credential":"acme_erp","tools":{{"list_open_orders":"{one}"}}}},"acme.connectors.mailbox":{{"credential":"acme_mail","header":"x-api-key","template":"{{secret}}","tools":{{"list_invoices":"{two}"}}}}}}"#
    );
    let full = lock_06(&format!(
        r#"{libraries}{connectors},"host":{{"node":"22"}},"egress":{{"Reader":{{"api.github.com":"github"}}}},"members":{{"ana":{{"keys":["{one}"]}}}},"roles":{{"lead":["ana"]}}"#
    ));
    assert_eq!(lock_diagnostics(&full), Vec::<String>::new());
    // A 0.6 lock is at least every earlier format, and no other is at 0.6.
    assert!(lock_at_least(&full, "mandate/lock/0.5"));
    assert!(lock_at_least(&full, "mandate/lock/0.2"));
    assert!(lock_at_least(&full, LOCK_FORMAT_0_6));
    let older = json(r#"{"lock":"mandate/lock/0.5","modules":{}}"#);
    assert!(!lock_at_least(&older, LOCK_FORMAT_0_6));
    // The rules after the schema hold for it as for 0.5: a role's member.
    let unbound = lock_06(r#","roles":{"lead":["bo"]}"#);
    assert_eq!(lock_diagnostics(&unbound), ["MDT-E0140 at /roles/lead/0"]);
}

#[test]
fn the_two_fields_of_0_6_are_held_to_their_shape() {
    let one = digest('1');
    let shape = |members: &str| lock_diagnostics(&lock_06(members));
    // A library: version MAJOR.MINOR.PATCH, digest, at least one module,
    // each by program hash; nothing else.
    assert_eq!(
        shape(&format!(
            r#","libraries":{{"a.b":{{"version":"2.3","digest":"{one}","modules":{{"a.b":"{one}"}}}}}}"#
        )),
        ["MDT-E0140 at /libraries/a.b/version"]
    );
    assert_eq!(
        shape(r#","libraries":{"a.b":{"version":"1.0.0","digest":"sha256:short","modules":{}}}"#),
        [
            "MDT-E0140 at /libraries/a.b/digest",
            "MDT-E0140 at /libraries/a.b/modules"
        ]
    );
    assert_eq!(
        shape(&format!(
            r#","libraries":{{"a.b":{{"version":"1.0.0","digest":"{one}","modules":{{"a.b":"{one}"}},"signature":"x"}}}}"#
        )),
        ["MDT-E0140 at /libraries/a.b"]
    );
    assert_eq!(
        shape(&format!(
            r#","libraries":{{"a-b":{{"version":"1.0.0","digest":"{one}","modules":{{"a.b":"{one}"}}}}}}"#
        )),
        ["MDT-E0140 at /libraries", "MDT-E0140 at /libraries"]
    );
    // A connector: a credential's name (never a secret), the tools' schema
    // digests; header and template optional.
    assert_eq!(
        shape(&format!(
            r#","connectors":{{"a.erp":{{"credential":"not a name","tools":{{"t":"{one}"}}}}}}"#
        )),
        ["MDT-E0140 at /connectors/a.erp/credential"]
    );
    assert_eq!(
        shape(r#","connectors":{"a.erp":{"credential":"erp"}}"#),
        ["MDT-E0140 at /connectors/a.erp"]
    );
    assert_eq!(
        shape(r#","connectors":{"a.erp":{"credential":"erp","tools":{"t":"x"},"header":""}}"#),
        [
            "MDT-E0140 at /connectors/a.erp/header",
            "MDT-E0140 at /connectors/a.erp/tools/t"
        ]
    );
    // The message names the schema the lock was read by.
    let refused = validate_lock(&lock_06(r#","libraries":1"#));
    assert_eq!(
        refused[0].message,
        "The lock file does not match spec/lock-0.6.schema.json: /libraries must be object"
    );
}

#[test]
fn an_older_lock_with_a_field_of_0_6_is_refused_as_before() {
    for field in ["libraries", "connectors"] {
        let lock = json(&format!(
            r#"{{"lock":"mandate/lock/0.5","modules":{{}},"{field}":{{}}}}"#
        ));
        let refused = validate_lock(&lock);
        assert_eq!(refused.len(), 1, "{field}");
        let d = &refused[0];
        assert_eq!(d.code, "MDT-E0140");
        assert_eq!(d.at.path.as_deref(), Some(""));
        assert_eq!(
            d.message,
            "The lock file does not match spec/lock.schema.json: / must NOT have additional properties"
        );
        assert_eq!(
            d.facts
                .as_ref()
                .and_then(|f| f.get("params"))
                .and_then(|p| p.get("additionalProperty"))
                .and_then(mandate_ir::JsValue::as_str),
            Some(field)
        );
    }
    // A format no compiler reads is refused by the earlier schema's enum, as
    // before.
    let unknown = json(r#"{"lock":"mandate/lock/0.7","modules":{}}"#);
    assert_eq!(lock_diagnostics(&unknown), ["MDT-E0140 at /lock"]);
}

#[test]
fn the_library_domain_hashes_under_the_prefix_of_a_librarys_digest() {
    assert_eq!(HashDomain::Library.as_str(), "library");
    assert_eq!(HashDomain::from_name("library"), Some(HashDomain::Library));
    for d in HashDomain::ALL {
        assert_eq!(HashDomain::from_name(d.as_str()), Some(d));
    }
    // The domains of hash.ts are those of the TypeScript's vectors; library
    // is the Rust's alone.
    let file = read_json("vectors/hash.json").unwrap();
    let mut in_vectors: Vec<String> = file
        .get("domain")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|v| v.get("domain").and_then(Value::as_str).unwrap().to_owned())
        .collect();
    in_vectors.sort();
    in_vectors.dedup();
    let mut ours: Vec<String> = HashDomain::ALL
        .iter()
        .filter(|d| **d != HashDomain::Library)
        .map(|d| d.as_str().to_owned())
        .collect();
    ours.sort();
    assert_eq!(ours, in_vectors);
    // `SHA256("mandate/library/0.6\n" ‖ JCS(value))`, spec/library.md.
    let value = json(
        r#"{"version":"1.0.0","name":"std.patterns","requires":{},"modules":{"std.patterns":"sha256:00"}}"#,
    );
    assert_eq!(LIBRARY_HASH_VERSION, "0.6");
    assert_eq!(
        domain_hash(HashDomain::Library, &value, LIBRARY_HASH_VERSION),
        sha256(&format!("mandate/library/0.6\n{}", canonicalize(&value)))
    );
}
