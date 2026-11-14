//! Prints IR as Mandate text, as `mandate fmt` does: a port of
//! `compiler/src/print/printer.ts`, which is the specification. Every
//! function here is the function of that file with the same name (in snake
//! case; `type` is [`type_`]), and the text it prints is the same byte for
//! byte, for every program the vectors know.
//!
//! The printer is the inverse of the parser: what it prints for a program
//! that was loaded reads back to the same IR, except where the reference
//! itself does not (a comparison in parentheses on the left of a comparison
//! is printed without them; see [`binary`]). Where the reference prints
//! something odd the port prints the same, and a comment says so.
//!
//! JavaScript semantics the port imitates:
//!
//! - A member the IR does not have reads as `undefined`: `` `${x}` `` writes
//!   `undefined` ([`show`]), a join leaves it out ([`join_piece`]), and `if
//!   (x)` is false ([`truthy`]); `x !== undefined` is "the member is there".
//!   Truthiness is JavaScript's: an array or an object, an empty one too, is
//!   true; `""`, `0`, `false` and `null` are false.
//! - Objects are walked in the order of [`mandate_ir::Map`], which is the
//!   order of `Object.keys` and `Object.entries`; definitions are sorted with
//!   `sort()`, so by UTF-16 code units ([`mandate_ir::sort_utf16`]).
//! - `s.trimStart()` is [`mandate_ir::trim_start`], with ECMAScript's white
//!   space.
//! - The regular expressions of `escapeText` and `money` are written as
//!   character and suffix operations, with the pattern in a comment.
//!
//! Where the TypeScript throws on a program that is not well formed (a
//! `TypeError` for `x.map` of `undefined`), the port reads the missing list
//! as empty, or gives an error when it has nothing to print; it never
//! panics. The `Error`s the TypeScript throws on purpose are given with its
//! messages.

use mandate_ir::{DefKind, ExprOp, Map, StmtOp, Value, sort_utf16, trim_start};

/// What a printing function gives: the text, or the message of the error the
/// TypeScript throws.
type Printed = Result<String, String>;

/// What `undefined` and `null` members read as; see [`member`].
static NULL: Value = Value::Null;

/// Definitions are printed by kind in this order, by name inside each kind.
const KIND_ORDER: [DefKind; 13] = [
    DefKind::Role,
    DefKind::Interface,
    DefKind::Component,
    DefKind::Environment,
    DefKind::Capability,
    DefKind::Type,
    DefKind::Const,
    DefKind::Effect,
    DefKind::Extern,
    DefKind::Fn,
    DefKind::Contract,
    DefKind::Agent,
    DefKind::Workflow,
];

/// Prints a program as Mandate text: `printProgram(p)`.
///
/// `program` is a program that was loaded (`load`), by either reader: it is
/// at most 64 levels deep, which bounds the recursion of the functions below
/// (a few frames per level of IR). Given a value that is not a program, the
/// result is whatever its members make; it does not panic.
///
/// The text ends with a line feed. It is `Err` where the TypeScript throws:
/// a union type anywhere but at the top of a type definition, a set literal
/// with items, a string literal inside an interpolation, and a value that
/// should be a string and is not.
///
/// # Errors
///
/// The message of the TypeScript's `Error`: `"A union type can only appear as
/// a type definition."`, `"Only the empty set literal has a text form."` or
/// `"String literals cannot appear inside an interpolation."`; or a
/// description of what is not as the IR has it.
pub fn print_program(program: &Value) -> Printed {
    let p = program;
    let mut out: Vec<String> = Vec::new();
    let language = member(p, "language");
    if language.as_str() != Some("mandate/0.1") {
        // `p.language.replace("/", " @ ")`: the first "/" only.
        let Some(language) = language.as_str() else {
            return Err("TypeError: the program's language is not a string".to_owned());
        };
        out.push(language.replacen('/', " @ ", 1));
        out.push(String::new());
    }
    out.push(format!(
        "module {} @ {}",
        show(p, "module"),
        show(p, "version")
    ));
    if !items(p, "uses").is_empty() {
        out.push(String::new());
        for u in items(p, "uses") {
            // `u.names ? ... : ...`: names are there, an empty list too.
            if truthy(member(u, "names")) {
                out.push(format!(
                    "use {}.{{{}}}",
                    show(u, "module"),
                    join(items(u, "names"), ", ")
                ));
            } else {
                out.push(format!("use {}", show(u, "module")));
            }
        }
    }
    let defs: Vec<(&str, &Value)> = member(p, "defs")
        .as_object()
        .into_iter()
        .flat_map(Map::iter)
        .collect();
    for kind in KIND_ORDER {
        let mut names: Vec<&str> = defs
            .iter()
            .filter(|(_, d)| DefKind::from_value(member(d, "kind")) == Some(kind))
            .map(|(n, _)| *n)
            .collect();
        sort_utf16(&mut names);
        for name in names {
            out.push(String::new());
            out.push(print_def(name, member(member(p, "defs"), name))?);
        }
    }
    let mut workflows: Vec<&str> = defs
        .iter()
        .filter(|(_, d)| DefKind::from_value(member(d, "kind")) == Some(DefKind::Workflow))
        .map(|(n, _)| *n)
        .collect();
    sort_utf16(&mut workflows);
    for name in workflows {
        let wf = member(member(p, "defs"), name);
        for h in items(wf, "on") {
            out.push(String::new());
            out.push(format!(
                "on {} in {name} => {}",
                show(h, "event"),
                expr(member(h, "then"), 0, "")?
            ));
        }
    }
    for (name, t) in entries(p, "tests") {
        out.push(String::new());
        let mut lines = vec![format!("test {} {{", quote_text(name))];
        if truthy(member(t, "handlers")) {
            lines.push("  with handlers {".to_owned());
            let hs: Vec<(&str, &Value)> = entries(t, "handlers").collect();
            for (i, (k, v)) in hs.iter().enumerate() {
                let comma = if i < hs.len().saturating_sub(1) {
                    ","
                } else {
                    ""
                };
                lines.push(format!("    {k} = {}{comma}", expr(v, 0, "    ")?));
            }
            lines.push("  }".to_owned());
        }
        for s in items(t, "body") {
            lines.push(stmt(s, "  ")?);
        }
        lines.push("}".to_owned());
        out.push(lines.join("\n"));
    }
    let mut text = out.join("\n");
    text.push('\n');
    Ok(text)
}

