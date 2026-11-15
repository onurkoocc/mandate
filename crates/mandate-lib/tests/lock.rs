//! The lock's pins: the reader, a pin compared with what was found, and a
//! library's `requires` against the pins.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use std::collections::BTreeMap;

use common::{Table, json};
use mandate_ir::{JsValue, parse, stringify};
use mandate_lib::{
    Digest, FoundLibrary, LockLibrary, PinProblem, Range, RequireProblem, Version, check_requires,
    compare_pin, find_pin, lock_libraries_js, modules_pinned_twice, read_lock_libraries,
};

/// A digest made of one number: `sha256:` and 64 hex digits.
fn d(n: u32) -> String {
    format!("sha256:{n:064x}")
}

fn digest(n: u32) -> Digest {
    Digest::parse(&d(n)).unwrap()
}

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

fn s(text: &str) -> String {
    stringify(&JsValue::from(text)).unwrap()
}

/// The pins in a `libraries` member written as JSON.
fn read(libraries: &str) -> Result<BTreeMap<String, LockLibrary>, Vec<String>> {
    let value = parse(libraries).unwrap().value;
    read_lock_libraries(Some(&value))
        .map_err(|problems| problems.iter().map(|p| json(p.to_js())).collect())
}

fn wrong_type(at: &str, expected: &str, found: &str) -> String {
    format!(
        r#"{{"problem":"wrong_type","at":{},"expected":"{expected}","found":"{found}"}}"#,
        s(at)
    )
}

#[test]
fn the_specifications_pins_are_read() {
    let text = format!(
        r#"{{
  "std.patterns":    {{ "version": "1.0.0", "digest": "{}", "modules": {{ "std.patterns": "{}" }} }},
  "acme.connectors": {{ "version": "2.3.0", "digest": "{}",
                       "modules": {{ "acme.connectors": "{}", "acme.connectors.types": "{}" }} }}
}}"#,
        d(1),
        d(2),
        d(3),
        d(4),
        d(5)
    );
    let pins = read(&text).unwrap();
    assert_eq!(
        pins.keys().collect::<Vec<_>>(),
        ["acme.connectors", "std.patterns"]
    );
    let acme = &pins["acme.connectors"];
    assert_eq!(acme.version(), &v("2.3.0"));
    assert_eq!(acme.digest(), &digest(3));
    assert_eq!(acme.modules().len(), 2);
    assert_eq!(acme.modules()["acme.connectors.types"], digest(5));
    assert_eq!(
        json(acme.to_js()),
        format!(
            r#"{{"version":"2.3.0","digest":"{}","modules":{{"acme.connectors":"{}","acme.connectors.types":"{}"}}}}"#,
            d(3),
            d(4),
            d(5)
        )
    );
    assert_eq!(
        stringify(&lock_libraries_js(&pins)).unwrap(),
        format!(
            r#"{{"acme.connectors":{{"version":"2.3.0","digest":"{}","modules":{{"acme.connectors":"{}","acme.connectors.types":"{}"}}}},"std.patterns":{{"version":"1.0.0","digest":"{}","modules":{{"std.patterns":"{}"}}}}}}"#,
            d(3),
            d(4),
            d(5),
            d(1),
            d(2)
        )
    );
}

#[test]
fn a_lock_without_pins_pins_nothing() {
    assert!(read_lock_libraries(None).unwrap().is_empty());
    assert!(read("{}").unwrap().is_empty());
}

