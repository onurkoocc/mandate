//! Domain-separated SHA-256 hashes over canonical text (Doc 4 §3.4): a port
//! of `compiler/src/hash.ts`.
//!
//! ```text
//! H = "sha256:" || hex(SHA256("mandate/<domain>/<version>\n" || JCS(value)))
//! ```
//!
//! A program and its definitions are hashed under the program's language
//! version, so two versions never read the same bytes with different meaning.
//! The runtime's own domains use [`RUNTIME_HASH_VERSION`]. Hashes are
//! identities, not authentication.

use std::fmt::Write as _;

use sha2::{Digest, Sha256};

use crate::jcs::{canonicalize, compare_utf16};
use crate::value::{Map, Value};

/// The version the runtime's domains are hashed under, and a program's when
/// it names none: the 0.1 hash profile.
pub const RUNTIME_HASH_VERSION: &str = "0.1";

/// What a hash identifies: `HashDomain` in `hash.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HashDomain {
    /// A whole program.
    Program,
    /// One top-level definition.
    Def,
    /// A program with the lock it is packaged with.
    Package,
    /// A run.
    Run,
    /// An action of a run.
    Action,
    /// An operation.
    Operation,
    /// A request.
    Request,
    /// A binding.
    Binding,
    /// A decision.
    Decision,
}

impl HashDomain {
    /// The domain's name in the hash prefix, such as `program`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            HashDomain::Program => "program",
            HashDomain::Def => "def",
            HashDomain::Package => "package",
            HashDomain::Run => "run",
            HashDomain::Action => "action",
            HashDomain::Operation => "operation",
            HashDomain::Request => "request",
            HashDomain::Binding => "binding",
            HashDomain::Decision => "decision",
        }
    }

    /// The domain named `name`, such as `program`.
    #[must_use]
    pub fn from_name(name: &str) -> Option<HashDomain> {
        [
            HashDomain::Program,
            HashDomain::Def,
            HashDomain::Package,
            HashDomain::Run,
            HashDomain::Action,
            HashDomain::Operation,
            HashDomain::Request,
            HashDomain::Binding,
            HashDomain::Decision,
        ]
        .into_iter()
        .find(|d| d.as_str() == name)
    }
}

/// `sha256:<hex>` of the domain prefix and the canonical text of `value`:
/// `domainHash(domain, value, version)` in `hash.ts`.
#[must_use]
pub fn domain_hash(domain: HashDomain, value: &Value, version: &str) -> String {
    let mut h = Sha256::new();
    h.update(format!("mandate/{}/{version}\n", domain.as_str()).as_bytes());
    h.update(canonicalize(value).as_bytes());
    let digest = h.finalize();
    let mut out = String::with_capacity(71);
    out.push_str("sha256:");
    for byte in digest.iter() {
        // Writing to a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// A program's hash and one hash per definition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgramHashes {
    /// The hash of the whole program.
    pub program: String,
    /// Each definition's hash, by name, in UTF-16 order of the names.
    pub defs: Vec<(String, String)>,
}

/// The hashes of a program: `hashProgram` in `hash.ts`.
///
/// The version is what follows `mandate/` in the program's `language` field,
/// or [`RUNTIME_HASH_VERSION`] when there is no such field. Definitions are the
/// members of its `defs` object; a program without one has none.
#[must_use]
pub fn hash_program(program: &Value) -> ProgramHashes {
    let version = program
        .get("language")
        .and_then(Value::as_str)
        .and_then(|lang| lang.strip_prefix("mandate/"))
        .unwrap_or(RUNTIME_HASH_VERSION);
    let mut defs: Vec<(String, String)> = Vec::new();
    if let Some(Value::Object(d)) = program.get("defs") {
        let mut members: Vec<(&str, &Value)> = d.iter().collect();
        members.sort_by(|a, b| compare_utf16(a.0, b.0));
        for (name, def) in members {
            defs.push((name.to_owned(), domain_hash(HashDomain::Def, def, version)));
        }
    }
    ProgramHashes {
        program: domain_hash(HashDomain::Program, program, version),
        defs,
    }
}

/// A package's hash: the program's hash and the lock it is packaged with,
/// `{ "program": <hash>, "lock": <lock> }` in the package domain under
/// [`RUNTIME_HASH_VERSION`] (`packageHash` in `hash.ts`). `lock` is the lock
/// as a package carries it: without its `lock` format field (`packagedLock` in
/// `lock.ts`).
#[must_use]
pub fn package_hash(program_hash: &str, lock: &Value) -> String {
    let mut package = Map::new();
    package.insert("program", program_hash);
    package.insert("lock", lock.clone());
    domain_hash(
        HashDomain::Package,
        &Value::Object(package),
        RUNTIME_HASH_VERSION,
    )
}
