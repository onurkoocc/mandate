//! Typed views of the definitions the capability checks read
//! (`CapabilityDef`, `ComponentDef`, `Command` and `EnvironmentDef` in
//! `compiler/src/ir/types.ts`), in the pattern of [`crate::Program`].
//!
//! Each view is made from a definition's value and only when its `kind` is
//! the view's, as `d?.kind === "component"` reads it in TypeScript; a member
//! that is missing or of another type reads as `None` or as nothing.

use crate::expr::Expr;
use crate::tags::DefKind;
use crate::type_expr::TypeExpr;
use crate::value::{Map, Value};

/// The object `v`, when it is one whose `kind` is `kind`.
fn of_kind(v: &Value, kind: DefKind) -> Option<&Map> {
    v.as_object()
        .filter(|map| map.get("kind").and_then(DefKind::from_value) == Some(kind))
}

/// The strings of the array `v`, in order; the elements that are not
/// strings are left out.
fn strings(v: Option<&Value>) -> impl Iterator<Item = &str> {
    v.and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
}

/// A `capability` definition: `{ kind, value }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapabilityDef<'a> {
    map: &'a Map,
}

impl<'a> CapabilityDef<'a> {
    /// The view of `v`, when it is a `capability` definition.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<CapabilityDef<'a>> {
        of_kind(v, DefKind::Capability).map(|map| CapabilityDef { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `value`: the capability expression.
    #[must_use]
    pub fn value(self) -> Option<Expr<'a>> {
        self.map.get("value").and_then(Expr::of)
    }
}

/// A `component` definition of the system model (design doc 9 §2.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ComponentDef<'a> {
    map: &'a Map,
}

impl<'a> ComponentDef<'a> {
    /// The view of `v`, when it is a `component` definition.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<ComponentDef<'a>> {
        of_kind(v, DefKind::Component).map(|map| ComponentDef { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `repo`: the git repository, `owner/name`.
    #[must_use]
    pub fn repo(self) -> Option<&'a str> {
        self.map.get("repo").and_then(Value::as_str)
    }

    /// `root`: where its working copy sits.
    #[must_use]
    pub fn root(self) -> Option<&'a str> {
        self.map.get("root").and_then(Value::as_str)
    }

    /// `lang`.
    #[must_use]
    pub fn lang(self) -> Option<&'a str> {
        self.map.get("lang").and_then(Value::as_str)
    }

    /// `owner`: the role that owns it.
    #[must_use]
    pub fn owner(self) -> Option<&'a str> {
        self.map.get("owner").and_then(Value::as_str)
    }

    fn commands(self, key: &str) -> Option<impl Iterator<Item = Command<'a>>> {
        self.map.get(key).and_then(Value::as_array).map(|cs| {
            cs.iter()
                .filter_map(|c| c.as_object().map(|map| Command { map }))
        })
    }

    /// `build`, when it is there (an empty list is there); the elements
    /// that are not objects are left out.
    #[must_use]
    pub fn build(self) -> Option<impl Iterator<Item = Command<'a>>> {
        self.commands("build")
    }

    /// `test`, when it is there (an empty list is there); the elements that
    /// are not objects are left out.
    #[must_use]
    pub fn test(self) -> Option<impl Iterator<Item = Command<'a>>> {
        self.commands("test")
    }

    /// `provides`: interface names.
    pub fn provides(self) -> impl Iterator<Item = &'a str> {
        strings(self.map.get("provides"))
    }

    /// `consumes`: interface names.
    pub fn consumes(self) -> impl Iterator<Item = &'a str> {
        strings(self.map.get("consumes"))
    }

    /// `governance`: its own governance-class file patterns.
    pub fn governance(self) -> impl Iterator<Item = &'a str> {
        strings(self.map.get("governance"))
    }
}

/// One process a component runs to build or test itself: `{ command, args }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Command<'a> {
    map: &'a Map,
}

