//! The system view: the components with their owners, the interfaces with
//! provider and consumers, and the environments with their reads and the
//! weakest authorization each effect accepts there; with modules, the
//! imported system model with its module hash (design doc 9 §8.1;
//! `compiler/src/views/views.ts`, lines 1142-1243).

use mandate_check::{Modules, ProgramRef, VIEW_FORMAT, is_system, js_text, link, program_ref};
use mandate_ir::{
    ComponentDef, EnvironmentDef, JsObject, JsValue, Program, Value, compare_utf16, hash_program,
    sort_utf16, unique_in_order,
};

use crate::doc::{Block, Cell};
use crate::shown::{js, list, mermaid_text, show_command, texts, type_text};

/// One component of the system model.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemComponent {
    /// Its name.
    pub name: String,
    /// The git repository, `owner/name`.
    pub repo: String,
    /// Where its working copy sits.
    pub root: String,
    /// Its language.
    pub lang: String,
    /// The role that owns it.
    pub owner: String,
    /// How it builds, one command a line.
    pub build: Vec<String>,
    /// How it tests, one command a line.
    pub test: Vec<String>,
    /// The interfaces it provides.
    pub provides: Vec<String>,
    /// The interfaces it consumes.
    pub consumes: Vec<String>,
    /// Its own governance-class patterns, beyond the language's defaults
    /// (K70).
    pub governance: Vec<String>,
}

/// One interface of the system model.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemInterface {
    /// Its name.
    pub name: String,
    /// Its protocol.
    pub protocol: String,
    /// Where it is specified.
    pub spec: String,
    /// The first component that provides it, by name.
    pub provider: Option<String>,
    /// The components that consume it, by name.
    pub consumers: Vec<String>,
}

/// One read of an environment.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemRead {
    /// Its name.
    pub name: String,
    /// The component it reads from.
    pub from: String,
    /// `sql` or `logs`.
    pub kind: &'static str,
    /// Its parameters, `name: type` each.
    pub params: String,
    /// The type of a row.
    pub returns: String,
    /// The most rows it returns, as read.
    pub max_rows: JsValue,
}

/// One effect an environment authorizes, and how weakly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemAuthorize {
    /// The effect.
    pub effect: String,
    /// `policy` or `a person (role)`.
    pub tier: String,
}

/// One environment of the system model.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemEnvironment {
    /// Its name.
    pub name: String,
    /// The highest data class it holds.
    pub class: String,
    /// Its reads.
    pub reads: Vec<SystemRead>,
    /// The weakest authorization each effect accepts there.
    pub authorize: Vec<SystemAuthorize>,
}

/// The system a program works on: `SystemView`.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemView {
    /// The program it shows.
    pub program: ProgramRef,
    /// The modules the system model comes from, as `(module, hash)`; empty
    /// when the program defines it itself.
    pub modules: Vec<(String, String)>,
    /// The components, by name.
    pub components: Vec<SystemComponent>,
    /// The interfaces, by name.
    pub interfaces: Vec<SystemInterface>,
    /// The environments, by name.
    pub environments: Vec<SystemEnvironment>,
    /// The consumption graph: an edge from consumer to provider, labelled
    /// with the interface.
    pub mermaid: String,
}

