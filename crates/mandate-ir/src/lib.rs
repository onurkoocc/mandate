//! Reads, canonicalises and hashes Mandate IR exactly as the TypeScript
//! reference compiler does.
//!
//! A program's hash is an identity that approvals and the runtime bind to, so
//! a second implementation must give the same bytes and the same hashes. This
//! crate ports the three TypeScript modules those depend on, which remain the
//! specification:
//!
//! - [`parse`] and [`parse_bytes`]: the strict JSON reader,
//!   `compiler/src/json/strict-json.ts`, with its limits ([`limits`]) and its
//!   diagnostics ([`Diagnostic`]: code, message, JSON Pointer, span in UTF-16
//!   columns).
//! - [`canonicalize`]: RFC 8785 canonical text, `compiler/src/json/jcs.ts`.
//! - [`domain_hash`], [`hash_program`] and [`package_hash`]:
//!   `compiler/src/hash.ts`.
//!
//! [`number_to_string`] is ECMAScript's `Number::toString`, which the
//! compiler's output and the runtime's canonical form write numbers with.
//!
//! The vectors in the repository's `vectors/` directory are written by the
//! TypeScript implementation and read by this crate's tests.
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

pub use diag::{Diagnostic, Location, Severity, Span, ptr_token};
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
