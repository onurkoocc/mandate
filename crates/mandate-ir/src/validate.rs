//! Reading a program given as JSON IR: `load(text, "json")` in
//! `compiler/src/check.ts` and `validateIr` in `compiler/src/ir/validate.ts`,
//! ported line by line.
//!
//! The language version is checked first, so that a program for another
//! version gets one explicit diagnostic (E0103) instead of a pile of schema
//! errors; then the closed schema ([`crate::ir_schema`]), whose raw errors
//! become diagnostics as `schemaDiagnostics` makes them; then the version
//! gates; then the number of definitions (E0105).

use std::cmp::Reverse;
use std::collections::{BTreeMap, HashSet};

use crate::diag::{Diagnostic, Location, Span, has_errors, ptr_token};
use crate::jcs::compare_utf16;
use crate::js_value::{JsObject, JsValue, stringify};
use crate::reader::parse;
use crate::schema::{SchemaError, ir_schema_errors};
use crate::tags::Language;
use crate::value::Value;

/// The spans of a value that was read, by JSON Pointer.
pub type Spans = BTreeMap<String, Span>;

/// The span of `path`, or else of the nearest path above it that has one:
/// `nearestSpan` in `validate.ts`.
#[must_use]
pub fn nearest_span(spans: Option<&Spans>, path: &str) -> Option<Span> {
    let spans = spans?;
    let mut p = path;
    loop {
        if let Some(span) = spans.get(p) {
            return Some(*span);
        }
        if p.is_empty() {
            return None;
        }
        // `p.slice(0, p.lastIndexOf("/"))`; with no `/`, `slice(0, -1)`.
        p = match p.rfind('/') {
            Some(at) => p.get(..at).unwrap_or_default(),
            None => {
                let mut chars = p.chars();
                chars.next_back();
                chars.as_str()
            }
        };
    }
}

/// `at(path)` of `validateIr`: `{ path, span }` with the nearest span, or
/// `{ path }`.
fn at(spans: Option<&Spans>, path: &str) -> Location {
    Location::path_span(path, nearest_span(spans, path))
}

/// The diagnostics of `value`, a program read as JSON, with the spans the
/// reader gave: `validateIr(value, spans)`.
#[must_use]
pub fn validate_ir(value: &Value, spans: Option<&Spans>) -> Vec<Diagnostic> {
    let Value::Object(program) = value else {
        return vec![Diagnostic::new(
            "E0104",
            "A Mandate program must be a JSON object.",
            at(spans, ""),
            None,
        )];
    };
    let found = program.get("language");
    if found.and_then(Language::from_value).is_none() {
        return vec![unknown_language(found, spans)];
    }
    match ir_schema_errors(value) {
        Ok(errors) => schema_diagnostics(&errors, spans),
        // The embedded schema always prepares (a test holds it to that);
        // were it not to, nothing is accepted.
        Err(why) => vec![Diagnostic::new(
            "E0104",
            format!("The IR schema could not be prepared: {why}"),
            at(spans, ""),
            None,
        )],
    }
}

/// E0103 for a `language` that is missing or not one this compiler reads.
fn unknown_language(found: Option<&Value>, spans: Option<&Spans>) -> Diagnostic {
    let known = Language::ALL
        .iter()
        .map(|v| format!("\"{v}\""))
        .collect::<Vec<_>>()
        .join(" or ");
    let message = match found {
        None => format!("Missing \"language\" field; expected {known}."),
        Some(v) => format!(
            "Unsupported language version {}; this compiler reads {known}. Use an explicit migration instead of loading it as-is.",
            stringify(&JsValue::from(v)).unwrap_or_default()
        ),
    };
    let expected: Vec<JsValue> = Language::ALL.iter().map(|v| v.as_str().into()).collect();
    let facts = JsObject::new()
        .with("expected", expected)
        .with("found", found.map_or(JsValue::Null, JsValue::from));
    Diagnostic::new("E0103", message, at(spans, "/language"), Some(facts))
}

