//! The doors that read, check, hash and print a program: `load`, `check`,
//! `load_modules`, `parse_strict_json`, `canonicalize`, `hash_program`,
//! `package_hash`, `domain_hash` and `print_program`.

use mandate_ir::{
    Diagnostic, HashDomain, JsObject, JsValue, ProgramHashes, Span, Spans, Value, parse,
};
use mandate_syntax::{SourceKind, parse_mdt};

use super::DoorError;
use super::input::{Members, args};
use crate::check::{CheckOptions, ModuleSource};

/// The diagnostics as an array.
pub(super) fn diagnostics_js(diagnostics: &[Diagnostic]) -> JsValue {
    JsValue::Array(diagnostics.iter().map(Diagnostic::to_js).collect())
}

/// A value of the IR as an output value.
pub(super) fn ir(v: &Value) -> JsValue {
    JsValue::from(v)
}

/// The span table of `text`, read as `kind`, as the TypeScript's `Map`
/// iterates it: an object with the entries in the order they were made.
///
/// The Rust keeps the table sorted by pointer ([`Spans`]); the order of the
/// TypeScript's is recovered from how it was made. The strict JSON reader
/// sets a value's span when the value ends, so its entries are in the order
/// of where each value ends in the text. The Mandate text's are those of the
/// walk of `sourceMap`, an object before its members, which
/// [`mandate_syntax::SourceMap`] keeps in order. An entry of `spans` that
/// neither order has (none, for a table made from `text`) goes last, in the
/// table's order.
fn spans_js(text: &str, kind: SourceKind, spans: &Spans) -> JsValue {
    let mut rows: Vec<(&str, Span)> = Vec::with_capacity(spans.len());
    match kind {
        SourceKind::Json => {
            rows.extend(spans.iter().map(|(p, s)| (p.as_str(), *s)));
            rows.sort_by_key(|(_, s)| (s.end_line, s.end_col));
        }
        SourceKind::Mdt => {
            let order = parse_mdt(text).spans;
            for (pointer, _) in order.iter() {
                if let Some((p, s)) = spans.get_key_value(pointer) {
                    rows.push((p.as_str(), *s));
                }
            }
            if rows.len() < spans.len() {
                for (p, s) in spans {
                    if order.get(p).is_none() {
                        rows.push((p.as_str(), *s));
                    }
                }
            }
        }
    }
    let entries: Vec<(String, JsValue)> = rows
        .into_iter()
        .map(|(p, s)| (p.to_owned(), s.to_js()))
        .collect();
    // The pointers are distinct, and none is an array index (each is empty
    // or starts with `/`), so the object keeps this order.
    JsObject::from_entries(entries).map_or(JsValue::Null, JsValue::Object)
}

/// The parameters of [`load`].
pub(super) const LOAD: &[&str] = &["text", "kind"];

/// `load(text, kind)`, `compiler/src/check.ts`: reads a program and
/// validates it against the closed schema.
///
/// Input: `{ text: string, kind: "mdt" | "json" }`.
/// Output: `LoadResult`, `{ program?, spans, diagnostics }`; `spans` is the
/// `Map` from JSON Pointer to `[startLine, startCol, endLine, endCol]`, as an
/// object in the order the TypeScript made it.
pub(super) fn load(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, LOAD)?;
    let text = a.str("text")?;
    let kind = a.kind("kind")?;
    let loaded = mandate_syntax::load(text, kind);
    Ok(JsObject::new()
        .with_some("program", loaded.program.as_ref().map(ir))
        .with("spans", spans_js(text, kind, &loaded.spans))
        .with("diagnostics", diagnostics_js(&loaded.diagnostics))
        .into())
}

/// The parameters of [`check`].
pub(super) const CHECK: &[&str] = &["text", "kind", "opts"];

/// `check(text, kind, opts)`, `compiler/src/check.ts`: reads, validates
/// and checks a program, and hashes it when it checks.
///
/// Input: `{ text: string, kind: "mdt" | "json", opts?: { lock?, modules?,
/// claim? } }`: `lock` is the lock as read (any value: the check validates
/// it), `modules` the loaded modules by name (each a program), `claim` the
/// `{ envelope, lead }` a sub-program's check is given.
/// Output: `CheckResult`, `{ program?, spans, diagnostics, ok, hashes? }`,
/// `spans` as [`load`] gives it and `hashes` `{ program, defs }`.
pub(super) fn check(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, CHECK)?;
    let text = a.str("text")?;
    let kind = a.kind("kind")?;
    let mut opts = CheckOptions::default();
    if let Some(o) = a.opt_members("opts", "opts.")? {
        opts.lock = o.opt_value("lock");
        opts.modules = o.opt_modules("modules")?;
        opts.claim = o.opt_object("claim")?;
    }
    let r = crate::check::check(text, kind, &opts);
    Ok(JsObject::new()
        .with_some("program", r.program.as_ref().map(ir))
        .with("spans", spans_js(text, kind, &r.spans))
        .with("diagnostics", diagnostics_js(&r.diagnostics))
        .with("ok", r.ok)
        .with_some("hashes", r.hashes.as_ref().map(ProgramHashes::to_js))
        .into())
}

/// The parameters of [`load_modules`].
pub(super) const LOAD_MODULES: &[&str] = &["sources"];

