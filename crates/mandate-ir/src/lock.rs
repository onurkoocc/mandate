//! `validateLock` in `compiler/src/lock.ts`, and the lock formats it reads.
//!
//! It lives here, beside the schema it applies, because it needs nothing
//! but the lock as a [`Value`]: a lock the schema refuses gets one E0140
//! for each raw error, in Ajv's order, with no sorting, dropping or
//! deduplication ([`lock_schema_diagnostics`]); one it accepts is held to the
//! rules the schema cannot say ([`validate_lock`]): the lock format a field
//! needs, a key under two members, a role's members, a tier's tariff. A lock
//! gives no spans, so `at` is `{ path }`.

use crate::diag::{Diagnostic, Location};
use crate::js_value::{JsObject, JsValue};
use crate::schema::lock_schema_errors;
use crate::text::trim;
use crate::value::Value;

/// The lock format this compiler writes: `LOCK_FORMAT`.
pub const LOCK_FORMAT: &str = "mandate/lock/0.5";

/// The lock formats it reads, oldest first: `LOCK_FORMATS`. 0.2 has no
/// bindings, 0.3 no members or roles, and 0.4 no host, isolation or egress.
pub const LOCK_FORMATS: [&str; 4] = [
    "mandate/lock/0.2",
    "mandate/lock/0.3",
    "mandate/lock/0.4",
    "mandate/lock/0.5",
];

/// The lock fields of format 0.5 (spec/boundary.md "Lock 0.5"):
/// `LOCK_FIELDS_0_5`.
pub const LOCK_FIELDS_0_5: [&str; 3] = ["host", "isolation", "egress"];

/// `LOCK_FORMATS.indexOf(format)`: the place of a format, `-1` for any
/// other value (a number, a format this compiler does not read).
fn format_index(format: Option<&str>) -> i64 {
    let at = format.and_then(|f| LOCK_FORMATS.iter().position(|x| *x == f));
    at.and_then(|i| i64::try_from(i).ok()).unwrap_or(-1)
}

/// A lock's format is `format` or later: `atLeast(lock, format)` in
/// `lock.ts`, `lock.lock !== undefined && LOCK_FORMATS.indexOf(lock.lock) >=
/// LOCK_FORMATS.indexOf(format)`. A lock with no format, or one this compiler
/// does not read, is at no format (`-1` is below every format, and so is a
/// `format` that is not one: then any lock that has a `lock` member is at
/// least it, as in the TypeScript).
#[must_use]
pub fn lock_at_least(lock: &Value, format: &str) -> bool {
    let Some(have) = lock.get("lock") else {
        return false;
    };
    format_index(have.as_str()) >= format_index(Some(format))
}

/// The diagnostics `validateLock(value)` gives when the lock schema refuses
/// `value`; none when it accepts it (then the rules after the schema decide,
/// [`validate_lock`]).
#[must_use]
pub fn lock_schema_diagnostics(value: &Value) -> Vec<Diagnostic> {
    let errors = match lock_schema_errors(value) {
        Ok(errors) => errors,
        // The embedded schema always prepares (a test holds it to that);
        // were it not to, no lock is accepted.
        Err(why) => {
            return vec![Diagnostic::new(
                "E0140",
                format!("The lock schema could not be prepared: {why}"),
                Location::path(""),
                None,
            )];
        }
    };
    errors
        .into_iter()
        .map(|e| {
            let shown = if e.instance_path.is_empty() {
                "/"
            } else {
                e.instance_path.as_str()
            };
            let message = format!(
                "The lock file does not match spec/lock.schema.json: {shown} {}",
                e.message
            );
            let facts = JsObject::new()
                .with("keyword", e.keyword)
                .with("params", e.params);
            Diagnostic::new(
                "E0140",
                trim(&message),
                Location::path(e.instance_path),
                Some(facts),
            )
        })
        .collect()
}

/// `String(lock.lock)`, and `lock.lock ?? null` as a fact.
fn format_text_and_fact(lock: &Value) -> (String, JsValue) {
    let format = lock.get("lock");
    (
        JsValue::from(format).to_js_string(),
        format.map_or(JsValue::Null, JsValue::from),
    )
}

