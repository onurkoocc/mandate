// The control API (Doc 4 §16.1): StartRun, GetRun, SubmitInput, DecideAction,
// CancelRun, ReconcileAction, ReplayRun. A run is driven by a worker that
// holds its lease; a crash leaves the journal as it was, and `resume` starts a
// new worker with a higher fence that re-runs the body against the journal.

import { randomUUID } from "node:crypto";
import { capsOf, check, domainHash, hashProgram, link, linkedProgram, packageHash, references, SANDBOX_DENIALS_FORMAT, workflowBounds, type DenialReport, type Envelope, type Json, type Lock, type Modules, type Program } from "@mandate/compiler";
import type { Adapters, Cost, RunComponents, RunMode } from "./adapters.js";
import type { WorkspaceComponent } from "./workspace.js";
import { ArtifactStore, MemoryBlobs, type ArtifactRef } from "./artifacts.js";
import { recordProblem, type AttestationRule } from "./attestation.js";
import { criterionMethods } from "./criteria.js";
import { approvalProblem, authorizationId, InvalidDecision, isSignedDecision, payloadOf, roleRefusal, shownRefusal, signerRefusal, storedProblem, type DecisionKind, type Refusal, type Shown, type SignedDecision, type StoredDecision } from "./decisions.js";
import { EvidenceSigner, TrustedKeys, type EvidenceRecord } from "./evidence.js";
import { RateLimiter, type BucketConfig } from "./ratelimit.js";
import type { Db, Row, Tx } from "./db.js";
import { Faults } from "./faults.js";
import { checkFitness, systemProbe, type HostProbe } from "./fitness.js";
import { schemaErrors, typeSchema } from "./schema.js";
import { Interpreter, ReplayEnd, type Epoch, type Policy } from "./interp.js";
import { costDims, Journal, TERMINAL, type ActionRow, type BudgetReport, type EvidenceRow, type Limits, type RunRow } from "./journal.js";
import { buildPackage, isSigned04, verifyPackage, type Package } from "./package.js";
import { CHECK_MS, WorkerChecker, type ProgramChecker } from "./plan.js";
import { Attention, Cancelled, Crash, Fault, StaleFence, Suspend, Violation } from "./signals.js";
import { digest, isObj, type Obj, type Value } from "./values.js";

export type { Lock };
export { buildPackage, isSigned04, notRunYet, RUNTIME_LANGUAGES, verifyPackage, type Package } from "./package.js";

/** The roles that own an envelope in a program: who may approve its package. */
function envelopeOwners(program: Program): Set<string> {
  return new Set(Object.values(program.defs).flatMap((d) => (d.kind === "workflow" && d.envelope?.owner !== undefined ? [d.envelope.owner] : [])));
}

export interface StartOptions {
  pkg: Package;
  workflow: string;
  input: Obj;
  tenant?: string;
  runId?: string;
  /** Caller limits; the run gets the minimum of these and the workflow's budget (its envelope's, when it has one). */
  limits?: Limits;
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
   * The methods the configuration checks in this process even with a verifier process of its own (boundary and
   * onboarding checks; control.ts `inProcessMethods`). With trusted verifier keys, the evidence of every other
   * method a verifier call makes must carry a verifier attestation (spec/runtime.md "A verifier of its own").
   */
  inProcessMethods?: readonly string[];
  /**
   * A run's timers (a restart's backoff) are kept by its scheduler: the run
   * waits, and `tick` resumes it when the time comes. A Temporal worker's
   * runtime needs this; without it, the worker sleeps through the wait.
   */
  durableTimers?: boolean;
  /** Rate limits shared by every run on this database (§8.6), by bucket: `model`, `model:<tier>`, `tool`. */
  rateLimits?: Record<string, BucketConfig>;
  /**
   * How a person's decisions are taken (spec/envelope.md "Signed decisions"). `signed`, the default: every decision
   * is a record signed with a key the package's lock lists under a member; `keys` holds the members' public keys.
   * `unsigned`: a package of 0.1 to 0.3 takes a decision on the caller's word for who made it (`by`), as before
   * 0.4. A 0.4 package's decisions are signed in either mode, and it does not start in `unsigned`.
   */
  decisions?: { mode?: "signed" | "unsigned"; keys?: TrustedKeys };
  /**
   * How a lead's sub-programs are checked (spec/envelope.md "Limits"): `checkMs`, the longest a check may take
   * (2 s by default), and the checker, which by default runs the compiler in a worker thread of its own.
   */
  plan?: { checkMs?: number; checker?: ProgramChecker };
  /**
   * How the host's tools are read when a package's lock names their least versions (`host`; spec/boundary.md
   * "Isolation level and host fitness"). Default: this process's Node version and the first `bwrap` on PATH.
   */
  hostProbe?: HostProbe;
}

/** Who made a decision the runtime took: a member with a signed record, or in unsigned mode the name the caller gave. */
interface Decider {
  by: string;
  /** The fields a signed decision adds to what is recorded; empty in unsigned mode. */
  signed: { member: string; role: string | null; key: string; decision: string } | Record<string, never>;
}

