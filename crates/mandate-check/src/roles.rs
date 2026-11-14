//! Roles (0.4; spec/envelope.md "Roles"): a port of
//! `compiler/src/check/roles.ts`.
//!
//! A role is a definition people hold; the lock says who holds it. This
//! finds every place a program names a role ([`role_sites`]), and for a 0.4
//! module checks ([`role_checks`]):
//!
//! - E1501: each of them names a `role` definition, local or imported with
//!   `use`;
//! - E1503: `distinct_from` names a role approved earlier in the same
//!   criterion.
//!
//! E1502 (every role has a member in the lock) is with the lock checks. A
//! 0.1 to 0.3 module names a role with any text and has no role
//! definitions, so neither rule applies to it.

use mandate_ir::{
    Arg, Criterion, DefKind, Definition, Diagnostic, Expr, ExprOp, JsObject, JsValue, Language,
    Location, Map, Program, Repair, RepairOp, RepairOpKind, Risk, Spans, Tier, TierBy, Value,
    Verifier, VerifierForm, compare_utf16, nearest_span, ptr, ptr_token, sort_utf16,
};

use crate::caps::callee_path;
use crate::resolve::closest;

/// The IR value that names a role at a site: `RoleSite["value"]`, a
/// function of the role in the TypeScript.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoleValue {
    /// The role as a plain string (`(r) => r`): an owner, an approver, an
    /// authorization.
    Name,
    /// `(role) => ({ op: "text", value: role })`.
    Text,
    /// `(role) => ({ op: "var", name: role })`.
    Var,
}

impl RoleValue {
    /// The value that names `role` at the site.
    #[must_use]
    pub fn value(self, role: &str) -> JsValue {
        match self {
            RoleValue::Name => JsValue::from(role),
            RoleValue::Text => JsObject::new()
                .with("op", "text")
                .with("value", role)
                .into(),
            RoleValue::Var => JsObject::new().with("op", "var").with("name", role).into(),
        }
    }
}

/// One place a program names a role: `RoleSite`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleSite {
    /// The definition the place is in.
    pub def: String,
    /// The role named; `None` when the place holds something that is not a
    /// name.
    pub role: Option<String>,
    /// JSON Pointer of the name.
    pub path: String,
    /// What names it, for a message: "a component's owner".
    pub r#where: String,
    /// `distinct_from` names a role to compare with, not the role that
    /// decides.
    pub distinct: bool,
    /// The IR value that names a role at this place.
    pub value: RoleValue,
}

/// `role: code_owner` and `role: "code_owner"` name the same role: `named(e)`.
fn named(e: Option<Expr<'_>>) -> Option<&str> {
    let e = e?;
    match e.op() {
        Some(ExprOp::Var) => e.name(),
        Some(ExprOp::Text) => e.text(),
        _ => None,
    }
}

/// `asValue(e)`.
fn as_value(e: Option<Expr<'_>>) -> RoleValue {
    if e.is_some_and(|e| e.is(ExprOp::Text)) {
        RoleValue::Text
    } else {
        RoleValue::Var
    }
}

/// The calls that wait for a person and may name the role that answers.
const PERSON_CALLS: [&str; 3] = ["human.approve", "human.ask", "human"];

struct Sites {
    out: Vec<RoleSite>,
    def: String,
}

impl Sites {
    fn text(&mut self, role: Option<&str>, path: String, r#where: &str) {
        self.out.push(RoleSite {
            def: self.def.clone(),
            role: role.map(str::to_owned),
            path,
            r#where: r#where.to_owned(),
            distinct: false,
            value: RoleValue::Name,
        });
    }

    fn arg(&mut self, a: Arg<'_>, path: String, r#where: &str) {
        self.out.push(RoleSite {
            def: self.def.clone(),
            role: named(a.value()).map(str::to_owned),
            path,
            r#where: r#where.to_owned(),
            distinct: a.name() == Some("distinct_from"),
            value: as_value(a.value()),
        });
    }

