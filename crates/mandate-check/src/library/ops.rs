//! `mandate add`, `upgrade` and `publish` as pure functions
//! (spec/library.md "`mandate add`, `upgrade` and `publish`"): each is
//! given what the caller read from the operator's directory (every version
//! of the library, with its manifest, its modules and its `index.json`),
//! the lock, the configuration's `libraries` member and the time, and gives
//! what to write; it writes nothing.
//!
//! - **What a version directory holds** ([`Published`]): its version (the
//!   directory's name), the library, and the text of its `index.json`, or
//!   none. A directory with no `index.json` was never published (publish
//!   writes it last): it is no candidate, and [`add`] and [`upgrade`] name
//!   it under `unpublished`. A directory whose manifest has another name or
//!   another version than the directory's is E1601 (`directory_mismatch`),
//!   and so is a malformed library or `index.json`; such a version is no
//!   candidate either.
//! - **[`add`]** resolves the highest version within the range whose
//!   waiting period is over and whose digest is not revoked
//!   ([`mandate_lib::resolve`]; the candidates of the built-in
//!   `std.patterns` are the copies in the compiler whose language is not
//!   newer than the program's, [`Request::language`]: 1.0.0, and for a
//!   program of 0.7 2.0.0 too), checks it with the libraries the lock pins
//!   (E1601, E1606), and gives the lock with its pin, of format 0.7 for a
//!   program of 0.7. Nothing in
//!   the range at all is E1606 (`no_version`); something in the range that
//!   is waiting or revoked is E1608, naming the version and the day it may
//!   be resolved.
//! - **[`upgrade`]** resolves as [`add`] does, then compares the version
//!   the lock pins (whose library is given and must be the pin's, E1605)
//!   with the new one: the authority signature ([`super::signature`]), and
//!   the semantic diff of each module by the one classifier of the semantic
//!   diff and of patches ([`crate::diff::classify`]), and a changed
//!   `requires`. A widening, a governance change of a module and a changed
//!   `requires` are governance changes: the lock is given back with the new
//!   pin only when there are none, or with `accept_governance`.
//! - **[`publish`]** checks the library (E1601; a reserved name is refused),
//!   and refuses (E1607) a version already published, a version that is not
//!   a major one above the highest published version below it when against
//!   it it widens the signature, removes a criterion or adds a waiver, and a
//!   version below the lowest published version above it within its
//!   `MAJOR` that this version above would widen in the same way against
//!   ([`mandate_lib::lowest_above`]). It gives the files to copy into
//!   `<dir>/<name>/<version>/` and the `index.json` to write with them.

use std::collections::{BTreeMap, BTreeSet};

use mandate_ir::{Diagnostic, JsObject, JsValue, Language, Map, Value, has_errors};
use mandate_lib::{
    BaseComparison, Candidate, LibrariesConfig, LockLibrary, PassedOver, PublishPlan, Range,
    Resolve, Timestamp, Version, WaitDays, judge_next, lowest_above, plan_publish, read_index,
    read_lock_libraries, resolve,
};

use super::signature::{Signature, Widening, signature, widenings};
use super::{
    LibrarySource, LoadedLibrary, STD_PATTERNS, STD_PATTERNS_EMBEDDED, assemble, diagnostic,
    library_language, load_library, lock_path, module_checks, std_patterns_for,
};
use crate::diff::{GovernanceChangeKind, classify};

/// One version directory of a library, as the caller read it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Published {
    /// The version, the directory's name.
    pub version: String,
    /// The manifest and the module files.
    pub source: LibrarySource,
    /// The text of `index.json`, or `None` when there is none.
    pub index: Option<String>,
}

/// A change an upgrade or a publication finds, with its kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    /// `widened` (the authority signature), `requires_changed`, or a kind
    /// of [`GovernanceChangeKind`]; `behavior` for a change that is not a
    /// governance one.
    pub kind: String,
    /// The definition or the module it is about.
    pub at: String,
    /// The change, for a person.
    pub text: String,
}

impl Found {
    /// `{ kind, at, text }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("kind", self.kind.as_str())
            .with("at", self.at.as_str())
            .with("text", self.text.as_str())
            .into()
    }
}

