//! The parser of Mandate text: a port of `compiler/src/parse/parser.ts`.
//!
//! It lowers straight into IR ([`crate::node`]) and gives each object it
//! builds the span of the tokens it read for it, as the TypeScript one does.
//! The structure is the TypeScript's, function for function, so that the
//! two can be read side by side: [`decl`] holds the declarations, [`expr`]
//! the types, statements, patterns and expressions.
//!
//! The parser recurses once for each level of nesting in the text, and stops
//! at [`JSON_DEPTH`] levels (`nest`). An interpolation is read by a parser of
//! its own whose count starts again at zero, and an interpolation cannot
//! hold a string, so the deepest the recursion goes is twice that. The
//! arguments of a call and the fields of a record literal, which `nest` does
//! not count, have a count of their own here ([`Parser::enter_postfix`]),
//! which the TypeScript does not have. The functions on the path of the
//! recursion keep their frames small (see [`expr`]).

mod decl;
mod expr;

use mandate_ir::{
    Diagnostic, JsObject, JsValue, Location,
    limits::{JSON_DEPTH, SOURCE_BYTES},
    sort_utf16, unique_in_order,
};

use crate::lexer::{Fail, Lexer, TokKind, Token, token_span};
use crate::node::{Node, O, Obj, obj, sort_canon, too_deep};

/// What a parse step gives: a value, or the diagnostic that stops the
/// reading.
pub(crate) type Res<T> = Result<T, Fail>;

/// `parseMdt(src)`: the program, and what the parser found while it read
/// on; or the one diagnostic that stopped it.
///
/// It refuses an input of more than [`SOURCE_BYTES`] bytes of UTF-8 before
/// reading it, as the JSON reader does; lexes the whole input, so that a
/// lexical error anywhere is the one reported; parses; and refuses an IR
/// nested deeper than [`JSON_DEPTH`] (`tooDeep`).
pub(crate) fn parse_program(src: &str) -> Result<(Node, Vec<Diagnostic>), Fail> {
    let bytes = src.len();
    if bytes > SOURCE_BYTES {
        let facts = JsObject::new()
            .with("limit", SOURCE_BYTES)
            .with("actual", bytes);
        return Err(Box::new(Diagnostic::new(
            "E0105",
            format!("Input exceeds the {SOURCE_BYTES}-byte source limit."),
            Location::default(),
            Some(facts),
        )));
    }
    let units: Vec<u16> = src.encode_utf16().collect();
    let toks = Lexer::new(&units, 1, 1).tokenize()?;
    let mut p = Parser::new(&toks);
    let program = Node::Obj(p.program()?);
    if let Some(deep) = too_deep(&program) {
        return Err(deep);
    }
    Ok((program, p.diagnostics))
}

/// `PREC_AND + 1`: what binds tighter than `and` (a verifier's operand, the
/// target of `escalate`, what follows `pause and`).
const ABOVE_AND: u8 = expr::PREC_AND + 1;

