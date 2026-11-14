//! The ACS target: each local agent's per-call rules written as an Agent
//! Control Specification manifest and a Rego policy (`compiler/src/target/acs.ts`,
//! lines 1-422; `spec/executors.md` "ACS target"; `mandate target acs`).
//!
//! The function [`acs_target`] gives an [`AcsTarget`] whose `to_js` builds the
//! object `acsTarget` returns, in its member order, and the Rego text of every
//! agent is the text the TypeScript writes, byte for byte. That equality is
//! what carries over to this port the evidence that the TypeScript's Rego,
//! evaluated on a real OPA in CI (`compiler/test/acs.test.ts`, case X05),
//! says what it should; there is deliberately no second OPA step for the Rust.
//!
//! JavaScript imitated here, besides what `mandate_check::sandbox` does:
//!
//! - `Object.entries` of the requirements, and so the order in which Rego
//!   package names are made unique, is the order of an object: names that are
//!   array indices first, ascending, then the others as they were assigned
//!   (a requirement named `__proto__` is not there: `sandbox_requirements`
//!   leaves it out, as the assignment sets a prototype and adds no member);
//! - `name.toLowerCase().replace(/[^a-z0-9_]/g, "_")` replaces each UTF-16
//!   code unit, so a character outside the Basic Multilingual Plane becomes
//!   two underscores, and U+0130 (which lowercases to `i` and a combining
//!   dot) becomes `i_`;
//! - `Math.max` of numbers that may be `NaN` (a budget that is not a number
//!   reads as `ToNumber` reads it), a `NaN` limit being written as `null`;
//! - `[...new Set(xs)].sort()` with no comparator: values by `String(x)` in
//!   UTF-16 order, `undefined` last, written as `null`;
//! - `commands[name] = ...` on a plain object, where a command named
//!   `__proto__` sets the prototype of `commands` and adds no member;
//! - `JSON.stringify` of strings, arrays and objects, and of numbers (a
//!   price in micros divided by a million, a time in milliseconds by a
//!   thousand).
//!
//! The one difference: where the TypeScript throws on an input that `check`
//! refuses, this reads nothing, as the neighbouring ports do. A program that
//! is no program has no agent; a model tier of the lock whose list holds
//! `null` is read as holding nothing there (the TypeScript throws a
//! `TypeError`), so the policy, which fails closed, denies a model it does not
//! list; an agent without `skills` has no skill budgets; a budget member that
//! is not an object reads as having no members.

use std::collections::HashSet;

use mandate_check::{
    DATA_CLASSES, DataClass, Modules, ProfileLevel, SandboxRequirement, class_rank, js_text,
    json_string, link, own, packaged_lock, sandbox_requirements,
};
use mandate_ir::{
    Diagnostic, JsObject, JsValue, Location, Program, Value, compare_utf16, hash_program,
    package_hash, stringify,
};

use crate::shown::{num, texts};

/// `ACS_TARGET_FORMAT`: the format of the target.
pub const ACS_TARGET_FORMAT: &str = "mandate/acs-target/0.1";

/// `ACS_VERSION`: the ACS manifest contract the target writes; the engine
/// AGT 5.0 pins (agent-control-spec 0.4.0-alpha.4) reads it.
pub const ACS_VERSION: &str = "0.4.0-alpha.1";

/// `ACS_PROFILE` (lines 48-67): how each guarantee holds when an agent's
/// calls are governed by an ACS host alone, in the order of the TypeScript.
/// Every level that is not `Full` relies on the host: ACS trusts the
/// snapshot its host builds and the counters its host keeps (ACS section 21).
pub const ACS_PROFILE: [(&str, ProfileLevel); 18] = [
    ("package.identity", ProfileLevel::Partial),
    ("static.checks", ProfileLevel::Full),
    ("caps.paths_commands", ProfileLevel::Partial),
    ("caps.delegation_narrowing", ProfileLevel::None),
    ("caps.network", ProfileLevel::None),
    ("parallel.isolation", ProfileLevel::None),
    ("model.pinning", ProfileLevel::Partial),
    ("model.max_class", ProfileLevel::Partial),
    ("budget.tokens_spend", ProfileLevel::Partial),
    ("budget.steps", ProfileLevel::None),
    ("budget.time", ProfileLevel::Partial),
    ("loop.progress", ProfileLevel::None),
    ("journal.turns", ProfileLevel::None),
    ("replay.no_adapter", ProfileLevel::None),
    ("evidence.verifier", ProfileLevel::None),
    ("effects.prepare_authorize_commit", ProfileLevel::None),
    ("credentials.control_plane", ProfileLevel::None),
    ("cancel", ProfileLevel::None),
];