// ── reading the IR as JavaScript reads it ────────────────────────────────

/// `v[key]`, with `null` for a member that is not there (and for a `v` with
/// no members). Whether the member is there is `v.get(key).is_some()`.
fn member<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&NULL)
}

/// JavaScript truthiness of a member's value (`if (x)`): `null`, `false`
/// and `""` are false (and `0`, and a member that is not there); everything
/// else, an empty array or object included, is true.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.get() != 0,
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The elements of an array member; none when it is not an array (where the
/// TypeScript would throw a `TypeError` calling `.map` or `for...of` on it).
fn items<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    member(v, key).as_array().unwrap_or_default()
}

/// `Object.entries(v[key])`: the members of an object member in order; none
/// when it is not an object.
fn entries<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = (&'a str, &'a Value)> {
    member(v, key).as_object().into_iter().flat_map(Map::iter)
}

/// `String(x)` of a value that might not be there: `` `${v[key]}` ``. A
/// number is an integer here, so it is written as `Number::toString` writes
/// it.
fn show(v: &Value, key: &str) -> String {
    js_string(v.get(key))
}

/// `String(x)`: `undefined` for a missing value, `null`, `true`, `false`,
/// the number, the string itself, the elements joined with `,` for an array
/// (`null` and `undefined` elements empty), `[object Object]` for an object.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().map(join_piece).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// What `Array.prototype.join` writes for an element: nothing for `null`
/// (and `undefined`), else `String(element)`.
fn join_piece(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        other => js_string(Some(other)),
    }
}

/// `xs.join(sep)`.
fn join(xs: &[Value], sep: &str) -> String {
    xs.iter().map(join_piece).collect::<Vec<_>>().join(sep)
}

/// A value that has to be a string for the TypeScript to call `.replace` or
/// `.includes` on it; the `TypeError` it would throw otherwise.
fn text(v: &Value) -> Result<&str, String> {
    v.as_str()
        .ok_or_else(|| "TypeError: a text that is not a string".to_owned())
}

/// `quoteText(s)` of a member that has to be a string.
fn quoted(v: &Value) -> Printed {
    Ok(quote_text(text(v)?))
}

/// `xs.map(quoteText).join(", ")`.
fn quote_all(xs: &[Value]) -> Printed {
    let quoted: Result<Vec<String>, String> = xs.iter().map(quoted).collect();
    Ok(quoted?.join(", "))
}

// ── definitions ──────────────────────────────────────────────────────────

/// `printDef(name, d)`.
fn print_def(name: &str, d: &Value) -> Printed {
    let Some(kind) = DefKind::from_value(member(d, "kind")) else {
        return Err(format!("the definition {name} has no kind the IR knows"));
    };
    match kind {
        DefKind::Role => Ok(format!("role {name} {}", quoted(member(d, "description"))?)),
        DefKind::Capability => Ok(format!(
            "capability {name} = {}",
            expr(member(d, "value"), 0, "")?
        )),
        DefKind::Type => {
            let g = if truthy(member(d, "generics")) {
                format!("<{}>", join(items(d, "generics"), ", "))
            } else {
                String::new()
            };
            let def = type_def(member(d, "type"))?;
            let class = if truthy(member(d, "class")) {
                format!(" classified {}", show(d, "class"))
            } else {
                String::new()
            };
            Ok(format!("type {name}{g} = {def}{class}"))
        }
        DefKind::Const => {
            let ty = if truthy(member(d, "type")) {
                format!(": {}", type_(member(d, "type"))?)
            } else {
                String::new()
            };
            Ok(format!(
                "let {name}{ty} = {}",
                expr(member(d, "value"), 0, "")?
            ))
        }
        DefKind::Effect => print_effect(name, d),
        DefKind::Extern => {
            let mut s = format!(
                "extern {} {}::{}({}) -> {}\n  {}",
                show(d, "lang"),
                quoted(member(d, "file"))?,
                show(d, "symbol"),
                params(items(d, "params"))?,
                type_(member(d, "returns"))?,
                effects(items(d, "effects"))?
            );
            if truthy(member(d, "idempotent_by")) {
                s.push_str(&format!(
                    "\n  idempotent_by {}",
                    expr(member(d, "idempotent_by"), 0, "  ")?
                ));
            }
            Ok(s)
        }
        DefKind::Fn => {
            let mut s = format!(
                "{}fn {name}({}) -> {}",
                if truthy(member(d, "pub")) { "pub " } else { "" },
                params(items(d, "params"))?,
                type_(member(d, "returns"))?
            );
            // `d.effects`: a list is there even when empty (`! {}`).
            if truthy(member(d, "effects")) {
                s.push_str(&format!(" {}", effects(items(d, "effects"))?));
            }
            if truthy(member(d, "budget")) {
                s.push_str(&format!("\n  {}", budget(member(d, "budget"))?));
            }
            s.push('\n');
            s.push_str(&block(items(d, "body"), "")?);
            Ok(s)
        }
        DefKind::Contract => print_contract(name, d),
        DefKind::Agent => print_agent(name, d),
        DefKind::Workflow => print_workflow(name, d),
        DefKind::Component => print_component(name, d),
        DefKind::Interface => Ok([
            format!("interface {name} {{"),
            format!("  protocol {}", show(d, "protocol")),
            format!("  spec     {}", quoted(member(d, "spec"))?),
            "}".to_owned(),
        ]
        .join("\n")),
        DefKind::Environment => print_environment(name, d),
    }
}

/// `case "effect"` of `printDef`.
fn print_effect(name: &str, d: &Value) -> Printed {
    let mut lines = vec![format!(
        "effect {name}({}) -> {}",
        params(items(d, "params"))?,
        type_(member(d, "returns"))?
    )];
    for c in items(d, "requires_caps") {
        lines.push(format!("  requires caps {}", expr(c, 0, "  ")?));
    }
    if truthy(member(d, "critical")) {
        lines.push("  critical".to_owned());
    }
    if truthy(member(d, "irreversible")) {
        lines.push("  irreversible".to_owned());
    }
    if truthy(member(d, "idempotency_required")) {
        lines.push("  idempotency required".to_owned());
    }
    if truthy(member(d, "retry_class")) {
        lines.push(format!("  retry_class {}", show(d, "retry_class")));
    }
    if truthy(member(d, "compensation")) {
        lines.push(format!("  compensation {}", show(d, "compensation")));
    }
    Ok(lines.join("\n"))
}

