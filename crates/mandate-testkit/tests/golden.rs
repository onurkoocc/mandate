//! The golden gate: what the Rust compiler prints for each program pinned
//! in `compiler/test/golden/outputs.json` must have the digest the
//! TypeScript compiler's output has there (see `compiler/test/golden.test.ts`
//! for what each output is). Release 0.5 closes when `PENDING` is empty.
//!
//! It lives in this crate because the outputs come from every compiler
//! crate (`load` and `fmt` from the syntax, `check` and `hash` from the
//! checks, the views from the views): the testkit depends on none of them,
//! so its tests can take each as a dev-dependency as it is written, and no
//! test moves when an output moves from one crate to another.

#![allow(clippy::panic, clippy::expect_used, missing_docs)]

mod common;

use std::collections::BTreeMap;

use common::{check_text, check_with, modules_of, read_source};
use mandate_check::{requirements_to_js, sandbox_requirements, semantic_diff};
use mandate_ir::{
    Diagnostic, JsObject, JsValue, Loaded, Value, canonicalize, stringify, stringify_pretty,
};
use mandate_syntax::{kind_of, load};
use mandate_testkit::{
    Golden, GoldenOutput, Miss, compare_digest, item_name, omission, read_json, read_text,
    result_codes, run_held_gate, stored_programs,
};
use mandate_views::{architecture, authority, cost, program_doc, to_html, to_markdown};

/// The outputs the Rust crates do not give yet, as `<output> @ <program>`
/// patterns. Shorten it in the commit that makes an item pass. The checks
/// are named by the codes they hold (`check @ <program> [codes]`, see
/// `mandate_testkit::codes`), and pending by family of codes; each pending
/// check is held to failing only by omission against its stored result.
const PENDING: &[&str] = &[];

