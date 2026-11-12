// Roles (0.4; spec/envelope.md "Roles").
//
// A role is a definition people hold; the lock says who holds it. This file
// finds every place a program names a role, and for a 0.4 module checks:
//
//   E1501  each of them names a `role` definition, local or imported with `use`
//   E1503  `distinct_from` names a role approved earlier in the same criterion
//
// E1502 (every role has a member in the lock) is with the lock checks, in lock.ts.
//
// A 0.1 to 0.3 module names a role with any text and has no role definitions,
// so neither rule applies to it.

import { diag, ptr, ptrToken, type Diagnostic, type Repair, type Span } from "../diag.js";
import { atLeast, type Def, type Expr, type Program, type Verifier } from "../ir/types.js";
import { nearestSpan } from "../ir/validate.js";
import { closest } from "../resolve/resolve.js";
import { calleePath } from "./caps.js";

export interface RoleSite {
  /** The definition the place is in. */
  def: string;
  /** The role named; undefined when the place holds something that is not a name. */
  role: string | undefined;
  /** JSON Pointer of the name. */
  path: string;
  /** What names it, for a message: "a component's owner". */
  where: string;
  /** `distinct_from` names a role to compare with, not the role that decides. */
  distinct: boolean;
  /** The IR value that names `role` at this place. */
  value: (role: string) => unknown;
}

type Node = Record<string, unknown>;

/** `role: code_owner` and `role: "code_owner"` name the same role. */
function named(e: Expr | undefined): string | undefined {
  return e?.op === "var" ? e.name : e?.op === "text" ? e.value : undefined;
}

function asValue(e: Expr): (role: string) => unknown {
  return e.op === "text" ? (role) => ({ op: "text", value: role }) : (role) => ({ op: "var", name: role });
}

/** The calls that wait for a person and may name the role that answers. */
const PERSON_CALLS = new Set(["human.approve", "human.ask", "human"]);

/**
 * Every place the definitions name a role, in the order of their paths: a
 * component's owner, an environment's authorization, an envelope's owner and
 * approvals, a change set's approvers, `human.approve`, `human.ask`,
 * `escalate human(…)` and `supervise escalate(human, …)`.
 */