/// What two versions of a library are against each other.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Comparison {
    /// How the new signature widens the old one.
    pub widenings: Vec<Widening>,
    /// The governance changes: the widenings, those of the modules, and a
    /// changed `requires`.
    pub governance: Vec<Found>,
    /// The other changes.
    pub behavior: Vec<Found>,
    /// The old version's signature.
    pub before: Signature,
    /// The new version's signature.
    pub after: Signature,
}

impl Comparison {
    /// What publish's version rule reads of it.
    #[must_use]
    pub fn base(&self) -> BaseComparison {
        let has = |k: GovernanceChangeKind| self.governance.iter().any(|g| g.kind == k.as_str());
        BaseComparison {
            widens_authority: !self.widenings.is_empty(),
            removes_criterion: has(GovernanceChangeKind::CriterionRemoved),
            adds_waiver: has(GovernanceChangeKind::WaiverAdded),
        }
    }
}

/// The libraries `deps` (but the built-in `std.patterns`, which
/// [`builtin_for`] gives each library), read; the E1601s of those that do
/// not read.
fn read_deps(deps: &[LibrarySource]) -> (Vec<LoadedLibrary>, Vec<Diagnostic>) {
    let mut out = Vec::new();
    let mut diagnostics = Vec::new();
    for (i, d) in deps.iter().enumerate() {
        match load_library(d, false, &format!("#{i}")) {
            Ok(l) if l.name() != STD_PATTERNS => out.push(l),
            Ok(_) => {}
            Err(d) => diagnostics.extend(d),
        }
    }
    (out, diagnostics)
}

/// The embedded versions of `std.patterns` a program of `language` may
/// pin, oldest first: those whose language is not newer than its own
/// (spec/attention.md "Which version"). `None` reads as a program of 0.6.
fn embedded_for(language: Option<Language>) -> Vec<LoadedLibrary> {
    let reads = language.unwrap_or(Language::V0_6);
    STD_PATTERNS_EMBEDDED
        .iter()
        .filter(|e| reads.at_least(e.language))
        .filter_map(|e| {
            let version = Version::parse(e.version).ok()?;
            std_patterns_for(Some(reads), Some(&version))
        })
        .collect()
}

/// The built-in `std.patterns` beside `library` when it is signed and
/// checked: the newest embedded version within the range its manifest
/// requires and of no newer language than its own, or without a
/// requirement the version a program of its language reads
/// ([`std_patterns_for`]). A library of 0.6 is given 1.0.0, as before 0.7.
fn builtin_for(library: &LoadedLibrary) -> Option<LoadedLibrary> {
    let language = library_language(library);
    let pinned = library
        .manifest
        .requires()
        .get(STD_PATTERNS)
        .and_then(|range| {
            embedded_for(language)
                .into_iter()
                .rev()
                .map(|l| *l.manifest.version())
                .find(|v| range.holds(v))
        });
    std_patterns_for(language, pinned.as_ref())
}

/// The signature of `library` with `deps` beside it, and the E1601s of its
/// modules that do not check, and E1606s of its requirements that `deps`
/// do not meet.
fn signed(
    library: &LoadedLibrary,
    deps: &[LoadedLibrary],
    check: bool,
) -> (Signature, Vec<Diagnostic>) {
    let builtin = (library.name() != STD_PATTERNS)
        .then(|| builtin_for(library))
        .flatten();
    let mut all: Vec<&LoadedLibrary> = vec![library];
    all.extend(deps.iter().filter(|d| d.name() != library.name()));
    all.extend(builtin.iter());
    let versions: BTreeMap<String, LockLibrary> =
        all.iter().map(|l| (l.name().to_owned(), l.pin())).collect();
    let assembled = assemble(&all, &versions);
    let mut diagnostics = Vec::new();
    if check {
        diagnostics.extend(
            assembled
                .diagnostics
                .iter()
                .filter(|d| {
                    d.facts
                        .as_ref()
                        .and_then(|f| f.get("library"))
                        .and_then(JsValue::as_str)
                        == Some(library.name())
                })
                .cloned(),
        );
        diagnostics.extend(module_checks(library, &assembled.modules, &assembled.reach));
    }
    (
        signature(&library.modules, &assembled.modules, &assembled.reach),
        diagnostics,
    )
}

