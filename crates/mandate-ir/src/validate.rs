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
use crate::limits::DEFINITIONS;
use crate::program::Program;
use crate::reader::parse;
use crate::schema::{SchemaError, ir_schema_errors};
use crate::tags::{DefKind, ExprOp, Language};
use crate::value::{Map, Value};

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
    let Some(program) = Program::of(value) else {
        return vec![Diagnostic::new(
            "E0104",
            "A Mandate program must be a JSON object.",
            at(spans, ""),
            None,
        )];
    };
    let Some(language) = program.language() else {
        return vec![unknown_language(program.members().get("language"), spans)];
    };
    let out = match ir_schema_errors(value) {
        Ok(errors) => schema_diagnostics(&errors, spans),
        // The embedded schema always prepares (a test holds it to that);
        // were it not to, nothing is accepted.
        Err(why) => vec![Diagnostic::new(
            "E0104",
            format!("The IR schema could not be prepared: {why}"),
            at(spans, ""),
            None,
        )],
    };
    // When `defs` is not an object there are no definitions, and none of
    // this applies, as in TypeScript.
    let mut gates = Gates {
        language,
        spans,
        out,
    };
    gates.newer_constructs(program);
    gates.agents(program);
    let mut out = gates.out;
    let n = program.definitions().count();
    if n > DEFINITIONS {
        let facts = JsObject::new().with("limit", DEFINITIONS).with("actual", n);
        out.push(Diagnostic::new(
            "E0105",
            format!("Program has {n} definitions; the 0.1 limit is {DEFINITIONS}."),
            at(spans, "/defs"),
            Some(facts),
        ));
    }
    out
}

/// The fields an agent, a workflow and a budget gained, and the version
/// that added each: `SINCE.agentFields`, `SINCE.workflowFields` and
/// `SINCE.budgetFields` in `validate.ts`. (`SINCE.kinds` and `SINCE.ops` are
/// [`DefKind::since`] and [`ExprOp::since`].)
const AGENT_FIELDS: [(&str, Language); 2] =
    [("loop", Language::V0_2), ("progress", Language::V0_2)];
const WORKFLOW_FIELDS: [(&str, Language); 1] = [("envelope", Language::V0_4)];
const BUDGET_FIELDS: [(&str, Language); 1] = [("agents", Language::V0_4)];

/// The version that added `field` by `table`, when it is newer than `language`.
fn newer(table: &[(&str, Language)], field: &str, language: Language) -> Option<Language> {
    table
        .iter()
        .find(|(f, _)| *f == field)
        .map(|(_, since)| *since)
        .filter(|since| !language.at_least(*since))
}

/// An int, dec or money literal below zero (`negativeLiteral`). The text form
/// of such a literal is a minus sign and a positive literal, which reads back
/// as `unary neg`, so from 0.5 the IR refuses it.
fn negative_literal(v: &Map) -> bool {
    match v.get("op").and_then(ExprOp::from_value) {
        Some(ExprOp::Int) => v
            .get("value")
            .and_then(Value::as_i64)
            .is_some_and(|n| n < 0),
        Some(ExprOp::Dec) => v
            .get("value")
            .and_then(Value::as_str)
            .is_some_and(|s| s.starts_with('-')),
        Some(ExprOp::Money) => v
            .get("micros")
            .and_then(Value::as_i64)
            .is_some_and(|n| n < 0),
        _ => false,
    }
}

/// The version gates of `validateIr`, after the schema's diagnostics.
struct Gates<'a> {
    language: Language,
    spans: Option<&'a Spans>,
    out: Vec<Diagnostic>,
}

