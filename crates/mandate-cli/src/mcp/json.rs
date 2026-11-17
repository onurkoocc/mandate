//! JSON as the Node server (`bridge/src/mcp.ts`) holds it: what
//! `JSON.parse` makes of a line, what `JSON.stringify` writes of an answer,
//! and the few things of JavaScript the server does to those values
//! (`String(v)`, truthiness, `trim`), so that the native server answers
//! with the same bytes.
//!
//! A JavaScript string is UTF-16, and `JSON.parse` takes a lone surrogate
//! escape (`"\ud800"`) into it; `JSON.stringify` writes it back as that
//! escape. [`JStr`] holds such a string as its code units, and every other
//! string as text. An object keeps its members in ECMAScript order (array
//! indices first, in ascending order; then the other names in the order
//! they first came), and a name given twice keeps its first place and takes
//! its last value, as `JSON.parse` does.
//!
//! [`parse`] reads a line without recursion, so that a line of a million
//! `[` costs no stack, and keeps what it reads only down to
//! [`KEPT_DEPTH`] levels: a value one level deeper is kept as [`J::Deep`]
//! (it is past the server's nesting limit, so the message is refused for
//! it), and what is deeper still is read and dropped. The tree is then at
//! most one level deeper than the limit, so walking and dropping it are
//! bounded too.

use std::collections::{BTreeMap, HashMap};

use mandate_ir::{Int, JsValue, Map, Value, is_safe_integer, write_json_string, write_number};

/// The deepest level whose values are kept whole: the server's nesting
/// limit (`MESSAGE_LIMITS.depth`: the IR's 64 levels, and 8 for the request
/// around an IR fragment). The message is at level 1.
pub(crate) const KEPT_DEPTH: usize = mandate_ir::limits::JSON_DEPTH.saturating_add(8);

/// A string as JavaScript holds it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum JStr {
    /// A well-formed string.
    Text(String),
    /// A string with a lone surrogate, as its UTF-16 code units.
    Units(Vec<u16>),
}

impl JStr {
    /// The string of these code units.
    pub(crate) fn from_units(units: Vec<u16>) -> JStr {
        match String::from_utf16(&units) {
            Ok(s) => JStr::Text(s),
            Err(_) => JStr::Units(units),
        }
    }

    /// The text, when the string is well-formed.
    pub(crate) fn text(&self) -> Option<&str> {
        match self {
            JStr::Text(s) => Some(s),
            JStr::Units(_) => None,
        }
    }

    /// Its UTF-16 code units.
    fn units(&self) -> Vec<u16> {
        match self {
            JStr::Text(s) => s.encode_utf16().collect(),
            JStr::Units(u) => u.clone(),
        }
    }

    /// The strings one after the other, as `+` and a template literal join
    /// them.
    pub(crate) fn concat(parts: &[&JStr]) -> JStr {
        if parts.iter().all(|p| matches!(p, JStr::Text(_))) {
            let mut out = String::new();
            for p in parts {
                if let JStr::Text(s) = p {
                    out.push_str(s);
                }
            }
            return JStr::Text(out);
        }
        let mut units = Vec::new();
        for p in parts {
            units.extend(p.units());
        }
        JStr::from_units(units)
    }

    /// `s.startsWith(prefix)`.
    pub(crate) fn starts_with(&self, prefix: &str) -> bool {
        match self {
            JStr::Text(s) => s.starts_with(prefix),
            JStr::Units(u) => {
                let p: Vec<u16> = prefix.encode_utf16().collect();
                u.starts_with(&p)
            }
        }
    }

