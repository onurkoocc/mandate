//! The manifest reader: what it accepts, with the exact manifest, and what
//! it refuses, with the exact problems in their order.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use common::{Table, json};
use mandate_ir::{JsValue, stringify};
use mandate_lib::{
    JsonFault, MODULES_MAX, ManifestProblem, NAME_MAX_BYTES, REQUIRES_MAX, ShapeProblem,
    read_manifest, read_manifest_bytes,
};

const LIBRARY: &str = r#""library":"mandate/library/0.6""#;
const NAME: &str = r#""name":"acme.connectors""#;
const VERSION: &str = r#""version":"2.3.0""#;
const MODULES: &str = r#""modules":["connectors.mdt","types.mdt"]"#;
const REQUIRES: &str = r#""requires":{"std.patterns":"^1.0"}"#;

/// An object of these members, written out.
fn doc(members: &[&str]) -> String {
    format!("{{{}}}", members.join(","))
}

/// A string as JSON text.
fn s(text: &str) -> String {
    stringify(&JsValue::from(text)).unwrap()
}

/// The problems of `text`, each as its JSON text.
fn problems(text: &str) -> Vec<String> {
    match read_manifest(text) {
        Ok(manifest) => panic!("accepted, as {}", json(manifest.to_js())),
        Err(problems) => problems.iter().map(|p| json(p.to_js())).collect(),
    }
}

fn wrong_type(at: &str, expected: &str, found: &str) -> String {
    format!(
        r#"{{"problem":"wrong_type","at":{},"expected":"{expected}","found":"{found}"}}"#,
        s(at)
    )
}

fn invalid_json(fault: &str, at: &str) -> String {
    format!(
        r#"{{"problem":"invalid_json","fault":"{fault}","at":{}}}"#,
        s(at)
    )
}

fn missing(field: &str) -> String {
    format!(r#"{{"problem":"missing_field","at":"","field":"{field}"}}"#)
}

#[test]
fn the_specifications_example_is_read() {
    let text = format!(
        r#"{{
  "library": "mandate/library/0.6",
  "name": "acme.connectors",
  "version": "2.3.0",
  "modules": ["connectors.mdt", "types.mdt"],
  "requires": {{ "std.patterns": "^1.0" }}
}}"#
    );
    let manifest = read_manifest(&text).unwrap();
    assert_eq!(manifest.name(), "acme.connectors");
    assert_eq!(manifest.version().to_string(), "2.3.0");
    assert_eq!(manifest.modules(), ["connectors.mdt", "types.mdt"]);
    assert_eq!(manifest.requires().len(), 1);
    assert_eq!(manifest.requires()["std.patterns"].to_string(), "^1.0");
    assert_eq!(
        json(manifest.to_js()),
        r#"{"name":"acme.connectors","version":"2.3.0","modules":["connectors.mdt","types.mdt"],"requires":{"std.patterns":"^1.0"}}"#
    );
}

