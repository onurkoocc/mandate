// What the TypeScript compiler gives for reading Mandate text (`.mdt`): the
// vectors in vectors/syntax.json and vectors/spans/ (vectors/README.md). The
// inputs are in syntax-cases/; this file runs them through `load`, writes
// the result down, and works out what the inputs cover, so that
// syntax-vectors.test.ts can assert it.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { kindOf, load } from "../src/check.js";
import { hasErrors, type Diagnostic, type Span } from "../src/diag.js";
import { canonicalize, compareUtf16 } from "../src/json/jcs.js";
import { isWellFormed, type Json } from "../src/json/strict-json.js";
import { LIMITS } from "../src/limits.js";
import { printProgram } from "../src/print/printer.js";
import { RESERVED } from "../src/parse/parser.js";
import { readRepo, repoRoot } from "./helpers.js";
import { SYNTAX_CASES, type SyntaxCase } from "./syntax-cases/index.js";

export const SYNTAX_FILE = "vectors/syntax.json";
export const SPANS_DIR = "vectors/spans/";

/** The text an input stands for. */
export function textOf(c: SyntaxCase): string {
  return "input" in c ? c.input : c.input_parts.map(([s, n]) => s.repeat(n)).join("");
}

/** `[pointer, startLine, startCol, endLine, endCol]`, by pointer in UTF-16 code-unit order. */
export type SpanRow = [string, number, number, number, number];

export function spanRows(spans: Map<string, Span>): SpanRow[] {
  return [...spans]
    .sort((a, b) => compareUtf16(a[0], b[0]))
    .map(([p, s]) => [p, s[0], s[1], s[2], s[3]]);
}

/** Nesting depth of a JSON value, the way the strict reader counts it (a scalar at the top is 1). */
function depthOf(v: unknown): number {
  if (v === null || typeof v !== "object") return 1;
  const kids = Array.isArray(v) ? v : Object.values(v);
  return 1 + kids.reduce((m: number, k) => Math.max(m, depthOf(k)), 0);
}

/**
 * The deepest an IR may be and still sit in a vector file as the `ir` of one
 * case: the file's own object, the `vectors` array and the case's object
 * come first, and the strict reader refuses nesting past `LIMITS.jsonDepth`.
 */
/** A canonical text longer than this many characters is given by its SHA-256. */
export const LONG_CANONICAL = 1500;

/** A span table whose rows, one per line, come to more than this many characters is given by its digest. */
export const LONG_SPANS = 1500;

export const IR_DEPTH_IN_FILE = LIMITS.jsonDepth - 3;

export interface CaseResult {
  name: string;
  ok: boolean;
  diagnostics: Diagnostic[];
  [key: string]: unknown;
}

export function runCase(c: SyntaxCase): CaseResult {
  const { name } = c;
  const input = "input" in c ? { input: c.input } : { input_parts: c.input_parts };
  const text = textOf(c);
  if (!isWellFormed(text)) throw new Error(`syntax vector "${name}": the input holds a lone surrogate`);
  const r = load(text, "mdt");
  const ok = r.program !== undefined && !hasErrors(r.diagnostics);
  for (const d of r.diagnostics) {
    // A message that quotes half of a surrogate pair cannot be carried as text; see vectors/README.md.
    if (!isWellFormed(JSON.stringify(d))) throw new Error(`syntax vector "${name}": a diagnostic holds a lone surrogate`);
  }
  const out: CaseResult = { name, ...input, ok, diagnostics: r.diagnostics };
  if (r.program === undefined) return out;

  const ir = r.program as unknown as Json;
  const canonical = canonicalize(ir);
  // A long canonical text is given by its digest, and an IR too deep to sit in the file, or whose canonical text is long, is left out.
  const depth = depthOf(ir);
  if (canonical.length > LONG_CANONICAL) out["canonical_sha256"] = sha256Hex(canonical);
  else out["canonical"] = canonical;
  if (depth <= IR_DEPTH_IN_FILE && canonical.length <= LONG_CANONICAL) out["ir"] = ir;
  else out["ir_depth"] = depth;
  const rows = spanRows(r.spans);
  const rowText = rows.map((row) => JSON.stringify(row)).join("\n");
  // A table too long to read in a vector is given by its digest and its length (vectors/README.md).
  if (rowText.length <= LONG_SPANS) out["spans"] = rows;
  else {
    out["spans_count"] = rows.length;
    out["spans_sha256"] = sha256Hex(rowText);
  }
  if (!ok) return out;

  let printed: string;
  try {
    printed = printProgram(r.program);
  } catch (e) {
    out["fmt_error"] = (e as Error).message;
    return out;
  }
  out["fmt"] = printed;
  const again = load(printed, "mdt");
  const reads = again.program !== undefined && !hasErrors(again.diagnostics);
  const sameIr = reads && canonicalize(again.program as unknown as Json) === canonical;
  const stable = reads && printProgram(again.program!) === printed;
  if (reads && sameIr && stable) out["fmt_roundtrip"] = true;
  else out["fmt_roundtrip"] = { reads, same_ir: sameIr, stable, ...(reads ? {} : { diagnostics: again.diagnostics }) };
  return out;
}