/// `ACS_PROFILE_NOTES` (lines 70-89): why each level is what it is, for the
/// profile the target writes, in the order of [`ACS_PROFILE`].
pub const ACS_PROFILE_NOTES: [(&str, &str); 18] = [
    (
        "package.identity",
        "every rule requires envelope.agent.version to be the package hash; the host asserts it",
    ),
    (
        "static.checks",
        "the compiler checks the program before it writes the target",
    ),
    (
        "caps.paths_commands",
        "checked at every pre_tool_call, at the agent's declared scope; the host must call it for every tool call",
    ),
    (
        "caps.delegation_narrowing",
        "a manifest is per agent at its declared upper bound; `with caps` narrowing needs the Mandate runtime",
    ),
    (
        "caps.network",
        "ACS does not enforce a sandbox; the sandbox requirement is written beside the manifest for the host's sandbox",
    ),
    (
        "parallel.isolation",
        "disjoint writes across parallel delegations need the Mandate runtime",
    ),
    (
        "model.pinning",
        "pre_model_call checks the model's name against the lock; effort is not in the snapshot",
    ),
    (
        "model.max_class",
        "every label entering at `input` must be at most the agent's max_class; the host propagates labels",
    ),
    (
        "budget.tokens_spend",
        "the host's counters must be under the limits; they are settled after a call, so one call can overshoot",
    ),
    ("budget.steps", "ACS counts tool calls, not model turns"),
    ("budget.time", "the host's elapsed_seconds counter"),
    (
        "loop.progress",
        "repeated calls and stalls need state; ACS is stateless",
    ),
    ("journal.turns", "needs the Mandate runtime"),
    ("replay.no_adapter", "needs the Mandate runtime"),
    (
        "evidence.verifier",
        "needs the Mandate runtime; an ACS verdict's evidence is opaque",
    ),
    (
        "effects.prepare_authorize_commit",
        "the agent gets no effect tool (any tool outside the grant is denied); committing an effect needs the Mandate runtime",
    ),
    (
        "credentials.control_plane",
        "where credentials live is the host's",
    ),
    ("cancel", "the host's"),
];

/// One agent's part of the target: `AcsAgent`.
#[derive(Clone, Debug, PartialEq)]
pub struct AcsAgent {
    /// The ACS manifest (JSON, which is YAML too).
    pub manifest: JsValue,
    /// The Rego module of the agent's policy bundle.
    pub rego: String,
    /// The agent's sandbox requirement, for the host's sandbox: ACS does not
    /// enforce one.
    pub requirement: SandboxRequirement,
}

impl AcsAgent {
    /// `{ manifest, rego, requirement }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("manifest", self.manifest.clone())
            .with("rego", self.rego.as_str())
            .with("requirement", self.requirement.to_js())
            .into()
    }
}

/// One guarantee of the profile: `AcsTarget["profile"][guarantee]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AcsProfileRow {
    /// The guarantee, such as `caps.network`.
    pub guarantee: &'static str,
    /// How it holds under an ACS host alone.
    pub level: ProfileLevel,
    /// Why it is that level.
    pub note: &'static str,
}

/// What `acsTarget` returns: `AcsTarget`. Its `format` is
/// [`ACS_TARGET_FORMAT`] and its `acs_version` [`ACS_VERSION`].
#[derive(Clone, Debug, PartialEq)]
pub struct AcsTarget {
    /// The program's hash.
    pub program: String,
    /// What a host presents as `envelope.agent.version`: the package hash
    /// with a lock, else the program hash.
    pub binding: String,
    /// The manifest and Rego of each local agent whose rules can be written,
    /// in the order of the members of the object the TypeScript builds.
    pub agents: Vec<(String, AcsAgent)>,
    /// How each guarantee holds, in the order of [`ACS_PROFILE`].
    pub profile: Vec<AcsProfileRow>,
    /// E0906 for each agent left out, then W0907 when there is an agent.
    pub diagnostics: Vec<Diagnostic>,
}

