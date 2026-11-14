//! The golden programs through the doors: each output text that
//! `compiler/test/golden/outputs.json` pins (the command line over the
//! repository's programs) made from requests to [`mandate_doors::answer`]
//! alone, formatted as the command line formats the door's output, against
//! the pinned digest. The test reads the program, its modules and its lock
//! from their files to put them in the requests; everything else is the
//! answers. It mirrors `crates/mandate-testkit/tests/golden.rs`, which makes
//! the same texts from the typed functions:
//!
//! - `load`: the door `load`, its `diagnostics`; `ir --canonical`: `load`,
//!   then `canonicalize` of its `program`; `fmt`: `load`, then
//!   `print_program`;
//! - `check`, `check --module`, `check --lock`: the door `check` (with the
//!   modules of `load_modules`, and the lock), its `{ ok, hashes?,
//!   diagnostics }`; `hash`: `check`, its `hashes`;
//! - `sandbox`: `check`, then `sandbox_requirements`;
//! - `view --against itself`: `check`, then `semantic_diff` of the program
//!   with itself;
//! - `view --format json`: `architecture`, `authority` and `cost`;
//!   `view --format md` and `html`: `program_doc`, then `to_markdown` or
//!   `to_html` of the document it gave;
//! - `view --card --format …`: `envelope_workflows`, then `card`, or
//!   `card_doc` and `to_markdown` or `to_html`.
//!
//! A JSON output is written `JSON.stringify(v, null, 2) + "\n"`, as the
//! command line writes it. Every pinned output is reached; a kind of output
//! this list does not know fails the test, so that a new one is added here.
//!
//! A second test holds the doors `architecture_blocks` and
//! `authority_blocks` to the document the TypeScript made: for each program
//! that checks (with its modules and its lock) and has a workflow or an
//! agent, `architecture_blocks(architecture(p))` and
//! `authority_blocks(authority(p))` are the first blocks of
//! `program_doc(p)`, whose text the first test holds to the pinned digest.

#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use std::collections::BTreeMap;

use common::output;
use mandate_ir::{JsObject, JsValue, stringify_pretty};
use mandate_syntax::{SourceKind, kind_of};
use mandate_testkit::json_doors::output_text;
use mandate_testkit::{Golden, GoldenOutput, compare_digest, read_bytes, read_json};

/// The text of a repository file as `readFileSync(file, "utf8")` reads it.
fn read_source(rel: &str) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&read_bytes(rel)?).into_owned())
}

fn kind_name(file: &str) -> &'static str {
    match kind_of(file) {
        SourceKind::Json => "json",
        SourceKind::Mdt => "mdt",
    }
}

/// `JSON.stringify(v, null, 2) + "\n"`.
fn pretty(v: &JsValue) -> String {
    let mut text = stringify_pretty(v).unwrap_or_else(|| "undefined".to_owned());
    text.push('\n');
    text
}

/// The member `key` of an output object.
fn member(v: &JsValue, key: &str) -> Result<JsValue, String> {
    v.get(key)
        .cloned()
        .ok_or_else(|| format!("the output has no `{key}`"))
}

/// The module files a program is given: `moduleFilesOf` in
/// `compiler/test/golden-outputs.ts`.
fn module_files_of(program: &str) -> Vec<&'static str> {
    if program == "fixtures/envelope/migrate-all.mdt" {
        vec!["fixtures/envelope/domain.mdt"]
    } else {
        vec![
            "fixtures/system/acme.system.mdt",
            "fixtures/system/repos.mdt",
        ]
    }
}

/// The lock a program is checked with: `lockFileOf` in
/// `compiler/test/helpers.ts`.
fn lock_file_of(program: &str) -> Option<String> {
    let (dir, file) = match program.rsplit_once('/') {
        Some((dir, file)) => (format!("{dir}/"), file),
        None => (String::new(), program),
    };
    let name = file.rsplit_once('.').map_or(file, |(name, _)| name);
    [
        format!("{dir}{name}.lock.json"),
        format!("{dir}mandate.lock.json"),
    ]
    .into_iter()
    .find(|p| mandate_testkit::path(p).exists())
}

/// The lock of a program, as read, when it has one.
fn lock_of(program: &str) -> Result<Option<JsValue>, String> {
    lock_file_of(program)
        .map(|f| read_json(&f).map(|v| JsValue::from(&v)))
        .transpose()
}

