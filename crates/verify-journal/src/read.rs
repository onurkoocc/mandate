//! Reading an export's bytes as JSON, by the rules and limits of
//! spec/journal.md "Reading an export".
//!
//! This is not the IR's reader ([`mandate_ir::parse`]): an export holds
//! whatever a run journaled, so numbers may have fractions and exponents and
//! are read as `JSON.parse` reads them, and its limits are the export's
//! (64 MiB, 256 arrays and objects deep), not the IR's.
//!
//! The rules are checked in the order the spec gives: the size first, then
//! that the whole is UTF-8, then the JSON text from its start. The first rule
//! broken is the one reported, so a text that nests too deep before it is
//! malformed is over the limit, and one malformed before it nests too deep is
//! malformed. A duplicate member name is found where the second name ends,
//! before its value is read.

use std::collections::HashSet;

use crate::json::Json;

/// The largest export a verifier reads, in bytes (64 MiB). Rule 1.
pub const EXPORT_BYTES: usize = 64 * 1024 * 1024;

/// The deepest nesting of arrays and objects a verifier reads, the outermost
/// counting as one. Rule 4.
pub const EXPORT_DEPTH: usize = 256;

/// Why an export could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// Larger or deeper than the limits: `export_over_limit`.
    OverLimit(String),
    /// Any other rule broken: `malformed_export`.
    Malformed(String),
}

impl ReadError {
    /// What was found, for a person.
    #[must_use]
    pub fn problem(&self) -> &str {
        match self {
            ReadError::OverLimit(p) | ReadError::Malformed(p) => p,
        }
    }
}

/// Reads `bytes` as one JSON text by rules 1 to 7 of "Reading an export".
///
/// # Errors
///
/// [`ReadError::OverLimit`] when the bytes are larger than [`EXPORT_BYTES`]
/// or nest deeper than [`EXPORT_DEPTH`]; [`ReadError::Malformed`] when they
/// break any other rule.
pub fn read_json(bytes: &[u8]) -> Result<Json, ReadError> {
    if bytes.len() > EXPORT_BYTES {
        return Err(ReadError::OverLimit(format!(
            "an export of {} bytes, larger than {EXPORT_BYTES}",
            bytes.len()
        )));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|e| ReadError::Malformed(format!("not UTF-8 at byte {}", e.valid_up_to())))?;
    let mut reader = Reader { text, pos: 0 };
    reader.ws();
    let value = reader.value(0)?;
    reader.ws();
    if reader.pos < text.len() {
        return Err(reader.malformed("content after the value"));
    }
    Ok(value)
}

struct Reader<'a> {
    text: &'a str,
    /// A byte offset into `text`, always at a character boundary when a
    /// slice is taken.
    pos: usize,
}

