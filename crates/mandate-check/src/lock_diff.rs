//! What two locks differ in: the people they bind (`lockDiff`) and what they
//! ask of the runtime's host and of a sandbox (`lockLimitsDiff`), from
//! `compiler/src/views/views.ts` lines 794-893.
//!
//! A lock is read as the TypeScript reads an unvalidated object (the diff
//! vectors parse their locks and do not validate them): a [`Value`], each
//! member read where it is, a member that is missing or of another type as
//! nothing. Where the TypeScript would throw on such a lock (a member that is
//! not a list where it calls `includes`), nothing is compared here instead.
//!
//! The isolation floors and the co-tenancy of a data class are the sandbox
//! module's (`floorFor` and `coTenancyFor` of `compiler/src/target/sandbox.ts`).

use mandate_ir::{Map, Value, ptr_token, sort_utf16, unique_in_order};

use crate::diff::Change;
use crate::sandbox::{CoTenancy, IsolationLevel, co_tenancy_for, floor_for};
use crate::stdlib::{DATA_CLASSES, DataClass};
use crate::view_shared::js_text;

/// A member of a lock that is an object: `lock?.members`.
fn object<'a>(lock: Option<&'a Value>, key: &str) -> Option<&'a Map> {
    lock?.get(key)?.as_object()
}

/// `Object.keys(x ?? {})`, then `[...new Set(...)]` of both and `.sort()`.
fn names(x: Option<&Map>, y: Option<&Map>) -> Vec<String> {
    let mut all = unique_in_order(
        x.into_iter()
            .chain(y)
            .flat_map(Map::keys)
            .map(str::to_owned),
    );
    sort_utf16(&mut all);
    all
}

/// The string member `key` of the object `o`, when there is one.
fn text_at<'a>(o: Option<&'a Map>, key: &str) -> Option<&'a str> {
    o?.get(key)?.as_str()
}

/// The strings of a list member, as a list is read where `includes` and a
/// spread go over it.
fn strings(v: Option<&Value>) -> Vec<&str> {
    v.and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .collect()
}

/// What changed in the people two locks bind: members, their keys and who
/// holds each role. A binding decides who can approve, so each change is a
/// governance change (spec/envelope.md, "The lock: members and roles"; case
/// H05). `lockDiff(before, after)`.
#[must_use]
pub fn lock_diff(before: Option<&Value>, after: Option<&Value>) -> Vec<Change> {
    let mut out: Vec<Change> = Vec::new();
    let bm = object(before, "members");
    let am = object(after, "members");
    for m in names(bm, am) {
        let b = bm.and_then(|x| x.get(&m)).filter(|v| v.is_truthy());
        let a = am.and_then(|x| x.get(&m)).filter(|v| v.is_truthy());
        let path = format!("/members/{}", ptr_token(&m));
        match (b, a) {
            // An added member's keys come with it, and a removed member's keys go with it: one line each.
            (None, Some(a)) => {
                let count = a
                    .get("keys")
                    .and_then(Value::as_array)
                    .map_or(0, <[Value]>::len);
                let word = if count == 1 { "key" } else { "keys" };
                out.push(Change::new(path, format!("+ member {m} ({count} {word})")));
            }
            (Some(_), None) => out.push(Change::new(path, format!("- member {m}"))),
            (Some(b), Some(a)) => {
                let bk = strings(b.get("keys"));
                let ak = strings(a.get("keys"));
                let mut keys = unique_in_order(bk.iter().chain(&ak).map(|k| (*k).to_owned()));
                sort_utf16(&mut keys);
                for k in keys {
                    let now = ak.contains(&k.as_str());
                    if bk.contains(&k.as_str()) != now {
                        out.push(Change::new(
                            format!("{path}/keys/{}", ptr_token(&k)),
                            format!("{} key {k} for {m}", if now { "+" } else { "-" }),
                        ));
                    }
                }
            }
            (None, None) => {}
        }
    }
    let br = object(before, "roles");
    let ar = object(after, "roles");
    for r in names(br, ar) {
        let b = strings(br.and_then(|x| x.get(&r)));
        let a = strings(ar.and_then(|x| x.get(&r)));
        let mut holders = unique_in_order(b.iter().chain(&a).map(|m| (*m).to_owned()));
        sort_utf16(&mut holders);
        for m in holders {
            let now = a.contains(&m.as_str());
            if b.contains(&m.as_str()) != now {
                out.push(Change::new(
                    format!("/roles/{}/{}", ptr_token(&r), ptr_token(&m)),
                    if now {
                        format!("+ {m} holds role {r}")
                    } else {
                        format!("- {m} no longer holds role {r}")
                    },
                ));
            }
        }
    }
    out
}

