//! Types, statements, patterns and expressions: the third part of
//! `parser.ts`.
//!
//! These are the functions the parser recurses through, one call per level
//! of nesting in the text: each kind of expression and statement has a
//! function of its own, and the text of an error message is made in a
//! function of its own, so that no frame on the way holds what another
//! branch needs.

use std::collections::HashSet;

use mandate_ir::{Int, is_safe_integer};

use super::{
    ABOVE_AND, Parser, Res, describe, fail_at, is_p, is_reserved, is_w, num_node, starts_upper,
};
use crate::lexer::{Fail, Lexer, RawPart, TokKind, Token, number_of_digits};
use crate::node::{Node, O, Obj, obj, sort_canon};

pub(super) const PREC_OR: u8 = 1;
pub(super) const PREC_AND: u8 = 2;
const PREC_NOT: u8 = 3;
const PREC_CMP: u8 = 4;
const PREC_UNARY: u8 = 8;

/// `BINARY_PREC[op]`.
fn binary_prec(op: &str) -> Option<u8> {
    match op {
        "or" => Some(PREC_OR),
        "and" => Some(PREC_AND),
        "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "\u{2286}" => Some(PREC_CMP),
        ".." => Some(5),
        "+" | "-" => Some(6),
        "*" | "/" => Some(7),
        _ => None,
    }
}

/// `startsOperand(t)`.
fn starts_operand(t: &Token) -> bool {
    matches!(t.kind, TokKind::Ident | TokKind::String | TokKind::Int) || is_p(t, "(")
}

/// `/^[A-Z]{3}$/.test(s)`: a currency.
fn is_currency(s: &str) -> bool {
    s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase())
}

/// `s.replace(/[kM]$/, "")`: a count's suffix taken off.
fn strip_magnitude(s: &str) -> &str {
    s.strip_suffix(['k', 'M']).unwrap_or(s)
}

/// `Number(BigInt(digits))`: the nearest double to the integer the decimal
/// digits write (`BigInt("")` is 0).
fn number_of_bigint(digits: &str) -> f64 {
    if digits.is_empty() {
        return 0.0;
    }
    number_of_digits(digits)
}

/// The micro-units of an amount: the number token `t` followed by its
/// currency.
fn money_micros(t: &Token, currency: &str) -> Res<Node> {
    let mut halves = strip_magnitude(&t.text).split('.');
    let whole = halves.next().unwrap_or_default();
    let frac = halves.next().unwrap_or_default();
    let micros = if t.kind == TokKind::Int {
        t.num.unwrap_or(0.0) * 1_000_000.0
    } else {
        if frac.len() > 6 {
            return Err(fail_at(
                format!("Amount {} has more than six decimal places.", t.text),
                t,
            ));
        }
        number_of_bigint(&format!("{whole}{frac:0<6}"))
    };
    if !is_safe_integer(micros) {
        return Err(fail_at(
            format!("Amount {} {currency} is too large.", t.text),
            t,
        ));
    }
    Ok(Node::Int(Int::saturating(micros as i64)))
}

impl<'a> Parser<'a> {
    // ── types ──────────────────────────────────────────────────────────

    /// `typeExpr({ allowWhere })`.
    pub(super) fn type_expr(&mut self, allow_where: bool) -> Res<O> {
        self.enter()?;
        let ty = self.type_expr_at(allow_where);
        self.leave();
        ty
    }

    fn type_expr_at(&mut self, allow_where: bool) -> Res<O> {
        let start = self.t();
        let ty = if self.eat_w("enum") {
            self.enum_type()?
        } else if self.eat_p("{") {
            self.record_type()?
        } else {
            self.ref_type()?
        };
        let ty = self.at(ty, start);
        if allow_where && self.eat_w("where") {
            let condition = self.expr(false)?;
            let refined = obj().with("refine", ty).with("where", condition);
            return Ok(self.at(refined, start));
        }
        Ok(ty)
    }

