//! The compiled corpus, `vectors/corpus/`: every call the TypeScript
//! compiler's own tests make to a front door of the compiler, with its input
//! and its whole result (`vectors/README.md`, section "corpus/", is the
//! authority; `compiler/test/corpus-doors.ts` is how it was written).
//!
//! This module is everything a test of a door needs apart from the door:
//!
//! - [`Corpus::load`] reads the files and refuses a corpus that is not
//!   whole: it checks what it read against `summary.json` (the counts of
//!   entries, shared items, doors, test files and diagnostic codes), the
//!   keys and ids against the hashes they are made of, that every entry
//!   names a door it knows and shared items that exist, that every shared
//!   item is named, and that no file is missing or left over.
//! - [`Corpus::input`] builds the [`Input`] of an entry, in the shape the
//!   README gives for its door, from the shared items it names.
//! - [`render_load`], [`render_check`], [`render_load_modules`] and
//!   [`render_diagnostics`] write what a Rust door returned as the corpus
//!   stores it ([`Rendered`]): members in the README's order, and a program,
//!   a span table or a module as a digest ([`ir_text`], [`spans_text`],
//!   [`digest_of`]).
//! - [`Entry::name`] is the name of an item of a gate,
//!   `<door> @ <id> [<codes>]`, and [`compare`] is the comparison, with a
//!   failure message that names the entry and the test files it came from
//!   and shows the first difference.
//!
//! A result is compared as the JSON text `JSON.stringify` gives, so that
//! the member order is compared too. Nothing here depends on a compiler
//! crate: a door's test converts between its own types and these.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write as _;

use mandate_ir::{
    Diagnostic, JsObject, JsValue, Loaded, Map, Spans, Value, compare_utf16, sort_utf16, stringify,
    stringify_pretty,
};

use crate::{files, first_difference, read_json, sha256};

/// The corpus directory, relative to the repository root.
pub const DIR: &str = "vectors/corpus";

const ENTRIES_FORMAT: &str = "mandate/vectors/corpus/entries/0.1";
const SHARED_FORMAT: &str = "mandate/vectors/corpus/shared/0.1";
const SUMMARY_FORMAT: &str = "mandate/vectors/corpus/summary/0.1";

/// A front door of the compiler (`vectors/README.md`, "The front doors").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Door {
    /// `load(text, kind)`.
    Load,
    /// `check(text, kind, { modules, lock, claim })`.
    Check,
    /// `loadModules(sources)`.
    LoadModules,
    /// `checkPatch(program, base, ops, modules)`.
    CheckPatch,
    /// `checkSubprogram(input)`.
    CheckSubprogram,
    /// `checkAmendment(input)`.
    CheckAmendment,
    /// `applyPatch(program, base, ops, modules)`.
    ApplyPatch,
    /// `validateLock(value)`.
    ValidateLock,
    /// `acsTarget(program, modules, lock)`.
    AcsTarget,
    /// `denialDiagnostics(program, report)`.
    DenialDiagnostics,
}

impl Door {
    /// Every door, in the order of the README's table.
    pub const ALL: [Door; 10] = [
        Door::Load,
        Door::Check,
        Door::LoadModules,
        Door::CheckPatch,
        Door::CheckSubprogram,
        Door::CheckAmendment,
        Door::ApplyPatch,
        Door::ValidateLock,
        Door::AcsTarget,
        Door::DenialDiagnostics,
    ];

    /// The name an entry carries: `load`, `check`, `load_modules`, ...
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Door::Load => "load",
            Door::Check => "check",
            Door::LoadModules => "load_modules",
            Door::CheckPatch => "check_patch",
            Door::CheckSubprogram => "check_subprogram",
            Door::CheckAmendment => "check_amendment",
            Door::ApplyPatch => "apply_patch",
            Door::ValidateLock => "validate_lock",
            Door::AcsTarget => "acs_target",
            Door::DenialDiagnostics => "denial_diagnostics",
        }
    }

    /// The door with this name.
    #[must_use]
    pub fn from_name(name: &str) -> Option<Door> {
        Door::ALL.into_iter().find(|d| d.name() == name)
    }
}

/// The form a program is given in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// `"mdt"`.
    Mdt,
    /// `"json"`.
    Json,
}

impl Kind {
    fn from_name(name: &str) -> Option<Kind> {
        match name {
            "mdt" => Some(Kind::Mdt),
            "json" => Some(Kind::Json),
            _ => None,
        }
    }
}

/// What a call came back with in TypeScript.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// `result`: the return value as plain JSON, a program's IR, a span table
    /// and each module `loadModules` returns as a digest.
    Result(Value),
    /// `result_text`: the exact text of a return value that holds a number
    /// that is not an integer.
    ResultText(String),
    /// `throws`: the message of the error the door threw.
    Throws(String),
}

/// One recorded call.
#[derive(Clone, Debug)]
pub struct Entry {
    /// `<door>-<16 hex digits>`.
    pub id: String,
    /// The door called.
    pub door: Door,
    /// The test files that made the call (repository paths).
    pub files: Vec<String>,
    /// The arguments, by name, as stored: shared items by key. Build the
    /// call's arguments with [`Corpus::input`].
    pub input: Value,
    /// What the call gave.
    pub outcome: Outcome,
}

impl Entry {
    /// The diagnostic codes of the stored result, each once, sorted: every
    /// object of the result that is a diagnostic (it has a string `code`
    /// and `severity`, and a `message`).
    #[must_use]
    pub fn codes(&self) -> Vec<String> {
        let mut codes = BTreeMap::new();
        if let Outcome::Result(result) = &self.outcome {
            count_codes(result, &mut codes);
        }
        let mut out: Vec<String> = codes.into_keys().collect();
        sort_utf16(&mut out);
        out
    }

