//! The JSON doors of the compiler behind one function: [`answer`] takes a
//! request as JSON text and gives the answer as JSON text. It is what the
//! WebAssembly module of `mandate-wasm` runs for the Node runtime, and what
//! the native command line (`mandate-cli`) will stand on.
//!
//! # The table
//!
//! The doors are the two tables of the compiler's crates, merged:
//! `mandate_check::json_doors::DOORS` (reading, checking, hashing and
//! printing a program, its parts, the lock, the sandbox, patches and diffs,
//! the constants) and `mandate_views::json_doors::DOORS` (the views, the
//! documents with their Markdown and HTML, the card, the ACS target), then
//! the library doors of language 0.6, `mandate_check::json_doors::LIBRARY_DOORS`
//! (`library_verify`, `library_add`, `library_upgrade`, `library_publish`,
//! `authority_signature`, which no TypeScript function stands for), then
//! the one door of this crate, `doors`. [`tables`] gives the four, [`doors`]
//! every door in that order, and [`door`] finds one by name. No name is in
//! two tables; a test holds that. Each door keeps the contract that
//! `mandate_check::json_doors` states: a pure function from a JSON object to
//! a JSON value, named after the TypeScript function it stands for (a door
//! with none says what it answers in its note), whose output is what
//! `JSON.stringify` gives for that function's result.
//!
//! The door `doors` takes `{}` and gives the table as data, `{ "format":
//! "mandate/doors/0.1", "doors": [{ name, ts, params, note? }, …] }`, every
//! door in the order of [`doors`], itself last: so that a host can check, when
//! it loads the module, that the module has the doors it expects. It is the
//! three committed `doors.json` files, one after the other, and its own row.
//!
//! # The request and the answer
//!
//! A request is one JSON text, `{"door": "<name>", "input": <value>}`, read by
//! the strict rules of the IR's reader (no duplicate key, integers only within
//! ±(2^53−1), no negative zero, no lone surrogate; see `reader.rs`) within the
//! bounds of a request: at most [`MAX_REQUEST_BYTES`] bytes of UTF-8 and
//! [`MAX_REQUEST_DEPTH`] levels of nesting. The answer is one JSON text:
//!
//! - `{"ok":true,"output":<value>}`: the door's output, `null` where the
//!   TypeScript gives `undefined`;
//! - `{"ok":false,"error":{"kind":"<kind>","message":"<text>"}}`, the kind one
//!   of [`ErrorKind`]: `too_large` (longer than [`MAX_REQUEST_BYTES`]: refused
//!   before it is read), `bad_request` (not UTF-8, not JSON by the strict
//!   reader, not an object, without `door` or with a `door` that is not a
//!   string, without `input`, or with another member), `unknown_door` (no
//!   door has that name), or `bad_input` (the door refused the input, or the
//!   TypeScript function throws on it).
//!
//! The answer is written as `JSON.stringify` writes it (`mandate_ir::stringify`):
//! no white space, members in the order of the value, strings escaped as
//! JavaScript escapes them (a control character as `\u001f`, or `\n` and its
//! kind). [`answer`] never panics, and the same request text gives the same
//! answer text: it reads no file, environment, clock, network or randomness.
//!
//! [`call`] is the same without the text of the answer: the output value or
//! the [`Refusal`], for a native caller; [`written`] writes either as
//! [`answer`] does.
//!
//! ```
//! let ok = mandate_doors::answer(r#"{"door":"canonicalize","input":{"value":{"b":1,"a":[true]}}}"#);
//! assert_eq!(ok, r#"{"ok":true,"output":"{\"a\":[true],\"b\":1}"}"#);
//! let no = mandate_doors::answer(r#"{"door":"nothing","input":{}}"#);
//! assert_eq!(no, r#"{"ok":false,"error":{"kind":"unknown_door","message":"no door is named `nothing`"}}"#);
//! ```
//!
//! Like the other library crates, it reads no file, environment variable or
//! clock and starts no process; it builds for `wasm32-wasip1`.

#![forbid(unsafe_code)]

use mandate_check::json_doors::input::{args, type_name};
use mandate_ir::{JsObject, JsValue, Value, stringify};

