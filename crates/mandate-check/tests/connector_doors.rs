//! The two doors of the runtime's use of connectors
//! (`json_doors::LIBRARY_DOORS`, which no TypeScript function of the
//! compiler stands for):
//!
//! - `tool_schema_digest` gives, for each tool of
//!   `vectors/tool-schema-digest.json`, the digest and the canonical text
//!   that `schemaDigest` of `runtime/src/mcp-client.ts` gave when
//!   `scripts/tool-digest-vectors.mjs` wrote the file, and refuses each text
//!   the file lists as refused;
//! - `callable_connectors` gives the connectors the check demands a lock
//!   entry for (E1407), on programs where a declared connector is not
//!   callable, is callable through a `tool.call` capability (a workflow's or
//!   an agent's), and comes from another module.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeSet;

use mandate_check::json_doors::{library_door, tool_canonical};
use mandate_check::{CheckOptions, ModuleSource, Modules, check, load_modules};
use mandate_ir::{JsObject, JsValue, Value, parse, stringify};
use mandate_syntax::SourceKind;
use mandate_testkit::{read_json, read_text};

const VECTORS: &str = "vectors/tool-schema-digest.json";

fn value(v: &JsValue) -> Value {
    parse(&stringify(v).unwrap()).unwrap().value
}

/// What a door gives for `input`: its output text, or its refusal's kind.
fn call(door: &str, input: &JsObject) -> Result<String, String> {
    let d = library_door(door).unwrap();
    (d.call)(&value(&JsValue::Object(input.clone())))
        .map(|o| stringify(&o).unwrap())
        .map_err(|e| e.kind.as_str().to_owned())
}

fn digest_of(text: &str) -> Result<String, String> {
    call("tool_schema_digest", &JsObject::new().with("tool", text))
}

#[test]
fn the_digest_is_what_the_runtime_function_gave_for_each_vector() {
    let file = read_json(VECTORS).unwrap();
    let vectors = file.get("vectors").and_then(Value::as_array).unwrap();
    assert!(vectors.len() >= 30, "{} vectors", vectors.len());
    let mut digests = BTreeSet::new();
    for v in vectors {
        let name = v.get("name").and_then(Value::as_str).unwrap();
        let tool = v.get("tool").and_then(Value::as_str).unwrap();
        let canonical = v.get("canonical").and_then(Value::as_str).unwrap();
        let digest = v.get("digest").and_then(Value::as_str).unwrap();
        assert_eq!(
            tool_canonical(tool).unwrap(),
            canonical,
            "{name}: canonical"
        );
        assert_eq!(
            digest_of(tool).unwrap(),
            format!("\"{digest}\""),
            "{name}: digest"
        );
        digests.insert(digest);
    }
    let refused = file.get("refused").and_then(Value::as_array).unwrap();
    assert!(refused.len() >= 20, "{} refused texts", refused.len());
    for v in refused {
        let name = v.get("name").and_then(Value::as_str).unwrap();
        let tool = v.get("tool").and_then(Value::as_str).unwrap();
        assert_eq!(digest_of(tool), Err("bad_input".to_owned()), "{name}");
    }
    println!(
        "tool_schema_digest: {} tools equal to the runtime's digest ({} distinct), {} texts refused",
        vectors.len(),
        digests.len(),
        refused.len()
    );
}

