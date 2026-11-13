// Schema validation of canonical IR (Doc 4 §3.4, §3.5).
//
// The language version is checked first so that a program for another version
// gets an explicit incompatibility (S02) instead of a pile of schema errors.
// The schema is closed: unknown fields are errors, never skipped.

import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { diag, ptrToken, type Diagnostic, type Span } from "../diag.js";
import { compareUtf16 } from "../json/jcs.js";
import type { Json } from "../json/strict-json.js";
import { LIMITS } from "../limits.js";
import { atLeast, isLanguageVersion, LANGUAGE_VERSIONS, SYSTEM_KINDS, type LanguageVersion } from "./types.js";

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

/**
 * The raw errors of the validator `validateIr` uses, for `value` as it stands, in Ajv's order. It exists for the
 * vectors (vectors/README.md): another implementation of the schema is checked against these. `validateIr` does
 * not call it, and does not run the validator at all for a document that is not an object or has no known language.
 */
export function irSchemaErrors(value: Json): ErrorObject[] {
  const validate = getValidator();
  return validate(value) ? [] : [...(validate.errors ?? [])];
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
  if (!isLanguageVersion(lang)) {
    const known = LANGUAGE_VERSIONS.map((v) => `"${v}"`).join(" or ");
    return [
      diag(
        "E0103",
        lang === undefined
          ? `Missing "language" field; expected ${known}.`
          : `Unsupported language version ${JSON.stringify(lang)}; this compiler reads ${known}. Use an explicit migration instead of loading it as-is.`,
        at("/language"),
        { facts: { expected: [...LANGUAGE_VERSIONS], found: lang ?? null } },
      ),
    ];
  }

  const validate = getValidator();
  const out: Diagnostic[] = [];
  if (!validate(value)) out.push(...schemaDiagnostics(validate.errors ?? [], at));

  const defs = value["defs"];
  if (defs && typeof defs === "object" && !Array.isArray(defs)) {
    out.push(...newerConstructs(defs, lang, at));
    for (const [name, d] of Object.entries(defs)) {
      if (!d || typeof d !== "object" || Array.isArray(d) || d["kind"] !== "agent") continue;
      for (const [field, since] of Object.entries(SINCE.agentFields)) {
        if (field in d && !atLeast(lang, since)) {
          out.push(diag("E0104", `Agent ${name}: '${field}' is a ${since} field; this program is ${lang}.`, at(`/defs/${ptrToken(name)}/${field}`), { facts: { field, language: lang } }));
        }
      }
      const pr = d["progress"];
      if (pr && typeof pr === "object" && !Array.isArray(pr) && typeof pr["window"] === "number" && typeof pr["repeats"] === "number" && pr["repeats"] > pr["window"]) {
        out.push(diag("E0104", `Agent ${name}: progress.repeats (${pr["repeats"]}) cannot be more than progress.window (${pr["window"]}).`, at(`/defs/${ptrToken(name)}/progress`), { facts: { window: pr["window"], repeats: pr["repeats"] } }));
      }
    }
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

/**
 * What each language version added: definition kinds, expression forms and
 * fields of an agent, a workflow and a budget. 0.2 added the agent loop's
 * strategy and progress thresholds; 0.3 the system model and change sets
 * (design doc 9); 0.4 roles, the envelope, `map`, `plan` and the `agents`
 * budget dimension (spec/envelope.md). An older program that uses one is
 * refused by name (E0104), not read with another meaning. A version adds its
 * constructs here. Exported for the vectors (vectors/README.md), which have a case for every row.
 */
export const SINCE: Record<"kinds" | "ops" | "agentFields" | "workflowFields" | "budgetFields", Record<string, LanguageVersion>> = {
  kinds: { ...Object.fromEntries(SYSTEM_KINDS.map((k) => [k, "mandate/0.3" as const])), role: "mandate/0.4" },
  ops: { changeset: "mandate/0.3", map: "mandate/0.4", plan: "mandate/0.4" },
  agentFields: { loop: "mandate/0.2", progress: "mandate/0.2" },
  workflowFields: { envelope: "mandate/0.4" },
  budgetFields: { agents: "mandate/0.4" },
};

/**
 * An int, dec or money literal below zero. The text form of such a literal is
 * a minus sign and a positive literal, which reads back as `unary neg`, so the
 * IR and its text would hash differently. From 0.5 the IR refuses it.
 */
function negativeLiteral(v: { [k: string]: Json }): boolean {
  switch (v["op"]) {
    case "int":
      return typeof v["value"] === "number" && v["value"] < 0;
    case "dec":
      return typeof v["value"] === "string" && v["value"].startsWith("-");
    case "money":
      return typeof v["micros"] === "number" && v["micros"] < 0;
    default:
      return false;
  }
}

/** The definitions and expressions of `defs` that are newer than `lang`. */
function newerConstructs(defs: { [k: string]: Json }, lang: LanguageVersion, at: (p: string) => { path: string; span?: Span }): Diagnostic[] {
  const out: Diagnostic[] = [];
  const newer = (table: Record<string, LanguageVersion>, key: unknown): LanguageVersion | undefined => {
    const since = typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined;
    return since && !atLeast(lang, since) ? since : undefined;
  };
  const walk = (v: Json, path: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`));
    else if (v && typeof v === "object") {
      const since = newer(SINCE.ops, v["op"]);
      if (since) out.push(diag("E0104", `'${String(v["op"])}' is a ${since} expression; this program is ${lang}.`, at(path), { facts: { op: v["op"]!, language: lang } }));
      if (atLeast(lang, "mandate/0.5") && negativeLiteral(v)) {
        out.push(diag("E0104", `A negative '${String(v["op"])}' literal is not allowed in ${lang}: from mandate/0.5 a negative literal is written as the negation of a positive one (unary neg).`, at(path), { facts: { op: v["op"]!, language: lang } }));
      }
      for (const [k, x] of Object.entries(v)) {
        // Every budget is written under `budget`: a workflow's, an agent's, a skill's, a delegation's.
        if (k === "budget" && x && typeof x === "object" && !Array.isArray(x)) {
          for (const field of Object.keys(x)) {
            const added = newer(SINCE.budgetFields, field);
            if (added) out.push(diag("E0104", `'${field}' is a ${added} budget field; this program is ${lang}.`, at(`${path}/budget/${ptrToken(field)}`), { facts: { field, language: lang } }));
          }
        }
        walk(x, `${path}/${ptrToken(k)}`);
      }
    }
  };
  for (const [name, d] of Object.entries(defs)) {
    const path = `/defs/${ptrToken(name)}`;
    const since = d && typeof d === "object" && !Array.isArray(d) ? newer(SINCE.kinds, d["kind"]) : undefined;
    if (since) {
      out.push(diag("E0104", `${name}: '${String((d as { [k: string]: Json })["kind"])}' is a ${since} definition; this program is ${lang}.`, at(`${path}/kind`), { facts: { kind: (d as { [k: string]: Json })["kind"]!, language: lang } }));
      continue;
    }
    if (d && typeof d === "object" && !Array.isArray(d) && d["kind"] === "workflow") {
      for (const field of Object.keys(d)) {
        const added = newer(SINCE.workflowFields, field);
        if (added) out.push(diag("E0104", `Workflow ${name}: '${field}' is a ${added} field; this program is ${lang}.`, at(`${path}/${ptrToken(field)}`), { facts: { field, language: lang } }));
      }
    }
    walk(d, path);
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
  // By UTF-16 code units, not by the locale: another implementation has to be able to reproduce the order.
  return out.sort((a, b) => compareUtf16(a.at.path ?? "", b.at.path ?? ""));
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