pub use mandate_check::json_doors::{Door, DoorError, DoorErrorKind, DoorFn};

mod reader;

/// The longest request, in bytes of UTF-8 (32 MiB). A longer one is
/// `too_large`, refused before it is read.
pub const MAX_REQUEST_BYTES: usize = 33_554_432;

/// The deepest nesting a request may have: the request object is at depth 1
/// and each member or item one deeper. Twice the 64 levels a program's
/// source may have, so that a program read from its source fits in a
/// request with room for what holds it (a request, its input, an options
/// object, the modules by name). Deeper is `bad_request`.
pub const MAX_REQUEST_DEPTH: usize = 128;

/// The format of the table the door `doors` gives.
pub const DOORS_FORMAT: &str = "mandate/doors/0.1";

/// What kind of failure an answer reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    /// The request is longer than [`MAX_REQUEST_BYTES`].
    TooLarge,
    /// The request is not UTF-8, not JSON, or not `{ door, input }`.
    BadRequest,
    /// No door has the name the request gives.
    UnknownDoor,
    /// The door refused its input.
    BadInput,
}

impl ErrorKind {
    /// Its name in the answer: `too_large`, `bad_request`, `unknown_door` or
    /// `bad_input`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorKind::TooLarge => "too_large",
            ErrorKind::BadRequest => "bad_request",
            ErrorKind::UnknownDoor => "unknown_door",
            ErrorKind::BadInput => "bad_input",
        }
    }
}

/// A request that was not answered with an output: its kind and a message
/// for a person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    /// What kind of failure.
    pub kind: ErrorKind,
    /// What was wrong.
    pub message: String,
}

impl Refusal {
    /// A refusal of `kind` with `message`.
    #[must_use]
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Refusal {
        Refusal {
            kind,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Refusal {
        Refusal::new(ErrorKind::BadRequest, message)
    }
}

impl From<DoorError> for Refusal {
    fn from(e: DoorError) -> Refusal {
        let kind = match e.kind {
            DoorErrorKind::BadInput => ErrorKind::BadInput,
        };
        Refusal::new(kind, e.message)
    }
}

/// The note of the door `doors`.
const DOORS_NOTE: &str = "The doors of the module, as data: { format: \"mandate/doors/0.1\", doors: [{ name, ts, params, note? }] }, every door of the checker's table, then of the views', then of the library doors of 0.6, then this one, in their order; the three tables are the doors.json files of crates/mandate-check (tests/json_doors and tests/library_doors) and crates/mandate-views. A host checks with it, when it loads the module, that the module has the doors it expects.";

/// The doors of this crate: `doors`.
static OWN: &[Door] = &[Door::own("doors", &[], DOORS_NOTE, doors_door)];

/// The four tables, in order: the checker's, the views', the library doors
/// of language 0.6 (`mandate_check::json_doors::LIBRARY_DOORS`, which no
/// TypeScript function stands for), and this crate's own (`doors`).
#[must_use]
pub fn tables() -> [&'static [Door]; 4] {
    [
        mandate_check::json_doors::DOORS,
        mandate_views::json_doors::DOORS,
        mandate_check::json_doors::LIBRARY_DOORS,
        OWN,
    ]
}

/// Every door, in the order of [`tables`].
pub fn doors() -> impl Iterator<Item = &'static Door> {
    tables().into_iter().flatten()
}

/// The door named `name`.
#[must_use]
pub fn door(name: &str) -> Option<&'static Door> {
    doors().find(|d| d.name == name)
}

/// The table as data: what the door `doors` gives.
#[must_use]
pub fn table() -> JsValue {
    let rows: Vec<JsValue> = doors()
        .map(|d| {
            JsObject::new()
                .with("name", d.name)
                .with("ts", d.ts.map_or(JsValue::Null, JsValue::from))
                .with(
                    "params",
                    JsValue::Array(d.params.iter().map(|p| JsValue::from(*p)).collect()),
                )
                .with_some("note", d.note)
                .into()
        })
        .collect();
    JsObject::new()
        .with("format", DOORS_FORMAT)
        .with("doors", rows)
        .into()
}

