//! The manifest of a library, `mandate.library.json` (spec/library.md "The
//! manifest").
//!
//! ```json
//! {
//!   "library": "mandate/library/0.6",
//!   "name": "acme.connectors",
//!   "version": "2.3.0",
//!   "modules": ["connectors.mdt", "types.mdt"],
//!   "requires": { "std.patterns": "^1.0" }
//! }
//! ```
//!
//! [`read_manifest`] reads its text as strict JSON ([`mandate_ir::parse`]: a
//! duplicate key at any depth, text after the object, a byte order mark, a
//! number that is not a safe integer, nesting over 64 and text over 1 MiB are
//! refused) and holds the object to the table of the specification: it is
//! one object, with the members `library`, `name`, `version`, `modules` and
//! `requires` and no other. `library`, `name`, `version` and `modules` are
//! required; **`requires` may be absent, and is then empty** (a library that
//! requires nothing need not say so, and its digest is the same either way).
//!
//! It collects every problem of the manifest, in a fixed order: first the
//! problems of shape ([`ShapeProblem`]: unknown members by name, missing
//! ones in the order above, a member or an entry of the wrong JSON type, as
//! they are found), then the others by member: `library`, `name`, `version`,
//! `modules` (by entry, then the collisions between entries) and `requires`
//! (by library name).

use std::collections::BTreeMap;

use mandate_ir::{JsObject, Map, Value};

use crate::name::{NameFault, PathFault, check_module_path, check_name};
use crate::problem::{
    ShapeProblem, child, closed_object, element, json_type, problem_object, read_json,
    read_json_bytes, string_member, strings_js,
};
use crate::version::{Range, Version, VersionFault};

/// The value of a manifest's `library` member: the format it is in.
pub const LIBRARY_FORMAT: &str = "mandate/library/0.6";

/// The most modules a manifest may list: 1024.
pub const MODULES_MAX: usize = 1024;

/// The most libraries a manifest may require: 1024.
pub const REQUIRES_MAX: usize = 1024;

/// A library's manifest, read and checked. It cannot be made any other way,
/// so every manifest in hand has a valid name, version, module paths (no two
/// of which are one file) and requirements.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    name: String,
    version: Version,
    modules: Vec<String>,
    requires: BTreeMap<String, Range>,
}

impl Manifest {
    /// The library's name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The library's version.
    #[must_use]
    pub const fn version(&self) -> &Version {
        &self.version
    }

    /// The module files, as the manifest lists them (in its order), each a
    /// safe relative path ([`check_module_path`]).
    #[must_use]
    pub fn modules(&self) -> &[String] {
        &self.modules
    }

    /// The libraries it requires, by name, each with its range.
    #[must_use]
    pub const fn requires(&self) -> &BTreeMap<String, Range> {
        &self.requires
    }

    /// The manifest as JSON: `{ name, version, modules, requires }`, the
    /// modules in the manifest's order and `requires` by name.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let requires: JsObject = self
            .requires
            .iter()
            .map(|(name, range)| (name.as_str(), range.to_string()))
            .collect();
        JsObject::new()
            .with("name", self.name.as_str())
            .with("version", self.version.to_string())
            .with(
                "modules",
                strings_js(self.modules.iter().map(String::as_str)),
            )
            .with("requires", requires)
    }
}