    /// The name of this entry as an item of a gate:
    /// `<door> @ <id> [<codes>]`, the codes sorted and separated by a space
    /// (`[]` when the stored result has none), so that a pending list can
    /// name a family of codes with a pattern such as `*MDT-E03??*`.
    #[must_use]
    pub fn name(&self) -> String {
        format!(
            "{} @ {} [{}]",
            self.door.name(),
            self.id,
            self.codes().join(" ")
        )
    }
}

fn is_diagnostic(map: &Map) -> bool {
    let string = |k: &str| map.get(k).and_then(Value::as_str).is_some();
    string("code") && string("severity") && string("message")
}

/// The diagnostics inside `value`, counted by code.
fn count_codes(value: &Value, counts: &mut BTreeMap<String, usize>) {
    match value {
        Value::Array(items) => {
            for item in items {
                count_codes(item, counts);
            }
        }
        Value::Object(map) if is_diagnostic(map) => {
            if let Some(code) = map.get("code").and_then(Value::as_str) {
                let n = counts.entry(code.to_owned()).or_insert(0);
                *n = n.saturating_add(1);
            }
        }
        Value::Object(map) => {
            for (_, v) in map.iter() {
                count_codes(v, counts);
            }
        }
        _ => {}
    }
}

/// The modules of a call, `{ name: IR }` in the order the call gave them.
pub type Modules<'a> = Vec<(&'a str, &'a Value)>;

/// A source given to `loadModules`.
#[derive(Clone, Debug)]
pub struct ModuleSource<'a> {
    /// The name given for messages.
    pub file: &'a str,
    /// The form of the text.
    pub kind: Kind,
    /// The text.
    pub text: &'a str,
}

/// The arguments of `checkPatch` and `applyPatch`.
#[derive(Clone, Debug)]
pub struct PatchInput<'a> {
    /// The IR the patch applies to.
    pub program: &'a Value,
    /// The hash of the program the patch is based on.
    pub base: &'a str,
    /// The RFC 6902 operations.
    pub ops: &'a [Value],
    /// The loaded modules.
    pub modules: Option<Modules<'a>>,
}

/// The arguments of a call, in the shape the README gives for its door. An
/// argument that is not there was not given: the door takes its default.
#[derive(Clone, Debug)]
pub enum Input<'a> {
    /// `load`.
    Load {
        /// The program's text.
        source: &'a str,
        /// Its form.
        kind: Kind,
    },
    /// `check`.
    Check {
        /// The program's text.
        source: &'a str,
        /// Its form.
        kind: Kind,
        /// The loaded modules (`options.modules`).
        modules: Option<Modules<'a>>,
        /// The lock, as a value (`options.lock`).
        lock: Option<&'a Value>,
        /// `options.claim`, inline.
        claim: Option<&'a Value>,
    },
    /// `loadModules`.
    LoadModules {
        /// The sources, in order.
        sources: Vec<ModuleSource<'a>>,
    },
    /// `checkPatch`.
    CheckPatch(PatchInput<'a>),
    /// `applyPatch`.
    ApplyPatch(PatchInput<'a>),
    /// `checkSubprogram`.
    CheckSubprogram {
        /// The parent program's IR.
        parent: &'a Value,
        /// The loaded modules.
        modules: Option<Modules<'a>>,
        /// The workflow's name.
        workflow: &'a str,
        /// The subprogram's number.
        number: i64,
        /// The hash the patch is based on.
        base: &'a str,
        /// The RFC 6902 operations.
        ops: &'a [Value],
        /// The lead agent's name.
        lead: &'a str,
        /// The room, inline.
        room: &'a Value,
    },
    /// `checkAmendment`.
    CheckAmendment {
        /// The parent program's IR.
        parent: &'a Value,
        /// The loaded modules.
        modules: Option<Modules<'a>>,
        /// The workflow's name.
        workflow: &'a str,
        /// The envelope, any JSON value (it is a lead's writing).
        envelope: Option<&'a Value>,
    },
    /// `validateLock`.
    ValidateLock {
        /// The value to validate, any JSON value.
        value: Option<&'a Value>,
    },
    /// `acsTarget`.
    AcsTarget {
        /// The program's IR.
        program: &'a Value,
        /// The loaded modules.
        modules: Option<Modules<'a>>,
        /// The lock, as a value.
        lock: Option<&'a Value>,
    },
    /// `denialDiagnostics`.
    DenialDiagnostics {
        /// The program's IR.
        program: &'a Value,
        /// The sandbox report, inline.
        report: &'a Value,
    },
}

impl Input<'_> {
    /// The door this is the input of.
    #[must_use]
    pub fn door(&self) -> Door {
        match self {
            Input::Load { .. } => Door::Load,
            Input::Check { .. } => Door::Check,
            Input::LoadModules { .. } => Door::LoadModules,
            Input::CheckPatch(_) => Door::CheckPatch,
            Input::ApplyPatch(_) => Door::ApplyPatch,
            Input::CheckSubprogram { .. } => Door::CheckSubprogram,
            Input::CheckAmendment { .. } => Door::CheckAmendment,
            Input::ValidateLock { .. } => Door::ValidateLock,
            Input::AcsTarget { .. } => Door::AcsTarget,
            Input::DenialDiagnostics { .. } => Door::DenialDiagnostics,
        }
    }
}

/// The corpus: its entries in the order of the files (by id, in UTF-16
/// order) and the shared items they name.
#[derive(Debug)]
pub struct Corpus {
    /// Every entry.
    pub entries: Vec<Entry>,
    texts: HashMap<String, String>,
    values: HashMap<String, Value>,
}

