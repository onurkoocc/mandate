//! The reader of a request: strict JSON, by the rules of the IR's reader
//! (`mandate_ir::parse`, `compiler/src/json/strict-json.ts`), within the
//! bounds of a request instead of those of a source.
//!
//! It refuses what `JSON.parse` would silently change or what the IR cannot
//! hold: a duplicate key in an object, a number that is not an integer
//! within ±(2^53−1) (a fraction or an exponent included) or is negative
//! zero, a string with a lone surrogate (`\ud800` escaped alone), a control
//! character unescaped in a string, and anything that is not JSON. White
//! space is the four characters of JSON.
//!
//! Its bounds are not the source's (1 MiB, 64 levels), since a request
//! carries sources and programs inside it: the length is bounded before the
//! request is read ([`crate::MAX_REQUEST_BYTES`]), and the nesting by
//! [`crate::MAX_REQUEST_DEPTH`], which keeps the reader and every door that
//! walks what it read within the stack. It walks the text as UTF-8, which
//! the text already is.

use mandate_ir::{Int, Map, Value};

use crate::MAX_REQUEST_DEPTH;

/// Why a text is not a request's JSON, and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NotJson {
    /// What is wrong.
    pub what: String,
    /// The byte where it is.
    pub at: usize,
}

/// Reads `text` as strict JSON.
pub(crate) fn read(text: &str) -> Result<Value, NotJson> {
    let mut r = Reader {
        src: text.as_bytes(),
        pos: 0,
    };
    r.ws();
    let value = r.value(1)?;
    r.ws();
    if r.pos < r.src.len() {
        return Err(r.fail("content after the value"));
    }
    Ok(value)
}