    fn enum_type(&mut self) -> Res<O> {
        self.expect_p("{")?;
        let mut members: Vec<Node> = Vec::new();
        // `members.includes(m)`, in constant time.
        let mut seen: HashSet<String> = HashSet::new();
        while !self.is_p("}") {
            let t = self.t();
            let m = self.ident("an enum member")?;
            if seen.contains(&m) {
                self.dup("enum member", &m, t);
            }
            seen.insert(m.clone());
            members.push(Node::Str(m));
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p("}")?;
        Ok(obj().with("enum", members))
    }

    fn record_type(&mut self) -> Res<O> {
        let mut record = obj();
        while !self.is_p("}") {
            let t = self.t();
            let name = self.ident("a field name")?;
            self.expect_p(":")?;
            if record.has(&name) {
                self.dup("field", &name, t);
            }
            let ty = self.type_expr(true)?;
            record.set(&name, ty);
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p("}")?;
        Ok(obj().with("record", record))
    }

    fn ref_type(&mut self) -> Res<O> {
        let name = self.qname()?;
        let mut ty = obj().with("ref", name);
        if self.eat_p("<") {
            let mut args: Vec<Node> = Vec::new();
            loop {
                args.push(Node::Obj(self.type_expr(false)?));
                if !self.eat_p(",") {
                    break;
                }
            }
            self.expect_p(">")?;
            ty.set("args", args);
        }
        Ok(ty)
    }

    // ── shared pieces ──────────────────────────────────────────────────

    /// Comma-separated expressions. Never takes `Name { … }`, so a following block stays a block.
    pub(super) fn expr_list(&mut self) -> Res<Vec<Node>> {
        let mut out = vec![Node::Obj(self.expr(true)?)];
        while self.eat_p(",") {
            out.push(Node::Obj(self.expr(true)?));
        }
        Ok(out)
    }

    pub(super) fn args(&mut self) -> Res<Vec<Node>> {
        self.expect_p("(")?;
        let mut out: Vec<Node> = Vec::new();
        while !self.is_p(")") {
            out.push(Node::Obj(self.arg()?));
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p(")")?;
        Ok(out)
    }

    fn arg(&mut self) -> Res<O> {
        let t = self.t();
        if t.kind == TokKind::Ident && is_p(self.la(1), ":") && !is_reserved(&t.text) {
            self.bump();
            self.bump();
            let value = self.expr(false)?;
            let named = obj().with("name", t.text.as_str()).with("value", value);
            return Ok(self.at(named, t));
        }
        let value = self.expr(false)?;
        Ok(self.at(obj().with("value", value), t))
    }

    fn call_spec(&mut self) -> Res<O> {
        let start = self.t();
        let mut c = obj().with("name", self.ident("a strategy name")?);
        if self.is_p("(") {
            let args = self.args()?;
            c.set("args", args);
        }
        Ok(self.at(c, start))
    }

    pub(super) fn block(&mut self) -> Res<Vec<Node>> {
        self.enter()?;
        let body = self.block_at();
        self.leave();
        body
    }

    fn block_at(&mut self) -> Res<Vec<Node>> {
        self.expect_p("{")?;
        let mut out: Vec<Node> = Vec::new();
        while !self.is_p("}") {
            if self.at_eof() {
                return Err(self.fail("Unterminated block; expected '}'.".to_owned()));
            }
            out.push(Node::Obj(self.stmt()?));
        }
        self.expect_p("}")?;
        Ok(out)
    }

    // ── statements ─────────────────────────────────────────────────────

    pub(super) fn stmt(&mut self) -> Res<O> {
        let start = self.t();
        if self.eat_w("let") {
            return self.let_stmt(start);
        }
        if self.eat_w("par") {
            return self.par_stmt(start);
        }
        if self.eat_w("if") {
            let s = self.if_rest()?;
            return Ok(self.at(s, start));
        }
        if self.eat_w("loop") {
            return self.loop_stmt(start);
        }
        if self.eat_w("return") {
            return self.return_stmt(start);
        }
        if self.is_w("on") && is_w(self.la(1), "error") {
            return self.on_error_stmt(start);
        }
        if self.in_test && self.is_w("run") {
            return self.run_stmt(start);
        }
        let value = self.expr(false)?;
        Ok(self.at(obj().with("op", "expr").with("value", value), start))
    }

    fn let_stmt(&mut self, start: &Token) -> Res<O> {
        let name = self.name()?;
        let mut s = obj()
            .with("op", "let")
            .with("name", name)
            .with("value", Node::Bool(false));
        if self.eat_p(":") {
            let ty = self.type_expr(false)?;
            s.set("type", ty);
        }
        self.expect_p("=")?;
        let value = self.expr(false)?;
        s.set("value", value);
        Ok(self.at(s, start))
    }

    fn par_stmt(&mut self, start: &Token) -> Res<O> {
        let mut s = obj().with("op", "par").with("branches", obj());
        if self.eat_w("supervise") {
            let supervise = self.call_spec()?;
            s.set("supervise", supervise);
        }
        let mut branches = obj();
        self.expect_p("{")?;
        while !self.is_p("}") {
            let t = self.t();
            let name = self.ident("a branch name")?;
            self.expect_p("=")?;
            if branches.has(&name) {
                self.dup("par branch", &name, t);
            }
            let branch = self.expr(false)?;
            branches.set(&name, branch);
        }
        self.expect_p("}")?;
        s.set("branches", branches);
        Ok(self.at(s, start))
    }

    fn loop_stmt(&mut self, start: &Token) -> Res<O> {
        let mut s = obj().with("op", "loop").with("body", Vec::new());
        if self.eat_w("max_iter") {
            if self.t().kind != TokKind::Int {
                return Err(self.fail("max_iter takes an integer.".to_owned()));
            }
            let max_iter = num_node(self.bump());
            s.set("max_iter", max_iter);
        } else if self.eat_w("until") {
            let until = self.expr(true)?;
            s.set("until", until);
        }
        let body = self.block()?;
        s.set("body", body);
        Ok(self.at(s, start))
    }

    fn return_stmt(&mut self, start: &Token) -> Res<O> {
        let mut s = obj().with("op", "return");
        // The value, if any, starts on the same line as `return`.
        if !self.is_p("}") && !self.t().nl {
            let value = self.expr(false)?;
            s.set("value", value);
        }
        Ok(self.at(s, start))
    }

    fn on_error_stmt(&mut self, start: &Token) -> Res<O> {
        self.bump();
        self.bump();
        self.expect_p("(")?;
        let pattern = self.pattern()?;
        self.expect_p(")")?;
        self.expect_p("=>")?;
        let then = self.expr(false)?;
        let s = obj()
            .with("op", "on_error")
            .with("pattern", pattern)
            .with("then", then);
        Ok(self.at(s, start))
    }

    fn run_stmt(&mut self, start: &Token) -> Res<O> {
        self.bump();
        let target = self.expr(false)?;
        self.expect_w("expect")?;
        let expect = self.ident("an expected outcome")?;
        let s = obj()
            .with("op", "run")
            .with("target", target)
            .with("expect", expect);
        Ok(self.at(s, start))
    }

    fn if_rest(&mut self) -> Res<O> {
        self.enter()?;
        let s = self.if_rest_at();
        self.leave();
        s
    }

    fn if_rest_at(&mut self) -> Res<O> {
        let cond = self.expr(true)?;
        let then = self.block()?;
        let mut s = obj().with("op", "if").with("cond", cond).with("then", then);
        if self.eat_w("else") {
            let t = self.t();
            if self.eat_w("if") {
                let inner = self.if_rest()?;
                let inner = self.at(inner, t);
                s.set("else", vec![Node::Obj(inner)]);
            } else {
                let otherwise = self.block()?;
                s.set("else", otherwise);
            }
        }
        Ok(s)
    }

    pub(super) fn pattern(&mut self) -> Res<O> {
        self.enter()?;
        let p = self.pattern_at();
        self.leave();
        p
    }

    fn pattern_at(&mut self) -> Res<O> {
        let start = self.t();
        if self.is_w("_") {
            self.bump();
            return Ok(self.at(obj().with("p", "wild"), start));
        }
        let name = self.ident("a pattern")?;
        if self.is_p("(") {
            self.bump();
            let mut args: Vec<Node> = Vec::new();
            while !self.is_p(")") {
                args.push(Node::Obj(self.pattern()?));
                if !self.eat_p(",") {
                    break;
                }
            }
            self.expect_p(")")?;
            let p = obj().with("p", "tag").with("tag", name).with("args", args);
            return Ok(self.at(p, start));
        }
        if starts_upper(&name) {
            return Ok(self.at(obj().with("p", "tag").with("tag", name), start));
        }
        Ok(self.at(obj().with("p", "bind").with("name", name), start))
    }

    // ── expressions ────────────────────────────────────────────────────

    /// `expr({ noStruct })`.
    pub(crate) fn expr(&mut self, no_struct: bool) -> Res<O> {
        self.binary(PREC_OR, no_struct)
    }

    pub(super) fn binary(&mut self, min_prec: u8, no_struct: bool) -> Res<O> {
        let start = self.t();
        let mut left = self.unary(min_prec, no_struct)?;
        loop {
            let Some(op) = self.binary_op() else {
                return Ok(left);
            };
            let prec = binary_prec(op).unwrap_or(0);
            if prec < min_prec {
                return Ok(left);
            }
            self.bump();
            let tighter = prec.saturating_add(1);
            if op == ".." {
                let to = self.binary(tighter, no_struct)?;
                let range = obj().with("op", "range").with("from", left).with("to", to);
                left = self.at(range, start);
                continue;
            }
            let right = self.binary(tighter, no_struct)?;
            let bop = if op == "\u{2286}" { "subseteq" } else { op };
            let binary = obj()
                .with("op", "binary")
                .with("bop", bop)
                .with("left", left)
                .with("right", right);
            left = self.at(binary, start);
            if prec == PREC_CMP && self.binary_op().and_then(binary_prec) == Some(PREC_CMP) {
                return Err(self.fail("Comparisons do not chain; add parentheses.".to_owned()));
            }
        }
    }

    fn binary_op(&self) -> Option<&'a str> {
        let t = self.t();
        match t.kind {
            TokKind::Punct if binary_prec(&t.text).is_some() => Some(t.text.as_str()),
            TokKind::Ident if matches!(t.text.as_str(), "and" | "or" | "in") => {
                Some(t.text.as_str())
            }
            _ => None,
        }
    }

    fn unary(&mut self, min_prec: u8, no_struct: bool) -> Res<O> {
        let start = self.t();
        if self.is_w("not") && min_prec <= PREC_NOT {
            self.bump();
            self.enter()?;
            let of = self.binary(PREC_NOT, no_struct);
            self.leave();
            let not = obj().with("op", "unary").with("uop", "not").with("of", of?);
            return Ok(self.at(not, start));
        }
        if self.is_p("-") {
            self.bump();
            self.enter()?;
            let of = self.unary(PREC_UNARY, no_struct);
            self.leave();
            let neg = obj().with("op", "unary").with("uop", "neg").with("of", of?);
            return Ok(self.at(neg, start));
        }
        self.postfix(no_struct)
    }

    fn postfix(&mut self, no_struct: bool) -> Res<O> {
        let start = self.t();
        let mut e = self.primary(no_struct)?;
        loop {
            if self.is_p(".") && self.la(1).kind == TokKind::Ident {
                self.bump();
                let name = self.bump().text.as_str();
                let field = obj().with("op", "field").with("of", e).with("name", name);
                e = self.at(field, start);
            } else if self.is_p("(") && !self.t().nl {
                // A `(` on a new line starts a new statement, not a call.
                let args = self.args()?;
                let call = obj()
                    .with("op", "call")
                    .with("callee", e)
                    .with("args", args);
                e = self.at(call, start);
            } else if self.is_p("?") && !self.t().nl {
                self.bump();
                e = self.at(obj().with("op", "try").with("of", e), start);
            } else if let Some(ty) = self.record_type_name(&e, no_struct) {
                let record = self.record_lit(ty)?;
                e = self.at(record, start);
            } else {
                return Ok(e);
            }
        }
    }

    /// The type name when a `{` here starts a record literal: on the line
    /// of a name that starts with a capital, where one is allowed.
    fn record_type_name(&self, e: &Obj, no_struct: bool) -> Option<String> {
        if !self.is_p("{") || self.t().nl || no_struct || e.str("op") != Some("var") {
            return None;
        }
        e.str("name")
            .filter(|name| starts_upper(name))
            .map(str::to_owned)
    }

    fn record_lit(&mut self, ty: String) -> Res<O> {
        self.expect_p("{")?;
        let mut fields = obj();
        while !self.is_p("}") {
            let t = self.t();
            let name = self.ident("a field name")?;
            if fields.has(&name) {
                self.dup("field", &name, t);
            }
            if self.eat_p(":") {
                let value = self.expr(false)?;
                fields.set(&name, value);
            } else {
                let shorthand = self.at(obj().with("op", "var").with("name", name.as_str()), t);
                fields.set(&name, shorthand);
            }
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p("}")?;
        Ok(obj()
            .with("op", "record")
            .with("type", ty)
            .with("fields", fields))
    }

    /// `primary(ctx)`.
    pub(super) fn primary(&mut self, no_struct: bool) -> Res<O> {
        self.enter()?;
        let e = self.primary_at(no_struct);
        self.leave();
        e
    }

    fn primary_at(&mut self, no_struct: bool) -> Res<O> {
        let t = self.t();
        match t.kind {
            TokKind::Int | TokKind::Dec => self.number_expr(t),
            TokKind::Duration => {
                self.bump();
                Ok(self.at(obj().with("op", "duration").with("ms", num_node(t)), t))
            }
            TokKind::String => self.template_expr(t, "template"),
            TokKind::Prompt => self.template_expr(t, "prompt"),
            TokKind::Punct if t.text == "(" => self.paren_expr(),
            TokKind::Punct if t.text == "[" => self.list_expr(t),
            TokKind::Punct if t.text == "{" && is_p(self.la(1), "}") => {
                self.bump();
                self.bump();
                Ok(self.at(obj().with("op", "set").with("items", Vec::new()), t))
            }
            TokKind::Ident => self.keyword_expr(t, no_struct),
            _ => Err(self.expected("an expression")),
        }
    }

    fn number_expr(&mut self, t: &'a Token) -> Res<O> {
        self.bump();
        let next = self.t();
        if next.kind == TokKind::Ident && is_currency(&next.text) {
            let currency = self.bump().text.as_str();
            let micros = money_micros(t, currency)?;
            let money = obj()
                .with("op", "money")
                .with("micros", micros)
                .with("currency", currency);
            return Ok(self.at(money, t));
        }
        if t.kind == TokKind::Int {
            return Ok(self.at(obj().with("op", "int").with("value", num_node(t)), t));
        }
        Ok(self.at(obj().with("op", "dec").with("value", t.text.as_str()), t))
    }

    fn template_expr(&mut self, t: &'a Token, op: &str) -> Res<O> {
        self.bump();
        let e = self.template(op, &t.parts)?;
        Ok(self.at(e, t))
    }

    fn paren_expr(&mut self) -> Res<O> {
        self.bump();
        let e = self.expr(false)?;
        self.expect_p(")")?;
        Ok(e)
    }

    fn list_expr(&mut self, t: &'a Token) -> Res<O> {
        self.bump();
        let mut items: Vec<Node> = Vec::new();
        while !self.is_p("]") {
            items.push(Node::Obj(self.expr(false)?));
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p("]")?;
        Ok(self.at(obj().with("op", "list").with("items", items), t))
    }

    fn keyword_expr(&mut self, t: &'a Token, no_struct: bool) -> Res<O> {
        match t.text.as_str() {
            "true" | "false" => {
                self.bump();
                let value = t.text == "true";
                return Ok(self.at(obj().with("op", "bool").with("value", value), t));
            }
            "delegate" => {
                let e = self.delegate_expr()?;
                return Ok(self.at(e, t));
            }
            "spawn" => return self.spawn_expr(t),
            "await" => return self.await_expr(t, no_struct),
            "verify" => {
                let e = self.verify_expr()?;
                return Ok(self.at(e, t));
            }
            "infer" => return self.infer_expr(t),
            "effect" => return self.effect_expr(t),
            "switch" => return self.switch_expr(t),
            _ => {}
        }
        // Contextual expression keywords: only when what follows can start an operand.
        if t.text == "changeset" && is_p(self.la(1), "(") {
            let e = self.changeset_expr()?;
            return Ok(self.at(e, t));
        }
        // `map x in xs …` and `plan Agent.skill(…) …` (0.4): two names in a row on one line start nothing else.
        if t.text == "map" && self.starts_map() {
            let e = self.map_expr()?;
            return Ok(self.at(e, t));
        }
        if t.text == "plan" && self.starts_plan() {
            let e = self.plan_expr()?;
            return Ok(self.at(e, t));
        }
        if t.text == "escalate" && starts_operand(self.la(1)) {
            return self.escalate_expr(t, no_struct);
        }
        if t.text == "pause" {
            return self.pause_expr(t, no_struct);
        }
        if is_reserved(&t.text) {
            return Err(self.unexpected_keyword(t));
        }
        self.bump();
        Ok(self.at(obj().with("op", "var").with("name", t.text.as_str()), t))
    }

    fn unexpected_keyword(&self, t: &Token) -> Fail {
        self.fail(format!("Unexpected keyword '{}' in an expression.", t.text))
    }

    fn starts_map(&self) -> bool {
        self.la(1).kind == TokKind::Ident
            && !self.la(1).nl
            && is_w(self.la(2), "in")
            && !self.la(2).nl
    }

    fn starts_plan(&self) -> bool {
        self.la(1).kind == TokKind::Ident
            && !self.la(1).nl
            && is_p(self.la(2), ".")
            && self.la(3).kind == TokKind::Ident
            && is_p(self.la(4), "(")
    }

    fn spawn_expr(&mut self, t: &'a Token) -> Res<O> {
        self.bump();
        let agent = self.ident("an agent name")?;
        self.expect_p(".")?;
        let skill = self.ident("a skill name")?;
        let args = self.args()?;
        let e = obj()
            .with("op", "spawn")
            .with("agent", agent)
            .with("skill", skill)
            .with("args", args);
        Ok(self.at(e, t))
    }

    fn await_expr(&mut self, t: &'a Token, no_struct: bool) -> Res<O> {
        self.bump();
        let of = self.unary(PREC_UNARY, no_struct)?;
        Ok(self.at(obj().with("op", "await").with("of", of), t))
    }

    fn infer_expr(&mut self, t: &'a Token) -> Res<O> {
        self.bump();
        let ty = self.type_expr(false)?;
        self.expect_w("from")?;
        let from = self.binary(PREC_OR, true)?;
        let mut e = obj()
            .with("op", "infer")
            .with("type", ty)
            .with("from", from);
        if self.eat_w("using") {
            let using = self.expr(false)?;
            e.set("using", using);
        }
        Ok(self.at(e, t))
    }

    fn effect_expr(&mut self, t: &'a Token) -> Res<O> {
        self.bump();
        let name = self.qname()?;
        let args = self.args()?;
        let mut e = obj()
            .with("op", "effect")
            .with("name", name)
            .with("args", args);
        if self.eat_w("idempotent_by") {
            let key = self.expr(false)?;
            e.set("idempotent_by", key);
        }
        if self.eat_w("compensate") {
            let compensate = self.qname()?;
            e.set("compensate", compensate);
        }
        Ok(self.at(e, t))
    }

    fn switch_expr(&mut self, t: &'a Token) -> Res<O> {
        self.bump();
        let on = self.expr(true)?;
        self.expect_p("{")?;
        let mut cases: Vec<Node> = Vec::new();
        while !self.is_p("}") {
            cases.push(Node::Obj(self.switch_case()?));
            self.eat_p(",");
        }
        self.expect_p("}")?;
        let e = obj()
            .with("op", "switch")
            .with("on", on)
            .with("cases", cases);
        Ok(self.at(e, t))
    }

    fn switch_case(&mut self) -> Res<O> {
        let ct = self.t();
        let pattern = self.pattern()?;
        self.expect_p("=>")?;
        let bt = self.t();
        let then = if self.is_p("{") {
            let body = self.block()?;
            self.at(obj().with("op", "block").with("body", body), bt)
        } else {
            self.expr(false)?
        };
        Ok(self.at(obj().with("pattern", pattern).with("then", then), ct))
    }

    fn escalate_expr(&mut self, t: &'a Token, no_struct: bool) -> Res<O> {
        self.bump();
        let to = self.binary(ABOVE_AND, no_struct)?;
        Ok(self.at(obj().with("op", "escalate").with("to", to), t))
    }

    fn pause_expr(&mut self, t: &'a Token, no_struct: bool) -> Res<O> {
        self.bump();
        let mut e = obj().with("op", "pause");
        if self.eat_w("and") {
            let then = self.binary(ABOVE_AND, no_struct)?;
            e.set("then", then);
        }
        Ok(self.at(e, t))
    }

    fn delegate_expr(&mut self) -> Res<O> {
        self.bump();
        let agent = self.ident("an agent name")?;
        self.expect_p(".")?;
        let skill = self.ident("a skill name")?;
        let args = self.args()?;
        let mut e = obj()
            .with("op", "delegate")
            .with("agent", agent)
            .with("skill", skill)
            .with("args", args);
        loop {
            if self.is_w("with") && is_w(self.la(1), "caps") {
                self.bump();
                self.bump();
                let caps = sort_canon(self.expr_list()?);
                e.set("caps", caps);
            } else if self.is_w("budget") && is_p(self.la(1), "{") {
                let budget = self.budget()?;
                e.set("budget", budget);
            } else if self.eat_w("isolated") {
                e.set("isolated", true);
            } else if self.eat_w("timeout") {
                let timeout = self.unary(PREC_UNARY, false)?;
                e.set("timeout", timeout);
            } else if self.eat_w("supervise") {
                let supervise = self.call_spec()?;
                e.set("supervise", supervise);
            } else {
                return Ok(e);
            }
        }
    }

    /// `map x in xs [max n] [par k] [with caps K] [budget { … }] [supervise s] { body }`
    /// (0.4; spec/envelope.md "map"). The options come in any order, each once.
    fn map_expr(&mut self) -> Res<O> {
        self.bump();
        let bind = self.ident("a name for one element")?;
        self.expect_w("in")?;
        let over = self.expr(true)?;
        let mut e = obj()
            .with("op", "map")
            .with("bind", bind)
            .with("over", over)
            .with("body", Vec::new());
        loop {
            if self.is_w("max") && self.la(1).kind == TokKind::Int {
                let max = self.map_whole(&e, "max")?;
                e.set("max", max);
            } else if self.is_w("par") && self.la(1).kind == TokKind::Int {
                let par = self.map_whole(&e, "par")?;
                e.set("par", par);
            } else if self.is_w("with") && is_w(self.la(1), "caps") {
                self.bump();
                self.bump();
                let caps = sort_canon(self.expr_list()?);
                e.set("caps", caps);
            } else if self.is_w("budget") && is_p(self.la(1), "{") {
                let budget = self.budget()?;
                e.set("budget", budget);
            } else if self.eat_w("supervise") {
                let supervise = self.call_spec()?;
                e.set("supervise", supervise);
            } else {
                break;
            }
        }
        let body = self.block()?;
        e.set("body", body);
        Ok(e)
    }

    /// `whole(what)` in `mapExpr`: the number after `max` or `par`.
    fn map_whole(&mut self, e: &Obj, what: &str) -> Res<Node> {
        let kt = self.bump();
        let vt = self.t();
        if vt.kind != TokKind::Int || vt.num.unwrap_or(0.0) < 1.0 {
            return Err(fail_at(
                format!("'{what}' takes a whole number, at least 1."),
                vt,
            ));
        }
        if e.has(what) {
            self.dup("map option", what, kt);
        }
        self.bump();
        Ok(num_node(vt))
    }

    /// `plan Agent.skill(args) [budget { … }] within envelope` (0.4; spec/envelope.md "plan").
    fn plan_expr(&mut self) -> Res<O> {
        self.bump();
        let agent = self.ident("an agent name")?;
        self.expect_p(".")?;
        let skill = self.ident("a skill name")?;
        let args = self.args()?;
        let mut e = obj()
            .with("op", "plan")
            .with("agent", agent)
            .with("skill", skill)
            .with("args", args);
        if self.is_w("budget") && is_p(self.la(1), "{") {
            let budget = self.budget()?;
            e.set("budget", budget);
        }
        self.expect_w("within")?;
        self.expect_w("envelope")?;
        Ok(e)
    }

    /// `changeset(plan) { member c = effect(args) [approved_by role "r"] …
    /// order c, … change Interface kind … approve role "r" } [idempotent_by e]`
    /// (0.3; design doc 9 §3).
    fn changeset_expr(&mut self) -> Res<O> {
        self.bump();
        self.expect_p("(")?;
        let plan = self.expr(false)?;
        self.expect_p(")")?;
        // `members`, `order` and `approver` are made here and filled below;
        // `changes` is made at the first `change`, after all three.
        let mut e = obj()
            .with("op", "changeset")
            .with("plan", plan)
            .with("members", obj())
            .with("order", Vec::new())
            .with("approver", "");
        let mut members = obj();
        let mut order: Vec<Node> = Vec::new();
        let mut approver = String::new();
        let mut changes: Option<O> = None;
        let mut ordered = false;
        self.expect_p("{")?;
        while !self.is_p("}") {
            let t = self.t();
            let word = self.ident("member, order, change or approve")?;
            match word.as_str() {
                "member" => self.changeset_member(&mut members)?,
                "order" => {
                    if ordered {
                        self.dup("change set field", "order", t);
                    }
                    ordered = true;
                    loop {
                        order.push(Node::Str(self.ident("a member name")?));
                        if !self.eat_p(",") {
                            break;
                        }
                    }
                }
                "change" => {
                    let it = self.t();
                    let iface = self.ident("an interface name")?;
                    let kt = self.t();
                    let kind = self.ident("additive, breaking or none")?;
                    if !matches!(kind.as_str(), "additive" | "breaking" | "none") {
                        return Err(fail_at(
                            format!(
                                "Unknown change kind '{kind}'; expected additive, breaking or none."
                            ),
                            kt,
                        ));
                    }
                    let changes = changes.get_or_insert_with(obj);
                    if changes.has(&iface) {
                        self.dup("interface change", &iface, it);
                    }
                    changes.set(&iface, kind);
                }
                "approve" => {
                    if !approver.is_empty() {
                        self.dup("change set field", "approve", t);
                    }
                    self.expect_w("role")?;
                    approver = self.string("a role")?;
                }
                _ => {
                    return Err(fail_at(
                        format!(
                            "Expected member, order, change or approve in a change set but found '{word}'."
                        ),
                        t,
                    ));
                }
            }
        }
        self.expect_p("}")?;
        if approver.is_empty() {
            return Err(self.fail(
                "A change set names the role that approves it: approve role \"\u{2026}\"."
                    .to_owned(),
            ));
        }
        if !ordered {
            return Err(
                self.fail("A change set lists its commit order: order c, \u{2026}.".to_owned())
            );
        }
        e.set("members", members);
        e.set("order", order);
        e.set("approver", approver);
        e = e.with_some("changes", changes);
        if self.eat_w("idempotent_by") {
            let key = self.expr(false)?;
            e.set("idempotent_by", key);
        }
        Ok(e)
    }

    fn changeset_member(&mut self, members: &mut Obj) -> Res<()> {
        let mt = self.t();
        let name = self.ident("a component name")?;
        self.expect_p("=")?;
        let effect = self.qname()?;
        let args = self.args()?;
        let mut m = obj().with("effect", effect).with("args", args);
        if self.eat_w("approved_by") {
            self.expect_w("role")?;
            let approver = self.string("a role")?;
            m.set("approver", approver);
        }
        if members.has(&name) {
            self.dup("change set member", &name, mt);
        }
        let m = self.at(m, mt);
        members.set(&name, m);
        Ok(())
    }

    fn verify_expr(&mut self) -> Res<O> {
        self.bump();
        let value = self.expr(false)?;
        self.expect_w("against")?;
        let contract = self.ident("a contract name")?;
        let args = self.args()?;
        let mut e = obj()
            .with("op", "verify")
            .with("value", value)
            .with("contract", contract)
            .with("args", args);
        if self.is_w("on") && is_w(self.la(1), "unmet") {
            let start = self.bump();
            self.bump();
            self.expect_p("(")?;
            let bind = self.ident("a binding name")?;
            self.expect_p(")")?;
            self.expect_p("=>")?;
            let then = self.expr(false)?;
            let on_unmet = self.at(obj().with("bind", bind).with("then", then), start);
            e.set("on_unmet", on_unmet);
        }
        Ok(e)
    }

    /// `template(op, raw)`: each interpolation read by a lexer and a parser
    /// of its own, whose diagnostics join this one's when it has been read.
    fn template(&mut self, op: &str, raw: &[RawPart]) -> Res<O> {
        let mut parts: Vec<Node> = Vec::new();
        let mut all_text = true;
        for p in raw {
            match p {
                RawPart::Text(text) => parts.push(Node::Obj(obj().with("text", text.as_str()))),
                RawPart::Src { src, line, col } => {
                    all_text = false;
                    let expr = self.interpolation(src, *line, *col)?;
                    parts.push(Node::Obj(obj().with("expr", expr)));
                }
            }
        }
        if op == "template" && all_text {
            let mut value = String::new();
            for p in raw {
                if let RawPart::Text(text) = p {
                    value.push_str(text);
                }
            }
            return Ok(obj().with("op", "text").with("value", value));
        }
        Ok(obj().with("op", op).with("parts", parts))
    }

    fn interpolation(&mut self, src: &[u16], line: usize, col: usize) -> Res<O> {
        let toks = Lexer::new(src, line, col).tokenize()?;
        let mut sub = Parser::new(&toks);
        let expr = sub.expr(false)?;
        if !sub.at_eof() {
            return Err(sub.fail(format!(
                "Unexpected {} in interpolation.",
                describe(sub.t())
            )));
        }
        self.diagnostics.append(&mut sub.diagnostics);
        Ok(expr)
    }
}