impl AcsTarget {
    /// The part of the agent called `name`.
    #[must_use]
    pub fn agent(&self, name: &str) -> Option<&AcsAgent> {
        self.agents.iter().find(|(n, _)| n == name).map(|(_, a)| a)
    }

    /// `{ format, acs_version, program, binding, agents, profile,
    /// diagnostics }`, as `acsTarget` builds it.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let mut agents = JsObject::new();
        for (name, agent) in &self.agents {
            agents.insert(name.as_str(), agent.to_js());
        }
        let mut profile = JsObject::new();
        for row in &self.profile {
            profile.insert(
                row.guarantee,
                JsObject::new()
                    .with("level", row.level.as_str())
                    .with("note", row.note),
            );
        }
        JsObject::new()
            .with("format", ACS_TARGET_FORMAT)
            .with("acs_version", ACS_VERSION)
            .with("program", self.program.as_str())
            .with("binding", self.binding.as_str())
            .with("agents", agents)
            .with("profile", profile)
            .with(
                "diagnostics",
                JsValue::Array(self.diagnostics.iter().map(Diagnostic::to_js).collect()),
            )
            .into()
    }
}

/// The ACS target of a checked program: one manifest and Rego bundle per
/// local agent. An agent whose rules cannot be written is left out with
/// E0906: a capability without a static scope, or a spend budget in a
/// currency other than USD, the only one ACS counts. W0907 names what the
/// target does not carry: `acsTarget(program, modules, lock)` (lines 116-157).
///
/// `lock` is the lock the program is packaged with, as a value (`None`, or a
/// value that is falsy, for no lock): with one the binding is the package
/// hash and the policy pins the models the lock names.
#[must_use]
pub fn acs_target(program: &Value, modules: Option<&Modules>, lock: Option<&Value>) -> AcsTarget {
    let program_hash = hash_program(program).program;
    // `lock ? packageHash(programHash, packagedLock(lock)) : programHash`,
    // and `!!lock` for the Rego.
    let lock = lock.filter(|l| l.is_truthy());
    let binding = match lock {
        Some(l) => package_hash(&program_hash, &Value::Object(packaged_lock(Some(l)))),
        None => program_hash.clone(),
    };
    let requirements = in_member_order(sandbox_requirements(program, modules, lock));
    let defs = Program::of(program)
        .map(|p| link(p, modules).defs)
        .unwrap_or_default();
    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut agents: Vec<(String, AcsAgent)> = Vec::new();
    let mut packages: HashSet<String> = HashSet::new();
    for (name, req) in requirements {
        let Some(def) = defs.get(&name) else { continue };
        if !req.unbounded.is_empty() {
            diagnostics.push(Diagnostic::new(
                "E0906",
                format!(
                    "{name}'s capabilities {} have no static scope; an ACS rule cannot check a call against them.",
                    req.unbounded.join(", ")
                ),
                Location::path(format!("/defs/{name}/caps")),
                Some(
                    JsObject::new()
                        .with("agent", name.as_str())
                        .with("unbounded", texts(&req.unbounded)),
                ),
            ));
            continue;
        }
        let budget = largest(def);
        if let Some(spend) = &budget.spend
            && spend.currency.and_then(Value::as_str) != Some("USD")
        {
            diagnostics.push(Diagnostic::new(
                "E0906",
                format!(
                    "{name}'s spend budget is in {}; ACS hosts count cost in USD only.",
                    js_text(spend.currency)
                ),
                Location::path(format!("/defs/{name}/budget")),
                Some(
                    JsObject::new()
                        .with("agent", name.as_str())
                        .with("currency", JsValue::from(spend.currency)),
                ),
            ));
            continue;
        }
        let mut pkg = package_name(&name);
        while packages.contains(&pkg) {
            pkg.push('_');
        }
        packages.insert(pkg.clone());
        let models = locked_models(&req, lock);
        let max_class = req
            .models
            .iter()
            .map(|m| m.max_class)
            .fold(DataClass::Public, |a, b| {
                if class_rank(b) > class_rank(a) { b } else { a }
            });
        let manifest = manifest(&name, &pkg, &req, &program_hash, &binding);
        let rego = rego(&RegoInputs {
            pkg: &pkg,
            req: &req,
            budget: &budget,
            models: &models,
            max_class,
            binding: &binding,
            program: &program_hash,
            locked: lock.is_some(),
        });
        agents.push((
            name,
            AcsAgent {
                manifest,
                rego,
                requirement: req,
            },
        ));
    }
    let missing: Vec<String> = ACS_PROFILE
        .iter()
        .filter(|(_, level)| *level == ProfileLevel::None)
        .map(|(g, _)| (*g).to_owned())
        .collect();
    if !agents.is_empty() {
        diagnostics.push(Diagnostic::new(
            "W0907",
            format!(
                "The ACS target does not carry {}: they need the Mandate runtime. A host that governs these agents with ACS alone gives the profile written beside them.",
                missing.join(", ")
            ),
            Location::path(""),
            Some(JsObject::new().with("not_carried", texts(&missing))),
        ));
    }
    let profile = ACS_PROFILE
        .iter()
        .zip(ACS_PROFILE_NOTES.iter())
        .map(|((guarantee, level), (_, note))| AcsProfileRow {
            guarantee,
            level: *level,
            note,
        })
        .collect();
    AcsTarget {
        program: program_hash,
        binding,
        agents,
        profile,
        diagnostics,
    }
}

