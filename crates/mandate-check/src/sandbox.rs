//! Sandbox requirements (Doc 4 §7.3, §11.2): a port of
//! `compiler/src/target/sandbox.ts`. For each local agent the compiler
//! states, independently of any platform, the upper bound of what the
//! agent's process may touch: paths it reads and writes, commands it may
//! run, hosts it may reach, models it may call, and how long it may run.
//!
//! The compiler does not write MXC or AX policy itself. A pinned, versioned
//! sandbox adapter translates a requirement into its platform's policy after
//! probing what the host can enforce, and refuses to run when a requirement
//! cannot be enforced (INV-11). External effects such as `git.pr` are not
//! part of a sandbox: they go through the runtime's effect broker (§8.8).
//!
//! A 0.5 program's requirement has format 0.2 (spec/boundary.md): the
//! methods each host is limited to, the isolation level the sandbox needs
//! and whether it may share its host, and the credential each host's
//! requests carry, by name. The level and the credentials come from the
//! lock; nothing here sets a floor of its own. Every other program's
//! requirement is format 0.1, as it was.
//!
//! A requirement is written as JSON in a fixed member order
//! ([`SandboxRequirement::to_js`]): `format`, `subject`, `filesystem`,
//! `exec`, `network`, `models`, `ui`, `limits`, `unbounded`, then, in 0.2,
//! `isolation` and `egress`.
//!
//! JavaScript imitated here: `sort(cmp)` on strings by UTF-16 code units,
//! `Map` and `Set` in insertion order, `JSON.stringify` of a model as a key,
//! truthiness of a scope that is an empty array (it is there), `??` on a
//! level that may be `null`, and the plain objects the TypeScript builds
//! (`limited`, `credentials`, `out`), on which assigning a member named
//! `__proto__` sets the prototype and adds no member: such a member is left
//! out, as `JSON.stringify` leaves it out.
//!
//! The lock is read as [`crate::lock`] reads it: a member of the wrong type
//! reads as missing, and a level that is none of [`ISOLATION_LEVELS`] is not
//! higher than any.

use mandate_ir::{
    DefKind, Definition, Diagnostic, Expr, JsObject, JsValue, Language, Location, Program, Value,
    hash_program, sort_utf16, unique_in_order, write_json_string,
};

use crate::caps::{CapOptions, CapVal, caps_of, segments, show_cap, within};
use crate::lock::own;
use crate::modules::{Modules, link};
use crate::stdlib::{DATA_CLASSES, DEFAULT_MODEL_MAX_CLASS, DataClass, class_rank};

/// The format of a sandbox requirement: `SANDBOX_REQUIREMENT_FORMAT`.
pub const SANDBOX_REQUIREMENT_FORMAT: &str = "mandate/sandbox-requirement/0.1";

/// The requirement of a 0.5 program (spec/boundary.md "Sandbox requirement
/// 0.2"): `SANDBOX_REQUIREMENT_FORMAT_0_2`.
pub const SANDBOX_REQUIREMENT_FORMAT_0_2: &str = "mandate/sandbox-requirement/0.2";

/// The format of a report of what sandboxes denied: `SANDBOX_DENIALS_FORMAT`.
pub const SANDBOX_DENIALS_FORMAT: &str = "mandate/sandbox-denials/0.1";

/// An isolation level, weakest first (spec/boundary.md "Isolation level and
/// host fitness"): `IsolationLevel`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IsolationLevel {
    /// `process`.
    Process,
    /// `user_kernel`.
    UserKernel,
    /// `microvm`.
    Microvm,
    /// `dedicated_host`.
    DedicatedHost,
}

impl IsolationLevel {
    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            IsolationLevel::Process => "process",
            IsolationLevel::UserKernel => "user_kernel",
            IsolationLevel::Microvm => "microvm",
            IsolationLevel::DedicatedHost => "dedicated_host",
        }
    }

    /// The level named `name`, if there is one.
    #[must_use]
    pub fn from_name(name: &str) -> Option<IsolationLevel> {
        ISOLATION_LEVELS.into_iter().find(|l| l.as_str() == name)
    }

    /// `ISOLATION_LEVELS.indexOf(level)`.
    #[must_use]
    pub const fn index(self) -> usize {
        match self {
            IsolationLevel::Process => 0,
            IsolationLevel::UserKernel => 1,
            IsolationLevel::Microvm => 2,
            IsolationLevel::DedicatedHost => 3,
        }
    }
}

