//! The declarations, the system model, contracts, tests and the pieces they
//! share (`params`, `effects`, `progress`, `budget`): the second part of
//! `parser.ts`.
//!
//! Member order is the order of first assignment in the TypeScript. Where
//! the TypeScript makes a member early and fills it later (`body: []`, then
//! `def.body = this.block()`; `caps: []`, then `def.caps.push(…)`), this
//! port either does the same or makes the member's value in a local and
//! assigns it at the end, which leaves the member in its early place. Where
//! a member is first made late (`def.reads ??= …` at the first `read`), it
//! is made at the same point here.

use std::collections::HashSet;

use super::{
    ABOVE_AND, DATA_CLASSES, INTERFACE_PROTOCOLS, LANGUAGE_VERSIONS, Parser, Res, describe,
    fail_at, in_plain_object, is_p, is_reserved, is_w, num_node, sorted_set, unknown_class,
};
use crate::lexer::{Fail, TokKind, Token};
use crate::node::{Node, O, Obj, obj, sort_canon};

/// What a declaration gives: its name, its definition, and the token of its
/// name (where a duplicate is reported).
pub(super) type Decl<'a> = (String, O, &'a Token);

/// A member the TypeScript makes with a placeholder value and assigns again
/// before the object is done (`value: { op: "int", value: 0 }`): only its
/// place matters.
fn placeholder() -> Node {
    Node::Bool(false)
}

/// A scalar member of an expression the parser has just read, such as the
/// `value` of an `int`: `(v as { value: number }).value`.
fn scalar(o: &Obj, key: &str) -> Node {
    match o.get(key) {
        Some(Node::Int(n)) => Node::Int(*n),
        Some(Node::Str(s)) => Node::Str(s.clone()),
        Some(Node::Bool(b)) => Node::Bool(*b),
        _ => placeholder(),
    }
}

fn bad_budget(key: &str, want: &str, vt: &Token) -> Fail {
    fail_at(format!("Budget field '{key}' takes {want}."), vt)
}

