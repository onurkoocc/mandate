//! Diagnostics in the JSON shape of Doc 4 §13.1: a port of
//! `compiler/src/diag.ts`.
//!
//! The code is stable and machine-read. The message is stable text too: the
//! ported phases give the TypeScript messages character for character.
//! [`Diagnostic::to_js`] gives the object `diag()` builds, members in the
//! order `JSON.stringify` writes them, so that written with
//! [`crate::stringify`] or [`crate::stringify_pretty`] a diagnostic is the
//! TypeScript one byte for byte.

use crate::js_value::{JsObject, JsValue};
use crate::value::{Int, Value};

/// A source span: 1-based lines and columns, end exclusive. A column counts
/// UTF-16 code units, as an ECMAScript string index does, so a character
/// outside the Basic Multilingual Plane is two columns wide.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Span {
    /// The first line.
    pub start_line: usize,
    /// The first column.
    pub start_col: usize,
    /// The last line.
    pub end_line: usize,
    /// The column after the last.
    pub end_col: usize,
}

impl Span {
    fn parts(self) -> [usize; 4] {
        [self.start_line, self.start_col, self.end_line, self.end_col]
    }

    /// The span as the TypeScript side writes it: `[startLine, startCol, endLine, endCol]`.
    #[must_use]
    pub fn to_value(self) -> Value {
        Value::Array(
            self.parts()
                .into_iter()
                .map(|n| Value::Number(Int::from_usize_saturating(n)))
                .collect(),
        )
    }

    /// As [`Span::to_value`], as an output value.
    #[must_use]
    pub fn to_js(self) -> JsValue {
        JsValue::Array(self.parts().into_iter().map(JsValue::from).collect())
    }
}

/// Whether a diagnostic stops a program from checking.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Severity {
    /// The input is refused.
    Error,
    /// The input is accepted with a remark.
    Warning,
}

impl Severity {
    /// `"error"` or `"warning"`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

/// Where a diagnostic points: the `at` object of `diag.ts`.
///
/// Each call site in the TypeScript builds this object itself, so the order
/// of its members is the call site's. These occur in `compiler/src`: `{}`,
/// `{ path }`, `{ span }`, `{ path, span }` (most sites, through
/// `span ? { path, span } : { path }`) and `{ span, path }` (the JSON
/// reader's `fail`, and the parser's depth check `tooDeep`). No call site
/// sets `def`. `span_first` says which of the two orders a location has;
/// `def`, when set, is written first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Location {
    /// The definition the diagnostic belongs to, when known.
    pub def: Option<String>,
    /// An RFC 6901 JSON Pointer into the value that was read.
    pub path: Option<String>,
    /// The span in the text that was read.
    pub span: Option<Span>,
    /// Whether `span` is written before `path`.
    pub span_first: bool,
}

impl Location {
    /// `{ path }`.
    #[must_use]
    pub fn path(path: impl Into<String>) -> Location {
        Location {
            path: Some(path.into()),
            ..Location::default()
        }
    }

    /// `span ? { path, span } : { path }`, the form most call sites write.
    #[must_use]
    pub fn path_span(path: impl Into<String>, span: Option<Span>) -> Location {
        Location {
            path: Some(path.into()),
            span,
            ..Location::default()
        }
    }

    /// `{ span }`.
    #[must_use]
    pub fn span(span: Span) -> Location {
        Location {
            span: Some(span),
            ..Location::default()
        }
    }

    /// `{ span, path }`.
    #[must_use]
    pub fn span_path(span: Span, path: impl Into<String>) -> Location {
        Location {
            path: Some(path.into()),
            span: Some(span),
            span_first: true,
            ..Location::default()
        }
    }

    /// `span ? { span, path } : { path }`, as the parser's depth check
    /// (`tooDeep` in parser.ts) writes it.
    #[must_use]
    pub fn span_then_path(span: Option<Span>, path: impl Into<String>) -> Location {
        match span {
            Some(span) => Location::span_path(span, path),
            None => Location::path(path),
        }
    }

    /// `{ ...at, span }`: a span already present keeps its place; a new one
    /// comes last.
    #[must_use]
    pub fn with_span(self, span: Span) -> Location {
        let span_first = self.span_first && self.span.is_some();
        Location {
            span: Some(span),
            span_first,
            ..self
        }
    }

    /// The object, members in this location's order.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let span = self.span.map(Span::to_js);
        let out = JsObject::new().with_some("def", self.def.as_deref());
        if self.span_first {
            out.with_some("span", span)
                .with_some("path", self.path.as_deref())
        } else {
            out.with_some("path", self.path.as_deref())
                .with_some("span", span)
        }
    }
}

/// The operation of a repair patch step: `RepairOp["op"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RepairOpKind {
    /// `"add"`.
    Add,
    /// `"remove"`.
    Remove,
    /// `"replace"`.
    Replace,
}

impl RepairOpKind {
    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            RepairOpKind::Add => "add",
            RepairOpKind::Remove => "remove",
            RepairOpKind::Replace => "replace",
        }
    }
}

/// One step of a repair patch: `RepairOp`, written `{ op, path, value? }`.
#[derive(Clone, Debug, PartialEq)]
pub struct RepairOp {
    /// The operation.
    pub op: RepairOpKind,
    /// The JSON Pointer it applies at.
    pub path: String,
    /// The value it adds or puts in place; written only when present.
    pub value: Option<JsValue>,
}

/// How risky a repair is: `Repair["risk"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Risk {
    /// `"low"`.
    Low,
    /// `"medium"`.
    Medium,
    /// `"high"`.
    High,
}

impl Risk {
    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Risk::Low => "low",
            Risk::Medium => "medium",
            Risk::High => "high",
        }
    }
}