impl std::fmt::Display for IsolationLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Isolation levels, weakest first: `ISOLATION_LEVELS`.
pub const ISOLATION_LEVELS: [IsolationLevel; 4] = [
    IsolationLevel::Process,
    IsolationLevel::UserKernel,
    IsolationLevel::Microvm,
    IsolationLevel::DedicatedHost,
];

/// Whether a sandbox may share its host: `CoTenancy`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CoTenancy {
    /// `allowed`.
    Allowed,
    /// `forbidden`.
    Forbidden,
}

impl CoTenancy {
    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            CoTenancy::Allowed => "allowed",
            CoTenancy::Forbidden => "forbidden",
        }
    }
}

/// The agent that runs inside, and the hash of its definition:
/// `SandboxRequirement["subject"]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subject {
    /// The agent's name.
    pub agent: String,
    /// The hash of its definition (any text for a requirement made for a
    /// verifier or a command).
    pub def: String,
}

/// What an agent may read and write: absolute paths, normalized by segment,
/// each list sorted, without paths that lie inside another. A write path may
/// also be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Filesystem {
    /// Paths it may read.
    pub read: Vec<String>,
    /// Paths it may write.
    pub write: Vec<String>,
}

/// A command the agent may start, optionally limited to argument prefixes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecGrant {
    /// The command.
    pub command: String,
    /// The argument prefixes it is limited to, when it is limited.
    pub args_prefix: Option<Vec<Vec<String>>>,
}

/// What an agent may reach over HTTPS. Model endpoints are not listed: the
/// adapter maps `models` to them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Network {
    /// The hosts, sorted.
    pub hosts: Vec<String>,
    /// In 0.2, each host that only some methods are allowed for, with them,
    /// in the order of `hosts`; a host it does not list allows any method.
    /// `None` in 0.1, which has no such member.
    pub methods: Option<Vec<(String, Vec<String>)>>,
}

/// A model the agent may call: `{ tier, max_class }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelGrant {
    /// The tier, or none for any.
    pub tier: Option<String>,
    /// The highest data class it may receive.
    pub max_class: DataClass,
}

impl ModelGrant {
    /// `JSON.stringify` of it: what the TypeScript uses as its key.
    fn json(&self) -> String {
        let mut out = String::from("{\"tier\":");
        match &self.tier {
            Some(tier) => write_json_string(&mut out, tier),
            None => out.push_str("null"),
        }
        out.push_str(",\"max_class\":");
        write_json_string(&mut out, self.max_class.as_str());
        out.push('}');
        out
    }

    fn to_js(&self) -> JsObject {
        JsObject::new()
            .with(
                "tier",
                self.tier.as_deref().map_or(JsValue::Null, JsValue::from),
            )
            .with("max_class", self.max_class.as_str())
    }
}

/// The isolation of a 0.2 requirement: the least isolation the sandbox needs
/// (the lock's floor for `data_class` and, when it reaches a host, the
/// lock's floor for an untrusted network), whether it may share its host
/// with other tenants, the highest data class its models may receive, and
/// whether it reaches any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Isolation {
    /// The least level.
    pub min: IsolationLevel,
    /// Whether it may share its host.
    pub co_tenancy: CoTenancy,
    /// The highest data class its models may receive.
    pub data_class: DataClass,
    /// Whether it reaches any host.
    pub untrusted_network: bool,
}

/// The credentials of a 0.2 requirement: the credential each host's requests
/// carry, by the name the lock binds; never a secret.
#[derive(Clone, Debug, PartialEq)]
pub struct Egress {
    /// By host, in the order of `network.hosts`, as the lock has them.
    pub credentials: Vec<(String, JsValue)>,
}

