//! The tools: `callTool` of `bridge/src/mcp.ts`, over the same doors of the
//! compiler that the Node server reaches through the bridge, asked with the
//! same inputs (each built as the bridge's facade builds it: the members a
//! function's parameters, in order, an undefined one left out) and read as
//! the bridge reads their answers. A door's input that a request cannot
//! carry, and a door's refusal, are the bridge's failures, in its words.
//!
//! What language 0.7 adds (spec/attention.md "The MCP server"), which the
//! Node server does not do yet:
//!
//! - `check`, `project` and `caps_of` take `libraries`, a list of `{
//!   manifest, files }` (each a string `manifest` and an object `files` of
//!   strings, else the tool error), given to the check as `opts.libraries`
//!   (when the list is not empty); the check finds the embedded
//!   `std.patterns` by itself. A view of `project` and the authority view of
//!   `caps_of` are given the modules of those libraries too, as `mandate
//!   view` gives them (`modulesOf` of `bridge/src/libraries.ts`), and the
//!   `before` program of a diff is checked with them; `caps_of` takes `lock`
//!   too, as `check` does;
//! - `project` has the view `card`, of the workflow `workflow` (the door
//!   `card`, as `mandate view --card` asks it), and the view `attention`,
//!   which has no door yet ([`attention_view`]);
//! - `spec` takes the section `patterns` (spec/library.md) and `attention`
//!   (spec/attention.md), whole.

use std::panic::{AssertUnwindSafe, catch_unwind};

use mandate_doors::MAX_REQUEST_BYTES;
use mandate_ir::{JsObject, JsValue, stringify};

use super::json::{J, JObj, JStr, NOT_PRIMITIVE, js_truthy, request_value};
use super::{Fail, InDoor, Server};

/// The core specification, `spec/core.md`.
const CORE: &str = include_str!("../../../../spec/core.md");

/// The specification of patterns and libraries, `spec/library.md`: the
/// section `patterns`.
const PATTERNS: &str = include_str!("../../../../spec/library.md");

/// The specification of attention, `spec/attention.md`: the section
/// `attention`.
const ATTENTION: &str = include_str!("../../../../spec/attention.md");

/// The languages the TypeScript compiler reads (`LANGUAGE_VERSIONS`): a
/// view of their programs is given no modules (`viewModules`).
const TS_LANGUAGES: [&str; 5] = [
    "mandate/0.1",
    "mandate/0.2",
    "mandate/0.3",
    "mandate/0.4",
    "mandate/0.5",
];

/// The views of `project`, for the message that names them.
const VIEWS: &str = "view must be architecture, authority, cost, diff, card or attention";

/// The answer to `project` with `view: "attention"`, until the attention
/// view has its door (slice RP1): the one place that answers it.
pub(crate) fn attention_view() -> Fail {
    Fail::Tool(JStr::from(
        "view attention is not available yet: the Rust compiler has no door attention",
    ))
}

/// A tool error.
fn tool(message: impl Into<JStr>) -> Fail {
    Fail::Tool(message.into())
}

/// A failure the bridge would throw, as an Internal error.
fn internal(message: impl Into<JStr>) -> Fail {
    Fail::Internal(message.into())
}

/// The most bytes of answer the bridge's host takes from the module
/// (`MAX_ANSWER_BYTES` of `bridge/src/wasm/host.ts`): a longer one stops the
/// call, `output_too_large`.
pub(crate) const MAX_ANSWER_BYTES: usize = 64 * 1024 * 1024;

/// How many bytes the module would write for this result of a door: the
/// answer `{"ok":true,"output":…}` or `{"ok":false,"error":…}`
/// (`mandate_doors::written`), the output written once.
fn answer_bytes(result: &Result<JsValue, mandate_doors::DoorError>) -> usize {
    match result {
        Ok(out) => {
            let around = mandate_doors::written(Ok(JsValue::Null))
                .len()
                .saturating_sub("null".len());
            let output = if out.is_undefined() {
                "null".len()
            } else {
                stringify(out).map_or("null".len(), |t| t.len())
            };
            around.saturating_add(output)
        }
        Err(e) => mandate_doors::written(Err(e.clone().into())).len(),
    }
}

