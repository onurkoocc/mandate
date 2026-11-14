// Writes the vectors in vectors/ (vectors/README.md): what this compiler's
// strict reader, canonical text and hashes give for chosen inputs and for
// every program the golden file pins. Another implementation (the Rust crate
// in crates/mandate-ir) reads the same files and must give the same bytes.
//
// The committed files must be what this test generates; it fails when one
// differs, is missing or is left over. To write them again:
// MANDATE_UPDATE_VECTORS=1 npm test.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kindOf, load } from "../src/check.js";
import { domainHash, hashProgram, packageHash, type HashDomain } from "../src/hash.js";
import { canonicalize } from "../src/json/jcs.js";
import { isWellFormed, parseStrictJson, type Json } from "../src/json/strict-json.js";
import { LIMITS } from "../src/limits.js";
import { packagedLock, type Lock } from "../src/lock.js";
import { lockFileOf, readRepo, repoRoot } from "./helpers.js";

const VECTORS = "vectors/";
const PROGRAMS_DIR = `${VECTORS}programs/`;

/** One reader input: text, text pieces repeated, or bytes (hex) repeated. */
type Input = { input: string } | { input_parts: Array<[string, number]> } | { input_bytes: Array<[string, number]> };

/** The text the reader is given: bytes are decoded as readFileSync(file, "utf8") decodes them. */
function textOf(i: Input): string {
  if ("input" in i) return i.input;
  if ("input_parts" in i) return i.input_parts.map(([s, n]) => s.repeat(n)).join("");
  return Buffer.concat(i.input_bytes.map(([hex, n]) => Buffer.from(hex.repeat(n), "hex"))).toString("utf8");
}

const text = (name: string, input: string): { name: string } & Input => ({ name, input });
const parts = (name: string, ...input_parts: Array<[string, number]>): { name: string } & Input => ({ name, input_parts });
const bytes = (name: string, ...input_bytes: Array<[string, number]>): { name: string } & Input => ({ name, input_bytes });

const D = LIMITS.jsonDepth;
const MiB = LIMITS.sourceBytes;

