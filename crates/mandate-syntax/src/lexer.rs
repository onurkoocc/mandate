//! The lexer of Mandate text: a port of `compiler/src/parse/lexer.ts`.
//!
//! It walks the text as UTF-16 code units, as the TypeScript lexer walks an
//! ECMAScript string: a column is a code unit, so a character outside the
//! Basic Multilingual Plane is two; lines break at a line feed only (a
//! carriage return, a tab and a byte order mark are one column each). A
//! message that quotes "the character" quotes one code unit; where that is
//! half of a surrogate pair, the TypeScript message holds a lone surrogate,
//! which a Rust string cannot, and U+FFFD stands for it (no vector has one).
//!
//! The TypeScript lexer's regular expressions are ported by hand; each port
//! carries its pattern and has a unit test.

use mandate_ir::{Diagnostic, Location, Span, is_safe_integer};

/// A diagnostic that stops the reading: `throw new DiagnosticError([d])`.
pub(crate) type Fail = Box<Diagnostic>;

/// `TokKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TokKind {
    Ident,
    Int,
    Dec,
    Duration,
    Version,
    String,
    Prompt,
    Punct,
    Eof,
}

/// `RawPart`: a piece of a string literal as written, or the source of one
/// of its interpolations with the position of its first character.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RawPart {
    /// `{ text }`.
    Text(String),
    /// `{ src, line, col }`, the source as code units.
    Src {
        src: Vec<u16>,
        line: usize,
        col: usize,
    },
}

/// `Token`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Token {
    pub(crate) kind: TokKind,
    /// The identifier, the punctuation, or the number's lexeme.
    pub(crate) text: String,
    /// For an int: the integer; for a duration: milliseconds. A JavaScript
    /// number; the lexer only makes safe integers.
    pub(crate) num: Option<f64>,
    /// For a string or a prompt (`parts ?? []`).
    pub(crate) parts: Vec<RawPart>,
    /// A line break separates this token from the one before.
    pub(crate) nl: bool,
    pub(crate) line: usize,
    pub(crate) col: usize,
    pub(crate) end_line: usize,
    pub(crate) end_col: usize,
}

/// `tokenSpan(t)`.
pub(crate) fn token_span(t: &Token) -> Span {
    Span {
        start_line: t.line,
        start_col: t.col,
        end_line: t.end_line,
        end_col: t.end_col,
    }
}

/// `PUNCT`, tried in this order: the two-character ones first.
const PUNCT: [&str; 30] = [
    "=>", "->", "==", "!=", "<=", ">=", "..", "::", "{", "}", "(", ")", "[", "]", "<", ">", ",",
    ".", ":", ";", "=", "!", "?", "|", "@", "+", "-", "*", "/", "\u{2286}",
];

const LF: u16 = 0x0a;
const CR: u16 = 0x0d;
const TAB: u16 = 0x09;
const SPACE: u16 = 0x20;
const QUOTE: u16 = 0x22;
const SLASH: u16 = 0x2f;
const BACKSLASH: u16 = 0x5c;
const UNDERSCORE: u16 = 0x5f;
const DOT: u16 = 0x2e;
const OPEN_BRACE: u16 = 0x7b;
const CLOSE_BRACE: u16 = 0x7d;

/// `isDigit`: `c >= "0" && c <= "9"` on one code unit.
pub(crate) fn is_digit(c: u16) -> bool {
    (0x30..=0x39).contains(&c)
}

fn is_ascii_letter(c: u16) -> bool {
    (0x41..=0x5a).contains(&c) || (0x61..=0x7a).contains(&c)
}

/// `isIdentStart`: an ASCII letter or `_`.
fn is_ident_start(c: u16) -> bool {
    is_ascii_letter(c) || c == UNDERSCORE
}

/// `isIdentPart`.
fn is_ident_part(c: u16) -> bool {
    is_ident_start(c) || is_digit(c)
}

/// `/[0-9A-Za-z.+-]/.test(c)` on one code unit: a character of a version.
fn is_version_char(c: u16) -> bool {
    is_digit(c) || is_ascii_letter(c) || c == DOT || c == 0x2b || c == 0x2d
}

/// `/^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.]+)?$/.test(v)`, for a `v` made of
/// version characters only (`is_version_char`), as the lexer gives it.
///
/// The match is unique without backtracking: the numeric part holds digits
/// and points only, so the suffix, if any, starts at the first `-` or `+`.
pub(crate) fn is_version(v: &str) -> bool {
    let (numeric, suffix) = v
        .find(['-', '+'])
        .and_then(|at| v.split_at_checked(at))
        .unwrap_or((v, ""));
    let numeric_ok = numeric
        .split('.')
        .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    let suffix_ok = match suffix.get(1..) {
        None => true,
        Some(rest) => {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        }
    };
    numeric_ok && suffix_ok
}