/// Cuts a list of problems for a message.
fn join_problems(problems: &[String]) -> String {
    const SHOWN: usize = 25;
    let mut out: Vec<String> = problems.iter().take(SHOWN).cloned().collect();
    if problems.len() > SHOWN {
        out.push(format!(
            "... and {} more",
            problems.len().saturating_sub(SHOWN)
        ));
    }
    out.join("\n")
}

fn as_object<'v>(v: &'v Value, what: &str) -> Result<&'v Map, String> {
    v.as_object()
        .ok_or_else(|| format!("{what}: not an object"))
}

fn member<'v>(map: &'v Map, key: &str, what: &str) -> Result<&'v Value, String> {
    map.get(key).ok_or_else(|| format!("{what}: no \"{key}\""))
}

fn string_member<'v>(map: &'v Map, key: &str, what: &str) -> Result<&'v str, String> {
    member(map, key, what)?
        .as_str()
        .ok_or_else(|| format!("{what}: \"{key}\" is not a string"))
}

fn count_member(map: &Map, key: &str, what: &str) -> Result<usize, String> {
    member(map, key, what)?
        .as_i64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| format!("{what}: \"{key}\" is not a count"))
}

/// The members of `map` must be among `required` and `optional`, and every
/// one of `required` must be there.
fn only_members(map: &Map, what: &str, required: &[&str], optional: &[&str]) -> Result<(), String> {
    for key in map.keys() {
        if !required.contains(&key) && !optional.contains(&key) {
            return Err(format!(
                "{what}: has the member \"{key}\", which is not known"
            ));
        }
    }
    for key in required {
        if !map.contains_key(key) {
            return Err(format!("{what}: has no member \"{key}\""));
        }
    }
    Ok(())
}

/// A file of the corpus: its format, its part and the parts it is of.
fn read_part(rel: &str, format: &str, part: usize, parts: usize) -> Result<Value, String> {
    let value = read_json(rel)?;
    let map = as_object(&value, rel)?;
    if string_member(map, "format", rel)? != format {
        return Err(format!("{rel}: the format is not {format}"));
    }
    if count_member(map, "part", rel)? != part || count_member(map, "parts", rel)? != parts {
        return Err(format!("{rel}: is not part {part} of {parts}"));
    }
    Ok(value)
}

/// The compact JSON text of a value, in its member order.
fn compact(value: &Value) -> String {
    stringify(&JsValue::from(value)).unwrap_or_default()
}

/// The first 16 hex digits of the SHA-256 of `text`.
fn key_of(text: &str) -> String {
    sha256(text)
        .strip_prefix("sha256:")
        .unwrap_or_default()
        .chars()
        .take(16)
        .collect()
}

/// One item of a `shared-N.json`: a text (also as pieces) or a value.
enum Item {
    Text(String),
    Value(Value),
}

/// The text a list of pieces stands for.
fn join_parts(parts: &Value, what: &str) -> Result<String, String> {
    let mut text = String::new();
    for part in parts
        .as_array()
        .ok_or_else(|| format!("{what}: parts is not an array"))?
    {
        let pair = part
            .as_array()
            .ok_or_else(|| format!("{what}: a part is not [piece, count]"))?;
        let (Some(piece), Some(count)) = (
            pair.first().and_then(Value::as_str),
            pair.get(1)
                .and_then(Value::as_i64)
                .and_then(|n| usize::try_from(n).ok()),
        ) else {
            return Err(format!("{what}: a part is not [piece, count]"));
        };
        text.push_str(&piece.repeat(count));
    }
    Ok(text)
}

fn read_item(key: &str, item: &Value) -> Result<Item, String> {
    let what = format!("shared item {key}");
    let map = as_object(item, &what)?;
    match (
        map.get("text"),
        map.get("parts"),
        map.get("value"),
        map.len(),
    ) {
        (Some(text), None, None, 1) => text
            .as_str()
            .map(|t| Item::Text(t.to_owned()))
            .ok_or_else(|| format!("{what}: text is not a string")),
        (None, Some(parts), None, 1) => join_parts(parts, &what).map(Item::Text),
        (None, None, Some(value), 1) => Ok(Item::Value(value.clone())),
        _ => Err(format!(
            "{what}: is not exactly one of text, parts and value"
        )),
    }
}

