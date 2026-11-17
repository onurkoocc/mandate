// The control API (Doc 4 §16.1): StartRun, GetRun, SubmitInput, DecideAction,
// CancelRun, ReconcileAction, ReplayRun. A run is driven by a worker that
// holds its lease; a crash leaves the journal as it was, and `resume` starts a
// new worker with a higher fence that re-runs the body against the journal.

import { randomUUID } from "node:crypto";
import { atLeast, attentionFacts, callableConnectors, capsOf, check, domainHash, hashProgram, isProgram06OrLater, link, linkedProgram, packageHash, references, SANDBOX_DENIALS_FORMAT, sandboxRequirements, workflowBounds, type AttentionFacts, type Budget07, type Def, type DenialReport, type Envelope, type Json, type LibrariesConfig, type Lock, type Modules, type Program, type WorkflowDef } from "@mandate/bridge";
import { CompilerFailure } from "@mandate/bridge/mode";
import type { Adapters, Cost, EgressNeed, RunComponents, RunMode, ToolAdapter } from "./adapters.js";
import { Connectors, ConnectorWrite, connectorsOf } from "./connectors.js";
import type { WorkspaceComponent } from "./workspace.js";
import { ArtifactStore, MemoryBlobs, type ArtifactRef } from "./artifacts.js";
import { ATTENTION_MEDIA_TYPE, factsAtStart, readFacts, type FactsDoor } from "./attention.js";
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
import { costDims, haltedRefusal, Journal, limitDims, TERMINAL, type ActionRow, type BudgetReport, type EvidenceRow, type HaltRow, type HaltScope, type Limits, type RunRow } from "./journal.js";
import { ASKS, asksLimit, boundUnder } from "./asks.js";
import { exportJournal, verifyExport, type JournalExport, type JournalReport } from "./journal-chain.js";
import { buildPackage, isPackage06OrLater, isPackage07OrLater, isSigned04, libraryModules, refuseRevoked, verifyPackage, type LoadOptions, type Package } from "./package.js";
import { escalationRefused, tickOpenWaits } from "./tick.js";
import { CHECK_MS, WorkerChecker, type ProgramChecker } from "./plan.js";
import { Attention, Cancelled, Crash, Fault, StaleFence, Suspend, Violation } from "./signals.js";
import { givenValueProblem, listsRefusal, questionDigest, questionIn, REVIEW, subjectValue, VERIFY, WAIVER, waiverFacts, waiverProblem, waiverRecord, waiveRoleRefusal, WHOLE } from "./review.js";
import { canonical, digest, isObj, type Obj, type Value } from "./values.js";

export type { Lock };
export { buildPackage, isSigned04, notRunYet, RUNTIME_LANGUAGES, verifyPackage, type Package } from "./package.js";

/** The roles that own an envelope in a program: who may approve its package. */
function envelopeOwners(program: Program): Set<string> {
  return new Set(Object.values(program.defs).flatMap((d) => (d.kind === "workflow" && d.envelope?.owner !== undefined ? [d.envelope.owner] : [])));
}

/**
 * What a package needs of the egress proxy (spec/boundary.md "Sandbox egress"): whether the sandbox of one of its
 * local agents reaches a host, and each credential its lock binds, in the order agent, host.
 */
export function egressNeed(pkg: Package, running: { program: Program; modules: Modules } = { program: pkg.program, modules: pkg.modules ?? {} }): EgressNeed {
  const hosts = Object.values(sandboxRequirements(running.program, running.modules, pkg.lock)).some((r) => r.network.hosts.length > 0);
  const credentials = Object.entries(pkg.lock.egress ?? {})
    .flatMap(([agent, bound]) => Object.entries(bound ?? {}).map(([host, credential]) => ({ agent, host, credential })))
    .sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return { hosts, credentials };
}

/**
 * A stored running program as a view reads a program: the definitions the packaged program has, as the running
 * program holds them, and nothing it only sees of a module. A connector of its own is as its text declares it: the
 * marks a table of linked definitions puts on one (`module`, `unbound`) are no part of a program.
 */
function ownDefinitions(stored: Program, source: Program): Program {
  const defs = Object.fromEntries(
    Object.keys(source.defs)
      .filter((n) => Object.hasOwn(stored.defs, n))
      .map((n) => {
        const d = stored.defs[n] as unknown as Record<string, unknown>;
        if (d["kind"] !== "connector") return [n, d];
        const { module: _module, unbound: _unbound, ...declared } = d;
        return [n, declared];
      }),
  );
  return { ...stored, defs } as unknown as Program;
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
   * The violation limit (spec/boundary.md "Violations and halt"): how many violations stop a run. A 0.5 package's run
   * stops at 3 unless `limit` says otherwise; an earlier package's stops only when `limit` is given. Every run records
   * and counts its violations either way.
   */
  violations?: { limit?: number };
  /**
   * How the host's tools are read when a package's lock names their least versions (`host`; spec/boundary.md
   * "Isolation level and host fitness"). Default: this process's Node version and the first `bwrap` on PATH.
   */
  hostProbe?: HostProbe;
  /**
   * The `libraries` member of the runtime's configuration (spec/library.md "The local directory"): a package that
   * carries a `revoked` digest is not loaded, and a run of one stops at its next resume (`library_revoked`).
   */
  libraries?: Partial<LibrariesConfig>;
}

/**
 * The media type of a run's stored running program (spec/library.md "Hashes, and what the runtime stores"): the
 * expansion of its program, linked through what each library reaches, as the compiler's check gave it at the start.
 */
export const EXPANDED_MEDIA_TYPE = "application/vnd.mandate.expanded+json";

/**
 * What a connector's check at a resume stops a run with (spec/library.md "The lock binding and schema digests",
 * "Egress"): a tool whose schema is not the one the lock pins, a server that does not answer as the narrow protocol
 * allows, a request the proxy denied, a runtime with no way out for a connector, and a connector the lock does not bind.
 */
const CONNECTOR_STOPS = ["tool_schema_mismatch", "connector_protocol", "egress_denied", "no_egress_for_connector", "bad_connector"] as const;

/** What stops a run at its resume for a person, as `attention_required`, rather than being thrown at the caller. */
const STOPS_AT_RESUME = new Set(["library_revoked", "expansion_mismatch", "facts_mismatch", ...CONNECTOR_STOPS]);

