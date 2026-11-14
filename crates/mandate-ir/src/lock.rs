//! The schema half of `validateLock` in `compiler/src/lock.ts`: a lock the
//! schema refuses gets one E0140 for each raw error, in Ajv's order, with no
//! sorting, dropping or deduplication. A lock gives no spans, so `at` is
//! `{ path }`, the error's `instancePath`.
//!
//! The rules `validateLock` applies to a lock the schema accepts (the lock
//! format a field needs, a key under two members, a role's members, a tier's
//! tariff) are not here yet.

use crate::diag::{Diagnostic, Location};
use crate::js_value::JsObject;
use crate::schema::lock_schema_errors;
use crate::text::trim;
use crate::value::Value;

/// The diagnostics `validateLock(value)` gives when the lock schema refuses
/// `value`; none when it accepts it (then the rules after the schema decide).
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