#[test]
fn pins_refused() {
    let ok_digest = d(1);
    let entry = |version: &str, digest: &str, modules: &str| {
        format!(
            r#"{{"acme":{{"version":{},"digest":{},"modules":{modules}}}}}"#,
            s(version),
            s(digest)
        )
    };
    let mut t = Table::new();
    t.eq(
        "libraries is an array",
        read("[]").err(),
        Some(vec![wrong_type("", "object", "array")]),
    );
    t.eq(
        "an entry that is a string",
        read(r#"{"acme":"x"}"#).err(),
        Some(vec![wrong_type("/acme", "object", "string")]),
    );
    t.eq(
        "an entry that is null",
        read(r#"{"acme":null}"#).err(),
        Some(vec![wrong_type("/acme", "object", "null")]),
    );
    t.eq(
        "an empty entry",
        read(r#"{"acme":{}}"#).err(),
        Some(
            ["version", "digest", "modules"]
                .iter()
                .map(|f| format!(r#"{{"problem":"missing_field","at":"/acme","field":"{f}"}}"#))
                .collect(),
        ),
    );
    t.eq(
        "an unknown member",
        read(&format!(
            r#"{{"acme":{{"version":"1.0.0","digest":"{ok_digest}","modules":{{"acme":"{ok_digest}"}},"requires":{{}}}}}}"#
        ))
        .err(),
        Some(vec![r#"{"problem":"unknown_field","at":"/acme","field":"requires"}"#.to_owned()]),
    );
    for (version, fault) in [
        ("1.0", "components"),
        ("1", "components"),
        ("^1.0.0", "not_decimal"),
        ("1.0.0-rc1", "not_decimal"),
        ("01.0.0", "leading_zero"),
        ("", "empty"),
        // The schema allows nine digits; so does the crate.
        ("1000000000.0.0", "too_large"),
    ] {
        t.eq(
            &format!("version {version:?}"),
            read(&entry(
                version,
                &ok_digest,
                &format!(r#"{{"acme":"{ok_digest}"}}"#),
            ))
            .err(),
            Some(vec![format!(
                r#"{{"problem":"invalid_version","library":"acme","found":{},"fault":"{fault}"}}"#,
                s(version)
            )]),
        );
    }
    t.ok(
        "nine digits are fine",
        read(&entry(
            "999999999.0.0",
            &ok_digest,
            &format!(r#"{{"acme":"{ok_digest}"}}"#),
        ))
        .is_ok(),
    );
    let not_hex = d(1).replace('0', "g");
    let short = d(1)[1..].to_owned();
    for bad in ["", "sha256:00", not_hex.as_str(), short.as_str()] {
        t.eq(
            &format!("digest {bad:?}"),
            read(&entry(
                "1.0.0",
                bad,
                &format!(r#"{{"acme":"{ok_digest}"}}"#),
            ))
            .err(),
            Some(vec![format!(
                r#"{{"problem":"invalid_digest","library":"acme","found":{}}}"#,
                s(bad)
            )]),
        );
    }
    t.eq(
        "no module",
        read(&entry("1.0.0", &ok_digest, "{}")).err(),
        Some(vec![
            r#"{"problem":"no_modules","library":"acme"}"#.to_owned(),
        ]),
    );
    t.eq(
        "modules is an array",
        read(&entry("1.0.0", &ok_digest, "[]")).err(),
        Some(vec![wrong_type("/acme/modules", "object", "array")]),
    );
    t.eq(
        "a module hash that is not a string",
        read(&entry("1.0.0", &ok_digest, r#"{"acme":1}"#)).err(),
        Some(vec![wrong_type("/acme/modules/acme", "string", "number")]),
    );
    t.eq(
        "a module hash that is not a digest",
        read(&entry("1.0.0", &ok_digest, r#"{"acme":"sha256:xyz","acme.b":""}"#)).err(),
        Some(vec![
            r#"{"problem":"invalid_module_hash","library":"acme","module":"acme","found":"sha256:xyz"}"#.to_owned(),
            r#"{"problem":"invalid_module_hash","library":"acme","module":"acme.b","found":""}"#.to_owned(),
        ]),
    );
    t.eq(
        "a module of another library",
        read(&entry(
            "1.0.0",
            &ok_digest,
            &format!(r#"{{"other.x":"{ok_digest}"}}"#),
        ))
        .err(),
        Some(vec![
            r#"{"problem":"module_outside_library","library":"acme","module":"other.x"}"#
                .to_owned(),
        ]),
    );
    t.eq(
        "the prefix needs the dot",
        read(&entry(
            "1.0.0",
            &ok_digest,
            &format!(r#"{{"acmex":"{ok_digest}"}}"#),
        ))
        .err(),
        Some(vec![
            r#"{"problem":"module_outside_library","library":"acme","module":"acmex"}"#.to_owned(),
        ]),
    );
    t.eq(
        "a module that is not a name",
        read(&entry("1.0.0", &ok_digest, &format!(r#"{{"acme.Types":"{ok_digest}","acme.":"{ok_digest}"}}"#))).err(),
        Some(vec![
            r#"{"problem":"invalid_module_name","library":"acme","module":"acme.","fault":"empty_segment"}"#.to_owned(),
            r#"{"problem":"invalid_module_name","library":"acme","module":"acme.Types","fault":"upper_case"}"#.to_owned(),
        ]),
    );
    t.eq(
        "a library that is not a name",
        read(&format!(
            r#"{{"Acme":{{"version":"1.0.0","digest":"{ok_digest}","modules":{{"Acme":"{ok_digest}"}}}}}}"#
        ))
        .err(),
        Some(vec![
            r#"{"problem":"invalid_library_name","library":"Acme","fault":"upper_case"}"#.to_owned(),
            r#"{"problem":"invalid_module_name","library":"Acme","module":"Acme","fault":"upper_case"}"#.to_owned(),
        ]),
    );
    t.eq(
        "a library that is a device name",
        read(&format!(
            r#"{{"nul":{{"version":"1.0.0","digest":"{ok_digest}","modules":{{"nul":"{ok_digest}"}}}}}}"#
        ))
        .err(),
        Some(vec![
            r#"{"problem":"invalid_library_name","library":"nul","fault":"device_name"}"#.to_owned(),
            r#"{"problem":"invalid_module_name","library":"nul","module":"nul","fault":"device_name"}"#.to_owned(),
        ]),
    );
    // Libraries come by name, and each one's problems by member.
    t.eq(
        "two libraries",
        read(&format!(
            r#"{{"zed":{{"version":"1","digest":"x","modules":{{}}}},"acme":{{"version":"1.0.0","digest":"{ok_digest}","modules":{{"acme":"x"}}}}}}"#
        ))
        .err(),
        Some(vec![
            r#"{"problem":"invalid_module_hash","library":"acme","module":"acme","found":"x"}"#.to_owned(),
            r#"{"problem":"invalid_version","library":"zed","found":"1","fault":"components"}"#.to_owned(),
            r#"{"problem":"invalid_digest","library":"zed","found":"x"}"#.to_owned(),
            r#"{"problem":"no_modules","library":"zed"}"#.to_owned(),
        ]),
    );
    t.finish();
}

fn pin(version: &str, modules: &[(&str, u32)]) -> LockLibrary {
    let members: Vec<String> = modules
        .iter()
        .map(|(name, n)| format!("{}:{}", s(name), s(&d(*n))))
        .collect();
    let text = format!(
        r#"{{"acme":{{"version":"{version}","digest":"{}","modules":{{{}}}}}}}"#,
        d(100),
        members.join(",")
    );
    read(&text).unwrap().remove("acme").unwrap()
}

fn found(version: &str, digest_n: u32, modules: &[(&str, u32)]) -> FoundLibrary {
    FoundLibrary {
        version: v(version),
        digest: digest(digest_n),
        modules: modules
            .iter()
            .map(|(name, n)| ((*name).to_owned(), digest(*n)))
            .collect(),
    }
}

fn pin_problems(locked: &LockLibrary, found: &FoundLibrary) -> Vec<String> {
    compare_pin("acme", locked, found)
        .iter()
        .map(|p| json(p.to_js()))
        .collect()
}

#[test]
fn what_is_found_against_the_pin() {
    let locked = pin("2.3.0", &[("acme", 1), ("acme.types", 2)]);
    let mut t = Table::new();
    t.eq(
        "a match",
        pin_problems(
            &locked,
            &found("2.3.0", 100, &[("acme", 1), ("acme.types", 2)]),
        ),
        Vec::<String>::new(),
    );
    t.eq(
        "another version",
        pin_problems(
            &locked,
            &found("2.3.1", 100, &[("acme", 1), ("acme.types", 2)]),
        ),
        vec![
            r#"{"problem":"version_differs","library":"acme","locked":"2.3.0","found":"2.3.1"}"#
                .to_owned(),
        ],
    );
    t.eq(
        "another digest",
        pin_problems(
            &locked,
            &found("2.3.0", 101, &[("acme", 1), ("acme.types", 2)]),
        ),
        vec![format!(
            r#"{{"problem":"digest_differs","library":"acme","locked":"{}","found":"{}"}}"#,
            d(100),
            d(101)
        )],
    );
    t.eq(
        "a module that hashes otherwise",
        pin_problems(&locked, &found("2.3.0", 100, &[("acme", 1), ("acme.types", 3)])),
        vec![format!(
            r#"{{"problem":"module_hash_differs","library":"acme","module":"acme.types","locked":"{}","found":"{}"}}"#,
            d(2),
            d(3)
        )],
    );
    t.eq(
        "a module the lock lists and is not found",
        pin_problems(&locked, &found("2.3.0", 100, &[("acme", 1)])),
        vec![r#"{"problem":"module_missing","library":"acme","module":"acme.types"}"#.to_owned()],
    );
    t.eq(
        "a module found that the lock does not list",
        pin_problems(
            &locked,
            &found(
                "2.3.0",
                100,
                &[("acme", 1), ("acme.types", 2), ("acme.extra", 9)],
            ),
        ),
        vec![r#"{"problem":"module_unlisted","library":"acme","module":"acme.extra"}"#.to_owned()],
    );
    t.eq(
        "none found",
        pin_problems(&locked, &found("2.3.0", 100, &[])),
        vec![
            r#"{"problem":"module_missing","library":"acme","module":"acme"}"#.to_owned(),
            r#"{"problem":"module_missing","library":"acme","module":"acme.types"}"#.to_owned(),
        ],
    );
    t.eq(
        "everything at once: version, digest, then the modules by name",
        pin_problems(
            &locked,
            &found("1.0.0", 7, &[("acme.zed", 9), ("acme.types", 4), ("acme.extra", 5)]),
        ),
        vec![
            r#"{"problem":"version_differs","library":"acme","locked":"2.3.0","found":"1.0.0"}"#.to_owned(),
            format!(r#"{{"problem":"digest_differs","library":"acme","locked":"{}","found":"{}"}}"#, d(100), d(7)),
            r#"{"problem":"module_missing","library":"acme","module":"acme"}"#.to_owned(),
            r#"{"problem":"module_unlisted","library":"acme","module":"acme.extra"}"#.to_owned(),
            format!(
                r#"{{"problem":"module_hash_differs","library":"acme","module":"acme.types","locked":"{}","found":"{}"}}"#,
                d(2),
                d(4)
            ),
            r#"{"problem":"module_unlisted","library":"acme","module":"acme.zed"}"#.to_owned(),
        ],
    );
    // Module names are case-sensitive: the same letters in another case are
    // another module.
    t.eq(
        "another case",
        pin_problems(
            &pin("1.0.0", &[("acme", 1)]),
            &found("1.0.0", 100, &[("Acme", 1)]),
        ),
        vec![
            r#"{"problem":"module_unlisted","library":"acme","module":"Acme"}"#.to_owned(),
            r#"{"problem":"module_missing","library":"acme","module":"acme"}"#.to_owned(),
        ],
    );
    t.finish();
}

#[test]
fn a_library_the_lock_does_not_pin() {
    let mut pins = BTreeMap::new();
    pins.insert("acme".to_owned(), pin("1.0.0", &[("acme", 1)]));
    assert_eq!(find_pin(&pins, "acme").unwrap().version(), &v("1.0.0"));
    let err = find_pin(&pins, "other").unwrap_err();
    assert_eq!(
        err,
        PinProblem::NotPinned {
            library: "other".to_owned()
        }
    );
    assert_eq!(
        json(err.to_js()),
        r#"{"problem":"not_pinned","library":"other"}"#
    );
    // Names are not folded.
    assert!(find_pin(&pins, "Acme").is_err());
}

#[test]
fn a_module_pinned_twice() {
    let mut pins = BTreeMap::new();
    pins.insert(
        "acme".to_owned(),
        pin("1.0.0", &[("acme", 1), ("acme.types", 2)]),
    );
    let problems = |top: &[&str]| -> Vec<String> {
        modules_pinned_twice(top.iter().copied(), &pins)
            .iter()
            .map(|p| json(p.to_js()))
            .collect()
    };
    assert_eq!(problems(&[]), Vec::<String>::new());
    assert_eq!(problems(&["other", "acme.t"]), Vec::<String>::new());
    assert_eq!(
        problems(&["acme.types", "x", "acme", "acme"]),
        vec![
            r#"{"problem":"pinned_twice","module":"acme","library":"acme"}"#.to_owned(),
            r#"{"problem":"pinned_twice","module":"acme.types","library":"acme"}"#.to_owned(),
        ]
    );
}

#[test]
fn requires_against_the_pins() {
    let mut pins = BTreeMap::new();
    pins.insert("std.patterns".to_owned(), {
        let value = parse(&format!(
            r#"{{"std.patterns":{{"version":"1.0.0","digest":"{}","modules":{{"std.patterns":"{}"}}}}}}"#,
            d(1),
            d(2)
        ))
        .unwrap()
        .value;
        read_lock_libraries(Some(&value)).unwrap().remove("std.patterns").unwrap()
    });
    pins.insert("acme.util".to_owned(), pin("0.3.7", &[("acme", 1)]));
    let requires = |list: &[(&str, &str)]| -> BTreeMap<String, Range> {
        list.iter()
            .map(|(n, r)| ((*n).to_owned(), Range::parse(r).unwrap()))
            .collect()
    };
    let check = |list: &[(&str, &str)]| -> Vec<String> {
        check_requires("acme.connectors", &requires(list), &pins)
            .iter()
            .map(|p| json(p.to_js()))
            .collect()
    };
    let mut t = Table::new();
    t.eq("nothing required", check(&[]), Vec::<String>::new());
    t.eq(
        "met",
        check(&[("std.patterns", "^1.0"), ("acme.util", "^0.3")]),
        Vec::<String>::new(),
    );
    t.eq(
        "met, exact",
        check(&[("std.patterns", "1.0.0")]),
        Vec::<String>::new(),
    );
    t.eq(
        "met, ^0.3.7",
        check(&[("acme.util", "^0.3.7")]),
        Vec::<String>::new(),
    );
    t.eq(
        "not pinned",
        check(&[("std.missing", "^1")]),
        vec![r#"{"problem":"requirement_not_pinned","library":"acme.connectors","requirement":"std.missing","range":"^1"}"#.to_owned()],
    );
    t.eq(
        "outside the range",
        check(&[("std.patterns", "^2")]),
        vec![r#"{"problem":"requirement_out_of_range","library":"acme.connectors","requirement":"std.patterns","range":"^2","pinned":"1.0.0"}"#.to_owned()],
    );
    t.eq(
        "^0.3 does not hold 0.4.0 and ^0.2 does not hold 0.3.7",
        check(&[("acme.util", "^0.2")]),
        vec![r#"{"problem":"requirement_out_of_range","library":"acme.connectors","requirement":"acme.util","range":"^0.2","pinned":"0.3.7"}"#.to_owned()],
    );
    t.eq(
        "below the range, and exact",
        check(&[("std.patterns", "1.0.1"), ("acme.util", "^0.3.8")]),
        vec![
            r#"{"problem":"requirement_out_of_range","library":"acme.connectors","requirement":"acme.util","range":"^0.3.8","pinned":"0.3.7"}"#.to_owned(),
            r#"{"problem":"requirement_out_of_range","library":"acme.connectors","requirement":"std.patterns","range":"1.0.1","pinned":"1.0.0"}"#.to_owned(),
        ],
    );
    t.eq(
        "both kinds, by name",
        check(&[("zed", "^1"), ("std.patterns", "^3"), ("acme.util", "^0.3"), ("aaa", "^0")]),
        vec![
            r#"{"problem":"requirement_not_pinned","library":"acme.connectors","requirement":"aaa","range":"^0"}"#.to_owned(),
            r#"{"problem":"requirement_out_of_range","library":"acme.connectors","requirement":"std.patterns","range":"^3","pinned":"1.0.0"}"#.to_owned(),
            r#"{"problem":"requirement_not_pinned","library":"acme.connectors","requirement":"zed","range":"^1"}"#.to_owned(),
        ],
    );
    t.eq(
        "ids",
        RequireProblem::NotPinned {
            library: String::new(),
            requirement: String::new(),
            range: Range::parse("^1").unwrap(),
        }
        .id(),
        "requirement_not_pinned",
    );
    t.finish();
}