/// `case "contract"` of `printDef`.
fn print_contract(name: &str, d: &Value) -> Printed {
    let mut lines = vec![format!(
        "contract {name}({}) {{",
        params(items(d, "params"))?
    )];
    for r in items(d, "require") {
        lines.push(format!("  require {}", expr(r, 0, "  ")?));
    }
    /// The local `crit` of the TypeScript.
    fn crit(lines: &mut Vec<String>, kw: &str, n: &str, c: &Value) -> Result<(), String> {
        lines.push(format!("  {kw} {n} {}", quoted(member(c, "description"))?));
        lines.push(format!("    by {}", verifier(member(c, "by"))?));
        Ok(())
    }
    for (n, c) in entries(d, "accept") {
        crit(&mut lines, "accept", n, c)?;
    }
    for (n, c) in entries(d, "invariant") {
        crit(&mut lines, "invariant", n, c)?;
    }
    lines.push("}".to_owned());
    Ok(lines.join("\n"))
}

/// `d.caps.map((c) => noStruct(c, ind)).join(", ")`.
fn no_struct_all(caps: &[Value], ind: &str) -> Printed {
    let printed: Result<Vec<String>, String> = caps.iter().map(|c| no_struct(c, ind)).collect();
    Ok(printed?.join(", "))
}

/// `case "agent"` of `printDef`.
fn print_agent(name: &str, d: &Value) -> Printed {
    let remote = member(d, "remote");
    if truthy(remote) {
        let mut lines = vec![format!(
            "agent remote {name} = {}",
            expr(member(remote, "bind"), 0, "")?
        )];
        if remote.get("version").is_some() {
            lines.push(format!("  version {}", quoted(member(remote, "version"))?));
        }
        for r in items(remote, "require") {
            lines.push(format!("  require {}", expr(r, 0, "  ")?));
        }
        if truthy(member(remote, "trust")) {
            lines.push(format!("  trust {}", show(remote, "trust")));
        }
        if !items(d, "caps").is_empty() {
            lines.push(format!("  caps {}", no_struct_all(items(d, "caps"), "  ")?));
        }
        lines.push("  skills {".to_owned());
        for (n, s) in entries(d, "skills") {
            lines.push(format!("    {}", skill_sig(n, s, true)?));
        }
        lines.push("  }".to_owned());
        return Ok(lines.join("\n"));
    }
    let mut lines = vec![format!("agent {name} {{")];
    if d.get("role").is_some() {
        lines.push(format!("  role   {}", quoted(member(d, "role"))?));
    }
    if d.get("model").is_some() {
        lines.push(format!("  model  {}", show(d, "model")));
    }
    if !items(d, "caps").is_empty() {
        lines.push(format!(
            "  caps   {}",
            no_struct_all(items(d, "caps"), "  ")?
        ));
    }
    if truthy(member(d, "budget")) {
        lines.push(format!("  {}", budget(member(d, "budget"))?));
    }
    if truthy(member(d, "loop")) {
        lines.push(format!("  loop   {}", show(d, "loop")));
    }
    if truthy(member(d, "progress")) {
        let p = member(d, "progress");
        let parts: Vec<String> = ["window", "repeats", "stall"]
            .iter()
            .filter(|k| p.get(k).is_some())
            .map(|k| format!("{k}: {}", show(p, k)))
            .collect();
        lines.push(format!("  progress {{ {} }}", parts.join(", ")));
    }
    for (n, s) in entries(d, "skills") {
        let mut sig = format!("  skill {}", skill_sig(n, s, false)?);
        if truthy(member(s, "budget")) {
            sig.push_str(&format!("\n    {}", budget(member(s, "budget"))?));
        }
        // `s.body`: a list is there even when empty.
        if truthy(member(s, "body")) {
            sig.push('\n');
            sig.push_str(&block(items(s, "body"), "  ")?);
        }
        lines.push(sig);
    }
    lines.push("}".to_owned());
    Ok(lines.join("\n"))
}

/// The `envelope` part of `case "workflow"` of `printDef`: its lines, which
/// start with `  envelope {`.
fn print_envelope(env: &Value) -> Printed {
    let mut lines = vec!["  envelope {".to_owned()];
    if env.get("owner").is_some() {
        lines.push(format!("    owner   {}", show(env, "owner")));
    }
    if truthy(member(env, "caps")) {
        lines.push(format!(
            "    caps    {}",
            no_struct_all(items(env, "caps"), "    ")?
        ));
    }
    if truthy(member(env, "budget")) {
        // `.replace("budget ", "budget  ")`: the first one, at the start.
        lines.push(format!(
            "    {}",
            budget(member(env, "budget"))?.replacen("budget ", "budget  ", 1)
        ));
    }
    let spawn = member(env, "spawn");
    if truthy(spawn) {
        let mut parts: Vec<String> = Vec::new();
        if spawn.get("max_concurrent").is_some() {
            parts.push(format!("max_concurrent: {}", show(spawn, "max_concurrent")));
        }
        if spawn.get("max_class").is_some() {
            parts.push(format!("max_class: {}", show(spawn, "max_class")));
        }
        lines.push(format!("    spawn   {{ {} }}", parts.join(", ")));
    }
    for (effect, role) in entries(env, "approve") {
        lines.push(format!("    approve {effect} by {}", js_string(Some(role))));
    }
    lines.push("  }".to_owned());
    Ok(lines.join("\n"))
}

/// `case "workflow"` of `printDef`.
fn print_workflow(name: &str, d: &Value) -> Printed {
    let mut s = format!(
        "workflow {name}({}) -> {}",
        params(items(d, "params"))?,
        type_(member(d, "returns"))?
    );
    let has_envelope = truthy(member(d, "envelope"));
    if has_envelope {
        s.push('\n');
        s.push_str(&print_envelope(member(d, "envelope"))?);
    }
    // An envelope's caps take the place of the workflow's, which are then empty and not written.
    if !has_envelope || !items(d, "caps").is_empty() {
        s.push_str(&format!(
            "\n  caps    {}",
            no_struct_all(items(d, "caps"), "  ")?
        ));
    }
    if truthy(member(d, "budget")) {
        s.push_str(&format!("\n  {}", budget(member(d, "budget"))?));
    }
    if truthy(member(d, "ensures")) {
        s.push_str(&format!(
            "\n  ensures {}",
            no_struct(member(d, "ensures"), "  ")?
        ));
    }
    s.push('\n');
    s.push_str(&block(items(d, "body"), "")?);
    Ok(s)
}