/// `loadModules(sources)`, `compiler/src/check.ts`: loads the modules a
/// program imports and checks each against the others.
///
/// Input: `{ sources: [{ text: string, kind: "mdt" | "json", file: string }] }`.
/// Output: `{ modules: { <name>: program }, problems: [{ file, diagnostics }] }`.
pub(super) fn load_modules(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, LOAD_MODULES)?;
    let items = a.array("sources")?;
    let mut sources: Vec<ModuleSource<'_>> = Vec::with_capacity(items.len());
    for item in items {
        let s = Members::nested(item, "sources[].", "sources[]")?;
        sources.push(ModuleSource {
            text: s.str("text")?,
            kind: s.kind("kind")?,
            file: s.str("file")?,
        });
    }
    let r = crate::check::load_modules(&sources);
    let modules: JsObject = r.modules.iter().map(|(name, p)| (name, ir(p))).collect();
    let problems: Vec<JsValue> = r
        .problems
        .iter()
        .map(|p| {
            JsObject::new()
                .with("file", p.file.as_str())
                .with("diagnostics", diagnostics_js(&p.diagnostics))
                .into()
        })
        .collect();
    Ok(JsObject::new()
        .with("modules", modules)
        .with("problems", problems)
        .into())
}

/// The parameters of [`parse_strict_json`].
pub(super) const PARSE_STRICT_JSON: &[&str] = &["text"];

/// `parseStrictJson(text)`, `compiler/src/json/strict-json.ts`: the strict
/// JSON reader of the IR (no duplicate keys, integers only, bounded depth
/// and size).
///
/// Input: `{ text: string }`.
/// Output: `{ ok: true, value: { value, spans } }`, `spans` the `Map` from
/// JSON Pointer to span in the order the reader made it (the order in which
/// the values end in the text), or `{ ok: false, diagnostics }`.
pub(super) fn parse_strict_json(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, PARSE_STRICT_JSON)?;
    let text = a.str("text")?;
    Ok(match parse(text) {
        Ok(parsed) => JsObject::new()
            .with("ok", true)
            .with(
                "value",
                JsObject::new()
                    .with("value", ir(&parsed.value))
                    .with("spans", spans_js(text, SourceKind::Json, &parsed.spans)),
            )
            .into(),
        Err(diagnostics) => JsObject::new()
            .with("ok", false)
            .with("diagnostics", diagnostics_js(&diagnostics))
            .into(),
    })
}

/// The parameters of [`canonicalize`].
pub(super) const CANONICALIZE: &[&str] = &["value"];

/// `canonicalize(value)`, `compiler/src/json/jcs.ts`: the RFC 8785
/// canonical text of a value.
///
/// Input: `{ value: any JSON value }`.
/// Output: the text, a string.
pub(super) fn canonicalize(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, CANONICALIZE)?;
    Ok(JsValue::String(mandate_ir::canonicalize(a.value("value")?)))
}

/// The parameters of [`hash_program`].
pub(super) const HASH_PROGRAM: &[&str] = &["program"];

/// `hashProgram(program)`, `compiler/src/hash.ts`: the hash of a program and
/// of each of its definitions.
///
/// Input: `{ program: any JSON value }`.
/// Output: `{ program, defs: { <name>: hash } }`, the names sorted.
pub(super) fn hash_program(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, HASH_PROGRAM)?;
    Ok(mandate_ir::hash_program(a.value("program")?).to_js().into())
}

/// The parameters of [`package_hash`].
pub(super) const PACKAGE_HASH: &[&str] = &["programHash", "lock"];

/// `packageHash(programHash, lock)`, `compiler/src/hash.ts`: the hash of a
/// program with the lock it is packaged with.
///
/// Input: `{ programHash: string, lock: the lock as a package carries it
/// (any JSON value) }`.
/// Output: the hash, a string.
pub(super) fn package_hash(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, PACKAGE_HASH)?;
    let program_hash = a.str("programHash")?;
    let lock = a.value("lock")?;
    Ok(JsValue::String(mandate_ir::package_hash(
        program_hash,
        lock,
    )))
}

/// The parameters of [`domain_hash`].
pub(super) const DOMAIN_HASH: &[&str] = &["domain", "value", "version"];

/// `domainHash(domain, value, version)`, `compiler/src/hash.ts`: the
/// domain-separated hash of a value.
///
/// Input: `{ domain: "program" | "def" | "package" | "run" | "action" |
/// "operation" | "request" | "binding" | "decision" | "event", value: any
/// JSON value, version?: string }` (`"0.1"` when absent).
/// Output: the hash, a string.
pub(super) fn domain_hash(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, DOMAIN_HASH)?;
    let name = a.str("domain")?;
    let domain = HashDomain::from_name(name).ok_or_else(|| {
        DoorError::bad_input(format!("`domain` is \"{name}\", not a hash domain"))
    })?;
    let value = a.value("value")?;
    let version = a
        .opt_str("version")?
        .unwrap_or(mandate_ir::RUNTIME_HASH_VERSION);
    Ok(JsValue::String(mandate_ir::domain_hash(
        domain, value, version,
    )))
}

/// The parameters of [`print_program`].
pub(super) const PRINT_PROGRAM: &[&str] = &["p"];

/// `printProgram(p)`, `compiler/src/print/printer.ts`: a program as Mandate
/// text.
///
/// Input: `{ p: program }`.
/// Output: the text, a string ending with a line feed; `bad_input` with the
/// TypeScript's message where it throws (a union type that is not a type
/// definition, a set literal with items, a string literal in an
/// interpolation).
pub(super) fn print_program(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, PRINT_PROGRAM)?;
    let p = a.object("p")?;
    mandate_syntax::print_program(p)
        .map(JsValue::String)
        .map_err(DoorError::bad_input)
}