/** Reader inputs, accepted ones first. Each name says what the vector is about. */
const READER_INPUTS: Array<{ name: string } & Input> = [
  // Accepted.
  text("every scalar", '[null,true,false,0,-1,1,"s"]'),
  text("whitespace of all four kinds, CR counted as a column", ' \t\r\n{ "a" :\r[ 1 ,\t2 ] }\r\n '),
  text("empty containers and the empty string", '{"a":{},"b":[],"c":""}'),
  text("the short escapes and the solidus", '"\\"\\\\\\/\\b\\f\\n\\r\\t"'),
  text("\\u escapes in lower and upper case", '"\\u0041\\u00e9\\u00C9\\u20ac\\uABCD\\u0000\\u001f"'),
  text("a surrogate pair written as escapes", '"\\ud83d\\ude00\\uD83D\\uDE00"'),
  text("a character outside the BMP is two columns", '["😀",1,"a😀b",2]'),
  text("characters of the BMP outside ASCII are one column", '{"é":"ü","€":["ж",1]}'),
  text("U+007F, U+2028 and U+2029 unescaped in a string", '["\u007f"," "," "]'),
  text("integers at ±(2^53−1)", "[9007199254740991,-9007199254740991]"),
  text("zero", "0"),
  text("a lone top-level string", '"x"'),
  text("pointer tokens escape ~ and /", '{"a/b":{"m~n":{"~/":1}},"":{"":2}}'),
  text("__proto__ and constructor are ordinary keys", '{"__proto__":1,"constructor":{"prototype":2}}'),
  text("no Unicode normalisation: é and e + U+0301 are two keys", '{"é":1,"é":2}'),
  text("multi-line input with characters outside ASCII", '{\n  "é😀": [\n    1,\n    "ü"\n  ],\n  "x": {"y": null}\n}\n'),
  parts(`arrays nested ${D} deep`, ["[", D], ["]", D]),
  parts(`a scalar at depth ${D}`, ["[", D - 1], ["0", 1], ["]", D - 1]),
  parts(`objects nested ${D} deep`, ['{"a":', D - 1], ["{}", 1], ["}", D - 1]),
  parts("input of exactly the size limit", [" ", MiB - 1], ["0", 1]),
  parts("the size limit counts UTF-8 bytes, not code units", ['"', 1], ["é", (MiB - 2) / 2], ['"', 1]),
  bytes("ill-formed UTF-8 in a string becomes U+FFFD per maximal subpart", ["22", 1], ["eda080", 1], ["c080", 1], ["e2822e", 1], ["ff", 1], ["f09f98", 1], ["22", 1]),
  bytes("UTF-8 bytes of a character outside the BMP", ["22f09f988022", 1]),

  // E0108: not JSON.
  text("empty input", ""),
  text("only whitespace", "  \n\t "),
  text("a truncated literal", "tru"),
  text("a literal in the wrong case", "True"),
  text("a literal followed by a letter", "trueX"),
  text("a leading plus", "+1"),
  text("a leading decimal point", ".5"),
  text("a lone minus", "-"),
  text("a minus before a letter", "[-a]"),
  text("a leading zero", "01"),
  text("a decimal point without digits", "1."),
  text("an exponent without digits", "[1e]"),
  text("a trailing comma in an array", "[1,]"),
  text("a missing comma in an array", "[1 2]"),
  text("an unclosed array", "["),
  text("a missing colon", '{"a" 1}'),
  text("a trailing comma in an object", '{"a":1,}'),
  text("an unquoted key", "{a:1}"),
  text("an unclosed object", '{"a":1'),
  text("content after the value", "{} x"),
  text("a second value", "1 2"),
  text("an unterminated string", '"abc'),
  text("an unterminated key", '{"abc'),
  text("an unknown escape", '"\\x"'),
  text("an upper-case U escape", '"\\U0041"'),
  text("a backslash at the end of input", '"\\'),
  text("a \\u escape with three digits", '"\\u12"'),
  text("a \\u escape with a non-hex digit", '"\\u12G4"'),
  text("a raw tab in a string", '"a\tb"'),
  text("a raw line feed in a string, reported on the next line", '"a\nb"'),
  text("a raw carriage return in a string", '"a\rb"'),
  text("a raw NUL in a string", '"\u0000"'),
  text("a raw U+001F in a string", '["ok","\u001f"]'),
  text("a byte order mark given as text", "﻿{}"),
  bytes("a byte order mark in the file", ["efbbbf7b7d", 1]),
  bytes("an ill-formed UTF-8 byte outside a string", ["5b", 1], ["ff", 1], ["5d", 1]),
  text("carriage returns do not start a line", "\r\r x"),
  text("an error on line 3 after characters outside ASCII", '{\n  "é😀": [1, 2,\n  "ü😀" x]\n}'),
  text("an error after two characters outside the BMP", '["😀😀" x]'),

  // E0102: a duplicate key.
  text("a duplicate key", '{"a":1,"a":2}'),
  text("a duplicate key at depth", '{"x":[{"k":{"a":1,"b":{},"a":2}}]}'),
  text("a duplicate key written with an escape", '{"a":1,"\\u0061":2}'),
  text("a duplicate key that needs pointer escapes", '{"a/b~":1,"a/b~":2}'),
  text("a duplicate empty key", '{"":1,"":2}'),
  text("a duplicate key outside ASCII on a later line", '{\n "é😀": 1,\n "é😀": 2\n}'),
  text("a duplicate key is found before its value is read", '{"a":1,"a":tru'),

  // E0105: a limit.
  parts(`arrays nested ${D + 1} deep`, ["[", D + 1], ["]", D + 1]),
  parts(`a scalar at depth ${D + 1}`, ["[", D], ["0", 1], ["]", D]),
  parts(`objects nested ${D + 1} deep`, ['{"a":', D], ["{}", 1], ["}", D]),
  parts("input one byte over the size limit", [" ", MiB], ["0", 1]),
  parts("input over the size limit in UTF-8 bytes only", ['"', 1], ["é", MiB / 2], ['"', 1]),
  bytes("input over the size limit once U+FFFD replaces ill-formed bytes", ["22", 1], ["ff", (MiB - 1) / 3], ["22", 1]),

  // E0106: a number outside the domain.
  text("2^53", "9007199254740992"),
  text("−2^53", "-9007199254740992"),
  text("an integer far beyond the range", "[12345678901234567890123]"),
  text("negative zero", "-0"),
  text("negative zero in an array", "[-0]"),
  text("negative zero with a leading zero after it", "-01"),
  text("a fraction", "1.5"),
  text("a fraction that is an integer", "1.0"),
  text("negative zero as a fraction", "-0.0"),
  text("an exponent", "1e3"),
  text("an exponent with a sign", "1E+3"),
  text("a negative exponent", "1e-3"),
  text("zero with an exponent", '{"n":0e0}'),

  // E0107: a lone surrogate.
  text("a lone high surrogate", '"\\ud800"'),
  text("a lone low surrogate", '"\\udc00"'),
  text("a high surrogate before a letter", '"\\ud83dx"'),
  text("a pair in the wrong order", '"\\ude00\\ud83d"'),
  text("a high surrogate escape before a raw character outside the BMP", '"\\ud83d😀"'),
  text("a lone surrogate in a key", '{"\\ud800":1}'),
  text("a lone surrogate at depth", '{"a":["\\udfff"]}'),
];

