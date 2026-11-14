//! Reading a door's input: the members of the input object, each of the
//! JSON type its TypeScript parameter has, with `bad_input` for what is not.
//!
//! The rules ([`super`] states them for the caller):
//!
//! - The input is an object. At its top level a member that is not one of
//!   the door's parameters is refused; deeper (an options object, a
//!   sub-program's input) other members are ignored, as the TypeScript
//!   ignores them.
//! - A required member must be there; `null` is a value like any other and is
//!   held to the member's type.
//! - An optional parameter, or an optional member of an options object, may
//!   be absent or `null`, which are the same.
//! - A member whose TypeScript type is a closed set of strings (a source
//!   kind, a data class, a language version, a hash domain) must be one of
//!   them.
//! - Numbers are the integers of the IR's value domain: the strict reader the
//!   request is read with refuses any other.

use mandate_ir::{Language, Map, Span, Spans, Value};
use mandate_syntax::SourceKind;

use super::DoorError;
use crate::caps::{CapOptions, CapVal};
use crate::modules::Modules;
use crate::patch::PatchOp;
use crate::stdlib::DataClass;

/// The JSON type of a value, as a message names it.
fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// The members of an object of the input, with where it is for messages.
#[derive(Clone, Copy, Debug)]
pub(super) struct Members<'a> {
    map: &'a Map,
    /// `""` for the input itself, `"opts."` for a member of `opts`.
    at: &'a str,
}

/// The members of `input`, which must be an object whose every member is
/// one of `params`.
pub(super) fn args<'a>(input: &'a Value, params: &[&str]) -> Result<Members<'a>, DoorError> {
    let Value::Object(map) = input else {
        return Err(DoorError::bad_input(format!(
            "the input is {}, not an object",
            type_name(input)
        )));
    };
    if let Some(extra) = map.keys().find(|k| !params.contains(k)) {
        return Err(DoorError::bad_input(if params.is_empty() {
            format!("`{extra}` is not a parameter: the door takes none")
        } else {
            format!(
                "`{extra}` is not a parameter: the door takes {}",
                params.join(", ")
            )
        }));
    }
    Ok(Members { map, at: "" })
}