/// The signature of `library` with the libraries `deps` (and the built-in
/// `std.patterns`) beside it, and what is wrong with it there: the E1601s
/// of `deps` that do not read and of its modules that do not check, and the
/// E1606s of its requirements they do not meet.
#[must_use]
pub fn signed_with(
    library: &LoadedLibrary,
    deps: &[LibrarySource],
) -> (Signature, Vec<Diagnostic>) {
    let (deps, mut diagnostics) = read_deps(deps);
    let (sig, mut more) = signed(library, &deps, library.name() != STD_PATTERNS);
    diagnostics.append(&mut more);
    (sig, diagnostics)
}

/// `old` against `new`, both with `deps` beside them.
#[must_use]
pub fn compare(old: &LoadedLibrary, new: &LoadedLibrary, deps: &[LoadedLibrary]) -> Comparison {
    let (before, _) = signed(old, deps, false);
    let (after, _) = signed(new, deps, false);
    let found = widenings(&before, &after);
    let mut governance: Vec<Found> = found
        .iter()
        .map(|w| Found {
            kind: "widened".to_owned(),
            at: w.name.clone(),
            text: w.text.clone(),
        })
        .collect();
    let mut behavior = Vec::new();
    // Each module by the classifier of the semantic diff and of patches.
    let builtin = (new.name() != STD_PATTERNS)
        .then(|| builtin_for(new))
        .flatten();
    let mut all: Vec<&LoadedLibrary> = vec![new];
    all.extend(deps.iter().filter(|d| d.name() != new.name()));
    all.extend(builtin.iter());
    let versions: BTreeMap<String, LockLibrary> =
        all.iter().map(|l| (l.name().to_owned(), l.pin())).collect();
    let modules = assemble(&all, &versions).modules;
    let names: BTreeSet<&str> = old.modules.keys().chain(new.modules.keys()).collect();
    for m in names {
        match (old.modules.get(m), new.modules.get(m)) {
            (Some(b), Some(a)) => {
                let c = classify(b, a, Some(&modules));
                governance.extend(c.governance.into_iter().map(|g| Found {
                    kind: g.kind.as_str().to_owned(),
                    at: format!("{m}{}", g.path),
                    text: g.text,
                }));
                behavior.extend(c.behavior.into_iter().map(|g| Found {
                    kind: "behavior".to_owned(),
                    at: format!("{m}{}", g.path),
                    text: g.text,
                }));
            }
            (None, Some(_)) => behavior.push(Found {
                kind: "behavior".to_owned(),
                at: m.to_owned(),
                text: format!("+ module {m}"),
            }),
            (Some(_), None) => behavior.push(Found {
                kind: "behavior".to_owned(),
                at: m.to_owned(),
                text: format!("- module {m} removed"),
            }),
            (None, None) => {}
        }
    }
    // A changed `requires`: other code the library's modules reach.
    let (ro, rn) = (old.manifest.requires(), new.manifest.requires());
    let required: BTreeSet<&String> = ro.keys().chain(rn.keys()).collect();
    for r in required {
        let text = match (ro.get(r), rn.get(r)) {
            (None, Some(n)) => format!("+ requires {r} {n}"),
            (Some(o), None) => format!("- requires {r} {o}"),
            (Some(o), Some(n)) if o != n => format!("~ requires {r} {o} → {n}"),
            _ => continue,
        };
        governance.push(Found {
            kind: "requires_changed".to_owned(),
            at: r.clone(),
            text,
        });
    }
    Comparison {
        widenings: found,
        governance,
        behavior,
        before,
        after,
    }
}

/// The versions read, each with its candidate.
type Read = Vec<(Candidate, LoadedLibrary)>;

