//! What the tests of the dispatcher share: a request written as a host
//! writes it, the answer read back as the test kit's [`Answer`], and the
//! doors of a table as the test kit's [`JsonDoor`]s whose every call goes
//! through [`mandate_doors::answer`], so that the request and the answer
//! are what is tested, not the door's function.

#![allow(
    dead_code,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_check::json_doors::Door;
use mandate_ir::{JsObject, JsValue, Value, stringify};
use mandate_testkit::json_doors::{Answer, JsonDoor};

/// The text of `{ door, input }`, as `JSON.stringify` writes it.
pub fn request(door: &str, input: &Value) -> String {
    request_js(door, JsValue::from(input))
}

/// The text of `{ door, input }`, the input an output value.
pub fn request_js(door: &str, input: impl Into<JsValue>) -> String {
    let r: JsValue = JsObject::new()
        .with("door", door)
        .with("input", input.into())
        .into();
    stringify(&r).expect("an object has a text")
}

/// The output of the door `door` for `input`, through
/// [`mandate_doors::answer`], or the refusal as text.
pub fn output(door: &str, input: impl Into<JsValue>) -> Result<JsValue, String> {
    match through(&request_js(door, input)) {
        Answer::Output(v) => Ok(v),
        refused => Err(format!("{door}: {}", refused.text())),
    }
}

/// The answer to `request`, read back, or why it is not an answer as the
/// dispatcher writes them: valid JSON, written as `JSON.stringify` writes
/// it, `{ ok: true, output }` or `{ ok: false, error: { kind, message } }`.
pub fn read_answer(text: &str) -> Result<Answer, String> {
    let v = parse_js(text)?;
    if stringify(&v).as_deref() != Some(text) {
        return Err(format!("not as JSON.stringify writes it: {text}"));
    }
    let JsValue::Object(o) = &v else {
        return Err(format!("not an object: {text}"));
    };
    let keys: Vec<&str> = o.keys().collect();
    match (keys.as_slice(), o.get("ok")) {
        (["ok", "output"], Some(JsValue::Bool(true))) => Ok(Answer::Output(
            o.get("output").cloned().unwrap_or(JsValue::Null),
        )),
        (["ok", "error"], Some(JsValue::Bool(false))) => {
            let e = o
                .get("error")
                .and_then(JsValue::as_object)
                .ok_or("no error")?;
            let ekeys: Vec<&str> = e.keys().collect();
            if ekeys != ["kind", "message"] {
                return Err(format!("an error of other members: {text}"));
            }
            match (e.get("kind"), e.get("message")) {
                (Some(JsValue::String(kind)), Some(JsValue::String(message))) => {
                    Ok(Answer::Refused {
                        kind: kind.clone(),
                        message: message.clone(),
                    })
                }
                _ => Err(format!(
                    "an error whose kind or message is not text: {text}"
                )),
            }
        }
        _ => Err(format!("not an answer: {text}")),
    }
}

/// The answer to `request` through the dispatcher, read back; a text that
/// is not an answer is a refusal of kind `not_an_answer`, which no test
/// takes for a right one.
pub fn through(request: &str) -> Answer {
    let text = mandate_doors::answer(request);
    read_answer(&text).unwrap_or_else(|why| Answer::Refused {
        kind: "not_an_answer".to_owned(),
        message: why,
    })
}

/// The doors of `table`, each called through [`mandate_doors::answer`]
/// with its name and the input as a request.
pub fn through_answer(table: &'static [Door]) -> Vec<JsonDoor<'static>> {
    table
        .iter()
        .map(|d| JsonDoor {
            name: d.name,
            ts: d.ts,
            params: d.params,
            note: d.note,
            call: Box::new(move |input| through(&request(d.name, input))),
        })
        .collect()
}

/// The kind of an answer, `ok` for an output.
pub fn kind(a: &Answer) -> &str {
    match a {
        Answer::Output(_) => "ok",
        Answer::Refused { kind, .. } => kind,
    }
}

// ── reading an answer ────────────────────────────────────────────────────

/// `JSON.parse` of an answer, as a [`JsValue`]: numbers are doubles, an
/// object keeps its members in ECMAScript order.
pub fn parse_js(text: &str) -> Result<JsValue, String> {
    let chars: Vec<char> = text.chars().collect();
    let mut p = Parser { s: &chars, i: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != chars.len() {
        return Err(format!("content after the value at {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [char],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t' | '\n' | '\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: char) -> Result<(), String> {
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("{c:?} expected at {}", self.i))
        }
    }

    fn value(&mut self) -> Result<JsValue, String> {
        match self.peek() {
            Some('{') => {
                self.i += 1;
                let mut entries: Vec<(String, JsValue)> = Vec::new();
                self.ws();
                if self.peek() == Some('}') {
                    self.i += 1;
                    return Ok(JsValue::Object(JsObject::new()));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.ws();
                    self.eat(':')?;
                    self.ws();
                    entries.push((k, self.value()?));
                    self.ws();
                    if self.peek() == Some(',') {
                        self.i += 1;
                        continue;
                    }
                    self.eat('}')?;
                    return JsObject::from_entries(entries)
                        .map(JsValue::Object)
                        .ok_or_else(|| "a key twice".to_owned());
                }
            }
            Some('[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.peek() == Some(']') {
                    self.i += 1;
                    return Ok(JsValue::Array(items));
                }
                loop {
                    self.ws();
                    items.push(self.value()?);
                    self.ws();
                    if self.peek() == Some(',') {
                        self.i += 1;
                        continue;
                    }
                    self.eat(']')?;
                    return Ok(JsValue::Array(items));
                }
            }
            Some('"') => self.string().map(JsValue::String),
            Some('t') => self.word("true", JsValue::Bool(true)),
            Some('f') => self.word("false", JsValue::Bool(false)),
            Some('n') => self.word("null", JsValue::Null),
            Some(c) if c == '-' || c.is_ascii_digit() => {
                let start = self.i;
                while matches!(self.peek(), Some(c) if c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' || c.is_ascii_digit())
                {
                    self.i += 1;
                }
                let lexeme: String = self.s[start..self.i].iter().collect();
                lexeme
                    .parse::<f64>()
                    .map(JsValue::Number)
                    .map_err(|_| format!("a number {lexeme}"))
            }
            _ => Err(format!("a value expected at {}", self.i)),
        }
    }

    fn word(&mut self, w: &str, v: JsValue) -> Result<JsValue, String> {
        for c in w.chars() {
            self.eat(c)?;
        }
        Ok(v)
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut n = 0;
        for _ in 0..4 {
            let d = self
                .peek()
                .and_then(|c| c.to_digit(16))
                .ok_or("a \\u escape")?;
            n = n * 16 + d;
            self.i += 1;
        }
        Ok(n)
    }

    fn string(&mut self) -> Result<String, String> {
        self.eat('"')?;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or("a string that does not end")?;
            self.i += 1;
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let e = self.peek().ok_or("an escape")?;
                    self.i += 1;
                    match e {
                        '"' | '\\' | '/' => out.push(e),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xd800..0xdc00).contains(&hi) {
                                self.eat('\\')?;
                                self.eat('u')?;
                                let lo = self.hex4()?;
                                0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                            } else {
                                hi
                            };
                            out.push(char::from_u32(code).ok_or("a lone surrogate")?);
                        }
                        other => return Err(format!("an escape \\{other}")),
                    }
                }
                c if (c as u32) < 0x20 => return Err("a raw control character".to_owned()),
                c => out.push(c),
            }
        }
    }
}
