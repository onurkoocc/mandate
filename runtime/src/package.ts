// A package: a program with its lock and the modules it was checked with,
// under one hash (§3.5). `verifyPackage` is what the runtime holds a package
// to before it runs it. It trusts nobody who built one, itself included: an
// amended package (spec/envelope.md "Amendments") passes it like any other.
//
// From 0.6 (spec/library.md "At load") a package also carries the libraries
// its lock pins. A program of 0.6 runs as its running program: expanded,
// when it applies a pattern, and linked through what each library reaches,
// the compiler's own `std.patterns` among them. The compiler's check gives
// it (`linked`), with the very definitions it checked, and `verifyPackage`
// gives it back for the run to store. What 0.6 has that this runtime does
// not run yet is refused here by name (NOT_RUN_YET_06).

import {
  atLeast,
  bindingChecks,
  canonicalize,
  check,
  checkAmendment,
  envelopeChanges,
  hashProgram,
  isProgram06,
  kindOf,
  LANGUAGE_06,
  libraryVerify,
  link,
  linkedProgram,
  load,
  LOCK_FIELDS_0_5,
  LOCK_FORMAT,
  LOCK_FORMAT_06,
  modelTiers,
  packageHash,
  roleLockChecks,
  sandboxLockChecks,
  semanticDiff,
  subprogramLinked,
  validateLock,
  type AmendmentCheck,
  type AmendmentInput,
  type Change,
  type Diagnostic,
  type DiffView,
  type Json,
  type LanguageVersion,
  type LibrariesConfig,
  type LibrarySource,
  type Lock,
  type Modules,
  type Program,
} from "@mandate/bridge";
import { CompilerFailure, compilerMode } from "@mandate/bridge/mode";
import { Violation } from "./signals.js";

/** An amendment as the runtime checks it: with the lock of the run's package, which the amended package keeps. */
export type AmendedInput = AmendmentInput & { lock: Lock };

/** The check of an amendment and of the package it makes. */
export interface AmendedCheck extends AmendmentCheck {
  /** When `ok`: the amended package's hash, and the semantic diff from the run's program to the amended one. */
  package?: string;
  diff?: DiffView;
  /** What the amendment changes in the envelope, line by line: what the owner who decides it is shown. */
  changes?: Change[];
}

/**
 * Checks an amendment a lead asked for, and the package it makes (spec/envelope.md "Amendments"). The program with
 * the new envelope passes the compiler's checks and takes nothing away from the old envelope (`checkAmendment`,
 * E1709). The package of that program, with the run's lock and modules, is then held to what every package is held
 * to before it runs (`verifyPackage`): a role nobody holds, or a model tier the lock does not pin, refuses it here
 * and not in the middle of the run. What refuses it is a diagnostic to the lead.
 *
 * In 0.6 an amendment of a program that applies a pattern, or whose package carries libraries, is not run yet: the
 * run goes on with the expansion it stored at its start, which the amended package would leave behind, and the
 * amended package would need its libraries carried with it. It is refused by name (`unsupported_language`).
 */
export function checkAmended(i: AmendedInput): AmendedCheck {
  const why = amendmentNotRunYet(i.parent, i.lock);
  if (why) return { ok: false, diagnostics: [{ code: "unsupported_language", severity: "error", message: why, at: {}, docs: "spec/library.md" }] };
  const r = checkAmendment(i);
  if (!r.ok || !r.program) return r;
  const pkg = buildPackage(r.program, i.lock, i.modules ?? {});
  try {
    verifyPackage(pkg);
  } catch (e) {
    if (!(e instanceof Violation)) throw e;
    return { ok: false, diagnostics: [...r.diagnostics, { code: e.code, severity: "error", message: e.message, at: {}, docs: "spec/envelope.md" }] };
  }
  return { ...r, package: pkg.hash, diff: semanticDiff(i.parent, r.program), changes: envelopeChanges(i.parent, r.program, i.workflow, i.modules ?? {}) };
}

/** Why an amendment of a 0.6 program is not run yet, or undefined. */
function amendmentNotRunYet(parent: Program, lock: Lock): string | undefined {
  if (!isProgram06(parent)) return undefined;
  const applying = applications(parent);
  if (applying.length) return `The program applies a pattern (${applying.join(", ")}): its run runs the expansion stored at its start, and this runtime does not amend a run of one yet (spec/library.md "Hashes, and what the runtime stores").`;
  const libraries = Object.keys(lock.libraries ?? {}).sort();
  if (libraries.length) return `The package carries libraries (${libraries.join(", ")}), and this runtime does not amend a package of 0.6 with libraries yet (spec/library.md "At load").`;
  return undefined;
}