impl Corpus {
    /// Reads `vectors/corpus/` and checks it against its summary.
    ///
    /// # Errors
    ///
    /// What is wrong with the corpus, one problem a line (the first 25): a
    /// file missing, left over, or in another format; an entry or a shared
    /// item that is not what its key or id says; an entry that names a door
    /// this module does not know, a shared item that is not there, or an
    /// input that does not have the shape the README gives; a shared item
    /// no entry names; a count that is not the summary's.
    pub fn load() -> Result<Corpus, String> {
        let summary_rel = format!("{DIR}/summary.json");
        let summary = read_json(&summary_rel)?;
        let summary = as_object(&summary, &summary_rel)?;
        if string_member(summary, "format", &summary_rel)? != SUMMARY_FORMAT {
            return Err(format!("{summary_rel}: the format is not {SUMMARY_FORMAT}"));
        }

        // The files: parts counted by the first of each, and nothing else.
        let entries_parts = parts_of(&format!("{DIR}/entries-1.json"))?;
        let shared_parts = parts_of(&format!("{DIR}/shared-1.json"))?;
        let mut expected_files: Vec<String> = vec!["summary.json".to_owned()];
        expected_files.extend((1..=entries_parts).map(|n| format!("entries-{n}.json")));
        expected_files.extend((1..=shared_parts).map(|n| format!("shared-{n}.json")));
        sort_utf16(&mut expected_files);
        let mut found = files(DIR)?;
        sort_utf16(&mut found);
        if found != expected_files {
            return Err(format!(
                "{DIR}: the files are {found:?}, expected {expected_files:?}"
            ));
        }

        let mut problems: Vec<String> = Vec::new();

        // The shared items.
        let mut texts: HashMap<String, String> = HashMap::new();
        let mut values: HashMap<String, Value> = HashMap::new();
        let mut last_key: Option<String> = None;
        for part in 1..=shared_parts {
            let rel = format!("{DIR}/shared-{part}.json");
            let file = read_part(&rel, SHARED_FORMAT, part, shared_parts)?;
            let items = as_object(member(as_object(&file, &rel)?, "items", &rel)?, &rel)?;
            for (key, item) in items.iter() {
                if let Some(last) = &last_key
                    && compare_utf16(last, key) != std::cmp::Ordering::Less
                {
                    problems.push(format!("{rel}: the key {key} is not after {last}"));
                }
                last_key = Some(key.to_owned());
                match read_item(key, item) {
                    Err(e) => problems.push(format!("{rel}: {e}")),
                    Ok(Item::Text(text)) => {
                        let want = key_of(&compact(&Value::String(text.clone())));
                        if want != key {
                            problems.push(format!("{rel}: the text {key} has the key {want}"));
                        }
                        texts.insert(key.to_owned(), text);
                    }
                    Ok(Item::Value(value)) => {
                        let want = key_of(&compact(&value));
                        if want != key {
                            problems.push(format!("{rel}: the value {key} has the key {want}"));
                        }
                        values.insert(key.to_owned(), value);
                    }
                }
            }
        }

        // The entries.
        let mut entries: Vec<Entry> = Vec::new();
        let mut last_id: Option<String> = None;
        for part in 1..=entries_parts {
            let rel = format!("{DIR}/entries-{part}.json");
            let file = read_part(&rel, ENTRIES_FORMAT, part, entries_parts)?;
            let list = member(as_object(&file, &rel)?, "entries", &rel)?
                .as_array()
                .ok_or_else(|| format!("{rel}: entries is not an array"))?;
            for raw in list {
                match read_entry(raw) {
                    Err(e) => problems.push(format!("{rel}: {e}")),
                    Ok(entry) => {
                        if let Some(last) = &last_id
                            && compare_utf16(last, &entry.id) != std::cmp::Ordering::Less
                        {
                            problems
                                .push(format!("{rel}: the id {} is not after {last}", entry.id));
                        }
                        last_id = Some(entry.id.clone());
                        entries.push(entry);
                    }
                }
            }
        }

        let corpus = Corpus {
            entries,
            texts,
            values,
        };

        // Every input is built, so that one that is malformed is found now,
        // and every shared item must be named.
        let mut used: BTreeSet<&str> = BTreeSet::new();
        for entry in &corpus.entries {
            if let Err(e) = corpus.build(entry, &mut used) {
                problems.push(format!("{}: {e}", entry.id));
            }
        }
        let unnamed: Vec<&String> = corpus
            .texts
            .keys()
            .chain(corpus.values.keys())
            .filter(|k| !used.contains(k.as_str()))
            .collect();
        if !unnamed.is_empty() {
            let mut keys: Vec<&str> = unnamed.iter().map(|k| k.as_str()).collect();
            sort_utf16(&mut keys);
            problems.push(format!(
                "{} shared item(s) that no entry names: {}",
                keys.len(),
                keys.join(" ")
            ));
        }

        corpus.check_summary(summary, &summary_rel, &mut problems);
        if problems.is_empty() {
            Ok(corpus)
        } else {
            Err(format!(
                "{DIR}: {} problem(s):\n{}",
                problems.len(),
                join_problems(&problems)
            ))
        }
    }

