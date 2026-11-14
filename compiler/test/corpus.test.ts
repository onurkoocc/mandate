// The compiled corpus in vectors/corpus/ (vectors/README.md, "corpus/"): every call the compiler's tests make to a
// front door of the compiler (corpus-doors.ts), with its input and its whole result, for the Rust compiler to make
// again and match. Nothing here is product behaviour.
//
// In every run this test makes each stored call again from its stored input and compares the result (staleness),
// checks the files' format, and checks that every diagnostic code occurs in some stored result. In the collecting
// mode (MANDATE_CORPUS=1, set up in vitest.config.ts; corpus-record.ts records the calls) it runs after every other
// test file and also checks that the corpus holds exactly what the suite called (completeness). To write the corpus
// again: MANDATE_UPDATE_VECTORS=1 npm test (which turns the collecting mode on).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { check, checkAmendment, checkPatch, checkSubprogram, load, loadModules, type SourceKind } from "../src/check.js";
import { CODES } from "../src/codes.js";
import { parseStrictJson } from "../src/json/strict-json.js";
import { validateLock } from "../src/lock.js";
import { applyPatch } from "../src/patch/patch.js";
import { acsTarget } from "../src/target/acs.js";
import { denialDiagnostics } from "../src/target/sandbox.js";
import { DOORS, PARTS_FROM, partsOf, resultOf, sha256, utf16, valueKey, VECTOR_WRITERS, wellFormed, type Door } from "./corpus-doors.js";
import type { RecordedCall } from "./corpus-record.js";
import { repoRoot } from "./helpers.js";

const DIR = "vectors/corpus/";
/** A file stays well under the 1 MiB the Rust reader accepts, and the test below says 900 KB. */
const PART_LIMIT = 800_000;
/** The owner's limit for the corpus as a whole. */
const TOTAL_LIMIT = 3 * 1024 * 1024;
const FORMAT = "mandate/vectors/corpus";

const COLLECTING = process.env["MANDATE_CORPUS"] === "1" || process.env["MANDATE_UPDATE_VECTORS"] === "1";
const UPDATE = process.env["MANDATE_UPDATE_VECTORS"] === "1";

/**
 * The codes of codes.ts that no input of a front door can give, and why. Every other code must occur in a stored
 * result of the corpus or of vectors/diagnostics/.
 */
export const NOT_REACHABLE: Record<string, string> = {
  "MDT-E0902":
    "Raised only by the runtime (runtime/src/sandbox.ts, runtime/src/loop.ts, runtime/src/mxc.ts) when a sandbox host cannot enforce an agent's requirement: it is a fact of the host a run starts on, and nothing in compiler/src gives it.",
};

/**
 * Credential-shaped strings, which the repository's secret scanner refuses in a commit: an entry whose input or
 * result holds one is left out (and listed in summary.json).
 */
const SECRET_SHAPES: RegExp[] = [/\bsk-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\./];

// ---------------------------------------------------------------------------------------------------------
// The stored form

/** A shared item: a text, a text as pieces, or a JSON value (a program, a module, a lock). */
type Item = { text: string } | { parts: Array<[string, number]> } | { value: unknown };

export interface Entry {
  id: string;
  door: Door;
  /** The test files that made the call, in UTF-16 order. */
  files: string[];
  input: Record<string, unknown>;
  result?: unknown;
  result_text?: string;
  throws?: string;
}

interface LeftOut {
  id: string;
  door: Door;
  files: string[];
  reason: string;
}

interface Corpus {
  entries: Entry[];
  shared: Map<string, Item>;
}

const textOf = (item: Item | undefined, key: string): string => {
  if (item && "text" in item) return item.text;
  if (item && "parts" in item) return item.parts.map(([s, n]) => s.repeat(n)).join("");
  throw new Error(`no text ${key}`);
};

const valueOf = (item: Item | undefined, key: string): unknown => {
  if (item && "value" in item) return JSON.parse(JSON.stringify(item.value));
  throw new Error(`no value ${key}`);
};

type Obj = Record<string, unknown>;

