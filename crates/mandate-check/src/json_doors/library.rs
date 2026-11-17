//! The library doors of language 0.6 (spec/library.md "The bridge":
//! `library_verify`, `library_add`, `library_upgrade`, `library_publish`,
//! `authority_signature`), which no TypeScript function stands for: the
//! TypeScript compiler is frozen at 0.5. Their table is
//! [`super::LIBRARY_DOORS`], committed as
//! `crates/mandate-check/tests/library_doors/doors.json`; they are held to
//! the functions of [`crate::library`] by `tests/library_doors.rs`, not to
//! a TypeScript.
//!
//! Each reads what a caller read from the operator's directory, with no
//! file, clock or configuration of its own:
//!
//! - a library is `{ manifest, files }`: the text of `mandate.library.json`
//!   and each module file it lists, by that path, with its text;
//! - a version directory is `{ version, library, index }`: the directory's
//!   name, its library, and the text of its `index.json` or `null` when it
//!   has none;
//! - `config` is the `libraries` member of the runtime's configuration,
//!   `{ dir, wait_days?, revoked? }`, read strictly (a member it does not
//!   know is `bad_input`);
//! - `now` is the time, `YYYY-MM-DDTHH:MM:SSZ`.

use mandate_ir::{JsObject, JsValue, Value};
use mandate_lib::{LibrariesConfig, Timestamp, read_libraries_config};

use super::DoorError;
use super::input::{Members, args};
use crate::library::ops::{Published, Request, add, publish, upgrade};
use crate::library::{LibrarySource, load_library};

/// `{ manifest, files }`, the member `name` of `m`.
fn source_of(m: Members<'_>, name: &str) -> Result<LibrarySource, DoorError> {
    let v = m.object(name)?;
    source_value(v, name)
}

/// A library from its JSON value, which is `name` in the input.
fn source_value(v: &Value, name: &str) -> Result<LibrarySource, DoorError> {
    let s = Members::nested(v, "", name)?;
    let manifest = s.str("manifest")?.to_owned();
    let mut files = Vec::new();
    for (path, text) in s.map("files")?.iter() {
        let Some(text) = text.as_str() else {
            return Err(DoorError::bad_input(format!(
                "`{name}.files.{path}` is {}, not a string",
                super::input::type_name(text)
            )));
        };
        files.push((path.to_owned(), text.to_owned()));
    }
    Ok(LibrarySource { manifest, files })
}

/// The libraries of the member `name` (an array), or none.
pub fn sources_of(m: Members<'_>, name: &str) -> Result<Vec<LibrarySource>, DoorError> {
    if m.opt_value(name).is_none_or(|v| matches!(v, Value::Null)) {
        return Ok(Vec::new());
    }
    m.array(name)?
        .iter()
        .map(|v| source_value(v, &format!("{name}[]")))
        .collect()
}

/// The version directories of the member `name`.
fn versions_of(m: Members<'_>, name: &str) -> Result<Vec<Published>, DoorError> {
    let mut out = Vec::new();
    for v in m.array(name)? {
        let p = Members::nested(v, "", &format!("{name}[]"))?;
        let index = match p.opt_value("index") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(other) => return Err(p.wrong("index", other, "a string or null")),
        };
        out.push(Published {
            version: p.str("version")?.to_owned(),
            source: source_of(p, "library")?,
            index,
        });
    }
    Ok(out)
}