    /// `s.trim()` (`both`) or `s.trimStart()`: ECMAScript's white space and
    /// line terminators taken off.
    pub(crate) fn trimmed(&self, both: bool) -> JStr {
        match self {
            JStr::Text(s) => JStr::Text(
                if both {
                    s.trim_matches(js_space)
                } else {
                    s.trim_start_matches(js_space)
                }
                .to_owned(),
            ),
            JStr::Units(u) => {
                // Every white space character is one code unit.
                let space = |c: &u16| char::from_u32(u32::from(*c)).is_some_and(js_space);
                let start = u.iter().position(|c| !space(c)).unwrap_or(u.len());
                let end = if both {
                    u.iter()
                        .rposition(|c| !space(c))
                        .map_or(start, |i| i.saturating_add(1))
                } else {
                    u.len()
                };
                JStr::from_units(u.get(start..end).unwrap_or_default().to_vec())
            }
        }
    }

    /// Writes it as `JSON.stringify` writes a string.
    pub(crate) fn write(&self, out: &mut String) {
        match self {
            JStr::Text(s) => write_json_string(out, s),
            JStr::Units(u) => {
                out.push('"');
                for c in char::decode_utf16(u.iter().copied()) {
                    match c {
                        Ok(c) => {
                            let mut buf = [0u8; 4];
                            let one: &str = c.encode_utf8(&mut buf);
                            let mut quoted = String::new();
                            write_json_string(&mut quoted, one);
                            out.push_str(
                                quoted.get(1..quoted.len().saturating_sub(1)).unwrap_or(""),
                            );
                        }
                        Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
                    }
                }
                out.push('"');
            }
        }
    }
}

impl From<&str> for JStr {
    fn from(s: &str) -> JStr {
        JStr::Text(s.to_owned())
    }
}

impl From<String> for JStr {
    fn from(s: String) -> JStr {
        JStr::Text(s)
    }
}

/// ECMAScript's `WhiteSpace` and `LineTerminator`: what `trim` takes off.
pub(crate) fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// A value as the Node server holds it.
#[derive(Clone, Debug)]
pub(crate) enum J {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A double.
    Num(f64),
    /// A string.
    Str(JStr),
    /// An array.
    Arr(Vec<J>),
    /// An object.
    Obj(JObj),
    /// A value one level past [`KEPT_DEPTH`], read and not kept.
    Deep,
    /// A value a door of the compiler gave, as the bridge reads its answer.
    Js(JsValue),
}

impl J {
    /// A string.
    pub(crate) fn str(s: impl Into<JStr>) -> J {
        J::Str(s.into())
    }

    /// `v[key]` of an object; `None` (undefined) for anything else, an
    /// array included (the server looks up names only).
    pub(crate) fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(o) => o.get(key),
            _ => None,
        }
    }

    /// The string, when this is one.
    pub(crate) fn as_jstr(&self) -> Option<&JStr> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Whether JavaScript reads it as true.
    pub(crate) fn truthy(&self) -> bool {
        match self {
            J::Null => false,
            J::Bool(b) => *b,
            J::Num(x) => !(x.is_nan() || *x == 0.0),
            J::Str(JStr::Text(s)) => !s.is_empty(),
            J::Str(JStr::Units(u)) => !u.is_empty(),
            J::Arr(_) | J::Obj(_) | J::Deep => true,
            J::Js(v) => js_truthy(v),
        }
    }

    /// `typeof v === "object"` and truthy: an object or an array.
    pub(crate) fn is_object_like(&self) -> bool {
        matches!(
            self,
            J::Arr(_) | J::Obj(_) | J::Js(JsValue::Array(_) | JsValue::Object(_))
        )
    }

    /// `String(v)`.
    pub(crate) fn to_js_string(&self) -> JStr {
        match self {
            J::Null => JStr::from("null"),
            J::Bool(b) => JStr::from(if *b { "true" } else { "false" }),
            J::Num(x) => {
                let mut s = String::new();
                write_number(&mut s, *x);
                JStr::Text(s)
            }
            J::Str(s) => s.clone(),
            J::Arr(items) => {
                let comma = JStr::from(",");
                let mut parts: Vec<JStr> = Vec::new();
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        parts.push(comma.clone());
                    }
                    if !matches!(item, J::Null | J::Js(JsValue::Null | JsValue::Undefined)) {
                        parts.push(item.to_js_string());
                    }
                }
                let refs: Vec<&JStr> = parts.iter().collect();
                JStr::concat(&refs)
            }
            J::Obj(_) | J::Deep => JStr::from("[object Object]"),
            J::Js(v) => JStr::Text(v.to_js_string()),
        }
    }
}

