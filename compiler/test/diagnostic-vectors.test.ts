// Writes the diagnostic vectors in vectors/diagnostics/ (vectors/README.md, "diagnostics/"): the whole result the
// reference compiler gives for every conformance case it runs, and for the checks of every golden program, for the
// Rust compiler to match member for member, in the same order. Nothing here is product behaviour.
//
// The committed files must be what this test generates; it fails when one differs, is missing or is left over.
// To write them again: MANDATE_UPDATE_VECTORS=1 npm test.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check, load, type CheckResult } from "../src/check.js";
import { CODES } from "../src/codes.js";
import { isWellFormed, parseStrictJson } from "../src/json/strict-json.js";
import { kindOf } from "../src/check.js";
import { caseDirs, compareResult, readCase, runCompileCase, type Case, type Observed } from "./cases-runner.js";
import { digests, json, lockOf, moduleFilesOf, modulesOf, outputs, PROGRAMS } from "./golden-outputs.js";
import { lockFileOf, readRepo, repoRoot } from "./helpers.js";

/** The number of distinct codes the stored results hold; it changes only with a new case or a changed compiler. */
const EXPECTED_CODES_SEEN = 44;
const DIR = "vectors/diagnostics/";
/** A file stays well under the 1 MiB the Rust reader accepts, and the test below says 900 KB. */
const PART_LIMIT = 800_000;

/** JSON as the vector files hold it (see vectors.test.ts): two-space indents, a list of integers on one line, ASCII only. */
function vectorText(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
    .replace(/\[\n(?:\s*-?\d+,\n)*\s*-?\d+\n\s*\]/g, (a) => `[${a.slice(1, -1).trim().split(/,\s*/).join(", ")}]`)
    .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return text + "\n";
}

/** Whether the value holds a number the Rust reader refuses (not an integer, or beyond 2^53). */
function hasOtherNumber(v: unknown): boolean {
  if (typeof v === "number") return !Number.isSafeInteger(v);
  if (Array.isArray(v)) return v.some(hasOtherNumber);
  if (v && typeof v === "object") return Object.values(v).some(hasOtherNumber);
  return false;
}

/** A value as plain JSON (what `JSON.stringify` keeps, in the compiler's member order). */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

interface Diag {
  code: string;
  at: { path?: string };
  facts?: Record<string, unknown>;
}
type Result = { ok: boolean; diagnostics: Diag[]; hashes?: unknown };

// ---------------------------------------------------------------------------------------------------------
// The conformance cases

type Door = "check" | "check_patched" | "apply_ops" | "check_subprogram" | "check_amendment";

interface ConformanceVector {
  name: string;
  kind: string;
  door: Door;
  input: { file: string; kind: string } | { inline: true; kind: string };
  modules: string[];
  lock: string | null;
  uses: string[];
  result?: unknown;
  text?: string;
}

function doorOf(c: Case): Door {
  if (c.amendment !== undefined) return "check_amendment";
  if (c.subprogram !== undefined) return "check_subprogram";
  if (c.patch !== undefined) return c.base !== undefined ? "apply_ops" : "check_patched";
  return "check";
}

/** What a front door returns, as the vectors hold it: the members of the result, in its order, without the IR and spans a check also carries. */
function resultOf(door: Door, r: ReturnType<typeof runCompileCase>): { stored: unknown; observed: Observed } {
  let stored: Record<string, unknown>;
  if (door === "check" || door === "check_patched") {
    const c = r as CheckResult;
    stored = { ok: c.ok, ...(c.hashes ? { hashes: c.hashes } : {}), diagnostics: c.diagnostics };
  } else {
    // apply_ops (refused: { ok, diagnostics }; else a check), check_subprogram and check_amendment return their own members.
    const { spans: _spans, ...rest } = r as unknown as Record<string, unknown> & { spans?: unknown };
    if (door === "apply_ops" && "program" in rest) {
      const c = r as CheckResult;
      stored = { ok: c.ok, ...(c.hashes ? { hashes: c.hashes } : {}), diagnostics: c.diagnostics };
    } else if (door === "check_amendment") {
      const { hashes: _h, ...own } = rest;
      stored = own;
    } else {
      stored = rest;
    }
  }
  const value = plain(stored) as Result & { hash?: string };
  // The runner reads `hashes` of an amendment from the hash of the program with the new envelope.
  const observed: Observed = { ok: value.ok, diagnostics: value.diagnostics, ...(value.hashes !== undefined ? { hashes: value.hashes } : door === "check_amendment" && value.hash !== undefined ? { hashes: { program: value.hash } } : {}) };
  return { stored: value, observed };
}