struct Reader<'a> {
    src: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn fail(&self, what: impl Into<String>) -> NotJson {
        NotJson {
            what: what.into(),
            at: self.pos,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }

    fn bump(&mut self) {
        self.pos = self.pos.saturating_add(1);
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.bump();
        }
    }

    /// What is at the current position, for a message.
    fn found(&self) -> String {
        match self.peek() {
            None => "the end of the request".to_owned(),
            Some(b) if b.is_ascii_graphic() => format!("'{}'", char::from(b)),
            Some(b) => format!("the byte 0x{b:02x}"),
        }
    }

    fn expect(&mut self, b: u8) -> Result<(), NotJson> {
        if self.peek() == Some(b) {
            self.bump();
            Ok(())
        } else {
            Err(self.fail(format!(
                "'{}' expected, {} found",
                char::from(b),
                self.found()
            )))
        }
    }

    fn word(&mut self, word: &[u8], value: Value) -> Result<Value, NotJson> {
        let end = self.pos.saturating_add(word.len());
        if self.src.get(self.pos..end) == Some(word) {
            self.pos = end;
            Ok(value)
        } else {
            Err(self.fail(format!("a value expected, {} found", self.found())))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, NotJson> {
        if depth > MAX_REQUEST_DEPTH {
            return Err(self.fail(format!("nesting deeper than {MAX_REQUEST_DEPTH} levels")));
        }
        match self.peek() {
            Some(b'{') => self.object(depth).map(Value::Object),
            Some(b'[') => self.array(depth).map(Value::Array),
            Some(b'"') => self.string().map(Value::String),
            Some(b'-' | b'0'..=b'9') => self.number().map(Value::Number),
            Some(b't') => self.word(b"true", Value::Bool(true)),
            Some(b'f') => self.word(b"false", Value::Bool(false)),
            Some(b'n') => self.word(b"null", Value::Null),
            _ => Err(self.fail(format!("a value expected, {} found", self.found()))),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Map, NotJson> {
        let start = self.pos;
        self.expect(b'{')?;
        self.ws();
        let mut members: Vec<(String, Value)> = Vec::new();
        if self.peek() == Some(b'}') {
            self.bump();
            return Ok(Map::new());
        }
        let inner = depth.saturating_add(1);
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(self.fail(format!("a key expected, {} found", self.found())));
            }
            let key = self.string()?;
            self.ws();
            self.expect(b':')?;
            self.ws();
            let value = self.value(inner)?;
            members.push((key, value));
            self.ws();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b'}') => {
                    self.bump();
                    break;
                }
                _ => {
                    return Err(self.fail(format!("',' or '}}' expected, {} found", self.found())));
                }
            }
        }
        let duplicate = duplicate_key(&members);
        match (duplicate, Map::from_entries(members)) {
            (None, Some(map)) => Ok(map),
            (key, _) => Err(NotJson {
                what: format!(
                    "the key \"{}\" twice in one object",
                    key.unwrap_or_default()
                ),
                at: start,
            }),
        }
    }

    fn array(&mut self, depth: usize) -> Result<Vec<Value>, NotJson> {
        self.expect(b'[')?;
        self.ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.bump();
            return Ok(items);
        }
        let inner = depth.saturating_add(1);
        loop {
            self.ws();
            items.push(self.value(inner)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.bump(),
                Some(b']') => {
                    self.bump();
                    return Ok(items);
                }
                _ => return Err(self.fail(format!("',' or ']' expected, {} found", self.found()))),
            }
        }
    }

    /// Four hex digits at the current position, as a code unit.
    fn hex4(&mut self) -> Result<u32, NotJson> {
        let mut code: u32 = 0;
        for _ in 0..4 {
            let digit = self
                .peek()
                .and_then(|b| char::from(b).to_digit(16))
                .ok_or_else(|| self.fail("a \\u escape without four hex digits"))?;
            code = code.saturating_mul(16).saturating_add(digit);
            self.bump();
        }
        Ok(code)
    }

    fn string(&mut self) -> Result<String, NotJson> {
        self.expect(b'"')?;
        let mut out: Vec<u8> = Vec::new();
        loop {
            // The run of bytes that stand for themselves.
            let run_start = self.pos;
            while matches!(self.peek(), Some(b) if b != b'"' && b != b'\\' && b >= 0x20) {
                self.bump();
            }
            if let Some(run) = self.src.get(run_start..self.pos) {
                out.extend_from_slice(run);
            }
            match self.peek() {
                None => return Err(self.fail("a string that does not end")),
                Some(b'"') => {
                    self.bump();
                    break;
                }
                Some(b'\\') => {
                    self.bump();
                    self.escape(&mut out)?;
                }
                Some(_) => {
                    return Err(self.fail("a control character unescaped in a string"));
                }
            }
        }
        String::from_utf8(out).map_err(|_| self.fail("a string that is not UTF-8"))
    }

    /// The escape after a backslash, written into `out` as UTF-8.
    fn escape(&mut self, out: &mut Vec<u8>) -> Result<(), NotJson> {
        let at = self.pos;
        let decoded: char = match self.peek() {
            Some(b'"') => '"',
            Some(b'\\') => '\\',
            Some(b'/') => '/',
            Some(b'b') => '\u{8}',
            Some(b'f') => '\u{c}',
            Some(b'n') => '\n',
            Some(b'r') => '\r',
            Some(b't') => '\t',
            Some(b'u') => {
                self.bump();
                let unit = self.hex4()?;
                let lone = || NotJson {
                    what: "a lone surrogate in a string".to_owned(),
                    at,
                };
                let code = match unit {
                    0xd800..=0xdbff => {
                        if self.src.get(self.pos..self.pos.saturating_add(2)) != Some(b"\\u") {
                            return Err(lone());
                        }
                        self.pos = self.pos.saturating_add(2);
                        let low = self.hex4()?;
                        if !(0xdc00..=0xdfff).contains(&low) {
                            return Err(lone());
                        }
                        0x1_0000_u32
                            .saturating_add(unit.saturating_sub(0xd800).saturating_mul(0x400))
                            .saturating_add(low.saturating_sub(0xdc00))
                    }
                    0xdc00..=0xdfff => return Err(lone()),
                    other => other,
                };
                let c = char::from_u32(code).ok_or_else(lone)?;
                let mut buf = [0_u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                return Ok(());
            }
            _ => return Err(self.fail(format!("an escape \\ followed by {}", self.found()))),
        };
        self.bump();
        let mut buf = [0_u8; 4];
        out.extend_from_slice(decoded.encode_utf8(&mut buf).as_bytes());
        Ok(())
    }

    /// The lexeme of `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, which
    /// must be an integer of the IR's domain.
    fn number(&mut self) -> Result<Int, NotJson> {
        let start = self.pos;
        let negative = self.peek() == Some(b'-');
        if negative {
            self.bump();
        }
        let digits_start = self.pos;
        match self.peek() {
            Some(b'0') => self.bump(),
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.bump();
                }
            }
            _ => return Err(self.fail("a malformed number")),
        }
        let digits_end = self.pos;
        let digit_at = |r: &Reader<'_>, offset: usize| {
            matches!(r.src.get(r.pos.saturating_add(offset)), Some(b'0'..=b'9'))
        };
        let mut integral = true;
        if self.peek() == Some(b'.') && digit_at(self, 1) {
            self.bump();
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.bump();
            }
            integral = false;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            let sign = usize::from(matches!(
                self.src.get(self.pos.saturating_add(1)),
                Some(b'+' | b'-')
            ));
            if digit_at(self, sign.saturating_add(1)) {
                self.pos = self.pos.saturating_add(sign.saturating_add(1));
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.bump();
                }
                integral = false;
            }
        }
        let at_start = |what: &str| NotJson {
            what: what.to_owned(),
            at: start,
        };
        if !integral {
            return Err(at_start("a number that is not an integer"));
        }
        let magnitude = self
            .src
            .get(digits_start..digits_end)
            .unwrap_or_default()
            .iter()
            .try_fold(0_i64, |acc, b| {
                acc.checked_mul(10)?
                    .checked_add(i64::from(b.checked_sub(b'0')?))
            });
        let signed = magnitude.and_then(|m| if negative { m.checked_neg() } else { Some(m) });
        let Some(n) = signed.and_then(Int::new) else {
            return Err(at_start("an integer outside ±(2^53−1)"));
        };
        if negative && n.get() == 0 {
            return Err(at_start("negative zero"));
        }
        Ok(n)
    }
}

/// A key that `members` has twice, the first in sorted order.
fn duplicate_key(members: &[(String, Value)]) -> Option<String> {
    let mut keys: Vec<&str> = members.iter().map(|(k, _)| k.as_str()).collect();
    keys.sort_unstable();
    keys.windows(2).find_map(|w| match w {
        [a, b] if a == b => Some((*a).to_owned()),
        _ => None,
    })
}