    /// What `summary.json` pins that the entries can show.
    fn check_summary(&self, summary: &Map, rel: &str, problems: &mut Vec<String>) {
        let mut pin = |what: &str, want: Result<usize, String>, got: usize| match want {
            Ok(want) if want == got => {}
            Ok(want) => problems.push(format!("{rel}: {what} is {want}, the corpus has {got}")),
            Err(e) => problems.push(e),
        };
        pin(
            "entries",
            count_member(summary, "entries", rel),
            self.entries.len(),
        );
        pin(
            "shared",
            count_member(summary, "shared", rel),
            self.texts.len().saturating_add(self.values.len()),
        );
        let left_out = summary
            .get("left_out")
            .and_then(Value::as_array)
            .map(<[Value]>::len);
        match (left_out, count_member(summary, "distinct_calls", rel)) {
            (Some(left_out), Ok(distinct)) => {
                if distinct != self.entries.len().saturating_add(left_out) {
                    problems.push(format!(
                        "{rel}: distinct_calls is {distinct}, but there are {} entries and {left_out} calls left out",
                        self.entries.len()
                    ));
                }
            }
            (None, _) => problems.push(format!("{rel}: left_out is not an array")),
            (_, Err(e)) => problems.push(e),
        }

        // Counts by door, by test file and by code: the summary's table and
        // the corpus's, key by key.
        let by = |key: &str| -> Result<BTreeMap<String, usize>, String> {
            let map = as_object(member(summary, key, rel)?, &format!("{rel}: {key}"))?;
            let mut out = BTreeMap::new();
            for (name, n) in map.iter() {
                let n = n
                    .as_i64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| format!("{rel}: {key}.{name} is not a count"))?;
                out.insert(name.to_owned(), n);
            }
            Ok(out)
        };
        let mut by_door: BTreeMap<String, usize> =
            Door::ALL.iter().map(|d| (d.name().to_owned(), 0)).collect();
        let mut by_file: BTreeMap<String, usize> = BTreeMap::new();
        let mut by_code: BTreeMap<String, usize> = BTreeMap::new();
        for entry in &self.entries {
            let n = by_door.entry(entry.door.name().to_owned()).or_insert(0);
            *n = n.saturating_add(1);
            for file in &entry.files {
                let n = by_file.entry(file.clone()).or_insert(0);
                *n = n.saturating_add(1);
            }
            if let Outcome::Result(result) = &entry.outcome {
                count_codes(result, &mut by_code);
            }
        }
        for (key, got) in [
            ("by_door", by_door),
            ("by_file", by_file),
            ("by_code", by_code),
        ] {
            match by(key) {
                Err(e) => problems.push(e),
                Ok(want) => {
                    for name in want.keys().chain(got.keys()).collect::<BTreeSet<_>>() {
                        let (w, g) = (want.get(name), got.get(name));
                        if w != g {
                            problems.push(format!(
                                "{rel}: {key}.{name} is {}, the corpus has {}",
                                w.map_or("not there".to_owned(), ToString::to_string),
                                g.map_or("none".to_owned(), ToString::to_string)
                            ));
                        }
                    }
                }
            }
        }
    }

    /// The text of the shared item `key`.
    fn text<'a>(&'a self, key: &'a Value, used: &mut BTreeSet<&'a str>) -> Result<&'a str, String> {
        let key = key
            .as_str()
            .ok_or("a shared text is named by something that is not a string")?;
        let text = self
            .texts
            .get(key)
            .ok_or_else(|| format!("names the shared text {key}, which is not there"))?;
        used.insert(key);
        Ok(text)
    }

    /// The shared value named by `key`.
    fn value<'a>(
        &'a self,
        key: &'a Value,
        used: &mut BTreeSet<&'a str>,
    ) -> Result<&'a Value, String> {
        let key = key
            .as_str()
            .ok_or("a shared value is named by something that is not a string")?;
        let value = self
            .values
            .get(key)
            .ok_or_else(|| format!("names the shared value {key}, which is not there"))?;
        used.insert(key);
        Ok(value)
    }

    fn modules<'a>(
        &'a self,
        v: Option<&'a Value>,
        used: &mut BTreeSet<&'a str>,
    ) -> Result<Option<Modules<'a>>, String> {
        let Some(v) = v else { return Ok(None) };
        let map = as_object(v, "modules")?;
        let mut out = Vec::new();
        for (name, key) in map.iter() {
            out.push((name, self.value(key, used)?));
        }
        Ok(Some(out))
    }

    /// The arguments of `entry`, built from its stored input and the shared
    /// items it names.
    ///
    /// # Errors
    ///
    /// When the input does not have the shape the README gives for the
    /// door: a member missing or not known, of another type, or a shared
    /// item that is not there.
    pub fn input<'a>(&'a self, entry: &'a Entry) -> Result<Input<'a>, String> {
        self.build(entry, &mut BTreeSet::new())
    }

    /// [`Corpus::input`], noting the keys of the shared items it names.
    fn build<'a>(
        &'a self,
        entry: &'a Entry,
        used: &mut BTreeSet<&'a str>,
    ) -> Result<Input<'a>, String> {
        let what = format!("the input of a {} call", entry.door.name());
        let input = as_object(&entry.input, &what)?;
        let kind = |input: &'a Map| -> Result<Kind, String> {
            let name = string_member(input, "kind", &what)?;
            Kind::from_name(name).ok_or_else(|| format!("{what}: the kind \"{name}\" is not known"))
        };
        let ops = |input: &'a Map| -> Result<&'a [Value], String> {
            member(input, "ops", &what)?
                .as_array()
                .ok_or_else(|| format!("{what}: ops is not an array"))
        };
        match entry.door {
            Door::Load => {
                only_members(input, &what, &["source", "kind"], &[])?;
                Ok(Input::Load {
                    source: self.text(member(input, "source", &what)?, used)?,
                    kind: kind(input)?,
                })
            }
            Door::Check => {
                only_members(
                    input,
                    &what,
                    &["source", "kind"],
                    &["modules", "lock", "claim"],
                )?;
                Ok(Input::Check {
                    source: self.text(member(input, "source", &what)?, used)?,
                    kind: kind(input)?,
                    modules: self.modules(input.get("modules"), used)?,
                    lock: input.get("lock").map(|k| self.value(k, used)).transpose()?,
                    claim: input.get("claim"),
                })
            }
            Door::LoadModules => {
                only_members(input, &what, &["sources"], &[])?;
                let mut sources = Vec::new();
                for source in member(input, "sources", &what)?
                    .as_array()
                    .ok_or_else(|| format!("{what}: sources is not an array"))?
                {
                    let s = as_object(source, "a module source")?;
                    only_members(s, "a module source", &["file", "kind", "text"], &[])?;
                    sources.push(ModuleSource {
                        file: string_member(s, "file", "a module source")?,
                        kind: kind(s)?,
                        text: self.text(member(s, "text", "a module source")?, used)?,
                    });
                }
                Ok(Input::LoadModules { sources })
            }
            Door::CheckPatch | Door::ApplyPatch => {
                only_members(input, &what, &["program", "base", "ops"], &["modules"])?;
                let patch = PatchInput {
                    program: self.value(member(input, "program", &what)?, used)?,
                    base: string_member(input, "base", &what)?,
                    ops: ops(input)?,
                    modules: self.modules(input.get("modules"), used)?,
                };
                Ok(if entry.door == Door::CheckPatch {
                    Input::CheckPatch(patch)
                } else {
                    Input::ApplyPatch(patch)
                })
            }
            Door::CheckSubprogram => {
                only_members(
                    input,
                    &what,
                    &[
                        "parent", "workflow", "number", "base", "ops", "lead", "room",
                    ],
                    &["modules"],
                )?;
                Ok(Input::CheckSubprogram {
                    parent: self.value(member(input, "parent", &what)?, used)?,
                    modules: self.modules(input.get("modules"), used)?,
                    workflow: string_member(input, "workflow", &what)?,
                    number: member(input, "number", &what)?
                        .as_i64()
                        .ok_or_else(|| format!("{what}: number is not an integer"))?,
                    base: string_member(input, "base", &what)?,
                    ops: ops(input)?,
                    lead: string_member(input, "lead", &what)?,
                    room: member(input, "room", &what)?,
                })
            }
            Door::CheckAmendment => {
                only_members(
                    input,
                    &what,
                    &["parent", "workflow"],
                    &["modules", "envelope"],
                )?;
                Ok(Input::CheckAmendment {
                    parent: self.value(member(input, "parent", &what)?, used)?,
                    modules: self.modules(input.get("modules"), used)?,
                    workflow: string_member(input, "workflow", &what)?,
                    envelope: input.get("envelope"),
                })
            }
            Door::ValidateLock => {
                only_members(input, &what, &[], &["value"])?;
                Ok(Input::ValidateLock {
                    value: input.get("value"),
                })
            }
            Door::AcsTarget => {
                only_members(input, &what, &["program"], &["modules", "lock"])?;
                Ok(Input::AcsTarget {
                    program: self.value(member(input, "program", &what)?, used)?,
                    modules: self.modules(input.get("modules"), used)?,
                    lock: input.get("lock").map(|k| self.value(k, used)).transpose()?,
                })
            }
            Door::DenialDiagnostics => {
                only_members(input, &what, &["program", "report"], &[])?;
                Ok(Input::DenialDiagnostics {
                    program: self.value(member(input, "program", &what)?, used)?,
                    report: member(input, "report", &what)?,
                })
            }
        }
    }
}