/// The candidates of `library` among `versions`: each loaded, with its
/// publication time; the E1601s of those that are malformed, and the
/// versions with no `index.json`.
fn candidates(library: &str, versions: &[Published]) -> (Read, Vec<Diagnostic>, Vec<String>) {
    let mut out = Vec::new();
    let mut diagnostics = Vec::new();
    let mut unpublished = Vec::new();
    for v in versions {
        let Some(index) = &v.index else {
            unpublished.push(v.version.clone());
            continue;
        };
        let l = match load_library(&v.source, false, library) {
            Ok(l) => l,
            Err(d) => {
                diagnostics.extend(d);
                continue;
            }
        };
        if l.name() != library || l.manifest.version().to_string() != v.version {
            diagnostics.push(diagnostic(
                "E1601",
                format!(
                    "Library {library} is malformed: the directory of version {} holds {} {}.",
                    v.version,
                    l.name(),
                    l.manifest.version()
                ),
                &lock_path(library),
                JsObject::new()
                    .with("library", library)
                    .with("problem", "directory_mismatch")
                    .with("version", v.version.as_str())
                    .with("found_name", l.name())
                    .with("found_version", l.manifest.version().to_string()),
            ));
            continue;
        }
        match read_index(index) {
            Ok(published_at) => out.push((
                Candidate {
                    version: *l.manifest.version(),
                    digest: l.digest.clone(),
                    published_at,
                },
                l,
            )),
            Err(problems) => {
                for p in problems {
                    diagnostics.push(diagnostic(
                        "E1601",
                        format!(
                            "Library {library} is malformed: the index.json of version {} has the problem {}.",
                            v.version,
                            p.id()
                        ),
                        &lock_path(library),
                        JsObject::new()
                            .with("library", library)
                            .with("problem", "index")
                            .with("version", v.version.as_str())
                            .with("index", p.to_js()),
                    ));
                }
            }
        }
    }
    (out, diagnostics, unpublished)
}

/// What [`add`] and [`upgrade`] are given.
#[derive(Clone, Copy, Debug)]
pub struct Request<'a> {
    /// The library.
    pub library: &'a str,
    /// The range, as written; `None` for any version.
    pub range: Option<&'a str>,
    /// The lock.
    pub lock: &'a Value,
    /// Every version directory of the library.
    pub versions: &'a [Published],
    /// The libraries the lock pins (but the built-in one), for the checks
    /// of the library resolved.
    pub libraries: &'a [LibrarySource],
    /// The configuration's `libraries` member, read: the waiting period and
    /// the revoked digests. `None` waits 0 days and revokes nothing.
    pub config: Option<&'a LibrariesConfig>,
    /// The time the waiting period is compared with.
    pub now: Timestamp,
    /// 0.7: the language of the program the lock is for, when the caller
    /// knows it (`--program`). It decides which embedded versions of
    /// `std.patterns` may be pinned (those of a language not newer than
    /// it), and a program of 0.7 or later is given a lock of format
    /// `mandate/lock/0.7`. `None` is a program of 0.6, as before 0.7.
    pub language: Option<Language>,
}

/// What [`add`] and [`upgrade`] give.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// No diagnostic is an error, and a version was resolved.
    pub ok: bool,
    /// What was found.
    pub diagnostics: Vec<Diagnostic>,
    /// The resolution: `{ chosen, passed_over }`, and `unpublished`.
    pub resolution: JsObject,
    /// The version resolved, its digest and its signature.
    pub chosen: Option<(Version, String, Signature)>,
    /// What an upgrade compared, when it compared.
    pub comparison: Option<Comparison>,
    /// The lock with the new pin, when it is to be written.
    pub lock: Option<Value>,
}