/// `schemaDiagnostics`: the raw errors as E0104, the ones that reach
/// deepest into the value, each message once, sorted by path.
fn schema_diagnostics(errors: &[SchemaError], spans: Option<&Spans>) -> Vec<Diagnostic> {
    // oneOf without a discriminator reports every failed branch; keep the
    // errors that reach deepest into the instance, which name the problem.
    let relevant: Vec<&SchemaError> = errors
        .iter()
        .filter(|e| e.keyword != "oneOf" && e.keyword != "if")
        .collect();
    // `instancePath.split("/").length`, one more for additionalProperties.
    let depth = |e: &SchemaError| {
        let parts = e.instance_path.matches('/').count().saturating_add(1);
        parts.saturating_add(usize::from(e.keyword == "additionalProperties"))
    };
    // Whether another error's path is below `path`: the paths that start with
    // `path + "/"` are together in sorted order, from the first one not less
    // than it.
    let mut paths: Vec<&str> = relevant.iter().map(|e| e.instance_path.as_str()).collect();
    paths.sort_unstable();
    paths.dedup();
    let has_below = |path: &str| {
        let prefix = format!("{path}/");
        let first = paths.partition_point(|p| *p < prefix.as_str());
        paths.get(first).is_some_and(|p| p.starts_with(&prefix))
    };
    let mut sorted = relevant.clone();
    // Stable, as `Array.prototype.sort` is: equal depths keep Ajv's order.
    sorted.sort_by_key(|e| Reverse(depth(e)));
    let max_depth = sorted.first().map_or(0, |e| depth(e));
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for e in sorted {
        // Drop shallower errors that are only a consequence of a deeper one.
        if has_below(&e.instance_path) && depth(e) < max_depth {
            continue;
        }
        let param = |key: &str| {
            e.params
                .get(key)
                .map(JsValue::to_js_string)
                .unwrap_or_default()
        };
        let mut path = e.instance_path.clone();
        let message = match e.keyword {
            "additionalProperties" => {
                let field = param("additionalProperty");
                path = format!("{path}/{}", ptr_token(&field));
                format!(
                    "Unknown field \"{field}\". The IR schema is closed; unknown fields are rejected, not ignored."
                )
            }
            "required" => format!("Missing required field \"{}\".", param("missingProperty")),
            "const" | "enum" => {
                let allowed = match (e.params.get("allowedValue"), e.params.get("allowedValues")) {
                    (Some(one), _) if e.keyword == "const" => vec![one.clone()],
                    (_, Some(JsValue::Array(all))) => all.clone(),
                    _ => Vec::new(),
                };
                let shown: Vec<String> = allowed
                    .iter()
                    .map(|v| stringify(v).unwrap_or_default())
                    .collect();
                format!("Value must be one of {}.", shown.join(", "))
            }
            "pattern" => format!(
                "Value does not match {} (names are ASCII identifiers).",
                param("pattern")
            ),
            "discriminator" => format!("Unknown or missing tag: {}.", e.message),
            _ => format!("Schema violation: {}.", e.message),
        };
        if !seen.insert(format!("{path}|{message}")) {
            continue;
        }
        let facts = JsObject::new()
            .with("keyword", e.keyword)
            .with("schema_path", e.schema_path.as_str());
        out.push(Diagnostic::new(
            "E0104",
            message,
            at(spans, &path),
            Some(facts),
        ));
    }
    // By UTF-16 code units, not by the locale; stable.
    out.sort_by(|a, b| {
        let path = |d: &Diagnostic| d.at.path.clone().unwrap_or_default();
        compare_utf16(&path(a), &path(b))
    });
    out
}

/// What [`load_json`] gives: `LoadResult` in `check.ts`.
#[derive(Clone, Debug, PartialEq)]
pub struct Loaded {
    /// The program, when it was read and has no error.
    pub program: Option<Value>,
    /// Each value's span in the text, by JSON Pointer; empty when the reader
    /// refused the text.
    pub spans: Spans,
    /// The reader's diagnostics, or those of [`validate_ir`].
    pub diagnostics: Vec<Diagnostic>,
}

/// Reads a program given as JSON IR: `load(text, "json")`. The strict reader
/// first: when it refuses the text, its diagnostics and no spans. Then
/// [`validate_ir`]: when it gives an error, its diagnostics and the spans,
/// but no program; otherwise the program too.
#[must_use]
pub fn load_json(text: &str) -> Loaded {
    match parse(text) {
        Err(diagnostics) => Loaded {
            program: None,
            spans: Spans::new(),
            diagnostics,
        },
        Ok(parsed) => {
            let diagnostics = validate_ir(&parsed.value, Some(&parsed.spans));
            let program = (!has_errors(&diagnostics)).then_some(parsed.value);
            Loaded {
                program,
                spans: parsed.spans,
                diagnostics,
            }
        }
    }
}