#[test]
fn the_door_reads_what_the_vectors_cannot_hold() {
    // A tool nested deeper than the door reads is refused, and one at the
    // limit is read.
    let nest = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
    let tool = |n: usize| format!("{{\"name\":\"x\",\"inputSchema\":{}}}", nest(n));
    assert!(digest_of(&tool(500)).is_ok());
    assert_eq!(digest_of(&tool(600)), Err("bad_input".to_owned()));
    // Equal texts of one tool give one digest, in whatever order and form.
    let a = digest_of(r#"{"name":"t","inputSchema":{"b":1.0,"a":[1e2]}}"#);
    let b = digest_of(r#"{"inputSchema":{"a":[100],"b":1},"name":"t"}"#);
    assert_eq!(a, b);
    // outputSchema counts, other members do not.
    let plain = digest_of(r#"{"name":"t","inputSchema":{}}"#).unwrap();
    let described = digest_of(r#"{"name":"t","inputSchema":{},"description":"d"}"#).unwrap();
    let with_output = digest_of(r#"{"name":"t","inputSchema":{},"outputSchema":{}}"#).unwrap();
    assert_eq!(plain, described);
    assert_ne!(plain, with_output);
    // The input is a text: an object is refused, so is a member that is not
    // the door's.
    let d = library_door("tool_schema_digest").unwrap();
    for text in [
        r#"{"tool":{"name":"t"}}"#,
        r#"{"tool":null}"#,
        r#"{"tool":1}"#,
        r#"{}"#,
        r#"{"tool":"{}","made_up":1}"#,
    ] {
        let e = (d.call)(&parse(text).unwrap().value).unwrap_err();
        assert_eq!(e.kind.as_str(), "bad_input", "{text}");
    }
}

// ----------------------------------------------------------- callable_connectors

const OWN: &str = "conformance/T01/program.mdt";
const DRAFTS: &str = "fixtures/library/drafts.mdt";
const TYPES: &str = "fixtures/library/acme.connectors/types.mdt";
const CONNECTORS: &str = "fixtures/library/acme.connectors/connectors.mdt";
/// A lock with no connector in it, so that every connector the package can
/// call is E1407 `no_entry`.
const LOCK: &str = "conformance/E1407/mandate.lock.json";

fn modules() -> Modules {
    let texts: Vec<(String, String)> = [TYPES, CONNECTORS]
        .iter()
        .map(|f| ((*f).to_owned(), read_text(f).unwrap()))
        .collect();
    let sources: Vec<ModuleSource<'_>> = texts
        .iter()
        .map(|(file, text)| ModuleSource {
            text,
            kind: SourceKind::Mdt,
            file,
        })
        .collect();
    let r = load_modules(&sources);
    assert!(r.problems.is_empty(), "{:?}", r.problems);
    r.modules
}

/// `text` with `from` replaced by `to`, which it holds once.
fn changed(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "{from}");
    text.replacen(from, to, 1)
}

/// What the door says, as `id` of each connector, for the program `text`
/// with its modules, which must be the connectors the check demands an entry
/// for: its E1407 `no_entry` diagnostics against a lock that binds none, in
/// order.
fn callable(text: &str, modules: Option<&Modules>) -> Vec<String> {
    let lock = read_json(LOCK).unwrap();
    let free = check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            modules,
            ..CheckOptions::default()
        },
    );
    assert!(free.ok, "{:?}", free.diagnostics);
    let ids = |out: &str| -> Vec<(String, String)> {
        let v = parse(out).unwrap().value;
        v.as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c.get("id").and_then(Value::as_str).unwrap().to_owned(),
                    c.get("name").and_then(Value::as_str).unwrap().to_owned(),
                )
            })
            .collect()
    };
    // The program as the package has it, with the modules it imports.
    let mut input = JsObject::new().with("program", JsValue::from(free.program.as_ref().unwrap()));
    if let Some(m) = modules {
        input = input.with("modules", JsValue::from(&Value::Object(m.clone())));
    }
    let from_written = ids(&call("callable_connectors", &input).unwrap());
    // What the check demands, with a lock that binds nothing.
    let bound = check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            lock: Some(&lock),
            modules,
            ..CheckOptions::default()
        },
    );
    let demanded: Vec<String> = bound
        .diagnostics
        .iter()
        .filter(|d| d.code == "MDT-E1407")
        .filter_map(|d| {
            let facts = d.facts.as_ref()?;
            let problem = facts.get("problem")?.as_str()?;
            (problem == "no_entry").then(|| facts.get("connector")?.as_str().map(str::to_owned))?
        })
        .collect();
    let given: Vec<String> = from_written.iter().map(|(id, _)| id.clone()).collect();
    assert_eq!(given, demanded, "the door and E1407");
    for (id, name) in &from_written {
        assert!(
            id.ends_with(&format!(".{name}")),
            "{id} is not <module>.{name}"
        );
    }
    given
}

const LEDGER: &str = r#"
/// A ledger nothing calls.
connector ledger = mcp("https://ledger.example.com/mcp")
  version "1.0"
  class   internal
{
  tool balance(account: Text) -> Untrusted<Int>
    read_only
}

"#;

#[test]
fn a_connector_nobody_calls_is_not_callable() {
    let own = read_text(OWN).unwrap();
    assert_eq!(callable(&own, None), ["example.erp.erp"]);
    // A second connector, declared, with no capability to call it.
    let declared = changed(
        &own,
        "capability ErpRead ",
        &format!("{LEDGER}capability ErpRead "),
    );
    assert_eq!(callable(&declared, None), ["example.erp.erp"]);
    // With a capability for it that nothing holds, it is still not callable.
    let unheld = changed(
        &declared,
        "capability ModelAll",
        "capability LedgerRead = tool.call(ledger, balance)\ncapability ModelAll",
    );
    assert_eq!(callable(&unheld, None), ["example.erp.erp"]);
}

