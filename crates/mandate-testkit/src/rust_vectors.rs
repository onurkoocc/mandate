//! The files the Rust compiler writes about languages 0.6 and 0.7, which no
//! TypeScript result holds (`vectors/README.md`, "The gates of 0.6" and "The
//! gates of 0.7"): the golden file of the 0.6 programs, [`GOLDEN_0_6`], and
//! the diagnostic vectors of 0.6, [`DIAGNOSTICS_0_6`]; and those of 0.7,
//! [`GOLDEN_0_7`] and [`DIAGNOSTICS_0_7`], written with [`UPDATE_0_7`].
//!
//! They catch a regression; they do not say a rule is right, which the
//! hand-written conformance cases of 0.6 do. A normal run compares each file
//! with what the Rust gives now and fails when they differ ([`pin`]); a run
//! with the environment variable [`UPDATE`] set to `1` writes them instead,
//! and only then. Nothing else writes them.

use std::fmt::Write as _;

use mandate_ir::{JsValue, stringify_pretty};

/// The environment variable that makes a run write the files of 0.6 instead
/// of comparing them: `MANDATE_UPDATE_0_6=1`. Under WebAssembly,
/// `scripts/wasi-test.mjs` passes it on.
pub const UPDATE: &str = "MANDATE_UPDATE_0_6";

/// The golden file of the 0.6 programs, relative to the repository root:
/// the same shape as `compiler/test/golden/outputs.json`.
pub const GOLDEN_0_6: &str = "vectors/golden/0.6.json";

/// The directory of the diagnostic vectors of 0.6: the same layout and
/// formats as `vectors/diagnostics/`.
pub const DIAGNOSTICS_0_6: &str = "vectors/diagnostics-0.6";

/// The directory of the programs of 0.6 the golden file pins: every `.mdt`
/// and `.ir.json` file in it.
pub const PROGRAMS_0_6: &str = "fixtures/library";

/// The environment variable that makes a run write the files of 0.7
/// instead of comparing them: `MANDATE_UPDATE_0_7=1`, passed on under
/// WebAssembly as [`UPDATE`] is.
pub const UPDATE_0_7: &str = "MANDATE_UPDATE_0_7";

/// The attention facts of every workflow of every 0.7 program
/// ([`PROGRAMS_0_7`]), as the door `attention_facts` gives them: written
/// with [`UPDATE_0_7`], as the other files of 0.7 are.
pub const ATTENTION_0_7: &str = "vectors/attention-0.7/facts.json";

/// The attention view of every workflow of every 0.7 program
/// ([`PROGRAMS_0_7`]) in its three formats, as the door `attention` gives
/// them: written with [`UPDATE_0_7`].
pub const ATTENTION_VIEW_0_7: &str = "vectors/attention-0.7/view.json";

/// The golden file of the 0.7 programs, relative to the repository root:
/// the shape of [`GOLDEN_0_6`].
pub const GOLDEN_0_7: &str = "vectors/golden/0.7.json";

/// The directory of the diagnostic vectors of 0.7: the layout and formats
/// of [`DIAGNOSTICS_0_6`].
pub const DIAGNOSTICS_0_7: &str = "vectors/diagnostics-0.7";

/// The directory of the programs of 0.7 the golden file of 0.7 pins: every
/// `.mdt` and `.ir.json` file in it.
pub const PROGRAMS_0_7: &str = "fixtures/attention";

/// Whether this run writes the files of 0.6 ([`UPDATE`] is `1`).
#[must_use]
pub fn updating() -> bool {
    updating_by(UPDATE)
}

/// Whether the environment variable `var` is `1`.
fn updating_by(var: &str) -> bool {
    std::env::var(var).is_ok_and(|v| v == "1")
}

/// The programs of 0.6 the golden file pins, repository paths in order.
///
/// # Errors
///
/// When the directory cannot be listed.
pub fn programs_0_6() -> Result<Vec<String>, String> {
    programs_in(PROGRAMS_0_6)
}

/// The programs of 0.7 the golden file of 0.7 pins, repository paths in
/// order.
///
/// # Errors
///
/// When the directory cannot be listed.
pub fn programs_0_7() -> Result<Vec<String>, String> {
    programs_in(PROGRAMS_0_7)
}

/// Every `.mdt` and `.ir.json` file of `dir`, repository paths in order.
fn programs_in(dir: &str) -> Result<Vec<String>, String> {
    Ok(crate::files(dir)?
        .into_iter()
        .filter(|f| f.ends_with(".mdt") || f.ends_with(".ir.json"))
        .map(|f| format!("{dir}/{f}"))
        .collect())
}

/// `JSON.stringify(value, null, 2) + "\n"`, as the golden files are written.
#[must_use]
pub fn json_text(v: &JsValue) -> String {
    let mut text = stringify_pretty(v).unwrap_or_default();
    text.push('\n');
    text
}

