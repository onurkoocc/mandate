// Runs the language-neutral conformance cases in conformance/<id>/ (see
// conformance/README.md). The case files are the product; this is one reader of them.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { check, checkAmendment, checkSubprogram, kindOf, load, loadModules, type AmendmentCheck, type AmendmentInput, type CheckResult, type SourceKind, type SubprogramCheck, type SubprogramInput } from "../src/check.js";
import type { CapVal } from "../src/check/caps.js";
import { skeleton } from "../src/check/subprogram.js";
import type { Diagnostic } from "../src/diag.js";
import { hasErrors } from "../src/diag.js";
import { hashProgram } from "../src/hash.js";
import type { Program } from "../src/ir/types.js";
import type { Json } from "../src/json/strict-json.js";
import type { Lock } from "../src/lock.js";
import type { Modules } from "../src/modules.js";
import { applyOps } from "../src/patch/patch.js";
import { CAP_CTORS, DATA_CLASSES, type DataClass } from "../src/std/std.js";
import { repoRoot } from "./helpers.js";

export const CASES_DIR = join(repoRoot, "conformance");
export const CASE_FORMAT = "mandate/conformance-case/0.1";

export interface ExpectedDiagnostic {
  code: string;
  path: string;
  facts?: Record<string, unknown>;
}

export interface CaseExpect {
  ok: boolean;
  diagnostics: ExpectedDiagnostic[];
  hashes?: { program?: string; defs?: Record<string, string> };
}

