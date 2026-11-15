//! What a pattern's definition is held to on its own (spec/library.md
//! "What a pattern may not do"): E1301 (it is well formed), E1302 (it brings
//! no authority) and E1306 (no name of it means two things), and E1307 for
//! an application inside its body. Its body is type-checked only through
//! its applications, since a slot has no value until then.
//!
//! A name in a pattern means what it means in the pattern's module, its
//! *home*: a slot, a type parameter, a run parameter or a local name of the
//! body, else a definition the module defines or imports, else a built-in.
//! E1302 follows every road by which a pattern could reach authority that
//! its applying program did not name: a definition of a capability, an
//! agent, a connector, a role, an effect, a workflow or an `extern`, named
//! by the body, the signature, or a function, constant, type or contract of
//! the home that the pattern names (transitively); a capability constructor
//! in a capability's place, or one that is no function of the standard
//! library anywhere; an effect run with `effect`; a role written as text
//! where a person is asked; and `caps`, a `budget` or an `envelope`
//! declared by the pattern itself.

use std::collections::HashSet;
use std::rc::Rc;

use mandate_ir::{DefKind, Definition, JsObject, Map, PatternDef, Program, Value};

use super::walk::{Named, Place, Scope, Walk};
use crate::resolve::{BUILTIN_FUNCTIONS, BUILTIN_TYPES, BUILTIN_TYPES_0_4};
use crate::stdlib::{CAP_CTORS, CAP_CTORS_0_6, std_fn};

/// The slot kinds of spec/library.md "Slots".
pub(crate) const SLOT_KINDS: [&str; 9] = [
    "type",
    "skill",
    "tool",
    "effect",
    "contract",
    "role",
    "capability",
    "const",
    "field",
];

/// The built-in types of a 0.6 program, those of every earlier version
/// included.
pub(crate) fn builtin_type(name: &str) -> bool {
    BUILTIN_TYPES.contains(&name)
        || BUILTIN_TYPES_0_4.contains(&name)
        || crate::resolve::BUILTIN_TYPES_0_6.contains(&name)
}

/// `a` or `an` before `word`, as a message writes it.
pub(crate) fn article(word: &str) -> &'static str {
    if word.starts_with(['a', 'e', 'i', 'o', 'u']) {
        "an"
    } else {
        "a"
    }
}

/// A problem a check found, at a path inside the definition it checks
/// (`""` for the definition itself).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Problem {
    /// The code, `E1301` and so on.
    pub(crate) code: &'static str,
    /// The message.
    pub(crate) message: String,
    /// The path inside the definition.
    pub(crate) at: String,
    /// The facts.
    pub(crate) facts: JsObject,
}

impl Problem {
    pub(crate) fn new(code: &'static str, message: String, at: &str, facts: JsObject) -> Problem {
        Problem {
            code,
            message,
            at: at.to_owned(),
            facts,
        }
    }
}

/// What a name of a pattern's home is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Meaning<'a> {
    /// A definition of the home.
    Own(&'a Value),
    /// A name a `use` of the home lists from `module`; its definition when
    /// the module is given.
    Imported(Option<&'a Value>, &'a str),
    /// A module of the standard library the home imports (`human`, `fs`).
    StdModule,
    /// A built-in type.
    BuiltinType,
    /// A built-in function.
    BuiltinFn,
    /// Nothing the home knows.
    Unknown,
}

impl<'a> Meaning<'a> {
    /// The definition's kind, when it is a definition the check can see.
    pub(crate) fn kind(self) -> Option<DefKind> {
        match self {
            Meaning::Own(d) | Meaning::Imported(Some(d), _) => Definition::of(d).kind(),
            _ => None,
        }
    }

    /// The definition, when the check can see it.
    pub(crate) fn def(self) -> Option<&'a Value> {
        match self {
            Meaning::Own(d) | Meaning::Imported(Some(d), _) => Some(d),
            _ => None,
        }
    }
}

/// A pattern, where it is defined: its home program (the applying program
/// itself for a local pattern, else the module that defines it) and the
/// home's linked definitions.
pub(crate) struct Site<'a> {
    /// The pattern's name.
    pub(crate) name: &'a str,
    /// Its definition.
    pub(crate) value: &'a Value,
    /// Its home.
    pub(crate) home: Program<'a>,
    /// The home's definitions with its imports linked.
    pub(crate) linked: &'a Map,
}

