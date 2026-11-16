// JSON Schemas for model output (Doc 4 §8.2 step 5). A model is asked for a
// value of a Mandate type: an `infer` result, or a skill's result through the
// agent loop's `finish` tool. The type becomes a JSON Schema, sent with the
// request and checked again on the answer: a model's word that its output
// fits is not taken (INV-04).
//
// Values use the runtime's JSON shapes (values.ts): a variant is
// `{ "$tag": …, "$args": [ … ] }`, money `{ "$money": …, "$currency": … }`.
// How a value is known (Inferred, Untrusted, Verified) is not part of its
// shape. A type the program imports but does not define (e.g. `Issue` from
// `company.domain`) accepts any JSON value.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { PATH_PATTERN, type Def, type Expr, type Program, type TypeExpr } from "@mandate/bridge";
import { canonical, type Value } from "./values.js";

export type JsonSchema = Record<string, unknown>;

const PATH_RULE = "a path relative to the repository root: segments separated by /, no . or .. segment, no leading /, no \\, : or NUL";

const BASE: Record<string, JsonSchema> = {
  Bool: { type: "boolean" },
  Int: { type: "integer" },
  Dec: { type: "string", pattern: "^-?[0-9]+(\\.[0-9]+)?$" },
  Text: { type: "string" },
  Bytes: { type: "string", contentEncoding: "base64" },
  // Relative, normalized, portable (K68, G14): spec/core.md#paths.
  Path: { type: "string", pattern: PATH_PATTERN, description: PATH_RULE },
  Url: { type: "string" },
  Time: { type: "integer", description: "milliseconds since the Unix epoch" },
  Duration: { type: "integer", minimum: 0, description: "milliseconds" },
  Money: {
    type: "object",
    properties: { $money: { type: "integer" }, $currency: { type: "string", pattern: "^[A-Z]{3}$" } },
    required: ["$money", "$currency"],
    additionalProperties: false,
  },
  EvidenceRef: { type: "string" },
};

const WRAPPERS = new Set(["Inferred", "Untrusted", "Verified", "Decision"]);

/** The JSON Schema of `type` in `program`. Named types become `$defs`, so recursive types are fine. */
export function typeSchema(program: Program, type: TypeExpr): JsonSchema {
  const defs: Record<string, JsonSchema> = {};
  const root = convert(program, type, defs, new Set());
  return Object.keys(defs).length ? { ...root, $defs: defs } : root;
}

/**
 * The schema of `type` that a value from outside the run is held to (a connector's result, spec/library.md
 * "Connectors"), for `heldTo`. It differs from `typeSchema`, which a model is sent, in three ways. A refinement is
 * stated in full, or the schema is refused: undefined when the type has a refinement no keyword here states. A `Set`
 * is checked in one pass over its items, where `uniqueItems` compares every two of them. A `Map`, the one place a
 * type leaves a member's name open, takes no key that begins with `$`: those are the runtime's own (a variant's
 * `$tag`, money's `$money`), read only where a type declares them.
 */
export function heldSchema(program: Program, type: TypeExpr): JsonSchema | undefined {
  const defs: Record<string, JsonSchema> = {};
  const held: Held = { unenforced: false };
  const root = convert(program, type, defs, new Set(), held);
  if (held.unenforced) return undefined;
  return Object.keys(defs).length ? { ...root, $defs: defs } : root;
}

/** Set while a schema is made for `heldSchema`; `unenforced` once a refinement could not be stated. */
interface Held {
  unenforced: boolean;
}

/** `heldSchema`'s keywords: a set's items are distinct; the length of a list or a text, in UTF-16 units as `len` counts, is within `[lo, hi]`. */
const DISTINCT = "mandateDistinct";
const LEN = "mandateLen";

