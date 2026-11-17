//! Libraries on the command line (language 0.6, spec/library.md
//! "Libraries"): the operator's directory read into what the compiler's
//! pure functions take, the runtime's configuration, the libraries a lock
//! pins handed to a check, and `mandate add`, `upgrade` and `publish`.
//!
//! The compiler decides everything (`mandate_check::library::ops`): this
//! module reads the files it is to be given, prints what it answers, and
//! writes what it says to write, the lock or the published version.

use std::collections::BTreeSet;

use mandate_check::Modules;
use mandate_check::library::ops::{
    Outcome, Publication, Published, Request, add, publish, upgrade,
};
use mandate_check::library::{LibrarySource, STD_PATTERNS, load_library};
use mandate_ir::{Diagnostic, JsObject, JsValue, Language, Map, Value, format_diagnostic};
use mandate_lib::{
    Digest, LibrariesConfig, Timestamp, Version, is_name, read_libraries_config,
    read_lock_libraries, read_manifest,
};

use crate::args::Args;
use crate::commands::{Cli, Done, Stop, pretty};

/// The manifest's file name in a library's directory.
const MANIFEST: &str = "mandate.library.json";

/// The file `mandate publish` writes last into a version's directory.
const INDEX: &str = "index.json";

/// The lock a command reads when `--lock` names none, in the working
/// directory.
const LOCK: &str = "mandate.lock.json";

/// The configuration a command reads when `--config` names none and the
/// working directory has it.
const CONFIG: &str = "mandate.runtime.json";

/// What a check of a program is given of the libraries its lock pins.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Given {
    /// The libraries, as read from the directory.
    pub libraries: Vec<LibrarySource>,
    /// The digests the configuration revokes, when there is a configuration
    /// with a `libraries` member.
    pub revoked: Option<BTreeSet<Digest>>,
    /// The modules of the libraries that read, for the views.
    pub modules: Modules,
}

impl Given {
    /// `modules` and the modules of the libraries: what a view is given.
    pub(crate) fn with_modules(&self, modules: &Modules) -> Modules {
        let mut all = modules.clone();
        for (m, p) in self.modules.iter() {
            all.insert(m, p.clone());
        }
        all
    }
}

/// The configuration, as far as the libraries go.
struct Config {
    /// The file it was read from.
    file: String,
    /// Its `libraries` member, when it has one.
    libraries: Option<LibrariesConfig>,
}

/// `<library>[@<range>]`.
fn named(spec: &str) -> (&str, Option<&str>) {
    match spec.split_once('@') {
        Some((name, range)) => (name, Some(range)),
        None => (spec, None),
    }
}

/// Whether `lock` pins a library at all.
fn pins_libraries(lock: Option<&Value>) -> bool {
    lock.and_then(|l| l.get("libraries"))
        .and_then(Value::as_object)
        .is_some_and(|m| m.keys().next().is_some())
}

/// One line for each governance change and each other change of a
/// comparison, as `mandate patch` writes a governance change.
fn change_lines(governance: &[(String, String, String)], behavior: &[(String, String)]) -> String {
    let mut out = String::new();
    for (kind, at, text) in governance {
        out.push_str(&format!("governance change: {kind} at {at}: {text}\n"));
    }
    for (at, text) in behavior {
        out.push_str(&format!("behavior change: at {at}: {text}\n"));
    }
    out
}