/// The requirements as `Object.entries` of the object they were assigned to
/// gives them: names that are array indices first, ascending, then the others
/// in the order they were assigned.
fn in_member_order(
    requirements: Vec<(String, SandboxRequirement)>,
) -> Vec<(String, SandboxRequirement)> {
    let order: Vec<String> = requirements
        .iter()
        .map(|(name, _)| (name.as_str(), JsValue::Null))
        .collect::<JsObject>()
        .keys()
        .map(str::to_owned)
        .collect();
    let mut rest = requirements;
    let mut out = Vec::with_capacity(rest.len());
    for name in order {
        if let Some(i) = rest.iter().position(|(n, _)| *n == name) {
            out.push(rest.remove(i));
        }
    }
    out
}

/// `name.toLowerCase().replace(/[^a-z0-9_]/g, "_")`: the name of the Rego
/// package. The expression has no `u` flag, so it replaces each UTF-16 code
/// unit of the lowercased name that is not `a-z`, `0-9` or `_`.
fn package_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    out
}

/// The models the lock names for the tiers an agent may call, each once and
/// sorted: `[...new Set(req.models.flatMap((m) => (m.tier ? (own(lock?.models,
/// m.tier) ?? []) : [])).map((l) => l.model))].sort()`.
///
/// What a tier maps to is a list of models (flattened one level) or one
/// model, which `flatMap` takes as one element; an element's `model` is
/// `undefined` where it has none. The values are compared and sorted as
/// `Set` and `sort()` do, `undefined` last.
fn locked_models(req: &SandboxRequirement, lock: Option<&Value>) -> Vec<JsValue> {
    let models = lock.and_then(|l| l.get("models"));
    let mut found: Vec<JsValue> = Vec::new();
    let mut take = |l: &Value| {
        let model = JsValue::from(l.get("model"));
        if !found.contains(&model) {
            found.push(model);
        }
    };
    for tier in req
        .models
        .iter()
        .filter_map(|m| m.tier.as_deref())
        .filter(|t| !t.is_empty())
    {
        match own(models, tier) {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => {
                // `null.model` throws in JavaScript; here it holds nothing.
                for l in items.iter().filter(|l| !matches!(l, Value::Null)) {
                    take(l);
                }
            }
            Some(one) => take(one),
        }
    }
    let (mut defined, undefined): (Vec<JsValue>, Vec<JsValue>) =
        found.into_iter().partition(|v| !v.is_undefined());
    defined.sort_by(|a, b| compare_utf16(&a.to_js_string(), &b.to_js_string()));
    defined.extend(undefined);
    defined
}

/// The agent's budget as one upper bound, as `Budget` of `largest(a)`: each
/// dimension at its largest over the agent and its skills. A number is a
/// double, as `Math.max` reads it.
struct Bound<'a> {
    tokens: Option<f64>,
    time_ms: Option<f64>,
    spend: Option<Spend<'a>>,
}

/// A spend bound: `{ micros, currency }`.
struct Spend<'a> {
    micros: f64,
    currency: Option<&'a Value>,
}