impl Reader<'_> {
    fn malformed(&self, what: &str) -> ReadError {
        ReadError::Malformed(format!("{what} at byte {}", self.pos))
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    fn at(&self, offset: usize) -> Option<u8> {
        self.text
            .as_bytes()
            .get(self.pos.checked_add(offset)?)
            .copied()
    }

    fn bump(&mut self, n: usize) {
        self.pos = self.pos.saturating_add(n);
    }

    /// Rule 3: white space is space, tab, line feed and carriage return.
    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.bump(1);
        }
    }

    /// A value whose enclosing arrays and objects number `depth`.
    fn value(&mut self, depth: usize) -> Result<Json, ReadError> {
        self.ws();
        match self.peek() {
            Some(open @ (b'[' | b'{')) => {
                if depth >= EXPORT_DEPTH {
                    return Err(ReadError::OverLimit(format!(
                        "nesting deeper than {EXPORT_DEPTH} at byte {}",
                        self.pos
                    )));
                }
                self.bump(1);
                if open == b'[' {
                    self.array(depth)
                } else {
                    self.object(depth)
                }
            }
            Some(b'"') => self.string().map(Json::String),
            Some(b't') => self.word("true", Json::Bool(true)),
            Some(b'f') => self.word("false", Json::Bool(false)),
            Some(b'n') => self.word("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(self.malformed("no value")),
        }
    }

    fn word(&mut self, word: &str, value: Json) -> Result<Json, ReadError> {
        let rest = self.text.as_bytes().get(self.pos..).unwrap_or_default();
        if rest.starts_with(word.as_bytes()) {
            self.bump(word.len());
            Ok(value)
        } else {
            Err(self.malformed("no value"))
        }
    }

    /// After `[`.
    fn array(&mut self, depth: usize) -> Result<Json, ReadError> {
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.bump(1);
            return Ok(Json::Array(items));
        }
        let inner = depth.saturating_add(1);
        loop {
            items.push(self.value(inner)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.bump(1),
                Some(b']') => {
                    self.bump(1);
                    return Ok(Json::Array(items));
                }
                _ => return Err(self.malformed("a list without , or ]")),
            }
        }
    }

    /// After `{`. Rule 5: no two members of one name, compared once their
    /// escapes are read; `__proto__` is a name like any other.
    fn object(&mut self, depth: usize) -> Result<Json, ReadError> {
        let mut members: Vec<(String, Json)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.bump(1);
            return Ok(Json::Object(members));
        }
        let inner = depth.saturating_add(1);
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(self.malformed("an object without a member name"));
            }
            let name = self.string()?;
            if !seen.insert(name.clone()) {
                return Err(self.malformed(&format!("a duplicate member {name:?}")));
            }
            self.ws();
            if self.peek() != Some(b':') {
                return Err(self.malformed("a member without :"));
            }
            self.bump(1);
            let value = self.value(inner)?;
            members.push((name, value));
            self.ws();
            match self.peek() {
                Some(b',') => self.bump(1),
                Some(b'}') => {
                    self.bump(1);
                    return Ok(Json::Object(members));
                }
                _ => return Err(self.malformed("an object without , or }")),
            }
        }
    }

    /// At `"`. Rule 6: the escapes of RFC 8259 only; no lone surrogate,
    /// escaped or not (an unescaped one is not UTF-8, so it never gets here);
    /// no unescaped code point below U+0020.
    fn string(&mut self) -> Result<String, ReadError> {
        self.bump(1);
        let mut out = String::new();
        loop {
            // Copy the run of characters up to the next quote, backslash or
            // control character. Those are ASCII, so the run ends at a
            // character boundary.
            let start = self.pos;
            while matches!(self.peek(), Some(b) if b != b'"' && b != b'\\' && b >= 0x20) {
                self.bump(1);
            }
            out.push_str(self.text.get(start..self.pos).unwrap_or_default());
            match self.peek() {
                None => return Err(self.malformed("an unterminated string")),
                Some(b'"') => {
                    self.bump(1);
                    return Ok(out);
                }
                Some(b'\\') => {
                    let escape = self.at(1);
                    self.bump(2);
                    let c = match escape {
                        Some(b'"') => '"',
                        Some(b'\\') => '\\',
                        Some(b'/') => '/',
                        Some(b'b') => '\u{08}',
                        Some(b'f') => '\u{0c}',
                        Some(b'n') => '\n',
                        Some(b'r') => '\r',
                        Some(b't') => '\t',
                        Some(b'u') => self.unicode_escape()?,
                        _ => return Err(self.malformed("an unknown escape")),
                    };
                    out.push(c);
                }
                Some(_) => return Err(self.malformed("a control character in a string")),
            }
        }
    }

    /// After `\u`: four hex digits, and for a high surrogate the `\u` escape
    /// of a low surrogate after it.
    fn unicode_escape(&mut self) -> Result<char, ReadError> {
        let unit = self.hex4()?;
        if (0xd800..=0xdbff).contains(&unit) {
            if self.peek() != Some(b'\\') || self.at(1) != Some(b'u') {
                return Err(self.malformed("a lone surrogate"));
            }
            self.bump(2);
            let low = self.hex4()?;
            if !(0xdc00..=0xdfff).contains(&low) {
                return Err(self.malformed("a lone surrogate"));
            }
            let code = unit
                .checked_sub(0xd800)
                .and_then(|high| high.checked_mul(0x400))
                .and_then(|high| high.checked_add(low.checked_sub(0xdc00)?))
                .and_then(|bits| bits.checked_add(0x1_0000))
                .and_then(char::from_u32);
            return code.ok_or_else(|| self.malformed("a lone surrogate"));
        }
        char::from_u32(unit).ok_or_else(|| self.malformed("a lone surrogate"))
    }

    fn hex4(&mut self) -> Result<u32, ReadError> {
        let mut code: u32 = 0;
        for offset in 0..4 {
            code = self
                .at(offset)
                .and_then(|b| char::from(b).to_digit(16))
                .and_then(|digit| code.checked_mul(16)?.checked_add(digit))
                .ok_or_else(|| self.malformed("an escape without four hex digits"))?;
        }
        self.bump(4);
        Ok(code)
    }

    /// At `-` or a digit. Rule 3: no leading zeros, no `+`; rule 7: the double
    /// nearest to it, as `JSON.parse` reads it (a tie goes to the even one);
    /// one beyond the largest double is refused, one below the smallest reads
    /// as zero, and `-0` as -0.
    fn number(&mut self) -> Result<Json, ReadError> {
        let start = self.pos;
        let mut len = usize::from(self.peek() == Some(b'-'));
        let digit = |r: &Self, at: usize| matches!(r.at(at), Some(b'0'..=b'9'));
        match self.at(len) {
            Some(b'0') => len = len.saturating_add(1),
            Some(b'1'..=b'9') => {
                while digit(self, len) {
                    len = len.saturating_add(1);
                }
            }
            _ => return Err(self.malformed("no value")),
        }
        if self.at(len) == Some(b'.') && digit(self, len.saturating_add(1)) {
            len = len.saturating_add(1);
            while digit(self, len) {
                len = len.saturating_add(1);
            }
        }
        if matches!(self.at(len), Some(b'e' | b'E')) {
            let mut end = len.saturating_add(1);
            if matches!(self.at(end), Some(b'+' | b'-')) {
                end = end.saturating_add(1);
            }
            if digit(self, end) {
                while digit(self, end) {
                    end = end.saturating_add(1);
                }
                len = end;
            }
        }
        self.bump(len);
        let lexeme = self.text.get(start..self.pos).unwrap_or_default();
        // Rust reads a decimal as the nearest double, ties to even, as
        // ECMAScript's `Number` does.
        match lexeme.parse::<f64>() {
            Ok(x) if x.is_finite() => Ok(Json::Number(x)),
            _ => Err(self.malformed("a number beyond a double")),
        }
    }
}