impl<'a> Members<'a> {
    /// The members of `value`, an object, which is `name` in the input (a
    /// member, or an item of a list); `at` is where it is for messages, such
    /// as `"opts."`. Members it has that the door does not read are ignored.
    pub(super) fn nested(
        value: &'a Value,
        at: &'a str,
        name: &str,
    ) -> Result<Members<'a>, DoorError> {
        match value {
            Value::Object(map) => Ok(Members { map, at }),
            _ => Err(DoorError::bad_input(format!(
                "`{name}` is {}, not an object",
                type_name(value)
            ))),
        }
    }

    fn missing(self, name: &str) -> DoorError {
        DoorError::bad_input(format!("`{}{name}` is missing", self.at))
    }

    fn wrong(self, name: &str, v: &Value, want: &str) -> DoorError {
        DoorError::bad_input(format!(
            "`{}{name}` is {}, not {want}",
            self.at,
            type_name(v)
        ))
    }

    /// The member `name`, which must be there, whatever its value.
    pub(super) fn value(self, name: &str) -> Result<&'a Value, DoorError> {
        self.map.get(name).ok_or_else(|| self.missing(name))
    }

    /// The member `name` when it is there and not `null`.
    pub(super) fn opt_value(self, name: &str) -> Option<&'a Value> {
        self.map.get(name).filter(|v| !matches!(v, Value::Null))
    }

    /// The member `name`, a string.
    pub(super) fn str(self, name: &str) -> Result<&'a str, DoorError> {
        let v = self.value(name)?;
        v.as_str().ok_or_else(|| self.wrong(name, v, "a string"))
    }

    /// The member `name`, a string, when it is there.
    pub(super) fn opt_str(self, name: &str) -> Result<Option<&'a str>, DoorError> {
        self.opt_value(name)
            .map(|v| v.as_str().ok_or_else(|| self.wrong(name, v, "a string")))
            .transpose()
    }

    /// The member `name`, a number (an integer of the IR's domain).
    pub(super) fn int(self, name: &str) -> Result<i64, DoorError> {
        let v = self.value(name)?;
        v.as_i64().ok_or_else(|| self.wrong(name, v, "a number"))
    }

    /// The member `name`, a number or `null`, which must be there.
    pub(super) fn int_or_null(self, name: &str) -> Result<Option<i64>, DoorError> {
        match self.value(name)? {
            Value::Null => Ok(None),
            v => v
                .as_i64()
                .map(Some)
                .ok_or_else(|| self.wrong(name, v, "a number or null")),
        }
    }

    /// The member `name`, an object.
    pub(super) fn object(self, name: &str) -> Result<&'a Value, DoorError> {
        let v = self.value(name)?;
        match v {
            Value::Object(_) => Ok(v),
            _ => Err(self.wrong(name, v, "an object")),
        }
    }

    /// The member `name`, an object, when it is there.
    pub(super) fn opt_object(self, name: &str) -> Result<Option<&'a Value>, DoorError> {
        match self.opt_value(name) {
            None => Ok(None),
            Some(v @ Value::Object(_)) => Ok(Some(v)),
            Some(v) => Err(self.wrong(name, v, "an object")),
        }
    }

    /// The member `name`, an object, as its members.
    pub(super) fn map(self, name: &str) -> Result<&'a Map, DoorError> {
        let v = self.object(name)?;
        v.as_object()
            .ok_or_else(|| self.wrong(name, v, "an object"))
    }

    /// The member `name`, an object, as its members, when it is there.
    pub(super) fn opt_map(self, name: &str) -> Result<Option<&'a Map>, DoorError> {
        Ok(self.opt_object(name)?.and_then(Value::as_object))
    }

    /// The members of the member `name`, an object; `at` names it in
    /// messages, such as `"opts."`.
    pub(super) fn members(self, name: &str, at: &'a str) -> Result<Members<'a>, DoorError> {
        Members::nested(self.value(name)?, at, name)
    }

    /// As [`Members::members`], when the member is there.
    pub(super) fn opt_members(
        self,
        name: &str,
        at: &'a str,
    ) -> Result<Option<Members<'a>>, DoorError> {
        self.opt_value(name)
            .map(|v| Members::nested(v, at, name))
            .transpose()
    }

    /// The member `name`, an array.
    pub(super) fn array(self, name: &str) -> Result<&'a [Value], DoorError> {
        let v = self.value(name)?;
        v.as_array().ok_or_else(|| self.wrong(name, v, "an array"))
    }

    /// The member `name`, an array of strings.
    pub(super) fn strings(self, name: &str) -> Result<Vec<&'a str>, DoorError> {
        let items = self.array(name)?;
        strings_of(self, name, items)
    }

    /// The member `name`, an array of strings, when it is there.
    pub(super) fn opt_strings(self, name: &str) -> Result<Option<Vec<&'a str>>, DoorError> {
        match self.opt_value(name) {
            None => Ok(None),
            Some(v) => {
                let items = v
                    .as_array()
                    .ok_or_else(|| self.wrong(name, v, "an array"))?;
                strings_of(self, name, items).map(Some)
            }
        }
    }

    /// The member `name`, `"mdt"` or `"json"`.
    pub(super) fn kind(self, name: &str) -> Result<SourceKind, DoorError> {
        match self.str(name)? {
            "mdt" => Ok(SourceKind::Mdt),
            "json" => Ok(SourceKind::Json),
            other => Err(DoorError::bad_input(format!(
                "`{}{name}` is \"{other}\", not \"mdt\" or \"json\"",
                self.at
            ))),
        }
    }

    /// The member `name`, a language version such as `"mandate/0.5"`, when
    /// it is there.
    pub(super) fn opt_language(self, name: &str) -> Result<Option<Language>, DoorError> {
        self.opt_str(name)?
            .map(|tag| {
                Language::from_tag(tag).ok_or_else(|| {
                    DoorError::bad_input(format!(
                        "`{}{name}` is \"{tag}\", not a language version",
                        self.at
                    ))
                })
            })
            .transpose()
    }

    /// The member `name`, a data class.
    pub(super) fn data_class(self, name: &str) -> Result<DataClass, DoorError> {
        let tag = self.str(name)?;
        DataClass::from_name(tag).ok_or_else(|| {
            DoorError::bad_input(format!(
                "`{}{name}` is \"{tag}\", not a data class",
                self.at
            ))
        })
    }

    /// The member `name`, loaded modules by name (an object whose every
    /// member is a program, an object), when it is there.
    pub(super) fn opt_modules(self, name: &str) -> Result<Option<&'a Modules>, DoorError> {
        let Some(modules) = self.opt_map(name)? else {
            return Ok(None);
        };
        if let Some((m, v)) = modules.iter().find(|(_, v)| !matches!(v, Value::Object(_))) {
            return Err(DoorError::bad_input(format!(
                "`{}{name}.{m}` is {}, not a program",
                self.at,
                type_name(v)
            )));
        }
        Ok(Some(modules))
    }

    /// The member `name`, a table of spans by JSON Pointer (a `Map` in the
    /// TypeScript, an object here): each `[startLine, startCol, endLine,
    /// endCol]`, when it is there.
    pub(super) fn opt_spans(self, name: &str) -> Result<Option<Spans>, DoorError> {
        let Some(map) = self.opt_map(name)? else {
            return Ok(None);
        };
        let mut out = Spans::new();
        for (pointer, v) in map.iter() {
            let span = span_of(v).ok_or_else(|| {
                DoorError::bad_input(format!(
                    "`{}{name}` has a span that is not four numbers at \"{pointer}\"",
                    self.at
                ))
            })?;
            out.insert(pointer.to_owned(), span);
        }
        Ok(Some(out))
    }

    /// The member `name`, a list of patch operations, each an object.
    pub(super) fn ops(self, name: &str) -> Result<Vec<PatchOp>, DoorError> {
        let items = self.array(name)?;
        items
            .iter()
            .map(|v| match v {
                Value::Object(_) => Ok(PatchOp::from_value(v)),
                _ => Err(DoorError::bad_input(format!(
                    "`{}{name}` has an operation that is {}, not an object",
                    self.at,
                    type_name(v)
                ))),
            })
            .collect()
    }

    /// The member `name`, a list of capability values.
    pub(super) fn caps(self, name: &str) -> Result<Vec<CapVal>, DoorError> {
        let items = self.array(name)?;
        items
            .iter()
            .map(|v| {
                cap_val(v).map_err(|e| DoorError::bad_input(format!("`{}{name}`: {e}", self.at)))
            })
            .collect()
    }

    /// The member `name`, `CapOptions` (`{ language? }`), when it is there.
    pub(super) fn opt_cap_options(self, name: &str) -> Result<CapOptions, DoorError> {
        let at = if self.at.is_empty() { "opts." } else { self.at };
        Ok(match self.opt_members(name, at)? {
            None => CapOptions::default(),
            Some(opts) => CapOptions {
                language: opts.opt_language("language")?,
            },
        })
    }
}