/// `Math.max(a, b)`: `NaN` when either is, and `+0` over `-0`.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { b } else { a }
    } else if b > a {
        b
    } else {
        a
    }
}

/// `a === b` of two members: equal primitives, or both missing; an array or
/// an object is only equal to itself, and the two are never the same one.
fn same_value(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Array(_) | Value::Object(_)), _)
        | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// `largest(a)` (lines 159-169): `[a.budget, ...skills' budgets]` that are
/// not falsy, folded into the largest of each dimension. A spend in another
/// currency than the first one seen is ignored.
fn largest(a: &Value) -> Bound<'_> {
    let skills: Vec<&Value> = match a.get("skills") {
        Some(Value::Object(m)) => m.iter().map(|(_, v)| v).collect(),
        Some(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    };
    let budgets = std::iter::once(a.get("budget"))
        .chain(skills.into_iter().map(|s| s.get("budget")))
        .flatten()
        .filter(|b| b.is_truthy());
    let mut out = Bound {
        tokens: None,
        time_ms: None,
        spend: None,
    };
    for b in budgets {
        if let Some(tokens) = b.get("tokens") {
            out.tokens = Some(js_max(out.tokens.unwrap_or(0.0), num(Some(tokens))));
        }
        if let Some(time) = b.get("time").filter(|t| t.is_truthy()) {
            out.time_ms = Some(js_max(out.time_ms.unwrap_or(0.0), num(time.get("ms"))));
        }
        if let Some(spend) = b.get("spend").filter(|s| s.is_truthy()) {
            let next = Spend {
                micros: num(spend.get("micros")),
                currency: spend.get("currency"),
            };
            out.spend = Some(match out.spend.take() {
                Some(prev) if same_value(prev.currency, next.currency) => Spend {
                    micros: js_max(prev.micros, next.micros),
                    currency: next.currency,
                },
                Some(prev) => prev,
                None => next,
            });
        }
    }
    out
}

/// `POINTS` (lines 171-180): the intervention points, each with the part of
/// the snapshot its policy reads and the kind of that part.
const POINTS: [(&str, &str, &str); 8] = [
    ("agent_startup", "$.agent_init", "agent"),
    ("input", "$.input", "input"),
    ("pre_model_call", "$.model", "model_request"),
    ("post_model_call", "$.response", "model_response"),
    ("pre_tool_call", "$.tool_call.args", "tool_args"),
    ("post_tool_call", "$.tool_result", "tool_result"),
    ("output", "$.response", "output"),
    ("agent_shutdown", "$.summary", "summary"),
];

/// `toolsOf(req)` (lines 183-190): the tools of a grant (`runtime/src/tools.ts`,
/// K8), and `finish`.
fn tools_of(req: &SandboxRequirement) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !req.filesystem.read.is_empty() || !req.filesystem.write.is_empty() {
        out.extend(["read_file", "list_dir", "grep"].map(str::to_owned));
    }
    if !req.filesystem.write.is_empty() {
        out.push("write_file".to_owned());
    }
    if !req.exec.is_empty() {
        out.push("run".to_owned());
    }
    out.push("finish".to_owned());
    out
}

/// `manifest(agent, pkg, req, program, binding)` (lines 192-211).
fn manifest(
    agent: &str,
    pkg: &str,
    req: &SandboxRequirement,
    program: &str,
    binding: &str,
) -> JsValue {
    let mut points = JsObject::new();
    for (point, target, kind) in POINTS {
        let mut p = JsObject::new()
            .with("policy_target", target)
            .with("policy_target_kind", kind);
        if point.ends_with("_tool_call") {
            p.insert("tool_name_from", "$.tool_call.name");
        }
        p.insert("policy", JsObject::new().with("id", "mandate"));
        points.insert(point, p);
    }
    // A tool entry's members are host metadata that ACS does not read (Gate
    // 0b); the rules are all in the Rego.
    let mut tools = JsObject::new();
    for t in tools_of(req) {
        let labels = JsValue::Array(vec![JsValue::from(format!("mandate:{t}"))]);
        tools.insert(t, JsObject::new().with("security_labels", labels));
    }
    JsObject::new()
        .with("agent_control_specification_version", ACS_VERSION)
        .with(
            "metadata",
            JsObject::new().with(
                "mandate",
                JsObject::new()
                    .with("format", ACS_TARGET_FORMAT)
                    .with("agent", agent)
                    .with("program", program)
                    .with("binding", binding),
            ),
        )
        .with(
            "policies",
            JsObject::new().with(
                "mandate",
                JsObject::new()
                    .with("type", "rego")
                    .with("bundle", format!("./{agent}"))
                    .with("query", format!("data.mandate.{pkg}.verdict")),
            ),
        )
        .with("intervention_points", points)
        .with("tools", tools)
        .into()
}