/// Whether JavaScript reads the value as true.
pub(crate) fn js_truthy(v: &JsValue) -> bool {
    match v {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(b) => *b,
        JsValue::Number(x) => !(x.is_nan() || *x == 0.0),
        JsValue::String(s) => !s.is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
        JsValue::Json(t) => !matches!(t.as_str(), "null" | "false" | "0" | "\"\""),
    }
}

/// `String(v)` of an optional value: `undefined` when there is none.
pub(crate) fn js_string_of(v: Option<&J>) -> JStr {
    v.map_or_else(|| JStr::from("undefined"), J::to_js_string)
}

/// The name of a member: an array index, or any other name.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Key<'a> {
    /// An array index.
    Index(u32),
    /// Any other name.
    Name(&'a JStr),
}

impl Key<'_> {
    /// The name as a string.
    pub(crate) fn to_jstr(self) -> JStr {
        match self {
            Key::Index(n) => JStr::Text(n.to_string()),
            Key::Name(s) => s.clone(),
        }
    }
}

/// An object, its members in ECMAScript order.
#[derive(Clone, Debug, Default)]
pub(crate) struct JObj {
    indexed: BTreeMap<u32, J>,
    named: Vec<(JStr, J)>,
    at: HashMap<JStr, usize>,
}

/// `key` as an array index (`"0"`, `"10"`, … up to `"4294967294"`), when it
/// is one.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

impl JObj {
    /// `{}`.
    pub(crate) fn new() -> JObj {
        JObj::default()
    }

    /// `o[key] = value`: a name already there keeps its place.
    pub(crate) fn insert(&mut self, key: JStr, value: J) {
        if let Some(n) = key.text().and_then(array_index) {
            self.indexed.insert(n, value);
            return;
        }
        match self.at.get(&key) {
            Some(&i) => {
                if let Some(slot) = self.named.get_mut(i) {
                    slot.1 = value;
                }
            }
            None => {
                self.at.insert(key.clone(), self.named.len());
                self.named.push((key, value));
            }
        }
    }

    /// The object with `key` set to `value`.
    pub(crate) fn with(mut self, key: &str, value: J) -> JObj {
        self.insert(JStr::from(key), value);
        self
    }

    /// The object with `key` set to `value` when there is one.
    pub(crate) fn with_some(self, key: &str, value: Option<J>) -> JObj {
        match value {
            Some(v) => self.with(key, v),
            None => self,
        }
    }

    /// `o[key]`.
    pub(crate) fn get(&self, key: &str) -> Option<&J> {
        if let Some(n) = array_index(key) {
            return self.indexed.get(&n);
        }
        let i = *self.at.get(&JStr::from(key))?;
        self.named.get(i).map(|(_, v)| v)
    }

    /// The members, in order.
    pub(crate) fn iter(&self) -> impl Iterator<Item = (Key<'_>, &J)> {
        self.indexed
            .iter()
            .map(|(k, v)| (Key::Index(*k), v))
            .chain(self.named.iter().map(|(k, v)| (Key::Name(k), v)))
    }
}

// ── JSON.parse ──────────────────────────────────────────────────────────

/// What the reader expects next.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Expect {
    /// A value.
    Value,
    /// A value or `]`, after `[`.
    FirstItem,
    /// A name or `}`, after `{`.
    FirstName,
    /// A name, after `,` in an object.
    Name,
    /// `:`.
    Colon,
    /// `,` or the end of the container, after a value in it.
    Next,
    /// Nothing but white space, after the value.
    End,
}

/// A container being read whose members are kept.
enum Frame {
    Arr(Vec<J>),
    Obj(JObj, Option<JStr>),
}

