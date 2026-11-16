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
import type { Value } from "./values.js";

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

function convert(program: Program, t: TypeExpr, defs: Record<string, JsonSchema>, seen: Set<string>): JsonSchema {
  if ("record" in t) {
    const names = Object.keys(t.record).sort();
    return {
      type: "object",
      properties: Object.fromEntries(names.map((n) => [n, convert(program, t.record[n]!, defs, seen)])),
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
          ...(v.fields?.length ? { $args: { type: "array", prefixItems: v.fields.map((f) => convert(program, f.type, defs, seen)), minItems: v.fields.length, maxItems: v.fields.length } } : {}),
        },
        required: v.fields?.length ? ["$tag", "$args"] : ["$tag"],
        additionalProperties: false,
      })),
    };
  }
  if ("refine" in t) return { ...convert(program, t.refine, defs, seen), ...refinement(t.where) };
  const args = t.args ?? [];
  if (WRAPPERS.has(t.ref) && args[0]) return convert(program, args[0], defs, seen);
  if (BASE[t.ref]) return BASE[t.ref]!;
  switch (t.ref) {
    case "List":
      return { type: "array", items: args[0] ? convert(program, args[0], defs, seen) : {} };
    case "Set":
      return { type: "array", items: args[0] ? convert(program, args[0], defs, seen) : {}, uniqueItems: true };
    case "Map":
      return { type: "object", additionalProperties: args[1] ? convert(program, args[1], defs, seen) : {} };
    case "Option":
      return { anyOf: [args[0] ? convert(program, args[0], defs, seen) : {}, { type: "null" }] };
  }
  const def: Def | undefined = program.defs[t.ref];
  if (def?.kind === "type") {
    if (!seen.has(t.ref)) {
      seen.add(t.ref);
      defs[t.ref] = convert(program, def.type, defs, seen);
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
