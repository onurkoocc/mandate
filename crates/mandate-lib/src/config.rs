//! What the operator's directory and configuration say: a version's
//! `index.json` (its publication time) and the `libraries` member of the
//! runtime's configuration (the directory, the waiting period, the revoked
//! digests). Spec/library.md "The local directory".
//!
//! Both are the operator's, so both are read strictly: an unknown member is
//! refused, not ignored, because `wait_day` read as nothing would be a
//! waiting period of 0.

use std::collections::BTreeSet;

use mandate_ir::{Int, JsObject, JsValue, Value};

use crate::digest::Digest;
use crate::problem::{
    ShapeProblem, child, closed_object, element, json_type, problem_object, read_json,
    read_json_bytes, string_member,
};
use crate::time::{TimeFault, Timestamp, WAIT_DAYS_MAX, WaitDays};

/// The longest `libraries.dir`, in bytes: 4096.
pub const DIR_MAX_BYTES: usize = 4096;

/// A fault of `index.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IndexProblem {
    /// The text is not an object of exactly `published_at`: see
    /// [`ShapeProblem`].
    Shape(ShapeProblem),
    /// `published_at` is not a time (`YYYY-MM-DDTHH:MM:SSZ`).
    InvalidPublishedAt {
        /// What it is.
        found: String,
        /// Why not.
        fault: TimeFault,
    },
}

impl IndexProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            IndexProblem::Shape(shape) => shape.id(),
            IndexProblem::InvalidPublishedAt { .. } => "invalid_published_at",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        match self {
            IndexProblem::Shape(shape) => shape.to_js(),
            IndexProblem::InvalidPublishedAt { found, fault } => problem_object(self.id())
                .with("found", found.as_str())
                .with("fault", fault.id()),
        }
    }
}

/// Reads the text of an `index.json`: exactly
/// `{ "published_at": "YYYY-MM-DDTHH:MM:SSZ" }`, strict JSON.
///
/// # Errors
///
/// Every [`IndexProblem`] the text has; when it is not strict JSON, that
/// alone.
pub fn read_index(text: &str) -> Result<Timestamp, Vec<IndexProblem>> {
    match read_json(text) {
        Ok(value) => read_index_value(&value),
        Err(shape) => Err(vec![IndexProblem::Shape(shape)]),
    }
}

/// As [`read_index`], for the bytes of the file, which must be UTF-8.
///
/// # Errors
///
/// As [`read_index`].
pub fn read_index_bytes(bytes: &[u8]) -> Result<Timestamp, Vec<IndexProblem>> {
    match read_json_bytes(bytes) {
        Ok(value) => read_index_value(&value),
        Err(shape) => Err(vec![IndexProblem::Shape(shape)]),
    }
}

/// As [`read_index`], for a value that was read already.
///
/// # Errors
///
/// As [`read_index`].
pub fn read_index_value(value: &Value) -> Result<Timestamp, Vec<IndexProblem>> {
    let mut shape = Vec::new();
    let Some(map) = closed_object(value, "", &["published_at"], &["published_at"], &mut shape)
    else {
        return Err(shape.into_iter().map(IndexProblem::Shape).collect());
    };
    let text = string_member(map, "", "published_at", &mut shape);
    let mut problems: Vec<IndexProblem> = shape.into_iter().map(IndexProblem::Shape).collect();
    let Some(text) = text else {
        return Err(problems);
    };
    match Timestamp::parse(text) {
        Ok(time) if problems.is_empty() => Ok(time),
        Ok(_) => Err(problems),
        Err(fault) => {
            problems.push(IndexProblem::InvalidPublishedAt {
                found: text.to_owned(),
                fault,
            });
            Err(problems)
        }
    }
}

/// The `libraries` member of the runtime's configuration, read: where the
/// libraries are, how long a version waits, which digests are revoked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LibrariesConfig {
    dir: String,
    wait_days: WaitDays,
    revoked: BTreeSet<Digest>,
}

impl LibrariesConfig {
    /// The directory, as written: relative to the configuration, which is
    /// for the caller to resolve. This crate does not interpret it.
    #[must_use]
    pub fn dir(&self) -> &str {
        &self.dir
    }

    /// Days a published version waits before `add` or `upgrade` resolves it
    /// (0 when the member is absent).
    #[must_use]
    pub const fn wait_days(&self) -> WaitDays {
        self.wait_days
    }

    /// The revoked digests, in byte order, each once.
    #[must_use]
    pub const fn revoked(&self) -> &BTreeSet<Digest> {
        &self.revoked
    }

    /// Whether `digest` is revoked.
    #[must_use]
    pub fn is_revoked(&self, digest: &Digest) -> bool {
        self.revoked.contains(digest)
    }

    /// The configuration as JSON: `{ dir, wait_days, revoked }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new()
            .with("dir", self.dir.as_str())
            .with("wait_days", self.wait_days.get())
            .with(
                "revoked",
                JsValue::Array(
                    self.revoked
                        .iter()
                        .map(|d| JsValue::from(d.as_str()))
                        .collect(),
                ),
            )
    }
}