    fn walk(&mut self, v: &Value, path: &str) {
        let o = match v {
            Value::Array(items) => {
                for (i, x) in items.iter().enumerate() {
                    self.walk(x, &format!("{path}/{i}"));
                }
                return;
            }
            Value::Object(o) => o,
            _ => return,
        };
        let e = Expr::of(v);
        if let Some(cs) = e.filter(|e| e.is(ExprOp::Changeset)) {
            self.text(
                cs.approver(),
                format!("{path}/approver"),
                "a change set's approver",
            );
            for (m, mem) in cs.changeset_members() {
                // `mem.approver !== undefined`.
                if mem.members().contains_key("approver") {
                    self.text(
                        mem.approver(),
                        format!("{path}/members/{}/approver", ptr_token(m)),
                        "a change set member's approver",
                    );
                }
            }
        }
        if let Some(call) = e.filter(|e| e.is(ExprOp::Call))
            && let Some(callee) = call.callee().and_then(callee_path)
            && PERSON_CALLS.contains(&callee.as_str())
        {
            for (i, a) in call.arg_values().iter().enumerate() {
                let Some(a) = Arg::of(a) else { continue };
                let name = a.name();
                if name == Some("role")
                    || (name == Some("distinct_from") && callee == "human.approve")
                {
                    let r#where = if callee == "human" {
                        "an escalation"
                    } else {
                        callee.as_str()
                    };
                    self.arg(a, format!("{path}/args/{i}/value"), r#where);
                }
            }
        }
        // `sup && typeof sup === "object" && sup.name === "escalate"`.
        if let Some(sup) = o.get("supervise")
            && sup.get("name").and_then(Value::as_str) == Some("escalate")
        {
            let args = sup
                .get("args")
                .and_then(Value::as_array)
                .unwrap_or_default();
            for (i, a) in args.iter().enumerate() {
                let Some(a) = Arg::of(a) else { continue };
                if a.name() == Some("role") {
                    self.arg(
                        a,
                        format!("{path}/supervise/args/{i}/value"),
                        "a supervision's escalation",
                    );
                }
            }
        }
        for (k, x) in o.iter() {
            self.walk(x, &format!("{path}/{}", ptr_token(k)));
        }
    }
}

/// Every place the definitions name a role, in the order of their paths
/// (by UTF-16 code units, stably): a component's owner, an environment's
/// authorization, an envelope's owner and approvals, a change set's
/// approvers, `human.approve`, `human.ask`, `escalate human(…)` and
/// `supervise escalate(human, …)`: `roleSites(defs)`.
#[must_use]
pub fn role_sites(defs: &Map) -> Vec<RoleSite> {
    let mut s = Sites {
        out: Vec::new(),
        def: String::new(),
    };
    for (name, value) in defs.iter() {
        let base = ptr(&[&"defs", &name]);
        s.def = name.to_owned();
        let d = Definition::of(value);
        match d.kind() {
            Some(DefKind::Component) => {
                s.text(d.owner(), format!("{base}/owner"), "a component's owner");
            }
            Some(DefKind::Environment) => {
                for (effect, tier) in d.authorize() {
                    let tier = Tier::of(tier);
                    if tier.and_then(Tier::by) == Some(TierBy::Human) {
                        s.text(
                            tier.and_then(Tier::role),
                            format!("{base}/authorize/{}/role", ptr_token(effect)),
                            "an environment's authorization",
                        );
                    }
                }
            }
            Some(DefKind::Workflow) => {
                if let Some(env) = d.envelope() {
                    if env.members().contains_key("owner") {
                        s.text(
                            env.owner(),
                            format!("{base}/envelope/owner"),
                            "an envelope's owner",
                        );
                    }
                    for (effect, role) in env.approve() {
                        s.text(
                            role.as_str(),
                            format!("{base}/envelope/approve/{}", ptr_token(effect)),
                            "an envelope's approval",
                        );
                    }
                }
            }
            _ => {}
        }
        s.walk(value, &base);
    }
    // `out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))`, stable.
    s.out.sort_by(|a, b| compare_utf16(&a.path, &b.path));
    s.out
}

/// The roles the definitions name, each once, sorted: `rolesNamed(defs)`.
#[must_use]
pub fn roles_named(defs: &Map) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in role_sites(defs) {
        if let Some(r) = s.role
            && !out.contains(&r)
        {
            out.push(r);
        }
    }
    sort_utf16(&mut out);
    out
}

/// `where` at the start of a sentence: "A component's owner", but
/// `human.ask` as it is written. `/^an? /.test(where) ? where.charAt(0).toUpperCase() + where.slice(1) : where`.
fn subject(r#where: &str) -> String {
    if r#where.starts_with("a ") || r#where.starts_with("an ") {
        let mut chars = r#where.chars();
        match chars.next() {
            Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
            None => String::new(),
        }
    } else {
        r#where.to_owned()
    }
}

/// `/^[aeiou]/.test(kind) ? "an" : "a"`.
fn article(kind: &str) -> &'static str {
    if kind.starts_with(['a', 'e', 'i', 'o', 'u']) {
        "an"
    } else {
        "a"
    }
}

/// One `human.approve` call in a criterion, and its path.
struct Approval<'a> {
    call: Expr<'a>,
    path: String,
}