/** Whether `load` gave a program (it did when the case has its canonical text, in full or by digest). */
export const isLoaded = (r: CaseResult): boolean => "canonical" in r || "canonical_sha256" in r;

export function syntaxResults(): CaseResult[] {
  return SYNTAX_CASES.map(runCase);
}

// ── files ───────────────────────────────────────────────────────────────────

/**
 * JSON as the vector files hold it: two-space indents; a value whose text on
 * one line is at most 100 characters stays on one line, and so does an array
 * of at most five numbers and strings (a span, a pointer and its span, a
 * piece of text and its count); an \`ir\` is always one line; and every
 * character from U+007F up is escaped, so a file is ASCII.
 */
export function vectorJson(value: unknown): string {
  const scalar = (v: unknown): boolean => v === null || typeof v !== "object";
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return "[" + v.map(inline).join(", ") + "]";
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      return "{" + entries.map(([k, x]) => JSON.stringify(k) + ": " + inline(x)).join(", ") + "}";
    }
    return JSON.stringify(v);
  };
  const go = (v: unknown, ind: string, key: string): string => {
    if (key === "ir") return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if ((v.length <= 5 && v.every(scalar)) || inline(v).length <= 100) return inline(v);
      return "[\n" + v.map((x) => ind + "  " + go(x, ind + "  ", "")).join(",\n") + "\n" + ind + "]";
    }
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (entries.length === 0) return "{}";
      if (inline(v).length <= 100) return inline(v);
      return "{\n" + entries.map(([k, x]) => ind + "  " + JSON.stringify(k) + ": " + go(x, ind + "  ", k)).join(",\n") + "\n" + ind + "}";
    }
    return JSON.stringify(v);
  };
  return go(value, "", "").replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\n";
}

/** The programs the golden file pins, by repository path. */
export function goldenPrograms(): string[] {
  return Object.keys(JSON.parse(readRepo("compiler/test/golden/outputs.json")) as Record<string, unknown>).sort();
}

/** `fixtures/fixbug/fixbug.mdt` → `vectors/spans/fixtures.fixbug.fixbug.mdt.json`. */
export const spansFile = (source: string): string => `${SPANS_DIR}${source.replaceAll("/", ".")}.json`;

export function spansVector(source: string): unknown {
  const kind = kindOf(source);
  const r = load(readRepo(source), kind);
  if (!r.program) throw new Error(`${source} does not load`);
  return { format: "mandate/vectors/spans/0.1", source, kind, count: r.spans.size, spans: spanRows(r.spans) };
}

export function syntaxFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set(SYNTAX_FILE, vectorJson({ format: "mandate/vectors/syntax/0.1", vectors: syntaxResults() }));
  for (const source of goldenPrograms()) files.set(spansFile(source), vectorJson(spansVector(source)));
  return files;
}

// ── coverage ────────────────────────────────────────────────────────────────

