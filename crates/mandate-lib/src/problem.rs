//! The problems every reader of this crate shares: what is wrong with the
//! text or the JSON value a reader was given before any of its fields is
//! looked at ([`ShapeProblem`]), and the helpers that read a closed object.
//!
//! A problem is a typed value with a stable identifier ([`ShapeProblem::id`],
//! `snake_case`) and the facts a diagnostic needs; `to_js` writes it as
//! `{ "problem": <id>, ...facts }` with a fixed field order. Nothing here is
//! English.

use mandate_ir::{Diagnostic, JsObject, JsValue, Map, Value, parse, ptr_token};

/// The member that holds a problem's identifier in its JSON form.
pub(crate) const PROBLEM_KEY: &str = "problem";

/// A JSON object that starts with a problem's identifier.
pub(crate) fn problem_object(id: &str) -> JsObject {
    JsObject::new().with(PROBLEM_KEY, id)
}

/// The JSON Pointer of the member `key` of the value at `at`.
pub(crate) fn child(at: &str, key: &str) -> String {
    format!("{at}/{}", ptr_token(key))
}

/// The JSON Pointer of the element `index` of the array at `at`.
pub(crate) fn element(at: &str, index: usize) -> String {
    format!("{at}/{index}")
}

/// The name of a JSON value's type, as JavaScript's JSON would say it:
/// `null`, `boolean`, `number`, `string`, `array` or `object`.
#[must_use]
pub fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Why the strict JSON reader of `mandate-ir` ([`mandate_ir::parse`]) refused
/// a text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonFault {
    /// Not JSON: a character where none may be, text after the value, an
    /// unterminated string, an escape that is not one, a control character
    /// in a string.
    Syntax,
    /// An object has a member twice, at any depth.
    DuplicateKey,
    /// The text is longer than the reader's limit (1 MiB).
    TooLarge,
    /// The value nests deeper than the reader's limit (64).
    TooDeep,
    /// A number with a fraction or an exponent.
    NotInteger,
    /// An integer outside ±(2^53−1).
    OutOfRange,
    /// `-0`.
    NegativeZero,
    /// A `\u` escape that is half of a surrogate pair.
    LoneSurrogate,
}

impl JsonFault {
    /// The fault's identifier.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            JsonFault::Syntax => "syntax",
            JsonFault::DuplicateKey => "duplicate_key",
            JsonFault::TooLarge => "too_large",
            JsonFault::TooDeep => "too_deep",
            JsonFault::NotInteger => "not_integer",
            JsonFault::OutOfRange => "out_of_range",
            JsonFault::NegativeZero => "negative_zero",
            JsonFault::LoneSurrogate => "lone_surrogate",
        }
    }
}

/// The fault the reader's one diagnostic stands for.
fn json_fault(diagnostic: &Diagnostic) -> JsonFault {
    let code = diagnostic
        .code
        .strip_prefix("MDT-")
        .unwrap_or(&diagnostic.code);
    match code {
        "E0102" => JsonFault::DuplicateKey,
        "E0105" => {
            // Only the size limit's diagnostic states the size it found.
            let sized = diagnostic
                .facts
                .as_ref()
                .is_some_and(|facts| facts.get("actual").is_some());
            if sized {
                JsonFault::TooLarge
            } else {
                JsonFault::TooDeep
            }
        }
        "E0106" => {
            let lexeme = diagnostic
                .facts
                .as_ref()
                .and_then(|facts| facts.get("lexeme"))
                .and_then(JsValue::as_str)
                .unwrap_or_default();
            if lexeme.contains(['.', 'e', 'E']) {
                JsonFault::NotInteger
            } else if lexeme == "-0" {
                JsonFault::NegativeZero
            } else {
                JsonFault::OutOfRange
            }
        }
        "E0107" => JsonFault::LoneSurrogate,
        _ => JsonFault::Syntax,
    }
}

