// Front door of the compiler: read text or JSON into canonical IR, validate it
// against the closed schema, resolve names, run the static checks (Gate 1)
// and hash it.

import { diag, hasErrors, type Diagnostic, type Span } from "./diag.js";
import { hashProgram, type ProgramHashes } from "./hash.js";
import type { Program } from "./ir/types.js";
import { sourceMap } from "./ir/sourcemap.js";
import { validateIr } from "./ir/validate.js";
import { parseStrictJson, type Json } from "./json/strict-json.js";
import { parseMdt } from "./parse/parser.js";
import { resolveNames } from "./resolve/resolve.js";
import { staticCheck } from "./check/static.js";
import { lockChecks, moduleLockChecks, validateLock, type Lock } from "./lock.js";
import { link, type Modules } from "./modules.js";

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

export interface CheckOptions {
  /** The lock file (spec/lock.md). With it, tiers are checked against it and W0504 is computed. */
  lock?: Lock;
  /**
   * Imported modules the caller has loaded, by name, e.g. a system model
   * (design doc 9 §2.1). Their definitions are linked in; a module left out
   * stays opaque. Each module should pass `check` on its own.
   */
  modules?: Modules;
}

export interface ModuleSource {
  text: string;
  kind: SourceKind;
  /** Where it was read from, for messages. */
  file: string;
}

/**
 * Loads modules a program imports, such as a system model, and checks each
 * against the others. Keyed by the name each declares (`module …`); a name
 * given twice is refused.
 */
export function loadModules(sources: ModuleSource[]): { modules: Modules; problems: Array<{ file: string; diagnostics: Diagnostic[] }> } {
  const modules: Modules = {};
  const problems: Array<{ file: string; diagnostics: Diagnostic[] }> = [];
  const loaded: Array<{ src: ModuleSource; program: Program }> = [];
  for (const src of sources) {
    const r = load(src.text, src.kind);
    if (!r.program || hasErrors(r.diagnostics)) {
      problems.push({ file: src.file, diagnostics: r.diagnostics });
      continue;
    }
    if (Object.hasOwn(modules, r.program.module)) {
      problems.push({ file: src.file, diagnostics: [diag("E0121", `Module ${r.program.module} is given twice.`, { path: "/module" }, { facts: { module: r.program.module } })] });
      continue;
    }
    modules[r.program.module] = r.program;
    loaded.push({ src, program: r.program });
  }
  for (const { src, program } of loaded) {
    const others = Object.fromEntries(Object.entries(modules).filter(([m]) => m !== program.module));
    const r = check(src.text, src.kind, { modules: others });
    if (!r.ok) problems.push({ file: src.file, diagnostics: r.diagnostics });
  }
  return { modules, problems };
}

export function check(text: string, kind: SourceKind, opts: CheckOptions = {}): CheckResult {
  const loaded = load(text, kind);
  const diagnostics = [...loaded.diagnostics];
  if (!loaded.program || hasErrors(diagnostics)) return { ...loaded, diagnostics, ok: false };
  const linked = link(loaded.program, opts.modules);
  diagnostics.push(...linked.diagnostics.map((d) => (d.at.path !== undefined && loaded.spans.get(d.at.path) ? { ...d, at: { ...d.at, span: loaded.spans.get(d.at.path)! } } : d)));
  diagnostics.push(...resolveNames(loaded.program, loaded.spans, linked.defs));
  // Static checks assume every name resolves.
  if (!hasErrors(diagnostics)) diagnostics.push(...staticCheck(loaded.program, loaded.spans, linked.defs));
  if (opts.lock && !hasErrors(diagnostics)) {
    const lockDiags = validateLock(opts.lock);
    diagnostics.push(...(lockDiags.length ? lockDiags : [...lockChecks({ ...loaded.program, defs: linked.defs }, opts.lock, loaded.spans), ...moduleLockChecks(loaded.program, opts.lock, opts.modules)]));
  }
  const ok = !hasErrors(diagnostics);
  const result: CheckResult = { ...loaded, diagnostics, ok };
  if (ok) result.hashes = hashProgram(loaded.program as unknown as Json);
  return result;
}