/// A fault of a manifest. [`read_manifest`] gives them all, in a fixed order.
///
/// Where a problem has `index`, it is the position of a module in `modules`
/// (from 0).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManifestProblem {
    /// The text is not an object of the manifest's members: see
    /// [`ShapeProblem`].
    Shape(ShapeProblem),
    /// `library` is not `mandate/library/0.6`.
    UnknownFormat {
        /// What it is.
        found: String,
    },
    /// `name` is not a library's name.
    InvalidName {
        /// What it is.
        found: String,
        /// Why not.
        fault: NameFault,
    },
    /// `version` is not a version.
    InvalidVersion {
        /// What it is.
        found: String,
        /// Why not.
        fault: VersionFault,
    },
    /// `modules` is empty.
    NoModules,
    /// `modules` has more than [`MODULES_MAX`] entries (and none of them is
    /// looked at).
    TooManyModules {
        /// How many it has.
        count: usize,
        /// [`MODULES_MAX`].
        limit: usize,
    },
    /// An entry of `modules` is not a safe relative path of a module file.
    InvalidModulePath {
        /// The entry's position.
        index: usize,
        /// The entry.
        path: String,
        /// Why not.
        fault: PathFault,
    },
    /// An entry of `modules` is an earlier entry again.
    DuplicateModulePath {
        /// The later entry's position.
        index: usize,
        /// The entry.
        path: String,
        /// The earlier entry's position.
        first: usize,
    },
    /// An entry of `modules` differs from an earlier one only in the case of
    /// letters, so a file system that does not tell them apart has one file
    /// for both.
    CaseDuplicateModulePath {
        /// The later entry's position.
        index: usize,
        /// The entry.
        path: String,
        /// The earlier entry's position.
        first: usize,
        /// The earlier entry.
        first_path: String,
    },
    /// An entry of `modules` is a file and also a directory that another
    /// entry is under (`a.mdt` and `a.mdt/b.mdt`), which no file system can
    /// hold. Case is not told apart.
    ModulePathConflict {
        /// The position of the entry that is the file.
        index: usize,
        /// The entry that is the file.
        path: String,
        /// The position of the entry under it.
        inside_index: usize,
        /// The entry under it.
        inside_path: String,
    },
    /// `requires` has more than [`REQUIRES_MAX`] members (and none of them
    /// is looked at).
    TooManyRequirements {
        /// How many it has.
        count: usize,
        /// [`REQUIRES_MAX`].
        limit: usize,
    },
    /// A member of `requires` is named by something that is not a library's
    /// name.
    InvalidRequirementName {
        /// The name.
        name: String,
        /// Why not.
        fault: NameFault,
    },
    /// A member of `requires` has a range that is not one.
    InvalidRange {
        /// The library it is the range of.
        name: String,
        /// The range as written.
        found: String,
        /// Why not.
        fault: VersionFault,
    },
    /// The library requires itself.
    RequiresItself {
        /// Its name.
        name: String,
    },
}