impl Cli<'_> {
    /// Reports `diagnostics` against `file`, one a line on standard error.
    fn say(&mut self, diagnostics: &[Diagnostic], file: &str) {
        for d in diagnostics {
            self.err(&format!("{}\n", format_diagnostic(d, Some(file))));
        }
    }

    /// The configuration `--config` names, or `mandate.runtime.json` of the
    /// working directory when it is there; only its `libraries` member is
    /// read (the rest is the runtime's).
    fn config(&mut self, a: &Args) -> Result<Option<Config>, Stop> {
        let (file, text) = match a.config.as_deref() {
            Some(file) => (file.to_owned(), self.read(file)?),
            None => match self.read_if_there(CONFIG)? {
                Some(text) => (CONFIG.to_owned(), text),
                None => return Ok(None),
            },
        };
        let value = self.strict_json(&text, &file, a.json())?;
        let Some(members) = value.as_object() else {
            return Err(self.fail(
                2,
                &format!("{file} is not a configuration: it is not an object"),
            ));
        };
        let libraries = match members.get("libraries") {
            None => None,
            Some(member) => match read_libraries_config(member) {
                Ok(config) => Some(config),
                Err(problems) => {
                    let ids: Vec<&str> = problems.iter().map(|p| p.id()).collect();
                    return Err(self.fail(
                        2,
                        &format!(
                            "{file}: its member libraries is not {{ dir, wait_days?, revoked? }}: {}",
                            ids.join(", ")
                        ),
                    ));
                }
            },
        };
        Ok(Some(Config { file, libraries }))
    }

    /// The directory of libraries: the one `--libraries` names, or else the
    /// configuration's `libraries.dir`, relative to the configuration.
    fn libraries_dir(&self, a: &Args, config: Option<&Config>) -> Option<String> {
        if let Some(dir) = &a.libraries {
            return Some(dir.clone());
        }
        let config = config?;
        let dir = config.libraries.as_ref()?.dir();
        Some(self.beside(&config.file, dir))
    }

    /// The directory of libraries, or the stop that says none is named.
    fn needed_dir(&mut self, dir: Option<String>) -> Result<String, Stop> {
        match dir {
            Some(dir) => Ok(dir),
            None => Err(self.fail(
                2,
                "no directory of libraries: name it with --libraries <dir>, or as libraries.dir of the configuration (--config <file>, or mandate.runtime.json)",
            )),
        }
    }

    /// The library in the directory `dir`: its manifest, and each module
    /// file the manifest lists that is there (one that is missing is left
    /// out, so that the compiler says so). `None` when there is no manifest.
    /// A manifest the compiler does not read is handed in alone: its module
    /// paths are not followed.
    fn library_in(&mut self, dir: &str) -> Option<LibrarySource> {
        let manifest = self.text_of(&self.io.join(dir, MANIFEST))?;
        let mut files = Vec::new();
        if let Ok(read) = read_manifest(&manifest) {
            for path in read.modules() {
                if let Some(text) = self.text_of(&self.io.join(dir, path)) {
                    files.push((path.clone(), text));
                }
            }
        }
        Some(LibrarySource { manifest, files })
    }

    /// The text of `file`, when it can be read.
    fn text_of(&mut self, file: &str) -> Option<String> {
        self.io
            .read_file(file)
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Every version directory of `library` in `dir`, by name: one that has
    /// a manifest or an `index.json`.
    fn versions_in(&mut self, dir: &str, library: &str) -> Vec<Published> {
        let home = self.io.join(dir, library);
        let mut names: Vec<String> = match self.io.list_dir(&home) {
            Ok(entries) => entries
                .into_iter()
                .filter(|e| e.is_dir)
                .map(|e| e.name)
                .collect(),
            Err(_) => Vec::new(),
        };
        names.sort();
        let mut out = Vec::new();
        for version in names {
            let at = self.io.join(&home, &version);
            let source = self.library_in(&at);
            let index = self.text_of(&self.io.join(&at, INDEX));
            if source.is_some() || index.is_some() {
                out.push(Published {
                    version,
                    source: source.unwrap_or_default(),
                    index,
                });
            }
        }
        out
    }

    /// The libraries `lock` pins, each read from `dir` at the version it is
    /// pinned at; but the built-in one, and `except`. One that is not in
    /// the directory is left out, so that the compiler says so.
    fn pinned_in(&mut self, lock: &Value, dir: &str, except: Option<&str>) -> Vec<LibrarySource> {
        let pins = read_lock_libraries(lock.get("libraries")).unwrap_or_default();
        let mut out = Vec::new();
        for (name, pin) in &pins {
            if name == STD_PATTERNS || Some(name.as_str()) == except {
                continue;
            }
            let home = self.io.join(dir, name);
            let at = self.io.join(&home, &pin.version().to_string());
            out.extend(self.library_in(&at));
        }
        out
    }

    /// What a check of a program with `lock` is given: the libraries the
    /// lock pins, read from the directory, and the configuration's revoked
    /// digests. A lock that pins none reads no configuration and no
    /// directory.
    pub(crate) fn given(&mut self, a: &Args, lock: Option<&Value>) -> Result<Given, Stop> {
        let Some(lock) = lock.filter(|l| pins_libraries(Some(l))) else {
            return Ok(Given::default());
        };
        let config = self.config(a)?;
        let revoked = config
            .as_ref()
            .and_then(|c| c.libraries.as_ref())
            .map(|l| l.revoked().clone());
        let libraries = match self.libraries_dir(a, config.as_ref()) {
            Some(dir) => self.pinned_in(lock, &dir, None),
            None => Vec::new(),
        };
        let mut modules = Modules::new();
        for source in &libraries {
            if let Ok(library) = load_library(source, false, "a library") {
                for (m, p) in library.modules.iter() {
                    modules.insert(m, p.clone());
                }
            }
        }
        Ok(Given {
            libraries,
            revoked,
            modules,
        })
    }

    /// The time, as the doors take it.
    fn now(&mut self) -> Result<Timestamp, Stop> {
        let seconds = self.io.now_unix_seconds();
        match Timestamp::from_unix_seconds(seconds) {
            Some(now) => Ok(now),
            None => Err(self.fail(
                2,
                &format!("the clock gives {seconds} seconds since 1970, which is not a time"),
            )),
        }
    }

    /// The lock `mandate add` and `upgrade` work on, and its file: the one
    /// `--lock` names or `mandate.lock.json` of the working directory; a
    /// file that is not there is a lock of 0.6 that pins nothing.
    fn lock_to_change(&mut self, a: &Args) -> Result<(String, Value), Stop> {
        let file = a.lock.clone().unwrap_or_else(|| LOCK.to_owned());
        let lock = match self.read_if_there(&file)? {
            Some(text) => self.strict_json(&text, &file, a.json())?,
            None => {
                let mut empty = Map::new();
                empty.insert("lock", "mandate/lock/0.6");
                empty.insert("modules", Value::Object(Map::new()));
                Value::Object(empty)
            }
        };
        if lock.as_object().is_none() {
            return Err(self.fail(2, &format!("{file} is not a lock: it is not an object")));
        }
        Ok((file, lock))
    }

    /// `mandate add <library>[@<range>]` and, with `upgrading`,
    /// `mandate upgrade <library>[@<range>] [--accept-governance]`.
    pub(crate) fn add(&mut self, a: &Args, upgrading: bool) -> Done {
        let Some(spec) = a.arg(0) else {
            return Err(self.usage());
        };
        let (library, range) = named(spec);
        if !is_name(library) {
            return Err(self.fail(2, &format!("{library} is not the name of a library")));
        }
        // 0.7: the language of the program the lock is for, when `--program`
        // names it; a program that does not load is reported against its file.
        let language = match a.program.as_deref() {
            Some(file) => {
                let text = self.read(file)?;
                let loaded = mandate_syntax::load(&text, mandate_syntax::kind_of(file));
                match loaded.program {
                    Some(p) if !mandate_ir::has_errors(&loaded.diagnostics) => {
                        p.get("language").and_then(Language::from_value)
                    }
                    _ => {
                        self.report(&loaded.diagnostics, file, a.json(), &JsObject::new());
                        return Ok(1);
                    }
                }
            }
            None => None,
        };
        let (lock_file, lock) = self.lock_to_change(a)?;
        let config = self.config(a)?;
        let dir = self.libraries_dir(a, config.as_ref());
        // The built-in library needs no directory: its one version is the
        // compiler's own copy.
        let dir = if library == STD_PATTERNS {
            dir
        } else {
            Some(self.needed_dir(dir)?)
        };
        let pins = read_lock_libraries(lock.get("libraries")).unwrap_or_default();
        let pinned_version = pins.get(library).map(|p| p.version().to_string());
        let (versions, libraries, pinned) = match dir.as_deref() {
            Some(dir) => {
                let versions = if library == STD_PATTERNS {
                    Vec::new()
                } else {
                    self.versions_in(dir, library)
                };
                let pinned = pinned_version.as_deref().and_then(|v| {
                    let home = self.io.join(dir, library);
                    self.library_in(&self.io.join(&home, v))
                });
                (versions, self.pinned_in(&lock, dir, Some(library)), pinned)
            }
            None => (Vec::new(), Vec::new(), None),
        };
        let request = Request {
            library,
            range,
            lock: &lock,
            versions: &versions,
            libraries: &libraries,
            config: config.as_ref().and_then(|c| c.libraries.as_ref()),
            now: self.now()?,
            language,
        };
        let outcome = if upgrading {
            upgrade(
                &request,
                &pinned.unwrap_or_default(),
                a.flag("--accept-governance"),
            )
        } else {
            add(&request)
        };
        if a.json() {
            self.out(&pretty(&outcome.to_js()));
        } else {
            self.say(&outcome.diagnostics, &lock_file);
            let text = resolved_text(library, pinned_version.as_deref(), &outcome);
            self.out(&text);
        }
        match &outcome.lock {
            Some(lock) if outcome.ok => {
                self.write(&lock_file, &pretty(&JsValue::from(lock)))?;
                if !a.json() {
                    self.out(&format!("wrote {lock_file}\n"));
                }
                Ok(0)
            }
            _ => {
                let held = outcome
                    .comparison
                    .as_ref()
                    .map_or(0, |c| c.governance.len());
                if outcome.ok && held > 0 && !a.json() {
                    self.out(&format!(
                        "not written: {held} governance change(s); {lock_file} is written only with --accept-governance\n"
                    ));
                }
                Ok(1)
            }
        }
    }

    /// `mandate publish <source dir>`.
    pub(crate) fn publish(&mut self, a: &Args) -> Done {
        let Some(source_dir) = a.arg(0) else {
            return Err(self.usage());
        };
        let manifest_file = self.io.join(source_dir, MANIFEST);
        // A source without a manifest is not a library at all.
        self.read(&manifest_file)?;
        let source = self.library_in(source_dir).unwrap_or_default();
        let config = self.config(a)?;
        let dir = self.libraries_dir(a, config.as_ref());
        let dir = self.needed_dir(dir)?;
        // What the directory holds of it, and of what it requires: of each
        // required library, the highest published version within the range.
        let mut published = Vec::new();
        let mut libraries = Vec::new();
        if let Ok(manifest) = read_manifest(&source.manifest) {
            published = self.versions_in(&dir, manifest.name());
            for (required, range) in manifest.requires() {
                if required == STD_PATTERNS {
                    continue;
                }
                let best = self
                    .versions_in(&dir, required)
                    .into_iter()
                    .filter(|p| p.index.is_some())
                    .filter_map(|p| Version::parse(&p.version).ok().map(|v| (v, p)))
                    .filter(|(v, _)| range.holds(v))
                    .max_by_key(|(v, _)| *v);
                libraries.extend(best.map(|(_, p)| p.source));
            }
        }
        let publication = publish(&source, &published, &libraries, self.now()?);
        if a.json() {
            self.out(&pretty(&publication.to_js()));
        } else {
            self.say(&publication.diagnostics, &manifest_file);
            self.out(&compared_text(&publication));
        }
        let (true, Some((name, version, digest)), Some(index)) =
            (publication.ok, &publication.library, &publication.index)
        else {
            return Ok(1);
        };
        let home = self.io.join(&dir, name);
        let target = self.io.join(&home, &version.to_string());
        self.make_dir(&target)?;
        for (path, text) in &publication.files {
            let file = self.io.join(&target, path);
            if path.contains('/') {
                let parent = self.io.parent(&file);
                self.make_dir(&parent)?;
            }
            self.write(&file, text)?;
        }
        // The index last: a directory without it was never published.
        let index_file = self.io.join(&target, INDEX);
        self.write(&index_file, index)?;
        if !a.json() {
            self.out(&format!(
                "published {name} {version} {digest} to {target}\n"
            ));
        }
        Ok(0)
    }
}