/// What the Rust crates print for one pinned output.
fn output(o: &GoldenOutput<'_>) -> Result<String, String> {
    // `load(text, kindOf(file))`.
    let loaded =
        || -> Result<Loaded, String> { Ok(load(&read_text(o.program)?, kind_of(o.program))) };
    match o.output {
        // `canonicalize(load(text, kind).program)`.
        "ir --canonical" => loaded()?
            .program
            .map(|program| canonicalize(&program))
            .ok_or_else(|| "load gave no program".to_owned()),
        // `JSON.stringify(load(text, kind).diagnostics, null, 2) + "\n"`.
        "load" => {
            let loaded = loaded()?;
            let diagnostics =
                JsValue::Array(loaded.diagnostics.iter().map(Diagnostic::to_js).collect());
            let mut text = stringify_pretty(&diagnostics).unwrap_or_default();
            text.push('\n');
            Ok(text)
        }
        // `printProgram(load(text, kind).program)`.
        "fmt" => {
            let program = loaded()?
                .program
                .ok_or_else(|| "load gave no program".to_owned())?;
            mandate_syntax::print_program(&program)
        }
        // `checkOutput(check(text, kind))`: `JSON.stringify({ ok, hashes?,
        // diagnostics }, null, 2) + "\n"`.
        "check" => Ok(check_text(&checked(o.program, false, false)?)),
        // The same, with the program's modules (`moduleFilesOf`).
        "check --module" => Ok(check_text(&checked(o.program, true, false)?)),
        // The same, with its modules and its lock (`lockOf`).
        "check --lock" => Ok(check_text(&checked(o.program, true, true)?)),
        // `JSON.stringify(check(text, kind).hashes, null, 2) + "\n"`, for a
        // program that checks.
        "hash" => {
            let hashes = checked(o.program, false, false)?
                .hashes
                .ok_or("the program does not check, so it has no hashes")?;
            let mut text = stringify_pretty(&JsValue::Object(hashes.to_js())).unwrap_or_default();
            text.push('\n');
            Ok(text)
        }
        // `JSON.stringify({ program: checked.hashes.program, requirements:
        // sandboxRequirements(p, mods, lock) }, null, 2) + "\n"`, for a program
        // that checks with its modules and its lock, if it has one.
        "sandbox" => {
            let files = module_files_of(o.program);
            let modules = modules_of(&files, &files)?;
            let lock_path = lock_file_of(o.program);
            let lock = lock_path.as_deref().map(read_json).transpose()?;
            let r = check_with(
                &read_source(o.program)?,
                kind_of(o.program),
                Some(&modules),
                lock_path.as_deref(),
            )?;
            let (Some(program), Some(hashes)) = (&r.program, &r.hashes) else {
                return Err("the program does not check, so it has no sandbox".to_owned());
            };
            let requirements = sandbox_requirements(program, Some(&modules), lock.as_ref());
            let out = JsObject::new()
                .with("program", hashes.program.as_str())
                .with("requirements", requirements_to_js(&requirements));
            let mut text = stringify_pretty(&JsValue::Object(out)).unwrap_or_default();
            text.push('\n');
            Ok(text)
        }
        // `json(semanticDiff(p, p))` of the program as `check` gives it with its
        // modules and its lock (`lockOf`), when it checks: no locks and no modules
        // are given to the diff.
        "view --against itself" => {
            let r = checked(o.program, true, lock_file_of(o.program).is_some())?;
            let program = r
                .program
                .filter(|_| r.ok)
                .ok_or("the program does not check, so it has no views")?;
            let mut text = stringify_pretty(&semantic_diff(&program, &program, None).to_js())
                .unwrap_or_default();
            text.push('\n');
            Ok(text)
        }
        // `json({ architecture: architecture(p), authority: authority(p), cost:
        // cost(p, lock) })`, and `toMarkdown` and `toHtml` of `programDoc(p, lock,
        // mods)`, of the program as `check` gives it with its modules and its lock
        // (`lockOf`), when it checks.
        "view --format json" | "view --format md" | "view --format html" => {
            let files = module_files_of(o.program);
            let modules = modules_of(&files, &files)?;
            let lock_path = lock_file_of(o.program);
            let lock = lock_path.as_deref().map(read_json).transpose()?;
            let r = checked(o.program, true, lock_path.is_some())?;
            let program = r
                .program
                .filter(|_| r.ok)
                .ok_or("the program does not check, so it has no views")?;
            if o.output == "view --format json" {
                let views = JsObject::new()
                    .with("architecture", architecture(&program).to_js())
                    .with("authority", authority(&program).to_js())
                    .with("cost", cost(&program, lock.as_ref()).to_js());
                let mut text = stringify_pretty(&JsValue::Object(views)).unwrap_or_default();
                text.push('\n');
                return Ok(text);
            }
            let doc = program_doc(&program, lock.as_ref(), Some(&modules));
            Ok(if o.output == "view --format md" {
                to_markdown(&doc)
            } else {
                to_html(&doc)
            })
        }
        _ => Err("no Rust implementation yet".to_owned()),
    }
}

/// The module files a program is given: `moduleFilesOf` in
/// `compiler/test/golden-outputs.ts` (`MODULE_FILES`, except where
/// `MODULE_FILES_OF` names others).
fn module_files_of(program: &str) -> Vec<String> {
    let files: &[&str] = if program == "fixtures/envelope/migrate-all.mdt" {
        &["fixtures/envelope/domain.mdt"]
    } else {
        &[
            "fixtures/system/acme.system.mdt",
            "fixtures/system/repos.mdt",
        ]
    };
    files.iter().map(|f| (*f).to_owned()).collect()
}

/// The lock a program is checked with: `lockFileOf` in
/// `compiler/test/helpers.ts`, `<name>.lock.json` beside it, else
/// `mandate.lock.json` beside it, the first that exists.
fn lock_file_of(program: &str) -> Option<String> {
    let (dir, file) = match program.rsplit_once('/') {
        Some((dir, file)) => (format!("{dir}/"), file),
        None => (String::new(), program),
    };
    // `.replace(/\.[^.]*$/, "")`.
    let name = file.rsplit_once('.').map_or(file, |(name, _)| name);
    [
        format!("{dir}{name}.lock.json"),
        format!("{dir}mandate.lock.json"),
    ]
    .into_iter()
    .find(|p| mandate_testkit::path(p).exists())
}