/** The workflows of a program that apply a pattern, each as `W = P`, in the order of their names. */
export function applications(program: Program): string[] {
  return Object.entries(program.defs as Record<string, { kind?: string; apply?: { pattern?: unknown } }>)
    .filter(([, d]) => d.kind === "workflow" && d.apply !== undefined)
    .map(([n, d]) => `${n} = ${String(d.apply!.pattern)}`)
    .sort();
}

/**
 * A content-addressed package: the program, its hash, its lock, and the
 * imported modules it was checked with (a system model, design doc 9 §2.1).
 * The lock pins every module by its program hash, so the package hash covers
 * them too.
 *
 * 0.6: the libraries its lock pins, each as the doors take it (its manifest and its module files, by the path the
 * manifest lists them under). The lock pins each by its digest, so the package hash covers them too. `std.patterns`
 * is the compiler's own: a lock pins it, and a package does not carry it.
 */
export interface Package {
  hash: string;
  programHash: string;
  program: Program;
  lock: Lock;
  modules?: Modules;
  libraries?: LibrarySource[];
}

/** What a package is held to at load besides itself: the runtime's configuration of libraries (spec/library.md). */
export interface LoadOptions {
  /** The `libraries` member of the runtime's configuration: `revoked` digests are never loaded. */
  libraries?: Partial<LibrariesConfig>;
}

/** What `verifyPackage` gives a package that passes: what a run of it runs. */
export interface Verified {
  /**
   * The program as a run runs it, linked: every definition it sees is among its `defs`, and it is never linked
   * again. For a program of 0.6 that applies a pattern, or whose lock pins a library, the running program the
   * compiler's check gave (`stored`): expanded, and linked through what each library reaches. For any other, the
   * package's program with the package's modules linked in (`linkedProgram`), as a resume links it again.
   */
  running: Program;
  /**
   * What a run stores at its start, and runs from then on (0.6): the running program, for a program that applies a
   * pattern or whose lock pins a library, which plain linking of the package would not give. The run's manifest
   * names it by its hash, `expanded`.
   */
  stored?: Program;
  /** The modules of the package: its own, and those of its libraries. `running` already holds what it sees of them. */
  modules: Modules;
}

/** Whether a run of the package stores its running program: its program applies a pattern, or its lock pins a library. */
function storesRunning(pkg: Pick<Package, "program" | "lock">): boolean {
  return applications(pkg.program).length > 0 || Object.keys(isObj(pkg.lock.libraries) ? pkg.lock.libraries : {}).length > 0;
}

/**
 * The language versions this runtime runs. Of 0.4 it runs roles, signed decisions, envelopes, `map` and `plan`; of
 * 0.5 the program and every field of its lock; of 0.6 what 0.5 has, `pub`, doc lines, closed imports, libraries
 * (a module of one may import another it reaches), `std.patterns`, and patterns whose expansion holds only what it
 * runs; see `notRunYet` and NOT_RUN_YET_06.
 */
export const RUNTIME_LANGUAGES: readonly LanguageVersion[] = ["mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4", "mandate/0.5", LANGUAGE_06];

/**
 * What a program uses of 0.4 that this runtime does not run: the `agents` dimension in a budget other than an
 * envelope's (spec/envelope.md). A package that uses it is refused at load: a version is never run on a
 * best-effort basis (§3.5). An envelope runs: its approval, its `agents` ledger, `max_concurrent` and `approve`.
 * So do a `map` and a `plan`, whose sub-programs name `agents` in their own budgets, as their claim on the
 * envelope's.
 *
 * With `lock`, the package's lock: what it asks that this runtime does not enforce yet, by its name (`lock.<field>`),
 * none today. Every field of format 0.5 is enforced (spec/boundary.md): `isolation` by each sandbox's requirement,
 * which the sandbox adapter holds to what its host gives; `host` by the check of the host's tools before a run starts
 * or resumes (fitness.ts); `egress` by the egress proxy, which alone puts a credential into a sandbox's requests: a
 * run that needs it starts only where a proxy is named, and the adapter refuses by name a binding the proxy does not
 * hold, or one on a host whose sandboxes do not reach the proxy.
 */