#[test]
fn what_is_accepted() {
    let mut t = Table::new();
    let reference = read_manifest(&doc(&[LIBRARY, NAME, VERSION, MODULES, REQUIRES])).unwrap();
    // Members in another order, and white space.
    t.eq(
        "another order",
        read_manifest(&doc(&[REQUIRES, MODULES, VERSION, NAME, LIBRARY])).unwrap(),
        reference.clone(),
    );
    t.eq(
        "white space",
        read_manifest(&format!(
            "\t\r\n {{ \n\"library\" : \"mandate/library/0.6\" ,\n {NAME},{VERSION},{MODULES},{REQUIRES} }}\r\n"
        ))
        .unwrap(),
        reference,
    );
    // `requires` absent is `requires` empty.
    let none = read_manifest(&doc(&[LIBRARY, NAME, VERSION, MODULES])).unwrap();
    let empty =
        read_manifest(&doc(&[LIBRARY, NAME, VERSION, MODULES, r#""requires":{}"#])).unwrap();
    t.eq("absent requires is empty", none.clone(), empty);
    t.eq("requires is empty", none.requires().len(), 0);
    t.eq(
        "absent requires as JSON",
        json(none.to_js()),
        r#"{"name":"acme.connectors","version":"2.3.0","modules":["connectors.mdt","types.mdt"],"requires":{}}"#.to_owned(),
    );
    // `requires` is by name in the result, and the modules keep their order.
    let many = read_manifest(&doc(&[
        LIBRARY,
        r#""name":"b""#,
        r#""version":"0.0.1""#,
        r#""modules":["z.mdt","a.json","m/x.mdt"]"#,
        r#""requires":{"zeta":"1.2.3","alpha":"^0","mid.dle":"^0.0.0"}"#,
    ]))
    .unwrap();
    t.eq(
        "ordering",
        json(many.to_js()),
        r#"{"name":"b","version":"0.0.1","modules":["z.mdt","a.json","m/x.mdt"],"requires":{"alpha":"^0","mid.dle":"^0.0.0","zeta":"1.2.3"}}"#.to_owned(),
    );
    // The compiler's own names are not refused by the reader.
    t.ok(
        "std.patterns",
        read_manifest(&doc(&[
            LIBRARY,
            r#""name":"std.patterns""#,
            VERSION,
            r#""modules":["patterns.mdt"]"#,
        ]))
        .is_ok(),
    );
    // The longest name, and as many modules as are allowed.
    let longest = "a".repeat(NAME_MAX_BYTES);
    t.ok(
        "longest name",
        read_manifest(&doc(&[
            LIBRARY,
            &format!(r#""name":"{longest}""#),
            VERSION,
            MODULES,
        ]))
        .is_ok(),
    );
    let modules: Vec<String> = (0..MODULES_MAX).map(|i| s(&format!("m{i}.mdt"))).collect();
    let max_modules = read_manifest(&doc(&[
        LIBRARY,
        NAME,
        VERSION,
        &format!(r#""modules":[{}]"#, modules.join(",")),
    ]))
    .unwrap();
    t.eq("1024 modules", max_modules.modules().len(), MODULES_MAX);
    // Bytes that are UTF-8 are read as the text is.
    t.ok(
        "bytes",
        read_manifest_bytes(doc(&[LIBRARY, NAME, VERSION, MODULES]).as_bytes()).is_ok(),
    );
    t.finish();
}

#[test]
fn text_that_is_not_strict_json_has_one_problem() {
    let valid = doc(&[LIBRARY, NAME, VERSION, MODULES, REQUIRES]);
    let mut t = Table::new();
    // A byte order mark.
    t.eq(
        "byte order mark",
        problems(&format!("\u{feff}{valid}")),
        vec![r#"{"problem":"byte_order_mark"}"#.to_owned()],
    );
    t.eq(
        "bytes with a byte order mark",
        read_manifest_bytes(format!("\u{feff}{valid}").as_bytes())
            .unwrap_err()
            .iter()
            .map(|p| json(p.to_js()))
            .collect::<Vec<_>>(),
        vec![r#"{"problem":"byte_order_mark"}"#.to_owned()],
    );
    // Not UTF-8.
    t.eq(
        "not utf-8",
        read_manifest_bytes(&[0x7b, 0xff, 0x7d])
            .unwrap_err()
            .iter()
            .map(|p| json(p.to_js()))
            .collect::<Vec<_>>(),
        vec![r#"{"problem":"not_utf8"}"#.to_owned()],
    );
    // Text after the object.
    t.eq(
        "text after",
        problems(&format!("{valid} x")),
        vec![invalid_json("syntax", "")],
    );
    t.eq(
        "two objects",
        problems(&format!("{valid}{valid}")),
        vec![invalid_json("syntax", "")],
    );
    t.eq(
        "a comma after",
        problems(&format!("{valid},")),
        vec![invalid_json("syntax", "")],
    );
    // Not JSON at all.
    for (case, text) in [
        ("empty", ""),
        ("white space", " \n"),
        ("trailing comma", r#"{"library":"mandate/library/0.6",}"#),
        ("single quotes", "{'library':'x'}"),
        ("a comment", "{/* x */}"),
        ("unterminated", r#"{"library":"mandate/lib"#),
        ("bare word", "yes"),
        ("NaN", "NaN"),
    ] {
        let got = problems(text);
        t.eq(case, got.len(), 1);
        t.ok(
            case,
            got.first()
                .is_some_and(|p| p.contains(r#""fault":"syntax""#)),
        );
    }
    // A duplicate key, at the top and inside `requires`.
    t.eq(
        "duplicate name",
        problems(&doc(&[
            LIBRARY,
            NAME,
            VERSION,
            MODULES,
            r#""name":"other""#,
        ])),
        vec![invalid_json("duplicate_key", "/name")],
    );
    t.eq(
        "duplicate library",
        problems(&doc(&[LIBRARY, LIBRARY, NAME, VERSION, MODULES])),
        vec![invalid_json("duplicate_key", "/library")],
    );
    t.eq(
        "duplicate in requires",
        problems(&doc(&[
            LIBRARY,
            NAME,
            VERSION,
            MODULES,
            r#""requires":{"x":"^1","x":"^2"}"#,
        ])),
        vec![invalid_json("duplicate_key", "/requires/x")],
    );
    t.eq(
        "duplicate in an unknown member",
        problems(&doc(&[
            LIBRARY,
            NAME,
            VERSION,
            MODULES,
            r#""extra":{"a":1,"a":1}"#,
        ])),
        vec![invalid_json("duplicate_key", "/extra/a")],
    );
    // A key that differs only in case is another key (and so an unknown one).
    t.eq(
        "case of a key",
        problems(&doc(&[LIBRARY, NAME, VERSION, MODULES, r#""Name":"x""#])),
        vec![r#"{"problem":"unknown_field","at":"","field":"Name"}"#.to_owned()],
    );
    // Numbers the reader refuses.
    for (case, number, fault) in [
        ("fraction", "1.5", "not_integer"),
        ("exponent", "1e3", "not_integer"),
        ("negative zero", "-0", "negative_zero"),
        ("beyond 2^53", "9007199254740992", "out_of_range"),
        ("beyond 2^64", "18446744073709551616", "out_of_range"),
    ] {
        t.eq(
            case,
            problems(&doc(&[
                LIBRARY,
                NAME,
                VERSION,
                MODULES,
                &format!(r#""extra":{number}"#),
            ])),
            vec![invalid_json(fault, "/extra")],
        );
    }
    // A lone surrogate, a bad escape, a control character in a string.
    t.eq(
        "lone surrogate",
        problems(&doc(&[LIBRARY, r#""name":"\ud800""#, VERSION, MODULES])),
        vec![invalid_json("lone_surrogate", "/name")],
    );
    t.eq(
        "bad escape",
        problems(&doc(&[LIBRARY, r#""name":"\x""#, VERSION, MODULES])),
        vec![invalid_json("syntax", "/name")],
    );
    t.eq(
        "raw control character",
        problems(&format!("{{\"name\":\"a\tb\"}}")),
        vec![invalid_json("syntax", "/name")],
    );
    t.finish();
}

#[test]
fn the_readers_limits_are_reported_as_faults() {
    // Nesting over 64.
    let deep = format!("{}{}", "[".repeat(70), "]".repeat(70));
    let too_deep = problems(&format!(r#"{{"extra":{deep}}}"#));
    assert_eq!(too_deep.len(), 1);
    assert!(
        too_deep[0].contains(r#""fault":"too_deep""#),
        "{too_deep:?}"
    );
    // 64 is deep enough to be read (and then an unknown member).
    let deep_ok = format!("{}{}", "[".repeat(60), "]".repeat(60));
    let read = problems(&doc(&[
        LIBRARY,
        NAME,
        VERSION,
        MODULES,
        &format!(r#""extra":{deep_ok}"#),
    ]));
    assert_eq!(
        read,
        vec![r#"{"problem":"unknown_field","at":"","field":"extra"}"#.to_owned()]
    );
    // Text over 1 MiB.
    let big = format!(r#"{{"extra":"{}"}}"#, "a".repeat(1_048_576));
    let too_large = problems(&big);
    assert_eq!(too_large.len(), 1);
    assert!(
        too_large[0].contains(r#""fault":"too_large""#),
        "{too_large:?}"
    );
}

#[test]
fn an_object_that_is_not_the_manifests_has_shape_problems() {
    let mut t = Table::new();
    for (text, found) in [
        ("[]", "array"),
        ("null", "null"),
        (r#""x""#, "string"),
        ("1", "number"),
        ("true", "boolean"),
    ] {
        t.eq(text, problems(text), vec![wrong_type("", "object", found)]);
    }
    // No field at all: each is missing, in the order of the table.
    t.eq(
        "empty object",
        problems("{}"),
        vec![
            missing("library"),
            missing("name"),
            missing("version"),
            missing("modules"),
        ],
    );
    // Each of the four required fields missing, alone.
    for (without, field) in [
        (doc(&[NAME, VERSION, MODULES, REQUIRES]), "library"),
        (doc(&[LIBRARY, VERSION, MODULES, REQUIRES]), "name"),
        (doc(&[LIBRARY, NAME, MODULES, REQUIRES]), "version"),
        (doc(&[LIBRARY, NAME, VERSION, REQUIRES]), "modules"),
    ] {
        t.eq(
            &format!("without {field}"),
            problems(&without),
            vec![missing(field)],
        );
    }
    // Unknown fields, by name, before the rest.
    t.eq(
        "unknown fields",
        problems(&doc(&[
            r#""zeta":1"#,
            r#""alpha":[]"#,
            LIBRARY,
            NAME,
            VERSION,
            MODULES,
        ])),
        vec![
            r#"{"problem":"unknown_field","at":"","field":"alpha"}"#.to_owned(),
            r#"{"problem":"unknown_field","at":"","field":"zeta"}"#.to_owned(),
        ],
    );
    t.eq(
        "an unknown field and a missing one",
        problems(&doc(&[LIBRARY, NAME, VERSION, r#""extra":null"#])),
        vec![
            r#"{"problem":"unknown_field","at":"","field":"extra"}"#.to_owned(),
            missing("modules"),
        ],
    );
    t.finish();
}

#[test]
fn each_field_of_a_wrong_type() {
    let mut t = Table::new();
    for (field, expected, wrong) in [
        (
            "library",
            "string",
            [
                ("1", "number"),
                ("null", "null"),
                ("true", "boolean"),
                ("[]", "array"),
                ("{}", "object"),
            ],
        ),
        (
            "name",
            "string",
            [
                ("1", "number"),
                ("null", "null"),
                ("false", "boolean"),
                (r#"["a"]"#, "array"),
                ("{}", "object"),
            ],
        ),
        (
            "version",
            "string",
            [
                ("1", "number"),
                ("null", "null"),
                ("true", "boolean"),
                ("[1,0,0]", "array"),
                ("{}", "object"),
            ],
        ),
        (
            "modules",
            "array",
            [
                ("1", "number"),
                ("null", "null"),
                ("true", "boolean"),
                (r#""a.mdt""#, "string"),
                ("{}", "object"),
            ],
        ),
        (
            "requires",
            "object",
            [
                ("1", "number"),
                ("null", "null"),
                ("true", "boolean"),
                (r#""a""#, "string"),
                ("[]", "array"),
            ],
        ),
    ] {
        for (value, found) in wrong {
            let members: Vec<String> = [
                ("library", LIBRARY),
                ("name", NAME),
                ("version", VERSION),
                ("modules", MODULES),
                ("requires", REQUIRES),
            ]
            .iter()
            .map(|&(key, member)| {
                if key == field {
                    format!(r#""{key}":{value}"#)
                } else {
                    member.to_owned()
                }
            })
            .collect();
            let refs: Vec<&str> = members.iter().map(String::as_str).collect();
            t.eq(
                &format!("{field}: {value}"),
                problems(&doc(&refs)),
                vec![wrong_type(&format!("/{field}"), expected, found)],
            );
        }
    }
    // Entries of `modules` and values of `requires`.
    t.eq(
        "a module that is not a string",
        problems(&doc(&[
            LIBRARY,
            NAME,
            VERSION,
            r#""modules":["a.mdt",1,null,["b.mdt"]]"#,
        ])),
        vec![
            wrong_type("/modules/1", "string", "number"),
            wrong_type("/modules/2", "string", "null"),
            wrong_type("/modules/3", "string", "array"),
        ],
    );
    t.eq(
        "a range that is not a string",
        problems(&doc(&[
            LIBRARY,
            NAME,
            VERSION,
            MODULES,
            r#""requires":{"b":1,"a":null}"#,
        ])),
        vec![
            wrong_type("/requires/a", "string", "null"),
            wrong_type("/requires/b", "string", "number"),
        ],
    );
    t.finish();
}

#[test]
fn the_format_the_name_and_the_version() {
    let mut t = Table::new();
    for (library, found) in [
        ("mandate/library/0.5", "mandate/library/0.5"),
        ("mandate/library/0.6 ", "mandate/library/0.6 "),
        ("Mandate/library/0.6", "Mandate/library/0.6"),
        ("", ""),
        ("mandate/lock/0.6", "mandate/lock/0.6"),
    ] {
        t.eq(
            &format!("library {library:?}"),
            problems(&doc(&[
                &format!(r#""library":{}"#, s(library)),
                NAME,
                VERSION,
                MODULES,
            ])),
            vec![format!(
                r#"{{"problem":"unknown_format","found":{}}}"#,
                s(found)
            )],
        );
    }
    for (name, fault) in [
        ("", "empty"),
        ("Acme", "upper_case"),
        ("acme.Connectors", "upper_case"),
        ("acme..x", "empty_segment"),
        ("acme.", "empty_segment"),
        (".acme", "empty_segment"),
        ("1acme", "segment_start"),
        ("acme.1", "segment_start"),
        ("ac-me", "bad_character"),
        ("acme/x", "bad_character"),
        ("con", "device_name"),
        ("acme.aux", "device_name"),
        ("\u{430}cme", "segment_start"),
    ] {
        t.eq(
            &format!("name {name:?}"),
            problems(&doc(&[
                LIBRARY,
                &format!(r#""name":{}"#, s(name)),
                VERSION,
                MODULES,
            ])),
            vec![format!(
                r#"{{"problem":"invalid_name","found":{},"fault":"{fault}"}}"#,
                s(name)
            )],
        );
    }
    let too_long = "a".repeat(NAME_MAX_BYTES + 1);
    t.eq(
        "name too long",
        problems(&doc(&[
            LIBRARY,
            &format!(r#""name":"{too_long}""#),
            VERSION,
            MODULES,
        ])),
        vec![format!(
            r#"{{"problem":"invalid_name","found":"{too_long}","fault":"too_long"}}"#
        )],
    );
    for (version, fault) in [
        ("", "empty"),
        ("2.3", "components"),
        ("2", "components"),
        ("2.3.0.0", "components"),
        ("02.3.0", "leading_zero"),
        ("2.3.0-rc1", "not_decimal"),
        ("2.3.0+build", "not_decimal"),
        (" 2.3.0", "not_decimal"),
        ("2.3.0\n", "not_decimal"),
        ("v2.3.0", "not_decimal"),
        ("2..0", "empty_component"),
        ("4294967296.0.0", "too_large"),
        ("1.0.18446744073709551616", "too_large"),
    ] {
        t.eq(
            &format!("version {version:?}"),
            problems(&doc(&[
                LIBRARY,
                NAME,
                &format!(r#""version":{}"#, s(version)),
                MODULES,
            ])),
            vec![format!(
                r#"{{"problem":"invalid_version","found":{},"fault":"{fault}"}}"#,
                s(version)
            )],
        );
    }
    t.finish();
}

#[test]
fn each_module_path_is_held_to_the_allow_list() {
    let mut t = Table::new();
    for (path, fault) in [
        ("../x.mdt", "dot_segment"),
        ("/x.mdt", "leading_slash"),
        ("C:/x.mdt", "colon"),
        ("a\\b.mdt", "backslash"),
        ("a//b.mdt", "empty_segment"),
        ("./a.mdt", "dot_segment"),
        ("a/./b.mdt", "dot_segment"),
        ("a/../b.mdt", "dot_segment"),
        ("x.mdt ", "trailing_dot_or_space"),
        ("x.mdt.", "trailing_dot_or_space"),
        ("con.mdt", "device_name"),
        ("NUL.json", "device_name"),
        ("aux/x.mdt", "device_name"),
        ("x.MDT", "extension"),
        ("x.txt", "extension"),
        ("x", "extension"),
        ("", "empty"),
        ("a\0b.mdt", "control_character"),
        // A Cyrillic letter that looks like an ASCII one.
        ("\u{435}.mdt", "not_ascii"),
        ("index.json", "reserved_file"),
        ("mandate.library.json", "reserved_file"),
    ] {
        t.eq(
            &format!("{path:?}"),
            problems(&doc(&[
                LIBRARY,
                NAME,
                VERSION,
                &format!(r#""modules":[{}]"#, s(path)),
            ])),
            vec![format!(
                r#"{{"problem":"invalid_module_path","index":0,"path":{},"fault":"{fault}"}}"#,
                s(path)
            )],
        );
    }
    // Each entry's own problem, with its position.
    t.eq(
        "several",
        problems(&doc(&[LIBRARY, NAME, VERSION, r#""modules":["ok.mdt","../x.mdt","fine.json","y.txt"]"#])),
        vec![
            r#"{"problem":"invalid_module_path","index":1,"path":"../x.mdt","fault":"dot_segment"}"#.to_owned(),
            r#"{"problem":"invalid_module_path","index":3,"path":"y.txt","fault":"extension"}"#.to_owned(),
        ],
    );
    t.finish();
}

#[test]
fn modules_that_collide() {
    let mut t = Table::new();
    let modules = |list: &str| {
        problems(&doc(&[
            LIBRARY,
            NAME,
            VERSION,
            &format!(r#""modules":{list}"#),
        ]))
    };
    t.eq(
        "empty",
        modules("[]"),
        vec![r#"{"problem":"no_modules"}"#.to_owned()],
    );
    t.eq(
        "the same twice",
        modules(r#"["a.mdt","b.mdt","a.mdt"]"#),
        vec![
            r#"{"problem":"duplicate_module_path","index":2,"path":"a.mdt","first":0}"#.to_owned(),
        ],
    );
    t.eq(
        "the same three times",
        modules(r#"["a.mdt","a.mdt","a.mdt"]"#),
        vec![
            r#"{"problem":"duplicate_module_path","index":1,"path":"a.mdt","first":0}"#.to_owned(),
            r#"{"problem":"duplicate_module_path","index":2,"path":"a.mdt","first":0}"#.to_owned(),
        ],
    );
    // Two that differ only in case are one file on a case-insensitive file
    // system, in either order.
    t.eq(
        "A.mdt beside a.mdt",
        modules(r#"["A.mdt","a.mdt"]"#),
        vec![r#"{"problem":"case_duplicate_module_path","index":1,"path":"a.mdt","first":0,"first_path":"A.mdt"}"#.to_owned()],
    );
    t.eq(
        "a.mdt beside A.mdt",
        modules(r#"["a.mdt","A.mdt"]"#),
        vec![r#"{"problem":"case_duplicate_module_path","index":1,"path":"A.mdt","first":0,"first_path":"a.mdt"}"#.to_owned()],
    );
    t.eq(
        "in a directory",
        modules(r#"["lib/a.mdt","other.mdt","LIB/A.mdt"]"#),
        vec![r#"{"problem":"case_duplicate_module_path","index":2,"path":"LIB/A.mdt","first":0,"first_path":"lib/a.mdt"}"#.to_owned()],
    );
    t.eq(
        "the json extension too",
        modules(r#"["Types.json","types.json"]"#),
        vec![r#"{"problem":"case_duplicate_module_path","index":1,"path":"types.json","first":0,"first_path":"Types.json"}"#.to_owned()],
    );
    // A file that is also a directory.
    t.eq(
        "a file and its directory",
        modules(r#"["a.mdt","a.mdt/b.mdt"]"#),
        vec![r#"{"problem":"module_path_conflict","index":0,"path":"a.mdt","inside_index":1,"inside_path":"a.mdt/b.mdt"}"#.to_owned()],
    );
    t.eq(
        "a path that only looks like a directory of another",
        modules(r#"["x/y/z.mdt","X/Y.mdt/q.mdt","x/y"]"#),
        // `x/y` is no module (no extension); `x/y.mdt` does not exist.
        vec![
            r#"{"problem":"invalid_module_path","index":2,"path":"x/y","fault":"extension"}"#
                .to_owned(),
        ],
    );
    t.eq(
        "a file and a directory of another case",
        modules(r#"["a.mdt","A.mdt/b.mdt"]"#),
        vec![r#"{"problem":"module_path_conflict","index":0,"path":"a.mdt","inside_index":1,"inside_path":"A.mdt/b.mdt"}"#.to_owned()],
    );
    t.eq(
        "a file and a deeper directory",
        modules(r#"["d/a.json","d/a.json/e/f.mdt"]"#),
        vec![r#"{"problem":"module_path_conflict","index":0,"path":"d/a.json","inside_index":1,"inside_path":"d/a.json/e/f.mdt"}"#.to_owned()],
    );
    // The same name in two directories is two files.
    t.ok(
        "same name, two directories",
        read_manifest(&doc(&[
            LIBRARY,
            NAME,
            VERSION,
            r#""modules":["a/x.mdt","b/x.mdt","x.mdt"]"#,
        ]))
        .is_ok(),
    );
    // An invalid entry does not take part in the collisions.
    t.eq(
        "an invalid entry and its duplicate",
        modules(r#"["../x.mdt","../x.mdt"]"#),
        vec![
            r#"{"problem":"invalid_module_path","index":0,"path":"../x.mdt","fault":"dot_segment"}"#.to_owned(),
            r#"{"problem":"invalid_module_path","index":1,"path":"../x.mdt","fault":"dot_segment"}"#.to_owned(),
        ],
    );
    // More than the limit: that is all that is said.
    let many: Vec<String> = (0..=MODULES_MAX).map(|i| s(&format!("m{i}.mdt"))).collect();
    t.eq(
        "too many",
        modules(&format!("[{}]", many.join(","))),
        vec![format!(
            r#"{{"problem":"too_many_modules","count":{},"limit":{MODULES_MAX}}}"#,
            MODULES_MAX + 1
        )],
    );
    t.finish();
}

#[test]
fn requires() {
    let mut t = Table::new();
    let requires = |list: &str| {
        problems(&doc(&[
            LIBRARY,
            NAME,
            VERSION,
            MODULES,
            &format!(r#""requires":{list}"#),
        ]))
    };
    t.eq(
        "a name that is not a name",
        requires(r#"{"Bad":"^1"}"#),
        vec![
            r#"{"problem":"invalid_requirement_name","name":"Bad","fault":"upper_case"}"#
                .to_owned(),
        ],
    );
    t.eq(
        "the library itself",
        requires(r#"{"acme.connectors":"^1"}"#),
        vec![r#"{"problem":"requires_itself","name":"acme.connectors"}"#.to_owned()],
    );
    t.eq(
        "a library under the same prefix is not itself",
        read_manifest(&doc(&[
            LIBRARY,
            NAME,
            VERSION,
            MODULES,
            r#""requires":{"acme.connectors.types":"^1","acme":"^1"}"#,
        ]))
        .is_ok(),
        true,
    );
    t.eq(
        "a range that is not one",
        requires(r#"{"b":"^1.x","a":"1.0","c":"~1","d":"","e":">=1.0.0"}"#),
        vec![
            r#"{"problem":"invalid_range","name":"a","found":"1.0","fault":"components"}"#
                .to_owned(),
            r#"{"problem":"invalid_range","name":"b","found":"^1.x","fault":"not_decimal"}"#
                .to_owned(),
            r#"{"problem":"invalid_range","name":"c","found":"~1","fault":"components"}"#
                .to_owned(),
            r#"{"problem":"invalid_range","name":"d","found":"","fault":"empty"}"#.to_owned(),
            r#"{"problem":"invalid_range","name":"e","found":">=1.0.0","fault":"not_decimal"}"#
                .to_owned(),
        ],
    );
    t.eq(
        "a bad name with a bad range",
        requires(r#"{"1x":"^"}"#),
        vec![
            r#"{"problem":"invalid_requirement_name","name":"1x","fault":"segment_start"}"#
                .to_owned(),
            r#"{"problem":"invalid_range","name":"1x","found":"^","fault":"empty"}"#.to_owned(),
        ],
    );
    let many: Vec<String> = (0..=REQUIRES_MAX)
        .map(|i| format!(r#""l{i}":"^1""#))
        .collect();
    t.eq(
        "too many",
        requires(&format!("{{{}}}", many.join(","))),
        vec![format!(
            r#"{{"problem":"too_many_requirements","count":{},"limit":{REQUIRES_MAX}}}"#,
            REQUIRES_MAX + 1
        )],
    );
    t.finish();
}

#[test]
fn every_problem_of_a_manifest_comes_in_one_order() {
    let text = r#"{
        "zzz": 1,
        "library": "mandate/library/0.5",
        "name": "Bad",
        "version": "1",
        "modules": ["../a.mdt", "b.mdt", "B.mdt", 7],
        "requires": { "B": "^1", "bad": "x", "n": 2 }
    }"#;
    let want = vec![
        r#"{"problem":"unknown_field","at":"","field":"zzz"}"#.to_owned(),
        wrong_type("/modules/3", "string", "number"),
        wrong_type("/requires/n", "string", "number"),
        r#"{"problem":"unknown_format","found":"mandate/library/0.5"}"#.to_owned(),
        r#"{"problem":"invalid_name","found":"Bad","fault":"upper_case"}"#.to_owned(),
        r#"{"problem":"invalid_version","found":"1","fault":"components"}"#.to_owned(),
        r#"{"problem":"invalid_module_path","index":0,"path":"../a.mdt","fault":"dot_segment"}"#.to_owned(),
        r#"{"problem":"case_duplicate_module_path","index":2,"path":"B.mdt","first":1,"first_path":"b.mdt"}"#.to_owned(),
        r#"{"problem":"invalid_requirement_name","name":"B","fault":"upper_case"}"#.to_owned(),
        r#"{"problem":"invalid_range","name":"bad","found":"x","fault":"components"}"#.to_owned(),
    ];
    assert_eq!(problems(text), want);
    // And the same, a second time: the order is not by chance.
    assert_eq!(problems(text), want);
}

#[test]
fn problems_are_values_with_an_identifier() {
    let refused = read_manifest("{}").unwrap_err();
    assert_eq!(refused.len(), 4);
    assert_eq!(refused[0].id(), "missing_field");
    assert!(matches!(
        &refused[0],
        ManifestProblem::Shape(ShapeProblem::MissingField { at, field }) if at.is_empty() && field == "library"
    ));
    let dup = read_manifest(r#"{"a":1,"a":2}"#).unwrap_err();
    assert_eq!(
        dup,
        vec![ManifestProblem::Shape(ShapeProblem::InvalidJson {
            fault: JsonFault::DuplicateKey,
            at: "/a".to_owned()
        })]
    );
}