/** Makes the call of an entry again from its stored input, and gives its result as the corpus stores it. */
function replay(door: Door, input: Obj, shared: Map<string, Item>): { result: string } | { throws: string } {
  const text = (k: unknown): string => textOf(shared.get(k as string), k as string);
  const value = (k: unknown): unknown => valueOf(shared.get(k as string), k as string);
  const modules = (m: unknown): never => (m === undefined ? undefined : Object.fromEntries(Object.entries(m as Obj).map(([n, k]) => [n, value(k)]))) as never;
  const has = (k: string): boolean => Object.hasOwn(input, k);
  const call = (): unknown => {
    switch (door) {
      case "load":
        return load(text(input["source"]), input["kind"] as SourceKind);
      case "check":
        return check(text(input["source"]), input["kind"] as SourceKind, {
          ...(has("modules") ? { modules: modules(input["modules"]) } : {}),
          ...(has("lock") ? { lock: value(input["lock"]) as never } : {}),
          ...(has("claim") ? { claim: input["claim"] as never } : {}),
        });
      case "load_modules":
        return loadModules((input["sources"] as Obj[]).map((s) => ({ file: s["file"] as string, kind: s["kind"] as SourceKind, text: text(s["text"]) })));
      case "check_patch":
        return checkPatch(value(input["program"]) as never, input["base"] as string, input["ops"] as never, modules(input["modules"]));
      case "apply_patch":
        return applyPatch(value(input["program"]) as never, input["base"] as string, input["ops"] as never, modules(input["modules"]));
      case "check_subprogram":
        return checkSubprogram({
          parent: value(input["parent"]) as never,
          ...(has("modules") ? { modules: modules(input["modules"]) } : {}),
          workflow: input["workflow"] as string,
          number: input["number"] as number,
          base: input["base"] as string,
          ops: input["ops"] as never,
          lead: input["lead"] as never,
          room: input["room"] as never,
        });
      case "check_amendment":
        return checkAmendment({ parent: value(input["parent"]) as never, ...(has("modules") ? { modules: modules(input["modules"]) } : {}), workflow: input["workflow"] as string, envelope: input["envelope"] });
      case "validate_lock":
        return validateLock(input["value"]);
      case "acs_target":
        return acsTarget(value(input["program"]) as never, modules(input["modules"]), has("lock") ? (value(input["lock"]) as never) : undefined);
      case "denial_diagnostics":
        return denialDiagnostics(value(input["program"]) as never, input["report"] as never);
    }
  };
  try {
    return { result: JSON.stringify(resultOf(door, call())) };
  } catch (e) {
    return { throws: e instanceof Error ? e.message : String(e) };
  }
}

/** The stored result of an entry, as the text `replay` gives. */
const storedResult = (e: Entry): { result: string } | { throws: string } =>
  e.throws !== undefined ? { throws: e.throws } : { result: e.result_text !== undefined ? JSON.stringify(JSON.parse(e.result_text)) : JSON.stringify(e.result) };

// ---------------------------------------------------------------------------------------------------------
// Values

function walk(v: unknown, f: (v: unknown) => void): void {
  f(v);
  if (Array.isArray(v)) v.forEach((x) => walk(x, f));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (f(k), walk(x, f));
}

const some = (v: unknown, p: (v: unknown) => boolean): boolean => {
  let found = false;
  walk(v, (x) => (found ||= p(x)));
  return found;
};

const otherNumber = (x: unknown): boolean => typeof x === "number" && !Number.isSafeInteger(x);
const loneSurrogate = (x: unknown): boolean => typeof x === "string" && !wellFormed(x);
const secretShaped = (x: unknown): boolean => typeof x === "string" && SECRET_SHAPES.some((r) => r.test(x));

/** Every diagnostic in a value: an object with a `code` of codes.ts's form and a `severity`. */
function diagnosticsIn(v: unknown): Array<{ code: string }> {
  const out: Array<{ code: string }> = [];
  walk(v, (x) => {
    if (x && typeof x === "object" && !Array.isArray(x) && typeof (x as Obj)["code"] === "string" && /^MDT-[EW]\d{4}$/.test((x as Obj)["code"] as string) && typeof (x as Obj)["severity"] === "string") out.push(x as { code: string });
  });
  return out;
}

