//! Imported modules (Doc 4 §4.1, §19; design doc 9 §2.1): a port of
//! `compiler/src/modules.ts`.
//!
//! Linking does not change the program or its hash. It builds the table of
//! definitions the program can see: its own, the ones it imports by name,
//! and what those refer to inside their module (a component's interfaces, a
//! read's row type). A module the caller has not loaded stays opaque: its
//! names resolve and their types are unknown.
//!
//! The tables are JavaScript objects in the TypeScript, so they are
//! [`Map`]s here: [`Modules`] keeps the order modules were added in, and
//! [`Linked::defs`] the program's definitions first, then the imported ones
//! in the order they were linked. One property of a plain object is
//! imitated by hand, and said where: assigning a member named `__proto__`
//! sets the object's prototype and adds no member.

use mandate_ir::{
    ConnectorDef, DefKind, Definition, Diagnostic, Import, JsObject, Location, Map, Program, Value,
    ptr, sort_utf16,
};

/// Loaded modules by name: `Modules`, `Record<string, Program>`. Each value
/// is a program's IR.
pub type Modules = Map;

/// What [`link`] gives: `Linked`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Linked {
    /// Every definition visible to the checks: local, imported, and what
    /// imports refer to.
    pub defs: Map,
    /// The module an imported definition comes from, by definition, in the
    /// order they were linked (the order of `Object.keys(origin)`).
    pub origin: Vec<(String, String)>,
    /// E0120 for a name a loaded module does not define, E0121 for an
    /// imported definition whose name is taken.
    pub diagnostics: Vec<Diagnostic>,
}

impl Linked {
    /// `origin[name]` for an imported definition.
    #[must_use]
    pub fn origin_of(&self, name: &str) -> Option<&str> {
        self.origin
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, m)| m.as_str())
    }
}

/// `String(o[name])` for a member `name` that a plain `{}` has from
/// `Object.prototype` and not of its own (in Node), or `None`.
///
/// `link` reads `origin[dep]` without `Object.hasOwn`, so an imported
/// definition named `toString` that collides with a local one is said to
/// collide with "module function toString() { [native code] }". The port
/// does not fix that.
pub(crate) fn object_prototype_text(name: &str) -> Option<String> {
    const FUNCTIONS: [&str; 10] = [
        "__defineGetter__",
        "__defineSetter__",
        "hasOwnProperty",
        "__lookupGetter__",
        "__lookupSetter__",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toString",
        "valueOf",
        "toLocaleString",
    ];
    match name {
        "__proto__" => Some("[object Object]".to_owned()),
        "constructor" => Some("function Object() { [native code] }".to_owned()),
        _ => FUNCTIONS
            .contains(&name)
            .then(|| format!("function {name}() {{ [native code] }}")),
    }
}

