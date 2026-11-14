//! The tag enums of `mandate-ir` are the closed sets of the IR schema the
//! crate embeds: each enum's values are the schema's, in its order, and every
//! closed set of the schema (each `oneOf`) has an enum. A schema that adds a
//! tag, drops one or adds a set fails here at once.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_ir::{
    DefKind, ExprOp, IR_SCHEMA_TEXT, Language, PatternKind, Program, ReadSource, StmtOp,
    TemplatePart, TierBy, TypeForm, Value, VerifierForm, load_json, parse, ptr_token,
};

fn schema() -> Value {
    parse(IR_SCHEMA_TEXT).expect("the embedded schema").value
}

/// The value at a JSON Pointer of `v`.
fn at<'a>(v: &'a Value, pointer: &str) -> &'a Value {
    pointer.split('/').skip(1).fold(v, |v, token| match v {
        Value::Array(items) => &items[token.parse::<usize>().expect("an index")],
        _ => v.get(token).unwrap_or_else(|| panic!("no {pointer}")),
    })
}

/// The branches of the `oneOf` at `pointer`.
fn branches<'a>(schema: &'a Value, pointer: &str) -> &'a [Value] {
    at(schema, &format!("{pointer}/oneOf"))
        .as_array()
        .expect("oneOf is an array")
}