/// `check(text, kind, { modules?, lock? })` of a golden program.
fn checked(
    program: &str,
    with_modules: bool,
    with_lock: bool,
) -> Result<mandate_check::CheckResult, String> {
    let text = read_source(program)?;
    let files = module_files_of(program);
    let modules = if with_modules {
        Some(modules_of(&files, &files)?)
    } else {
        None
    };
    let lock = if with_lock {
        Some(lock_file_of(program).ok_or("the program has no lock")?)
    } else {
        None
    };
    check_with(&text, kind_of(program), modules.as_ref(), lock.as_deref())
}

/// The name of an output in the gate: `<output> @ <program>`, and for a
/// check the codes its stored result holds (`vectors/diagnostics/`), and
/// for `hash`, which holds none, `[]`.
fn name_of(o: &GoldenOutput<'_>, codes: &BTreeMap<(String, String), Vec<String>>) -> String {
    match o.output {
        "check" | "check --module" | "check --lock" => {
            let slot = o.output.replace(" --", "_");
            match codes.get(&(o.program.to_owned(), slot)) {
                Some(codes) => item_name(o.output, o.program, codes),
                None => format!("{} (no stored result)", o.name()),
            }
        }
        "hash" => item_name::<&str>(o.output, o.program, []),
        _ => o.name(),
    }
}

/// The diagnostics of a check that does not have its digest, against the
/// stored result of that check: whether they are the stored ones with some
/// left out, in order, each compared whole.
fn held(stored: &Value, actual: &[Diagnostic], difference: String) -> Miss {
    let want: Vec<String> = stored
        .get("diagnostics")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .map(|d| stringify(&JsValue::from(d)).unwrap_or_default())
        .collect();
    let got: Vec<String> = actual
        .iter()
        .map(|d| stringify(&d.to_js()).unwrap_or_default())
        .collect();
    match omission(&want, &got, |w, g| w == g, Clone::clone) {
        Ok(_) => Miss::Omits(difference),
        Err(why) => Miss::Differs(format!("{why}\n{difference}")),
    }
}

/// One pinned output against its digest, held to omission when it is a
/// check (`stored` are the stored results of the checks).
fn run(o: &GoldenOutput<'_>, stored: &BTreeMap<(String, String), Value>) -> Result<(), Miss> {
    let (with_modules, with_lock) = match o.output {
        "check" => (false, false),
        "check --module" => (true, false),
        "check --lock" => (true, true),
        _ => {
            return output(o)
                .and_then(|text| compare_digest(o.digest, &text))
                .map_err(Miss::Differs);
        }
    };
    let r = checked(o.program, with_modules, with_lock).map_err(Miss::Differs)?;
    compare_digest(o.digest, &check_text(&r)).map_err(|why| {
        let slot = o.output.replace(" --", "_");
        match stored.get(&(o.program.to_owned(), slot)) {
            Some(v) => held(v, &r.diagnostics, why),
            None => Miss::Excluded {
                rule: "a check with no stored result in vectors/diagnostics to hold it to",
                why,
            },
        }
    })
}

#[test]
fn golden_outputs() {
    mandate_testkit::check_pending(PENDING).expect("the pending list");
    let golden = Golden::load().expect("the golden file");
    let mut codes: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    let mut stored: BTreeMap<(String, String), Value> = BTreeMap::new();
    for p in stored_programs().expect("the golden vectors") {
        for (slot, v) in &p.results {
            codes.insert((p.program.clone(), slot.clone()), result_codes(v));
            stored.insert((p.program.clone(), slot.clone()), v.clone());
        }
    }
    let items = golden.outputs().map(|o| (name_of(&o, &codes), o));
    let gate = run_held_gate("golden outputs", PENDING, items, |o| run(o, &stored));
    if let Err(report) = gate {
        panic!("{report}");
    }
}