export interface PatchOpJson {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

export type CaseSource = { file: string; kind: SourceKind } | { text: string; kind: SourceKind };

/** A lead's sub-program, checked with the case's input as its parent (conformance/README.md). */
export interface CaseSubprogram {
  workflow: string;
  number?: number;
  defs?: CaseSource;
  patch?: PatchOpJson[];
  lead?: DataClass;
  room: {
    left: Record<string, number>;
    time_left_ms?: number;
    writes?: Array<{ ctor: string; scope: string[] }>;
  };
}

/** An amendment of an envelope, checked with the case's input as the program the run has (conformance/README.md). */
export interface CaseAmendment {
  workflow: string;
  patch: PatchOpJson[];
}

export interface Case {
  format: string;
  id: string;
  kind: "compile" | "run";
  title: string;
  spec: string[];
  language?: string;
  input: CaseSource;
  modules?: string[];
  lock?: string | null;
  patch?: PatchOpJson[];
  base?: string;
  subprogram?: CaseSubprogram;
  amendment?: CaseAmendment;
  expect: CaseExpect;
}

/** What the comparison reads from a compiler result. */
export interface Observed {
  ok: boolean;
  diagnostics: Array<Pick<Diagnostic, "code" | "facts"> & { at: { path?: string } }>;
  hashes?: unknown;
}

// ---------------------------------------------------------------- comparison

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Compares what the compiler returned with what the case expects and lists every difference;
 * an empty list means the case holds. Diagnostics match in order, one to one, by code and path.
 * Facts match as a subset. Messages and spans are never compared.
 */
export function compareResult(expect: CaseExpect, got: Observed): string[] {
  const problems: string[] = [];
  if (got.ok !== expect.ok) problems.push(`ok: expected ${expect.ok}, got ${got.ok}`);
  const show = (d: { code: string; at?: { path?: string }; path?: string }): string => `${d.code} at ${JSON.stringify(d.at ? d.at.path : d.path)}`;
  const n = Math.max(expect.diagnostics.length, got.diagnostics.length);
  for (let i = 0; i < n; i++) {
    const want = expect.diagnostics[i];
    const have = got.diagnostics[i];
    if (!want) {
      problems.push(`diagnostic ${i}: unexpected ${show(have!)}`);
      continue;
    }
    if (!have) {
      problems.push(`diagnostic ${i}: missing ${show(want)}`);
      continue;
    }
    if (have.code !== want.code) problems.push(`diagnostic ${i}: expected code ${want.code}, got ${have.code}`);
    // A diagnostic without a path (a reader error that has only a span) is at "".
    if ((have.at.path ?? "") !== want.path) problems.push(`diagnostic ${i} (${want.code}): expected path ${JSON.stringify(want.path)}, got ${JSON.stringify(have.at.path ?? "")}`);
    for (const [key, value] of Object.entries(want.facts ?? {})) {
      const found = have.facts !== undefined && Object.hasOwn(have.facts, key) ? have.facts[key] : undefined;
      if (!deepEqual(found, value)) {
        problems.push(`diagnostic ${i} (${want.code}): fact ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(found)}`);
      }
    }
  }
  if (expect.hashes !== undefined && !deepEqual(got.hashes, expect.hashes)) {
    problems.push(`hashes: expected ${JSON.stringify(expect.hashes)}, got ${JSON.stringify(got.hashes)}`);
  }
  return problems;
}

// ---------------------------------------------------------------- RFC 6902

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

function tokens(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`"${pointer}" is not a JSON Pointer`);
  return pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function index(token: string, length: number, allowEnd: boolean): number {
  if (allowEnd && token === "-") return length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error(`"${token}" is not an array index`);
  const i = Number(token);
  if (i > length || (i === length && !allowEnd)) throw new Error(`index ${i} is out of range`);
  return i;
}

/** Applies RFC 6902 `add`, `replace` and `remove` to a copy of `doc`. Any other op is refused. */
export function applyJsonPatch(doc: unknown, ops: readonly PatchOpJson[]): unknown {
  let root = structuredClone(doc) as JsonValue;
  for (const [n, op] of ops.entries()) {
    const where = `patch operation ${n} (${String(op.op)} ${op.path})`;
    if (op.op !== "add" && op.op !== "replace" && op.op !== "remove") {
      throw new Error(`${where}: op "${String(op.op)}" is not supported; use add, replace or remove`);
    }
    try {
      const path = tokens(op.path);
      if (path.length === 0) {
        if (op.op === "remove") throw new Error("the document root cannot be removed");
        root = structuredClone(op.value) as JsonValue;
        continue;
      }
      let parent: JsonValue = root;
      for (const t of path.slice(0, -1)) parent = child(parent, t);
      const last = path[path.length - 1]!;
      if (Array.isArray(parent)) {
        if (op.op === "add") parent.splice(index(last, parent.length, true), 0, structuredClone(op.value) as JsonValue);
        else if (op.op === "replace") parent[index(last, parent.length, false)] = structuredClone(op.value) as JsonValue;
        else parent.splice(index(last, parent.length, false), 1);
      } else if (parent !== null && typeof parent === "object") {
        const exists = Object.hasOwn(parent, last);
        if (op.op !== "add" && !exists) throw new Error(`there is no member "${last}"`);
        if (op.op === "remove") delete parent[last];
        else parent[last] = structuredClone(op.value) as JsonValue;
      } else {
        throw new Error("the parent is not an object or an array");
      }
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
  }
  return root;
}

function child(parent: JsonValue, token: string): JsonValue {
  if (Array.isArray(parent)) return parent[index(token, parent.length, false)]!;
  if (parent !== null && typeof parent === "object" && Object.hasOwn(parent, token)) return parent[token]!;
  throw new Error(`there is no member "${token}"`);
}

// ---------------------------------------------------------------- reading cases

let validator: ValidateFunction | undefined;

function caseValidator(): ValidateFunction {
  validator ??= new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(join(CASES_DIR, "case.schema.json"), "utf8")) as object);
  return validator;
}