/// The character a message quotes for one code unit; U+FFFD for half of a
/// surrogate pair.
fn unit_char(unit: u16) -> char {
    char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}')
}

/// The text of code units that are whole characters, as a Rust string.
pub(crate) fn units_text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// The base units of a duration suffix (`DURATION_UNITS`).
fn duration_unit(suffix: &str) -> Option<u32> {
    match suffix {
        "ms" => Some(1),
        "s" => Some(1000),
        "m" => Some(60_000),
        "h" => Some(3_600_000),
        "d" => Some(86_400_000),
        _ => None,
    }
}

/// The factor of a count suffix (`MAGNITUDE`).
fn magnitude(suffix: &str) -> Option<u32> {
    match suffix {
        "k" => Some(1000),
        "M" => Some(1_000_000),
        _ => None,
    }
}

/// `scaleDecimal(digits, frac, scale)`: digits.frac × scale as an exact
/// integer; `None` when it is not whole (`undefined`), `Some(∞)` when it is
/// over 2^53−1. The TypeScript works in `BigInt`; this multiplies the decimal
/// digits by the scale, exactly, however many there are.
pub(crate) fn scale_decimal(digits: &str, frac: &str, scale: u32) -> Option<f64> {
    // The product, least significant digit first.
    let mut product: Vec<u8> =
        Vec::with_capacity(digits.len().saturating_add(frac.len()).saturating_add(10));
    let mut carry: u64 = 0;
    for b in digits.bytes().chain(frac.bytes()).rev() {
        let d = u64::from(b.saturating_sub(b'0'));
        let x = d.saturating_mul(u64::from(scale)).saturating_add(carry);
        product.push(u8::try_from(x % 10).unwrap_or(0));
        carry = x / 10;
    }
    while carry > 0 {
        product.push(u8::try_from(carry % 10).unwrap_or(0));
        carry /= 10;
    }
    // Divisible by 10^frac.len() when its last frac.len() digits are zeros
    // (a product shorter than that is divisible only when it is zero).
    if product.iter().take(frac.len()).any(|&d| d != 0) {
        return None;
    }
    let whole = product.get(frac.len()..).unwrap_or_default();
    let significant = whole
        .iter()
        .rposition(|&d| d != 0)
        .map_or(0, |top| top.saturating_add(1));
    let whole = whole.get(..significant).unwrap_or_default();
    if whole.len() > 16 {
        return Some(f64::INFINITY);
    }
    let v = whole.iter().rev().fold(0_u64, |acc, &d| {
        acc.saturating_mul(10).saturating_add(u64::from(d))
    });
    if v > 9_007_199_254_740_991 {
        return Some(f64::INFINITY);
    }
    Some(v as f64)
}

/// `Number(s)` for a string of decimal digits: the nearest double.
pub(crate) fn number_of_digits(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(f64::NAN)
}

/// The lexer: `new Lexer(src, startLine, startCol)`.
pub(crate) struct Lexer<'a> {
    src: &'a [u16],
    pos: usize,
    line: usize,
    col: usize,
    /// The previous token is the punctuation `@`, after which a number is a
    /// version (`this.prev?.kind === "punct" && this.prev.text === "@"`).
    after_at: bool,
}

