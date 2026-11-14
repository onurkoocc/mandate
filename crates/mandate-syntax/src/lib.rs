//! Reads Mandate text (`.mdt`) into IR exactly as the TypeScript reference
//! compiler does: the same IR, members in the same order, the same table of
//! spans, the same diagnostics. It ports, and is specified by:
//!
//! - `compiler/src/parse/lexer.ts`, the lexer;
//! - `compiler/src/parse/parser.ts`, the parser, which lowers straight into
//!   IR and records a span for every object it builds;
//! - `compiler/src/ir/sourcemap.ts`, which turns those spans into a table of
//!   JSON Pointers ([`SourceMap`]).
//!
//! [`parse_mdt`] is `parseMdt` followed by `sourceMap` and the plain-JSON
//! copy that `load` in `compiler/src/check.ts` makes: what `load(text, "mdt")`
//! gives before the schema validation. `load` for text is [`parse_mdt`], then
//! the validation of [`ParseResult::program`] against the schema, whose
//! diagnostics come after [`ParseResult::diagnostics`].
//!
//! What a port has to copy, and the vectors that hold this crate to it, are
//! described in `vectors/README.md` ("Reading Mandate text"). In short:
//!
//! - Positions count UTF-16 code units from 1; only a line feed breaks a
//!   line. A message that quotes a character quotes one code unit; for half
//!   of a surrogate pair, where the TypeScript message holds a lone
//!   surrogate, it holds U+FFFD.
//! - The IR is built in the order the TypeScript assigns members, which is
//!   not always source order, and its objects list array-index names first,
//!   as a JavaScript object does (only `tests` has such names).
//! - The reading stops at the first error it cannot read past; the
//!   diagnostics it had gathered (`MDT-E0103`, `MDT-E0121`, `MDT-E0120`) are
//!   lost with it, as they are in TypeScript.
//! - The input is at most 1 MiB of UTF-8; text nested more than 64 deep is
//!   refused while it is read, before the parser's stack can run out, and an
//!   IR nested more than 64 deep after it is read.
//!
//! The crate reads no file, environment variable or clock: it takes text and
//! gives values. It builds for `wasm32-wasip1`.
//!
//! ```
//! let read = mandate_syntax::parse_mdt("module m @ 0.1\nlet x = 1 + 2\n");
//! let program = read.program.expect("a program");
//! assert_eq!(
//!     mandate_ir::canonicalize(program.get("defs").expect("defs")),
//!     r#"{"x":{"kind":"const","value":{"bop":"+","left":{"op":"int","value":1},"op":"binary","right":{"op":"int","value":2}}}}"#
//! );
//! let span = read.spans.get("/defs/x/value").expect("a span");
//! assert_eq!((span.start_line, span.start_col, span.end_line, span.end_col), (2, 9, 2, 14));
//! assert!(read.diagnostics.is_empty());
//!
//! let refused = mandate_syntax::parse_mdt("module m @ 0.1\nlet = 1\n");
//! assert!(refused.program.is_none());
//! assert_eq!(refused.diagnostics[0].message, "Expected a name but found '='.");
//! ```

#![forbid(unsafe_code)]

mod lexer;
mod node;
mod parser;
mod sourcemap;

use mandate_ir::{Diagnostic, Value};

pub use parser::RESERVED;
pub use sourcemap::SourceMap;

/// What [`parse_mdt`] gives: `ParseResult` in `parser.ts`, with its span
/// table already turned into a [`SourceMap`].
#[derive(Clone, Debug, PartialEq)]
pub struct ParseResult {
    /// The program's IR, when the text was read: the plain-JSON copy `load`
    /// makes, members in the order the parser assigned them. `None` when the
    /// reading stopped at an error, or the IR is nested too deep.
    pub program: Option<Value>,
    /// JSON Pointer into [`ParseResult::program`] → the span of text it came
    /// from, for every object the parser marked; empty when there is no
    /// program, as `load` gives it.
    pub spans: SourceMap,
    /// With a program: what the parser found while it read on, in order
    /// (`MDT-E0103` and `MDT-E0121` as found, then `MDT-E0120` for each
    /// handler without its workflow). Without one: the one diagnostic that
    /// stopped the reading.
    pub diagnostics: Vec<Diagnostic>,
}

/// Reads Mandate text: `parseMdt(src)`, then `sourceMap(program, spans)`,
/// as `load(text, "mdt")` does before the schema validation.
#[must_use]
pub fn parse_mdt(src: &str) -> ParseResult {
    match parser::parse_program(src) {
        Ok((program, diagnostics)) => {
            let (program, spans) = node::finish(program);
            ParseResult {
                program: Some(program),
                spans,
                diagnostics,
            }
        }
        Err(stop) => ParseResult {
            program: None,
            spans: SourceMap::new(),
            diagnostics: vec![*stop],
        },
    }
}
