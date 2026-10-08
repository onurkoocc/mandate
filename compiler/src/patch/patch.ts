// Structural IR patches (Doc 4 §14 `mandate.apply_patch`, §16.1 ApplyPatch).
//
// A patch names the program hash it was written against. If the program has
// moved on, the patch is refused with stale_base (S12) instead of being merged
// by position. Patches that widen authority are flagged as governance changes
// (§13.2) so a human sees them; this step reports them, it does not block them.

import { diag, hasErrors, type Diagnostic } from "../diag.js";
import { hashProgram } from "../hash.js";
import type { Budget, Def, Program } from "../ir/types.js";
import { validateIr } from "../ir/validate.js";
import { canonicalize } from "../json/jcs.js";
import type { Json } from "../json/strict-json.js";
import { resolveNames } from "../resolve/resolve.js";

export interface PatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

export interface GovernanceChange {
  kind: "capability_added" | "budget_increased" | "criterion_removed" | "irreversible_added";
  path: string;
  detail: string;
}

export interface PatchResult {
  ok: boolean;
  program?: Program;
  hash?: string;
  diagnostics: Diagnostic[];
  governance: GovernanceChange[];
}

export function applyPatch(program: Program, base: string, ops: PatchOp[]): PatchResult {
  const current = hashProgram(program as unknown as Json).program;
  if (current !== base) {
    return {
      ok: false,
      governance: [],
      diagnostics: [
        diag("E0130", "stale_base: the patch was written against an older version of the program.", { path: "" }, {
          facts: { base, current },
        }),
      ],
    };
  }
  const next = structuredClone(program) as unknown as Json;
  let root: Json = next;
  for (const [i, op] of ops.entries()) {
    try {
      root = applyOp(root, op);
    } catch (e) {
      return {
        ok: false,
        governance: [],
        diagnostics: [
          diag("E0131", `Patch operation ${i} (${op.op} ${op.path}) failed: ${(e as Error).message}`, { path: op.path }, {
            facts: { index: i },
          }),
        ],
      };
    }
  }
  const diagnostics = validateIr(root);
  if (!hasErrors(diagnostics)) diagnostics.push(...resolveNames(root as unknown as Program));
  const ok = !hasErrors(diagnostics);
  const result: PatchResult = { ok, diagnostics, governance: ok ? governance(program, root as unknown as Program) : [] };
  if (ok) {
    result.program = root as unknown as Program;
    result.hash = hashProgram(root).program;
  }
  return result;
}

function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error("path must be a JSON Pointer starting with '/'");
  return path
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function applyOp(root: Json, op: PatchOp): Json {
  if (op.op !== "add" && op.op !== "remove" && op.op !== "replace") throw new Error(`unsupported op '${String(op.op)}'`);
  const tokens = parsePointer(op.path);
  if (tokens.length === 0) {
    if (op.op === "remove") throw new Error("cannot remove the root");
    return op.value as Json;
  }
  let parent: Json = root;
  for (const t of tokens.slice(0, -1)) {
    parent = child(parent, t);
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(parent)) {
    const idx = last === "-" ? parent.length : Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx > parent.length || (op.op !== "add" && idx >= parent.length)) {
      throw new Error(`index '${last}' out of range`);
    }
    if (op.op === "add") parent.splice(idx, 0, op.value as Json);
    else if (op.op === "remove") parent.splice(idx, 1);
    else parent[idx] = op.value as Json;
    return root;
  }
  if (parent === null || typeof parent !== "object") throw new Error(`'${last}' has no parent object`);
  if (op.op !== "add" && !Object.hasOwn(parent, last)) throw new Error(`no member '${last}'`);
  if (op.op === "remove") delete parent[last];
  else parent[last] = op.value as Json;
  return root;
}

function child(node: Json, token: string): Json {
  if (Array.isArray(node)) {
    const v = node[Number(token)];
    if (v === undefined) throw new Error(`index '${token}' out of range`);
    return v;
  }
  if (node !== null && typeof node === "object" && Object.hasOwn(node, token)) return node[token]!;
  throw new Error(`no member '${token}'`);
}

// ── governance classification (§13.2) ─────────────────────────────────────

function governance(before: Program, after: Program): GovernanceChange[] {
  const out: GovernanceChange[] = [];
  for (const [name, d] of Object.entries(after.defs)) {
    const prev: Def | undefined = before.defs[name];
    const base = `/defs/${name}`;
    if (d.kind === "capability" && (!prev || prev.kind !== "capability" || json(prev.value) !== json(d.value))) {
      out.push({ kind: "capability_added", path: base, detail: `capability '${name}' added or changed` });
    }
    if ((d.kind === "agent" || d.kind === "workflow") && prev && prev.kind === d.kind) {
      const had = new Set(prev.caps.map(json));
      d.caps.forEach((c, i) => {
        if (!had.has(json(c))) out.push({ kind: "capability_added", path: `${base}/caps/${i}`, detail: `${name} gains ${json(c)}` });
      });
    }
    if ((d.kind === "agent" || d.kind === "workflow" || d.kind === "fn") && prev && prev.kind === d.kind) {
      for (const detail of budgetGrowth(prev.budget, d.budget)) out.push({ kind: "budget_increased", path: `${base}/budget`, detail: `${name}: ${detail}` });
    }
    if (d.kind === "agent" && prev && prev.kind === "agent") {
      for (const [sn, s] of Object.entries(d.skills)) {
        const ps = prev.skills[sn];
        if (ps) for (const detail of budgetGrowth(ps.budget, s.budget)) out.push({ kind: "budget_increased", path: `${base}/skills/${sn}/budget`, detail: `${name}.${sn}: ${detail}` });
      }
    }
    if (d.kind === "effect" && d.irreversible && !(prev && prev.kind === "effect" && prev.irreversible)) {
      out.push({ kind: "irreversible_added", path: base, detail: `effect '${name}' is irreversible` });
    }
  }
  for (const [name, prev] of Object.entries(before.defs)) {
    if (prev.kind !== "contract") continue;
    const now = after.defs[name];
    for (const group of ["accept", "invariant"] as const) {
      for (const crit of Object.keys(prev[group] ?? {})) {
        if (!now || now.kind !== "contract" || !(crit in (now[group] ?? {}))) {
          out.push({ kind: "criterion_removed", path: `/defs/${name}/${group}/${crit}`, detail: `${name} drops ${group} criterion '${crit}'` });
        }
      }
    }
  }
  return out;
}

function budgetGrowth(a: Budget | undefined, b: Budget | undefined): string[] {
  if (!a) return [];
  if (!b) return ["budget removed"];
  const out: string[] = [];
  const cmp = (field: string, x: number | undefined, y: number | undefined): void => {
    if (x === undefined) return;
    if (y === undefined) out.push(`${field} limit removed`);
    else if (y > x) out.push(`${field} ${x} → ${y}`);
  };
  cmp("tokens", a.tokens, b.tokens);
  cmp("steps", a.steps, b.steps);
  cmp("time_ms", a.time?.ms, b.time?.ms);
  if (a.spend && b.spend && a.spend.currency !== b.spend.currency) out.push("spend currency changed");
  else cmp("spend_micros", a.spend?.micros, b.spend?.micros);
  return out;
}

function json(v: unknown): string {
  return canonicalize(v as Json);
}