/// A sandbox requirement: `SandboxRequirement`.
#[derive(Clone, Debug, PartialEq)]
pub struct SandboxRequirement {
    /// [`SANDBOX_REQUIREMENT_FORMAT`] or [`SANDBOX_REQUIREMENT_FORMAT_0_2`].
    pub format: &'static str,
    /// The agent that runs inside.
    pub subject: Subject,
    /// Paths it reads and writes.
    pub filesystem: Filesystem,
    /// Commands it may start, sorted by command.
    pub exec: Vec<ExecGrant>,
    /// Hosts it may reach.
    pub network: Network,
    /// Models it may call, sorted by their JSON.
    pub models: Vec<ModelGrant>,
    /// `limits.timeout_ms`: wall-clock limit from the agent's `time`
    /// budget; none when it has none. 0.1 agents never get the desktop or
    /// the clipboard (`ui`).
    pub timeout_ms: Option<f64>,
    /// Capabilities whose scope is not statically known, listed, never
    /// dropped or widened: an adapter must refuse a requirement that has any.
    pub unbounded: Vec<String>,
    /// 0.2: the isolation it needs.
    pub isolation: Option<Isolation>,
    /// 0.2: the credentials its requests carry.
    pub egress: Option<Egress>,
}

fn strings(xs: &[String]) -> JsValue {
    JsValue::Array(xs.iter().map(|x| JsValue::from(x.as_str())).collect())
}

impl SandboxRequirement {
    /// The object the TypeScript builds, its members in its order, written as
    /// `JSON.stringify` writes it.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let exec: Vec<JsValue> = self
            .exec
            .iter()
            .map(|e| {
                JsObject::new()
                    .with("command", e.command.as_str())
                    .with_some(
                        "args_prefix",
                        e.args_prefix.as_ref().map(|lists| {
                            JsValue::Array(lists.iter().map(|l| strings(l)).collect())
                        }),
                    )
                    .into()
            })
            .collect();
        let mut network = JsObject::new().with("hosts", strings(&self.network.hosts));
        if let Some(methods) = &self.network.methods {
            let mut limited = JsObject::new();
            for (host, list) in methods {
                limited.insert(host.as_str(), strings(list));
            }
            network.insert("methods", limited);
        }
        let models: Vec<JsValue> = self.models.iter().map(|m| m.to_js().into()).collect();
        let mut out = JsObject::new()
            .with("format", self.format)
            .with(
                "subject",
                JsObject::new()
                    .with("agent", self.subject.agent.as_str())
                    .with("def", self.subject.def.as_str()),
            )
            .with(
                "filesystem",
                JsObject::new()
                    .with("read", strings(&self.filesystem.read))
                    .with("write", strings(&self.filesystem.write)),
            )
            .with("exec", exec)
            .with("network", network)
            .with("models", models)
            .with(
                "ui",
                JsObject::new()
                    .with("desktop", false)
                    .with("clipboard", false),
            )
            .with(
                "limits",
                JsObject::new().with(
                    "timeout_ms",
                    self.timeout_ms.map_or(JsValue::Null, JsValue::Number),
                ),
            )
            .with("unbounded", strings(&self.unbounded));
        if let Some(iso) = &self.isolation {
            out.insert(
                "isolation",
                JsObject::new()
                    .with("min", iso.min.as_str())
                    .with("co_tenancy", iso.co_tenancy.as_str())
                    .with("data_class", iso.data_class.as_str())
                    .with("untrusted_network", iso.untrusted_network),
            );
        }
        if let Some(egress) = &self.egress {
            let mut credentials = JsObject::new();
            for (host, name) in &egress.credentials {
                credentials.insert(host.as_str(), name.clone());
            }
            out.insert("egress", JsObject::new().with("credentials", credentials));
        }
        out
    }
}

/// What a requirement is read with: the language of the program it is for,
/// and the lock it is packaged with: `RequirementOptions`.
#[derive(Clone, Copy, Debug, Default)]
pub struct RequirementOptions<'a> {
    /// The language of the program; from 0.5 the requirement has format 0.2.
    pub language: Option<Language>,
    /// The lock, as read.
    pub lock: Option<&'a Value>,
}

/// A host's methods while the capabilities are read: `Set<string> | "any"`.
enum HostMethods {
    Any,
    Some(Vec<String>),
}

