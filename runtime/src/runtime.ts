// The control API (Doc 4 §16.1): StartRun, GetRun, SubmitInput, DecideAction,
// CancelRun, ReconcileAction, ReplayRun. A run is driven by a worker that
// holds its lease; a crash leaves the journal as it was, and `resume` starts a
// new worker with a higher fence that re-runs the body against the journal.

import { randomUUID } from "node:crypto";
import { bindingChecks, canonicalize, capsOf, check, domainHash, hashProgram, isLanguageVersion, LANGUAGE_VERSIONS, link, linkedProgram, LOCK_FORMAT, modelTiers, references, SANDBOX_DENIALS_FORMAT, validateLock, type DenialReport, type Json, type Lock, type Modules, type Program } from "@mandate/compiler";
import type { Adapters, Cost, RunComponents, RunMode } from "./adapters.js";
import type { WorkspaceComponent } from "./workspace.js";
import { ArtifactStore, MemoryBlobs, type ArtifactRef } from "./artifacts.js";
import { attestationProblem } from "./attestation.js";
import { EvidenceSigner, TrustedKeys, type EvidenceRecord } from "./evidence.js";
import { RateLimiter, type BucketConfig } from "./ratelimit.js";
import type { Db, Row } from "./db.js";
import { Faults } from "./faults.js";
import { schemaErrors, typeSchema } from "./schema.js";
import { Interpreter, ReplayEnd, type Policy } from "./interp.js";
import { costDims, Journal, TERMINAL, type ActionRow, type BudgetReport, type EvidenceRow, type RunRow } from "./journal.js";
import { Attention, Cancelled, Crash, Fault, StaleFence, Suspend, Violation } from "./signals.js";
import { digest, isObj, type Obj, type Value } from "./values.js";

export type { Lock };

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

export function buildPackage(program: Program, lock: Lock = { modules: {} }, modules: Modules = {}): Package {
  const programHash = hashProgram(program as unknown as Json).program;
  return { hash: domainHash("package", { program: programHash, lock } as unknown as Json), programHash, program, lock, ...(Object.keys(modules).length ? { modules } : {}) };
}

/**
 * Load-time verification (§3.5, S09). The runtime does not trust whoever
 * built the package: it recomputes the hashes, requires every imported
 * module to be locked, and re-runs the compiler's checks.
 */