/// What is wrong with a text or a value before a reader looks at what it
/// means: it is not text, not strict JSON, or not an object of the fields the
/// reader lists.
///
/// `at` is a JSON Pointer into the value that was read (`""` is the whole
/// value, and a member of a value read from inside another document is
/// relative to that value).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShapeProblem {
    /// The bytes are not UTF-8.
    NotUtf8,
    /// The text starts with a byte order mark.
    ByteOrderMark,
    /// The text is not strict JSON ([`JsonFault`]); `at` is where the reader
    /// stopped, when it knows.
    InvalidJson {
        /// The reader's fault.
        fault: JsonFault,
        /// The pointer to the value it was reading, or `""`.
        at: String,
    },
    /// A member that the object may not have.
    UnknownField {
        /// The pointer to the object.
        at: String,
        /// The member's name.
        field: String,
    },
    /// A member the object must have and has not.
    MissingField {
        /// The pointer to the object.
        at: String,
        /// The member's name.
        field: String,
    },
    /// A value of another JSON type than the one the field is.
    WrongType {
        /// The pointer to the value.
        at: String,
        /// The type it must be.
        expected: &'static str,
        /// The type it is.
        found: &'static str,
    },
}

impl ShapeProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            ShapeProblem::NotUtf8 => "not_utf8",
            ShapeProblem::ByteOrderMark => "byte_order_mark",
            ShapeProblem::InvalidJson { .. } => "invalid_json",
            ShapeProblem::UnknownField { .. } => "unknown_field",
            ShapeProblem::MissingField { .. } => "missing_field",
            ShapeProblem::WrongType { .. } => "wrong_type",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`, the facts in the order
    /// of the variant's fields.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let base = problem_object(self.id());
        match self {
            ShapeProblem::NotUtf8 | ShapeProblem::ByteOrderMark => base,
            ShapeProblem::InvalidJson { fault, at } => {
                base.with("fault", fault.id()).with("at", at.as_str())
            }
            ShapeProblem::UnknownField { at, field } | ShapeProblem::MissingField { at, field } => {
                base.with("at", at.as_str()).with("field", field.as_str())
            }
            ShapeProblem::WrongType {
                at,
                expected,
                found,
            } => base
                .with("at", at.as_str())
                .with("expected", *expected)
                .with("found", *found),
        }
    }
}

/// Reads `text` as strict JSON: [`mandate_ir::parse`], after a byte order
/// mark is named as one. It refuses a duplicate key at every depth, text
/// after the value, nesting deeper than 64, text over 1 MiB, a number that is
/// not an integer within ±(2^53−1) (and `-0`), a lone surrogate, a string
/// with an unescaped control character, and every character that JSON does
/// not allow between tokens.
pub(crate) fn read_json(text: &str) -> Result<Value, ShapeProblem> {
    if text.starts_with('\u{feff}') {
        return Err(ShapeProblem::ByteOrderMark);
    }
    match parse(text) {
        Ok(parsed) => Ok(parsed.value),
        Err(diagnostics) => {
            let (fault, at) = diagnostics
                .first()
                .map_or((JsonFault::Syntax, String::new()), |d| {
                    (json_fault(d), d.at.path.clone().unwrap_or_default())
                });
            Err(ShapeProblem::InvalidJson { fault, at })
        }
    }
}

/// [`read_json`] of bytes: they must be UTF-8, which `mandate-ir` would
/// otherwise repair with U+FFFD.
pub(crate) fn read_json_bytes(bytes: &[u8]) -> Result<Value, ShapeProblem> {
    match std::str::from_utf8(bytes) {
        Ok(text) => read_json(text),
        Err(_) => Err(ShapeProblem::NotUtf8),
    }
}

/// Checks that `value` is an object whose members are among `fields`, and
/// that each of `required` is there. The problems are added to `out`: an
/// unknown member for each one there is, in the order of their names, then a
/// missing one for each of `required`, in the order given.
pub(crate) fn closed_object<'a>(
    value: &'a Value,
    at: &str,
    fields: &[&str],
    required: &[&str],
    out: &mut Vec<ShapeProblem>,
) -> Option<&'a Map> {
    let Some(map) = value.as_object() else {
        out.push(ShapeProblem::WrongType {
            at: at.to_owned(),
            expected: "object",
            found: json_type(value),
        });
        return None;
    };
    let mut unknown: Vec<&str> = map.keys().filter(|k| !fields.contains(k)).collect();
    unknown.sort_unstable();
    for field in unknown {
        out.push(ShapeProblem::UnknownField {
            at: at.to_owned(),
            field: field.to_owned(),
        });
    }
    for field in required {
        if !map.contains_key(field) {
            out.push(ShapeProblem::MissingField {
                at: at.to_owned(),
                field: (*field).to_owned(),
            });
        }
    }
    Some(map)
}

/// The member `key` of `map` when it is a string; a member of another type
/// is a problem, and a missing one is none (the object check reports it).
pub(crate) fn string_member<'a>(
    map: &'a Map,
    at: &str,
    key: &str,
    out: &mut Vec<ShapeProblem>,
) -> Option<&'a str> {
    let value = map.get(key)?;
    if let Some(text) = value.as_str() {
        Some(text)
    } else {
        out.push(ShapeProblem::WrongType {
            at: child(at, key),
            expected: "string",
            found: json_type(value),
        });
        None
    }
}

/// The member `key` of `map` when it is an object; as [`string_member`].
pub(crate) fn object_member<'a>(
    map: &'a Map,
    at: &str,
    key: &str,
    out: &mut Vec<ShapeProblem>,
) -> Option<&'a Map> {
    let value = map.get(key)?;
    if let Some(object) = value.as_object() {
        Some(object)
    } else {
        out.push(ShapeProblem::WrongType {
            at: child(at, key),
            expected: "object",
            found: json_type(value),
        });
        None
    }
}

/// A list of strings as a JSON array.
pub(crate) fn strings_js<'a>(items: impl IntoIterator<Item = &'a str>) -> JsValue {
    JsValue::Array(items.into_iter().map(JsValue::from).collect())
}

#[cfg(test)]
mod tests {
    use mandate_ir::Value;

    use super::{JsonFault, ShapeProblem, json_type, read_json, read_json_bytes};

    fn fault(text: &str) -> Option<JsonFault> {
        match read_json(text) {
            Err(ShapeProblem::InvalidJson { fault, .. }) => Some(fault),
            _ => None,
        }
    }

    #[test]
    fn what_the_strict_reader_refuses_is_named() {
        assert_eq!(fault("{"), Some(JsonFault::Syntax));
        assert_eq!(fault(""), Some(JsonFault::Syntax));
        assert_eq!(fault("{} x"), Some(JsonFault::Syntax));
        assert_eq!(fault(r#"{"a":1,"a":2}"#), Some(JsonFault::DuplicateKey));
        assert_eq!(
            fault(r#"{"a":{"b":1,"b":1}}"#),
            Some(JsonFault::DuplicateKey)
        );
        assert_eq!(fault("1.5"), Some(JsonFault::NotInteger));
        assert_eq!(fault("1E2"), Some(JsonFault::NotInteger));
        assert_eq!(fault("-0"), Some(JsonFault::NegativeZero));
        assert_eq!(fault("9007199254740992"), Some(JsonFault::OutOfRange));
        assert_eq!(fault(r#""\ud800""#), Some(JsonFault::LoneSurrogate));
        assert_eq!(fault(&"[".repeat(65)), Some(JsonFault::TooDeep));
        assert_eq!(
            fault(&format!("\"{}\"", "a".repeat(1_048_576))),
            Some(JsonFault::TooLarge)
        );
        // 64 levels is the most.
        assert_eq!(
            fault(&format!("{}{}", "[".repeat(64), "]".repeat(64))),
            None
        );
        assert!(read_json("9007199254740991").is_ok());
    }

    #[test]
    fn a_byte_order_mark_and_bad_utf8_are_named() {
        assert_eq!(read_json("\u{feff}{}"), Err(ShapeProblem::ByteOrderMark));
        assert_eq!(
            read_json_bytes(b"\xef\xbb\xbf{}"),
            Err(ShapeProblem::ByteOrderMark)
        );
        assert_eq!(read_json_bytes(b"{\xff}"), Err(ShapeProblem::NotUtf8));
        assert_eq!(read_json_bytes(b"{}").map(|v| json_type(&v)), Ok("object"));
    }

    #[test]
    fn json_types_are_named_as_javascript_names_them() {
        assert_eq!(json_type(&Value::Null), "null");
        assert_eq!(json_type(&Value::Bool(true)), "boolean");
        assert_eq!(json_type(&Value::from("x")), "string");
        assert_eq!(json_type(&Value::Array(Vec::new())), "array");
        assert_eq!(json_type(&Value::Object(mandate_ir::Map::new())), "object");
    }
}
