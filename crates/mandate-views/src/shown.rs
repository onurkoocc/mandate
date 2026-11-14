//! The small texts the views of a program are written in, from
//! `compiler/src/views/views.ts` (lines 224-233 `show`, 418-420
//! `mermaidText`, 1158 `showCommand`, 1160-1166 `typeText` and 1511
//! `list`), and the reading of numbers the views do on members of the IR.
//!
//! JavaScript imitated here: `${micros / 1_000_000}` is a double divided and
//! written as `Number::toString` writes it ([`number_to_string`]); a member
//! of a template that is missing is the text `undefined`
//! ([`js_text`]); `x ?? d` takes `d` for `undefined` and for `null`.

use mandate_check::{defs_of, duration, js_text, to_number};
use mandate_ir::{JsValue, Program, TypeExpr, TypeForm, Value, compare_utf16, number_to_string};

/// `ToNumber(v)` of a member of the IR: `undefined` is `NaN`.
#[must_use]
pub fn num(v: Option<&Value>) -> f64 {
    to_number(&JsValue::from(v))
}

/// `a ?? b`, as a number a template or an arithmetic expression reads: the
/// first of the members that is neither missing nor `null`, else `default`.
#[must_use]
pub fn num_or(candidates: &[Option<&Value>], default: f64) -> f64 {
    candidates
        .iter()
        .copied()
        .flatten()
        .find(|v| !matches!(v, Value::Null))
        .map_or(default, |v| num(Some(v)))
}

/// `${ms}` of a duration's `ms`: `duration(ms)` for an integer, and for a
/// member that is no number what a template makes of it with the `ms` after.
fn duration_text(ms: Option<&Value>) -> String {
    match ms.and_then(Value::as_i64) {
        Some(ms) => duration(ms),
        None => format!("{}ms", js_text(ms)),
    }
}

/// The budget as one line: `show(b)`. `—` for none, and for a budget that
/// holds nothing.
#[must_use]
pub fn show(b: Option<&Value>) -> String {
    let Some(b) = b.filter(|b| b.is_truthy()) else {
        return "—".to_owned();
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(spend) = b.get("spend").filter(|s| s.is_truthy()) {
        parts.push(format!(
            "{} {}",
            number_to_string(num(spend.get("micros")) / 1_000_000.0),
            js_text(spend.get("currency"))
        ));
    }
    if let Some(tokens) = b.get("tokens") {
        parts.push(format!("{} tokens", js_text(Some(tokens))));
    }
    if let Some(steps) = b.get("steps") {
        parts.push(format!("{} steps", js_text(Some(steps))));
    }
    if let Some(time) = b.get("time").filter(|t| t.is_truthy()) {
        parts.push(duration_text(time.get("ms")));
    }
    if let Some(agents) = b.get("agents") {
        parts.push(format!("{} agents", js_text(Some(agents))));
    }
    let line = parts.join(" · ");
    if line.is_empty() {
        "—".to_owned()
    } else {
        line
    }
}

/// A list on one line: `xs.join(", ") || "—"`.
#[must_use]
pub fn list(xs: &[String]) -> String {
    let line = xs.join(", ");
    if line.is_empty() {
        "—".to_owned()
    } else {
        line
    }
}

/// Text inside a Mermaid label: `"`, `<` and `>` are written as the
/// entities Mermaid reads: `mermaidText(s)`.
#[must_use]
pub fn mermaid_text(s: &str) -> String {
    s.replace('"', "#quot;")
        .replace('<', "#lt;")
        .replace('>', "#gt;")
}

/// A process of a component as one line: `showCommand(c)`.
#[must_use]
pub fn show_command(command: &str, args: &[&str]) -> String {
    let mut words = vec![command];
    words.extend(args.iter().copied());
    words.join(" ")
}

/// A type as the system view writes it: `typeText(t)`.
#[must_use]
pub fn type_text(t: &Value) -> String {
    let Some(t) = TypeExpr::of(t) else {
        return "union".to_owned();
    };
    if t.has(TypeForm::Ref) {
        let name = js_text(t.members().get("ref"));
        return match t.args() {
            Some(args) => {
                let shown: Vec<String> = args.iter().map(type_text).collect();
                format!("{name}<{}>", shown.join(", "))
            }
            None => name,
        };
    }
    if t.has(TypeForm::Record) {
        let fields: Vec<String> = t
            .record()
            .map(|(k, v)| format!("{k}: {}", type_text(v)))
            .collect();
        return format!("{{ {} }}", fields.join(", "));
    }
    if t.has(TypeForm::Refine) {
        return match t.members().get("refine") {
            Some(inner) => format!("{} where …", type_text(inner)),
            None => "undefined where …".to_owned(),
        };
    }
    if t.has(TypeForm::Enum) {
        let tags: Vec<String> = t
            .members()
            .get("enum")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .map(|x| js_text(Some(x)))
            .collect();
        return format!("enum {{ {} }}", tags.join(", "));
    }
    "union".to_owned()
}

/// `Object.entries(program.defs).sort(([a], [b]) => (a < b ? -1 : 1))`: the
/// definitions by name, in the order of UTF-16 code units. (The comparator
/// answers `1` for equal names, which an object does not have.)
#[must_use]
pub fn sorted_defs(program: Program<'_>) -> Vec<(&str, &Value)> {
    let mut defs: Vec<(&str, &Value)> = defs_of(program).iter().collect();
    defs.sort_by(|a, b| compare_utf16(a.0, b.0));
    defs
}

/// The text a member of the IR is in a template, as a `JsValue` for the
/// output of a view: `undefined` when it is missing.
#[must_use]
pub fn js(v: Option<&Value>) -> JsValue {
    JsValue::from(v)
}

/// A list of texts as the array of a view.
#[must_use]
pub fn texts(xs: &[String]) -> JsValue {
    JsValue::Array(xs.iter().map(|x| JsValue::from(x.as_str())).collect())
}