/// What [`lock_limits_diff`] gives: `{ governance, behavior }`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LockLimitsDiff {
    /// What lets a sandbox do more, or run on less.
    pub governance: Vec<Change>,
    /// The opposite of each.
    pub behavior: Vec<Change>,
}

/// `x.split(".").map(Number)`: a version's segments as JavaScript reads them.
fn segments(x: &str) -> Vec<f64> {
    x.split('.').map(crate::js_number::js_to_number).collect()
}

/// `version(x, y)`: versions by number, segment by segment; a missing segment
/// is 0, so 22.23 and 22.23.0 are the same. A segment that is no number is
/// `NaN`, which is unequal to anything, itself included, so the comparison
/// ends there, and says "not below".
#[allow(clippy::float_cmp)]
fn version_below(x: &str, y: &str) -> bool {
    let xs = segments(x);
    let ys = segments(y);
    let n = xs.len().max(ys.len());
    for i in 0..n {
        let a = xs.get(i).copied().unwrap_or(0.0);
        let b = ys.get(i).copied().unwrap_or(0.0);
        if a != b {
            return a < b;
        }
    }
    false
}

/// `ISOLATION_LEVELS.indexOf(level)`: `-1` for a name that is no level.
fn level_index(level: &str) -> isize {
    IsolationLevel::from_name(level)
        .and_then(|l| isize::try_from(l.index()).ok())
        .unwrap_or(-1)
}

/// `level(x, y)`: whether `x` is a lower isolation level than `y`.
fn level_below(x: &str, y: &str) -> bool {
    level_index(x) < level_index(y)
}

/// One least value: `below` orders values, and none is below all, or is
/// `bottom` when one value means the same as none (a floor of process is no
/// floor). Lowered or taken away is governance; raised or added, behavior.
/// `least(path, label, b, a, below, none, bottom?)`.
#[allow(clippy::too_many_arguments)]
fn least(
    out: &mut LockLimitsDiff,
    path: String,
    label: &str,
    b: Option<&str>,
    a: Option<&str>,
    below: fn(&str, &str) -> bool,
    none: &str,
    bottom: Option<&str>,
) {
    let was = b.or(bottom);
    let now = a.or(bottom);
    if was == now {
        return;
    }
    if let (Some(w), Some(n)) = (was, now)
        && !below(w, n)
        && !below(n, w)
    {
        return;
    }
    let lowered = now.is_none() || was.is_some_and(|w| now.is_some_and(|n| below(n, w)));
    let shown = |v: Option<&str>| v.unwrap_or(none).to_owned();
    let change = Change::new(
        path,
        format!(
            "~ {label}: {} → {} ({})",
            shown(b),
            shown(a),
            if lowered { "lowered" } else { "raised" }
        ),
    );
    if lowered {
        out.governance.push(change);
    } else {
        out.behavior.push(change);
    }
}