/** Canonical text longer than this is given by its SHA-256 (of its UTF-8), not in full. */
const LONG = 4096;

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function readerVectors(): unknown[] {
  return READER_INPUTS.map(({ name, ...input }) => {
    const r = parseStrictJson(textOf(input));
    if (r.ok) {
      const canonical = canonicalize(r.value.value);
      // A canonical text near the size limit would make the file too large to read: its digest stands for it.
      const expected = canonical.length > LONG ? { canonical_sha256: sha256Hex(canonical) } : { canonical };
      return { name, ...input, ok: true, ...expected, spans: Object.fromEntries(r.value.spans) };
    }
    for (const d of r.diagnostics) {
      // A message that quotes half of a surrogate pair cannot be carried as text; see vectors/README.md.
      if (!isWellFormed(d.message)) throw new Error(`reader vector "${name}": the message holds a lone surrogate`);
    }
    return { name, ...input, ok: false, diagnostics: r.diagnostics };
  });
}

/** Canonical-text inputs: each is read by the strict reader, then canonicalised. */
const JCS_INPUTS: Array<{ name: string; input: string }> = [
  { name: "RFC 8785 §3.2.3: members sorted by UTF-16 code units", input: '{"€":1,"\\r":2,"דּ":3,"1":4,"😀":5,"\\u0080":6,"ö":7}' },
  { name: "UTF-16 order differs from code point and UTF-8 byte order", input: '{"\\uffff":1,"\\ue000":2,"😀":3,"\\u00e9":4,"z":5}' },
  { name: "a character outside the BMP sorts before U+E000 to U+FFFF", input: '{"\\uff61":1,"𝄞":2,"\\ue000":3,"\\ud7ff":4}' },
  { name: "a prefix sorts first, the empty name before all", input: '{"ab":1,"b":2,"a":3,"":4}' },
  { name: "upper case sorts before lower case", input: '{"a":1,"B":2,"A":3,"b":4}' },
  { name: "integer-like names sort as strings", input: '{"10":1,"9":2,"a":3,"1":4}' },
  { name: "no Unicode normalisation", input: '{"é":1,"e\\u0301":2}' },
  { name: "members sorted at every depth, arrays kept in order", input: '{"z":[{"b":1,"a":2},[3,{"d":4,"c":5}]],"y":{"y":{"b":0,"a":0}}}' },
  { name: "every control character", input: JSON.stringify(Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("")) },
  { name: "quote, backslash and solidus", input: '"\\"\\\\\\/"' },
  { name: "U+007F, U+2028 and U+2029 are written as themselves", input: '"\\u007f\\u2028\\u2029"' },
  { name: "escapes of other characters are written as the characters", input: '"\\u0041\\u00e9\\u20ac\\ud83d\\ude00\\uFFFF"' },
  { name: "control characters in a member name", input: '{"\\u0001\\n":1,"\\t":2}' },
  { name: "integers at the bounds and zero", input: "[9007199254740991,-9007199254740991,0,-1,10,100]" },
  { name: "whitespace is removed", input: ' {\n "a" : [ 1 , true , null ] ,\r\n "b" : { } }\t' },
  { name: "scalars", input: '[null,true,false,"",[],{}]' },
];

function jcsVectors(): unknown[] {
  return JCS_INPUTS.map(({ name, input }) => {
    const r = parseStrictJson(input);
    if (!r.ok) throw new Error(`jcs vector "${name}" does not read`);
    return { name, input, canonical: canonicalize(r.value.value) };
  });
}

const DOMAINS = ["program", "def", "package", "run", "action", "operation", "request", "binding", "decision", "event"] as const satisfies readonly HashDomain[];
// Every domain has a vector: a domain added to HashDomain and not here does not compile.
const everyDomain: Exclude<HashDomain, (typeof DOMAINS)[number]> extends never ? true : never = true;
void everyDomain;