function convert(program: Program, t: TypeExpr, defs: Record<string, JsonSchema>, seen: Set<string>, held?: Held): JsonSchema {
  if ("record" in t) {
    const names = Object.keys(t.record).sort();
    return {
      type: "object",
      properties: Object.fromEntries(names.map((n) => [n, convert(program, t.record[n]!, defs, seen, held)])),
      required: names,
      additionalProperties: false,
    };
  }
  if ("enum" in t) return { type: "string", enum: [...t.enum] };
  if ("union" in t) {
    return {
      anyOf: t.union.map((v) => ({
        type: "object",
        properties: {
          $tag: { const: v.tag },
          ...(v.fields?.length ? { $args: { type: "array", prefixItems: v.fields.map((f) => convert(program, f.type, defs, seen, held)), minItems: v.fields.length, maxItems: v.fields.length } } : {}),
        },
        required: v.fields?.length ? ["$tag", "$args"] : ["$tag"],
        additionalProperties: false,
      })),
    };
  }
  if ("refine" in t) {
    const base = convert(program, t.refine, defs, seen, held);
    if (!held) return { ...base, ...refinement(t.where) };
    // Held: the refinement in full, on the kind of value the refined type is, or the schema is refused.
    const of = typeof base["$ref"] === "string" ? defs[base["$ref"].slice("#/$defs/".length)] : base;
    const stated = heldRefinement(t.where, of?.["type"]);
    if (!stated) held.unenforced = true;
    return { allOf: [base, stated ?? {}] };
  }
  const args = t.args ?? [];
  if (WRAPPERS.has(t.ref) && args[0]) return convert(program, args[0], defs, seen, held);
  if (BASE[t.ref]) return BASE[t.ref]!;
  switch (t.ref) {
    case "List":
      return { type: "array", items: args[0] ? convert(program, args[0], defs, seen, held) : {} };
    case "Set":
      return { type: "array", items: args[0] ? convert(program, args[0], defs, seen, held) : {}, ...(held ? { [DISTINCT]: true } : { uniqueItems: true }) };
    case "Map":
      return { type: "object", additionalProperties: args[1] ? convert(program, args[1], defs, seen, held) : {}, ...(held ? { propertyNames: { pattern: "^(?!\\$)" } } : {}) };
    case "Option":
      return { anyOf: [args[0] ? convert(program, args[0], defs, seen, held) : {}, { type: "null" }] };
  }
  const def: Def | undefined = program.defs[t.ref];
  if (def?.kind === "type") {
    if (!seen.has(t.ref)) {
      seen.add(t.ref);
      defs[t.ref] = convert(program, def.type, defs, seen, held);
    }
    return { $ref: `#/$defs/${t.ref}` };
  }
  return {};
}

/**
 * Whether `type` is closed in `program`: every name it reaches is a built-in type or a type the program defines, so
 * that its schema admits nothing it does not say. A name the program does not define becomes the schema `{}`, which
 * accepts any value; what comes from outside the run (a connector's result, spec/library.md "Connectors") is never
 * checked against such a schema.
 */
export function isClosed(program: Program, type: TypeExpr, seen: Set<string> = new Set()): boolean {
  if ("record" in type) return Object.values(type.record).every((f) => isClosed(program, f, seen));
  if ("enum" in type) return true;
  if ("union" in type) return type.union.every((v) => (v.fields ?? []).every((f) => isClosed(program, f.type, seen)));
  if ("refine" in type) return isClosed(program, type.refine, seen);
  const args = type.args ?? [];
  if (WRAPPERS.has(type.ref)) return args.length > 0 && isClosed(program, args[0]!, seen);
  if (BASE[type.ref]) return true;
  if (type.ref === "List" || type.ref === "Set" || type.ref === "Option") return args.length === 1 && isClosed(program, args[0]!, seen);
  if (type.ref === "Map") return args.length === 2 && isClosed(program, args[1]!, seen);
  const def: Def | undefined = Object.hasOwn(program.defs, type.ref) ? program.defs[type.ref] : undefined;
  if (def?.kind !== "type") return false;
  if (seen.has(type.ref)) return true;
  seen.add(type.ref);
  return isClosed(program, def.type, seen);
}

/** Whether `type` is a record in `program`, through the names and refinements it is written with. */
export function isRecord(program: Program, type: TypeExpr, seen: Set<string> = new Set()): boolean {
  if ("record" in type) return true;
  if ("refine" in type) return isRecord(program, type.refine, seen);
  if (!("ref" in type) || seen.has(type.ref)) return false;
  const def: Def | undefined = Object.hasOwn(program.defs, type.ref) ? program.defs[type.ref] : undefined;
  if (def?.kind !== "type") return false;
  seen.add(type.ref);
  return isRecord(program, def.type, seen);
}