/// The member `config`, read.
pub fn config_of(m: Members<'_>) -> Result<Option<LibrariesConfig>, DoorError> {
    match m.opt_value("config") {
        None | Some(Value::Null) => Ok(None),
        Some(v) => read_libraries_config(v).map(Some).map_err(|problems| {
            DoorError::bad_input(format!(
                "`config` is not the libraries member of a configuration: {}",
                problems
                    .iter()
                    .map(|p| p.id())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }),
    }
}

/// The member `now`, a time.
fn now_of(m: Members<'_>) -> Result<Timestamp, DoorError> {
    let text = m.str("now")?;
    Timestamp::parse(text).map_err(|f| {
        DoorError::bad_input(format!(
            "`now` is \"{text}\", not a time YYYY-MM-DDTHH:MM:SSZ: {}",
            f.id()
        ))
    })
}

/// The diagnostics as an array.
fn diagnostics_js(diagnostics: &[mandate_ir::Diagnostic]) -> JsValue {
    JsValue::Array(
        diagnostics
            .iter()
            .map(mandate_ir::Diagnostic::to_js)
            .collect(),
    )
}

/// The parameters of [`library_verify`].
pub(super) const LIBRARY_VERIFY: &[&str] = &["library", "libraries"];

/// `library_verify`: a library read and checked (E1601, E1606) with the
/// libraries it requires beside it.
///
/// Input: `{ library, libraries? }`.
/// Output: `{ ok, diagnostics, name?, version?, digest?, pin?, signature? }`.
pub(super) fn library_verify(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, LIBRARY_VERIFY)?;
    let source = source_of(a, "library")?;
    let deps = sources_of(a, "libraries")?;
    let library = match load_library(&source, false, "the library") {
        Ok(l) => l,
        Err(d) => {
            return Ok(JsObject::new()
                .with("ok", false)
                .with("diagnostics", diagnostics_js(&d))
                .into());
        }
    };
    let (sig, diagnostics) = crate::library::ops::signed_with(&library, &deps);
    Ok(JsObject::new()
        .with("ok", !mandate_ir::has_errors(&diagnostics))
        .with("diagnostics", diagnostics_js(&diagnostics))
        .with("name", library.name())
        .with("version", library.manifest.version().to_string())
        .with("digest", library.digest.as_str())
        .with("pin", library.pin().to_js())
        .with("signature", sig.to_js())
        .into())
}

/// The parameters of [`authority_signature`].
pub(super) const AUTHORITY_SIGNATURE: &[&str] = &["library", "libraries"];

/// `authority_signature`: the authority signature of a library's `pub`
/// workflows, patterns, connectors and agents (spec/library.md "The
/// authority signature").
///
/// Input: `{ library, libraries? }`.
/// Output: `{ "<module>.<name>": { kind, … }, … }`, or `null` when the
/// library does not read.
pub(super) fn authority_signature(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, AUTHORITY_SIGNATURE)?;
    let source = source_of(a, "library")?;
    let deps = sources_of(a, "libraries")?;
    Ok(match load_library(&source, false, "the library") {
        Ok(l) => JsValue::Object(crate::library::ops::signed_with(&l, &deps).0.to_js()),
        Err(_) => JsValue::Null,
    })
}

/// The parameters of [`library_add`].
pub(super) const LIBRARY_ADD: &[&str] = &[
    "library",
    "range",
    "lock",
    "versions",
    "libraries",
    "config",
    "now",
];

/// `library_add`: `mandate add <library>[@<range>]`.
///
/// Input: `{ library, range?, lock, versions, libraries?, config?, now }`.
/// Output: `{ ok, diagnostics, resolution, version?, digest?, signature?,
/// lock }`, `lock` the lock with the new pin or `null`.
pub(super) fn library_add(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, LIBRARY_ADD)?;
    let lock = a.object("lock")?;
    let versions = versions_of(a, "versions")?;
    let libraries = sources_of(a, "libraries")?;
    let config = config_of(a)?;
    let r = Request {
        library: a.str("library")?,
        range: a.opt_str("range")?,
        lock,
        versions: &versions,
        libraries: &libraries,
        config: config.as_ref(),
        now: now_of(a)?,
    };
    Ok(add(&r).to_js())
}

/// The parameters of [`library_upgrade`].
pub(super) const LIBRARY_UPGRADE: &[&str] = &[
    "library",
    "range",
    "lock",
    "versions",
    "pinned",
    "libraries",
    "config",
    "now",
    "accept_governance",
];

/// `library_upgrade`: `mandate upgrade <library>[@<range>]
/// [--accept-governance]`; `pinned` is the library of the version the lock
/// pins.
///
/// Input: `{ library, range?, lock, versions, pinned, libraries?, config?,
/// now, accept_governance? }`.
/// Output: as [`library_add`], and `governance`, `behavior`, `widenings`
/// and `before` (the pinned version's signature) when it compared; `lock`
/// is `null` when the comparison holds a governance change and
/// `accept_governance` is not true.
pub(super) fn library_upgrade(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, LIBRARY_UPGRADE)?;
    let lock = a.object("lock")?;
    let versions = versions_of(a, "versions")?;
    let libraries = sources_of(a, "libraries")?;
    let config = config_of(a)?;
    let pinned = source_of(a, "pinned")?;
    let accept = a.opt_bool("accept_governance")?.unwrap_or(false);
    let r = Request {
        library: a.str("library")?,
        range: a.opt_str("range")?,
        lock,
        versions: &versions,
        libraries: &libraries,
        config: config.as_ref(),
        now: now_of(a)?,
    };
    Ok(upgrade(&r, &pinned, accept).to_js())
}

/// The parameters of [`library_publish`].
pub(super) const LIBRARY_PUBLISH: &[&str] = &["source", "published", "libraries", "now"];

/// `library_publish`: `mandate publish <source dir>`.
///
/// Input: `{ source, published, libraries?, now }`: the library to
/// publish, every version directory of it the directory holds, the
/// libraries it requires.
/// Output: `{ ok, diagnostics, name?, version?, digest?, against, files?,
/// index? }`: when it may be published, the files to copy into
/// `<dir>/<name>/<version>/` by path, and the text of its `index.json`.
pub(super) fn library_publish(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, LIBRARY_PUBLISH)?;
    let source = source_of(a, "source")?;
    let published = versions_of(a, "published")?;
    let libraries = sources_of(a, "libraries")?;
    Ok(publish(&source, &published, &libraries, now_of(a)?).to_js())
}
