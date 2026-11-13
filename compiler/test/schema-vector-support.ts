// Support for compiler/test/schema-vectors.test.ts (vectors/README.md, "schema/"): the mutation operators the
// invalid inputs are built with, an independent statement of what `schemaDiagnostics` (src/ir/validate.ts) does
// with Ajv's raw errors, and the walks over a JSON Schema that the coverage assertions use.

import type { Json } from "../src/json/strict-json.js";

// ---------------------------------------------------------------------------------------------------------
// Pointers and mutation operators

export const parsePtr = (p: string): string[] => (p === "" ? [] : p.slice(1).split("/").map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~")));

export type JsonKind = "string" | "number" | "boolean" | "null" | "array" | "object";

/** What the operators put in place of a value. Plain words and small integers: nothing credential-shaped. */
const REPLACEMENT: Record<JsonKind, Json> = { string: "made-up", number: 7, boolean: true, null: null, array: [], object: {} };

/** One change to a document. The pointer it applies at is the first argument of `edit`. */
export type Mut =
  | { m: "remove" }
  | { m: "add"; name: string; value: Json }
  | { m: "as"; to: JsonKind }
  | { m: "set"; value: Json }
  | { m: "dup"; index: number }
  | { m: "empty" }
  | { m: "rename"; from: string; to: string }
  | { m: "insert"; index: number; value: Json };

export const remove: Mut = { m: "remove" };
export const empty: Mut = { m: "empty" };
export const add = (name: string, value: Json = 1): Mut => ({ m: "add", name, value });
export const asKind = (to: JsonKind): Mut => ({ m: "as", to });
export const set = (value: Json): Mut => ({ m: "set", value });
export const dup = (index = 0): Mut => ({ m: "dup", index });
export const rename = (from: string, to: string): Mut => ({ m: "rename", from, to });
export const insert = (index: number, value: Json): Mut => ({ m: "insert", index, value });

export interface Edit {
  ptr: string;
  mut: Mut;
}

export function describe(e: Edit): string {
  const at = e.ptr === "" ? "(root)" : e.ptr;
  switch (e.mut.m) {
    case "remove":
      return `remove ${at}`;
    case "add":
      return `add unknown member ${JSON.stringify(e.mut.name)} to ${at}`;
    case "as":
      return `${at} as ${e.mut.to}`;
    case "set":
      return `${at} = ${JSON.stringify(e.mut.value)}`;
    case "dup":
      return `repeat item ${e.mut.index} of ${at}`;
    case "empty":
      return `empty ${at}`;
    case "rename":
      return `rename ${JSON.stringify(e.mut.from)} to ${JSON.stringify(e.mut.to)} in ${at}`;
    case "insert":
      return `insert at ${e.mut.index} of ${at}`;
  }
}

const clone = (v: Json): Json => JSON.parse(JSON.stringify(v)) as Json;
const isObj = (v: Json | undefined): v is { [k: string]: Json } => v !== null && typeof v === "object" && !Array.isArray(v);

function at(root: Json, tokens: string[], ptr: string): Json {
  let v: Json = root;
  for (const t of tokens) {
    if (Array.isArray(v)) {
      const next: Json | undefined = v[Number(t)];
      if (next === undefined) throw new Error(`${ptr}: no item ${t}`);
      v = next;
    } else if (isObj(v) && Object.hasOwn(v, t)) v = v[t]!;
    else throw new Error(`${ptr}: no member ${t}`);
  }
  return v;
}

/** The document with `edit` applied. Throws when the pointer does not lead to a value, so a stale case fails loudly. */
export function applyEdit(doc: Json, edit: Edit): Json {
  const root = clone(doc);
  const tokens = parsePtr(edit.ptr);
  const target = at(root, tokens, edit.ptr);
  const replacement = ((): Json | undefined => {
    const mut = edit.mut;
    switch (mut.m) {
      case "as":
        return clone(REPLACEMENT[mut.to]);
      case "set":
        return clone(mut.value);
      case "empty":
        if (Array.isArray(target)) return [];
        if (isObj(target)) return {};
        throw new Error(`${edit.ptr}: not a container`);
      case "add":
        if (!isObj(target)) throw new Error(`${edit.ptr}: not an object`);
        if (Object.hasOwn(target, mut.name)) throw new Error(`${edit.ptr}: already has ${mut.name}`);
        return { ...target, [mut.name]: clone(mut.value) };
      case "rename": {
        if (!isObj(target) || !Object.hasOwn(target, mut.from)) throw new Error(`${edit.ptr}: no member ${mut.from}`);
        return Object.fromEntries(Object.entries(target).map(([k, v]) => [k === mut.from ? mut.to : k, v]));
      }
      case "dup":
        if (!Array.isArray(target) || target[mut.index] === undefined) throw new Error(`${edit.ptr}: no item ${mut.index}`);
        return [...target, clone(target[mut.index]!)];
      case "insert":
        if (!Array.isArray(target)) throw new Error(`${edit.ptr}: not an array`);
        return [...target.slice(0, mut.index), clone(mut.value), ...target.slice(mut.index)];
      case "remove":
        return undefined;
    }
  })();
  if (tokens.length === 0) {
    if (replacement === undefined) throw new Error("cannot remove the root");
    return replacement;
  }
  const parent = at(root, tokens.slice(0, -1), edit.ptr);
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(parent)) {
    if (replacement === undefined) parent.splice(Number(last), 1);
    else parent[Number(last)] = replacement;
  } else if (isObj(parent)) {
    if (replacement === undefined) delete parent[last];
    else {
      // An object keeps its members in order, so a replaced member stays where it was.
      parent[last] = replacement;
    }
  }
  return root;
}