impl SystemView {
    /// `{ format, kind, program, modules, components, interfaces,
    /// environments, mermaid }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let array = |items: Vec<JsValue>| JsValue::Array(items);
        JsObject::new()
            .with("format", VIEW_FORMAT)
            .with("kind", "system")
            .with("program", self.program.to_js())
            .with(
                "modules",
                array(
                    self.modules
                        .iter()
                        .map(|(m, h)| {
                            JsObject::new()
                                .with("module", m.as_str())
                                .with("hash", h.as_str())
                                .into()
                        })
                        .collect(),
                ),
            )
            .with(
                "components",
                array(
                    self.components
                        .iter()
                        .map(|c| {
                            JsObject::new()
                                .with("name", c.name.as_str())
                                .with("repo", c.repo.as_str())
                                .with("root", c.root.as_str())
                                .with("lang", c.lang.as_str())
                                .with("owner", c.owner.as_str())
                                .with("build", texts(&c.build))
                                .with("test", texts(&c.test))
                                .with("provides", texts(&c.provides))
                                .with("consumes", texts(&c.consumes))
                                .with("governance", texts(&c.governance))
                                .into()
                        })
                        .collect(),
                ),
            )
            .with(
                "interfaces",
                array(
                    self.interfaces
                        .iter()
                        .map(|i| {
                            JsObject::new()
                                .with("name", i.name.as_str())
                                .with("protocol", i.protocol.as_str())
                                .with("spec", i.spec.as_str())
                                .with(
                                    "provider",
                                    i.provider.as_deref().map_or(JsValue::Null, JsValue::from),
                                )
                                .with("consumers", texts(&i.consumers))
                                .into()
                        })
                        .collect(),
                ),
            )
            .with(
                "environments",
                array(
                    self.environments
                        .iter()
                        .map(|e| {
                            JsObject::new()
                                .with("name", e.name.as_str())
                                .with("class", e.class.as_str())
                                .with(
                                    "reads",
                                    array(
                                        e.reads
                                            .iter()
                                            .map(|r| {
                                                JsObject::new()
                                                    .with("name", r.name.as_str())
                                                    .with("from", r.from.as_str())
                                                    .with("kind", r.kind)
                                                    .with("params", r.params.as_str())
                                                    .with("returns", r.returns.as_str())
                                                    .with("max_rows", r.max_rows.clone())
                                                    .into()
                                            })
                                            .collect(),
                                    ),
                                )
                                .with(
                                    "authorize",
                                    array(
                                        e.authorize
                                            .iter()
                                            .map(|a| {
                                                JsObject::new()
                                                    .with("effect", a.effect.as_str())
                                                    .with("tier", a.tier.as_str())
                                                    .into()
                                            })
                                            .collect(),
                                    ),
                                )
                                .into()
                        })
                        .collect(),
                ),
            )
            .with("mermaid", self.mermaid.as_str())
            .into()
    }
}

/// A member that is a string, as the view holds it (`undefined` for none is
/// not a string a validated program lacks).
fn string_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// `xs.map(showCommand)` of a component's `build` or `test`.
fn commands<'a>(list: Option<impl Iterator<Item = mandate_ir::Command<'a>>>) -> Vec<String> {
    list.into_iter()
        .flatten()
        .map(|c| {
            let args: Vec<&str> = c.args().collect();
            show_command(c.command().unwrap_or_default(), &args)
        })
        .collect()
}

