// Front door of the compiler: read text or JSON into canonical IR, validate it
// against the closed schema, resolve names, run the static checks (Gate 1)
// and hash it.

import { hasErrors, type Diagnostic, type Span } from "./diag.js";
import { hashProgram, type ProgramHashes } from "./hash.js";
import type { Program } from "./ir/types.js";
import { sourceMap } from "./ir/sourcemap.js";
import { validateIr } from "./ir/validate.js";
import { parseStrictJson, type Json } from "./json/strict-json.js";
import { parseMdt } from "./parse/parser.js";
import { resolveNames } from "./resolve/resolve.js";
import { staticCheck } from "./check/static.js";

export type SourceKind = "mdt" | "json";

export interface LoadResult {
  program?: Program;
  /** JSON Pointer into the IR → span in the input. */
  spans: Map<string, Span>;
  diagnostics: Diagnostic[];
}

export interface CheckResult extends LoadResult {
  ok: boolean;
  hashes?: ProgramHashes;
}

export function kindOf(file: string): SourceKind {
  return file.endsWith(".json") ? "json" : "mdt";
}

/** Reads source into IR and validates it against the schema. */
export function load(text: string, kind: SourceKind): LoadResult {
  if (kind === "json") {
    const parsed = parseStrictJson(text);
    if (!parsed.ok) return { spans: new Map(), diagnostics: parsed.diagnostics };
    const { value, spans } = parsed.value;
    const diagnostics = validateIr(value, spans);
    if (hasErrors(diagnostics)) return { spans, diagnostics };
    return { program: value as unknown as Program, spans, diagnostics };
  }
  const parsed = parseMdt(text);
  if (!parsed.program) return { spans: new Map(), diagnostics: parsed.diagnostics };
  const spans = sourceMap(parsed.program, parsed.spans);
  // Plain JSON so the IR has no null-prototype objects and matches what a JSON reader would build.
  const program = JSON.parse(JSON.stringify(parsed.program)) as Program;
  const diagnostics = [...parsed.diagnostics, ...validateIr(program as unknown as Json, spans)];
  return { program, spans, diagnostics };
}

export function check(text: string, kind: SourceKind): CheckResult {
  const loaded = load(text, kind);
  const diagnostics = [...loaded.diagnostics];
  if (!loaded.program || hasErrors(diagnostics)) return { ...loaded, diagnostics, ok: false };
  diagnostics.push(...resolveNames(loaded.program, loaded.spans));
  // Static checks assume every name resolves.
  if (!hasErrors(diagnostics)) diagnostics.push(...staticCheck(loaded.program, loaded.spans));
  const ok = !hasErrors(diagnostics);
  const result: CheckResult = { ...loaded, diagnostics, ok };
  if (ok) result.hashes = hashProgram(loaded.program as unknown as Json);
  return result;
}
