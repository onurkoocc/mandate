//! The libraries a lock pins (spec/library.md "Lock 0.6"), read without
//! trusting that the schema check ran, and what is compared with them: what
//! a library's directory holds against its pin (the facts of E1605), and a
//! library's `requires` against the pins (the facts of E1606).
//!
//! ```json
//! "libraries": {
//!   "acme.connectors": { "version": "2.3.0", "digest": "sha256:…",
//!                        "modules": { "acme.connectors": "sha256:…", "acme.connectors.types": "sha256:…" } }
//! }
//! ```
//!
//! A pin is *read* as the lock schema says (`spec/lock-0.6.schema.json`):
//! exactly the members `version`, `digest` and `modules`, a version of three
//! components, digests of the one shape, at least one module, and the names
//! of the libraries and their modules. It is a little stricter than the
//! schema, as the specification is: a name is lower-case (the schema's
//! `QName` also allows upper-case), and each module of a library is named
//! with the library's name ([`module_belongs_to`]). A lock this reader
//! refuses and the schema allows pins nothing a manifest could have.

use std::collections::BTreeMap;

use mandate_ir::{JsObject, JsValue, Value};

use crate::digest::Digest;
use crate::name::{NameFault, check_name, module_belongs_to};
use crate::problem::{
    ShapeProblem, child, closed_object, json_type, object_member, problem_object, string_member,
};
use crate::version::{Range, Version, VersionFault};

/// A library as a lock pins it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockLibrary {
    version: Version,
    digest: Digest,
    modules: BTreeMap<String, Digest>,
}

impl LockLibrary {
    /// The pin of what was found: its version, its digest and its modules,
    /// as `mandate add` and `upgrade` write it into the lock.
    #[must_use]
    pub fn of_found(found: &FoundLibrary) -> LockLibrary {
        LockLibrary {
            version: found.version,
            digest: found.digest.clone(),
            modules: found.modules.clone(),
        }
    }

    /// The version the lock resolved.
    #[must_use]
    pub const fn version(&self) -> &Version {
        &self.version
    }

    /// The library's digest.
    #[must_use]
    pub const fn digest(&self) -> &Digest {
        &self.digest
    }

    /// Each module of the library by name, with its program hash.
    #[must_use]
    pub const fn modules(&self) -> &BTreeMap<String, Digest> {
        &self.modules
    }

    /// The pin as the lock writes it: `{ version, digest, modules }`, the
    /// modules by name.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let modules: JsObject = self
            .modules
            .iter()
            .map(|(name, hash)| (name.as_str(), hash.as_str()))
            .collect();
        JsObject::new()
            .with("version", self.version.to_string())
            .with("digest", self.digest.as_str())
            .with("modules", modules)
    }
}

/// A fault of the lock's `libraries` member. Each `at` is a JSON Pointer
/// relative to that member.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LockProblem {
    /// The member, an entry or its `modules` is not an object of the right
    /// members and types: see [`ShapeProblem`].
    Shape(ShapeProblem),
    /// A library is named by something that is not a library's name.
    InvalidLibraryName {
        /// The name.
        library: String,
        /// Why not.
        fault: NameFault,
    },
    /// A pin's `version` is not a version.
    InvalidVersion {
        /// The library.
        library: String,
        /// What it is.
        found: String,
        /// Why not.
        fault: VersionFault,
    },
    /// A pin's `digest` is not a digest.
    InvalidDigest {
        /// The library.
        library: String,
        /// What it is.
        found: String,
    },
    /// A pin has no module.
    NoModules {
        /// The library.
        library: String,
    },
    /// A pinned module is named by something that is not a name.
    InvalidModuleName {
        /// The library.
        library: String,
        /// The module's name.
        module: String,
        /// Why not.
        fault: NameFault,
    },
    /// A pinned module's name is neither the library's nor begins with it
    /// and a dot.
    ModuleOutsideLibrary {
        /// The library.
        library: String,
        /// The module's name.
        module: String,
    },
    /// A pinned module's program hash is not a digest.
    InvalidModuleHash {
        /// The library.
        library: String,
        /// The module's name.
        module: String,
        /// What it is.
        found: String,
    },
}

