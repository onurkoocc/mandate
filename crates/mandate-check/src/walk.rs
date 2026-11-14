//! The tree walkers of `compiler/src/check/static.ts` (`children`,
//! `walkExprs`, `walkStmtExprs`, `walkExpr`, `readsVar`), which the static
//! checks and the cost model ([`crate::cost`]) share. The views have a
//! `children` of their own, a different one, which is not this.
//!
//! The order is the TypeScript's: an expression before its sub-expressions,
//! the sub-expressions in the order [`children`] lists them, the statements
//! of a block or of a map's body before its other sub-expressions. Each
//! function recurses once per level of nesting; the IR a program loads to
//! is at most [`mandate_ir::limits::JSON_DEPTH`] deep.

use mandate_ir::{Expr, ExprOp, Stmt, StmtOp, Value};

/// The `expr` of each part of a template or a prompt that has one:
/// `e.parts.flatMap((p) => ("expr" in p ? [p.expr] : []))`.
fn part_exprs<'a>(e: Expr<'a>) -> impl Iterator<Item = Expr<'a>> {
    e.parts()
        .iter()
        .filter_map(|p| p.get("expr").and_then(Expr::of))
}

/// The values of the arguments: `e.args.map((a) => a.value)`.
fn arg_values<'a>(e: Expr<'a>) -> impl Iterator<Item = Expr<'a>> {
    e.args().filter_map(|a| a.value())
}

/// The direct sub-expressions of `e`, in order; the statements of a block
/// or of a map's body are not among them: `children(e)`.
#[must_use]
pub fn children(e: Expr<'_>) -> Vec<Expr<'_>> {
    let Some(op) = e.op() else {
        return Vec::new();
    };
    match op {
        ExprOp::List | ExprOp::Set => e.items().collect(),
        ExprOp::Template | ExprOp::Prompt => part_exprs(e).collect(),
        ExprOp::Field | ExprOp::Unary | ExprOp::Try | ExprOp::Await => {
            e.operand().into_iter().collect()
        }
        ExprOp::Call => e.callee().into_iter().chain(arg_values(e)).collect(),
        ExprOp::Binary => e.left().into_iter().chain(e.right()).collect(),
        ExprOp::Range => e.from().into_iter().chain(e.to()).collect(),
        ExprOp::Record => e.fields().filter_map(|(_, v)| Expr::of(v)).collect(),
        ExprOp::Infer => e.from().into_iter().chain(e.using()).collect(),
        ExprOp::Delegate => arg_values(e).chain(e.timeout()).collect(),
        ExprOp::Spawn | ExprOp::Plan => arg_values(e).collect(),
        ExprOp::Map => e
            .over()
            .into_iter()
            .chain(e.caps().unwrap_or_default().iter().filter_map(Expr::of))
            .collect(),
        ExprOp::Verify => e
            .value_expr()
            .into_iter()
            .chain(arg_values(e))
            .chain(e.on_unmet().and_then(|u| u.then()))
            .collect(),
        ExprOp::Effect => arg_values(e).chain(e.idempotent_by()).collect(),
        ExprOp::Changeset => e
            .plan()
            .into_iter()
            .chain(e.changeset_members().flat_map(|(_, m)| {
                m.arg_values()
                    .iter()
                    .filter_map(|a| a.get("value").and_then(Expr::of))
            }))
            .chain(e.idempotent_by())
            .collect(),
        ExprOp::Escalate => e.to().into_iter().collect(),
        ExprOp::Pause => e.then().into_iter().collect(),
        ExprOp::Switch => e
            .on()
            .into_iter()
            .chain(e.cases().filter_map(|c| c.then()))
            .collect(),
        _ => Vec::new(),
    }
}

/// Visits every expression in a statement list, nested blocks included:
/// `walkExprs(stmts, f)`.
pub fn walk_exprs<'a>(stmts: &'a [Value], f: &mut dyn FnMut(Expr<'a>)) {
    for s in stmts.iter().filter_map(Stmt::of) {
        walk_stmt_exprs(s, f, true);
    }
}

/// Visits the expressions of one statement: `walkStmtExprs(s, f, deep)`.
/// The blocks of an `if` and the body of a `loop` only when `deep`; the
/// blocks inside its expressions always.
pub fn walk_stmt_exprs<'a>(s: Stmt<'a>, f: &mut dyn FnMut(Expr<'a>), deep: bool) {
    let ex = |e: Option<Expr<'a>>, f: &mut dyn FnMut(Expr<'a>)| {
        if let Some(e) = e {
            walk_expr(e, f);
        }
    };
    match s.op() {
        Some(StmtOp::Let | StmtOp::Expr | StmtOp::Return) => ex(s.value(), f),
        Some(StmtOp::Par) => {
            for (_, b) in s.branches() {
                ex(Expr::of(b), f);
            }
        }
        Some(StmtOp::If) => {
            ex(s.cond(), f);
            if deep {
                walk_exprs(s.then_block(), f);
                if let Some(e) = s.else_block() {
                    walk_exprs(e, f);
                }
            }
        }
        Some(StmtOp::Loop) => {
            ex(s.until(), f);
            if deep {
                walk_exprs(s.body(), f);
            }
        }
        Some(StmtOp::OnError) => ex(s.then_expr(), f),
        Some(StmtOp::Run) => ex(s.target(), f),
        None => {}
    }
}

/// Visits `e` and every expression inside it: `walkExpr(e, f)`.
pub fn walk_expr<'a>(e: Expr<'a>, f: &mut dyn FnMut(Expr<'a>)) {
    f(e);
    if e.is(ExprOp::Block) || e.is(ExprOp::Map) {
        walk_exprs(e.body(), f);
    }
    for k in children(e) {
        walk_expr(k, f);
    }
}

/// Whether `v` reads the variable `name` anywhere inside it: an object
/// with `op: "var"` and that `name`, at any depth of any JSON value
/// (`readsVar(v, name)`).
#[must_use]
pub fn reads_var(v: &Value, name: &str) -> bool {
    match v {
        Value::Array(items) => items.iter().any(|x| reads_var(x, name)),
        Value::Object(o) => {
            if o.get("op").and_then(Value::as_str) == Some("var")
                && o.get("name").and_then(Value::as_str) == Some(name)
            {
                return true;
            }
            o.iter().any(|(_, x)| reads_var(x, name))
        }
        _ => false,
    }
}
