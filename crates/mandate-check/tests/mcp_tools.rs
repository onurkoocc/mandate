//! The door `mcp_tools` (`json_doors::LIBRARY_DOORS`, which no TypeScript
//! function stands for): the tool list the MCP servers of 0.7 hand to
//! `tools/list` (spec/attention.md "The MCP server").
//!
//! - The tools of 0.7 are the frozen list (`tools.json`, the `tables`
//!   door's `TOOLS`, held to the TypeScript) and the changes the spec names,
//!   and nothing else: the test `mcp_tools_the_list_of_0_7_is_the_frozen_list_and_the_named_changes`
//!   lists every difference, one named change each, so that an edit of
//!   `tools-0.7.json` that is not one of them fails.
//! - The languages up to 0.6 are given the frozen list; a language the door
//!   does not know is refused, and every language the `tables` door lists is
//!   known.
//! - The output is the same on every call, and is held across builds by
//!   `vectors/mcp-tools/mcp-tools-0.7.json` (written by the Rust with
//!   `MANDATE_UPDATE_0_7=1`).
//! - No tool signs, approves, decides or promotes, and none takes a key.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::json_doors::{door, library_door};
use mandate_ir::{JsObject, JsValue, Value, parse, stringify};
use mandate_testkit::rust_vectors::pin_0_7;

const FROZEN: &str = include_str!("../src/json_doors/tools.json");
const TOOLS_0_7: &str = include_str!("../src/json_doors/tools-0.7.json");
const VECTOR: &str = "vectors/mcp-tools/mcp-tools-0.7.json";

fn value(v: &JsValue) -> Value {
    parse(&stringify(v).unwrap()).unwrap().value
}

fn text(s: &str) -> Value {
    parse(s).unwrap().value
}

/// The door's output text for `language`, or its refusal's kind.
fn output(language: &str) -> Result<String, String> {
    let d = library_door("mcp_tools").unwrap();
    let input = value(&JsObject::new().with("language", language).into());
    (d.call)(&input)
        .map(|o| stringify(&o).unwrap())
        .map_err(|e| e.kind.as_str().to_owned())
}

fn tools_of(output: &str) -> Value {
    text(output).get("tools").unwrap().clone()
}

/// The tools of a list by name, in the list's order.
fn named(list: &Value) -> Vec<(&str, &Value)> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|t| (t.get("name").and_then(Value::as_str).unwrap(), t))
        .collect()
}

/// Every difference of `new` from `old`, as `added <path>`, `removed <path>`
/// or `changed <path>` (an object is compared member by member; an array or
/// a value, whole), the paths as JSON Pointers.
fn differences(path: &str, old: &Value, new: &Value, out: &mut Vec<String>) {
    if let (Value::Object(o), Value::Object(n)) = (old, new) {
        for (k, ov) in o.iter() {
            let at = format!("{path}/{k}");
            match n.get(k) {
                Some(nv) => differences(&at, ov, nv, out),
                None => out.push(format!("removed {at}")),
            }
        }
        for k in n.keys() {
            if !o.contains_key(k) {
                out.push(format!("added {path}/{k}"));
            }
        }
    } else if old != new {
        out.push(format!("changed {path}"));
    }
}

#[test]
fn mcp_tools_the_door_gives_the_tools_of_a_language_and_what_the_modern_era_adds() {
    let out = text(&output("mandate/0.7").unwrap());
    assert_eq!(
        out.get("language").and_then(Value::as_str),
        Some("mandate/0.7")
    );
    assert_eq!(out.get("tools").unwrap(), &text(TOOLS_0_7));
    let modern = out.get("modern").unwrap();
    assert_eq!(modern.get("ttlMs").and_then(Value::as_i64), Some(3_600_000));
    assert_eq!(
        modern.get("cacheScope").and_then(Value::as_str),
        Some("public")
    );
    assert_eq!(modern.as_object().unwrap().len(), 2);
    assert_eq!(out.as_object().unwrap().len(), 3);
    // Each tool is what `tools/list` carries.
    for (name, tool) in named(out.get("tools").unwrap()) {
        let members: Vec<&str> = tool.as_object().unwrap().keys().collect();
        assert_eq!(
            members,
            ["name", "title", "description", "inputSchema"],
            "{name}"
        );
        let schema = tool.get("inputSchema").unwrap();
        assert_eq!(schema.get("type").and_then(Value::as_str), Some("object"));
        assert_eq!(
            schema.get("additionalProperties"),
            Some(&Value::Bool(false)),
            "{name}"
        );
    }
}