/// The modules of a program, through the door `load_modules`; they must
/// load.
fn modules_of(program: &str) -> Result<JsValue, String> {
    let mut sources = Vec::new();
    for f in module_files_of(program) {
        sources.push(JsValue::from(
            JsObject::new()
                .with("text", read_source(f)?)
                .with("kind", kind_name(f))
                .with("file", f),
        ));
    }
    let loaded = output("load_modules", JsObject::new().with("sources", sources))?;
    if member(&loaded, "problems")?
        .as_array()
        .is_none_or(|p| !p.is_empty())
    {
        return Err(format!("the modules of {program} do not load"));
    }
    member(&loaded, "modules")
}

/// The door `check` of a program, with its modules and its lock when asked.
fn checked(program: &str, with_modules: bool, with_lock: bool) -> Result<JsValue, String> {
    let mut opts = JsObject::new();
    if with_modules {
        opts.insert("modules", modules_of(program)?);
    }
    if with_lock {
        opts.insert("lock", lock_of(program)?.ok_or("the program has no lock")?);
    }
    output(
        "check",
        JsObject::new()
            .with("text", read_source(program)?)
            .with("kind", kind_name(program))
            .with("opts", opts),
    )
}

/// The program of a check that is `ok`.
fn checked_program(r: &JsValue) -> Result<JsValue, String> {
    if r.get("ok").and_then(JsValue::as_bool) != Some(true) {
        return Err("the program does not check".to_owned());
    }
    member(r, "program")
}

/// The door `load` of a program.
fn loaded(program: &str) -> Result<JsValue, String> {
    output(
        "load",
        JsObject::new()
            .with("text", read_source(program)?)
            .with("kind", kind_name(program)),
    )
}

/// A string output.
fn text(v: JsValue) -> Result<String, String> {
    match v {
        JsValue::String(s) => Ok(s),
        other => Err(format!("not a string: {}", output_text(&other))),
    }
}

/// What the views of a golden program are made of.
struct Viewed {
    /// The program as `check` gives it with its modules and its lock.
    program: JsValue,
    /// Its modules.
    modules: JsValue,
    /// Its lock, if it has one.
    lock: Option<JsValue>,
}

/// The program of a golden output as `check` gives it with its modules and
/// its lock if it has one, and the two.
fn viewed(program: &str) -> Result<Viewed, String> {
    let lock = lock_of(program)?;
    let r = checked(program, true, lock.is_some())?;
    Ok(Viewed {
        program: checked_program(&r)?,
        modules: modules_of(program)?,
        lock,
    })
}