/// `approvals(v, path, found)`: every `human.approve` call in `v`, before
/// what is inside it.
fn approvals<'a>(v: &'a Value, path: &str, found: &mut Vec<Approval<'a>>) {
    let o = match v {
        Value::Array(items) => {
            for (i, x) in items.iter().enumerate() {
                approvals(x, &format!("{path}/{i}"), found);
            }
            return;
        }
        Value::Object(o) => o,
        _ => return,
    };
    if let Some(call) = Expr::of(v).filter(|e| e.is(ExprOp::Call))
        && call.callee().and_then(callee_path).as_deref() == Some("human.approve")
    {
        found.push(Approval {
            call,
            path: path.to_owned(),
        });
    }
    for (k, x) in o.iter() {
        approvals(x, &format!("{path}/{}", ptr_token(k)), found);
    }
}

/// `inOrder(v, path, found)`.
fn in_order<'a>(v: Verifier<'a>, path: &str, found: &mut Vec<Approval<'a>>) {
    if v.has(VerifierForm::All) {
        for (i, x) in v.all().iter().enumerate() {
            if let Some(x) = Verifier::of(x) {
                in_order(x, &format!("{path}/all/{i}"), found);
            }
        }
    } else if v.has(VerifierForm::Static) {
        if let Some(e) = v.members().get("static") {
            approvals(e, &format!("{path}/static"), found);
        }
    } else if let Some(e) = v.members().get("call") {
        approvals(e, &format!("{path}/call"), found);
    }
}