/// The failure of a door whose answer the host would not take whole, in the
/// host's words; nothing when it would.
fn answer_cap(name: &str, result: &Result<JsValue, mandate_doors::DoorError>) -> Result<(), Fail> {
    if answer_bytes(result) > MAX_ANSWER_BYTES {
        return Err(internal(format!(
            "the Rust compiler failed on {name} (output_too_large): the answer passed {MAX_ANSWER_BYTES} bytes and the call was stopped"
        )));
    }
    Ok(())
}

/// The output of the door `name` for `input`, as the bridge's `rustCall`
/// gives it; its failures in the bridge's words.
fn door(name: &'static str, input: JObj) -> Result<JsValue, Fail> {
    let value = request_value(&J::Obj(input), 2).map_err(|problem| {
        internal(format!(
            "the Rust compiler failed on {name} (unrepresentable): {problem}"
        ))
    })?;
    // `{"door":"<name>","input":<input>}`, which the module reads only when
    // it is not longer than a request may be.
    let written = stringify(&JsValue::from(&value)).map_or(0, |t| t.len());
    let request = written.saturating_add(name.len()).saturating_add(20);
    if request > MAX_REQUEST_BYTES {
        return Err(internal(format!(
            "the Rust compiler failed on {name} (refused): too_large: the request is longer than {MAX_REQUEST_BYTES} bytes, the most a request may be"
        )));
    }
    let Some(d) = mandate_doors::door(name) else {
        return Err(internal(format!(
            "the Rust compiler failed on {name} (refused): unknown_door: no door is named `{name}`"
        )));
    };
    // A panic of the door says nothing (`mod.rs`, `InDoor`), and is caught.
    let caught = {
        let _quiet = InDoor::begin();
        catch_unwind(AssertUnwindSafe(|| (d.call)(&value)))
    };
    let result = caught.map_err(|_| {
        internal(format!(
            "the Rust compiler failed on {name} (trap): the module panicked"
        ))
    })?;
    answer_cap(name, &result)?;
    match result {
        Ok(JsValue::Undefined) => Ok(JsValue::Null),
        Ok(out) => Ok(out),
        // The function the door stands for throws, with its message.
        Err(e) => Err(internal(e.message)),
    }
}

/// `args[k]`, when it is a string; else the tool error `k must be a string`.
fn str_arg<'a>(args: &'a J, k: &str) -> Result<&'a JStr, Fail> {
    match args.get(k) {
        Some(J::Str(s)) => Ok(s),
        _ => Err(tool(format!("{k} must be a string"))),
    }
}

/// `kindFor`: what a source is, as the call says or else by its first
/// character.
fn kind_for(source: &JStr, kind: Option<&J>) -> &'static str {
    match kind.and_then(J::as_jstr).and_then(JStr::text) {
        Some("mdt") => "mdt",
        Some("json") => "json",
        _ if source.trimmed(false).starts_with("{") => "json",
        _ => "mdt",
    }
}

/// `kindOf`: a file's kind by its name.
fn kind_of(path: &str) -> &'static str {
    if path.ends_with(".json") {
        "json"
    } else {
        "mdt"
    }
}

/// `d.severity === "error"`.
fn is_error(d: &JsValue) -> bool {
    d.get("severity").and_then(JsValue::as_str) == Some("error")
}

/// The member `k` of a door's output, `undefined` when it has none.
fn member(v: &JsValue, k: &str) -> JsValue {
    v.get(k).cloned().unwrap_or(JsValue::Undefined)
}

/// The elements of a door's output's member `k`, or none.
fn items<'a>(v: &'a JsValue, k: &str) -> &'a [JsValue] {
    v.get(k).and_then(JsValue::as_array).unwrap_or_default()
}

/// `${d.code} ${d.message}`.
fn coded(d: &JsValue) -> String {
    format!(
        "{} {}",
        member(d, "code").to_js_string(),
        member(d, "message").to_js_string()
    )
}

/// `viewModules`: the modules a view of `programs` is given, which are the
/// caller's when one of them is of a language the TypeScript compiler does
/// not read.
fn view_modules(modules: &JsObject, programs: &[&JsValue]) -> Option<J> {
    programs
        .iter()
        .any(|p| {
            !p.get("language")
                .and_then(JsValue::as_str)
                .is_some_and(|l| TS_LANGUAGES.contains(&l))
        })
        .then(|| J::Js(JsValue::Object(modules.clone())))
}