/// The definitions `program` sees with `modules` loaded: `link(program,
/// modules)`. An import of a module that is not loaded, or one without
/// `names`, adds nothing.
#[must_use]
pub fn link(program: Program<'_>, modules: Option<&Modules>) -> Linked {
    // `{ ...program.defs }`.
    let mut defs = program.defs().cloned().unwrap_or_default();
    let mut origin: Vec<(String, String)> = Vec::new();
    let mut diagnostics = Vec::new();
    let origin_of = |origin: &[(String, String)], name: &str| -> Option<String> {
        origin
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, m)| m.clone())
    };
    for (i, u) in program.use_values().iter().enumerate() {
        let Some(u) = Import::of(u) else { continue };
        let Some(module) = u.module() else { continue };
        // `Object.hasOwn(modules, u.module) ? modules[u.module] : undefined`.
        let m = modules.and_then(|ms| ms.get(module));
        let (Some(m), Some(names)) = (m, u.names_given()) else {
            continue;
        };
        let m_defs = m.get("defs").and_then(Value::as_object);
        for name in names.iter().filter_map(Value::as_str) {
            if !m_defs.is_some_and(|d| d.contains_key(name)) {
                diagnostics.push(Diagnostic::new(
                    "E0120",
                    format!("Module {module} has no definition '{name}'."),
                    Location::path(ptr(&[&"uses", &i, &"names"])),
                    Some(
                        JsObject::new()
                            .with("name", name)
                            .with("module", module)
                            .with("expected", "definition"),
                    ),
                ));
                continue;
            }
            let Some(m_defs) = m_defs else { continue };
            for dep in closure(m_defs, name) {
                let from = origin_of(&origin, &dep);
                if from.as_deref() == Some(module) {
                    continue;
                }
                if defs.contains_key(&dep) {
                    // `origin[dep] ? `module ${origin[dep]}` : "a definition of this module"`,
                    // where `origin[dep]` also finds what `Object.prototype` has.
                    let where_ = match from.or_else(|| object_prototype_text(&dep)) {
                        Some(o) => format!("module {o}"),
                        None => "a definition of this module".to_owned(),
                    };
                    diagnostics.push(Diagnostic::new(
                        "E0121",
                        format!("'{dep}' from {module} collides with {where_}."),
                        Location::path(ptr(&[&"uses", &i])),
                        Some(
                            JsObject::new()
                                .with("name", dep.as_str())
                                .with("module", module),
                        ),
                    ));
                    continue;
                }
                // `defs[dep] = …` and `origin[dep] = …` on plain objects: for
                // `__proto__` the first sets the prototype and the second does
                // nothing, so neither table gains a member.
                if dep == "__proto__" {
                    continue;
                }
                if let Some(d) = m_defs.get(&dep) {
                    defs.insert(dep.clone(), with_module(d.clone(), module));
                }
                origin.push((dep, module.to_owned()));
            }
        }
    }
    // 0.6: a connector is named by its module and its name, so each one in
    // the table says its module, the program's own ones too.
    if let Some(own) = program.module() {
        let names: Vec<&str> = program
            .defs()
            .map(|d| d.keys().collect())
            .unwrap_or_default();
        mark_own_connectors(&mut defs, &names, own);
    }
    if let Some(modules) = modules {
        mark_unbound(&mut defs, program, &origin, modules);
    }
    Linked {
        defs,
        origin,
        diagnostics,
    }
}

/// The type names a value of a tool's signature refers to (`ref`), each
/// once, in the order found, the built-in types left out.
fn type_names(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => items.iter().for_each(|x| type_names(x, out)),
        Value::Object(o) => {
            if let Some(r) = o.get("ref").and_then(Value::as_str)
                && !crate::resolve::BUILTIN_TYPES.contains(&r)
                && !crate::resolve::BUILTIN_TYPES_0_4.contains(&r)
                && !out.iter().any(|n| n == r)
            {
                out.push(r.to_owned());
            }
            o.iter().for_each(|(_, x)| type_names(x, out));
        }
        _ => {}
    }
}

