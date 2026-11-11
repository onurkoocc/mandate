// Runs the language-neutral conformance cases in conformance/<id>/ (see
// conformance/README.md). The case files are the product; this is one reader of them.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { check, kindOf, load, loadModules, type CheckResult, type SourceKind } from "../src/check.js";
import type { Diagnostic } from "../src/diag.js";
import { hasErrors } from "../src/diag.js";
import type { Lock } from "../src/lock.js";
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

export interface Case {
  format: string;
  id: string;
  kind: "compile" | "run";
  title: string;
  spec: string[];
  language?: string;
  input: { file: string; kind: SourceKind } | { text: string; kind: SourceKind };
  modules?: string[];
  lock?: string | null;
  patch?: PatchOpJson[];
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
    if (have.at.path !== want.path) problems.push(`diagnostic ${i} (${want.code}): expected path ${JSON.stringify(want.path)}, got ${JSON.stringify(have.at.path)}`);
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

/** Runs a `compile` case with this compiler and returns what it observed. */
export function runCompileCase(name: string, c: Case): CheckResult {
  const dir = join(CASES_DIR, name);
  let text: string;
  if ("text" in c.input) text = c.input.text;
  else text = readFileSync(caseFile(dir, c.input.file), "utf8");
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

  if (c.patch !== undefined) {
    const base = load(text, kind);
    if (!base.program || hasErrors(base.diagnostics)) {
      throw new Error(`the input of a patch case must load before the patch: ${base.diagnostics.map((d) => `${d.code} at ${d.at.path ?? ""}`).join(", ")}`);
    }
    text = JSON.stringify(applyJsonPatch(base.program, c.patch));
    kind = "json";
  }

  const result = check(text, kind, { modules: loaded.modules, ...(lock ? { lock } : {}) });
  if (c.language !== undefined) {
    const declared = result.program?.language;
    if (declared !== c.language) throw new Error(`the case says language ${c.language}, the program declares ${String(declared)}`);
  }
  return result;
}