impl Outcome {
    /// `{ ok, diagnostics, resolution, version?, digest?, signature?,
    /// governance?, behavior?, widenings?, lock }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let mut out = JsObject::new()
            .with("ok", self.ok)
            .with(
                "diagnostics",
                JsValue::Array(self.diagnostics.iter().map(Diagnostic::to_js).collect()),
            )
            .with("resolution", self.resolution.clone());
        if let Some((v, d, s)) = &self.chosen {
            out.insert("version", v.to_string());
            out.insert("digest", d.as_str());
            out.insert("signature", s.to_js());
        }
        if let Some(c) = &self.comparison {
            out.insert(
                "governance",
                JsValue::Array(c.governance.iter().map(Found::to_js).collect()),
            );
            out.insert(
                "behavior",
                JsValue::Array(c.behavior.iter().map(Found::to_js).collect()),
            );
            out.insert(
                "widenings",
                JsValue::Array(
                    c.widenings
                        .iter()
                        .map(|w| JsValue::Object(w.to_js()))
                        .collect(),
                ),
            );
            out.insert("before", c.before.to_js());
        }
        out.insert(
            "lock",
            self.lock.as_ref().map_or(JsValue::Null, JsValue::from),
        );
        out.into()
    }
}

/// A refused outcome with `diagnostics`.
fn refused(diagnostics: Vec<Diagnostic>, resolution: JsObject) -> Outcome {
    Outcome {
        ok: false,
        diagnostics,
        resolution,
        chosen: None,
        comparison: None,
        lock: None,
    }
}

/// The lock with `pin` as the entry of `library`, the entries by name. A
/// lock of a format before 0.6 becomes one of 0.6, the first that has
/// `libraries`; one of 0.6 or later (0.7, spec/attention.md "Lock 0.7")
/// keeps its format, and so every field that format has. For a program of
/// 0.7 or later (`language`), a lock of a format before 0.7 becomes one of
/// 0.7, whose fields are those of 0.6 and two more it need not have.
fn with_pin(lock: &Value, library: &str, pin: &LockLibrary, language: Option<Language>) -> Value {
    let mut m = lock.as_object().cloned().unwrap_or_default();
    let mut libraries: Vec<(String, Value)> = m
        .get("libraries")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect())
        .unwrap_or_default();
    libraries.retain(|(k, _)| k != library);
    let mut modules = Map::new();
    for (m, h) in pin.modules() {
        modules.insert(m.as_str(), h.as_str());
    }
    let mut entry = Map::new();
    entry.insert("version", pin.version().to_string());
    entry.insert("digest", pin.digest().as_str());
    entry.insert("modules", Value::Object(modules));
    libraries.push((library.to_owned(), Value::Object(entry)));
    libraries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = Map::new();
    for (k, v) in libraries {
        out.insert(k, v);
    }
    m.insert("libraries", Value::Object(out));
    if language.is_some_and(|l| l.at_least(Language::V0_7)) {
        if !mandate_ir::lock_at_least(lock, mandate_ir::LOCK_FORMAT_0_7) {
            m.insert("lock", mandate_ir::LOCK_FORMAT_0_7);
        }
    } else if !mandate_ir::lock_at_least(lock, mandate_ir::LOCK_FORMAT_0_6) {
        m.insert("lock", mandate_ir::LOCK_FORMAT_0_6);
    }
    Value::Object(m)
}

