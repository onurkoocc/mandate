//! Libraries in the checker (language 0.6, spec/library.md "Libraries" and
//! "`std.patterns`"), which only the Rust compiler reads.
//!
//! A library is handed to the compiler as text ([`LibrarySource`]: its
//! manifest and the module files it lists); the compiler reads no file, and
//! the pure model of what a library is ([`mandate_lib`]) decides what can be
//! decided from text alone. This module turns the model's problems into
//! diagnostics and reads the modules:
//!
//! - [`load_library`]: the manifest, each listed module loaded and hashed
//!   (a module's name is the name its text declares, `module x @ …`; the
//!   file's name says nothing of it), and the digest. E1601 for a malformed
//!   library: the manifest's problems, a reserved name (`std`, `std.…`,
//!   accepted for the copy built into the compiler alone), a file the
//!   manifest lists that was not handed in or one handed in that it does
//!   not list, a module that does not load, is not written in 0.6, is
//!   named outside the library, is named twice, or defines an `extern`.
//! - [`STD_PATTERNS`]: the built-in `std.patterns`, whose source is
//!   `lib/std.patterns/` and is part of the compiler.
//! - [`for_check`]: what [`crate::check()`] reads of the libraries of a
//!   program of 0.6, before it links: their modules, the modules each one
//!   reaches (its own library's and those of the libraries it requires,
//!   [`crate::Reach`]), and the diagnostics of the libraries against the
//!   lock: E1601, E1605 (a digest, a version or a module that is not the
//!   pin's, a library not pinned, a pinned one not handed in, a module
//!   pinned twice), E1606 (a requirement not pinned or pinned outside its
//!   range) and E1608 (a pinned digest the configuration revokes). Every
//!   module of a library is checked too, with the modules it may import as
//!   its modules (E1601 when one does not check).
//!
//! The doors that add, upgrade and publish a library are [`ops`]'s; the
//! authority signature is [`signature`]'s.

pub mod ops;

pub use mandate_lib::Digest;
pub mod signature;

use std::collections::{BTreeMap, BTreeSet};

use mandate_ir::{
    DefKind, Definition, Diagnostic, JsObject, JsValue, Language, Location, Program, Value,
    has_errors, hash_program,
};
use mandate_lib::{
    FoundLibrary, LockLibrary, Manifest, check_requires, compare_pin, is_reserved_name,
    library_digest, modules_pinned_twice, read_lock_libraries, read_manifest,
};
use mandate_syntax::{kind_of, load};

use crate::check::CheckOptions;
use crate::modules::{Modules, Reach};

/// The name of the library built into the compiler.
pub const STD_PATTERNS: &str = "std.patterns";

/// The manifest of `std.patterns`, `lib/std.patterns/mandate.library.json`.
pub const STD_PATTERNS_MANIFEST: &str =
    include_str!("../../../../lib/std.patterns/mandate.library.json");

/// The one module of `std.patterns`, `lib/std.patterns/patterns.mdt`.
pub const STD_PATTERNS_MODULE: &str = include_str!("../../../../lib/std.patterns/patterns.mdt");

/// A library as it is handed to the compiler: the text of its
/// `mandate.library.json`, and each module file the manifest lists, by the
/// path it lists it under, with its text (Mandate text, or JSON IR for a
/// path that ends in `.json`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LibrarySource {
    /// The manifest's text.
    pub manifest: String,
    /// Each module file: its path as the manifest lists it, and its text.
    pub files: Vec<(String, String)>,
}

impl LibrarySource {
    /// The built-in `std.patterns`.
    #[must_use]
    pub fn std_patterns() -> LibrarySource {
        LibrarySource {
            manifest: STD_PATTERNS_MANIFEST.to_owned(),
            files: vec![("patterns.mdt".to_owned(), STD_PATTERNS_MODULE.to_owned())],
        }
    }
}

/// A library read: its manifest, its modules by name (in the manifest's
/// order) with their program hashes, and its digest.
#[derive(Clone, Debug, PartialEq)]
pub struct LoadedLibrary {
    /// The manifest.
    pub manifest: Manifest,
    /// Each module's IR, by the name it declares.
    pub modules: Modules,
    /// Each module's text and the path it was read from, by name.
    pub sources: BTreeMap<String, (String, String)>,
    /// Each module's program hash, by name.
    pub hashes: BTreeMap<String, Digest>,
    /// The digest, from the manifest and the program hashes.
    pub digest: Digest,
}

impl LoadedLibrary {
    /// The library's name.
    #[must_use]
    pub fn name(&self) -> &str {
        self.manifest.name()
    }

