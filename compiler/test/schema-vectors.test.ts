// Writes the schema vectors in vectors/schema/ (vectors/README.md, "schema/"): what Ajv says about invalid IR and
// invalid locks, and the diagnostics the compiler makes of it, for the Rust validator (crates/mandate-ir) to match
// error for error. Nothing here is product behaviour.
//
// The committed files must be what this test generates; it fails when one differs, is missing or is left over.
// To write them again: MANDATE_UPDATE_VECTORS=1 npm test.
// MANDATE_VECTORS_REPORT=1 also prints the coverage tables.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kindOf, load } from "../src/check.js";
import type { Diagnostic } from "../src/diag.js";
import { atLeast, isLanguageVersion, LANGUAGE_VERSIONS, type LanguageVersion } from "../src/ir/types.js";
import { irSchema, irSchemaErrors, SINCE } from "../src/ir/validate.js";
import { isWellFormed, parseStrictJson, type Json } from "../src/json/strict-json.js";
import { lockSchema, lockSchemaErrors, validateLock } from "../src/lock.js";
import { BEHAVIOUR_CASES, GOLDEN_BASES, IR_CASES, MANUAL_BASES, N_INDEX_DEFS, N_INDEX_UNKNOWN, N_PROTO, N_ORDER_ITEMS, N_ORDER_MAP, N_ORDER_PROPERTIES, type CaseSpec } from "./schema-vector-cases.js";
import { GATE_PROGRAMS, RULE_GATES } from "./schema-vector-gates.js";
import { readRepo, repoRoot } from "./helpers.js";
import { LOCK_BASES, LOCK_CASES } from "./schema-vector-locks.js";
import { applyEdit, behavioursOf, BEHAVIOURS, defOf, describe as describeEdit, inlinedDefs, read, schemaKeywords, tally, type Raw } from "./schema-vector-support.js";

const DIR = "vectors/schema/";
/** A file stays well under the 1 MiB the Rust reader accepts, and the test below says 900 KB. */
const PART_LIMIT = 800_000;

type RawError = Raw & { propertyName?: string };
type Program = { [k: string]: Json };

/** An Ajv error as the vectors hold it: the five members every error has, and `propertyName` where Ajv sets it. */
function rawOf(e: { instancePath: string; schemaPath: string; keyword: string; params: Record<string, unknown>; message?: string; propertyName?: string }): RawError {
  return {
    instancePath: e.instancePath,
    schemaPath: e.schemaPath,
    keyword: e.keyword,
    params: e.params,
    ...(e.message === undefined ? {} : { message: e.message }),
    ...(e.propertyName === undefined ? {} : { propertyName: e.propertyName }),
  };
}

/** JSON as the vector files hold it (see vectors.test.ts): two-space indents, a list of integers on one line, ASCII only. */
function vectorText(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
    .replace(/\[\n(?:\s*-?\d+,\n)*\s*-?\d+\n\s*\]/g, (a) => `[${a.slice(1, -1).trim().split(/,\s*/).join(", ")}]`)
    .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return json + "\n";
}

const text = (doc: Json, pretty: boolean): string => (pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc));

function strict(input: string, name: string): Json {
  const parsed = parseStrictJson(input);
  if (!parsed.ok) throw new Error(`${name}: not strict JSON`);
  return parsed.value.value;
}