/// E1501 and E1503 for a 0.4 module: `roleChecks(program, spans, linked)`.
/// `linked` is the table of definitions the program sees with its imported
/// modules loaded ([`crate::link`]); a role imported from a module that is
/// not loaded is taken on trust, as any imported name is.
#[must_use]
pub fn role_checks(
    program: Program<'_>,
    spans: Option<&Spans>,
    linked: Option<&Map>,
) -> Vec<Diagnostic> {
    // `atLeast(program.language, "mandate/0.4")`; a language it does not
    // know is at index -1, before every version.
    if !program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_4))
    {
        return Vec::new();
    }
    let empty = Map::new();
    let defs = program.defs().unwrap_or(&empty);
    let mut out = Vec::new();
    let at = |path: &str| Location::path_span(path, nearest_span(spans, path));
    let mut imported: Vec<&str> = Vec::new();
    for u in program.use_values() {
        for n in u
            .get("names")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
        {
            if !imported.contains(&n) {
                imported.push(n);
            }
        }
    }
    let all = linked.unwrap_or(defs);
    let kind = |d: &Value| Definition::of(d).kind();
    // Whether `name` is a role here; `None` when its module is not loaded.
    let is_role = |name: &str| -> Option<bool> {
        if let Some(local) = defs.get(name) {
            return Some(kind(local) == Some(DefKind::Role));
        }
        if !imported.contains(&name) {
            return Some(false);
        }
        all.get(name).map(|d| kind(d) == Some(DefKind::Role))
    };
    let mut roles: Vec<String> = Vec::new();
    for n in defs.keys().chain(imported.iter().copied()) {
        if is_role(n) == Some(true) && !roles.iter().any(|r| r == n) {
            roles.push(n.to_owned());
        }
    }
    sort_utf16(&mut roles);
    let roles_js = || JsValue::Array(roles.iter().map(|r| JsValue::from(r.as_str())).collect());

    let sites = role_sites(defs);
    for s in &sites {
        let Some(role) = s.role.as_deref() else {
            out.push(Diagnostic::new(
                "E1501",
                format!(
                    "{} names a role: write the name of a role definition (spec/envelope.md).",
                    subject(&s.r#where)
                ),
                at(&s.path),
                Some(
                    JsObject::new()
                        .with("where", s.r#where.as_str())
                        .with("roles", roles_js()),
                ),
            ));
            continue;
        };
        if is_role(role) != Some(false) {
            continue;
        }
        let near = closest(role, &roles);
        // `own(program.defs, s.role) ?? (imported.has(s.role) ? own(all, s.role) : undefined)`.
        let what = defs.get(role).or_else(|| {
            if imported.contains(&role) {
                all.get(role)
            } else {
                None
            }
        });
        let why = match what {
            Some(d) => {
                // `what.kind`, written as a template literal writes it.
                let k = d.get("kind").map_or_else(
                    || "undefined".to_owned(),
                    |k| JsValue::from(k).to_js_string(),
                );
                format!("'{role}' is {} {k}, not a role", article(&k))
            }
            None => format!("'{role}' is not a role this module defines or imports"),
        };
        let mut d = Diagnostic::new(
            "E1501",
            format!(
                "{} names the role '{role}', but {why}. Define it: role {role} \"…\" (spec/envelope.md).",
                subject(&s.r#where)
            ),
            at(&s.path),
            Some(
                JsObject::new()
                    .with("role", role)
                    .with("where", s.r#where.as_str())
                    .with("roles", roles_js())
                    .with_some("did_you_mean", near.as_deref()),
            ),
        );
        if let Some(near) = near.as_deref() {
            d = d.with_repair(vec![Repair {
                id: "r1".to_owned(),
                summary: format!("Use '{near}'"),
                patch: vec![RepairOp {
                    op: RepairOpKind::Replace,
                    path: s.path.clone(),
                    value: Some(s.value.value(near)),
                }],
                risk: Risk::Low,
                requires_approval: None,
            }]);
        }
        out.push(d);
    }

    // E1503: the approvals of one criterion open one after the other, so
    // `distinct_from` can only name a role an earlier one of them asked.
    let mut in_criterion: Vec<String> = Vec::new();
    let mut contracts: Vec<(&str, &Value)> = defs.iter().collect();
    contracts.sort_by(|a, b| compare_utf16(a.0, b.0));
    for (name, value) in contracts {
        let d = Definition::of(value);
        if d.kind() != Some(DefKind::Contract) {
            continue;
        }
        for (group, criteria) in [
            ("accept", d.accept().collect::<Vec<_>>()),
            ("invariant", d.invariant().collect::<Vec<_>>()),
        ] {
            let mut criteria = criteria;
            criteria.sort_by(|a, b| compare_utf16(a.0, b.0));
            for (cn, c) in criteria {
                let mut found: Vec<Approval<'_>> = Vec::new();
                if let Some(by) = Criterion::of(c).and_then(Criterion::by) {
                    in_order(
                        by,
                        &format!("{}/by", ptr(&[&"defs", &name, &group, &cn])),
                        &mut found,
                    );
                }
                let mut earlier: Vec<String> = Vec::new();
                for Approval { call, path } in &found {
                    for (i, a) in call.arg_values().iter().enumerate() {
                        let Some(a) = Arg::of(a) else { continue };
                        if a.name() != Some("distinct_from") {
                            continue;
                        }
                        let p = format!("{path}/args/{i}/value");
                        in_criterion.push(p.clone());
                        let Some(other) = named(a.value()) else {
                            continue;
                        };
                        if earlier.iter().any(|e| e == other) {
                            continue;
                        }
                        out.push(Diagnostic::new(
                            "E1503",
                            format!(
                                "distinct_from names '{other}', but no approval earlier in criterion {name}.{cn} asks that role (spec/envelope.md \"distinct_from\")."
                            ),
                            at(&p),
                            Some(
                                JsObject::new().with("distinct_from", other).with(
                                    "approved_earlier",
                                    JsValue::Array(
                                        earlier.iter().map(|e| JsValue::from(e.as_str())).collect(),
                                    ),
                                ),
                            ),
                        ));
                    }
                    // `named(call.args.find((a) => a.name === "role")?.value)`.
                    let role = call
                        .args()
                        .find(|a| a.name() == Some("role"))
                        .and_then(|a| named(a.value()));
                    if let Some(role) = role {
                        earlier.push(role.to_owned());
                    }
                }
            }
        }
    }
    for s in &sites {
        if !s.distinct || in_criterion.contains(&s.path) {
            continue;
        }
        out.push(Diagnostic::new(
            "E1503",
            "distinct_from compares two approvals of one contract criterion; this approval is not in one (spec/envelope.md \"distinct_from\").",
            at(&s.path),
            Some(
                JsObject::new()
                    .with_some("distinct_from", s.role.as_deref())
                    .with("approved_earlier", JsValue::Array(Vec::new())),
            ),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{article, subject};

    /// The expectations are what `subject` and `article` of
    /// `compiler/dist/check/roles.js` (module-private, taken out of its
    /// text with `new Function`) give on the same inputs.
    #[test]
    fn subjects_and_articles() {
        assert_eq!(subject("a component's owner"), "A component's owner");
        assert_eq!(subject("an escalation"), "An escalation");
        assert_eq!(subject("human.ask"), "human.ask");
        assert_eq!(subject("an"), "an");
        assert_eq!(subject("another"), "another");
        assert_eq!(article("agent"), "an");
        assert_eq!(article("effect"), "an");
        assert_eq!(article("type"), "a");
        assert_eq!(article("Interface"), "a");
    }
}