// ---------------------------------------------------------------------------------------------------------
// What schemaDiagnostics does with Ajv's raw errors, stated again

export interface Raw {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

/** The JSON Pointer token of a member name (RFC 6901 §4), as `ptrToken` writes it. */
const token = (s: string): string => s.replace(/~/g, "~0").replace(/\//g, "~1");

/** A string by UTF-16 code units. */
export const utf16 = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A string by code points: what a UTF-8 byte comparison gives. It differs from `utf16` above U+FFFF against U+E000-U+FFFF. */
export const codePoints = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length - y.length < 0 ? -1 : x.length > y.length ? 1 : 0;
};
/**
 * An order like a locale's, without asking one: punctuation, then digits, then letters; letters without regard to
 * case (lower case first when only the case differs). The vectors only use it to say that the order the compiler
 * writes is not that one.
 */
export const localeLike = (a: string, b: string): number => {
  const rank = (c: string): number => (/[0-9]/.test(c) ? 1 : /[A-Za-z]/.test(c) ? 2 : 0);
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!;
    const q = y[i]!;
    if (p === q) continue;
    const rp = rank(p);
    const rq = rank(q);
    if (rp !== rq) return rp < rq ? -1 : 1;
    const lp = p.toLowerCase();
    const lq = q.toLowerCase();
    if (lp !== lq) return lp < lq ? -1 : 1;
    return p === lp ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
};

export interface Kept {
  raw: Raw;
  path: string;
  message: string;
}

export interface Reading {
  /** The diagnostics, in the order they are written. */
  out: Kept[];
  /** Raw errors left out because they are `oneOf` or `if` errors. */
  noise: Raw[];
  /** Raw errors left out because a deeper error is at a path below theirs. */
  shallow: Raw[];
  /** Raw errors that have a deeper error below them and were kept because they are as deep as the deepest. */
  keptAtMax: Raw[];
  /** Raw errors left out because an earlier one has the same path and message. */
  duplicate: Raw[];
}

/** The message `schemaDiagnostics` gives a raw error, and the path it is at. */
export function messageOf(e: Raw): { path: string; message: string } {
  let path = e.instancePath;
  let message: string;
  if (e.keyword === "additionalProperties") {
    const field = String(e.params["additionalProperty"]);
    path = `${path}/${token(field)}`;
    message = `Unknown field "${field}". The IR schema is closed; unknown fields are rejected, not ignored.`;
  } else if (e.keyword === "required") {
    message = `Missing required field "${String(e.params["missingProperty"])}".`;
  } else if (e.keyword === "const" || e.keyword === "enum") {
    const allowed = e.keyword === "const" ? [e.params["allowedValue"]] : (e.params["allowedValues"] as unknown[]);
    message = `Value must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`;
  } else if (e.keyword === "pattern") {
    message = `Value does not match ${String(e.params["pattern"])} (names are ASCII identifiers).`;
  } else if (e.keyword === "discriminator") {
    message = `Unknown or missing tag: ${e.message ?? "invalid discriminator"}.`;
  } else {
    message = `Schema violation: ${e.message ?? e.keyword}.`;
  }
  return { path, message };
}

/**
 * What `schemaDiagnostics` does, step by step. `plusOne: false` leaves out the one extra level an
 * `additionalProperties` error counts for, to find the cases in which that level decides.
 */
export function read(errors: Raw[], plusOne = true): Reading {
  const noise = errors.filter((e) => e.keyword === "oneOf" || e.keyword === "if");
  const relevant = errors.filter((e) => e.keyword !== "oneOf" && e.keyword !== "if");
  const depth = (e: Raw): number => e.instancePath.split("/").length + (plusOne && e.keyword === "additionalProperties" ? 1 : 0);
  const paths = new Set(relevant.map((e) => e.instancePath));
  const sorted = [...relevant].sort((a, b) => depth(b) - depth(a));
  const maxDepth = sorted.length ? depth(sorted[0]!) : 0;
  const reading: Reading = { out: [], noise, shallow: [], keptAtMax: [], duplicate: [] };
  const seen = new Set<string>();
  for (const e of sorted) {
    const hasDeeper = [...paths].some((p) => p !== e.instancePath && p.startsWith(e.instancePath + "/"));
    if (hasDeeper && depth(e) < maxDepth) {
      reading.shallow.push(e);
      continue;
    }
    if (hasDeeper) reading.keptAtMax.push(e);
    const { path, message } = messageOf(e);
    const key = `${path}|${message}`;
    if (seen.has(key)) {
      reading.duplicate.push(e);
      continue;
    }
    seen.add(key);
    reading.out.push({ raw: e, path, message });
  }
  reading.out.sort((a, b) => utf16(a.path, b.path));
  return reading;
}

/** The behaviours of `schemaDiagnostics` a case shows; the test says which cases are the ones that name each. */
export const BEHAVIOURS = [
  "drops_shallower",
  "keeps_at_max_depth",
  "additional_depth",
  "removes_duplicates",
  "same_path_order",
  "sort_not_code_point",
  "sort_not_locale",
] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

export function behavioursOf(errors: Raw[]): Behaviour[] {
  const r = read(errors);
  const shows: Behaviour[] = [];
  if (r.shallow.length > 0) shows.push("drops_shallower");
  if (r.keptAtMax.length > 0) shows.push("keeps_at_max_depth");
  const without = read(errors, false);
  const id = (k: Kept[]): string => k.map((x) => `${x.raw.instancePath}|${x.raw.schemaPath}|${x.message}`).sort().join("\n");
  if (id(r.out) !== id(without.out)) shows.push("additional_depth");
  if (r.duplicate.length > 0) shows.push("removes_duplicates");
  const paths = r.out.map((k) => k.path);
  if (new Set(paths).size < paths.length) shows.push("same_path_order");
  // The compiler's order against the same errors sorted another way (both sorts are stable, like the compiler's).
  const pre = r.out.map((k) => k.path);
  const order = (cmp: (a: string, b: string) => number): string => [...r.out].sort((a, b) => cmp(a.path, b.path)).map((k) => k.raw.schemaPath + k.path).join("\n");
  const written = r.out.map((k) => k.raw.schemaPath + k.path).join("\n");
  if (pre.length > 1 && order(codePoints) !== written) shows.push("sort_not_code_point");
  if (pre.length > 1 && order(localeLike) !== written) shows.push("sort_not_locale");
  return shows;
}

// ---------------------------------------------------------------------------------------------------------
// Walks over a JSON Schema

type Schema = { [k: string]: unknown };
const isSchema = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);