/// The text of one pinned output, from answers alone.
fn produce(o: &GoldenOutput<'_>) -> Result<String, String> {
    let program = o.program;
    match o.output {
        "load" => Ok(pretty(&member(&loaded(program)?, "diagnostics")?)),
        "ir --canonical" => {
            let p = member(&loaded(program)?, "program")?;
            text(output("canonicalize", JsObject::new().with("value", p))?)
        }
        "fmt" => {
            let p = member(&loaded(program)?, "program")?;
            text(output("print_program", JsObject::new().with("p", p))?)
        }
        "check" | "check --module" | "check --lock" => {
            let r = checked(program, o.output != "check", o.output == "check --lock")?;
            let shown = JsObject::new()
                .with("ok", member(&r, "ok")?)
                .with_some("hashes", r.get("hashes").cloned())
                .with("diagnostics", member(&r, "diagnostics")?);
            Ok(pretty(&shown.into()))
        }
        "hash" => Ok(pretty(&member(&checked(program, false, false)?, "hashes")?)),
        "sandbox" => {
            let lock = lock_of(program)?;
            let r = checked(program, true, lock.is_some())?;
            let p = member(&r, "program")?;
            let hash = member(&member(&r, "hashes")?, "program")?;
            let requirements = output(
                "sandbox_requirements",
                JsObject::new()
                    .with("program", p)
                    .with("modules", modules_of(program)?)
                    .with("lock", lock),
            )?;
            Ok(pretty(
                &JsObject::new()
                    .with("program", hash)
                    .with("requirements", requirements)
                    .into(),
            ))
        }
        "view --against itself" => {
            let p = viewed(program)?.program;
            Ok(pretty(&output(
                "semantic_diff",
                JsObject::new().with("before", p.clone()).with("after", p),
            )?))
        }
        "view --format json" => {
            let Viewed {
                program: p, lock, ..
            } = viewed(program)?;
            let one = |door: &str| output(door, JsObject::new().with("program", p.clone()));
            let cost = output(
                "cost",
                JsObject::new()
                    .with("program", p.clone())
                    .with("lock", lock),
            )?;
            Ok(pretty(
                &JsObject::new()
                    .with("architecture", one("architecture")?)
                    .with("authority", one("authority")?)
                    .with("cost", cost)
                    .into(),
            ))
        }
        "view --format md" | "view --format html" => {
            let Viewed {
                program: p,
                modules,
                lock,
            } = viewed(program)?;
            let doc = output(
                "program_doc",
                JsObject::new()
                    .with("program", p)
                    .with("lock", lock)
                    .with("modules", modules),
            )?;
            let render = if o.output == "view --format md" {
                "to_markdown"
            } else {
                "to_html"
            };
            text(output(render, JsObject::new().with("doc", doc))?)
        }
        "view --card --format json" | "view --card --format md" | "view --card --format html" => {
            let Viewed {
                program: p,
                modules,
                lock,
            } = viewed(program)?;
            let names = output(
                "envelope_workflows",
                JsObject::new().with("program", p.clone()),
            )?;
            let Some([JsValue::String(name)]) = names.as_array() else {
                return Err(format!(
                    "not one workflow with an envelope: {}",
                    output_text(&names)
                ));
            };
            let input = JsObject::new()
                .with("program", p)
                .with("workflow", name.as_str())
                .with(
                    "opts",
                    JsObject::new().with("modules", modules).with("lock", lock),
                );
            if o.output == "view --card --format json" {
                return Ok(pretty(&output("card", input)?));
            }
            let doc = output("card_doc", input)?;
            let render = if o.output == "view --card --format md" {
                "to_markdown"
            } else {
                "to_html"
            };
            text(output(render, JsObject::new().with("doc", doc))?)
        }
        other => Err(format!("no way through the doors for the output {other}")),
    }
}

#[test]
fn every_golden_output_through_the_doors() {
    let golden = Golden::load().expect("the golden file");
    let mut reached: BTreeMap<&str, usize> = BTreeMap::new();
    let mut wrong: Vec<String> = Vec::new();
    let mut total = 0;
    for o in golden.outputs() {
        total += 1;
        match produce(&o).and_then(|t| compare_digest(o.digest, &t)) {
            Ok(()) => *reached.entry(o.output).or_default() += 1,
            Err(why) => wrong.push(format!("{}: {why}", o.name())),
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {total} pinned outputs not given through the doors:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
    let counts: Vec<String> = reached.iter().map(|(k, n)| format!("{k} {n}")).collect();
    println!(
        "golden outputs through answer: {} of {total} ({})",
        reached.values().sum::<usize>(),
        counts.join(", ")
    );
}

#[test]
fn the_blocks_doors_begin_the_document_of_a_program() {
    let golden = Golden::load().expect("the golden file");
    let mut held = 0;
    for program in golden.programs() {
        let Ok(Viewed { program: p, .. }) = viewed(program) else {
            continue;
        };
        let doc =
            output("program_doc", JsObject::new().with("program", p.clone())).expect("program_doc");
        let blocks = doc
            .get("blocks")
            .and_then(JsValue::as_array)
            .expect("blocks");
        // A program with no workflow and no agent (a system model) has no
        // views of its own, only its system.
        let heading = blocks
            .first()
            .and_then(|b| b.get("h"))
            .and_then(JsValue::as_str);
        if heading != Some("Architecture") {
            continue;
        }
        let mut first: Vec<JsValue> = Vec::new();
        for (view, door) in [
            ("architecture", "architecture_blocks"),
            ("authority", "authority_blocks"),
        ] {
            let v = output(view, JsObject::new().with("program", p.clone())).expect(view);
            let b = output(door, JsObject::new().with("v", v)).expect(door);
            first.extend(b.as_array().expect("blocks").iter().cloned());
        }
        let head = blocks.get(..first.len()).expect("as many blocks");
        assert_eq!(
            output_text(&JsValue::Array(head.to_vec())),
            output_text(&JsValue::Array(first)),
            "{program}"
        );
        held += 1;
    }
    // The golden programs that check and have a workflow or an agent.
    assert!(held >= 14, "only {held} programs");
    println!("architecture_blocks and authority_blocks begin the document of {held} programs");
}
