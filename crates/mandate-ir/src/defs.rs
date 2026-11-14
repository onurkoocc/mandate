//! Typed views of the definitions the capability checks read
//! (`CapabilityDef`, `ComponentDef`, `Command` and `EnvironmentDef` in
//! `compiler/src/ir/types.ts`), in the pattern of [`crate::Program`].
//!
//! Each view is made from a definition's value and only when its `kind` is
//! the view's, as `d?.kind === "component"` reads it in TypeScript; a member
//! that is missing or of another type reads as `None` or as nothing.

use crate::expr::Expr;
use crate::tags::DefKind;
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