/// 0.6: for each connector linked from a module, the type names of each of
/// its tools' signatures that the program does not have as the very
/// definition that module means by them, written into the linked connector
/// as `unbound`, `{ <tool>: { <name>: <the module that defines it there> } }`
/// (an empty module when that module has no such name). That module means by
/// a name its own definition, or the definition a `use` of it lists; the
/// program has it when its own definition or a linked one of that name comes
/// from the same module. A use of such a tool refuses the name (E0120,
/// `crate::statics`): a program calls a tool only with the types it means.
/// Only a table of linked definitions holds `unbound`; the schema refuses it
/// in a program.
fn mark_unbound(
    defs: &mut Map,
    program: Program<'_>,
    origin: &[(String, String)],
    modules: &Modules,
) {
    let own = program.module().unwrap_or_default();
    let mine = program.defs();
    let has = |name: &str| -> Option<String> {
        if mine.is_some_and(|d| d.contains_key(name)) {
            return Some(own.to_owned());
        }
        origin
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, m)| m.clone())
    };
    let mut marks: Vec<(String, Map)> = Vec::new();
    for (name, d) in defs.iter() {
        let Some(c) = ConnectorDef::of(d) else {
            continue;
        };
        if mine.is_some_and(|m| m.contains_key(name)) {
            continue;
        }
        let Some(module) = origin
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, m)| m.as_str())
        else {
            continue;
        };
        let Some(m) = modules.get(module).and_then(Program::of) else {
            continue;
        };
        let means = |n: &str| -> String {
            if m.defs().is_some_and(|d| d.contains_key(n)) {
                return module.to_owned();
            }
            m.imports()
                .find(|u| u.names().any(|x| x == n))
                .and_then(|u| u.module())
                .unwrap_or_default()
                .to_owned()
        };
        let mut unbound = Map::new();
        for (tool, t) in c.tools() {
            let mut names = Vec::new();
            type_names(&Value::Object(t.members().clone()), &mut names);
            let mut missing = Map::new();
            for n in names {
                let meant = means(&n);
                if meant.is_empty() || has(&n).as_deref() != Some(meant.as_str()) {
                    missing.insert(n, meant);
                }
            }
            if !missing.is_empty() {
                unbound.insert(tool, Value::Object(missing));
            }
        }
        marks.push((name.to_owned(), unbound));
    }
    for (name, unbound) in marks {
        if let Some(Value::Object(d)) = defs.get_mut(&name) {
            d.remove("unbound");
            if !unbound.is_empty() {
                d.insert("unbound", Value::Object(unbound));
            }
        }
    }
}

/// `d` with `module` set to `module` when it is a connector (0.6), which is
/// named by its module and its name (spec/library.md "tool.call"); any
/// other definition as it is. Only a table of linked definitions holds a
/// connector so: its IR has no `module` (the schema refuses one), so a
/// program cannot write it.
#[must_use]
pub fn with_module(d: Value, module: &str) -> Value {
    match d {
        Value::Object(mut m)
            if m.get("kind").and_then(DefKind::from_value) == Some(DefKind::Connector) =>
        {
            m.insert("module", module);
            Value::Object(m)
        }
        other => other,
    }
}

/// Every connector of `defs` that says no module, marked as one of
/// `module` ([`with_module`]): the program's own, in a table of linked
/// definitions. [`mark_own_connectors`] marks the program's own whatever
/// they say.
pub fn mark_connectors(defs: &mut Map, module: &str) {
    let unmarked: Vec<String> = defs
        .iter()
        .filter(|(_, d)| ConnectorDef::of(d).is_some_and(|c| c.module().is_none()))
        .map(|(n, _)| n.to_owned())
        .collect();
    mark_named(defs, &unmarked, module);
}

/// The connectors of `defs` named in `own`, the program's own definitions,
/// marked as of the program's `module`, whatever `module` they say: a value
/// that was not read by the schema (which refuses `module` in a connector)
/// cannot pass for another module's connector.
pub fn mark_own_connectors<S: AsRef<str>>(defs: &mut Map, own: &[S], module: &str) {
    let named: Vec<String> = own
        .iter()
        .map(AsRef::as_ref)
        .filter(|n| defs.get(n).is_some_and(|d| ConnectorDef::of(d).is_some()))
        .map(str::to_owned)
        .collect();
    mark_named(defs, &named, module);
}

fn mark_named(defs: &mut Map, unmarked: &[String], module: &str) {
    for name in unmarked {
        if let Some(d) = defs.get_mut(name)
            && let Value::Object(m) = d
        {
            m.insert("module", module);
        }
    }
}

/// A program whose definitions are the linked ones, for checks, views and
/// the interpreter, never for hashing: `linkedProgram(program, modules)`,
/// `{ ...program, defs: link(program, modules).defs }`.
#[must_use]
pub fn linked_program(program: Program<'_>, modules: Option<&Modules>) -> Value {
    let defs = link(program, modules).defs;
    let mut out = program.members().clone();
    out.insert("defs", defs);
    Value::Object(out)
}

