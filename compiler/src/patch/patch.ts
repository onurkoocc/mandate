// Structural IR patches (Doc 4 §14 `mandate.apply_patch`, §16.1 ApplyPatch).
//
// A patch names the program hash it was written against. If the program has
// moved on, the patch is refused with stale_base (S12) instead of being merged
// by position. Patches that widen authority are flagged as governance changes
// (§13.2) so a human sees them; this step reports them, it does not block them.
// The semantic diff (views/views.ts) classifies them, so a patch and a view agree.

import { diag, hasErrors, type Diagnostic } from "../diag.js";
import { hashProgram } from "../hash.js";
import type { Program } from "../ir/types.js";
import { validateIr } from "../ir/validate.js";
import type { Json } from "../json/strict-json.js";
import { link, type Modules } from "../modules.js";
import { resolveNames } from "../resolve/resolve.js";
import { governanceChanges, type GovernanceChangeKind } from "../views/views.js";

export interface PatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

/** `detail` is the change as the semantic diff shows it. */
export interface GovernanceChange {
  kind: GovernanceChangeKind;
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

/**
 * `modules`: what the program imports (a system model), linked in as `check` links it, so the patched
 * program's names resolve against them (modules.ts).
 */
export function applyPatch(program: Program, base: string, ops: PatchOp[], modules: Modules = {}): PatchResult {
  const patched = applyOps(program, base, ops);
  const diagnostics = patched.diagnostics;
  const next = patched.program;
  if (next) {
    const linked = link(next, modules);
    diagnostics.push(...linked.diagnostics, ...resolveNames(next, undefined, linked.defs));
  }
  if (!next || hasErrors(diagnostics)) return { ok: false, diagnostics, governance: [] };
  return { ok: true, diagnostics, governance: governance(program, next, modules), program: next, hash: hashProgram(next as unknown as Json).program };
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

/**
 * `program` with `ops` applied, when they were written against its hash and
 * what they make is valid IR. Names are not resolved: the caller says what
 * the patched program sees. A lead's sub-program is made this way from its
 * skeleton (check.ts `checkSubprogram`).
 */
export function applyOps(program: Program, base: string, ops: PatchOp[]): { program?: Program; diagnostics: Diagnostic[] } {
  const current = hashProgram(program as unknown as Json).program;
  if (current !== base) {
    return { diagnostics: [diag("E0130", "stale_base: the patch was written against an older version of the program.", { path: "" }, { facts: { base, current } })] };
  }
  let root = structuredClone(program) as unknown as Json;
  for (const [i, op] of ops.entries()) {
    try {
      root = applyOp(root, op);
    } catch (e) {
      return { diagnostics: [diag("E0131", `Patch operation ${i} (${op.op} ${op.path}) failed: ${(e as Error).message}`, { path: op.path }, { facts: { index: i } })] };
    }
  }
  const diagnostics = validateIr(root);
  return hasErrors(diagnostics) ? { diagnostics } : { program: root as unknown as Program, diagnostics };
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

/** The semantic diff's governance changes (views.ts), so a patch and `mandate view --against` classify a change alike. */
function governance(before: Program, after: Program, modules: Modules): GovernanceChange[] {
  return governanceChanges(before, after, modules).map((c) => ({ kind: c.kind, path: c.path, detail: c.text }));
}