/// 0.7: the version of `std.patterns` the lock pins (`lock.libraries
/// ["std.patterns"].version`), when it pins one: what a view door given no
/// lock is handed as `std_patterns`, so that it shows the version the check
/// read, as `mandate view` does. The check of the program has held the pin
/// to an embedded version (E1605) before any view is asked.
fn std_patterns_of(lock: Option<&J>) -> Option<J> {
    lock?
        .get("libraries")?
        .get("std.patterns")?
        .get("version")
        .filter(|v| v.as_jstr().is_some())
        .cloned()
}

/// `{ modules, ...(lock ? { lock } : {}), ...(libraries.length ? { libraries } : {}) }`.
fn check_options(modules: &JsObject, lock: Option<&J>, libraries: Option<&J>) -> JObj {
    JObj::new()
        .with("modules", J::Js(JsValue::Object(modules.clone())))
        .with_some("lock", lock.filter(|l| l.truthy()).cloned())
        .with_some("libraries", libraries.cloned())
}

/// Whether `v` is a library as a call gives one: an object with a string
/// `manifest` and an object `files` whose every member is a string. What
/// else it holds is the door's to refuse.
fn is_library(v: &J) -> bool {
    matches!(v.get("manifest"), Some(J::Str(_)))
        && match v.get("files") {
            Some(J::Obj(files)) => files.iter().all(|(_, text)| matches!(text, J::Str(_))),
            _ => false,
        }
}

/// 0.7: the call's `libraries`, a list of libraries, when it has a
/// non-empty one; the tool error when it is not such a list.
fn libraries_arg(args: &J) -> Result<Option<&J>, Fail> {
    match args.get("libraries") {
        None => Ok(None),
        Some(given @ J::Arr(list)) if list.iter().all(is_library) => {
            Ok(if list.is_empty() { None } else { Some(given) })
        }
        Some(_) => Err(tool(
            "libraries must be a list of libraries, each { manifest, files }",
        )),
    }
}

/// The section `section` of the specification, as `specText` gives it; 0.7
/// adds the sections `patterns` and `attention`.
fn spec_text(section: Option<&J>) -> Result<String, Fail> {
    let Some(section) = section else {
        return Ok(CORE.to_owned());
    };
    // `String(section)` throws for an object with an own `toString`.
    let want = section
        .to_js_string()
        .map_err(|_| internal(NOT_PRIMITIVE))?
        .trimmed(true);
    match want.text() {
        Some("patterns") => return Ok(PATTERNS.to_owned()),
        Some("attention") => return Ok(ATTENTION.to_owned()),
        _ => {}
    }
    let lines: Vec<&str> = CORE.split('\n').collect();
    let hashes = |l: &str| l.bytes().take_while(|b| *b == b'#').count();
    // `^#{2,3} <want>\.? `, the section number taken as it is written.
    let heads = |l: &str| {
        let n = hashes(l);
        let Some(text) = want.text() else {
            return false;
        };
        (2..=3).contains(&n)
            && l.get(n..)
                .and_then(|rest| rest.strip_prefix(' '))
                .and_then(|rest| rest.strip_prefix(text))
                .is_some_and(|after| after.starts_with(' ') || after.starts_with(". "))
    };
    let Some(start) = lines.iter().position(|l| heads(l)) else {
        return Err(Fail::Tool(JStr::concat(&[
            &JStr::from("no section "),
            &want,
            &JStr::from(" in the core specification"),
        ])));
    };
    let depth = lines.get(start).map_or(0, |l| hashes(l));
    let end = lines
        .iter()
        .enumerate()
        .skip(start.saturating_add(1))
        .find(|(_, l)| {
            let n = hashes(l);
            n > 0 && l.get(n..).is_some_and(|rest| rest.starts_with(' ')) && n <= depth
        })
        .map_or(lines.len(), |(i, _)| i);
    Ok(lines.get(start..end).unwrap_or_default().join("\n"))
}

