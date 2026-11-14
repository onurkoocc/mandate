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

/// The reference tokens of a JSON Pointer, unescaped: `tokens` in
/// `compiler/test/cases-runner.ts`.
fn pointer_tokens(pointer: &str) -> Result<Vec<String>, String> {
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    let Some(rest) = pointer.strip_prefix('/') else {
        return Err(format!("\"{pointer}\" is not a JSON Pointer"));
    };
    Ok(rest
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect())
}

/// An array index of the runner: `index(token, length, allowEnd)`. `-` is
/// the end when `allow_end`; otherwise `/^(0|[1-9][0-9]*)$/`, within the
/// array (or at its end when `allow_end`).
fn pointer_index(token: &str, length: usize, allow_end: bool) -> Result<usize, String> {
    if allow_end && token == "-" {
        return Ok(length);
    }
    let digits = !token.is_empty()
        && token.bytes().all(|b| b.is_ascii_digit())
        && (token == "0" || !token.starts_with('0'));
    if !digits {
        return Err(format!("\"{token}\" is not an array index"));
    }
    // `Number(token)`: a run of digits too long for usize is past any end.
    let i = token.parse::<usize>().unwrap_or(usize::MAX);
    if i > length || (i == length && !allow_end) {
        return Err(format!("index {token} is out of range"));
    }
    Ok(i)
}

/// `child(parent, token)` of the runner.
fn pointer_child<'v>(parent: &'v mut Value, token: &str) -> Result<&'v mut Value, String> {
    match parent {
        Value::Array(items) => {
            let i = pointer_index(token, items.len(), false)?;
            items
                .get_mut(i)
                .ok_or_else(|| format!("index {token} is out of range"))
        }
        Value::Object(map) => map
            .get_mut(token)
            .ok_or_else(|| format!("there is no member \"{token}\"")),
        _ => Err(format!("there is no member \"{token}\"")),
    }
}

/// One operation of [`apply_json_patch`].
fn apply_op(root: &mut Value, kind: &str, path: &str, value: Option<&Value>) -> Result<(), String> {
    let value = || value.cloned().unwrap_or(Value::Null);
    let tokens = pointer_tokens(path)?;
    let Some((last, init)) = tokens.split_last() else {
        if kind == "remove" {
            return Err("the document root cannot be removed".to_owned());
        }
        *root = value();
        return Ok(());
    };
    let mut parent = root;
    for t in init {
        parent = pointer_child(parent, t)?;
    }
    match parent {
        Value::Array(items) => {
            let i = pointer_index(last, items.len(), kind == "add")?;
            match kind {
                "add" => items.insert(i, value()),
                "replace" => {
                    if let Some(slot) = items.get_mut(i) {
                        *slot = value();
                    }
                }
                _ => {
                    items.remove(i);
                }
            }
        }
        Value::Object(map) => {
            if kind != "add" && !map.contains_key(last) {
                return Err(format!("there is no member \"{last}\""));
            }
            if kind == "remove" {
                map.remove(last);
            } else {
                map.insert(last.clone(), value());
            }
        }
        _ => return Err("the parent is not an object or an array".to_owned()),
    }
    Ok(())
}

/// `applyJsonPatch(doc, ops)` of `compiler/test/cases-runner.ts`: RFC 6902
/// `add`, `replace` and `remove`, applied in order to a copy of `doc`; any
/// other op is refused, and so is an operation whose path does not exist.
/// An object member set by `add` or `replace` is assigned, so a member that
/// is there keeps its place and a new one comes last (in ECMAScript order).
/// (The runner's objects come from `JSON.parse`, plain objects, where an
/// assignment to `__proto__` would set the prototype; no case writes one.)
pub fn apply_json_patch(doc: &Value, ops: &[Value]) -> Result<Value, String> {
    let mut root = doc.clone();
    for (n, op) in ops.iter().enumerate() {
        let kind = op.get("op").and_then(Value::as_str).unwrap_or("undefined");
        let path = op.get("path").and_then(Value::as_str).unwrap_or("");
        let at = format!("patch operation {n} ({kind} {path})");
        if !matches!(kind, "add" | "replace" | "remove") {
            return Err(format!(
                "{at}: op \"{kind}\" is not supported; use add, replace or remove"
            ));
        }
        apply_op(&mut root, kind, path, op.get("value")).map_err(|e| format!("{at}: {e}"))?;
    }
    Ok(root)
}

/// The text a `check_patched` case is checked as (`runCompileCase`): its
/// input loaded, which must load without errors, the case's patch applied
/// to the IR, and the patched IR written as `JSON.stringify(program)`
/// writes it, compact.
pub fn patched_source(text: &str, kind: SourceKind, patch: &[Value]) -> Result<String, String> {
    let before = mandate_syntax::load(text, kind);
    let program = match before.program {
        Some(p) if !mandate_ir::has_errors(&before.diagnostics) => p,
        _ => {
            let codes: Vec<String> = before
                .diagnostics
                .iter()
                .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
                .collect();
            return Err(format!(
                "the input of a patch case must load before the patch: {}",
                codes.join(", ")
            ));
        }
    };
    let patched = apply_json_patch(&program, patch)?;
    mandate_ir::stringify(&JsValue::from(&patched)).ok_or_else(|| "no JSON text".to_owned())
}
