// The control API (Doc 4 §16.1): StartRun, GetRun, SubmitInput, DecideAction,
// CancelRun, ReconcileAction, ReplayRun. A run is driven by a worker that
// holds its lease; a crash leaves the journal as it was, and `resume` starts a
// new worker with a higher fence that re-runs the body against the journal.

import { randomUUID } from "node:crypto";
import { canonicalize, check, domainHash, hashProgram, LANGUAGE_VERSION, type Json, type Program } from "@mandate/compiler";
import type { Adapters, Cost } from "./adapters.js";
import type { Db, Row } from "./db.js";
import { Faults } from "./faults.js";
import { Interpreter, ReplayEnd, type Policy } from "./interp.js";
import { costDims, Journal, TERMINAL, type ActionRow, type RunRow } from "./journal.js";
import { Attention, Cancelled, Crash, Fault, StaleFence, Suspend, Violation } from "./signals.js";
import { digest, isObj, type Obj, type Value } from "./values.js";

/** Pinned versions of the non-std modules a program imports (S09). */
export interface Lock {
  modules: Record<string, string>;
}

/** A content-addressed package: the program, its hash and its lock. */
export interface Package {
  hash: string;
  programHash: string;
  program: Program;
  lock: Lock;
}

export function buildPackage(program: Program, lock: Lock = { modules: {} }): Package {
  const programHash = hashProgram(program as unknown as Json).program;
  return { hash: domainHash("package", { program: programHash, lock } as unknown as Json), programHash, program, lock };
}

/**
 * Load-time verification (§3.5, S09). The runtime does not trust whoever
 * built the package: it recomputes the hashes, requires every imported
 * module to be locked, and re-runs the compiler's checks.
 */
