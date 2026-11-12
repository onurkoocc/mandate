//! Diagnostics in the JSON shape of Doc 4 §13.1: the `Diagnostic` of
//! `compiler/src/diag.ts`.
//!
//! The code is stable and machine-read. The message is stable text too: the
//! reader's messages are the TypeScript reader's, character for character.

use crate::value::{Int, Map, Value};

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
    /// The span as the TypeScript side writes it: `[startLine, startCol, endLine, endCol]`.
    #[must_use]
    pub fn to_value(self) -> Value {
        Value::Array(
            [self.start_line, self.start_col, self.end_line, self.end_col]
                .into_iter()
                .map(|n| Value::Number(Int::from_usize_saturating(n)))
                .collect(),
        )
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

/// Where a diagnostic points.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Location {
    /// The definition the diagnostic belongs to, when known.
    pub def: Option<String>,
    /// An RFC 6901 JSON Pointer into the value that was read.
    pub path: Option<String>,
    /// The span in the text that was read.
    pub span: Option<Span>,
}

/// One diagnostic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    /// The full code, such as `MDT-E0108`.
    pub code: String,
    /// `Warning` for a `W` code, `Error` otherwise.
    pub severity: Severity,
    /// The message for people.
    pub message: String,
    /// Where it points.
    pub at: Location,
    /// Machine-readable facts, when the diagnostic has any.
    pub facts: Option<Map>,
}

impl Diagnostic {
    /// A diagnostic with code `code` (without the `MDT-` prefix, such as
    /// `E0108`), as `diag()` in `diag.ts` makes one.
    #[must_use]
    pub fn new(
        code: &str,
        message: impl Into<String>,
        at: Location,
        facts: Option<Map>,
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
        }
    }

    /// The `docs` field: `mandate explain <code>`.
    #[must_use]
    pub fn docs(&self) -> String {
        format!("mandate explain {}", self.code)
    }

    /// The diagnostic in the JSON shape the TypeScript compiler writes:
    /// `{ code, severity, message, at: { def?, path?, span? }, docs, facts? }`.
    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut at = Map::new();
        if let Some(def) = &self.at.def {
            at.insert("def", def.as_str());
        }
        if let Some(path) = &self.at.path {
            at.insert("path", path.as_str());
        }
        if let Some(span) = self.at.span {
            at.insert("span", span.to_value());
        }
        let mut out = Map::new();
        out.insert("code", self.code.as_str());
        out.insert("severity", self.severity.as_str());
        out.insert("message", self.message.as_str());
        out.insert("at", at);
        out.insert("docs", self.docs());
        if let Some(facts) = &self.facts {
            out.insert("facts", facts.clone());
        }
        Value::Object(out)
    }
}

/// Escapes one JSON Pointer reference token (RFC 6901 §4): `~` as `~0`, `/` as `~1`.
#[must_use]
pub fn ptr_token(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}