impl<'a> Lexer<'a> {
    pub(crate) fn new(src: &'a [u16], line: usize, col: usize) -> Lexer<'a> {
        Lexer {
            src,
            pos: 0,
            line,
            col,
            after_at: false,
        }
    }

    /// `tokenize()`: every token, the last one `eof`.
    pub(crate) fn tokenize(mut self) -> Result<Vec<Token>, Fail> {
        let mut out = Vec::new();
        loop {
            let t = self.next_token()?;
            self.after_at = t.kind == TokKind::Punct && t.text == "@";
            let eof = t.kind == TokKind::Eof;
            out.push(t);
            if eof {
                return Ok(out);
            }
        }
    }

    fn fail_at(message: String, line: usize, col: usize) -> Fail {
        let span = Span {
            start_line: line,
            start_col: col,
            end_line: line,
            end_col: col.saturating_add(1),
        };
        Box::new(Diagnostic::new(
            "E0101",
            message,
            Location::span(span),
            None,
        ))
    }

    fn fail_here(&self, message: String) -> Fail {
        Self::fail_at(message, self.line, self.col)
    }

    fn peek(&self) -> Option<u16> {
        self.src.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<u16> {
        self.src.get(self.pos.checked_add(offset)?).copied()
    }

    fn at_end(&self) -> bool {
        self.pos >= self.src.len()
    }

    /// Moves one code unit on; past the end it still counts a column, as the
    /// TypeScript lexer does (`this.src[this.pos++] ?? ""`).
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

    /// Skips blanks and comments; true when a line break was crossed.
    fn skip_trivia(&mut self) -> bool {
        let mut nl = false;
        loop {
            match self.peek() {
                Some(c @ (SPACE | TAB | CR | LF)) => {
                    if c == LF {
                        nl = true;
                    }
                    self.advance();
                }
                Some(SLASH) if self.peek_at(1) == Some(SLASH) => {
                    while !self.at_end() && self.peek() != Some(LF) {
                        self.advance();
                    }
                }
                _ => return nl,
            }
        }
    }

    fn make(&self, kind: TokKind, text: String, line: usize, col: usize) -> Token {
        Token {
            kind,
            text,
            num: None,
            parts: Vec::new(),
            nl: false,
            line,
            col,
            end_line: self.line,
            end_col: self.col,
        }
    }

    fn next_token(&mut self) -> Result<Token, Fail> {
        let nl = self.skip_trivia();
        let mut t = self.lex()?;
        if nl {
            t.nl = true;
        }
        Ok(t)
    }

    fn lex(&mut self) -> Result<Token, Fail> {
        let (line, col) = (self.line, self.col);
        let Some(ch) = self.peek() else {
            return Ok(self.make(TokKind::Eof, String::new(), line, col));
        };

        if self.after_at && is_digit(ch) {
            return self.version(line, col);
        }

        if is_ident_start(ch) {
            let mut id = String::new();
            while let Some(c) = self.peek().filter(|&c| is_ident_part(c)) {
                id.push(unit_char(c));
                self.advance();
            }
            if id == "prompt" && self.peek() == Some(QUOTE) {
                let parts = self.string_body()?;
                let mut t = self.make(TokKind::Prompt, id, line, col);
                t.parts = parts;
                return Ok(t);
            }
            return Ok(self.make(TokKind::Ident, id, line, col));
        }

        if is_digit(ch) {
            return self.number(line, col);
        }

        if ch == QUOTE {
            let parts = self.string_body()?;
            let mut t = self.make(TokKind::String, String::new(), line, col);
            t.parts = parts;
            return Ok(t);
        }

        for p in PUNCT {
            if self.starts_with(p) {
                for _ in p.encode_utf16() {
                    self.advance();
                }
                return Ok(self.make(TokKind::Punct, p.to_owned(), line, col));
            }
        }

        let shown = unit_char(ch);
        if ch > 0x7f {
            return Err(Self::fail_at(
                format!("Non-ASCII character '{shown}' outside a string. Identifiers are ASCII."),
                line,
                col,
            ));
        }
        Err(Self::fail_at(
            format!("Unexpected character '{shown}'."),
            line,
            col,
        ))
    }

    fn version(&mut self, line: usize, col: usize) -> Result<Token, Fail> {
        let mut v = String::new();
        while let Some(c) = self.peek().filter(|&c| is_version_char(c)) {
            v.push(unit_char(c));
            self.advance();
        }
        if !is_version(&v) {
            return Err(Self::fail_at(
                format!("Malformed version '{v}'."),
                line,
                col,
            ));
        }
        Ok(self.make(TokKind::Version, v, line, col))
    }

    fn number(&mut self, line: usize, col: usize) -> Result<Token, Fail> {
        let mut digits = String::new();
        loop {
            match self.peek() {
                Some(c) if is_digit(c) => {
                    digits.push(unit_char(c));
                    self.advance();
                }
                Some(UNDERSCORE) if self.peek_at(1).is_some_and(is_digit) => {
                    self.advance();
                }
                _ => break,
            }
        }
        let mut frac = String::new();
        if self.peek() == Some(DOT) && self.peek_at(1).is_some_and(is_digit) {
            self.advance();
            while let Some(c) = self.peek().filter(|&c| is_digit(c)) {
                frac.push(unit_char(c));
                self.advance();
            }
        }
        let mut suffix = String::new();
        while let Some(c) = self.peek().filter(|&c| is_ascii_letter(c)) {
            suffix.push(unit_char(c));
            self.advance();
        }
        let lexeme = if frac.is_empty() {
            digits.clone()
        } else {
            format!("{digits}.{frac}")
        };

        if suffix.is_empty() {
            if !frac.is_empty() {
                return Ok(self.make(TokKind::Dec, lexeme, line, col));
            }
            let n = Self::safe_int(&lexeme, line, col)?;
            let mut t = self.make(TokKind::Int, lexeme, line, col);
            t.num = Some(n);
            return Ok(t);
        }
        if let Some(scale) = duration_unit(&suffix) {
            let text = format!("{lexeme}{suffix}");
            let ms = Self::scaled(&digits, &frac, scale, line, col, &text)?;
            let mut t = self.make(TokKind::Duration, text, line, col);
            t.num = Some(ms);
            return Ok(t);
        }
        if let Some(scale) = magnitude(&suffix) {
            let text = format!("{lexeme}{suffix}");
            let n = Self::scaled(&digits, &frac, scale, line, col, &text)?;
            let mut t = self.make(TokKind::Int, text, line, col);
            t.num = Some(n);
            return Ok(t);
        }
        Err(Self::fail_at(
            format!(
                "Unknown number suffix '{suffix}'. Use k or M for counts and ms, s, m, h or d for durations."
            ),
            line,
            col,
        ))
    }

    /// `safeInt(lexeme, 1, …)`: `Number(lexeme) * 1`, which must be a safe
    /// integer.
    fn safe_int(lexeme: &str, line: usize, col: usize) -> Result<f64, Fail> {
        let n = number_of_digits(lexeme) * 1.0;
        if !is_safe_integer(n) {
            return Err(Self::fail_at(
                format!("Integer {lexeme} is outside \u{b1}(2^53\u{2212}1)."),
                line,
                col,
            ));
        }
        Ok(n)
    }

    /// `scaled`: exact digits.frac × scale, which must come out whole.
    fn scaled(
        digits: &str,
        frac: &str,
        scale: u32,
        line: usize,
        col: usize,
        lexeme: &str,
    ) -> Result<f64, Fail> {
        let Some(n) = scale_decimal(digits, frac, scale) else {
            return Err(Self::fail_at(
                format!("{lexeme} is not a whole number of base units."),
                line,
                col,
            ));
        };
        if !is_safe_integer(n) {
            return Err(Self::fail_at(
                format!("{lexeme} is outside \u{b1}(2^53\u{2212}1)."),
                line,
                col,
            ));
        }
        Ok(n)
    }

    fn string_body(&mut self) -> Result<Vec<RawPart>, Fail> {
        let triple = self.starts_with("\"\"\"");
        let quotes = if triple { 3 } else { 1 };
        let (start_line, start_col) = (self.line, self.col);
        for _ in 0..quotes {
            self.advance();
        }
        let mut parts: Vec<RawPart> = Vec::new();
        let mut text: Vec<u16> = Vec::new();
        loop {
            let Some(ch) = self.peek() else {
                return Err(Self::fail_at(
                    "Unterminated string.".to_owned(),
                    start_line,
                    start_col,
                ));
            };
            let closes = if triple {
                self.starts_with("\"\"\"")
            } else {
                ch == QUOTE
            };
            if closes {
                for _ in 0..quotes {
                    self.advance();
                }
                break;
            }
            if !triple && ch == LF {
                return Err(Self::fail_at(
                    "Newline in a single-line string; use \"\"\"\u{2026}\"\"\".".to_owned(),
                    start_line,
                    start_col,
                ));
            }
            if ch == BACKSLASH {
                self.advance();
                let esc = self.advance();
                let v = match esc {
                    Some(0x6e) => LF,
                    Some(0x74) => TAB,
                    Some(0x72) => CR,
                    Some(c @ (QUOTE | BACKSLASH | OPEN_BRACE | CLOSE_BRACE)) => c,
                    other => {
                        let shown = other.map(|u| unit_char(u).to_string()).unwrap_or_default();
                        return Err(self.fail_here(format!("Invalid escape '\\{shown}'.")));
                    }
                };
                text.push(v);
                continue;
            }
            if ch == OPEN_BRACE {
                if !text.is_empty() {
                    parts.push(RawPart::Text(units_text(&text)));
                }
                text.clear();
                self.advance();
                parts.push(self.interpolation()?);
                continue;
            }
            if ch == CLOSE_BRACE {
                return Err(
                    self.fail_here("Unmatched '}' in string; escape it as '\\}'.".to_owned())
                );
            }
            text.push(ch);
            self.advance();
        }
        if !text.is_empty() {
            parts.push(RawPart::Text(units_text(&text)));
        }
        Ok(parts)
    }

    /// The source of an interpolation, from just after its `{` to its
    /// matching `}`, braces counted.
    fn interpolation(&mut self) -> Result<RawPart, Fail> {
        let (line, col) = (self.line, self.col);
        let mut depth: usize = 1;
        let mut src: Vec<u16> = Vec::new();
        loop {
            let Some(c) = self.peek() else {
                return Err(Self::fail_at(
                    "Unterminated interpolation.".to_owned(),
                    line,
                    col,
                ));
            };
            if c == QUOTE {
                return Err(self.fail_here(
                    "String literals inside an interpolation are not supported.".to_owned(),
                ));
            }
            if c == OPEN_BRACE {
                depth = depth.saturating_add(1);
            }
            if c == CLOSE_BRACE {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    self.advance();
                    break;
                }
            }
            src.push(c);
            self.advance();
        }
        Ok(RawPart::Src { src, line, col })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_pattern() {
        // /^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.]+)?$/
        for ok in [
            "0",
            "0.1",
            "1.2.3",
            "10.20",
            "007",
            "1.0-rc.1",
            "1.0+build.7",
            "1-a",
            "1+A.b.9",
            "1.0-.",
        ] {
            assert!(is_version(ok), "{ok}");
        }
        for bad in [
            "", "1.", ".1", "1..2", "1.0a", "1+", "1-", "1.0-a-b", "1-a+b", "a", "1.0-", "-1", "+1",
        ] {
            assert!(!is_version(bad), "{bad}");
        }
    }

    #[test]
    fn version_characters() {
        // /[0-9A-Za-z.+-]/
        for c in "09AZaz.+-".encode_utf16() {
            assert!(is_version_char(c));
        }
        for c in "/:@[`{_ ,é".encode_utf16() {
            assert!(!is_version_char(c));
        }
    }

    #[test]
    fn suffix_letters() {
        // /[A-Za-z]/
        for c in "AZaz".encode_utf16() {
            assert!(is_ascii_letter(c));
        }
        for c in "@[`{0_é".encode_utf16() {
            assert!(!is_ascii_letter(c));
        }
    }

    #[test]
    fn scaling_is_exact() {
        assert_eq!(scale_decimal("15", "", 3_600_000), Some(54_000_000.0));
        assert_eq!(scale_decimal("1", "5", 3_600_000), Some(5_400_000.0));
        assert_eq!(scale_decimal("0", "001", 1000), Some(1.0));
        assert_eq!(scale_decimal("0", "0001", 1000), None);
        assert_eq!(scale_decimal("1", "5", 1), None);
        assert_eq!(scale_decimal("0", "0005", 1000), None);
        assert_eq!(scale_decimal("0", "000", 1000), Some(0.0));
        assert_eq!(
            scale_decimal("9007199254741", "", 1000),
            Some(f64::INFINITY)
        );
        assert_eq!(
            scale_decimal("9007199254740", "991", 1000),
            Some(9_007_199_254_740_991.0)
        );
        assert_eq!(
            scale_decimal("9007199254740", "992", 1000),
            Some(f64::INFINITY)
        );
        assert_eq!(
            scale_decimal("104249991", "", 86_400_000),
            Some(9_007_199_222_400_000.0)
        );
        assert_eq!(
            scale_decimal("104249992", "", 86_400_000),
            Some(f64::INFINITY)
        );
        assert_eq!(scale_decimal("000", "5", 1_000_000), Some(500_000.0));
        let long = "9".repeat(5000);
        assert_eq!(scale_decimal(&long, "", 1), Some(f64::INFINITY));
    }

    fn lex(src: &str) -> Result<Vec<Token>, Fail> {
        let units: Vec<u16> = src.encode_utf16().collect();
        Lexer::new(&units, 1, 1).tokenize()
    }

    #[test]
    fn columns_count_code_units() {
        let toks = lex("\"\u{1f600}\" x").unwrap_or_default();
        let x = toks.get(1).map(|t| (t.text.as_str(), t.col));
        assert_eq!(x, Some(("x", 6)));
    }

    #[test]
    fn an_escape_at_the_end_counts_a_column_past_it() {
        let d = lex("\"\\").err().map(|d| (d.message.clone(), d.at.span));
        let span = Span {
            start_line: 1,
            start_col: 4,
            end_line: 1,
            end_col: 5,
        };
        assert_eq!(d, Some(("Invalid escape '\\'.".to_owned(), Some(span))));
    }
}