/// The requirement for a set of capabilities, such as an agent's or a
/// delegate's grant. With a language of 0.5 or later it has format 0.2;
/// otherwise, or without options, it is format 0.1, byte for byte as before:
/// `requirementFor(subject, caps, timeoutMs, opts)`.
#[must_use]
pub fn requirement_for(
    subject: Subject,
    caps: &[CapVal],
    timeout_ms: Option<f64>,
    opts: &RequirementOptions<'_>,
) -> SandboxRequirement {
    let mut read: Vec<String> = Vec::new();
    let mut write: Vec<String> = Vec::new();
    let mut exec: Vec<ExecGrant> = Vec::new();
    let mut hosts: Vec<String> = Vec::new();
    // Per host, the methods it is allowed, or "any" once one capability
    // allows it without methods.
    let mut methods: Vec<(String, HostMethods)> = Vec::new();
    let mut models: Vec<(String, ModelGrant)> = Vec::new();
    let mut unbounded: Vec<String> = Vec::new();
    for c in caps {
        match c.ctor() {
            "fs.read" | "fs.write" => match c.scope() {
                None => unbounded.push(show_cap(c)),
                Some(scope) => {
                    let into = if c.ctor() == "fs.read" {
                        &mut read
                    } else {
                        &mut write
                    };
                    into.extend(scope.iter().map(|p| normalize(p)));
                }
            },
            "exec" => match c.scope() {
                None => unbounded.push(show_cap(c)),
                Some(scope) => {
                    for command in scope {
                        let at = exec.iter().position(|e| e.command == *command);
                        // Two grants of the same command: the union of what
                        // they allow. A grant without prefixes allows any
                        // arguments, so it absorbs any other grant of the
                        // command.
                        let prefixes: Option<Vec<Vec<String>>> = match at.and_then(|i| exec.get(i))
                        {
                            Some(prev) => match (&prev.args_prefix, c.args_prefix()) {
                                (Some(prev), Some(now)) => {
                                    Some(prev.iter().chain(now).cloned().collect())
                                }
                                _ => None,
                            },
                            None => c.args_prefix().map(<[Vec<String>]>::to_vec),
                        };
                        let grant = ExecGrant {
                            command: command.clone(),
                            args_prefix: prefixes.map(unique_lists),
                        };
                        match at.and_then(|i| exec.get_mut(i)) {
                            Some(slot) => *slot = grant,
                            None => exec.push(grant),
                        }
                    }
                }
            },
            "net.https" => match c.scope() {
                None => unbounded.push(show_cap(c)),
                Some(scope) => {
                    hosts.extend(scope.iter().cloned());
                    // Two grants of the same host: the union of what they
                    // allow; one without methods allows any.
                    for h in scope {
                        let at = methods.iter().position(|(m, _)| m == h);
                        let prev = at.and_then(|i| methods.get(i)).map(|(_, m)| m);
                        let next = match (prev, c.methods()) {
                            (Some(HostMethods::Any), _) | (_, None) => HostMethods::Any,
                            (prev, Some(now)) => {
                                let before = match prev {
                                    Some(HostMethods::Some(list)) => list.clone(),
                                    _ => Vec::new(),
                                };
                                HostMethods::Some(unique_in_order(
                                    before.into_iter().chain(now.iter().cloned()),
                                ))
                            }
                        };
                        match at.and_then(|i| methods.get_mut(i)) {
                            Some(slot) => slot.1 = next,
                            None => methods.push((h.clone(), next)),
                        }
                    }
                }
            },
            "model.infer" => {
                let m = ModelGrant {
                    tier: c.tier().map(str::to_owned),
                    max_class: c.max_class().unwrap_or(DEFAULT_MODEL_MAX_CLASS),
                };
                let key = m.json();
                match models.iter_mut().find(|(k, _)| *k == key) {
                    Some(slot) => slot.1 = m,
                    None => models.push((key, m)),
                }
            }
            // git.pr, money.spend: external effects, committed by the
            // runtime's broker, not inside the sandbox.
            _ => {}
        }
    }
    exec.sort_by(|a, b| mandate_ir::compare_utf16(&a.command, &b.command));
    models.sort_by(|a, b| mandate_ir::compare_utf16(&a.0, &b.0));
    let models: Vec<ModelGrant> = models.into_iter().map(|(_, m)| m).collect();
    let mut sorted_hosts = unique_in_order(hosts);
    sort_utf16(&mut sorted_hosts);
    let mut unbounded = unique_in_order(unbounded);
    sort_utf16(&mut unbounded);
    let req = SandboxRequirement {
        format: SANDBOX_REQUIREMENT_FORMAT,
        subject,
        filesystem: Filesystem {
            read: outermost(read),
            write: outermost(write),
        },
        exec,
        network: Network {
            hosts: sorted_hosts,
            methods: None,
        },
        models,
        timeout_ms,
        unbounded,
        isolation: None,
        egress: None,
    };
    if !opts.language.is_some_and(|l| l.at_least(Language::V0_5)) {
        return req;
    }

    // Format 0.2: the fields of 0.1 in their places, then isolation and
    // egress.
    let mut limited: Vec<(String, Vec<String>)> = Vec::new();
    for h in &req.network.hosts {
        let m = methods.iter().find(|(x, _)| x == h).map(|(_, m)| m);
        if let Some(HostMethods::Some(list)) = m {
            let mut list = list.clone();
            sort_utf16(&mut list);
            // `limited[h] = …` on a plain object: `__proto__` is no member.
            if h != "__proto__" {
                limited.push((h.clone(), list));
            }
        }
    }
    let data_class = req
        .models
        .iter()
        .map(|m| m.max_class)
        .fold(DataClass::Public, |a, m| {
            if class_rank(m) > class_rank(a) { m } else { a }
        });
    let untrusted = !req.network.hosts.is_empty();
    let iso = opts.lock.and_then(|l| l.get("isolation"));
    // Floors come from the lock alone; with none, the level is process.
    let floor = floor_for(iso, data_class);
    let network = if untrusted {
        member(iso, "untrusted_network")
            .and_then(level_of)
            .unwrap_or(IsolationLevel::Process)
    } else {
        IsolationLevel::Process
    };
    let bound = own(opts.lock.and_then(|l| l.get("egress")), &req.subject.agent);
    let mut credentials: Vec<(String, JsValue)> = Vec::new();
    for h in &req.network.hosts {
        if let Some(name) = own(bound, h)
            && h != "__proto__"
        {
            credentials.push((h.clone(), JsValue::from(name)));
        }
    }
    SandboxRequirement {
        format: SANDBOX_REQUIREMENT_FORMAT_0_2,
        network: Network {
            hosts: req.network.hosts.clone(),
            methods: Some(limited),
        },
        isolation: Some(Isolation {
            min: higher(floor, network),
            co_tenancy: co_tenancy_for(iso, data_class),
            data_class,
            untrusted_network: untrusted,
        }),
        egress: Some(Egress { credentials }),
        ..req
    }
}

