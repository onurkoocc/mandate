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
//! Three pieces of `compiler/src/target/sandbox.ts` are copied here, each
//! marked, because that file is ported by another slice: `ISOLATION_LEVELS`,
//! `floorFor` and `coTenancyFor`.

use mandate_ir::{Map, Value, ptr_token, sort_utf16, unique_in_order};

use crate::diff::Change;
use crate::stdlib::{DATA_CLASSES, DataClass, class_rank};
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
        let b = bm
            .and_then(|x| x.get(&m))
            .filter(|v| crate::view_shared::truthy(Some(v)));
        let a = am
            .and_then(|x| x.get(&m))
            .filter(|v| crate::view_shared::truthy(Some(v)));
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

// R14: the public one in the sandbox module replaces this copy.
/// `ISOLATION_LEVELS`: isolation levels, weakest first (spec/boundary.md
/// "Isolation level and host fitness").
const ISOLATION_LEVELS: [&str; 4] = ["process", "user_kernel", "microvm", "dedicated_host"];

/// `ISOLATION_LEVELS.indexOf(level)`: `-1` for a name that is none.
fn level_index(level: &str) -> isize {
    ISOLATION_LEVELS
        .iter()
        .position(|l| *l == level)
        .and_then(|i| isize::try_from(i).ok())
        .unwrap_or(-1)
}

// R14: the public one in the sandbox module replaces this copy.
/// The stronger of two isolation levels: `higher(a, b)` of `sandbox.ts`.
fn higher<'a>(a: &'a str, b: &'a str) -> &'a str {
    if level_index(b) > level_index(a) {
        b
    } else {
        a
    }
}

// R14: the public one in the sandbox module replaces this copy.
/// `own(o, k)` of `sandbox.ts`: `o[k]` when `k` is a key of `o` itself.
fn own<'a>(o: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    o?.as_object()?.get(k)
}

// R14: the public one in the sandbox module replaces this copy.
/// The isolation floor a lock's `isolation` gives data of class `c`: the
/// highest floor it sets for `c` or any less sensitive class, since a floor
/// holds for every class above the one it names. `process` when it sets none.
/// `floorFor(iso, c)` of `sandbox.ts`.
fn floor_for<'a>(iso: Option<&'a Value>, c: DataClass) -> &'a str {
    let floor = iso.and_then(|i| i.get("floor"));
    DATA_CLASSES
        .iter()
        .filter(|x| class_rank(**x) <= class_rank(c))
        .fold("process", |a, x| {
            // `own(iso?.floor, x) ?? "process"`: a level that is no string is none of the levels.
            let level = own(floor, x.as_str()).map_or("process", |v| v.as_str().unwrap_or(""));
            higher(a, level)
        })
}

// R14: the public one in the sandbox module replaces this copy.
/// Whether a sandbox with data of class `c` may share its host: not when the
/// lock forbids it for `c` or any less sensitive class. `coTenancyFor(iso,
/// c)` of `sandbox.ts`, `forbidden` as `true`.
fn co_tenancy_forbidden(iso: Option<&Value>, c: DataClass) -> bool {
    let co = iso.and_then(|i| i.get("co_tenancy"));
    DATA_CLASSES.iter().any(|x| {
        class_rank(*x) <= class_rank(c)
            && own(co, x.as_str()).and_then(Value::as_str) == Some("forbidden")
    })
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
/// `lockLimitsDiff(before, after)`.
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
            Some(floor_for(bi, cls)),
            Some(floor_for(ai, cls)),
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
        let b = co_tenancy_forbidden(bi, cls);
        let a = co_tenancy_forbidden(ai, cls);
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
    out
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
