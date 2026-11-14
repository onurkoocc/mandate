//! The run-time authority decisions (`src/grant.rs`) against their
//! reference, `bridge/src/authority.ts`, through their JSON doors (`grant`,
//! `narrow`, `map_scopes`, `in_flight_overlap`), on two sets of cases:
//!
//! - `bridge/test/authority-cases.json`, the recorded cases, read where
//!   they are (the bridge's own test, `bridge/test/authority.test.ts`, holds
//!   the TypeScript to the same file): `[{ name, fn, input, output }]`;
//! - `vectors/authority/cases.json`, generated cases, which
//!   `scripts/authority-vectors.mjs` writes from the built TypeScript (see
//!   `vectors/README.md`): `{ format, generator, seed, counts, cases: [{ fn,
//!   input, output }] }`.
//!
//! Each case goes through the door of its function, as `{ input }`, twice:
//! both answers must be the same text, and the output must be the recorded
//! one as a JSON value (array order significant, the order of an object's
//! members not), and also as text, which the door contract makes the
//! TypeScript's member order too. Every failing case is counted before the
//! test fails, so that a run shows how many differ.

#![allow(clippy::panic, clippy::expect_used, missing_docs)]

use std::collections::BTreeMap;

use mandate_check::json_doors::door;
use mandate_check::{
    AuthorityContext, CapVal, Capability, GrantDelegation, GrantInput, GrantOutput, grant,
};
use mandate_ir::{JsValue, Map, Value, canonicalize, parse, stringify};
use mandate_testkit::read_json;

const RECORDED: &str = "bridge/test/authority-cases.json";
const GENERATED: &str = "vectors/authority/cases.json";
const FORMAT: &str = "mandate/vectors/authority/0.1";
const HOW: &str = "the file is written by `node scripts/authority-vectors.mjs`, \
                   after `npm ci --ignore-scripts && npm run build`";

/// The door of each function of `bridge/src/authority.ts`.
const FUNCTIONS: [(&str, &str); 4] = [
    ("grant", "grant"),
    ("narrow", "narrow"),
    ("mapScopes", "map_scopes"),
    ("inFlightOverlap", "in_flight_overlap"),
];

/// The kinds of result of each function: the member names of its result
/// object, and for `inFlightOverlap` whether the overlap is `null`.
const KINDS: [(&str, &[&str]); 4] = [
    ("grant", &["available", "granted", "refused"]),
    ("narrow", &["caps", "partial", "notText", "refused"]),
    ("mapScopes", &["items,writes", "partial", "refused"]),
    ("inFlightOverlap", &["clear", "refused"]),
];

/// The kind of result `output` is, for function `f`.
fn kind_of(f: &str, output: &Value) -> String {
    let Some(members) = output.as_object() else {
        return "not an object".to_owned();
    };
    if f == "inFlightOverlap" {
        return match members.get("overlap") {
            Some(Value::Null) => "clear".to_owned(),
            Some(_) => "refused".to_owned(),
            None => "no overlap".to_owned(),
        };
    }
    members.keys().collect::<Vec<_>>().join(",")
}

/// One case through the door of its function, twice: what is wrong, if
/// anything.
fn run(f: &str, input: &Value, output: &Value) -> Result<(), String> {
    let name = FUNCTIONS
        .iter()
        .find(|(ts, _)| *ts == f)
        .map(|(_, d)| *d)
        .ok_or_else(|| format!("no function {f}"))?;
    let d = door(name).ok_or_else(|| format!("no door {name}"))?;
    let mut call = Map::new();
    call.insert("input", input.clone());
    let call = Value::Object(call);
    let answer = |n: &str| -> Result<String, String> {
        let out = (d.call)(&call)
            .map_err(|e| format!("the {n} call is {}: {}", e.kind.as_str(), e.message))?;
        stringify(&out).ok_or_else(|| format!("the {n} call gives undefined"))
    };
    let first = answer("first")?;
    let second = answer("second")?;
    if first != second {
        return Err(format!("two calls gave two answers: {first} and {second}"));
    }
    let got = parse(&first)
        .map_err(|_| format!("the output is not strict JSON: {first}"))?
        .value;
    let want = stringify(&JsValue::from(output)).unwrap_or_default();
    if canonicalize(&got) != canonicalize(output) {
        return Err(format!("expected {want}\n    got      {first}"));
    }
    if first != want {
        return Err(format!(
            "the same value, its members in another order: expected {want}\n    got      {first}"
        ));
    }
    Ok(())
}

/// What a run of a set of cases found: cases by function and by kind, and
/// what failed.
#[derive(Default)]
struct Tally {
    by_kind: BTreeMap<String, BTreeMap<String, usize>>,
    failed: Vec<String>,
}

impl Tally {
    fn case(&mut self, label: &str, f: &str, input: Option<&Value>, output: Option<&Value>) {
        let (Some(input), Some(output)) = (input, output) else {
            self.failed.push(format!("{label}: no input or no output"));
            return;
        };
        let count = self
            .by_kind
            .entry(f.to_owned())
            .or_default()
            .entry(kind_of(f, output))
            .or_default();
        *count = count.saturating_add(1);
        if let Err(e) = run(f, input, output) {
            self.failed.push(format!("{label}: {e}"));
        }
    }

