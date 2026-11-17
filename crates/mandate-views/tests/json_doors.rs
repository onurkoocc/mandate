//! The JSON doors of `mandate-views` (`src/json_doors/`) against the
//! TypeScript compiler, call for call, by the shared tests of
//! `mandate_testkit::json_doors`: a copy of
//! `crates/mandate-check/tests/json_doors.rs` with this crate's table,
//! directory and lists.
//!
//! `crates/mandate-views/tests/json_doors/` holds `doors.json`, the table of
//! doors as data, which must equal [`mandate_views::json_doors::DOORS`];
//! `inputs.json`, calls written by hand over the fixtures, their locks and
//! modules, the documents of `tests/data/inputs.json` and views and
//! documents written here; and `expected.json`, what the TypeScript function
//! each door stands for gives for each call, which
//! `scripts/json-doors-vectors.mjs` writes. Each call goes through the Rust
//! door, twice, and its output text must be the TypeScript's, or
//! `bad_input` where the TypeScript throws. Then each door is given inputs
//! that are not what it takes and must answer `bad_input`, never panic; and
//! an optional member that is `null` must be the same as one left out.
//! Last, the inputs the doors refuse although the TypeScript gives an
//! answer for them, each with that answer.

#![allow(clippy::panic, clippy::expect_used, missing_docs)]

use mandate_testkit::json_doors::{
    Answer, JsonDoor, Rules, check_calls, check_malformed, check_table,
};
use mandate_views::json_doors::{DOORS, door};

const DIR: &str = "crates/mandate-views/tests/json_doors";

/// The table, as the test kit reads it.
fn doors() -> Vec<JsonDoor<'static>> {
    DOORS
        .iter()
        .map(|d| JsonDoor {
            name: d.name,
            ts: d.ts,
            params: d.params,
            note: d.note,
            call: Box::new(move |input| match (d.call)(input) {
                Ok(output) => Answer::Output(output),
                Err(e) => Answer::Refused {
                    kind: e.kind.as_str().to_owned(),
                    message: e.message,
                },
            }),
        })
        .collect()
}