/** Keywords whose value is a map of schemas, a schema, or a list of schemas (JSON Schema 2020-12). */
const MAP_OF_SCHEMAS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const ONE_SCHEMA = ["additionalProperties", "propertyNames", "items", "contains", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"];
const LIST_OF_SCHEMAS = ["oneOf", "anyOf", "allOf", "prefixItems"];

/** Every keyword that stands as a keyword (not as a property name or inside an `enum` or `const`) in the schema, with how often. */
export function schemaKeywords(schema: object): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (s: unknown): void => {
    if (!isSchema(s)) return;
    for (const [k, v] of Object.entries(s)) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (MAP_OF_SCHEMAS.includes(k) && isSchema(v)) Object.values(v).forEach(walk);
      else if (ONE_SCHEMA.includes(k)) walk(v);
      else if (LIST_OF_SCHEMAS.includes(k) && Array.isArray(v)) v.forEach(walk);
    }
  };
  walk(schema);
  return counts;
}

/** The `$ref` target name of `#/$defs/Name`. */
const refName = (ref: string): string => ref.slice(ref.lastIndexOf("/") + 1);

/** A schema that contains no `$ref` is inlined by Ajv (its default `inlineRefs`), which writes `#/$defs/Name/…` in schemaPath. */
export function inlinedDefs(schema: { $defs?: Record<string, unknown> }): string[] {
  return Object.entries(schema.$defs ?? {}).filter(([, d]) => !JSON.stringify(d).includes('"$ref"')).map(([n]) => n);
}