/// The resolution of a request: the chosen version's library, the
/// resolution as JSON, and what refuses it.
fn resolved(r: &Request<'_>) -> Result<(LoadedLibrary, JsObject, Vec<Diagnostic>), Box<Outcome>> {
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let range = match r.range.map(Range::parse).transpose() {
        Ok(range) => range,
        Err(fault) => {
            return Err(Box::new(refused(
                vec![diagnostic(
                    "E1606",
                    format!(
                        "The range {} asked for library {} is not a range: {}.",
                        r.range.unwrap_or_default(),
                        r.library,
                        fault.id()
                    ),
                    &lock_path(r.library),
                    JsObject::new()
                        .with("library", r.library)
                        .with("problem", "invalid_range")
                        .with("range", r.range.unwrap_or_default())
                        .with("fault", fault.id()),
                )],
                JsObject::new(),
            )));
        }
    };
    let pins = read_lock_libraries(r.lock.get("libraries")).unwrap_or_default();
    let pinned = pins.get(r.library).map(|p| *p.version());
    let (found, mut problems, unpublished) = if r.library == STD_PATTERNS {
        // The built-in copies are the candidates, those of a language not
        // newer than the program's (0.7): they wait for nothing.
        let builtin = embedded_for(r.language).into_iter().map(|l| {
            (
                Candidate {
                    version: *l.manifest.version(),
                    digest: l.digest.clone(),
                    published_at: Timestamp::from_unix_seconds(0).unwrap_or(r.now),
                },
                l,
            )
        });
        (builtin.collect(), Vec::new(), Vec::new())
    } else {
        candidates(r.library, r.versions)
    };
    diagnostics.append(&mut problems);
    let list: Vec<Candidate> = found.iter().map(|(c, _)| c.clone()).collect();
    let revoked = r.config.map(|c| c.revoked().clone()).unwrap_or_default();
    let wait = if r.library == STD_PATTERNS {
        WaitDays::default()
    } else {
        r.config.map(LibrariesConfig::wait_days).unwrap_or_default()
    };
    let resolution = resolve(&Resolve {
        library: r.library,
        range: range.as_ref(),
        candidates: &list,
        wait_days: wait,
        revoked: &revoked,
        now: r.now,
        pinned: pinned.as_ref(),
    });
    let resolution = match resolution {
        Ok(res) => res,
        Err(problems) => {
            for p in problems {
                diagnostics.push(diagnostic(
                    "E1601",
                    format!("Library {} is malformed: {}.", r.library, p.id()),
                    &lock_path(r.library),
                    JsObject::new()
                        .with("library", r.library)
                        .spread(&p.to_js()),
                ));
            }
            return Err(Box::new(refused(diagnostics, JsObject::new())));
        }
    };
    let shown = resolution.to_js().with(
        "unpublished",
        JsValue::Array(
            unpublished
                .iter()
                .map(|v| JsValue::from(v.as_str()))
                .collect(),
        ),
    );
    let Some(chosen) = &resolution.chosen else {
        let held: Vec<_> = resolution
            .passed_over
            .iter()
            .filter(|s| s.reason != PassedOver::OutsideRange)
            .collect();
        if held.is_empty() {
            diagnostics.push(diagnostic(
                "E1606",
                format!(
                    "No version of library {} in the directory is within {}.",
                    r.library,
                    r.range.unwrap_or("any range")
                ),
                &lock_path(r.library),
                JsObject::new()
                    .with("library", r.library)
                    .with("problem", "no_version")
                    .with("range", r.range.map_or(JsValue::Null, JsValue::from)),
            ));
        }
        for s in held {
            let text = match s.reason {
                PassedOver::Waiting { available_from } => format!(
                    "Version {} of library {} is within its waiting period: it may be resolved from {available_from}.",
                    s.candidate.version, r.library
                ),
                _ => format!(
                    "Version {} of library {} has a revoked digest, {}: it is never resolved.",
                    s.candidate.version, r.library, s.candidate.digest
                ),
            };
            diagnostics.push(diagnostic(
                "E1608",
                text,
                &lock_path(r.library),
                JsObject::new()
                    .with("library", r.library)
                    .spread(&s.to_js()),
            ));
        }
        return Err(Box::new(refused(diagnostics, shown)));
    };
    let Some((_, library)) = found.into_iter().find(|(c, _)| c.version == chosen.version) else {
        return Err(Box::new(refused(diagnostics, shown)));
    };
    Ok((library, shown, diagnostics))
}

/// `mandate add <library>[@<range>]`.
#[must_use]
pub fn add(r: &Request<'_>) -> Outcome {
    let (library, resolution, mut diagnostics) = match resolved(r) {
        Ok(x) => x,
        Err(o) => return *o,
    };
    let (deps, mut dep_problems) = read_deps(r.libraries);
    diagnostics.append(&mut dep_problems);
    let (sig, mut problems) = signed(&library, &deps, library.name() != STD_PATTERNS);
    diagnostics.append(&mut problems);
    let ok = !has_errors(&diagnostics);
    Outcome {
        ok,
        lock: ok.then(|| with_pin(r.lock, r.library, &library.pin(), r.language)),
        chosen: Some((*library.manifest.version(), library.digest.to_string(), sig)),
        comparison: None,
        diagnostics,
        resolution,
    }
}