impl<'a> Command<'a> {
    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `command`.
    #[must_use]
    pub fn command(self) -> Option<&'a str> {
        self.map.get("command").and_then(Value::as_str)
    }

    /// `args`, its fixed arguments, in order.
    pub fn args(self) -> impl Iterator<Item = &'a str> {
        strings(self.map.get("args"))
    }
}

/// An `environment` definition of the system model (design doc 9 §2.1, §5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnvironmentDef<'a> {
    map: &'a Map,
}

impl<'a> EnvironmentDef<'a> {
    /// The view of `v`, when it is an `environment` definition.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<EnvironmentDef<'a>> {
        of_kind(v, DefKind::Environment).map(|map| EnvironmentDef { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `class`: the highest data class it holds.
    #[must_use]
    pub fn class(self) -> Option<&'a str> {
        self.map.get("class").and_then(Value::as_str)
    }

    /// `reads`: its declared reads by name, in the order of the object
    /// (`Object.keys`).
    pub fn reads(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        self.map
            .get("reads")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(Map::iter)
    }

    /// `authorize`: by effect name, the weakest authorization it accepts.
    pub fn authorize(self) -> impl Iterator<Item = (&'a str, &'a Value)> {
        self.map
            .get("authorize")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(Map::iter)
    }
}

/// A `connector` definition (spec/library.md "Connectors", language 0.6):
/// `{ kind, mcp, version?, class?, tools }`. In a table of linked
/// definitions it also has `module`, the module that defines it, which
/// linking writes: a connector is named by its module and its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConnectorDef<'a> {
    map: &'a Map,
}

impl<'a> ConnectorDef<'a> {
    /// The view of `v`, when it is a `connector` definition.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<ConnectorDef<'a>> {
        of_kind(v, DefKind::Connector).map(|map| ConnectorDef { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `mcp`: the server's URL.
    #[must_use]
    pub fn mcp(self) -> Option<&'a str> {
        self.map.get("mcp").and_then(Value::as_str)
    }

    /// `version`: the text the program records.
    #[must_use]
    pub fn version(self) -> Option<&'a str> {
        self.map.get("version").and_then(Value::as_str)
    }

    /// `class`: the data class of what its tools return, as written.
    #[must_use]
    pub fn class(self) -> Option<&'a str> {
        self.map.get("class").and_then(Value::as_str)
    }

    /// `module`: in a table of linked definitions, the module that defines
    /// it.
    #[must_use]
    pub fn module(self) -> Option<&'a str> {
        self.map.get("module").and_then(Value::as_str)
    }

    /// `tools`: its tools by name, in the order of the object; the ones
    /// that are not objects are left out.
    pub fn tools(self) -> impl Iterator<Item = (&'a str, Tool<'a>)> {
        self.map
            .get("tools")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(Map::iter)
            .filter_map(|(n, t)| t.as_object().map(|map| (n, Tool { map })))
    }

    /// The tool `name`, when it declares one.
    #[must_use]
    pub fn tool(self, name: &str) -> Option<Tool<'a>> {
        self.map
            .get("tools")
            .and_then(|t| t.get(name))
            .and_then(Value::as_object)
            .map(|map| Tool { map })
    }
}

/// A `pattern` definition (spec/library.md "Patterns", language 0.6): `{
/// kind, generics?, slots, params?, returns, body?, pub?, doc? }`, and the
/// `caps`, `budget` and `envelope` a pattern may not declare (E1302), which
/// the schema lets through so that the check names them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PatternDef<'a> {
    map: &'a Map,
}

impl<'a> PatternDef<'a> {
    /// The view of `v`, when it is a `pattern` definition.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<PatternDef<'a>> {
        of_kind(v, DefKind::Pattern).map(|map| PatternDef { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `generics`: the names of its type parameters, in order, every
    /// element included.
    #[must_use]
    pub fn generics(self) -> &'a [Value] {
        self.map
            .get("generics")
            .and_then(Value::as_array)
            .unwrap_or_default()
    }

    /// `slots`, in order; the ones that are not objects are left out.
    pub fn slots(self) -> impl Iterator<Item = Slot<'a>> {
        self.slot_values()
            .iter()
            .filter_map(|s| s.as_object().map(|map| Slot { map }))
    }

