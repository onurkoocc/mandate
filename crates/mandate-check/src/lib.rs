//! The checks of the Rust Mandate compiler, ported from the TypeScript
//! reference compiler, which remains the specification: the same
//! diagnostics, codes, messages and `facts`, byte for byte.
//!
//! So far it holds what every later check stands on:
//!
//! - [`caps`]: what a capability expression means and the relations between
//!   capabilities, `compiler/src/check/caps.ts` ([`caps_of`],
//!   [`caps_from_call`], [`cap_from_call`], [`read_methods`],
//!   [`imported_methods`], [`callee_path`]; [`within`], [`cap_covers`],
//!   [`cap_authorizes`], [`writes_overlap`], [`show_cap`] and the rest).
//! - [`stdlib`]: the standard library's tables, `compiler/src/std/std.ts`
//!   (the data classes, the built-in effects, the capability constructors,
//!   the std effects and functions, the constants), in the TypeScript's
//!   order.
//! - [`governance`]: governance-class files, `compiler/src/std/governance.ts`
//!   ([`pattern_problem`], [`glob_reg_exp`], [`governance_kind`],
//!   [`governance_files`]).
//! - [`path`]: the `Path` type, `compiler/src/path.ts` ([`PATH_PATTERN`],
//!   [`path_problem`], [`is_path`]).
//! - [`posix`]: the two functions of Node's `node:path` `posix` that
//!   `caps.ts` uses, `normalize` and `isAbsolute`.
//!
//! The JavaScript semantics they depend on are imitated where they occur and
//! said so there: sorting without a comparator by UTF-16 code units, `Set`
//! and `Map` in insertion order, the truthiness of an empty string, the
//! member order of objects built by literals and spreads ([`CapVal`]), and
//! regular expressions matched by hand (no regular expression engine).
//!
//! Like `mandate-ir`, the crate reads no file, environment variable or clock
//! and starts no process (a test in `mandate-testkit` holds it to that), and
//! it builds for `wasm32-wasip1`. Its tests compare it with what the
//! TypeScript gives on the inputs `scripts/caps-vectors.mjs` writes.

#![forbid(unsafe_code)]

pub mod caps;
pub mod governance;
pub mod path;
pub mod posix;
pub mod stdlib;

pub use caps::{
    CapMember, CapOptions, CapResult, CapVal, HTTP_METHODS, MethodProblem, MethodProblemKind,
    Methods, Table, callee_path, cap_authorizes, cap_covers, cap_from_call, caps_from_call,
    caps_of, caps_of_within, imported_methods, paths_overlap, prefixes_within, read_methods,
    reads_methods, scope_within, segments, show_cap, within, writes_overlap,
};
pub use governance::{
    GOVERNANCE_FILES, GOVERNANCE_KINDS, GlobRegExp, GovernanceFile, GovernanceKind, glob_reg_exp,
    governance_files, governance_kind, pattern_problem,
};
pub use path::{PATH_PATTERN, is_path, path_problem};
pub use stdlib::{
    BUILTIN_EFFECTS, CAP_CTORS, CapCtor, DATA_CLASSES, DECISION_POLICIES, DEFAULT_MODEL_MAX_CLASS,
    DataClass, MAX_CHOICE_OPTIONS, MAX_RESTARTS, OUT_OF_SCOPE_OPTIONS, PROTECTED_TYPES,
    STD_EFFECTS, STD_FNS, ScopeKind, StdEffect, StdFn, StdType, UNGATED_EFFECTS, UNKNOWN, cap_ctor,
    class_rank, is_builtin_effect, is_decision_policy, is_out_of_scope_option, is_protected_type,
    is_ungated_effect, std_effect, std_fn,
};