/// What changed in what two locks of format 0.5 ask of the runtime's host and
/// of a sandbox (spec/boundary.md "Lock 0.5"). What lets a sandbox do more, or
/// run on less, is a governance change: a credential bound to an agent's
/// requests, added or changed; an isolation floor lowered or taken away; a
/// sandbox that may now share its host; a least host version lowered or taken
/// away. The opposite of each is a behavior change.
/// `lockLimitsDiff(before, after)`; and, after what the TypeScript compares,
/// the connectors of 0.6 and the role classes and the promotion ladder of
/// 0.7, which no lock it reads has.
#[must_use]
pub fn lock_limits_diff(before: Option<&Value>, after: Option<&Value>) -> LockLimitsDiff {
    let mut out = LockLimitsDiff::default();
    let bh = object(before, "host");
    let ah = object(after, "host");
    for tool in names(bh, ah) {
        least(
            &mut out,
            format!("/host/{}", ptr_token(&tool)),
            &format!("host.{tool}"),
            text_at(bh, &tool),
            text_at(ah, &tool),
            version_below,
            "no minimum",
            None,
        );
    }
    let bi = before.and_then(|l| l.get("isolation"));
    let ai = after.and_then(|l| l.get("isolation"));
    // Floors and sharing are compared as each data class has them in effect: a floor holds for every more sensitive
    // class, so taking one away, or lowering it, may lower what a class that the lock does not name gets.
    for cls in DATA_CLASSES {
        least(
            &mut out,
            format!("/isolation/floor/{}", ptr_token(cls.as_str())),
            &format!("isolation.floor.{cls} in effect"),
            Some(floor_for(bi, cls).as_str()),
            Some(floor_for(ai, cls).as_str()),
            level_below,
            "process",
            None,
        );
    }
    least(
        &mut out,
        "/isolation/untrusted_network".to_owned(),
        "isolation.untrusted_network",
        bi.and_then(|i| i.get("untrusted_network"))
            .and_then(Value::as_str),
        ai.and_then(|i| i.get("untrusted_network"))
            .and_then(Value::as_str),
        level_below,
        "no floor",
        Some("process"),
    );
    for cls in DATA_CLASSES {
        let b = co_tenancy_for(bi, cls) == CoTenancy::Forbidden;
        let a = co_tenancy_for(ai, cls) == CoTenancy::Forbidden;
        if b == a {
            continue;
        }
        let word = |forbidden: bool| if forbidden { "forbidden" } else { "allowed" };
        let relaxed = !a;
        let change = Change::new(
            format!("/isolation/co_tenancy/{}", ptr_token(cls.as_str())),
            format!(
                "~ isolation.co_tenancy.{cls} in effect: {} → {} ({})",
                word(b),
                word(a),
                if relaxed { "relaxed" } else { "tightened" }
            ),
        );
        if relaxed {
            out.governance.push(change);
        } else {
            out.behavior.push(change);
        }
    }
    let be = object(before, "egress");
    let ae = object(after, "egress");
    for agent in names(be, ae) {
        let b = be.and_then(|e| e.get(&agent)).and_then(Value::as_object);
        let a = ae.and_then(|e| e.get(&agent)).and_then(Value::as_object);
        for host in names(b, a) {
            let was = b.and_then(|m| m.get(&host));
            let now = a.and_then(|m| m.get(&host));
            if same(was, now) {
                continue;
            }
            let path = format!("/egress/{}/{}", ptr_token(&agent), ptr_token(&host));
            match (was, now) {
                (None, now) => out.governance.push(Change::new(
                    path,
                    format!(
                        "+ egress: {agent}'s requests to {host} carry credential {}",
                        js_text(now)
                    ),
                )),
                (was, None) => out.behavior.push(Change::new(
                    path,
                    format!(
                        "- egress: {agent}'s requests to {host} carry credential {} no more",
                        js_text(was)
                    ),
                )),
                (was, now) => out.governance.push(Change::new(
                    path,
                    format!(
                        "~ egress: {agent}'s requests to {host} carry credential {} → {}",
                        js_text(was),
                        js_text(now)
                    ),
                )),
            }
        }
    }
    connector_changes(&mut out, before, after);
    attention_changes(&mut out, before, after);
    out
}