function hashVectors(): unknown {
  const value = '{"b":[1,"é"],"a":{"😀":null}}';
  const read = (input: string): Json => {
    const r = parseStrictJson(input);
    if (!r.ok) throw new Error(`hash vector input does not read: ${input}`);
    return r.value.value;
  };
  const domain: unknown[] = [];
  for (const d of DOMAINS) domain.push({ domain: d, version: "0.1", input: value, hash: domainHash(d, read(value), "0.1") });
  for (const version of ["0.2", "0.3", "0.4", "0.5", ""]) {
    for (const d of ["program", "def"] as const) domain.push({ domain: d, version, input: value, hash: domainHash(d, read(value), version) });
  }
  domain.push({ domain: "program", version: "0.1", input: "{}", hash: domainHash("program", {}, "0.1") });
  domain.push({ domain: "def", version: "0.1", input: '""', hash: domainHash("def", "", "0.1") });

  const defs = '{"T":{"kind":"type","type":{"ref":"Text"}}}';
  const programs: Array<{ name: string; input: string }> = [
    { name: "a 0.1 program", input: `{"language":"mandate/0.1","module":"m","version":"0.1","defs":${defs}}` },
    { name: "a 0.4 program", input: `{"language":"mandate/0.4","module":"m","version":"0.1","defs":${defs}}` },
    { name: "a 0.5 program", input: `{"language":"mandate/0.5","module":"m","version":"0.1","defs":${defs}}` },
    { name: "no language: 0.1", input: `{"module":"m","defs":${defs}}` },
    { name: "a language not under mandate/: 0.1", input: `{"language":"other/0.3","defs":${defs}}` },
    { name: "a language that is not a string: 0.1", input: `{"language":3,"defs":${defs}}` },
    { name: "mandate/ alone: the empty version", input: `{"language":"mandate/","defs":${defs}}` },
    { name: "definitions in UTF-16 order of their names", input: '{"language":"mandate/0.3","defs":{"😀":1,"\\ue000":2,"b":3,"B":4,"10":5,"9":6}}' },
    { name: "defs that is not an object: no definitions", input: '{"language":"mandate/0.2","defs":[1,2]}' },
    { name: "no defs: no definitions", input: '{"language":"mandate/0.2"}' },
    { name: "a program that is not an object", input: '["mandate/0.2"]' },
  ];
  const program = programs.map(({ name, input }) => {
    const p = read(input);
    const h = hashProgram(p);
    const d = p && typeof p === "object" && !Array.isArray(p) ? p["defs"] : undefined;
    // In the order hashProgram hashes them, not Object.keys order (which puts integer-like names first).
    const names = d && typeof d === "object" && !Array.isArray(d) ? Object.keys(d).sort() : [];
    return { name, input, program: h.program, defs: names.map((n) => [n, h.defs[n]]) };
  });

  const programHash = hashProgram(read(programs[0]!.input)).program;
  const locks: Array<{ name: string; lock: string }> = [
    { name: "no lock file: no pins", lock: canonicalize(packagedLock(undefined) as unknown as Json) },
    { name: "a lock with pins", lock: '{"modules":{"company.domain":"sha256:0f1e"},"models":{"standard":{"provider":"anthropic","model":"m","effort":"high"}}}' },
  ];
  const pkg = locks.map(({ name, lock }) => ({ name, program_hash: programHash, lock, hash: packageHash(programHash, read(lock) as object) }));
  return { domain, program, package: pkg };
}

/** The programs the golden file pins, by repository path. */
function goldenPrograms(): string[] {
  return Object.keys(JSON.parse(readRepo("compiler/test/golden/outputs.json")) as Record<string, unknown>).sort();
}

/** `fixtures/fixbug/fixbug.mdt` → `fixtures.fixbug.fixbug.mdt.json`. */
const programFile = (source: string): string => `${PROGRAMS_DIR}${source.replaceAll("/", ".")}.json`;

function programVector(source: string): unknown {
  const loaded = load(readRepo(source), kindOf(source));
  if (!loaded.program) throw new Error(`${source} does not load`);
  const ir = loaded.program as unknown as Json;
  const h = hashProgram(ir);
  const out: Record<string, unknown> = {
    format: "mandate/vectors/program/0.1",
    source,
    kind: kindOf(source),
    language: loaded.program.language,
    canonical: canonicalize(ir),
    hashes: { program: h.program, defs: Object.keys(loaded.program.defs).sort().map((n) => [n, h.defs[n]]) },
  };
  const lockPath = lockFileOf(source);
  if (lockPath) {
    const parsed = parseStrictJson(readRepo(lockPath));
    if (!parsed.ok) throw new Error(`${lockPath} is not strict JSON`);
    const packaged = packagedLock(parsed.value.value as unknown as Lock);
    out["lock"] = packaged;
    out["package"] = packageHash(h.program, packaged);
  }
  // Last, so the file reads top down: the hashes, then the IR they are of, in the compiler's member order.
  out["ir"] = ir;
  return out;
}