impl<'a> Site<'a> {
    /// The pattern's view.
    pub(crate) fn def(&self) -> Option<PatternDef<'a>> {
        PatternDef::of(self.value)
    }

    /// `/defs/<name>`, its path in its home.
    pub(crate) fn base(&self) -> String {
        mandate_ir::ptr(&[&"defs", &self.name])
    }

    /// What `name` means in the home.
    pub(crate) fn meaning(&self, name: &str) -> Meaning<'a> {
        if let Some(d) = self.home.defs().and_then(|d| d.get(name)) {
            return Meaning::Own(d);
        }
        for u in self.home.imports() {
            let module = u.module().unwrap_or_default();
            if u.names().any(|n| n == name) {
                if module == "std" {
                    return Meaning::StdModule;
                }
                return Meaning::Imported(self.linked.get(name), module);
            }
        }
        if builtin_type(name) {
            return Meaning::BuiltinType;
        }
        if BUILTIN_FUNCTIONS.contains(&name) {
            return Meaning::BuiltinFn;
        }
        Meaning::Unknown
    }

    /// The home's own definitions and imported names, by name: what a slot
    /// or a parameter may not be named like (E1306).
    pub(crate) fn home_names(&self) -> Vec<(&'a str, &'static str)> {
        let mut out: Vec<(&'a str, &'static str)> = Vec::new();
        for (n, _) in self.home.definitions() {
            out.push((n, "defines"));
        }
        for u in self.home.imports() {
            for n in u.names() {
                out.push((n, "imports"));
            }
        }
        out
    }
}

/// The kind of the slot `n` of `slots`, as one of [`SLOT_KINDS`] (`""` for
/// a kind that is none of them, which E1301 names); `None` when `n` is no
/// slot.
pub(crate) fn kind_in(slots: &[(&str, &str)], n: &str) -> Option<&'static str> {
    let (_, kind) = slots.iter().find(|(s, _)| *s == n)?;
    Some(
        SLOT_KINDS
            .iter()
            .find(|k| *k == kind)
            .copied()
            .unwrap_or(""),
    )
}

/// The names of the slots of `p`, with their kinds.
pub(crate) fn slots_of(p: PatternDef<'_>) -> Vec<(&str, &str)> {
    p.slots()
        .map(|s| (s.name().unwrap_or_default(), s.kind().unwrap_or_default()))
        .collect()
}