/// `case "component"` of `printDef`.
fn print_component(name: &str, d: &Value) -> Printed {
    let mut lines = vec![
        format!("component {name} {{"),
        format!("  repo     {}", quoted(member(d, "repo"))?),
        format!("  root     {}", quoted(member(d, "root"))?),
        format!("  lang     {}", show(d, "lang")),
        format!("  owner    role {}", quoted(member(d, "owner"))?),
    ];
    if truthy(member(d, "build")) {
        lines.push(format!("  build    {}", commands(items(d, "build"))?));
    }
    if truthy(member(d, "test")) {
        lines.push(format!("  test     {}", commands(items(d, "test"))?));
    }
    if truthy(member(d, "provides")) {
        lines.push(format!("  provides {}", join(items(d, "provides"), ", ")));
    }
    if truthy(member(d, "consumes")) {
        lines.push(format!("  consumes {}", join(items(d, "consumes"), ", ")));
    }
    if truthy(member(d, "governance")) {
        lines.push(format!(
            "  governance {}",
            quote_all(items(d, "governance"))?
        ));
    }
    lines.push("}".to_owned());
    Ok(lines.join("\n"))
}

/// `case "environment"` of `printDef`.
fn print_environment(name: &str, d: &Value) -> Printed {
    let mut lines = vec![
        format!("environment {name} {{"),
        format!("  class {}", show(d, "class")),
    ];
    for (rn, r) in entries(d, "reads") {
        lines.push(format!("  read {rn} from {}", show(r, "from")));
        let query = member(r, "query");
        if query.get("sql").is_some() {
            // `quoteParts([{ text: r.query.sql }], false, "    ")`
            let part: Map = [("text", member(query, "sql").clone())]
                .into_iter()
                .collect();
            let parts = [Value::Object(part)];
            lines.push(format!("    sql {}", quote_parts(&parts, false, "    ")?));
        } else {
            lines.push(format!(
                "    logs where {}",
                no_struct(member(query, "logs"), "    ")?
            ));
        }
        lines.push(format!("    params ({})", params(items(r, "params"))?));
        lines.push(format!("    returns {}", type_(member(r, "returns"))?));
        lines.push(format!("    max_rows {}", show(r, "max_rows")));
    }
    for (effect, t) in entries(d, "authorize") {
        let by = if member(t, "by").as_str() == Some("policy") {
            "policy".to_owned()
        } else {
            format!("human(role: {})", quoted(member(t, "role"))?)
        };
        lines.push(format!("  authorize {effect} by {by}"));
    }
    lines.push("}".to_owned());
    Ok(lines.join("\n"))
}

/// `commands(cs)`.
fn commands(cs: &[Value]) -> Printed {
    let mut printed: Vec<String> = Vec::new();
    for c in cs {
        let command = quoted(member(c, "command"))?;
        let args = if items(c, "args").is_empty() {
            String::new()
        } else {
            format!(", [{}]", quote_all(items(c, "args"))?)
        };
        printed.push(format!("exec({command}{args})"));
    }
    Ok(printed.join(", "))
}

/// `skillSig(name, s, remote)`.
fn skill_sig(name: &str, s: &Value, remote: bool) -> Printed {
    // Local skills always declare effects; remote ones only when they have any.
    let eff = if !remote || !items(s, "effects").is_empty() {
        format!(" {}", effects(items(s, "effects"))?)
    } else {
        String::new()
    };
    Ok(format!(
        "{name}({}) -> {}{eff}",
        params(items(s, "params"))?,
        type_(member(s, "returns"))?
    ))
}

/// `params(ps)`.
fn params(ps: &[Value]) -> Printed {
    let mut printed: Vec<String> = Vec::new();
    for p in ps {
        printed.push(format!(
            "{}: {}",
            show(p, "name"),
            type_(member(p, "type"))?
        ));
    }
    Ok(printed.join(", "))
}

/// `effects(es)`.
fn effects(es: &[Value]) -> Printed {
    let mut printed: Vec<String> = Vec::new();
    for e in es {
        let mut s = show(e, "effect");
        // `e.args ? ... : ""`: a list is there even when empty (`name()`).
        if truthy(member(e, "args")) {
            s.push_str(&format!("({})", args(items(e, "args"), "")?));
        }
        printed.push(s);
    }
    Ok(format!("! {{{}}}", printed.join(", ")))
}

/// `budget(b)`.
fn budget(b: &Value) -> Printed {
    let mut parts: Vec<String> = Vec::new();
    if b.get("tokens").is_some() {
        parts.push(format!("tokens: {}", count(member(b, "tokens"))));
    }
    let time = member(b, "time");
    if truthy(time) {
        parts.push(format!("time: {}", duration(member(time, "ms"))));
    }
    let spend = member(b, "spend");
    if truthy(spend) {
        parts.push(format!(
            "spend: {}",
            money(member(spend, "micros"), member(spend, "currency"))
        ));
    }
    if b.get("steps").is_some() {
        parts.push(format!("steps: {}", show(b, "steps")));
    }
    if b.get("agents").is_some() {
        parts.push(format!("agents: {}", show(b, "agents")));
    }
    Ok(format!("budget {{ {} }}", parts.join(", ")))
}

/// `count(n)`: a token count, with `k` or `M` when it is a whole number of
/// thousands or millions. (A number that is not one: `String(n)`.)
fn count(n: &Value) -> String {
    match n.as_i64() {
        Some(n) => count_of(n),
        None => js_string(Some(n)),
    }
}

/// `count(n)` of an integer. In TypeScript `n % 1000 === 0` is true for a
/// negative multiple as well (`-2000 % 1000` is `-0`), and so it is here.
fn count_of(n: i64) -> String {
    if n != 0 && n % 1_000_000 == 0 {
        return format!("{}M", n / 1_000_000);
    }
    if n != 0 && n % 1000 == 0 {
        return format!("{}k", n / 1000);
    }
    n.to_string()
}