/// The names an object made as `{}` has through `Object.prototype`, which
/// `key in o` finds although the object has no such member.
const OBJECT_PROTOTYPE: [&str; 12] = [
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

/// `key in o` for an object the TypeScript makes as `{}` (`budget`,
/// `progress`, `spawn`), where a name of `Object.prototype` is found too.
/// The parser refuses such a name as unknown right after asking, so the
/// duplicate it reports for one is never seen; it is kept for fidelity.
/// The maps the TypeScript makes with `Object.create(null)` use
/// [`Obj::has`].
fn in_plain_object(o: &Obj, key: &str) -> bool {
    o.has(key) || OBJECT_PROTOTYPE.contains(&key)
}

/// `Unknown data class '<cls>'; expected one of …` at `t`.
fn unknown_class(cls: &str, t: &Token) -> Fail {
    fail_at(
        format!(
            "Unknown data class '{cls}'; expected one of {}.",
            DATA_CLASSES.join(", ")
        ),
        t,
    )
}

/// `RESERVED` in `parser.ts`: the words that cannot be a name.
pub const RESERVED: [&str; 34] = [
    "module",
    "use",
    "type",
    "enum",
    "capability",
    "fn",
    "pub",
    "extern",
    "effect",
    "agent",
    "skill",
    "workflow",
    "contract",
    "let",
    "par",
    "delegate",
    "spawn",
    "await",
    "verify",
    "infer",
    "if",
    "else",
    "loop",
    "return",
    "switch",
    "on",
    "with",
    "in",
    "where",
    "and",
    "or",
    "not",
    "true",
    "false",
];

/// `LANGUAGE_VERSIONS` in `compiler/src/ir/types.ts`.
pub(crate) const LANGUAGE_VERSIONS: [&str; 5] = [
    "mandate/0.1",
    "mandate/0.2",
    "mandate/0.3",
    "mandate/0.4",
    "mandate/0.5",
];

/// `DATA_CLASSES` in `compiler/src/std/std.ts`.
pub(crate) const DATA_CLASSES: [&str; 4] = ["public", "internal", "confidential", "restricted"];

/// `INTERFACE_PROTOCOLS` in `compiler/src/ir/types.ts`.
pub(crate) const INTERFACE_PROTOCOLS: [&str; 5] =
    ["openapi", "mcp_tools", "oauth", "event", "db_schema"];

fn is_reserved(word: &str) -> bool {
    RESERVED.contains(&word)
}

/// `/^[A-Z]/.test(name)`.
pub(crate) fn starts_upper(name: &str) -> bool {
    name.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
}

/// The end-of-input token that stands in should a token list be empty
/// (the lexer always ends one with an `eof`).
static EOF: Token = Token {
    kind: TokKind::Eof,
    text: String::new(),
    num: None,
    parts: Vec::new(),
    nl: false,
    line: 1,
    col: 1,
    end_line: 1,
    end_col: 1,
};

/// `isP(text, t)`.
pub(crate) fn is_p(t: &Token, text: &str) -> bool {
    t.kind == TokKind::Punct && t.text == text
}

/// `isW(word, t)`.
pub(crate) fn is_w(t: &Token, word: &str) -> bool {
    t.kind == TokKind::Ident && t.text == word
}

/// `describe(t)`: how a message names the token found.
pub(crate) fn describe(t: &Token) -> String {
    match t.kind {
        TokKind::Eof => "end of input".to_owned(),
        TokKind::String | TokKind::Prompt => "a string".to_owned(),
        _ => format!("'{}'", t.text),
    }
}

/// `fail(message, t)`: `MDT-E0101` at the token.
pub(crate) fn fail_at(message: String, t: &Token) -> Fail {
    Box::new(Diagnostic::new(
        "E0101",
        message,
        Location::span(token_span(t)),
        None,
    ))
}

/// `[...new Set(items)].sort()`, as a list of strings.
pub(crate) fn sorted_set(items: Vec<String>) -> Vec<Node> {
    let mut unique = unique_in_order(items);
    sort_utf16(&mut unique);
    unique.into_iter().map(Node::Str).collect()
}

/// An integer token's number, or a duration's milliseconds, as the IR
/// number it is (the lexer makes only safe integers).
pub(crate) fn num_node(t: &Token) -> Node {
    Node::Int(mandate_ir::Int::saturating(t.num.unwrap_or(0.0) as i64))
}

/// The parser: `new Parser(toks, spans)`.
pub(crate) struct Parser<'a> {
    toks: &'a [Token],
    i: usize,
    /// The version the file declares; a message names the fields that
    /// version has.
    language: &'static str,
    /// What the parser found while it read on: `MDT-E0103`, `MDT-E0121`,
    /// `MDT-E0120`.
    pub(crate) diagnostics: Vec<Diagnostic>,
    in_test: bool,
    /// How many expressions, types, blocks, patterns and operators the
    /// parser is inside.
    depth: usize,
    /// How many call argument lists and record literals the parser is inside
    /// (Rust only; see [`Parser::enter_postfix`]).
    postfix_depth: usize,
}

