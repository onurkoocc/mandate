// The envelope's own rules (0.4; spec/envelope.md "The envelope", "Static checks").
//
//   E1701  an envelope gives `owner`, `caps` and a `budget` with `agents`, and
//          its workflow writes no `caps` or `budget` of its own
//   E1704  every effect under `approve` is critical, and a capability of the
//          envelope covers it
//   E1707  `plan` stands only in the body of a workflow with an envelope
//
// E1702, E1703 and E1708 are a map's rules, and E1705 and E1706 a
// sub-program's: they come with `map` and `plan`. What an envelope bounds is
// checked where a workflow's caps and budget always were (static.ts: C1, C2,
// E0501 with `steps` and `agents`, E0220 with `spawn.max_class`).

import { ptrToken } from "../diag.js";
import type { Def, WorkflowDef } from "../ir/types.js";
import { showCap, type CapVal } from "./caps.js";

/** What the rules need of the checker. */
export interface EnvelopeEnv {
  report(code: string, message: string, path: string, facts?: Record<string, unknown>): void;
  /** Whether `effect` goes through prepare → authorize → commit. False for a name that is no effect. */
  isCritical(effect: string): boolean;
  /** The capabilities among `caps` that authorize `effect`. */
  covering(effect: string, caps: CapVal[]): CapVal[];
}

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** E1701 and E1704 for workflow `name`; `caps` are its envelope's capabilities, evaluated. */
export function checkEnvelope(name: string, d: WorkflowDef, base: string, caps: CapVal[], env: EnvelopeEnv): void {
  const e = d.envelope;
  if (!e) return;
  const at = `${base}/envelope`;
  const missing = [
    ...(e.owner === undefined ? ["owner"] : []),
    ...(e.caps === undefined ? ["caps"] : []),
    ...(e.budget === undefined ? ["budget"] : e.budget.agents === undefined ? ["budget.agents"] : []),
  ];
  if (missing.length) {
    env.report("E1701", `${name}'s envelope does not give ${list(missing)}. An envelope names its owner, its caps and a budget with agents: they are what a person approves (spec/envelope.md "What it declares").`, at, { missing });
  }
  if (d.caps.length) {
    env.report("E1701", `${name} has an envelope and caps of its own. The envelope's caps take their place: write them there.`, `${base}/caps`, { field: "caps" });
  }
  if (d.budget) {
    env.report("E1701", `${name} has an envelope and a budget of its own. The envelope's budget takes its place: write it there.`, `${base}/budget`, { field: "budget" });
  }
  for (const [effect, role] of Object.entries(e.approve ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const path = `${at}/approve/${ptrToken(effect)}`;
    if (!env.isCritical(effect)) {
      env.report("E1704", `${name}'s envelope asks ${role} to approve '${effect}', which is not a critical effect. Only an effect that goes through prepare → authorize → commit is authorized by anyone.`, path, { effect, role, critical: false });
      continue;
    }
    if (!env.covering(effect, caps).length) {
      env.report("E1704", `${name}'s envelope asks ${role} to approve '${effect}', but no capability in the envelope's caps covers it, so nothing in the run can do it.`, path, {
        effect,
        role,
        critical: true,
        available: caps.map(showCap),
      });
    }
  }
}

/** Every `plan` under `v`, by JSON Pointer. */
function plans(v: unknown, path: string, found: string[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => plans(x, `${path}/${i}`, found));
    return;
  }
  if (!v || typeof v !== "object") return;
  if ((v as { op?: unknown }).op === "plan") found.push(path);
  for (const [k, x] of Object.entries(v)) plans(x, `${path}/${ptrToken(k)}`, found);
}

/**
 * E1707: a `plan` anywhere but the body of a workflow with an envelope. A
 * lead's sub-programs are held to what is left of an envelope, so without
 * one there is nothing to hold them to; a function's body is not a
 * workflow's, whoever calls it.
 */
export function plansOutside(defs: Record<string, Def>, report: EnvelopeEnv["report"]): void {
  for (const [name, d] of Object.entries(defs)) {
    const base = `/defs/${ptrToken(name)}`;
    const found: string[] = [];
    const inEnvelope = d.kind === "workflow" && !!d.envelope;
    for (const [k, x] of Object.entries(d)) {
      if (inEnvelope && k === "body") continue;
      plans(x, `${base}/${ptrToken(k)}`, found);
    }
    for (const path of found.sort()) {
      const why =
        d.kind !== "workflow" ? `${name} is ${/^[aeiou]/.test(d.kind) ? "an" : "a"} ${d.kind}` : inEnvelope ? `this one is outside ${name}'s body` : `${name} has no envelope`;
      report("E1707", `'plan … within envelope' stands only in the body of a workflow with an envelope, and ${why} (spec/envelope.md "plan").`, path, { def: name, kind: d.kind, envelope: inEnvelope });
    }
  }
}