/** Runs `make` for each spec and reports every one that throws at once. */
function build<T>(specs: CaseSpec[], make: (spec: CaseSpec) => T): T[] {
  const failures: string[] = [];
  const out = specs.flatMap((spec) => {
    try {
      return [make(spec)];
    } catch (err) {
      failures.push(`${spec.name ?? spec.base}: ${(err as Error).message}`);
      return [];
    }
  });
  if (failures.length) throw new Error(failures.join("; "));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Invalid IR

/** The bases, by id: golden definitions wrapped as the smallest program, and the programs written in schema-vector-cases.ts. */
function irBases(): Map<string, Program> {
  const out = new Map<string, Program>();
  const loaded = new Map<string, Program>();
  for (const b of GOLDEN_BASES) {
    const program = loaded.get(b.source) ?? (load(readRepo(b.source), kindOf(b.source)).program as unknown as Program);
    loaded.set(b.source, program);
    const defs = program["defs"] as { [k: string]: Json };
    out.set(b.id, { language: program["language"]!, module: "vectors.base", version: "0.1", defs: Object.fromEntries(b.defs.map((d) => [d, defs[d]!])) });
  }
  for (const b of MANUAL_BASES) out.set(b.id, b.program);
  return out;
}

interface IrCase {
  name: string;
  base: string;
  pretty: boolean;
  input: string;
  /** Whether `validateIr` runs the schema at all: not for a document that is not an object or has no known language. */
  schema_consulted: boolean;
  raw_errors: RawError[];
  shows: string[];
  diagnostics: Diagnostic[];
}

function irCases(): IrCase[] {
  const bases = irBases();
  return build(IR_CASES, (spec) => {
    const base = bases.get(spec.base);
    if (!base) throw new Error(`no base ${spec.base}`);
    const doc = spec.edits.reduce<Json>((d, edit) => applyEdit(d, edit), base);
    const name = spec.name ?? `${spec.base}: ${describeEdit(spec.edits[0]!)}`;
    const pretty = spec.pretty ?? JSON.stringify(base).length < 1000;
    const input = spec.after ? spec.after(text(doc, pretty)) : text(doc, pretty);
    const value = strict(input, name);
    const consulted = value !== null && typeof value === "object" && !Array.isArray(value) && isLanguageVersion(value["language"]);
    const raw = irSchemaErrors(value).map((e) => rawOf(e as never));
    return { name, base: spec.base, pretty, input, schema_consulted: consulted, raw_errors: raw, shows: consulted ? behavioursOf(raw) : [], diagnostics: load(input, "json").diagnostics };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Version gates

interface GateCase {
  name: string;
  /** The row of a SINCE table (`kinds.role`) or the name of the other rule. */
  rule: string;
  /** The language that introduced the construct, for a row of a table. */
  since: string | null;
  language: string;
  verdict: "accepted" | "refused";
  input: string;
  diagnostics: Diagnostic[];
}

const NEWEST = LANGUAGE_VERSIONS[LANGUAGE_VERSIONS.length - 1]!;

function gateCases(): GateCase[] {
  const out: GateCase[] = [];
  const add = (name: string, rule: string, since: string | null, language: string, verdict: "accepted" | "refused", program: Program): void => {
    const input = JSON.stringify(program, null, 2);
    out.push({ name, rule, since, language, verdict, input, diagnostics: load(input, "json").diagnostics });
  };
  for (const [table, rows] of Object.entries(SINCE)) {
    for (const [key, since] of Object.entries(rows)) {
      const programs = GATE_PROGRAMS[`${table}.${key}`];
      if (!programs) throw new Error(`SINCE.${table}.${key} has no gate vector: add GATE_PROGRAMS["${table}.${key}"] in schema-vector-gates.ts`);
      for (const p of programs) {
        const label = `SINCE.${table}.${key}${p.variant ? ` (${p.variant})` : ""}`;
        const accepted = [...new Set([NEWEST, since])] as LanguageVersion[];
        for (const language of accepted) add(`${label} in ${language}`, `${table}.${key}`, since, language, "accepted", p.program(language));
        for (const language of LANGUAGE_VERSIONS.filter((l) => !atLeast(l, since))) add(`${label} in ${language}`, `${table}.${key}`, since, language, "refused", p.program(language));
      }
    }
  }
  const listed = new Set(Object.entries(SINCE).flatMap(([table, rows]) => Object.keys(rows).map((key) => `${table}.${key}`)));
  for (const key of Object.keys(GATE_PROGRAMS)) if (!listed.has(key)) throw new Error(`GATE_PROGRAMS["${key}"] is not a row of the SINCE tables any more`);
  for (const r of RULE_GATES) {
    for (const c of r.cases) {
      for (const language of c.accepted) add(`${r.rule}: ${c.label} in ${language}`, r.rule, null, language, "accepted", c.program(language));
      for (const language of c.refused) add(`${r.rule}: ${c.label} in ${language}`, r.rule, null, language, "refused", c.program(language));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Invalid locks

interface LockCase {
  name: string;
  base: string;
  pretty: boolean;
  input: string;
  raw_errors: RawError[];
  diagnostics: Diagnostic[];
}

function lockCases(): LockCase[] {
  const bases = new Map(LOCK_BASES.map((b) => [b.id, strict(readRepo(b.path), b.path)]));
  return build(LOCK_CASES, (spec) => {
    const base = bases.get(spec.base);
    if (base === undefined) throw new Error(`no base ${spec.base}`);
    const doc = spec.edits.reduce<Json>((d, edit) => applyEdit(d, edit), base);
    const name = spec.name ?? `${spec.base}: ${describeEdit(spec.edits[0]!)}`;
    const pretty = spec.pretty ?? true;
    const input = spec.after ? spec.after(text(doc, pretty)) : text(doc, pretty);
    const value = strict(input, name);
    return { name, base: spec.base, pretty, input, raw_errors: lockSchemaErrors(value).map((e) => rawOf(e as never)), diagnostics: validateLock(value) };
  });
}

// ---------------------------------------------------------------------------------------------------------
// The files

function files(ir: IrCase[], gates: GateCase[], locks: LockCase[]): Map<string, string> {
  const out = new Map<string, string>();
  // The IR cases in order, in as many parts as the limit needs.
  const parts: IrCase[][] = [[]];
  let size = 0;
  for (const c of ir) {
    const n = vectorText(c).length;
    if (size + n > PART_LIMIT) {
      parts.push([]);
      size = 0;
    }
    parts[parts.length - 1]!.push(c);
    size += n;
  }
  parts.forEach((p, i) => out.set(`${DIR}ir-invalid-${i + 1}.json`, vectorText({ format: "mandate/vectors/schema/ir-invalid/0.1", part: i + 1, parts: parts.length, cases: p })));
  out.set(`${DIR}ir-gates.json`, vectorText({ format: "mandate/vectors/schema/ir-gates/0.1", cases: gates }));
  out.set(`${DIR}lock-invalid.json`, vectorText({ format: "mandate/vectors/schema/lock-invalid/0.1", cases: locks }));
  return out;
}

const committed = (): string[] => (existsSync(repoRoot + DIR) ? readdirSync(repoRoot + DIR).map((f) => DIR + f).sort() : []);

// ---------------------------------------------------------------------------------------------------------
// Coverage

/** Keywords that carry no error of their own: the errors come from the schemas they hold, or they only name things. */
const NEVER_RAISE: Record<string, string> = {
  properties: "its subschemas raise the errors",
  items: "its subschema raises the errors",
  $ref: "the referenced schema raises the errors",
  patternProperties: "its subschemas raise the errors",
  prefixItems: "its subschemas raise the errors",
  allOf: "its subschemas raise the errors",
};
/** Annotations and structure. */
const ANNOTATION = new Set(["$schema", "$id", "$defs", "definitions", "$comment", "title", "description", "default", "examples"]);
/** Keywords of Ajv that give an error of their own. */
const RAISE = new Set([
  "type", "enum", "const", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "required",
  "additionalProperties", "propertyNames", "oneOf", "anyOf", "not", "if", "contains", "minContains", "maxContains", "dependentRequired", "discriminator",
]);

interface Coverage {
  /** keyword → number of cases with a raw error of it */
  byKeyword: Map<string, number>;
  /** keywords of the schema that cannot be the keyword of an error, and why */
  impossible: Map<string, string>;
  /** keywords of the schema that need cases and have fewer than two */
  missing: string[];
  /** keywords of the schema nobody has classified */
  unknown: string[];
}

function coverage(schema: object, cases: Array<{ raw_errors: RawError[] }>): Coverage {
  const byKeyword = new Map<string, number>();
  for (const c of cases) for (const k of new Set(c.raw_errors.map((e) => e.keyword))) byKeyword.set(k, (byKeyword.get(k) ?? 0) + 1);
  const impossible = new Map<string, string>();
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const k of schemaKeywords(schema).keys()) {
    if (ANNOTATION.has(k)) continue;
    if (NEVER_RAISE[k]) impossible.set(k, NEVER_RAISE[k]!);
    else if (!RAISE.has(k)) unknown.push(k);
    else if ((byKeyword.get(k) ?? 0) < 2) missing.push(k);
  }
  return { byKeyword, impossible, missing, unknown };
}

/** The message with what varies in it replaced, so that the table counts templates. */
function template(m: string): string {
  return m
    .replace(/^must have required property '.*'$/, "must have required property '<name>'")
    .replace(/^must match pattern ".*"$/, 'must match pattern "<pattern>"')
    .replace(/^tag ".*" must be string$/, 'tag "<tag>" must be string')
    .replace(/^value of tag ".*" must be in oneOf$/, 'value of tag "<tag>" must be in oneOf')
    .replace(/\d+/g, "<n>");
}

describe("schema vectors for other implementations", () => {
  const ir = irCases();
  const gates = gateCases();
  const locks = lockCases();
  const now = files(ir, gates, locks);

  if (process.env["MANDATE_UPDATE_VECTORS"] === "1") {
    mkdirSync(repoRoot + DIR, { recursive: true });
    for (const file of committed()) if (!now.has(file)) rmSync(repoRoot + file);
    for (const [file, content] of now) writeFileSync(repoRoot + file, content);
  }

  it("vectors/schema/ holds exactly the files the generator writes", () => {
    expect(committed()).toEqual([...now.keys()].sort());
  });

  for (const [file, content] of now) {
    it(`${file} is what this compiler gives`, () => {
      expect(existsSync(repoRoot + file), `${file} is missing; MANDATE_UPDATE_VECTORS=1 npm test writes it`).toBe(true);
      expect(readFileSync(repoRoot + file, "utf8")).toBe(content);
    });
  }

  it("every file is ASCII strict JSON within the Rust reader's limits: under 900 KB, nesting up to 64, integers only, no lone surrogate", () => {
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
      expect(Buffer.byteLength(content), `${file} is over the limit`).toBeLessThan(900_000);
      const r = parseStrictJson(content);
      expect(r.ok, file).toBe(true);
      const value = JSON.parse(content) as unknown;
      expect(depthOf(value), `${file}: nesting`).toBeLessThanOrEqual(64);
      for (const n of numbersOf(value)) expect(Number.isSafeInteger(n), `${file}: ${n}`).toBe(true);
      for (const s of stringsOf(value)) expect(isWellFormed(s), `${file}: a lone surrogate`).toBe(true);
    }
  });

  describe("invalid IR", () => {
    it("has about 150 cases or more, with distinct names, each with errors", () => {
      expect(ir.length).toBeGreaterThanOrEqual(150);
      expect(new Set(ir.map((c) => c.name)).size).toBe(ir.length);
      for (const c of ir) expect(c.raw_errors.length, c.name).toBeGreaterThan(0);
      for (const c of ir) expect(c.diagnostics.length, c.name).toBeGreaterThan(0);
    });

    it("covers every definition kind, expression form, statement, type form, pattern, verifier, tier and read source of the schema in a base", () => {
      const bases = [...irBases().values()];
      const seen = new Set<string>();
      const walk = (v: Json): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          for (const k of ["op", "kind", "p", "by"]) if (typeof v[k] === "string") seen.add(`${k}=${v[k]}`);
          for (const k of ["ref", "record", "enum", "union", "refine"]) if (k in v) seen.add(`type=${k}`);
          for (const k of ["static", "call", "all"]) if (k in v) seen.add(`verifier=${k}`);
          for (const k of ["sql", "logs"]) if (k in v) seen.add(`read=${k}`);
          Object.values(v).forEach(walk);
        }
      };
      for (const b of bases) walk(b["defs"]!);
      const schema = irSchema() as { $defs: Record<string, { oneOf?: Array<{ properties: Record<string, { const?: string }> }> }> };
      const wanted: string[] = [];
      for (const [def, tag] of [["Def", "kind"], ["Expr", "op"], ["Stmt", "op"], ["Pattern", "p"], ["Tier", "by"]] as const) {
        for (const branch of schema.$defs[def]!.oneOf!) wanted.push(`${tag}=${branch.properties[tag]!.const}`);
      }
      wanted.push("type=ref", "type=record", "type=enum", "type=union", "type=refine", "verifier=static", "verifier=call", "verifier=all", "read=sql", "read=logs");
      expect(wanted.filter((w) => !seen.has(w))).toEqual([]);
    });

    it("gives, for every case that reaches the schema, the diagnostics the reference reading of the raw errors gives", () => {
      for (const c of ir) {
        if (!c.schema_consulted) continue;
        const fromSchema = c.diagnostics.filter((d) => d.facts?.["schema_path"] !== undefined);
        const reading = read(c.raw_errors);
        expect(
          fromSchema.map((d) => [d.at.path, d.message, d.facts?.["keyword"], d.facts?.["schema_path"]]),
          c.name,
        ).toEqual(reading.out.map((k) => [k.path, k.message, k.raw.keyword, k.raw.schemaPath]));
        expect(fromSchema.every((d) => d.code === "MDT-E0104" && d.at.span !== undefined), c.name).toBe(true);
      }
    });

    it("does not consult the schema for a document that is not an object or has no known language", () => {
      const unconsulted = ir.filter((c) => !c.schema_consulted);
      expect(unconsulted.length).toBeGreaterThanOrEqual(8);
      for (const c of unconsulted) expect(c.diagnostics.map((d) => d.code).every((code) => code === "MDT-E0103" || code === "MDT-E0104"), c.name).toBe(true);
    });

    it("writes some cases pretty-printed over several lines and some compact on one line", () => {
      const pretty = ir.filter((c) => c.pretty && c.schema_consulted);
      const compact = ir.filter((c) => !c.pretty && c.schema_consulted);
      expect(pretty.length).toBeGreaterThanOrEqual(40);
      expect(compact.length).toBeGreaterThanOrEqual(40);
      const spans = (cs: IrCase[]): number[][] => cs.flatMap((c) => c.diagnostics.flatMap((d) => (d.at.span ? [d.at.span as number[]] : [])));
      expect(spans(pretty).filter((s) => s[0] !== s[2]).length, "spans over several lines").toBeGreaterThan(5);
      expect(spans(compact).every((s) => s[0] === 1 && s[2] === 1), "compact text is one line").toBe(true);
    });

    it("has a raw error with each keyword the schema uses at least twice, and says which keywords cannot have one", () => {
      const cov = coverage(irSchema(), ir);
      expect(cov.unknown, "classify these keywords in schema-vectors.test.ts, and add cases for them").toEqual([]);
      expect(cov.missing, "keywords of spec/ir.schema.json with fewer than two cases").toEqual([]);
      expect([...cov.impossible.keys()].sort()).toEqual(["items", "properties", "$ref"].sort());
    });

    it("has a raw error raised in every entry of $defs, found by the schemaPath or by following the instance path", () => {
      const schema = irSchema() as { $defs: Record<string, unknown> };
      const inlined = new Set(inlinedDefs(schema));
      const found = new Set<string>();
      for (const c of ir) {
        for (const e of c.raw_errors) {
          const def = defOf(schema, e);
          expect(def, `${c.name}: ${e.instancePath} ${e.schemaPath}`).toBeDefined();
          found.add(def!);
          const named = /^#\/\$defs\/([^/]+)\//.exec(e.schemaPath);
          // Ajv writes the name of a definition only where it inlines it: where the definition holds no $ref.
          if (named) expect(inlined.has(named[1]!), `${named[1]} is inlined`).toBe(true);
        }
      }
      expect(Object.keys(schema.$defs).filter((d) => !found.has(d))).toEqual([]);
    });

    it("has raw errors that are all integers in `params`, and `propertyName` only inside propertyNames", () => {
      for (const c of ir) {
        for (const e of c.raw_errors) {
          const nums: unknown[] = [];
          JSON.stringify(e.params, (_k, v) => (typeof v === "number" ? (nums.push(v), v) : v));
          for (const n of nums) expect(Number.isInteger(n), `${c.name}: ${e.keyword} ${JSON.stringify(e.params)}`).toBe(true);
          if (e.propertyName !== undefined) expect(e.schemaPath, c.name).toMatch(/propertyNames|\$defs/);
        }
      }
    });

    it("names, for each behaviour of schemaDiagnostics, the cases that show it, and each of them does", () => {
      expect(Object.keys(BEHAVIOUR_CASES).sort()).toEqual([...BEHAVIOURS].sort());
      const byName = new Map(ir.map((c) => [c.name, c]));
      for (const [behaviour, names] of Object.entries(BEHAVIOUR_CASES)) {
        expect(names.length, behaviour).toBeGreaterThanOrEqual(3);
        for (const name of names) {
          const c = byName.get(name);
          expect(c, `${behaviour}: no case "${name}"`).toBeDefined();
          expect(c!.shows, `"${name}" shows ${behaviour}`).toContain(behaviour);
        }
      }
    });

    it("has the unknown members of the sort cases in an order the sort changes, and real characters", () => {
      const cp = ir.find((c) => c.name.startsWith("unknown root members U+E000"))!;
      expect(cp.diagnostics.map((d) => d.at.path)).toEqual(["/\u{1F600}", "/"]);
      expect(cp.raw_errors.map((e) => e.params["additionalProperty"])).toEqual(["", "\u{1F600}"]);
      const locale = ir.find((c) => c.name.startsWith("unknown root members in the order"))!;
      expect(locale.diagnostics.map((d) => d.at.path)).toEqual(["/1x", "/A", "/B", "/_x", "/a", "/b"]);
    });

    it("has Ajv visit array-index member names first, in numeric order, and __proto__ as a name", () => {
      const names = (name: string): unknown[] => ir.find((c) => c.name === name)!.raw_errors.filter((e) => e.keyword === "additionalProperties").map((e) => e.params["additionalProperty"]);
      expect(names(N_INDEX_UNKNOWN)).toEqual(["2", "10", "b"]);
      expect(ir.find((c) => c.name === N_INDEX_DEFS)!.raw_errors.filter((e) => e.keyword === "propertyNames").map((e) => e.params["propertyName"])).toEqual(["2", "10", "b d"]);
      expect(names(N_PROTO)).toEqual(["__proto__"]);
    });

    it("has raw errors in the order Ajv gives: the schema's order for members, the index for items, the document's for a map", () => {
      const paths = (name: string): string[] => ir.find((c) => c.name === name)!.raw_errors.map((e) => e.instancePath);
      expect(paths(N_ORDER_PROPERTIES)).toEqual(["/defs/Peer/budget/tokens", "/defs/Peer/budget/steps"]);
      expect(paths(N_ORDER_ITEMS)).toEqual(["/uses/0/names/0", "/uses/0/names/1"]);
      expect(paths(N_ORDER_MAP)).toEqual(["/tests/Check/handlers/ask", "/tests/Check/handlers/tell"]);
    });

    if (process.env["MANDATE_VECTORS_REPORT"] === "1") {
      it("prints the coverage tables", () => {
        const schema = irSchema() as { $defs: Record<string, unknown> };
        const cov = coverage(schema, ir);
        const lines: string[] = [`IR cases: ${ir.length}`, "", "keyword -> cases with a raw error of it"];
        for (const [k, n] of [...cov.byKeyword].sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`  ${k}: ${n}`);
        lines.push("keywords of the schema that cannot be the keyword of an error:");
        for (const [k, why] of cov.impossible) lines.push(`  ${k}: ${why}`);
        const defs = new Map<string, number>();
        for (const c of ir) for (const d of new Set(c.raw_errors.map((e) => defOf(schema, e)!))) defs.set(d, (defs.get(d) ?? 0) + 1);
        lines.push("", "$defs entry -> cases with a raw error raised in it (inlined by Ajv: " + inlinedDefs(schema).join(", ") + ")");
        for (const d of Object.keys(schema.$defs)) lines.push(`  ${d}: ${defs.get(d) ?? 0}`);
        lines.push("", "message template -> raw errors");
        for (const [t, n] of tally(ir.flatMap((c) => c.raw_errors), (e) => `${e.keyword}: ${template(e.message ?? "")}`)) lines.push(`  ${t}: ${n}`);
        lines.push("", "behaviour -> cases showing it (named cases)");
        for (const b of BEHAVIOURS) lines.push(`  ${b}: ${ir.filter((c) => c.shows.includes(b)).length} (${BEHAVIOUR_CASES[b]!.length} named)`);
        const lockCov = coverage(lockSchema(), locks);
        lines.push("", `lock cases: ${locks.length}`, "keyword -> cases with a raw error of it");
        for (const [k, n] of [...lockCov.byKeyword].sort(([a], [b]) => (a < b ? -1 : 1))) lines.push(`  ${k}: ${n}`);
        lines.push("keywords of the lock schema that cannot be the keyword of an error:");
        for (const [k, why] of lockCov.impossible) lines.push(`  ${k}: ${why}`);
        const lockSchemaDefs = lockSchema() as { $defs: Record<string, unknown> };
        const lockDefs = new Map<string, number>();
        for (const c of locks) for (const d of new Set(c.raw_errors.map((e) => defOf(lockSchemaDefs, e)!))) lockDefs.set(d, (lockDefs.get(d) ?? 0) + 1);
        lines.push("$defs entry -> cases (lock)");
        for (const d of Object.keys(lockSchemaDefs.$defs)) lines.push(`  ${d}: ${lockDefs.get(d) ?? 0}`);
        lines.push("message template -> raw errors (lock)");
        for (const [t, n] of tally(locks.flatMap((c) => c.raw_errors), (e) => `${e.keyword}: ${template(e.message ?? "")}`)) lines.push(`  ${t}: ${n}`);
        lines.push("", `gate cases: ${gates.length}`, `sizes: ${[...now].map(([f, c]) => `${f} ${Buffer.byteLength(c)}`).join("; ")}`);
        const out = process.env["MANDATE_VECTORS_REPORT_FILE"];
        if (out) {
          writeFileSync(out, lines.join("\n") + "\n");
          writeFileSync(out + ".json", JSON.stringify({ ir, locks, gates }));
        } else console.log(lines.join("\n"));
      });
    }
  });

  describe("version gates", () => {
    it("has a case for every row of every SINCE table, accepted in the newest language and refused in each older one", () => {
      for (const [table, rows] of Object.entries(SINCE)) {
        for (const [key, since] of Object.entries(rows)) {
          const mine = gates.filter((g) => g.rule === `${table}.${key}`);
          expect(mine.length, `${table}.${key}`).toBeGreaterThanOrEqual(2);
          for (const g of mine) {
            const refuses = !atLeast(g.language as LanguageVersion, since);
            expect(g.verdict, g.name).toBe(refuses ? "refused" : "accepted");
            if (refuses) {
              expect(g.diagnostics.length, g.name).toBeGreaterThan(0);
              expect(g.diagnostics.every((d) => d.code === "MDT-E0104" && d.at.span !== undefined && d.facts?.["language"] === g.language), g.name).toBe(true);
            } else expect(g.diagnostics, g.name).toEqual([]);
          }
          expect(mine.some((g) => g.language === NEWEST && g.verdict === "accepted"), `${table}.${key} in ${NEWEST}`).toBe(true);
          for (const language of LANGUAGE_VERSIONS.filter((l) => !atLeast(l, since))) expect(mine.some((g) => g.language === language && g.verdict === "refused"), `${table}.${key} in ${language}`).toBe(true);
        }
      }
    });

    it("has the other E0104 rules: refused where they say, accepted where they do not", () => {
      for (const g of gates.filter((x) => x.since === null)) {
        if (g.verdict === "accepted") expect(g.diagnostics, g.name).toEqual([]);
        else {
          expect(g.diagnostics.length, g.name).toBeGreaterThan(0);
          expect(g.diagnostics.every((d) => d.code === "MDT-E0104"), g.name).toBe(true);
        }
      }
      expect(RULE_GATES.length).toBeGreaterThanOrEqual(5);
    });

    it("has a case for each of the five places a budget is written", () => {
      expect(GATE_PROGRAMS["budgetFields.agents"]!.length).toBe(5);
    });
  });

  describe("invalid locks", () => {
    it("has about 30 cases or more, with distinct names", () => {
      expect(locks.length).toBeGreaterThanOrEqual(30);
      expect(new Set(locks.map((c) => c.name)).size).toBe(locks.length);
    });

    it("gives E0140 for each raw error, with Ajv's params as facts, and for the rules after the schema", () => {
      for (const c of locks) {
        expect(c.diagnostics.length, c.name).toBeGreaterThan(0);
        expect(c.diagnostics.every((d) => d.code === "MDT-E0140"), c.name).toBe(true);
        if (c.raw_errors.length > 0) {
          expect(c.diagnostics.map((d) => [d.at.path, d.facts?.["keyword"], d.facts?.["params"]]), c.name).toEqual(c.raw_errors.map((e) => [e.instancePath, e.keyword, e.params]));
        }
      }
      expect(locks.filter((c) => c.raw_errors.length === 0).length).toBeGreaterThanOrEqual(6);
    });

    it("has a raw error with each keyword of the lock schema at least twice, and every entry of $defs", () => {
      const schema = lockSchema() as { $defs: Record<string, unknown> };
      const cov = coverage(schema, locks);
      expect(cov.unknown).toEqual([]);
      expect(cov.missing, "keywords of spec/lock.schema.json with fewer than two cases").toEqual([]);
      const found = new Set<string>();
      for (const c of locks) for (const e of c.raw_errors) found.add(defOf(schema, e) ?? `?${c.name}: ${e.schemaPath}`);
      expect(Object.keys(schema.$defs).filter((d) => !found.has(d))).toEqual([]);
      expect([...found].filter((d) => d.startsWith("?"))).toEqual([]);
    });
  });
});