/// `duration(ms)`.
fn duration(ms: &Value) -> String {
    match ms.as_i64() {
        Some(ms) => duration_of(ms),
        None => format!("{}ms", js_string(Some(ms))),
    }
}

/// `duration(ms)` of an integer: the largest of `d`, `h`, `m`, `s` it is a
/// whole number of, else `ms`; zero is `0ms`.
fn duration_of(ms: i64) -> String {
    for (u, f) in [
        ("d", 86_400_000_i64),
        ("h", 3_600_000),
        ("m", 60_000),
        ("s", 1000),
    ] {
        if ms != 0 && ms.checked_rem(f) == Some(0) {
            return format!("{}{u}", ms.checked_div(f).unwrap_or_default());
        }
    }
    format!("{ms}ms")
}

/// `money(micros, currency)`.
fn money(micros: &Value, currency: &Value) -> String {
    // A value that is not a number is not an amount the IR can hold; read as 0.
    money_of(
        micros.as_i64().unwrap_or_default(),
        &js_string(Some(currency)),
    )
}

/// `money(micros, currency)` of an integer amount: the whole units, then the
/// fraction with its trailing zeros left off, then the currency.
fn money_of(micros: i64, currency: &str) -> String {
    let neg = micros < 0;
    let abs = micros.unsigned_abs();
    let whole = abs / 1_000_000;
    // `String(abs % 1_000_000).padStart(6, "0").replace(/0+$/, "")`
    let frac_digits = format!("{:06}", abs % 1_000_000);
    let frac = frac_digits.trim_end_matches('0');
    let sign = if neg { "-" } else { "" };
    if frac.is_empty() {
        format!("{sign}{whole} {currency}")
    } else {
        format!("{sign}{whole}.{frac} {currency}")
    }
}

// ── types ────────────────────────────────────────────────────────────────

/// `typeDef(t)`: a type, or a union of variants, which only a type
/// definition may be.
fn type_def(t: &Value) -> Printed {
    if t.get("union").is_some() {
        let mut variants: Vec<String> = Vec::new();
        for v in items(t, "union") {
            if truthy(member(v, "fields")) {
                variants.push(format!(
                    "{}({})",
                    show(v, "tag"),
                    params(items(v, "fields"))?
                ));
            } else {
                variants.push(join_piece(member(v, "tag")));
            }
        }
        return Ok(variants.join(" | "));
    }
    type_(t)
}

/// `type(t)`.
fn type_(t: &Value) -> Printed {
    if t.get("ref").is_some() {
        // `t.args ? ... : t.ref`: a list is there even when empty (`T<>`).
        if truthy(member(t, "args")) {
            let mut type_args: Vec<String> = Vec::new();
            for a in items(t, "args") {
                type_args.push(type_(a)?);
            }
            return Ok(format!("{}<{}>", show(t, "ref"), type_args.join(", ")));
        }
        return Ok(show(t, "ref"));
    }
    if t.get("record").is_some() {
        let mut fields: Vec<String> = Vec::new();
        for (k, v) in entries(t, "record") {
            fields.push(format!("{k}: {}", type_(v)?));
        }
        // An empty record is `{  }`, with two spaces.
        return Ok(format!("{{ {} }}", fields.join(", ")));
    }
    if t.get("enum").is_some() {
        return Ok(format!("enum {{ {} }}", join(items(t, "enum"), ", ")));
    }
    if t.get("refine").is_some() {
        return Ok(format!(
            "{} where {}",
            type_(member(t, "refine"))?,
            expr(member(t, "where"), 0, "")?
        ));
    }
    Err("A union type can only appear as a type definition.".to_owned())
}

/// `verifier(v)`.
fn verifier(v: &Value) -> Printed {
    if v.get("all").is_some() {
        let mut parts: Vec<String> = Vec::new();
        for x in items(v, "all") {
            parts.push(verifier(x)?);
        }
        return Ok(parts.join(" and "));
    }
    if v.get("static").is_some() {
        return Ok(format!(
            "static {}",
            expr(member(v, "static"), ABOVE_AND, "    ")?
        ));
    }
    expr(member(v, "call"), ABOVE_AND, "    ")
}

// ── statements ───────────────────────────────────────────────────────────

/// `block(body, ind)`.
fn block(body: &[Value], ind: &str) -> Printed {
    let mut lines = vec![format!("{ind}{{")];
    let inner = format!("{ind}  ");
    for s in body {
        lines.push(stmt(s, &inner)?);
    }
    lines.push(format!("{ind}}}"));
    Ok(lines.join("\n"))
}

/// `block(body, ind).trimStart()`.
fn block_trimmed(body: &[Value], ind: &str) -> Printed {
    Ok(trim_start(&block(body, ind)?).to_owned())
}

/// `stmt(s, ind)`.
fn stmt(s: &Value, ind: &str) -> Printed {
    let Some(op) = StmtOp::from_value(member(s, "op")) else {
        return Err("a statement with no op the IR knows".to_owned());
    };
    match op {
        StmtOp::Let => {
            let ty = if truthy(member(s, "type")) {
                format!(": {}", type_(member(s, "type"))?)
            } else {
                String::new()
            };
            Ok(format!(
                "{ind}let {}{ty} = {}",
                show(s, "name"),
                expr(member(s, "value"), 0, ind)?
            ))
        }
        StmtOp::Par => stmt_par(s, ind),
        StmtOp::If => {
            let mut out = format!(
                "{ind}if {} {}",
                no_struct(member(s, "cond"), ind)?,
                block_trimmed(items(s, "then"), ind)?
            );
            if truthy(member(s, "else")) {
                out.push_str(&format!(" else {}", block_trimmed(items(s, "else"), ind)?));
            }
            Ok(out)
        }
        StmtOp::Loop => {
            let head = if s.get("max_iter").is_some() {
                format!(" max_iter {}", show(s, "max_iter"))
            } else if truthy(member(s, "until")) {
                format!(" until {}", no_struct(member(s, "until"), ind)?)
            } else {
                String::new()
            };
            Ok(format!(
                "{ind}loop{head} {}",
                block_trimmed(items(s, "body"), ind)?
            ))
        }
        StmtOp::Return => {
            let value = if truthy(member(s, "value")) {
                format!(" {}", expr(member(s, "value"), 0, ind)?)
            } else {
                String::new()
            };
            Ok(format!("{ind}return{value}"))
        }
        StmtOp::OnError => Ok(format!(
            "{ind}on error({}) => {}",
            pattern(member(s, "pattern")),
            expr(member(s, "then"), 0, ind)?
        )),
        StmtOp::Run => Ok(format!(
            "{ind}run {} expect {}",
            expr(member(s, "target"), 0, ind)?,
            show(s, "expect")
        )),
        StmtOp::Expr => {
            // A statement that starts with `-` would continue the previous one.
            let text = expr(member(s, "value"), 0, ind)?;
            if text.starts_with('-') {
                Ok(format!("{ind}({text})"))
            } else {
                Ok(format!("{ind}{text}"))
            }
        }
    }
}