/// `mandate upgrade <library>[@<range>] [--accept-governance]`: `pinned`
/// is the library of the version the lock pins.
#[must_use]
pub fn upgrade(r: &Request<'_>, pinned: &LibrarySource, accept_governance: bool) -> Outcome {
    let pins = read_lock_libraries(r.lock.get("libraries")).unwrap_or_default();
    let Some(pin) = pins.get(r.library) else {
        return refused(
            vec![diagnostic(
                "E1605",
                format!(
                    "The lock does not pin the library {}: add it first (mandate add {}).",
                    r.library, r.library
                ),
                &lock_path(r.library),
                JsObject::new()
                    .with("problem", "not_pinned")
                    .with("library", r.library),
            )],
            JsObject::new(),
        );
    };
    let old = if r.library == STD_PATTERNS {
        // The embedded version the lock pins; a pin of one that is not
        // embedded is refused below, as one of another digest is.
        std_patterns_for(r.language, Some(pin.version())).ok_or_else(Vec::new)
    } else {
        load_library(pinned, false, r.library)
    };
    let old = match old {
        Ok(l) => l,
        Err(d) => return refused(d, JsObject::new()),
    };
    let mismatch: Vec<Diagnostic> = mandate_lib::compare_pin(r.library, pin, &old.found())
        .into_iter()
        .map(|p| {
            diagnostic(
                "E1605",
                format!(
                    "The library given as the one the lock pins does not match its pin: {}.",
                    p.id().replace('_', " ")
                ),
                &lock_path(r.library),
                p.to_js(),
            )
        })
        .collect();
    if !mismatch.is_empty() {
        return refused(mismatch, JsObject::new());
    }
    let mut added = add(r);
    let Some(chosen) = added.chosen.as_ref().filter(|_| added.ok) else {
        return added;
    };
    let new = if r.library == STD_PATTERNS {
        std_patterns_for(r.language, Some(&chosen.0))
    } else {
        r.versions
            .iter()
            .find(|v| v.version == chosen.0.to_string())
            .and_then(|v| load_library(&v.source, false, r.library).ok())
    };
    let Some(new) = new else {
        return added;
    };
    let (deps, _) = read_deps(r.libraries);
    let comparison = compare(&old, &new, &deps);
    if !comparison.governance.is_empty() && !accept_governance {
        added.lock = None;
    }
    added.comparison = Some(comparison);
    added
}

/// What [`publish`] gives.
#[derive(Clone, Debug, PartialEq)]
pub struct Publication {
    /// No diagnostic is an error.
    pub ok: bool,
    /// What was found.
    pub diagnostics: Vec<Diagnostic>,
    /// The library's name, version and digest, when it reads.
    pub library: Option<(String, Version, String)>,
    /// The comparison with the version below, and with the one above.
    pub against: Vec<(String, Comparison)>,
    /// The files to copy into `<dir>/<name>/<version>/`, by path: the
    /// manifest and the modules.
    pub files: Vec<(String, String)>,
    /// The text of the `index.json` to write with them.
    pub index: Option<String>,
}

impl Publication {
    /// `{ ok, diagnostics, name?, version?, digest?, against, files?, index? }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let mut out = JsObject::new().with("ok", self.ok).with(
            "diagnostics",
            JsValue::Array(self.diagnostics.iter().map(Diagnostic::to_js).collect()),
        );
        if let Some((n, v, d)) = &self.library {
            out.insert("name", n.as_str());
            out.insert("version", v.to_string());
            out.insert("digest", d.as_str());
        }
        out.insert(
            "against",
            JsValue::Array(
                self.against
                    .iter()
                    .map(|(v, c)| {
                        JsObject::new()
                            .with("version", v.as_str())
                            .with("requires_major", c.base().requires_major())
                            .with(
                                "widenings",
                                JsValue::Array(
                                    c.widenings
                                        .iter()
                                        .map(|w| JsValue::Object(w.to_js()))
                                        .collect(),
                                ),
                            )
                            .with(
                                "governance",
                                JsValue::Array(c.governance.iter().map(Found::to_js).collect()),
                            )
                            .into()
                    })
                    .collect(),
            ),
        );
        if self.ok {
            out.insert(
                "files",
                self.files
                    .iter()
                    .map(|(p, t)| (p.as_str(), t.as_str()))
                    .collect::<JsObject>(),
            );
            out.insert(
                "index",
                self.index.as_deref().map_or(JsValue::Null, JsValue::from),
            );
        }
        out.into()
    }
}