impl ManifestProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            ManifestProblem::Shape(shape) => shape.id(),
            ManifestProblem::UnknownFormat { .. } => "unknown_format",
            ManifestProblem::InvalidName { .. } => "invalid_name",
            ManifestProblem::InvalidVersion { .. } => "invalid_version",
            ManifestProblem::NoModules => "no_modules",
            ManifestProblem::TooManyModules { .. } => "too_many_modules",
            ManifestProblem::InvalidModulePath { .. } => "invalid_module_path",
            ManifestProblem::DuplicateModulePath { .. } => "duplicate_module_path",
            ManifestProblem::CaseDuplicateModulePath { .. } => "case_duplicate_module_path",
            ManifestProblem::ModulePathConflict { .. } => "module_path_conflict",
            ManifestProblem::TooManyRequirements { .. } => "too_many_requirements",
            ManifestProblem::InvalidRequirementName { .. } => "invalid_requirement_name",
            ManifestProblem::InvalidRange { .. } => "invalid_range",
            ManifestProblem::RequiresItself { .. } => "requires_itself",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`, the facts in the order
    /// of the variant's fields (a [`ShapeProblem`] as it writes itself).
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let base = problem_object(self.id());
        match self {
            ManifestProblem::Shape(shape) => shape.to_js(),
            ManifestProblem::UnknownFormat { found } => base.with("found", found.as_str()),
            ManifestProblem::InvalidName { found, fault } => {
                base.with("found", found.as_str()).with("fault", fault.id())
            }
            ManifestProblem::InvalidVersion { found, fault } => {
                base.with("found", found.as_str()).with("fault", fault.id())
            }
            ManifestProblem::NoModules => base,
            ManifestProblem::TooManyModules { count, limit }
            | ManifestProblem::TooManyRequirements { count, limit } => {
                base.with("count", *count).with("limit", *limit)
            }
            ManifestProblem::InvalidModulePath { index, path, fault } => base
                .with("index", *index)
                .with("path", path.as_str())
                .with("fault", fault.id()),
            ManifestProblem::DuplicateModulePath { index, path, first } => base
                .with("index", *index)
                .with("path", path.as_str())
                .with("first", *first),
            ManifestProblem::CaseDuplicateModulePath {
                index,
                path,
                first,
                first_path,
            } => base
                .with("index", *index)
                .with("path", path.as_str())
                .with("first", *first)
                .with("first_path", first_path.as_str()),
            ManifestProblem::ModulePathConflict {
                index,
                path,
                inside_index,
                inside_path,
            } => base
                .with("index", *index)
                .with("path", path.as_str())
                .with("inside_index", *inside_index)
                .with("inside_path", inside_path.as_str()),
            ManifestProblem::InvalidRequirementName { name, fault } => {
                base.with("name", name.as_str()).with("fault", fault.id())
            }
            ManifestProblem::InvalidRange { name, found, fault } => base
                .with("name", name.as_str())
                .with("found", found.as_str())
                .with("fault", fault.id()),
            ManifestProblem::RequiresItself { name } => base.with("name", name.as_str()),
        }
    }
}

/// Reads the text of a `mandate.library.json`.
///
/// # Errors
///
/// Every [`ManifestProblem`] the text has, in a fixed order. When the text is
/// not strict JSON that is the only one.
pub fn read_manifest(text: &str) -> Result<Manifest, Vec<ManifestProblem>> {
    match read_json(text) {
        Ok(value) => read_manifest_value(&value),
        Err(shape) => Err(vec![ManifestProblem::Shape(shape)]),
    }
}

/// Reads the bytes of a `mandate.library.json`, which must be UTF-8 (a
/// reader that repaired them would let `U+FFFD` stand where a byte was
/// wrong).
///
/// # Errors
///
/// As [`read_manifest`], and [`ShapeProblem::NotUtf8`] alone for bytes that
/// are not UTF-8.
pub fn read_manifest_bytes(bytes: &[u8]) -> Result<Manifest, Vec<ManifestProblem>> {
    match read_json_bytes(bytes) {
        Ok(value) => read_manifest_value(&value),
        Err(shape) => Err(vec![ManifestProblem::Shape(shape)]),
    }
}

/// Reads a manifest that is already a JSON value (one that came out of
/// [`mandate_ir::parse`], which has no duplicate key).
///
/// # Errors
///
/// As [`read_manifest`].
pub fn read_manifest_value(value: &Value) -> Result<Manifest, Vec<ManifestProblem>> {
    let mut shape: Vec<ShapeProblem> = Vec::new();
    let mut problems: Vec<ManifestProblem> = Vec::new();
    let Some(map) = closed_object(
        value,
        "",
        &["library", "name", "version", "modules", "requires"],
        &["library", "name", "version", "modules"],
        &mut shape,
    ) else {
        return Err(shape.into_iter().map(ManifestProblem::Shape).collect());
    };

    let mut name_read = None;
    let mut version_read = None;
    let mut modules_read = Vec::new();
    let mut requires_read = BTreeMap::new();

    if let Some(format) =
        member_string(map, "library", &mut shape).filter(|format| *format != LIBRARY_FORMAT)
    {
        problems.push(ManifestProblem::UnknownFormat {
            found: format.to_owned(),
        });
    }
    if let Some(name) = member_string(map, "name", &mut shape) {
        match check_name(name) {
            Ok(()) => name_read = Some(name.to_owned()),
            Err(fault) => problems.push(ManifestProblem::InvalidName {
                found: name.to_owned(),
                fault,
            }),
        }
    }
    if let Some(version) = member_string(map, "version", &mut shape) {
        match Version::parse(version) {
            Ok(v) => version_read = Some(v),
            Err(fault) => problems.push(ManifestProblem::InvalidVersion {
                found: version.to_owned(),
                fault,
            }),
        }
    }
    if let Some(modules) = map.get("modules") {
        read_modules(modules, &mut shape, &mut problems, &mut modules_read);
    }
    if let Some(requires) = map.get("requires") {
        read_requires(
            requires,
            name_read.as_deref(),
            &mut shape,
            &mut problems,
            &mut requires_read,
        );
    }

    let mut all: Vec<ManifestProblem> = shape.into_iter().map(ManifestProblem::Shape).collect();
    all.append(&mut problems);
    match (all.is_empty(), name_read, version_read) {
        (true, Some(name), Some(version)) => Ok(Manifest {
            name,
            version,
            modules: modules_read,
            requires: requires_read,
        }),
        _ => Err(all),
    }
}

/// A string member of the manifest; one of another type is a problem.
fn member_string<'a>(map: &'a Map, key: &str, shape: &mut Vec<ShapeProblem>) -> Option<&'a str> {
    string_member(map, "", key, shape)
}

/// The entries of `modules`.
fn read_modules(
    value: &Value,
    shape: &mut Vec<ShapeProblem>,
    problems: &mut Vec<ManifestProblem>,
    out: &mut Vec<String>,
) {
    let Some(entries) = value.as_array() else {
        shape.push(ShapeProblem::WrongType {
            at: child("", "modules"),
            expected: "array",
            found: json_type(value),
        });
        return;
    };
    if entries.is_empty() {
        problems.push(ManifestProblem::NoModules);
        return;
    }
    if entries.len() > MODULES_MAX {
        problems.push(ManifestProblem::TooManyModules {
            count: entries.len(),
            limit: MODULES_MAX,
        });
        return;
    }
    // The entries that are safe paths, with their positions.
    let mut valid: Vec<(usize, &str)> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        match entry.as_str() {
            None => shape.push(ShapeProblem::WrongType {
                at: element(&child("", "modules"), index),
                expected: "string",
                found: json_type(entry),
            }),
            Some(path) => match check_module_path(path) {
                Ok(()) => valid.push((index, path)),
                Err(fault) => problems.push(ManifestProblem::InvalidModulePath {
                    index,
                    path: path.to_owned(),
                    fault,
                }),
            },
        }
    }
    collisions(&valid, problems);
    out.extend(entries.iter().filter_map(Value::as_str).map(str::to_owned));
}

/// The collisions between safe paths: one listed twice, two that a file
/// system without case would make one, a file that is another's directory.
fn collisions(valid: &[(usize, &str)], problems: &mut Vec<ManifestProblem>) {
    // Each distinct path in lower case, with the first position and path
    // that wrote it.
    let mut first_of: BTreeMap<String, (usize, &str)> = BTreeMap::new();
    let mut kept: Vec<(usize, &str, String)> = Vec::new();
    for &(index, path) in valid {
        let lower = path.to_ascii_lowercase();
        match first_of.get(&lower) {
            Some(&(first, first_path)) if first_path == path => {
                problems.push(ManifestProblem::DuplicateModulePath {
                    index,
                    path: path.to_owned(),
                    first,
                });
            }
            Some(&(first, first_path)) => {
                problems.push(ManifestProblem::CaseDuplicateModulePath {
                    index,
                    path: path.to_owned(),
                    first,
                    first_path: first_path.to_owned(),
                });
            }
            None => {
                first_of.insert(lower.clone(), (index, path));
                kept.push((index, path, lower));
            }
        }
    }
    for (inside_index, inside_path, lower) in &kept {
        // Each proper directory of the path: what is before a `/`.
        for (at, _) in lower.match_indices('/') {
            let Some(directory) = lower.get(..at) else {
                continue;
            };
            if let Some(&(index, path)) = first_of.get(directory) {
                problems.push(ManifestProblem::ModulePathConflict {
                    index,
                    path: path.to_owned(),
                    inside_index: *inside_index,
                    inside_path: (*inside_path).to_owned(),
                });
            }
        }
    }
}

/// The members of `requires`, by name.
fn read_requires(
    value: &Value,
    own_name: Option<&str>,
    shape: &mut Vec<ShapeProblem>,
    problems: &mut Vec<ManifestProblem>,
    out: &mut BTreeMap<String, Range>,
) {
    let Some(map) = value.as_object() else {
        shape.push(ShapeProblem::WrongType {
            at: child("", "requires"),
            expected: "object",
            found: json_type(value),
        });
        return;
    };
    if map.len() > REQUIRES_MAX {
        problems.push(ManifestProblem::TooManyRequirements {
            count: map.len(),
            limit: REQUIRES_MAX,
        });
        return;
    }
    let mut members: Vec<(&str, &Value)> = map.iter().collect();
    members.sort_unstable_by_key(|&(name, _)| name);
    for (name, range) in members {
        let name_fault = check_name(name).err();
        if let Some(fault) = name_fault {
            problems.push(ManifestProblem::InvalidRequirementName {
                name: name.to_owned(),
                fault,
            });
        } else if own_name == Some(name) {
            problems.push(ManifestProblem::RequiresItself {
                name: name.to_owned(),
            });
        }
        let Some(text) = range.as_str() else {
            shape.push(ShapeProblem::WrongType {
                at: child(&child("", "requires"), name),
                expected: "string",
                found: json_type(range),
            });
            continue;
        };
        match Range::parse(text) {
            Ok(parsed) => {
                if name_fault.is_none() {
                    out.insert(name.to_owned(), parsed);
                }
            }
            Err(fault) => problems.push(ManifestProblem::InvalidRange {
                name: name.to_owned(),
                found: text.to_owned(),
                fault,
            }),
        }
    }
}
