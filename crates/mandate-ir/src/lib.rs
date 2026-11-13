//! Reads, canonicalises and hashes Mandate IR exactly as the TypeScript
//! reference compiler does, and holds what every ported phase of that
//! compiler shares.
//!
//! A program's hash is an identity that approvals and the runtime bind to, so
//! a second implementation must give the same bytes and the same hashes. This
//! crate ports the TypeScript modules those depend on, which remain the
//! specification:
//!
//! - [`parse`] and [`parse_bytes`]: the strict JSON reader,
//!   `compiler/src/json/strict-json.ts`, with its limits ([`limits`]).
//! - [`canonicalize`]: RFC 8785 canonical text, `compiler/src/json/jcs.ts`.
//! - [`domain_hash`], [`hash_program`] and [`package_hash`]:
//!   `compiler/src/hash.ts`.
//! - [`Diagnostic`], [`Location`], [`Repair`], [`ptr`], [`has_errors`] and
//!   [`format_diagnostic`]: `compiler/src/diag.ts`.
//!
//! And the ECMAScript behaviour the compiler's output depends on, so that no
//! phase reinvents it: objects that keep their members in ECMAScript order
//! ([`Map`], [`JsObject`]); the output value [`JsValue`] with `undefined`, and
//! `JSON.stringify` with and without indentation ([`stringify`],
//! [`stringify_pretty`]); `Number::toString` ([`number_to_string`]); and the
//! string operations that count UTF-16 code units or use ECMAScript white
//! space ([`utf16_len`], [`compare_utf16`], [`sort_utf16`], [`trim`]).
//!
//! The crate reads no file, environment variable or clock and starts no
//! process (a test in `mandate-testkit` holds it to that), and it builds for
//! `wasm32-wasip1`. The vectors in the repository's `vectors/` directory are
//! written by the TypeScript implementation and read by this crate's tests.
//!
//! ```
//! let parsed = mandate_ir::parse(r#"{"b": 1, "a": "é"}"#).map_err(|d| d[0].message.clone())?;
//! assert_eq!(mandate_ir::canonicalize(&parsed.value), "{\"a\":\"é\",\"b\":1}");
//!
//! let refused = mandate_ir::parse(r#"{"a": 1, "a": 2}"#).unwrap_err();
//! assert_eq!(refused[0].code, "MDT-E0102");
//! assert_eq!(refused[0].at.path.as_deref(), Some("/a"));
//! # Ok::<(), String>(())
//! ```

#![forbid(unsafe_code)]

mod diag;
mod hash;
mod jcs;
mod js_value;
pub mod limits;
mod members;
mod number;
mod reader;
mod text;
mod value;

pub use diag::{
    Diagnostic, Location, PtrToken, Repair, RepairOp, RepairOpKind, Risk, Severity, Span,
    format_diagnostic, has_errors, ptr, ptr_token,
};
pub use hash::{
    HashDomain, ProgramHashes, RUNTIME_HASH_VERSION, domain_hash, hash_program, package_hash,
};
pub use jcs::{canonicalize, compare_utf16, write_json_string};
pub use js_value::{JsObject, JsValue, stringify, stringify_pretty};
pub use number::{is_integer, is_safe_integer, number_to_string, write_number};
pub use reader::{Parsed, parse, parse_bytes};
pub use text::{
    is_js_whitespace, sort_utf16, trim, trim_end, trim_start, unique_in_order, utf16_len,
};
pub use value::{Int, Map, Value};