/// The door `doors`: input `{}`, output [`table`].
fn doors_door(input: &Value) -> Result<JsValue, DoorError> {
    args(input, &[])?;
    Ok(table())
}

/// At most 80 characters of `name`, for a message.
fn shown(name: &str) -> String {
    match name.char_indices().nth(80) {
        Some((i, _)) => format!("{}…", name.get(..i).unwrap_or_default()),
        None => name.to_owned(),
    }
}

/// The request's door and input, or why it is not a request.
fn parts(request: &Value) -> Result<(&str, &Value), Refusal> {
    let Value::Object(members) = request else {
        return Err(Refusal::bad_request(format!(
            "the request is {}, not an object",
            type_name(request)
        )));
    };
    if let Some(other) = members.keys().find(|k| *k != "door" && *k != "input") {
        return Err(Refusal::bad_request(format!(
            "the request has a member `{}`: a request has only `door` and `input`",
            shown(other)
        )));
    }
    let name = match members.get("door") {
        None => return Err(Refusal::bad_request("the request has no `door`")),
        Some(Value::String(name)) => name.as_str(),
        Some(other) => {
            return Err(Refusal::bad_request(format!(
                "`door` is {}, not a string",
                type_name(other)
            )));
        }
    };
    let input = members
        .get("input")
        .ok_or_else(|| Refusal::bad_request("the request has no `input`"))?;
    Ok((name, input))
}

/// The answer to `request` as a value: the door's output, or the refusal.
///
/// # Errors
///
/// A [`Refusal`] of each [`ErrorKind`], as the crate's documentation says.
pub fn call_bytes(request: &[u8]) -> Result<JsValue, Refusal> {
    if request.len() > MAX_REQUEST_BYTES {
        return Err(Refusal::new(
            ErrorKind::TooLarge,
            format!(
                "the request is longer than {MAX_REQUEST_BYTES} bytes, the most a request may be"
            ),
        ));
    }
    let text = std::str::from_utf8(request).map_err(|e| {
        Refusal::bad_request(format!(
            "the request is not UTF-8: at byte {}",
            e.valid_up_to()
        ))
    })?;
    let value = reader::read(text).map_err(|e| {
        Refusal::bad_request(format!(
            "the request is not JSON: {} at byte {}",
            e.what, e.at
        ))
    })?;
    let (name, input) = parts(&value)?;
    let d = door(name).ok_or_else(|| {
        Refusal::new(
            ErrorKind::UnknownDoor,
            format!("no door is named `{}`", shown(name)),
        )
    })?;
    match (d.call)(input)? {
        JsValue::Undefined => Ok(JsValue::Null),
        output => Ok(output),
    }
}

/// [`call_bytes`] of a request that is text.
///
/// # Errors
///
/// As [`call_bytes`].
pub fn call(request: &str) -> Result<JsValue, Refusal> {
    call_bytes(request.as_bytes())
}

/// The text of an answer: `{"ok":true,"output":…}` or
/// `{"ok":false,"error":{"kind":…,"message":…}}`, as `JSON.stringify`
/// writes it.
#[must_use]
pub fn written(answer: Result<JsValue, Refusal>) -> String {
    let value: JsValue = match answer {
        Ok(output) => JsObject::new()
            .with("ok", true)
            .with(
                "output",
                if output.is_undefined() {
                    JsValue::Null
                } else {
                    output
                },
            )
            .into(),
        Err(r) => JsObject::new()
            .with("ok", false)
            .with(
                "error",
                JsObject::new()
                    .with("kind", r.kind.as_str())
                    .with("message", r.message),
            )
            .into(),
    };
    // An object is never `undefined`, so there is always a text.
    stringify(&value).unwrap_or_default()
}

/// The answer to the request whose bytes are `request`, as JSON text.
#[must_use]
pub fn answer_bytes(request: &[u8]) -> String {
    written(call_bytes(request))
}

/// The answer to `request`, as JSON text: the function the module runs.
#[must_use]
pub fn answer(request: &str) -> String {
    answer_bytes(request.as_bytes())
}