/// What `add` and `upgrade` print of an outcome that resolved a version:
/// the library with its version and digest (an upgrade names the version it
/// comes from), an upgrade's changes, then the authority signature.
fn resolved_text(library: &str, from: Option<&str>, outcome: &Outcome) -> String {
    let Some((version, digest, signature)) = &outcome.chosen else {
        return String::new();
    };
    let mut out = match (&outcome.comparison, from) {
        (Some(_), Some(from)) => format!("{library} {from} -> {version} {digest}\n"),
        _ => format!("{library} {version} {digest}\n"),
    };
    if let Some(c) = &outcome.comparison {
        let governance: Vec<(String, String, String)> = c
            .governance
            .iter()
            .map(|g| (g.kind.clone(), g.at.clone(), g.text.clone()))
            .collect();
        let behavior: Vec<(String, String)> = c
            .behavior
            .iter()
            .map(|g| (g.at.clone(), g.text.clone()))
            .collect();
        out.push_str(&change_lines(&governance, &behavior));
    }
    out.push_str("authority signature:\n");
    out.push_str(&pretty(&JsValue::Object(signature.to_js())));
    out
}

/// What `publish` prints of the versions it compared with: for each, its
/// governance changes.
fn compared_text(publication: &Publication) -> String {
    let mut out = String::new();
    for (version, c) in &publication.against {
        for g in &c.governance {
            out.push_str(&format!(
                "against {version}: governance change: {} at {}: {}\n",
                g.kind, g.at, g.text
            ));
        }
    }
    out
}
