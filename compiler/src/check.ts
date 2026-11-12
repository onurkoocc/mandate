// Front door of the compiler: read text or JSON into canonical IR, validate it
// against the closed schema, resolve names, run the static checks (Gate 1)
// and hash it.

import { diag, hasErrors, ptr, type Diagnostic, type Span } from "./diag.js";
import { hashProgram, type ProgramHashes } from "./hash.js";
import type { Program } from "./ir/types.js";
import { sourceMap } from "./ir/sourcemap.js";
import { validateIr } from "./ir/validate.js";
import { parseStrictJson, type Json } from "./json/strict-json.js";
import { parseMdt } from "./parse/parser.js";
import { resolveNames } from "./resolve/resolve.js";
import { narrowings } from "./check/amendment.js";
import { capsOf } from "./check/caps.js";
import { roleChecks } from "./check/roles.js";
import { staticCheck, type Claim } from "./check/static.js";
import { containment, opened, skeleton, subprogramShape, subprogramWorkflow, type Room } from "./check/subprogram.js";
import { lockChecks, moduleLockChecks, roleLockChecks, validateLock, type Lock } from "./lock.js";
import { link, type Modules } from "./modules.js";
import { applyOps, applyPatch, type GovernanceChange, type PatchOp } from "./patch/patch.js";
import type { DataClass } from "./std/std.js";

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
  /** For a lead's sub-program: the envelope its workflow stands under and its lead's data class (`checkSubprogram`). */
  claim?: Claim;
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
  // A role is a name too, from 0.4: where one is named, it is a role definition (E1501, E1503).
  diagnostics.push(...roleChecks(loaded.program, loaded.spans, linked.defs));
  // Static checks assume every name resolves.
  if (!hasErrors(diagnostics)) diagnostics.push(...staticCheck(loaded.program, loaded.spans, linked.defs, opts.claim));
  if (opts.lock && !hasErrors(diagnostics)) {
    const lockDiags = validateLock(opts.lock);
    diagnostics.push(...(lockDiags.length ? lockDiags : [...lockChecks({ ...loaded.program, defs: linked.defs }, opts.lock, loaded.spans), ...roleLockChecks(loaded.program, linked, opts.lock, loaded.spans), ...moduleLockChecks(loaded.program, opts.lock, opts.modules)]));
  }
  const ok = !hasErrors(diagnostics);
  const result: CheckResult = { ...loaded, diagnostics, ok };
  if (ok) result.hashes = hashProgram(loaded.program as unknown as Json);
  return result;
}

/** A patch applied to a program, with the patched program's own checks. */
export interface PatchCheck {
  ok: boolean;
  hash?: string;
  diagnostics: Diagnostic[];
  governance: GovernanceChange[];
  requires_approval: boolean;
  program?: Program;
}

/**
 * Applies `ops` to `program` against the hash they were written for
 * (patch/patch.ts), then checks the patched program with `modules`, so the
 * caller sees what it would be asked to fix next. Nothing is saved. The MCP
 * server's `mandate.apply_patch` answers with it, and 0.4's `check_program`
 * checks a lead's sub-program the same way (spec/envelope.md).
 */
export function checkPatch(program: Program, base: string, ops: PatchOp[], modules: Modules = {}): PatchCheck {
  const r = applyPatch(program, base, ops, modules);
  const checked = r.program ? check(JSON.stringify(r.program), "json", { modules }) : undefined;
  return {
    ok: r.ok && !!checked?.ok,
    ...(r.hash ? { hash: r.hash } : {}),
    diagnostics: [...r.diagnostics, ...(checked?.diagnostics ?? [])],
    governance: r.governance,
    requires_approval: r.governance.length > 0,
    ...(r.program ? { program: r.program } : {}),
  };
}

/** A lead's sub-program, as `check_program` and `submit_program` receive it (spec/envelope.md "plan"). */
export interface SubprogramInput {
  /** The program whose `plan` runs the lead, and the modules it imports. */
  parent: Program;
  modules?: Modules;
  /** The workflow of `parent` whose envelope bounds the run. */
  workflow: string;
  /** The sub-program's number under its `plan`, which names the skeleton it is a patch to. */
  number: number;
  /** The hash of that skeleton. */
  base: string;
  ops: PatchOp[];
  /** The data class of what the lead received (`leadClasses`). */
  lead: DataClass;
  /** What is left of the envelope now. */
  room: Room;
}

export interface SubprogramCheck {
  /** The sub-program passed every check and fits what is left of the envelope. */
  ok: boolean;
  diagnostics: Diagnostic[];
  /** When `ok`: the sub-program as the lead wrote it, its hash, and the name of its one workflow. */
  program?: Program;
  hash?: string;
  workflow?: string;
}

/**
 * Checks a lead's sub-program and whether it fits what is left of the
 * envelope (spec/envelope.md "The sub-program", INV-15). In order: the patch
 * applies to the skeleton of its number; it defines only what a sub-program
 * may (E1705); all of `check` passes, with every definition of the parent in
 * sight and its workflow under the parent's envelope; its claim fits `room`
 * (E1706). Nothing is saved and nothing runs.
 */
