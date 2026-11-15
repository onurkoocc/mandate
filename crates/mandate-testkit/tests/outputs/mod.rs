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

use mandate_check::{CheckResult, requirements_to_js, sandbox_requirements, semantic_diff};
use mandate_ir::{Diagnostic, JsObject, JsValue, canonicalize, stringify_pretty};
use mandate_syntax::{kind_of, load};
use mandate_testkit::read_json;
use mandate_views::{
    architecture, authority, card, card_doc, cost, envelope_workflows, program_doc, to_html,
    to_markdown,
};

use crate::common::{check_text, check_with, modules_of, read_source};

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
    } else {
        &[
            "fixtures/system/acme.system.mdt",
            "fixtures/system/repos.mdt",
        ]
    };
    files.iter().map(|f| (*f).to_owned()).collect()
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
    check_with(text, kind_of(program), modules.as_ref(), lock.as_deref())
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
        let modules = modules_of(&files, &files)?;
        let lock = lock_path.as_deref().map(read_json).transpose()?;
        let views = JsObject::new()
            .with("architecture", architecture(p).to_js())
            .with("authority", authority(p).to_js())
            .with("cost", cost(p, lock.as_ref()).to_js());
        out.push((
            "view --format json".to_owned(),
            pretty(&JsValue::Object(views)),
        ));
        let doc = program_doc(p, lock.as_ref(), Some(&modules));
        out.push(("view --format md".to_owned(), to_markdown(&doc)));
        out.push(("view --format html".to_owned(), to_html(&doc)));
        out.push((
            "view --against itself".to_owned(),
            pretty(&semantic_diff(p, p, None).to_js()),
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
    }
    Ok(out)
}