    /// `slots`, every element included, so that a slot's index is its index
    /// in the IR.
    #[must_use]
    pub fn slot_values(self) -> &'a [Value] {
        self.map
            .get("slots")
            .and_then(Value::as_array)
            .unwrap_or_default()
    }

    /// The slot `name`, the first of that name.
    #[must_use]
    pub fn slot(self, name: &str) -> Option<Slot<'a>> {
        self.slots().find(|s| s.name() == Some(name))
    }

    /// `params`: its run parameters, every element included.
    #[must_use]
    pub fn params(self) -> &'a [Value] {
        self.map
            .get("params")
            .and_then(Value::as_array)
            .unwrap_or_default()
    }

    /// `returns`.
    #[must_use]
    pub fn returns(self) -> Option<TypeExpr<'a>> {
        self.map.get("returns").and_then(TypeExpr::of)
    }

    /// `body`, when it is a list of statements.
    #[must_use]
    pub fn body(self) -> Option<&'a [Value]> {
        self.map.get("body").and_then(Value::as_array)
    }
}

/// One slot of a pattern: `{ name, kind, params?, returns?, type?,
/// read_only? }`. `kind` is read as written, so that a kind the language
/// does not have is the check's to name (E1301).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slot<'a> {
    map: &'a Map,
}

impl<'a> Slot<'a> {
    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `name`.
    #[must_use]
    pub fn name(self) -> Option<&'a str> {
        self.map.get("name").and_then(Value::as_str)
    }

    /// `kind`, as written: `type`, `skill`, `tool`, `effect`, `contract`,
    /// `role`, `capability`, `const` or `field` in a pattern that is well
    /// formed.
    #[must_use]
    pub fn kind(self) -> Option<&'a str> {
        self.map.get("kind").and_then(Value::as_str)
    }

    /// `params`: the parameter types of its signature, when it has one.
    #[must_use]
    pub fn params(self) -> Option<&'a [Value]> {
        self.map.get("params").and_then(Value::as_array)
    }

    /// `returns`: the result type of its signature.
    #[must_use]
    pub fn returns(self) -> Option<TypeExpr<'a>> {
        self.map.get("returns").and_then(TypeExpr::of)
    }

    /// `type`: the type of a `const` slot, or the record type of a `field`
    /// slot.
    #[must_use]
    pub fn type_expr(self) -> Option<TypeExpr<'a>> {
        self.map.get("type").and_then(TypeExpr::of)
    }

    /// `read_only` of a `skill` slot.
    #[must_use]
    pub fn read_only(self) -> bool {
        self.map.get("read_only") == Some(&Value::Bool(true))
    }
}

/// The application of a pattern a workflow carries (spec/library.md
/// "Application", language 0.6): `apply: { pattern, types?, args }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Application<'a> {
    map: &'a Map,
}

impl<'a> Application<'a> {
    /// The view of a workflow's `apply`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<Application<'a>> {
        v.as_object().map(|map| Application { map })
    }

    /// The application a definition carries, when it is a workflow with an
    /// `apply` object.
    #[must_use]
    pub fn of_workflow(d: &'a Value) -> Option<Application<'a>> {
        of_kind(d, DefKind::Workflow)
            .and_then(|m| m.get("apply"))
            .and_then(Application::of)
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `pattern`: the name applied.
    #[must_use]
    pub fn pattern(self) -> Option<&'a str> {
        self.map.get("pattern").and_then(Value::as_str)
    }

    /// `types`: the type arguments, every element included.
    #[must_use]
    pub fn types(self) -> &'a [Value] {
        self.map
            .get("types")
            .and_then(Value::as_array)
            .unwrap_or_default()
    }

    /// `args`, every element included, so that an argument's index is its
    /// index in the IR.
    #[must_use]
    pub fn arg_values(self) -> &'a [Value] {
        self.map
            .get("args")
            .and_then(Value::as_array)
            .unwrap_or_default()
    }

    /// `args`, in order; the ones that are not objects are left out.
    pub fn args(self) -> impl Iterator<Item = SlotArg<'a>> {
        self.arg_values()
            .iter()
            .filter_map(|a| a.as_object().map(|map| SlotArg { map }))
    }
}