/// The number of parts a corpus file says it is one of.
fn parts_of(rel: &str) -> Result<usize, String> {
    let value = read_json(rel)?;
    count_member(as_object(&value, rel)?, "parts", rel)
}

/// One entry, as written.
fn read_entry(raw: &Value) -> Result<Entry, String> {
    let map = as_object(raw, "an entry")?;
    let id = string_member(map, "id", "an entry")?;
    let what = format!("the entry {id}");
    let door_name = string_member(map, "door", &what)?;
    let door = Door::from_name(door_name).ok_or_else(|| {
        format!("{what}: names the door \"{door_name}\", which this module does not know")
    })?;

    let outcome = match (map.get("result"), map.get("result_text"), map.get("throws")) {
        (Some(result), None, None) => Outcome::Result(result.clone()),
        (None, Some(text), None) => Outcome::ResultText(
            text.as_str()
                .ok_or_else(|| format!("{what}: result_text is not a string"))?
                .to_owned(),
        ),
        (None, None, Some(message)) => Outcome::Throws(
            message
                .as_str()
                .ok_or_else(|| format!("{what}: throws is not a string"))?
                .to_owned(),
        ),
        _ => {
            return Err(format!(
                "{what}: has not exactly one of result, result_text and throws"
            ));
        }
    };
    only_members(
        map,
        &what,
        &["id", "door", "files", "input"],
        &["result", "result_text", "throws"],
    )?;

    let mut files: Vec<String> = Vec::new();
    for file in member(map, "files", &what)?
        .as_array()
        .ok_or_else(|| format!("{what}: files is not an array"))?
    {
        files.push(
            file.as_str()
                .ok_or_else(|| format!("{what}: a file is not a string"))?
                .to_owned(),
        );
    }
    if files.is_empty() {
        return Err(format!("{what}: has no files"));
    }
    let mut sorted = files.clone();
    sort_utf16(&mut sorted);
    if sorted != files {
        return Err(format!("{what}: files are not in UTF-16 order"));
    }

    let input = member(map, "input", &what)?;
    let want = format!(
        "{}-{}",
        door.name(),
        key_of(&format!("{}\n{}", door.name(), compact(input)))
    );
    if want != id {
        return Err(format!(
            "{what}: the id of a {} call with this input is {want}",
            door.name()
        ));
    }
    Ok(Entry {
        id: id.to_owned(),
        door,
        files,
        input: input.clone(),
        outcome,
    })
}

// ---------------------------------------------------------------------------
// What a Rust door returned, as the corpus stores it

/// A digest, with the text it is the digest of, to show when it differs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preimage {
    /// What is hashed: `program`, `spans` or `module <name>`.
    pub label: String,
    /// `sha256:<hex>`.
    pub digest: String,
    /// The compact JSON text that was hashed.
    pub text: String,
}

/// A result as the corpus stores it, and the texts its digests stand for.
#[derive(Clone, Debug, PartialEq)]
pub struct Rendered {
    /// The stored form of the return value.
    pub value: JsValue,
    /// The texts hashed to make the digests in `value`.
    pub preimages: Vec<Preimage>,
}

/// What a call gave, for [`compare`]: a result, or the error it threw.
#[derive(Clone, Debug, PartialEq)]
pub enum Actual {
    /// A return value.
    Result(Rendered),
    /// The message of an error the door raised.
    Throws(String),
}

/// `sha256:` and the hex SHA-256 of a compact JSON `text`, hashed as UTF-8:
/// the digest of a program, a span table or a module.
#[must_use]
pub fn digest_of(text: &str) -> String {
    sha256(text)
}

