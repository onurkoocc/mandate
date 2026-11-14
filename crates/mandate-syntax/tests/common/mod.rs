//! What the syntax and span gates share: span tables as the vectors write
//! them, and the comparison of values as JSON text.

#![allow(dead_code)]

use mandate_ir::{JsValue, Span, Value, compare_utf16, stringify};

/// One row of a span table, `["/p",1,2,3,4]`, as `JSON.stringify` writes it.
pub fn row(pointer: &str, span: Span) -> String {
    let parts = JsValue::Array(vec![
        JsValue::from(pointer),
        JsValue::from(span.start_line),
        JsValue::from(span.start_col),
        JsValue::from(span.end_line),
        JsValue::from(span.end_col),
    ]);
    stringify(&parts).unwrap_or_default()
}

/// The rows of a table, by pointer in UTF-16 code-unit order (`spanRows`).
pub fn rows<'a>(table: impl Iterator<Item = (&'a str, Span)>) -> Vec<String> {
    let mut entries: Vec<(&str, Span)> = table.collect();
    entries.sort_by(|a, b| compare_utf16(a.0, b.0));
    entries.into_iter().map(|(p, s)| row(p, s)).collect()
}

/// A value of a vector file as `JSON.stringify` writes it.
pub fn json(value: &Value) -> String {
    stringify(&JsValue::from(value)).unwrap_or_default()
}

/// The rows a vector file holds, each written as [`row`] writes one.
pub fn vector_rows(value: Option<&Value>) -> Result<Vec<String>, String> {
    let rows = value
        .and_then(Value::as_array)
        .ok_or("the vector has no span rows")?;
    Ok(rows.iter().map(json).collect())
}

/// `Ok` when the two lists of lines are equal, else the first difference.
pub fn same_lines(what: &str, expected: &[String], actual: &[String]) -> Result<(), String> {
    if expected == actual {
        return Ok(());
    }
    let at = expected
        .iter()
        .zip(actual)
        .position(|(e, a)| e != a)
        .unwrap_or(expected.len().min(actual.len()));
    Err(format!(
        "{what}: {} expected, {} given; first difference at {}:\n    expected: {}\n    actual:   {}",
        expected.len(),
        actual.len(),
        at,
        expected.get(at).map_or("(none)", String::as_str),
        actual.get(at).map_or("(none)", String::as_str),
    ))
}

/// The nesting depth of a value as the strict reader counts it (a scalar
/// at the top is 1): `depthOf` in `compiler/test/syntax-vectors.ts`.
pub fn depth_of(value: &Value) -> usize {
    let kids: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(map) => map.iter().map(|(_, v)| v).collect(),
        _ => return 1,
    };
    1 + kids.into_iter().map(depth_of).max().unwrap_or(0)
}