/** Validates a parsed case.json against conformance/case.schema.json; the problems, or none. */
export function schemaProblems(value: unknown): string[] {
  const v = caseValidator();
  if (v(value)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}

/** The case directories under conformance/, by name. */
export function caseDirs(): string[] {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((name) => statSync(join(CASES_DIR, name)).isDirectory())
    .sort();
}

/** Resolves a path named in a case against the case directory; it must stay inside the repository. */
export function caseFile(dir: string, file: string): string {
  if (isAbsolute(file)) throw new Error(`path "${file}" is absolute; paths are relative to the case directory`);
  const full = resolve(dir, file);
  const rel = relative(repoRoot, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path "${file}" leaves the repository`);
  return full;
}

/** Reads and validates conformance/<name>/case.json. Throws when the directory is not a good case. */
export function readCase(name: string): Case {
  const dir = join(CASES_DIR, name);
  const file = join(dir, "case.json");
  if (!existsSync(file)) throw new Error(`conformance/${name} has no case.json`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`conformance/${name}/case.json is not JSON: ${(e as Error).message}`);
  }
  const problems = schemaProblems(value);
  if (problems.length > 0) throw new Error(`conformance/${name}/case.json does not match case.schema.json:\n  ${problems.join("\n  ")}`);
  const c = value as Case;
  if (c.id !== name) throw new Error(`conformance/${name}/case.json has id ${c.id}; it must equal the directory name`);
  return c;
}

// ---------------------------------------------------------------- running

function sourceText(dir: string, src: CaseSource): string {
  return "text" in src ? src.text : readFileSync(caseFile(dir, src.file), "utf8");
}

/**
 * What `checkSubprogram` receives for a case's `subprogram`, with `parent` as the
 * program it stands under. The operations are one `add` for each definition of
 * `defs`, in order, then `patch` as it is written. Throws when the case is not good.
 */
export function subprogramInput(dir: string, s: CaseSubprogram, parent: Program, modules: Modules): SubprogramInput {
  const number = s.number ?? 1;
  const ops: SubprogramInput["ops"] = [];
  if (s.defs !== undefined) {
    const r = load(sourceText(dir, s.defs), s.defs.kind);
    if (!r.program || hasErrors(r.diagnostics)) {
      throw new Error(`the defs of a subprogram case must load: ${r.diagnostics.map((d) => `${d.code} at ${d.at.path ?? ""}`).join(", ")}`);
    }
    // Only the definitions are read; the module's header is not.
    for (const [name, def] of Object.entries(r.program.defs)) ops.push({ op: "add", path: `/defs/${name}`, value: def });
  }
  ops.push(...(s.patch ?? []));
  const lead = s.lead ?? "public";
  if (!DATA_CLASSES.includes(lead)) throw new Error(`lead ${String(lead)} is not a data class`);
  const writes: CapVal[] = (s.room.writes ?? []).map((w) => {
    const spec = Object.hasOwn(CAP_CTORS, w.ctor) ? CAP_CTORS[w.ctor] : undefined;
    if (!spec?.write) throw new Error(`room.writes: ${w.ctor} is not a write capability constructor`);
    return { ctor: w.ctor, effect: spec.effect, write: spec.write, scope: [...w.scope] };
  });
  return {
    parent,
    modules,
    workflow: s.workflow,
    number,
    base: hashProgram(skeleton(parent.module, number) as unknown as Json).program,
    ops,
    lead,
    room: { left: { ...s.room.left }, ...(s.room.time_left_ms !== undefined ? { time_left_ms: s.room.time_left_ms } : {}), writes },
  };
}

/**
 * What `checkAmendment` receives for a case's `amendment`, with `parent` as the program
 * the run has: the envelope of the case's workflow with the patch applied to it. Throws
 * when the case is not good.
 */
export function amendmentInput(a: CaseAmendment, parent: Program, modules: Modules): AmendmentInput {
  const wf = Object.hasOwn(parent.defs, a.workflow) ? parent.defs[a.workflow] : undefined;
  if (wf?.kind !== "workflow" || !wf.envelope) throw new Error(`amendment.workflow: ${a.workflow} is not a workflow with an envelope`);
  return { parent, modules, workflow: a.workflow, envelope: applyJsonPatch(wf.envelope, a.patch) };
}

/** An amendment's check, with the hash of the program it makes where a case's `hashes` are read. */
export type AmendmentObserved = AmendmentCheck & { hashes?: { program: string } };

/** What a patch case with `base` observes when the patch is refused before the patched program is checked. */
export interface PatchRefused {
  ok: false;
  diagnostics: Diagnostic[];
}

/** Runs a `compile` case with this compiler and returns what it observed. */
export function runCompileCase(name: string, c: Case): CheckResult | SubprogramCheck | AmendmentObserved | PatchRefused {
  const dir = join(CASES_DIR, name);
  let text = sourceText(dir, c.input);
  let kind = c.input.kind;

  const sources = (c.modules ?? []).map((m) => {
    const full = caseFile(dir, m);
    return { text: readFileSync(full, "utf8"), kind: kindOf(full), file: m };
  });
  const loaded = loadModules(sources);
  if (loaded.problems.length > 0) {
    const first = loaded.problems[0]!;
    throw new Error(`module ${first.file} does not load: ${first.diagnostics.map((d) => d.code).join(", ")}`);
  }
  const lock = typeof c.lock === "string" ? (JSON.parse(readFileSync(caseFile(dir, c.lock), "utf8")) as Lock) : undefined;

  /** The program a sub-program or an amendment stands on: it checks, and it declares the case's language. */
  const standsOn = (what: string): Program => {
    const parent = check(text, kind, { modules: loaded.modules });
    if (!parent.ok || !parent.program) {
      throw new Error(`the ${what} must check without errors: ${parent.diagnostics.map((d) => `${d.code} at ${d.at.path ?? ""}`).join(", ")}`);
    }
    if (c.language !== undefined && parent.program.language !== c.language) throw new Error(`the case says language ${c.language}, the parent declares ${parent.program.language}`);
    return parent.program;
  };

  if (c.amendment !== undefined) {
    if (c.patch !== undefined || c.lock !== undefined || c.subprogram !== undefined) {
      throw new Error("an amendment case has no top-level patch or lock, and no subprogram; the new envelope is the old one with amendment.patch");
    }
    const r = checkAmendment(amendmentInput(c.amendment, standsOn("program of an amendment case"), loaded.modules));
    return r.hash !== undefined ? { ...r, hashes: { program: r.hash } } : r;
  }

  if (c.subprogram !== undefined) {
    if (c.patch !== undefined || c.lock !== undefined) throw new Error("a subprogram case has no top-level patch or lock; the lead's operations go in subprogram.patch");
    return checkSubprogram(subprogramInput(dir, c.subprogram, standsOn("parent of a subprogram case"), loaded.modules));
  }

  if (c.base !== undefined && c.patch === undefined) throw new Error("base is the hash a patch was written against; a case with base has a patch");
  if (c.patch !== undefined) {
    const before = load(text, kind);
    if (!before.program || hasErrors(before.diagnostics)) {
      throw new Error(`the input of a patch case must load before the patch: ${before.diagnostics.map((d) => `${d.code} at ${d.at.path ?? ""}`).join(", ")}`);
    }
    if (c.base !== undefined) {
      // Applied as `mandate.apply_patch` does: against a base. A stale one (E0130) or an operation that cannot be applied (E0131) is the result.
      const applied = applyOps(before.program, c.base, c.patch);
      if (!applied.program) return { ok: false, diagnostics: applied.diagnostics };
      text = JSON.stringify(applied.program);
    } else {
      text = JSON.stringify(applyJsonPatch(before.program, c.patch));
    }
    kind = "json";
  }

  const result = check(text, kind, { modules: loaded.modules, ...(lock ? { lock } : {}) });
  if (c.language !== undefined) {
    // A program that does not load still declares a language: a case about an older program that
    // uses a newer construct says which older version it is.
    let declared: unknown = result.program?.language;
    if (declared === undefined && kind === "json") {
      try {
        declared = (JSON.parse(text) as { language?: unknown } | null)?.language;
      } catch {
        // Not JSON: nothing is declared.
      }
    }
    if (declared !== c.language) throw new Error(`the case says language ${c.language}, the program declares ${String(declared)}`);
  }
  return result;
}