/// 0.7: what changed in the lock's `role_classes` and `promotion`
/// (spec/attention.md "Lock 0.7"). Each role's class is compared as it is
/// in effect, its entry or else `internal`: a class raised (an entry added
/// above `internal`, changed upward, or taken away from below `internal`)
/// shows the role more data, a governance change, and one lowered is a
/// behavior change; an entry that leaves the class in effect as it was (an
/// `internal` added or taken away) is no change. `promotion: "required"`
/// taken away lets a run of `read_only` or `live` start with nobody's
/// promotion, a governance change; added, a behavior change. A lock older
/// than 0.7 has neither, so nothing here applies to it.
fn attention_changes(out: &mut LockLimitsDiff, before: Option<&Value>, after: Option<&Value>) {
    let bc = object(before, "role_classes");
    let ac = object(after, "role_classes");
    let in_effect = |c: Option<&Map>, role: &str| {
        text_at(c, role)
            .and_then(DataClass::from_name)
            .unwrap_or(DataClass::Internal)
    };
    for role in names(bc, ac) {
        let (was, now) = (in_effect(bc, &role), in_effect(ac, &role));
        if was == now {
            continue;
        }
        let raised = now > was;
        let change = Change::new(
            format!("/role_classes/{}", ptr_token(&role)),
            format!(
                "~ the data class role {role} may be shown, in effect: {was} → {now} ({})",
                if raised { "raised" } else { "lowered" }
            ),
        );
        if raised {
            out.governance.push(change);
        } else {
            out.behavior.push(change);
        }
    }
    let required = |l: Option<&Value>| {
        l.and_then(|l| l.get("promotion")).and_then(Value::as_str) == Some("required")
    };
    match (required(before), required(after)) {
        (true, false) => out.governance.push(Change::new(
            "/promotion",
            "- promotion: required (a run of read_only or live needs no promotion)",
        )),
        (false, true) => out.behavior.push(Change::new(
            "/promotion",
            "+ promotion: required (a run of read_only or live needs a promotion)",
        )),
        _ => {}
    }
}

/// 0.6: what changed in the lock's `connectors`, the credential each
/// connector's requests carry and where it goes (spec/library.md "Lock 0.6"):
/// an entry added, and its `credential`, `url`, `header` or `template`
/// changed, and a tool's schema digest added or changed, are governance
/// changes; an entry or a digest taken away is a behavior change. A lock
/// older than 0.6 has no `connectors`, so nothing here applies to it.
fn connector_changes(out: &mut LockLimitsDiff, before: Option<&Value>, after: Option<&Value>) {
    let bc = object(before, "connectors");
    let ac = object(after, "connectors");
    for id in names(bc, ac) {
        let b = bc.and_then(|c| c.get(&id)).and_then(Value::as_object);
        let a = ac.and_then(|c| c.get(&id)).and_then(Value::as_object);
        let path = format!("/connectors/{}", ptr_token(&id));
        let (b, a) = match (b, a) {
            (None, Some(a)) => {
                out.governance.push(Change::new(
                    path,
                    format!(
                        "+ connector {id}: credential {} to {}",
                        js_text(a.get("credential")),
                        js_text(a.get("url"))
                    ),
                ));
                continue;
            }
            (Some(_), None) => {
                out.behavior.push(Change::new(
                    path,
                    format!("- connector {id} no longer bound"),
                ));
                continue;
            }
            (Some(b), Some(a)) => (b, a),
            (None, None) => continue,
        };
        for field in ["credential", "url", "header", "template"] {
            let (was, now) = (b.get(field), a.get(field));
            if !same(was, now) {
                out.governance.push(Change::new(
                    format!("{path}/{field}"),
                    format!(
                        "~ connector {id}.{field}: {} → {}",
                        js_text(was),
                        js_text(now)
                    ),
                ));
            }
        }
        let (bt, at) = (
            b.get("tools").and_then(Value::as_object),
            a.get("tools").and_then(Value::as_object),
        );
        for tool in names(bt, at) {
            let (was, now) = (bt.and_then(|t| t.get(&tool)), at.and_then(|t| t.get(&tool)));
            if same(was, now) {
                continue;
            }
            let at_tool = format!("{path}/tools/{}", ptr_token(&tool));
            let change = Change::new(
                at_tool,
                format!(
                    "~ connector {id}.{tool}: schema {} → {}",
                    js_text(was),
                    js_text(now)
                ),
            );
            if now.is_some() {
                out.governance.push(change);
            } else {
                out.behavior.push(change);
            }
        }
    }
}

/// `was === now` for two members that may be missing: equal when both are
/// missing, or both are the same primitive; an object or a list is never
/// `===` to another.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Array(_) | Value::Object(_)), _)
        | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}
