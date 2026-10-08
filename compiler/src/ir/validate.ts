// Schema validation of canonical IR (Doc 4 §3.4, §3.5).
//
// The language version is checked first so that a program for another version
// gets an explicit incompatibility (S02) instead of a pile of schema errors.
// The schema is closed: unknown fields are errors, never skipped.

import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { diag, ptrToken, type Diagnostic, type Span } from "../diag.js";
import type { Json } from "../json/strict-json.js";
import { LIMITS } from "../limits.js";
import { LANGUAGE_VERSION } from "./types.js";

let validator: ValidateFunction | undefined;

export function irSchema(): object {
  // compiler/src/ir and compiler/dist/ir sit at the same depth below the repo root.
  return JSON.parse(readFileSync(new URL("../../../spec/ir.schema.json", import.meta.url), "utf8")) as object;
}

function getValidator(): ValidateFunction {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, discriminator: true, strict: true, strictRequired: false });
    validator = ajv.compile(irSchema());
  }
  return validator;
}

export function validateIr(value: Json, spans?: Map<string, Span>): Diagnostic[] {
  const at = (path: string): { path: string; span?: Span } => {
    const span = nearestSpan(spans, path);
    return span ? { path, span } : { path };
  };

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [diag("E0104", "A Mandate program must be a JSON object.", at(""))];
  }
  const lang = value["language"];
  if (lang !== LANGUAGE_VERSION) {
    return [
      diag(
        "E0103",
        lang === undefined
          ? `Missing "language" field; expected "${LANGUAGE_VERSION}".`
          : `Unsupported language version ${JSON.stringify(lang)}; this compiler reads "${LANGUAGE_VERSION}". Use an explicit migration instead of loading it as-is.`,
        at("/language"),
        { facts: { expected: LANGUAGE_VERSION, found: lang ?? null } },
      ),
    ];
  }

  const validate = getValidator();
  const out: Diagnostic[] = [];
  if (!validate(value)) out.push(...schemaDiagnostics(validate.errors ?? [], at));

  const defs = value["defs"];
  if (defs && typeof defs === "object" && !Array.isArray(defs)) {
    const n = Object.keys(defs).length;
    if (n > LIMITS.definitions) {
      out.push(
        diag("E0105", `Program has ${n} definitions; the 0.1 limit is ${LIMITS.definitions}.`, at("/defs"), {
          facts: { limit: LIMITS.definitions, actual: n },
        }),
      );
    }
  }
  return out;
}

function schemaDiagnostics(errors: ErrorObject[], at: (p: string) => { path: string; span?: Span }): Diagnostic[] {
  // oneOf without a discriminator reports every failed branch; keep the errors
  // that reach deepest into the instance, which name the actual problem.
  const relevant = errors.filter((e) => e.keyword !== "oneOf" && e.keyword !== "if");
  const depth = (e: ErrorObject): number => e.instancePath.split("/").length + (e.keyword === "additionalProperties" ? 1 : 0);
  const byPath = new Map<string, ErrorObject[]>();
  for (const e of relevant) {
    const list = byPath.get(e.instancePath) ?? [];
    list.push(e);
    byPath.set(e.instancePath, list);
  }
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const sorted = [...relevant].sort((a, b) => depth(b) - depth(a));
  const maxDepth = sorted.length ? depth(sorted[0]!) : 0;
  for (const e of sorted) {
    // Drop shallower errors that are only a consequence of a deeper one.
    if ([...byPath.keys()].some((p) => p !== e.instancePath && p.startsWith(e.instancePath + "/")) && depth(e) < maxDepth) continue;
    let path = e.instancePath;
    let message: string;
    if (e.keyword === "additionalProperties") {
      const field = String((e.params as { additionalProperty: string }).additionalProperty);
      path = `${path}/${ptrToken(field)}`;
      message = `Unknown field "${field}". The IR schema is closed; unknown fields are rejected, not ignored.`;
    } else if (e.keyword === "required") {
      message = `Missing required field "${String((e.params as { missingProperty: string }).missingProperty)}".`;
    } else if (e.keyword === "const" || e.keyword === "enum") {
      const allowed = e.keyword === "const" ? [(e.params as { allowedValue: unknown }).allowedValue] : (e.params as { allowedValues: unknown[] }).allowedValues;
      message = `Value must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`;
    } else if (e.keyword === "pattern") {
      message = `Value does not match ${String((e.params as { pattern: string }).pattern)} (names are ASCII identifiers).`;
    } else if (e.keyword === "discriminator") {
      message = `Unknown or missing tag: ${e.message ?? "invalid discriminator"}.`;
    } else {
      message = `Schema violation: ${e.message ?? e.keyword}.`;
    }
    const key = `${path}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diag("E0104", message, at(path), { facts: { keyword: e.keyword, schema_path: e.schemaPath } }));
  }
  return out.sort((a, b) => (a.at.path ?? "").localeCompare(b.at.path ?? ""));
}

export function nearestSpan(spans: Map<string, Span> | undefined, path: string): Span | undefined {
  if (!spans) return undefined;
  let p = path;
  for (;;) {
    const s = spans.get(p);
    if (s) return s;
    if (p === "") return undefined;
    p = p.slice(0, p.lastIndexOf("/"));
  }
}