/// The reader over the bytes of a line.
struct Reader<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn bump(&mut self) {
        self.at = self.at.saturating_add(1);
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.bump();
        }
    }

    fn literal(&mut self, word: &str) -> Option<()> {
        let end = self.at.checked_add(word.len())?;
        (self.bytes.get(self.at..end)? == word.as_bytes()).then_some(())?;
        self.at = end;
        Some(())
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.bump();
        }
        self.at.saturating_sub(start)
    }

    /// A number, by JSON's grammar, as the double it reads to.
    fn number(&mut self) -> Option<f64> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.bump();
        }
        match self.peek() {
            Some(b'0') => self.bump(),
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return None,
        }
        if self.peek() == Some(b'.') {
            self.bump();
            if self.digits() == 0 {
                return None;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.bump();
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.bump();
            }
            if self.digits() == 0 {
                return None;
            }
        }
        self.text.get(start..self.at)?.parse::<f64>().ok()
    }

    /// A string, after its opening quote is seen, as its code units.
    fn string(&mut self) -> Option<JStr> {
        self.bump();
        let mut units: Vec<u16> = Vec::new();
        loop {
            let start = self.at;
            while self
                .peek()
                .is_some_and(|b| b != b'"' && b != b'\\' && b >= 0x20)
            {
                self.bump();
            }
            units.extend(self.text.get(start..self.at)?.encode_utf16());
            match self.peek()? {
                b'"' => {
                    self.bump();
                    return Some(JStr::from_units(units));
                }
                b'\\' => {
                    self.bump();
                    let c = self.peek()?;
                    self.bump();
                    let unit: u16 = match c {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => {
                            let end = self.at.checked_add(4)?;
                            let hex = self.text.get(self.at..end)?;
                            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                                return None;
                            }
                            self.at = end;
                            u16::from_str_radix(hex, 16).ok()?
                        }
                        _ => return None,
                    };
                    units.push(unit);
                }
                // A control character.
                _ => return None,
            }
        }
    }
}

/// `JSON.parse(text)`, or `None` where it throws. Values deeper than
/// [`KEPT_DEPTH`] are not kept (see the module's documentation).
pub(crate) fn parse(text: &str) -> Option<J> {
    let mut r = Reader {
        text,
        bytes: text.as_bytes(),
        at: 0,
    };
    let mut kept: Vec<Frame> = Vec::new();
    // The containers past the kept levels: whether each is an object.
    let mut skipped: Vec<bool> = Vec::new();
    let mut root: Option<J> = None;
    let mut expect = Expect::Value;
    loop {
        r.skip_space();
        let in_object = match skipped.last() {
            Some(o) => *o,
            None => matches!(kept.last(), Some(Frame::Obj(..))),
        };
        match expect {
            Expect::End => return if r.peek().is_none() { root } else { None },
            Expect::Colon => {
                (r.peek()? == b':').then_some(())?;
                r.bump();
                expect = Expect::Value;
                continue;
            }
            Expect::Next => {
                match r.peek()? {
                    b',' => {
                        r.bump();
                        expect = if in_object {
                            Expect::Name
                        } else {
                            Expect::Value
                        };
                        continue;
                    }
                    b']' if !in_object => {}
                    b'}' if in_object => {}
                    _ => return None,
                }
                // The end of the container: below.
            }
            Expect::FirstName | Expect::Name => {
                let c = r.peek()?;
                if c == b'}' && expect == Expect::FirstName {
                    // The end of the container: below.
                } else {
                    (c == b'"').then_some(())?;
                    let name = r.string()?;
                    if skipped.is_empty()
                        && let Some(Frame::Obj(_, key)) = kept.last_mut()
                    {
                        *key = Some(name);
                    }
                    expect = Expect::Colon;
                    continue;
                }
            }
            Expect::FirstItem if r.peek()? == b']' => {
                // The end of the container: below.
            }
            Expect::Value | Expect::FirstItem => {
                let depth = kept.len().saturating_add(skipped.len()).saturating_add(1);
                let c = r.peek()?;
                let value = match c {
                    b'[' | b'{' => {
                        r.bump();
                        let object = c == b'{';
                        if depth <= KEPT_DEPTH {
                            kept.push(if object {
                                Frame::Obj(JObj::new(), None)
                            } else {
                                Frame::Arr(Vec::new())
                            });
                        } else {
                            skipped.push(object);
                        }
                        expect = if object {
                            Expect::FirstName
                        } else {
                            Expect::FirstItem
                        };
                        continue;
                    }
                    b'"' => J::Str(r.string()?),
                    b't' => r.literal("true").map(|()| J::Bool(true))?,
                    b'f' => r.literal("false").map(|()| J::Bool(false))?,
                    b'n' => r.literal("null").map(|()| J::Null)?,
                    _ => J::Num(r.number()?),
                };
                let value = match depth {
                    d if d <= KEPT_DEPTH => Some(value),
                    d if d == KEPT_DEPTH.saturating_add(1) => Some(J::Deep),
                    _ => None,
                };
                place(&mut kept, &skipped, &mut root, value);
                expect = if kept.is_empty() && skipped.is_empty() {
                    Expect::End
                } else {
                    Expect::Next
                };
                continue;
            }
        }
        // The container ends here.
        r.bump();
        let value = if skipped.pop().is_some() {
            // The first skipped level is one past the kept ones.
            skipped.is_empty().then_some(J::Deep)
        } else {
            match kept.pop()? {
                Frame::Arr(items) => Some(J::Arr(items)),
                Frame::Obj(o, _) => Some(J::Obj(o)),
            }
        };
        place(&mut kept, &skipped, &mut root, value);
        expect = if kept.is_empty() && skipped.is_empty() {
            Expect::End
        } else {
            Expect::Next
        };
    }
}

