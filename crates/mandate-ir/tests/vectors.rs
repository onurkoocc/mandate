//! Reads the vectors the TypeScript compiler writes (`vectors/`, see
//! `vectors/README.md`) and checks that this crate gives the same bytes:
//! the same canonical text, spans and diagnostics from the reader, the same
//! canonical text, and the same hashes. Every mismatch is listed before the
//! test fails.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_ir::{
    Diagnostic, HashDomain, JsValue, Map, Parsed, Value, canonicalize, domain_hash, hash_program,
    package_hash, parse, parse_bytes, stringify,
};
use mandate_testkit::{files, read_bytes, read_json, sha256};

/// Reads a vector file with this crate's own reader.
fn read(rel: &str) -> Value {
    read_json(rel).unwrap_or_else(|e| panic!("{e}"))
}

fn field<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or_else(|| panic!("no field {key}"))
}

fn str_field<'a>(v: &'a Value, key: &str) -> &'a str {
    field(v, key)
        .as_str()
        .unwrap_or_else(|| panic!("{key} is not a string"))
}

fn count(v: &Value) -> usize {
    usize::try_from(v.as_i64().expect("a count")).expect("a count")
}

fn hex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

/// Shortens a long text for a failure message.
fn short(s: &str) -> String {
    if s.chars().count() <= 400 {
        return s.to_owned();
    }
    let head: String = s.chars().take(400).collect();
    format!("{head}... ({} bytes)", s.len())
}

#[derive(Default)]
struct Failures(Vec<String>);

impl Failures {
    fn check(&mut self, what: &str, expected: &str, actual: &str) {
        if expected != actual {
            self.0.push(format!(
                "{what}\n    expected: {}\n    actual:   {}",
                short(expected),
                short(actual)
            ));
        }
    }

    fn finish(self, checked: usize, what: &str) {
        assert!(checked > 0, "no {what} vectors were checked");
        assert!(
            self.0.is_empty(),
            "{} of {checked} {what} vectors differ from TypeScript:\n\n{}",
            self.0.len(),
            self.0.join("\n\n")
        );
    }
}

fn spans_value(parsed: &Parsed) -> Value {
    Value::Object(
        parsed
            .spans
            .iter()
            .map(|(path, span)| (path.clone(), span.to_value()))
            .collect::<Map>(),
    )
}

/// The diagnostics as `JSON.stringify` writes them. The vectors keep the
/// members in the order TypeScript gives them, so this compares that order
/// too (`at` is `{ span, path }` from the reader's `fail`, for one).
fn diagnostics_text(diags: &[Diagnostic]) -> String {
    stringify(&JsValue::Array(
        diags.iter().map(Diagnostic::to_js).collect(),
    ))
    .unwrap_or_default()
}

/// What a reader vector gives this crate's reader, by the form of its input.
fn read_input(v: &Value) -> Result<Parsed, Vec<Diagnostic>> {
    if let Some(text) = v.get("input") {
        return parse(text.as_str().expect("input is a string"));
    }
    if let Some(parts) = v.get("input_parts") {
        let mut text = String::new();
        for part in parts.as_array().expect("input_parts is an array") {
            let part = part.as_array().expect("a part is [text, count]");
            text.push_str(&part[0].as_str().expect("text").repeat(count(&part[1])));
        }
        return parse(&text);
    }
    let mut bytes = Vec::new();
    for part in field(v, "input_bytes")
        .as_array()
        .expect("input_bytes is an array")
    {
        let part = part.as_array().expect("a part is [hex, count]");
        let unit = hex(part[0].as_str().expect("hex"));
        for _ in 0..count(&part[1]) {
            bytes.extend_from_slice(&unit);
        }
    }
    parse_bytes(&bytes)
}

#[test]
fn reader() {
    let file = read("vectors/reader.json");
    assert_eq!(str_field(&file, "format"), "mandate/vectors/reader/0.1");
    let vectors = field(&file, "vectors").as_array().unwrap();
    let mut failures = Failures::default();
    for v in vectors {
        let name = str_field(v, "name");
        let ok = field(v, "ok") == &Value::Bool(true);
        match (read_input(v), ok) {
            (Ok(parsed), true) => {
                let canonical = canonicalize(&parsed.value);
                if let Some(expected) = v.get("canonical") {
                    failures.check(
                        &format!("{name}: canonical text"),
                        expected.as_str().unwrap(),
                        &canonical,
                    );
                } else {
                    failures.check(
                        &format!("{name}: SHA-256 of the canonical text"),
                        &format!("sha256:{}", str_field(v, "canonical_sha256")),
                        &sha256(&canonical),
                    );
                }
                failures.check(
                    &format!("{name}: spans"),
                    &canonicalize(field(v, "spans")),
                    &canonicalize(&spans_value(&parsed)),
                );
            }
            (Err(diags), false) => failures.check(
                &format!("{name}: diagnostics"),
                &stringify(&JsValue::from(field(v, "diagnostics"))).unwrap_or_default(),
                &diagnostics_text(&diags),
            ),
            (Ok(parsed), false) => failures.check(
                &format!("{name}: refused in TypeScript, accepted here"),
                &canonicalize(field(v, "diagnostics")),
                &canonicalize(&parsed.value),
            ),
            (Err(diags), true) => failures.check(
                &format!("{name}: accepted in TypeScript, refused here"),
                v.get("canonical")
                    .and_then(Value::as_str)
                    .unwrap_or("(long)"),
                &diagnostics_text(&diags),
            ),
        }
    }
    failures.finish(vectors.len(), "reader");
}

