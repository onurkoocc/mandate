//! Two doors of the runtime's use of connectors (spec/library.md "The lock
//! binding and schema digests", spec/attention.md "Carry-over from 0.6"),
//! which no TypeScript function of the compiler stands for: the TypeScript
//! compiler is frozen at 0.5. They are in the table
//! [`super::LIBRARY_DOORS`], committed as
//! `crates/mandate-check/tests/library_doors/doors.json`.
//!
//! - `tool_schema_digest` gives what `schemaDigest` of
//!   `runtime/src/mcp-client.ts` gives, byte for byte, which the vectors of
//!   `vectors/tool-schema-digest.json` (written from that function by
//!   `scripts/tool-digest-vectors.mjs`) hold it to
//!   (`crates/mandate-check/tests/connector_doors.rs`).
//! - `callable_connectors` gives the connectors E1407 demands a lock entry
//!   for, by the function that rule is made of
//!   ([`crate::lock::callable_connectors`]).

use std::collections::BTreeMap;
use std::fmt::Write as _;

use mandate_ir::{JsObject, JsValue, Value, sha256_of, write_number};

use super::DoorError;
use super::input::args;

/// How deep a tool's JSON may nest: a schema deeper than this is
/// `bad_input`. The runtime's own limit is the stack's.
const DEPTH: usize = 512;

/// The parameters of [`tool_schema_digest`].
pub(super) const TOOL_SCHEMA_DIGEST: &[&str] = &["tool"];

/// `tool_schema_digest`: the schema digest of an MCP tool, the lock's
/// `sha256:<hex>` of the canonical JSON of `{ name, inputSchema,
/// outputSchema }` as `tools/list` gives them (`schemaDigest`,
/// `runtime/src/mcp-client.ts`).
///
/// Input: `{ tool }`, `tool` the JSON text of the tool as the server sent
/// it, or as `JSON.stringify` writes it for the object the runtime holds.
/// It is a text, not an object, so that a number keeps the form a double
/// has in JSON (`1.0`, `1e2`, `0.1`), which a request cannot carry: the IR's
/// numbers are integers. The text is read as `JSON.parse` reads it (a
/// member given twice takes its last value; a lone surrogate escape stays),
/// and only the members `name`, `inputSchema` and `outputSchema` count; a
/// member that is not there is left out of the digested object, as the
/// function leaves out one that is `undefined`.
/// Output: the digest, a string.
pub(super) fn tool_schema_digest(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, TOOL_SCHEMA_DIGEST)?;
    let text = a.str("tool")?;
    let canonical = tool_canonical(text)
        .map_err(|e| DoorError::bad_input(format!("`tool` is not the JSON text of a tool: {e}")))?;
    Ok(JsValue::String(sha256_of(&canonical)))
}

/// The canonical text of what `schemaDigest` digests, for the JSON text of
/// a tool: its `inputSchema`, `name` and `outputSchema`, those that are
/// there, as `canonical` of `runtime/src/values.ts` writes them. The error
/// says what is wrong with the text.
///
/// # Errors
///
/// The text is not JSON, is not an object, or nests deeper than 512 levels.
pub fn tool_canonical(text: &str) -> Result<String, String> {
    let Json::Object(members) = Reader::new(text).document()? else {
        return Err("it is not an object".to_owned());
    };
    let kept: BTreeMap<Vec<u16>, Json> = members
        .into_iter()
        .filter(|(k, _)| {
            ["name", "inputSchema", "outputSchema"]
                .iter()
                .any(|n| k.iter().copied().eq(n.encode_utf16()))
        })
        .collect();
    let mut out = String::new();
    write_json(&mut out, &Json::Object(kept));
    Ok(out)
}

/// A JSON value as `JSON.parse` reads it: a number is a double, a string is
/// UTF-16 code units (so that a lone surrogate, which a Rust string cannot
/// hold, stays), an object keeps one member per name.
enum Json {
    Null,
    Bool(bool),
    Number(f64),
    Text(Vec<u16>),
    Array(Vec<Json>),
    Object(BTreeMap<Vec<u16>, Json>),
}