export function notRunYet(program: Program, lock?: Lock): string[] {
  const found = new Set<string>();
  for (const field of Object.keys(UNENFORCED) as Unenforced[]) if (lock?.[field] !== undefined) found.add(`lock.${field}`);
  const walk = (v: unknown, key: string, kept: unknown): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key, kept));
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (key === "budget" && o["agents"] !== undefined && v !== kept) found.add("agents");
    for (const [k, x] of Object.entries(o)) walk(x, k, kept);
  };
  // An envelope's own budget is the one the ledger keeps `agents` for; nothing reserves it anywhere else yet.
  for (const d of Object.values(program.defs)) walk(d, "", d.kind === "workflow" ? d.envelope?.budget : undefined);
  return [...found].sort();
}

/**
 * Why each lock field that this runtime does not enforce yet is not, as a refusal names it (`unsupported_lock`): a field
 * a later lock format adds is refused here by its name until the change that enforces it. None today.
 */
const UNENFORCED: Partial<Record<(typeof LOCK_FIELDS_0_5)[number], string>> = {};
type Unenforced = (typeof LOCK_FIELDS_0_5)[number];

// ── what 0.6 has that this runtime does not run yet ─────────────────────

/** Where a node of the IR stands, as a construct of NOT_RUN_YET_06 is found by it. */
interface At {
  /** The member of its parent the node is, as `envelope` or `waive`. */
  key: string;
  /** Whether it stands in the body of a `map`. */
  inMap: boolean;
  /** The definitions the program sees (linked): an effect is read by its definition. */
  defs: Record<string, unknown>;
}

/** What a package of 0.6 is, as NOT_RUN_YET_06 reads it. */
interface Read06 {
  lock: Lock;
}

/** One construct of 0.6 this runtime does not run yet: its name, the slice that releases it, and how it is found. */
interface NotRunYet06 {
  name: string;
  slice: string;
  /** Found at a node of the program the run would run (linked, so an imported definition is read too). */
  node?: (o: Record<string, unknown>, at: At) => boolean;
  /** Found in the package beside its program. */
  pkg?: (p: Read06) => boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** `<name>.<member>` as a callee: `{ op: "field", of: { op: "var", name }, name: member }`. */
const named = (o: Record<string, unknown>, name: string, member: string): boolean => o["op"] === "field" && o["name"] === member && isObj(o["of"]) && o["of"]["op"] === "var" && o["of"]["name"] === name;

/**
 * Every construct of 0.6 this runtime does not run yet, with the slice that releases it (spec/library.md, the table
 * of parts). A package of 0.6 that holds one is refused at load, `unsupported_language`, naming each it holds, so
 * that a half-built 0.6 never runs; a lead's sub-program that holds one is refused at its check. The slice that
 * implements a construct takes its line out, and nothing else.
 */
export const NOT_RUN_YET_06: readonly NotRunYet06[] = [
  // Connectors at run time: the MCP client, connector gateways, schema digests, samples (spec/library.md "Connectors").
  { name: "connector", slice: "B9", node: (o, at) => at.key !== "" && o["kind"] === "connector" && typeof o["mcp"] === "string" },
  { name: "tool.call", slice: "B9", node: (o) => named(o, "tool", "call") },
  { name: "lock.connectors", slice: "B9", pkg: (p) => isObj(p.lock.connectors) && Object.keys(p.lock.connectors).length > 0 },
  // The batch commit step (spec/library.md "The batch commit step"): a critical effect in a map body, which 0.6
  // allows. An effect there that is not a definition this runtime knows not to be critical is taken as one.
  {
    name: "batch commit step",
    slice: "B9",
    node: (o, at) => {
      if (!at.inMap || o["op"] !== "effect" || typeof o["name"] !== "string") return false;
      const d = Object.hasOwn(at.defs, o["name"]) ? at.defs[o["name"]] : undefined;
      return !isObj(d) || d["kind"] !== "effect" || d["critical"] === true;
    },
  },
  // `human.review` and waivers (spec/library.md "`human.review` and waivers").
  { name: "human.review", slice: "B10", node: (o) => named(o, "human", "review") },
  { name: "waive by", slice: "B10", node: (o, at) => at.key !== "" && Array.isArray(o["waive"]) && o["by"] !== undefined },
  // `shapes` in an envelope (spec/library.md "`shapes`").
  { name: "shapes", slice: "B12", node: (o, at) => at.key === "envelope" && o["shapes"] !== undefined },
];

/** The names of NOT_RUN_YET_06 that `program` (linked: the definitions it sees) and the package hold, in the table's order. */
export function notRunYet06(program: Program, p: Read06): string[] {
  const found = new Set<string>();
  const defs = program.defs as unknown as Record<string, unknown>;
  const walk = (v: unknown, key: string, inMap: boolean, depth: number): void => {
    if (depth > 512) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key, inMap, depth + 1));
    if (!isObj(v)) return;
    for (const row of NOT_RUN_YET_06) if (row.node?.(v, { key, inMap, defs })) found.add(row.name);
    for (const [k, x] of Object.entries(v)) walk(x, k, inMap || (v["op"] === "map" && k === "body"), depth + 1);
  };
  for (const [name, d] of Object.entries(defs)) walk(d, name, false, 0);
  for (const row of NOT_RUN_YET_06) if (row.pkg?.(p)) found.add(row.name);
  return NOT_RUN_YET_06.map((r) => r.name).filter((n) => found.has(n));
}

