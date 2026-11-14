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
//! - [`load_json`] and [`validate_ir`]: reading a program given as JSON IR,
//!   `load(text, "json")` in `compiler/src/check.ts` and `validateIr` in
//!   `compiler/src/ir/validate.ts` (the language, the closed schema, the
//!   version gates, the number of definitions), with [`nearest_span`].
//! - [`Schema`]: a JSON Schema validator that gives Ajv's raw errors
//!   ([`SchemaError`]) in Ajv's order, for the subset of draft 2020-12 the
//!   two schemas use; [`ir_schema`] and [`lock_schema`] are
//!   `spec/ir.schema.json` and `spec/lock.schema.json`, embedded when the
//!   crate is built, and [`lock_schema_diagnostics`] is the E0140 that
//!   `validateLock` in `compiler/src/lock.ts` makes of a refused lock. Its
//!   `pattern`s are matched by hand, with no regular expression engine.
//! - The closed sets of tags the IR schema defines, as enums ([`Language`],
//!   [`DefKind`], [`ExprOp`], [`StmtOp`], [`PatternKind`], [`TierBy`],
//!   [`TypeForm`], [`VerifierForm`], [`ReadSource`], [`TemplatePart`]), each
//!   with `ALL`, `as_str` and `from_tag`; a test fails when the schema and
//!   the enums differ.
//! - Typed views of a program over its [`Value`] ([`Program`], [`Import`],
//!   [`Definition`]; expressions [`Expr`], [`Arg`], [`OnUnmet`],
//!   [`SwitchCase`], [`ChangesetMember`]; statements [`Stmt`], [`Pattern`],
//!   [`CallSpec`]; types [`TypeExpr`], [`Param`], [`Variant`]; the parts of
//!   definitions [`Skill`], [`Remote`], [`Envelope`], [`OnHandler`],
//!   [`Criterion`], [`Verifier`], [`Read`], [`Tier`], [`TestDef`]; and the
//!   kinds the capability checks read, [`CapabilityDef`], [`ComponentDef`],
//!   [`Command`], [`EnvironmentDef`]). A view is a `Copy` struct that borrows the value and
//!   has one method per member, which converts it (a tag to its enum, a list
//!   to an iterator of views); a member that is missing or of another type
//!   reads as `None` or as nothing, so a view never panics, even on a value
//!   that was not validated. Views of other constructs follow that pattern
//!   when a phase needs them.
//!
//! And the ECMAScript behaviour the compiler's output depends on, so that no
//! phase reinvents it: objects that keep their members in ECMAScript order
//! ([`Map`], [`JsObject`]); the output value [`JsValue`] with `undefined`, and
//! `JSON.stringify` with and without indentation ([`stringify`],
//! [`stringify_pretty`]); `Number::toString` ([`number_to_string`]); and the
//! string operations that count UTF-16 code units or use ECMAScript white
//! space ([`utf16_len`], [`compare_utf16`], [`sort_utf16`], [`trim`]).
//!
//! Known differences, and a trap for porters:
//!
//! - A Rust string cannot hold a lone surrogate. Where the reader's message
//!   quotes half of a surrogate pair, it holds U+FFFD: the text form of the
//!   diagnostic is what TypeScript's becomes in UTF-8, but in JSON output
//!   TypeScript writes an escape such as `\ud83d` and [`stringify`] writes
//!   U+FFFD. Such inputs are a listed exception of the acceptance gate.
//! - In TypeScript `o["__proto__"] = v` on a plain `{}` sets the prototype
//!   and adds no member (on an object made by `Object.create(null)`, as the
//!   JSON reader's are, it adds one); [`JsObject::insert`] and [`Map::insert`]
//!   always add one, so check how the TypeScript object was made. Ajv's
//!   `uniqueItems` meets this: in an array of strings two items
//!   `"__proto__"` are not found to be the same, and [`Schema`] gives that.
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

mod def_parts;
mod defs;
mod diag;
mod expr;
mod hash;
mod jcs;
mod js_value;
pub mod limits;
mod lock;
mod members;
mod number;
mod pattern;
mod program;
mod reader;
mod schema;
mod stmt;
mod tags;
mod text;
mod type_expr;
mod validate;
mod value;
mod view;

pub use def_parts::{Criterion, Envelope, OnHandler, Read, Remote, Skill, TestDef, Tier, Verifier};
pub use defs::{CapabilityDef, Command, ComponentDef, EnvironmentDef};
pub use diag::{
    Diagnostic, Location, PtrToken, Repair, RepairOp, RepairOpKind, Risk, Severity, Span,
    format_diagnostic, has_errors, ptr, ptr_token,
};
pub use expr::{Arg, ChangesetMember, Expr, OnUnmet, SwitchCase};
pub use hash::{
    HashDomain, ProgramHashes, RUNTIME_HASH_VERSION, domain_hash, hash_program, package_hash,
};
pub use jcs::{canonicalize, compare_utf16, write_json_string};
pub use js_value::{JsObject, JsValue, stringify, stringify_pretty};
pub use lock::lock_schema_diagnostics;
pub use number::{is_integer, is_safe_integer, number_to_string, write_number};
pub use program::{Definition, Import, Program};
pub use reader::{Parsed, parse, parse_bytes};
pub use schema::{
    IR_SCHEMA_TEXT, LOCK_SCHEMA_TEXT, Schema, SchemaError, SchemaOptions, ir_schema,
    ir_schema_errors, lock_schema, lock_schema_errors,
};
pub use stmt::{CallSpec, Pattern, Stmt};
pub use tags::{
    DefKind, ExprOp, Language, PatternKind, ReadSource, StmtOp, TemplatePart, TierBy, TypeForm,
    VerifierForm,
};
pub use text::{
    is_js_whitespace, sort_utf16, trim, trim_end, trim_start, unique_in_order, utf16_len,
};
pub use type_expr::{Param, TypeExpr, Variant};
pub use validate::{Loaded, Spans, load_json, nearest_span, validate_ir};
pub use value::{Int, Map, Value};