/// A program's IR as `JSON.stringify` writes it, in the member order the
/// compiler built it (names that are array indices first, in numeric order,
/// which [`Value`] keeps).
#[must_use]
pub fn ir_text(program: &Value) -> String {
    stringify(&JsValue::from(program)).unwrap_or_default()
}

/// A span table as `[[pointer, [startLine, startCol, endLine, endCol]], ...]`
/// sorted by pointer in UTF-16 order, as `JSON.stringify` writes it. (A
/// `BTreeMap` of `String` sorts by UTF-8 bytes, which differs for
/// characters from U+E000 up.)
#[must_use]
pub fn spans_text(spans: &Spans) -> String {
    let mut rows: Vec<(&String, &mandate_ir::Span)> = spans.iter().collect();
    rows.sort_by(|a, b| compare_utf16(a.0, b.0));
    let rows: Vec<JsValue> = rows
        .into_iter()
        .map(|(pointer, span)| JsValue::Array(vec![JsValue::from(pointer.as_str()), span.to_js()]))
        .collect();
    stringify(&JsValue::Array(rows)).unwrap_or_default()
}

impl Rendered {
    /// A result that has no digest yet.
    #[must_use]
    pub fn new(value: JsValue) -> Rendered {
        Rendered {
            value,
            preimages: Vec::new(),
        }
    }

    /// The digest of `text`, noted under `label`, as a member value.
    pub fn digest(&mut self, label: &str, text: String) -> JsValue {
        let digest = digest_of(&text);
        self.preimages.push(Preimage {
            label: label.to_owned(),
            digest: digest.clone(),
            text,
        });
        JsValue::String(digest)
    }
}

/// The diagnostics as `JSON.stringify` writes them.
#[must_use]
pub fn diagnostics_js(diagnostics: &[Diagnostic]) -> JsValue {
    JsValue::Array(diagnostics.iter().map(Diagnostic::to_js).collect())
}

/// The result of `validate_lock` and `denial_diagnostics`: the array of
/// diagnostics.
#[must_use]
pub fn render_diagnostics(diagnostics: &[Diagnostic]) -> Rendered {
    Rendered::new(diagnostics_js(diagnostics))
}

/// The result of `load`: `{ program?, spans, diagnostics }`.
#[must_use]
pub fn render_load(loaded: &Loaded) -> Rendered {
    render_program_result(
        loaded.program.as_ref(),
        &loaded.spans,
        &loaded.diagnostics,
        &[],
    )
}

/// The result of `check`: `{ program?, spans, diagnostics, ok, hashes? }`.
/// `hashes` is `{ program, defs }` when the program checked.
#[must_use]
pub fn render_check(
    program: Option<&Value>,
    spans: &Spans,
    diagnostics: &[Diagnostic],
    ok: bool,
    hashes: Option<JsValue>,
) -> Rendered {
    let mut tail = vec![("ok", JsValue::Bool(ok))];
    if let Some(hashes) = hashes {
        tail.push(("hashes", hashes));
    }
    render_program_result(program, spans, diagnostics, &tail)
}

fn render_program_result(
    program: Option<&Value>,
    spans: &Spans,
    diagnostics: &[Diagnostic],
    tail: &[(&str, JsValue)],
) -> Rendered {
    let mut rendered = Rendered::new(JsValue::Undefined);
    let mut object = JsObject::new();
    if let Some(program) = program {
        object.insert("program", rendered.digest("program", ir_text(program)));
    }
    object.insert("spans", rendered.digest("spans", spans_text(spans)));
    object.insert("diagnostics", diagnostics_js(diagnostics));
    for (key, value) in tail {
        object.insert(*key, value.clone());
    }
    rendered.value = JsValue::Object(object);
    rendered
}

/// The result of `apply_patch`: `{ ok, diagnostics, governance, program?,
/// hash? }`, `governance` as the compiler gives it (a list of `{ kind, path,
/// detail }`) and `program`, when the patch was applied, as its digest.
#[must_use]
pub fn render_apply_patch(
    ok: bool,
    diagnostics: &[Diagnostic],
    governance: JsValue,
    program: Option<&Value>,
    hash: Option<&str>,
) -> Rendered {
    let mut rendered = Rendered::new(JsValue::Undefined);
    let mut object = JsObject::new()
        .with("ok", ok)
        .with("diagnostics", diagnostics_js(diagnostics))
        .with("governance", governance);
    if let Some(program) = program {
        object.insert("program", rendered.digest("program", ir_text(program)));
    }
    if let Some(hash) = hash {
        object.insert("hash", hash);
    }
    rendered.value = JsValue::Object(object);
    rendered
}

/// The result of `check_patch`: `{ ok, hash?, diagnostics, governance,
/// requires_approval, program? }`, `program` as its digest.
#[must_use]
pub fn render_check_patch(
    ok: bool,
    hash: Option<&str>,
    diagnostics: &[Diagnostic],
    governance: JsValue,
    requires_approval: bool,
    program: Option<&Value>,
) -> Rendered {
    let mut rendered = Rendered::new(JsValue::Undefined);
    let mut object = JsObject::new().with("ok", ok);
    if let Some(hash) = hash {
        object.insert("hash", hash);
    }
    object.insert("diagnostics", diagnostics_js(diagnostics));
    object.insert("governance", governance);
    object.insert("requires_approval", requires_approval);
    if let Some(program) = program {
        object.insert("program", rendered.digest("program", ir_text(program)));
    }
    rendered.value = JsValue::Object(object);
    rendered
}