/// The tag values of a discriminated `oneOf`: each branch's
/// `properties/<tag>/const`, after checking the discriminator names `tag`.
fn tag_values(schema: &Value, pointer: &str, tag: &str) -> Vec<String> {
    let discriminator = at(schema, &format!("{pointer}/discriminator/propertyName"));
    assert_eq!(discriminator.as_str(), Some(tag), "{pointer}");
    branches(schema, pointer)
        .iter()
        .map(|b| {
            at(b, &format!("/properties/{tag}/const"))
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

/// The forms of a `oneOf` the schema tells apart by a member: each branch's
/// first required member, which is one of its properties.
fn form_members(schema: &Value, pointer: &str) -> Vec<String> {
    branches(schema, pointer)
        .iter()
        .map(|b| {
            let member = at(b, "/required/0").as_str().unwrap();
            assert!(
                b.get("properties").and_then(|p| p.get(member)).is_some(),
                "{pointer}"
            );
            member.to_owned()
        })
        .collect()
}

fn texts<T: Copy>(all: &[T], as_str: fn(T) -> &'static str) -> Vec<String> {
    all.iter().map(|v| as_str(*v).to_owned()).collect()
}

/// Every JSON Pointer in the schema at which there is a `oneOf`.
fn one_of_pointers(v: &Value, pointer: &str, out: &mut Vec<String>) {
    match v {
        Value::Object(map) => {
            for (key, x) in map.iter() {
                if key == "oneOf" {
                    out.push(pointer.to_owned());
                }
                one_of_pointers(x, &format!("{pointer}/{}", ptr_token(key)), out);
            }
        }
        Value::Array(items) => {
            for (i, x) in items.iter().enumerate() {
                one_of_pointers(x, &format!("{pointer}/{i}"), out);
            }
        }
        _ => {}
    }
}

#[test]
fn every_closed_set_of_the_schema_is_an_enum_with_the_same_values() {
    let schema = schema();
    let language: Vec<String> = at(&schema, "/properties/language/enum")
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        texts(Language::ALL, Language::as_str),
        language,
        "language versions"
    );
    let sets: [(&str, Vec<String>, Vec<String>); 9] = [
        (
            "/$defs/Def",
            tag_values(&schema, "/$defs/Def", "kind"),
            texts(DefKind::ALL, DefKind::as_str),
        ),
        (
            "/$defs/Expr",
            tag_values(&schema, "/$defs/Expr", "op"),
            texts(ExprOp::ALL, ExprOp::as_str),
        ),
        (
            "/$defs/Stmt",
            tag_values(&schema, "/$defs/Stmt", "op"),
            texts(StmtOp::ALL, StmtOp::as_str),
        ),
        (
            "/$defs/Pattern",
            tag_values(&schema, "/$defs/Pattern", "p"),
            texts(PatternKind::ALL, PatternKind::as_str),
        ),
        (
            "/$defs/Tier",
            tag_values(&schema, "/$defs/Tier", "by"),
            texts(TierBy::ALL, TierBy::as_str),
        ),
        (
            "/$defs/TypeExpr",
            form_members(&schema, "/$defs/TypeExpr"),
            texts(TypeForm::ALL, TypeForm::as_str),
        ),
        (
            "/$defs/Verifier",
            form_members(&schema, "/$defs/Verifier"),
            texts(VerifierForm::ALL, VerifierForm::as_str),
        ),
        (
            "/$defs/ReadSource/properties/query",
            form_members(&schema, "/$defs/ReadSource/properties/query"),
            texts(ReadSource::ALL, ReadSource::as_str),
        ),
        (
            "/$defs/TemplatePart",
            form_members(&schema, "/$defs/TemplatePart"),
            texts(TemplatePart::ALL, TemplatePart::as_str),
        ),
    ];
    for (pointer, in_schema, in_enum) in &sets {
        assert_eq!(in_enum, in_schema, "the enum of {pointer} and the schema");
    }
    // A closed set the schema adds has no enum yet.
    let mut found = Vec::new();
    one_of_pointers(&schema, "", &mut found);
    let mut known: Vec<String> = sets.iter().map(|(p, _, _)| (*p).to_owned()).collect();
    found.sort();
    known.sort();
    assert_eq!(found, known, "every oneOf of the schema has an enum here");
}

#[test]
fn tags_convert_both_ways_and_versions_are_ordered() {
    for kind in DefKind::ALL {
        assert_eq!(DefKind::from_tag(kind.as_str()), Some(*kind));
    }
    for op in ExprOp::ALL {
        assert_eq!(ExprOp::from_tag(op.as_str()), Some(*op));
    }
    assert_eq!(ExprOp::from_tag("let"), None);
    assert_eq!(StmtOp::from_tag("on_error"), Some(StmtOp::OnError));
    assert_eq!(
        DefKind::from_value(&Value::from("role")),
        Some(DefKind::Role)
    );
    assert_eq!(DefKind::from_value(&Value::Null), None);
    assert!(Language::V0_5.at_least(Language::V0_4));
    assert!(Language::V0_4.at_least(Language::V0_4));
    assert!(!Language::V0_3.at_least(Language::V0_4));
    assert_eq!(DefKind::Role.since(), Language::V0_4);
    assert_eq!(ExprOp::Changeset.since(), Language::V0_3);
    assert_eq!(ExprOp::Int.since(), Language::V0_1);
    assert_eq!(Language::NEWEST.to_string(), "mandate/0.5");
    let refine = parse(r#"{"refine": {"ref": "Int"}, "where": {"op": "bool", "value": true}}"#)
        .unwrap()
        .value;
    assert_eq!(TypeForm::of(&refine), Some(TypeForm::Refine));
    assert_eq!(TypeForm::of(&Value::Null), None);
}

#[test]
fn a_program_is_read_through_its_view() {
    let text = r#"{"language": "mandate/0.4", "module": "a.b", "version": "1.0",
        "uses": [{"module": "std.core", "names": ["Text", "Int"]}, {"module": "m"}],
        "defs": {"T": {"kind": "type", "type": {"ref": "Text"}}, "R": {"kind": "role", "description": "x"}}}"#;
    let loaded = load_json(text);
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let value = loaded.program.unwrap();
    let program = Program::of(&value).unwrap();
    assert_eq!(program.language(), Some(Language::V0_4));
    assert_eq!(program.module(), Some("a.b"));
    assert_eq!(program.version(), Some("1.0"));
    let imports: Vec<(Option<&str>, Vec<&str>)> = program
        .imports()
        .map(|i| (i.module(), i.names().collect()))
        .collect();
    assert_eq!(
        imports,
        [(Some("std.core"), vec!["Text", "Int"]), (Some("m"), vec![])]
    );
    let defs: Vec<(&str, Option<DefKind>)> =
        program.definitions().map(|(n, d)| (n, d.kind())).collect();
    assert_eq!(
        defs,
        [("T", Some(DefKind::Type)), ("R", Some(DefKind::Role))]
    );
    assert_eq!(
        program.definition("R").and_then(|d| d.kind()),
        Some(DefKind::Role)
    );
    assert!(program.definition("X").is_none());
    // On a value that was not validated, a missing or mistyped member is
    // None or empty, never a panic.
    let odd = parse(r#"{"language": 5, "uses": "x", "defs": [1]}"#)
        .unwrap()
        .value;
    let odd = Program::of(&odd).unwrap();
    assert_eq!(odd.language(), None);
    assert_eq!(odd.module(), None);
    assert_eq!(odd.imports().count(), 0);
    assert_eq!(odd.definitions().count(), 0);
    assert!(Program::of(&Value::Null).is_none());
}