export function verifyPackage(pkg: Package): void {
  if (!isLanguageVersion(pkg.program.language)) throw new Violation("unsupported_language", `Package language ${String(pkg.program.language)} is not one of ${LANGUAGE_VERSIONS.join(", ")}.`);
  const programHash = hashProgram(pkg.program as unknown as Json).program;
  if (programHash !== pkg.programHash) throw new Violation("package_hash_mismatch", `The program hashes to ${programHash}, not the packaged ${pkg.programHash}.`);
  if (domainHash("package", { program: programHash, lock: pkg.lock } as unknown as Json) !== pkg.hash) {
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
  if (pkg.lock.models || pkg.lock.tariffs || pkg.lock.bindings) {
    const bad = validateLock({ lock: LOCK_FORMAT, ...pkg.lock });
    if (bad.length) throw new Violation("malformed_lock", `The package's lock is malformed: ${bad.map((d) => d.message).join(" ")}`);
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
}

export interface StartOptions {
  pkg: Package;
  workflow: string;
  input: Obj;
  tenant?: string;
  runId?: string;
  /** Caller limits; the run gets the minimum of these and the workflow's budget. */
  limits?: Cost;
  authorize?: Policy["authorize"];
  authorizationTtlMs?: number;
  /** Priority class in shared rate limits (§8.6). */
  priority?: Policy["priority"];
  /** How the run touches the outside world (design doc 9 §5.2): `live` (default), `read_only` or `design`. */
  mode?: RunMode;
}

export interface Message {
  sender: string;
  messageId: string;
}

export type ReplayResult =
  | { status: "complete"; value: Value }
  | { status: "partial"; stoppedAt: string }
  | { status: "incomplete_replay"; missing: string }
  | { status: "failed"; error: Value }
  | { status: "attention_required"; reason: Value };

/**
 * Who moves a run forward after a control call. Without one, the caller's
 * process does it inline (`resume`). With one, such as the Temporal driver,
 * control calls only record their decision in PostgreSQL and wake the run's
 * scheduler, which calls `resume` from its own worker.
 */
export interface Driver {
  start(runId: string): Promise<void>;
  wake(runId: string): Promise<void>;
}

/** What a runtime keeps besides PostgreSQL. */
export interface RuntimeOptions {
  /** Artifact bytes (§16.1). Default: in memory, indexed in PostgreSQL. */
  artifacts?: ArtifactStore;
  /** The control plane's evidence key (§10.3). Default: a new key for this process. */
  signer?: EvidenceSigner;
  /** Other public keys whose evidence this runtime accepts, e.g. an earlier key. Its own always counts. */
  trustedKeys?: string[];
  /**
   * Public keys of verifiers that run as processes of their own (P2-11).
   * A check that carries a verifier attestation counts only when one of
   * these signed it.
   */
  trustedVerifiers?: TrustedKeys;
  /**
   * A run's timers (a restart's backoff) are kept by its scheduler: the run
   * waits, and `tick` resumes it when the time comes. A Temporal worker's
   * runtime needs this; without it, the worker sleeps through the wait.
   */
  durableTimers?: boolean;
  /** Rate limits shared by every run on this database (§8.6), by bucket: `model`, `model:<tier>`, `tool`. */
  rateLimits?: Record<string, BucketConfig>;
}

export class Runtime {
  readonly journal: Journal;
  readonly faults: Faults;
  readonly artifacts: ArtifactStore;
  readonly signer: EvidenceSigner;
  readonly trusted: TrustedKeys;
  readonly verifiers: TrustedKeys;
  readonly durableTimers: boolean;
  readonly limiter: RateLimiter | undefined;
  private readonly packages = new Map<string, Package>();

  constructor(
    readonly db: Db,
    readonly adapters: Adapters,
    faults?: Faults,
    readonly driver?: Driver,
    options: RuntimeOptions = {},
  ) {
    this.journal = new Journal(db, () => adapters.clock.now());
    this.faults = faults ?? new Faults();
    this.artifacts = options.artifacts ?? new ArtifactStore(db, new MemoryBlobs(), () => adapters.clock.now());
    this.signer = options.signer ?? EvidenceSigner.generate();
    this.trusted = new TrustedKeys([this.signer.publicKey, ...(options.trustedKeys ?? [])]);
    this.verifiers = options.trustedVerifiers ?? new TrustedKeys();
    this.durableTimers = options.durableTimers ?? false;
    this.limiter = options.rateLimits && Object.keys(options.rateLimits).length ? new RateLimiter(db, options.rateLimits, () => adapters.clock.now()) : undefined;
  }

  // ── StartRun / resume ─────────────────────────────────────────────────

  async startRun(o: StartOptions): Promise<RunRow> {
    verifyPackage(o.pkg);
    const wf = o.pkg.program.defs[o.workflow];
    if (!wf || wf.kind !== "workflow") throw new Violation("unknown_workflow", `No workflow '${o.workflow}'.`);
    const linked = linkedProgram(o.pkg.program, o.pkg.modules);
    // The input is a value of the workflow's parameter types, as a model's answer is of its type: a Path in it keeps the Path rule (K68).
    const input = isObj(o.input ?? null) ? (o.input as Obj) : {};
    for (const p of wf.params) {
      if (!Object.hasOwn(input, p.name)) continue;
      const problems = schemaErrors(typeSchema(linked, p.type), input[p.name]!);
      if (problems.length) throw new Violation("input_mismatch", `Input '${p.name}' of ${o.workflow} does not fit its type: ${problems.join(", ")}.`);
    }
    await this.validateBindings(linked, o.workflow);
    await this.validateExecutor(o.pkg);
    const lowered = this.remoteGuarantees(o.pkg.program);
    const runId = o.runId ?? randomUUID();
    const limits = minLimits(costDims(wf.budget), costDims(o.limits));
    const policy: Policy = { tenant: o.tenant ?? "default", ...(o.authorize ? { authorize: o.authorize } : {}), ...(o.authorizationTtlMs ? { authorizationTtlMs: o.authorizationTtlMs } : {}), ...(o.priority ? { priority: o.priority } : {}) };
    // The components the program works on start from one base commit each, recorded in the run's manifest (B3).
    const components = await this.prepareWorkspace(runId, o.pkg);
    const manifest = { format: RUN_MANIFEST_FORMAT, package: o.pkg.hash, workflow: o.workflow, tenant: policy.tenant, input: digest("request", o.input), mode: o.mode ?? "live", components } as unknown as Value;
    const manifestHash = digest("run", manifest);
    await this.db.tx(async (tx) => {
      await tx.query("insert into packages (package_hash, program, lock, modules) values ($1, $2, $3, $4) on conflict (package_hash) do nothing", [
        o.pkg.hash,
        JSON.stringify(o.pkg.program),
        JSON.stringify(o.pkg.lock),
        JSON.stringify(o.pkg.modules ?? {}),
      ]);
      await this.journal.createRun(tx, { runId, tenant: policy.tenant, packageHash: o.pkg.hash, workflow: o.workflow, input: o.input, policy: policy as unknown as Value, limits, manifest, manifestHash });
      for (const agent of lowered) await this.journal.event(tx, runId, "guarantee_lowered", { agent, delivery: "at_most_once", reason: "the remote agent's server does not deduplicate messages" });
    });
    this.packages.set(o.pkg.hash, o.pkg);
    return this.drive(runId, true);
  }

  /**
   * The working copies of the components a package's program works on
   * (design doc 9 §12, B3). Their roots are claimed for this run first, so a
   * root another unfinished run holds is refused before anything in it is
   * touched (`workspace_busy`); then the workspace adapter checks each one out
   * at its base commit. A program that works on components and a runtime
   * without a workspace adapter do not start (INV-11).
   */
  private async prepareWorkspace(runId: string, pkg: Package): Promise<RunComponents> {
    const wanted = componentsOf(pkg);
    if (!wanted.length) return {};
    const ws = this.adapters.workspace;
    if (!ws) throw new Violation("no_workspace", `The program works on components (${wanted.map((c) => c.name).join(", ")}), and this runtime has no workspace adapter.`);
    await this.db.tx(async (tx) => {
      for (const c of wanted) {
        const [held] = await tx.query<Row>("select w.run_id, w.claimed_at, r.state from workspace_claims w left join runs r on r.run_id = w.run_id where w.root = $1 for update of w", [c.root]);
        if (held && held["run_id"] !== runId) {
          // A claim whose run never got created is stale after ten minutes (a start that died between claim and run).
          const live = held["state"] ? !TERMINAL.has(held["state"] as RunRow["state"]) : this.adapters.clock.now() - Number(held["claimed_at"]) < 600_000;
          if (live) throw new Violation("workspace_busy", `${c.name}'s working copy ${c.root} is in use by run ${String(held["run_id"])}.`);
        }
        await tx.query("insert into workspace_claims (root, run_id, claimed_at) values ($1, $2, $3) on conflict (root) do update set run_id = $2, claimed_at = $3", [c.root, runId, this.adapters.clock.now()]);
      }
    });
    let bases: Record<string, { base: string }>;
    try {
      bases = await ws.prepare(wanted);
    } catch (e) {
      await this.db.query("delete from workspace_claims where run_id = $1", [runId]);
      throw new Violation("workspace_failed", `The components' working copies could not be prepared: ${(e as Error).message}`);
    }
    const out: RunComponents = {};
    for (const c of wanted) {
      const base = bases[c.name]?.base;
      if (!base) throw new Violation("workspace_failed", `The workspace adapter gave no base commit for ${c.name}.`);
      out[c.name] = { repo: c.repo, root: c.root, base };
    }
    return out;
  }

  /**
   * Asks every tool adapter the workflow can reach whether it serves the
   * program's binding (§16.1 ValidateBinding). A `git.*` effect is bound to the
   * repositories of the workflow's `git.pr(…)` capabilities. A run whose
   * effects an adapter cannot serve does not start.
   */
  private async validateBindings(program: Program, workflow: string): Promise<void> {
    const wf = program.defs[workflow];
    if (wf?.kind !== "workflow") return;
    const effects = new Set<string>();
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") {
        const node = v as { op?: unknown; name?: unknown };
        if (node.op === "effect" && typeof node.name === "string") effects.add(node.name);
        Object.values(v).forEach(visit);
      }
    };
    visit(wf);
    const repos = wf.caps.flatMap((c) => capsOf(program.defs, c)).filter((c) => c.ctor === "git.pr").flatMap((c) => c.scope ?? []);
    for (const name of [...effects].sort()) {
      const tool = this.adapters.tools[name];
      if (!tool?.validateBinding) continue;
      const r = await tool.validateBinding({ repos: name.startsWith("git.") ? repos : [] });
      if ("unsupported" in r) throw new Violation("unsupported_binding", `The adapter for ${name} cannot serve this program: ${r.unsupported}.`);
    }
  }

  /**
   * The executor the lock binds agents to (K45). A bound agent is never run
   * anywhere else: a runtime without that executor, or whose executor no
   * longer has what was deployed, does not start the run (ValidateBinding,
   * §16.1; INV-11).
   */
  private async validateExecutor(pkg: Package): Promise<void> {
    const b = pkg.lock.bindings?.["managed-agents"];
    if (!b) return;
    const agents = Object.keys(b.agents).sort();
    const ex = this.adapters.loop?.executor;
    if (ex?.name !== "managed-agents") throw new Violation("no_executor", `The lock binds ${agents.join(", ")} to Managed Agents, and this runtime has no Managed Agents executor.`);
    const unserved = agents.filter((a) => !Object.hasOwn(ex.chats, a));
    if (unserved.length) throw new Violation("no_executor", `The Managed Agents executor does not serve ${unserved.join(", ")}.`);
    const r = await ex.validateBinding();
    if ("unsupported" in r) throw new Violation("unsupported_binding", `The Managed Agents binding does not hold: ${r.unsupported}.`);
  }

  /**
   * Remote agents whose servers do not deduplicate messages (§9.6, G12). A
   * program that requires it (`require idempotent_messages`) does not start
   * against such an adapter; otherwise the guarantee is lowered, recorded
   * at start, and each task is sent at most once.
   */
  private remoteGuarantees(program: Program): string[] {
    const lowered: string[] = [];
    for (const [name, d] of Object.entries(program.defs).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (d.kind !== "agent" || !d.remote) continue;
      if (this.adapters.agents.remoteProfile?.(name)?.idempotentMessages) continue;
      const required = (d.remote.require ?? []).some((e) => (e.op === "var" ? e.name : e.op === "call" && e.callee.op === "var" ? e.callee.name : "") === "idempotent_messages");
      if (required) throw new Violation("unsupported_binding", `${name} requires idempotent message delivery, and its adapter's server does not deduplicate messages (G12).`);
      lowered.push(name);
    }
    return lowered;
  }

  private async drive(runId: string, start = false): Promise<RunRow> {
    if (!this.driver) return this.resume(runId);
    await (start ? this.driver.start(runId) : this.driver.wake(runId));
    return this.journal.run(runId);
  }

  /** Starts a new worker on the run: takes the lease (fence + 1) and drives the body against the journal. */
  async resume(runId: string): Promise<RunRow> {
    const { run, fence } = await this.journal.acquire(runId);
    if (TERMINAL.has(run.state)) return run;
    const program = await this.program(run.package_hash);
    await this.write(runId, fence, async (tx) => this.journal.setState(tx, runId, "running"));
    const interp = this.interpreter(run, program, fence, false, this.adapters);
    try {
      const result = await interp.runWorkflow(run.workflow, run.input as Obj);
      await this.finish(runId, fence, { state: "succeeded", result });
    } catch (e) {
      if (e instanceof Crash) throw e;
      if (e instanceof StaleFence) return this.journal.run(runId);
      await this.settle(runId, fence, e, interp);
    }
    return this.journal.run(runId);
  }

  private async settle(runId: string, fence: number, e: unknown, interp: Interpreter): Promise<void> {
    if (e instanceof Suspend) return this.finish(runId, fence, { state: "waiting", waiting: e.waiting });
    if (e instanceof Attention) return this.finish(runId, fence, { state: "attention_required", attention: e.reason });
    if (e instanceof Cancelled) return this.closeCancelled(runId, fence);
    if (e instanceof Violation) {
      // An invariant violation is never handed to the program; the run stops for a person (§8.7).
      return this.finish(runId, fence, { state: "attention_required", attention: { violation: e.code, message: e.message } });
    }
    if (e instanceof Fault) {
      if (e.tag === "BudgetExceeded") return this.budgetExceeded(runId, fence, e, interp);
      return this.fail(runId, fence, e);
    }
    throw e;
  }

  private async fail(runId: string, fence: number, e: Fault): Promise<void> {
    const open = await this.openActions(runId);
    if (open.length) return this.finish(runId, fence, { state: "attention_required", attention: { error: e.value(), open_actions: open } });
    return this.finish(runId, fence, { state: "failed", error: e.value() });
  }

  /**
   * A reservation did not fit (§8.6). The workflow's `on budget_exceeded`
   * handler runs; without one, the run pauses for a person. Each time the
   * budget runs out is an episode with its own waits. Once its question is
   * answered, the run tries again from the command that did not fit, which
   * fits if a person raised the limits (`raiseLimits`), and otherwise opens
   * the next episode.
   */
  private async budgetExceeded(runId: string, fence: number, e: Fault, interp: Interpreter): Promise<void> {
    const run = await this.journal.run(runId);
    const handler = (interp.workflowDef(run.workflow).on ?? []).some((h) => h.event === "budget_exceeded");
    const last = await this.journal.budgetEpisode(runId);
    let episode = last ?? 0;
    let opened = last !== null;
    try {
      for (;;) {
        if (!opened) await this.write(runId, fence, (tx) => this.journal.event(tx, runId, "budget_exceeded", { episode, detail: e.value() }));
        try {
          await interp.onBudgetExceeded(run.workflow, run.input as Obj, episode);
        } catch (s) {
          if (!(s instanceof Suspend)) throw s;
          const w = isObj(s.waiting) ? s.waiting : {};
          return await this.finish(runId, fence, {
            state: "waiting",
            waiting: { kind: "budget_exceeded", detail: e.value(), handler, episode, command: w["command"] ?? null, request: w["request"] ?? null },
          });
        }
        // A handler that asks nobody leaves the run failed.
        if (!opened) return await this.fail(runId, fence, e);
        // This episode was answered and the budget ran out again.
        episode++;
        opened = false;
      }
    } catch (s) {
      if (s instanceof StaleFence) return;
      if (s instanceof Fault) return this.fail(runId, fence, s);
      if (s instanceof Violation) return this.finish(runId, fence, { state: "attention_required", attention: { violation: s.code, message: s.message } });
      throw s;
    }
  }

  /** Writes the run's state only while this worker still holds the lease. */
  private async finish(runId: string, fence: number, s: { state: RunRow["state"]; result?: Value; error?: Value; waiting?: Value; attention?: Value; summary?: Value }): Promise<void> {
    if (s.state === "succeeded") {
      const open = await this.openActions(runId);
      if (open.length) s = { state: "attention_required", attention: { open_actions: open } };
    }
    const { state, ...fields } = s;
    await this.write(runId, fence, (tx) => this.journal.setState(tx, runId, state, fields));
  }

  private async write(runId: string, fence: number, fn: (tx: Parameters<Parameters<Db["tx"]>[0]>[0]) => Promise<void>): Promise<void> {
    try {
      await this.db.tx(async (tx) => {
        await this.journal.lock(tx, runId, fence);
        await fn(tx);
      });
    } catch (e) {
      if (!(e instanceof StaleFence)) throw e;
    }
  }

  /** External actions without a final result: no clean terminal state while any exists (R10, INV-12). */
  private async openActions(runId: string): Promise<Value[]> {
    const rows = await this.journal.actions(runId);
    return rows.filter((a) => a.state === "dispatched" || a.state === "unknown_outcome").map((a) => ({ operation: a.operation_key, effect: a.effect, state: a.state }));
  }

  private async closeCancelled(runId: string, fence?: number): Promise<void> {
    const actions = await this.journal.actions(runId);
    const summary = {
      effects_completed_before_or_during_cancel: actions.filter((a) => a.state === "confirmed").map((a: ActionRow) => ({ effect: a.effect, operation: a.operation_key })),
    };
    const open = await this.openActions(runId);
    const target = open.length ? { state: "attention_required" as const, attention: { open_actions: open }, summary } : { state: "cancelled" as const, summary };
    if (fence === undefined) {
      await this.db.tx(async (tx) => {
        await this.journal.lock(tx, runId);
        const { state, ...fields } = target;
        await this.journal.setState(tx, runId, state, fields);
      });
    } else await this.finish(runId, fence, target);
  }

  private interpreter(run: RunRow, program: Program, fence: number, replay: boolean, adapters: Adapters): Interpreter {
    return new Interpreter({
      journal: this.journal,
      adapters,
      program,
      packageHash: run.package_hash,
      runId: run.run_id,
      fence,
      policy: run.policy as unknown as Policy,
      faults: this.faults,
      artifacts: this.artifacts,
      signer: this.signer,
      trusted: this.trusted,
      verifiers: this.verifiers,
      ...(isObj(run.manifest) && isObj(run.manifest["components"] ?? null) ? { workspace: run.manifest["components"] as unknown as RunComponents } : {}),
      ...(isObj(run.manifest) && typeof run.manifest["mode"] === "string" ? { mode: run.manifest["mode"] as RunMode } : {}),
      replay,
      durableTimers: this.durableTimers,
      ...(this.limiter ? { limiter: this.limiter } : {}),
    });
  }

  /** The program and modules of a package, as packaged. */
  private async packaged(packageHash: string): Promise<{ program: Program; modules: Modules }> {
    const cached = this.packages.get(packageHash);
    if (cached) return { program: cached.program, modules: cached.modules ?? {} };
    const [row] = await this.db.query<Row>("select program, modules from packages where package_hash = $1", [packageHash]);
    if (!row) throw new Violation("unknown_package", `No package ${packageHash}.`);
    return { program: row["program"] as Program, modules: (row["modules"] ?? {}) as Modules };
  }

  /** The package's program with its imported modules linked in: what the interpreter runs. Never hashed. */
  private async program(packageHash: string): Promise<Program> {
    const p = await this.packaged(packageHash);
    return linkedProgram(p.program, p.modules);
  }

  // ── GetRun ────────────────────────────────────────────────────────────

  getRun(runId: string): Promise<RunRow> {
    return this.journal.run(runId);
  }

  /** The run's budget table: limits, settled, reserved and available per dimension, and each command's share (§8.6). */
  budgetReport(runId: string): Promise<BudgetReport> {
    return this.journal.budgetReport(runId);
  }

  /** Contract criteria results recorded for the run: the evidence behind its Verified values (§10). */
  evidence(runId: string): Promise<EvidenceRow[]> {
    return this.journal.evidence(runId);
  }

  /**
   * Checks every evidence record of a run against its signature: whether a
   * trusted key signed exactly this record (§10.3), and, for a check made by
   * a verifier of its own, whether a trusted verifier key attested the same
   * result (P2-11). Views show the result.
   */
  async verifyEvidence(runId: string): Promise<Array<{ evidence_id: string; criterion: string; valid: boolean; key_id: string | null }>> {
    return (await this.journal.evidence(runId)).map((e) => ({
      evidence_id: e.evidence_id,
      criterion: e.criterion,
      key_id: e.key_id,
      valid: !!e.record && !!e.key_id && !!e.signature && this.trusted.verify(e.record as unknown as EvidenceRecord, { key_id: e.key_id, signature: e.signature }) && (e.record as unknown as EvidenceRecord).evidence_id === e.evidence_id && (e.record as unknown as EvidenceRecord).passed === e.passed && !attestationProblem(e.record as unknown as EvidenceRecord, this.verifiers),
    }));
  }

  /**
   * What the run's sandboxes denied in learning mode (§16.1 Collect), by
   * agent, as the report `mandate check --denials` turns into W0311.
   */
  async sandboxDenials(runId: string): Promise<DenialReport> {
    const run = await this.journal.run(runId);
    const { program } = await this.packaged(run.package_hash);
    const labels = new Map((await this.db.query<Row>("select command_id, label from commands where run_id = $1", [runId])).map((r) => [String(r["command_id"]), String(r["label"] ?? "")]));
    const denials: DenialReport["denials"] = [];
    for (const e of await this.journal.events(runId)) {
      if (e.type !== "command_completed" || !isObj(e.data)) continue;
      const meta = isObj(e.data["meta"] ?? null) ? (e.data["meta"] as Obj) : undefined;
      const found = meta && Array.isArray(meta["sandbox_denials"]) ? meta["sandbox_denials"] : [];
      const agent = (labels.get(String(e.data["command"])) ?? "").split(".")[0] ?? "";
      for (const d of found) if (isObj(d)) denials.push({ agent, resource: String(d["resource"]), access: String(d["access"]) });
    }
    return { format: SANDBOX_DENIALS_FORMAT, program: hashProgram(program as unknown as Json).program, denials };
  }

  /** An artifact of a run, scoped by the run's tenant: another run's or tenant's digest is refused like a missing one (G08). */
  async artifact(runId: string, ref: string, tenant?: string): Promise<{ bytes: Uint8Array; media_type: string; digest: string }> {
    const run = await this.journal.run(runId);
    if (tenant !== undefined && tenant !== run.tenant) throw new Violation("artifact_not_found", "No such artifact in this run.");
    return this.artifacts.get({ tenant: run.tenant, runId }, ref);
  }

  async artifactList(runId: string): Promise<ArtifactRef[]> {
    const run = await this.journal.run(runId);
    return this.artifacts.list({ tenant: run.tenant, runId });
  }

  // ── SubmitInput / DecideAction ────────────────────────────────────────

  /**
   * Answers a wait opened by human.ask, escalate or pause; then resumes the
   * run. `revision` is the run revision the answer was given on (GetRun).
   */
  async submitInput(runId: string, msg: Message, i: { commandId: string; revision: number; value: Value }): Promise<RunRow> {
    const fresh = await this.resolveWait(runId, msg, i.commandId, i.revision, "input", i as unknown as Value, async () => ({ state: "succeeded", result: i.value }));
    return fresh ? this.drive(runId) : this.journal.run(runId);
  }

  /**
   * A person's decision. It applies only to the digest they saw (G02) and
   * only before the wait's deadline (R15). The wait is either:
   *
   * - a prepared action (`request.action_digest`): an approval becomes an
   *   authorization bound to that digest;
   * - a contract criterion `human.approve` (`request.subject_digest`): an
   *   approval is evidence for the criterion and authorizes nothing.
   *
   * `revision` is the run revision the person decided on (GetRun). A
   * decision made on an older view is refused with `stale_revision`.
   */
  async decideAction(runId: string, msg: Message, d: { commandId: string; revision: number; digest: string; approve: boolean; by: string }): Promise<RunRow> {
    type Resolution = { state: "succeeded"; result: Value } | { state: "failed"; error: Value };
    const fresh = await this.resolveWait(runId, msg, d.commandId, d.revision, "decision", d as unknown as Value, async (tx, request, run): Promise<Resolution> => {
      const criterion = isObj(request) && typeof request["subject_digest"] === "string";
      // The code owner's own decision on a governance-class file (K70): a gate before the action's authorization, not one.
      const gate = isObj(request) && request["gate"] === "governance";
      const bound = isObj(request) ? (criterion ? request["subject_digest"] : request["action_digest"]) : undefined;
      if (bound !== d.digest) {
        throw new Violation("decision_digest_mismatch", "The decision names something other than what is waiting for approval.");
      }
      const deadline = isObj(request) ? request["deadline"] : null;
      if (typeof deadline === "number" && this.adapters.clock.now() >= deadline) {
        return { state: "failed", error: { tag: "Rejected", args: ["approval_expired"] } };
      }
      if (!d.approve || criterion || gate) {
        if (criterion) await this.journal.event(tx, runId, d.approve ? "criterion_approved" : "criterion_denied", { command: d.commandId, by: d.by });
        if (gate) await this.journal.event(tx, runId, d.approve ? "governance_approved" : "governance_denied", { command: d.commandId, digest: d.digest, by: d.by });
        return { state: "succeeded", result: { approved: d.approve, by: d.by } };
      }
      const id = digest("operation", { authorize: d.digest, by: d.by, message: msg.messageId });
      const ttl = (run.policy as unknown as Policy).authorizationTtlMs ?? 15 * 60_000;
      await tx.query("insert into authorizations (authorization_id, run_id, action_digest, decided_by, expires_at) values ($1, $2, $3, $4, $5) on conflict do nothing", [
        id,
        runId,
        d.digest,
        d.by,
        this.adapters.clock.now() + ttl,
      ]);
      await this.journal.event(tx, runId, "action_authorized", { authorization: id, digest: d.digest, by: d.by });
      return { state: "succeeded", result: { approved: true, by: d.by, authorization_id: id } };
    });
    return fresh ? this.drive(runId) : this.journal.run(runId);
  }

  /**
   * Raises a run's limits after `budget_exceeded` (§8.6). This is a
   * governance change (§13.2): a person makes it, it is recorded with who
   * made it, and it can only raise a limit, never lower one. It stops at the
   * workflow's own budget, which only a new program version can change. Like
   * a decision, it names the revision it was made on and is deduplicated by
   * message. The run itself goes on when its `budget_exceeded` question is
   * answered.
   */
  async raiseLimits(runId: string, msg: Message, r: { revision: number; limits: Cost; by: string }): Promise<RunRow> {
    const seen = await this.journal.run(runId);
    const wf = (await this.program(seen.package_hash)).defs[seen.workflow];
    const program = costDims(wf?.kind === "workflow" ? wf.budget : undefined);
    const wanted = costDims(r.limits);
    await this.db.tx(async (tx) => {
      const run = await this.journal.lock(tx, runId);
      const fresh = await this.journal.inbox(tx, { tenant: run.tenant, sender: msg.sender, messageId: msg.messageId, payloadDigest: digest("request", r as unknown as Value) });
      if (!fresh) return;
      if (run.revision !== r.revision) throw new Violation("stale_revision", `The raise was made on revision ${r.revision}; run ${runId} is at revision ${run.revision}.`);
      if (TERMINAL.has(run.state)) throw new Violation("run_ended", `Run ${runId} has ended (${run.state}).`);
      for (const [dim, limit] of Object.entries(wanted)) {
        if (dim in program && limit > program[dim]!) {
          throw new Violation("above_program_budget", `${run.workflow} declares a ${dim} budget of ${program[dim]}; raising the run to ${limit} needs a new program version (§13.2).`);
        }
      }
      const before = await this.journal.raiseLimits(tx, runId, wanted);
      await this.journal.event(tx, runId, "limits_raised", { by: r.by, sender: msg.sender, message: msg.messageId, from: before, to: wanted });
    });
    return this.journal.run(runId);
  }

  /**
   * Acts on a wait whose deadline has passed: a decision expires, so nothing
   * is dispatched after its deadline (R15); a timer is due, so the run goes on.
   */
  async tick(runId: string): Promise<RunRow> {
    const run = await this.journal.run(runId);
    const w = run.waiting;
    if (run.state !== "waiting" || !isObj(w)) return run;
    const req = w["request"];
    const deadline = isObj(req) ? req["deadline"] : null;
    if (typeof deadline !== "number" || this.adapters.clock.now() < deadline) return run;
    if (w["kind"] === "timer") return this.drive(runId);
    if (w["kind"] !== "decision") return run;
    await this.db.tx(async (tx) => {
      await this.journal.lock(tx, runId);
      await tx.query("update commands set state = 'failed', error = $3 where run_id = $1 and command_id = $2 and state = 'waiting'", [
        runId,
        String(w["command"]),
        JSON.stringify({ tag: "Rejected", args: ["approval_expired"] }),
      ]);
      await this.journal.event(tx, runId, "wait_expired", { command: String(w["command"]) });
    });
    return this.drive(runId);
  }

  private async resolveWait(
    runId: string,
    msg: Message,
    commandId: string,
    revision: number,
    kind: "input" | "decision",
    payload: Value,
    resolve: (tx: Parameters<Parameters<Db["tx"]>[0]>[0], request: Value, run: RunRow) => Promise<{ state: "succeeded"; result: Value } | { state: "failed"; error: Value }>,
  ): Promise<boolean> {
    return this.db.tx(async (tx) => {
      const run = await this.journal.lock(tx, runId);
      const fresh = await this.journal.inbox(tx, { tenant: run.tenant, sender: msg.sender, messageId: msg.messageId, payloadDigest: digest("request", payload) });
      if (!fresh) return false;
      // The answer was given on what the caller last saw; if the run moved on since, it must look again (§16.1).
      if (run.revision !== revision) {
        throw new Violation("stale_revision", `The ${kind} was given on revision ${revision}; run ${runId} is at revision ${run.revision}.`);
      }
      const [row] = await tx.query<Row>("select kind, state, result from commands where run_id = $1 and command_id = $2", [runId, commandId]);
      if (!row || row["kind"] !== kind || row["state"] !== "waiting") throw new Violation("no_wait", `Run ${runId} is not waiting for ${kind} at ${commandId}.`);
      // Everything inside goes through `tx`: an in-process database has one connection.
      const r = await resolve(tx, row["result"] as Value, run);
      await tx.query("update commands set state = $3, result = $4, error = $5 where run_id = $1 and command_id = $2", [
        runId,
        commandId,
        r.state,
        JSON.stringify("result" in r ? r.result : null),
        JSON.stringify("error" in r ? r.error : null),
      ]);
      await this.journal.event(tx, runId, kind === "input" ? "input_received" : "decision_received", { command: commandId, sender: msg.sender, message: msg.messageId });
      return true;
    });
  }

  // ── CancelRun ─────────────────────────────────────────────────────────

  /**
   * Cancellation is an event, not erasure (§8.9). It is ordered against
   * dispatch on the run's row: a dispatch after it is refused (R08); one
   * before it is followed to its real result (R09).
   */
  async cancelRun(runId: string): Promise<RunRow> {
    const idle = await this.db.tx(async (tx) => {
      const run = await this.journal.lock(tx, runId);
      if (TERMINAL.has(run.state)) return false;
      await tx.query("update runs set cancel_requested = true, revision = revision + 1 where run_id = $1", [runId]);
      await this.journal.event(tx, runId, "cancel_requested", {});
      return run.state === "waiting" || run.state === "accepted" || run.state === "attention_required";
    });
    // An action whose outcome is unknown is asked to stop: an adapter that can prove it never took effect resolves it.
    for (const a of await this.journal.actions(runId)) {
      if (a.state === "unknown_outcome") await this.cancelAction(runId, a.operation_key);
    }
    if (idle) await this.closeCancelled(runId);
    if (this.driver) await this.driver.wake(runId);
    return this.journal.run(runId);
  }

  /**
   * Asks the adapter to stop an action (§16.1 Cancel). Cancelled, with the
   * adapter's proof: the action is resolved as never applied. Too late: it was
   * applied, and its receipt is recorded. Unknown, or an adapter without
   * Cancel: nothing changes.
   */
  async cancelAction(runId: string, operationKey: string): Promise<RunRow> {
    const action = await this.journal.action(operationKey);
    if (!action || action.run_id !== runId) throw new Violation("unknown_action", `No action ${operationKey} in run ${runId}.`);
    const tool = this.adapters.tools[action.effect];
    if (tool?.cancel && (action.state === "unknown_outcome" || action.state === "prepared")) {
      const r = await tool.cancel(operationKey);
      if ("cancelled" in r) await this.journal.finishAction(runId, undefined, operationKey, "cancelled", { detail: { cancelled: r.cancelled } });
      else if ("tooLate" in r) await this.journal.finishAction(runId, undefined, operationKey, "confirmed", { receipt: r.tooLate });
    }
    return this.journal.run(runId);
  }

  // ── ReconcileAction ───────────────────────────────────────────────────

  /**
   * Asks the adapter what happened to an action with an unknown outcome.
   * Applied: the receipt is recorded. Not applied (with the adapter's proof):
   * the action may be sent again under the same operation key. Unknown: it
   * stays open.
   */
  async reconcileAction(runId: string, operationKey: string): Promise<RunRow> {
    const action = await this.journal.action(operationKey);
    if (!action || action.run_id !== runId) throw new Violation("unknown_action", `No action ${operationKey} in run ${runId}.`);
    const tool = this.adapters.tools[action.effect];
    if (!tool) throw new Violation("no_adapter", `No adapter for effect ${action.effect}.`);
    const r = await tool.reconcile(operationKey);
    if ("applied" in r) await this.journal.finishAction(runId, undefined, operationKey, "confirmed", { receipt: r.applied });
    else if ("notApplied" in r) await this.journal.finishAction(runId, undefined, operationKey, "prepared", { detail: { not_applied: r.notApplied } });
    else return this.journal.run(runId);
    return this.drive(runId);
  }

  /** A charge that arrives after a timeout or a cancellation (R16). */
  settleCharge(runId: string, commandId: string, cost: Cost): Promise<void> {
    return this.journal.settleCharge(runId, commandId, cost);
  }

  // ── ReplayRun ─────────────────────────────────────────────────────────

  /** Rebuilds the run from its journal without calling any adapter (INV-09, R13). */
  async replayRun(runId: string, adapters: Adapters = refusingAdapters(this.adapters)): Promise<ReplayResult> {
    const run = await this.journal.run(runId);
    const program = await this.program(run.package_hash);
    const interp = this.interpreter(run, program, run.fence, true, adapters);
    try {
      return { status: "complete", value: await interp.runWorkflow(run.workflow, run.input as Obj) };
    } catch (e) {
      if (e instanceof ReplayEnd) return e.reason === "payload_purged" ? { status: "incomplete_replay", missing: e.commandId } : { status: "partial", stoppedAt: e.commandId };
      if (e instanceof Fault) return { status: "failed", error: e.value() };
      if (e instanceof Attention) return { status: "attention_required", reason: e.reason };
      throw e;
    }
  }

  /** Retention: drops result payloads; a later replay reports incomplete_replay (R14). */
  purgePayloads(runId: string): Promise<void> {
    return this.journal.purgePayloads(runId);
  }
}