function conformance(): { vectors: ConformanceVector[]; observed: Map<string, { c: Case; observed: Observed }> } {
  const vectors: ConformanceVector[] = [];
  const observedBy = new Map<string, { c: Case; observed: Observed }>();
  for (const name of caseDirs()) {
    const c = readCase(name);
    if (c.kind !== "compile") continue;
    const door = doorOf(c);
    const { stored, observed } = resultOf(door, runCompileCase(name, c));
    const v: ConformanceVector = {
      name: c.id,
      kind: c.kind,
      door,
      input: "file" in c.input ? { file: c.input.file, kind: c.input.kind } : { inline: true, kind: c.input.kind },
      modules: c.modules ?? [],
      lock: typeof c.lock === "string" ? c.lock : null,
      uses: (["patch", "base", "subprogram", "amendment"] as const).filter((k) => c[k] !== undefined),
    };
    if (hasOtherNumber(stored)) v.text = JSON.stringify(stored, null, 2) + "\n";
    else v.result = stored;
    vectors.push(v);
    observedBy.set(c.id, { c, observed });
  }
  return { vectors, observed: observedBy };
}

// ---------------------------------------------------------------------------------------------------------
// The golden programs

interface GoldenVector {
  program: string;
  modules: string[];
  lock: string | null;
  /** check, check_module, check_lock (where the program has a lock) and load, as values. */
  results: Record<string, unknown>;
  /** The results that hold a number the Rust reader refuses, as their exact text. */
  texts: Record<string, string>;
}

const SLOTS: Array<[slot: string, output: string]> = [
  ["check", "check"],
  ["check_module", "check --module"],
  ["check_lock", "check --lock"],
  ["load", "load"],
];

function golden(): GoldenVector[] {
  const out: GoldenVector[] = [];
  const shared = new Map<string, ReturnType<typeof modulesOf>>();
  for (const file of [...PROGRAMS].sort()) {
    const modFiles = moduleFilesOf(file);
    const key = modFiles.join("\n");
    if (!shared.has(key)) shared.set(key, modulesOf(modFiles));
    const mods = shared.get(key)!;
    const src = readRepo(file);
    const kind = kindOf(file);
    const lock = lockOf(file);
    const checkValue = (r: CheckResult): unknown => plain({ ok: r.ok, ...(r.hashes ? { hashes: r.hashes } : {}), diagnostics: r.diagnostics });
    const values: Record<string, unknown> = {
      check: checkValue(check(src, kind)),
      check_module: checkValue(check(src, kind, { modules: mods })),
      ...(lock ? { check_lock: checkValue(check(src, kind, { modules: mods, lock })) } : {}),
      load: plain(load(src, kind).diagnostics),
    };
    const results: Record<string, unknown> = {};
    const texts: Record<string, string> = {};
    for (const [slot] of SLOTS) {
      if (!(slot in values)) continue;
      if (hasOtherNumber(values[slot])) texts[slot] = json(values[slot]);
      else results[slot] = values[slot];
    }
    out.push({ program: file, modules: modFiles, lock: lockFileOf(file) ?? null, results, texts });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The summary and the files

function walkDiagnostics(c: ConformanceVector | GoldenVector): Diag[] {
  const results: unknown[] = "results" in c ? Object.values(c.results) : [c.result];
  if (!("results" in c) && c.text !== undefined) results.splice(0, 1, JSON.parse(c.text));
  if ("texts" in c) for (const t of Object.values(c.texts)) results.push(JSON.parse(t));
  return results.flatMap((r) => (Array.isArray(r) ? (r as Diag[]) : (r as Result).diagnostics));
}

function summary(cv: ConformanceVector[], gv: GoldenVector[]): unknown {
  const kinds: Record<string, number> = {};
  for (const v of cv) kinds[v.door] = (kinds[v.door] ?? 0) + 1;
  const byCode: Record<string, number> = {};
  for (const v of [...cv, ...gv]) for (const d of walkDiagnostics(v)) byCode[d.code] = (byCode[d.code] ?? 0) + 1;
  const sorted = Object.fromEntries(Object.entries(byCode).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    format: "mandate/vectors/diagnostics/summary/0.1",
    conformance_cases: cv.length,
    conformance_by_door: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => (a < b ? -1 : 1))),
    golden_results: gv.reduce((n, v) => n + Object.keys(v.results).length + Object.keys(v.texts).length, 0),
    diagnostics: Object.values(byCode).reduce((a, b) => a + b, 0),
    by_code: sorted,
    codes_in_no_result: Object.keys(CODES).filter((c) => !(c in byCode)).sort(),
  };
}