/// The text of a vector file as `vectorText` in
/// `compiler/test/diagnostic-vectors.test.ts` writes it: two-space indents,
/// an array of integers on one line (`[1, 1, 1, 8]`), and only ASCII (every
/// UTF-16 code unit from U+007F up as `\uXXXX`, lower-case), then a line end.
#[must_use]
pub fn vector_text(v: &JsValue) -> String {
    let pretty = stringify_pretty(v).unwrap_or_default();
    let mut out = String::with_capacity(pretty.len());
    let lines: Vec<&str> = pretty.split('\n').collect();
    let mut i: usize = 0;
    while let Some(line) = lines.get(i) {
        // `[\n(?:\s*-?\d+,\n)*\s*-?\d+\n\s*\]`: an array whose items are all
        // integers, one a line, the last without a comma.
        if line.ends_with('[')
            && let Some((items, close, next)) = integer_items(&lines, i.saturating_add(1))
        {
            out.push_str(line);
            out.push_str(&items.join(", "));
            out.push_str(close.trim_start());
            out.push('\n');
            i = next;
            continue;
        }
        out.push_str(line);
        out.push('\n');
        i = i.saturating_add(1);
    }
    // `out` ends with the line end of the last line, as `text + "\n"`.
    ascii(&out)
}

/// From line `from`: lines that are each an integer and a comma, then one
/// that is an integer alone, then the line that closes the array. The
/// integers, the closing line and the line after it, when that is so.
fn integer_items<'a>(lines: &[&'a str], from: usize) -> Option<(Vec<&'a str>, &'a str, usize)> {
    let mut items: Vec<&'a str> = Vec::new();
    let mut j = from;
    loop {
        let t = lines.get(j)?.trim();
        match t.strip_suffix(',') {
            Some(item) if is_integer(item) => items.push(item),
            Some(_) => return None,
            None if is_integer(t) => {
                items.push(t);
                break;
            }
            None => return None,
        }
        j = j.saturating_add(1);
    }
    let close_at = j.saturating_add(1);
    let close = lines.get(close_at)?;
    close
        .trim_start()
        .starts_with(']')
        .then_some((items, *close, close_at.saturating_add(1)))
}

/// `-?\d+`.
fn is_integer(s: &str) -> bool {
    let digits = s.strip_prefix('-').unwrap_or(s);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Every UTF-16 code unit from U+007F up as `\uXXXX`.
fn ascii(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if u32::from(c) < 0x7f {
            out.push(c);
        } else {
            let mut units = [0_u16; 2];
            for unit in c.encode_utf16(&mut units) {
                // Writing to a String cannot fail.
                let _ = write!(out, "\\u{unit:04x}");
            }
        }
    }
    out
}

/// Holds the repository file `rel` to `text`: on a normal run, `Ok` when the
/// file is `text`, else what differs; with [`UPDATE`] set, writes `text` to
/// it (and its directory) and says so.
///
/// # Errors
///
/// The file is missing or differs (on a normal run), or cannot be written.
pub fn pin(rel: &str, text: &str) -> Result<String, String> {
    pin_by(UPDATE, rel, text)
}

/// [`pin`] for a file of 0.7: written instead with [`UPDATE_0_7`] set to
/// `1`.
///
/// # Errors
///
/// As [`pin`].
pub fn pin_0_7(rel: &str, text: &str) -> Result<String, String> {
    pin_by(UPDATE_0_7, rel, text)
}

/// [`pin`], written instead when the environment variable `var` is `1`.
fn pin_by(var: &str, rel: &str, text: &str) -> Result<String, String> {
    if updating_by(var) {
        let file = crate::path(rel);
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{rel}: {e}"))?;
        }
        std::fs::write(&file, text).map_err(|e| format!("{rel}: {e}"))?;
        return Ok(format!("{rel}: written ({var}=1)"));
    }
    let committed = crate::read_text(rel)
        .map_err(|e| format!("{e}; {var}=1 writes it from what the Rust gives"))?;
    crate::compare_text(&committed, text).map_err(|why| {
        format!("{rel} is not what the Rust gives: {why}\n(a change on purpose: write it again with {var}=1, and say why in the commit)")
    })?;
    Ok(format!("{rel}: the same"))
}

#[cfg(test)]
mod tests {
    use mandate_ir::{JsObject, JsValue};

    use super::vector_text;

    #[test]
    fn a_vector_is_written_as_the_typescript_writes_one() {
        let v: JsValue = JsObject::new()
            .with(
                "span",
                JsValue::Array(vec![1.into(), JsValue::Number(-2.0), 30.into()]),
            )
            .with("words", JsValue::Array(vec!["a".into(), 1.into()]))
            .with("empty", JsValue::Array(Vec::new()))
            .with("text", "é😀\u{7f}")
            .into();
        assert_eq!(
            vector_text(&v),
            "{\n  \"span\": [1, -2, 30],\n  \"words\": [\n    \"a\",\n    1\n  ],\n  \"empty\": [],\n  \"text\": \"\\u00e9\\ud83d\\ude00\\u007f\"\n}\n"
        );
    }
}
