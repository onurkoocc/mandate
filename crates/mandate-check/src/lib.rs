//! The checks of the Rust Mandate compiler, ported from the TypeScript
//! reference compiler, which remains the specification: the same
//! diagnostics, codes, messages and `facts`, byte for byte.
//!
//! So far it holds the front door and the stages before the static checks:
//!
//! - [`check`](mod@check): [`check()`], [`load_modules`], [`CheckOptions`],
//!   [`CheckResult`], `compiler/src/check.ts` lines 60–131. The stages after
//!   `importedMethods` are seams that give nothing yet, listed in
//!   [`UNPORTED`]: until it is empty, an `ok` from [`check()`] means no
//!   error from the stages ported so far.
//! - [`modules`]: [`link`], [`linked_program`] and [`references`],
//!   `compiler/src/modules.ts`: the definitions a program sees with its
//!   imported modules ([`Linked`], [`Modules`]).
//! - [`resolve`]: [`resolve_names`] and [`closest`] (the "did you mean" of
//!   every diagnostic that has one), `compiler/src/resolve/resolve.ts`.
//! - [`roles`]: [`role_checks`], [`role_sites`] and [`roles_named`],
//!   `compiler/src/check/roles.ts`.
//!
//! And what every later check stands on:
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
//! TypeScript gives on the inputs `scripts/caps-vectors.mjs` and
//! `scripts/front-vectors.mjs` write; the gates of `mandate-testkit` hold
//! [`check()`] to the stored results of the TypeScript's.

#![forbid(unsafe_code)]

pub mod caps;
pub mod check;
pub mod governance;
pub mod modules;
pub mod path;
pub mod posix;
pub mod resolve;
pub mod roles;
pub mod stdlib;

pub use check::{
    CheckOptions, CheckResult, LoadedModules, ModuleProblem, ModuleSource, UNPORTED, check,
    load_modules,
};
pub use modules::{Linked, Modules, link, linked_program, references};
pub use resolve::{
    BUILTIN_FUNCTIONS, BUILTIN_TYPES, BUILTIN_TYPES_0_4, SUPERVISION_STRATEGIES, closest,
    resolve_names,
};
pub use roles::{RoleSite, RoleValue, role_checks, role_sites, roles_named};

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