function minLimits(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? Math.min(out[k]!, v) : v;
  return out;
}

/** Adapters that fail the test if replay ever reaches the outside world. */
export function refusingAdapters(real: Adapters): Adapters {
  const refuse = (what: string) => (): never => {
    throw new Violation("replay_called_adapter", `Replay tried to call ${what}.`);
  };
  return {
    agents: { run: refuse("an agent") },
    model: { infer: refuse("a model"), upperBound: () => ({}) },
    verifier: { check: refuse("a verifier") },
    reads: { call: refuse("a read") },
    broker: { describe: () => ({ id: "refused", digest: "" }), query: refuse("the read broker") },
    samples: { describe: () => ({ id: "refused", digest: "" }), query: refuse("sample reads") },
    tools: Object.fromEntries(
      Object.entries(real.tools).map(([k, t]) => [k, { describe: () => t.describe(), prepare: refuse(`${k}.prepare`), execute: refuse(`${k}.execute`), reconcile: refuse(`${k}.reconcile`) }]),
    ),
    clock: real.clock,
    random: refuse("random"),
  };
}

/** The format of a run's manifest: what it started from (design doc 9 §12). */
export const RUN_MANIFEST_FORMAT = "mandate/run-manifest/0.1";

/** The components of the package's system model that its program refers to, by name. */
export function componentsOf(pkg: Package): WorkspaceComponent[] {
  const defs = link(pkg.program, pkg.modules).defs;
  const names = new Set<string>();
  for (const d of Object.values(pkg.program.defs)) for (const r of references(d)) if (Object.hasOwn(defs, r) && defs[r]!.kind === "component") names.add(r);
  return [...names].sort().map((name) => {
    const c = defs[name] as Extract<(typeof defs)[string], { kind: "component" }>;
    return { name, repo: c.repo, root: c.root };
  });
}