function parts<T>(items: T[], first: (part: number, parts: number, items: T[]) => unknown, path: (n: number) => string): Map<string, string> {
  const groups: T[][] = [[]];
  let size = 0;
  for (const item of items) {
    const n = vectorText(item).length;
    if (size + n > PART_LIMIT) {
      groups.push([]);
      size = 0;
    }
    groups[groups.length - 1]!.push(item);
    size += n;
  }
  return new Map(groups.map((g, i) => [path(i + 1), vectorText(first(i + 1, groups.length, g))]));
}

function files(cv: ConformanceVector[], gv: GoldenVector[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [f, t] of parts(cv, (part, n, items) => ({ format: "mandate/vectors/diagnostics/conformance/0.1", part, parts: n, cases: items }), (n) => `${DIR}conformance-${n}.json`)) out.set(f, t);
  for (const [f, t] of parts(gv, (part, n, items) => ({ format: "mandate/vectors/diagnostics/golden/0.1", part, parts: n, programs: items }), (n) => `${DIR}golden-${n}.json`)) out.set(f, t);
  out.set(`${DIR}summary.json`, vectorText(summary(cv, gv)));
  return out;
}

const committed = (): string[] => (existsSync(repoRoot + DIR) ? readdirSync(repoRoot + DIR).map((f) => DIR + f).sort() : []);

/** The text of a result, as the vectors hold it: the value, or the exact text where it has a number JSON readers refuse. */
const textOf = (value: unknown): string => json(value);