/// A reader of JSON text, by the grammar of RFC 8259.
struct Reader<'a> {
    text: &'a str,
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(text: &'a str) -> Reader<'a> {
        Reader { text, at: 0 }
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn bump(&mut self) {
        self.at = self.at.saturating_add(1);
    }

    fn fail(&self, what: &str) -> String {
        format!("{what} at byte {}", self.at)
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.bump();
        }
    }

    /// The whole text: one value, and nothing after it.
    fn document(&mut self) -> Result<Json, String> {
        let v = self.value(0)?;
        self.skip_space();
        if self.peek().is_some() {
            return Err(self.fail("there is text after the value"));
        }
        Ok(v)
    }

    fn value(&mut self, depth: usize) -> Result<Json, String> {
        if depth > DEPTH {
            return Err(format!("it nests deeper than {DEPTH} levels"));
        }
        self.skip_space();
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Json::Text),
            Some(b't') => self.word("true", Json::Bool(true)),
            Some(b'f') => self.word("false", Json::Bool(false)),
            Some(b'n') => self.word("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.fail("there is no JSON value")),
        }
    }

    fn word(&mut self, word: &str, value: Json) -> Result<Json, String> {
        let rest = self.text.as_bytes().get(self.at..).unwrap_or_default();
        if !rest.starts_with(word.as_bytes()) {
            return Err(self.fail("there is no JSON value"));
        }
        self.at = self.at.saturating_add(word.len());
        Ok(value)
    }

    fn digits(&mut self) -> usize {
        let mut n = 0_usize;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.bump();
            n = n.saturating_add(1);
        }
        n
    }

    /// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, as the double it
    /// rounds to.
    fn number(&mut self) -> Result<Json, String> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.bump();
        }
        match self.peek() {
            Some(b'0') => self.bump(),
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(self.fail("a number has no digits")),
        }
        if self.peek() == Some(b'.') {
            self.bump();
            if self.digits() == 0 {
                return Err(self.fail("a number has no digits after its point"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.bump();
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.bump();
            }
            if self.digits() == 0 {
                return Err(self.fail("a number has no digits in its exponent"));
            }
        }
        let lexeme = self.text.get(start..self.at).unwrap_or_default();
        lexeme
            .parse::<f64>()
            .map(Json::Number)
            .map_err(|_| self.fail("a number is malformed"))
    }

    fn hex4(&mut self) -> Result<u16, String> {
        let end = self.at.saturating_add(4);
        let digits = self.text.get(self.at..end).unwrap_or_default();
        if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(self.fail("a \\u escape has no four hexadecimal digits"));
        }
        self.at = end;
        u16::from_str_radix(digits, 16).map_err(|_| self.fail("a \\u escape is malformed"))
    }

    /// A string, its escapes read; a code unit that is a surrogate on its
    /// own stays one.
    fn string(&mut self) -> Result<Vec<u16>, String> {
        self.bump();
        let mut out: Vec<u16> = Vec::new();
        loop {
            let rest = self.text.get(self.at..).unwrap_or_default();
            let run = rest
                .find(|c: char| c == '"' || c == '\\' || c < '\u{20}')
                .unwrap_or(rest.len());
            out.extend(rest.get(..run).unwrap_or_default().encode_utf16());
            self.at = self.at.saturating_add(run);
            match self.peek() {
                Some(b'"') => {
                    self.bump();
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.bump();
                    let unit: u16 = match self.peek() {
                        Some(b'"') => 0x22,
                        Some(b'\\') => 0x5c,
                        Some(b'/') => 0x2f,
                        Some(b'b') => 0x08,
                        Some(b'f') => 0x0c,
                        Some(b'n') => 0x0a,
                        Some(b'r') => 0x0d,
                        Some(b't') => 0x09,
                        Some(b'u') => {
                            self.bump();
                            out.push(self.hex4()?);
                            continue;
                        }
                        _ => return Err(self.fail("a string has an escape JSON does not have")),
                    };
                    self.bump();
                    out.push(unit);
                }
                Some(_) => return Err(self.fail("a string has a control character")),
                None => return Err(self.fail("a string is not closed")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, String> {
        self.bump();
        let mut items = Vec::new();
        self.skip_space();
        if self.peek() == Some(b']') {
            self.bump();
            return Ok(Json::Array(items));
        }
        loop {
            items.push(self.value(depth.saturating_add(1))?);
            self.skip_space();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b']') => {
                    self.bump();
                    return Ok(Json::Array(items));
                }
                _ => return Err(self.fail("an array is not closed")),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, String> {
        self.bump();
        let mut members: BTreeMap<Vec<u16>, Json> = BTreeMap::new();
        self.skip_space();
        if self.peek() == Some(b'}') {
            self.bump();
            return Ok(Json::Object(members));
        }
        loop {
            self.skip_space();
            if self.peek() != Some(b'"') {
                return Err(self.fail("a member has no name"));
            }
            let name = self.string()?;
            self.skip_space();
            if self.peek() != Some(b':') {
                return Err(self.fail("a member has no colon"));
            }
            self.bump();
            let value = self.value(depth.saturating_add(1))?;
            // `JSON.parse`: a name given twice takes its last value.
            members.insert(name, value);
            self.skip_space();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b'}') => {
                    self.bump();
                    return Ok(Json::Object(members));
                }
                _ => return Err(self.fail("an object is not closed")),
            }
        }
    }
}

/// `canonical(v)` of `runtime/src/values.ts`: members sorted by their names'
/// UTF-16 code units, strings as `JSON.stringify` writes them, numbers as
/// ECMAScript writes them (`null` for one that is not finite, as
/// `JSON.stringify` does).
fn write_json(out: &mut String, v: &Json) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Number(x) if x.is_finite() => write_number(out, *x),
        Json::Number(_) => out.push_str("null"),
        Json::Text(t) => write_text(out, t),
        Json::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Json::Object(members) => {
            // The map is in the order of the names' UTF-16 code units.
            out.push('{');
            for (i, (name, item)) in members.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_text(out, name);
                out.push(':');
                write_json(out, item);
            }
            out.push('}');
        }
    }
}

