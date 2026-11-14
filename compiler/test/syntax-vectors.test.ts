// Writes vectors/syntax.json and vectors/spans/ (vectors/README.md): what
// this compiler's lexer, parser and printer give for chosen text, and the
// pointer-to-span table of every program the golden file pins. Another
// implementation reads the same files and must give the same results.
//
// The committed files must be what this test generates; it fails when one
// differs, is missing or is left over. To write them again:
// MANDATE_UPDATE_VECTORS=1 npm test.
//
// It also asserts what the inputs cover: every message the lexer and the
// parser can give, every construct of the IR and each optional part of it,
// every literal and token form, and the positions that count UTF-16 code
// units.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isWellFormed, parseStrictJson } from "../src/json/strict-json.js";
import { LIMITS } from "../src/limits.js";
import { RESERVED } from "../src/parse/parser.js";
import { repoRoot } from "./helpers.js";
import { SYNTAX_CASES, type SyntaxCase } from "./syntax-cases/index.js";
import { RESERVED_WORDS } from "./syntax-cases/lexical.js";
import {
  SPANS_DIR,
  SYNTAX_FILE,
  UNREACHABLE,
  callSiteCount,
  coverage,
  isLoaded,
  goldenPrograms,
  observedForms,
  requiredForms,
  sites,
  spansFile,
  syntaxFiles,
  syntaxResults,
  templateShapes,
  textOf,
} from "./syntax-vectors.js";

/** The strict reader refuses a file over 1 MiB; a file here stays well under it. */
const MAX_FILE = 900_000;
/** What the files together may add to the repository. */
const MAX_TOTAL = 1_500_000;

/** The vector files on disk, as repository paths. */
function committed(): string[] {
  const spans = existsSync(repoRoot + SPANS_DIR) ? readdirSync(repoRoot + SPANS_DIR).map((f) => SPANS_DIR + f) : [];
  return [...(existsSync(repoRoot + SYNTAX_FILE) ? [SYNTAX_FILE] : []), ...spans].sort();
}