describe("diagnostic vectors for other implementations", () => {
  const { vectors: cv, observed } = conformance();
  const gv = golden();
  const now = files(cv, gv);

  if (process.env["MANDATE_UPDATE_VECTORS"] === "1") {
    mkdirSync(repoRoot + DIR, { recursive: true });
    for (const file of committed()) if (!now.has(file)) rmSync(repoRoot + file);
    for (const [file, content] of now) writeFileSync(repoRoot + file, content);
  }

  it("vectors/diagnostics/ holds exactly the files the generator writes", () => {
    expect(committed()).toEqual([...now.keys()].sort());
  });

  for (const [file, content] of now) {
    it(`${file} is what this compiler gives`, () => {
      expect(existsSync(repoRoot + file), `${file} is missing; MANDATE_UPDATE_VECTORS=1 npm test writes it`).toBe(true);
      expect(readFileSync(repoRoot + file, "utf8")).toBe(content);
    });
  }

  it("every file is ASCII strict JSON within the Rust reader's limits: under 900 KB, nesting up to 64, integers only, no lone surrogate, no duplicate key", () => {
    const stringsOf = (v: unknown, out: string[] = []): string[] => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), stringsOf(x, out));
      return out;
    };
    const depthOf = (v: unknown): number => (v && typeof v === "object" ? 1 + Math.max(0, ...Object.values(v).map(depthOf)) : 0);
    const numbersOf = (v: unknown, out: number[] = []): number[] => {
      if (typeof v === "number") out.push(v);
      else if (Array.isArray(v)) v.forEach((x) => numbersOf(x, out));
      else if (v && typeof v === "object") Object.values(v).forEach((x) => numbersOf(x, out));
      return out;
    };
    for (const [file, content] of now) {
      expect(/^[\x20-\x7e\n]*$/.test(content), `${file} is not ASCII`).toBe(true);
      expect(content.includes("\r"), `${file} has a carriage return`).toBe(false);
      expect(Buffer.byteLength(content), `${file} is over the limit`).toBeLessThan(900_000);
      // The compiler's own strict reader refuses a duplicate key and a lone surrogate.
      expect(parseStrictJson(content).ok, file).toBe(true);
      const value = JSON.parse(content) as unknown;
      expect(depthOf(value), `${file}: nesting`).toBeLessThanOrEqual(64);
      for (const n of numbersOf(value)) expect(Number.isSafeInteger(n), `${file}: ${n}`).toBe(true);
      for (const s of stringsOf(value)) expect(isWellFormed(s), `${file}: a lone surrogate`).toBe(true);
    }
  });

  describe("conformance cases", () => {
    it("holds one vector for every compile case, in the order of the names", () => {
      const compile = caseDirs().filter((n) => readCase(n).kind === "compile");
      expect(cv.length).toBe(123);
      expect(cv.map((v) => v.name)).toEqual(compile);
      expect(new Set(cv.map((v) => v.name)).size).toBe(cv.length);
    });

    it("counts the cases by front door, and says which kinds of case it leaves out", () => {
      const byDoor: Record<string, number> = {};
      for (const v of cv) byDoor[v.door] = (byDoor[v.door] ?? 0) + 1;
      expect(byDoor).toEqual({ apply_ops: 4, check: 69, check_amendment: 5, check_patched: 36, check_subprogram: 9 });
      const other: Record<string, number> = {};
      for (const n of caseDirs()) {
        const k = readCase(n).kind;
        if (k !== "compile") other[k] = (other[k] ?? 0) + 1;
      }
      expect(other).toEqual({ journal: 16 });
    });

    it("gives, for every case, a result that satisfies the case's own expectation under the rule of conformance/README.md", () => {
      for (const v of cv) {
        const { c } = observed.get(v.name)!;
        // The stored value, read back from the text on disk, is what is compared.
        const onDisk = JSON.parse(vectorText(v)) as ConformanceVector;
        const value = (onDisk.result ?? JSON.parse(onDisk.text!)) as Result & { hash?: string };
        const seen: Observed = { ok: value.ok, diagnostics: value.diagnostics, ...(value.hashes !== undefined ? { hashes: value.hashes } : v.door === "check_amendment" && value.hash !== undefined ? { hashes: { program: value.hash } } : {}) };
        expect(compareResult(c.expect, seen), v.name).toEqual([]);
      }
    });

    it("names inputs that exist, by file name inside the case directory", () => {
      for (const v of cv) {
        const base = `conformance/${v.name}/`;
        if ("file" in v.input) expect(existsSync(repoRoot + base + v.input.file), `${v.name}: ${v.input.file}`).toBe(true);
        for (const m of v.modules) expect(existsSync(repoRoot + base + m), `${v.name}: ${m}`).toBe(true);
        if (v.lock !== null) expect(existsSync(repoRoot + base + v.lock), `${v.name}: ${v.lock}`).toBe(true);
      }
    });
  });

  describe("golden programs", () => {
    it("holds one vector for every program of the golden file, with the results that program has", () => {
      expect(gv.length).toBe(21);
      expect(gv.filter((v) => v.lock).length).toBe(5);
      expect(gv.map((v) => v.program)).toEqual([...PROGRAMS].sort());
      for (const v of gv) {
        const slots = [...Object.keys(v.results), ...Object.keys(v.texts)].sort();
        expect(slots, v.program).toEqual((v.lock ? ["check", "check_lock", "check_module", "load"] : ["check", "check_module", "load"]).sort());
      }
      expect(summary(cv, gv)).toMatchObject({ golden_results: gv.length * 3 + gv.filter((v) => v.lock).length });
    });

    it("gives, for each result, exactly the text the golden test hashes, so its sha256 is the pinned digest", () => {
      const pinned = JSON.parse(readFileSync(repoRoot + "compiler/test/golden/outputs.json", "utf8")) as Record<string, Record<string, string>>;
      const shared = new Map<string, ReturnType<typeof modulesOf>>();
      for (const v of gv) {
        const key = v.modules.join("\n");
        if (!shared.has(key)) shared.set(key, modulesOf(v.modules));
        const texts = outputs(v.program, shared.get(key)!);
        const onDisk = JSON.parse(vectorText(v)) as GoldenVector;
        for (const [slot, output] of SLOTS) {
          if (!(slot in v.results) && !(slot in v.texts)) {
            expect(output in texts && output !== "check --lock", `${v.program}: ${output} has no result`).toBe(false);
            continue;
          }
          const stored = slot in onDisk.results ? textOf(onDisk.results[slot]) : onDisk.texts[slot]!;
          expect(stored, `${v.program} ${output}`).toBe(texts[output]);
          expect(`sha256:${createHash("sha256").update(stored, "utf8").digest("hex")}`, `${v.program} ${output}`).toBe(pinned[v.program]![output]);
        }
      }
      expect(Object.keys(digests()).sort()).toEqual(gv.map((v) => v.program));
    });
  });

  describe("diagnostics", () => {
    const s = summary(cv, gv) as { diagnostics: number; by_code: Record<string, number>; codes_in_no_result: string[] };

    it("counts every diagnostic of every stored result by code", () => {
      const all = [...cv, ...gv].flatMap(walkDiagnostics);
      expect(all.length).toBe(s.diagnostics);
      expect(Object.values(s.by_code).reduce((a, b) => a + b, 0)).toBe(all.length);
      for (const code of Object.keys(s.by_code)) expect(CODES, code).toHaveProperty([code]);
    });

    it("lists the codes of codes.ts that no stored result holds", () => {
      expect([...Object.keys(s.by_code), ...s.codes_in_no_result].sort()).toEqual(Object.keys(CODES).sort());
      expect(Object.keys(s.by_code).length).toBe(EXPECTED_CODES_SEEN);
    });
  });
});