impl LockProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            LockProblem::Shape(shape) => shape.id(),
            LockProblem::InvalidLibraryName { .. } => "invalid_library_name",
            LockProblem::InvalidVersion { .. } => "invalid_version",
            LockProblem::InvalidDigest { .. } => "invalid_digest",
            LockProblem::NoModules { .. } => "no_modules",
            LockProblem::InvalidModuleName { .. } => "invalid_module_name",
            LockProblem::ModuleOutsideLibrary { .. } => "module_outside_library",
            LockProblem::InvalidModuleHash { .. } => "invalid_module_hash",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let base = problem_object(self.id());
        match self {
            LockProblem::Shape(shape) => shape.to_js(),
            LockProblem::InvalidLibraryName { library, fault } => base
                .with("library", library.as_str())
                .with("fault", fault.id()),
            LockProblem::InvalidVersion {
                library,
                found,
                fault,
            } => base
                .with("library", library.as_str())
                .with("found", found.as_str())
                .with("fault", fault.id()),
            LockProblem::InvalidDigest { library, found } => base
                .with("library", library.as_str())
                .with("found", found.as_str()),
            LockProblem::NoModules { library } => base.with("library", library.as_str()),
            LockProblem::InvalidModuleName {
                library,
                module,
                fault,
            } => base
                .with("library", library.as_str())
                .with("module", module.as_str())
                .with("fault", fault.id()),
            LockProblem::ModuleOutsideLibrary { library, module } => base
                .with("library", library.as_str())
                .with("module", module.as_str()),
            LockProblem::InvalidModuleHash {
                library,
                module,
                found,
            } => base
                .with("library", library.as_str())
                .with("module", module.as_str())
                .with("found", found.as_str()),
        }
    }
}

/// Moves what a shape check found into the problems.
fn flush(shape: &mut Vec<ShapeProblem>, problems: &mut Vec<LockProblem>) {
    problems.extend(shape.drain(..).map(LockProblem::Shape));
}

/// Reads the `libraries` member of a lock; `None`, a lock without one, pins
/// nothing. The libraries are read by name in byte order, each problem by
/// library and then by member.
///
/// # Errors
///
/// Every [`LockProblem`] the member has.
pub fn read_lock_libraries(
    libraries: Option<&Value>,
) -> Result<BTreeMap<String, LockLibrary>, Vec<LockProblem>> {
    let mut out = BTreeMap::new();
    let Some(libraries) = libraries else {
        return Ok(out);
    };
    let Some(map) = libraries.as_object() else {
        return Err(vec![LockProblem::Shape(ShapeProblem::WrongType {
            at: String::new(),
            expected: "object",
            found: json_type(libraries),
        })]);
    };
    let mut entries: Vec<(&str, &Value)> = map.iter().collect();
    entries.sort_unstable_by_key(|&(name, _)| name);
    let mut problems = Vec::new();
    for (name, entry) in entries {
        if let Some(pin) = read_pin(name, entry, &mut problems) {
            out.insert(name.to_owned(), pin);
        }
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

/// One pin; `None` when it has a problem, which is added to `problems`.
fn read_pin(name: &str, entry: &Value, problems: &mut Vec<LockProblem>) -> Option<LockLibrary> {
    let at = child("", name);
    let before = problems.len();
    let mut shape = Vec::new();
    if let Err(fault) = check_name(name) {
        problems.push(LockProblem::InvalidLibraryName {
            library: name.to_owned(),
            fault,
        });
    }
    let map = closed_object(
        entry,
        &at,
        &["version", "digest", "modules"],
        &["version", "digest", "modules"],
        &mut shape,
    );
    let Some(map) = map else {
        flush(&mut shape, problems);
        return None;
    };

    let mut version = None;
    if let Some(text) = string_member(map, &at, "version", &mut shape) {
        match Version::parse(text) {
            Ok(v) => version = Some(v),
            Err(fault) => problems.push(LockProblem::InvalidVersion {
                library: name.to_owned(),
                found: text.to_owned(),
                fault,
            }),
        }
    }
    let mut digest = None;
    if let Some(text) = string_member(map, &at, "digest", &mut shape) {
        digest = Digest::parse(text);
        if digest.is_none() {
            problems.push(LockProblem::InvalidDigest {
                library: name.to_owned(),
                found: text.to_owned(),
            });
        }
    }
    let mut modules = BTreeMap::new();
    if let Some(members) = object_member(map, &at, "modules", &mut shape) {
        if members.is_empty() {
            problems.push(LockProblem::NoModules {
                library: name.to_owned(),
            });
        }
        let mut listed: Vec<(&str, &Value)> = members.iter().collect();
        listed.sort_unstable_by_key(|&(module, _)| module);
        for (module, hash) in listed {
            read_module(name, module, hash, &at, &mut modules, problems, &mut shape);
        }
    }
    flush(&mut shape, problems);
    match (version, digest) {
        (Some(version), Some(digest)) if problems.len() == before => Some(LockLibrary {
            version,
            digest,
            modules,
        }),
        _ => None,
    }
}

/// One pinned module of the library `library`, whose pin is at `at`.
fn read_module(
    library: &str,
    module: &str,
    hash: &Value,
    at: &str,
    out: &mut BTreeMap<String, Digest>,
    problems: &mut Vec<LockProblem>,
    shape: &mut Vec<ShapeProblem>,
) {
    if let Err(fault) = check_name(module) {
        problems.push(LockProblem::InvalidModuleName {
            library: library.to_owned(),
            module: module.to_owned(),
            fault,
        });
    } else if !module_belongs_to(module, library) {
        problems.push(LockProblem::ModuleOutsideLibrary {
            library: library.to_owned(),
            module: module.to_owned(),
        });
    }
    let Some(text) = hash.as_str() else {
        shape.push(ShapeProblem::WrongType {
            at: child(&child(at, "modules"), module),
            expected: "string",
            found: json_type(hash),
        });
        return;
    };
    match Digest::parse(text) {
        Some(parsed) => {
            out.insert(module.to_owned(), parsed);
        }
        None => problems.push(LockProblem::InvalidModuleHash {
            library: library.to_owned(),
            module: module.to_owned(),
            found: text.to_owned(),
        }),
    }
}

/// What a library's directory holds, as the caller read and computed it:
/// the library to compare with its pin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FoundLibrary {
    /// The version of the directory the library was found in (and of its
    /// manifest).
    pub version: Version,
    /// The digest computed from the manifest and the modules
    /// ([`crate::library_digest`]).
    pub digest: Digest,
    /// Each module's name, with the program hash computed from its file.
    pub modules: BTreeMap<String, Digest>,
}

/// A way in which what is found does not match what the lock pins (E1605).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PinProblem {
    /// The lock pins no library of this name.
    NotPinned {
        /// The library.
        library: String,
    },
    /// The library found has another version than the pin.
    VersionDiffers {
        /// The library.
        library: String,
        /// The pin's.
        locked: Version,
        /// The one found.
        found: Version,
    },
    /// The library found has another digest than the pin.
    DigestDiffers {
        /// The library.
        library: String,
        /// The pin's.
        locked: Digest,
        /// The one found.
        found: Digest,
    },
    /// A module hashes otherwise than its pin.
    ModuleHashDiffers {
        /// The library.
        library: String,
        /// The module.
        module: String,
        /// The pin's.
        locked: Digest,
        /// The one found.
        found: Digest,
    },
    /// A module the lock lists is not found.
    ModuleMissing {
        /// The library.
        library: String,
        /// The module.
        module: String,
    },
    /// A module is found that the lock does not list.
    ModuleUnlisted {
        /// The library.
        library: String,
        /// The module.
        module: String,
    },
    /// A module is pinned by the lock's top-level `modules` and by a
    /// library.
    PinnedTwice {
        /// The module.
        module: String,
        /// The library that pins it.
        library: String,
    },
}

