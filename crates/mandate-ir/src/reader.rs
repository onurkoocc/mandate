//! The strict JSON reader for IR input (Doc 4 §3.4, §3.5): a port of
//! `compiler/src/json/strict-json.ts`.
//!
//! It refuses what `JSON.parse` would silently change: a duplicate object key
//! (E0102), a number that is not an integer within ±(2^53−1) or is negative
//! zero (E0106), a string with a lone surrogate (E0107). It bounds the input's
//! size and nesting (E0105), and anything else that is not JSON is E0108.
//! Each refusal is one diagnostic with the TypeScript reader's code, message,
//! JSON Pointer and span.
//!
//! The reader walks the text as UTF-16 code units, as the TypeScript one walks
//! an ECMAScript string. Columns count code units, and a message that quotes
//! "the character found" quotes one code unit. When that unit is half of a
//! surrogate pair, the TypeScript message holds a lone surrogate, which a Rust
//! string cannot; this reader writes U+FFFD there, which is what the
//! TypeScript message becomes when it is written out as UTF-8.

use std::collections::{BTreeMap, HashSet};

use crate::diag::{Diagnostic, Location, Span, ptr_token};
use crate::limits::{JSON_DEPTH, SOURCE_BYTES};
use crate::value::{Int, Map, Value};

/// A value that was read, with the source span of every value in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    /// The value.
    pub value: Value,
    /// Each value's span, by its JSON Pointer (`""` is the whole value).
    pub spans: BTreeMap<String, Span>,
}

/// Reads `text` as strict JSON: `parseStrictJson` in `strict-json.ts`.
///
/// # Errors
///
/// The diagnostics when `text` is refused. There is exactly one, as in
/// TypeScript; it is a list so that a caller can treat it like any other
/// phase's diagnostics.
pub fn parse(text: &str) -> Result<Parsed, Vec<Diagnostic>> {
    if text.len() > SOURCE_BYTES {
        let mut facts = Map::new();
        facts.insert("limit", Int::from_usize_saturating(SOURCE_BYTES));
        facts.insert("actual", Int::from_usize_saturating(text.len()));
        return Err(vec![Diagnostic::new(
            "E0105",
            format!("Input exceeds the {SOURCE_BYTES}-byte source limit."),
            Location::default(),
            Some(facts),
        )]);
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut reader = Reader {
        src: &units,
        pos: 0,
        line: 1,
        col: 1,
        spans: BTreeMap::new(),
    };
    reader.read().map_err(|d| vec![*d])
}

/// Reads file bytes as strict JSON, decoding them as the TypeScript CLI does
/// (`readFileSync(file, "utf8")`): a byte order mark is kept, so it is refused
/// as an unexpected character, and each ill-formed UTF-8 sequence becomes
/// U+FFFD (the WHATWG and Unicode "maximal subpart" replacement, which Node
/// and [`String::from_utf8_lossy`] both use). The size limit applies to the
/// decoded text, as it does there.
///
/// # Errors
///
/// As [`parse`].
pub fn parse_bytes(bytes: &[u8]) -> Result<Parsed, Vec<Diagnostic>> {
    parse(&String::from_utf8_lossy(bytes))
}

type Fail = Box<Diagnostic>;

const LF: u16 = 0x0a;
const CR: u16 = 0x0d;
const TAB: u16 = 0x09;
const SPACE: u16 = 0x20;
const QUOTE: u16 = 0x22;
const BACKSLASH: u16 = 0x5c;

/// The character a message quotes for one code unit; U+FFFD for a surrogate.
fn unit_char(unit: u16) -> char {
    char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}')
}

fn is_digit(unit: Option<u16>) -> bool {
    matches!(unit, Some(0x30..=0x39))
}

fn hex_value(unit: u16) -> Option<u16> {
    match unit {
        0x30..=0x39 => unit.checked_sub(0x30),
        0x41..=0x46 => unit.checked_sub(0x37),
        0x61..=0x66 => unit.checked_sub(0x57),
        _ => None,
    }
}

struct Reader<'a> {
    src: &'a [u16],
    pos: usize,
    line: usize,
    col: usize,
    spans: BTreeMap<String, Span>,
}