impl Server {
    /// `modulesFor`: the server's modules and the call's own.
    fn modules_for(&self, args: &J) -> Result<JsObject, Fail> {
        let given = match args.get("modules") {
            None => return Ok(self.modules.clone()),
            Some(J::Arr(items)) if items.iter().all(|m| matches!(m, J::Str(_))) => items,
            Some(_) => return Err(tool("modules must be a list of module sources")),
        };
        let sources: Vec<J> = given
            .iter()
            .enumerate()
            .map(|(i, text)| {
                let kind = text.as_jstr().map_or("mdt", |t| kind_for(t, None));
                J::Obj(
                    JObj::new()
                        .with("file", J::str(format!("modules[{i}]")))
                        .with("text", text.clone())
                        .with("kind", J::str(kind)),
                )
            })
            .collect();
        let out = door("load_modules", JObj::new().with("sources", J::Arr(sources)))?;
        let problems = items(&out, "problems");
        if !problems.is_empty() {
            let all: Vec<String> = problems
                .iter()
                .flat_map(|p| {
                    let file = member(p, "file").to_js_string();
                    items(p, "diagnostics")
                        .iter()
                        .map(move |d| format!("{file}: {}", coded(d)))
                })
                .collect();
            return Err(tool(format!("a module does not load: {}", all.join("; "))));
        }
        let loaded = out
            .get("modules")
            .and_then(JsValue::as_object)
            .cloned()
            .unwrap_or_default();
        Ok(self.modules.clone().spread(&loaded))
    }

    /// `program`: a program that passes its checks, or a tool error with
    /// the diagnostics.
    fn program(
        &self,
        source: &JStr,
        kind: Option<&J>,
        modules: &JsObject,
        lock: Option<&J>,
        libraries: Option<&J>,
    ) -> Result<JsValue, Fail> {
        let r = door(
            "check",
            JObj::new()
                .with("text", J::Str(source.clone()))
                .with("kind", J::str(kind_for(source, kind)))
                .with("opts", J::Obj(check_options(modules, lock, libraries))),
        )?;
        if !r.get("ok").is_some_and(js_truthy) {
            let errors: Vec<String> = items(&r, "diagnostics")
                .iter()
                .filter(|d| is_error(d))
                .map(coded)
                .collect();
            return Err(tool(format!(
                "the program does not check: {}",
                errors.join("; ")
            )));
        }
        Ok(member(&r, "program"))
    }

    /// The table of codes, the door `codes`, read once.
    fn codes(&mut self) -> Result<JsValue, Fail> {
        if let Some(c) = &self.codes {
            return Ok(c.clone());
        }
        let table = door("codes", JObj::new())?;
        self.codes = Some(table.clone());
        Ok(table)
    }

    /// 0.7: `modulesOf` of `bridge/src/libraries.ts`: the modules of each
    /// library that reads, each module file loaded, the first of a name
    /// kept.
    fn modules_of(libraries: &J) -> Result<JsObject, Fail> {
        let mut out = JsObject::new();
        let J::Arr(list) = libraries else {
            return Ok(out);
        };
        for library in list {
            let verified = door(
                "library_verify",
                JObj::new().with("library", library.clone()),
            )?;
            if verified.get("name").is_none_or(JsValue::is_undefined) {
                continue;
            }
            let Some(J::Obj(files)) = library.get("files") else {
                continue;
            };
            for (path, text) in files.iter() {
                let path = path.to_jstr();
                let kind = kind_of(path.text().unwrap_or_default());
                let loaded = door(
                    "load",
                    JObj::new()
                        .with("text", text.clone())
                        .with("kind", J::str(kind)),
                )?;
                let program = member(&loaded, "program");
                if js_truthy(&program) {
                    let name = member(&program, "module").to_js_string();
                    if out.get(&name).is_none() {
                        out.insert(name, program);
                    }
                }
            }
        }
        Ok(out)
    }

    /// 0.7: what a view is given: the call's modules and, when it gives
    /// libraries, theirs after them (`{ ...modules, ...modulesOf(libraries)
    /// }`, so that a library's module of a name the server or the call has
    /// too is the library's, in the place the name had).
    fn linked(modules: &JsObject, libraries: Option<&J>) -> Result<JsObject, Fail> {
        Ok(match libraries {
            Some(l) => modules.clone().spread(&Server::modules_of(l)?),
            None => modules.clone(),
        })
    }

