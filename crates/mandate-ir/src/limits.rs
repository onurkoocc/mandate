//! The reference-profile resource limits (Doc 4 §3.4), the same in every
//! language version from 0.1 to 0.5: `LIMITS` in `compiler/src/limits.ts`.
//! They bound what the checker accepts; they are not scale claims.

/// The largest input the reader accepts, in bytes of UTF-8 (1 MiB). Over it
/// is E0105.
pub const SOURCE_BYTES: usize = 1024 * 1024;

/// The deepest nesting the reader accepts. The top-level value is at depth 1
/// and each array element or object member one deeper, scalars included: a
/// number inside 64 nested arrays is at depth 65, which is E0105.
pub const JSON_DEPTH: usize = 64;

/// The most top-level definitions one program may have; more is E0105.
pub const DEFINITIONS: usize = 64;

/// The most nodes the static checks expand a program to (0.1 step 2).
pub const EXPANDED_NODES: usize = 1000;