impl PinProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            PinProblem::NotPinned { .. } => "not_pinned",
            PinProblem::VersionDiffers { .. } => "version_differs",
            PinProblem::DigestDiffers { .. } => "digest_differs",
            PinProblem::ModuleHashDiffers { .. } => "module_hash_differs",
            PinProblem::ModuleMissing { .. } => "module_missing",
            PinProblem::ModuleUnlisted { .. } => "module_unlisted",
            PinProblem::PinnedTwice { .. } => "pinned_twice",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let base = problem_object(self.id());
        match self {
            PinProblem::NotPinned { library } => base.with("library", library.as_str()),
            PinProblem::VersionDiffers {
                library,
                locked,
                found,
            } => base
                .with("library", library.as_str())
                .with("locked", locked.to_string())
                .with("found", found.to_string()),
            PinProblem::DigestDiffers {
                library,
                locked,
                found,
            } => base
                .with("library", library.as_str())
                .with("locked", locked.as_str())
                .with("found", found.as_str()),
            PinProblem::ModuleHashDiffers {
                library,
                module,
                locked,
                found,
            } => base
                .with("library", library.as_str())
                .with("module", module.as_str())
                .with("locked", locked.as_str())
                .with("found", found.as_str()),
            PinProblem::ModuleMissing { library, module }
            | PinProblem::ModuleUnlisted { library, module } => base
                .with("library", library.as_str())
                .with("module", module.as_str()),
            PinProblem::PinnedTwice { module, library } => base
                .with("module", module.as_str())
                .with("library", library.as_str()),
        }
    }
}

/// The pin of `library`.
///
/// # Errors
///
/// [`PinProblem::NotPinned`] when the lock has none.
pub fn find_pin<'a>(
    pins: &'a BTreeMap<String, LockLibrary>,
    library: &str,
) -> Result<&'a LockLibrary, PinProblem> {
    pins.get(library).ok_or_else(|| PinProblem::NotPinned {
        library: library.to_owned(),
    })
}