    fn total(&self) -> usize {
        self.by_kind.values().flat_map(BTreeMap::values).sum()
    }

    fn per_function(&self) -> String {
        self.by_kind
            .iter()
            .map(|(f, kinds)| {
                let n: usize = kinds.values().sum();
                let parts: Vec<String> = kinds.iter().map(|(k, c)| format!("{k} {c}")).collect();
                format!("{f} {n} ({})", parts.join(", "))
            })
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// Fails with every failure, counted, or prints the summary.
    fn finish(&self, what: &str) {
        let summary = format!(
            "{what}: {} cases, {} failed: {}",
            self.total(),
            self.failed.len(),
            self.per_function()
        );
        println!("{summary}");
        if !self.failed.is_empty() {
            panic!("{summary}\n{}", self.failed.join("\n"));
        }
    }

    /// Whether every function has cases of every kind it has, and no other.
    fn every_kind(&self) -> Result<(), String> {
        let mut wrong = Vec::new();
        for (f, kinds) in KINDS {
            let have = self.by_kind.get(f).cloned().unwrap_or_default();
            for k in kinds {
                if !have.contains_key(*k) {
                    wrong.push(format!("{f} has no case whose result is {k}"));
                }
            }
            for k in have.keys() {
                if !kinds.contains(&k.as_str()) {
                    wrong.push(format!("{f} has a result of kind {k}"));
                }
            }
        }
        if wrong.is_empty() {
            Ok(())
        } else {
            Err(wrong.join("\n"))
        }
    }
}

#[test]
fn recorded_cases_answer_as_the_typescript() {
    let file = read_json(RECORDED).expect("the recorded cases");
    let cases = file.as_array().expect("a list of cases");
    let mut tally = Tally::default();
    for c in cases {
        let name = c.get("name").and_then(Value::as_str).unwrap_or("?");
        let f = c.get("fn").and_then(Value::as_str).unwrap_or("?");
        tally.case(&format!("{f}: {name}"), f, c.get("input"), c.get("output"));
    }
    if let Err(e) = tally.every_kind() {
        tally.failed.push(e);
    }
    tally.finish("recorded authority cases (bridge/test/authority-cases.json)");
}

#[test]
fn generated_vectors_answer_as_the_typescript() {
    let file = read_json(GENERATED).unwrap_or_else(|e| panic!("{e}; {HOW}"));
    assert_eq!(
        file.get("format").and_then(Value::as_str),
        Some(FORMAT),
        "{HOW}"
    );
    let cases = file
        .get("cases")
        .and_then(Value::as_array)
        .expect("a list of cases");
    let mut tally = Tally::default();
    for (i, c) in cases.iter().enumerate() {
        let f = c.get("fn").and_then(Value::as_str).unwrap_or("?");
        tally.case(
            &format!("case {i} ({f})"),
            f,
            c.get("input"),
            c.get("output"),
        );
    }
    if let Err(e) = tally.every_kind() {
        tally.failed.push(e);
    }
    // The counts the generator printed and wrote are the cases' own.
    let counts: BTreeMap<String, BTreeMap<String, usize>> = file
        .get("counts")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(f, kinds)| {
                    let kinds = kinds
                        .as_object()
                        .map(|k| {
                            k.iter()
                                .map(|(k, n)| {
                                    let n = n.as_i64().and_then(|n| usize::try_from(n).ok());
                                    (k.to_owned(), n.unwrap_or(usize::MAX))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    (f.to_owned(), kinds)
                })
                .collect()
        })
        .unwrap_or_default();
    if counts != tally.by_kind {
        tally.failed.push(format!(
            "the counts the file states are not its cases': {HOW}"
        ));
    }
    tally.finish("generated authority vectors (vectors/authority/cases.json)");
}

/// The typed functions, from Rust: what a later slice builds on. A
/// capability made with [`Capability::new`] is written as its [`CapVal`].
#[test]
fn the_typed_functions_take_capabilities_made_in_rust() {
    let write = |scope: &str| {
        let mut c = CapVal::new("fs.write", "Fs.Write", true);
        c.set_scope(Some(vec![scope.to_owned()]));
        Capability::new(c)
    };
    let input = GrantInput {
        context: AuthorityContext {
            bounds: vec![write("/work")],
            given: Vec::new(),
            handed: Vec::new(),
        },
        delegation: Some(GrantDelegation {
            agent: "coder".to_owned(),
            held: vec![write("/work/b"), write("/work/a"), write("/etc")],
            remote: false,
            own: Vec::new(),
        }),
    };
    let GrantOutput::Granted(granted) = grant(&input) else {
        panic!("not granted");
    };
    let scopes: Vec<&str> = granted
        .iter()
        .filter_map(|c| c.cap().scope().and_then(<[String]>::first))
        .map(String::as_str)
        .collect();
    assert_eq!(scopes, ["/work/a", "/work/b"]);
    assert_eq!(
        stringify(&JsValue::Object(grant(&input).to_js())),
        Some(
            r#"{"granted":[{"ctor":"fs.write","effect":"Fs.Write","write":true,"scope":["/work/a"]},{"ctor":"fs.write","effect":"Fs.Write","write":true,"scope":["/work/b"]}]}"#
                .to_owned()
        )
    );
}