/// The places of a pattern: its signature (the slots' types, the run
/// parameters' types, the result) and its body, with the run parameters
/// and the slots' names as the body's outermost scope.
pub(crate) fn places(p: PatternDef<'_>) -> Vec<Place> {
    let mut w = Walk::new();
    let root = Rc::new(Scope::default());
    for (i, s) in p.slot_values().iter().enumerate() {
        for k in ["params", "returns", "type"] {
            if let Some(x) = s.get(k) {
                w.node(x, &format!("/slots/{i}/{k}"), &root, false);
            }
        }
    }
    let params: Vec<String> = p
        .params()
        .iter()
        .filter_map(|x| x.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    for (i, x) in p.params().iter().enumerate() {
        if let Some(t) = x.get("type") {
            w.node(t, &format!("/params/{i}/type"), &root, false);
        }
    }
    if let Some(r) = p.members().get("returns") {
        w.node(r, "/returns", &root, false);
    }
    let scope = Scope::child(&root, params);
    if let Some(body) = p.body() {
        w.block(body, "/body", &scope);
    }
    w.out
}

/// The checks of a pattern's definition: E1301, E1302, E1306 and E1307,
/// each at a path inside the definition.
pub(crate) fn check_pattern(site: &Site<'_>) -> Vec<Problem> {
    let mut out: Vec<Problem> = Vec::new();
    let Some(p) = site.def() else { return out };
    let name = site.name;
    malformed(name, p, &mut out);
    let slots = slots_of(p);
    let kind_of = |n: &str| kind_in(&slots, n);
    let generics: Vec<&str> = p.generics().iter().filter_map(Value::as_str).collect();
    collisions(site, p, &generics, &mut out);
    let all = places(p);
    for place in &all {
        slot_use(name, place, &kind_of, &generics, &mut out);
    }
    authority(site, &all, &kind_of, &generics, &mut out);
    for key in ["caps", "budget", "envelope"] {
        if p.members().get(key).is_some() {
            out.push(Problem::new(
                "E1302",
                format!(
                    "Pattern {name} declares {}: a pattern grants itself nothing; the workflow that applies it holds the caps and the budget (spec/library.md \"What a pattern may not do\").",
                    if key == "caps" { "caps".to_owned() } else { format!("a {key}") }
                ),
                &format!("/{key}"),
                JsObject::new()
                    .with("pattern", name)
                    .with("declares", key),
            ));
        }
    }
    out
}

/// E1301 of the declaration: the kinds, the names given twice, the
/// signatures, the body.
fn malformed(name: &str, p: PatternDef<'_>, out: &mut Vec<Problem>) {
    let mut seen: Vec<&str> = Vec::new();
    for (i, g) in p.generics().iter().enumerate() {
        let Some(g) = g.as_str() else { continue };
        if seen.contains(&g) {
            out.push(Problem::new(
                "E1301",
                format!("Pattern {name} names the type parameter {g} twice."),
                &format!("/generics/{i}"),
                JsObject::new()
                    .with("pattern", name)
                    .with("problem", "type_parameter_twice")
                    .with("name", g),
            ));
        }
        seen.push(g);
    }
    let mut names: Vec<&str> = Vec::new();
    for (i, s) in p.slots().enumerate() {
        let sname = s.name().unwrap_or_default();
        let kind = s.kind().unwrap_or_default();
        let at = format!("/slots/{i}");
        if names.contains(&sname) {
            out.push(Problem::new(
                "E1301",
                format!("Pattern {name} has two slots named {sname}."),
                &format!("{at}/name"),
                JsObject::new()
                    .with("pattern", name)
                    .with("problem", "slot_twice")
                    .with("slot", sname),
            ));
        }
        names.push(sname);
        if !SLOT_KINDS.contains(&kind) {
            out.push(Problem::new(
                "E1301",
                format!(
                    "Slot {sname} of pattern {name} is of the kind '{kind}', which no slot is; a slot is one of {}.",
                    SLOT_KINDS.join(", ")
                ),
                &format!("{at}/kind"),
                JsObject::new()
                    .with("pattern", name)
                    .with("problem", "unknown_kind")
                    .with("slot", sname)
                    .with("kind", kind),
            ));
            continue;
        }
        let m = s.members();
        let has = |k: &str| m.get(k).is_some();
        // What each kind takes: its signature, and nothing else.
        let (wants, takes): (&[&str], &[&str]) = match kind {
            "skill" => (&["params", "returns"], &["params", "returns", "read_only"]),
            "tool" | "effect" => (&["params", "returns"], &["params", "returns"]),
            "contract" => (&["params"], &["params"]),
            "const" | "field" => (&["type"], &["type"]),
            _ => (&[], &[]),
        };
        let missing: Vec<&str> = wants.iter().copied().filter(|k| !has(k)).collect();
        let extra: Vec<&str> = ["params", "returns", "type", "read_only"]
            .into_iter()
            .filter(|k| has(k) && !takes.contains(k))
            .collect();
        if !missing.is_empty() || !extra.is_empty() {
            let shape = match kind {
                "skill" => "skill(T, …) -> R [read_only]",
                "tool" => "tool(T, …) -> R",
                "effect" => "effect(T, …) -> R",
                "contract" => "contract(T, …)",
                "const" => "const T",
                "field" => "field(T)",
                other => other,
            };
            out.push(Problem::new(
                "E1301",
                format!(
                    "Slot {sname} of pattern {name} is {} {kind} slot, whose signature is written {shape}.",
                    article(kind)
                ),
                &at,
                JsObject::new()
                    .with("pattern", name)
                    .with("problem", "signature")
                    .with("slot", sname)
                    .with("kind", kind)
                    .with(
                        "missing",
                        missing.iter().map(|k| mandate_ir::JsValue::from(*k)).collect::<Vec<_>>(),
                    )
                    .with(
                        "extra",
                        extra.iter().map(|k| mandate_ir::JsValue::from(*k)).collect::<Vec<_>>(),
                    ),
            ));
        }
    }
    if p.body().is_none() {
        out.push(Problem::new(
            "E1301",
            format!("Pattern {name} has no body: a pattern's body is a block, as a workflow's."),
            "",
            JsObject::new()
                .with("pattern", name)
                .with("problem", "body"),
        ));
    }
}

/// E1306: a slot, type parameter or run parameter named like another of
/// them, like a definition of the home or a name it imports, or like a name
/// the body binds.
fn collisions(site: &Site<'_>, p: PatternDef<'_>, generics: &[&str], out: &mut Vec<Problem>) {
    let name = site.name;
    let mut seen: Vec<(String, &'static str)> = Vec::new();
    let home = site.home_names();
    let check = |n: &str,
                 what: &'static str,
                 at: String,
                 out: &mut Vec<Problem>,
                 seen: &mut Vec<(String, &'static str)>| {
        if let Some((_, other)) = seen
            .iter()
            .find(|(s, w)| s == n && !(*w == what && what != "run parameter"))
        {
            out.push(Problem::new(
                "E1306",
                format!("Pattern {name} has a {what} and a {other} named {n}."),
                &at,
                JsObject::new()
                    .with("pattern", name)
                    .with("name", n)
                    .with("problem", "twice")
                    .with(
                        "kinds",
                        vec![
                            mandate_ir::JsValue::from(*other),
                            mandate_ir::JsValue::from(what),
                        ],
                    ),
            ));
        } else if let Some((_, how)) = home.iter().find(|(h, _)| *h == n) {
            out.push(Problem::new(
                "E1306",
                format!(
                    "The {what} {n} of pattern {name} is named like a definition its module {how}; a name of the pattern's module means that definition in its body."
                ),
                &at,
                JsObject::new()
                    .with("pattern", name)
                    .with("name", n)
                    .with("problem", "module_name")
                    .with("module_name", *how),
            ));
        }
        seen.push((n.to_owned(), what));
    };
    for (i, g) in generics.iter().enumerate() {
        check(
            g,
            "type parameter",
            format!("/generics/{i}"),
            out,
            &mut seen,
        );
    }
    for (i, s) in p.slots().enumerate() {
        check(
            s.name().unwrap_or_default(),
            "slot",
            format!("/slots/{i}/name"),
            out,
            &mut seen,
        );
    }
    for (i, x) in p.params().iter().enumerate() {
        let n = x.get("name").and_then(Value::as_str).unwrap_or_default();
        check(
            n,
            "run parameter",
            format!("/params/{i}/name"),
            out,
            &mut seen,
        );
    }
    // A name the body binds, named like one of them: the body's name would
    // hide the slot or the parameter, or an argument would be read as it.
    let mut reported: HashSet<String> = HashSet::new();
    for place in places(p) {
        let Named::Bind(b) = &place.named else {
            continue;
        };
        if let Some((_, what)) = seen.iter().find(|(s, _)| s == b)
            && reported.insert(format!("{b}@{}", place.path))
        {
            out.push(Problem::new(
                "E1306",
                format!(
                    "The body of pattern {name} binds {b}, the name of its {what}: in an expansion the one would be read as the other."
                ),
                &place.path,
                JsObject::new()
                    .with("pattern", name)
                    .with("name", b.as_str())
                    .with("problem", "local")
                    .with("kind", *what),
            ));
        }
    }
}

/// E1301 for a slot used other than its kind allows, and E1307 for an
/// application in the body (a pattern called or read as a value).
fn slot_use(
    name: &str,
    place: &Place,
    kind_of: &dyn Fn(&str) -> Option<&'static str>,
    generics: &[&str],
    out: &mut Vec<Problem>,
) {
    let wrong = |slot: &str, kind: &str, how: &str| {
        Problem::new(
            "E1301",
            format!(
                "Slot {slot} of pattern {name} is {} {kind} slot, which the body cannot use {how}.",
                article(kind)
            ),
            &place.path,
            JsObject::new()
                .with("pattern", name)
                .with("problem", "slot_use")
                .with("slot", slot)
                .with("kind", kind)
                .with("use", how),
        )
    };
    // A slot of a kind that is none is named by E1301 already.
    let kind_of = |n: &str| kind_of(n).filter(|k| !k.is_empty());
    match &place.named {
        Named::Var {
            name: n, called, ..
        } if !place.shadowed => {
            let Some(kind) = kind_of(n) else { return };
            let ok = match kind {
                "tool" => *called,
                "role" | "capability" | "const" => !*called,
                _ => false,
            };
            if !ok {
                let how = if *called { "as a call" } else { "as a value" };
                out.push(wrong(n, kind, how));
            }
        }
        Named::SkillSlot(n) => match kind_of(n) {
            Some("skill") => {}
            Some(kind) => out.push(wrong(n, kind, "as a delegation")),
            None => out.push(Problem::new(
                "E1301",
                format!("delegate {n}(…) in pattern {name} names no skill slot of it."),
                &place.path,
                JsObject::new()
                    .with("pattern", name)
                    .with("problem", "slot_use")
                    .with("slot", n.as_str())
                    .with("use", "as a delegation"),
            )),
        },
        Named::Effect(n) => {
            if let Some(kind) = kind_of(n).filter(|k| *k != "effect") {
                out.push(wrong(n, kind, "as an effect"));
            }
        }
        Named::Contract(n) => {
            if let Some(kind) = kind_of(n).filter(|k| *k != "contract") {
                out.push(wrong(n, kind, "as a contract"));
            }
        }
        Named::Type { name: n, contract } => {
            if generics.contains(&n.as_str()) {
                return;
            }
            match (kind_of(n), contract) {
                (Some("type"), _) | (Some("contract"), true) | (None, _) => {}
                (Some(kind), _) => out.push(wrong(n, kind, "as a type")),
            }
        }
        Named::Record(n) => {
            if let Some(kind) = kind_of(n) {
                out.push(wrong(n, kind, "as a record's type"));
            }
        }
        Named::Count(n) => match kind_of(n) {
            Some("const") => {}
            Some(kind) => out.push(wrong(n, kind, "as a map's max or par")),
            None => out.push(Problem::new(
                "E1301",
                format!("A map in pattern {name} counts by {n}, which is no const slot of it."),
                &place.path,
                JsObject::new()
                    .with("pattern", name)
                    .with("problem", "slot_use")
                    .with("slot", n.as_str())
                    .with("use", "as a map's max or par"),
            )),
        },
        _ => {}
    }
}

/// E1302: what the pattern names that would bring authority, and E1307 for
/// an application in its body.
fn authority(
    site: &Site<'_>,
    all: &[Place],
    kind_of: &dyn Fn(&str) -> Option<&'static str>,
    generics: &[&str],
    out: &mut Vec<Problem>,
) {
    let name = site.name;
    let brings = |what: &str, n: &str, path: &str, via: Option<&str>| {
        let through = via.map(|v| format!(" (through {v})")).unwrap_or_default();
        Problem::new(
            "E1302",
            format!(
                "Pattern {name} names the {what} {n}{through} other than through a slot: a pattern brings no authority; give it a slot, and the applying program names the {what} (spec/library.md \"What a pattern may not do\")."
            ),
            path,
            JsObject::new()
                .with("pattern", name)
                .with("names", what)
                .with("name", n)
                .with_some("via", via),
        )
    };
    let mut visited: HashSet<String> = HashSet::new();
    for place in all {
        let path = place.path.as_str();
        match &place.named {
            Named::Var { name: n, caps, .. } if !place.shadowed && kind_of(n).is_none() => {
                if *caps && builtin_ctor(n) {
                    out.push(brings("capability constructor", n, path, None));
                    continue;
                }
                let m = site.meaning(n);
                if let Some(d) = def_authority(site, n, m, &mut visited) {
                    out.push(brings(d.0, d.1.as_str(), path, d.2.as_deref()));
                }
                if m.kind() == Some(DefKind::Pattern) {
                    out.push(Problem::new(
                        "E1307",
                        format!(
                            "Pattern {name} names the pattern {n}: a pattern does not apply another (spec/library.md \"Application\")."
                        ),
                        path,
                        JsObject::new()
                            .with("pattern", name)
                            .with("problem", "in_pattern")
                            .with("applies", n.as_str()),
                    ));
                }
            }
            Named::Agent(a) => out.push(brings("agent", a, path, None)),
            Named::Effect(e) if kind_of(e).is_none() => out.push(brings("effect", e, path, None)),
            Named::Compensate(e) => out.push(brings("effect", e, path, None)),
            Named::RoleText => out.push(brings("role", "written as text", path, None)),
            Named::Path { path: callee, caps } => {
                let head = callee.split('.').next().unwrap_or_default();
                if kind_of(head).is_some() {
                    continue;
                }
                let ctor = builtin_ctor(callee);
                if ctor && (*caps || std_fn(callee).is_none()) {
                    out.push(brings("capability constructor", callee, path, None));
                }
            }
            Named::Contract(c) if kind_of(c).is_none() => {
                if let Some(d) = def_authority(site, c, site.meaning(c), &mut visited) {
                    out.push(brings(d.0, d.1.as_str(), path, d.2.as_deref()));
                }
            }
            Named::Type { name: t, .. } | Named::Record(t)
                if kind_of(t).is_none() && !generics.contains(&t.as_str()) =>
            {
                if let Some(d) = def_authority(site, t, site.meaning(t), &mut visited) {
                    out.push(brings(d.0, d.1.as_str(), path, d.2.as_deref()));
                }
            }
            _ => {}
        }
    }
}

/// Whether `path` is a capability constructor of the standard library
/// (`fs.write`, `tool.call`, …).
fn builtin_ctor(path: &str) -> bool {
    CAP_CTORS.iter().any(|(n, _)| *n == path) || CAP_CTORS_0_6.iter().any(|(n, _)| *n == path)
}

/// What authority a definition of the home named `n` brings, followed
/// through the functions, constants, types and contracts it names: the kind
/// named, the name, and the definition it was reached through.
fn def_authority(
    site: &Site<'_>,
    n: &str,
    m: Meaning<'_>,
    visited: &mut HashSet<String>,
) -> Option<(&'static str, String, Option<String>)> {
    let kind = m.kind()?;
    match kind {
        DefKind::Capability => return Some(("capability", n.to_owned(), None)),
        DefKind::Agent => return Some(("agent", n.to_owned(), None)),
        DefKind::Connector => return Some(("connector", n.to_owned(), None)),
        DefKind::Role => return Some(("role", n.to_owned(), None)),
        DefKind::Effect => return Some(("effect", n.to_owned(), None)),
        DefKind::Workflow => return Some(("workflow", n.to_owned(), None)),
        DefKind::Extern => return Some(("extern", n.to_owned(), None)),
        _ => {}
    }
    if !matches!(
        kind,
        DefKind::Fn | DefKind::Const | DefKind::Type | DefKind::Contract
    ) || !visited.insert(n.to_owned())
    {
        return None;
    }
    let d = m.def()?;
    // The definition's own places, in the home's names; its parameters are
    // its own.
    let mut w = Walk::new();
    let root = Rc::new(Scope::default());
    let params: Vec<String> = Definition::of(d)
        .params()
        .iter()
        .filter_map(|p| p.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    let scope = Scope::child(&root, params);
    if let Some(members) = d.as_object() {
        for (k, x) in members.iter() {
            if k == "body" {
                w.block(x.as_array().unwrap_or_default(), "/body", &scope);
            } else if k != "kind" {
                w.node(x, &format!("/{k}"), &scope, false);
            }
        }
    }
    // A contract's criteria name the roles that approve and waive them.
    if kind == DefKind::Contract {
        let mut one = Map::new();
        one.insert(n, d.clone());
        let sites = crate::roles::role_sites(&one);
        if let Some(role) = sites.iter().find_map(|s| s.role.clone()) {
            return Some(("role", role, Some(n.to_owned())));
        }
    }
    for place in &w.out {
        let found = match &place.named {
            Named::Agent(a) => Some(("agent", a.clone(), None)),
            Named::Effect(e) | Named::Compensate(e) => Some(("effect", e.clone(), None)),
            Named::RoleText => Some(("role", "written as text".to_owned(), None)),
            Named::Path { path, caps }
                if builtin_ctor(path) && (*caps || std_fn(path).is_none()) =>
            {
                Some(("capability constructor", path.clone(), None))
            }
            Named::Var { name: v, .. } if !place.shadowed => {
                def_authority(site, v, site.meaning(v), visited)
            }
            Named::Contract(c) | Named::Type { name: c, .. } | Named::Record(c) => {
                def_authority(site, c, site.meaning(c), visited)
            }
            _ => None,
        };
        // Reached through `n`: the definition the pattern names says so.
        if let Some((what, name, _)) = found {
            return Some((what, name, Some(n.to_owned())));
        }
    }
    None
}