impl Gates<'_> {
    fn refuse(&mut self, message: String, path: &str, facts: JsObject) {
        self.out.push(Diagnostic::new(
            "E0104",
            message,
            at(self.spans, path),
            Some(facts),
        ));
    }

    /// `newerConstructs`: the definitions and expressions of `defs` that are
    /// newer than the program's language.
    fn newer_constructs(&mut self, program: Program<'_>) {
        let lang = self.language;
        for (name, def) in program.definitions() {
            let mut path = format!("/defs/{}", ptr_token(name));
            let kind = def.kind();
            if let Some(kind) = kind
                && !lang.at_least(kind.since())
            {
                let since = kind.since();
                let facts = JsObject::new()
                    .with("kind", kind.as_str())
                    .with("language", lang.as_str());
                let message =
                    format!("{name}: '{kind}' is a {since} definition; this program is {lang}.");
                self.refuse(message, &format!("{path}/kind"), facts);
                continue;
            }
            if kind == Some(DefKind::Workflow)
                && let Some(fields) = def.members()
            {
                for field in fields.keys() {
                    if let Some(added) = newer(&WORKFLOW_FIELDS, field, lang) {
                        let facts = JsObject::new()
                            .with("field", field)
                            .with("language", lang.as_str());
                        let message = format!(
                            "Workflow {name}: '{field}' is a {added} field; this program is {lang}."
                        );
                        self.refuse(message, &format!("{path}/{}", ptr_token(field)), facts);
                    }
                }
            }
            self.walk(def.value(), &mut path);
        }
    }

    /// Every object under a definition: an `op` newer than the language, a
    /// negative literal from 0.5, a budget field newer than the language. The
    /// path grows and shrinks as the walk goes; it is copied only into a
    /// diagnostic.
    fn walk(&mut self, v: &Value, path: &mut String) {
        let lang = self.language;
        match v {
            Value::Array(items) => {
                for (i, x) in items.iter().enumerate() {
                    let len = path.len();
                    path.push('/');
                    path.push_str(&i.to_string());
                    self.walk(x, path);
                    path.truncate(len);
                }
            }
            Value::Object(map) => {
                let op = map.get("op").and_then(ExprOp::from_value);
                if let Some(op) = op
                    && !lang.at_least(op.since())
                {
                    let since = op.since();
                    let facts = JsObject::new()
                        .with("op", op.as_str())
                        .with("language", lang.as_str());
                    let message =
                        format!("'{op}' is a {since} expression; this program is {lang}.");
                    self.refuse(message, path, facts);
                }
                if lang.at_least(Language::V0_5)
                    && let Some(op) = op
                    && negative_literal(map)
                {
                    let facts = JsObject::new()
                        .with("op", op.as_str())
                        .with("language", lang.as_str());
                    let message = format!(
                        "A negative '{op}' literal is not allowed in {lang}: from mandate/0.5 a negative literal is written as the negation of a positive one (unary neg)."
                    );
                    self.refuse(message, path, facts);
                }
                for (k, x) in map.iter() {
                    // Every budget is written under `budget`: a workflow's,
                    // an agent's, a skill's, a delegation's.
                    if k == "budget"
                        && let Value::Object(budget) = x
                    {
                        for field in budget.keys() {
                            if let Some(added) = newer(&BUDGET_FIELDS, field, lang) {
                                let facts = JsObject::new()
                                    .with("field", field)
                                    .with("language", lang.as_str());
                                let message = format!(
                                    "'{field}' is a {added} budget field; this program is {lang}."
                                );
                                let at = format!("{path}/budget/{}", ptr_token(field));
                                self.refuse(message, &at, facts);
                            }
                        }
                    }
                    let len = path.len();
                    path.push('/');
                    path.push_str(&ptr_token(k));
                    self.walk(x, path);
                    path.truncate(len);
                }
            }
            _ => {}
        }
    }

    /// The fields an agent gained, and `progress.repeats` over
    /// `progress.window`.
    fn agents(&mut self, program: Program<'_>) {
        let lang = self.language;
        for (name, def) in program.definitions() {
            let Some(agent) = def.members() else {
                continue;
            };
            if def.kind() != Some(DefKind::Agent) {
                continue;
            }
            for (field, since) in AGENT_FIELDS {
                if agent.contains_key(field) && !lang.at_least(since) {
                    let facts = JsObject::new()
                        .with("field", field)
                        .with("language", lang.as_str());
                    let message = format!(
                        "Agent {name}: '{field}' is a {since} field; this program is {lang}."
                    );
                    self.refuse(
                        message,
                        &format!("/defs/{}/{field}", ptr_token(name)),
                        facts,
                    );
                }
            }
            let progress = agent.get("progress");
            let number = |key: &str| match progress.and_then(|p| p.get(key)) {
                Some(Value::Number(n)) => Some(*n),
                _ => None,
            };
            if let (Some(window), Some(repeats)) = (number("window"), number("repeats"))
                && repeats > window
            {
                let facts = JsObject::new()
                    .with("window", window)
                    .with("repeats", repeats);
                let message = format!(
                    "Agent {name}: progress.repeats ({repeats}) cannot be more than progress.window ({window})."
                );
                self.refuse(
                    message,
                    &format!("/defs/{}/progress", ptr_token(name)),
                    facts,
                );
            }
        }
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
    let mut sorted: Vec<(usize, &SchemaError)> = relevant.iter().map(|e| (depth(e), *e)).collect();
    // Stable, as `Array.prototype.sort` is: equal depths keep Ajv's order.
    sorted.sort_by_key(|(d, _)| Reverse(*d));
    let max_depth = sorted.first().map_or(0, |(d, _)| *d);
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (d, e) in sorted {
        // Drop shallower errors that are only a consequence of a deeper one.
        if d < max_depth && has_below(&e.instance_path) {
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
        compare_utf16(
            a.at.path.as_deref().unwrap_or_default(),
            b.at.path.as_deref().unwrap_or_default(),
        )
    });
    out
}

/// What `load` gives: `LoadResult` in `check.ts`.
#[derive(Clone, Debug, PartialEq)]
pub struct Loaded {
    /// The program. From JSON ([`load_json`]): when it was read and has no
    /// error. From Mandate text (`load` in `mandate-syntax`): whenever the
    /// parser gave one, whatever the schema says.
    pub program: Option<Value>,
    /// Each value's span in the text, by JSON Pointer; empty when the reader
    /// refused the text.
    pub spans: Spans,
    /// The diagnostics. From JSON: the reader's, or else those of
    /// [`validate_ir`]. From Mandate text: the parser's, then those of
    /// [`validate_ir`].
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