/**
 * The entry of `$defs` an error was raised in, or "#" for the root schema. Ajv writes `#/$defs/Name/…` for a
 * definition it inlines; for any other, schemaPath starts again at that definition's own root, so the name is
 * found by following the instance path through the schema, and the schemaPath must lead to the error's keyword.
 */
export function defOf(schema: { $defs?: Record<string, unknown> }, e: Raw): string | undefined {
  const inline = /^#\/\$defs\/([^/]+)\//.exec(e.schemaPath);
  if (inline) return inline[1];
  const defs = schema.$defs ?? {};
  interface State {
    node: Schema;
    def: string;
  }
  const resolve = (s: State): State => {
    let { node, def } = s;
    while (typeof node["$ref"] === "string") {
      def = refName(node["$ref"]);
      node = defs[def] as Schema;
    }
    return { node, def };
  };
  const expand = (s: State): State[] => {
    const r = resolve(s);
    const branches = Array.isArray(r.node["oneOf"]) ? (r.node["oneOf"] as Schema[]).flatMap((b) => expand({ node: b, def: r.def })) : [];
    return [r, ...branches];
  };
  let states: State[] = [{ node: schema as Schema, def: "#" }];
  for (const t of parsePtr(e.instancePath)) {
    const next: State[] = [];
    for (const s of states.flatMap(expand)) {
      const props = s.node["properties"];
      const additional = s.node["additionalProperties"];
      const items = s.node["items"];
      if (isSchema(props) && isSchema(props[t])) next.push({ node: props[t] as Schema, def: s.def });
      else if (isSchema(additional)) next.push({ node: additional, def: s.def });
      else if (isSchema(items) && /^[0-9]+$/.test(t)) next.push({ node: items, def: s.def });
    }
    states = next;
  }
  for (const s of states.map(resolve)) {
    const root = (s.def === "#" ? schema : defs[s.def]) as Schema;
    const segments = e.schemaPath.slice(2).split("/").filter((x) => x !== "");
    let n: unknown = root;
    for (const seg of segments) n = isSchema(n) || Array.isArray(n) ? (n as Record<string, unknown>)[seg] : undefined;
    if (n !== undefined && segments[segments.length - 1] === e.keyword) return s.def;
  }
  return undefined;
}

/** Counts of each distinct value, for the tables. */
export function tally<T>(items: Iterable<T>, key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return new Map([...m].sort(([a], [b]) => utf16(a, b)));
}
