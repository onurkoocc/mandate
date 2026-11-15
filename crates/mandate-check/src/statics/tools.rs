//! The connectors of language 0.6 (spec/library.md "Connectors"), which
//! only the Rust compiler reads: a connector's declaration (E1401, E1402,
//! E1403), a call of one of its tools (E1405, E0201, E0220), the
//! requirement of a write tool's effect, and the requirements of every
//! `requires caps` of an effect in a program of 0.6 (B12).
//!
//! A tool is a member of its connector's definition: `c.t` names tool `t`
//! of the connector `c` the program defines or lists in a `use`, never a
//! module's path and never an opaque call (name resolution has held that
//! the tool is declared). Its class decides where it is called:
//!
//! - a read-only tool, as an expression in a workflow's body: the effect
//!   `Tool`, scoped by the tool (`crate::caps::tool_item`), its value
//!   `Untrusted<T>` of the connector's class;
//! - a write tool, as `effect c.t(…) idempotent_by k` in a workflow's body:
//!   a critical effect named `c.t`, whose requirement is `tool.call(c, t)`
//!   ([`crate::caps::tool_call_caps`], the one reading of a `tool.call`).
//!
//! Anything else is E1405. Every argument is held to the connector's class
//! (E0220), as what a model receives is held to its capability's.

use mandate_ir::{
    ConnectorDef, DefKind, Definition, Expr, JsObject, JsValue, Language, Map, Tool, Value,
    canonicalize,
};

use super::{Checker, Frame, Usage, Val, Where, sub, sub_i};
use crate::caps::{
    CapVal, TOOL_CALL, TOOL_READ_EFFECT, TOOL_WRITE_EFFECT, cap_authorizes, caps_of, show_cap,
    tool_call_caps, tool_connector, tool_item,
};
use crate::stdlib::{DataClass, class_rank};
use crate::ty::{Level, epistemic, named, show};

/// A tool of a connector as a program names it, `c.t`: the connector's
/// name and definition, and the tool's name and declaration.
#[derive(Clone, Debug)]
pub(crate) struct ToolRef<'a> {
    /// The connector's name.
    pub(crate) connector: String,
    /// The connector's definition, as linked (it says its module).
    pub(crate) def: ConnectorDef<'a>,
    /// The tool's name.
    pub(crate) name: String,
    /// The tool's declaration.
    pub(crate) tool: Tool<'a>,
}

impl ToolRef<'_> {
    /// `c.t`, as the program writes it and as its effect is named.
    pub(crate) fn shown(&self) -> String {
        format!("{}.{}", self.connector, self.name)
    }

    /// The connector's class, when it is a data class.
    fn class(&self) -> Option<DataClass> {
        self.def.class().and_then(DataClass::from_name)
    }

    /// The scope item of the tool, `<module>.<connector>.<tool>`; with no
    /// module known, one no capability names.
    fn item(&self) -> String {
        tool_item(
            self.def.module().unwrap_or_default(),
            &self.connector,
            &self.name,
        )
    }

    /// `{ connector, tool }` and the rest.
    fn facts(&self) -> JsObject {
        JsObject::new()
            .with("connector", self.connector.as_str())
            .with("tool", self.name.as_str())
    }
}

/// The member `T` of a type `{ ref: name, args: [T] }`, when it is one.
fn wrapped<'v>(t: Option<&'v Value>, name: &str) -> Option<&'v Value> {
    let t = t?;
    if t.get("ref").and_then(Value::as_str) != Some(name) {
        return None;
    }
    match t.get("args").and_then(Value::as_array) {
        Some([inner]) => Some(inner),
        _ => None,
    }
}

/// Whether a parameter's type is `Text`, as written.
fn is_text(p: &Value) -> bool {
    let t = p.get("type");
    t.and_then(|t| t.get("ref")).and_then(Value::as_str) == Some("Text")
        && t.and_then(|t| t.get("args")).is_none()
}

/// Whether `h` is a host name as egress reads one (spec/egress.md "Host
/// names"): dot-separated labels of lower-case letters, digits and hyphens,
/// none starting or ending with a hyphen, at most 63 characters each and
/// 253 in all. An IPv4 address is such a name.
fn is_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// What keeps `url` from being a connector's server (E1402): one absolute
/// `https://` URL, printable ASCII, with a host name and no user, password,
/// port, query or fragment; its path, empty or from `/`, is where requests
/// go.
fn url_problem(url: &str) -> Option<&'static str> {
    let Some(rest) = url.strip_prefix("https://") else {
        return Some("it does not start with https://");
    };
    if !url.bytes().all(|b| b.is_ascii_graphic()) || url.contains('\\') {
        return Some("it holds a space, a backslash, a control character or one that is not ASCII");
    }
    if url.contains('?') {
        return Some("it has a query");
    }
    if url.contains('#') {
        return Some("it has a fragment");
    }
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.contains('@') {
        return Some("it names a user or a password");
    }
    if authority.contains(':') {
        return Some("it names a port");
    }
    if !is_host(authority) {
        return Some("its host is not a host name");
    }
    None
}

