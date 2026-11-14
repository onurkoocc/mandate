//! The functions of `compiler/src/ir/types.ts` that read a program's budgets
//! and bounds: [`BUDGET_DIMENSIONS`], [`budget_amount`] and
//! [`workflow_bounds`]. A budget is the object `{ tokens?, spend?: { micros,
//! currency }, time?: { ms }, steps?, agents? }`, a workflow the object of a
//! `workflow` definition, each read as a [`Value`]: a member that is missing or
//! of another type reads as nothing, and nothing here panics.

use crate::value::Value;

/// The dimensions of a budget, in the order of `BUDGET_DIMENSIONS` in
/// `ir/types.ts`. Whatever adds budgets up, compares two of them or reserves
/// one walks this list.
pub const BUDGET_DIMENSIONS: [&str; 5] = ["tokens", "steps", "time", "spend", "agents"];

/// What a budget gives one dimension, as a number: tokens, steps and agents
/// as counts, time in milliseconds, spend in micro-units of its currency.
/// `budgetAmount(b, dim)`; a dimension that is none of [`BUDGET_DIMENSIONS`]
/// gives nothing.
#[must_use]
pub fn budget_amount(b: Option<&Value>, dim: &str) -> Option<i64> {
    let b = b?;
    match dim {
        "tokens" | "steps" | "agents" => b.get(dim)?.as_i64(),
        "time" => b.get("time")?.get("ms")?.as_i64(),
        "spend" => b.get("spend")?.get("micros")?.as_i64(),
        _ => None,
    }
}

/// What a workflow may hold and spend: the result of [`workflow_bounds`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkflowBounds<'a> {
    /// The capability expressions.
    pub caps: &'a [Value],
    /// Where they are, as a path inside the definition.
    pub caps_at: &'static str,
    /// The budget, when there is one.
    pub budget: Option<&'a Value>,
    /// Where it is.
    pub budget_at: &'static str,
}

/// `workflowBounds(d)` of `ir/types.ts`: the workflow's own `caps` and
/// `budget`, or those of its envelope when it has one (which then hold the
/// caps the workflow's own list no longer does).
#[must_use]
pub fn workflow_bounds(d: &Value) -> WorkflowBounds<'_> {
    match given(d.get("envelope")) {
        None => WorkflowBounds {
            caps: d.get("caps").and_then(Value::as_array).unwrap_or_default(),
            caps_at: "caps",
            budget: given(d.get("budget")),
            budget_at: "budget",
        },
        Some(e) => WorkflowBounds {
            caps: e.get("caps").and_then(Value::as_array).unwrap_or_default(),
            caps_at: "envelope/caps",
            budget: given(e.get("budget")),
            budget_at: "envelope/budget",
        },
    }
}

/// The member when it is there and truthy.
fn given(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| x.is_truthy())
}
