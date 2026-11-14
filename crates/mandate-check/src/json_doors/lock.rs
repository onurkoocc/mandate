//! The doors over the lock, the Managed Agents binding and the sandbox:
//! `validate_lock`, `role_lock_checks`, `sandbox_lock_checks`,
//! `binding_checks`, `model_tiers`, `packaged_lock`, `agent_models`,
//! `sandbox_requirements`, `requirement_for` and `denial_diagnostics`.

use mandate_ir::{Definition, JsObject, JsValue, Value};

use super::DoorError;
use super::front::{diagnostics_js, ir};
use super::input::args;
use super::program::{program_of, strings_js};
use crate::lock::Lock;
use crate::modules::Linked;
use crate::sandbox::{RequirementOptions, Subject};

/// The parameters of [`validate_lock`].
pub(super) const VALIDATE_LOCK: &[&str] = &["value"];

/// `validateLock(value)`, `compiler/src/lock.ts`: the lock's schema and
/// the rules after it.
///
/// Input: `{ value: the lock as read (any JSON value) }`.
/// Output: the diagnostics.
pub(super) fn validate_lock(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, VALIDATE_LOCK)?;
    Ok(diagnostics_js(&crate::lock::validate_lock(
        a.value("value")?,
    )))
}

/// The parameters of [`role_lock_checks`].
pub(super) const ROLE_LOCK_CHECKS: &[&str] = &["program", "linked", "lock", "spans"];

/// `roleLockChecks(program, linked, lock, spans)`, `compiler/src/lock.ts`:
/// every role a package names is held by someone in the lock.
///
/// Input: `{ program, linked: { defs, origin: { <definition>: <module> } },
/// lock: object, spans?: { <pointer>: span } }` (`linked` as `link` gives
/// it, its `diagnostics` not read; `spans` a `Map` in the TypeScript).
/// Output: the diagnostics.
pub(super) fn role_lock_checks(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, ROLE_LOCK_CHECKS)?;
    let program = program_of(a.object("program")?)?;
    let l = a.members("linked", "linked.")?;
    let defs = l.map("defs")?.clone();
    let origin = l
        .map("origin")?
        .iter()
        .map(|(name, module)| {
            module
                .as_str()
                .map(|m| (name.to_owned(), m.to_owned()))
                .ok_or_else(|| {
                    DoorError::bad_input(format!("`linked.origin.{name}` is not a string"))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let linked = Linked {
        defs,
        origin,
        diagnostics: Vec::new(),
    };
    let lock = Lock::of(a.object("lock")?);
    let spans = a.opt_spans("spans")?;
    Ok(diagnostics_js(&crate::lock::role_lock_checks(
        program,
        &linked,
        lock,
        spans.as_ref(),
    )))
}

/// The parameters of [`sandbox_lock_checks`].
pub(super) const SANDBOX_LOCK_CHECKS: &[&str] = &["program", "lock"];

/// `sandboxLockChecks(program, lock)`, `compiler/src/lock.ts`: the lock's
/// isolation floors and credential bindings against the program.
///
/// Input: `{ program (its imported definitions linked), lock: object }`.
/// Output: the diagnostics.
pub(super) fn sandbox_lock_checks(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, SANDBOX_LOCK_CHECKS)?;
    let program = program_of(a.object("program")?)?;
    let lock = Lock::of(a.object("lock")?);
    Ok(diagnostics_js(&crate::lock::sandbox_lock_checks(
        program, lock,
    )))
}

/// The parameters of [`binding_checks`].
pub(super) const BINDING_CHECKS: &[&str] = &["program", "lock", "spans"];

/// `bindingChecks(program, lock, spans)`, `compiler/src/target/managed-agents.ts`:
/// the checks a Managed Agents binding needs.
///
/// Input: `{ program, lock: object, spans?: { <pointer>: span } }`.
/// Output: the diagnostics.
pub(super) fn binding_checks(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, BINDING_CHECKS)?;
    let program = program_of(a.object("program")?)?;
    let lock = Lock::of(a.object("lock")?);
    let spans = a.opt_spans("spans")?;
    Ok(diagnostics_js(&crate::managed_agents::binding_checks(
        program,
        lock,
        spans.as_ref(),
    )))
}

/// The parameters of [`model_tiers`].
pub(super) const MODEL_TIERS: &[&str] = &["program"];

/// `modelTiers(program)`, `compiler/src/lock.ts`: the model tiers a
/// program's capabilities name.
///
/// Input: `{ program }`.
/// Output: the tiers, each once, in the order found (a `Set`).
pub(super) fn model_tiers(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, MODEL_TIERS)?;
    let program = program_of(a.object("program")?)?;
    Ok(strings_js(&crate::lock::model_tiers(program)))
}

