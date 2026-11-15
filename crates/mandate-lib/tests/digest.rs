//! A library's digest: known answers computed outside the crate, pairs that
//! must differ, and what is refused.
//!
//! The known answers were made by a script that does not use this crate or
//! a JSON serializer: it writes the canonical text of
//! `{ name, version, requires, modules }` by hand (members in code-unit
//! order, no white space, strings without escapes since every name, range
//! and hash here is plain ASCII) and hashes
//! `"mandate/library/0.6\n" + text` with `node:crypto`'s SHA-256, written
//! `sha256:<hex>`. The program hashes of the modules are stand-ins: the
//! SHA-256 of `"program <label>"`. The canonical text of each case is in the
//! comment above it, so that the constants can be made again.

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
use mandate_lib::{
    Digest, DigestProblem, Manifest, is_digest, library_digest, module_name_problems, read_manifest,
};

const MAIN: &str = "sha256:ca02f86750baf59872450c93d10e60133dc2a0e5be935425f9a211476ba198d6";
const TYPES: &str = "sha256:da926f3fe82727455bdbba4b195151523aba6a6076135348dbcd306fa1fc0c90";
const MAIN_CHANGED: &str =
    "sha256:f3f8b83388ff0d982180dd582d9ac20e9a99da7cbda9932ac6b1e88e6e0c41d2";
const EXTRA: &str = "sha256:d2eebc9f2a9a91b1bf081451ffbd5758e4f3bb1aee8b20948e04f240133a392b";
const LIB_A: &str = "sha256:b091cf39ee7ae51bc34726b503fc9f164fe2a9e84c92a0edb4d2f4c0a6fac5df";

// {"modules":{"acme.connectors":"sha256:ca02…98d6","acme.connectors.types":"sha256:da92…0c90"},"name":"acme.connectors","requires":{"std.patterns":"^1.0"},"version":"2.3.0"}
const SPEC_EXAMPLE: &str =
    "sha256:8fa9c933d6115c6ab7376b2847a181934f32924bcd9c6402ac844e4f52986826";
// The same with "requires":{}
const NO_REQUIRES: &str = "sha256:33fa02b5d9cca553ec358925a1ef24a7fcb920e53ab3e7169afa72fbbec43174";
// Three modules, and "requires":{"acme.util":"^2","std.patterns":"^1.0"}
const SEVERAL_MODULES: &str =
    "sha256:764e9659541663560fb861a986766697dc201670ec250257886945981a2a0f88";
// {"modules":{"lib":"sha256:b091…c5df"},"name":"lib","requires":{"other":"1.2.3"},"version":"0.0.1"}
const EXACT_RANGE: &str = "sha256:36f4ce82251663c5536a9a271a430d4c92c381240fe89c4f56dc6e78058bc5d4";
// The specification's example, at version 2.3.1.
const ANOTHER_VERSION: &str =
    "sha256:9ae2dfbcd7df144644396776a7d0c7339e470bd58b1daa1ebbe43875a8a118c6";
// The specification's example, with "std.patterns":"^1.0.0".
const ANOTHER_RANGE: &str =
    "sha256:4342189f5479c31167bc972ccc379b9defd915239289fc25996269951e54a2b6";
// The specification's example, with "std.patterns":"^1.1".
const ANOTHER_RANGE_MINOR: &str =
    "sha256:a7a837fa2e2ff7969d2f744cbea230563f4734bd975efb1b62fb38b049771673";
// The specification's example, with another hash for `acme.connectors`.
const ANOTHER_MODULE_HASH: &str =
    "sha256:bcc354fcf627088e158a0fd408b12e57dba921bbff7bf689d2cb3fbff8582db6";
// The specification's example, with a third module `acme.connectors.extra`.
const MODULE_ADDED: &str =
    "sha256:2d81605e2b3ea62c9858f199f39c873dcf677964b1a33bd94e06065ae3deeddc";

fn manifest(version: &str, modules: &str, requires: &str) -> Manifest {
    read_manifest(&format!(
        r#"{{"library":"mandate/library/0.6","name":"acme.connectors","version":"{version}","modules":{modules},"requires":{requires}}}"#
    ))
    .unwrap()
}

fn spec_manifest() -> Manifest {
    manifest(
        "2.3.0",
        r#"["connectors.mdt","types.mdt"]"#,
        r#"{"std.patterns":"^1.0"}"#,
    )
}

fn digest_of(manifest: &Manifest, modules: &[(&str, &str)]) -> String {
    library_digest(manifest, modules).unwrap().to_string()
}

fn refusals(manifest: &Manifest, modules: &[(&str, &str)]) -> Vec<String> {
    library_digest(manifest, modules)
        .unwrap_err()
        .iter()
        .map(|p| json(p.to_js()))
        .collect()
}