/// Puts a value that was read into the container it is in, or makes it the
/// root; a value inside a skipped container is dropped.
fn place(kept: &mut [Frame], skipped: &[bool], root: &mut Option<J>, value: Option<J>) {
    let Some(value) = value else {
        return;
    };
    if !skipped.is_empty() {
        return;
    }
    match kept.last_mut() {
        None => *root = Some(value),
        Some(Frame::Arr(items)) => items.push(value),
        Some(Frame::Obj(o, key)) => {
            if let Some(k) = key.take() {
                o.insert(k, value);
            }
        }
    }
}

// ── JSON.stringify ──────────────────────────────────────────────────────

/// `JSON.stringify(v)`.
pub(crate) fn stringify(v: &J) -> String {
    let mut out = String::new();
    write(&mut out, v);
    out
}

/// Whether `JSON.stringify` writes nothing for the value (it is undefined).
fn unwritten(v: &J) -> bool {
    matches!(v, J::Js(JsValue::Undefined))
}

fn write(out: &mut String, v: &J) {
    match v {
        J::Null | J::Deep => out.push_str("null"),
        J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        J::Num(x) if x.is_finite() => write_number(out, *x),
        J::Num(_) => out.push_str("null"),
        J::Str(s) => s.write(out),
        J::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if unwritten(item) {
                    out.push_str("null");
                } else {
                    write(out, item);
                }
            }
            out.push(']');
        }
        J::Obj(o) => {
            out.push('{');
            let mut first = true;
            for (k, item) in o.iter() {
                if unwritten(item) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                k.to_jstr().write(out);
                out.push(':');
                write(out, item);
            }
            out.push('}');
        }
        J::Js(v) => out.push_str(&mandate_ir::stringify(v).unwrap_or_else(|| "null".to_owned())),
    }
}

// ── a door's input ──────────────────────────────────────────────────────

/// The deepest nesting a request to a door may have: `MAX_REQUEST_DEPTH` of
/// `mandate_doors`, which the bridge holds a request to before it sends it.
const REQUEST_DEPTH: usize = mandate_doors::MAX_REQUEST_DEPTH;