export function checkSubprogram(i: SubprogramInput): SubprogramCheck {
  const wf = Object.hasOwn(i.parent.defs, i.workflow) ? i.parent.defs[i.workflow] : undefined;
  if (wf?.kind !== "workflow" || !wf.envelope) throw new Error(`${i.workflow} is not a workflow with an envelope, so it has no sub-programs`);
  const patched = applyOps(skeleton(i.parent.module, i.number), i.base, i.ops);
  if (!patched.program) return { ok: false, diagnostics: patched.diagnostics };
  const sub = patched.program;
  const diagnostics = [...patched.diagnostics, ...subprogramShape(sub, i.parent.module, i.number)];
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };
  const view = opened(sub, i.parent);
  const modules = { ...(i.modules ?? {}), [i.parent.module]: i.parent };
  const checked = check(JSON.stringify(view), "json", { modules, claim: { envelope: wf.envelope, lead: i.lead } });
  // A name the sub-program defines and its parent already has is reported once, at the definition the lead wrote.
  const collided = new Set<string>();
  for (const d of checked.diagnostics) {
    const name = d.code === "MDT-E0121" ? d.facts?.["name"] : undefined;
    if (typeof name !== "string") diagnostics.push(d);
    else if (!collided.has(name)) {
      collided.add(name);
      diagnostics.push({ ...d, at: { path: ptr("defs", name) } });
    }
  }
  const workflow = subprogramWorkflow(sub)!;
  if (!hasErrors(diagnostics)) {
    // The envelope is read in its parent's language, the sub-program in its own.
    const envelope = (wf.envelope.caps ?? []).flatMap((c) => capsOf(link(i.parent, i.modules).defs, c, { language: i.parent.language }));
    diagnostics.push(...containment(link(view, modules).defs, workflow, envelope, i.room, { language: view.language }));
  }
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };
  return { ok: true, diagnostics, program: sub, hash: hashProgram(sub as unknown as Json).program, workflow };
}

/** An amendment of an envelope, as `request_amendment` receives it (spec/envelope.md "Amendments"). */
export interface AmendmentInput {
  /** The run's program as it is now, and the modules it imports. */
  parent: Program;
  modules?: Modules;
  /** The workflow of `parent` whose envelope the amendment replaces. */
  workflow: string;
  /** The new envelope, as IR. It is a lead's writing: it is read as JSON and held to the schema. */
  envelope: unknown;
}

export interface AmendmentCheck {
  /** The program with the new envelope passes every check, and the new envelope takes nothing away. */
  ok: boolean;
  diagnostics: Diagnostic[];
  /** When `ok`: the program with the new envelope, and its hash. */
  program?: Program;
  hash?: string;
}

/**
 * Checks an amendment (spec/envelope.md "Amendments", N04): the run's
 * program with `envelope` in place of its workflow's own, and nothing else
 * changed. All of `check` passes on it, and the new envelope only widens the
 * old one (E1709). Nothing is saved and nothing runs.
 */
export function checkAmendment(i: AmendmentInput): AmendmentCheck {
  const wf = Object.hasOwn(i.parent.defs, i.workflow) ? i.parent.defs[i.workflow] : undefined;
  if (wf?.kind !== "workflow" || !wf.envelope) throw new Error(`${i.workflow} is not a workflow with an envelope, so it has none to amend`);
  const at = `${ptr("defs", i.workflow)}/envelope`;
  if (!i.envelope || typeof i.envelope !== "object" || Array.isArray(i.envelope)) {
    return { ok: false, diagnostics: [diag("E1701", `An amendment gives ${i.workflow}'s new envelope, with its owner, its caps and its budget.`, { path: at }, { facts: { missing: ["owner", "caps", "budget"] } })] };
  }
  const amended = { ...i.parent, defs: { ...i.parent.defs, [i.workflow]: { ...wf, envelope: i.envelope } } };
  const checked = check(JSON.stringify(amended), "json", i.modules ? { modules: i.modules } : {});
  const diagnostics = [...checked.diagnostics];
  const now = checked.program?.defs[i.workflow];
  if (checked.ok && now?.kind === "workflow" && now.envelope) diagnostics.push(...narrowings(link(checked.program!, i.modules).defs, i.workflow, wf.envelope, now.envelope, { language: checked.program!.language }));
  if (hasErrors(diagnostics) || !checked.program || !checked.hashes) return { ok: false, diagnostics };
  return { ok: true, diagnostics, program: checked.program, hash: checked.hashes.program };
}

/**
 * An admitted sub-program as the interpreter runs it: its own definitions
 * and all its parent sees. Never hashed.
 */
export function subprogramLinked(sub: Program, parent: Program, modules: Modules = {}): Program {
  const view = opened(sub, parent);
  return { ...sub, defs: link(view, { ...modules, [parent.module]: parent }).defs };
}