const resultValue = (e: Entry): unknown => (e.result_text !== undefined ? JSON.parse(e.result_text) : e.result);

// ---------------------------------------------------------------------------------------------------------
// From the recordings to the corpus

interface Recording {
  file: string;
  made: number;
  calls: RecordedCall[];
  values: Record<string, string>;
  unrecordable: Record<string, number>;
}

function readRecordings(): Recording[] {
  const dir = process.env["MANDATE_CORPUS_DIR"];
  if (!dir || !existsSync(dir)) throw new Error("corpus: no recordings; run the collecting mode through vitest.config.ts (MANDATE_CORPUS=1)");
  return readdirSync(dir)
    .sort(utf16)
    .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as Recording)
    .sort((a, b) => utf16(a.file, b.file));
}

interface Collected {
  corpus: Corpus;
  leftOut: LeftOut[];
  made: number;
  distinct: number;
  unrecordable: Record<string, number>;
  recorded: string[];
}

function collect(recordings: Recording[]): Collected {
  const values = new Map<string, string>();
  const calls = new Map<string, { door: Door; input: string; results: Set<string>; throws: Set<string>; files: Set<string> }>();
  let made = 0;
  const unrecordable: Record<string, number> = {};
  const used = recordings.filter((r) => !VECTOR_WRITERS.includes(r.file));
  for (const r of used) {
    made += r.made;
    for (const [k, n] of Object.entries(r.unrecordable)) unrecordable[k] = (unrecordable[k] ?? 0) + n;
    for (const [k, t] of Object.entries(r.values)) {
      if (values.has(k) && values.get(k) !== t) throw new Error(`corpus: two values have the key ${k}`);
      values.set(k, t);
    }
    for (const c of r.calls) {
      const key = `${c.door}\n${c.input}`;
      const e = calls.get(key) ?? { door: c.door, input: c.input, results: new Set(), throws: new Set(), files: new Set() };
      for (const x of c.results) e.results.add(x);
      if (c.throws !== undefined) e.throws.add(c.throws);
      e.files.add(r.file);
      calls.set(key, e);
    }
  }

  const shared = new Map<string, Item>();
  const entries: Entry[] = [];
  const leftOut: LeftOut[] = [];
  for (const c of calls.values()) {
    const raw = JSON.parse(c.input) as Obj;
    const items = new Map<string, Item>();
    const shareText = (t: unknown): string => {
      if (typeof t !== "string") throw new Error("corpus: a text is not a string");
      const key = valueKey(JSON.stringify(t));
      const parts = t.length > PARTS_FROM ? partsOf(t) : undefined;
      items.set(key, parts && JSON.stringify(parts).length * 2 < JSON.stringify(t).length ? { parts } : { text: t });
      return key;
    };
    const shareValue = (k: unknown): string => {
      const t = values.get(k as string);
      if (t === undefined) throw new Error(`corpus: no value ${String(k)}`);
      items.set(k as string, { value: JSON.parse(t) });
      return k as string;
    };
    const input: Obj = { ...raw };
    if ("source" in input) input["source"] = shareText(input["source"]);
    if (c.door === "load_modules") input["sources"] = (input["sources"] as Obj[]).map((s) => ({ ...s, text: shareText(s["text"]) }));
    for (const k of ["program", "parent", "lock"]) if (k in input && c.door !== "validate_lock") shareValue(input[k]);
    if (input["modules"] !== undefined) for (const k of Object.values(input["modules"] as Obj)) shareValue(k);

    const id = `${c.door}-${sha256(`${c.door}\n${JSON.stringify(input)}`).slice(0, 16)}`;
    const files = [...c.files].sort(utf16);
    const out = (reason: string): void => void leftOut.push({ id, door: c.door, files, reason });
    const whole = [input, ...[...items.values()], ...[...c.results].map((r) => JSON.parse(r) as unknown), ...c.throws];
    if (c.results.size + c.throws.size !== 1) {
      out("the same input gave different results");
      continue;
    }
    if (some(whole, loneSurrogate)) {
      out("its input or result holds a lone surrogate");
      continue;
    }
    if (some(whole, secretShaped)) {
      out("its input or result holds a credential-shaped string");
      continue;
    }
    if (some([input, ...[...items.values()]], otherNumber)) {
      out("its input holds a number that is not an integer");
      continue;
    }
    const entry: Entry = { id, door: c.door, files, input };
    if (c.throws.size) entry.throws = [...c.throws][0]!;
    else {
      const result = JSON.parse([...c.results][0]!) as unknown;
      if (some(result, otherNumber)) entry.result_text = [...c.results][0]!;
      else entry.result = result;
    }
    // What is stored must be enough to make the call again.
    const again = replay(c.door, JSON.parse(JSON.stringify(input)) as Obj, new Map([...shared, ...items]));
    if (JSON.stringify(again) !== JSON.stringify(storedResult(entry))) {
      out("made again from the stored input, it gives another result");
      continue;
    }
    for (const [k, item] of items) shared.set(k, item);
    entries.push(entry);
  }
  entries.sort((a, b) => utf16(a.id, b.id));
  leftOut.sort((a, b) => utf16(a.id, b.id));
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error("corpus: two entries have the same id");
  return { corpus: { entries, shared }, leftOut, made, distinct: calls.size, unrecordable, recorded: recordings.map((r) => r.file) };
}