#[test]
fn mcp_tools_the_languages_up_to_0_6_get_the_frozen_list_which_is_the_tables_doors() {
    let tables = (door("tables").unwrap().call)(&text("{}")).unwrap();
    let frozen = value(tables.as_object().unwrap().get("TOOLS").unwrap());
    assert_eq!(
        frozen,
        text(FROZEN),
        "the tables door's TOOLS is tools.json"
    );
    for v in 1..=6 {
        let language = format!("mandate/0.{v}");
        assert_eq!(tools_of(&output(&language).unwrap()), frozen, "{language}");
    }
}

#[test]
fn mcp_tools_every_language_the_compiler_lists_has_a_tool_list_and_no_other_does() {
    let tables = (door("tables").unwrap().call)(&text("{}")).unwrap();
    let versions = value(
        tables
            .as_object()
            .unwrap()
            .get("LANGUAGE_VERSIONS")
            .unwrap(),
    );
    let versions = versions.as_array().unwrap();
    assert_eq!(versions.len(), 7);
    for v in versions {
        let v = v.as_str().unwrap();
        assert!(output(v).is_ok(), "{v} has no tool list");
    }
    for bad in ["mandate/0.8", "mandate/0.0", "0.7", "mandate/0.7 ", ""] {
        assert_eq!(output(bad), Err("bad_input".to_owned()), "{bad:?}");
    }
    let d = library_door("mcp_tools").unwrap();
    for input in [
        "null",
        "{}",
        r#"{"language":7}"#,
        r#"{"language":null}"#,
        r#"{"language":"mandate/0.7","made_up":1}"#,
    ] {
        assert!((d.call)(&text(input)).is_err(), "{input}");
    }
}

/// The differences of the list of 0.7 from the frozen one, each the change
/// that `spec/attention.md` names: `check` takes `libraries`; `project`
/// offers the card and the attention view (the `view` values, the `workflow`
/// they are asked for) and takes a `lock` (described, for the card and the
/// attention view); `spec` takes the sections `patterns` and `attention`.
/// The descriptions of the three tools say so.
const NAMED_CHANGES: [(&str, &str); 8] = [
    (
        "changed /mandate.check/description",
        "check: the description says libraries and the embedded std.patterns",
    ),
    (
        "added /mandate.check/inputSchema/properties/libraries",
        "check: takes libraries",
    ),
    (
        "changed /mandate.project/description",
        "project: the description names the card and the attention view",
    ),
    (
        "added /mandate.project/inputSchema/properties/lock/description",
        "project: the lock, which the tool already takes, is described",
    ),
    (
        "changed /mandate.project/inputSchema/properties/view/enum",
        "project: view offers card and attention (checked below to be the old values and these two)",
    ),
    (
        "added /mandate.project/inputSchema/properties/workflow",
        "project: the workflow the card and the attention view are asked for",
    ),
    (
        "changed /mandate.spec/description",
        "spec: the description names the two sections",
    ),
    (
        "changed /mandate.spec/inputSchema/properties/section/description",
        "spec: section takes patterns and attention",
    ),
];

#[test]
fn mcp_tools_the_list_of_0_7_is_the_frozen_list_and_the_named_changes() {
    let frozen = text(FROZEN);
    let new = text(TOOLS_0_7);
    let (old_tools, new_tools) = (named(&frozen), named(&new));
    // Every tool of the frozen list is there, in its place, and no other.
    assert_eq!(
        old_tools.iter().map(|t| t.0).collect::<Vec<_>>(),
        new_tools.iter().map(|t| t.0).collect::<Vec<_>>(),
        "the tools, and their order"
    );
    let mut found = Vec::new();
    for ((name, old), (_, new)) in old_tools.iter().zip(&new_tools) {
        differences(&format!("/{name}"), old, new, &mut found);
    }
    let mut expected: Vec<&str> = NAMED_CHANGES.iter().map(|c| c.0).collect();
    expected.sort_unstable();
    found.sort_unstable();
    assert_eq!(
        found.iter().map(String::as_str).collect::<Vec<_>>(),
        expected,
        "the differences of tools-0.7.json from tools.json are the named changes: {NAMED_CHANGES:?}"
    );
    // The two changes that are a whole value say what they change.
    let view = |list: &Value| -> Vec<String> {
        named(list)
            .iter()
            .find(|t| t.0 == "mandate.project")
            .unwrap()
            .1
            .get("inputSchema")
            .and_then(|s| s.get("properties"))
            .and_then(|p| p.get("view"))
            .and_then(|v| v.get("enum"))
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    };
    let mut want = view(&frozen);
    assert_eq!(want, ["architecture", "authority", "cost", "diff"]);
    want.extend(["card".to_owned(), "attention".to_owned()]);
    assert_eq!(view(&new), want);
    let property = |list: &Value, tool: &str, name: &str| -> Option<Value> {
        named(list)
            .iter()
            .find(|t| t.0 == tool)
            .unwrap()
            .1
            .get("inputSchema")
            .and_then(|s| s.get("properties"))
            .and_then(|p| p.get(name))
            .cloned()
    };
    // The new parameters are optional, and the old ones are as they were
    // (`required` is not among the differences).
    let libraries = property(&new, "mandate.check", "libraries").unwrap();
    assert_eq!(libraries.get("type").and_then(Value::as_str), Some("array"));
    let section = property(&new, "mandate.spec", "section").unwrap();
    let section = section.get("description").and_then(Value::as_str).unwrap();
    assert!(section.contains("`patterns`") && section.contains("`attention`"));
    let spec = named(&new)
        .iter()
        .find(|t| t.0 == "mandate.spec")
        .unwrap()
        .1
        .get("description")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    assert!(spec.contains("`patterns`") && spec.contains("`attention`"));
}