/** The bounds JSON Schema can state:`x >= n`, `x <= n`, `x > n`, `x < n`, `len(x) in a..b`. Others are not checked here. */
function refinement(e: Expr): JsonSchema {
  if (e.op !== "binary") return {};
  const int = (x: Expr): number | undefined => (x.op === "int" ? x.value : undefined);
  const n = int(e.right);
  if (e.left.op === "var" && n !== undefined) {
    switch (e.bop) {
      case ">=":
        return { minimum: n };
      case "<=":
        return { maximum: n };
      case ">":
        return { exclusiveMinimum: n };
      case "<":
        return { exclusiveMaximum: n };
    }
  }
  if (e.bop === "in" && e.left.op === "call" && e.right.op === "range") {
    const lo = int(e.right.from);
    const hi = int(e.right.to);
    const isLen = e.left.callee.op === "var" && e.left.callee.name === "len";
    if (isLen && lo !== undefined && hi !== undefined) return { minItems: lo, maxItems: hi };
  }
  return {};
}

/**
 * A refinement as `heldSchema` states it, for a value of JSON type `kind`; undefined when it cannot be stated. On an
 * integer: `x >= n`, `x <= n`, `x > n`, `x < n`, `x in a..b`. On a list or a text: the same of `len(x)`. And two of
 * these joined by `and`. A bound means nothing on another kind of value (`minimum` on a `Dec`, which is a string),
 * so it is not stated there.
 */
function heldRefinement(e: Expr, kind: unknown): JsonSchema | undefined {
  if (e.op !== "binary") return undefined;
  if (e.bop === "and") {
    const l = heldRefinement(e.left, kind);
    const r = heldRefinement(e.right, kind);
    return l && r ? { allOf: [l, r] } : undefined;
  }
  const int = (x: Expr): number | undefined => (x.op === "int" && Number.isSafeInteger(x.value) ? x.value : undefined);
  let lo: number | null | undefined;
  let hi: number | null | undefined;
  const n = int(e.right);
  if (e.bop === "in" && e.right.op === "range") {
    lo = int(e.right.from);
    hi = int(e.right.to);
  } else if (n !== undefined && e.bop === ">=") [lo, hi] = [n, null];
  else if (n !== undefined && e.bop === ">") [lo, hi] = [n + 1, null];
  else if (n !== undefined && e.bop === "<=") [lo, hi] = [null, n];
  else if (n !== undefined && e.bop === "<") [lo, hi] = [null, n - 1];
  if (lo === undefined || hi === undefined) return undefined;
  if (e.left.op === "var" && kind === "integer") return { ...(lo !== null ? { minimum: lo } : {}), ...(hi !== null ? { maximum: hi } : {}) };
  const isLen = e.left.op === "call" && e.left.callee.op === "var" && e.left.callee.name === "len" && e.left.args.length === 1 && e.left.args[0]!.value.op === "var";
  if (isLen && (kind === "array" || kind === "string")) return { [LEN]: [lo, hi] };
  return undefined;
}

const compiled = new WeakMap<JsonSchema, ValidateFunction>();
const ajv = new Ajv2020({ allErrors: true, strict: false });

/** Problems with `value` against `schema`, as short lines a model can act on; empty when it fits. */
export function schemaErrors(schema: JsonSchema, value: Value): string[] {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || "/"} ${e.keyword === "pattern" && e.params["pattern"] === PATH_PATTERN ? `is not a Path: ${PATH_RULE}` : (e.message ?? "is invalid")}`);
}

// What comes from outside the run is checked by a validator of its own: it stops at the first thing that does not
// fit, so a long answer of bad elements builds no list of errors, and it knows `heldSchema`'s keywords.
const heldCompiled = new WeakMap<JsonSchema, ValidateFunction>();
const heldAjv = new Ajv2020({ allErrors: false, strict: false });
heldAjv.addKeyword({ keyword: DISTINCT, schemaType: "boolean", validate: (_on: boolean, data: unknown) => !Array.isArray(data) || new Set(data.map((x) => canonical(x as Value))).size === data.length });
heldAjv.addKeyword({
  keyword: LEN,
  schemaType: "array",
  validate: (bounds: [number | null, number | null], data: unknown) => {
    if (!Array.isArray(data) && typeof data !== "string") return true;
    return (bounds[0] === null || data.length >= bounds[0]) && (bounds[1] === null || data.length <= bounds[1]);
  },
});

/** Whether `value` fits `schema`, a schema of `heldSchema`. */
export function heldTo(schema: JsonSchema, value: Value): boolean {
  let validate = heldCompiled.get(schema);
  if (!validate) {
    validate = heldAjv.compile(schema);
    heldCompiled.set(schema, validate);
  }
  return validate(value) === true;
}