/// `iso?.key` for a lock's `isolation` that may be any value.
fn member<'a>(iso: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    iso.and_then(|i| i.get(key))
}

/// The level a member is, when it is one: a level that is not one of
/// [`ISOLATION_LEVELS`] is at no place in them, and `??` keeps a value that
/// is not `null` or `undefined`.
fn level_of(v: &Value) -> Option<IsolationLevel> {
    v.as_str().and_then(IsolationLevel::from_name)
}

/// The isolation floor a lock's `isolation` gives data of class `c`: the
/// highest floor it sets for `c` or any less sensitive class, since a floor
/// holds for every class above the one it names. `process` when it sets none:
/// `floorFor(iso, c)`. `iso` is the lock's `isolation` member, as read.
#[must_use]
pub fn floor_for(iso: Option<&Value>, c: DataClass) -> IsolationLevel {
    DATA_CLASSES
        .into_iter()
        .filter(|x| class_rank(*x) <= class_rank(c))
        .fold(IsolationLevel::Process, |a, x| {
            let set = own(member(iso, "floor"), x.as_str())
                .and_then(level_of)
                .unwrap_or(IsolationLevel::Process);
            higher(a, set)
        })
}

/// Whether a sandbox with data of class `c` may share its host: not when the
/// lock forbids it for `c` or any less sensitive class: `coTenancyFor(iso,
/// c)`. `iso` is the lock's `isolation` member, as read.
#[must_use]
pub fn co_tenancy_for(iso: Option<&Value>, c: DataClass) -> CoTenancy {
    let forbidden = DATA_CLASSES.into_iter().any(|x| {
        class_rank(x) <= class_rank(c)
            && own(member(iso, "co_tenancy"), x.as_str()).and_then(Value::as_str)
                == Some("forbidden")
    });
    if forbidden {
        CoTenancy::Forbidden
    } else {
        CoTenancy::Allowed
    }
}

/// The stronger of two isolation levels.
fn higher(a: IsolationLevel, b: IsolationLevel) -> IsolationLevel {
    if b.index() > a.index() { b } else { a }
}