/// The result of `check_subprogram`: `{ ok, diagnostics, program?, hash?,
/// workflow? }`, `program` as its digest.
#[must_use]
pub fn render_check_subprogram(
    ok: bool,
    diagnostics: &[Diagnostic],
    program: Option<&Value>,
    hash: Option<&str>,
    workflow: Option<&str>,
) -> Rendered {
    let mut rendered = Rendered::new(JsValue::Undefined);
    let mut object = JsObject::new()
        .with("ok", ok)
        .with("diagnostics", diagnostics_js(diagnostics));
    if let Some(program) = program {
        object.insert("program", rendered.digest("program", ir_text(program)));
    }
    if let Some(hash) = hash {
        object.insert("hash", hash);
    }
    if let Some(workflow) = workflow {
        object.insert("workflow", workflow);
    }
    rendered.value = JsValue::Object(object);
    rendered
}

/// The result of `check_amendment`: `{ ok, diagnostics, program?, hash? }`,
/// `program` as its digest.
#[must_use]
pub fn render_check_amendment(
    ok: bool,
    diagnostics: &[Diagnostic],
    program: Option<&Value>,
    hash: Option<&str>,
) -> Rendered {
    render_check_subprogram(ok, diagnostics, program, hash, None)
}

/// The result of `load_modules`: `{ modules: { <name>: digest, ... },
/// problems: [{ file, diagnostics }, ...] }`; `modules` in the order the
/// compiler built them, and `problems` as `(file, diagnostics)`.
#[must_use]
pub fn render_load_modules(
    modules: &[(&str, &Value)],
    problems: &[(&str, &[Diagnostic])],
) -> Rendered {
    let mut rendered = Rendered::new(JsValue::Undefined);
    let mut digests = JsObject::new();
    for (name, ir) in modules {
        let digest = rendered.digest(&format!("module {name}"), ir_text(ir));
        digests.insert(*name, digest);
    }
    let problems: Vec<JsValue> = problems
        .iter()
        .map(|(file, diagnostics)| {
            JsObject::new()
                .with("file", *file)
                .with("diagnostics", diagnostics_js(diagnostics))
                .into()
        })
        .collect();
    rendered.value = JsObject::new()
        .with("modules", digests)
        .with("problems", problems)
        .into();
    rendered
}

// ---------------------------------------------------------------------------
// The comparison

/// A line for a report: the start of a text, cut to `max` characters.
fn head(text: &str, max: usize) -> String {
    let start: String = text.chars().take(max).collect();
    if start.len() < text.len() {
        format!("{start:?}...")
    } else {
        format!("{start:?}")
    }
}

/// `Ok` when what a call gave in Rust is what it gave in TypeScript, byte
/// for byte as `JSON.stringify` writes it; else a message that names the
/// entry and the test files it came from and shows the first difference.
///
/// # Errors
///
/// The message.
pub fn compare(entry: &Entry, actual: &Actual) -> Result<(), String> {
    let wrong = |why: String| {
        Err(format!(
            "{} (from {})\n{why}",
            entry.id,
            entry.files.join(", ")
        ))
    };
    match (&entry.outcome, actual) {
        (Outcome::Throws(expected), Actual::Throws(actual)) => {
            if expected == actual {
                Ok(())
            } else {
                wrong(format!(
                    "both threw, with different messages\n    expected: {}\n    actual:   {}",
                    head(expected, 200),
                    head(actual, 200)
                ))
            }
        }
        (Outcome::Throws(expected), Actual::Result(_)) => wrong(format!(
            "TypeScript threw ({}), Rust returned a result",
            head(expected, 200)
        )),
        (_, Actual::Throws(actual)) => wrong(format!(
            "TypeScript returned a result, Rust threw ({})",
            head(actual, 200)
        )),
        (Outcome::ResultText(expected), Actual::Result(rendered)) => {
            let got = stringify(&rendered.value).unwrap_or_default();
            if *expected == got {
                Ok(())
            } else {
                wrong(first_difference(expected, &got).unwrap_or_default())
            }
        }
        (Outcome::Result(expected), Actual::Result(rendered)) => {
            let expected = JsValue::from(expected);
            if stringify(&expected) == stringify(&rendered.value) {
                return Ok(());
            }
            wrong(explain(&expected, rendered))
        }
    }
}

/// Where two results differ: each member of an object result that differs,
/// with its first differing line, and the start of every text whose digest
/// is not in the expected result.
fn explain(expected: &JsValue, actual: &Rendered) -> String {
    let pretty = |v: &JsValue| stringify_pretty(v).unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    match (expected.as_object(), actual.value.as_object()) {
        (Some(e), Some(a)) => {
            let mut names: Vec<&str> = e.keys().collect();
            for name in a.keys() {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
            if e.keys().ne(a.keys()) {
                let list = |o: &JsObject| o.keys().collect::<Vec<_>>().join(", ");
                lines.push(format!(
                    "members: expected [{}], actual [{}]",
                    list(e),
                    list(a)
                ));
            }
            for name in names {
                let text = |o: &JsObject| o.get(name).map(&pretty).unwrap_or_default();
                if let Some(difference) = first_difference(&text(e), &text(a)) {
                    lines.push(format!("{name}: {difference}"));
                }
            }
        }
        _ => {
            lines.push(
                first_difference(&pretty(expected), &pretty(&actual.value)).unwrap_or_default(),
            );
        }
    }
    let expected_text = stringify(expected).unwrap_or_default();
    for p in &actual.preimages {
        if !expected_text.contains(&format!("\"{}\"", p.digest)) {
            lines.push(format!(
                "Rust's {} hashes to {} ({} bytes), which begins {}",
                p.label,
                p.digest,
                p.text.len(),
                head(&p.text, 300)
            ));
        }
    }
    let mut out = String::new();
    for line in lines {
        let _ = writeln!(out, "  {line}");
    }
    out.trim_end().to_owned()
}