/// The parameters of [`packaged_lock`].
pub(super) const PACKAGED_LOCK: &[&str] = &["lock"];

/// `packagedLock(lock)`, `compiler/src/lock.ts`: the lock as a package
/// carries it, without its `lock` format field.
///
/// Input: `{ lock?: the lock as read (any JSON value) }`; without one, the
/// lock of a program that has none.
/// Output: the lock, an object.
pub(super) fn packaged_lock(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, PACKAGED_LOCK)?;
    Ok(ir(&Value::Object(crate::lock::packaged_lock(
        a.opt_value("lock"),
    ))))
}

/// The parameters of [`agent_models`].
pub(super) const AGENT_MODELS: &[&str] = &["program", "agent"];

/// `agentModels(program, agent)`, `compiler/src/target/managed-agents.ts`:
/// the model tiers an agent may call and the highest data class it may send
/// them.
///
/// Input: `{ program, agent: an agent definition }`.
/// Output: `{ tiers, maxClass }`.
pub(super) fn agent_models(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, AGENT_MODELS)?;
    let program = program_of(a.object("program")?)?;
    let agent = Definition::of(a.object("agent")?);
    let m = crate::managed_agents::agent_models(program, agent);
    Ok(JsObject::new()
        .with("tiers", strings_js(&m.tiers))
        .with("maxClass", m.max_class.as_str())
        .into())
}

/// The parameters of [`sandbox_requirements`].
pub(super) const SANDBOX_REQUIREMENTS: &[&str] = &["program", "modules", "lock"];

/// `sandboxRequirements(program, modules, lock)`, `compiler/src/target/sandbox.ts`:
/// one sandbox requirement per local agent.
///
/// Input: `{ program, modules?: { <name>: program }, lock?: the lock as read }`.
/// Output: `{ <agent>: SandboxRequirement }`, by agent name sorted.
pub(super) fn sandbox_requirements(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, SANDBOX_REQUIREMENTS)?;
    let program = a.object("program")?;
    let modules = a.opt_modules("modules")?;
    let lock = a.opt_value("lock");
    let r = crate::sandbox::sandbox_requirements(program, modules, lock);
    Ok(crate::sandbox::requirements_to_js(&r).into())
}

/// The parameters of [`requirement_for`].
pub(super) const REQUIREMENT_FOR: &[&str] = &["subject", "caps", "timeoutMs", "opts"];

/// `requirementFor(subject, caps, timeoutMs, opts)`, `compiler/src/target/sandbox.ts`:
/// the sandbox requirement for a set of capabilities.
///
/// Input: `{ subject: { agent: string, def: string }, caps: [CapVal],
/// timeoutMs: number | null, opts?: { language?, lock? } }`; `timeoutMs` is
/// required, and may be `null`.
/// Output: `SandboxRequirement`.
pub(super) fn requirement_for(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, REQUIREMENT_FOR)?;
    let s = a.members("subject", "subject.")?;
    let subject = Subject {
        agent: s.str("agent")?.to_owned(),
        def: s.str("def")?.to_owned(),
    };
    let caps = a.caps("caps")?;
    // An integer of the IR's domain, within ±(2^53−1): a double holds it.
    let timeout_ms = a.int_or_null("timeoutMs")?.map(|ms| ms as f64);
    let mut opts = RequirementOptions::default();
    if let Some(o) = a.opt_members("opts", "opts.")? {
        opts.language = o.opt_language("language")?;
        opts.lock = o.opt_value("lock");
    }
    let r = crate::sandbox::requirement_for(subject, &caps, timeout_ms, &opts);
    Ok(r.to_js().into())
}

/// The parameters of [`denial_diagnostics`].
pub(super) const DENIAL_DIAGNOSTICS: &[&str] = &["program", "report"];

/// `denialDiagnostics(program, report)`, `compiler/src/target/sandbox.ts`:
/// W0311 for what an agent's sandbox denied in learning mode.
///
/// Input: `{ program, report: the denial report as read (any JSON value) }`.
/// Output: the diagnostics; `bad_input` with the TypeScript's message where
/// it throws (a report that is `null`, `denials` that is not a list, a
/// denial that is `null`).
pub(super) fn denial_diagnostics(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, DENIAL_DIAGNOSTICS)?;
    let program = a.object("program")?;
    let report = a.value("report")?;
    crate::sandbox::denial_diagnostics(program, report)
        .map(|d| diagnostics_js(&d))
        .map_err(DoorError::bad_input)
}