export function verifyPackage(pkg: Package): void {
  if (pkg.program.language !== LANGUAGE_VERSION) throw new Violation("unsupported_language", `Package language ${String(pkg.program.language)} is not ${LANGUAGE_VERSION}.`);
  const programHash = hashProgram(pkg.program as unknown as Json).program;
  if (programHash !== pkg.programHash) throw new Violation("package_hash_mismatch", `The program hashes to ${programHash}, not the packaged ${pkg.programHash}.`);
  if (domainHash("package", { program: programHash, lock: pkg.lock } as unknown as Json) !== pkg.hash) {
    throw new Violation("package_hash_mismatch", "The package hash does not match its program and lock.");
  }
  const unlocked = (pkg.program.uses ?? []).map((u) => u.module).filter((m) => m !== "std" && !m.startsWith("std.") && !Object.hasOwn(pkg.lock.modules, m));
  if (unlocked.length) throw new Violation("unlocked_module", `Imported modules are not locked: ${[...new Set(unlocked)].join(", ")}.`);
  const r = check(canonicalize(pkg.program as unknown as Json), "json");
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

export class Runtime {
  readonly journal: Journal;
  readonly faults: Faults;
  private readonly packages = new Map<string, Package>();

  constructor(
    readonly db: Db,
    readonly adapters: Adapters,
    faults?: Faults,
  ) {
    this.journal = new Journal(db, () => adapters.clock.now());
    this.faults = faults ?? new Faults();
  }

  // ── StartRun / resume ─────────────────────────────────────────────────

  async startRun(o: StartOptions): Promise<RunRow> {
    verifyPackage(o.pkg);
    const wf = o.pkg.program.defs[o.workflow];
    if (!wf || wf.kind !== "workflow") throw new Violation("unknown_workflow", `No workflow '${o.workflow}'.`);
    const runId = o.runId ?? randomUUID();
    const limits = minLimits(costDims(wf.budget), costDims(o.limits));
    const policy: Policy = { tenant: o.tenant ?? "default", ...(o.authorize ? { authorize: o.authorize } : {}), ...(o.authorizationTtlMs ? { authorizationTtlMs: o.authorizationTtlMs } : {}) };
    await this.db.tx(async (tx) => {
      await tx.query("insert into packages (package_hash, program, lock) values ($1, $2, $3) on conflict (package_hash) do nothing", [
        o.pkg.hash,
        JSON.stringify(o.pkg.program),
        JSON.stringify(o.pkg.lock),
      ]);
      await this.journal.createRun(tx, { runId, tenant: policy.tenant, packageHash: o.pkg.hash, workflow: o.workflow, input: o.input, policy: policy as unknown as Value, limits });
    });
    this.packages.set(o.pkg.hash, o.pkg);
    return this.resume(runId);
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
      if (e.tag === "BudgetExceeded") {
        // Default when the workflow has no handler: pause and ask a person (§8.6).
        const handler = interp.workflowDef((await this.journal.run(runId)).workflow).on?.find((h) => h.event === "budget_exceeded");
        return this.finish(runId, fence, { state: "waiting", waiting: { kind: "budget_exceeded", detail: e.value(), handler: handler ? true : false } });
      }
      const open = await this.openActions(runId);
      if (open.length) return this.finish(runId, fence, { state: "attention_required", attention: { error: e.value(), open_actions: open } });
      return this.finish(runId, fence, { state: "failed", error: e.value() });
    }
    throw e;
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
      replay,
    });
  }

  private async program(packageHash: string): Promise<Program> {
    const cached = this.packages.get(packageHash);
    if (cached) return cached.program;
    const [row] = await this.db.query<Row>("select program, lock from packages where package_hash = $1", [packageHash]);
    if (!row) throw new Violation("unknown_package", `No package ${packageHash}.`);
    return row["program"] as Program;
  }

  // ── GetRun ────────────────────────────────────────────────────────────

  getRun(runId: string): Promise<RunRow> {
    return this.journal.run(runId);
  }

  // ── SubmitInput / DecideAction ────────────────────────────────────────

  /** Answers a wait opened by human.ask, escalate or pause; then resumes the run. */
  async submitInput(runId: string, msg: Message, commandId: string, value: Value): Promise<RunRow> {
    const fresh = await this.resolveWait(runId, msg, commandId, "input", { commandId, value }, async () => ({ state: "succeeded", result: value }));
    return fresh ? this.resume(runId) : this.journal.run(runId);
  }

  /**
   * A person's decision on a prepared action. It applies only to the action
   * digest they saw (G02), only before the wait's deadline (R15), and an
   * approval becomes an authorization bound to that digest.
   */
  async decideAction(runId: string, msg: Message, d: { commandId: string; actionDigest: string; approve: boolean; by: string }): Promise<RunRow> {
    type Resolution = { state: "succeeded"; result: Value } | { state: "failed"; error: Value };
    const fresh = await this.resolveWait(runId, msg, d.commandId, "decision", d as unknown as Value, async (tx, request, run): Promise<Resolution> => {
      if (!isObj(request) || request["action_digest"] !== d.actionDigest) {
        throw new Violation("decision_digest_mismatch", "The decision names a different action than the one waiting for approval.");
      }
      const deadline = request["deadline"];
      if (typeof deadline === "number" && this.adapters.clock.now() >= deadline) {
        return { state: "failed", error: { tag: "Rejected", args: ["approval_expired"] } };
      }
      if (!d.approve) return { state: "succeeded", result: { approved: false, by: d.by } };
      const id = digest("operation", { authorize: d.actionDigest, by: d.by, message: msg.messageId });
      const ttl = (run.policy as unknown as Policy).authorizationTtlMs ?? 15 * 60_000;
      await tx.query("insert into authorizations (authorization_id, run_id, action_digest, decided_by, expires_at) values ($1, $2, $3, $4, $5) on conflict do nothing", [
        id,
        runId,
        d.actionDigest,
        d.by,
        this.adapters.clock.now() + ttl,
      ]);
      await this.journal.event(tx, runId, "action_authorized", { authorization: id, digest: d.actionDigest, by: d.by });
      return { state: "succeeded", result: { approved: true, by: d.by, authorization_id: id } };
    });
    return fresh ? this.resume(runId) : this.journal.run(runId);
  }

  /** Expires waits whose deadline has passed: no dispatch happens after a deadline (R15). */
  async tick(runId: string): Promise<RunRow> {
    const run = await this.journal.run(runId);
    const w = run.waiting;
    if (run.state !== "waiting" || !isObj(w) || w["kind"] !== "decision") return run;
    const req = w["request"];
    const deadline = isObj(req) ? req["deadline"] : null;
    if (typeof deadline !== "number" || this.adapters.clock.now() < deadline) return run;
    await this.db.tx(async (tx) => {
      await this.journal.lock(tx, runId);
      await tx.query("update commands set state = 'failed', error = $3 where run_id = $1 and command_id = $2 and state = 'waiting'", [
        runId,
        String(w["command"]),
        JSON.stringify({ tag: "Rejected", args: ["approval_expired"] }),
      ]);
      await this.journal.event(tx, runId, "wait_expired", { command: String(w["command"]) });
    });
    return this.resume(runId);
  }

  private async resolveWait(
    runId: string,
    msg: Message,
    commandId: string,
    kind: "input" | "decision",
    payload: Value,
    resolve: (tx: Parameters<Parameters<Db["tx"]>[0]>[0], request: Value, run: RunRow) => Promise<{ state: "succeeded"; result: Value } | { state: "failed"; error: Value }>,
  ): Promise<boolean> {
    return this.db.tx(async (tx) => {
      const run = await this.journal.lock(tx, runId);
      const fresh = await this.journal.inbox(tx, { tenant: run.tenant, sender: msg.sender, messageId: msg.messageId, payloadDigest: digest("request", payload) });
      if (!fresh) return false;
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
    if (idle) await this.closeCancelled(runId);
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
    return this.resume(runId);
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
    tools: Object.fromEntries(
      Object.entries(real.tools).map(([k, t]) => [k, { describe: () => t.describe(), prepare: refuse(`${k}.prepare`), execute: refuse(`${k}.execute`), reconcile: refuse(`${k}.reconcile`) }]),
    ),
    clock: real.clock,
    random: refuse("random"),
  };
}