/** The violation limit of a 0.5 package's run when the configuration names none. */
export const VIOLATION_LIMIT = 3;

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
/** A package as it is: its hash, its program and the modules it links, what the compiler is asked which connectors it can call of. */
interface PackageSource {
  hash: string;
  program: Program;
  modules: Modules;
}

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
  /** The configured violation limit; absent, a 0.5 package's run stops at `VIOLATION_LIMIT` and an earlier one's never. */
  readonly violationLimit: number | undefined;
  /** Reads the host's tools for a lock's `host`. */
  readonly hostProbe: HostProbe;
  /** What a package is held to at load besides itself: the configuration's libraries. */
  readonly load: LoadOptions;
  private readonly packages = new Map<string, Package>();
  /** The modules of a stored package's libraries, as loaded again from their text, by package hash. */
  private readonly linkingCache = new Map<string, Modules>();
  /** The connectors a package of 0.7 can call, by package hash (callableOf). */
  private readonly callableCache = new Map<string, ReadonlySet<string>>();
  /**
   * 0.7: the compiler's door of the attention facts, which a run's start asks, and nothing after it (attention.ts). A
   * seam: a test stands another in for it, to show that a resume and a replay read what the start stored.
   */
  attentionFacts: FactsDoor = attentionFacts;

  constructor(
    readonly db: Db,
    readonly adapters: Adapters,
    faults?: Faults,
    readonly driver?: Driver,
    options: RuntimeOptions = {},
  ) {
    this.signer = options.signer ?? EvidenceSigner.generate();
    // The evidence key signs the journal's anchors too (spec/journal.md); the journal itself holds no key.
    const signer = this.signer;
    this.journal = new Journal(db, () => adapters.clock.now(), (format, statement) => signer.signStatement(format, statement));
    this.faults = faults ?? new Faults();
    this.artifacts = options.artifacts ?? new ArtifactStore(db, new MemoryBlobs(), () => adapters.clock.now());
    this.trusted = new TrustedKeys([this.signer.publicKey, ...(options.trustedKeys ?? [])]);
    this.verifiers = options.trustedVerifiers ?? new TrustedKeys();
    this.inProcess = new Set(options.inProcessMethods ?? []);
    this.durableTimers = options.durableTimers ?? false;
    this.limiter = options.rateLimits && Object.keys(options.rateLimits).length ? new RateLimiter(db, options.rateLimits, () => adapters.clock.now()) : undefined;
    this.decisionMode = options.decisions?.mode ?? "signed";
    this.decisionKeys = options.decisions?.keys ?? new TrustedKeys();
    this.checker = options.plan?.checker ?? new WorkerChecker();
    this.checkMs = options.plan?.checkMs ?? CHECK_MS;
    this.violationLimit = options.violations?.limit;
    this.hostProbe = options.hostProbe ?? systemProbe;
    this.load = options.libraries ? { libraries: options.libraries } : {};
  }

  // ── StartRun / resume ─────────────────────────────────────────────────

  async startRun(o: StartOptions): Promise<RunRow> {
    // The run id and the tenant are text columns: what is not well-formed Unicode, or holds U+0000, would be stored
    // as something else, and the run would live under a name it was not started with (spec/journal.md).
    if (o.runId !== undefined && (o.runId === "" || !storable(o.runId))) throw new Violation("invalid_run_id", "A run id is non-empty, well-formed Unicode without U+0000; this one would be stored as another, or as none.");
    if (o.tenant !== undefined && !storable(o.tenant)) throw new Violation("invalid_tenant", "A tenant is well-formed Unicode without U+0000; this one would be stored as another.");
    // What a run of the package runs: its program linked, or (0.6) the running program its check gave (expanded, and
    // linked through what each library reaches), which the run stores at its start.
    const verified = verifyPackage(o.pkg, this.load);
    if (this.decisionMode === "unsigned" && isSigned04(o.pkg.program, o.pkg.modules)) {
      throw new Violation("signed_decisions_required", "A mandate/0.4 package does not run in unsigned mode: its decisions are signed records (spec/envelope.md). Take decisions.mode out of the runtime configuration.");
    }
    // A host below the lock's least versions starts nothing of the package: no workspace, no run, no event (unfit_host).
    // With a scheduler this process only records the run and starts its workflow; the worker that takes the run
    // checks its own host when it resumes it.
    if (!this.driver) await checkFitness(o.pkg.lock, this.hostProbe);
    // A run starts a workflow of the package's own program, as the running program holds it (its expansion, when it
    // applies a pattern): never one the program only imports.
    const wf = Object.hasOwn(o.pkg.program.defs, o.workflow) && Object.hasOwn(verified.running.defs, o.workflow) ? verified.running.defs[o.workflow] : undefined;
    if (!wf || wf.kind !== "workflow") throw new Violation("unknown_workflow", `No workflow '${o.workflow}'.`);
    // 0.7: the attention facts of the workflow, asked of the compiler with what the check at load was given, which the
    // run stores and reads from then on (spec/attention.md "The stored facts"). None given refuses the start.
    const facts = verified.facts ? factsAtStart(this.attentionFacts, verified.facts, o.workflow) : undefined;
    // 0.7: the run's `asks` limit, and the bound under the runtime's configuration it is held to (asks.ts).
    const asks = this.asksAtStart(o, wf, facts?.facts);
    const linked = verified.running;
    // The input is a value of the workflow's parameter types, as a model's answer is of its type: a Path in it keeps the Path rule (K68).
    const input = isObj(o.input ?? null) ? (o.input as Obj) : {};
    // 0.6: what a run is started with holds none of the members the runtime's own values are known by, at any depth,
    // as a person's answer holds none: a Verified value is made by a verify of the run, never handed in.
    const given = isPackage06OrLater(o.pkg) ? givenValueProblem(input) : undefined;
    if (given) throw new Violation(given.reason, `The input of ${o.workflow} is not taken. ${given.message}`);
    for (const p of wf.params) {
      if (!Object.hasOwn(input, p.name)) continue;
      const problems = schemaErrors(typeSchema(linked, p.type), input[p.name]!);
      if (problems.length) throw new Violation("input_mismatch", `Input '${p.name}' of ${o.workflow} does not fit its type: ${problems.join(", ")}.`);
    }
    // A package whose lock binds credentials needs the egress proxy; with none configured it starts nothing. With the
    // control plane's gateways on, or a package whose sandboxes reach hosts, a proxy that does not answer, or lacks a
    // gateway's credential or one the lock binds, starts nothing either.
    // A stored running program holds every definition it sees, the agents of its libraries among them.
    const need = egressNeed(o.pkg, verified.stored ? { program: verified.stored, modules: {} } : { program: o.pkg.program, modules: verified.modules });
    if (need.credentials.length && !this.adapters.egress) {
      throw new Violation("no_egress_proxy", `The package's lock binds ${need.credentials.map((c) => `${c.credential} to ${c.agent}'s requests to ${c.host}`).join(", ")}; a credential is put in only by the egress proxy, and this runtime's configuration names none (egress.admin).`);
    }
    // 0.6: the connectors the package can call, bound by its lock. A run that reaches their servers (`read_only`,
    // `live`) starts only where their requests have a way out, and the proxy is asked for their credentials too.
    const connectors = isPackage06OrLater(o.pkg) ? this.connectorsFor(linked, o.pkg.lock, this.adapters, { hash: o.pkg.hash, program: o.pkg.program, modules: verified.modules }) : undefined;
    // Every declared tool is bound now, in every mode: one that cannot be (`bad_connector`) starts nothing.
    connectors?.bindAll();
    // 0.7: a package whose connectors none can be called binds none, and needs no way out for them.
    const reaches = connectors?.any && (o.mode ?? "live") !== "design" ? connectors : undefined;
    if (reaches) {
      if (!this.adapters.connectors) {
        throw new Violation("no_egress_for_connector", `The package can call ${reaches.names().join(", ")}; a connector's requests leave only through the egress proxy, and this runtime's configuration names none (egress.admin).`);
      }
      need.connectors = reaches.credentials();
    }
    // A batch commit step is authorized by policy, never by a person: a policy that hands a person an effect a map's body commits starts nothing.
    if (isPackage06OrLater(o.pkg)) refusePersonInMap(wf, o.authorize);
    await this.adapters.egress?.ready(need);
    await this.validateBindings(linked, o.workflow);
    await this.validateExecutor(o.pkg);
    // A workflow with an envelope starts only once a member of its owner role approved this package (H03).
    const approval = wf.envelope ? await this.envelopeApproval(o.pkg, o.workflow, wf.envelope) : undefined;
    const approved = approval ? { package: o.pkg.hash, member: approval.record.member, role: approval.record.role ?? null, key: approval.record.key, decision: approval.decision_id } : undefined;
    // 0.6: what the run runs, so that a remote agent or a component a library or an expansion brings is seen; before
    // 0.6, the program as packaged, as it was.
    const seen = isPackage06OrLater(o.pkg) ? verified.running : undefined;
    const lowered = this.remoteGuarantees(seen ?? o.pkg.program);
    const runId = o.runId ?? randomUUID();
    const limits = { ...minLimits(costDims(workflowBounds(wf).budget), costDims(o.limits)), ...(asks ? { [ASKS]: asks.limit } : {}) };
    const policy: Policy = { tenant: o.tenant ?? "default", ...(o.authorize ? { authorize: o.authorize } : {}), ...(o.authorizationTtlMs ? { authorizationTtlMs: o.authorizationTtlMs } : {}), ...(o.priority ? { priority: o.priority } : {}) };
    // A halted scope starts nothing (spec/boundary.md "Violations and halt"). Asked here so that nothing is prepared
    // for a run that will not start; what decides is asked again where the run is created.
    const early = await this.journal.openHalt(policy.tenant);
    if (early) throw haltedRefusal(early, `Run ${runId} does not start`);
    // 0.6: each connector's server is asked for its tools, and every declared tool's schema is held to the digest the
    // lock pins: a difference starts nothing (`tool_schema_mismatch`), and nothing is called. A design run reaches no server.
    if (reaches) {
      await reaches.verifySchemas();
    }
    // The components the program works on start from one base commit each, recorded in the run's manifest (B3).
    const components = await this.prepareWorkspace(runId, o.pkg, seen);
    // The manifest of a run under an envelope lists the approval it starts under; another run's manifest is as it was.
    // A run that stores its running program (0.6: its program applies a pattern, or its lock pins a library) names it
    // by its hash, as `expanded`; it stores it with the run.
    const expanded = verified.stored ? { program: verified.stored, hash: hashProgram(verified.stored as unknown as Json).program } : undefined;
    const manifest = {
      format: RUN_MANIFEST_FORMAT,
      package: o.pkg.hash,
      workflow: o.workflow,
      tenant: policy.tenant,
      input: digest("request", o.input),
      mode: o.mode ?? "live",
      components,
      ...(approved ? { envelope_approval: { decision: approved.decision, member: approved.member, role: approved.role, key: approved.key } } : {}),
      ...(expanded ? { expanded: expanded.hash } : {}),
      ...(facts ? { attention: facts.digest } : {}),
    } as unknown as Value;
    const manifestHash = digest("run", manifest);
    try {
      await this.db.tx(async (tx) => {
        // Under the lock a halt of this tenant takes: a halt either committed before and is seen here, or waits for
        // this transaction and then finds the run among the open ones it ends.
        const halt = await this.journal.holdOffHalts(tx, policy.tenant);
        if (halt) throw haltedRefusal(halt, `Run ${runId} does not start`);
        await this.keep(tx, o.pkg);
        await this.journal.createRun(tx, { runId, tenant: policy.tenant, packageHash: o.pkg.hash, workflow: o.workflow, input: o.input, policy: policy as unknown as Value, limits, manifest, manifestHash, ...(asks ? { asksReserved: asks.reserved } : {}) });
        // The running program the run runs from here on, its resumes and its replays: never one made again (spec/library.md).
        if (expanded) await this.artifacts.put({ tenant: policy.tenant, runId }, canonical(expanded.program as unknown as Value), EXPANDED_MEDIA_TYPE, tx);
        // 0.7: the attention facts the run shows from here on, in its resumes and its replays: never asked again.
        if (facts) await this.artifacts.put({ tenant: policy.tenant, runId }, facts.bytes, ATTENTION_MEDIA_TYPE, tx);
        if (approved) await this.journal.event(tx, runId, "envelope_approved", approved);
        for (const agent of lowered) await this.journal.event(tx, runId, "guarantee_lowered", { agent, delivery: "at_most_once", reason: "the remote agent's server does not deduplicate messages" });
      });
    } catch (e) {
      // A run that was refused gives back the working copies it claimed: it never existed.
      if (e instanceof Violation && e.code === "halted" && Object.keys(components).length) await this.db.query("delete from workspace_claims where run_id = $1", [runId]);
      throw e;
    }
    this.packages.set(o.pkg.hash, o.pkg);
    return this.drive(runId, true);
  }

  /**
   * 0.7 (spec/attention.md "`asks` at run time"): the run's `asks` limit, the declared `asks` of its workflow (or of
   * its envelope) and the caller's `--limit asks=N` taken together, the smaller of the two; with neither, none, and the
   * run has no such row. With a limit, the bound under the runtime's configuration (the static total of the facts, and
   * the effect sites `authorize` hands to a person that the total does not count) is held to it: one above it, or
   * unbounded, refuses the start before anything is written (`attention_above_asks`). The bound is what the run
   * reserves for its own program's questions (`reserved`). A package of 0.1 to 0.6 counts no questions: a caller's
   * `asks` limit for one is refused (`unsupported_limit`).
   */
  private asksAtStart(o: StartOptions, wf: Def, facts: AttentionFacts | undefined): { limit: number; reserved: number } | undefined {
    const caller = o.limits?.asks;
    if (caller !== undefined && (!Number.isSafeInteger(caller) || caller < 0)) throw new Violation("invalid_limit", "The asks limit is a whole number of at least 0.");
    if (!facts) {
      if (caller !== undefined) throw new Violation("unsupported_limit", "The run is limited in asks, which only a run of a package of mandate/0.7 or later counts: a run of an earlier package puts no bound on its questions.");
      return undefined;
    }
    const declared = (workflowBounds(wf as WorkflowDef).budget as Budget07 | undefined)?.asks;
    const limit = asksLimit(declared, caller);
    if (limit === undefined) return undefined;
    const bound = boundUnder(facts, o.authorize);
    if (typeof bound !== "number") {
      throw new Violation("attention_above_asks", `The run's questions are more than the bound can count${bound === undefined ? " (its facts give no total)" : ""}, under the runtime's configuration, and its asks limit is ${limit}: it does not start (spec/attention.md "\`asks\` at run time").`);
    }
    if (bound > limit) {
      const added = bound - (facts.totals!.questions as number);
      throw new Violation("attention_above_asks", `The run can ask ${bound} questions under the runtime's configuration (${String(facts.totals!.questions)} in the program, and ${added} the configuration hands to a person), above its asks limit of ${limit}: it does not start (spec/attention.md "\`asks\` at run time").`);
    }
    return { limit, reserved: bound };
  }

  /** Stores a package under its hash; one that is already there is left as it is. */
  private async keep(tx: Tx, pkg: Package): Promise<void> {
    await tx.query("insert into packages (package_hash, program, lock, modules, libraries) values ($1, $2, $3, $4, $5) on conflict (package_hash) do nothing", [
      pkg.hash,
      JSON.stringify(pkg.program),
      JSON.stringify(pkg.lock),
      JSON.stringify(pkg.modules ?? {}),
      pkg.libraries?.length ? JSON.stringify(pkg.libraries) : null,
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
    verifyPackage(pkg, this.load);
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
  private async prepareWorkspace(runId: string, pkg: Package, running?: Program): Promise<RunComponents> {
    const wanted = componentsOf(pkg, running);
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
    // From here every call of the compiler is the drive's: one that fails (a CompilerFailure) stops the run for a
    // person, `compiler_failed`, and is not thrown on, so that a scheduler does not drive it again and again.
    // So does a package that now carries a revoked library digest, or a run whose stored expansion is missing or is
    // not the one its manifest names: the run stops for a person (`library_revoked`, `expansion_mismatch`).
    let interp: Interpreter;
    try {
      refuseRevoked((await this.packaged(run.package_hash)).lock, this.load);
      const loaded = await this.loaded(run.package_hash, run);
      // 0.6: every resume asks each connector's server for its tools again before the run goes on, and a schema that
      // is not the one the lock pins stops the run for a person (`tool_schema_mismatch`); nothing is called. A design
      // run reaches no server. (A start asks too, before the run exists: a difference there starts nothing.)
      const connectors = await this.connectorsAtResume(run, loaded, fence);
      // 0.7: the attention facts the run stored at its start (`facts_mismatch` when they are missing or another).
      const facts = await this.storedFacts(run);
      await this.write(runId, fence, async (tx) => this.journal.setState(tx, runId, "running"));
      interp = this.interpreter(run, loaded, fence, false, this.adapters, await this.journal.startedAt(runId), await this.earlier(run), connectors, facts);
    } catch (e) {
      if (!(e instanceof CompilerFailure) && !(e instanceof Violation && STOPS_AT_RESUME.has(e.code))) throw e;
      await this.settle(runId, fence, e);
      return this.journal.run(runId);
    }
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

  private async settle(runId: string, fence: number, thrown: unknown, interp?: Interpreter): Promise<void> {
    const e = compilerStop(thrown);
    if (e instanceof Suspend) return this.finish(runId, fence, { state: "waiting", waiting: e.waiting });
    if (e instanceof Attention) return this.finish(runId, fence, { state: "attention_required", attention: e.reason });
    if (e instanceof Cancelled) return this.closeCancelled(runId, fence);
    if (e instanceof Violation) {
      // An invariant violation is never handed to the program; the run stops for a person (§8.7).
      return this.finish(runId, fence, { state: "attention_required", attention: { violation: e.code, message: e.message } });
    }
    if (e instanceof Fault) {
      if (e.tag === "BudgetExceeded" && interp) return this.budgetExceeded(runId, fence, e, interp);
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
        if (!opened) await this.write(runId, fence, async (tx) => void (await this.journal.event(tx, runId, "budget_exceeded", { episode, detail: e.value() })));
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
    } catch (thrown) {
      const s = compilerStop(thrown);
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
    await this.write(runId, fence, async (tx) => {
      // 0.7: every stage begun and not ended ends before the run's `run_succeeded` (spec/attention.md "Events").
      if (state === "succeeded") await this.journal.endStages(tx, runId);
      await this.journal.setState(tx, runId, state, fields);
    });
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

  /**
   * Ends a cancelled run, from its actions as they are in the transaction that writes the state (`cancelTarget`). A
   * worker ends its own run, under its lease (`fence`). Without one, the cancel ends a run it found idle, as a halt
   * does (`endHalted`): under the row lock it reads the run again and leaves a run that has ended meanwhile as it
   * ended, so a run ends once; and it raises the fence, so a worker that took the lease since writes nothing more. A
   * run a halt left for an open action is the halt's: it ends `cancelled` once none is open, as `closeHalted` ends it.
   */
  private async closeCancelled(runId: string, fence?: number): Promise<void> {
    if (fence !== undefined) {
      await this.write(runId, fence, async (tx) => {
        const { state, ...fields } = cancelTarget(await this.actionsIn(tx, runId));
        await this.journal.setState(tx, runId, state, fields);
      });
      return;
    }
    await this.db.tx(async (tx) => {
      const run = await this.journal.lock(tx, runId);
      if (TERMINAL.has(run.state)) return;
      const actions = await this.actionsIn(tx, runId);
      const halted = isObj(run.attention) ? run.attention["halted"] : undefined;
      const target = typeof halted === "string" ? haltTarget(actions, halted) : cancelTarget(actions);
      if (typeof halted === "string" && target.state !== "cancelled") return;
      await tx.query("update runs set fence = fence + 1 where run_id = $1", [runId]);
      const { state, ...fields } = target;
      await this.journal.setState(tx, runId, state, fields);
    });
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

  /**
   * The connectors of a 0.6 package's running program, bound by its lock (spec/library.md "Connectors"); undefined for
   * a package of 0.1 to 0.5, and for one that holds no connector. Building it reaches no server. Their requests leave
   * by `adapters.connectors`, and a design run's samples come from `adapters.samples`.
   */
  private connectorsFor(program: Program, lock: Lock, adapters: Adapters, from: PackageSource): Connectors | undefined {
    if (!isProgram06OrLater(program) || !connectorsOf(program).length) return undefined;
    const samples = adapters.samples;
    const callable = this.callableOf(from);
    return new Connectors({ program, lock, transport: adapters.connectors, samples: samples?.tool ? (name) => samples.tool!(name) : undefined, ...(callable ? { callable } : {}) });
  }

  /**
   * Language 0.7 (spec/attention.md "Carry-over from 0.6"): the lock keys of the connectors the compiler says the
   * package can call, those E1407 demands a lock entry for; undefined for a package of 0.1 to 0.6, which binds every
   * connector its program declares. The compiler is given the package as it has it (its program and the modules it
   * links), never the running program, whose definitions hold what the modules it imports declare. A refusal of
   * the door starts nothing (`bad_connector`): the runtime does not guess which connectors can be called.
   */
  private callableOf(from: PackageSource): ReadonlySet<string> | undefined {
    if (!isPackage07OrLater({ program: from.program, modules: from.modules })) return undefined;
    const known = this.callableCache.get(from.hash);
    if (known) return known;
    let ids: Set<string>;
    try {
      ids = new Set(callableConnectors(from.program, from.modules).map((c) => c.id));
    } catch (e) {
      if (e instanceof CompilerFailure) throw e;
      throw new Violation("bad_connector", `The compiler could not say which connectors the package can call: ${e instanceof Error ? e.message : String(e)}.`);
    }
    this.callableCache.set(from.hash, ids);
    return ids;
  }

  /** A loaded package as the compiler is asked about it: as packaged, with the modules it links. */
  private sourceOf(hash: string, loaded: Loaded): PackageSource {
    return { hash, program: loaded.source, modules: loaded.modules };
  }

  /**
   * A resumed run's connectors, their schemas held to the lock again unless the run is a design run. A request of
   * the check that the proxy denied is recorded as a violation of the run, as every denied request is, before the
   * run stops.
   */
  private async connectorsAtResume(run: RunRow, loaded: Loaded, fence: number): Promise<Connectors | undefined> {
    const connectors = this.connectorsFor(loaded.program, loaded.lock, this.adapters, this.sourceOf(run.package_hash, loaded));
    const mode = isObj(run.manifest) && typeof run.manifest["mode"] === "string" ? run.manifest["mode"] : "live";
    // As at the start: every declared tool is bound before the run goes on, in every mode.
    connectors?.bindAll();
    if (!connectors?.any || mode === "design") return connectors;
    if (!this.adapters.connectors) throw new Violation("no_egress_for_connector", `Run ${run.run_id} can call ${connectors.names().join(", ")}; a connector's requests leave only through the egress proxy, and this runtime's configuration names none (egress.admin).`);
    try {
      await connectors.verifySchemas();
    } catch (e) {
      if (e instanceof Violation && e.code === "egress_denied") await this.journal.violation(run.run_id, fence, { kind: "egress_denied", delegate: "/connectors", agent: "connectors", step: `/connectors#${fence}`, detail: e.message });
      throw e;
    }
    return connectors;
  }

  /**
   * The adapter of an action's effect: the connector's, for a write tool of a 0.6 package's connector; else the
   * configuration's. It is given in an object: an adapter may have a `then` of its own (a test's does), and must not
   * be taken for a promise.
   */
  private async toolOf(runId: string, effect: string): Promise<{ tool: ToolAdapter | undefined }> {
    const run = await this.journal.run(runId);
    if (isPackage06OrLater(await this.packaged(run.package_hash))) {
      const loaded = await this.loaded(run.package_hash, run);
      const write = this.connectorsFor(loaded.program, loaded.lock, this.adapters, this.sourceOf(run.package_hash, loaded))?.write(effect);
      if (write) return { tool: write };
    }
    return { tool: this.adapters.tools[effect] };
  }

  /**
   * Whether `effect` is `<connector>.<tool>` of a connector the run's 0.6 program holds; nothing is bound, and no
   * server reached. When the package of 0.6 cannot be loaded, its connectors are not known (a library's are in the
   * running program only): an effect of the form `<name>.<tool>` could be one's, and is taken for one, so that no
   * configured adapter is asked about an operation a connector's server holds.
   */
  private async namesConnector(runId: string, effect: string): Promise<boolean> {
    const run = await this.journal.run(runId);
    if (!isPackage06OrLater(await this.packaged(run.package_hash))) return false;
    const dot = effect.indexOf(".");
    if (dot <= 0) return false;
    let program: Program;
    try {
      program = (await this.loaded(run.package_hash, run)).program;
    } catch {
      return true;
    }
    return connectorsOf(program).some(([name]) => name === effect.slice(0, dot));
  }

  private interpreter(run: RunRow, loaded: Loaded, fence: number, replay: boolean, adapters: Adapters, startedAt: number, earlier: Epoch[], bound?: Connectors, attention?: AttentionFacts): Interpreter {
    const wf = Object.hasOwn(loaded.program.defs, run.workflow) ? loaded.program.defs[run.workflow] : undefined;
    const connectors = bound ?? this.connectorsFor(loaded.program, loaded.lock, adapters, this.sourceOf(run.package_hash, loaded));
    // The limit is the package's language's: a 0.5 program's run has one by default, an earlier one's only when configured.
    const violationLimit = this.violationLimit ?? (atLeast(loaded.source.language, "mandate/0.5") ? VIOLATION_LIMIT : undefined);
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
      ...(violationLimit !== undefined ? { violationLimit } : {}),
      ...(connectors ? { connectors } : {}),
      ...(attention ? { attention } : {}),
    });
  }

  /** The program, modules, lock and libraries of a package, as packaged. */
  private async packaged(packageHash: string): Promise<{ program: Program; modules: Modules; lock: Lock; libraries: Package["libraries"] }> {
    const cached = this.packages.get(packageHash);
    if (cached) return { program: cached.program, modules: cached.modules ?? {}, lock: cached.lock, libraries: cached.libraries };
    const [row] = await this.db.query<Row>("select program, modules, lock, libraries from packages where package_hash = $1", [packageHash]);
    if (!row) throw new Violation("unknown_package", `No package ${packageHash}.`);
    return { program: row["program"] as Program, modules: (row["modules"] ?? {}) as Modules, lock: row["lock"] as Lock, libraries: (row["libraries"] ?? undefined) as Package["libraries"] };
  }

  /**
   * The modules a run of a package links: the package's, and (0.6) those of its libraries, loaded again from their
   * text and held to the lock's pins, as at load.
   */
  private async linking(packageHash: string): Promise<Modules> {
    const p = await this.packaged(packageHash);
    if (!p.libraries?.length) return p.modules;
    let libs = this.linkingCache.get(packageHash);
    if (!libs) this.linkingCache.set(packageHash, (libs = libraryModules(p)));
    return { ...p.modules, ...libs };
  }

  /**
   * A package as a run uses it. Its decisions are signed in signed mode, and always when it is a 0.4 package. With
   * `run`, the program is the run's: the running program it stored at its start, when its manifest names one (0.6),
   * which holds every definition it sees and is not linked again.
   */
  private async loaded(packageHash: string, run?: RunRow): Promise<Loaded> {
    const p = await this.packaged(packageHash);
    const modules = await this.linking(packageHash);
    const stored = run ? await this.storedExpansion(run) : undefined;
    if (stored) {
      // A running program holds every definition its program imports by name from a module the run links. One that
      // lacks such a definition is an expansion that was stored without them (the form before the running program
      // was stored): the run would meet a name with no definition, so it is not run.
      const missing = (stored.uses ?? []).flatMap((u) => (Object.hasOwn(modules, u.module) ? (u.names ?? []).filter((n) => !Object.hasOwn(stored.defs, n)) : []));
      if (missing.length) {
        throw new Violation("expansion_mismatch", `Run ${run!.run_id} stored an expansion without the definitions its program imports (${[...new Set(missing)].sort().join(", ")}): it is not a running program, and is not run (spec/library.md).`);
      }
    }
    return { program: stored ?? linkedProgram(p.program, modules), lock: p.lock, signed: this.decisionMode === "signed" || isSigned04(p.program, p.modules), source: p.program, modules };
  }

  /**
   * What the views of a run's program are given: the program as packaged (`source`), the program the run runs as a
   * view reads one (`program`), and the modules it links (with its libraries'). For a run that stored its running
   * program (0.6), `program` is the program's own definitions as that one holds them (its expansion, when it applies
   * a pattern), with its `use`s: what it sees of its modules a view links itself. For any other, the same as `source`.
   */
  async runProgram(runId: string): Promise<{ source: Program; program: Program; modules: Modules }> {
    const run = await this.journal.run(runId);
    // As stored, never as this process holds it: a view is made of what the database holds, members in its order.
    const [row] = await this.db.query<Row>("select program, modules, lock, libraries from packages where package_hash = $1", [run.package_hash]);
    if (!row) throw new Violation("unknown_package", `No package ${run.package_hash}.`);
    const source = row["program"] as Program;
    const libraries = (row["libraries"] ?? undefined) as Package["libraries"];
    const modules = { ...((row["modules"] ?? {}) as Modules), ...(libraries?.length ? libraryModules({ lock: row["lock"] as Lock, libraries }) : {}) };
    const stored = await this.storedExpansion(run);
    return { source, program: stored ? ownDefinitions(stored, source) : source, modules };
  }

  /**
   * The running program a run stored at its start (spec/library.md "Hashes, and what the runtime stores"): the
   * expansion of its program, with every definition it sees linked in. Undefined for a run whose manifest names none. One that is missing, or whose bytes do not hash to what the manifest names,
   * is not run: `expansion_mismatch`. It is never made again: a compiler that expands the package otherwise now
   * cannot move the command ids of a run that is going on.
   */
  async storedExpansion(run: RunRow): Promise<Program | undefined> {
    const named = isObj(run.manifest) ? run.manifest["expanded"] : undefined;
    if (named === undefined) return undefined;
    const scope = { tenant: run.tenant, runId: run.run_id };
    const stored = (await this.artifacts.list(scope)).filter((a) => a.media_type === EXPANDED_MEDIA_TYPE);
    for (const a of stored) {
      try {
        const program = JSON.parse(await this.artifacts.text(scope, a.ref)) as Program;
        if (hashProgram(program as unknown as Json).program === named) return program;
      } catch (e) {
        // Bytes that do not read, or do not hash, are no expansion; a compiler that fails has decided nothing.
        if (e instanceof CompilerFailure) throw e;
      }
    }
    throw new Violation(
      "expansion_mismatch",
      `Run ${run.run_id}'s manifest names the expansion ${String(named)}, and ${stored.length ? "no expansion stored with the run hashes to it" : "none is stored with the run"}: a run runs the expansion it stored at its start, and no other (spec/library.md).`,
    );
  }

  /**
   * The attention facts a run of 0.7 stored at its start (spec/attention.md "The stored facts"), by the digest its
   * manifest names as `attention`: undefined for a run whose manifest names none (every run of 0.1 to 0.6). Facts that
   * are missing, or whose bytes do not hash to that digest, are not read: `facts_mismatch`. They are never asked of the
   * compiler again: one upgraded while the run goes on does not change what the run shows.
   *
   * After an amendment the owner approved (D6 of slice B3), the facts in force are those of the amended workflow,
   * stored with the lead's request and named by the run's latest `package_amended` (`attention`): the run reads them
   * from there on, at every resume and replay. The facts of each earlier package stay stored, named where they were.
   */
  async storedFacts(run: RunRow): Promise<AttentionFacts | undefined> {
    const named = isObj(run.manifest) ? run.manifest["attention"] : undefined;
    if (named === undefined) return undefined;
    const scope = { tenant: run.tenant, runId: run.run_id };
    const [amended] = await this.db.query<Row>("select data->'attention' as attention from events where run_id = $1 and type = 'package_amended' and data ? 'attention' order by seq desc limit 1", [run.run_id]);
    if (amended) return readFacts(this.artifacts, scope, amended["attention"], `Run ${run.run_id}'s amendment`);
    return readFacts(this.artifacts, scope, named, `Run ${run.run_id}'s manifest`);
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
    // The run's program: the running program it stored (0.6), which holds the contracts a pattern of a library names.
    const { lock, signed, program } = await this.loaded(run.package_hash, run);
    // A person's approval rests on their signed decision (H04): the record it names must still be the one they signed.
    const decisions = new Map((await this.journal.decisions(runId)).map((d) => [d.decision_id, d]));
    const rule: AttestationRule = { keys: this.verifiers, inProcess: this.inProcess };
    const contractOf = (name: string): Program["defs"][string] | undefined => (Object.hasOwn(program.defs, name) ? program.defs[name] : undefined);
    const declared = (record: EvidenceRecord): string[] | undefined => criterionMethods(contractOf(record.contract), record.criterion);
    const rows = await this.journal.evidence(runId);
    // A waiver (0.6) is held to the review decision it names and the failed record it waives (review.ts); in a run of
    // 0.1 to 0.5 one holds nothing.
    const from06 = isProgram06OrLater(program);
    const facts = from06 && rows.some((e) => e.method === WAIVER) ? await waiverFacts(this.journal, runId, { contract: contractOf, keys: this.decisionKeys, lock, trusted: this.trusted }) : undefined;
    // A verify's own record (0.6) is of the contract whole, and no criterion's check: it holds by its signature.
    const holds = (e: (typeof rows)[number], record: EvidenceRecord): boolean =>
      record.method === WAIVER || e.method === WAIVER
        ? !!facts && record.method === e.method && !waiverProblem(record, facts)
        : record.method === VERIFY || e.method === VERIFY
          ? from06 && record.method === e.method && record.criterion === WHOLE
          : !recordProblem(record, { ...e, run: runId }, declared(record), rule) && !approvalProblem(record, decisions, this.decisionKeys, lock, signed);
    return rows.map((e) => ({
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
        holds(e, e.record as unknown as EvidenceRecord),
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
    // A review's decision (0.6) is one like any other: its record, signature and the lock's binding of its key.
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
    if (!row || row["state"] !== "waiting" || (row["kind"] !== "input" && row["kind"] !== "decision" && row["kind"] !== "amendment" && row["kind"] !== REVIEW)) throw new Violation("no_wait", `Run ${runId} is not waiting for a person.`);
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

  // ── the chained journal (spec/journal.md) ─────────────────────────────

  /** The run's journal as an outsider checks it: events, anchors, the manifest and the package (`mandate journal export`). */
  exportJournal(runId: string): Promise<JournalExport> {
    return exportJournal(this.db, runId);
  }

  /**
   * Verifies the run's journal as an outsider would: its export, as the bytes `mandate journal export` writes, under
   * the keys this runtime trusts, its own and those rotated out. Nothing here is read from the database but the export.
   */
  async verifyJournal(runId: string): Promise<JournalReport> {
    return verifyExport(JSON.stringify(await this.exportJournal(runId)), this.trusted.publicKeys());
  }

  // ── SubmitInput / DecideAction ────────────────────────────────────────

  /**
   * Answers a wait opened by human.ask, escalate or pause; then resumes the
   * run. `revision` is the run revision the answer was given on (GetRun).
   */
  async submitInput(runId: string, msg: Message, i: { commandId: string; revision: number; value: Value } | { value: Value; signed: SignedDecision }): Promise<RunRow> {
    const signed = "signed" in i ? i.signed : undefined;
    const at = "signed" in i ? named(i.signed) : i;
    // 0.6: an answer holds none of the members the runtime's own values are known by, at any depth: a person's answer
    // that looked like a Verified value would otherwise reach a step that takes one. Refused by name, and the wait stays.
    const from06 = isPackage06OrLater(await this.packaged((await this.journal.run(runId)).package_hash));
    const fresh = await this.resolveWait(runId, msg, at.commandId, at.revision, "input", i as unknown as Value, { signed, kinds: ["answer"], payload: payloadOf.answer(i.value) }, async () => {
      const why = from06 ? givenValueProblem(i.value) : undefined;
      if (why) throw new Refused({ reason: why.reason, message: `The answer is not taken. ${why.message}` }, signed, at.commandId);
      return { state: "succeeded", result: i.value };
    });
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
   * A person's decision on a review's wait (0.6; spec/library.md "The wait and the decision"): a signed record of kind
   * `review` whose command is the review's wait, whose subject is the digest of what the wait asks, made in the role
   * the wait asks now, and whose payload is the digest of `{ waive, decline }`: the input indices of the open items
   * it waives and of those it declines. It is held, in this order, to every rule of a decision (who signed, what the
   * record is for, the role: `invalid_decision`), to the wait's deadline (`past_deadline`), to deciding every open
   * item exactly once and nothing else (`incomplete_review`), and to its role being one that every failed criterion
   * of each item it waives names in its `waive by` (`not_in_role`); the rules are review.ts's. A refused decision
   * changes nothing: `decision_refused` is recorded, and the wait stays open.
   *
   * Taken, in the one transaction that takes it: for each failed record of each item it waives, a waiver record
   * beside it, signed by the runtime (`criterion_waived`), then `review_decided`. The decision names indices and
   * nothing else: what a waived item's value is, is what its verify journaled.
   */
  async decideReview(runId: string, msg: Message, d: { signed: SignedDecision; waive: number[]; decline: number[] }): Promise<RunRow> {
    // Only these are taken from the caller: whatever else comes with them is no part of the decision. Nothing of them
    // is read before who signed is: lists that are not lists are refused below, after the signature, and recorded.
    // Lists of numbers alone: anything else (a BigInt among them, which no digest takes) is lists that are not lists.
    const shaped = Array.isArray(d?.waive) && Array.isArray(d?.decline) && [...d.waive, ...d.decline].every((x) => typeof x === "number");
    const lists = { waive: shaped ? [...d.waive] : [], decline: shaped ? [...d.decline] : [] };
    const at = named(d?.signed);
    const seen = await this.journal.run(runId);
    const loaded = await this.loaded(seen.package_hash, seen);
    const fresh = await this.resolveWait(runId, msg, at.commandId, at.revision, REVIEW, { signed: d?.signed ?? null, waive: shaped ? d.waive : null, decline: shaped ? d.decline : null } as unknown as Value, { signed: d?.signed, kinds: [REVIEW], payload: payloadOf.review(lists) }, async (tx, request, run, who) => {
      // A review is decided by a signed record alone, whatever the runtime's mode.
      const signer = isObj(who.signed as Value) && typeof who.signed.member === "string" ? (who.signed as { member: string; role: string | null; key: string; decision: string }) : undefined;
      if (!signer) throw new Refused({ reason: "invalid_signature", message: "A review is decided by a signed decision, and this one carries no signature." }, d?.signed, at.commandId);
      if (!shaped) throw new Refused({ reason: "incomplete_review", message: "A review's decision names the items it waives and those it declines, each as a list of indices." }, d.signed, at.commandId);
      const req = isObj(request) ? request : {};
      const q = questionIn(req);
      // What the person signed is the digest the wait shows; the question it stands for is the one it is the digest of.
      if (!q || questionDigest(q) !== req["subject_digest"]) throw new Violation("forged_evidence", `The review's wait at ${at.commandId} holds another question than the one its subject names.`);
      const deadline = req["deadline"];
      if (typeof deadline !== "number" || this.adapters.clock.now() >= deadline) {
        throw new Refused({ reason: "past_deadline", message: "The review's deadline has passed: the wait is escalated or it expires, and nothing is decided on its own." }, d.signed, at.commandId);
      }
      const incomplete = listsRefusal(q, lists);
      if (incomplete) throw new Refused(incomplete, d.signed, at.commandId);
      const c = Object.hasOwn(loaded.program.defs, q.contract) ? loaded.program.defs[q.contract] : undefined;
      const notInRole = waiveRoleRefusal(c, q, lists.waive as number[], signer.role ?? undefined);
      if (notInRole) throw new Refused(notInRole, d.signed, at.commandId);
      const decision = { id: signer.decision, member: signer.member, role: String(signer.role), key: signer.key };
      const waived = q.items.filter((i) => (lists.waive as number[]).includes(i.index)).sort((a, b) => a.index - b.index);
      const rows = new Map((await this.journal.evidence(runId, waived.flatMap((i) => i.unmet.flatMap((u) => u.failed)), tx)).map((r) => [r.evidence_id, r]));
      for (const item of waived) {
        for (const u of item.unmet) {
          if (!u.failed.length) throw new Violation("forged_evidence", `Item ${item.index} of the review at ${at.commandId} failed ${q.contract}.${u.criterion} with no record to waive.`);
          for (const id of u.failed) {
            // The record waived is the failed check of this item's value that the review asked about, as it was signed.
            const row = rows.get(id);
            const failed = (row?.record ?? null) as EvidenceRecord | null;
            const holds = !!row && !!failed && !!row.key_id && !!row.signature && this.trusted.verify(failed, { key_id: row.key_id, signature: row.signature }) && failed.evidence_id === id && !row.passed && failed.passed === false && failed.method !== WAIVER;
            if (!holds || failed!.contract !== q.contract || failed!.criterion !== u.criterion || subjectValue(failed) !== item.value_digest) {
              throw new Violation("forged_evidence", `${id}, which item ${item.index} of the review at ${at.commandId} failed, is not a signed failed record of ${q.contract}.${u.criterion} for that item's value.`);
            }
            const waiver = waiverRecord({ run: runId, package: run.package_hash, failed: failed!, decision, review: at.commandId, index: item.index, at: this.adapters.clock.now() });
            await this.journal.recordEvidence(runId, { record: waiver, ...this.signer.sign(waiver) }, tx);
            await this.journal.event(tx, runId, "criterion_waived", { command: at.commandId, index: item.index, contract: q.contract, criterion: u.criterion, waiver: waiver.evidence_id, failed: id, decision: decision.id });
          }
        }
      }
      const decided = { waive: [...(lists.waive as number[])].sort((a, b) => a - b), decline: [...(lists.decline as number[])].sort((a, b) => a - b) };
      await this.journal.event(tx, runId, "review_decided", { command: at.commandId, ...decided, by: who.by, ...who.signed });
      return { state: "succeeded", result: { subject: String(req["subject_digest"]), ...decided, by: who.by, ...who.signed } };
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
    // 0.7 (D6 of slice B3): the facts of the amended workflow, stored with the request, and those in force now, read
    // before the transaction too; the run's own reservation of `asks` moves by what the bound under the configuration
    // moves by.
    const seen = await this.journal.run(runId);
    const amended = approve && typeof asked["attention"] === "string" ? await readFacts(this.artifacts, { tenant: seen.tenant, runId }, asked["attention"], `The amendment at ${at.commandId}`) : undefined;
    const now = amended ? await this.storedFacts(seen) : undefined;
    const authorize = (seen.policy as unknown as Policy).authorize;
    const boundNow = now ? boundUnder(now, authorize) : undefined;
    const boundNext = amended ? boundUnder(amended, authorize) : undefined;
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
      // 0.7: `asks` rises with the envelope's, as every other dimension does.
      const dims = (b: Budget07 | undefined): Record<string, number> => ({ ...costDims(b), ...(amended && typeof b?.asks === "number" ? { [ASKS]: b.asks } : {}) });
      const before = dims(was?.kind === "workflow" ? was.envelope?.budget : undefined);
      const limits = Object.fromEntries(Object.entries(dims(wf.envelope.budget)).filter(([dim, amount]) => amount > (before[dim] ?? amount)));
      const moved = await this.journal.amendRun(tx, runId, at.commandId, to, limits);
      // The run's own questions are bounded by the amended program's bound from here on: its reservation moves by what
      // the bound moves by, up by what is left of the run's `asks` at most.
      if (typeof boundNext === "number") await this.journal.moveParentAsks(tx, run, boundNext - (typeof boundNow === "number" ? boundNow : boundNext));
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
        ...(amended ? { attention: String(asked["attention"]) } : {}),
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
    const loaded = await this.loaded(seen.package_hash, seen);
    const wf = loaded.program.defs[seen.workflow];
    // 0.7: `asks` too, up to the declared value and no further; a run whose workflow declares none was limited by its
    // caller alone, and is raised as any other such limit is, with no ceiling of the program's.
    const declared = wf?.kind === "workflow" ? (workflowBounds(wf).budget as Budget07 | undefined)?.asks : undefined;
    const program: Record<string, number> = { ...costDims(wf?.kind === "workflow" ? workflowBounds(wf).budget : undefined), ...(typeof declared === "number" ? { [ASKS]: declared } : {}) };
    if (r.limits.asks !== undefined && (!Number.isSafeInteger(r.limits.asks) || r.limits.asks < 0)) throw new Violation("invalid_limit", "The asks limit is a whole number of at least 0.");
    const wanted = limitDims(r.limits);
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
          const what = dim === ASKS ? `asks: ${program[dim]}` : `a ${dim} budget of ${program[dim]}`;
          throw new Violation(
            "above_program_budget",
            enveloped
              ? `${run.workflow}'s envelope gives ${what}; raising the run to ${limit} needs an amendment of the envelope, which its owner approves (spec/envelope.md).`
              : `${run.workflow} declares ${what}; raising the run to ${limit} needs a new program version (§13.2).`,
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
    // 0.7 (spec/attention.md "The driver loop"): every open wait past its deadline, and a wait decided and not driven on.
    if (run.state === "waiting" && isPackage07OrLater(await this.packaged(run.package_hash))) {
      const fit = async (): Promise<void> => (this.driver ? undefined : checkFitness((await this.packaged(run.package_hash)).lock, this.hostProbe));
      return tickOpenWaits(this, runId, { fit, drive: (id) => this.drive(id) });
    }
    const w = run.waiting;
    if (run.state !== "waiting" || !isObj(w)) return run;
    const req = w["request"];
    const deadline = isObj(req) ? req["deadline"] : null;
    // A review (0.6) is escalated once, when it has a role to escalate to, and then expires; and a review that was
    // decided while the drive after it did not run is driven now, whatever its deadline. One that waits within its
    // deadline is left as it is, and nothing is asked of the host for it.
    if (w["kind"] === REVIEW) {
      const due = typeof deadline === "number" && this.adapters.clock.now() >= deadline;
      const [row] = due ? [] : await this.db.query<Row>("select state from commands where run_id = $1 and command_id = $2", [runId, String(w["command"])]);
      if (!due && (!row || row["state"] === "waiting")) return run;
      return this.expireReview(runId, String(w["command"]));
    }
    if (typeof deadline !== "number" || this.adapters.clock.now() < deadline) return run;
    if (w["kind"] === "timer") return this.drive(runId);
    // A decision expires, and so does an amendment nobody answered: the lead is told, and the envelope stays.
    if (w["kind"] !== "decision" && w["kind"] !== "amendment") return run;
    // A runtime that resumes the run itself checks its host first, as the resume would: an unfit host expires
    // nothing, and the wait stays for a fit host to expire (unfit_host). With a scheduler, its worker checks.
    if (!this.driver) await checkFitness((await this.packaged(run.package_hash)).lock, this.hostProbe);
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

  /**
   * A review's wait past its deadline (0.6; spec/library.md "Escalation and expiry"). Nothing passes on its own:
   *
   * - with `escalate_to`, once: the same question is asked of that role, with a new deadline of the same length from
   *   when it is escalated, so that role has a whole deadline of its own (`review_escalated`); a tick that comes late
   *   escalates and nothing more. The run's revision moves and the wait asks the new role, so a decision for the first
   *   role is refused;
   * - else, or once the escalated deadline has passed too: every open item is declined, by nobody (`review_expired`,
   *   `wait_expired`), and the run goes on.
   *
   * A run that waits on a review its decision has already ended (the drive after the decision did not run: a crash,
   * a failure of the compiler) is driven, as a decision's expiry drives its run. A runtime that resumes the run itself
   * checks its host first, as a decision's expiry does.
   */
  private async expireReview(runId: string, command: string): Promise<RunRow> {
    if (!this.driver) await checkFitness((await this.packaged((await this.journal.run(runId)).package_hash)).lock, this.hostProbe);
    const now = this.adapters.clock.now();
    const done = await this.db.tx(async (tx): Promise<"escalated" | "expired" | "decided" | undefined> => {
      const run = await this.journal.lock(tx, runId);
      const w = isObj(run.waiting) ? run.waiting : {};
      if (run.state !== "waiting" || w["command"] !== command) return undefined;
      const [row] = await tx.query<Row>("select kind, state, result, inside from commands where run_id = $1 and command_id = $2", [runId, command]);
      if (row && row["kind"] === REVIEW && row["state"] !== "waiting") return "decided";
      const req = row && isObj((row["result"] ?? null) as Value) ? (row["result"] as Obj) : undefined;
      if (!row || row["kind"] !== REVIEW || row["state"] !== "waiting" || !req) return undefined;
      const q = questionIn(req);
      const deadline = req["deadline"];
      const ms = req["deadline_ms"];
      if (!q || typeof deadline !== "number" || typeof ms !== "number" || now < deadline) return undefined;
      const role = String(req["role"]);
      const to = req["escalate_to"];
      // The escalation is a question, counted in this transaction (spec/attention.md "Counting"); a run of 0.1 to 0.6
      // has no `asks` limit, and counts nothing. Past the limit it is not made, and the review expires below.
      if (typeof to === "string" && to !== role && req["escalated"] === undefined && !(await escalationRefused(this.journal, tx, run, command, row["inside"]))) {
        const next: Obj = { ...req, role: to, deadline: now + ms, escalated: { from: role, at: now } };
        await tx.query("update commands set result = $3 where run_id = $1 and command_id = $2 and state = 'waiting'", [runId, command, JSON.stringify(next)]);
        await this.journal.event(tx, runId, "review_escalated", { command, from: role, to, deadline: now + ms });
        await this.journal.setState(tx, runId, "waiting", { waiting: { ...w, request: next } });
        return "escalated";
      }
      const open = q.items.map((i) => i.index).sort((a, b) => a - b);
      const outcome: Obj = { subject: String(req["subject_digest"]), waive: [], decline: open, by: null, role, expired: true };
      await tx.query("update commands set state = 'succeeded', result = $3, error = null where run_id = $1 and command_id = $2 and state = 'waiting'", [runId, command, JSON.stringify(outcome)]);
      await this.journal.event(tx, runId, "review_expired", { command, role, declined: open });
      await this.journal.event(tx, runId, "wait_expired", { command });
      return "expired";
    });
    return done === "expired" || done === "decided" ? this.drive(runId) : this.journal.run(runId);
  }

  private async resolveWait(
    runId: string,
    msg: Message,
    commandId: string,
    revision: number,
    kind: "input" | "decision" | "amendment" | typeof REVIEW,
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
   * before it is followed to its real result (R09). A run ends once: the
   * cancel that ends an idle run takes its lease, and leaves a run that
   * ended meanwhile as it ended (`closeCancelled`).
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
      // A run no worker is driving is ended by this cancel, so the cancel takes its lease, as a halt does: a worker
      // that took it before, and has not written yet, writes nothing. A running run keeps its worker, which meets the
      // cancel at its next dispatch (R08) and follows an action in flight to its result (R09).
      const idle = run.state === "waiting" || run.state === "accepted" || run.state === "attention_required";
      await tx.query(`update runs set cancel_requested = true,${idle ? " fence = fence + 1," : ""} revision = revision + 1 where run_id = $1`, [runId]);
      await this.journal.event(tx, runId, "cancel_requested", who);
      return idle;
    });
    // An action whose outcome is unknown is asked to stop: an adapter that can prove it never took effect resolves it.
    for (const a of await this.journal.actions(runId)) {
      if (a.state === "unknown_outcome") await this.cancelAction(runId, a.operation_key);
    }
    if (idle) await this.closeCancelled(runId);
    if (this.driver) await this.driver.wake(runId);
    const row = await this.journal.run(runId);
    // What the run holds open outside the runtime (its gateway sessions, wherever they were opened) is cut. The
    // cancel is recorded whatever the proxy says; a proxy that did not revoke is reported to the caller.
    if (this.adapters.revoke) {
      try {
        await this.adapters.revoke({ run: runId });
      } catch (e) {
        throw new Violation("egress_unavailable", `run ${runId} is cancelled, and its egress sessions were not revoked: ${(e as Error).message}`);
      }
    }
    return row;
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
    // A connector's adapter (0.6) cannot cancel. When the adapter cannot be read (the package, its connectors), the
    // effect is still the configuration's to cancel unless it names a tool of a connector the program holds.
    const { tool } = await this.toolOf(runId, action.effect).catch(async () => ({ tool: (await this.namesConnector(runId, action.effect).catch(() => false)) ? undefined : this.adapters.tools[action.effect] }));
    if (tool?.cancel && (action.state === "unknown_outcome" || action.state === "prepared")) {
      const r = await tool.cancel(operationKey);
      if ("cancelled" in r) await this.journal.finishAction(runId, undefined, operationKey, "cancelled", { detail: { cancelled: r.cancelled } });
      else if ("tooLate" in r) await this.journal.finishAction(runId, undefined, operationKey, "confirmed", { receipt: r.tooLate });
    }
    return this.journal.run(runId);
  }

  // ── Halt (spec/boundary.md "Violations and halt") ─────────────────────

  /**
   * Halts a tenant, or every tenant: the hard stop. In one transaction, under the lock every start and every resume
   * of the scope takes (`Journal.holdOffHalts`), it records the halt, and then ends every run of the scope that has
   * not ended: it locks the run, records that it was cancelled (`cancel_requested`) and that its lease was revoked
   * (`lease_revoked`), drops the lease (the fence goes up, so a worker that was driving the run writes nothing more),
   * and ends the run `cancelled`, or `attention_required` while an action is open (INV-12). A second sweep in the
   * same transaction ends a run that a writer which does not take the lock (a runtime of an earlier version) created
   * meanwhile.
   *
   * Once that has committed, as a cancel does, an action whose outcome is unknown is asked to stop, and a run whose
   * actions are all resolved by that ends `cancelled`; the scheduler is told; and the adapters are told to revoke
   * what they hold open for the scope. A failure of any of these undoes nothing: the runs have ended, and the report
   * says what failed.
   *
   * `between` is a seam for tests: it runs between the two sweeps, inside the transaction.
   */
  async halt(scope: HaltScope, o: { reason?: string; by?: string; between?: (tx: Tx) => Promise<void> } = {}): Promise<HaltReport> {
    if ("tenant" in scope && (scope.tenant === "" || !storable(scope.tenant))) throw new Violation("invalid_tenant", "A tenant is non-empty, well-formed Unicode without U+0000.");
    const halt: HaltRow = { halt_id: `halt-${randomUUID()}`, tenant: "tenant" in scope ? scope.tenant : null, reason: o.reason ?? null, halted_by: o.by ?? null, halted_at: this.adapters.clock.now(), lifted_by: null, lifted_at: null };
    const ended: HaltReport["ended"] = [];
    await this.db.tx(async (tx) => {
      await this.journal.lockHaltScope(tx, scope);
      await tx.query("insert into halts (halt_id, tenant, reason, halted_by, halted_at) values ($1, $2, $3, $4, $5)", [halt.halt_id, halt.tenant, halt.reason, halt.halted_by, halt.halted_at]);
      const done = new Set<string>();
      const sweep = async (): Promise<void> => {
        // In run id order, so that two halts that cover the same runs lock them in the same order.
        const open = await tx.query<Row>(
          `select run_id from runs where state not in ('succeeded', 'failed', 'cancelled')${halt.tenant === null ? "" : " and tenant = $1"} order by run_id for update`,
          halt.tenant === null ? [] : [halt.tenant],
        );
        for (const r of open) {
          const runId = String(r["run_id"]);
          if (done.has(runId)) continue;
          done.add(runId);
          const e = await this.endHalted(tx, runId, halt);
          if (e) ended.push(e);
        }
      };
      await sweep();
      await o.between?.(tx);
      await sweep();
    });
    const problems: string[] = [];
    for (const e of ended) {
      if (e.state !== "attention_required") continue;
      try {
        for (const a of await this.journal.actions(e.run)) if (a.state === "unknown_outcome") await this.cancelAction(e.run, a.operation_key);
        e.state = await this.closeHalted(e.run);
      } catch (x) {
        problems.push(`run ${e.run}: asking its open actions to stop failed: ${(x as Error).message}`);
      }
    }
    for (const e of ended) {
      try {
        await this.driver?.wake(e.run);
      } catch (x) {
        problems.push(`run ${e.run}: its scheduler was not told: ${(x as Error).message}`);
      }
    }
    let revoke: HaltReport["revoke"] = "none";
    if (this.adapters.revoke) {
      try {
        await this.adapters.revoke("all" in scope ? { all: true } : { tenant: scope.tenant });
        revoke = "revoked";
      } catch (x) {
        revoke = { failed: (x as Error).message };
      }
    }
    return { halt, ended, revoke, problems };
  }

  /** Ends one run for a halt, in the halt's transaction; a run that has ended meanwhile is left as it is. */
  private async endHalted(tx: Tx, runId: string, halt: HaltRow): Promise<HaltReport["ended"][number] | undefined> {
    const run = await this.journal.lock(tx, runId);
    if (TERMINAL.has(run.state)) return undefined;
    await tx.query("update runs set cancel_requested = true, fence = fence + 1, revision = revision + 1, updated_at = $2 where run_id = $1", [runId, this.adapters.clock.now()]);
    await this.journal.event(tx, runId, "cancel_requested", { halt: halt.halt_id, ...(halt.reason !== null ? { reason: halt.reason } : {}), ...(halt.halted_by !== null ? { by: halt.halted_by } : {}) });
    await this.journal.event(tx, runId, "lease_revoked", { halt: halt.halt_id, fence: run.fence });
    const target = haltTarget(await this.actionsIn(tx, runId), halt.halt_id);
    const { state, ...fields } = target;
    await this.journal.setState(tx, runId, state, fields);
    return { run: runId, tenant: run.tenant, state };
  }

  /** The run's actions, read in `tx`: an in-process database has one connection. */
  private async actionsIn(tx: Tx, runId: string): Promise<ActionRow[]> {
    return (await tx.query<Row>("select * from actions where run_id = $1 order by command_id", [runId])) as unknown as ActionRow[];
  }

  /**
   * A run a halt left `attention_required`, for an action that was open: once no action of it is open, it ends
   * `cancelled`, as a cancelled run does. Returns the state the run is in.
   */
  private async closeHalted(runId: string): Promise<RunRow["state"]> {
    return this.db.tx(async (tx) => {
      const run = await this.journal.lock(tx, runId);
      const halted = isObj(run.attention) ? run.attention["halted"] : undefined;
      if (run.state !== "attention_required" || !run.cancel_requested || typeof halted !== "string") return run.state;
      const target = haltTarget(await this.actionsIn(tx, runId), halted);
      if (target.state !== "cancelled") return run.state;
      await this.journal.setState(tx, runId, "cancelled", { summary: target.summary });
      return "cancelled";
    });
  }

  /**
   * Lifts the halts of exactly `scope`, recorded with who lifted them; a lift is not signed. A lift of all tenants
   * lifts the halts of all tenants and leaves each tenant's own halt as it is; a lift of a tenant leaves a halt of
   * all tenants as it is. Lifting brings no run back: what a halt ended stays ended. Returns the halts it lifted.
   */
  async liftHalt(scope: HaltScope, by: string): Promise<HaltRow[]> {
    if (!by.trim()) throw new Violation("invalid_lift", "A lift says who lifts the halt (--by).");
    if ("tenant" in scope && (scope.tenant === "" || !storable(scope.tenant))) throw new Violation("invalid_tenant", "A tenant is non-empty, well-formed Unicode without U+0000.");
    const lifted = await this.db.tx(async (tx) => {
      await this.journal.lockHaltScope(tx, scope);
      return tx.query<Row>(
        `update halts set lifted_at = $1, lifted_by = $2 where lifted_at is null and ${"all" in scope ? "tenant is null" : "tenant = $3"} returning halt_id`,
        "all" in scope ? [this.adapters.clock.now(), by] : [this.adapters.clock.now(), by, scope.tenant],
      );
    });
    if (!lifted.length) throw new Violation("not_halted", `${"all" in scope ? "No halt of every tenant" : `No halt of tenant ${scope.tenant}`} is in force.`);
    const ids = new Set(lifted.map((r) => String(r["halt_id"])));
    return (await this.journal.halts()).filter((h) => ids.has(h.halt_id));
  }

  /** Every halt, lifted or not, oldest first; with `open`, only those in force. */
  async halts(o: { open?: boolean } = {}): Promise<HaltRow[]> {
    const all = await this.journal.halts();
    return o.open ? all.filter((h) => h.lifted_at === null) : all;
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
    const { tool } = await this.toolOf(runId, action.effect);
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
    // A connector's tool (0.6): its server is asked only once its schemas are the ones the lock pins, as at a resume;
    // and a request of either that the proxy denied is a violation of the run, recorded once for the action.
    const denied = async (detail: string): Promise<void> => {
      const run = await this.journal.run(runId);
      await this.journal.violation(runId, run.fence, { kind: "egress_denied", delegate: action.command_id, agent: action.effect, step: `${action.command_id}#reconcile`, detail });
    };
    if (tool instanceof ConnectorWrite) {
      try {
        await tool.verifyBeforeAsking();
      } catch (e) {
        if (e instanceof Violation && e.code === "egress_denied") await denied(e.message);
        throw e;
      }
    }
    const r = await tool.reconcile(operationKey);
    if (tool instanceof ConnectorWrite && "unknown" in r && typeof (r as { denied?: unknown }).denied === "string") await denied(`The egress proxy denied the reconciliation of ${action.effect} (${(r as { denied: string }).denied}); it was not sent upstream.`);
    if ("applied" in r) await this.journal.finishAction(runId, undefined, operationKey, "confirmed", { receipt: r.applied });
    else if ("notApplied" in r) await this.journal.finishAction(runId, undefined, operationKey, "prepared", { detail: { not_applied: r.notApplied } });
    else return this.journal.run(runId);
    // A halted scope resumes nothing (spec/boundary.md "Violations and halt"). A run the halt left for an open action
    // ends `cancelled` once none is open, as a cancelled run does; it is not driven.
    const after = await this.journal.run(runId);
    if (!TERMINAL.has(after.state) && (await this.journal.openHalt(after.tenant))) {
      await this.closeHalted(runId);
      return this.journal.run(runId);
    }
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
    let loaded: Loaded;
    let facts: AttentionFacts | undefined;
    try {
      loaded = await this.loaded(run.package_hash, run);
      facts = await this.storedFacts(run);
    } catch (e) {
      // A stored expansion, or stored attention facts (0.7), missing or another: the replay reports it, and runs nothing.
      if (e instanceof Violation && (e.code === "expansion_mismatch" || e.code === "facts_mismatch")) return { status: "attention_required", reason: { violation: e.code, message: e.message } };
      throw e;
    }
    const interp = this.interpreter(run, loaded, run.fence, true, adapters, await this.journal.startedAt(runId), await this.earlier(run), undefined, facts);
    try {
      return { status: "complete", value: await interp.runWorkflow(run.workflow, run.input as Obj) };
    } catch (e) {
      if (e instanceof ReplayEnd) return e.reason === "payload_purged" ? { status: "incomplete_replay", missing: e.commandId } : { status: "partial", stoppedAt: e.commandId };
      if (e instanceof Fault) return { status: "failed", error: e.value() };
      if (e instanceof Attention) return { status: "attention_required", reason: e.reason };
      // A sub-program's stored running program or facts missing or another, or a report or a stage the stored facts do
      // not describe (0.7): reported as the run's own are, above.
      if (e instanceof Violation && (e.code === "expansion_mismatch" || e.code === "facts_mismatch")) return { status: "attention_required", reason: { violation: e.code, message: e.message } };
      throw e;
    }
  }

  /** Retention: drops result payloads; a later replay reports incomplete_replay (R14). */
  purgePayloads(runId: string): Promise<void> {
    return this.journal.purgePayloads(runId);
  }
}

/**
 * Where a cancel leaves a run, from its actions: `cancelled`, with the effects that completed, or `attention_required`
 * while an action is dispatched or has an unknown outcome (INV-12).
 */
function cancelTarget(actions: ActionRow[]): { state: "cancelled"; summary: Value } | { state: "attention_required"; attention: Value; summary: Value } {
  const summary = { effects_completed_before_or_during_cancel: actions.filter((a) => a.state === "confirmed").map((a) => ({ effect: a.effect, operation: a.operation_key })) };
  const open = actions.filter((a) => a.state === "dispatched" || a.state === "unknown_outcome").map((a) => ({ operation: a.operation_key, effect: a.effect, state: a.state }));
  return open.length ? { state: "attention_required", attention: { open_actions: open }, summary } : { state: "cancelled", summary };
}

/**
 * Where a halt leaves a run, from its actions: `cancelled`, with the effects that completed, or `attention_required`
 * while an action is dispatched or has an unknown outcome (INV-12). Both name the halt.
 */
function haltTarget(actions: ActionRow[], halt: string): { state: "cancelled"; summary: Value } | { state: "attention_required"; attention: Value; summary: Value } {
  const summary = { effects_completed_before_or_during_cancel: actions.filter((a) => a.state === "confirmed").map((a) => ({ effect: a.effect, operation: a.operation_key })), halt };
  const open = actions.filter((a) => a.state === "dispatched" || a.state === "unknown_outcome").map((a) => ({ operation: a.operation_key, effect: a.effect, state: a.state }));
  return open.length ? { state: "attention_required", attention: { halted: halt, open_actions: open }, summary } : { state: "cancelled", summary };
}

/** What a halt did: its record, the runs it ended and how, whether the adapters revoked, and what failed after it. */
export interface HaltReport {
  halt: HaltRow;
  ended: Array<{ run: string; tenant: string; state: RunRow["state"] }>;
  /** `revoked`; `none` when no adapter holds anything to revoke; or why revoking failed. */
  revoke: "revoked" | "none" | { failed: string };
  /** What failed once the runs had ended: asking an open action to stop, telling the scheduler. */
  problems: string[];
}

/** What a waiting command shows to whoever decides on it: its digest and the role it asks (`Shown`). */
function shownBy(run: RunRow, commandId: string, row: Row): Shown {
  const request = isObj((row["result"] ?? null) as Value) ? (row["result"] as Obj) : {};
  // A decision wait shows the digest it is bound to; an amendment's, the hash of the package it asks for; a review's,
  // the digest of what it asks, which its escalation leaves as it was (0.6); a question shows the digest of the
  // question as recorded.
  const subject =
    row["kind"] === "decision" || row["kind"] === REVIEW
      ? String(request["subject_digest"] ?? request["action_digest"] ?? "")
      : row["kind"] === "amendment"
        ? String(request["package"] ?? "")
        : String(row["request_digest"]);
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

/** Whether a text column keeps `s` as it is: well-formed UTF-16 (no lone surrogate) and no U+0000. */
function storable(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed() && !s.includes(String.fromCharCode(0));
}

function minLimits(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? Math.min(out[k]!, v) : v;
  return out;
}

/**
 * 0.6, at a start (spec/library.md "The batch commit step"): a run whose policy hands a person an effect that a
 * map's body of its workflow commits is refused at once, `person_in_map`; nothing in a map's body waits for a person.
 * `authorize` is the override `StartRun` was given.
 */
function refusePersonInMap(wf: unknown, authorize: Policy["authorize"]): void {
  const asked = Object.entries(authorize ?? {}).filter(([, a]) => a?.by === "human");
  if (!asked.length) return;
  const inMaps = new Set<string>();
  const visit = (v: unknown, inMap: boolean, depth: number): void => {
    if (depth > 512) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, inMap, depth + 1));
    if (!v || typeof v !== "object") return;
    const node = v as Record<string, unknown>;
    if (inMap && node["op"] === "effect" && typeof node["name"] === "string") inMaps.add(node["name"]);
    for (const [k, x] of Object.entries(node)) visit(x, inMap || (node["op"] === "map" && k === "body"), depth + 1);
  };
  visit(wf, false, 0);
  const found = asked.filter(([name]) => inMaps.has(name)).map(([name, a]) => `${name} (${a.by === "human" ? a.role : ""})`);
  if (found.length) throw new Violation("person_in_map", `The run's policy hands a person ${found.sort().join(", ")}, which a map's body commits: a batch commit step is authorized by policy, never by a person (spec/library.md).`);
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

/**
 * The components of the package's system model that its program refers to, by name. With `running` (0.6), the
 * program a run of the package runs, which holds every definition it sees: the components any of them refers to,
 * those a library's definition or a pattern's expansion names among them.
 */
export function componentsOf(pkg: Package, running?: Program): WorkspaceComponent[] {
  const defs = running ? running.defs : link(pkg.program, pkg.modules).defs;
  const names = new Set<string>();
  for (const d of Object.values(running ? running.defs : pkg.program.defs)) for (const r of references(d)) if (Object.hasOwn(defs, r) && defs[r]!.kind === "component") names.add(r);
  return [...names].sort().map((name) => {
    const c = defs[name] as Extract<(typeof defs)[string], { kind: "component" }>;
    return { name, repo: c.repo, root: c.root };
  });
}

/**
 * A failure of the compiler behind the bridge while a run is driven (its module missing or refused, a trap, its
 * memory ceiling, an input a request cannot carry, an answer that is not one) as what it is for the run: a violation
 * it stops on for a person (`compiler_failed`), as one at load is (`load_verification_failed`). It names the kind of
 * failure and the door, in what a model may be shown of it; nothing was granted or done by the call that failed.
 * Anything else is as it was thrown.
 */
function compilerStop(e: unknown): unknown {
  if (!(e instanceof CompilerFailure)) return e;
  return new Violation("compiler_failed", `The compiler failed while the run was driven (${e.kind}${e.door ? ` on ${e.door}` : ""}), so the run stops here for a person: ${e.shown}`);
}