impl<'a> Parser<'a> {
    pub(crate) fn new(toks: &'a [Token]) -> Parser<'a> {
        Parser {
            toks,
            i: 0,
            language: "mandate/0.1",
            diagnostics: Vec::new(),
            in_test: false,
            depth: 0,
            postfix_depth: 0,
        }
    }

    // ── token helpers ──────────────────────────────────────────────────

    fn tok(&self, i: usize) -> &'a Token {
        self.toks.get(i).or(self.toks.last()).unwrap_or(&EOF)
    }

    /// `this.t`.
    pub(crate) fn t(&self) -> &'a Token {
        self.tok(self.i)
    }

    fn at_eof(&self) -> bool {
        self.t().kind == TokKind::Eof
    }

    /// `la(n)`: the token `n` on, or the last one.
    fn la(&self, n: usize) -> &'a Token {
        let last = self.toks.len().saturating_sub(1);
        self.tok(self.i.saturating_add(n).min(last))
    }

    fn bump(&mut self) -> &'a Token {
        let t = self.t();
        if t.kind != TokKind::Eof {
            self.i = self.i.saturating_add(1);
        }
        t
    }

    fn is_p(&self, text: &str) -> bool {
        is_p(self.t(), text)
    }

    fn is_w(&self, word: &str) -> bool {
        is_w(self.t(), word)
    }

    fn eat_p(&mut self, text: &str) -> bool {
        if self.is_p(text) {
            self.bump();
            return true;
        }
        false
    }

    fn eat_w(&mut self, word: &str) -> bool {
        if self.is_w(word) {
            self.bump();
            return true;
        }
        false
    }

    /// `fail(message)`: at the token the parser is at.
    fn fail(&self, message: String) -> Fail {
        fail_at(message, self.t())
    }

    /// `Expected <what> but found <the token>.`
    fn expected(&self, what: &str) -> Fail {
        self.fail(format!("Expected {what} but found {}.", describe(self.t())))
    }

    fn expect_p(&mut self, text: &str) -> Res<&'a Token> {
        if !self.is_p(text) {
            return Err(self.expected(&format!("'{text}'")));
        }
        Ok(self.bump())
    }

    fn expect_w(&mut self, word: &str) -> Res<&'a Token> {
        if !self.is_w(word) {
            return Err(self.expected(&format!("'{word}'")));
        }
        Ok(self.bump())
    }

    fn reserved(&self, what: &str) -> Fail {
        self.fail(format!(
            "'{}' is a reserved keyword and cannot be used as {what}.",
            self.t().text
        ))
    }

    /// `ident(what)`: a name that is not a reserved word.
    fn ident(&mut self, what: &str) -> Res<String> {
        let t = self.t();
        if t.kind != TokKind::Ident {
            return Err(self.expected(what));
        }
        if is_reserved(&t.text) {
            return Err(self.reserved(what));
        }
        self.bump();
        Ok(t.text.clone())
    }

    /// `ident()`: `ident("a name")`.
    fn name(&mut self) -> Res<String> {
        self.ident("a name")
    }

    /// `qname()`: names joined by `.`.
    fn qname(&mut self) -> Res<String> {
        let mut name = self.name()?;
        while self.is_p(".") && self.la(1).kind == TokKind::Ident {
            self.bump();
            name.push('.');
            name.push_str(&self.name()?);
        }
        Ok(name)
    }

    /// `string(what)`: a string literal without interpolation, as its text.
    fn string(&mut self, what: &str) -> Res<String> {
        let t = self.t();
        if t.kind != TokKind::String {
            return Err(self.expected(what));
        }
        self.bump();
        if t.parts
            .iter()
            .any(|p| matches!(p, crate::lexer::RawPart::Src { .. }))
        {
            return Err(fail_at(
                format!("Interpolation is not allowed in {what}."),
                t,
            ));
        }
        let mut out = String::new();
        for p in &t.parts {
            if let crate::lexer::RawPart::Text(text) = p {
                out.push_str(text);
            }
        }
        Ok(out)
    }

    /// The first half of `nest`: one level deeper, or `MDT-E0105` at the
    /// token when the text is nested deeper than the IR may be. The caller
    /// calls [`Parser::leave`] after the step, whatever it gave (`finally`).
    fn enter(&mut self) -> Res<()> {
        if self.depth >= JSON_DEPTH {
            return Err(self.too_deep());
        }
        self.depth = self.depth.saturating_add(1);
        Ok(())
    }

    fn leave(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    /// One level deeper into the arguments of a call or the fields of a
    /// record literal, which the TypeScript reads without `nest`: `f(f(…))`
    /// and `T { a: T { … } }` are refused there only after they are read, by
    /// the depth of their IR, and past some three thousand levels V8's stack
    /// runs out (a `RangeError`, which `parseMdt` throws on). This port
    /// cannot follow it there without running out of stack itself, so it
    /// refuses, as `nest` does, the [`JSON_DEPTH`]th level, counted on from
    /// the enclosing text into an interpolation.
    ///
    /// No input that TypeScript reads is refused here: every such level adds
    /// at least two levels to the IR (`fields`, or `args` and an argument), so
    /// one 64 deep is far deeper than the IR may be. What differs is the
    /// diagnostic: TypeScript gives the `MDT-E0105` of the IR's depth, at its
    /// first value too deep, or a syntax error that comes later in the text.
    fn enter_postfix(&mut self) -> Res<()> {
        if self.postfix_depth >= JSON_DEPTH {
            return Err(self.too_deep());
        }
        self.postfix_depth = self.postfix_depth.saturating_add(1);
        Ok(())
    }

    fn leave_postfix(&mut self) {
        self.postfix_depth = self.postfix_depth.saturating_sub(1);
    }

    fn too_deep(&self) -> Fail {
        let facts = JsObject::new().with("limit", JSON_DEPTH);
        Box::new(Diagnostic::new(
            "E0105",
            format!("Nesting exceeds the depth limit of {JSON_DEPTH}."),
            Location::span(token_span(self.t())),
            Some(facts),
        ))
    }

    /// `at(node, start)`: the span from `start` to the previous token.
    fn at(&self, mut node: O, start: &Token) -> O {
        let end = self.tok(self.i.saturating_sub(1));
        node.span = Some(mandate_ir::Span {
            start_line: start.line,
            start_col: start.col,
            end_line: end.end_line,
            end_col: end.end_col,
        });
        node
    }

    /// `dup(kind, name, t)`: `MDT-E0121`, and the reading goes on.
    fn dup(&mut self, kind: &str, name: &str, t: &Token) {
        let facts = JsObject::new().with("name", name);
        self.diagnostics.push(Diagnostic::new(
            "E0121",
            format!("Duplicate {kind} '{name}'."),
            Location::span(token_span(t)),
            Some(facts),
        ));
    }

    // ── program ────────────────────────────────────────────────────────

    /// `program()`.
    pub(crate) fn program(&mut self) -> Res<O> {
        let start = self.t();
        // `mandate @ 0.2` names the language version; a file without it is 0.1.
        let mut language = "mandate/0.1";
        if self.is_w("mandate") && is_p(self.la(1), "@") {
            let lang_tok = self.bump();
            self.bump();
            if self.t().kind != TokKind::Version {
                return Err(self.expected("a language version after 'mandate @'"));
            }
            let v = format!("mandate/{}", self.bump().text);
            match LANGUAGE_VERSIONS.iter().find(|known| **known == v) {
                Some(known) => {
                    self.language = known;
                    language = known;
                }
                None => self.diagnostics.push(unsupported_language(&v, lang_tok)),
            }
        }
        self.expect_w("module")?;
        let module = self.qname()?;
        self.expect_p("@")?;
        if self.t().kind != TokKind::Version {
            return Err(self.expected("a module version after '@'"));
        }
        let version = self.bump().text.clone();

        let mut uses: Vec<Node> = Vec::new();
        while self.is_w("use") {
            uses.push(Node::Obj(self.use_decl()?));
        }

        let mut defs = obj();
        let mut tests = obj();
        let mut handlers: Vec<(String, O, &'a Token)> = Vec::new();

        while !self.at_eof() {
            let t = self.t();
            if self.is_w("on") {
                handlers.push(self.top_level_on()?);
                continue;
            }
            if self.is_w("test") && self.la(1).kind == TokKind::String {
                self.bump();
                let name_tok = self.t();
                let name = self.string("a test name")?;
                let body = self.test_body()?;
                let test = self.at(body, t);
                if tests.has(&name) {
                    self.dup("test", &name, name_tok);
                }
                tests.set(&name, test);
                continue;
            }
            let (name, def, name_tok) = self.decl()?;
            if defs.has(&name) {
                self.dup("definition", &name, name_tok);
            }
            let def = self.at(def, t);
            defs.set(&name, def);
        }

        for (target, handler, tok) in handlers {
            let workflow = defs
                .get_mut(&target)
                .and_then(Node::as_obj_mut)
                .filter(|wf| wf.str("kind") == Some("workflow"));
            match workflow {
                Some(wf) => wf.push("on", handler),
                None => self.diagnostics.push(no_workflow(&target, tok)),
            }
        }

        let mut program = obj()
            .with("language", language)
            .with("module", module)
            .with("version", version)
            .with("defs", defs);
        if !uses.is_empty() {
            program.set("uses", sort_canon(uses));
        }
        if !tests.is_empty() {
            program.set("tests", tests);
        }
        Ok(self.at(program, start))
    }

    fn use_decl(&mut self) -> Res<O> {
        let start = self.bump();
        let module = self.qname()?;
        let mut u = obj().with("module", module);
        if self.is_p(".") && is_p(self.la(1), "{") {
            self.bump();
            self.bump();
            let mut names: Vec<String> = Vec::new();
            while !self.is_p("}") {
                names.push(self.ident("an imported name")?);
                if !self.eat_p(",") {
                    break;
                }
            }
            self.expect_p("}")?;
            u.set("names", sorted_set(names));
        }
        Ok(self.at(u, start))
    }

    fn top_level_on(&mut self) -> Res<(String, O, &'a Token)> {
        let start = self.bump();
        let event = self.ident("an event name")?;
        self.expect_w("in")?;
        let tok = self.t();
        let target = self.ident("a workflow name")?;
        self.expect_p("=>")?;
        let then = self.expr(false)?;
        let handler = self.at(obj().with("event", event).with("then", then), start);
        Ok((target, handler, tok))
    }
}

/// `MDT-E0103` for a language line this compiler does not read.
fn unsupported_language(v: &str, lang_tok: &Token) -> Diagnostic {
    let quoted: Vec<String> = LANGUAGE_VERSIONS.iter().map(|x| format!("'{x}'")).collect();
    let expected: Vec<JsValue> = LANGUAGE_VERSIONS
        .iter()
        .map(|x| JsValue::from(*x))
        .collect();
    let facts = JsObject::new().with("expected", expected).with("found", v);
    Diagnostic::new(
        "E0103",
        format!(
            "Unsupported language version '{v}'; this compiler reads {}.",
            quoted.join(" or ")
        ),
        Location::span(token_span(lang_tok)),
        Some(facts),
    )
}

/// `MDT-E0120` for a handler whose target is not a workflow.
fn no_workflow(target: &str, tok: &Token) -> Diagnostic {
    let facts = JsObject::new().with("name", target);
    Diagnostic::new(
        "E0120",
        format!("Handler targets '{target}', which is not a workflow in this module."),
        Location::span(token_span(tok)),
        Some(facts),
    )
}
