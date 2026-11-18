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

/// What is left to visit, on the walk's own stack (on the heap): the walk
/// does not recurse, so that a walk inside the static checks, which recurse
/// themselves, adds no frame per level of nesting to theirs.
enum Work<'a> {
    /// An expression: it, then its block or body, then its children.
    Expr(Expr<'a>),
    /// A statement list, its statements walked deep.
    Stmts(&'a [Value]),
    /// A statement, its blocks only when deep.
    Stmt(Stmt<'a>, bool),
}

/// Visits what `start` holds, in the order the recursive walk of the
/// TypeScript does: each item is pushed in reverse, so that the first is
/// visited first, and an expression's block or body before its children.
fn walk<'a>(start: Work<'a>, f: &mut dyn FnMut(Expr<'a>)) {
    let mut todo: Vec<Work<'a>> = vec![start];
    while let Some(w) = todo.pop() {
        match w {
            Work::Expr(e) => {
                f(e);
                todo.extend(children(e).into_iter().rev().map(Work::Expr));
                if e.is(ExprOp::Block) || e.is(ExprOp::Map) {
                    todo.push(Work::Stmts(e.body()));
                }
            }
            Work::Stmts(stmts) => {
                let list: Vec<Stmt<'a>> = stmts.iter().filter_map(Stmt::of).collect();
                todo.extend(list.into_iter().rev().map(|s| Work::Stmt(s, true)));
            }
            Work::Stmt(s, deep) => stmt_work(s, deep, &mut todo),
        }
    }
}

/// What a statement holds, pushed in reverse onto `todo`: the expressions
/// of `walkStmtExprs(s, f, deep)` in its order.
fn stmt_work<'a>(s: Stmt<'a>, deep: bool, todo: &mut Vec<Work<'a>>) {
    let mut out: Vec<Work<'a>> = Vec::new();
    let ex = |e: Option<Expr<'a>>, out: &mut Vec<Work<'a>>| {
        if let Some(e) = e {
            out.push(Work::Expr(e));
        }
    };
    match s.op() {
        Some(StmtOp::Let | StmtOp::Expr | StmtOp::Return) => ex(s.value(), &mut out),
        Some(StmtOp::Par) => {
            for (_, b) in s.branches() {
                ex(Expr::of(b), &mut out);
            }
        }
        Some(StmtOp::If) => {
            ex(s.cond(), &mut out);
            if deep {
                out.push(Work::Stmts(s.then_block()));
                if let Some(e) = s.else_block() {
                    out.push(Work::Stmts(e));
                }
            }
        }
        Some(StmtOp::Loop) => {
            ex(s.until(), &mut out);
            if deep {
                out.push(Work::Stmts(s.body()));
            }
        }
        Some(StmtOp::OnError) => ex(s.then_expr(), &mut out),
        Some(StmtOp::Run) => ex(s.target(), &mut out),
        // 0.7: a report holds the expressions of its fields, in order; a
        // stage holds none.
        Some(StmtOp::Report) => {
            for f in s.fields() {
                ex(
                    mandate_ir::ReportField::of(f).and_then(mandate_ir::ReportField::value),
                    &mut out,
                );
            }
        }
        Some(StmtOp::Stage) | None => {}
    }
    todo.extend(out.into_iter().rev());
}

/// Visits every expression in a statement list, nested blocks included:
/// `walkExprs(stmts, f)`.
pub fn walk_exprs<'a>(stmts: &'a [Value], f: &mut dyn FnMut(Expr<'a>)) {
    walk(Work::Stmts(stmts), f);
}

/// Visits the expressions of one statement: `walkStmtExprs(s, f, deep)`.
/// The blocks of an `if` and the body of a `loop` only when `deep`; the
/// blocks inside its expressions always.
pub fn walk_stmt_exprs<'a>(s: Stmt<'a>, f: &mut dyn FnMut(Expr<'a>), deep: bool) {
    walk(Work::Stmt(s, deep), f);
}

/// Visits `e` and every expression inside it: `walkExpr(e, f)`.
pub fn walk_expr<'a>(e: Expr<'a>, f: &mut dyn FnMut(Expr<'a>)) {
    walk(Work::Expr(e), f);
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
