//! An amendment of an envelope (0.4; spec/envelope.md "Amendments", N04): a
//! port of `compiler/src/check/amendment.ts`.
//!
//! A lead asks for one with `request_amendment`: a new envelope for the
//! run's workflow, and nothing else. The program with that envelope is a new
//! program, and is checked as any program is. One rule is the amendment's
//! own, E1709 ([`narrowings`]): an amendment only widens. The new envelope
//! holds every capability the old one held, gives each budget dimension at
//! least what it gave and names no other, and bounds the run's delegations
//! no more tightly. In 0.6 it keeps every shape (spec/library.md
//! "`shapes`") and adds none where the envelope had none.
//!
//! JavaScript imitated: the budget's dimensions in a `Map`, in insertion
//! order; numbers written as JavaScript writes them; a member that is
//! missing against one that is there.

use mandate_ir::{
    BUDGET_DIMENSIONS, Diagnostic, Expr, JsObject, JsValue, Language, Location, Map, Value,
    budget_amount, budget_asks, ptr,
};

use crate::caps::{CapOptions, CapVal, cap_covers, caps_of, show_cap};
use crate::stdlib::{DataClass, class_rank};

/// A budget's amount in each dimension it names, by name, in the order of
/// the dimensions (`tokens`, `steps`, `time`, `spend:<currency>`,
/// `agents`), with the field it is written in: `amounts(b)`.
fn amounts(b: Option<&Value>) -> Vec<(String, &'static str, i64)> {
    let mut out: Vec<(String, &'static str, i64)> = Vec::new();
    for field in BUDGET_DIMENSIONS {
        let Some(amount) = budget_amount(b, field) else {
            continue;
        };
        let key = if field == "spend" {
            let currency = b
                .and_then(|b| b.get("spend"))
                .and_then(|s| s.get("currency"))
                .and_then(Value::as_str)
                .unwrap_or("undefined");
            format!("spend:{currency}")
        } else {
            field.to_owned()
        };
        // `out.set(key, …)`: a name that is there keeps its place.
        match out.iter_mut().find(|(k, _, _)| *k == key) {
            Some(slot) => *slot = (key, field, amount),
            None => out.push((key, field, amount)),
        }
    }
    out
}

/// The capabilities an envelope's `caps` list evaluates to:
/// `(env.caps ?? []).flatMap((c) => capsOf(defs, c, opts))`.
fn caps_held(defs: &Map, envelope: &Value, opts: CapOptions) -> Vec<CapVal> {
    envelope
        .get("caps")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Expr::of)
        .flat_map(|c| caps_of(defs, c, opts))
        .collect()
}

/// The `spawn` bounds of an envelope: `max_concurrent`.
fn max_concurrent(envelope: &Value) -> Option<i64> {
    envelope
        .get("spawn")
        .and_then(|s| s.get("max_concurrent"))
        .and_then(Value::as_i64)
}

/// The `spawn.max_class` of an envelope, as written.
fn max_class(envelope: &Value) -> Option<&str> {
    envelope
        .get("spawn")
        .and_then(|s| s.get("max_class"))
        .and_then(Value::as_str)
}

/// 0.7: E1709 for an amendment whose budget drops `asks`, adds it where the
/// envelope had none, or lowers it (spec/attention.md "Sub-programs and
/// amendments"); `at` is the envelope's path.
fn asks_narrowed(
    no: &mut impl FnMut(String, &str, JsObject),
    at: &str,
    has_budget: bool,
    before: &Value,
    after: &Value,
) {
    let was = budget_asks(before.get("budget"));
    let asked = budget_asks(after.get("budget"));
    match (was, asked) {
        (Some(b), None) => no(
            format!(
                "The amendment's budget names no asks, and the envelope gives {b}. An amendment names every dimension the envelope names."
            ),
            &if has_budget {
                format!("{at}/budget")
            } else {
                at.to_owned()
            },
            JsObject::new()
                .with("dimension", "asks")
                .with("was", b as f64)
                .with("asked", JsValue::Null),
        ),
        (Some(b), Some(a)) if a < b => no(
            format!(
                "The amendment gives {a} asks, and the envelope gives {b}. An amendment only raises a budget."
            ),
            &format!("{at}/budget/asks"),
            JsObject::new()
                .with("dimension", "asks")
                .with("was", b as f64)
                .with("asked", a as f64),
        ),
        (None, Some(a)) => no(
            format!(
                "The amendment limits asks to {a}, and the envelope does not limit it. An amendment adds no limit."
            ),
            &format!("{at}/budget/asks"),
            JsObject::new()
                .with("dimension", "asks")
                .with("was", JsValue::Null)
                .with("asked", a as f64),
        ),
        _ => {}
    }
}