/// `where` of the bridge's `writeRequest`: the place in the input.
fn place_of(at: &str) -> String {
    if at.is_empty() {
        "the input".to_owned()
    } else {
        format!("the input at {at}")
    }
}

/// A JSON Pointer reference token (RFC 6901): `~` as `~0`, `/` as `~1`.
pub(crate) fn pointer_token(name: &str) -> String {
    name.replace('~', "~0").replace('/', "~1")
}

/// A number as a request carries it: a safe integer that is not `-0`.
fn request_number(x: f64, at: &str) -> Result<Value, String> {
    let negative_zero = x.to_bits() == (-0.0f64).to_bits();
    // A safe integer is exact as an i64.
    let int = if is_safe_integer(x) && !negative_zero {
        Int::new(x as i64)
    } else {
        None
    };
    int.map(Value::Number).ok_or_else(|| {
        let shown = if negative_zero {
            "-0".to_owned()
        } else {
            let mut s = String::new();
            write_number(&mut s, x);
            s
        };
        format!(
            "{} is the number {shown}, and a request holds integers within ±(2^53−1) only",
            place_of(at)
        )
    })
}

/// The value a door is given for `v`, as the bridge's `writeRequest`
/// writes it and the door's reader reads it back; or what in it a request
/// cannot carry, with where it is (the bridge's words), for the first such
/// thing in the order the bridge walks the value. `depth` is the level of
/// `v` in the request (its input is at 2).
pub(crate) fn request_value(v: &J, at: &str, depth: usize) -> Result<Value, String> {
    match v {
        J::Null | J::Deep => Ok(Value::Null),
        J::Bool(b) => Ok(Value::Bool(*b)),
        J::Num(x) => request_number(*x, at),
        J::Str(JStr::Text(s)) => Ok(Value::String(s.clone())),
        J::Str(JStr::Units(_)) => Err(format!(
            "{} is a string with a lone surrogate, which the request reader refuses",
            place_of(at)
        )),
        J::Js(v) => request_js(v, at, depth),
        J::Arr(items) => {
            too_deep(at, depth)?;
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                out.push(request_value(
                    item,
                    &format!("{at}/{i}"),
                    depth.saturating_add(1),
                )?);
            }
            Ok(Value::Array(out))
        }
        J::Obj(o) => {
            too_deep(at, depth)?;
            let mut out = Map::new();
            for (k, item) in o.iter() {
                let name = match k {
                    Key::Index(n) => n.to_string(),
                    Key::Name(JStr::Text(s)) => s.clone(),
                    Key::Name(JStr::Units(_)) => {
                        return Err(format!(
                            "{} has a member name with a lone surrogate",
                            place_of(at)
                        ));
                    }
                };
                if unwritten(item) {
                    continue;
                }
                let inner = format!("{at}/{}", pointer_token(&name));
                let value = request_value(item, &inner, depth.saturating_add(1))?;
                out.insert(name, value);
            }
            Ok(Value::Object(out))
        }
    }
}

fn too_deep(at: &str, depth: usize) -> Result<(), String> {
    if depth > REQUEST_DEPTH {
        return Err(format!(
            "{} is nested deeper than the {REQUEST_DEPTH} levels a request may have",
            place_of(at)
        ));
    }
    Ok(())
}