/// What the table does not say of its parameters.
const RULES: Rules<'static> = Rules {
    // The parameters a door may be called without (`null` is the same).
    optional: &[
        // The Rust's alone (0.6): the modules an applied pattern comes from.
        ("architecture", "modules"),
        ("architecture", "lock"),
        ("authority", "modules"),
        ("cost", "modules"),
        ("diff_doc", "modules"),
        ("cost", "lock"),
        ("program_doc", "lock"),
        ("program_doc", "modules"),
        ("diff_doc", "locks"),
        // 0.7: the version of std.patterns a caller that holds no lock names.
        ("architecture", "std_patterns"),
        ("authority", "std_patterns"),
        ("cost", "std_patterns"),
        ("program_doc", "std_patterns"),
        ("diff_doc", "std_patterns"),
        ("card", "opts"),
        ("card_doc", "opts"),
        ("acs_target", "modules"),
        ("acs_target", "lock"),
    ],
    // The parameters whose TypeScript type takes any JSON value: a lock as
    // read, which the function reads as it is.
    any: &[
        ("architecture", "lock"),
        ("cost", "lock"),
        ("program_doc", "lock"),
        ("acs_target", "lock"),
    ],
    // Deeper: the members of an options object, the modules, and what a
    // document or a view holds.
    refused: &[
        (
            "card",
            r#"{"program":{},"workflow":"W","opts":{"modules":{"a":1}}}"#,
        ),
        (
            "card_doc",
            r#"{"program":{},"workflow":"W","opts":{"modules":[]}}"#,
        ),
        ("program_doc", r#"{"program":{},"modules":{"a":"x"}}"#),
        ("acs_target", r#"{"program":{},"modules":{"a":null}}"#),
        ("diff_doc", r#"{"before":{},"after":{},"locks":[]}"#),
        (
            "to_markdown",
            r#"{"doc":{"title":"t","meta":[["k",1]],"blocks":[]}}"#,
        ),
        (
            "to_markdown",
            r#"{"doc":{"title":"t","meta":[],"blocks":[{"table":{"head":[1],"rows":[]}}]}}"#,
        ),
        (
            "to_html",
            r#"{"doc":{"title":"t","meta":[],"blocks":[{"table":"x"}]}}"#,
        ),
        (
            "to_html",
            r#"{"doc":{"title":"t","meta":[],"blocks":[{"list":[["x"]]}]}}"#,
        ),
        (
            "to_html",
            r#"{"doc":{"title":"t","meta":[],"blocks":[{"list":[{"mono":true}]}]}}"#,
        ),
        ("to_html", r#"{"doc":{"title":"t","meta":[],"blocks":[1]}}"#),
        (
            "architecture_blocks",
            r#"{"v":{"workflows":[{"workflow":"W","budget":"b","mermaid":"m","nodes":[{"id":"n1","kind":"verify","label":"L"}],"edges":[]}]}}"#,
        ),
        (
            "architecture_blocks",
            r#"{"v":{"workflows":[{"workflow":"W","budget":"b","mermaid":"m","nodes":[],"edges":[{"from":"n1","to":"n2","label":1}]}]}}"#,
        ),
        (
            "authority_blocks",
            r#"{"v":{"rows":[{"who":"A","kind":"agent","effects":[],"read":[1],"write":[],"network":[],"model":[],"exec":[],"repos":[],"money":[],"unbounded":[]}]}}"#,
        ),
    ],
};

/// The inputs a door refuses although the TypeScript function gives an
/// answer for them: what the typed form of a document or a view cannot
/// hold (`mandate_views::json_doors` says what that is), each with what
/// the TypeScript gives.
const LAXER: &[(&str, &str, &str)] = &[
    // A string where an array is: iterated as its characters.
    (
        "to_markdown",
        r#"{"doc":{"title":"t","meta":"","blocks":[]}}"#,
        r##""# t\n\n""##,
    ),
    (
        "to_markdown",
        r#"{"doc":{"title":"t","meta":["kv"],"blocks":[]}}"#,
        r##""# t\n\n- **k:** ` v `\n""##,
    ),
    (
        "to_markdown",
        r#"{"doc":{"title":"t","meta":[],"blocks":""}}"#,
        r##""# t\n\n""##,
    ),
    (
        "to_markdown",
        r#"{"doc":{"title":"t","meta":[],"blocks":[{"table":{"head":["a"],"rows":""}}]}}"#,
        r##""# t\n\n\n| a |\n|---|\n""##,
    ),
    // A mark or a language that is not of its type: read by its truthiness,
    // or written as text.
    (
        "to_markdown",
        r#"{"doc":{"title":"t","meta":[],"blocks":[{"list":[{"text":"x","mono":1}]}]}}"#,
        r##""# t\n\n\n- ` x `\n""##,
    ),
    (
        "to_html",
        r#"{"doc":{"title":"t","meta":[],"blocks":[{"list":[{"text":"x","untrusted":"yes"}]}]}}"#,
        "the page, with the item as an untrusted span",
    ),
    (
        "to_markdown",
        r#"{"doc":{"title":"t","meta":[],"blocks":[{"code":"x","lang":5}]}}"#,
        r##""# t\n\n\n```5\nx\n```\n""##,
    ),
    (
        "to_markdown",
        r#"{"doc":{"title":"t","meta":[],"blocks":[{"code":"x","untrusted":0}]}}"#,
        r##""# t\n\n\n```\nx\n```\n""##,
    ),
    // A view whose members are not of their types: written as they are.
    (
        "architecture_blocks",
        r#"{"v":{"workflows":[{"workflow":"W","budget":"b","mermaid":"m","nodes":[{"id":"n1","kind":"made-up","label":"L","detail":[]}],"edges":[]}]}}"#,
        r#"[...,{"table":{...,"rows":[["L","made-up","—","—"]]}}]"#,
    ),
    (
        "architecture_blocks",
        r#"{"v":{"workflows":[{"workflow":1,"budget":2,"mermaid":3,"nodes":[{"id":"n1","kind":"verify","label":4,"detail":[5]}],"edges":[]}]}}"#,
        r#"[{"h":"Architecture"},{"p":"Workflow 1, budget 2."},{"code":3,"lang":"mermaid"},...]"#,
    ),
    (
        "authority_blocks",
        r#"{"v":{"rows":[{"who":"A","kind":"made-up","effects":[],"read":[],"write":[],"network":[],"model":[],"exec":[],"repos":[],"money":[],"unbounded":[]}]}}"#,
        r#"[...,{"table":{...,"rows":[["A","made-up","—",...]]}}]"#,
    ),
    (
        "authority_blocks",
        r#"{"v":{"rows":[{"who":1,"kind":"agent","effects":[2],"read":[],"write":[],"network":[],"model":[],"exec":[],"repos":[],"money":[],"unbounded":[]}]}}"#,
        r#"[...,{"table":{...,"rows":[[1,"agent","—",...,"2","—"]]}}]"#,
    ),
];

#[test]
fn doors_json_is_the_table() {
    match check_table(DIR, &doors()) {
        Ok(summary) => println!("{summary}"),
        Err(e) => panic!("{e}"),
    }
    for d in DOORS {
        assert!(door(d.name).is_some_and(|f| f.name == d.name));
    }
    assert!(door("no_such_door").is_none());
    for d in mandate_check::json_doors::DOORS {
        assert!(door(d.name).is_none(), "{} is in both tables", d.name);
    }
}

#[test]
fn every_door_answers_as_the_typescript() {
    match check_calls(DIR, &doors()) {
        Ok(summary) => println!("{summary}"),
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn malformed_inputs_are_bad_input() {
    match check_malformed(DIR, &doors(), &RULES) {
        Ok(summary) => println!("{summary}"),
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn refused_where_the_typescript_is_laxer() {
    let doors = doors();
    let mut wrong: Vec<String> = Vec::new();
    for (name, input, typescript) in LAXER {
        let d = doors.iter().find(|d| d.name == *name).expect("a door");
        let input = mandate_ir::parse(input).expect("JSON").value;
        let answer = (d.call)(&input);
        if !answer.is_bad_input() {
            wrong.push(format!(
                "{name}: {} (the TypeScript gives {typescript})",
                answer.text()
            ));
        }
    }
    assert!(wrong.is_empty(), "not refused:\n{}", wrong.join("\n"));
    println!(
        "json doors: {} inputs refused where the TypeScript gives an answer",
        LAXER.len()
    );
}