#[test]
fn canonical_text() {
    let file = read("vectors/jcs.json");
    assert_eq!(str_field(&file, "format"), "mandate/vectors/jcs/0.1");
    let vectors = field(&file, "vectors").as_array().unwrap();
    let mut failures = Failures::default();
    for v in vectors {
        let name = str_field(v, "name");
        match parse(str_field(v, "input")) {
            Ok(parsed) => failures.check(
                name,
                str_field(v, "canonical"),
                &canonicalize(&parsed.value),
            ),
            Err(d) => failures.check(name, str_field(v, "canonical"), &format!("refused: {d:?}")),
        }
    }
    failures.finish(vectors.len(), "canonical-text");
}

fn input_value(v: &Value, key: &str) -> Value {
    parse(str_field(v, key))
        .unwrap_or_else(|d| panic!("{key} does not read: {d:?}"))
        .value
}

fn defs_value(defs: &[(String, String)]) -> Value {
    Value::Array(
        defs.iter()
            .map(|(n, h)| Value::Array(vec![n.as_str().into(), h.as_str().into()]))
            .collect(),
    )
}

#[test]
fn hashes() {
    let file = read("vectors/hash.json");
    assert_eq!(str_field(&file, "format"), "mandate/vectors/hash/0.1");
    let mut failures = Failures::default();
    let mut checked = 0;

    for v in field(&file, "domain").as_array().unwrap() {
        let domain = HashDomain::from_name(str_field(v, "domain")).expect("a known domain");
        let version = str_field(v, "version");
        let what = format!("{} under {version:?}", domain.as_str());
        let actual = domain_hash(domain, &input_value(v, "input"), version);
        failures.check(&what, str_field(v, "hash"), &actual);
        checked += 1;
    }

    for v in field(&file, "program").as_array().unwrap() {
        let name = str_field(v, "name");
        let h = hash_program(&input_value(v, "input"));
        failures.check(
            &format!("{name}: program"),
            str_field(v, "program"),
            &h.program,
        );
        failures.check(
            &format!("{name}: defs"),
            &canonicalize(field(v, "defs")),
            &canonicalize(&defs_value(&h.defs)),
        );
        checked += 1;
    }

    for v in field(&file, "package").as_array().unwrap() {
        let name = str_field(v, "name");
        let actual = package_hash(str_field(v, "program_hash"), &input_value(v, "lock"));
        failures.check(name, str_field(v, "hash"), &actual);
        checked += 1;
    }
    failures.finish(checked, "hash");
}

#[test]
fn programs() {
    let files = files("vectors/programs").expect("vectors/programs");
    let mut failures = Failures::default();
    for name in &files {
        let v = read(&format!("vectors/programs/{name}"));
        assert_eq!(str_field(&v, "format"), "mandate/vectors/program/0.1");
        let source = str_field(&v, "source");
        let ir = field(&v, "ir");
        let canonical = str_field(&v, "canonical");

        // The IR in the compiler's member order, canonicalised here.
        failures.check(
            &format!("{source}: canonical text"),
            canonical,
            &canonicalize(ir),
        );
        // The canonical text, read and written again, is itself.
        match parse(canonical) {
            Ok(p) => failures.check(
                &format!("{source}: canonical text read again"),
                canonical,
                &canonicalize(&p.value),
            ),
            Err(d) => failures.check(
                &format!("{source}: canonical text read again"),
                canonical,
                &format!("refused: {d:?}"),
            ),
        }
        // A JSON source is read from its file too.
        if str_field(&v, "kind") == "json" {
            let bytes = read_bytes(source).expect("the source file");
            let actual = match parse_bytes(&bytes) {
                Ok(p) => canonicalize(&p.value),
                Err(d) => format!("refused: {d:?}"),
            };
            failures.check(&format!("{source}: read from the file"), canonical, &actual);
        }

        let h = hash_program(ir);
        let hashes = field(&v, "hashes");
        failures.check(
            &format!("{source}: program hash"),
            str_field(hashes, "program"),
            &h.program,
        );
        failures.check(
            &format!("{source}: definition hashes"),
            &canonicalize(field(hashes, "defs")),
            &canonicalize(&defs_value(&h.defs)),
        );
        if let Some(lock) = v.get("lock") {
            failures.check(
                &format!("{source}: package hash"),
                str_field(&v, "package"),
                &package_hash(&h.program, lock),
            );
        }
    }
    failures.finish(files.len(), "program");
}