/// One requirement per local agent, by agent name, in the order of the names
/// sorted by UTF-16 code units. Remote agents run elsewhere and are bound
/// over A2A, so they get none. The program should already pass `check`.
/// `lock` is the lock it is packaged with: a 0.5 program's requirement reads
/// its isolation floors and credential bindings: `sandboxRequirements(program,
/// modules, lock)`.
///
/// An agent named `__proto__` is left out: the TypeScript assigns its
/// requirement to `out["__proto__"]`, which sets the prototype of `out`.
#[must_use]
pub fn sandbox_requirements(
    program: &Value,
    modules: Option<&Modules>,
    lock: Option<&Value>,
) -> Vec<(String, SandboxRequirement)> {
    let Some(view) = Program::of(program) else {
        return Vec::new();
    };
    let hashes = hash_program(program).defs;
    // Capabilities over components open into paths and commands of the
    // imported system model (doc 9 §2.2).
    let defs = link(view, modules).defs;
    let language = view.language();
    let mut names: Vec<&str> = view.defs().into_iter().flat_map(|d| d.keys()).collect();
    sort_utf16(&mut names);
    let mut out: Vec<(String, SandboxRequirement)> = Vec::new();
    for name in names {
        let Some(def) = view.definition(name) else {
            continue;
        };
        if def.kind() != Some(DefKind::Agent)
            || def.value().get("remote").is_some_and(Value::is_truthy)
        {
            continue;
        }
        let opts = CapOptions { language };
        let held: Vec<CapVal> = def
            .caps()
            .iter()
            .filter_map(Expr::of)
            .flat_map(|e| caps_of(&defs, e, opts))
            .collect();
        let hash = hashes
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, h)| h.clone())
            .unwrap_or_default();
        let req = requirement_for(
            Subject {
                agent: name.to_owned(),
                def: hash,
            },
            &held,
            agent_timeout(def),
            &RequirementOptions {
                language,
                // `...(lock ? { lock } : {})`.
                lock: lock.filter(|l| l.is_truthy()),
            },
        );
        if name != "__proto__" {
            out.push((name.to_owned(), req));
        }
    }
    out
}

/// The requirements as the object `sandboxRequirements` returns, written as
/// `JSON.stringify` writes it.
#[must_use]
pub fn requirements_to_js(requirements: &[(String, SandboxRequirement)]) -> JsObject {
    let mut out = JsObject::new();
    for (name, r) in requirements {
        out.insert(name.as_str(), r.to_js());
    }
    out
}

/// The agent's `time` budget, or the longest of its skills' when every skill
/// has one: `agentTimeout`.
fn agent_timeout(a: Definition<'_>) -> Option<f64> {
    let ms = |budget: Option<&Value>| -> Option<f64> {
        budget
            .and_then(|b| b.get("time"))
            .and_then(|t| t.get("ms"))
            .and_then(Value::as_i64)
            .map(|n| n as f64)
    };
    if let Some(t) = ms(a.value().get("budget")) {
        return Some(t);
    }
    let skills: Vec<Option<f64>> = a.skills().map(|(_, s)| ms(s.get("budget"))).collect();
    if !skills.is_empty() && skills.iter().all(Option::is_some) {
        return Some(
            skills
                .into_iter()
                .flatten()
                .fold(f64::NEG_INFINITY, f64::max),
        );
    }
    None
}

/// A path by its segments; a Windows path keeps its drive (`C:/work/repo`),
/// any other is rooted at `/`: `normalize`.
fn normalize(path: &str) -> String {
    let s = segments(path);
    let drive = s.first().is_some_and(|first| {
        let mut chars = first.chars();
        matches!(
            (chars.next(), chars.next(), chars.next()),
            (Some(c), Some(':'), None) if c.is_ascii_alphabetic()
        )
    });
    if drive {
        s.join("/")
    } else {
        format!("/{}", s.join("/"))
    }
}

/// Sorted, without duplicates, and without paths that lie inside another
/// one: `outermost`.
fn outermost(paths: Vec<String>) -> Vec<String> {
    let mut unique = unique_in_order(paths);
    sort_utf16(&mut unique);
    unique
        .iter()
        .filter(|p| !unique.iter().any(|q| q != *p && within(p, q)))
        .cloned()
        .collect()
}