/** One thing the inputs must reach: a message the lexer or the parser can give. */
export interface Site {
  /** A group, and what in it. */
  kind: string;
  id: string;
  code: string;
  /** Matches the message of a diagnostic that comes from this site. */
  message: RegExp;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A message template (`Unknown x '${y}'.`) as a pattern: each hole stands for any text. */
function templateRe(template: string): RegExp {
  return new RegExp("^" + template.split(/\$\{(?:[^{}]|\{[^{}]*\})*\}/).map(escapeRe).join("[\\s\\S]*") + "$");
}

/** The string a source literal (`"…"` or a template without holes) stands for. */
const unquote = (lit: string): string => lit.slice(1, -1).replace(/\\(.)/g, "$1");

const sourceOf = (file: string): string => readFileSync(`${repoRoot}compiler/src/parse/${file}`, "utf8");

/** Messages the generic helpers (`expectP`, `ident`, …) give: they are covered through their arguments, not as templates. */
const HELPER_TEMPLATES = ["Expected '${text}' but found", "Expected '${word}' but found", "Expected ${what} but found", "'${t.text}' is a reserved keyword", "Interpolation is not allowed in ${what}"];

/**
 * Every message the lexer and the parser can give, read from their source:
 * the message of each `fail(` call, each distinct name `ident(` and
 * `string(` is called with, each token `expectP(` and word `expectW(` asks
 * for, each kind `dup(` is called with; plus the `diag(` calls, which are
 * listed by hand below, and a check that nothing is missed.
 */
export function sites(): Site[] {
  const out: Site[] = [];
  const add = (kind: string, id: string, code: string, message: RegExp): void => {
    out.push({ kind, id, code, message });
  };
  const lexer = sourceOf("lexer.ts");
  const parser = sourceOf("parser.ts");

  for (const [file, text, kind] of [["lexer", lexer, "lexer"], ["parser", parser, "parser"]] as const) {
    void file;
    const seen = new Set<string>();
    for (const m of text.matchAll(/\b(?:this|sub)\.fail\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g)) {
      const lit = m[1]!;
      const template = unquote(lit);
      if (HELPER_TEMPLATES.some((h) => template.startsWith(h))) continue;
      if (seen.has(template)) continue;
      seen.add(template);
      add(kind, template, "MDT-E0101", templateRe(template));
    }
  }
  // `bad(…)` in `budget`: one message, several wants.
  for (const m of parser.matchAll(/\bbad\(("(?:[^"\\]|\\.)*")\)/g)) {
    add("parser", `Budget field takes ${unquote(m[1]!)}`, "MDT-E0101", new RegExp(`^Budget field '[\\s\\S]*' takes ${escapeRe(unquote(m[1]!))}\\.$`));
  }

  // Messages with a hole that stands for one of a few words: each word is a variant to reach.
  for (const w of ["max", "par"]) add("parser", `'${w}' takes a whole number, at least 1 (map)`, "MDT-E0101", new RegExp(`^'${w}' takes a whole number, at least 1\\.$`));
  for (const f of ["repo", "root", "lang", "owner"]) add("parser", `Component needs '${f}'`, "MDT-E0101", new RegExp(`^Component '.*' needs '${f}'\\.$`));

  const distinct = (re: RegExp, text: string): string[] => [...new Set([...text.matchAll(re)].map((m) => m[1]!.replace(/\\(.)/g, "$1")))];
  for (const what of [...distinct(/this\.ident\("((?:[^"\\]|\\.)*)"\)/g, parser), "a name"]) {
    add("ident", what, "MDT-E0101", new RegExp(`^Expected ${escapeRe(what)} but found `));
  }
  for (const what of distinct(/this\.string\("((?:[^"\\]|\\.)*)"\)/g, parser)) {
    add("string", what, "MDT-E0101", new RegExp(`^Expected ${escapeRe(what)} but found `));
    add("string interpolation", what, "MDT-E0101", new RegExp(`^Interpolation is not allowed in ${escapeRe(what)}\\.$`));
  }
  for (const tok of distinct(/expectP\("((?:[^"\\]|\\.)*)"\)/g, parser)) {
    add("expected punctuation", tok, "MDT-E0101", new RegExp(`^Expected '${escapeRe(tok)}' but found `));
  }
  for (const word of distinct(/expectW\("((?:[^"\\]|\\.)*)"\)/g, parser)) {
    add("expected word", word, "MDT-E0101", new RegExp(`^Expected '${escapeRe(word)}' but found `));
  }
  for (const kind of distinct(/this\.dup\("((?:[^"\\]|\\.)*)"/g, parser)) {
    add("duplicate", kind, "MDT-E0121", new RegExp(`^Duplicate ${escapeRe(kind)} '`));
  }
  // The word `describe` gives for the token found: three forms.
  add("found", "end of input", "MDT-E0101", /but found end of input\.$/);
  add("found", "a string", "MDT-E0101", /but found a string\.$/);
  add("found", "the token's text", "MDT-E0101", /but found '/);
  // A name that is a reserved keyword, from any position that takes a name.
  add("ident", "reserved keyword", "MDT-E0101", /^'[^']*' is a reserved keyword and cannot be used as /);
  // The `diag(` calls other than the ones in `fail` helpers and `dup`.
  add("diag", "unsupported language version", "MDT-E0103", /^Unsupported language version /);
  add("diag", "handler targets no workflow", "MDT-E0120", /^Handler targets '/);
  add("diag", "source size limit", "MDT-E0105", /^Input exceeds the \d+-byte source limit\.$/);
  add("diag", "nesting limit while reading", "MDT-E0105", /^Nesting exceeds the depth limit of \d+\.$/);
  add("diag", "nesting limit of the IR", "MDT-E0105", /^JSON nesting exceeds the depth limit of \d+\.$/);
  return out;
}

/** The `fail(`, `diag(`, `dup(`, `bad(` and generic-helper call sites in the source, to hold `sites()` to account. */
export function callSiteCount(): { fail: number; diag: number; dup: number; bad: number } {
  const count = (re: RegExp, text: string): number => [...text.matchAll(re)].length;
  const all = sourceOf("lexer.ts") + "\n" + sourceOf("parser.ts");
  return {
    fail: count(/\b(?:this|sub)\.fail\(/g, all),
    diag: count(/\bdiag\(/g, all),
    dup: count(/\bthis\.dup\(/g, all),
    bad: count(/\bbad\(/g, all),
  };
}

/** Messages that no input can reach, by `Site.kind` and `Site.id`, with the reason. */
export const UNREACHABLE: Record<string, string> = {
  "ident: a role name": "decl() reads a role only when a name and a string follow the word, so a non-name there is a syntax error elsewhere; a reserved word there is reached",
  "ident: an environment name": "decl() reads an environment only when a name and a brace follow the word, so a non-name there is a syntax error elsewhere; a reserved word there is reached",
  "ident: a name for one element": "a map is entered only when a name follows the word map and the word in follows that name, so a non-name there makes map a plain name; a reserved word there is reached",
  "string: a test name": "program() reads a test only when a string follows the word test; an interpolation in it is reached",
  "expected word: budget": "budget() is called only where the word budget has been seen",
};

export function coverage(results: CaseResult[]): Array<{ site: Site; cases: string[] }> {
  const all = sites();
  return all.map((site) => ({
    site,
    cases: results.filter((r) => r.diagnostics.some((d) => d.code === site.code && site.message.test(d.message))).map((r) => r.name),
  }));
}

// ── forms of the IR ─────────────────────────────────────────────────────────

type SchemaNode = { properties?: Record<string, { enum?: unknown[]; const?: unknown }>; oneOf?: SchemaNode[] };

/**
 * Every construct of the IR and each of its optional parts, as `label.part`
 * (and `label.part=value` for a part that takes one of a fixed set of words),
 * read from the IR schema: what the grammar can produce, which the inputs
 * must between them produce.
 */
export function requiredForms(): string[] {
  const schema = JSON.parse(readRepo("spec/ir.schema.json")) as { properties: Record<string, unknown>; $defs: Record<string, SchemaNode> };
  const out = new Set<string>();
  const add = (label: string, node: SchemaNode | undefined): void => {
    for (const [k, v] of Object.entries(node?.properties ?? {})) {
      out.add(`${label}.${k}`);
      if (k === "kind" || k === "op" || k === "p") continue;
      for (const e of v.enum ?? []) out.add(`${label}.${k}=${String(e)}`);
    }
  };
  const tagged = (prefix: string, key: string, node: SchemaNode): void => {
    for (const b of node.oneOf ?? []) {
      const tag = (b.properties?.[key] as { const?: string } | undefined)?.const;
      if (tag === undefined) continue;
      out.add(`${prefix}:${tag}`);
      add(`${prefix}:${tag}`, b);
    }
  };
  for (const k of Object.keys(schema.properties)) out.add(`program.${k}`);
  tagged("def", "kind", schema.$defs["Def"]!);
  tagged("expr", "op", schema.$defs["Expr"]!);
  tagged("stmt", "op", schema.$defs["Stmt"]!);
  tagged("pattern", "p", schema.$defs["Pattern"]!);
  for (const [label, name] of [["budget", "Budget"], ["envelope", "Envelope"], ["param", "Param"], ["arg", "Arg"], ["callspec", "CallSpec"], ["effectref", "EffectRef"], ["variant", "Variant"], ["criterion", "Criterion"], ["skill", "Skill"], ["test", "Test"], ["command", "Command"], ["read", "ReadSource"], ["money", "Money"]] as const) {
    add(label, schema.$defs[name]);
  }
  for (const v of ["ref", "args", "record", "enum", "union", "refine", "where"]) out.add(`type.${v}`);
  for (const v of ["static", "call", "all"]) out.add(`verifier.${v}`);
  for (const v of ["text", "expr"]) out.add(`templatepart.${v}`);
  for (const v of ["policy", "human"]) out.add(`tier.by=${v}`);
  out.add("tier.role");
  for (const v of ["additive", "breaking", "none"]) out.add(`changes=${v}`);
  for (const v of ["trusted", "untrusted"]) out.add(`remote.trust=${v}`);
  for (const v of ["bind", "version", "require"]) out.add(`remote.${v}`);
  for (const v of ["window", "repeats", "stall"]) out.add(`progress.${v}`);
  for (const v of ["max_concurrent", "max_class"]) out.add(`spawn.${v}`);
  for (const v of ["module", "names"]) out.add(`use.${v}`);
  for (const v of ["sql", "logs"]) out.add(`read.query.${v}`);
  out.add("expr:template.interpolation");
  // `kind`, `op` and `p` name the construct itself.
  return [...out].filter((f) => !/\.(kind|op|p)$/.test(f)).sort();
}

const STMT_OPS = new Set(["let", "par", "if", "loop", "return", "on_error", "run", "expr"]);
const DEF_KINDS = new Set(["type", "capability", "const", "fn", "extern", "effect", "agent", "workflow", "contract", "component", "interface", "environment", "role"]);

/** The forms the IR of every case that loaded (and kept its `ir`) holds. */
export function observedForms(results: CaseResult[]): Set<string> {
  const seen = new Set<string>();
  const tag = (label: string, node: Record<string, unknown>): void => {
    seen.add(label);
    for (const [k, v] of Object.entries(node)) {
      seen.add(`${label}.${k}`);
      if (typeof v === "string") seen.add(`${label}.${k}=${v}`);
    }
  };
  const walk = (node: unknown, parentKey: string, grand: string): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x, parentKey, grand);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const has = (k: string): boolean => Object.hasOwn(o, k);
    let label: string | undefined;
    if (typeof o["op"] === "string") label = `${STMT_OPS.has(o["op"]) ? "stmt" : "expr"}:${o["op"]}`;
    else if (typeof o["kind"] === "string" && DEF_KINDS.has(o["kind"])) label = `def:${o["kind"]}`;
    else if (typeof o["p"] === "string") label = `pattern:${o["p"]}`;
    else if (parentKey === "budget") label = "budget";
    else if (parentKey === "envelope") label = "envelope";
    else if (parentKey === "remote" || parentKey === "progress" || parentKey === "spawn") label = parentKey;
    else if (parentKey === "skills") label = "skill";
    else if (parentKey === "tests") label = "test";
    else if (parentKey === "uses") label = "use";
    else if (parentKey === "changes") {
      for (const v of Object.values(o)) seen.add(`changes=${String(v)}`);
    } else if (has("ref") || has("record") || has("enum") || has("union") || has("refine")) {
      for (const k of Object.keys(o)) seen.add(`type.${k}`);
    } else if (has("static") || has("call") || has("all")) {
      for (const k of Object.keys(o)) seen.add(`verifier.${k}`);
    } else if (has("text") || (has("expr") && Object.keys(o).length === 1)) {
      for (const k of Object.keys(o)) seen.add(`templatepart.${k}`);
    } else if (has("tag")) label = "variant";
    else if (has("description") && has("by")) label = "criterion";
    else if (has("command")) label = "command";
    else if (has("from") && has("query")) {
      label = "read";
      for (const k of Object.keys(o["query"] as object)) seen.add(`read.query.${k}`);
    } else if (has("effect")) label = "effectref";
    else if (has("micros")) label = "money";
    else if (has("name") && has("type")) label = "param";
    else if (has("name") && has("value")) label = "arg";
    else if (has("name") && grand === "supervise") label = "callspec";
    else if (parentKey === "supervise") label = "callspec";
    else if (has("by")) {
      label = "tier";
      seen.add(`tier.by=${String(o["by"])}`);
    } else if (has("module") && has("version") && has("defs")) label = "program";
    if (label) tag(label, o);
    if (label === "expr:template" || label === "expr:prompt") {
      const parts = o["parts"] as Array<Record<string, unknown>>;
      if (parts.some((p) => "expr" in p)) seen.add("expr:template.interpolation");
    }
    for (const [k, v] of Object.entries(o)) {
      // A map of skills, tests or changes: its values are labelled by the map.
      if ((k === "skills" || k === "tests") && v !== null && typeof v === "object") {
        for (const x of Object.values(v as object)) walk(x, k, parentKey);
      } else if (k === "changes" && v !== null && typeof v === "object") {
        for (const x of Object.values(v as object)) seen.add(`changes=${String(x)}`);
      } else walk(v, k, parentKey);
    }
  };
  for (const r of results) {
    if (r.ir !== undefined) walk(r.ir, "", "");
  }
  // A `program.uses` item has `module`; a test has `body`.
  return seen;
}

/** Facts about a template's parts: where interpolations stand. */
export function templateShapes(results: CaseResult[]): Set<string> {
  const shapes = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const o = node as { op?: string; parts?: Array<{ text?: string; expr?: { op: string } }> };
    if ((o.op === "template" || o.op === "prompt") && o.parts) {
      const p = o.parts;
      const isExpr = (i: number): boolean => p[i] !== undefined && "expr" in p[i]!;
      if (p.length === 1 && isExpr(0)) shapes.add("alone");
      if (p.length > 1 && isExpr(0)) shapes.add("start");
      if (p.length > 1 && isExpr(p.length - 1)) shapes.add("end");
      for (let i = 1; i < p.length - 1; i++) if (isExpr(i)) shapes.add("middle");
      for (let i = 1; i < p.length; i++) if (isExpr(i) && isExpr(i - 1)) shapes.add("adjacent");
      if (p.some((x) => x.expr !== undefined && x.expr.op !== "var")) shapes.add("an expression, not a name");
      if (o.op === "prompt" && p.some((x) => "expr" in x)) shapes.add("in a prompt");
    }
    Object.values(o).forEach(walk);
  };
  for (const r of results) if (r.ir !== undefined) walk(r.ir);
  return shapes;
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export { RESERVED };
