//! What the gates that run `mandate_check::check` share: reading a source
//! as Node's `readFileSync(file, "utf8")` reads it, loading modules as
//! `--module` loads them, and checking with them and a lock.

#![allow(dead_code, clippy::expect_used, clippy::panic, missing_docs)]

use mandate_check::{CheckOptions, CheckResult, ModuleSource, Modules, check, load_modules};
use mandate_ir::{JsValue, Value, stringify_pretty};
use mandate_syntax::{SourceKind, kind_of};
use mandate_testkit::{read_bytes, read_json};

/// The text of the repository file `rel`, decoded as
/// `readFileSync(file, "utf8")` decodes it: each ill-formed sequence is
/// U+FFFD.
pub fn read_source(rel: &str) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&read_bytes(rel)?).into_owned())
}

/// `mdt` or `json`.
pub fn kind_named(kind: &str) -> SourceKind {
    if kind == "json" {
        SourceKind::Json
    } else {
        SourceKind::Mdt
    }
}

/// The modules in the repository files `files`, loaded together with
/// `load_modules` (each against the others), named by `names` in messages.
/// They must load, as the TypeScript's test helpers require.
pub fn modules_of(files: &[String], names: &[String]) -> Result<Modules, String> {
    let mut texts = Vec::new();
    for f in files {
        texts.push(read_source(f)?);
    }
    let sources: Vec<ModuleSource<'_>> = files
        .iter()
        .zip(&texts)
        .zip(names)
        .map(|((f, text), name)| ModuleSource {
            text,
            kind: kind_of(f),
            file: name,
        })
        .collect();
    let loaded = load_modules(&sources);
    if let Some(p) = loaded.problems.first() {
        let codes: Vec<String> = p
            .diagnostics
            .iter()
            .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
            .collect();
        return Err(format!(
            "module {} does not load: {}",
            p.file,
            codes.join(", ")
        ));
    }
    Ok(loaded.modules)
}

/// `check(text, kind, { modules, lock })`, with the modules and the lock
/// read from these repository files.
pub fn check_with(
    text: &str,
    kind: SourceKind,
    modules: Option<&Modules>,
    lock: Option<&str>,
) -> Result<CheckResult, String> {
    let lock: Option<Value> = lock.map(read_json).transpose()?;
    Ok(check(
        text,
        kind,
        &CheckOptions {
            lock: lock.as_ref(),
            modules,
            claim: None,
        },
    ))
}

/// The text the golden test hashes for a check: `JSON.stringify({ ok,
/// hashes?, diagnostics }, null, 2) + "\n"`.
pub fn check_text(r: &CheckResult) -> String {
    let mut text = stringify_pretty(&r.to_js()).unwrap_or_default();
    text.push('\n');
    text
}

/// A stored value as that text: `JSON.stringify(value, null, 2) + "\n"`.
pub fn value_text(v: &Value) -> String {
    let mut text = stringify_pretty(&JsValue::from(v)).unwrap_or_default();
    text.push('\n');
    text
}