/// One argument of an application: `{ name, value }`, or `{ name, type }`
/// for a type written as one (`List<Invoice>`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlotArg<'a> {
    map: &'a Map,
}

impl<'a> SlotArg<'a> {
    /// The view of `v`, when it is an object.
    #[must_use]
    pub fn of(v: &'a Value) -> Option<SlotArg<'a>> {
        v.as_object().map(|map| SlotArg { map })
    }

    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `name`: the slot it is for.
    #[must_use]
    pub fn name(self) -> Option<&'a str> {
        self.map.get("name").and_then(Value::as_str)
    }

    /// `value`: an expression.
    #[must_use]
    pub fn value(self) -> Option<Expr<'a>> {
        self.map.get("value").and_then(Expr::of)
    }

    /// `type`: a type.
    #[must_use]
    pub fn type_expr(self) -> Option<TypeExpr<'a>> {
        self.map.get("type").and_then(TypeExpr::of)
    }
}

/// One tool of a connector: `{ params, returns, read_only?, critical?,
/// idempotency_key?, retry_class?, reconcile_by?, compensation? }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tool<'a> {
    map: &'a Map,
}

impl<'a> Tool<'a> {
    /// The members, as read.
    #[must_use]
    pub fn members(self) -> &'a Map {
        self.map
    }

    /// `params`, every element included.
    #[must_use]
    pub fn params(self) -> &'a [Value] {
        self.map
            .get("params")
            .and_then(Value::as_array)
            .unwrap_or_default()
    }

    /// `returns`.
    #[must_use]
    pub fn returns(self) -> Option<TypeExpr<'a>> {
        self.map.get("returns").and_then(TypeExpr::of)
    }

    /// `read_only`: it changes nothing.
    #[must_use]
    pub fn read_only(self) -> bool {
        self.map.get("read_only") == Some(&Value::Bool(true))
    }

    /// `critical`.
    #[must_use]
    pub fn critical(self) -> bool {
        self.map.get("critical") == Some(&Value::Bool(true))
    }

    /// `idempotency_key`: the parameter the runtime sends the operation key
    /// in.
    #[must_use]
    pub fn idempotency_key(self) -> Option<&'a str> {
        self.map.get("idempotency_key").and_then(Value::as_str)
    }

    /// `retry_class`.
    #[must_use]
    pub fn retry_class(self) -> Option<&'a str> {
        self.map.get("retry_class").and_then(Value::as_str)
    }

    /// `reconcile_by`: the read-only tool asked about a write's outcome.
    #[must_use]
    pub fn reconcile_by(self) -> Option<&'a str> {
        self.map.get("reconcile_by").and_then(Value::as_str)
    }

    /// `compensation`: the write tool offered to a person after a partial
    /// failure.
    #[must_use]
    pub fn compensation(self) -> Option<&'a str> {
        self.map.get("compensation").and_then(Value::as_str)
    }

    /// Whether it declares anything of a write class: `critical`,
    /// `idempotency_key`, `retry_class`, `reconcile_by` or `compensation`.
    #[must_use]
    pub fn declares_write(self) -> bool {
        [
            "critical",
            "idempotency_key",
            "retry_class",
            "reconcile_by",
            "compensation",
        ]
        .iter()
        .any(|k| self.map.get(k).is_some())
    }

    /// Whether it is read as a write tool: anything but a tool that is
    /// `read_only` and declares nothing of a write class. A tool of no
    /// closed class, neither or both (E1401), is read as a write, the
    /// stricter: no agent may hold it, and it is called only as a critical
    /// effect.
    #[must_use]
    pub fn is_write(self) -> bool {
        !self.read_only() || self.declares_write()
    }
}