/// A string as `JSON.stringify` writes it: a lone surrogate as its
/// `\u` escape, in lower case.
fn write_text(out: &mut String, units: &[u16]) {
    out.push('"');
    for r in char::decode_utf16(units.iter().copied()) {
        match r {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok(c) if c < ' ' => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            Ok(c) => out.push(c),
            Err(e) => {
                let _ = write!(out, "\\u{:04x}", e.unpaired_surrogate());
            }
        }
    }
    out.push('"');
}

/// The parameters of [`callable_connectors`].
pub(super) const CALLABLE_CONNECTORS: &[&str] = &["program", "modules"];

/// `callable_connectors`: the connectors a program can call, those E1407
/// demands a lock entry for (`crate::lock::callable_connectors`, the
/// function that rule is made of).
///
/// Input: `{ program, modules? }` as `link` takes them: the program as the
/// package has it (the one the check read, not its running program, whose
/// `defs` hold every definition of the modules it imports, agents and
/// workflows of them among them, which the check does not count) and the
/// modules it imports. Its patterns need not be expanded: what is read is
/// the capabilities of its workflows, envelopes and agents, which an
/// application leaves as they are.
/// Output: `[{ id, name }, …]`, each connector once, in the order found:
/// `id` is `<module>.<connector>`, the key of its entry in the lock's
/// `connectors`; `name` is the connector's name in the program.
pub(super) fn callable_connectors(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, CALLABLE_CONNECTORS)?;
    let program = a.program_view("program")?;
    let modules = a.opt_modules("modules")?;
    let linked = crate::modules::link(program, modules);
    Ok(JsValue::Array(
        crate::lock::callable_connectors(program, &linked.defs)
            .iter()
            .map(|(id, name)| {
                JsObject::new()
                    .with("id", id.as_str())
                    .with("name", name.as_str())
                    .into()
            })
            .collect(),
    ))
}