// ---------------------------------------------------------------------------------------------------------
// The files

/** JSON text as the vector files hold it: ASCII only, every character from U+007F up as a `\u` escape. */
const ascii = (s: string): string => s.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** One file of a list in parts: a head and then one compact line for each item. */
function partFiles(prefix: string, format: string, member: string, lines: string[], object: boolean): Map<string, string> {
  const groups: string[][] = [[]];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > PART_LIMIT && groups[groups.length - 1]!.length) {
      groups.push([]);
      size = 0;
    }
    groups[groups.length - 1]!.push(line);
    size += line.length + 6;
  }
  const [open, close] = object ? ["{", "}"] : ["[", "]"];
  return new Map(
    groups.map((g, i) => [
      `${DIR}${prefix}-${i + 1}.json`,
      `{\n  "format": "${format}",\n  "part": ${i + 1},\n  "parts": ${groups.length},\n  "${member}": ${open}\n${g.map((l) => `    ${l}`).join(",\n")}\n  ${close}\n}\n`,
    ]),
  );
}

function summaryOf(c: Corpus, x: Pick<Collected, "leftOut" | "made" | "distinct" | "unrecordable">): unknown {
  const byDoor: Record<string, number> = {};
  for (const e of c.entries) byDoor[e.door] = (byDoor[e.door] ?? 0) + 1;
  const byFile: Record<string, number> = {};
  for (const e of c.entries) for (const f of e.files) byFile[f] = (byFile[f] ?? 0) + 1;
  const byCode: Record<string, number> = {};
  for (const e of c.entries) for (const d of diagnosticsIn(resultValue(e))) byCode[d.code] = (byCode[d.code] ?? 0) + 1;
  const sorted = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => utf16(a, b)));
  return {
    format: `${FORMAT}/summary/0.1`,
    calls: x.made,
    distinct_calls: x.distinct,
    entries: c.entries.length,
    shared: c.shared.size,
    by_door: Object.fromEntries((Object.keys(DOORS) as Door[]).map((d) => [d, byDoor[d] ?? 0])),
    by_file: sorted(byFile),
    by_code: sorted(byCode),
    left_out: x.leftOut,
    not_recorded: sorted(x.unrecordable),
  };
}

function filesOf(c: Corpus, x: Pick<Collected, "leftOut" | "made" | "distinct" | "unrecordable">): Map<string, string> {
  const out = new Map<string, string>();
  for (const [f, t] of partFiles("entries", `${FORMAT}/entries/0.1`, "entries", c.entries.map((e) => ascii(JSON.stringify(e))), false)) out.set(f, t);
  const keys = [...c.shared.keys()].sort(utf16);
  for (const [f, t] of partFiles("shared", `${FORMAT}/shared/0.1`, "items", keys.map((k) => ascii(`${JSON.stringify(k)}: ${JSON.stringify(c.shared.get(k))}`)), true)) out.set(f, t);
  out.set(`${DIR}summary.json`, ascii(JSON.stringify(summaryOf(c, x), null, 2)) + "\n");
  return out;
}