/// Validates a parsed lock file against `spec/lock.schema.json` and the
/// rules the schema cannot say; E0140 for each problem: `validateLock(value)`.
///
/// For a lock the schema accepts, in this order: bindings need format 0.3;
/// `members` and `roles` need 0.4 (in that order); `host`, `isolation` and
/// `egress` need 0.5; a key listed under two members (at the second one, in
/// the order of `members` and of each member's keys); a role that lists a
/// member `members` does not have; a tier whose model has no tariff.
#[must_use]
pub fn validate_lock(value: &Value) -> Vec<Diagnostic> {
    let refused = lock_schema_diagnostics(value);
    if !refused.is_empty() {
        return refused;
    }
    let Some(lock) = value.as_object() else {
        // The schema accepts only an object.
        return Vec::new();
    };
    let given = |field: &str| lock.get(field).is_some_and(Value::is_truthy);
    let (format, format_fact) = format_text_and_fact(value);
    let mut out: Vec<Diagnostic> = Vec::new();
    if given("bindings") && !lock_at_least(value, "mandate/lock/0.3") {
        out.push(Diagnostic::new(
            "E0140",
            format!("Executor bindings need lock format mandate/lock/0.3, not {format}."),
            Location::path("/lock"),
            Some(JsObject::new().with("lock", format_fact.clone())),
        ));
    }
    for (fields, since) in [
        (&["members", "roles"][..], "mandate/lock/0.4"),
        (&LOCK_FIELDS_0_5[..], "mandate/lock/0.5"),
    ] {
        for field in fields {
            if given(field) && !lock_at_least(value, since) {
                out.push(Diagnostic::new(
                    "E0140",
                    format!("Lock field {field} needs lock format {since}, not {format}."),
                    Location::path(format!("/{field}")),
                    Some(
                        JsObject::new()
                            .with("field", *field)
                            .with("lock", format_fact.clone()),
                    ),
                ));
            }
        }
    }
    let members = lock.get("members").and_then(Value::as_object);
    // `holder`: the member that listed a key first.
    let mut holder: Vec<(&str, &str)> = Vec::new();
    for (member, m) in members.into_iter().flat_map(|ms| ms.iter()) {
        let keys = m.get("keys").and_then(Value::as_array).unwrap_or_default();
        for (i, key) in keys.iter().enumerate() {
            let Some(key) = key.as_str() else { continue };
            match holder.iter().find(|(k, _)| *k == key) {
                None => holder.push((key, member)),
                Some((_, first)) => out.push(Diagnostic::new(
                    "E0140",
                    format!(
                        "Key {key} is listed under members {first} and {member}; one key belongs to one member."
                    ),
                    Location::path(format!("/members/{member}/keys/{i}")),
                    Some(
                        JsObject::new().with("key", key).with(
                            "members",
                            JsValue::Array(vec![JsValue::from(*first), JsValue::from(member)]),
                        ),
                    ),
                )),
            }
        }
    }
    let roles = lock.get("roles").and_then(Value::as_object);
    for (role, listed) in roles.into_iter().flat_map(|rs| rs.iter()) {
        let listed = listed.as_array().unwrap_or_default();
        for (i, member) in listed.iter().enumerate() {
            let Some(member) = member.as_str() else {
                continue;
            };
            // `!own(lock.members, member)`.
            if !members
                .and_then(|ms| ms.get(member))
                .is_some_and(Value::is_truthy)
            {
                out.push(Diagnostic::new(
                    "E0140",
                    format!("Role {role} lists member {member}, which is not in members."),
                    Location::path(format!("/roles/{role}/{i}")),
                    Some(JsObject::new().with("role", role).with("member", member)),
                ));
            }
        }
    }
    let models = lock.get("models").and_then(Value::as_object);
    let tariffs = lock.get("tariffs").and_then(Value::as_object);
    for (tier, m) in models.into_iter().flat_map(|ms| ms.iter()) {
        let Some(model) = m.get("model").and_then(Value::as_str) else {
            continue;
        };
        // `!own(lock.tariffs, m.model)`.
        if !tariffs
            .and_then(|ts| ts.get(model))
            .is_some_and(Value::is_truthy)
        {
            out.push(Diagnostic::new(
                "E0140",
                format!("The lock maps tier {tier} to {model}, which has no tariff."),
                Location::path(format!("/models/{tier}/model")),
                Some(JsObject::new().with("tier", tier).with("model", model)),
            ));
        }
    }
    out
}