#[test]
fn mcp_tools_the_door_answers_the_same_on_every_call() {
    let first = output("mandate/0.7").unwrap();
    // Other calls in between, of the same door and of others.
    let _ = output("mandate/0.6").unwrap();
    let _ = (door("tables").unwrap().call)(&text("{}")).unwrap();
    for _ in 0..3 {
        assert_eq!(output("mandate/0.7").unwrap(), first);
    }
    // The input's member order and spacing do not matter.
    let d = library_door("mcp_tools").unwrap();
    let again = (d.call)(&text(" {\n \"language\" : \"mandate/0.7\" } ")).unwrap();
    assert_eq!(stringify(&again).unwrap(), first);
}

#[test]
fn mcp_tools_the_output_is_the_stored_vector() {
    let mut stored = output("mandate/0.7").unwrap();
    stored.push('\n');
    match pin_0_7(VECTOR, &stored) {
        Ok(line) => println!("{line}"),
        Err(e) => panic!("{e}"),
    }
}

/// The words, lower-cased, of a text: runs of letters and digits.
fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// The names of the members of every `properties` object under `v`.
fn parameter_names(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            for (k, x) in m.iter() {
                if k == "properties"
                    && let Value::Object(props) = x
                {
                    out.extend(props.keys().map(str::to_owned));
                }
                parameter_names(x, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| parameter_names(x, out)),
        _ => {}
    }
}

/// What a tool that signs, approves, decides or promotes would say, or a
/// parameter that would carry a key, by the start of a word.
const FORBIDDEN_WORDS: [&str; 6] = ["sign", "approv", "decid", "decision", "promot", "endors"];
const FORBIDDEN_PARAMETERS: [&str; 7] = [
    "key",
    "secret",
    "credential",
    "password",
    "signature",
    "private",
    "token",
];

/// The one sentence of the frozen list that speaks of approval: `apply_patch`
/// reports the governance changes "those need a person's approval", which a
/// person gives, never the server.
const A_PERSONS_APPROVAL: &str = "those need a person's approval";

#[test]
fn mcp_tools_no_tool_signs_approves_decides_or_promotes_and_none_takes_a_key() {
    for language in ["mandate/0.6", "mandate/0.7"] {
        let list = tools_of(&output(language).unwrap());
        assert_eq!(named(&list).len(), 6, "{language}");
        for (name, tool) in named(&list) {
            let mut said = vec![name.to_owned()];
            for member in ["title", "description"] {
                let t = tool.get(member).and_then(Value::as_str).unwrap();
                said.push(t.replace(A_PERSONS_APPROVAL, ""));
            }
            let schema = tool.get("inputSchema").unwrap();
            // The descriptions of the parameters too.
            collect_descriptions(schema, &mut said);
            for w in words(&said.join(" ")) {
                for f in FORBIDDEN_WORDS {
                    assert!(!w.starts_with(f), "{language} {name} speaks of `{w}`");
                }
            }
            let mut parameters = Vec::new();
            parameter_names(schema, &mut parameters);
            assert!(!parameters.is_empty(), "{name}");
            for p in parameters {
                for f in FORBIDDEN_PARAMETERS {
                    assert!(
                        !p.to_lowercase().contains(f),
                        "{language} {name} takes `{p}`"
                    );
                }
            }
        }
    }
    // The only tools are the ones the servers had.
    let list = text(TOOLS_0_7);
    let names: Vec<&str> = named(&list).iter().map(|t| t.0).collect();
    assert_eq!(
        names,
        [
            "mandate.check",
            "mandate.explain",
            "mandate.apply_patch",
            "mandate.caps_of",
            "mandate.project",
            "mandate.spec"
        ]
    );
}

/// Every `description` text under `v`.
fn collect_descriptions(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(m) => {
            for (k, x) in m.iter() {
                match (k, x) {
                    ("description", Value::String(s)) => out.push(s.clone()),
                    _ => collect_descriptions(x, out),
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_descriptions(x, out)),
        _ => {}
    }
}
