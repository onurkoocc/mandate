//! The front door for a program in either of its forms: `load` and `kindOf`
//! in `compiler/src/check.ts`, ported line by line.

use mandate_ir::{Loaded, Spans, load_json, validate_ir};

use crate::parse_mdt;

/// The form a program is given in: `SourceKind` in `check.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SourceKind {
    /// `"mdt"`: Mandate text.
    Mdt,
    /// `"json"`: the IR as JSON.
    Json,
}

/// `kindOf(file)`: JSON for a name that ends in `.json`, text otherwise.
#[must_use]
pub fn kind_of(file: &str) -> SourceKind {
    if file.ends_with(".json") {
        SourceKind::Json
    } else {
        SourceKind::Mdt
    }
}

/// Reads a program and validates it against the closed schema:
/// `load(text, kind)`.
///
/// The two forms differ in what comes back. From JSON
/// ([`mandate_ir::load_json`]) there is no program when the reader or the
/// validation gives an error. From text there is a program whenever the
/// parser gave one, whatever the schema says, with the parser's
/// diagnostics first and the validation's after them (`[...parsed.diagnostics,
/// ...validateIr(program, spans)]`); when the parser gave none, its
/// diagnostics and no spans. The spans of text are those of
/// [`crate::ParseResult::spans`], by pointer.
#[must_use]
pub fn load(text: &str, kind: SourceKind) -> Loaded {
    match kind {
        SourceKind::Json => load_json(text),
        SourceKind::Mdt => {
            let parsed = parse_mdt(text);
            let Some(program) = parsed.program else {
                return Loaded {
                    program: None,
                    spans: Spans::new(),
                    diagnostics: parsed.diagnostics,
                };
            };
            let spans = Spans::from(&parsed.spans);
            let mut diagnostics = parsed.diagnostics;
            diagnostics.extend(validate_ir(&program, Some(&spans)));
            Loaded {
                program: Some(program),
                spans,
                diagnostics,
            }
        }
    }
}