/// `JSON.stringify(v)` of a value that is not `undefined`.
fn json_of(v: impl Into<JsValue>) -> String {
    stringify(&v.into()).unwrap_or_default()
}

/// `JSON.stringify` of a list of strings.
fn strings_json(xs: &[String]) -> String {
    json_of(texts(xs))
}

/// What the Rego of one agent is written from: the arguments of `rego` in the
/// TypeScript (lines 224-226).
struct RegoInputs<'a> {
    pkg: &'a str,
    req: &'a SandboxRequirement,
    budget: &'a Bound<'a>,
    models: &'a [JsValue],
    max_class: DataClass,
    binding: &'a str,
    program: &'a str,
    locked: bool,
}

/// `rego(...)` (lines 224-422): the Rego module of an agent's policy.
fn rego(inputs: &RegoInputs<'_>) -> String {
    let RegoInputs {
        pkg,
        req,
        budget,
        models,
        max_class,
        binding,
        program,
        locked,
    } = *inputs;
    let mut commands = JsObject::new();
    for e in &req.exec {
        // `commands["__proto__"] = [...]` sets a prototype and adds no member.
        if e.command == "__proto__" {
            continue;
        }
        let prefixes = match &e.args_prefix {
            Some(lists) => lists.iter().map(|l| texts(l)).collect(),
            None => vec![JsValue::Null],
        };
        commands.insert(e.command.as_str(), JsValue::Array(prefixes));
    }
    let commands = json_of(commands);
    let mut limits = JsObject::new();
    if let Some(tokens) = budget.tokens {
        limits.insert("token_count", tokens);
    }
    if let Some(spend) = &budget.spend {
        limits.insert("cost_usd", spend.micros / 1_000_000.0);
    }
    if let Some(ms) = budget.time_ms {
        limits.insert("elapsed_seconds", ms / 1000.0);
    }
    let limits = json_of(limits);
    let models = json_of(JsValue::Array(models.to_vec()));
    let max_class = max_class.as_str();
    let lattice = json_of(
        DATA_CLASSES
            .iter()
            .fold(JsObject::new(), |o, c| o.with(c.as_str(), class_rank(*c))),
    );
    let cwd = req
        .filesystem
        .read
        .first()
        .or_else(|| req.filesystem.write.first())
        .map_or("", String::as_str);
    let mut out = String::new();
    out.push_str(r##"package mandate."##);
    out.push_str(pkg);
    out.push_str(
        r##"

import rego.v1

# Generated by `mandate target acs` ("##,
    );
    out.push_str(ACS_TARGET_FORMAT);
    out.push_str(
        r##") from program
# "##,
    );
    out.push_str(program);
    out.push_str(
        r##".
# Do not edit: the policy is a projection of the program, and a changed rule
# is a changed program. Every rule fails closed: a missing field, counter or
# label denies.

binding := "##,
    );
    out.push_str(&json_string(binding));
    out.push_str(
        r##"

cwd := "##,
    );
    out.push_str(&json_string(cwd));
    out.push_str(
        r##"

read_roots := "##,
    );
    out.push_str(&strings_json(&req.filesystem.read));
    out.push_str(
        r##"

write_roots := "##,
    );
    out.push_str(&strings_json(&req.filesystem.write));
    out.push_str(
        r##"

# command -> argument prefixes; null allows any arguments.
commands := "##,
    );
    out.push_str(&commands);
    out.push_str(
        r##"

tools := "##,
    );
    out.push_str(&strings_json(&tools_of(req)));
    out.push_str(
        r##"

# The host's counters (AGT-SNAPSHOT §1) and their limits from the agent's budget.
limits := "##,
    );
    out.push_str(&limits);
    out.push_str(
        r##"

models := "##,
    );
    out.push_str(&models);
    out.push_str(
        r##"

max_class := "##,
    );
    out.push_str(&json_string(max_class));
    out.push_str(
        r##"

lattice := "##,
    );
    out.push_str(&lattice);
    out.push_str(r##"

deny(reason) := {"decision": "deny", "reason": reason}

allow := {"decision": "allow"}

default verdict := {"decision": "deny", "reason": "mandate_unhandled"}

# The host presents the package hash, so a host that does not know it runs a
# Mandate policy is denied rather than enforcing part of it.
verdict := deny("mandate_binding_mismatch") if {
	not bound
} else := deny("mandate_budget_counter_missing") if {
	counter_missing
} else := deny("mandate_budget_exhausted") if {
	exhausted
} else := point

bound if input.snapshot.envelope.agent.version == binding

# Through a rule: `not` over an undefined reference is not a dependable "missing".
counter_present(counter) if is_number(input.snapshot.envelope.budgets[counter])

counter_missing if {
	some counter, _ in limits
	not counter_present(counter)
}

exhausted if {
	some counter, limit in limits
	input.snapshot.envelope.budgets[counter] >= limit
}

default point := {"decision": "deny", "reason": "mandate_unhandled"}

point := allow if input.intervention_point in ["agent_startup", "post_model_call", "post_tool_call", "output", "agent_shutdown"]

point := ingress if input.intervention_point == "input"

point := model_call if input.intervention_point == "pre_model_call"

point := tool_call if input.intervention_point == "pre_tool_call"

# What enters the agent carries its labels, and none may be above max_class.
default ingress := {"decision": "deny", "reason": "mandate_labels_missing"}

ingress := allow if {
	labels := input.snapshot.input.ifc.source_labels
	is_array(labels)
	count(labels) > 0
	every label in labels {
		lattice[label] <= lattice[max_class]
	}
} else := deny("mandate_data_class") if {
	count(input.snapshot.input.ifc.source_labels) > 0
}

"##);
    if locked {
        out.push_str(
            r##"default model_call := {"decision": "deny", "reason": "mandate_model_not_locked"}

model_call := allow if input.snapshot.model.name in models"##,
        );
    } else {
        out.push_str(
            r##"# Without a lock no model is pinned (profile: model.pinning).
model_call := allow"##,
        );
    }
    out.push_str(
        r##"

default tool_call := {"decision": "deny", "reason": "mandate_outside_grant"}

tool_call := allow if {
	tool_name in tools
	tool_ok
}

tool_name := input.snapshot.tool_call.name

tool_args := input.policy_target.value

tool_ok if tool_name == "finish"

tool_ok if {
	tool_name in ["read_file", "list_dir"]
	readable(tool_args.path)
}

tool_ok if {
	tool_name == "grep"
	is_string(tool_args.pattern)
	readable(tool_args.path)
}

tool_ok if {
	tool_name == "write_file"
	is_string(tool_args.content)
	writable(tool_args.path)
}

tool_ok if {
	tool_name == "run"
	command_ok(tool_args.command, tool_args.args)
}

resolved(p) := p if startswith(p, "/")

resolved(p) := concat("/", [cwd, p]) if not startswith(p, "/")

# A path is taken as written: no ".", "..", or empty segment.
bad_segment(segments) if {
	some s in segments
	s in [".", ".."]
}

bad_segment(segments) if {
	some i, s in segments
	i > 0
	s == ""
}

clean(p) if not bad_segment(split(p, "/"))

inside(p, root) if p == root

inside(p, root) if {
	root == "/"
	startswith(p, "/")
}

inside(p, root) if startswith(p, concat("", [root, "/"]))

readable(p) if {
	is_string(p)
	r := resolved(p)
	clean(r)
	some root in array.concat(read_roots, write_roots)
	inside(r, root)
}

writable(p) if {
	is_string(p)
	r := resolved(p)
	clean(r)
	some root in write_roots
	inside(r, root)
}

command_ok(command, args) if {
	is_string(command)
	is_array(args)
	every a in args {
		is_string(a)
	}
	some prefix in commands[command]
	prefix_ok(prefix, args)
}

prefix_ok(prefix, _) if prefix == null

prefix_ok(prefix, args) if {
	is_array(prefix)
	count(args) >= count(prefix)
	every i, x in prefix {
		args[i] == x
	}
}
"##,
    );
    out
}