/// The system a program works on: `system(program, modules)`. With
/// `modules`, the imported system model is shown with its module hash. A
/// value that is no program shows no system.
#[must_use]
pub fn system(program: &Value, modules: Option<&Modules>) -> SystemView {
    let Some(p) = Program::of(program) else {
        return SystemView {
            program: program_ref(program),
            modules: Vec::new(),
            components: Vec::new(),
            interfaces: Vec::new(),
            environments: Vec::new(),
            mermaid: "flowchart LR".to_owned(),
        };
    };
    let linked = link(p, modules);
    let mut defs: Vec<(&str, &Value)> = linked.defs.iter().collect();
    defs.sort_by(|a, b| compare_utf16(a.0, b.0));
    let of_kind = |kind: &str| -> Vec<(&str, &Value)> {
        defs.iter()
            .copied()
            .filter(|(_, d)| d.get("kind").and_then(Value::as_str) == Some(kind))
            .collect()
    };
    let comps: Vec<(&str, ComponentDef<'_>)> = of_kind("component")
        .into_iter()
        .filter_map(|(n, d)| ComponentDef::of(d).map(|c| (n, c)))
        .collect();
    let components: Vec<SystemComponent> = comps
        .iter()
        .map(|(name, c)| SystemComponent {
            name: (*name).to_owned(),
            repo: c.repo().unwrap_or_default().to_owned(),
            root: c.root().unwrap_or_default().to_owned(),
            lang: c.lang().unwrap_or_default().to_owned(),
            owner: c.owner().unwrap_or_default().to_owned(),
            build: commands(c.build()),
            test: commands(c.test()),
            provides: c.provides().map(str::to_owned).collect(),
            consumes: c.consumes().map(str::to_owned).collect(),
            governance: c.governance().map(str::to_owned).collect(),
        })
        .collect();
    let interfaces: Vec<SystemInterface> = of_kind("interface")
        .into_iter()
        .map(|(name, i)| SystemInterface {
            name: name.to_owned(),
            protocol: string_of(i.get("protocol")),
            spec: string_of(i.get("spec")),
            provider: comps
                .iter()
                .find(|(_, c)| c.provides().any(|p| p == name))
                .map(|(n, _)| (*n).to_owned()),
            consumers: comps
                .iter()
                .filter(|(_, c)| c.consumes().any(|p| p == name))
                .map(|(n, _)| (*n).to_owned())
                .collect(),
        })
        .collect();
    let environments: Vec<SystemEnvironment> = of_kind("environment")
        .into_iter()
        .filter_map(|(name, d)| EnvironmentDef::of(d).map(|e| (name, e)))
        .map(|(name, e)| SystemEnvironment {
            name: name.to_owned(),
            class: e.class().unwrap_or_default().to_owned(),
            reads: e
                .reads()
                .map(|(rn, r)| {
                    let params: Vec<String> = r
                        .get("params")
                        .and_then(Value::as_array)
                        .unwrap_or_default()
                        .iter()
                        .map(|p| format!("{}: {}", js_text(p.get("name")), param_type(p)))
                        .collect();
                    SystemRead {
                        name: rn.to_owned(),
                        from: string_of(r.get("from")),
                        kind: if r.get("query").is_some_and(|q| q.get("sql").is_some()) {
                            "sql"
                        } else {
                            "logs"
                        },
                        params: params.join(", "),
                        returns: r
                            .get("returns")
                            .map_or_else(|| "union".to_owned(), type_text),
                        max_rows: js(r.get("max_rows")),
                    }
                })
                .collect(),
            authorize: e
                .authorize()
                .map(|(effect, t)| SystemAuthorize {
                    effect: effect.to_owned(),
                    tier: if t.get("by").and_then(Value::as_str) == Some("policy") {
                        "policy".to_owned()
                    } else {
                        format!("a person ({})", js_text(t.get("role")))
                    },
                })
                .collect(),
        })
        .collect();
    let id = |n: &str| format!("c_{n}");
    let mut lines = vec!["flowchart LR".to_owned()];
    for c in &components {
        lines.push(format!(
            "  {}[\"{}<br/>{}\"]",
            id(&c.name),
            mermaid_text(&format!("{} ({})", c.name, c.lang)),
            mermaid_text(&c.owner)
        ));
    }
    for i in &interfaces {
        for consumer in &i.consumers {
            if let Some(provider) = &i.provider {
                lines.push(format!(
                    "  {} -->|{}| {}",
                    id(consumer),
                    mermaid_text(&i.name),
                    id(provider)
                ));
            }
        }
    }
    let mut used = unique_in_order(linked.origin.iter().map(|(_, m)| m.clone()));
    sort_utf16(&mut used);
    SystemView {
        program: program_ref(program),
        modules: used
            .into_iter()
            .map(|m| {
                let hash = modules
                    .and_then(|ms| ms.get(&m))
                    .map(|v| hash_program(v).program)
                    .unwrap_or_default();
                (m, hash)
            })
            .collect(),
        components,
        interfaces,
        environments,
        mermaid: lines.join("\n"),
    }
}

/// `typeText(p.type)` of a parameter.
fn param_type(p: &Value) -> String {
    p.get("type").map_or_else(|| "union".to_owned(), type_text)
}

/// Whether the program has a system model of its own or in the modules it
/// imports: `hasSystem(program, modules)`.
#[must_use]
pub fn has_system(program: &Value, modules: Option<&Modules>) -> bool {
    let Some(p) = Program::of(program) else {
        return false;
    };
    link(p, modules)
        .defs
        .iter()
        .any(|(_, d)| d.get("kind").and_then(Value::as_str).is_some_and(is_system))
}

/// The blocks of the system in a document: `systemBlocks(v)`.
#[must_use]
pub fn system_blocks(v: &SystemView) -> Vec<Block> {
    let head = |cols: &[&str]| cols.iter().map(|c| (*c).to_owned()).collect::<Vec<_>>();
    let plain = |xs: Vec<&str>| xs.into_iter().map(Cell::plain).collect::<Vec<_>>();
    let mut out = vec![Block::H("System".to_owned())];
    if !v.modules.is_empty() {
        let from: Vec<String> = v
            .modules
            .iter()
            .map(|(m, h)| format!("{m} ({h})"))
            .collect();
        out.push(Block::P(format!("System model from {}.", from.join(", "))));
    }
    out.push(Block::Code {
        code: v.mermaid.clone(),
        lang: Some("mermaid".to_owned()),
        untrusted: false,
    });
    out.push(Block::Table {
        head: head(&[
            "Component",
            "Repository",
            "Root",
            "Language",
            "Owner",
            "Build",
            "Test",
            "Provides",
            "Consumes",
        ]),
        rows: v
            .components
            .iter()
            .map(|c| {
                let cells = [
                    c.name.clone(),
                    c.repo.clone(),
                    c.root.clone(),
                    c.lang.clone(),
                    c.owner.clone(),
                    list(&c.build),
                    list(&c.test),
                    list(&c.provides),
                    list(&c.consumes),
                ];
                cells.into_iter().map(Cell::plain).collect()
            })
            .collect(),
    });
    // K70: what a component's owner must approve whatever else authorizes the action.
    let own: Vec<&SystemComponent> = v
        .components
        .iter()
        .filter(|c| !c.governance.is_empty())
        .collect();
    out.push(Block::P(format!(
        "Governance-class files: an action that carries one needs its component owner's approval. The language's own are CI workflows, lockfiles, agent settings, the Mandate lock and CODEOWNERS{}",
        if own.is_empty() {
            "; no component adds any."
        } else {
            "; components add:"
        }
    )));
    if !own.is_empty() {
        out.push(Block::Table {
            head: head(&["Component", "Owner", "Its own governance-class files"]),
            rows: own
                .iter()
                .map(|c| {
                    vec![
                        Cell::plain(c.name.as_str()),
                        Cell::plain(c.owner.as_str()),
                        Cell::plain(list(&c.governance)),
                    ]
                })
                .collect(),
        });
    }
    out.push(Block::Table {
        head: head(&["Interface", "Protocol", "Spec", "Provider", "Consumers"]),
        rows: v
            .interfaces
            .iter()
            .map(|i| {
                vec![
                    Cell::plain(i.name.as_str()),
                    Cell::plain(i.protocol.as_str()),
                    Cell::plain(i.spec.as_str()),
                    Cell::plain(i.provider.as_deref().unwrap_or("none")),
                    Cell::plain(list(&i.consumers)),
                ]
            })
            .collect(),
    });
    for e in &v.environments {
        out.push(Block::P(format!(
            "Environment {}: holds data up to {}.",
            e.name, e.class
        )));
        if !e.reads.is_empty() {
            out.push(Block::Table {
                head: head(&["Read", "From", "Kind", "Parameters", "Row", "Max rows"]),
                rows: e
                    .reads
                    .iter()
                    .map(|r| {
                        let mut cells = plain(vec![&r.name, &r.from, r.kind]);
                        cells.push(Cell::plain(if r.params.is_empty() {
                            "—"
                        } else {
                            r.params.as_str()
                        }));
                        cells.push(Cell::plain(r.returns.as_str()));
                        cells.push(Cell::plain(r.max_rows.to_js_string()));
                        cells
                    })
                    .collect(),
            });
        }
        if !e.authorize.is_empty() {
            out.push(Block::Table {
                head: head(&["Effect", "Authorized at least by"]),
                rows: e
                    .authorize
                    .iter()
                    .map(|a| vec![Cell::plain(a.effect.as_str()), Cell::plain(a.tier.as_str())])
                    .collect(),
            });
        }
    }
    out
}
