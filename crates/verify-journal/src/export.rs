//! An export held to its shape: rule 8 of spec/journal.md "Reading an
//! export", and the members of "The export".

use crate::json::{Json, safe_integer};
use crate::read::{ReadError, read_json};

/// The format of an export.
pub const EXPORT_FORMAT: &str = "mandate/journal-export/0.1";

/// A run's journal as an export carries it.
#[derive(Clone, Debug, PartialEq)]
pub struct Export {
    /// The run id, non-empty.
    pub run: String,
    /// The run's tenant.
    pub tenant: String,
    /// The run's manifest hash.
    pub manifest_hash: Option<String>,
    /// The run's manifest: an object, or `Json::Null`.
    pub manifest: Json,
    /// The package the first event names.
    pub package: Package,
    /// The events, in the export's order (at least one).
    pub events: Vec<Event>,
    /// The anchors, in the export's order, each `seq` above the one before.
    pub anchors: Vec<Anchor>,
    /// The key ids the export says signed the anchors. Advisory: a verifier
    /// trusts the keys it is given, never these.
    pub keys: Vec<String>,
}

/// The package of an export.
#[derive(Clone, Debug, PartialEq)]
pub struct Package {
    /// The package hash the export names.
    pub hash: String,
    /// The program's IR, an object.
    pub program: Json,
    /// The lock as packaged, an object.
    pub lock: Json,
    /// The modules by name, an object.
    pub modules: Json,
}

/// An event of an export.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    /// Its number, from 1 up to 2^53 − 1.
    pub seq: u64,
    /// Its type, such as `run_accepted`.
    pub kind: String,
    /// Its data.
    pub data: Json,
    /// When it was stored, milliseconds since the epoch, of magnitude at most
    /// 2^53 − 1.
    pub at: i64,
    /// Its hash, or `None` for `null`.
    pub hash: Option<String>,
}

/// An anchor of an export.
#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    /// The seq of the event it anchors.
    pub seq: u64,
    /// That event's hash, as signed.
    pub hash: String,
    /// That event's time, as signed.
    pub at: i64,
    /// The id of the key that signed it.
    pub key_id: String,
    /// `ed25519:` and the signature's base64.
    pub signature: String,
}

/// Reads an export: rules 1 to 7 ([`read_json`]), then the shape (rule 8).
///
/// # Errors
///
/// As [`read_json`], and [`ReadError::Malformed`] when the value read does
/// not have the shape of an export.
pub fn read_export(bytes: &[u8]) -> Result<Export, ReadError> {
    let value = read_json(bytes)?;
    shape(value).map_err(ReadError::Malformed)
}

/// The members `names` of an object that has exactly those members, in the
/// order of `names`.
fn closed<const N: usize>(value: Json, names: [&str; N], what: &str) -> Result<[Json; N], String> {
    let wrong = || {
        format!(
            "{what} does not have exactly the members {}",
            names.join(", ")
        )
    };
    let Json::Object(members) = value else {
        return Err(wrong());
    };
    if members.len() != N {
        return Err(wrong());
    }
    let mut slots: [Option<Json>; N] = std::array::from_fn(|_| None);
    for (name, member) in members {
        let slot = names
            .iter()
            .position(|n| *n == name)
            .and_then(|i| slots.get_mut(i))
            .ok_or_else(wrong)?;
        *slot = Some(member);
    }
    // The reader admits no duplicate names, so N members with N different
    // known names fill every slot.
    if slots.iter().any(Option::is_none) {
        return Err(wrong());
    }
    Ok(slots.map(|slot| slot.unwrap_or(Json::Null)))
}

fn string(value: Json, what: &str) -> Result<String, String> {
    match value {
        Json::String(s) => Ok(s),
        _ => Err(format!("{what} is not a string")),
    }
}

fn string_or_null(value: Json, what: &str) -> Result<Option<String>, String> {
    match value {
        Json::Null => Ok(None),
        Json::String(s) => Ok(Some(s)),
        _ => Err(format!("{what} is not a string or null")),
    }
}