/// `name` and every definition of the module whose definitions are `defs`
/// that it refers to, transitively, sorted (by UTF-16 code units):
/// `closure(m, name)`. An interface comes with its provider: who answers for
/// a change to it (doc 9 §2.1, §3.3).
fn closure(defs: &Map, name: &str) -> Vec<String> {
    // The TypeScript visits depth first; the set it builds does not depend
    // on the order, and it is sorted.
    let mut out: Vec<String> = Vec::new();
    let mut todo: Vec<String> = vec![name.to_owned()];
    while let Some(n) = todo.pop() {
        if out.contains(&n) {
            continue;
        }
        let Some(d) = defs.get(&n) else { continue };
        out.push(n.clone());
        todo.extend(references(d));
        if Definition::of(d).kind() == Some(DefKind::Interface) {
            for (c, cd) in defs.iter() {
                let def = Definition::of(cd);
                let provides = def
                    .provides()
                    .is_some_and(|p| p.iter().any(|x| x.as_str() == Some(n.as_str())));
                if def.kind() == Some(DefKind::Component) && provides {
                    todo.push(c.to_owned());
                }
            }
        }
    }
    sort_utf16(&mut out);
    out
}

/// The names a definition refers to: types, variables, agents, contracts,
/// effects, interfaces and components, each once, in the order they are
/// found (`references(d)`, a `Set`).
#[must_use]
pub fn references(d: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    walk_references(d, &mut out);
    out
}

fn add(out: &mut Vec<String>, name: &str) {
    if !out.iter().any(|n| n == name) {
        out.push(name.to_owned());
    }
}

fn walk_references(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => {
            for x in items {
                walk_references(x, out);
            }
        }
        Value::Object(o) => {
            let string = |k: &str| o.get(k).and_then(Value::as_str);
            if let Some(r) = string("ref") {
                add(out, r);
            }
            let op = string("op");
            if op == Some("var")
                && let Some(n) = string("name")
            {
                add(out, n);
            }
            if op == Some("effect")
                && let Some(n) = string("name")
            {
                add(out, n);
            }
            for k in [
                "agent",
                "contract",
                "effect",
                "compensate",
                "compensation",
                "from",
            ] {
                if let Some(n) = string(k) {
                    add(out, n);
                }
            }
            for k in ["provides", "consumes"] {
                if let Some(items) = o.get(k).and_then(Value::as_array) {
                    for x in items.iter().filter_map(Value::as_str) {
                        add(out, x);
                    }
                }
            }
            for (_, x) in o.iter() {
                walk_references(x, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::object_prototype_text;

    /// What `String(({})[name])` gives in Node for every own property of
    /// `Object.prototype` (`Object.getOwnPropertyNames`), and for a name it
    /// does not have.
    #[test]
    fn what_a_plain_object_finds_on_its_prototype() {
        let node = [
            ("constructor", "function Object() { [native code] }"),
            (
                "__defineGetter__",
                "function __defineGetter__() { [native code] }",
            ),
            (
                "__defineSetter__",
                "function __defineSetter__() { [native code] }",
            ),
            (
                "hasOwnProperty",
                "function hasOwnProperty() { [native code] }",
            ),
            (
                "__lookupGetter__",
                "function __lookupGetter__() { [native code] }",
            ),
            (
                "__lookupSetter__",
                "function __lookupSetter__() { [native code] }",
            ),
            (
                "isPrototypeOf",
                "function isPrototypeOf() { [native code] }",
            ),
            (
                "propertyIsEnumerable",
                "function propertyIsEnumerable() { [native code] }",
            ),
            ("toString", "function toString() { [native code] }"),
            ("valueOf", "function valueOf() { [native code] }"),
            ("__proto__", "[object Object]"),
            (
                "toLocaleString",
                "function toLocaleString() { [native code] }",
            ),
        ];
        for (name, text) in node {
            assert_eq!(object_prototype_text(name).as_deref(), Some(text), "{name}");
        }
        assert_eq!(object_prototype_text("nope"), None);
        assert_eq!(object_prototype_text("tostring"), None);
    }
}