/// A fault of the configuration's `libraries` member. Each `at` is a JSON
/// Pointer relative to that member.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfigProblem {
    /// The member is not an object of `dir`, `wait_days` and `revoked`
    /// alone, with the right types: see [`ShapeProblem`].
    Shape(ShapeProblem),
    /// `dir` is empty.
    EmptyDir,
    /// `dir` is over [`DIR_MAX_BYTES`].
    DirTooLong {
        /// Its length in bytes.
        length: usize,
        /// [`DIR_MAX_BYTES`].
        limit: usize,
    },
    /// `dir` has a NUL, which no path has.
    DirHasNul,
    /// `wait_days` is negative or over [`WAIT_DAYS_MAX`].
    WaitDaysOutOfRange {
        /// What it is.
        found: i64,
        /// [`WAIT_DAYS_MAX`].
        max: u32,
    },
    /// An entry of `revoked` is not a digest (`sha256:` and 64 lower-case
    /// hex digits).
    InvalidRevoked {
        /// The entry's position.
        index: usize,
        /// The entry.
        found: String,
    },
}

impl ConfigProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            ConfigProblem::Shape(shape) => shape.id(),
            ConfigProblem::EmptyDir => "empty_dir",
            ConfigProblem::DirTooLong { .. } => "dir_too_long",
            ConfigProblem::DirHasNul => "dir_has_nul",
            ConfigProblem::WaitDaysOutOfRange { .. } => "wait_days_out_of_range",
            ConfigProblem::InvalidRevoked { .. } => "invalid_revoked",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let base = problem_object(self.id());
        match self {
            ConfigProblem::Shape(shape) => shape.to_js(),
            ConfigProblem::EmptyDir | ConfigProblem::DirHasNul => base,
            ConfigProblem::DirTooLong { length, limit } => {
                base.with("length", *length).with("limit", *limit)
            }
            ConfigProblem::WaitDaysOutOfRange { found, max } => base
                .with("found", JsValue::from(Int::saturating(*found)))
                .with("max", *max),
            ConfigProblem::InvalidRevoked { index, found } => {
                base.with("index", *index).with("found", found.as_str())
            }
        }
    }
}

/// Reads the `libraries` member of the runtime's configuration:
/// `{ "dir": …, "wait_days": …, "revoked": […] }`. `dir` is required, a
/// non-empty string without NUL, which is not interpreted; `wait_days` is an
/// integer from 0 to [`WAIT_DAYS_MAX`], and 0 when absent; `revoked` is a
/// list of digests, empty when absent, and a digest written twice is one.
///
/// # Errors
///
/// Every [`ConfigProblem`] the value has, in a fixed order: shape, then
/// `dir`, `wait_days`, `revoked`.
pub fn read_libraries_config(value: &Value) -> Result<LibrariesConfig, Vec<ConfigProblem>> {
    let mut shape = Vec::new();
    let Some(map) = closed_object(
        value,
        "",
        &["dir", "wait_days", "revoked"],
        &["dir"],
        &mut shape,
    ) else {
        return Err(shape.into_iter().map(ConfigProblem::Shape).collect());
    };
    let mut problems: Vec<ConfigProblem> = Vec::new();

    let mut dir = None;
    if let Some(text) = string_member(map, "", "dir", &mut shape) {
        if text.is_empty() {
            problems.push(ConfigProblem::EmptyDir);
        } else if text.len() > DIR_MAX_BYTES {
            problems.push(ConfigProblem::DirTooLong {
                length: text.len(),
                limit: DIR_MAX_BYTES,
            });
        } else if text.contains('\0') {
            problems.push(ConfigProblem::DirHasNul);
        } else {
            dir = Some(text.to_owned());
        }
    }

    let mut wait_days = WaitDays::default();
    if let Some(days) = map.get("wait_days") {
        match days.as_i64() {
            None => shape.push(ShapeProblem::WrongType {
                at: child("", "wait_days"),
                expected: "number",
                found: json_type(days),
            }),
            Some(n) => match u32::try_from(n).ok().and_then(WaitDays::new) {
                Some(w) => wait_days = w,
                None => problems.push(ConfigProblem::WaitDaysOutOfRange {
                    found: n,
                    max: WAIT_DAYS_MAX,
                }),
            },
        }
    }

    let mut revoked = BTreeSet::new();
    if let Some(list) = map.get("revoked") {
        match list.as_array() {
            None => shape.push(ShapeProblem::WrongType {
                at: child("", "revoked"),
                expected: "array",
                found: json_type(list),
            }),
            Some(entries) => {
                for (index, entry) in entries.iter().enumerate() {
                    match entry.as_str() {
                        None => shape.push(ShapeProblem::WrongType {
                            at: element(&child("", "revoked"), index),
                            expected: "string",
                            found: json_type(entry),
                        }),
                        Some(text) => match Digest::parse(text) {
                            Some(digest) => {
                                revoked.insert(digest);
                            }
                            None => problems.push(ConfigProblem::InvalidRevoked {
                                index,
                                found: text.to_owned(),
                            }),
                        },
                    }
                }
            }
        }
    }

    let mut all: Vec<ConfigProblem> = shape.into_iter().map(ConfigProblem::Shape).collect();
    all.append(&mut problems);
    match dir {
        Some(dir) if all.is_empty() => Ok(LibrariesConfig {
            dir,
            wait_days,
            revoked,
        }),
        _ => Err(all),
    }
}