export function roleSites(defs: Record<string, Def>): RoleSite[] {
  const out: RoleSite[] = [];
  let def = "";
  const text = (role: string, path: string, where: string): void => {
    out.push({ def, role, path, where, distinct: false, value: (r) => r });
  };
  const arg = (a: { name?: string; value: Expr }, path: string, where: string): void => {
    out.push({ def, role: named(a.value), path, where, distinct: a.name === "distinct_from", value: asValue(a.value) });
  };

  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}/${i}`));
    if (!v || typeof v !== "object") return;
    const o = v as Node;
    if (o["op"] === "changeset") {
      const cs = v as Extract<Expr, { op: "changeset" }>;
      text(cs.approver, `${path}/approver`, "a change set's approver");
      for (const [m, mem] of Object.entries(cs.members)) {
        if (mem.approver !== undefined) text(mem.approver, `${path}/members/${ptrToken(m)}/approver`, "a change set member's approver");
      }
    }
    if (o["op"] === "call") {
      const call = v as Extract<Expr, { op: "call" }>;
      const callee = calleePath(call.callee);
      if (callee && PERSON_CALLS.has(callee)) {
        call.args.forEach((a, i) => {
          if (a.name === "role" || (a.name === "distinct_from" && callee === "human.approve")) arg(a, `${path}/args/${i}/value`, callee === "human" ? "an escalation" : callee);
        });
      }
    }
    const sup = o["supervise"] as { name?: unknown; args?: Array<{ name?: string; value: Expr }> } | undefined;
    if (sup && typeof sup === "object" && sup.name === "escalate") {
      (sup.args ?? []).forEach((a, i) => {
        if (a.name === "role") arg(a, `${path}/supervise/args/${i}/value`, "a supervision's escalation");
      });
    }
    for (const [k, x] of Object.entries(o)) walk(x, `${path}/${ptrToken(k)}`);
  };

  for (const [name, d] of Object.entries(defs)) {
    const base = ptr("defs", name);
    def = name;
    if (d.kind === "component") text(d.owner, `${base}/owner`, "a component's owner");
    if (d.kind === "environment") {
      for (const [effect, tier] of Object.entries(d.authorize ?? {})) {
        if (tier.by === "human") text(tier.role, `${base}/authorize/${ptrToken(effect)}/role`, "an environment's authorization");
      }
    }
    if (d.kind === "workflow" && d.envelope) {
      if (d.envelope.owner !== undefined) text(d.envelope.owner, `${base}/envelope/owner`, "an envelope's owner");
      for (const [effect, role] of Object.entries(d.envelope.approve ?? {})) text(role, `${base}/envelope/approve/${ptrToken(effect)}`, "an envelope's approval");
    }
    walk(d, base);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The roles the definitions name, each once, sorted. */
export function rolesNamed(defs: Record<string, Def>): string[] {
  return [...new Set(roleSites(defs).flatMap((s) => (s.role === undefined ? [] : [s.role])))].sort();
}

/**
 * E1501 and E1503 for a 0.4 module. `linked` is the table of definitions the
 * program sees with its imported modules loaded (modules.ts); a role imported
 * from a module that is not loaded is taken on trust, as any imported name is.
 */
export function roleChecks(program: Program, spans?: Map<string, Span>, linked?: Record<string, Def>): Diagnostic[] {
  if (!atLeast(program.language, "mandate/0.4")) return [];
  const out: Diagnostic[] = [];
  const at = (path: string): { path: string; span?: Span } => {
    const span = nearestSpan(spans, path);
    return span ? { path, span } : { path };
  };
  const imported = new Set((program.uses ?? []).flatMap((u) => u.names ?? []));
  const all = linked ?? program.defs;
  const own = (defs: Record<string, Def>, name: string): Def | undefined => (Object.hasOwn(defs, name) ? defs[name] : undefined);
  /** Whether `name` is a role here; undefined when its module is not loaded. */
  const isRole = (name: string): boolean | undefined => {
    const local = own(program.defs, name);
    if (local) return local.kind === "role";
    if (!imported.has(name)) return false;
    const def = own(all, name);
    return def ? def.kind === "role" : undefined;
  };
  const roles = [...new Set([...Object.keys(program.defs), ...imported])].filter((n) => isRole(n) === true).sort();

  const sites = roleSites(program.defs);
  for (const s of sites) {
    if (s.role === undefined) {
      out.push(diag("E1501", `${subject(s.where)} names a role: write the name of a role definition (spec/envelope.md).`, at(s.path), { facts: { where: s.where, roles } }));
      continue;
    }
    if (isRole(s.role) !== false) continue;
    const near = closest(s.role, roles);
    const repair: Repair[] = near ? [{ id: "r1", summary: `Use '${near}'`, patch: [{ op: "replace", path: s.path, value: s.value(near) }], risk: "low" }] : [];
    const what = own(program.defs, s.role) ?? (imported.has(s.role) ? own(all, s.role) : undefined);
    const why = what ? `'${s.role}' is ${article(what.kind)} ${what.kind}, not a role` : `'${s.role}' is not a role this module defines or imports`;
    out.push(
      diag("E1501", `${subject(s.where)} names the role '${s.role}', but ${why}. Define it: role ${s.role} "…" (spec/envelope.md).`, at(s.path), {
        facts: { role: s.role, where: s.where, roles, ...(near ? { did_you_mean: near } : {}) },
        ...(repair.length ? { repair } : {}),
      }),
    );
  }

  // E1503: the approvals of one criterion open one after the other, so `distinct_from` can only
  // name a role an earlier one of them asked.
  const inCriterion = new Set<string>();
  const approvals = (v: unknown, path: string, found: Array<{ call: Extract<Expr, { op: "call" }>; path: string }>): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => approvals(x, `${path}/${i}`, found));
    if (!v || typeof v !== "object") return;
    const o = v as Node;
    if (o["op"] === "call" && calleePath((v as Extract<Expr, { op: "call" }>).callee) === "human.approve") found.push({ call: v as Extract<Expr, { op: "call" }>, path });
    for (const [k, x] of Object.entries(o)) approvals(x, `${path}/${ptrToken(k)}`, found);
  };
  const inOrder = (v: Verifier, path: string, found: Array<{ call: Extract<Expr, { op: "call" }>; path: string }>): void => {
    if ("all" in v) v.all.forEach((x, i) => inOrder(x, `${path}/all/${i}`, found));
    else if ("static" in v) approvals(v.static, `${path}/static`, found);
    else approvals(v.call, `${path}/call`, found);
  };
  for (const [name, d] of Object.entries(program.defs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (d.kind !== "contract") continue;
    for (const group of ["accept", "invariant"] as const) {
      for (const [cn, c] of Object.entries(d[group] ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const found: Array<{ call: Extract<Expr, { op: "call" }>; path: string }> = [];
        inOrder(c.by, `${ptr("defs", name, group, cn)}/by`, found);
        const earlier: string[] = [];
        for (const { call, path } of found) {
          call.args.forEach((a, i) => {
            if (a.name !== "distinct_from") return;
            const p = `${path}/args/${i}/value`;
            inCriterion.add(p);
            const other = named(a.value);
            if (other === undefined || earlier.includes(other)) return;
            out.push(
              diag("E1503", `distinct_from names '${other}', but no approval earlier in criterion ${name}.${cn} asks that role (spec/envelope.md "distinct_from").`, at(p), {
                facts: { distinct_from: other, approved_earlier: [...earlier] },
              }),
            );
          });
          const role = named(call.args.find((a) => a.name === "role")?.value);
          if (role !== undefined) earlier.push(role);
        }
      }
    }
  }
  for (const s of sites) {
    if (!s.distinct || inCriterion.has(s.path)) continue;
    out.push(
      diag("E1503", "distinct_from compares two approvals of one contract criterion; this approval is not in one (spec/envelope.md \"distinct_from\").", at(s.path), {
        facts: { ...(s.role !== undefined ? { distinct_from: s.role } : {}), approved_earlier: [] },
      }),
    );
  }
  return out;
}

/** `where` at the start of a sentence: "A component's owner", but `human.ask` as it is written. */
function subject(where: string): string {
  return /^an? /.test(where) ? where.charAt(0).toUpperCase() + where.slice(1) : where;
}

function article(kind: string): string {
  return /^[aeiou]/.test(kind) ? "an" : "a";
}
