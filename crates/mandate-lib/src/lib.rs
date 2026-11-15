//! The model of a Mandate library: its manifest, its digest and its version
//! rules.
//!
//! A library is one or more 0.6 modules and a manifest, shared by digest,
//! pinned in the lock and resolved from one local directory the operator
//! controls (spec/library.md "Libraries"). This crate is the *pure* part of
//! that: everything about a library that can be decided from text and values
//! alone, with no program checked and no file read.
//!
//! - **Versions and ranges** ([`Version`], [`Range`]): `MAJOR.MINOR.PATCH`
//!   and `^MAJOR[.MINOR[.PATCH]]`, with `holds`.
//! - **Names** ([`check_name`], [`is_reserved_name`], [`module_belongs_to`])
//!   and **module files** ([`check_module_path`]): a library's name, and the
//!   paths a manifest may list, held to an allow-list that no file system
//!   reads as another file than the one meant.
//! - **The manifest** ([`read_manifest`], [`Manifest`]).
//! - **The digest** ([`library_digest`], [`Digest`]), over the manifest and
//!   the program hashes of its modules, which are an input.
//! - **The lock's pins** ([`read_lock_libraries`], [`LockLibrary`]), a pin
//!   compared with what was found ([`compare_pin`]: E1605's facts), and a
//!   library's `requires` against the pins ([`check_requires`]: E1606's).
//! - **Time** ([`Timestamp`], [`Day`], [`WaitDays`]), a version's
//!   `index.json` ([`read_index`]) and the configuration's `libraries`
//!   member ([`read_libraries_config`]).
//! - **Resolution** ([`resolve`]): the highest version within the range,
//!   whose waiting period is over and which is not revoked.
//! - **Publish's version rule** ([`plan_publish`], [`Above::judge`]: E1607's
//!   facts).
//!
//! # What it is held to
//!
//! Every input is untrusted: a manifest anyone wrote, a lock anyone edited,
//! a directory anyone filled. Its answers decide what is pinned and loaded,
//! so a reader refuses what it does not know (an unknown member, a form
//! with two spellings) and none of its functions panics, overflows or
//! allocates more than the size of its input calls for. The crate reads no
//! file, environment variable, process or clock (the time a waiting period
//! is compared with is an argument), and uses no map whose order is
//! unspecified: every result is typed, sorted and the same every time.
//!
//! Each reader collects *every* problem of its input in a stable order. A
//! problem is a value with a stable `snake_case` identifier (`id`) and the
//! facts a diagnostic needs, and has `to_js`, which writes it as
//! `{ "problem": <id>, ...facts }` with a fixed order of members. Turning
//! problems into the diagnostics E1601 and E1605 to E1608 is the checker's.
//!
//! # What is bounded
//!
//! | What | Bound |
//! |---|---|
//! | a version's component | [`VERSION_COMPONENT_MAX`] (999 999 999) |
//! | a name | [`NAME_MAX_BYTES`] (128) |
//! | a module file's path, and a segment of it | [`PATH_MAX_BYTES`] (200), [`PATH_SEGMENT_MAX_BYTES`] (64) |
//! | modules and requirements of a manifest | [`MODULES_MAX`], [`REQUIRES_MAX`] (1024 each) |
//! | the waiting period | [`WAIT_DAYS_MAX`] (36 500 days) |
//! | a configured directory | [`DIR_MAX_BYTES`] (4096) |
//! | a JSON text | 1 MiB, and nesting of 64 ([`mandate_ir::parse`]) |

#![forbid(unsafe_code)]

mod config;
mod digest;
mod lock;
mod manifest;
mod name;
mod problem;
mod publish;
mod resolve;
mod time;
mod version;

pub use config::{
    ConfigProblem, DIR_MAX_BYTES, IndexProblem, LibrariesConfig, read_index, read_index_bytes,
    read_index_value, read_libraries_config,
};
pub use digest::{Digest, DigestProblem, is_digest, library_digest, module_name_problems};
pub use lock::{
    FoundLibrary, LockLibrary, LockProblem, PinProblem, RequireProblem, check_requires,
    compare_pin, find_pin, lock_libraries_js, modules_pinned_twice, read_lock_libraries,
};
pub use manifest::{
    LIBRARY_FORMAT, MODULES_MAX, Manifest, ManifestProblem, REQUIRES_MAX, read_manifest,
    read_manifest_bytes, read_manifest_value,
};
pub use name::{
    NAME_MAX_BYTES, NameFault, PATH_MAX_BYTES, PATH_SEGMENT_MAX_BYTES, PathFault, RESERVED_FILES,
    check_module_path, check_name, is_device_name, is_name, is_reserved_name, module_belongs_to,
};
pub use problem::{JsonFault, ShapeProblem, json_type};
pub use publish::{Above, BaseComparison, PublishPlan, PublishProblem, plan_publish};
pub use resolve::{Candidate, PassedOver, Resolution, Resolve, ResolveProblem, Skipped, resolve};
pub use time::{Day, MAX_UNIX_SECONDS, TimeFault, Timestamp, WAIT_DAYS_MAX, WaitDays};
pub use version::{Range, VERSION_COMPONENT_MAX, Version, VersionFault};