/// Compares what was found of `library` with its pin: the version, then the
/// digest, then each module by name (in byte order) in the union of the two
/// lists. An empty answer is a match: the same version, the same digest and
/// the same modules with the same hashes.
#[must_use]
pub fn compare_pin(library: &str, locked: &LockLibrary, found: &FoundLibrary) -> Vec<PinProblem> {
    let mut problems = Vec::new();
    if locked.version != found.version {
        problems.push(PinProblem::VersionDiffers {
            library: library.to_owned(),
            locked: locked.version,
            found: found.version,
        });
    }
    if locked.digest != found.digest {
        problems.push(PinProblem::DigestDiffers {
            library: library.to_owned(),
            locked: locked.digest.clone(),
            found: found.digest.clone(),
        });
    }
    let mut names: Vec<&str> = locked
        .modules
        .keys()
        .chain(found.modules.keys())
        .map(String::as_str)
        .collect();
    names.sort_unstable();
    names.dedup();
    for module in names {
        match (locked.modules.get(module), found.modules.get(module)) {
            (Some(pinned), Some(seen)) if pinned != seen => {
                problems.push(PinProblem::ModuleHashDiffers {
                    library: library.to_owned(),
                    module: module.to_owned(),
                    locked: pinned.clone(),
                    found: seen.clone(),
                });
            }
            (Some(_), None) => problems.push(PinProblem::ModuleMissing {
                library: library.to_owned(),
                module: module.to_owned(),
            }),
            (None, Some(_)) => problems.push(PinProblem::ModuleUnlisted {
                library: library.to_owned(),
                module: module.to_owned(),
            }),
            _ => {}
        }
    }
    problems
}

/// The modules pinned twice: each of the lock's top-level `modules` (given
/// by name) that a library's pin lists too, by library and module name.
#[must_use]
pub fn modules_pinned_twice<'a>(
    top_level: impl IntoIterator<Item = &'a str>,
    pins: &BTreeMap<String, LockLibrary>,
) -> Vec<PinProblem> {
    let mut names: Vec<&str> = top_level.into_iter().collect();
    names.sort_unstable();
    names.dedup();
    let mut problems = Vec::new();
    for (library, pin) in pins {
        for module in &names {
            if pin.modules.contains_key(*module) {
                problems.push(PinProblem::PinnedTwice {
                    module: (*module).to_owned(),
                    library: library.clone(),
                });
            }
        }
    }
    problems
}

/// A way in which a library's `requires` is not met by the pins (E1606).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequireProblem {
    /// A library that `library` requires, which the lock does not pin.
    NotPinned {
        /// The requiring library.
        library: String,
        /// The library it requires.
        requirement: String,
        /// The range it requires.
        range: Range,
    },
    /// A library that `library` requires, which the lock pins at a version
    /// outside the range.
    OutOfRange {
        /// The requiring library.
        library: String,
        /// The library it requires.
        requirement: String,
        /// The range it requires.
        range: Range,
        /// The version the lock pins.
        pinned: Version,
    },
}

impl RequireProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            RequireProblem::NotPinned { .. } => "requirement_not_pinned",
            RequireProblem::OutOfRange { .. } => "requirement_out_of_range",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let base = problem_object(self.id());
        match self {
            RequireProblem::NotPinned {
                library,
                requirement,
                range,
            } => base
                .with("library", library.as_str())
                .with("requirement", requirement.as_str())
                .with("range", range.to_string()),
            RequireProblem::OutOfRange {
                library,
                requirement,
                range,
                pinned,
            } => base
                .with("library", library.as_str())
                .with("requirement", requirement.as_str())
                .with("range", range.to_string())
                .with("pinned", pinned.to_string()),
        }
    }
}

/// Checks the `requires` of `library` against the pins, by the name of what
/// is required (in byte order): a library the lock does not pin, and one it
/// pins at a version outside the range.
#[must_use]
pub fn check_requires(
    library: &str,
    requires: &BTreeMap<String, Range>,
    pins: &BTreeMap<String, LockLibrary>,
) -> Vec<RequireProblem> {
    let mut problems = Vec::new();
    for (requirement, range) in requires {
        match pins.get(requirement) {
            None => problems.push(RequireProblem::NotPinned {
                library: library.to_owned(),
                requirement: requirement.clone(),
                range: *range,
            }),
            Some(pin) if !range.holds(&pin.version) => {
                problems.push(RequireProblem::OutOfRange {
                    library: library.to_owned(),
                    requirement: requirement.clone(),
                    range: *range,
                    pinned: pin.version,
                });
            }
            Some(_) => {}
        }
    }
    problems
}

/// The pins as JSON: each library's name with its pin, in byte order.
#[must_use]
pub fn lock_libraries_js(pins: &BTreeMap<String, LockLibrary>) -> JsValue {
    JsValue::Object(
        pins.iter()
            .map(|(name, pin)| (name.as_str(), JsValue::Object(pin.to_js())))
            .collect(),
    )
}