/** The refusal of a package of 0.6 that holds what this runtime does not run yet, naming each and its slice. */
function refusal06(names: string[]): Violation {
  const by = new Map(NOT_RUN_YET_06.map((r) => [r.name, r.slice]));
  return new Violation("unsupported_language", `The package uses ${names.map((n) => `${n} (${by.get(n)})`).join(", ")} of mandate/0.6, which this runtime does not run yet (spec/library.md).`);
}

/**
 * What a lead's sub-program of a 0.6 parent holds that this runtime does not run in a sub-program yet: every
 * construct of NOT_RUN_YET_06 that it holds as it would run: `running`, the running program its check gave when it
 * applies a pattern (expanded, with all its parent sees linked in), or else the sub-program linked into its parent.
 *
 * A sub-program that applies a pattern and was given no running program, or one in which a workflow of its own
 * still applies one, would meet `apply` in its run: it is refused by name, whatever the compiler said.
 */
export function subprogramNotRunYet(sub: Program, parent: Program, modules: Modules, running?: Program): string[] {
  if (!isProgram06(sub) && !isProgram06(parent)) return [];
  const own = (p: Program): Program => ({ ...p, defs: Object.fromEntries(Object.keys(sub.defs).flatMap((n) => (Object.hasOwn(p.defs, n) ? [[n, p.defs[n]!]] : []))) });
  const unexpanded = applications(sub).length > 0 && (!running || applications(own(running)).length > 0 || Object.keys(sub.defs).some((n) => !Object.hasOwn(running.defs, n)));
  const applied = unexpanded ? ["a pattern applied in a sub-program"] : [];
  // What the package holds beside its program was held to the table when the run started.
  const inSub = notRunYet06(running && !unexpanded ? running : subprogramLinked(sub, parent, modules), { lock: { modules: {} } });
  return [...applied, ...inSub];
}

/** A 0.4 package: its program, or a module it was packaged with, is written in 0.4. Its decisions are always signed. */
export function isSigned04(program: Program, modules: Modules = {}): boolean {
  return [program, ...Object.values(modules)].some((p) => atLeast(p.language, "mandate/0.4"));
}

export function buildPackage(program: Program, lock: Lock = { modules: {} }, modules: Modules = {}, libraries: LibrarySource[] = []): Package {
  const programHash = hashProgram(program as unknown as Json).program;
  return { hash: packageHash(programHash, lock), programHash, program, lock, ...(Object.keys(modules).length ? { modules } : {}), ...(libraries.length ? { libraries } : {}) };
}

/**
 * The lock as the compiler reads a lock file: with its format, 0.6 for a package of 0.6 and 0.5 for any other, as the
 * package carries it without (`packagedLock`). A format the lock itself names stays.
 */
function formatted(lock: Lock, v06: boolean): Lock {
  return { lock: v06 ? LOCK_FORMAT_06 : LOCK_FORMAT, ...lock } as unknown as Lock;
}

/** Whether a package holds anything of 0.6: a program or module of 0.6, a lock with what only 0.6 has, or libraries. */
export function isPackage06(pkg: Pick<Package, "program" | "lock" | "modules" | "libraries">): boolean {
  return [pkg.program, ...Object.values(pkg.modules ?? {})].some(isProgram06) || pkg.lock.libraries !== undefined || pkg.lock.connectors !== undefined || (pkg.libraries ?? []).length > 0;
}