/// `case "par"` of `stmt`.
fn stmt_par(s: &Value, ind: &str) -> Printed {
    let supervise = if truthy(member(s, "supervise")) {
        format!(" supervise {}", call_spec(member(s, "supervise"))?)
    } else {
        String::new()
    };
    let mut lines = vec![format!("{ind}par{supervise} {{")];
    let inner = format!("{ind}  ");
    for (n, e) in entries(s, "branches") {
        lines.push(format!("{inner}{n} = {}", expr(e, 0, &inner)?));
    }
    lines.push(format!("{ind}}}"));
    Ok(lines.join("\n"))
}

/// `pattern(p)`.
fn pattern(p: &Value) -> String {
    match member(p, "p").as_str() {
        Some("wild") => return "_".to_owned(),
        Some("bind") => return show(p, "name"),
        _ => {}
    }
    // `p.args ? ... : p.tag`: a list is there even when empty (`T()`).
    if truthy(member(p, "args")) {
        let subs: Vec<String> = items(p, "args").iter().map(pattern).collect();
        format!("{}({})", show(p, "tag"), subs.join(", "))
    } else {
        show(p, "tag")
    }
}

/// `callSpec(c)`.
fn call_spec(c: &Value) -> Printed {
    if truthy(member(c, "args")) {
        Ok(format!(
            "{}({})",
            show(c, "name"),
            args(items(c, "args"), "")?
        ))
    } else {
        Ok(show(c, "name"))
    }
}

// ── expressions ──────────────────────────────────────────────────────────

/// `PREC_AND + 1`, where `PREC_AND` is the precedence of `and` (2): what `escalate`, `pause and` and a verifier's expressions
/// are written at, so that an `or` inside them has parentheses.
const ABOVE_AND: i32 = 3;
/// The precedence of the postfix forms and of every form that is a single
/// token or closed by brackets.
const POSTFIX: i32 = 9;

/// `PREC[bop]`.
fn prec_of_bop(bop: &str) -> Option<i32> {
    match bop {
        "or" => Some(1),
        "and" => Some(2),
        "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "subseteq" => Some(4),
        "+" | "-" => Some(6),
        "*" | "/" => Some(7),
        _ => None,
    }
}

/// `precOf(e)`: `None` for a binary operator that is not one of the IR's,
/// which [`expr_inner`] refuses before this is asked.
fn prec_of(e: &Value) -> Option<i32> {
    match ExprOp::from_value(member(e, "op")) {
        Some(ExprOp::Binary) => member(e, "bop").as_str().and_then(prec_of_bop),
        Some(ExprOp::Range) => Some(5),
        Some(ExprOp::Unary) => Some(if member(e, "uop").as_str() == Some("not") {
            3
        } else {
            8
        }),
        Some(
            ExprOp::Delegate
            | ExprOp::Verify
            | ExprOp::Infer
            | ExprOp::Effect
            | ExprOp::Changeset
            | ExprOp::Map
            | ExprOp::Plan
            | ExprOp::Switch
            | ExprOp::Escalate
            | ExprOp::Pause
            | ExprOp::Spawn
            | ExprOp::Await
            | ExprOp::Block,
        ) => Some(0),
        _ => Some(POSTFIX),
    }
}

/// `noStruct(e, ind)`: the expression, in parentheses when a record literal
/// is anywhere inside it, since `{` after it would be read as a block.
fn no_struct(e: &Value, ind: &str) -> Printed {
    let s = expr(e, 0, ind)?;
    if contains_record(e) {
        Ok(format!("({s})"))
    } else {
        Ok(s)
    }
}

/// `containsRecord(e)`: whether `e`, or anything it holds, is an object with
/// `op === "record"`. It looks at every member of every object and every
/// element of every list, not only at expressions.
fn contains_record(e: &Value) -> bool {
    match e {
        Value::Object(map) => {
            map.get("op").and_then(Value::as_str) == Some("record")
                || map.iter().any(|(_, v)| contains_record(v))
        }
        Value::Array(xs) => xs.iter().any(contains_record),
        _ => false,
    }
}

/// `expr(e, minPrec, ind)`: the expression, in parentheses when it binds
/// less tightly than `min_prec`.
fn expr(e: &Value, min_prec: i32, ind: &str) -> Printed {
    let s = expr_inner(e, ind)?;
    match prec_of(e) {
        Some(p) if p < min_prec => Ok(format!("({s})")),
        _ => Ok(s),
    }
}