/// The E1607 of a publication.
fn e1607(library: &str, problem: &mandate_lib::PublishProblem) -> Diagnostic {
    let text = match problem {
        mandate_lib::PublishProblem::AlreadyPublished { version } => {
            format!("Version {version} of library {library} is already published.")
        }
        mandate_lib::PublishProblem::NeedsMajor { version, base, .. } => format!(
            "Version {version} of library {library} widens the authority signature of {base}, removes one of its criteria or adds a waiver, and is not a major version above it."
        ),
        mandate_lib::PublishProblem::NextNeedsMajor { version, next, .. } => format!(
            "Version {next} of library {library}, published above {version} with its MAJOR, would widen the authority signature of {version}, remove one of its criteria or add a waiver: {version} cannot be published below it."
        ),
    };
    diagnostic(
        "E1607",
        text,
        "",
        JsObject::new()
            .with("library", library)
            .spread(&problem.to_js()),
    )
}

/// `mandate publish <source dir>`: `source` is the library to publish,
/// `published` every version the directory holds of it, `libraries` the
/// libraries it requires (but the built-in one), and `now` the time
/// written into its `index.json`.
#[must_use]
pub fn publish(
    source: &LibrarySource,
    published: &[Published],
    libraries: &[LibrarySource],
    now: Timestamp,
) -> Publication {
    let mut out = Publication {
        ok: false,
        diagnostics: Vec::new(),
        library: None,
        against: Vec::new(),
        files: Vec::new(),
        index: None,
    };
    let library = match load_library(source, false, "the source") {
        Ok(l) => l,
        Err(d) => {
            out.diagnostics = d;
            return out;
        }
    };
    let name = library.name().to_owned();
    out.library = Some((
        name.clone(),
        *library.manifest.version(),
        library.digest.to_string(),
    ));
    let (deps, mut problems) = read_deps(libraries);
    out.diagnostics.append(&mut problems);
    let (_, mut problems) = signed(&library, &deps, true);
    out.diagnostics.append(&mut problems);
    // The published versions, each read; one that does not read cannot be
    // compared, and a publication above or below it is refused (E1601).
    let mut versions: Vec<(Version, LoadedLibrary)> = Vec::new();
    for p in published {
        match load_library(&p.source, false, &name) {
            Ok(l) if l.name() == name => versions.push((*l.manifest.version(), l)),
            Ok(_) => {}
            Err(d) => out.diagnostics.extend(d),
        }
    }
    let listed: Vec<Version> = versions.iter().map(|(v, _)| *v).collect();
    let version = *library.manifest.version();
    match plan_publish(&listed, &version) {
        Err(p) => out.diagnostics.push(e1607(&name, &p)),
        Ok(plan) => {
            if let PublishPlan::Above(above) = plan {
                let base = *above.base();
                if let Some((_, old)) = versions.iter().find(|(v, _)| *v == base) {
                    let c = compare(old, &library, &deps);
                    if let Err(p) = above.judge(c.base()) {
                        out.diagnostics.push(e1607(&name, &p));
                    }
                    out.against.push((base.to_string(), c));
                }
            }
            if let Some(next) = lowest_above(&listed, &version)
                && let Some((_, newer)) = versions.iter().find(|(v, _)| *v == next)
            {
                let c = compare(&library, newer, &deps);
                if let Err(p) = judge_next(&version, &next, c.base()) {
                    out.diagnostics.push(e1607(&name, &p));
                }
                out.against.push((next.to_string(), c));
            }
        }
    }
    out.ok = !has_errors(&out.diagnostics);
    if out.ok {
        out.files
            .push(("mandate.library.json".to_owned(), source.manifest.clone()));
        out.files.extend(source.files.iter().cloned());
        out.index = Some(format!("{{ \"published_at\": \"{now}\" }}\n"));
    }
    out
}