/**
 * Load-time verification (§3.5, S09). The runtime does not trust whoever
 * built the package: it recomputes the hashes, requires every imported
 * module to be locked, and re-runs the compiler's checks.
 *
 * A compiler that fails while it is asked (a CompilerFailure of the bridge: its module missing, trapping, out of
 * memory, answering what is not an answer) has verified nothing: the package is refused, `load_verification_failed`.
 *
 * Gives what a run of the package runs: its program linked, which for a program of 0.6 that applies a pattern or
 * whose lock pins a library is the running program its check gave, and the run stores.
 */
export function verifyPackage(pkg: Package, o: LoadOptions = {}): Verified {
  try {
    return verified(pkg, o);
  } catch (e) {
    // As a model may be shown it: an amendment's refusal is a diagnostic to the lead that asked for it.
    if (e instanceof CompilerFailure) throw new Violation("load_verification_failed", `The compiler failed while it verified the package, so it is not run: ${e.shown}`);
    throw e;
  }
}

function verified(pkg: Package, o: LoadOptions): Verified {
  const v06 = isPackage06(pkg);
  // Only the Rust compiler reads 0.6: the reference compiler, frozen at 0.5, verifies nothing of it.
  if (v06 && compilerMode() === "ts") {
    throw new Violation("unsupported_language", `The package is of mandate/0.6, which only the Rust compiler reads; this runtime's compiler is the TypeScript reference (MANDATE_COMPILER=ts), frozen at mandate/0.5, so it is not run.`);
  }
  // The program and every module it was packaged with: a module's definitions run as the program's do.
  for (const p of [pkg.program, ...Object.values(pkg.modules ?? {})]) {
    if (!RUNTIME_LANGUAGES.includes(p?.language)) throw new Violation("unsupported_language", `Package language ${String(p?.language)} is not one of ${RUNTIME_LANGUAGES.join(", ")}.`);
    const all = notRunYet(p, p === pkg.program ? pkg.lock : undefined);
    const later = all.filter((n) => !n.startsWith("lock."));
    if (later.length) throw new Violation("unsupported_language", `The package uses ${later.join(", ")} of mandate/0.4, which this runtime does not run yet (spec/envelope.md).`);
    // What the lock asks of the host and the sandboxes is enforced or not run with; never run on a best-effort basis.
    const unenforced = all.filter((n) => n.startsWith("lock.")).map((n) => n.slice("lock.".length) as Unenforced);
    if (unenforced.length) throw new Violation("unsupported_lock", `The package's lock sets ${unenforced.map((f) => `${f} (${UNENFORCED[f]})`).join(", ")}, which this runtime does not enforce yet (spec/boundary.md).`);
  }
  const programHash = hashProgram(pkg.program as unknown as Json).program;
  if (programHash !== pkg.programHash) throw new Violation("package_hash_mismatch", `The program hashes to ${programHash}, not the packaged ${pkg.programHash}.`);
  if (packageHash(programHash, pkg.lock) !== pkg.hash) {
    throw new Violation("package_hash_mismatch", "The package hash does not match its program and lock.");
  }
  // A module of a library is pinned by its library's entry in the lock (0.6), as a module the package carries is by `modules`.
  const pinnedByLibrary = new Set(Object.values(pkg.lock.libraries ?? {}).flatMap((l) => Object.keys(isObj(l?.modules) ? l.modules : {})));
  const unlocked = (pkg.program.uses ?? []).map((u) => u.module).filter((m) => m !== "std" && !m.startsWith("std.") && !Object.hasOwn(pkg.lock.modules, m) && !pinnedByLibrary.has(m));
  if (unlocked.length) throw new Violation("unlocked_module", `Imported modules are not locked: ${[...new Set(unlocked)].join(", ")}.`);
  // The libraries (0.6): none revoked, each the one the lock pins, and the modules of each as a run links them.
  const libraryModules = v06 ? librariesOf(pkg, o) : {};
  // A module the package carries is the one the lock pins, byte for byte (S09, INV-02), and passes the checks itself.
  const modules = pkg.modules ?? {};
  for (const [name, m] of Object.entries(modules).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const hash = hashProgram(m as unknown as Json).program;
    if (m.module !== name || pkg.lock.modules[name] !== hash) throw new Violation("module_hash_mismatch", `Module ${name} hashes to ${hash}; the lock pins ${pkg.lock.modules[name] ?? "nothing"}.`);
    const others = Object.fromEntries(Object.entries(modules).filter(([n]) => n !== name));
    const mr = check(canonicalize(m as unknown as Json), "json", { modules: others, ...(isProgram06(m) && pkg.libraries?.length ? { libraries: pkg.libraries } : {}) });
    if (!mr.ok) throw new Violation("load_verification_failed", `Module ${name} does not pass the compiler's checks: ${mr.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).join(", ")}.`);
  }
  const linking: Modules = { ...modules, ...libraryModules };
  // The package's program with the package's modules linked in: what a run of it runs, unless it stores another.
  const plain = linkedProgram(pkg.program, v06 ? linking : modules);
  // 0.6: what the package holds that this runtime does not run yet, in the program as written, before anything is
  // asked of it; and once more below, in the running program the run would run.
  if (v06) {
    const unrun = notRunYet06(plain, { lock: pkg.lock });
    if (unrun.length) throw refusal06(unrun);
  }
  // A lock that pins models (spec/lock.md) must be well formed and pin every tier the program names.
  // A lock without models is for simulated models only; the Anthropic adapter refuses to run without one.
  // So must a lock that names members and roles: a key under two members, or a role held by nobody the lock lists, binds nothing.
  if (pkg.lock.models || pkg.lock.tariffs || pkg.lock.bindings || pkg.lock.members || pkg.lock.roles || LOCK_FIELDS_0_5.some((f) => pkg.lock[f]) || pkg.lock.libraries || pkg.lock.connectors) {
    const bad = validateLock(formatted(pkg.lock, v06));
    if (bad.length) throw new Violation("malformed_lock", `The package's lock is malformed: ${bad.map((d) => d.message).join(" ")}`);
  }
  // 0.6: the program is checked here, with its libraries, its lock (whose pins of the libraries the check holds the
  // libraries to, E1605, the compiler's own std.patterns among them) and the configuration, and gives its running
  // program: expanded, and linked through what each library reaches, with the very definitions that were checked.
  // A run of a program that applies a pattern, or whose lock pins a library, runs that one and stores it; any other
  // runs its program as plain linking gives it, which every resume gives again. Every check below reads what runs.
  const checked = v06 ? checked06(pkg, modules, o) : undefined;
  const stored = checked && storesRunning(pkg) ? checked : undefined;
  const running = stored ?? plain;
  if (stored) {
    const unrun = notRunYet06(stored, { lock: pkg.lock });
    if (unrun.length) throw refusal06(unrun);
  }
  // What the lock asks of a sandbox applies to the program (E1802, E1803): a floor in the lock of a program whose
  // requirements carry no isolation level would not be enforced, so it is not run with.
  const misfit = sandboxLockChecks(running, pkg.lock).filter((d) => d.severity === "error");
  if (misfit.length) throw new Violation("load_verification_failed", `The package's lock does not apply to its program: ${misfit.map((d) => `${d.code} ${d.message}`).join(" ")}`);
  if (pkg.lock.models || pkg.lock.tariffs || pkg.lock.bindings) {
    const missing = [...modelTiers(v06 ? running : pkg.program)].filter((t) => !Object.hasOwn(pkg.lock.models ?? {}, t)).sort();
    if (missing.length) throw new Violation("unlocked_model_tier", `Model tiers are not locked: ${missing.join(", ")} (MDT-E0141).`);
    // An executor binding that no longer fits the program and the lock is not run with (E0903–E0905, K45).
    const unfit = bindingChecks(running, pkg.lock).filter((d) => d.severity === "error");
    if (unfit.length) throw new Violation("unfit_binding", `The package's executor binding does not fit: ${unfit.map((d) => `${d.code} ${d.message}`).join(" ")}`);
  }
  if (!v06) {
    const r = check(canonicalize(pkg.program as unknown as Json), "json", { modules });
    if (!r.ok) {
      throw new Violation("load_verification_failed", `The program does not pass the compiler's checks: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).join(", ")}.`);
    }
  }
  // Every role a 0.4 package names has a member in its lock (E1502): a wait for a role nobody holds could never end.
  // A stored running program holds every definition it sees: they are its linked definitions, with nothing to add.
  const unbound = stored
    ? roleLockChecks(stored, { defs: stored.defs, origin: {} }, formatted(pkg.lock, v06))
    : roleLockChecks(pkg.program, link(pkg.program, v06 ? linking : modules), formatted(pkg.lock, v06));
  if (unbound.length) {
    const roles = [...new Set(unbound.map((d) => String((d.facts as { role?: unknown } | undefined)?.role)))].sort();
    throw new Violation("unbound_role", `The package's lock binds no member to ${roles.length === 1 ? "role" : "roles"} ${roles.join(", ")} (MDT-E1502).`);
  }
  return { running, ...(stored ? { stored } : {}), modules: v06 ? linking : modules };
}

