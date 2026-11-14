// A package: a program with its lock and the modules it was checked with,
// under one hash (§3.5). `verifyPackage` is what the runtime holds a package
// to before it runs it. It trusts nobody who built one, itself included: an
// amended package (spec/envelope.md "Amendments") passes it like any other.

import { atLeast, bindingChecks, canonicalize, check, checkAmendment, envelopeChanges, hashProgram, link, linkedProgram, LOCK_FIELDS_0_5, LOCK_FORMAT, modelTiers, packageHash, roleLockChecks, sandboxLockChecks, semanticDiff, validateLock, type AmendmentCheck, type AmendmentInput, type Change, type DiffView, type Json, type LanguageVersion, type Lock, type Modules, type Program } from "@mandate/bridge";
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
 */
export function checkAmended(i: AmendedInput): AmendedCheck {
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

/**
 * A content-addressed package: the program, its hash, its lock, and the
 * imported modules it was checked with (a system model, design doc 9 §2.1).
 * The lock pins every module by its program hash, so the package hash covers
 * them too.
 */
export interface Package {
  hash: string;
  programHash: string;
  program: Program;
  lock: Lock;
  modules?: Modules;
}

/**
 * The language versions this runtime runs. Of 0.4 it runs roles, signed decisions, envelopes, `map` and `plan`; of
 * 0.5 the program and every field of its lock; see `notRunYet`.
 */
export const RUNTIME_LANGUAGES: readonly LanguageVersion[] = ["mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4", "mandate/0.5"];

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

/** A 0.4 package: its program, or a module it was packaged with, is written in 0.4. Its decisions are always signed. */
export function isSigned04(program: Program, modules: Modules = {}): boolean {
  return [program, ...Object.values(modules)].some((p) => atLeast(p.language, "mandate/0.4"));
}

export function buildPackage(program: Program, lock: Lock = { modules: {} }, modules: Modules = {}): Package {
  const programHash = hashProgram(program as unknown as Json).program;
  return { hash: packageHash(programHash, lock), programHash, program, lock, ...(Object.keys(modules).length ? { modules } : {}) };
}

/**
 * Load-time verification (§3.5, S09). The runtime does not trust whoever
 * built the package: it recomputes the hashes, requires every imported
 * module to be locked, and re-runs the compiler's checks.
 */
export function verifyPackage(pkg: Package): void {
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
  const unlocked = (pkg.program.uses ?? []).map((u) => u.module).filter((m) => m !== "std" && !m.startsWith("std.") && !Object.hasOwn(pkg.lock.modules, m));
  if (unlocked.length) throw new Violation("unlocked_module", `Imported modules are not locked: ${[...new Set(unlocked)].join(", ")}.`);
  // A module the package carries is the one the lock pins, byte for byte (S09, INV-02), and passes the checks itself.
  const modules = pkg.modules ?? {};
  for (const [name, m] of Object.entries(modules).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const hash = hashProgram(m as unknown as Json).program;
    if (m.module !== name || pkg.lock.modules[name] !== hash) throw new Violation("module_hash_mismatch", `Module ${name} hashes to ${hash}; the lock pins ${pkg.lock.modules[name] ?? "nothing"}.`);
    const others = Object.fromEntries(Object.entries(modules).filter(([n]) => n !== name));
    const mr = check(canonicalize(m as unknown as Json), "json", { modules: others });
    if (!mr.ok) throw new Violation("load_verification_failed", `Module ${name} does not pass the compiler's checks: ${mr.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).join(", ")}.`);
  }
  // A lock that pins models (spec/lock.md) must be well formed and pin every tier the program names.
  // A lock without models is for simulated models only; the Anthropic adapter refuses to run without one.
  // So must a lock that names members and roles: a key under two members, or a role held by nobody the lock lists, binds nothing.
  if (pkg.lock.models || pkg.lock.tariffs || pkg.lock.bindings || pkg.lock.members || pkg.lock.roles || LOCK_FIELDS_0_5.some((f) => pkg.lock[f])) {
    const bad = validateLock({ lock: LOCK_FORMAT, ...pkg.lock });
    if (bad.length) throw new Violation("malformed_lock", `The package's lock is malformed: ${bad.map((d) => d.message).join(" ")}`);
  }
  // What the lock asks of a sandbox applies to the program (E1802, E1803): a floor in the lock of a program whose
  // requirements carry no isolation level would not be enforced, so it is not run with.
  const misfit = sandboxLockChecks(linkedProgram(pkg.program, modules), pkg.lock).filter((d) => d.severity === "error");
  if (misfit.length) throw new Violation("load_verification_failed", `The package's lock does not apply to its program: ${misfit.map((d) => `${d.code} ${d.message}`).join(" ")}`);
  if (pkg.lock.models || pkg.lock.tariffs || pkg.lock.bindings) {
    const missing = [...modelTiers(pkg.program)].filter((t) => !Object.hasOwn(pkg.lock.models ?? {}, t)).sort();
    if (missing.length) throw new Violation("unlocked_model_tier", `Model tiers are not locked: ${missing.join(", ")} (MDT-E0141).`);
    // An executor binding that no longer fits the program and the lock is not run with (E0903–E0905, K45).
    const unfit = bindingChecks(linkedProgram(pkg.program, modules), pkg.lock).filter((d) => d.severity === "error");
    if (unfit.length) throw new Violation("unfit_binding", `The package's executor binding does not fit: ${unfit.map((d) => `${d.code} ${d.message}`).join(" ")}`);
  }
  const r = check(canonicalize(pkg.program as unknown as Json), "json", { modules });
  if (!r.ok) {
    throw new Violation("load_verification_failed", `The program does not pass the compiler's checks: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).join(", ")}.`);
  }
  // Every role a 0.4 package names has a member in its lock (E1502): a wait for a role nobody holds could never end.
  const unbound = roleLockChecks(pkg.program, link(pkg.program, modules), { lock: LOCK_FORMAT, ...pkg.lock });
  if (unbound.length) {
    const roles = [...new Set(unbound.map((d) => String((d.facts as { role?: unknown } | undefined)?.role)))].sort();
    throw new Violation("unbound_role", `The package's lock binds no member to ${roles.length === 1 ? "role" : "roles"} ${roles.join(", ")} (MDT-E1502).`);
  }
}