impl Reader<'_> {
    fn read(&mut self) -> Result<Parsed, Fail> {
        self.ws();
        let value = self.value("", 1)?;
        self.ws();
        if !self.eof() {
            return Err(self.fail(
                "E0108",
                "Unexpected content after the top-level JSON value.",
                None,
                None,
            ));
        }
        Ok(Parsed {
            value,
            spans: std::mem::take(&mut self.spans),
        })
    }

    fn eof(&self) -> bool {
        self.pos >= self.src.len()
    }

    fn fail(
        &self,
        code: &str,
        message: impl Into<String>,
        path: Option<&str>,
        facts: Option<Map>,
    ) -> Fail {
        let at = Location {
            def: None,
            path: path.map(str::to_owned),
            span: Some(Span {
                start_line: self.line,
                start_col: self.col,
                end_line: self.line,
                end_col: self.col.saturating_add(1),
            }),
        };
        Box::new(Diagnostic::new(code, message, at, facts))
    }

    fn peek(&self) -> Option<u16> {
        self.src.get(self.pos).copied()
    }

    fn at(&self, offset: usize) -> Option<u16> {
        self.src.get(self.pos.checked_add(offset)?).copied()
    }

    /// Moves one code unit on; past the end it still counts a column, as the
    /// TypeScript reader does.
    fn advance(&mut self) -> Option<u16> {
        let unit = self.peek();
        self.pos = self.pos.saturating_add(1);
        if unit == Some(LF) {
            self.line = self.line.saturating_add(1);
            self.col = 1;
        } else {
            self.col = self.col.saturating_add(1);
        }
        unit
    }

    fn advance_by(&mut self, n: usize) {
        for _ in 0..n {
            self.advance();
        }
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(SPACE | TAB | LF | CR)) {
            self.advance();
        }
    }

    fn describe(&self) -> String {
        match self.peek() {
            None => "end of input".to_owned(),
            Some(unit) => format!("'{}'", unit_char(unit)),
        }
    }

    fn expect(&mut self, ch: u8) -> Result<(), Fail> {
        if self.peek() != Some(u16::from(ch)) {
            let message = format!(
                "Expected '{}' but found {}.",
                char::from(ch),
                self.describe()
            );
            return Err(self.fail("E0108", message, None, None));
        }
        self.advance();
        Ok(())
    }

    fn starts_with(&self, word: &str) -> bool {
        let mut at = self.pos;
        for unit in word.encode_utf16() {
            if self.src.get(at) != Some(&unit) {
                return false;
            }
            at = at.saturating_add(1);
        }
        true
    }

    fn value(&mut self, path: &str, depth: usize) -> Result<Value, Fail> {
        if depth > JSON_DEPTH {
            let mut facts = Map::new();
            facts.insert("limit", Int::from_usize_saturating(JSON_DEPTH));
            let message = format!("JSON nesting exceeds the depth limit of {JSON_DEPTH}.");
            return Err(self.fail("E0105", message, Some(path), Some(facts)));
        }
        let (start_line, start_col) = (self.line, self.col);
        let value = self.value_inner(path, depth)?;
        let span = Span {
            start_line,
            start_col,
            end_line: self.line,
            end_col: self.col,
        };
        self.spans.insert(path.to_owned(), span);
        Ok(value)
    }

    fn value_inner(&mut self, path: &str, depth: usize) -> Result<Value, Fail> {
        match self.peek() {
            Some(0x7b) => return self.object(path, depth).map(Value::Object),
            Some(0x5b) => return self.array(path, depth).map(Value::Array),
            Some(QUOTE) => return self.string(path).map(Value::String),
            Some(0x2d | 0x30..=0x39) => return self.number(path).map(Value::Number),
            _ => {}
        }
        for (word, value) in [
            ("true", Value::Bool(true)),
            ("false", Value::Bool(false)),
            ("null", Value::Null),
        ] {
            if self.starts_with(word) {
                self.advance_by(word.len());
                return Ok(value);
            }
        }
        let message = format!(
            "Unexpected {} where a JSON value was expected.",
            self.describe()
        );
        Err(self.fail("E0108", message, Some(path), None))
    }

    fn object(&mut self, path: &str, depth: usize) -> Result<Map, Fail> {
        self.expect(b'{')?;
        let mut out = Map::new();
        let mut seen: HashSet<String> = HashSet::new();
        self.ws();
        if self.peek() == Some(0x7d) {
            self.advance();
            return Ok(out);
        }
        let inner = depth.saturating_add(1);
        loop {
            self.ws();
            if self.peek() != Some(QUOTE) {
                let message = format!("Expected an object key but found {}.", self.describe());
                return Err(self.fail("E0108", message, Some(path), None));
            }
            let (key_line, key_col) = (self.line, self.col);
            let key = self.string(path)?;
            let member = format!("{path}/{}", ptr_token(&key));
            if seen.contains(&key) {
                let mut facts = Map::new();
                facts.insert("key", key.as_str());
                let at = Location {
                    def: None,
                    path: Some(member),
                    span: Some(Span {
                        start_line: key_line,
                        start_col: key_col,
                        end_line: self.line,
                        end_col: self.col,
                    }),
                };
                let message = format!(
                    "Duplicate object key \"{key}\". Duplicate keys are rejected before schema validation."
                );
                return Err(Box::new(Diagnostic::new("E0102", message, at, Some(facts))));
            }
            seen.insert(key.clone());
            self.ws();
            self.expect(b':')?;
            self.ws();
            let value = self.value(&member, inner)?;
            out.push_new(key, value);
            self.ws();
            if self.peek() == Some(0x2c) {
                self.advance();
                continue;
            }
            self.expect(b'}')?;
            return Ok(out);
        }
    }

    fn array(&mut self, path: &str, depth: usize) -> Result<Vec<Value>, Fail> {
        self.expect(b'[')?;
        let mut out = Vec::new();
        self.ws();
        if self.peek() == Some(0x5d) {
            self.advance();
            return Ok(out);
        }
        let inner = depth.saturating_add(1);
        loop {
            self.ws();
            let element = format!("{path}/{}", out.len());
            out.push(self.value(&element, inner)?);
            self.ws();
            if self.peek() == Some(0x2c) {
                self.advance();
                continue;
            }
            self.expect(b']')?;
            return Ok(out);
        }
    }

    fn string(&mut self, path: &str) -> Result<String, Fail> {
        self.expect(b'"')?;
        let mut out: Vec<u16> = Vec::new();
        loop {
            let Some(unit) = self.peek() else {
                return Err(self.fail("E0108", "Unterminated string.", Some(path), None));
            };
            self.advance();
            if unit == QUOTE {
                break;
            }
            if unit == BACKSLASH {
                let escape = self.advance();
                let decoded = match escape {
                    Some(c @ (QUOTE | BACKSLASH | 0x2f)) => c,
                    Some(0x62) => 0x08,
                    Some(0x66) => 0x0c,
                    Some(0x6e) => LF,
                    Some(0x72) => CR,
                    Some(0x74) => TAB,
                    Some(0x75) => {
                        let Some(code) = self.hex4() else {
                            return Err(self.fail(
                                "E0108",
                                "Invalid \\u escape.",
                                Some(path),
                                None,
                            ));
                        };
                        self.advance_by(4);
                        code
                    }
                    other => {
                        let shown = other.map(|u| unit_char(u).to_string()).unwrap_or_default();
                        let message = format!("Invalid escape '\\{shown}'.");
                        return Err(self.fail("E0108", message, Some(path), None));
                    }
                };
                out.push(decoded);
                continue;
            }
            if unit < SPACE {
                return Err(self.fail(
                    "E0108",
                    "Unescaped control character in string.",
                    Some(path),
                    None,
                ));
            }
            out.push(unit);
        }
        String::from_utf16(&out).map_err(|_| {
            self.fail(
                "E0107",
                "String contains a lone surrogate; it has no canonical (JCS) encoding.",
                Some(path),
                None,
            )
        })
    }

    /// The four hex digits at the current position, as a code unit.
    fn hex4(&self) -> Option<u16> {
        let mut code: u16 = 0;
        for offset in 0..4 {
            let digit = hex_value(self.at(offset)?)?;
            code = code.checked_mul(16)?.checked_add(digit)?;
        }
        Some(code)
    }

    fn number(&mut self, path: &str) -> Result<Int, Fail> {
        // The lexeme of /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.
        let negative = self.peek() == Some(0x2d);
        let mut len = usize::from(negative);
        match self.at(len) {
            Some(0x30) => len = len.saturating_add(1),
            Some(0x31..=0x39) => {
                len = len.saturating_add(1);
                while is_digit(self.at(len)) {
                    len = len.saturating_add(1);
                }
            }
            _ => return Err(self.fail("E0108", "Malformed number.", Some(path), None)),
        }
        let integer_end = len;
        let mut integral = true;
        if self.at(len) == Some(0x2e) && is_digit(self.at(len.saturating_add(1))) {
            len = len.saturating_add(2);
            while is_digit(self.at(len)) {
                len = len.saturating_add(1);
            }
            integral = false;
        }
        if matches!(self.at(len), Some(0x45 | 0x65)) {
            let mut end = len.saturating_add(1);
            if matches!(self.at(end), Some(0x2b | 0x2d)) {
                end = end.saturating_add(1);
            }
            if is_digit(self.at(end)) {
                while is_digit(self.at(end)) {
                    end = end.saturating_add(1);
                }
                len = end;
                integral = false;
            }
        }
        let lexeme = self.lexeme(len);
        let lexeme_facts = || {
            let mut facts = Map::new();
            facts.insert("lexeme", lexeme.as_str());
            Some(facts)
        };
        if !integral {
            let message = format!(
                "Number {lexeme} is not an integer. IR numbers are integers; write decimals as strings and money as integer micro-units."
            );
            return Err(self.fail("E0106", message, Some(path), lexeme_facts()));
        }
        let digits = lexeme
            .get(usize::from(negative)..integer_end)
            .unwrap_or_default();
        let magnitude = digits.bytes().try_fold(0_i64, |acc, b| {
            acc.checked_mul(10)?
                .checked_add(i64::from(b.checked_sub(b'0')?))
        });
        let signed = magnitude.and_then(|m| if negative { m.checked_neg() } else { Some(m) });
        let Some(n) = signed.and_then(Int::new) else {
            let message = format!("Integer {lexeme} is outside ±(2^53−1).");
            return Err(self.fail("E0106", message, Some(path), lexeme_facts()));
        };
        if negative && n.get() == 0 {
            return Err(self.fail(
                "E0106",
                "Negative zero is not allowed; write 0.",
                Some(path),
                lexeme_facts(),
            ));
        }
        self.advance_by(len);
        Ok(n)
    }

    /// The `len` code units at the current position as text; a number's
    /// lexeme is ASCII.
    fn lexeme(&self, len: usize) -> String {
        let end = self.pos.saturating_add(len);
        self.src
            .get(self.pos..end)
            .map(String::from_utf16_lossy)
            .unwrap_or_default()
    }
}