/**
 * The libraries of a package of 0.6 (spec/library.md "At load", "Waiting period and revocation"), held to the lock
 * and the configuration, and the modules of each as a run links them:
 *
 * - a digest the lock pins, or one a library the package carries hashes to, that the configuration revokes: the
 *   package is not loaded (`library_revoked`), whatever else is wrong with it;
 * - every library the lock pins is carried (but `std.patterns`, the compiler's own), each once, and each hashes,
 *   through the compiler (`library_verify`), to the digest the lock pins; each module of it hashes to the program
 *   hash the pin gives it (`library_digest_mismatch`). A library that does not read is the check's to report.
 */
function librariesOf(pkg: Package, o: LoadOptions): Modules {
  const pins = isObj(pkg.lock.libraries) ? pkg.lock.libraries : {};
  const carried = pkg.libraries ?? [];
  const verified = carried.map((l) => libraryVerify(l, carried.filter((x) => x !== l)));
  refuseRevoked(pkg.lock, o, verified.map((v) => [v.name ?? "a library the package carries", v.digest] as const));
  const out: Modules = {};
  const seen = new Set<string>();
  verified.forEach((v, i) => {
    if (!v.ok || !v.name || !v.digest) {
      const errors = v.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
      throw new Violation("load_verification_failed", `A library the package carries does not pass the compiler's checks: ${[...new Set(errors)].join(", ") || "it does not read"}.`);
    }
    if (seen.has(v.name)) throw new Violation("library_digest_mismatch", `The package carries library ${v.name} twice.`);
    seen.add(v.name);
    const pin = Object.hasOwn(pins, v.name) ? pins[v.name] : undefined;
    if (!pin) throw new Violation("library_digest_mismatch", `The package carries library ${v.name}, which its lock does not pin.`);
    if (pin.digest !== v.digest) throw new Violation("library_digest_mismatch", `Library ${v.name} hashes to ${v.digest}; the lock pins ${pin.digest}.`);
    Object.assign(out, modulesOf(carried[i]!, v.name, pin.modules));
  });
  const missing = Object.keys(pins).filter((n) => n !== "std.patterns" && !seen.has(n)).sort();
  if (missing.length) throw new Violation("library_digest_mismatch", `The package does not carry ${missing.length === 1 ? "library" : "libraries"} ${missing.join(", ")}, which its lock pins: a package carries every library its lock pins.`);
  return out;
}