describe("syntax vectors for other implementations", () => {
  const now = syntaxFiles();

  if (process.env["MANDATE_UPDATE_VECTORS"] === "1") {
    mkdirSync(repoRoot + SPANS_DIR, { recursive: true });
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

  it("keeps every file well under the reader's size limit, and the files together under the budget", () => {
    expect(MAX_FILE).toBeLessThan(LIMITS.sourceBytes);
    let total = 0;
    for (const [file, text] of now) {
      const size = Buffer.byteLength(text, "utf8");
      expect(size, file).toBeLessThan(MAX_FILE);
      total += size;
    }
    expect(total).toBeLessThan(MAX_TOTAL);
  });

  it("generating twice gives the same files", () => {
    const again = syntaxFiles();
    expect([...again.keys()]).toEqual([...now.keys()]);
    for (const [file, text] of now) expect(again.get(file), file).toBe(text);
  });

  it("has a span table for every program the golden file pins, each with the number of its entries", () => {
    const programs = goldenPrograms();
    expect(programs.length).toBeGreaterThanOrEqual(16);
    for (const p of programs) {
      const file = spansFile(p);
      const v = JSON.parse(now.get(file)!) as { count: number; spans: unknown[] };
      expect(v.spans.length, file).toBe(v.count);
      expect(v.count, file).toBeGreaterThan(0);
    }
    expect(new Set(programs.map(spansFile)).size).toBe(programs.length);
  });

  it("lists spans by pointer in UTF-16 code-unit order, once each", () => {
    for (const [file, text] of now) {
      const rows = (JSON.parse(text) as { spans?: Array<[string, ...number[]]> }).spans;
      if (!rows || file === SYNTAX_FILE) continue;
      const pointers = rows.map((r) => r[0]);
      expect(pointers, file).toEqual([...new Set(pointers)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    }
  });
});

describe("what the syntax vectors cover", () => {
  const results = syntaxResults();
  const texts = SYNTAX_CASES.map(textOf);

  it("has between 120 and a few hundred inputs, each named once", () => {
    expect(SYNTAX_CASES.length).toBeGreaterThanOrEqual(120);
    expect(new Set(SYNTAX_CASES.map((c) => c.name)).size).toBe(SYNTAX_CASES.length);
  });

  it("has an input of each kind: read, read with diagnostics, refused", () => {
    expect(results.some((r) => r.ok && r.diagnostics.length === 0)).toBe(true);
    expect(results.some((r) => isLoaded(r) && r.diagnostics.length > 0)).toBe(true);
    expect(results.some((r) => !isLoaded(r) && r.diagnostics.length > 0)).toBe(true);
  });

  it("reaches every message the lexer and the parser can give, except those listed with a reason", () => {
    const covered = coverage(results);
    const missed = covered.filter((c) => c.cases.length === 0).map((c) => `${c.site.kind}: ${c.site.id}`);
    const unlisted = missed.filter((m) => UNREACHABLE[m] === undefined);
    expect(unlisted, "messages no input reaches; add an input, or list the message in UNREACHABLE with its reason").toEqual([]);
    const reached = Object.keys(UNREACHABLE).filter((m) => !missed.includes(m));
    expect(reached, "listed as unreachable but an input reaches it").toEqual([]);
  });

  it("reaches each call site of a message that several calls give, which the message alone does not tell apart", () => {
    const sitesOfOneMessage: Array<[string, RegExp]> = [
      // parser.ts: typeDecl, the envelope's spawn, environmentDecl.
      ["type: a classified type of an unknown class", /^Unknown data class 'secret'/],
      ["workflow: an envelope with max_class of an unknown class", /^Unknown data class 'secret'/],
      ["system: an environment with a class that is unknown", /^Unknown data class 'secret'/],
      // decl(): a token that is not a name, and a name that starts no declaration.
      ["header: a definition that starts with a number", /^Expected a declaration but found '1'\.$/],
      ["position: a character outside the BMP in a string, then an error on the same line", /^Expected a declaration but found 'b'\.$/],
      // envelope(): a token that is not a name, and a name that is not a field.
      ["workflow: an envelope with a field that is not a name", /^Expected owner, caps, budget, spawn or approve in an envelope but found '1'\.$/],
      ["workflow: an envelope with an unknown field", /^Expected owner, caps, budget, spawn or approve in an envelope but found 'colour'\.$/],
      // The envelope's max_concurrent, and the map's max and par.
      ["workflow: an envelope with max_concurrent of zero", /^'max_concurrent' takes a whole number, at least 1\.$/],
      ["expression: a map expression with max of zero", /^'max' takes a whole number, at least 1\.$/],
      ["expression: a map expression with par of zero", /^'par' takes a whole number, at least 1\.$/],
    ];
    for (const [name, message] of sitesOfOneMessage) {
      const r = results.find((x) => x.name === name);
      expect(r, name).toBeDefined();
      expect(r!.diagnostics.some((d) => message.test(d.message)), name).toBe(true);
    }
  });

  it("holds the hand-listed diag( calls to the source: one in the lexer, seven in the parser", () => {
    const count = callSiteCount();
    expect(count.diag).toBe(8);
    expect(sites().filter((s) => s.kind === "diag").length).toBe(5);
  });

  it("reaches every diagnostic code the lexer and parser give", () => {
    const codes = new Set(results.flatMap((r) => r.diagnostics.map((d) => d.code)));
    for (const code of ["MDT-E0101", "MDT-E0103", "MDT-E0105", "MDT-E0120", "MDT-E0121"]) expect(codes.has(code), code).toBe(true);
  });

  it("holds the list of reserved words to the parser's, and has each as a definition's name", () => {
    expect(new Set(RESERVED_WORDS)).toEqual(RESERVED);
    for (const w of RESERVED_WORDS) {
      const asName = results.find((r) => r.name === `reserved word: '${w}' as a definition name`)!;
      expect(asName.diagnostics.map((d) => d.message), w).toEqual([`'${w}' is a reserved keyword and cannot be used as a name.`]);
    }
  });

  it("produces every construct of the IR and each optional part of it", () => {
    const seen = observedForms(results);
    const missed = requiredForms().filter((f) => !seen.has(f));
    expect(missed).toEqual([]);
  });

  it("puts interpolations at the start, in the middle, at the end, next to each other and alone", () => {
    const shapes = templateShapes(results);
    for (const s of ["start", "middle", "end", "adjacent", "alone", "an expression, not a name", "in a prompt"]) expect(shapes.has(s), s).toBe(true);
  });

  it("has an empty interpolation, a nested one and one in a multi-line string", () => {
    const inputs = texts;
    expect(inputs.some((i) => /"[^"\n]*\{\}[^"\n]*"/.test(i))).toBe(true);
    expect(inputs.some((i) => i.includes('"""') && /\{[a-z]/.test(i))).toBe(true);
    expect(inputs.some((i) => /\{ \{\} \}/.test(i))).toBe(true);
  });

  /** Lexical and positional forms the inputs must hold, each as a pattern an input matches. */
  const FORMS: Array<[string, RegExp, "any" | "ok"]> = [
    ["an integer with digit separators", /\d_\d/, "ok"],
    ["a count with k", /\b\d+k\b/, "ok"],
    ["a count with M", /\b\d+M\b/, "ok"],
    ["a decimal", /\b\d+\.\d+\b/, "ok"],
    ["money", /\d \b[A-Z]{3}\b/, "ok"],
    ["a duration in ms", /\b\d+ms\b/, "ok"],
    ["a duration in s", /\b\d+s\b/, "ok"],
    ["a duration in m", /\b\d+m\b/, "ok"],
    ["a duration in h", /\b\d+h\b/, "ok"],
    ["a duration in d", /\b\d+d\b/, "ok"],
    ["a negative literal", /= -\d/, "ok"],
    ["an escape: \\n", /\\n/, "ok"],
    ["an escape: \\t", /\\t/, "ok"],
    ["an escape: \\r", /\\r/, "ok"],
    ["an escape: \\\"", /\\"/, "ok"],
    ["an escape: \\\\", /\\\\/, "ok"],
    ["an escape: \\{", /\\\{/, "ok"],
    ["an escape: \\}", /\\\}/, "ok"],
    ["a multi-line string", /"""/, "ok"],
    ["a prompt template", /prompt"/, "ok"],
    ["a comment at the start of the file", /^\/\//, "ok"],
    ["a comment at the end of a line", /\S \/\/ \w+\n/, "ok"],
    ["a comment in the middle of an expression", /\+ \/\/ [^\n]*\n/, "ok"],
    ["a comment at the end of the file with no line break", /\/\/ [^\n]*$/, "ok"],
    ["a comment in a type", /\n  \/\/ b: Text/, "ok"],
    ["the subset operator", /⊆/, "ok"],
    ["a tab", /\t/, "ok"],
    ["a CRLF", /\r\n/, "ok"],
    ["a CR on its own", /\r(?!\n)/, "ok"],
    ["no final newline", /[^\n]$/, "ok"],
    ["trailing white space", /[ \t]+\n/, "ok"],
    ["a byte order mark in a comment", /\/\/ ﻿/, "ok"],
    ["a character outside the BMP in a string", /"[^"\n]*[\ud800-\udbff]/, "ok"],
    ["a character outside the BMP in a comment", /\/\/[^\n]*[\ud800-\udbff]/, "ok"],
    ["a character of the BMP outside ASCII in a string", /"[^"\n]*[\u0080-퟿]/, "ok"],
    ["a mark at the very start of the file that is not white space (a byte order mark)", /^﻿/, "any"],
    ["an empty file", /^$/, "any"],
    ["a file that is only a comment", /^\/\/ [^\n]*\n?$/, "any"],
    ["a name of 300 characters", /\w{300}/, "ok"],
    ["a name with `__proto__`", /__proto__/, "ok"],
  ];
  for (const [what, pattern, which] of FORMS) {
    it(`has ${what}`, () => {
      const found = results.some((r, i) => pattern.test(texts[i]!) && (which === "any" || r.ok));
      expect(found).toBe(true);
    });
  }

  it("has no input with a lone surrogate, and no refusal of a character outside the BMP in code (its message would hold half of a pair)", () => {
    const lone = SYNTAX_CASES.filter((c) => !isWellFormed(texts[SYNTAX_CASES.indexOf(c)]!)).map((c) => c.name);
    expect(lone).toEqual([]);
    // A character outside the BMP in code would be refused with half of its pair in the message.
    const inCode = results.filter((r, i) => /[\ud800-\udbff]/.test(texts[i]!) && r.diagnostics.some((d) => d.at.span && /Non-ASCII|Unexpected character/.test(d.message)));
    expect(inCode.map((r) => r.name)).toEqual([]);
  });

  it("stores no input over 20 KB in full: large inputs are built from parts", () => {
    for (const c of SYNTAX_CASES) if ("input" in c) expect(c.input.length, c.name).toBeLessThan(20_000);
    const built: SyntaxCase[] = SYNTAX_CASES.filter((c) => "input_parts" in c);
    expect(built.length).toBeGreaterThan(0);
  });
});