    /// `callTool`: runs one tool; its structured result, or why it cannot.
    pub(super) fn call_tool(&mut self, name: &str, args: &J) -> Result<JsValue, Fail> {
        let modules = self.modules_for(args)?;
        match name {
            "mandate.check" => {
                let source = str_arg(args, "source")?;
                let libraries = libraries_arg(args)?;
                let r = door(
                    "check",
                    JObj::new()
                        .with("text", J::Str(source.clone()))
                        .with("kind", J::str(kind_for(source, args.get("kind"))))
                        .with(
                            "opts",
                            J::Obj(check_options(&modules, args.get("lock"), libraries)),
                        ),
                )?;
                let hashes = r.get("hashes").filter(|h| js_truthy(h)).cloned();
                Ok(JsObject::new()
                    .with("ok", member(&r, "ok"))
                    .with_some("hashes", hashes)
                    .with("diagnostics", member(&r, "diagnostics"))
                    .into())
            }
            "mandate.explain" => {
                let raw = str_arg(args, "code")?;
                let code = if raw.starts_with("MDT-") {
                    raw.clone()
                } else {
                    JStr::concat(&[&JStr::from("MDT-"), raw])
                };
                let table = self.codes()?;
                let entry = code
                    .text()
                    .and_then(|c| table.get(c))
                    .filter(|e| js_truthy(e));
                let (Some(entry), Some(code)) = (entry, code.text()) else {
                    return Err(Fail::Tool(JStr::concat(&[
                        &JStr::from("unknown code "),
                        raw,
                    ])));
                };
                let row = JsObject::new().with("code", code);
                Ok(match entry.as_object() {
                    Some(e) => row.spread(e),
                    None => row,
                }
                .into())
            }
            "mandate.apply_patch" => {
                let source = str_arg(args, "source")?;
                let loaded = door(
                    "load",
                    JObj::new()
                        .with("text", J::Str(source.clone()))
                        .with("kind", J::str(kind_for(source, args.get("kind")))),
                )?;
                let program = member(&loaded, "program");
                if !js_truthy(&program) || items(&loaded, "diagnostics").iter().any(is_error) {
                    return Ok(JsObject::new()
                        .with("ok", false)
                        .with("diagnostics", member(&loaded, "diagnostics"))
                        .with("governance", JsValue::Array(Vec::new()))
                        .into());
                }
                let Some(ops @ J::Arr(_)) = args.get("ops") else {
                    return Err(tool("ops must be a list of RFC 6902 operations"));
                };
                let base = str_arg(args, "base")?;
                door(
                    "check_patch",
                    JObj::new()
                        .with("program", J::Js(program))
                        .with("base", J::Str(base.clone()))
                        .with("ops", ops.clone())
                        .with("modules", J::Js(JsValue::Object(modules))),
                )
            }
            "mandate.caps_of" => {
                let source = str_arg(args, "source")?;
                // 0.7: the lock and the libraries, as `check` and `project`
                // take them.
                let libraries = libraries_arg(args)?;
                let p = self.program(
                    source,
                    args.get("kind"),
                    &modules,
                    args.get("lock"),
                    libraries,
                )?;
                let who = str_arg(args, "name")?;
                let linked = Server::linked(&modules, libraries)?;
                let view = door(
                    "authority",
                    JObj::new()
                        .with("program", J::Js(p.clone()))
                        .with_some("modules", view_modules(&linked, &[&p]))
                        .with_some("std_patterns", std_patterns_of(args.get("lock"))),
                )?;
                let remote = JStr::concat(&[who, &JStr::from(" (remote)")]);
                let delegated = JStr::concat(&[who, &JStr::from(" → ")]);
                let rows: Vec<JsValue> = items(&view, "rows")
                    .iter()
                    .filter(|r| {
                        let w = r.get("who").and_then(JsValue::as_str).unwrap_or_default();
                        Some(w) == who.text()
                            || Some(w) == remote.text()
                            || delegated.text().is_some_and(|d| w.starts_with(d))
                    })
                    .cloned()
                    .collect();
                if rows.is_empty() {
                    return Err(Fail::Tool(JStr::concat(&[
                        who,
                        &JStr::from(" is not an agent or workflow of this program"),
                    ])));
                }
                let program = door("program_ref", JObj::new().with("p", J::Js(p)))?;
                Ok(JsObject::new()
                    .with("program", program)
                    .with("rows", JsValue::Array(rows))
                    .into())
            }
            "mandate.project" => self.project(args, &modules),
            "mandate.spec" => {
                let text = spec_text(args.get("section"))?;
                Ok(JsObject::new().with("text", text).into())
            }
            _ => Err(tool(format!("no tool {name}"))),
        }
    }