/**
 * Refuses a package whose lock pins, or which carries (`also`: a library by name, with the digest it hashes to), a
 * digest the configuration revokes (`library_revoked`): at load, and at every resume of a run of it.
 */
export function refuseRevoked(lock: Lock, o: LoadOptions, also: ReadonlyArray<readonly [string, string | undefined]> = []): void {
  const revoked = new Set(o.libraries?.revoked ?? []);
  if (!revoked.size) return;
  const named = [...Object.entries(isObj(lock.libraries) ? lock.libraries : {}).map(([n, p]) => [n, p?.digest] as const), ...also];
  const hit = [...new Set(named.filter(([, d]) => typeof d === "string" && revoked.has(d)).map(([n, d]) => `${n} (${d})`))].sort();
  if (hit.length) throw new Violation("library_revoked", `The package carries a revoked library digest: ${hit.join(", ")}. A revoked digest is never loaded (spec/library.md "Waiting period and revocation").`);
}

/** Each module of a library, loaded from its file, held to the program hash the lock pins it by (`library_digest_mismatch`). */
function modulesOf(library: LibrarySource, name: string, pins: Record<string, string>): Modules {
  const out: Modules = {};
  for (const [path, text] of Object.entries(library.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const loaded = load(text, kindOf(path));
    if (!loaded.program || loaded.diagnostics.some((d) => d.severity === "error")) throw new Violation("load_verification_failed", `Module file ${path} of library ${name} does not load.`);
    const m = loaded.program;
    const hash = hashProgram(m as unknown as Json).program;
    if (!Object.hasOwn(pins, m.module) || pins[m.module] !== hash) throw new Violation("library_digest_mismatch", `Module ${m.module} of library ${name} hashes to ${hash}; the lock pins ${Object.hasOwn(pins, m.module) ? pins[m.module] : "nothing"}.`);
    out[m.module] = m;
  }
  return out;
}

/**
 * The modules of the libraries a stored package carries, as a run links them: each loaded again from its text and
 * held to the program hash its lock pins it by, so that what a resume links is what was verified at the start.
 */
export function libraryModules(pkg: Pick<Package, "lock" | "libraries">): Modules {
  const pins = isObj(pkg.lock.libraries) ? pkg.lock.libraries : {};
  const out: Modules = {};
  for (const l of pkg.libraries ?? []) {
    let name: string | undefined;
    try {
      name = (JSON.parse(l.manifest) as { name?: unknown }).name as string | undefined;
    } catch {
      name = undefined;
    }
    const pin = typeof name === "string" && Object.hasOwn(pins, name) ? pins[name] : undefined;
    if (!pin) throw new Violation("library_digest_mismatch", `The package carries a library its lock does not pin (${String(name)}).`);
    Object.assign(out, modulesOf(l, name!, pin.modules));
  }
  return out;
}

/**
 * The check of a program of 0.6 at load: with the modules the package carries, its libraries, its lock and the
 * configuration's `libraries`, so that the libraries are held to the lock's pins (E1605, E1606, E1608) and every
 * other check runs as it would for `mandate check` with that lock. Gives the running program of a program of 0.6
 * (the check's `linked`): expanded, when it applies a pattern, and linked through what each library reaches. A
 * program of 0.6 that is given none, or one that applies a pattern and is given no expansion, or a running program
 * in which a workflow still applies one, is refused, as a failure of the compiler: nothing half expanded runs. A
 * package of 0.6 whose program is of an earlier language is given none, and runs as it is linked.
 *
 * A lock that pins no models is for simulated models only (as before 0.6, where the check is not given the lock):
 * with it the check holds every tier to the lock (E0141), and a program that does not check is given no expansion.
 * So then E0141 alone is left out of the check with the lock, and the expansion is that of the same check without
 * the lock, which holds the program to every rule but the lock's. A lock that pins models is held to every tier,
 * here and by `unlocked_model_tier`.
 */
function checked06(pkg: Package, modules: Modules, o: LoadOptions): Program | undefined {
  const text = canonicalize(pkg.program as unknown as Json);
  const config = o.libraries?.dir !== undefined ? { config: { dir: o.libraries.dir, ...(o.libraries.wait_days !== undefined ? { wait_days: o.libraries.wait_days } : {}), ...(o.libraries.revoked ? { revoked: o.libraries.revoked } : {}) } } : {};
  const read = { modules, ...(pkg.libraries?.length ? { libraries: pkg.libraries } : {}), ...config };
  const refused = (ds: Diagnostic[]): Violation => new Violation("load_verification_failed", `The program does not pass the compiler's checks: ${[...new Set(ds.map((d) => d.code))].join(", ")}.`);
  const given = { ...read, linked: true };
  const withLock = check(text, "json", { ...given, lock: formatted(pkg.lock, true) });
  const simulated = !pkg.lock.models && !pkg.lock.tariffs && !pkg.lock.bindings;
  const errors = withLock.diagnostics.filter((d) => d.severity === "error" && !(simulated && d.code === "MDT-E0141"));
  if (errors.length) throw refused(errors);
  const r = withLock.ok ? withLock : check(text, "json", given);
  if (!r.ok) throw refused(r.diagnostics.filter((d) => d.severity === "error"));
  const applying = applications(pkg.program);
  if (applying.length && !r.expanded) throw new Violation("load_verification_failed", `The program applies a pattern (${applying.join(", ")}), and the compiler gave no expansion of it.`);
  if (!applying.length && r.expanded) throw new Violation("load_verification_failed", "The program applies no pattern, and the compiler gave an expansion of it.");
  const linked = r.linked as unknown as Program | undefined;
  if (!isProgram06(pkg.program)) return undefined;
  if (!linked || !isObj(linked.defs)) throw new Violation("load_verification_failed", "The program is of mandate/0.6, and the compiler gave no running program of it.");
  const left = applications(linked);
  if (left.length) throw new Violation("load_verification_failed", `The running program the compiler gave still applies a pattern (${left.join(", ")}).`);
  const missing = Object.keys(pkg.program.defs).filter((n) => !Object.hasOwn(linked.defs, n));
  if (missing.length) throw new Violation("load_verification_failed", `The running program the compiler gave lacks the program's ${missing.sort().join(", ")}.`);
  return linked;
}