    /// What was found, as the lock's pin is compared with it.
    #[must_use]
    pub fn found(&self) -> FoundLibrary {
        FoundLibrary {
            version: *self.manifest.version(),
            digest: self.digest.clone(),
            modules: self.hashes.clone(),
        }
    }

    /// The pin `mandate add` writes for it.
    #[must_use]
    pub fn pin(&self) -> LockLibrary {
        LockLibrary::of_found(&self.found())
    }
}

/// A diagnostic of a library, at `path` (a JSON Pointer into the lock,
/// `/libraries/<name>`, or into the program), with `facts`.
pub(crate) fn diagnostic(code: &str, message: String, path: &str, facts: JsObject) -> Diagnostic {
    Diagnostic::new(code, message, Location::path(path), Some(facts))
}

/// `/libraries/<name>`.
pub(crate) fn lock_path(library: &str) -> String {
    mandate_ir::ptr(&[&"libraries", &library])
}

/// The E1601 of `library` with `facts` (`problem` and what it says).
fn malformed(library: &str, what: &str, facts: JsObject) -> Diagnostic {
    diagnostic(
        "E1601",
        format!("Library {library} is malformed: {what}."),
        &lock_path(library),
        JsObject::new().with("library", library).spread(&facts),
    )
}

/// The codes and paths of `diagnostics`' errors, as `code at path`.
fn error_codes(diagnostics: &[Diagnostic]) -> JsValue {
    JsValue::Array(
        diagnostics
            .iter()
            .filter(|d| d.severity == mandate_ir::Severity::Error)
            .map(|d| {
                JsValue::from(format!(
                    "{} at {}",
                    d.code,
                    d.at.path.as_deref().unwrap_or("")
                ))
            })
            .collect(),
    )
}

/// Reads a library: its manifest, its modules and its digest.
/// `builtin` is true for the copy of `std.patterns` the compiler holds,
/// which alone may have a reserved name. `label` names the library in a
/// diagnostic when its manifest has no name that can be read.
///
/// # Errors
///
/// The E1601 diagnostics of the library, every one found.
pub fn load_library(
    source: &LibrarySource,
    builtin: bool,
    label: &str,
) -> Result<LoadedLibrary, Vec<Diagnostic>> {
    let mut out: Vec<Diagnostic> = Vec::new();
    let manifest = match read_manifest(&source.manifest) {
        Ok(m) => m,
        Err(problems) => {
            for p in problems {
                out.push(malformed(
                    label,
                    &format!("its manifest has the problem {}", p.id()),
                    JsObject::new()
                        .with("problem", "manifest")
                        .with("manifest", p.to_js()),
                ));
            }
            return Err(out);
        }
    };
    let name = manifest.name().to_owned();
    if is_reserved_name(&name) && !builtin {
        out.push(malformed(
            &name,
            "std and the names under it are the compiler's own; a library handed to it may not have one",
            JsObject::new().with("problem", "reserved_name"),
        ));
    }
    let listed: Vec<&str> = manifest.modules().iter().map(String::as_str).collect();
    for (path, _) in &source.files {
        if !listed.contains(&path.as_str()) {
            out.push(malformed(
                &name,
                &format!("the file {path} was handed in, and its manifest does not list it"),
                JsObject::new()
                    .with("problem", "unlisted_file")
                    .with("file", path.as_str()),
            ));
        }
    }
    let mut modules = Modules::new();
    let mut sources: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut names: Vec<String> = Vec::new();
    for path in &listed {
        let Some((_, text)) = source.files.iter().find(|(p, _)| p == path) else {
            out.push(malformed(
                &name,
                &format!("its manifest lists the file {path}, which was not handed in"),
                JsObject::new()
                    .with("problem", "missing_file")
                    .with("file", *path),
            ));
            continue;
        };
        let loaded = load(text, kind_of(path));
        let program = match loaded.program {
            Some(p) if !has_errors(&loaded.diagnostics) => p,
            _ => {
                out.push(malformed(
                    &name,
                    &format!("its module file {path} does not load"),
                    JsObject::new()
                        .with("problem", "module_does_not_load")
                        .with("file", *path)
                        .with("codes", error_codes(&loaded.diagnostics)),
                ));
                continue;
            }
        };
        let Some(view) = Program::of(&program) else {
            continue;
        };
        let module = view.module().unwrap_or_default().to_owned();
        if !view.language().is_some_and(|l| l.at_least(Language::V0_6)) {
            out.push(malformed(
                &name,
                &format!("its module {module} is not written in mandate/0.6"),
                JsObject::new()
                    .with("problem", "not_0_6")
                    .with("module", module.as_str())
                    .with(
                        "language",
                        view.members()
                            .get("language")
                            .and_then(Value::as_str)
                            .unwrap_or("mandate/0.1"),
                    ),
            ));
        }
        for (def, d) in view.definitions() {
            if d.kind() == Some(DefKind::Extern) {
                out.push(malformed(
                    &name,
                    &format!(
                        "its module {module} defines the extern {def}: a library is data, and runs no code"
                    ),
                    JsObject::new()
                        .with("problem", "extern")
                        .with("module", module.as_str())
                        .with("name", def),
                ));
            }
        }
        names.push(module.clone());
        if !modules.contains_key(&module) {
            sources.insert(module.clone(), ((*path).to_owned(), text.clone()));
            modules.insert(module, program);
        }
    }
    let hashes: BTreeMap<String, Digest> = modules
        .iter()
        .filter_map(|(m, p)| Digest::parse(&hash_program(p).program).map(|h| (m.to_owned(), h)))
        .collect();
    let pairs: Vec<(&str, &str)> = names
        .iter()
        .map(|n| (n.as_str(), hashes.get(n).map_or("", |h| h.as_str())))
        .collect();
    let digest = match library_digest(&manifest, &pairs) {
        Ok(d) => Some(d),
        Err(problems) => {
            for p in problems {
                out.push(malformed(
                    &name,
                    &format!("its modules have the problem {}", p.id()),
                    p.to_js(),
                ));
            }
            None
        }
    };
    match digest {
        Some(digest) if out.is_empty() => Ok(LoadedLibrary {
            manifest,
            modules,
            sources,
            hashes,
            digest,
        }),
        _ => Err(out),
    }
}