fn object(value: Json, what: &str) -> Result<Json, String> {
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{what} is not an object"))
    }
}

/// An integer from 1 up to 2^53 − 1, however spelled.
fn seq(value: &Json, what: &str) -> Result<u64, String> {
    value
        .as_f64()
        .and_then(safe_integer)
        .filter(|n| *n >= 1)
        .and_then(|n| u64::try_from(n).ok())
        .ok_or_else(|| format!("{what}'s seq is not an integer from 1 up to 2^53 - 1"))
}

/// An integer of magnitude at most 2^53 − 1, however spelled; -0 is 0.
fn at(value: &Json, what: &str) -> Result<i64, String> {
    value
        .as_f64()
        .and_then(safe_integer)
        .ok_or_else(|| format!("{what}'s at is not an integer of magnitude at most 2^53 - 1"))
}

fn shape(value: Json) -> Result<Export, String> {
    let [
        format,
        run,
        tenant,
        manifest_hash,
        manifest,
        package,
        events,
        anchors,
        keys,
    ] = closed(
        value,
        [
            "format",
            "run",
            "tenant",
            "manifest_hash",
            "manifest",
            "package",
            "events",
            "anchors",
            "keys",
        ],
        "the export",
    )?;
    if format.as_str() != Some(EXPORT_FORMAT) {
        return Err(format!("the format is not {EXPORT_FORMAT}"));
    }
    let run = string(run, "run")?;
    if run.is_empty() {
        return Err("run is empty".to_owned());
    }
    let tenant = string(tenant, "tenant")?;
    let manifest_hash = string_or_null(manifest_hash, "manifest_hash")?;
    if !(manifest == Json::Null || manifest.is_object()) {
        return Err("manifest is not an object or null".to_owned());
    }
    let [hash, program, lock, modules] =
        closed(package, ["hash", "program", "lock", "modules"], "package")?;
    let package = Package {
        hash: string(hash, "package.hash")?,
        program: object(program, "package.program")?,
        lock: object(lock, "package.lock")?,
        modules: object(modules, "package.modules")?,
    };

    let Json::Array(events) = events else {
        return Err("events is not a list".to_owned());
    };
    if events.is_empty() {
        return Err("events is empty".to_owned());
    }
    let events = events
        .into_iter()
        .enumerate()
        .map(|(i, e)| {
            let what = format!("event {i}");
            let [s, kind, data, a, hash] = closed(e, ["seq", "type", "data", "at", "hash"], &what)?;
            Ok(Event {
                seq: seq(&s, &what)?,
                kind: string(kind, &format!("{what}'s type"))?,
                data,
                at: at(&a, &what)?,
                hash: string_or_null(hash, &format!("{what}'s hash"))?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let Json::Array(anchors) = anchors else {
        return Err("anchors is not a list".to_owned());
    };
    let mut read: Vec<Anchor> = Vec::with_capacity(anchors.len());
    for (i, a) in anchors.into_iter().enumerate() {
        let what = format!("anchor {i}");
        let [s, hash, t, key_id, signature] =
            closed(a, ["seq", "hash", "at", "key_id", "signature"], &what)?;
        let anchor = Anchor {
            seq: seq(&s, &what)?,
            hash: string(hash, &format!("{what}'s hash"))?,
            at: at(&t, &what)?,
            key_id: string(key_id, &format!("{what}'s key_id"))?,
            signature: string(signature, &format!("{what}'s signature"))?,
        };
        if read.last().is_some_and(|before| anchor.seq <= before.seq) {
            return Err(format!("{what} does not come after the one before it"));
        }
        read.push(anchor);
    }

    let Json::Array(keys) = keys else {
        return Err("keys is not a list".to_owned());
    };
    let keys = keys
        .into_iter()
        .map(|k| string(k, "a member of keys"))
        .collect::<Result<Vec<_>, String>>()?;

    Ok(Export {
        run,
        tenant,
        manifest_hash,
        manifest,
        package,
        events,
        anchors: read,
        keys,
    })
}