    /// `mandate.project`: a view of the program, or the diff from `before`.
    fn project(&self, args: &J, modules: &JsObject) -> Result<JsValue, Fail> {
        let lock = args.get("lock");
        let source = str_arg(args, "source")?;
        let libraries = libraries_arg(args)?;
        let p = self.program(source, args.get("kind"), modules, lock, libraries)?;
        // 0.7: a view is given the modules of the libraries too.
        let linked = Server::linked(modules, libraries)?;
        // 0.7: every view reads std.patterns at the version the lock pins.
        let pin = std_patterns_of(lock);
        let view = args.get("view").and_then(J::as_jstr).and_then(JStr::text);
        match view {
            // 0.6: a workflow that applies a pattern of a module is shown,
            // and compared, as its expansion.
            Some("architecture") => door(
                "architecture",
                JObj::new()
                    .with("program", J::Js(p.clone()))
                    .with_some("modules", view_modules(&linked, &[&p]))
                    .with_some("std_patterns", pin),
            ),
            Some("authority") => door(
                "authority",
                JObj::new()
                    .with("program", J::Js(p.clone()))
                    .with_some("modules", view_modules(&linked, &[&p]))
                    .with_some("std_patterns", pin),
            ),
            Some("cost") => door(
                "cost",
                JObj::new()
                    .with("program", J::Js(p.clone()))
                    .with_some("lock", lock.cloned())
                    .with_some("modules", view_modules(&linked, &[&p]))
                    .with_some("std_patterns", pin),
            ),
            Some("diff") => {
                let before = str_arg(args, "before")?;
                let before =
                    self.program(before, args.get("before_kind"), modules, None, libraries)?;
                door(
                    "semantic_diff",
                    JObj::new()
                        .with("before", J::Js(before.clone()))
                        .with("after", J::Js(p.clone()))
                        .with_some("modules", view_modules(&linked, &[&before, &p]))
                        .with_some("std_patterns", pin),
                )
            }
            // 0.7: the envelope card of one workflow.
            Some("card") => {
                let workflow = str_arg(args, "workflow")?;
                let opts = JObj::new()
                    .with("modules", J::Js(JsValue::Object(linked)))
                    .with_some("lock", lock.filter(|l| l.truthy()).cloned());
                let card = door(
                    "card",
                    JObj::new()
                        .with("program", J::Js(p))
                        .with("workflow", J::Str(workflow.clone()))
                        .with("opts", J::Obj(opts)),
                )?;
                if card.is_null() {
                    return Err(Fail::Tool(JStr::concat(&[
                        workflow,
                        &JStr::from(" is not a workflow with an envelope of this program"),
                    ])));
                }
                Ok(card)
            }
            Some("attention") => Err(attention_view()),
            _ => Err(tool(VIEWS)),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic, clippy::arithmetic_side_effects)]

    use mandate_ir::JsValue;

    use super::{Fail, MAX_ANSWER_BYTES, answer_bytes, answer_cap};

    #[test]
    fn an_answer_the_host_would_not_take_is_its_failure_in_its_words() {
        // `{"ok":true,"output":` and `}` around the output: 21 bytes.
        let around = r#"{"ok":true,"output":}"#.len();
        assert_eq!(answer_bytes(&Ok(JsValue::Null)), around + 4);
        assert_eq!(answer_bytes(&Ok(JsValue::Undefined)), around + 4);
        // A string of n characters is written in n + 2 bytes.
        let fits = MAX_ANSWER_BYTES - around - 2;
        let at = Ok(JsValue::String("a".repeat(fits)));
        assert_eq!(answer_bytes(&at), MAX_ANSWER_BYTES);
        assert!(answer_cap("check", &at).is_ok());
        let over = Ok(JsValue::String("a".repeat(fits + 1)));
        match answer_cap("check", &over) {
            Err(Fail::Internal(m)) => assert_eq!(
                m.text(),
                Some(
                    "the Rust compiler failed on check (output_too_large): the answer passed 67108864 bytes and the call was stopped"
                )
            ),
            other => panic!("{other:?}"),
        }
        // A character from U+0080 up counts its UTF-8 bytes.
        let wide = Ok(JsValue::String("é".repeat(fits / 2 + 1)));
        assert!(answer_cap("load", &wide).is_err());
    }
}
