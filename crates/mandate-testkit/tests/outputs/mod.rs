//! The output texts of a program, as the golden files pin them: what each
//! command prints, by its name (`compiler/test/golden-outputs.ts`,
//! `outputs`, is the authority). The golden gate of 0.6 (`golden_0_6.rs`)
//! and the 0.6 diagnostic vectors (`diagnostics_0_6.rs`) use it.
//!
//! It gives what `golden.rs`, the gate of the TypeScript's golden file,
//! gives: the same calls in the same order. `golden.rs` keeps a copy of its
//! own (another change owns it); `golden_0_6.rs` holds this module to every
//! digest of `compiler/test/golden/outputs.json`, so that the two cannot
//! drift apart without a test failing.

#![allow(dead_code)]

use mandate_check::{CheckResult, requirements_to_js, sandbox_requirements, semantic_diff_with};
use mandate_ir::{Diagnostic, JsObject, JsValue, canonicalize, stringify_pretty};
use mandate_syntax::{kind_of, load};
use mandate_testkit::read_json;
use mandate_views::{
    architecture_with, authority_with, card, card_doc, cost_with, envelope_workflows, program_doc,
    to_html, to_markdown,
};

use crate::common::{
    check_text, check_with_libraries, modules_of, read_source, run_subprogram, subprogram_case,
};

/// `MODULE_FILES` in `compiler/test/golden-outputs.ts`, and `MODULE_FILES_OF`
/// where it names others: the module files a program is given. A program of
/// 0.6 that imports a module of `fixtures/library/` is given it (no
/// TypeScript reads either, so the golden file of 0.6 alone has them).
pub fn module_files_of(program: &str) -> Vec<String> {
    let files: &[&str] = if program == "fixtures/envelope/migrate-all.mdt" {
        &["fixtures/envelope/domain.mdt"]
    } else if program == "fixtures/library/summarize.mdt" {
        &["fixtures/library/shared.mdt"]
    } else if program == "fixtures/library/drafts.mdt" || program == "fixtures/library/review.mdt" {
        &[
            "fixtures/library/acme.connectors/types.mdt",
            "fixtures/library/acme.connectors/connectors.mdt",
        ]
    } else if program == "fixtures/library/invoices.mdt"
        || program == "fixtures/library/migrate-all.mdt"
    {
        // The acceptance program: its modules come from its libraries. The
        // shaped migration imports nothing but std and std.patterns.
        &[]
    } else if program == "fixtures/library/batch.mdt" {
        // The acceptance program's flow, its pattern in a module of its own.
        &[
            "fixtures/library/acme.connectors/types.mdt",
            "fixtures/library/acme.connectors/connectors.mdt",
            "fixtures/library/batch.patterns.mdt",
        ]
    } else {
        &[
            "fixtures/system/acme.system.mdt",
            "fixtures/system/repos.mdt",
        ]
    };
    files.iter().map(|f| (*f).to_owned()).collect()
}

/// The library directories a program of 0.6 is given (`check --module`
/// and `--lock`, and its views): those its lock pins, besides the built-in
/// `std.patterns`.
pub fn library_dirs_of(program: &str) -> Vec<String> {
    if program == "fixtures/library/invoices.mdt" {
        vec!["fixtures/library/acme.connectors".to_owned()]
    } else {
        Vec::new()
    }
}

/// The modules of the libraries of `program`: what its views are given
/// besides its modules (the views add the built-in `std.patterns`).
pub fn library_modules_of(program: &str) -> Result<mandate_check::Modules, String> {
    let mut out = mandate_check::Modules::new();
    for source in crate::common::libraries_of(&library_dirs_of(program))? {
        let l = mandate_check::library::load_library(&source, false, program)
            .map_err(|d| format!("{program}: a library does not load: {d:?}"))?;
        for (m, ir) in l.modules.iter() {
            out.insert(m, ir.clone());
        }
    }
    Ok(out)
}

