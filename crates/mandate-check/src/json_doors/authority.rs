//! The doors of the run-time authority decisions, `bridge/src/authority.ts`
//! (in Rust [`crate::grant`](mod@crate::grant)): `grant`, `narrow`, `map_scopes` and
//! `in_flight_overlap`.
//!
//! Each takes `{ input }`, the TypeScript function's one argument, and
//! answers its result object. A capability in the input is read by
//! `input::authority_cap` (any `write` but `null`, read by truthiness; any
//! `maxClass` name; the object kept whole for the outputs); a member the
//! contract gives a type, given as `null` or as another JSON type, or
//! missing, is `bad_input`, as is a `delegation` left out (it is `null` to
//! ask what is available). Members the contract does not name are ignored,
//! deeper than the top level, as the TypeScript ignores them.

use mandate_ir::{JsValue, Value};

use super::DoorError;
use super::input::{Members, args};
use crate::grant::{
    AuthorityContext, GrantDelegation, GrantInput, InFlightOverlapInput, InFlightProgram,
    MapScopesInput, NarrowInput,
};

/// The one parameter of each of the four doors.
const INPUT: &[&str] = &["input"];

/// The members of `input`, the object the door's one parameter is.
fn the_input(input: &Value) -> Result<Members<'_>, DoorError> {
    let a = args(input, INPUT)?;
    Members::nested(a.value("input")?, "input.", "input")
}

/// The member `context` of `m`, an `AuthorityContext`: `{ bounds, given,
/// handed }`.
fn context(m: Members<'_>) -> Result<AuthorityContext, DoorError> {
    let c = Members::nested(m.value("context")?, "input.context.", "input.context")?;
    Ok(AuthorityContext {
        bounds: c.authority_caps("bounds")?,
        given: c.authority_cap_lists("given")?,
        handed: c.authority_caps("handed")?,
    })
}

/// The parameters of [`grant`].
pub(super) const GRANT: &[&str] = INPUT;

/// `grant(input)`, `bridge/src/authority.ts`: what is available in a
/// context, or what a delegation is granted in it.
///
/// Input: `{ input: { context: { bounds, given, handed }, delegation: null
/// | { agent, held, remote, own } } }`.
/// Output: `{ available }`, `{ granted }` or `{ refused: { tag, args } }`.
pub(super) fn grant(input: &Value) -> Result<JsValue, DoorError> {
    let i = the_input(input)?;
    let context = context(i)?;
    let delegation = match i.value("delegation")? {
        Value::Null => None,
        v => {
            let d = Members::nested(v, "input.delegation.", "input.delegation")?;
            Some(GrantDelegation {
                agent: d.str("agent")?.to_owned(),
                held: d.authority_caps("held")?,
                remote: d.bool("remote")?,
                own: d.authority_caps("own")?,
            })
        }
    };
    let out = crate::grant::grant(&GrantInput {
        context,
        delegation,
    });
    Ok(out.to_js().into())
}

/// The parameters of [`narrow`].
pub(super) const NARROW: &[&str] = INPUT;

/// `narrow(input)`, `bridge/src/authority.ts`: a narrowing with values
/// known only at run time.
///
/// Input: `{ input: { base, args: [any], complete } }`.
/// Output: `{ caps: [capability] }`, `{ partial: true }`, `{ notText }` or
/// `{ refused }`.
pub(super) fn narrow(input: &Value) -> Result<JsValue, DoorError> {
    let i = the_input(input)?;
    let out = crate::grant::narrow(&NarrowInput {
        base: i.authority_cap("base")?,
        args: i.array("args")?.to_vec(),
        complete: i.bool("complete")?,
    });
    Ok(out.to_js().into())
}

/// The parameters of [`map_scopes`].
pub(super) const MAP_SCOPES: &[&str] = INPUT;

/// `mapScopes(input)`, `bridge/src/authority.ts`: what each item of a map
/// is handed, and whether two items write the same place.
///
/// Input: `{ input: { map, par, context, items: [[capability]], complete }
/// }`.
/// Output: `{ items: [{ given, handed } | null], writes }`, `{ partial:
/// true }` or `{ refused }`.
pub(super) fn map_scopes(input: &Value) -> Result<JsValue, DoorError> {
    let i = the_input(input)?;
    let input = MapScopesInput {
        map: i.str("map")?.to_owned(),
        par: i.int("par")?,
        context: context(i)?,
        items: i.authority_cap_lists("items")?,
        complete: i.bool("complete")?,
    };
    Ok(crate::grant::map_scopes(&input).to_js().into())
}

/// The parameters of [`in_flight_overlap`].
pub(super) const IN_FLIGHT_OVERLAP: &[&str] = INPUT;

/// `inFlightOverlap(input)`, `bridge/src/authority.ts`: whether a map
/// writes where a sub-program in flight may write.
///
/// Input: `{ input: { map, writes: [[capability]], programs: [{ command,
/// writes }] } }`.
/// Output: `{ overlap: null | { tag, args } }`.
pub(super) fn in_flight_overlap(input: &Value) -> Result<JsValue, DoorError> {
    let i = the_input(input)?;
    let mut programs = Vec::new();
    for (k, p) in i.array("programs")?.iter().enumerate() {
        let at = format!("input.programs[{k}].");
        let name = format!("input.programs[{k}]");
        let p = Members::nested(p, &at, &name)?;
        programs.push(InFlightProgram {
            command: p.str("command")?.to_owned(),
            writes: p.authority_caps("writes")?,
        });
    }
    let out = crate::grant::in_flight_overlap(&InFlightOverlapInput {
        map: i.str("map")?.to_owned(),
        writes: i.authority_cap_lists("writes")?,
        programs,
    });
    Ok(out.to_js().into())
}