/// `exprInner(e, ind)`.
fn expr_inner(e: &Value, ind: &str) -> Printed {
    let Some(op) = ExprOp::from_value(member(e, "op")) else {
        return Err("an expression with no op the IR knows".to_owned());
    };
    match op {
        // `String(e.value)`, `e.value` and `String(e.value)`
        ExprOp::Int | ExprOp::Dec | ExprOp::Bool => Ok(show(e, "value")),
        ExprOp::Var => Ok(show(e, "name")),
        ExprOp::Text => quoted(member(e, "value")),
        ExprOp::Money => Ok(money(member(e, "micros"), member(e, "currency"))),
        ExprOp::Duration => Ok(duration(member(e, "ms"))),
        ExprOp::List => {
            let mut parts: Vec<String> = Vec::new();
            for i in items(e, "items") {
                parts.push(expr(i, 0, ind)?);
            }
            Ok(format!("[{}]", parts.join(", ")))
        }
        ExprOp::Set => {
            // `e.items.length`
            if !items(e, "items").is_empty() {
                return Err("Only the empty set literal has a text form.".to_owned());
            }
            Ok("{}".to_owned())
        }
        ExprOp::Template => quote_parts(items(e, "parts"), false, ind),
        ExprOp::Prompt => Ok(format!(
            "prompt{}",
            quote_parts(items(e, "parts"), true, ind)?
        )),
        ExprOp::Field => Ok(format!(
            "{}.{}",
            expr(member(e, "of"), POSTFIX, ind)?,
            show(e, "name")
        )),
        ExprOp::Call => Ok(format!(
            "{}({})",
            expr(member(e, "callee"), POSTFIX, ind)?,
            args(items(e, "args"), ind)?
        )),
        ExprOp::Try => Ok(format!("{}?", expr(member(e, "of"), POSTFIX, ind)?)),
        ExprOp::Unary => {
            if member(e, "uop").as_str() == Some("not") {
                Ok(format!("not {}", expr(member(e, "of"), 3, ind)?))
            } else {
                Ok(format!("-{}", expr(member(e, "of"), 8, ind)?))
            }
        }
        ExprOp::Binary => binary(e, ind),
        ExprOp::Range => Ok(format!(
            "{}..{}",
            expr(member(e, "from"), 5, ind)?,
            expr(member(e, "to"), 6, ind)?
        )),
        ExprOp::Record => record(e, ind),
        ExprOp::Infer => {
            let mut s = format!(
                "infer {} from {}",
                type_(member(e, "type"))?,
                no_struct(member(e, "from"), ind)?
            );
            if truthy(member(e, "using")) {
                s.push_str(&format!(" using {}", expr(member(e, "using"), 0, ind)?));
            }
            Ok(s)
        }
        ExprOp::Delegate => delegate(e, ind),
        ExprOp::Spawn => Ok(format!(
            "spawn {}.{}({})",
            show(e, "agent"),
            show(e, "skill"),
            args(items(e, "args"), ind)?
        )),
        ExprOp::Await => Ok(format!("await {}", expr(member(e, "of"), 8, ind)?)),
        ExprOp::Verify => verify(e, ind),
        ExprOp::Effect => effect(e, ind),
        ExprOp::Changeset => changeset(e, ind),
        ExprOp::Map => map(e, ind),
        ExprOp::Plan => {
            let bound = if truthy(member(e, "budget")) {
                format!(" {}", budget(member(e, "budget"))?)
            } else {
                String::new()
            };
            Ok(format!(
                "plan {}.{}({}){bound} within envelope",
                show(e, "agent"),
                show(e, "skill"),
                args(items(e, "args"), ind)?
            ))
        }
        ExprOp::Escalate => Ok(format!(
            "escalate {}",
            expr(member(e, "to"), ABOVE_AND, ind)?
        )),
        ExprOp::Pause => {
            if truthy(member(e, "then")) {
                Ok(format!(
                    "pause and {}",
                    expr(member(e, "then"), ABOVE_AND, ind)?
                ))
            } else {
                Ok("pause".to_owned())
            }
        }
        ExprOp::Switch => switch(e, ind),
        ExprOp::Block => block_trimmed(items(e, "body"), ind),
    }
}

/// `case "binary"` of `exprInner`.
///
/// A defect of the reference, kept: the left operand is written without
/// parentheses when it binds as tightly as the operator, so a comparison
/// that is itself the left operand of a comparison (`(a < b) < c`) is
/// printed `a < b < c`, which the parser does not read as the IR was.
fn binary(e: &Value, ind: &str) -> Printed {
    let bop = member(e, "bop").as_str().unwrap_or_default();
    let Some(p) = prec_of_bop(bop) else {
        return Err(format!(
            "an expression with no binary operator the IR knows: {bop:?}"
        ));
    };
    let op = if bop == "subseteq" { "⊆" } else { bop };
    Ok(format!(
        "{} {op} {}",
        expr(member(e, "left"), p, ind)?,
        expr(member(e, "right"), p.saturating_add(1), ind)?
    ))
}

/// `case "record"` of `exprInner`.
fn record(e: &Value, ind: &str) -> Printed {
    let mut fs: Vec<String> = Vec::new();
    for (k, v) in entries(e, "fields") {
        // `v.op === "var" && v.name === k`: the field is written by its name alone.
        if member(v, "op").as_str() == Some("var") && member(v, "name").as_str() == Some(k) {
            fs.push(k.to_owned());
        } else {
            fs.push(format!("{k}: {}", expr(v, 0, ind)?));
        }
    }
    // An empty record is `T {  }`, with two spaces.
    Ok(format!("{} {{ {} }}", show(e, "type"), fs.join(", ")))
}

/// `case "delegate"` of `exprInner`.
fn delegate(e: &Value, ind: &str) -> Printed {
    let mut s = format!(
        "delegate {}.{}({})",
        show(e, "agent"),
        show(e, "skill"),
        args(items(e, "args"), ind)?
    );
    if truthy(member(e, "caps")) {
        s.push_str(&format!(
            " with caps {}",
            no_struct_all(items(e, "caps"), ind)?
        ));
    }
    if truthy(member(e, "budget")) {
        s.push_str(&format!(" {}", budget(member(e, "budget"))?));
    }
    if truthy(member(e, "isolated")) {
        s.push_str(" isolated");
    }
    if truthy(member(e, "timeout")) {
        s.push_str(&format!(" timeout {}", expr(member(e, "timeout"), 8, ind)?));
    }
    if truthy(member(e, "supervise")) {
        s.push_str(&format!(
            " supervise {}",
            call_spec(member(e, "supervise"))?
        ));
    }
    Ok(s)
}

/// `case "verify"` of `exprInner`.
fn verify(e: &Value, ind: &str) -> Printed {
    let mut s = format!(
        "verify {} against {}({})",
        expr(member(e, "value"), 1, ind)?,
        show(e, "contract"),
        args(items(e, "args"), ind)?
    );
    let on_unmet = member(e, "on_unmet");
    if truthy(on_unmet) {
        s.push_str(&format!(
            "\n{ind}  on unmet({}) => {}",
            show(on_unmet, "bind"),
            expr(member(on_unmet, "then"), 0, &format!("{ind}  "))?
        ));
    }
    Ok(s)
}