/// `lockFileOf` in `compiler/test/helpers.ts`: `<name>.lock.json` beside the
/// program, else `mandate.lock.json` beside it, the first that exists.
pub fn lock_file_of(program: &str) -> Option<String> {
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

/// `check(text, kind, { modules?, lock? })` of a program.
pub fn checked(program: &str, with_modules: bool, with_lock: bool) -> Result<CheckResult, String> {
    checked_text(program, &read_source(program)?, with_modules, with_lock)
}

/// [`checked`] of `text` in the place of the program's own text: its modules
/// and its lock are the program's.
pub fn checked_text(
    program: &str,
    text: &str,
    with_modules: bool,
    with_lock: bool,
) -> Result<CheckResult, String> {
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
    let libraries = if with_modules {
        library_dirs_of(program)
    } else {
        Vec::new()
    };
    check_with_libraries(
        text,
        kind_of(program),
        modules.as_ref(),
        lock.as_deref(),
        &libraries,
        None,
    )
}

fn pretty(v: &JsValue) -> String {
    let mut text = stringify_pretty(v).unwrap_or_default();
    text.push('\n');
    text
}

/// Every output of `program`, in the order `outputs` writes them: `check`,
/// `check --module`, `check --lock` (with a lock), `load`, `ir --canonical`
/// and `fmt` (when it loads), `hash` (when it checks alone), and the views
/// and `sandbox` (when it checks with its modules and its lock), then the
/// card's three (`view --card --format …`) when it has exactly one workflow
/// with an envelope.
///
/// # Errors
///
/// A file that cannot be read, modules that do not load, or `fmt` refused.
pub fn outputs_of(program: &str) -> Result<Vec<(String, String)>, String> {
    outputs_of_text(program, &read_source(program)?)
}

/// [`outputs_of`] of `text` in the place of the program's own text: its
/// kind, its modules and its lock are the program's.
///
/// # Errors
///
/// As [`outputs_of`].
pub fn outputs_of_text(program: &str, text: &str) -> Result<Vec<(String, String)>, String> {
    let mut out: Vec<(String, String)> = Vec::new();
    let lock_path = lock_file_of(program);
    let plain = checked_text(program, text, false, false)?;
    out.push(("check".to_owned(), check_text(&plain)));
    let linked = checked_text(program, text, true, false)?;
    out.push(("check --module".to_owned(), check_text(&linked)));
    let with_lock = match lock_path {
        Some(_) => Some(checked_text(program, text, true, true)?),
        None => None,
    };
    if let Some(r) = &with_lock {
        out.push(("check --lock".to_owned(), check_text(r)));
    }
    let loaded = load(text, kind_of(program));
    out.push((
        "load".to_owned(),
        pretty(&JsValue::Array(
            loaded.diagnostics.iter().map(Diagnostic::to_js).collect(),
        )),
    ));
    if let Some(p) = &loaded.program {
        out.push(("ir --canonical".to_owned(), canonicalize(p)));
        out.push(("fmt".to_owned(), mandate_syntax::print_program(p)?));
    }
    if let Some(h) = &plain.hashes {
        out.push(("hash".to_owned(), pretty(&JsValue::Object(h.to_js()))));
    }
    let checked = with_lock.as_ref().unwrap_or(&linked);
    if let (true, Some(p)) = (checked.ok, &checked.program) {
        let files = module_files_of(program);
        let mut modules = modules_of(&files, &files)?;
        for (m, ir) in library_modules_of(program)?.iter() {
            modules.insert(m, ir.clone());
        }
        let lock = lock_path.as_deref().map(read_json).transpose()?;
        // The views as `mandate view --module …` gives them: with the
        // modules, so that a workflow that applies a pattern of one of them
        // is shown as its expansion (the same as without them for a program
        // that applies none).
        let views = JsObject::new()
            .with("architecture", architecture_with(p, Some(&modules)).to_js())
            .with("authority", authority_with(p, Some(&modules)).to_js())
            .with("cost", cost_with(p, lock.as_ref(), Some(&modules)).to_js());
        out.push((
            "view --format json".to_owned(),
            pretty(&JsValue::Object(views)),
        ));
        let doc = program_doc(p, lock.as_ref(), Some(&modules));
        out.push(("view --format md".to_owned(), to_markdown(&doc)));
        out.push(("view --format html".to_owned(), to_html(&doc)));
        out.push((
            "view --against itself".to_owned(),
            pretty(&semantic_diff_with(p, p, None, Some(&modules)).to_js()),
        ));
        let hashes = checked
            .hashes
            .as_ref()
            .ok_or("a program that checks has hashes")?;
        let requirements = sandbox_requirements(p, Some(&modules), lock.as_ref());
        let sandbox = JsObject::new()
            .with("program", hashes.program.as_str())
            .with("requirements", requirements_to_js(&requirements));
        out.push(("sandbox".to_owned(), pretty(&JsValue::Object(sandbox))));
        // `mandate view --card`: of the one workflow with an envelope, when the
        // program has exactly one, with its modules and its lock.
        if let [name] = envelope_workflows(p).as_slice() {
            let missing = || format!("{name} has no card");
            let view = card(p, name, lock.as_ref(), Some(&modules)).ok_or_else(missing)?;
            out.push((
                "view --card --format json".to_owned(),
                pretty(&view.to_js()),
            ));
            let doc = card_doc(p, name, lock.as_ref(), Some(&modules)).ok_or_else(missing)?;
            out.push(("view --card --format md".to_owned(), to_markdown(&doc)));
            out.push(("view --card --format html".to_owned(), to_html(&doc)));
        }
        // 0.6: the sub-programs a lead of the program might write, each
        // checked as `check_subprogram` gives it (spec/library.md "shapes").
        for (file, workflow, number) in subprograms_of(program) {
            let s = mandate_testkit::parse_json(format!(
                r#"{{"workflow":"{workflow}","number":{number},"defs":{{"file":"{file}","kind":"mdt"}},"room":{{"left":{{"tokens":50000000,"steps":1000,"agents":100,"spend:USD":100000000}},"time_left_ms":18000000}}}}"#
            ).as_bytes())?;
            let case = subprogram_case("fixtures/library", &s, p)?;
            let r = run_subprogram(&case, p, &modules)?;
            out.push((format!("check_subprogram {file}"), r.text));
        }
    }
    Ok(out)
}

/// The sub-programs of a program of 0.6 whose outputs are pinned with it:
/// each file (relative to `fixtures/library/`), the workflow whose envelope
/// bounds it and its number.
fn subprograms_of(program: &str) -> Vec<(&'static str, &'static str, u32)> {
    if program == "fixtures/library/migrate-all.mdt" {
        vec![
            ("migrate-all.plans/fan-out.mdt", "MigrateAll", 1),
            ("migrate-all.plans/written-out.mdt", "MigrateAll", 2),
        ]
    } else {
        Vec::new()
    }
}