/// A repair a diagnostic proposes: `Repair`, written
/// `{ id, summary, patch, risk, requires_approval? }` (the order of every
/// call site in `compiler/src`; none sets `requires_approval`).
#[derive(Clone, Debug, PartialEq)]
pub struct Repair {
    /// Its id within the diagnostic, such as `r1`.
    pub id: String,
    /// What it does, for people.
    pub summary: String,
    /// The patch, in order.
    pub patch: Vec<RepairOp>,
    /// How risky it is.
    pub risk: Risk,
    /// Whether applying it needs a person's approval; written only when set.
    pub requires_approval: Option<bool>,
}

impl Repair {
    /// The object `diag.ts` writes.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let patch = self
            .patch
            .iter()
            .map(|op| {
                JsObject::new()
                    .with("op", op.op.as_str())
                    .with("path", op.path.as_str())
                    .with_some("value", op.value.clone())
                    .into()
            })
            .collect::<Vec<JsValue>>();
        JsObject::new()
            .with("id", self.id.as_str())
            .with("summary", self.summary.as_str())
            .with("patch", patch)
            .with("risk", self.risk.as_str())
            .with_some("requires_approval", self.requires_approval)
    }
}

/// One diagnostic.
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    /// The full code, such as `MDT-E0108`.
    pub code: String,
    /// `Warning` for a `W` code, `Error` otherwise.
    pub severity: Severity,
    /// The message for people.
    pub message: String,
    /// Where it points.
    pub at: Location,
    /// Machine-readable facts, when the diagnostic has any. An empty object
    /// is written, as in TypeScript, where `{}` is truthy.
    pub facts: Option<JsObject>,
    /// The repairs it proposes, when it has any (written even when empty).
    pub repair: Option<Vec<Repair>>,
}

impl Diagnostic {
    /// A diagnostic with code `code` (without the `MDT-` prefix, such as
    /// `E0108`), as `diag(code, message, at, { facts })` in `diag.ts` makes
    /// one; [`Diagnostic::with_repair`] adds `repair`.
    #[must_use]
    pub fn new(
        code: &str,
        message: impl Into<String>,
        at: Location,
        facts: Option<JsObject>,
    ) -> Diagnostic {
        let severity = if code.starts_with('W') {
            Severity::Warning
        } else {
            Severity::Error
        };
        Diagnostic {
            code: format!("MDT-{code}"),
            severity,
            message: message.into(),
            at,
            facts,
            repair: None,
        }
    }

    /// The diagnostic with `repair`.
    #[must_use]
    pub fn with_repair(self, repair: Vec<Repair>) -> Diagnostic {
        Diagnostic {
            repair: Some(repair),
            ..self
        }
    }

    /// The `docs` field: `mandate explain <code>`.
    #[must_use]
    pub fn docs(&self) -> String {
        format!("mandate explain {}", self.code)
    }

    /// The object `diag()` builds:
    /// `{ code, severity, message, at, docs, facts?, repair? }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let repair = self
            .repair
            .as_ref()
            .map(|r| r.iter().map(|x| x.to_js().into()).collect::<Vec<JsValue>>());
        JsObject::new()
            .with("code", self.code.as_str())
            .with("severity", self.severity.as_str())
            .with("message", self.message.as_str())
            .with("at", self.at.to_js())
            .with("docs", self.docs())
            .with_some("facts", self.facts.clone())
            .with_some("repair", repair)
            .into()
    }
}

/// Whether any of `diags` is an error: `hasErrors` in `diag.ts`.
#[must_use]
pub fn has_errors(diags: &[Diagnostic]) -> bool {
    diags.iter().any(|d| d.severity == Severity::Error)
}

/// One line for people: `formatDiagnostic(d, file)` in `diag.ts`,
/// `<file>:<line>:<col>: <severity> <code>: <message> [<path>]`, with
/// `<input>` when there is no file name.
#[must_use]
pub fn format_diagnostic(d: &Diagnostic, file: Option<&str>) -> String {
    let file = file.unwrap_or("<input>");
    let place = match d.at.span {
        Some(s) => format!("{file}:{}:{}", s.start_line, s.start_col),
        None => file.to_owned(),
    };
    let path =
        d.at.path
            .as_ref()
            .map(|p| format!(" [{p}]"))
            .unwrap_or_default();
    format!(
        "{place}: {} {}: {}{path}",
        d.severity.as_str(),
        d.code,
        d.message
    )
}

/// Escapes one JSON Pointer reference token (RFC 6901 §4): `~` as `~0`, `/` as `~1`.
#[must_use]
pub fn ptr_token(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

/// A token of a JSON Pointer: a name, or an array index (`string | number`
/// in `ptr` of `diag.ts`, whose numbers are indices).
pub trait PtrToken {
    /// The token's text before escaping: `String(token)`.
    fn token_text(&self) -> String;
}

impl PtrToken for str {
    fn token_text(&self) -> String {
        self.to_owned()
    }
}

impl PtrToken for String {
    fn token_text(&self) -> String {
        self.clone()
    }
}

impl PtrToken for usize {
    fn token_text(&self) -> String {
        self.to_string()
    }
}

impl<T: PtrToken + ?Sized> PtrToken for &T {
    fn token_text(&self) -> String {
        (**self).token_text()
    }
}

/// The JSON Pointer of these tokens, each escaped: `ptr(...tokens)` in
/// `diag.ts`; `""` for none. `ptr(&[&"uses", &3_usize, &"names"])` is
/// `/uses/3/names`.
#[must_use]
pub fn ptr(tokens: &[&dyn PtrToken]) -> String {
    let mut out = String::new();
    for t in tokens {
        out.push('/');
        out.push_str(&ptr_token(&t.token_text()));
    }
    out
}