/// E1709: what `after` takes away from `before`, the envelope of
/// `workflow`: `narrowings(defs, workflow, before, after, opts)`. `defs` is
/// every definition the program sees, read as `opts` says (its language).
/// Each diagnostic names the dimension, what the envelope gave and what the
/// amendment asks, so that a lead can ask again for no less.
#[must_use]
pub fn narrowings(
    defs: &Map,
    workflow: &str,
    before: &Value,
    after: &Value,
    opts: CapOptions,
) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    let at = format!("{}/envelope", ptr(&[&"defs", &workflow]));
    let mut no = |message: String, path: &str, facts: JsObject| {
        out.push(Diagnostic::new(
            "E1709",
            message,
            Location::path(path),
            Some(facts),
        ));
    };

    // Authority: every capability the envelope held lies inside one it
    // holds now.
    let held = caps_held(defs, after, opts);
    for c in caps_held(defs, before, opts) {
        if held.iter().any(|w| cap_covers(w, &c)) {
            continue;
        }
        no(
            format!(
                "The amendment leaves out {}, which the envelope holds. An amendment only widens: what ran under the envelope must still lie inside it.",
                show_cap(&c)
            ),
            &format!("{at}/caps"),
            JsObject::new()
                .with("dimension", "capability")
                .with("capability", show_cap(&c))
                .with(
                    "asked",
                    held.iter()
                        .map(|w| JsValue::from(show_cap(w)))
                        .collect::<Vec<_>>(),
                ),
        );
    }

    // The budget: the same dimensions, each with at least what it had. A
    // dimension without an amount has no limit, so naming a new one would
    // add a limit, and leaving one out would leave the run's limit with
    // nothing above it.
    let was = amounts(before.get("budget"));
    let now = amounts(after.get("budget"));
    let has_budget = after.get("budget").is_some_and(Value::is_truthy);
    for (dimension, _, b) in &was {
        match now.iter().find(|(d, _, _)| d == dimension) {
            None => no(
                format!(
                    "The amendment's budget names no {dimension}, and the envelope gives {b}. An amendment names every dimension the envelope names."
                ),
                &if has_budget {
                    format!("{at}/budget")
                } else {
                    at.clone()
                },
                JsObject::new()
                    .with("dimension", dimension.as_str())
                    .with("was", *b as f64)
                    .with("asked", JsValue::Null),
            ),
            Some((_, field, a)) if a < b => no(
                format!(
                    "The amendment gives {a} {dimension}, and the envelope gives {b}. An amendment only raises a budget."
                ),
                &format!("{at}/budget/{field}"),
                JsObject::new()
                    .with("dimension", dimension.as_str())
                    .with("was", *b as f64)
                    .with("asked", *a as f64),
            ),
            Some(_) => {}
        }
    }
    for (dimension, field, a) in &now {
        if was.iter().any(|(d, _, _)| d == dimension) {
            continue;
        }
        no(
            format!(
                "The amendment limits {dimension} to {a}, and the envelope does not limit it. An amendment adds no limit."
            ),
            &format!("{at}/budget/{field}"),
            JsObject::new()
                .with("dimension", dimension.as_str())
                .with("was", JsValue::Null)
                .with("asked", *a as f64),
        );
    }

    // 0.7: `asks`, the most questions the run may put to people, is a
    // dimension of its own, not one of the ledger's, held as each of them:
    // left out, added, or lowered, it narrows the envelope.
    if opts.language.is_some_and(|l| l.at_least(Language::V0_7)) {
        asks_narrowed(&mut no, &at, has_budget, before, after);
    }

    // How many delegations at once, and how high a data class they may
    // receive.
    let (k0, k1) = (max_concurrent(before), max_concurrent(after));
    if let Some(k1) = k1
        && k0.is_none_or(|k0| k1 < k0)
    {
        no(
            match k0 {
                None => format!(
                    "The amendment allows {k1} delegations at once, and the envelope does not bound them. An amendment adds no bound."
                ),
                Some(k0) => format!(
                    "The amendment allows {k1} delegations at once, and the envelope allows {k0}. An amendment only raises it."
                ),
            },
            &format!("{at}/spawn/max_concurrent"),
            JsObject::new()
                .with("dimension", "max_concurrent")
                .with("was", k0.map_or(JsValue::Null, |k| JsValue::from(k as f64)))
                .with("asked", k1 as f64),
        );
    }
    let c0 = max_class(before).unwrap_or("internal");
    let c1 = max_class(after).unwrap_or("internal");
    let rank = |c: &str| DataClass::from_name(c).map(class_rank);
    // `classRank(c1) < classRank(c0)`; a name that is no class has rank -1.
    let below = match (rank(c1), rank(c0)) {
        (Some(a), Some(b)) => a < b,
        (None, Some(_)) => true,
        _ => false,
    };
    if below {
        no(
            format!(
                "The amendment allows a delegation at most {c1} data, and the envelope allows {c0}. An amendment only raises it."
            ),
            &if max_class(after).is_some() {
                format!("{at}/spawn/max_class")
            } else {
                at.clone()
            },
            JsObject::new()
                .with("dimension", "max_class")
                .with("was", c0)
                .with("asked", c1),
        );
    }

    // 0.6: the patterns a lead's sub-programs may apply (spec/library.md
    // "`shapes`"). An envelope without `shapes` lets a sub-program be any
    // workflow, so the list may be taken away or grow; a shape left out, or
    // a list where there was none, would refuse a sub-program the envelope
    // admitted. No envelope before 0.6 has one.
    let names = |e: &Value| {
        e.get("shapes").and_then(Value::as_array).map(|xs| {
            xs.iter()
                .filter_map(Value::as_str)
                .map(JsValue::from)
                .collect::<Vec<_>>()
        })
    };
    match (names(before), names(after)) {
        (Some(was), Some(asked)) => {
            for s in &was {
                if asked.contains(s) {
                    continue;
                }
                let shape = s.as_str().unwrap_or_default();
                no(
                    format!(
                        "The amendment leaves out the shape {shape}, which the envelope lists. An amendment only widens: a sub-program the envelope admitted must still be admitted."
                    ),
                    &format!("{at}/shapes"),
                    JsObject::new()
                        .with("dimension", "shapes")
                        .with("shape", shape)
                        .with("was", was.clone())
                        .with("asked", asked.clone()),
                );
            }
        }
        (None, Some(asked)) => no(
            "The amendment limits the lead's sub-programs to shapes, and the envelope admits any workflow. An amendment adds no limit.".to_owned(),
            &format!("{at}/shapes"),
            JsObject::new()
                .with("dimension", "shapes")
                .with("was", JsValue::Null)
                .with("asked", asked),
        ),
        _ => {}
    }
    out
}