/// [`request_value`] of a value a door gave, as the bridge holds it after
/// reading the door's answer: `undefined` was written as `null` in an
/// array and left out of an object, a number that is not finite as `null`,
/// `-0` as `0`.
fn request_js(v: &JsValue, at: &str, depth: usize) -> Result<Value, String> {
    match v {
        JsValue::Undefined | JsValue::Null => Ok(Value::Null),
        JsValue::Bool(b) => Ok(Value::Bool(*b)),
        JsValue::Number(x) if !x.is_finite() => Ok(Value::Null),
        JsValue::Number(x) if *x == 0.0 => Ok(Value::Number(Int::saturating(0))),
        JsValue::Number(x) => request_number(*x, at),
        JsValue::String(s) => Ok(Value::String(s.clone())),
        JsValue::Array(items) => {
            too_deep(at, depth)?;
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                out.push(request_js(
                    item,
                    &format!("{at}/{i}"),
                    depth.saturating_add(1),
                )?);
            }
            Ok(Value::Array(out))
        }
        JsValue::Object(o) => {
            too_deep(at, depth)?;
            let mut out = Map::new();
            for (k, item) in o.iter() {
                if item.is_undefined() {
                    continue;
                }
                let inner = format!("{at}/{}", pointer_token(k));
                out.insert(k, request_js(item, &inner, depth.saturating_add(1))?);
            }
            Ok(Value::Object(out))
        }
        JsValue::Json(text) => mandate_ir::parse(text.as_str())
            .map(|p| p.value)
            .map_err(|_| format!("{} is a value a request does not carry", place_of(at))),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic)]

    use super::{J, JStr, KEPT_DEPTH, parse, stringify};

    fn round(text: &str) -> String {
        stringify(&parse(text).unwrap_or_else(|| panic!("{text}")))
    }

    #[test]
    fn it_reads_and_writes_as_javascript_does() {
        assert_eq!(round(r#"{"b":1,"a":2,"b":3}"#), r#"{"b":3,"a":2}"#);
        assert_eq!(
            round(r#"{"x":1,"10":2,"2":3,"01":4}"#),
            r#"{"2":3,"10":2,"x":1,"01":4}"#
        );
        assert_eq!(
            round("[1.0,1e21,-0,1e400,0.1,12345678901234567890]"),
            "[1,1e+21,0,null,0.1,12345678901234567000]"
        );
        assert_eq!(round(r#""\ud800é😀\u001F""#), "\"\\ud800é😀\\u001f\"");
        assert_eq!(round(r#" { "__proto__" : [ ] } "#), r#"{"__proto__":[]}"#);
        for bad in [
            "",
            "[1,]",
            "{\"a\"}",
            "01",
            "1.",
            "\"\t\"",
            "[1] x",
            "{,}",
            "\u{feff}{}",
            "'a'",
            "nul",
        ] {
            assert!(parse(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn a_deep_value_is_read_without_being_kept() {
        let deep = format!("{}{}", "[".repeat(1_000_000), "]".repeat(1_000_000));
        let mut v = parse(&deep).unwrap();
        let mut depth = 1;
        while let J::Arr(mut items) = v {
            depth += 1;
            v = items.pop().unwrap();
        }
        assert!(matches!(v, J::Deep));
        assert_eq!(depth, KEPT_DEPTH + 1);
        assert!(parse(&format!("{}{}", "[".repeat(100_000), "]".repeat(99_999))).is_none());
        // A deep value given again is replaced, as its name keeps its place.
        let twice = format!("{{\"a\":{}1{},\"a\":1}}", "[".repeat(80), "]".repeat(80));
        assert_eq!(round(&twice), r#"{"a":1}"#);
    }

    #[test]
    fn strings_are_trimmed_and_joined_as_javascript_does() {
        let s = JStr::from("\u{feff}\u{3000} x \u{a0}");
        assert_eq!(s.trimmed(true), JStr::from("x"));
        assert_eq!(s.trimmed(false), JStr::from("x \u{a0}"));
        // U+0085 is not ECMAScript white space.
        assert_eq!(JStr::from("\u{85}x").trimmed(true), JStr::from("\u{85}x"));
        let lone = JStr::from_units(vec![0xd83d]);
        let low = JStr::from_units(vec![0xde00]);
        assert_eq!(JStr::concat(&[&lone, &low]), JStr::from("😀"));
        let arr = parse(r#"[null,"a",[1,[2,null]],{}]"#).unwrap();
        assert_eq!(arr.to_js_string(), JStr::from(",a,1,2,,[object Object]"));
    }
}