/** A decision that is refused, on its way out of the transaction that would have applied it. */
class Refused extends Error {
  constructor(
    readonly refusal: Refusal,
    readonly signed: unknown,
    readonly command: string | undefined,
  ) {
    super(refusal.message);
  }
}

/** A package as a run uses it: the linked program, the lock, and whether its decisions must be signed. */
interface Loaded {
  program: Program;
  lock: Lock;
  signed: boolean;
  /** The program and its modules as they were packaged: what a sub-program is checked and linked against. */
  source: Program;
  modules: Modules;
}

export class Runtime {
  readonly journal: Journal;
  readonly faults: Faults;
  readonly artifacts: ArtifactStore;
  readonly signer: EvidenceSigner;
  readonly trusted: TrustedKeys;
  readonly verifiers: TrustedKeys;
  /** The methods checked in this process, whose evidence carries no verifier attestation. */
  readonly inProcess: ReadonlySet<string>;
  readonly durableTimers: boolean;
  readonly limiter: RateLimiter | undefined;
  readonly decisionMode: "signed" | "unsigned";
  /** The members' public keys, by key id. The lock says whose each one is. */
  readonly decisionKeys: TrustedKeys;
  /** Checks a lead's sub-programs, and how long one check may take. */
  readonly checker: ProgramChecker;
  readonly checkMs: number;
  /** Reads the host's tools for a lock's `host`. */
  readonly hostProbe: HostProbe;
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
    this.inProcess = new Set(options.inProcessMethods ?? []);
    this.durableTimers = options.durableTimers ?? false;
    this.limiter = options.rateLimits && Object.keys(options.rateLimits).length ? new RateLimiter(db, options.rateLimits, () => adapters.clock.now()) : undefined;
    this.decisionMode = options.decisions?.mode ?? "signed";
    this.decisionKeys = options.decisions?.keys ?? new TrustedKeys();
    this.checker = options.plan?.checker ?? new WorkerChecker();
    this.checkMs = options.plan?.checkMs ?? CHECK_MS;
    this.hostProbe = options.hostProbe ?? systemProbe;
  }

  // ── StartRun / resume ─────────────────────────────────────────────────

  async startRun(o: StartOptions): Promise<RunRow> {
    verifyPackage(o.pkg);
    if (this.decisionMode === "unsigned" && isSigned04(o.pkg.program, o.pkg.modules)) {
      throw new Violation("signed_decisions_required", "A mandate/0.4 package does not run in unsigned mode: its decisions are signed records (spec/envelope.md). Take decisions.mode out of the runtime configuration.");
    }
    // A host below the lock's least versions starts nothing of the package: no workspace, no run, no event (unfit_host).
    await checkFitness(o.pkg.lock, this.hostProbe);
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
    // A workflow with an envelope starts only once a member of its owner role approved this package (H03).
    const approval = wf.envelope ? await this.envelopeApproval(o.pkg, o.workflow, wf.envelope) : undefined;
    const approved = approval ? { package: o.pkg.hash, member: approval.record.member, role: approval.record.role ?? null, key: approval.record.key, decision: approval.decision_id } : undefined;
    const lowered = this.remoteGuarantees(o.pkg.program);
    const runId = o.runId ?? randomUUID();
    const limits = minLimits(costDims(workflowBounds(wf).budget), costDims(o.limits));
    const policy: Policy = { tenant: o.tenant ?? "default", ...(o.authorize ? { authorize: o.authorize } : {}), ...(o.authorizationTtlMs ? { authorizationTtlMs: o.authorizationTtlMs } : {}), ...(o.priority ? { priority: o.priority } : {}) };
    // The components the program works on start from one base commit each, recorded in the run's manifest (B3).
    const components = await this.prepareWorkspace(runId, o.pkg);
    // The manifest of a run under an envelope lists the approval it starts under; another run's manifest is as it was.
    const manifest = {
      format: RUN_MANIFEST_FORMAT,
      package: o.pkg.hash,
      workflow: o.workflow,
      tenant: policy.tenant,
      input: digest("request", o.input),
      mode: o.mode ?? "live",
      components,
      ...(approved ? { envelope_approval: { decision: approved.decision, member: approved.member, role: approved.role, key: approved.key } } : {}),
    } as unknown as Value;
    const manifestHash = digest("run", manifest);
    await this.db.tx(async (tx) => {
      await this.keep(tx, o.pkg);
      await this.journal.createRun(tx, { runId, tenant: policy.tenant, packageHash: o.pkg.hash, workflow: o.workflow, input: o.input, policy: policy as unknown as Value, limits, manifest, manifestHash });
      if (approved) await this.journal.event(tx, runId, "envelope_approved", approved);
      for (const agent of lowered) await this.journal.event(tx, runId, "guarantee_lowered", { agent, delivery: "at_most_once", reason: "the remote agent's server does not deduplicate messages" });
    });
    this.packages.set(o.pkg.hash, o.pkg);
    return this.drive(runId, true);
  }

  /** Stores a package under its hash; one that is already there is left as it is. */
  private async keep(tx: Tx, pkg: Package): Promise<void> {
    await tx.query("insert into packages (package_hash, program, lock, modules) values ($1, $2, $3, $4) on conflict (package_hash) do nothing", [
      pkg.hash,
      JSON.stringify(pkg.program),
      JSON.stringify(pkg.lock),
      JSON.stringify(pkg.modules ?? {}),
    ]);
  }

  // ── ApproveEnvelope ───────────────────────────────────────────────────

  /**
   * Takes a member's approval of a package's envelope (spec/envelope.md "Approving an envelope"): a signed decision
   * of kind `envelope` whose subject is the package hash, made in the `owner` role of an envelope the package has.
   * It is about the package and no run, so it names no run, revision or command, and one approval serves every run
   * of that package. Returns the decision's digest.
   *
   * It is held to the rules of every decision (INV-16), in their order: who signed, what the record is for, then
   * the role. A refused approval is `invalid_decision` and nothing is stored; there is no run whose log could
   * record it.
   */
  async approveEnvelope(pkg: Package, signed: SignedDecision): Promise<string> {
    verifyPackage(pkg);
    const owners = envelopeOwners(pkg.program);
    if (!owners.size) throw new Violation("no_envelope", "The package has no workflow with an envelope, so there is nothing to approve.");
    const refusal = (): Refusal | undefined => {
      const who = signerRefusal(signed, this.decisionKeys, pkg.lock);
      if (who) return who;
      const r = signed.record;
      const what = shownRefusal(r, { package: pkg.hash, subject: pkg.hash }, ["envelope"]);
      if (what) return what;
      if (r.role === undefined || !owners.has(r.role)) {
        return { reason: "not_in_role", message: `An envelope is approved by its owner role (${[...owners].sort().join(", ")}); the decision is made as ${r.role ?? "no role"}.` };
      }
      return roleRefusal(r, pkg.lock, r.role);
    };
    const why = refusal();
    if (why) throw new InvalidDecision(why.reason, why.message);
    return this.db.tx(async (tx) => {
      await this.keep(tx, pkg);
      return this.journal.recordDecision(tx, signed);
    });
  }

  /**
   * The approval a run of an envelope workflow starts under: the oldest stored `envelope` decision for this package
   * hash, made in the envelope's owner role, that still holds. It is checked again here, as when it arrived: its
   * record is unchanged, names this package and nothing else, and is signed by a key the package's lock lists under
   * a member of that role. Without one the run does not start (`unapproved_envelope`, H03). An approval of another
   * package, however alike, is none: a changed program, lock or module is a new hash (N04).
   */
  private async envelopeApproval(pkg: Package, workflow: string, envelope: Envelope): Promise<StoredDecision> {
    const holds = (d: StoredDecision): boolean =>
      d.record.role === envelope.owner && !shownRefusal(d.record, { package: pkg.hash, subject: pkg.hash }, ["envelope"]) && !storedProblem(d, this.decisionKeys, pkg.lock);
    const found = (await this.journal.envelopeApprovals(pkg.hash)).find(holds);
    if (!found) {
      throw new Violation(
        "unapproved_envelope",
        `No member of ${envelope.owner ?? "its owner role"} has approved package ${pkg.hash}, so ${workflow} does not start. Read its card (mandate view --card) and sign it (mandate approve-envelope).`,
      );
    }
    return found;
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
    const repos = workflowBounds(wf).caps.flatMap((c) => capsOf(program.defs, c)).filter((c) => c.ctor === "git.pr").flatMap((c) => c.scope ?? []);
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
    // Every resume checks the host against the package's lock before it takes the lease. An unfit host takes nothing
    // and writes nothing: the run stays as it was, for a fit host to resume (unfit_host). A finished run runs nothing.
    const current = await this.journal.run(runId);
    if (!TERMINAL.has(current.state)) await checkFitness((await this.packaged(current.package_hash)).lock, this.hostProbe);
    const { run, fence } = await this.journal.acquire(runId);
    if (TERMINAL.has(run.state)) return run;
    const loaded = await this.loaded(run.package_hash);
    await this.write(runId, fence, async (tx) => this.journal.setState(tx, runId, "running"));
    const interp = this.interpreter(run, loaded, fence, false, this.adapters, await this.journal.startedAt(runId), await this.earlier(run));
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

  /**
   * The packages a run had before its envelope was amended, oldest first, each with the envelope the run's
   * workflow had in it (spec/envelope.md "Amendments"). The interpreter derives what belongs to a command the
   * journal holds under the package that command was recorded under.
   */
  private async earlier(run: RunRow): Promise<Epoch[]> {
    const out: Epoch[] = [];
    for (const a of await this.journal.amendments(run.run_id)) {
      const wf = (await this.packaged(a.from)).program.defs[run.workflow];
      out.push({ hash: a.from, ...(wf?.kind === "workflow" && wf.envelope ? { envelope: wf.envelope } : {}) });
    }
    return out;
  }

  private interpreter(run: RunRow, loaded: Loaded, fence: number, replay: boolean, adapters: Adapters, startedAt: number, earlier: Epoch[]): Interpreter {
    const wf = Object.hasOwn(loaded.program.defs, run.workflow) ? loaded.program.defs[run.workflow] : undefined;
    return new Interpreter({
      journal: this.journal,
      adapters,
      program: loaded.program,
      plan: { parent: loaded.source, modules: loaded.modules, lock: loaded.lock, checker: this.checker, checkMs: this.checkMs, startedAt },
      ...(earlier.length ? { earlier } : {}),
      decisions: { keys: this.decisionKeys, lock: loaded.lock, required: loaded.signed },
      lock: loaded.lock,
      ...(wf?.kind === "workflow" && wf.envelope ? { envelope: wf.envelope } : {}),
      packageHash: run.package_hash,
      runId: run.run_id,
      fence,
      policy: run.policy as unknown as Policy,
      faults: this.faults,
      artifacts: this.artifacts,
      signer: this.signer,
      trusted: this.trusted,
      verifiers: this.verifiers,
      inProcess: this.inProcess,
      ...(isObj(run.manifest) && isObj(run.manifest["components"] ?? null) ? { workspace: run.manifest["components"] as unknown as RunComponents } : {}),
      ...(isObj(run.manifest) && typeof run.manifest["mode"] === "string" ? { mode: run.manifest["mode"] as RunMode } : {}),
      replay,
      durableTimers: this.durableTimers,
      ...(this.limiter ? { limiter: this.limiter } : {}),
    });
  }

  /** The program, modules and lock of a package, as packaged. */
  private async packaged(packageHash: string): Promise<{ program: Program; modules: Modules; lock: Lock }> {
    const cached = this.packages.get(packageHash);
    if (cached) return { program: cached.program, modules: cached.modules ?? {}, lock: cached.lock };
    const [row] = await this.db.query<Row>("select program, modules, lock from packages where package_hash = $1", [packageHash]);
    if (!row) throw new Violation("unknown_package", `No package ${packageHash}.`);
    return { program: row["program"] as Program, modules: (row["modules"] ?? {}) as Modules, lock: row["lock"] as Lock };
  }

  /** A package as a run uses it. Its decisions are signed in signed mode, and always when it is a 0.4 package. */
  private async loaded(packageHash: string): Promise<Loaded> {
    const p = await this.packaged(packageHash);
    return { program: linkedProgram(p.program, p.modules), lock: p.lock, signed: this.decisionMode === "signed" || isSigned04(p.program, p.modules), source: p.program, modules: p.modules };
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
   * result (P2-11). With a verifier of its own configured, which checks need
   * that attestation is read from the program and the configuration, never
   * from the record (attestation.ts `recordProblem`). Views show the result.
   */
  async verifyEvidence(runId: string): Promise<Array<{ evidence_id: string; criterion: string; valid: boolean; key_id: string | null }>> {
    const run = await this.journal.run(runId);
    const { lock, signed, program } = await this.loaded(run.package_hash);
    // A person's approval rests on their signed decision (H04): the record it names must still be the one they signed.
    const decisions = new Map((await this.journal.decisions(runId)).map((d) => [d.decision_id, d]));
    const rule: AttestationRule = { keys: this.verifiers, inProcess: this.inProcess };
    const declared = (record: EvidenceRecord): string[] | undefined => criterionMethods(Object.hasOwn(program.defs, record.contract) ? program.defs[record.contract] : undefined, record.criterion);
    return (await this.journal.evidence(runId)).map((e) => ({
      evidence_id: e.evidence_id,
      criterion: e.criterion,
      key_id: e.key_id,
      valid:
        !!e.record &&
        !!e.key_id &&
        !!e.signature &&
        this.trusted.verify(e.record as unknown as EvidenceRecord, { key_id: e.key_id, signature: e.signature }) &&
        (e.record as unknown as EvidenceRecord).evidence_id === e.evidence_id &&
        (e.record as unknown as EvidenceRecord).passed === e.passed &&
        !recordProblem(e.record as unknown as EvidenceRecord, { ...e, run: runId }, declared(e.record as unknown as EvidenceRecord), rule) &&
        !approvalProblem(e.record as unknown as EvidenceRecord, decisions, this.decisionKeys, lock, signed),
    }));
  }

  /**
   * The decisions a run took as signed records, oldest first, each checked again: its record still hashes to its
   * digest, its signature verifies, and the package's lock binds its key to its member and role (INV-16).
   */
  async verifyDecisions(runId: string): Promise<Array<StoredDecision & { valid: boolean; problem?: string }>> {
    const run = await this.journal.run(runId);
    const { lock } = await this.loaded(run.package_hash);
    // A run under an envelope started on its owner's approval of the package: the decision its manifest lists comes first.
    const listed = isObj(run.manifest) && isObj(run.manifest["envelope_approval"] ?? null) ? (run.manifest["envelope_approval"] as Obj)["decision"] : undefined;
    const approval = typeof listed === "string" ? await this.journal.decision(listed) : undefined;
    return [...(approval ? [approval] : []), ...(await this.journal.decisions(runId))].map((d) => {
      const problem = storedProblem(d, this.decisionKeys, lock);
      return { ...d, valid: !problem, ...(problem ? { problem } : {}) };
    });
  }

  /**
   * What a decision on the run must name now (`Shown`): the package, the run and its revision, and
   *
   * - `"wait"`: the wait the run is in, the digest it shows and the role it asks;
   * - `"run"`: the run itself, for a raise of its limits or a cancel;
   * - `{ reconcile }`: the action whose outcome is asked.
   *
   * A person signs a record of these (`signDecision`); the runtime compares the record with them again when it arrives.
   */
  async shown(runId: string, about: "wait" | "run" | { reconcile: string }): Promise<Shown> {
    const run = await this.journal.run(runId);
    const base = { package: run.package_hash, run: runId, revision: run.revision };
    if (about === "run") return { ...base, subject: run.package_hash };
    if (about !== "wait") {
      const action = await this.journal.action(about.reconcile);
      if (!action || action.run_id !== runId) throw new Violation("unknown_action", `No action ${about.reconcile} in run ${runId}.`);
      return { ...base, command: action.command_id, subject: action.action_digest };
    }
    const w = run.waiting;
    const commandId = run.state === "waiting" && isObj(w) && typeof w["command"] === "string" ? w["command"] : undefined;
    const [row] = commandId === undefined ? [] : await this.db.query<Row>("select kind, state, result, request_digest from commands where run_id = $1 and command_id = $2", [runId, commandId]);
    if (!row || row["state"] !== "waiting" || (row["kind"] !== "input" && row["kind"] !== "decision" && row["kind"] !== "amendment")) throw new Violation("no_wait", `Run ${runId} is not waiting for a person.`);
    return shownBy(run, commandId!, row);
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
  async submitInput(runId: string, msg: Message, i: { commandId: string; revision: number; value: Value } | { value: Value; signed: SignedDecision }): Promise<RunRow> {
    const signed = "signed" in i ? i.signed : undefined;
    const at = "signed" in i ? named(i.signed) : i;
    const fresh = await this.resolveWait(runId, msg, at.commandId, at.revision, "input", i as unknown as Value, { signed, kinds: ["answer"], payload: payloadOf.answer(i.value) }, async () => ({ state: "succeeded", result: i.value }));
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
   *
   * A signed decision says all of this in its record: the wait, the
   * revision, the digest, and whether it approves. In unsigned mode the
   * caller says them, and who decided (`by`).
   */
  async decideAction(runId: string, msg: Message, given: { commandId: string; revision: number; digest: string; approve: boolean; by: string } | { signed: SignedDecision }): Promise<RunRow> {
    type Resolution = { state: "succeeded"; result: Value } | { state: "failed"; error: Value };
    const signed = "signed" in given ? given.signed : undefined;
    const d = "signed" in given ? { ...named(given.signed), digest: subjectOf(given.signed), approve: kindOf(given.signed) === "approve", by: "" } : given;
    const fresh = await this.resolveWait(runId, msg, d.commandId, d.revision, "decision", given as unknown as Value, { signed, by: d.by, kinds: ["approve", "decline"] }, async (tx, request, run, who): Promise<Resolution> => {
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
      const by = who.by;
      if (!d.approve || criterion || gate) {
        if (criterion) await this.journal.event(tx, runId, d.approve ? "criterion_approved" : "criterion_denied", { command: d.commandId, by, ...who.signed });
        if (gate) await this.journal.event(tx, runId, d.approve ? "governance_approved" : "governance_denied", { command: d.commandId, digest: d.digest, by, ...who.signed });
        return { state: "succeeded", result: { approved: d.approve, by, ...who.signed } };
      }
      const id = authorizationId(d.digest, by, msg.messageId);
      const ttl = (run.policy as unknown as Policy).authorizationTtlMs ?? 15 * 60_000;
      await tx.query("insert into authorizations (authorization_id, run_id, action_digest, decided_by, expires_at) values ($1, $2, $3, $4, $5) on conflict do nothing", [
        id,
        runId,
        d.digest,
        by,
        this.adapters.clock.now() + ttl,
      ]);
      await this.journal.event(tx, runId, "action_authorized", { authorization: id, digest: d.digest, by, ...who.signed });
      return { state: "succeeded", result: { approved: true, by, authorization_id: id, ...who.signed } };
    });
    return fresh ? this.drive(runId) : this.journal.run(runId);
  }

  /**
   * The owner's decision on an amendment a lead asked for (spec/envelope.md "Amendments", N04): a signed decision
   * of kind `amend`, or `decline`, that names the amendment's wait and, as its subject, the hash of the package
   * with the new envelope. It is made in the `owner` role of the envelope the run has now.
   *
   * An approval moves the run to the new package in the transaction that takes it (INV-02 as 0.4 refines it): the
   * run's package hash changes, its limits rise to the new envelope's budget, and `package_amended` records both
   * hashes, the diff and the decision. Nothing else carries over. A decision or an authorization names the package
   * it was made for, so one made for the old package answers nothing of the new one. On a decline, or past the
   * wait's deadline, the run's package stays as it was, and the lead is told.
   */
  async decideAmendment(runId: string, msg: Message, signed: SignedDecision): Promise<RunRow> {
    const at = named(signed);
    const approve = kindOf(signed) === "amend";
    // The package the wait asks for is read before the transaction: an in-process database has one connection.
    const [row] = await this.db.query<Row>("select result from commands where run_id = $1 and command_id = $2 and kind = 'amendment'", [runId, at.commandId]);
    const asked = isObj((row?.["result"] ?? null) as Value) ? (row!["result"] as Obj) : {};
    const to = typeof asked["package"] === "string" ? asked["package"] : undefined;
    const next = approve && to !== undefined ? await this.packaged(to) : undefined;
    const prev = next && typeof asked["from"] === "string" ? await this.packaged(asked["from"]) : undefined;
    const fresh = await this.resolveWait(runId, msg, at.commandId, at.revision, "amendment", { signed } as unknown as Value, { signed, kinds: ["amend", "decline"] }, async (tx, request, run, who) => {
      const r = isObj(request) ? request : {};
      const deadline = r["deadline"];
      if (typeof deadline === "number" && this.adapters.clock.now() >= deadline) return { state: "failed", error: { tag: "Rejected", args: ["approval_expired"] } };
      if (!approve) return { state: "succeeded", result: { approved: false, by: who.by, ...who.signed } };
      const wf = next?.program.defs[run.workflow];
      // An amendment is asked of the package the run has: one asked of an earlier package ended when that one was amended.
      if (to === undefined || r["package"] !== to || r["from"] !== run.package_hash || wf?.kind !== "workflow" || !wf.envelope) {
        throw new Violation("stale_amendment", `The amendment at ${at.commandId} was asked of package ${String(r["from"])}, and run ${runId} is under ${run.package_hash}.`);
      }
      // A limit rises in the dimensions the amendment raises, to what the new envelope gives. In any other the run
      // keeps the limit it has, also one its caller set below the envelope: that is a raise's to lift, not this.
      const was = prev?.program.defs[run.workflow];
      const before = costDims(was?.kind === "workflow" ? was.envelope?.budget : undefined);
      const limits = Object.fromEntries(Object.entries(costDims(wf.envelope.budget)).filter(([dim, amount]) => amount > (before[dim] ?? amount)));
      const moved = await this.journal.amendRun(tx, runId, at.commandId, to, limits);
      await this.journal.event(tx, runId, "package_amended", {
        from: run.package_hash,
        to,
        diff: r["diff"] ?? null,
        plan: r["plan"] ?? null,
        command: at.commandId,
        limits: { from: moved.limits, to: Object.fromEntries(Object.keys(moved.limits).map((dim) => [dim, limits[dim]!])) },
        superseded: moved.superseded,
        by: who.by,
        ...who.signed,
      });
      return { state: "succeeded", result: { approved: true, package: to, by: who.by, ...who.signed } };
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
  async raiseLimits(runId: string, msg: Message, r: { revision: number; limits: Limits; by: string } | { limits: Limits; signed: SignedDecision }): Promise<RunRow> {
    const seen = await this.journal.run(runId);
    const loaded = await this.loaded(seen.package_hash);
    const wf = loaded.program.defs[seen.workflow];
    const program = costDims(wf?.kind === "workflow" ? workflowBounds(wf).budget : undefined);
    const wanted = costDims(r.limits);
    const signed = "signed" in r ? r.signed : undefined;
    await this.deciding(runId, msg, () => this.db.tx(async (tx) => {
      const run = await this.journal.lock(tx, runId);
      const fresh = await this.journal.inbox(tx, { tenant: run.tenant, sender: msg.sender, messageId: msg.messageId, payloadDigest: digest("request", r as unknown as Value) });
      if (!fresh) return;
      // A raise is about the run, not a wait: it names the run's package, and any member may make it.
      this.identify(loaded, signed, undefined);
      const who = await this.admit(tx, loaded, { signed, by: "by" in r ? r.by : "" }, { package: run.package_hash, run: runId, revision: run.revision, subject: run.package_hash }, ["raise_limits"], payloadOf.limits(wanted));
      if (!("signed" in r) && run.revision !== r.revision) throw new Violation("stale_revision", `The raise was made on revision ${r.revision}; run ${runId} is at revision ${run.revision}.`);
      if (TERMINAL.has(run.state)) throw new Violation("run_ended", `Run ${runId} has ended (${run.state}).`);
      for (const [dim, limit] of Object.entries(wanted)) {
        if (dim in program && limit > program[dim]!) {
          const enveloped = wf?.kind === "workflow" && !!wf.envelope;
          throw new Violation(
            "above_program_budget",
            enveloped
              ? `${run.workflow}'s envelope gives a ${dim} budget of ${program[dim]}; raising the run to ${limit} needs an amendment of the envelope, which its owner approves (spec/envelope.md).`
              : `${run.workflow} declares a ${dim} budget of ${program[dim]}; raising the run to ${limit} needs a new program version (§13.2).`,
          );
        }
      }
      const before = await this.journal.raiseLimits(tx, runId, wanted);
      await this.journal.event(tx, runId, "limits_raised", { by: who.by, sender: msg.sender, message: msg.messageId, from: before, to: wanted, ...who.signed });
    }));
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
    // A decision expires, and so does an amendment nobody answered: the lead is told, and the envelope stays.
    if (w["kind"] !== "decision" && w["kind"] !== "amendment") return run;
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
    kind: "input" | "decision" | "amendment",
    payload: Value,
    from: { signed: SignedDecision | undefined; by?: string; kinds: DecisionKind[]; payload?: string },
    resolve: (tx: Tx, request: Value, run: RunRow, who: Decider) => Promise<{ state: "succeeded"; result: Value } | { state: "failed"; error: Value }>,
  ): Promise<boolean> {
    const loaded = await this.loaded((await this.journal.run(runId)).package_hash);
    return this.deciding(runId, msg, () => this.db.tx(async (tx) => {
      const run = await this.journal.lock(tx, runId);
      const fresh = await this.journal.inbox(tx, { tenant: run.tenant, sender: msg.sender, messageId: msg.messageId, payloadDigest: digest("request", payload) });
      if (!fresh) return false;
      // Who decides comes first: a refusal names them, whatever else is wrong with the decision.
      this.identify(loaded, from.signed, commandId);
      // The answer was given on what the caller last saw; if the run moved on since, it must look again (§16.1).
      if (run.revision !== revision) {
        const stale = `The ${kind} was given on revision ${revision}; run ${runId} is at revision ${run.revision}.`;
        throw from.signed ? new Refused({ reason: "stale_revision", message: stale }, from.signed, commandId) : new Violation("stale_revision", stale);
      }
      const [row] = await tx.query<Row>("select kind, state, result, request_digest from commands where run_id = $1 and command_id = $2", [runId, commandId]);
      if (!row || row["kind"] !== kind || row["state"] !== "waiting") {
        const none = `Run ${runId} is not waiting for ${kind} at ${commandId}.`;
        throw from.signed ? new Refused({ reason: "subject_mismatch", message: none }, from.signed, commandId) : new Violation("no_wait", none);
      }
      const request = row["result"] as Value;
      const who = await this.admit(tx, loaded, from, shownBy(run, commandId, row), from.kinds, from.payload, isObj(request) ? request : {});
      // Everything inside goes through `tx`: an in-process database has one connection.
      const r = await resolve(tx, request, run, who);
      await tx.query("update commands set state = $3, result = $4, error = $5 where run_id = $1 and command_id = $2", [
        runId,
        commandId,
        r.state,
        JSON.stringify("result" in r ? r.result : null),
        JSON.stringify("error" in r ? r.error : null),
      ]);
      await this.journal.event(tx, runId, kind === "input" ? "input_received" : "decision_received", { command: commandId, sender: msg.sender, message: msg.messageId, ...who.signed });
      return true;
    }));
  }

  // ── signed decisions (spec/envelope.md) ───────────────────────────────

  /**
   * Runs a control call that takes a decision. A refused decision changes nothing: its transaction is rolled back,
   * and `decision_refused` is the one thing recorded, with who tried, with which key, and why. It raises no
   * revision, and the wait stays open (INV-16).
   */
  private async deciding<T>(runId: string, msg: Message | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      await this.db.tx(async (tx) => {
        await this.journal.lock(tx, runId);
        await this.journal.event(tx, runId, "decision_refused", refusedEvent(e, msg));
      });
      throw new InvalidDecision(e.refusal.reason, e.refusal.message);
    }
  }

  /** Rules 1 and 2a: a signed record is one, by a key the lock lists under its member. Signed mode takes nothing else. */
  private identify(loaded: Loaded, signed: unknown, command: string | undefined): void {
    if (signed === undefined) {
      if (loaded.signed) throw new Refused({ reason: "invalid_signature", message: "This run takes signed decisions, and the decision carries no signature." }, undefined, command);
      return;
    }
    const why = signerRefusal(signed, this.decisionKeys, loaded.lock);
    if (why) throw new Refused(why, signed, command);
  }

  /**
   * Who makes a decision, inside the transaction that applies it, once `identify` has passed. A signed record is held to what the run shows now
   * (`shown`), to the role it asks and, for `distinct_from`, to the earlier approval of the same criterion; then it
   * is stored. Without a record, unsigned mode takes the caller's word (`by`).
   */
  private async admit(tx: Tx, loaded: Loaded, from: { signed: SignedDecision | undefined; by?: string }, shown: Shown, kinds: readonly DecisionKind[], payload: string | undefined, request: Obj = {}): Promise<Decider> {
    if (!from.signed) return { by: from.by ?? "", signed: {} };
    const record = from.signed.record;
    const why = shownRefusal(record, shown, kinds, payload) ?? roleRefusal(record, loaded.lock, shown.role);
    if (why) throw new Refused(why, from.signed, shown.command);
    // `human.approve(role: r, distinct_from: q)`: not the member who decided `q` in the same criterion (H02). Members
    // are compared, not keys: one person is one member, however many keys they hold.
    const other = request["distinct_from"];
    const within = request["criterion_path"];
    if (typeof other === "string" && typeof within === "string") {
      const earlier = (await this.journal.decisions(shown.run, tx)).filter((d) => d.record.role === other && (d.record.kind === "approve" || d.record.kind === "decline") && (d.record.command ?? "").startsWith(`${within}/`));
      if (earlier.some((d) => d.record.member === record.member)) {
        throw new Refused({ reason: "same_member", message: `Member ${record.member} decided as ${other} in this criterion; ${shown.role ?? "this approval"} must come from someone else.` }, from.signed, shown.command);
      }
    }
    const decision = await this.journal.recordDecision(tx, from.signed);
    return { by: record.member, signed: { member: record.member, role: record.role ?? null, key: record.key, decision } };
  }

  // ── CancelRun ─────────────────────────────────────────────────────────

  /**
   * Cancellation is an event, not erasure (§8.9). It is ordered against
   * dispatch on the run's row: a dispatch after it is refused (R08); one
   * before it is followed to its real result (R09).
   */
  async cancelRun(runId: string, signed?: SignedDecision): Promise<RunRow> {
    const loaded = signed === undefined ? undefined : await this.loaded((await this.journal.run(runId)).package_hash);
    const idle = await this.db.tx(async (tx) => {
      const run = await this.journal.lock(tx, runId);
      if (TERMINAL.has(run.state)) return false;
      // A cancel is always taken: stopping needs nobody's authority. A signature that holds says who asked; one that
      // does not is recorded as refused, and the run is cancelled all the same.
      let who: Decider["signed"] = {};
      if (signed !== undefined) {
        const why = signerRefusal(signed, this.decisionKeys, loaded!.lock) ?? shownRefusal(signed.record, { package: run.package_hash, run: runId, subject: run.package_hash }, ["cancel"]) ?? roleRefusal(signed.record, loaded!.lock, undefined);
        if (why) await this.journal.event(tx, runId, "decision_refused", refusedEvent(new Refused(why, signed, undefined), undefined));
        else who = { member: signed.record.member, role: null, key: signed.record.key, decision: await this.journal.recordDecision(tx, signed) };
      }
      await tx.query("update runs set cancel_requested = true, revision = revision + 1 where run_id = $1", [runId]);
      await this.journal.event(tx, runId, "cancel_requested", who);
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
  async reconcileAction(runId: string, operationKey: string, signed?: SignedDecision): Promise<RunRow> {
    const action = await this.journal.action(operationKey);
    if (!action || action.run_id !== runId) throw new Violation("unknown_action", `No action ${operationKey} in run ${runId}.`);
    const tool = this.adapters.tools[action.effect];
    if (!tool) throw new Violation("no_adapter", `No adapter for effect ${action.effect}.`);
    // A reconciliation is a person's message too: signed, it names the action and the revision it was asked on.
    const loaded = await this.loaded((await this.journal.run(runId)).package_hash);
    if (signed !== undefined || loaded.signed) {
      await this.deciding(runId, undefined, () => this.db.tx(async (tx) => {
        const run = await this.journal.lock(tx, runId);
        this.identify(loaded, signed, action.command_id);
        const who = await this.admit(tx, loaded, { signed }, { package: run.package_hash, run: runId, revision: run.revision, command: action.command_id, subject: action.action_digest }, ["reconcile"], payloadOf.reconcile(operationKey));
        await this.journal.event(tx, runId, "reconcile_requested", { operation: operationKey, ...who.signed });
      }));
    }
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
    const interp = this.interpreter(run, await this.loaded(run.package_hash), run.fence, true, adapters, await this.journal.startedAt(runId), await this.earlier(run));
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

/** What a waiting command shows to whoever decides on it: its digest and the role it asks (`Shown`). */
function shownBy(run: RunRow, commandId: string, row: Row): Shown {
  const request = isObj((row["result"] ?? null) as Value) ? (row["result"] as Obj) : {};
  // A decision wait shows the digest it is bound to; an amendment's, the hash of the package it asks for; a question
  // shows the digest of the question as recorded.
  const subject =
    row["kind"] === "decision" ? String(request["subject_digest"] ?? request["action_digest"] ?? "") : row["kind"] === "amendment" ? String(request["package"] ?? "") : String(row["request_digest"]);
  const role = typeof request["role"] === "string" && request["role"] !== "" ? request["role"] : undefined;
  return { package: run.package_hash, run: run.run_id, revision: run.revision, command: commandId, subject, ...(role !== undefined ? { role } : {}) };
}

/** The wait and the revision a signed decision names; a record that is none names nothing, and is refused before these are used. */
function named(signed: unknown): { commandId: string; revision: number } {
  const r = isSignedDecision(signed) ? signed.record : undefined;
  return { commandId: r?.command ?? "", revision: r?.revision ?? -1 };
}

function subjectOf(signed: unknown): string {
  return isSignedDecision(signed) ? signed.record.subject : "";
}

function kindOf(signed: unknown): DecisionKind | undefined {
  return isSignedDecision(signed) ? signed.record.kind : undefined;
}

/** The data of a `decision_refused` event: who tried, with which key, on what, and why. */
function refusedEvent(e: Refused, msg: Message | undefined): Value {
  const r = isSignedDecision(e.signed) ? e.signed.record : undefined;
  return {
    command: e.command ?? r?.command ?? null,
    reason: e.refusal.reason,
    kind: r?.kind ?? null,
    member: r?.member ?? null,
    role: r?.role ?? null,
    key: r?.key ?? null,
    ...(msg ? { sender: msg.sender, message: msg.messageId } : {}),
  };
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