impl<'a> Checker<'a> {
    /// The connector `name`, the program's own or a linked one.
    pub(crate) fn connector_def(&self, name: &str) -> Option<ConnectorDef<'a>> {
        self.def(name)
            .filter(|d| d.kind() == Some(DefKind::Connector))
            .and_then(|d| ConnectorDef::of(d.value()))
    }

    /// `c.t` as an effect's name: tool `t` of the connector `c`, when it
    /// declares one.
    pub(crate) fn connector_tool(&self, name: &str) -> Option<ToolRef<'a>> {
        let (c, t) = name.split_once('.')?;
        if t.contains('.') {
            return None;
        }
        let def = self.connector_def(c)?;
        let tool = def.tool(t)?;
        Some(ToolRef {
            connector: c.to_owned(),
            def,
            name: t.to_owned(),
            tool,
        })
    }

    /// `c.t` as the callee of a call: tool `t` of the connector `c`, when
    /// `c` is no variable of the frame and names a connector that declares
    /// `t`.
    pub(crate) fn tool_member(&self, callee: Expr<'a>, frame: &Frame<'a>) -> Option<ToolRef<'a>> {
        if !callee.is(mandate_ir::ExprOp::Field) {
            return None;
        }
        let of = callee.operand().filter(|o| o.is(mandate_ir::ExprOp::Var))?;
        let c = of.name()?;
        if Self::lookup(c, &frame.scope).is_some() {
            return None;
        }
        let def = self.connector_def(c)?;
        let name = callee.name()?;
        let tool = def.tool(name)?;
        Some(ToolRef {
            connector: c.to_owned(),
            def,
            name: name.to_owned(),
            tool,
        })
    }

    /// The call `e` when it calls a connector's tool, `c.t(…)` ([`Checker::tool_read`]),
    /// its arguments typed (`args`); `None` for any other call. Not inlined,
    /// so that the frame of a call on the path of the checker's recursion
    /// holds nothing of it.
    #[inline(never)]
    pub(crate) fn tool_call(
        &mut self,
        e: Expr<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        args: &[Val],
    ) -> Option<Val> {
        let r = self.tool_member(e.callee()?, frame)?;
        Some(self.tool_read(frame, path, &r, args))
    }

    /// The requirement of the effect of a write tool `c.t`: what
    /// `tool.call(c, t)` stands for, its write part.
    pub(crate) fn tool_requirement(&self, r: &ToolRef<'a>) -> Vec<CapVal> {
        tool_call_caps(self.defs, &r.connector, &[r.name.as_str()]).caps
    }

    /// What a use of tool `tool` of the linked connector `def` stands on
    /// that the program does not have (`unbound`, which linking writes,
    /// `crate::modules`): each type name of its signature the program does
    /// not hold as the definition the connector's module means, with that
    /// definition's module.
    fn unbound(def: ConnectorDef<'a>, tool: &str) -> Vec<(&'a str, &'a str)> {
        def.members()
            .get("unbound")
            .and_then(|u| u.get(tool))
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(Map::iter)
            .map(|(n, m)| (n, m.as_str().unwrap_or_default()))
            .collect()
    }

    /// E0120 at `path` for each type name of tool `tool`'s signature that the
    /// program does not have as the definition the connector's module means
    /// (F5): a program uses a tool only with the types it means, never with
    /// a definition of its own of the same name, and never with an unknown
    /// type. `seen` holds the names reported at `path` already.
    fn unbound_names(
        &mut self,
        connector: &str,
        def: ConnectorDef<'a>,
        tool: &str,
        path: &str,
        seen: &mut Vec<&'a str>,
    ) {
        for (name, module) in Self::unbound(def, tool) {
            if seen.contains(&name) {
                continue;
            }
            seen.push(name);
            let place = if module.is_empty() {
                "a name its connector's module does not define".to_owned()
            } else {
                format!("{module}.{name}")
            };
            let how = if module.is_empty() {
                String::new()
            } else {
                format!(": list it in a use, use {module}.{{{name}}}")
            };
            self.report(
                "E0120",
                format!(
                    "The tool {connector}.{tool} takes or gives the type {name}, which is {place}; this program has no such definition{how}."
                ),
                path,
                Some(
                    JsObject::new()
                        .with("name", name)
                        .with("expected", "type")
                        .with("module", module)
                        .with("tool", format!("{connector}.{tool}").as_str()),
                ),
            );
        }
    }

    /// What a use of a tool holds its signature to, at the use: its type
    /// names are the definitions its connector's module means (E0120), and
    /// none of them is classed above the connector's class (E0220), as its
    /// declaration is held in its module; a program may be given a module
    /// that was not checked.
    fn tool_signature(&mut self, r: &ToolRef<'a>, path: &str) {
        self.unbound_names(&r.connector, r.def, &r.name, path, &mut Vec::new());
        // The program's own connector is held at its declaration.
        if !self
            .program
            .defs()
            .is_some_and(|d| d.contains_key(&r.connector))
        {
            self.signature_class(&r.connector, r.def, &r.name, r.tool, path);
        }
    }

    /// E0220 at `path` when a type of tool `tool`'s signature is classed
    /// above its connector's class: a read-only tool would give data of a
    /// class its connector does not say, a write tool take it.
    fn signature_class(
        &mut self,
        connector: &str,
        c: ConnectorDef<'a>,
        tool: &str,
        t: Tool<'a>,
        path: &str,
    ) {
        let Some(allowed) = c.class().and_then(DataClass::from_name) else {
            return;
        };
        let mut types: Vec<crate::ty::Ty> = t.params().iter().map(|p| self.param_type(p)).collect();
        types.push(self.ty(t.returns()));
        let Some(cls) = types.iter().map(|ty| self.type_class(ty)).max() else {
            return;
        };
        if cls > allowed {
            self.report(
                "E0220",
                format!(
                    "The tool {connector}.{tool} takes or gives {} data, and its connector's class is {} (spec/library.md \"Declaration\").",
                    cls.as_str(),
                    allowed.as_str()
                ),
                path,
                Some(
                    JsObject::new()
                        .with("data_class", cls.as_str())
                        .with("allowed", allowed.as_str())
                        .with("connector", connector)
                        .with("tool", tool),
                ),
            );
        }
    }

    /// In a program of 0.6, what covers a use of `Tool` (a read-only tool's
    /// call, or a skill that declares it) or of `Tool.Write`: the `tool.call`
    /// parts of that kind whose scope holds the use's ([`cap_authorizes`]),
    /// by index among `caps`, and nothing else; no definition of the program
    /// takes part. `None` for any other effect, or before 0.6.
    pub(crate) fn tool_effect_caps(
        &self,
        effect: &str,
        scope: Option<&[String]>,
        caps: &[CapVal],
    ) -> Option<Vec<usize>> {
        if !self.at_least(Language::V0_6)
            || (effect != TOOL_READ_EFFECT && effect != TOOL_WRITE_EFFECT)
        {
            return None;
        }
        Some(
            caps.iter()
                .enumerate()
                .filter(|(_, c)| c.ctor() == TOOL_CALL && cap_authorizes(c, effect, scope))
                .map(|(i, _)| i)
                .collect(),
        )
    }

    /// What must cover a use of `effect`, each requirement a list of
    /// capabilities that must all be covered (B12), when it is read so:
    /// a write tool's effect (its `tool.call`), and in a program of 0.6
    /// an effect with `requires caps`, every capability of every line. A
    /// line that stands for nothing can be covered by nothing. `None` for
    /// every other effect, which is held as before.
    pub(crate) fn requirements(&self, effect: &str) -> Option<Vec<Vec<CapVal>>> {
        if let Some(r) = self.connector_tool(effect) {
            return r.tool.is_write().then(|| vec![self.tool_requirement(&r)]);
        }
        if !self.at_least(Language::V0_6) {
            return None;
        }
        let d = self.def_of(effect, DefKind::Effect)?;
        let lines = d.requires_caps();
        if lines.is_empty() {
            return None;
        }
        Some(
            lines
                .iter()
                .map(|l| {
                    Expr::of(l)
                        .map(|e| caps_of(self.defs, e, self.cap_opts()))
                        .unwrap_or_default()
                })
                .collect(),
        )
    }

    /// E1405 for a tool called where it cannot be.
    fn misplaced(&mut self, r: &ToolRef<'a>, path: &str, problem: &str, message: String) {
        self.report(
            "E1405",
            message,
            path,
            Some(r.facts().with("problem", problem)),
        );
    }

    /// Where a tool is called, when that is not a workflow's body.
    fn outside_workflow(&mut self, r: &ToolRef<'a>, frame: &Frame<'a>, path: &str) -> bool {
        if frame.where_ == Where::Workflow && !frame.beside_body {
            return false;
        }
        let (problem, where_) = if frame.beside_body {
            ("ensures", "workflow's ensures")
        } else {
            (frame.where_.as_str(), frame.where_.as_str())
        };
        self.misplaced(
            r,
            path,
            problem,
            format!(
                "The tool {} is called in a {where_}. A connector's tools are called only in a workflow's body: a read-only one as an expression, a write one as a critical effect (an agent's loop calls the read-only tools its delegation grants) (spec/library.md \"tool.call\").",
                r.shown()
            ),
        );
        true
    }

    /// The effect call `e` when it names a connector's tool, `effect c.t(…)`
    /// ([`Checker::tool_write`]); `None` for any other effect. Not inlined,
    /// as [`Checker::tool_call`].
    #[inline(never)]
    pub(crate) fn tool_effect(
        &mut self,
        e: Expr<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        args: &[Val],
    ) -> Option<Val> {
        let r = self.connector_tool(e.name()?)?;
        Some(self.tool_write(e, frame, path, &r, args))
    }

    /// `c.t(…)` as an expression: a read-only tool in a workflow's body
    /// (E1405 otherwise), the effect `Tool` scoped by the tool, its
    /// arguments against its parameters and its connector's class, and its
    /// value `Untrusted<T>` of the connector's class.
    pub(crate) fn tool_read(
        &mut self,
        frame: &mut Frame<'a>,
        path: &str,
        r: &ToolRef<'a>,
        args: &[Val],
    ) -> Val {
        self.tool_signature(r, path);
        if r.tool.is_write() {
            let shown = r.shown();
            self.misplaced(
                r,
                path,
                "write_as_expression",
                format!(
                    "{shown} is a write tool: it runs only as 'effect {shown}(…) idempotent_by k' in a workflow's body, a critical effect, through prepare → authorize → commit (spec/library.md \"tool.call\")."
                ),
            );
        } else if !self.outside_workflow(r, frame, path) {
            let mut u = Usage::new(TOOL_READ_EFFECT, path);
            u.scope = Some(vec![r.item()]);
            Self::use_effect(frame, u);
        }
        self.tool_args(r, path, args, r.tool.is_write());
        self.tool_value(r, args)
    }

    /// `effect c.t(…)`: a write tool, in a workflow's body (E1405 for a
    /// read-only one, or elsewhere), a critical effect with `idempotent_by`
    /// (E0403), never in a map's body (E1708), its arguments but the
    /// idempotency key against its parameters and its connector's class,
    /// and its value its declared `Receipt<T>` of the connector's class.
    pub(crate) fn tool_write(
        &mut self,
        e: Expr<'a>,
        frame: &mut Frame<'a>,
        path: &str,
        r: &ToolRef<'a>,
        args: &[Val],
    ) -> Val {
        self.tool_signature(r, path);
        let shown = r.shown();
        let write = r.tool.is_write();
        let placed = if !write {
            self.misplaced(
                r,
                path,
                "read_through_effect",
                format!(
                    "{shown} is a read-only tool: call it as an expression, 'let x = {shown}(…)'; 'effect' runs a write tool (spec/library.md \"tool.call\")."
                ),
            );
            false
        } else {
            !self.outside_workflow(r, frame, path)
        };
        if write {
            // A connector's tool is never irreversible: in a map's body it is
            // a batch commit step, under its conditions (a program of 0.6
            // alone has connectors).
            if frame.in_map.is_some() {
                self.commit_step(e, frame, path, &shown, false);
            }
            if e.idempotent_by().is_none() {
                self.report(
                    "E0403",
                    format!(
                        "Critical effect {shown} needs 'idempotent_by' at the call site (§8.4)."
                    ),
                    path,
                    Some(JsObject::new().with("repair_hint", "add `idempotent_by <business key>`")),
                );
            }
        }
        if let Some(by) = e.idempotent_by() {
            self.expr(by, frame, &sub(path, "idempotent_by"));
        }
        self.tool_args(r, path, args, write);
        if placed {
            Self::use_effect(frame, Usage::new(&shown, path));
        }
        self.tool_value(r, args)
    }

    /// The value of a tool's call: its declared result, a read-only one's
    /// as `Untrusted<T>` whatever it declares, of the connector's class (the
    /// most sensitive when the class is no data class) and of what was sent.
    fn tool_value(&self, r: &ToolRef<'a>, args: &[Val]) -> Val {
        let declared = self.ty(r.tool.returns());
        let ty = if r.tool.is_write() || epistemic(&declared).level == Level::Untrusted {
            declared
        } else {
            named("Untrusted", vec![declared])
        };
        let class = r.class().unwrap_or(DataClass::Restricted);
        let cls = args.iter().map(|a| a.cls).fold(class, DataClass::max);
        Val::new(ty, cls)
    }

    /// A tool's arguments: their count (E0201), each against its parameter,
    /// and each held to the connector's class (E0220, at the argument; in a
    /// sub-program, as for a model, E1706 when the lead's class is above
    /// it). A write tool's idempotency key is the runtime's to pass, so the
    /// program passes its other parameters.
    fn tool_args(&mut self, r: &ToolRef<'a>, path: &str, args: &[Val], write: bool) {
        let key = if write {
            r.tool.idempotency_key()
        } else {
            None
        };
        let params: Vec<&'a Value> = r
            .tool
            .params()
            .iter()
            .filter(|p| key.is_none() || p.get("name").and_then(Value::as_str) != key)
            .collect();
        let shown = r.shown();
        if args.len() != params.len() {
            let but = key.map_or_else(String::new, |k| {
                format!(" (its idempotency key, {k}, is the runtime's to pass)")
            });
            self.report(
                "E0201",
                format!(
                    "{shown} takes {} argument(s) but got {}{but}.",
                    params.len(),
                    args.len()
                ),
                path,
                None,
            );
        }
        for (i, p) in params.iter().enumerate() {
            if let Some(a) = args.get(i) {
                let t = self.param_type(p);
                self.expect(&a.ty, &t, &sub_i(path, "args", i, "/value"));
            }
        }
        let allowed = r.class().unwrap_or(DataClass::Public);
        for (i, a) in args.iter().enumerate() {
            if class_rank(a.cls) > class_rank(allowed) {
                let connector = format!("{}.{}", r.def.module().unwrap_or_default(), r.connector);
                self.over_model(
                    format!(
                        "{} data is sent to the connector {}, whose class allows at most {} (spec/library.md \"What is sent to a connector\").",
                        a.cls.as_str(),
                        r.connector,
                        allowed.as_str()
                    ),
                    &sub_i(path, "args", i, "/value"),
                    class_rank(allowed),
                    JsObject::new()
                        .with("data_class", a.cls.as_str())
                        .with("allowed", allowed.as_str())
                        .with("connector", connector.as_str()),
                );
            }
        }
    }

    /// E1406: an agent never holds a write tool. Each capability expression
    /// of an agent's `caps` that stands for a `tool.call` with a write tool.
    pub(crate) fn agent_write_tools(&mut self, agent: &str, caps: &'a [Value], base: &str) {
        for (i, c) in caps.iter().enumerate() {
            let Some(c) = Expr::of(c) else { continue };
            for v in caps_of(self.defs, c, self.cap_opts()) {
                if v.ctor() == TOOL_CALL && v.write() {
                    self.holds_write_tool(agent, &v, &format!("{base}/caps/{i}"), "caps");
                }
            }
        }
    }

    /// The connectors whose read-only tools `caps` holds above the class the
    /// best model capability among them may receive, with the class each
    /// returns and that bound, by connector (`<module>.<connector>`), each
    /// once; none when `caps` hold no model capability (no model reads what
    /// the tools give). A connector whose class is no data class returns the
    /// most sensitive.
    fn reads_above_model(caps: &[CapVal]) -> Vec<(String, DataClass, DataClass)> {
        let Some(best) = caps
            .iter()
            .filter(|c| c.ctor() == "model.infer")
            .map(|c| c.max_class().unwrap_or(DataClass::Internal))
            .max()
        else {
            return Vec::new();
        };
        let mut out: Vec<(String, DataClass, DataClass)> = Vec::new();
        for c in caps.iter().filter(|c| c.ctor() == TOOL_CALL && !c.write()) {
            let Some(id) = tool_connector(c) else {
                continue;
            };
            let class = c.max_class().unwrap_or(DataClass::Restricted);
            if class > best && !out.iter().any(|(i, _, _)| i == id) {
                out.push((id.to_owned(), class, best));
            }
        }
        out
    }

    /// The message and the facts of E0220 for `who`, whose loop reads tools of
    /// `id` of class `class` and whose model may receive at most `allowed`.
    fn read_above_model(
        who: &str,
        id: &str,
        class: DataClass,
        allowed: DataClass,
    ) -> (String, JsObject) {
        (
            format!(
                "{who} holds read-only tools of the connector {id}, which return {} data, and its model capability allows at most {}: what the tools return reaches the model (spec/library.md \"Declaration\").",
                class.as_str(),
                allowed.as_str()
            ),
            JsObject::new()
                .with("data_class", class.as_str())
                .with("allowed", allowed.as_str())
                .with("connector", id),
        )
    }

    /// E0120 for an agent whose `caps` hold, through a capability of any
    /// module, read-only tools whose signatures name types the program does
    /// not have as their connector's module means them: the agent's loop
    /// calls those tools with the program's types. At the capability.
    pub(crate) fn agent_unbound(&mut self, caps: &'a [Value], base: &str) {
        for (i, c) in caps.iter().enumerate() {
            let Some(e) = Expr::of(c) else { continue };
            let at = format!("{base}/caps/{i}");
            let mut seen = Vec::new();
            for v in caps_of(self.defs, e, self.cap_opts()) {
                if v.ctor() != TOOL_CALL {
                    continue;
                }
                for item in v.scope().unwrap_or_default() {
                    let Some((rest, tool)) = item.rsplit_once('.') else {
                        continue;
                    };
                    let connector = rest.rsplit_once('.').map_or(rest, |(_, n)| n);
                    let defs: &'a Map = self.defs;
                    let Some((name, def)) = defs
                        .iter()
                        .find(|(n, _)| *n == connector)
                        .and_then(|(n, d)| ConnectorDef::of(d).map(|c| (n, c)))
                    else {
                        continue;
                    };
                    let Some(tool) = def.tools().map(|(n, _)| n).find(|n| *n == tool) else {
                        continue;
                    };
                    self.unbound_names(name, def, tool, &at, &mut seen);
                }
            }
        }
    }

    /// E0220 for an agent whose declared `caps` hold read-only tools of a
    /// connector above the class its model may receive: what its loop reads
    /// reaches its model. At the capability that holds them.
    pub(crate) fn agent_read_classes(&mut self, agent: &str, caps: &'a [Value], base: &str) {
        let held: Vec<(usize, Vec<CapVal>)> = caps
            .iter()
            .enumerate()
            .filter_map(|(i, c)| Expr::of(c).map(|e| (i, caps_of(self.defs, e, self.cap_opts()))))
            .collect();
        let all: Vec<CapVal> = held.iter().flat_map(|(_, cs)| cs.iter().cloned()).collect();
        for (id, class, allowed) in Self::reads_above_model(&all) {
            let at = held
                .iter()
                .find(|(_, cs)| {
                    cs.iter()
                        .any(|c| tool_connector(c) == Some(id.as_str()) && !c.write())
                })
                .map_or(0, |(i, _)| *i);
            let (message, facts) = Self::read_above_model(agent, &id, class, allowed);
            self.report("E0220", message, &format!("{base}/caps/{at}"), Some(facts));
        }
    }

    /// E0220 for a delegation whose grant (`granted`) holds read-only tools
    /// of a connector above the class its model may receive, where the
    /// agent's own `caps` (`held`) do not already (that is reported at the
    /// agent): its `with caps`, or a map's, narrowed the model. At the
    /// delegation; in a sub-program, as for a model, E1706 when the lead's
    /// class is above the bound.
    pub(crate) fn grant_read_classes(
        &mut self,
        who: &str,
        granted: &[CapVal],
        held: &[CapVal],
        path: &str,
    ) {
        let already: Vec<String> = Self::reads_above_model(held)
            .into_iter()
            .map(|(id, _, _)| id)
            .collect();
        for (id, class, allowed) in Self::reads_above_model(granted) {
            if already.contains(&id) {
                continue;
            }
            let (message, facts) = Self::read_above_model(who, &id, class, allowed);
            self.over_model(message, path, class_rank(allowed), facts);
        }
    }

    /// E1406 for a map whose `with caps` hands a write tool and whose body
    /// delegates, in the body or in a function it calls however deep
    /// (`usages`, what the body used, a function's delegations included): a
    /// map hands its `with caps` to each delegation of its body, so the write
    /// tool would reach an agent. At each such capability of the `with caps`.
    /// A map whose body delegates nothing may hand a write tool to its body's
    /// own effects.
    pub(crate) fn map_hands_write_tools(&mut self, e: Expr<'a>, path: &str, usages: &[Usage]) {
        let Some(delegation) = usages.iter().find(|u| u.effect == "Delegate") else {
            return;
        };
        let agent = delegation
            .to
            .as_deref()
            .map_or("an agent", |to| to.split('.').next().unwrap_or(to))
            .to_owned();
        for (i, c) in e.caps().unwrap_or_default().iter().enumerate() {
            let Some(c) = Expr::of(c) else { continue };
            for v in caps_of(self.defs, c, self.cap_opts()) {
                if v.ctor() == TOOL_CALL && v.write() {
                    self.holds_write_tool(&agent, &v, &format!("{path}/caps/{i}"), "map with caps");
                }
            }
        }
    }

    /// E1406 for `v`, a write part of a `tool.call` an agent would hold, at
    /// `path`; `through` is how it would reach the agent (`caps`, `with
    /// caps` of the delegation, or a map's `with caps`).
    pub(crate) fn holds_write_tool(&mut self, agent: &str, v: &CapVal, path: &str, through: &str) {
        let shown = show_cap(v);
        self.report(
            "E1406",
            format!(
                "{agent} would hold {shown}, a write tool. An agent holds only read-only tools; a write tool is called by a workflow's body, as a critical effect (spec/library.md \"tool.call\")."
            ),
            path,
            Some(
                JsObject::new()
                    .with("agent", agent)
                    .with("capability", shown.as_str())
                    .with("through", through),
            ),
        );
    }

    /// What an agent receives against the class of every connector whose
    /// tools its grant holds (spec/library.md "What is sent to a
    /// connector"): E0220 at the delegation, once for each connector; in a
    /// sub-program, as for a model, E1706 when the lead's class is above it.
    pub(crate) fn grant_classes(
        &mut self,
        who: &str,
        granted: &[CapVal],
        cls: DataClass,
        path: &str,
    ) {
        let mut seen: Vec<&str> = Vec::new();
        for c in granted {
            let Some(id) = tool_connector(c) else {
                continue;
            };
            if seen.contains(&id) {
                continue;
            }
            seen.push(id);
            let allowed = c.max_class().unwrap_or(DataClass::Public);
            if class_rank(cls) > class_rank(allowed) {
                self.over_model(
                    format!(
                        "{who} receives {} data, and holds tools of the connector {id}, whose class allows at most {} (spec/library.md \"What is sent to a connector\").",
                        cls.as_str(),
                        allowed.as_str()
                    ),
                    path,
                    class_rank(allowed),
                    JsObject::new()
                        .with("data_class", cls.as_str())
                        .with("allowed", allowed.as_str())
                        .with("connector", id),
                );
            }
        }
    }

    /// `evalCap` of a `tool.call(c, t…)` in a program of 0.6, which
    /// `caps_from_call` read as `r` (E1404): its problem, or a connector
    /// that is neither the program's own nor one a `use` lists (a module's
    /// definition is named through a `use` list alone).
    pub(crate) fn tool_call_cap(
        &mut self,
        e: Expr<'a>,
        r: Option<crate::caps::CapResult>,
        path: &str,
    ) -> Vec<CapVal> {
        let r = r.unwrap_or_default();
        let problem = r.problem.clone().or_else(|| {
            let c = e
                .args()
                .next()
                .and_then(|a| a.value())
                .and_then(Expr::name)
                .unwrap_or_default();
            (!self.named_by_program(c)).then(|| {
                format!("'{c}' is a connector that the program neither defines nor lists in a use")
            })
        });
        if problem.is_none()
            && let Some(c) = e.args().next().and_then(|a| a.value()).and_then(Expr::name)
            && let Some(def) = self.connector_def(c)
        {
            let mut seen = Vec::new();
            for t in e
                .args()
                .skip(1)
                .filter_map(|a| a.value())
                .filter_map(Expr::name)
            {
                self.unbound_names(c, def, t, path, &mut seen);
            }
        }
        if let Some(problem) = problem {
            self.report(
                "E1404",
                format!("{problem} (spec/library.md \"tool.call\")."),
                path,
                Some(JsObject::new().with("problem", problem.as_str())),
            );
            return Vec::new();
        }
        r.caps
    }

    /// Whether `name` is the program's own definition or one a `use` lists:
    /// a name the program may give `tool.call` as its connector.
    pub(crate) fn named_by_program(&self, name: &str) -> bool {
        self.program.defs().is_some_and(|d| d.contains_key(name))
            || self.program.imports().any(|u| {
                !crate::imports::KnownModules::is_builtin(u.module().unwrap_or("std"))
                    && u.names().any(|n| n == name)
            })
    }

    /// `checkConnector`: a connector's declaration (E1402) and each of its
    /// tools' (E1401, E1403, and E0210 for a write tool's parameter of model
    /// output or untrusted content, R4).
    pub(crate) fn check_connector(&mut self, name: &str, d: Definition<'a>, base: &str) {
        let Some(c) = ConnectorDef::of(d.value()) else {
            return;
        };
        let malformed = |problem: &str| {
            JsObject::new()
                .with("connector", name)
                .with("problem", problem)
        };
        if let Some(why) = c.mcp().and_then(url_problem) {
            self.report(
                "E1402",
                format!(
                    "The server of connector {name} is one absolute https URL, with no user, password, port, query or fragment, and {why} (spec/library.md \"Declaration\")."
                ),
                &sub(base, "mcp"),
                Some(malformed("url").with("reason", why)),
            );
        }
        if c.version().is_none() {
            self.report(
                "E1402",
                format!("Connector {name} has no version."),
                base,
                Some(malformed("version")),
            );
        }
        match c.class() {
            None => self.report(
                "E1402",
                format!(
                    "Connector {name} has no class: the data class of what its tools return, and the most it may be sent."
                ),
                base,
                Some(malformed("class")),
            ),
            Some(cl) if DataClass::from_name(cl).is_none() => {
                let classes: Vec<JsValue> = DataClass::ALL
                    .iter()
                    .map(|k| JsValue::from(k.as_str()))
                    .collect();
                self.report(
                    "E1402",
                    format!(
                        "The class of connector {name}, '{cl}', is not a data class: public, internal, confidential or restricted."
                    ),
                    &sub(base, "class"),
                    Some(malformed("class").with("expected", classes)),
                );
            }
            Some(_) => {}
        }
        if c.tools().next().is_none() {
            self.report(
                "E1402",
                format!("Connector {name} declares no tool."),
                &sub(base, "tools"),
                Some(malformed("no_tool")),
            );
        }
        for (tn, t) in c.tools() {
            self.check_tool(name, c, tn, t, &format!("{base}/tools/{tn}"));
        }
    }

    /// E1401 for a tool, with its problem.
    fn unclosed(
        &mut self,
        connector: &str,
        tool: &str,
        path: &str,
        problem: &str,
        message: String,
    ) {
        self.report(
            "E1401",
            message,
            path,
            Some(
                JsObject::new()
                    .with("connector", connector)
                    .with("tool", tool)
                    .with("problem", problem),
            ),
        );
    }

    /// E1403 for a tool whose result is not of its class's kind.
    fn wrong_result(&mut self, connector: &str, tool: &str, tb: &str, t: Tool<'a>, want: &str) {
        let found = show(&self.ty(t.returns()));
        self.report(
            "E1403",
            format!(
                "Tool {connector}.{tool} returns {found}; a {} tool returns {want} (spec/library.md \"Tool classes\").",
                if want.starts_with("Untrusted") {
                    "read-only"
                } else {
                    "write"
                }
            ),
            &sub(tb, "returns"),
            Some(
                JsObject::new()
                    .with("connector", connector)
                    .with("tool", tool)
                    .with("expected", want)
                    .with("found", found.as_str()),
            ),
        );
    }

    /// One tool of a connector: of exactly one closed class (E1401), with
    /// the result of its class (E1403).
    fn check_tool(&mut self, cn: &str, c: ConnectorDef<'a>, tn: &str, t: Tool<'a>, tb: &str) {
        let write = t.declares_write();
        if t.read_only() == write {
            let (problem, what) = if write {
                ("both", "is read_only and of a write class")
            } else {
                ("neither", "is neither read_only nor of a write class")
            };
            self.unclosed(
                cn,
                tn,
                tb,
                problem,
                format!(
                    "Tool {cn}.{tn} {what}; a tool is read_only, or critical with an idempotency key and a retry class (spec/library.md \"Tool classes\")."
                ),
            );
            return;
        }
        self.signature_class(cn, c, tn, t, tb);
        if t.read_only() {
            if wrapped(t.members().get("returns"), "Untrusted").is_none() {
                self.wrong_result(cn, tn, tb, t, "Untrusted<T>");
            }
            return;
        }
        self.write_class(cn, c, tn, t, tb);
        if wrapped(t.members().get("returns"), "Receipt").is_none() {
            self.wrong_result(cn, tn, tb, t, "Receipt<T>");
        }
        for (i, p) in t.params().iter().enumerate() {
            let ty = self.param_type(p);
            let lvl = epistemic(&ty).level;
            if lvl == Level::Inferred || lvl == Level::Untrusted {
                self.report(
                    "E0210",
                    format!(
                        "Write tool '{cn}.{tn}' cannot take {}; critical parameters take only T or Verified<T> (R4).",
                        show(&ty)
                    ),
                    &format!("{tb}/params/{i}/type"),
                    None,
                );
            }
        }
    }

    /// The write class of a tool (E1401): `critical`, `idempotency key` of
    /// a `Text` parameter and `retry_class`; `reconcile by` with
    /// `reconcilable` and only then, naming a fitting read-only tool; a
    /// `compensation` naming another write tool of the connector.
    fn write_class(&mut self, cn: &str, c: ConnectorDef<'a>, tn: &str, t: Tool<'a>, tb: &str) {
        let mut missing: Vec<&str> = Vec::new();
        if !t.critical() {
            missing.push("critical");
        }
        if t.idempotency_key().is_none() {
            missing.push("idempotency key");
        }
        if t.retry_class().is_none() {
            missing.push("retry_class");
        }
        if !missing.is_empty() {
            self.unclosed(
                cn,
                tn,
                tb,
                "missing",
                format!(
                    "Write tool {cn}.{tn} does not declare {}; a write tool is critical, with an idempotency key and a retry class (spec/library.md \"Tool classes\").",
                    missing.join(", ")
                ),
            );
        }
        if let Some(k) = t.idempotency_key() {
            let fits = t
                .params()
                .iter()
                .any(|p| p.get("name").and_then(Value::as_str) == Some(k) && is_text(p));
            if !fits {
                self.unclosed(
                    cn,
                    tn,
                    tb_of(tb, "idempotency_key").as_str(),
                    "idempotency_key",
                    format!(
                        "The idempotency key of {cn}.{tn}, {k}, is no parameter of type Text; the runtime sends the operation key in it."
                    ),
                );
            }
        }
        let retry = t.retry_class();
        if retry == Some("read_only") {
            self.unclosed(
                cn,
                tn,
                &tb_of(tb, "retry_class"),
                "retry_class",
                format!(
                    "Write tool {cn}.{tn} has the retry class read_only, which is not a write's: idempotent, reconcilable or non_retryable."
                ),
            );
        }
        match (retry == Some("reconcilable"), t.reconcile_by()) {
            (true, None) => self.unclosed(
                cn,
                tn,
                tb,
                "reconcile_by_missing",
                format!(
                    "Write tool {cn}.{tn} is reconcilable and names no 'reconcile by' tool, which the runtime asks after a lost answer."
                ),
            ),
            (false, Some(_)) => self.unclosed(
                cn,
                tn,
                &tb_of(tb, "reconcile_by"),
                "reconcile_by_not_reconcilable",
                format!(
                    "Write tool {cn}.{tn} names a 'reconcile by' tool but is not reconcilable; only a reconcilable tool is reconciled."
                ),
            ),
            (true, Some(r)) if !reconciles(c, t, r) => self.unclosed(
                cn,
                tn,
                &tb_of(tb, "reconcile_by"),
                "reconcile_by",
                format!(
                    "{cn}.{r} cannot reconcile {cn}.{tn}: it is a read-only tool of {cn} that takes one Text parameter, the key, and returns Untrusted<Option<T>> where the write returns Receipt<T>."
                ),
            ),
            _ => {}
        }
        if let Some(k) = t.compensation() {
            let fits = k != tn
                && c.tool(k)
                    .is_some_and(|x| x.declares_write() && !x.read_only());
            if !fits {
                self.unclosed(
                    cn,
                    tn,
                    &tb_of(tb, "compensation"),
                    "compensation",
                    format!("The compensation of {cn}.{tn}, {k}, is no other write tool of {cn}."),
                );
            }
        }
    }
}

/// `${tb}/${member}`.
fn tb_of(tb: &str, member: &str) -> String {
    sub(tb, member)
}

/// Whether tool `r` of `c` can reconcile the write `t`: a read-only tool,
/// with one `Text` parameter, returning `Untrusted<Option<T>>` where `t`
/// returns `Receipt<T>`.
fn reconciles(c: ConnectorDef<'_>, t: Tool<'_>, r: &str) -> bool {
    let Some(rt) = c.tool(r) else {
        return false;
    };
    if !rt.read_only() || rt.declares_write() {
        return false;
    }
    let one_text = matches!(rt.params(), [p] if is_text(p));
    let answer =
        wrapped(rt.members().get("returns"), "Untrusted").and_then(|o| wrapped(Some(o), "Option"));
    let receipt = wrapped(t.members().get("returns"), "Receipt");
    one_text
        && matches!((answer, receipt), (Some(a), Some(b)) if canonicalize(a) == canonicalize(b))
}