fn strings_of<'a>(
    m: Members<'a>,
    name: &str,
    items: &'a [Value],
) -> Result<Vec<&'a str>, DoorError> {
    items
        .iter()
        .map(|v| {
            v.as_str().ok_or_else(|| {
                DoorError::bad_input(format!(
                    "`{}{name}` has an item that is {}, not a string",
                    m.at,
                    type_name(v)
                ))
            })
        })
        .collect()
}

/// `[startLine, startCol, endLine, endCol]`, each a number that is not
/// negative.
fn span_of(v: &Value) -> Option<Span> {
    let parts: Vec<usize> = v
        .as_array()?
        .iter()
        .map(|n| n.as_i64().and_then(|n| usize::try_from(n).ok()))
        .collect::<Option<Vec<_>>>()?;
    match parts.as_slice() {
        [start_line, start_col, end_line, end_col] => Some(Span {
            start_line: *start_line,
            start_col: *start_col,
            end_line: *end_line,
            end_col: *end_col,
        }),
        _ => None,
    }
}

/// A capability value as the TypeScript's `CapVal` is written in JSON:
/// `ctor`, `effect` and `write`, and the members it has, in the order it has
/// them. A member of a capability of another JSON type than its own is
/// refused; one a capability does not have is ignored.
pub(super) fn cap_val(v: &Value) -> Result<CapVal, String> {
    let Value::Object(map) = v else {
        return Err(format!("a capability is {}, not an object", type_name(v)));
    };
    let text = |k: &str| -> Result<Option<String>, String> {
        match map.get(k) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(other) => Err(format!(
                "a capability's `{k}` is {}, not a string",
                type_name(other)
            )),
        }
    };
    let strings = |k: &str| -> Result<Option<Vec<String>>, String> {
        let Some(found) = map.get(k) else {
            return Ok(None);
        };
        let items = found
            .as_array()
            .ok_or_else(|| format!("a capability's `{k}` is {}, not an array", type_name(found)))?;
        items
            .iter()
            .map(|x| {
                x.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("a capability's `{k}` has an item that is not a string"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some)
    };
    let ctor = text("ctor")?.ok_or("a capability has no `ctor`")?;
    let effect = text("effect")?.ok_or("a capability has no `effect`")?;
    let write = match map.get("write") {
        Some(Value::Bool(b)) => *b,
        Some(other) => {
            return Err(format!(
                "a capability's `write` is {}, not a boolean",
                type_name(other)
            ));
        }
        None => return Err("a capability has no `write`".to_owned()),
    };
    let mut cap = CapVal::new(ctor, effect, write);
    // The setters place a member as assignment does: in the order of the
    // object.
    for (k, found) in map.iter() {
        match k {
            "name" => cap.set_name(text("name")?),
            "via" => cap.set_via(text("via")?),
            "components" => cap.set_components(strings("components")?),
            "root" => cap.set_root(text("root")?),
            "scope" => cap.set_scope(strings("scope")?),
            "maxClass" => {
                let class = found
                    .as_str()
                    .and_then(DataClass::from_name)
                    .ok_or("a capability's `maxClass` is not a data class")?;
                cap.set_max_class(Some(class));
            }
            "tier" => cap.set_tier(text("tier")?),
            "argsPrefix" => {
                let lists = found
                    .as_array()
                    .ok_or("a capability's `argsPrefix` is not an array")?
                    .iter()
                    .map(|l| {
                        l.as_array()
                            .ok_or("a capability's `argsPrefix` has an item that is not an array")?
                            .iter()
                            .map(|a| {
                                a.as_str().map(str::to_owned).ok_or(
                                    "a capability's `argsPrefix` has an argument that is not a string",
                                )
                            })
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                cap.set_args_prefix(Some(lists));
            }
            "methods" => cap.set_methods(strings("methods")?),
            // `ctor`, `effect` and `write` are read above; another member is
            // not one a capability has, and is ignored, as the TypeScript
            // ignores it.
            _ => {}
        }
    }
    Ok(cap)
}