#[test]
fn a_connector_is_callable_through_a_capability_of_a_workflow_or_of_an_agent() {
    let own = read_text(OWN).unwrap();
    let declared = changed(
        &own,
        "capability ErpRead ",
        &format!("{LEDGER}capability ErpRead "),
    );
    // An agent that no workflow delegates to holds the capability: the
    // connector can be called, by the agent.
    let by_agent = changed(
        &changed(
            &declared,
            "capability ModelAll",
            "capability LedgerRead = tool.call(ledger, balance)\ncapability ModelAll",
        ),
        "workflow Draft(",
        "agent Auditor {\n  role   \"Reads the balance of an account.\"\n  caps   LedgerRead, ModelAll\n  budget { tokens: 10k, steps: 2 }\n  skill balance_of(account: Text) -> Inferred<Text> ! {Tool, Model}\n}\n\nworkflow Draft(",
    );
    assert_eq!(
        callable(&by_agent, None),
        ["example.erp.erp", "example.erp.ledger"]
    );
    // A workflow holds it and calls it.
    let by_workflow = changed(
        &changed(
            &declared,
            "capability ModelAll",
            "capability LedgerRead = tool.call(ledger, balance)\ncapability ModelAll",
        ),
        "caps   ErpRead, ErpDraft, ModelAll",
        "caps   ErpRead, ErpDraft, LedgerRead, ModelAll",
    );
    assert_eq!(
        callable(&by_workflow, None),
        ["example.erp.erp", "example.erp.ledger"]
    );
}

#[test]
fn a_connector_of_another_module_is_named_by_its_module() {
    let m = modules();
    let drafts = read_text(DRAFTS).unwrap();
    assert_eq!(
        callable(&drafts, Some(&m)),
        ["acme.connectors.erp", "acme.connectors.mailbox"]
    );
    // The mailbox is imported and its capability declared, and nothing holds
    // the capability: only the ERP can be called.
    let no_mailbox = changed(
        &changed(&drafts, "  let waiting = mailbox.list_invoices()\n", ""),
        "caps   Inbox, ErpRead,",
        "caps   ErpRead,",
    );
    assert_eq!(callable(&no_mailbox, Some(&m)), ["acme.connectors.erp"]);
}

#[test]
fn the_door_refuses_what_it_does_not_take() {
    let d = library_door("callable_connectors").unwrap();
    for text in [
        "null",
        "[]",
        "{}",
        r#"{"program":1}"#,
        r#"{"program":{},"modules":[]}"#,
        r#"{"program":{},"modules":{"m":1}}"#,
        r#"{"program":{},"made_up":1}"#,
    ] {
        let e = (d.call)(&parse(text).unwrap().value).unwrap_err();
        assert_eq!(e.kind.as_str(), "bad_input", "{text}");
    }
    // A program with no definition has no connector.
    let none = call(
        "callable_connectors",
        &JsObject::new().with("program", JsObject::new()),
    );
    assert_eq!(none, Ok("[]".to_owned()));
}

/// An object of 200 000 members is read in linear time, as `JSON.parse`
/// reads it (through `tool_canonical`: a request to a door is at most 1 MiB, which
/// is fewer members): the canonical text is the same as for the members written in order,
/// and a name given again takes its last value.
#[test]
fn a_large_object_is_read_quickly() {
    let n = 200_000;
    let members = |reverse: bool| -> String {
        let ids: Vec<usize> = if reverse {
            (0..n).rev().collect()
        } else {
            (0..n).collect()
        };
        ids.iter()
            .map(|i| format!("\"p{i:06}\":{{\"type\":\"integer\",\"minimum\":{i}}}"))
            .collect::<Vec<_>>()
            .join(",")
    };
    let tool = |body: &str| format!("{{\"name\":\"wide\",\"inputSchema\":{{{body}}}}}");
    let start = std::time::Instant::now();
    let a = tool_canonical(&tool(&members(false))).unwrap();
    let b = tool_canonical(&tool(&members(true))).unwrap();
    assert_eq!(a, b, "the order of members is not in the digest");
    // Every name twice: the last value is the one digested.
    let twice = format!(
        "{},{}",
        members(false).replace("\"minimum\":", "\"minimum\":-"),
        members(false)
    );
    assert_eq!(tool_canonical(&tool(&twice)).unwrap(), a);
    assert!(
        start.elapsed().as_secs() < 60,
        "{:?} for three objects of {n} members",
        start.elapsed()
    );
}
