//! The reference-profile resource limits the reader enforces (Doc 4 §3.4):
//! `LIMITS` in `compiler/src/limits.ts`.

/// The largest input the reader accepts, in bytes of UTF-8 (1 MiB). Over it
/// is E0105.
pub const SOURCE_BYTES: usize = 1024 * 1024;

/// The deepest nesting the reader accepts. The top-level value is at depth 1
/// and each array element or object member one deeper, scalars included: a
/// number inside 64 nested arrays is at depth 65, which is E0105.
pub const JSON_DEPTH: usize = 64;
