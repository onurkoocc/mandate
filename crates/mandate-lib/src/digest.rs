//! A library's digest (spec/library.md "The digest").
//!
//! ```text
//! digest = SHA256("mandate/library/0.6\n" ‖ JCS({ name, version, requires, modules: { <module name>: <program hash> } }))
//! ```
//!
//! written `sha256:<hex>`: [`mandate_ir::domain_hash`] in
//! [`HashDomain::Library`] under [`LIBRARY_HASH_VERSION`], which is exactly
//! that (the prefix is `mandate/library/0.6\n`, the text after it is RFC 8785
//! canonical JSON, the digest is 64 lower-case hex digits after `sha256:`).
//! The `version` and each range in `requires` are their one written form,
//! and `modules` maps each module's *name* (not its file) to its program
//! hash. The order of the manifest's `modules`, and whether `requires` is
//! absent or empty (the same `{}`), change nothing: a digest is a function
//! of the manifest's meaning. A range is its text as written, so `^1.0` and
//! `^1.0.0` are two digests.
//!
//! The program hashes are an input: this crate checks no module.

use std::collections::BTreeMap;
use std::fmt;

use mandate_ir::{HashDomain, JsObject, LIBRARY_HASH_VERSION, Map, Value, domain_hash};

use crate::manifest::Manifest;
use crate::name::{NameFault, check_name, module_belongs_to};
use crate::problem::problem_object;

/// A hash as the lock and the library write one: `sha256:` and 64 lower-case
/// hexadecimal digits. A library's digest, a module's program hash and a
/// revoked digest are all this.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Digest(String);

impl Digest {
    /// The digest `text` writes, when it has exactly that shape.
    #[must_use]
    pub fn parse(text: &str) -> Option<Digest> {
        let hex = text.strip_prefix("sha256:")?;
        let shaped = hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        shaped.then(|| Digest(text.to_owned()))
    }

    /// The digest as text, `sha256:<hex>`.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Whether `text` is a digest: `sha256:` and 64 lower-case hex digits.
#[must_use]
pub fn is_digest(text: &str) -> bool {
    Digest::parse(text).is_some()
}

/// What is wrong with the names and the program hashes of a library's
/// modules, which the caller read from the modules themselves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DigestProblem {
    /// There is no module: a library has at least one.
    NoModules,
    /// A module's name is not a name ([`check_name`]).
    ModuleNameMalformed {
        /// The module's name.
        module: String,
        /// Why not.
        fault: NameFault,
    },
    /// A module's name is neither the library's nor begins with it and a
    /// dot.
    ModuleOutsideLibrary {
        /// The module's name.
        module: String,
        /// The library's name.
        library: String,
    },
    /// Two modules have one name.
    DuplicateModuleName {
        /// The name.
        module: String,
    },
    /// A module's program hash is not `sha256:` and 64 lower-case hex
    /// digits.
    ModuleHashMalformed {
        /// The module's name.
        module: String,
        /// The hash as given.
        found: String,
    },
}

impl DigestProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            DigestProblem::NoModules => "no_modules",
            DigestProblem::ModuleNameMalformed { .. } => "module_name_malformed",
            DigestProblem::ModuleOutsideLibrary { .. } => "module_outside_library",
            DigestProblem::DuplicateModuleName { .. } => "duplicate_module_name",
            DigestProblem::ModuleHashMalformed { .. } => "module_hash_malformed",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let base = problem_object(self.id());
        match self {
            DigestProblem::NoModules => base,
            DigestProblem::ModuleNameMalformed { module, fault } => base
                .with("module", module.as_str())
                .with("fault", fault.id()),
            DigestProblem::ModuleOutsideLibrary { module, library } => base
                .with("module", module.as_str())
                .with("library", library.as_str()),
            DigestProblem::DuplicateModuleName { module } => base.with("module", module.as_str()),
            DigestProblem::ModuleHashMalformed { module, found } => base
                .with("module", module.as_str())
                .with("found", found.as_str()),
        }
    }
}

/// The problems with the names of a library's modules, which are what
/// E1601 is made of: a name that is not a name, one that is neither
/// `library` nor begins with it and a dot, and two modules with one name.
/// Names are compared as they are written, in case too: `acme.a` and
/// `acme.A` are two names, and the second is not a name at all.
///
/// The problems come by module name in byte order; a name has at most its
/// first fault, and a name written twice is a duplicate once.
#[must_use]
pub fn module_name_problems(library: &str, modules: &[&str]) -> Vec<DigestProblem> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for &module in modules {
        let count = counts.entry(module).or_insert(0);
        *count = count.saturating_add(1);
    }
    let mut problems = Vec::new();
    for (module, count) in counts {
        if let Err(fault) = check_name(module) {
            problems.push(DigestProblem::ModuleNameMalformed {
                module: module.to_owned(),
                fault,
            });
        } else if !module_belongs_to(module, library) {
            problems.push(DigestProblem::ModuleOutsideLibrary {
                module: module.to_owned(),
                library: library.to_owned(),
            });
        }
        if count > 1 {
            problems.push(DigestProblem::DuplicateModuleName {
                module: module.to_owned(),
            });
        }
    }
    problems
}

/// The digest of `manifest` with the program hashes of its modules, which
/// are `(module name, program hash)` pairs the caller read from the modules.
///
/// # Errors
///
/// A [`DigestProblem`] for each module name that is not one of this
/// library's, each name given twice (they come first, as
/// [`module_name_problems`] gives them, by name), and each hash that is not
/// a hash (by module name); [`DigestProblem::NoModules`] alone when there
/// are none.
pub fn library_digest(
    manifest: &Manifest,
    modules: &[(&str, &str)],
) -> Result<Digest, Vec<DigestProblem>> {
    if modules.is_empty() {
        return Err(vec![DigestProblem::NoModules]);
    }
    let names: Vec<&str> = modules.iter().map(|(name, _)| *name).collect();
    let mut problems = module_name_problems(manifest.name(), &names);
    let mut hashes: Vec<(&str, &str)> = modules.to_vec();
    hashes.sort_by_key(|&(name, _)| name);
    for (module, hash) in hashes {
        if !is_digest(hash) {
            problems.push(DigestProblem::ModuleHashMalformed {
                module: module.to_owned(),
                found: hash.to_owned(),
            });
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }

    let mut requires = Map::new();
    for (name, range) in manifest.requires() {
        requires.insert(name.as_str(), range.to_string());
    }
    let mut by_module = Map::new();
    for (module, hash) in modules {
        by_module.insert(*module, *hash);
    }
    let mut hashed = Map::new();
    hashed.insert("name", manifest.name());
    hashed.insert("version", manifest.version().to_string());
    hashed.insert("requires", Value::Object(requires));
    hashed.insert("modules", Value::Object(by_module));
    let text = domain_hash(
        HashDomain::Library,
        &Value::Object(hashed),
        LIBRARY_HASH_VERSION,
    );
    // `domain_hash` writes `sha256:` and 64 lower-case hex digits; a test
    // holds it to that.
    Ok(Digest(text))
}