const SPEC_MODULES: [(&str, &str); 2] =
    [("acme.connectors", MAIN), ("acme.connectors.types", TYPES)];

#[test]
fn known_answers_made_outside_the_crate() {
    let mut t = Table::new();
    t.eq(
        "the specification's example",
        digest_of(&spec_manifest(), &SPEC_MODULES),
        SPEC_EXAMPLE.to_owned(),
    );
    t.eq(
        "no requires",
        digest_of(
            &manifest("2.3.0", r#"["connectors.mdt","types.mdt"]"#, "{}"),
            &SPEC_MODULES,
        ),
        NO_REQUIRES.to_owned(),
    );
    t.eq(
        "several modules and requirements",
        digest_of(
            &manifest(
                "2.3.0",
                r#"["connectors.mdt","types.mdt","extra.mdt"]"#,
                r#"{"std.patterns":"^1.0","acme.util":"^2"}"#,
            ),
            &[
                ("acme.connectors", MAIN),
                ("acme.connectors.extra", EXTRA),
                ("acme.connectors.types", TYPES),
            ],
        ),
        SEVERAL_MODULES.to_owned(),
    );
    let lib = read_manifest(
        r#"{"library":"mandate/library/0.6","name":"lib","version":"0.0.1","modules":["lib.mdt"],"requires":{"other":"1.2.3"}}"#,
    )
    .unwrap();
    t.eq(
        "an exact range, one module",
        digest_of(&lib, &[("lib", LIB_A)]),
        EXACT_RANGE.to_owned(),
    );
    t.eq(
        "another version",
        digest_of(
            &manifest(
                "2.3.1",
                r#"["connectors.mdt","types.mdt"]"#,
                r#"{"std.patterns":"^1.0"}"#,
            ),
            &SPEC_MODULES,
        ),
        ANOTHER_VERSION.to_owned(),
    );
    t.eq(
        "another range, written ^1.0.0",
        digest_of(
            &manifest(
                "2.3.0",
                r#"["connectors.mdt","types.mdt"]"#,
                r#"{"std.patterns":"^1.0.0"}"#,
            ),
            &SPEC_MODULES,
        ),
        ANOTHER_RANGE.to_owned(),
    );
    t.eq(
        "another range, ^1.1",
        digest_of(
            &manifest(
                "2.3.0",
                r#"["connectors.mdt","types.mdt"]"#,
                r#"{"std.patterns":"^1.1"}"#,
            ),
            &SPEC_MODULES,
        ),
        ANOTHER_RANGE_MINOR.to_owned(),
    );
    t.eq(
        "another module hash",
        digest_of(
            &spec_manifest(),
            &[
                ("acme.connectors", MAIN_CHANGED),
                ("acme.connectors.types", TYPES),
            ],
        ),
        ANOTHER_MODULE_HASH.to_owned(),
    );
    t.eq(
        "a module added",
        digest_of(
            &spec_manifest(),
            &[
                ("acme.connectors", MAIN),
                ("acme.connectors.extra", EXTRA),
                ("acme.connectors.types", TYPES),
            ],
        ),
        MODULE_ADDED.to_owned(),
    );
    t.finish();
}

#[test]
fn the_answers_differ_where_the_libraries_do() {
    let all = [
        SPEC_EXAMPLE,
        NO_REQUIRES,
        SEVERAL_MODULES,
        EXACT_RANGE,
        ANOTHER_VERSION,
        ANOTHER_RANGE,
        ANOTHER_RANGE_MINOR,
        ANOTHER_MODULE_HASH,
        MODULE_ADDED,
    ];
    for (i, a) in all.iter().enumerate() {
        assert!(is_digest(a));
        for b in &all[i + 1..] {
            assert_ne!(a, b);
        }
    }
}

#[test]
fn what_does_not_change_a_digest() {
    let mut t = Table::new();
    // The order the modules are given in.
    t.eq(
        "module order",
        digest_of(
            &spec_manifest(),
            &[("acme.connectors.types", TYPES), ("acme.connectors", MAIN)],
        ),
        SPEC_EXAMPLE.to_owned(),
    );
    // The order of the manifest's `modules`, and the files they name.
    t.eq(
        "manifest module order",
        digest_of(
            &manifest(
                "2.3.0",
                r#"["types.mdt","connectors.mdt"]"#,
                r#"{"std.patterns":"^1.0"}"#,
            ),
            &SPEC_MODULES,
        ),
        SPEC_EXAMPLE.to_owned(),
    );
    t.eq(
        "other file names",
        digest_of(
            &manifest(
                "2.3.0",
                r#"["a/b.json","c.mdt"]"#,
                r#"{"std.patterns":"^1.0"}"#,
            ),
            &SPEC_MODULES,
        ),
        SPEC_EXAMPLE.to_owned(),
    );
    // An absent `requires` and an empty one.
    let absent = read_manifest(
        r#"{"library":"mandate/library/0.6","name":"acme.connectors","version":"2.3.0","modules":["a.mdt","b.mdt"]}"#,
    )
    .unwrap();
    t.eq(
        "absent requires",
        digest_of(&absent, &SPEC_MODULES),
        NO_REQUIRES.to_owned(),
    );
    // The order of `requires` as written.
    t.eq(
        "requires order",
        digest_of(
            &manifest(
                "2.3.0",
                r#"["a.mdt","b.mdt","c.mdt"]"#,
                r#"{"std.patterns":"^1.0","acme.util":"^2"}"#,
            ),
            &[
                ("acme.connectors.types", TYPES),
                ("acme.connectors", MAIN),
                ("acme.connectors.extra", EXTRA),
            ],
        ),
        SEVERAL_MODULES.to_owned(),
    );
    t.finish();
}

#[test]
fn a_digest_is_a_digest() {
    let digest = library_digest(&spec_manifest(), &SPEC_MODULES).unwrap();
    assert_eq!(digest.as_str(), SPEC_EXAMPLE);
    assert_eq!(digest.to_string(), SPEC_EXAMPLE);
    assert_eq!(Digest::parse(SPEC_EXAMPLE), Some(digest));
}

#[test]
fn what_is_a_digest() {
    let mut t = Table::new();
    let hex = "0123456789abcdef".repeat(4);
    t.ok("valid", is_digest(&format!("sha256:{hex}")));
    for (case, text) in [
        ("empty", String::new()),
        ("no prefix", hex.clone()),
        ("upper case hex", format!("sha256:{}", hex.to_uppercase())),
        ("one upper-case digit", format!("sha256:A{}", &hex[1..])),
        ("63 digits", format!("sha256:{}", &hex[1..])),
        ("65 digits", format!("sha256:{hex}0")),
        ("sha512", format!("sha512:{hex}")),
        ("upper-case prefix", format!("SHA256:{hex}")),
        ("a space", format!("sha256: {}", &hex[1..])),
        ("a trailing newline", format!("sha256:{hex}\n")),
        ("a g", format!("sha256:g{}", &hex[1..])),
        ("a non-ASCII digit", format!("sha256:\u{661}{}", &hex[1..])),
        ("only the prefix", "sha256:".to_owned()),
        ("a double colon", format!("sha256::{}", &hex[1..])),
        ("0x", format!("sha256:0x{}", &hex[2..])),
    ] {
        t.ok(case, !is_digest(&text));
    }
    t.finish();
}

#[test]
fn what_is_refused() {
    let spec = spec_manifest();
    let mut t = Table::new();
    t.eq(
        "no module",
        refusals(&spec, &[]),
        vec![r#"{"problem":"no_modules"}"#.to_owned()],
    );
    // The hash's shape.
    let upper = MAIN.to_uppercase().replace("SHA256", "sha256");
    let short = &MAIN[..MAIN.len() - 1];
    let long = format!("{MAIN}0");
    let bad_hashes: [(&str, String); 7] = [
        ("empty", String::new()),
        ("no prefix", MAIN[7..].to_owned()),
        ("upper case", upper),
        ("63 digits", short.to_owned()),
        ("65 digits", long),
        ("sha1", MAIN.replace("sha256", "sha1")),
        ("a trailing space", format!("{MAIN} ")),
    ];
    for (case, hash) in &bad_hashes {
        t.eq(
            &format!("hash: {case}"),
            refusals(&spec, &[("acme.connectors", MAIN), ("acme.connectors.types", hash.as_str())]),
            vec![format!(
                r#"{{"problem":"module_hash_malformed","module":"acme.connectors.types","found":{}}}"#,
                serde_str(hash)
            )],
        );
    }
    // The name: neither the library's nor under it with a dot.
    t.eq(
        "another library's module",
        refusals(&spec, &[("acme.connectors", MAIN), ("other.types", TYPES)]),
        vec![r#"{"problem":"module_outside_library","module":"other.types","library":"acme.connectors"}"#.to_owned()],
    );
    t.eq(
        "the prefix needs the dot",
        refusals(&spec, &[("acme.connectors", MAIN), ("acme.connectorsx", TYPES)]),
        vec![r#"{"problem":"module_outside_library","module":"acme.connectorsx","library":"acme.connectors"}"#.to_owned()],
    );
    t.eq(
        "the prefix needs the dot, with an underscore",
        refusals(&spec, &[("acme.connectors_types", TYPES)]),
        vec![r#"{"problem":"module_outside_library","module":"acme.connectors_types","library":"acme.connectors"}"#.to_owned()],
    );
    t.eq(
        "a parent library's name",
        refusals(&spec, &[("acme", MAIN)]),
        vec![
            r#"{"problem":"module_outside_library","module":"acme","library":"acme.connectors"}"#
                .to_owned(),
        ],
    );
    t.eq(
        "not a name at all",
        refusals(&spec, &[("acme.connectors.Types", TYPES), ("", MAIN)]),
        vec![
            r#"{"problem":"module_name_malformed","module":"","fault":"empty"}"#.to_owned(),
            r#"{"problem":"module_name_malformed","module":"acme.connectors.Types","fault":"upper_case"}"#.to_owned(),
        ],
    );
    t.eq(
        "a trailing dot",
        refusals(&spec, &[("acme.connectors.", TYPES)]),
        vec![r#"{"problem":"module_name_malformed","module":"acme.connectors.","fault":"empty_segment"}"#.to_owned()],
    );
    // Two modules with one name, with the same hash and with another.
    t.eq(
        "a name twice",
        refusals(
            &spec,
            &[("acme.connectors", MAIN), ("acme.connectors", MAIN)],
        ),
        vec![r#"{"problem":"duplicate_module_name","module":"acme.connectors"}"#.to_owned()],
    );
    t.eq(
        "a name twice with two hashes",
        refusals(
            &spec,
            &[("acme.connectors", MAIN), ("acme.connectors", TYPES)],
        ),
        vec![r#"{"problem":"duplicate_module_name","module":"acme.connectors"}"#.to_owned()],
    );
    // Module names are case-sensitive and lower-case by rule: a name that
    // differs in case from another is not a duplicate of it but, having an
    // upper-case letter, is not a name.
    t.eq(
        "names that differ in case",
        refusals(&spec, &[("acme.connectors.a", MAIN), ("acme.connectors.A", TYPES)]),
        vec![r#"{"problem":"module_name_malformed","module":"acme.connectors.A","fault":"upper_case"}"#.to_owned()],
    );
    // Every problem, names first, each by name.
    t.eq(
        "all at once",
        refusals(
            &spec,
            &[
                ("acme.connectors.z", "nope"),
                ("other", MAIN),
                ("acme.connectors.b", MAIN),
                ("acme.connectors.b", MAIN),
                ("acme.connectors.a", "sha256:00"),
            ],
        ),
        vec![
            r#"{"problem":"duplicate_module_name","module":"acme.connectors.b"}"#.to_owned(),
            r#"{"problem":"module_outside_library","module":"other","library":"acme.connectors"}"#.to_owned(),
            r#"{"problem":"module_hash_malformed","module":"acme.connectors.a","found":"sha256:00"}"#.to_owned(),
            r#"{"problem":"module_hash_malformed","module":"acme.connectors.z","found":"nope"}"#.to_owned(),
        ],
    );
    t.finish();
}

fn serde_str(text: &str) -> String {
    mandate_ir::stringify(&mandate_ir::JsValue::from(text)).unwrap()
}

#[test]
fn the_names_of_modules_are_checked_alone_too() {
    let mut t = Table::new();
    let names = |library: &str, modules: &[&str]| -> Vec<String> {
        module_name_problems(library, modules)
            .iter()
            .map(|p| json(p.to_js()))
            .collect()
    };
    t.eq("none", names("acme", &[]), Vec::<String>::new());
    t.eq(
        "fine",
        names("acme", &["acme", "acme.x", "acme.x.y"]),
        Vec::<String>::new(),
    );
    t.eq(
        "two modules with one name",
        names("acme", &["acme.x", "acme", "acme.x"]),
        vec![r#"{"problem":"duplicate_module_name","module":"acme.x"}"#.to_owned()],
    );
    t.eq(
        "three times is one problem",
        names("acme", &["acme.x", "acme.x", "acme.x"]),
        vec![r#"{"problem":"duplicate_module_name","module":"acme.x"}"#.to_owned()],
    );
    t.eq(
        "outside and twice",
        names("acme", &["acmex.y", "acmex.y", "acme.z"]),
        vec![
            r#"{"problem":"module_outside_library","module":"acmex.y","library":"acme"}"#
                .to_owned(),
            r#"{"problem":"duplicate_module_name","module":"acmex.y"}"#.to_owned(),
        ],
    );
    t.eq(
        "the identifier of no modules",
        DigestProblem::NoModules.id(),
        "no_modules",
    );
    t.finish();
}