const committed = (): string[] => (existsSync(repoRoot + DIR) ? readdirSync(repoRoot + DIR).map((f) => DIR + f).sort(utf16) : []);

function readCorpus(): { corpus: Corpus; texts: Map<string, string>; summary: Obj } {
  const texts = new Map(committed().map((f) => [f, readFileSync(repoRoot + f, "utf8")]));
  const entries: Entry[] = [];
  const shared = new Map<string, Item>();
  for (const [f, t] of texts) {
    const v = JSON.parse(t) as Obj;
    if (f.startsWith(`${DIR}entries-`)) entries.push(...(v["entries"] as Entry[]));
    if (f.startsWith(`${DIR}shared-`)) for (const [k, item] of Object.entries(v["items"] as Obj)) shared.set(k, item as Item);
  }
  const summary = texts.has(`${DIR}summary.json`) ? (JSON.parse(texts.get(`${DIR}summary.json`)!) as Obj) : {};
  return { corpus: { entries, shared }, texts, summary };
}

/** Every code that some stored result of vectors/diagnostics/ holds. */
function diagnosticVectorCodes(): Set<string> {
  const out = new Set<string>();
  const dir = "vectors/diagnostics/";
  for (const f of readdirSync(repoRoot + dir).sort(utf16)) {
    if (f === "summary.json") continue;
    const v = JSON.parse(readFileSync(repoRoot + dir + f, "utf8")) as { cases?: Obj[]; programs?: Obj[] };
    // A result is a value, or (a vector's `text`, a program's `texts`) the exact text of one.
    const results = [...(v.cases ?? []).map((c) => (typeof c["text"] === "string" ? JSON.parse(c["text"]) : c["result"])), ...(v.programs ?? []).flatMap((p) => [...Object.values(p["results"] as Obj), ...Object.values(p["texts"] as Obj).map((t) => JSON.parse(t as string))])];
    for (const d of diagnosticsIn(results)) out.add(d.code);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------

describe("the compiled corpus", () => {
  const collected = COLLECTING ? collect(readRecordings()) : undefined;
  const now = collected ? filesOf(collected.corpus, collected) : undefined;
  if (UPDATE && now) {
    mkdirSync(repoRoot + DIR, { recursive: true });
    for (const file of committed()) if (!now.has(file)) rmSync(repoRoot + file);
    for (const [file, content] of now) writeFileSync(repoRoot + file, content);
  }
  const { corpus, texts, summary } = readCorpus();

  it("every stored call, made again from its stored input, gives its stored result", () => {
    expect(corpus.entries.length).toBeGreaterThan(0);
    const stale: string[] = [];
    for (const e of corpus.entries) {
      const again = replay(e.door, e.input, corpus.shared);
      if (JSON.stringify(again) !== JSON.stringify(storedResult(e))) stale.push(`${e.id} (${e.files.join(", ")})`);
    }
    expect(stale, "these entries give another result now; MANDATE_UPDATE_VECTORS=1 npm test writes the corpus again").toEqual([]);
  });

  it("every file is ASCII strict JSON within the Rust reader's limits: under 900 KB, nesting up to 64, integers only, no lone surrogate, no duplicate key; 3 MiB in all", () => {
    expect(texts.size).toBeGreaterThan(0);
    let total = 0;
    const depthOf = (v: unknown): number => (v && typeof v === "object" ? 1 + Math.max(0, ...Object.values(v).map(depthOf)) : 0);
    for (const [file, content] of texts) {
      expect(/^[\x20-\x7e\n]*$/.test(content), `${file} is not ASCII`).toBe(true);
      expect(Buffer.byteLength(content), `${file} is over the limit`).toBeLessThan(900_000);
      total += Buffer.byteLength(content);
      expect(parseStrictJson(content).ok, file).toBe(true);
      const value = JSON.parse(content) as unknown;
      expect(depthOf(value), `${file}: nesting`).toBeLessThanOrEqual(64);
      expect(some(value, otherNumber), `${file}: a number that is not an integer`).toBe(false);
      expect(some(value, loneSurrogate), `${file}: a lone surrogate`).toBe(false);
      expect(some(value, secretShaped), `${file}: a credential-shaped string`).toBe(false);
    }
    expect(total, "the corpus is over 3 MiB").toBeLessThanOrEqual(TOTAL_LIMIT);
  });

  it("names every shared item it uses, uses every one it has, and gives each entry one result", () => {
    const used = new Set<string>();
    for (const e of corpus.entries) {
      expect(Object.keys(DOORS), e.id).toContain(e.door);
      expect(e.files.length, e.id).toBeGreaterThan(0);
      expect([e.result !== undefined, e.result_text !== undefined, e.throws !== undefined].filter(Boolean).length, e.id).toBe(1);
      const refs: unknown[] = [e.input["source"], e.input["program"], e.input["parent"], e.door === "validate_lock" ? undefined : e.input["lock"], ...Object.values((e.input["modules"] ?? {}) as Obj), ...((e.input["sources"] ?? []) as Obj[]).map((s) => s["text"])];
      for (const r of refs) if (r !== undefined) (expect(corpus.shared.has(r as string), `${e.id}: ${String(r)}`).toBe(true), used.add(r as string));
    }
    expect([...corpus.shared.keys()].filter((k) => !used.has(k))).toEqual([]);
    for (const [k, item] of corpus.shared) {
      const t = "value" in item ? JSON.stringify(item.value) : JSON.stringify(textOf(item, k));
      expect(valueKey(t), k).toBe(k);
    }
  });

  it("counts in summary.json what the entries hold", () => {
    const fresh = summaryOf(corpus, { leftOut: summary["left_out"] as LeftOut[], made: summary["calls"] as number, distinct: summary["distinct_calls"] as number, unrecordable: summary["not_recorded"] as Record<string, number> });
    expect(summary).toEqual(fresh);
  });

  it("holds a result with every code of codes.ts but those no front door can give", () => {
    const seen = diagnosticVectorCodes();
    for (const e of corpus.entries) for (const d of diagnosticsIn(resultValue(e))) seen.add(d.code);
    for (const code of Object.keys(NOT_REACHABLE)) {
      expect(CODES, code).toHaveProperty([code]);
      expect(seen.has(code), `${code} is listed as not reachable, but a result holds it`).toBe(false);
    }
    expect(Object.keys(CODES).filter((c) => !seen.has(c) && !(c in NOT_REACHABLE)).sort(utf16)).toEqual([]);
  });

  it.runIf(COLLECTING)("holds exactly what the suite calls now", () => {
    const c = collected!;
    const suite = readdirSync(repoRoot + "compiler/test").filter((f) => f.endsWith(".test.ts") && f !== "corpus.test.ts").map((f) => `compiler/test/${f}`).sort(utf16);
    expect(c.recorded, "a test file wrote no recording").toEqual(suite);
    const stored = new Set(corpus.entries.map((e) => e.id));
    const made = new Set(c.corpus.entries.map((e) => e.id));
    const name = (e: Entry): string => `${e.id} (${e.files.join(", ")})`;
    expect(c.corpus.entries.filter((e) => !stored.has(e.id)).map(name), "the suite makes calls the corpus does not hold; MANDATE_UPDATE_VECTORS=1 npm test writes it").toEqual([]);
    expect(corpus.entries.filter((e) => !made.has(e.id)).map(name), "the corpus holds calls the suite no longer makes; MANDATE_UPDATE_VECTORS=1 npm test writes it").toEqual([]);
    expect([...committed()], "vectors/corpus/ holds other files than the suite gives; MANDATE_UPDATE_VECTORS=1 npm test writes them").toEqual([...now!.keys()].sort(utf16));
    for (const [file, content] of now!) expect(texts.get(file) === content, `${file} is not what the suite calls now; MANDATE_UPDATE_VECTORS=1 npm test writes it`).toBe(true);
  });

  afterAll(() => {
    // The recordings of this run are read; the next run makes its own directory (vitest.config.ts).
    const dir = process.env["MANDATE_CORPUS_DIR"];
    if (COLLECTING && dir?.startsWith(join(tmpdir(), "mandate-corpus-"))) rmSync(dir, { recursive: true, force: true });
  });
});