/// The built-in `std.patterns`, read.
///
/// # Panics
///
/// Never: its source is part of the compiler and a test holds that it
/// reads (a failure would be a broken build, and is answered with an empty
/// library rather than a panic).
#[must_use]
pub fn std_patterns() -> Option<LoadedLibrary> {
    load_library(&LibrarySource::std_patterns(), true, STD_PATTERNS).ok()
}

/// The digest of the built-in `std.patterns`, which a lock pins.
#[must_use]
pub fn std_patterns_digest() -> Option<Digest> {
    std_patterns().map(|l| l.digest)
}

/// `modules` with the built-in `std.patterns` added, when `program` is of
/// 0.6, imports it, and `modules` do not hold it: for a view of a program,
/// which reads the expansion of a pattern of it. `None` otherwise.
#[must_use]
pub fn with_builtin(program: Program<'_>, modules: Option<&Modules>) -> Option<Modules> {
    let reads = program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_6))
        && imports_std_patterns(program)
        && !modules.is_some_and(|m| m.contains_key(STD_PATTERNS));
    if !reads {
        return None;
    }
    let mut all = modules.cloned().unwrap_or_default();
    for (m, p) in std_patterns()?.modules.iter() {
        all.insert(m, p.clone());
    }
    Some(all)
}

/// What [`crate::check()`] reads of the libraries of a program of 0.6.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ForCheck {
    /// The modules of the libraries, by name.
    pub modules: Modules,
    /// The modules each library module reaches.
    pub reach: Reach,
    /// The modules a library pins, which the lock's top-level `modules`
    /// does not pin again (E0142 is not theirs).
    pub pinned: BTreeSet<String>,
    /// E0140, E1601, E1605, E1606 and E1608.
    pub diagnostics: Vec<Diagnostic>,
}

/// Whether `program` names `std.patterns` in a `use`.
fn imports_std_patterns(program: Program<'_>) -> bool {
    program.imports().any(|u| u.module() == Some(STD_PATTERNS))
}