/// `case "effect"` of `exprInner`.
fn effect(e: &Value, ind: &str) -> Printed {
    let mut s = format!(
        "effect {}({})",
        show(e, "name"),
        args(items(e, "args"), ind)?
    );
    if truthy(member(e, "idempotent_by")) {
        s.push_str(&format!(
            "\n{ind}  idempotent_by {}",
            expr(member(e, "idempotent_by"), 0, &format!("{ind}  "))?
        ));
    }
    if truthy(member(e, "compensate")) {
        s.push_str(&format!("\n{ind}  compensate    {}", show(e, "compensate")));
    }
    Ok(s)
}

/// `case "changeset"` of `exprInner`.
fn changeset(e: &Value, ind: &str) -> Printed {
    let mut lines = vec![format!(
        "changeset({}) {{",
        expr(member(e, "plan"), 0, ind)?
    )];
    let inner = format!("{ind}  ");
    for (m, x) in entries(e, "members") {
        let approver = if truthy(member(x, "approver")) {
            format!(" approved_by role {}", quoted(member(x, "approver"))?)
        } else {
            String::new()
        };
        lines.push(format!(
            "{inner}member {m} = {}({}){approver}",
            show(x, "effect"),
            args(items(x, "args"), &inner)?
        ));
    }
    lines.push(format!("{inner}order {}", join(items(e, "order"), ", ")));
    for (i, k) in entries(e, "changes") {
        lines.push(format!("{inner}change {i} {}", js_string(Some(k))));
    }
    lines.push(format!(
        "{inner}approve role {}",
        quoted(member(e, "approver"))?
    ));
    let idempotent_by = if truthy(member(e, "idempotent_by")) {
        format!(
            " idempotent_by {}",
            expr(member(e, "idempotent_by"), 0, ind)?
        )
    } else {
        String::new()
    };
    lines.push(format!("{ind}}}{idempotent_by}"));
    Ok(lines.join("\n"))
}

/// `case "map"` of `exprInner`.
fn map(e: &Value, ind: &str) -> Printed {
    let mut s = format!(
        "map {} in {}",
        show(e, "bind"),
        no_struct(member(e, "over"), ind)?
    );
    if e.get("max").is_some() {
        s.push_str(&format!(" max {}", show(e, "max")));
    }
    if e.get("par").is_some() {
        s.push_str(&format!(" par {}", show(e, "par")));
    }
    if truthy(member(e, "caps")) {
        s.push_str(&format!(
            " with caps {}",
            no_struct_all(items(e, "caps"), ind)?
        ));
    }
    if truthy(member(e, "budget")) {
        s.push_str(&format!(" {}", budget(member(e, "budget"))?));
    }
    if truthy(member(e, "supervise")) {
        s.push_str(&format!(
            " supervise {}",
            call_spec(member(e, "supervise"))?
        ));
    }
    Ok(format!("{s} {}", block_trimmed(items(e, "body"), ind)?))
}

/// `case "switch"` of `exprInner`.
fn switch(e: &Value, ind: &str) -> Printed {
    let mut lines = vec![format!("switch {} {{", no_struct(member(e, "on"), ind)?)];
    let inner = format!("{ind}  ");
    for c in items(e, "cases") {
        let then = member(c, "then");
        let printed = if member(then, "op").as_str() == Some("block") {
            block_trimmed(items(then, "body"), &inner)?
        } else {
            expr(then, 0, &inner)?
        };
        lines.push(format!(
            "{inner}{} => {printed}",
            pattern(member(c, "pattern"))
        ));
    }
    lines.push(format!("{ind}}}"));
    Ok(lines.join("\n"))
}

/// `args(as, ind)`.
fn args(a: &[Value], ind: &str) -> Printed {
    let mut printed: Vec<String> = Vec::new();
    for x in a {
        let name = match x.get("name") {
            Some(n) => format!("{}: ", js_string(Some(n))),
            None => String::new(),
        };
        printed.push(format!("{name}{}", expr(member(x, "value"), 0, ind)?));
    }
    Ok(printed.join(", "))
}

// ── text ─────────────────────────────────────────────────────────────────

/// `escapeText(s, multiline)`: a backslash, a double quote, `{` and `}` get a
/// backslash before them, a tab is `\t` and a carriage return `\r`, and a line
/// feed is `\n` unless the text is in triple quotes. Any other character is
/// written as it is (a control character too).
///
/// The TypeScript does it with these replacements, in this order:
/// `/\\/g` to `\\\\`, `/"/g` to `\"`, `/\{/g` to `\{`, `/\}/g` to `\}`,
/// `/\t/g` to `\t`, `/\r/g` to `\r`, and `/\n/g` to `\n` when not
/// `multiline`. None of them can match what an earlier one wrote (the first
/// is the only one that makes a backslash a match, and it comes first), so
/// each character is replaced by itself on its own, as here.
fn escape_text(s: &str, multiline: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\n' if !multiline => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out
}

/// `quoteText(s)`.
fn quote_text(s: &str) -> String {
    format!("\"{}\"", escape_text(s, false))
}

/// `quoteParts(parts, forceTriple, ind)`: the parts of a template, or of a
/// prompt, which `forceTriple` puts in triple quotes (so does a line feed in
/// any text part).
fn quote_parts(parts: &[Value], force_triple: bool, ind: &str) -> Printed {
    let mut triple = force_triple;
    if !triple {
        for p in parts {
            // `"text" in p && p.text.includes("\n")`
            if p.get("text").is_some() && text(member(p, "text"))?.contains('\n') {
                triple = true;
                break;
            }
        }
    }
    let mut body = String::new();
    for p in parts {
        if p.get("text").is_some() {
            body.push_str(&escape_text(text(member(p, "text"))?, triple));
        } else {
            let inner = expr(member(p, "expr"), 0, ind)?;
            if inner.contains('"') {
                return Err("String literals cannot appear inside an interpolation.".to_owned());
            }
            body.push('{');
            body.push_str(&inner);
            body.push('}');
        }
    }
    if triple {
        Ok(format!("\"\"\"{body}\"\"\""))
    } else {
        Ok(format!("\"{body}\""))
    }
}