impl<'a> Parser<'a> {
    /// `decl()`.
    pub(super) fn decl(&mut self) -> Res<Decl<'a>> {
        let t = self.t();
        if t.kind != TokKind::Ident {
            return Err(self.expected("a declaration"));
        }
        let text = t.text.as_str();
        // The system model's kinds are contextual: `component.read(…)` stays an expression elsewhere.
        if matches!(text, "component" | "interface" | "environment")
            && self.la(1).kind == TokKind::Ident
            && is_p(self.la(2), "{")
        {
            return match text {
                "component" => self.component_decl(),
                "interface" => self.interface_decl(),
                _ => self.environment_decl(),
            };
        }
        // `role name "description"` (0.4). An agent's `role "…"` line has no name and is not a declaration.
        if text == "role" && self.la(1).kind == TokKind::Ident && self.la(2).kind == TokKind::String
        {
            self.bump();
            let name_tok = self.t();
            let name = self.ident("a role name")?;
            let description = self.string("a role description")?;
            let def = obj().with("kind", "role").with("description", description);
            return Ok((name, def, name_tok));
        }
        match text {
            "type" => self.type_decl(),
            "capability" => self.capability_decl(),
            "let" => self.const_decl(),
            "pub" | "fn" => self.fn_decl(),
            "extern" => self.extern_decl(),
            "effect" => self.effect_decl(),
            "agent" => self.agent_decl(),
            "workflow" => self.workflow_decl(),
            "contract" => self.contract_decl(),
            _ => Err(self.expected("a declaration")),
        }
    }

    fn capability_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let name_tok = self.t();
        let name = self.ident("a capability name")?;
        self.expect_p("=")?;
        let value = self.expr(false)?;
        let def = obj().with("kind", "capability").with("value", value);
        Ok((name, def, name_tok))
    }

    fn const_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let name_tok = self.t();
        let name = self.name()?;
        let mut def = obj().with("kind", "const").with("value", placeholder());
        if self.eat_p(":") {
            let ty = self.type_expr(false)?;
            def.set("type", ty);
        }
        self.expect_p("=")?;
        let value = self.expr(false)?;
        def.set("value", value);
        Ok((name, def, name_tok))
    }

    // ── declarations ───────────────────────────────────────────────────

    fn type_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let name_tok = self.t();
        let name = self.ident("a type name")?;
        let mut generics: Option<Vec<Node>> = None;
        if self.eat_p("<") {
            let mut names = Vec::new();
            loop {
                names.push(Node::Str(self.ident("a type parameter")?));
                if !self.eat_p(",") {
                    break;
                }
            }
            self.expect_p(">")?;
            generics = Some(names);
        }
        self.expect_p("=")?;
        let t = self.t();
        let starts_union = t.kind == TokKind::Ident
            && !is_reserved(&t.text)
            && (is_p(self.la(1), "(") || is_p(self.la(1), "|"));
        let ty = if starts_union {
            self.union_type()?
        } else {
            self.type_expr(true)?
        };
        let mut def = obj()
            .with("kind", "type")
            .with("type", ty)
            .with_some("generics", generics);
        if !self.t().nl && self.eat_w("classified") {
            let ct = self.t();
            let cls = self.ident("a data class")?;
            if !DATA_CLASSES.contains(&cls.as_str()) {
                return Err(unknown_class(&cls, ct));
            }
            def.set("class", cls);
        }
        Ok((name, def, name_tok))
    }

    fn union_type(&mut self) -> Res<O> {
        let start = self.t();
        let mut variants: Vec<Node> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        loop {
            let vt = self.t();
            let tag = self.ident("a variant name")?;
            let mut v = obj().with("tag", tag.as_str());
            if self.is_p("(") {
                let fields = self.params()?;
                v.set("fields", fields);
            }
            if seen.contains(&tag) {
                self.dup("variant", &tag, vt);
            }
            seen.insert(tag);
            variants.push(Node::Obj(self.at(v, vt)));
            if !self.eat_p("|") {
                break;
            }
        }
        Ok(self.at(obj().with("union", variants), start))
    }

    fn fn_decl(&mut self) -> Res<Decl<'a>> {
        let public = self.eat_w("pub");
        self.expect_w("fn")?;
        let name_tok = self.t();
        let name = self.ident("a function name")?;
        let params = self.params()?;
        self.expect_p("->")?;
        let returns = self.type_expr(false)?;
        let mut def = obj()
            .with("kind", "fn")
            .with("params", params)
            .with("returns", returns)
            .with("body", Vec::new());
        if public {
            def.set("pub", true);
        }
        if self.is_p("!") {
            let effects = self.effects()?;
            def.set("effects", effects);
        }
        if self.is_w("budget") {
            let budget = self.budget()?;
            def.set("budget", budget);
        }
        let body = self.block()?;
        def.set("body", body);
        Ok((name, def, name_tok))
    }

    fn extern_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let lang_tok = self.t();
        let lang = self.ident("a host language")?;
        if !matches!(lang.as_str(), "py" | "ts" | "java") {
            return Err(fail_at(
                format!("Unknown host language '{lang}'; expected py, ts or java."),
                lang_tok,
            ));
        }
        let file = self.string("a host file path")?;
        self.expect_p("::")?;
        let name_tok = self.t();
        let symbol = self.ident("a host symbol")?;
        let params = self.params()?;
        self.expect_p("->")?;
        let returns = self.type_expr(false)?;
        let effects = self.effects()?;
        let mut def = obj()
            .with("kind", "extern")
            .with("lang", lang)
            .with("file", file)
            .with("symbol", symbol.as_str())
            .with("params", params)
            .with("returns", returns)
            .with("effects", effects);
        if self.eat_w("idempotent_by") {
            let key = self.expr(false)?;
            def.set("idempotent_by", key);
        }
        Ok((symbol, def, name_tok))
    }

    fn effect_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let name_tok = self.t();
        let name = self.qname()?;
        let params = self.params()?;
        self.expect_p("->")?;
        let returns = self.type_expr(false)?;
        let mut def = obj()
            .with("kind", "effect")
            .with("params", params)
            .with("returns", returns);
        loop {
            if self.eat_w("requires") {
                self.expect_w("caps")?;
                let cap = self.expr(false)?;
                def.push("requires_caps", cap);
            } else if self.eat_w("critical") {
                def.set("critical", true);
            } else if self.eat_w("irreversible") {
                def.set("irreversible", true);
            } else if self.eat_w("idempotency") {
                self.expect_w("required")?;
                def.set("idempotency_required", true);
            } else if self.eat_w("compensation") {
                let compensation = self.qname()?;
                def.set("compensation", compensation);
            } else if self.eat_w("retry_class") {
                let t = self.t();
                let rc = self.ident("a retry class")?;
                if !matches!(
                    rc.as_str(),
                    "read_only" | "idempotent" | "reconcilable" | "non_retryable"
                ) {
                    return Err(fail_at(format!("Unknown retry class '{rc}'."), t));
                }
                def.set("retry_class", rc);
            } else {
                break;
            }
        }
        if let Some(Node::List(caps)) = def.get_mut("requires_caps") {
            let sorted = sort_canon(std::mem::take(caps));
            *caps = sorted;
        }
        Ok((name, def, name_tok))
    }

    fn agent_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let remote = self.eat_w("remote");
        let name_tok = self.t();
        let name = self.ident("an agent name")?;
        let mut def = obj()
            .with("kind", "agent")
            .with("caps", Vec::new())
            .with("skills", obj());
        let mut caps: Vec<Node> = Vec::new();
        let mut skills = obj();
        if remote {
            self.expect_p("=")?;
            let bind_start = self.t();
            let bind = self.expr(false)?;
            let mut binding = self.at(obj().with("bind", bind), bind_start);
            loop {
                if self.eat_w("version") {
                    let version = self.string("a version string")?;
                    binding.set("version", version);
                } else if self.eat_w("require") {
                    let required = self.expr(false)?;
                    binding.push("require", required);
                } else if self.eat_w("trust") {
                    let t = self.t();
                    let trust = self.ident("a trust level")?;
                    if trust != "trusted" && trust != "untrusted" {
                        return Err(fail_at(format!("Unknown trust level '{trust}'."), t));
                    }
                    binding.set("trust", trust);
                } else if self.eat_w("caps") {
                    caps.extend(self.expr_list()?);
                } else if self.eat_w("skills") {
                    self.expect_p("{")?;
                    while !self.is_p("}") {
                        self.skill(&mut skills, true)?;
                    }
                    self.expect_p("}")?;
                } else {
                    break;
                }
            }
            // `def.remote` was assigned before the loop, which adds no other member to `def`.
            def.set("remote", binding);
        } else {
            self.expect_p("{")?;
            while !self.is_p("}") {
                let t = self.t();
                if self.eat_w("role") {
                    let role = self.string("a role description")?;
                    def.set("role", role);
                } else if self.eat_w("model") {
                    let model = self.ident("a model tier")?;
                    def.set("model", model);
                } else if self.eat_w("caps") {
                    caps.extend(self.expr_list()?);
                } else if self.is_w("budget") {
                    let budget = self.budget()?;
                    def.set("budget", budget);
                } else if self.eat_w("loop") {
                    let st = self.t();
                    let strategy = self.ident("a loop strategy")?;
                    if strategy != "react" && strategy != "plan_execute" {
                        return Err(fail_at(
                            format!(
                                "Unknown loop strategy '{strategy}'; expected react or plan_execute."
                            ),
                            st,
                        ));
                    }
                    def.set("loop", strategy);
                } else if self.eat_w("progress") {
                    let progress = self.progress()?;
                    def.set("progress", progress);
                } else if self.eat_w("skill") {
                    self.skill(&mut skills, false)?;
                } else {
                    return Err(self.fail(format!(
                        "Expected role, model, caps, budget, loop, progress or skill in agent body but found {}.",
                        describe(t)
                    )));
                }
            }
            self.expect_p("}")?;
        }
        def.set("skills", skills);
        def.set("caps", sort_canon(caps));
        Ok((name, def, name_tok))
    }

    fn skill(&mut self, into: &mut Obj, remote: bool) -> Res<()> {
        let start = self.t();
        let name = self.ident("a skill name")?;
        let params = self.params()?;
        self.expect_p("->")?;
        let returns = self.type_expr(false)?;
        let mut s = obj()
            .with("params", params)
            .with("returns", returns)
            .with("effects", Vec::new());
        if self.is_p("!") {
            let effects = self.effects()?;
            s.set("effects", effects);
        } else if !remote {
            return Err(self.fail(format!(
                "Skill '{name}' must declare its effects with '! {{ \u{2026} }}'."
            )));
        }
        if self.is_w("budget") {
            let budget = self.budget()?;
            s.set("budget", budget);
        }
        if !remote && self.is_p("{") {
            let body = self.block()?;
            s.set("body", body);
        }
        if into.has(&name) {
            self.dup("skill", &name, start);
        }
        let s = self.at(s, start);
        into.set(&name, s);
        Ok(())
    }

    fn workflow_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let name_tok = self.t();
        let name = self.ident("a workflow name")?;
        let params = self.params()?;
        self.expect_p("->")?;
        let returns = self.type_expr(false)?;
        // An envelope takes the place of `caps` and `budget` (0.4). Both are still read after it, so that
        // a workflow that writes them as well is told so by name (E1701), not with a syntax error.
        let envelope = if self.is_w("envelope") && is_p(self.la(1), "{") {
            Some(self.envelope()?)
        } else {
            None
        };
        let mut caps: Vec<Node> = Vec::new();
        if envelope.is_none() || self.is_w("caps") {
            self.expect_w("caps")?;
            caps = sort_canon(self.expr_list()?);
        }
        let mut def = obj()
            .with("kind", "workflow")
            .with("params", params)
            .with("returns", returns)
            .with("caps", caps)
            .with("body", Vec::new());
        if self.is_w("budget") {
            let budget = self.budget()?;
            def.set("budget", budget);
        }
        if let Some(envelope) = envelope {
            def.set("envelope", envelope);
        }
        if self.eat_w("ensures") {
            let ensures = self.expr(true)?;
            def.set("ensures", ensures);
        }
        let body = self.block()?;
        def.set("body", body);
        Ok((name, def, name_tok))
    }

    /// `envelope { owner r  caps K, …  budget { … }  spawn { max_concurrent: n, max_class: c }
    /// approve effect by r … }` (0.4; spec/envelope.md). Fields come in any order, each once;
    /// `approve` once per effect.
    fn envelope(&mut self) -> Res<O> {
        let start = self.bump();
        let mut env = obj();
        let mut seen: HashSet<&str> = HashSet::new();
        self.expect_p("{")?;
        while !self.is_p("}") {
            let t = self.t();
            if t.kind != TokKind::Ident {
                return Err(self.expected("owner, caps, budget, spawn or approve in an envelope"));
            }
            let field = t.text.as_str();
            if field != "approve" {
                if seen.contains(field) {
                    self.dup("envelope field", field, t);
                }
                seen.insert(field);
            }
            match field {
                "owner" => {
                    self.bump();
                    let owner = self.ident("a role")?;
                    env.set("owner", owner);
                }
                "caps" => {
                    self.bump();
                    let caps = sort_canon(self.expr_list()?);
                    env.set("caps", caps);
                }
                "budget" => {
                    let budget = self.budget()?;
                    env.set("budget", budget);
                }
                "spawn" => {
                    let spawn = self.spawn_limits(t)?;
                    env.set("spawn", spawn);
                }
                "approve" => self.approval(&mut env)?,
                _ => {
                    return Err(fail_at(
                        format!(
                            "Expected owner, caps, budget, spawn or approve in an envelope but found '{field}'."
                        ),
                        t,
                    ));
                }
            }
        }
        self.expect_p("}")?;
        Ok(self.at(env, start))
    }

    /// An envelope's `spawn { max_concurrent: n, max_class: c }`; `t` is the
    /// word `spawn`.
    fn spawn_limits(&mut self, t: &'a Token) -> Res<O> {
        self.bump();
        let mut spawn = obj();
        self.expect_p("{")?;
        while !self.is_p("}") {
            let kt = self.t();
            let key = self.ident("a spawn field")?;
            self.expect_p(":")?;
            if in_plain_object(&spawn, &key) {
                self.dup("spawn field", &key, kt);
            }
            if key == "max_concurrent" {
                let vt = self.t();
                if vt.kind != TokKind::Int || vt.num.unwrap_or(0.0) < 1.0 {
                    return Err(fail_at(
                        "'max_concurrent' takes a whole number, at least 1.".to_owned(),
                        vt,
                    ));
                }
                self.bump();
                spawn.set("max_concurrent", num_node(vt));
            } else if key == "max_class" {
                let ct = self.t();
                let cls = self.ident("a data class")?;
                if !DATA_CLASSES.contains(&cls.as_str()) {
                    return Err(unknown_class(&cls, ct));
                }
                spawn.set("max_class", cls);
            } else {
                return Err(fail_at(
                    format!("Unknown spawn field '{key}'; expected max_concurrent or max_class."),
                    kt,
                ));
            }
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p("}")?;
        if spawn.is_empty() {
            return Err(fail_at(
                "'spawn' needs max_concurrent or max_class.".to_owned(),
                t,
            ));
        }
        Ok(spawn)
    }

    /// An envelope's `approve effect by role`.
    fn approval(&mut self, env: &mut Obj) -> Res<()> {
        self.bump();
        let et = self.t();
        let effect = self.qname()?;
        self.expect_w("by")?;
        let role = self.ident("a role")?;
        let Some(approve) = env.map("approve") else {
            return Ok(());
        };
        if approve.has(&effect) {
            self.dup("approval", &effect, et);
        }
        approve.set(&effect, role);
        Ok(())
    }

    // ── system model (0.3; design doc 9 §2) ───────────────────────────

    fn component_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let name_tok = self.t();
        let name = self.ident("a component name")?;
        let mut def = obj()
            .with("kind", "component")
            .with("repo", "")
            .with("root", "")
            .with("lang", "")
            .with("owner", "");
        let mut seen: HashSet<String> = HashSet::new();
        self.expect_p("{")?;
        while !self.is_p("}") {
            let t = self.t();
            let field = self.ident("a component field")?;
            if seen.contains(&field) {
                self.dup("component field", &field, t);
            }
            seen.insert(field.clone());
            match field.as_str() {
                "repo" => {
                    let repo = self.string("a repository, owner/name")?;
                    def.set("repo", repo);
                }
                "root" => {
                    let root = self.string("an absolute path")?;
                    def.set("root", root);
                }
                "lang" => {
                    let lang = self.ident("a language")?;
                    def.set("lang", lang);
                }
                "owner" => {
                    self.expect_w("role")?;
                    let owner = self.string("a role")?;
                    def.set("owner", owner);
                }
                "build" | "test" => {
                    let commands = self.commands()?;
                    def.set(&field, commands);
                }
                "provides" | "consumes" => {
                    let mut names: Vec<String> = Vec::new();
                    loop {
                        names.push(self.ident("an interface name")?);
                        if !self.eat_p(",") {
                            break;
                        }
                    }
                    def.set(&field, sorted_set(names));
                }
                "governance" => {
                    let mut globs: Vec<String> = Vec::new();
                    loop {
                        globs.push(self.string("a file pattern, e.g. \"deploy/**\"")?);
                        if !self.eat_p(",") {
                            break;
                        }
                    }
                    def.set("governance", sorted_set(globs));
                }
                _ => {
                    return Err(fail_at(
                        format!(
                            "Expected repo, root, lang, owner, build, test, provides, consumes or governance in a component but found '{field}'."
                        ),
                        t,
                    ));
                }
            }
        }
        self.expect_p("}")?;
        for f in ["repo", "root", "lang", "owner"] {
            if !seen.contains(f) {
                return Err(fail_at(
                    format!("Component '{name}' needs '{f}'."),
                    name_tok,
                ));
            }
        }
        Ok((name, def, name_tok))
    }

    /// `exec("npm", ["run", "build"]), exec(…)`: the processes a component runs.
    fn commands(&mut self) -> Res<Vec<Node>> {
        let mut out: Vec<Node> = Vec::new();
        loop {
            self.expect_w("exec")?;
            self.expect_p("(")?;
            let command = self.string("a command")?;
            let mut args: Vec<Node> = Vec::new();
            if self.eat_p(",") {
                self.expect_p("[")?;
                while !self.is_p("]") {
                    args.push(Node::Str(self.string("an argument")?));
                    if !self.eat_p(",") {
                        break;
                    }
                }
                self.expect_p("]")?;
            }
            self.expect_p(")")?;
            out.push(Node::Obj(obj().with("command", command).with("args", args)));
            if !self.eat_p(",") {
                break;
            }
        }
        Ok(out)
    }

    fn interface_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let name_tok = self.t();
        let name = self.ident("an interface name")?;
        let mut protocol: Option<String> = None;
        let mut spec: Option<String> = None;
        self.expect_p("{")?;
        while !self.is_p("}") {
            let t = self.t();
            let field = self.ident("an interface field")?;
            if field == "protocol" {
                // `if (protocol)`: once set it is a protocol's name, never empty.
                if protocol.is_some() {
                    self.dup("interface field", &field, t);
                }
                let pt = self.t();
                let p = self.ident("a protocol")?;
                if !INTERFACE_PROTOCOLS.contains(&p.as_str()) {
                    return Err(fail_at(
                        format!(
                            "Unknown protocol '{p}'; expected {}.",
                            INTERFACE_PROTOCOLS.join(", ")
                        ),
                        pt,
                    ));
                }
                protocol = Some(p);
            } else if field == "spec" {
                if spec.is_some() {
                    self.dup("interface field", &field, t);
                }
                spec = Some(self.string("a spec path")?);
            } else {
                return Err(fail_at(
                    format!("Expected protocol or spec in an interface but found '{field}'."),
                    t,
                ));
            }
        }
        self.expect_p("}")?;
        let (Some(protocol), Some(spec)) = (protocol, spec) else {
            return Err(fail_at(
                format!("Interface '{name}' needs 'protocol' and 'spec'."),
                name_tok,
            ));
        };
        let def = obj()
            .with("kind", "interface")
            .with("protocol", protocol)
            .with("spec", spec);
        Ok((name, def, name_tok))
    }

    fn environment_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let name_tok = self.t();
        let name = self.ident("an environment name")?;
        let mut def = obj().with("kind", "environment").with("class", "public");
        let mut classed = false;
        self.expect_p("{")?;
        while !self.is_p("}") {
            let t = self.t();
            if self.eat_w("class") {
                if classed {
                    self.dup("environment field", "class", t);
                }
                classed = true;
                let ct = self.t();
                let cls = self.ident("a data class")?;
                if !DATA_CLASSES.contains(&cls.as_str()) {
                    return Err(unknown_class(&cls, ct));
                }
                def.set("class", cls);
            } else if self.eat_w("read") {
                let rt = self.t();
                let rn = self.ident("a read name")?;
                // `def.reads ??= …` comes before the read is parsed.
                if def.map("reads").is_some_and(|reads| reads.has(&rn)) {
                    self.dup("read", &rn, rt);
                }
                let source = self.read_source()?;
                let source = self.at(source, rt);
                if let Some(reads) = def.map("reads") {
                    reads.set(&rn, source);
                }
            } else if self.eat_w("authorize") {
                let et = self.t();
                let effect = self.qname()?;
                self.expect_w("by")?;
                if def.map("authorize").is_some_and(|a| a.has(&effect)) {
                    self.dup("authorization tier", &effect, et);
                }
                let tier = self.tier()?;
                if let Some(authorize) = def.map("authorize") {
                    authorize.set(&effect, tier);
                }
            } else {
                return Err(self.fail(format!(
                    "Expected class, read or authorize in an environment but found {}.",
                    describe(t)
                )));
            }
        }
        self.expect_p("}")?;
        if !classed {
            return Err(fail_at(
                format!("Environment '{name}' needs 'class'."),
                name_tok,
            ));
        }
        Ok((name, def, name_tok))
    }

    /// `from c sql "…" | logs where e, params (…), returns T, max_rows n`.
    fn read_source(&mut self) -> Res<O> {
        self.expect_w("from")?;
        let from = self.ident("a component name")?;
        let query = if self.eat_w("sql") {
            obj().with("sql", self.string("an SQL query")?)
        } else if self.eat_w("logs") {
            self.expect_w("where")?;
            obj().with("logs", self.expr(true)?)
        } else {
            return Err(self.expected("'sql' or 'logs' after the read's component"));
        };
        self.expect_w("params")?;
        let params = self.params()?;
        self.expect_w("returns")?;
        let returns = self.type_expr(false)?;
        self.expect_w("max_rows")?;
        if self.t().kind != TokKind::Int {
            return Err(self.fail("max_rows takes an integer.".to_owned()));
        }
        let max_rows = num_node(self.bump());
        Ok(obj()
            .with("from", from)
            .with("query", query)
            .with("params", params)
            .with("returns", returns)
            .with("max_rows", max_rows))
    }

    /// `policy` or `human(role: "…")`.
    fn tier(&mut self) -> Res<O> {
        if self.eat_w("policy") {
            return Ok(obj().with("by", "policy"));
        }
        self.expect_w("human")?;
        self.expect_p("(")?;
        self.expect_w("role")?;
        self.expect_p(":")?;
        let role = self.string("a role")?;
        self.expect_p(")")?;
        Ok(obj().with("by", "human").with("role", role))
    }

    fn contract_decl(&mut self) -> Res<Decl<'a>> {
        self.bump();
        let name_tok = self.t();
        let name = self.ident("a contract name")?;
        let params = self.params()?;
        let mut def = obj()
            .with("kind", "contract")
            .with("params", params)
            .with("accept", obj());
        self.expect_p("{")?;
        while !self.is_p("}") {
            let t = self.t();
            if self.eat_w("require") {
                let required = self.expr(false)?;
                def.push("require", required);
            } else if self.is_w("accept") || self.is_w("invariant") {
                let accept = self.bump().text == "accept";
                let ct = self.t();
                let cname = self.ident("a criterion name")?;
                let description = self.string("a criterion description")?;
                self.expect_w("by")?;
                let by = self.verifier()?;
                let crit = self.at(obj().with("description", description).with("by", by), t);
                // `def.invariant ??= …` is evaluated before the duplicate check.
                if !accept && !def.has("invariant") {
                    def.set("invariant", obj());
                }
                let in_map = |key: &str| {
                    def.get(key)
                        .and_then(Node::as_obj)
                        .is_some_and(|m| m.has(&cname))
                };
                if in_map("accept") || in_map("invariant") {
                    self.dup("criterion", &cname, ct);
                }
                if let Some(into) = def.map(if accept { "accept" } else { "invariant" }) {
                    into.set(&cname, crit);
                }
            } else {
                return Err(self.fail(format!(
                    "Expected require, accept or invariant in contract body but found {}.",
                    describe(t)
                )));
            }
        }
        self.expect_p("}")?;
        Ok((name, def, name_tok))
    }

    fn verifier(&mut self) -> Res<Node> {
        let mut parts: Vec<Node> = Vec::new();
        loop {
            let start = self.t();
            // A verifier operand binds tighter than `and`, which joins verifiers.
            let key = if self.eat_w("static") {
                "static"
            } else {
                "call"
            };
            let operand = self.binary(ABOVE_AND, false)?;
            parts.push(Node::Obj(self.at(obj().with(key, operand), start)));
            if !self.eat_w("and") {
                break;
            }
        }
        if parts.len() == 1 {
            if let Some(only) = parts.pop() {
                return Ok(only);
            }
        }
        Ok(Node::Obj(obj().with("all", parts)))
    }

    pub(super) fn test_body(&mut self) -> Res<O> {
        self.expect_p("{")?;
        let mut test = obj().with("body", Vec::new());
        if self.is_w("with") && is_w(self.la(1), "handlers") {
            self.bump();
            self.bump();
            self.expect_p("{")?;
            let mut handlers = obj();
            while !self.is_p("}") {
                let t = self.t();
                let name = self.ident("an effect name")?;
                self.expect_p("=")?;
                if handlers.has(&name) {
                    self.dup("handler", &name, t);
                }
                let handler = self.expr(false)?;
                handlers.set(&name, handler);
                if !self.eat_p(",") {
                    break;
                }
            }
            self.expect_p("}")?;
            test.set("handlers", handlers);
        }
        self.in_test = true;
        let body = self.test_statements();
        self.in_test = false;
        test.set("body", body?);
        self.expect_p("}")?;
        Ok(test)
    }

    fn test_statements(&mut self) -> Res<Vec<Node>> {
        let mut body: Vec<Node> = Vec::new();
        while !self.is_p("}") {
            body.push(Node::Obj(self.stmt()?));
        }
        Ok(body)
    }

    // ── shared pieces ──────────────────────────────────────────────────

    pub(super) fn params(&mut self) -> Res<Vec<Node>> {
        self.expect_p("(")?;
        let mut out: Vec<Node> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        while !self.is_p(")") {
            let t = self.t();
            let name = self.ident("a parameter name")?;
            self.expect_p(":")?;
            let ty = self.type_expr(true)?;
            if seen.contains(&name) {
                self.dup("parameter", &name, t);
            }
            seen.insert(name.clone());
            out.push(Node::Obj(
                self.at(obj().with("name", name).with("type", ty), t),
            ));
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p(")")?;
        Ok(out)
    }

    pub(super) fn effects(&mut self) -> Res<Vec<Node>> {
        self.expect_p("!")?;
        self.expect_p("{")?;
        let mut out: Vec<Node> = Vec::new();
        while !self.is_p("}") {
            let t = self.t();
            let mut e = obj().with("effect", self.qname()?);
            if self.is_p("(") {
                let args = self.args()?;
                e.set("args", args);
            }
            out.push(Node::Obj(self.at(e, t)));
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p("}")?;
        Ok(sort_canon(out))
    }

    /// `progress { window: 8, repeats: 3, stall: 5 }` (§8.2).
    fn progress(&mut self) -> Res<O> {
        self.expect_p("{")?;
        let mut p = obj();
        while !self.is_p("}") {
            let kt = self.t();
            let key = self.ident("a progress field")?;
            self.expect_p(":")?;
            let vt = self.t();
            let v = self.primary(false)?;
            if !matches!(key.as_str(), "window" | "repeats" | "stall") {
                return Err(fail_at(
                    format!("Unknown progress field '{key}'; expected window, repeats or stall."),
                    kt,
                ));
            }
            if v.str("op") != Some("int") {
                return Err(fail_at(
                    format!("Progress field '{key}' takes an integer."),
                    vt,
                ));
            }
            if in_plain_object(&p, &key) {
                self.dup("progress field", &key, kt);
            }
            p.set(&key, scalar(&v, "value"));
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p("}")?;
        Ok(p)
    }

    pub(super) fn budget(&mut self) -> Res<O> {
        let start = self.expect_w("budget")?;
        self.expect_p("{")?;
        let mut b = obj();
        while !self.is_p("}") {
            let kt = self.t();
            let key = self.ident("a budget field")?;
            self.expect_p(":")?;
            let vt = self.t();
            let v = self.primary(false)?;
            if in_plain_object(&b, &key) {
                self.dup("budget field", &key, kt);
            }
            let op = v.str("op");
            match key.as_str() {
                "tokens" | "steps" | "agents" => {
                    if op != Some("int") {
                        return Err(bad_budget(&key, "an integer", vt));
                    }
                    b.set(&key, scalar(&v, "value"));
                }
                "spend" => {
                    if op != Some("money") {
                        return Err(bad_budget(
                            &key,
                            "an amount with a currency, e.g. 20 USD",
                            vt,
                        ));
                    }
                    let spend = obj()
                        .with("micros", scalar(&v, "micros"))
                        .with("currency", scalar(&v, "currency"));
                    b.set("spend", spend);
                }
                "time" => {
                    if op != Some("duration") {
                        return Err(bad_budget(&key, "a duration, e.g. 15m", vt));
                    }
                    b.set("time", obj().with("ms", scalar(&v, "ms")));
                }
                _ => return Err(self.unknown_budget_field(&key, kt)),
            }
            if !self.eat_p(",") {
                break;
            }
        }
        self.expect_p("}")?;
        Ok(self.at(b, start))
    }

    fn unknown_budget_field(&self, key: &str, kt: &Token) -> Fail {
        let from_04 = LANGUAGE_VERSIONS
            .iter()
            .position(|v| *v == self.language)
            .is_some_and(|at| at >= 3);
        let fields = if from_04 {
            "tokens, spend, time, steps or agents"
        } else {
            "tokens, spend, time or steps"
        };
        fail_at(
            format!("Unknown budget field '{key}'; expected {fields}."),
            kt,
        )
    }
}