/// The libraries of a program of 0.6 with `opts`: its lock's pins, the
/// libraries handed in and the built-in `std.patterns` (when the program
/// imports it, the lock pins it, or a library requires it). `None` for a
/// program of 0.1 to 0.5, whose check reads no library.
#[must_use]
pub fn for_check(program: Program<'_>, opts: &CheckOptions<'_>) -> Option<ForCheck> {
    if !program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_6))
    {
        return None;
    }
    let mut out = ForCheck::default();
    // A lock its schema refuses pins nothing here: the check reports what
    // the schema finds (E0140), with the lock's other problems, after the
    // static checks, and the libraries are read as without a lock.
    let lock = opts
        .lock
        .filter(|l| l.is_truthy() && crate::lock::validate_lock(l).is_empty());
    // The pins; a lock this reader refuses pins nothing (E0140).
    let pins: Option<BTreeMap<String, LockLibrary>> = lock.map(|l| {
        match read_lock_libraries(l.get("libraries")) {
            Ok(p) => p,
            Err(problems) => {
                for p in problems {
                    let facts = p.to_js();
                    out.diagnostics.push(diagnostic(
                        "E0140",
                        format!(
                            "The lock's libraries have the problem {}: a library and its modules are named with lower-case names, each module with its library's name.",
                            p.id()
                        ),
                        "/libraries",
                        facts,
                    ));
                }
                BTreeMap::new()
            }
        }
    });
    // The libraries handed in, and std.patterns.
    let mut loaded: Vec<LoadedLibrary> = Vec::new();
    for (i, source) in opts.libraries.unwrap_or_default().iter().enumerate() {
        match load_library(source, false, &format!("#{i}")) {
            Ok(l) => {
                if l.name() == STD_PATTERNS || loaded.iter().any(|x| x.name() == l.name()) {
                    out.diagnostics.push(malformed(
                        l.name(),
                        "it was handed in twice, or it is the library the compiler holds",
                        JsObject::new().with("problem", "handed_twice"),
                    ));
                    continue;
                }
                loaded.push(l);
            }
            Err(d) => out.diagnostics.extend(d),
        }
    }
    let wants_std = imports_std_patterns(program)
        || pins.as_ref().is_some_and(|p| p.contains_key(STD_PATTERNS))
        || loaded
            .iter()
            .any(|l| l.manifest.requires().contains_key(STD_PATTERNS));
    let mut builtin: Option<LoadedLibrary> = None;
    if wants_std {
        builtin = std_patterns();
    }
    let all: Vec<&LoadedLibrary> = builtin.iter().chain(loaded.iter()).collect();
    // Against the lock.
    if let Some(pins) = &pins {
        for l in &all {
            match pins.get(l.name()) {
                None => {
                    if l.name() != STD_PATTERNS || imports_std_patterns(program) {
                        out.diagnostics.push(not_pinned(l.name()));
                    }
                }
                Some(pin) => {
                    for p in compare_pin(l.name(), pin, &l.found()) {
                        out.diagnostics.push(diagnostic(
                            "E1605",
                            format!(
                                "Library {} does not match the lock: {}.",
                                l.name(),
                                p.id().replace('_', " ")
                            ),
                            &lock_path(l.name()),
                            p.to_js(),
                        ));
                    }
                    if opts.revoked.is_some_and(|r| r.contains(&l.digest)) {
                        out.diagnostics.push(revoked(l.name(), &l.digest));
                    }
                }
            }
        }
        for name in pins.keys() {
            if !all.iter().any(|l| l.name() == name) {
                out.diagnostics.push(diagnostic(
                    "E1605",
                    format!(
                        "The lock pins the library {name}, and it was not handed to the check: a package carries every library its lock pins."
                    ),
                    &lock_path(name),
                    JsObject::new()
                        .with("problem", "not_found")
                        .with("library", name.as_str()),
                ));
            }
        }
        let top: Vec<&str> = lock
            .and_then(|l| l.get("modules"))
            .and_then(Value::as_object)
            .map(|m| m.keys().collect())
            .unwrap_or_default();
        for p in modules_pinned_twice(top, pins) {
            out.diagnostics.push(diagnostic(
                "E1605",
                "A module is pinned by the lock's modules and by a library's pin: it is pinned in one place.".to_owned(),
                "/modules",
                p.to_js(),
            ));
        }
    }
    // Requirements: against the pins, or without a lock against the
    // libraries handed in; then the modules, and what each reaches.
    let versions: BTreeMap<String, LockLibrary> = match &pins {
        Some(p) => p.clone(),
        None => all.iter().map(|l| (l.name().to_owned(), l.pin())).collect(),
    };
    let assembled = assemble(&all, &versions);
    out.diagnostics.extend(assembled.diagnostics);
    out.pinned = assembled.modules.keys().map(str::to_owned).collect();
    out.modules = assembled.modules;
    out.reach = assembled.reach;
    // A module handed in as a given module too, with another text.
    if let Some(given) = opts.modules {
        for (m, ir) in given.iter() {
            if let Some(lib) = out.modules.get(m)
                && hash_program(lib).program != hash_program(ir).program
            {
                out.diagnostics.push(diagnostic(
                    "E1605",
                    format!(
                        "Module {m} is given to the check and is a module of a library, with another text: the library's is the one its digest covers."
                    ),
                    "/modules",
                    JsObject::new().with("problem", "given_differs").with("module", m),
                ));
            }
        }
    }
    // Every module of a library handed in checks, with the modules it may
    // import (the built-in one is held to that by a test).
    for l in &loaded {
        out.diagnostics
            .extend(check_modules(l, &out.modules, &out.reach));
    }
    Some(out)
}