/// `uniqueLists`: each list once by its JSON text (the last of equal ones),
/// in the order of those texts.
fn unique_lists(lists: Vec<Vec<String>>) -> Vec<Vec<String>> {
    let json = |l: &[String]| {
        let mut out = String::from("[");
        for (i, s) in l.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            write_json_string(&mut out, s);
        }
        out.push(']');
        out
    };
    let mut seen: Vec<(String, Vec<String>)> = Vec::new();
    for l in lists {
        let key = json(&l);
        match seen.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = l,
            None => seen.push((key, l)),
        }
    }
    seen.sort_by(|a, b| mandate_ir::compare_utf16(&a.0, &b.0));
    seen.into_iter().map(|(_, l)| l).collect()
}

/// `String(report.denials)`-free reading of what a call to
/// [`denial_diagnostics`] was given.
fn member_js(v: &Value, key: &str) -> JsValue {
    v.get(key).map_or(JsValue::Undefined, JsValue::from)
}

/// W0311 (§11.3, §12.2): what an agent's sandbox denied in learning mode, as
/// feedback on its policy. One warning per agent, access and resource. A
/// report made for another program is refused, since its agents' policies
/// may differ: `denialDiagnostics(program, report)`.
///
/// `program` is the program as read, `report` the report as read, which may
/// be any JSON value: the TypeScript does not check its type. Where it
/// throws a `TypeError`, this gives the error's message as `Err`: a report
/// that is `null`, a `denials` that is not iterable (not an array or a
/// string), a denial that is `null`.
///
/// # Errors
///
/// The message of the `TypeError` the TypeScript throws.
pub fn denial_diagnostics(program: &Value, report: &Value) -> Result<Vec<Diagnostic>, String> {
    let hash = hash_program(program).program;
    if matches!(report, Value::Null) {
        return Err("Cannot read properties of null (reading 'format')".to_owned());
    }
    if member_js(report, "format") != JsValue::from(SANDBOX_DENIALS_FORMAT) {
        return Ok(vec![Diagnostic::new(
            "E0104",
            format!("A denial report must have format {SANDBOX_DENIALS_FORMAT}."),
            Location::path(""),
            None,
        )]);
    }
    let reported = member_js(report, "program");
    if reported != JsValue::from(hash.as_str()) {
        return Ok(vec![Diagnostic::new(
            "E0104",
            format!(
                "The denial report is for program {}, not {hash}.",
                reported.to_js_string()
            ),
            Location::path(""),
            Some(
                JsObject::new()
                    .with("report", reported)
                    .with("program", hash.as_str()),
            ),
        )]);
    }
    // `for (const d of report.denials)`: an array's elements, or a string's
    // characters.
    let chars: Vec<Value>;
    let denials: &[Value] = match report.get("denials") {
        Some(Value::Array(items)) => items,
        Some(Value::String(s)) => {
            chars = s.chars().map(|c| Value::String(c.to_string())).collect();
            &chars
        }
        _ => return Err("report.denials is not iterable".to_owned()),
    };
    let defs = program.get("defs");
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<Diagnostic> = Vec::new();
    for d in denials {
        if matches!(d, Value::Null) {
            return Err("Cannot read properties of null (reading 'agent')".to_owned());
        }
        let (agent, access, resource) = (
            member_js(d, "agent"),
            member_js(d, "access"),
            member_js(d, "resource"),
        );
        let (agent_text, access_text, resource_text) = (
            agent.to_js_string(),
            access.to_js_string(),
            resource.to_js_string(),
        );
        let key = format!("{agent_text} {access_text} {resource_text}");
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        // `program.defs[d.agent]`.
        let is_agent = own(defs, &agent_text)
            .and_then(|def| def.get("kind"))
            .and_then(Value::as_str)
            == Some("agent");
        let path = if is_agent {
            format!("/defs/{agent_text}/caps")
        } else {
            String::new()
        };
        out.push(Diagnostic::new(
            "W0311",
            format!(
                "In learning mode, {agent_text}'s sandbox denied {access_text} of {resource_text}: its policy does not allow it. If {agent_text} needs it, its capability must grow (a governance change); if not, it reached too far."
            ),
            Location::path(path),
            Some(
                JsObject::new()
                    .with("agent", agent)
                    .with("access", access)
                    .with("resource", resource),
            ),
        ));
    }
    Ok(out)
}