/**
 * JSON as the vector files hold it: two-space indents, an array of numbers
 * (a span) on one line, and every character from U+007F up escaped, so a
 * file is ASCII. Both rewrites only touch text outside strings: a string in
 * JSON text holds no raw line feed, and no raw character from U+007F up
 * occurs outside one.
 */
function vectorText(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
    .replace(/\[\n(?:\s*-?\d+,\n)*\s*-?\d+\n\s*\]/g, (a) => `[${a.slice(1, -1).trim().split(/,\s*/).join(", ")}]`)
    .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return json + "\n";
}

function generate(): Map<string, string> {
  const files = new Map<string, string>();
  files.set(`${VECTORS}reader.json`, vectorText({ format: "mandate/vectors/reader/0.1", vectors: readerVectors() }));
  files.set(`${VECTORS}jcs.json`, vectorText({ format: "mandate/vectors/jcs/0.1", vectors: jcsVectors() }));
  files.set(`${VECTORS}hash.json`, vectorText({ format: "mandate/vectors/hash/0.1", ...(hashVectors() as object) }));
  for (const source of goldenPrograms()) files.set(programFile(source), vectorText(programVector(source)));
  return files;
}

/** The vector files on disk, as repository paths. */
function committed(): string[] {
  // syntax.json is written by syntax-vectors.test.ts.
  const top = existsSync(repoRoot + VECTORS) ? readdirSync(repoRoot + VECTORS).filter((f) => f.endsWith(".json") && f !== "syntax.json").map((f) => VECTORS + f) : [];
  const programs = existsSync(repoRoot + PROGRAMS_DIR) ? readdirSync(repoRoot + PROGRAMS_DIR).map((f) => PROGRAMS_DIR + f) : [];
  return [...top, ...programs].sort();
}

describe("vectors for other implementations", () => {
  const now = generate();

  if (process.env["MANDATE_UPDATE_VECTORS"] === "1") {
    mkdirSync(repoRoot + PROGRAMS_DIR, { recursive: true });
    for (const file of committed()) if (!now.has(file)) rmSync(repoRoot + file);
    for (const [file, text] of now) writeFileSync(repoRoot + file, text);
  }

  it("vectors/ holds exactly the files the generator writes", () => {
    expect(committed()).toEqual([...now.keys()].sort());
  });

  for (const [file, text] of now) {
    it(`${file} is what this compiler gives`, () => {
      expect(existsSync(repoRoot + file), `${file} is missing; MANDATE_UPDATE_VECTORS=1 npm test writes it`).toBe(true);
      expect(readFileSync(repoRoot + file, "utf8")).toBe(text);
    });
  }

  it("every file is ASCII strict JSON within the reader's limits, so any implementation's reader takes it", () => {
    for (const [file, text] of now) {
      expect(/^[\x20-\x7e\n]*$/.test(text), file).toBe(true);
      const r = parseStrictJson(text);
      expect(r.ok, file).toBe(true);
    }
  });

  it("covers every refusal of the reader, and acceptance", () => {
    const vectors = readerVectors() as Array<{ ok: boolean; diagnostics?: Array<{ code: string }> }>;
    const seen = new Set(vectors.flatMap((v) => (v.ok ? ["ok"] : v.diagnostics!.map((d) => d.code))));
    expect([...seen].sort()).toEqual(["MDT-E0102", "MDT-E0105", "MDT-E0106", "MDT-E0107", "MDT-E0108", "ok"]);
    expect(new Set(READER_INPUTS.map((v) => v.name)).size).toBe(READER_INPUTS.length);
  });

  it("covers every program the golden file pins, each with a package hash where it has a lock", () => {
    const programs = goldenPrograms();
    expect(programs.length).toBeGreaterThanOrEqual(16);
    expect(new Set(programs.map(programFile)).size).toBe(programs.length);
    const withLock = programs.filter((p) => lockFileOf(p) !== undefined);
    expect(withLock.length).toBeGreaterThan(0);
    for (const p of withLock) expect(now.get(programFile(p))).toContain('"package": "sha256:');
  });
});