/// The modules of libraries put together, with what each reaches and what
/// is wrong with them together.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Assembled {
    /// Every module of every library, by name.
    pub modules: Modules,
    /// What each module reaches: its own library's modules and those of the
    /// libraries its library requires.
    pub reach: Reach,
    /// E1606 for each requirement `versions` does not meet, E1601 for a
    /// module two libraries have.
    pub diagnostics: Vec<Diagnostic>,
}

/// `all` put together, their requirements held to `versions` (the pins, or
/// the versions handed in).
pub(crate) fn assemble(
    all: &[&LoadedLibrary],
    versions: &BTreeMap<String, LockLibrary>,
) -> Assembled {
    let mut out = Assembled::default();
    for l in all {
        for p in check_requires(l.name(), l.manifest.requires(), versions) {
            out.diagnostics.push(diagnostic(
                "E1606",
                format!(
                    "Library {}'s requirement is not met: {}.",
                    l.name(),
                    p.id().replace('_', " ")
                ),
                &lock_path(l.name()),
                p.to_js(),
            ));
        }
    }
    for l in all {
        for (m, ir) in l.modules.iter() {
            if out.modules.contains_key(m) {
                out.diagnostics.push(malformed(
                    l.name(),
                    &format!("its module {m} is a module of another library too"),
                    JsObject::new()
                        .with("problem", "module_in_two_libraries")
                        .with("module", m),
                ));
                continue;
            }
            out.modules.insert(m, ir.clone());
        }
    }
    for l in all {
        let mut allowed: Vec<String> = l.modules.keys().map(str::to_owned).collect();
        for required in l.manifest.requires().keys() {
            if let Some(r) = all.iter().find(|x| x.name() == required) {
                allowed.extend(r.modules.keys().map(str::to_owned));
            }
        }
        for m in l.modules.keys() {
            out.reach.insert(m.to_owned(), allowed.clone());
        }
    }
    out
}

/// The E1601s of the modules of `library` that do not check, with the
/// modules it reaches among `all` (crate-wide: the doors use it).
pub(crate) fn module_checks(
    library: &LoadedLibrary,
    all: &Modules,
    reach: &Reach,
) -> Vec<Diagnostic> {
    check_modules(library, all, reach)
}

/// The E1605 of a library the lock does not pin.
fn not_pinned(library: &str) -> Diagnostic {
    diagnostic(
        "E1605",
        format!(
            "The lock does not pin the library {library}: add it (mandate add {library}), which writes its version, its digest and its modules."
        ),
        &lock_path(library),
        JsObject::new()
            .with("problem", "not_pinned")
            .with("library", library),
    )
}

/// The E1608 of a library whose digest the configuration revokes.
pub(crate) fn revoked(library: &str, digest: &Digest) -> Diagnostic {
    diagnostic(
        "E1608",
        format!(
            "The digest {digest} of library {library} is revoked by the runtime's configuration: it is never resolved or loaded."
        ),
        &lock_path(library),
        JsObject::new()
            .with("problem", "revoked")
            .with("library", library)
            .with("digest", digest.as_str()),
    )
}

/// The E1601s of the modules of `library` that do not check with the
/// modules it may import (its own library's and those of the libraries it
/// requires).
fn check_modules(library: &LoadedLibrary, all: &Modules, reach: &Reach) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for (module, (path, text)) in &library.sources {
        let allowed = reach.get(module).cloned().unwrap_or_default();
        let others: Modules = all
            .iter()
            .filter(|(m, _)| *m != module && allowed.iter().any(|a| a == m))
            .map(|(m, p)| (m, p.clone()))
            .collect();
        let r = crate::check::check(
            text,
            kind_of(path),
            &CheckOptions {
                modules: Some(&others),
                reach: Some(reach),
                ..CheckOptions::default()
            },
        );
        if !r.ok {
            out.push(malformed(
                library.name(),
                &format!("its module {module} does not check"),
                JsObject::new()
                    .with("problem", "module_does_not_check")
                    .with("module", module.as_str())
                    .with("codes", error_codes(&r.diagnostics)),
            ));
        }
    }
    out
}

/// Whether `d`, a definition of a module of a library, is `pub`.
#[must_use]
pub fn is_pub(d: &Value) -> bool {
    Definition::of(d)
        .value()
        .get("pub")
        .is_some_and(Value::is_truthy)
}
