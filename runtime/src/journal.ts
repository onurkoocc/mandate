// The run journal in PostgreSQL (Doc 4 §8.3, §8.4, §8.6, §8.8, §8.9).
//
// Every write that must be atomic is one transaction that starts by locking
// the run's row and, for a worker, checking its fence:
//
//   dispatch   cancel check + budget reservation + dispatch record   (R07, R08)
//   complete   fence check + result + settlement                      (R06, R16)
//   commit     authorization check + single use + outbox record       (E0406, E0407, R15)
//
// Commands are keyed by a stable command id derived from the IR path, so a
// worker that re-runs the workflow body finds earlier results instead of
// calling the outside world again (R01, R13).

import { BUDGET_DIMENSIONS, budgetAmount, type Budget } from "@mandate/compiler";
import type { Cost, Outcome } from "./adapters.js";
import { decisionId, type SignedDecision, type StoredDecision } from "./decisions.js";
import type { EvidenceRecord } from "./evidence.js";
import { num, type Db, type Row, type Tx } from "./db.js";
import { ANCHOR_FORMAT, anchorStatement, eventHash, type AnchorSigner } from "./journal-chain.js";
import { Cancelled, Fault, StaleFence, Violation } from "./signals.js";
import type { Obj, Value } from "./values.js";

export type RunState = "accepted" | "running" | "waiting" | "cancelling" | "attention_required" | "succeeded" | "failed" | "cancelled";

export const TERMINAL: ReadonlySet<RunState> = new Set(["succeeded", "failed", "cancelled"]);

export interface RunRow {
  run_id: string;
  tenant: string;
  package_hash: string;
  workflow: string;
  input: Value;
  policy: Value;
  state: RunState;
  revision: number;
  fence: number;
  cancel_requested: boolean;
  waiting: Value;
  attention: Value;
  result: Value;
  error: Value;
  summary: Value;
  /** What the run started from (design doc 9 §12): package, workflow, input, components at their base commits. */
  manifest: Value;
  /** R: the hash of the manifest. */
  manifest_hash: string | null;
}

export interface EvidenceRow {
  evidence_id: string;
  contract: string;
  criterion: string;
  method: string;
  passed: boolean;
  detail: Value;
  /** What the check ran against: the contract's arguments, and for a test the working copy's files (§10.3). */
  subject: Value;
  /** The signed evidence record (§10.3), and its signature by the control plane's key. */
  record: Value;
  key_id: string | null;
  signature: string | null;
}

export interface BudgetReport {
  dimensions: Array<{ dimension: string; limit: number; settled: number; reserved: number; available: number }>;
  /** Commands in command-id order. `reserved` is the upper bound taken at dispatch; `open` lists dimensions still reserved. */
  commands: Array<{ command: string; kind: string; label: string | null; state: string; reserved: Record<string, number>; open: string[]; cost: Cost | "unknown" | null }>;
}

export type CommandState = "dispatched" | "waiting" | "throttled" | "succeeded" | "failed";

export interface CommandRow {
  command_id: string;
  kind: string;
  state: CommandState;
  fence: number;
  request_digest: string;
  result: Value;
  error: Value;
  payload_purged: boolean;
  /** How often the command was throttled (§8.6); while it waits to be sent again, its error is the Throttled fault. */
  throttled: number;
  /**
   * The run's package when the command was first recorded (spec/envelope.md "Amendments"). A command stands under
   * that package for good: what is derived for it again, in a resumed run or a replay, is derived under it. Absent
   * on a row written before amendments were recorded, whose run had one package.
   */
  package: string | null;
}

export type ActionState = "prepared" | "dispatched" | "confirmed" | "rejected" | "unknown_outcome" | "cancelled" | "would_apply";

export interface ActionRow {
  operation_key: string;
  run_id: string;
  command_id: string;
  effect: string;
  action_digest: string;
  params: Value;
  retry_class: string;
  state: ActionState;
  receipt: Value;
  detail: Value;
  /** Files the action applies, frozen at prepare: path → { ref, digest }. */
  artifacts: Value;
}

export interface ChangesetRow {
  set_key: string;
  command_id: string;
  set_digest: string;
  /** In commit order: component, effect, operation, action digest, approver, and the evidence the member's change carries. */
  members: Value;
  /** `prepared`, `committed`, `partial`, `failed`; `would_apply` in a read_only run, `simulated` in a design run. */
  state: string;
  detail: Value;
  /** What the set lands and why (doc 9 §3.4, §8.2): the plan, its digest and evidence, the order, the declared interface changes, the approver. */
  summary: Value;
}

export interface AuthorizationRow {
  authorization_id: string;
  action_digest: string;
  decided_by: string;
  expires_at: number | null;
  consumed_by: string | null;
}

/**
 * The ledger's dimensions of a cost or a budget: `tokens`, `steps`,
 * `spend:<currency>` in micro-units, and `agents`. `time` is not one: it is
 * held by deadlines, not by reservation.
 */
export function costDims(c: Cost | Budget | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const dim of BUDGET_DIMENSIONS) {
    const amount = budgetAmount(c, dim);
    if (amount === undefined || dim === "time") continue;
    out[dim === "spend" ? `spend:${c!.spend!.currency}` : dim] = amount;
  }
  return out;
}

/**
 * An admitted sub-program, as `program_admitted` records it (spec/envelope.md
 * "Admission"): the `plan` node and the sub-program's number there, the step
 * of the lead's loop that submitted it, the command its workflow runs under,
 * its hash and the base its patch was written against, where its IR is in
 * the artifact store, the name of its workflow, and what was reserved.
 */
export interface Admission {
  plan: string;
  number: number;
  step: string;
  command: string;
  hash: string;
  base: string;
  artifact: string;
  workflow: string;
  reservation?: Record<string, number>;
}

/**
 * A run's limits as a caller gives them: a cost by dimension, and under an
 * envelope the delegation attempts the run may start (`agents`).
 */
export type Limits = Cost & { agents?: number };

export class Journal {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
    /** Signs the anchor of each state change (spec/journal.md "Anchors"); without one, nothing is anchored. */
    private readonly signer?: AnchorSigner,
  ) {}

  // ── runs and events ───────────────────────────────────────────────────

  /** Locks the run's row; with `fence`, also checks the caller still holds the lease (R06). */
  async lock(tx: Tx, runId: string, fence?: number): Promise<RunRow> {
    const [row] = await tx.query<Row>("select * from runs where run_id = $1 for update", [runId]);
    if (!row) throw new Violation("unknown_run", `No run '${runId}'.`);
    const run = toRun(row);
    if (fence !== undefined && run.fence !== fence) throw new StaleFence(fence, run.fence);
    return run;
  }

  /**
   * Appends an event to the run's journal: one read of the run's last event and one insert. Every caller holds the
   * run's row lock (`lock`), or writes in the transaction that creates the run, so two appends to one run never
   * interleave between the read and the insert. Returns what was written.
   *
   * The event of a chained run carries its hash (spec/journal.md), over its data as the database gives it back:
   * what `JSON.stringify` writes, read with `JSON.parse`. A run is chained when its first event has a hash, so a
   * new run is, and a run begun before the journal was chained, whose last event has none, stays as it was.
   */
  async event(tx: Tx, runId: string, type: string, data: Value): Promise<{ seq: number; at: number; hash: string | null }> {
    const [last] = await tx.query<Row>("select seq, hash from events where run_id = $1 order by seq desc limit 1", [runId]);
    const seq = last ? num(last["seq"]) + 1 : 1;
    const prev = last ? ((last["hash"] ?? null) as string | null) : null;
    const at = this.now();
    const text = json(data);
    const hash = !last || prev !== null ? eventHash({ run: runId, seq, type, data: JSON.parse(text) as Value, at, prev }) : null;
    await tx.query("insert into events (run_id, seq, type, data, at, hash) values ($1, $2, $3, $4, $5, $6)", [runId, seq, type, text, at, hash]);
    return { seq, at, hash };
  }

  /**
   * Anchors a chained run at the state event just written (spec/journal.md "Anchors"): the runtime's evidence key
   * signs the event's seq, hash and time, in the transaction that wrote it. An anchor is a row of its own, never an
   * event. An unchained run, whose event has no hash, has nothing to anchor.
   */
  private async anchor(tx: Tx, runId: string, e: { seq: number; at: number; hash: string | null }): Promise<void> {
    if (e.hash === null || !this.signer) return;
    const sig = this.signer(ANCHOR_FORMAT, anchorStatement(runId, e.seq, e.hash, e.at));
    await tx.query("insert into journal_anchors (run_id, seq, hash, at, key_id, signature) values ($1, $2, $3, $4, $5, $6)", [runId, e.seq, e.hash, e.at, sig.key_id, sig.signature]);
  }

  /**
   * Records that a map began to run its items (spec/envelope.md "map"): once for a map node, however often the run
   * is resumed and comes to it again. Only the lease holder may write (R06).
   */
  async mapStarted(runId: string, fence: number, data: { map: string; items: number; par: number }): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [seen] = await tx.query<Row>("select 1 as seen from events where run_id = $1 and type = 'map_started' and data->>'map' = $2 limit 1", [runId, data.map]);
      if (!seen) await this.event(tx, runId, "map_started", data);
    });
  }

  /**
   * Records how a map ended (spec/envelope.md "map"): each item's outcome by input index, `Ok` or its fault's tag,
   * and `null` for an item a failed map did not start or did not let end. Once for a map node, like `map_started`:
   * the outcomes are what the journal's commands decided, so a resumed run that comes to the map again would say
   * the same.
   */
  async mapEnded(runId: string, fence: number, data: { map: string; outcomes: Array<string | null>; failed?: string }): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [seen] = await tx.query<Row>("select 1 as seen from events where run_id = $1 and type = 'map_ended' and data->>'map' = $2 limit 1", [runId, data.map]);
      if (!seen) await this.event(tx, runId, "map_ended", data);
    });
  }

  async run(runId: string): Promise<RunRow> {
    const [row] = await this.db.query<Row>("select * from runs where run_id = $1", [runId]);
    if (!row) throw new Violation("unknown_run", `No run '${runId}'.`);
    return toRun(row);
  }

  /** When the run was accepted, by the runtime's clock. With an envelope's `time` it is the run's deadline. */
  async startedAt(runId: string): Promise<number> {
    const [row] = await this.db.query<Row>("select created_at from runs where run_id = $1", [runId]);
    if (!row) throw new Violation("unknown_run", `No run '${runId}'.`);
    return num(row["created_at"]);
  }

  async events(runId: string): Promise<Array<{ seq: number; type: string; data: Value }>> {
    const rows = await this.db.query<Row>("select seq, type, data from events where run_id = $1 order by seq", [runId]);
    return rows.map((r) => ({ seq: num(r["seq"]), type: String(r["type"]), data: r["data"] as Value }));
  }

  /** The latest time the run's budget ran out (its `budget_exceeded` episode), if it ever did. */
  async budgetEpisode(runId: string): Promise<number | null> {
    const [r] = await this.db.query<Row>("select max((data->>'episode')::int) as n from events where run_id = $1 and type = 'budget_exceeded'", [runId]);
    return r?.["n"] === null || r?.["n"] === undefined ? null : num(r["n"]);
  }

  /**
   * Raises the run's limits: a governance change made by a person (§8.6,
   * §13.2). Each dimension may only go up; returns the limits it replaced.
   */
  async raiseLimits(tx: Tx, runId: string, limits: Record<string, number>): Promise<Record<string, number>> {
    const before: Record<string, number> = {};
    for (const [dim, limit] of Object.entries(limits)) {
      const [b] = await tx.query<Row>("select limit_value from budgets where run_id = $1 and dimension = $2", [runId, dim]);
      if (!b) throw new Violation("not_a_raise", `The run has no ${dim} limit to raise.`);
      before[dim] = num(b["limit_value"]);
      if (limit < before[dim]!) throw new Violation("not_a_raise", `The ${dim} limit is ${before[dim]}; ${limit} would lower it.`);
      await tx.query("update budgets set limit_value = $3 where run_id = $1 and dimension = $2", [runId, dim, limit]);
    }
    await tx.query("update runs set revision = revision + 1, updated_at = $2 where run_id = $1", [runId, this.now()]);
    return before;
  }

  async createRun(
    tx: Tx,
    r: { runId: string; tenant: string; packageHash: string; workflow: string; input: Value; policy: Value; limits: Record<string, number>; manifest: Value; manifestHash: string },
  ): Promise<void> {
    const at = this.now();
    await tx.query(
      "insert into runs (run_id, tenant, package_hash, workflow, input, policy, state, created_at, updated_at, manifest, manifest_hash) values ($1, $2, $3, $4, $5, $6, 'accepted', $7, $7, $8, $9)",
      [r.runId, r.tenant, r.packageHash, r.workflow, json(r.input), json(r.policy), at, json(r.manifest), r.manifestHash],
    );
    for (const [dim, limit] of Object.entries(r.limits)) {
      await tx.query("insert into budgets (run_id, dimension, limit_value) values ($1, $2, $3)", [r.runId, dim, limit]);
    }
    // The run's first state is anchored like every later one, so a chained run has an anchor from its first event on.
    await this.anchor(tx, r.runId, await this.event(tx, r.runId, "run_accepted", { workflow: r.workflow, package: r.packageHash, limits: r.limits, manifest: r.manifestHash }));
  }

  /** Takes the run's lease for a new worker: the fence goes up, so older workers' writes are refused (R06). */
  async acquire(runId: string): Promise<{ run: RunRow; fence: number }> {
    return this.db.tx(async (tx) => {
      const run = await this.lock(tx, runId);
      const fence = run.fence + 1;
      await tx.query("update runs set fence = $2, updated_at = $3 where run_id = $1", [runId, fence, this.now()]);
      await this.event(tx, runId, "lease_acquired", { fence });
      return { run: { ...run, fence }, fence };
    });
  }

  async setState(
    tx: Tx,
    runId: string,
    state: RunState,
    fields: Partial<Pick<RunRow, "waiting" | "attention" | "result" | "error" | "summary">> = {},
  ): Promise<void> {
    await tx.query(
      `update runs set state = $2, waiting = $3, attention = $4, result = $5, error = $6, summary = coalesce($7, summary),
         revision = revision + 1, updated_at = $8 where run_id = $1`,
      [runId, state, json(fields.waiting ?? null), json(fields.attention ?? null), json(fields.result ?? null), json(fields.error ?? null), fields.summary === undefined ? null : json(fields.summary), this.now()],
    );
    await this.anchor(tx, runId, await this.event(tx, runId, `run_${state}`, { ...fields } as Value));
    // A finished run gives its components' working copies back (B3).
    if (TERMINAL.has(state)) await tx.query("delete from workspace_claims where run_id = $1", [runId]);
  }

  // ── commands ──────────────────────────────────────────────────────────

  async command(runId: string, commandId: string): Promise<CommandRow | undefined> {
    const [row] = await this.db.query<Row>("select * from commands where run_id = $1 and command_id = $2", [runId, commandId]);
    return row ? toCommand(row) : undefined;
  }

  /**
   * Records that a command is about to be sent, reserving its upper-bound cost
   * in the same transaction. Returns the earlier row when the command already
   * has a result (replay). Refuses when the run was cancelled (R08) or the
   * reservation does not fit (R07).
   *
   * `within` names the command whose reservation pays for this one: a step of
   * an agent loop is charged to its delegation (§8.2). For each dimension the
   * parent reserved, the step must fit in what is left of that reservation,
   * or it is refused with `SkillFailed(StepLimit)`; a dimension the parent did
   * not reserve is reserved from the run as usual.
   *
   * `inside` names the sub-program the command belongs to (`admitProgram`).
   * What it reserves is then a share of what the program reserved when it
   * was admitted: the share must fit in what is left of the program's
   * reservation and comes out of it, so the run as a whole holds no more
   * than it did (N02, INV-15). One that does not fit is `BudgetExceeded`
   * naming the program. That holds in every dimension the run is limited
   * in, also one the program reserved nothing of: nothing inside a
   * sub-program is taken from the run.
   */
  async dispatch(
    runId: string,
    fence: number,
    cmd: { id: string; kind: string; digest: string; label?: string },
    reserve: Cost | Budget | undefined,
    within?: string,
    inside?: string,
  ): Promise<CommandRow | undefined> {
    return this.db.tx(async (tx) => {
      const run = await this.lock(tx, runId, fence);
      const [row] = await tx.query<Row>("select * from commands where run_id = $1 and command_id = $2", [runId, cmd.id]);
      const existing = row ? toCommand(row) : undefined;
      if (existing && existing.request_digest !== cmd.digest) {
        throw new Violation("nondeterministic_replay", `Command ${cmd.id} was recorded with a different request; the program or its inputs changed under a running workflow.`);
      }
      if (existing && (existing.state === "succeeded" || existing.state === "failed")) return existing;
      if (run.cancel_requested) throw new Cancelled();
      // A worker died between dispatch and result; release what it reserved before reserving again.
      if (existing) await this.release(tx, runId, cmd.id);
      let dims = costDims(reserve);
      if (within) {
        const parent = await this.activeReservations(tx, runId, within);
        for (const [dim, amount] of Object.entries(dims)) {
          if (!(dim in parent)) continue;
          if (amount > parent[dim]!) {
            throw new Fault("SkillFailed", [{ kind: "StepLimit", detail: `the step needs ${amount} ${dim} and ${parent[dim]} is left of the agent's budget` }]);
          }
        }
        dims = Object.fromEntries(Object.entries(dims).filter(([dim]) => !(dim in parent)));
      }
      await this.reserve(tx, runId, cmd.id, dims, inside);
      // The package is written with the row and never again: a command sent again keeps the one it was first recorded under.
      await tx.query(
        `insert into commands (run_id, command_id, kind, state, fence, request_digest, label, inside, package) values ($1, $2, $3, 'dispatched', $4, $5, $6, $7, $8)
         on conflict (run_id, command_id) do update set state = 'dispatched', fence = $4`,
        [runId, cmd.id, cmd.kind, fence, cmd.digest, cmd.label ?? null, inside ?? null, run.package_hash],
      );
      await this.event(tx, runId, "command_dispatched", { command: cmd.id, kind: cmd.kind, reserved: costDims(reserve) });
      return undefined;
    });
  }

  /**
   * available = limit − settled − active reservations; reserve only if it fits (§8.6). Inside a sub-program, a
   * dimension the run is limited in, or the program holds, is taken from the program's reservation and never
   * from the run: a program that holds none of it has none to give.
   */
  private async reserve(tx: Tx, runId: string, commandId: string, dims: Record<string, number>, inside?: string): Promise<void> {
    const held = inside ? await this.activeReservations(tx, runId, inside) : {};
    for (const [dim, amount] of Object.entries(dims)) {
      if (amount <= 0) continue;
      const [b] = await tx.query<Row>("select limit_value, settled from budgets where run_id = $1 and dimension = $2", [runId, dim]);
      if (inside && (b || Object.hasOwn(held, dim))) {
        const left = held[dim] ?? 0;
        if (amount > left) throw new Fault("BudgetExceeded", [{ dimension: dim, requested: amount, available: left, program: inside }]);
        await this.giveBack(tx, runId, inside, dim, -amount);
      } else if (b) {
        const [r] = await tx.query<Row>("select coalesce(sum(amount), 0) as active from reservations where run_id = $1 and dimension = $2 and state = 'active'", [runId, dim]);
        const available = num(b["limit_value"]) - num(b["settled"]) - num(r?.["active"]);
        if (amount > available) {
          throw new Fault("BudgetExceeded", [{ dimension: dim, requested: amount, available }]);
        }
      }
      await tx.query(
        `insert into reservations (run_id, command_id, dimension, amount, state) values ($1, $2, $3, $4, 'active')
         on conflict (run_id, command_id, dimension) do update set amount = $4, state = 'active'`,
        [runId, commandId, dim, amount],
      );
    }
  }

  /**
   * Records a command's outcome. A known cost is settled and the reservation
   * closed; an unknown cost keeps the reservation until the charge arrives (R16).
   * Only the lease holder may write (R06).
   */
  async complete(runId: string, fence: number, commandId: string, outcome: Outcome, within?: string): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [row] = await tx.query<Row>("select state from commands where run_id = $1 and command_id = $2", [runId, commandId]);
      // A command throttled too often is completed with its last Throttled fault.
      if (!row || (row["state"] !== "dispatched" && row["state"] !== "throttled")) throw new Violation("not_dispatched", `Command ${commandId} is not in flight.`);
      const cost = outcome.cost;
      if (cost === "unknown") {
        await this.event(tx, runId, "charge_pending", { command: commandId });
      } else {
        await this.settle(tx, runId, commandId, costDims(cost), within);
      }
      const ok = "ok" in outcome;
      await tx.query("update commands set state = $3, result = $4, error = $5, cost = $6 where run_id = $1 and command_id = $2", [
        runId,
        commandId,
        ok ? "succeeded" : "failed",
        json(ok ? outcome.ok : null),
        json(ok ? null : (outcome.error as unknown as Value)),
        json((cost ?? null) as Value),
      ]);
      await this.event(tx, runId, "command_completed", { command: commandId, ok, cost: (cost ?? null) as Value, ...(outcome.meta !== undefined ? { meta: outcome.meta } : {}) });
    });
  }

  private async activeReservations(tx: Tx, runId: string, commandId: string): Promise<Record<string, number>> {
    const rows = await tx.query<Row>("select dimension, amount from reservations where run_id = $1 and command_id = $2 and state = 'active'", [runId, commandId]);
    return Object.fromEntries(rows.map((r) => [String(r["dimension"]), num(r["amount"])]));
  }

  /** The sub-program a command belongs to, when it runs inside one. */
  private async programOf(tx: Tx, runId: string, commandId: string): Promise<string | undefined> {
    const [row] = await tx.query<Row>("select inside from commands where run_id = $1 and command_id = $2", [runId, commandId]);
    return typeof row?.["inside"] === "string" ? row["inside"] : undefined;
  }

  /**
   * Moves `amount` of a dimension into a sub-program's reservation, or out of it when negative. Only while the
   * program is in flight: once it has ended, what comes back is the run's again.
   */
  private async giveBack(tx: Tx, runId: string, program: string, dim: string, amount: number): Promise<void> {
    if (!amount) return;
    await tx.query("update reservations set amount = greatest(amount + $4, 0) where run_id = $1 and command_id = $2 and dimension = $3 and state = 'active'", [runId, program, dim, amount]);
  }

  /** Releases what a command still holds. A share of a sub-program's reservation goes back to it. */
  private async release(tx: Tx, runId: string, commandId: string): Promise<void> {
    const program = await this.programOf(tx, runId, commandId);
    if (program) {
      for (const [dim, amount] of Object.entries(await this.activeReservations(tx, runId, commandId))) await this.giveBack(tx, runId, program, dim, amount);
    }
    await tx.query("update reservations set state = 'released' where run_id = $1 and command_id = $2 and state = 'active'", [runId, commandId]);
  }

  /**
   * What the finished steps below `commandId` (`commandId/…`) have cost, by dimension. A lead's sub-programs run
   * below its delegation (`commandId/program/<n>/…`) and are not its steps: they are paid from the envelope, by
   * their own reservation.
   */
  async childCost(runId: string, commandId: string): Promise<Record<string, number>> {
    const below = commandId.replaceAll("%", "\\%").replaceAll("_", "\\_");
    const rows = await this.db.query<Row>("select cost from commands where run_id = $1 and command_id like $2 and command_id not like $3 and state in ('succeeded', 'failed')", [runId, `${below}/%`, `${below}/program/%`]);
    const out: Record<string, number> = {};
    for (const r of rows) {
      const c = r["cost"];
      if (!c || c === "unknown" || typeof c !== "object") continue;
      for (const [dim, v] of Object.entries(costDims(c as Cost))) out[dim] = (out[dim] ?? 0) + v;
    }
    return out;
  }

  private async settle(tx: Tx, runId: string, commandId: string, cost: Record<string, number>, within?: string): Promise<void> {
    // A delegation attempt is spent once it is sent, whatever came of it (spec/envelope.md "The ledger"): what the
    // command reserved of `agents` is what it settles. No adapter reports it as a cost.
    const own = await this.activeReservations(tx, runId, commandId);
    const dims = Object.hasOwn(own, "agents") ? { ...cost, agents: own["agents"]! } : cost;
    for (const [dim, amount] of Object.entries(dims)) {
      await tx.query("update budgets set settled = settled + $3 where run_id = $1 and dimension = $2", [runId, dim, amount]);
    }
    // What a step spent comes out of its delegation's reservation, which then holds only what is left.
    const paid = within ? await this.activeReservations(tx, runId, within) : {};
    const program = await this.programOf(tx, runId, commandId);
    for (const [dim, amount] of Object.entries(cost)) {
      if (!Object.hasOwn(paid, dim)) continue;
      await this.giveBack(tx, runId, within!, dim, -amount);
      // A step that spent more than its delegation had left: the rest comes out of the sub-program's reservation.
      if (program && amount > paid[dim]!) await this.giveBack(tx, runId, program, dim, paid[dim]! - amount);
    }
    // Inside a sub-program the command's share came out of the program's reservation. What it did not spend goes
    // back there; what it spent beyond its share, or without one, comes out of it. So the program's reservation and
    // its commands' shares together never hold more of the run than the program was admitted with.
    if (program) {
      for (const dim of new Set([...Object.keys(own), ...Object.keys(dims)])) {
        if (!Object.hasOwn(paid, dim)) await this.giveBack(tx, runId, program, dim, (own[dim] ?? 0) - (dims[dim] ?? 0));
      }
    }
    await tx.query("update reservations set state = 'settled' where run_id = $1 and command_id = $2 and state = 'active'", [runId, commandId]);
  }

  /** A charge reported after the fact, e.g. after a timeout or a cancellation (R16). */
  async settleCharge(runId: string, commandId: string, cost: Cost): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId);
      await this.settle(tx, runId, commandId, costDims(cost));
      await tx.query("update commands set cost = $3 where run_id = $1 and command_id = $2", [runId, commandId, json(cost as unknown as Value)]);
      await this.event(tx, runId, "charge_settled", { command: commandId, cost: cost as unknown as Value });
    });
  }

  /**
   * A command was throttled (§8.6): a rate limit or the provider's quota said
   * not now. Its reservation is released, so nothing is held while it waits,
   * and it waits to be sent again under the same id. Returns how often it has
   * been throttled. Only the lease holder may write (R06).
   */
  async throttle(runId: string, fence: number, commandId: string, fault: Value): Promise<number> {
    return this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      await this.release(tx, runId, commandId);
      const [row] = await tx.query<Row>(
        "update commands set state = 'throttled', error = $3, throttled = throttled + 1 where run_id = $1 and command_id = $2 and state = 'dispatched' returning throttled",
        [runId, commandId, json(fault)],
      );
      if (!row) throw new Violation("not_dispatched", `Command ${commandId} is not in flight.`);
      await this.event(tx, runId, "command_throttled", { command: commandId, fault, times: num(row["throttled"]) });
      return num(row["throttled"]);
    });
  }

  /** Opens a wait for a person (input or decision); returns the earlier row if it exists. */
  async openWait(runId: string, fence: number, cmd: { id: string; kind: string; digest: string }, request: Value, before?: (tx: Tx, run: RunRow) => Promise<void>): Promise<CommandRow> {
    return this.db.tx(async (tx) => {
      const run = await this.lock(tx, runId, fence);
      const [row] = await tx.query<Row>("select * from commands where run_id = $1 and command_id = $2", [runId, cmd.id]);
      if (row) return toCommand(row);
      // What belongs to the wait is written with it, or not at all.
      await before?.(tx, run);
      await tx.query(
        "insert into commands (run_id, command_id, kind, state, fence, request_digest, result, package) values ($1, $2, $3, 'waiting', $4, $5, $6, $7)",
        [runId, cmd.id, cmd.kind, fence, cmd.digest, json(request), run.package_hash],
      );
      await this.event(tx, runId, "wait_opened", { command: cmd.id, kind: cmd.kind, request });
      const [created] = await tx.query<Row>("select * from commands where run_id = $1 and command_id = $2", [runId, cmd.id]);
      return toCommand(created!);
    });
  }

  // ── amendments (spec/envelope.md "Amendments") ────────────────────────

  /**
   * Opens the wait of an amendment a lead asked for (N04): the package with the new envelope is stored under its
   * hash, `amendment_requested` is written, and the run waits for a member of its envelope's owner role, all in one
   * transaction. Once for a wait: a resumed run that comes to it again gets the row as it is.
   */
  async openAmendment(runId: string, fence: number, cmd: { id: string; digest: string }, request: Value, pkg: { hash: string; program: Value; lock: Value; modules: Value }, requested: Value): Promise<CommandRow> {
    return this.openWait(runId, fence, { ...cmd, kind: "amendment" }, request, async (tx, run) => {
      if (run.cancel_requested) throw new Cancelled();
      await tx.query("insert into packages (package_hash, program, lock, modules) values ($1, $2, $3, $4) on conflict (package_hash) do nothing", [pkg.hash, json(pkg.program), json(pkg.lock), json(pkg.modules)]);
      await this.event(tx, runId, "amendment_requested", requested);
    });
  }

  /** The packages a run moved between, oldest first, as `package_amended` records them. A run nobody amended has none. */
  async amendments(runId: string): Promise<Array<{ from: string; to: string }>> {
    const rows = await this.db.query<Row>("select data from events where run_id = $1 and type = 'package_amended' order by seq", [runId]);
    return rows.map((r) => ({ from: String((r["data"] as Obj)["from"]), to: String((r["data"] as Obj)["to"]) }));
  }

  /**
   * Moves a run to its amended package (INV-02 as 0.4 refines it), inside the transaction of the owner's decision:
   *
   * - the run's package is `to`;
   * - each limit in `limits`, the dimensions the amendment raises, rises to the amount given, and none is lowered
   *   or added;
   * - the lease ends, so a worker that drove the run under the old package writes nothing after this (R06);
   * - every other amendment the run still waits for was asked of the old package, and ends unanswered.
   *
   * Returns the limits it replaced and the waits it ended.
   */
  async amendRun(tx: Tx, runId: string, wait: string, to: string, limits: Record<string, number>): Promise<{ limits: Record<string, number>; superseded: string[] }> {
    const before: Record<string, number> = {};
    for (const [dim, limit] of Object.entries(limits).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [b] = await tx.query<Row>("select limit_value from budgets where run_id = $1 and dimension = $2", [runId, dim]);
      if (!b || num(b["limit_value"]) >= limit) continue;
      before[dim] = num(b["limit_value"]);
      await tx.query("update budgets set limit_value = $3 where run_id = $1 and dimension = $2", [runId, dim, limit]);
    }
    await tx.query("update runs set package_hash = $2, fence = fence + 1, updated_at = $3 where run_id = $1", [runId, to, this.now()]);
    const others = await tx.query<Row>(
      "update commands set state = 'failed', error = $3 where run_id = $1 and kind = 'amendment' and state = 'waiting' and command_id <> $2 returning command_id",
      [runId, wait, json({ tag: "Rejected", args: ["superseded"] })],
    );
    return { limits: before, superseded: others.map((r) => String(r["command_id"])).sort() };
  }

  // ── sub-programs (spec/envelope.md "plan") ────────────────────────────

  /**
   * Records what a lead did with a sub-program at one step of its loop: `program_submitted` or `program_refused`.
   * Once for a step and a type, however often the run is resumed and comes to the step again. Only the lease
   * holder may write (R06).
   */
  async programEvent(runId: string, fence: number, type: "program_submitted" | "program_refused", data: { step: string; [k: string]: Value }): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [seen] = await tx.query<Row>("select 1 as seen from events where run_id = $1 and type = $2 and data->>'step' = $3 limit 1", [runId, type, data.step]);
      if (!seen) await this.event(tx, runId, type, data);
    });
  }

  /** The sub-programs admitted at a `plan` node, in the order of their numbers. */
  async admissions(runId: string, plan: string): Promise<Admission[]> {
    const rows = await this.db.query<Row>("select data from events where run_id = $1 and type = 'program_admitted' and data->>'plan' = $2 order by seq", [runId, plan]);
    return rows.map((r) => r["data"] as unknown as Admission);
  }

  /**
   * The sub-programs of a run that were admitted and have not ended, in the order they were admitted. One that
   * waits, for a person or for the run to be resumed, is among them.
   */
  async inFlight(runId: string): Promise<Admission[]> {
    const rows = await this.db.query<Row>(
      `select e.data from events e join commands c on c.run_id = e.run_id and c.command_id = e.data->>'command'
       where e.run_id = $1 and e.type = 'program_admitted' and c.state = 'dispatched' order by e.seq`,
      [runId],
    );
    return rows.map((r) => r["data"] as unknown as Admission);
  }

  /**
   * Admits a sub-program (spec/envelope.md "Admission"): its whole budget is reserved from the run, its command is
   * recorded, `store` puts its IR into the artifact store, and `program_admitted` is written, all in one
   * transaction. Its commands then draw their shares from that reservation (`dispatch` with `inside`).
   *
   * When the budget does not fit in what the run has left, nothing is recorded and the fault is `BudgetExceeded`:
   * the check that came before saw a remainder that something else has taken since. A step whose sub-program was
   * admitted before is not admitted again: the earlier admission is returned.
   */
  async admitProgram(runId: string, fence: number, a: Admission, budget: Budget | undefined, digest: string, store: (tx: Tx) => Promise<void>): Promise<Admission> {
    return this.db.tx(async (tx) => {
      const run = await this.lock(tx, runId, fence);
      const [earlier] = await tx.query<Row>("select data from events where run_id = $1 and type = 'program_admitted' and data->>'step' = $2 limit 1", [runId, a.step]);
      if (earlier) return earlier["data"] as unknown as Admission;
      if (run.cancel_requested) throw new Cancelled();
      const reservation = costDims(budget);
      await this.reserve(tx, runId, a.command, reservation);
      await tx.query("insert into commands (run_id, command_id, kind, state, fence, request_digest, label, package) values ($1, $2, 'program', 'dispatched', $3, $4, $5, $6)", [runId, a.command, fence, digest, `sub-program ${a.number}`, run.package_hash]);
      await store(tx);
      const admitted = { ...a, reservation };
      await this.event(tx, runId, "program_admitted", admitted as unknown as Value);
      return admitted;
    });
  }

  /**
   * A sub-program ended, with a value or a fault. What is left of its reservation is released: its commands have
   * settled what they spent, and the rest is the run's again. A program that has ended stays as it ended.
   */
  async closeProgram(runId: string, fence: number, command: string, outcome: { ok: Value } | { error: { tag: string; args?: Value[] } }): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [row] = await tx.query<Row>("select kind, state from commands where run_id = $1 and command_id = $2", [runId, command]);
      if (!row || row["kind"] !== "program") throw new Violation("not_dispatched", `${command} is not an admitted sub-program.`);
      if (row["state"] !== "dispatched") return;
      await tx.query("update reservations set state = 'released' where run_id = $1 and command_id = $2 and state = 'active'", [runId, command]);
      const ok = "ok" in outcome;
      await tx.query("update commands set state = $3, result = $4, error = $5 where run_id = $1 and command_id = $2", [runId, command, ok ? "succeeded" : "failed", json(ok ? outcome.ok : null), json(ok ? null : (outcome.error as unknown as Value))]);
      await this.event(tx, runId, "command_completed", { command, ok, cost: null });
    });
  }

  async budget(runId: string): Promise<Record<string, { limit: number; settled: number; reserved: number }>> {
    const rows = await this.db.query<Row>(
      `select b.dimension, b.limit_value, b.settled,
         coalesce((select sum(amount) from reservations r where r.run_id = b.run_id and r.dimension = b.dimension and r.state = 'active'), 0) as reserved
       from budgets b where b.run_id = $1 order by b.dimension`,
      [runId],
    );
    return Object.fromEntries(rows.map((r) => [String(r["dimension"]), { limit: num(r["limit_value"]), settled: num(r["settled"]), reserved: num(r["reserved"]) }]));
  }

  /**
   * The run's budget table (§8.6): per dimension, the limit, what was settled,
   * what is still reserved and what is left; and per command that reserved or
   * spent anything, its reservation and its reported cost.
   */
  async budgetReport(runId: string): Promise<BudgetReport> {
    const dims = await this.budget(runId);
    const rows = await this.db.query<Row>(
      `select c.command_id, c.kind, c.label, c.state, c.cost, r.dimension, r.amount, r.state as reservation
       from commands c left join reservations r on r.run_id = c.run_id and r.command_id = c.command_id
       where c.run_id = $1
       order by c.command_id, r.dimension`,
      [runId],
    );
    const commands = new Map<string, BudgetReport["commands"][number]>();
    for (const r of rows) {
      const id = String(r["command_id"]);
      let c = commands.get(id);
      if (!c) {
        c = { command: id, kind: String(r["kind"]), label: (r["label"] ?? null) as string | null, state: String(r["state"]), reserved: {}, open: [], cost: (r["cost"] ?? null) as Cost | "unknown" | null };
        commands.set(id, c);
      }
      if (r["dimension"] !== null && r["dimension"] !== undefined) {
        const dim = String(r["dimension"]);
        c.reserved[dim] = num(r["amount"]);
        if (r["reservation"] === "active") c.open.push(dim);
      }
    }
    return {
      dimensions: Object.entries(dims).map(([dimension, d]) => ({ dimension, ...d, available: d.limit - d.settled - d.reserved })),
      commands: [...commands.values()].filter((c) => Object.keys(c.reserved).length || c.cost !== null),
    };
  }

  // ── external actions: prepare → authorize → commit (§8.8) ─────────────

  async action(operationKey: string): Promise<ActionRow | undefined> {
    const [row] = await this.db.query<Row>("select * from actions where operation_key = $1", [operationKey]);
    return row ? (row as unknown as ActionRow) : undefined;
  }

  async actions(runId: string): Promise<ActionRow[]> {
    return (await this.db.query<Row>("select * from actions where run_id = $1 order by command_id", [runId])) as unknown as ActionRow[];
  }

  /** Freezes the action's parameters. Idempotent: the operation key names the action. */
  async prepare(
    runId: string,
    fence: number,
    a: { operationKey: string; commandId: string; effect: string; actionDigest: string; params: Value; retryClass: string; artifacts?: Value },
  ): Promise<ActionRow> {
    return this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [row] = await tx.query<Row>("select * from actions where operation_key = $1", [a.operationKey]);
      if (row) return row as unknown as ActionRow;
      await tx.query(
        "insert into actions (operation_key, run_id, command_id, effect, action_digest, params, retry_class, state, artifacts) values ($1, $2, $3, $4, $5, $6, $7, 'prepared', $8)",
        [a.operationKey, runId, a.commandId, a.effect, a.actionDigest, json(a.params), a.retryClass, json(a.artifacts ?? null)],
      );
      await this.event(tx, runId, "action_prepared", { operation: a.operationKey, effect: a.effect, digest: a.actionDigest });
      const [created] = await tx.query<Row>("select * from actions where operation_key = $1", [a.operationKey]);
      return created as unknown as ActionRow;
    });
  }

  /** An authorization bound to one action digest (by policy or by a person). */
  async authorize(runId: string, auth: { id: string; actionDigest: string; decidedBy: string; expiresAt?: number }): Promise<AuthorizationRow> {
    return this.db.tx(async (tx) => {
      await this.lock(tx, runId);
      const [row] = await tx.query<Row>("select * from authorizations where authorization_id = $1", [auth.id]);
      if (!row) {
        await tx.query("insert into authorizations (authorization_id, run_id, action_digest, decided_by, expires_at) values ($1, $2, $3, $4, $5)", [
          auth.id,
          runId,
          auth.actionDigest,
          auth.decidedBy,
          auth.expiresAt ?? null,
        ]);
        await this.event(tx, runId, "action_authorized", { authorization: auth.id, digest: auth.actionDigest, by: auth.decidedBy });
      }
      return toAuth((await tx.query<Row>("select * from authorizations where authorization_id = $1", [auth.id]))[0]!);
    });
  }

  /**
   * Commit: the authorization must exist and match the action digest (E0406),
   * may be consumed once (E0407, G13), must not have expired (R15), and the
   * run must not be cancelled (R08). Consuming it and writing the outbox
   * record happen in one transaction.
   */
  async commit(runId: string, fence: number, operationKey: string, authorizationId: string, set?: { key: string; digest: string; authorizationId: string }): Promise<ActionRow> {
    return this.db.tx(async (tx) => {
      const run = await this.lock(tx, runId, fence);
      const [arow] = await tx.query<Row>("select * from actions where operation_key = $1 and run_id = $2", [operationKey, runId]);
      if (!arow) throw new Violation("unknown_action", `No prepared action ${operationKey}.`);
      const action = arow as unknown as ActionRow;
      if (action.state !== "prepared") return action;
      const [authRow] = await tx.query<Row>("select * from authorizations where authorization_id = $1", [authorizationId]);
      if (!authRow) throw new Violation("MDT-E0406", `Commit of ${action.effect} without an authorization.`);
      const auth = toAuth(authRow);
      if (auth.action_digest !== action.action_digest) {
        throw new Violation("MDT-E0406", `The authorization was given for a different action (digest ${auth.action_digest}, action ${action.action_digest}).`);
      }
      if (auth.consumed_by !== null && auth.consumed_by !== operationKey) {
        throw new Violation("MDT-E0407", `Authorization ${authorizationId} was already consumed by ${auth.consumed_by}.`);
      }
      if (auth.expires_at !== null && this.now() >= auth.expires_at) {
        throw new Fault("Rejected", ["authorization_expired"]);
      }
      if (run.cancel_requested) throw new Cancelled();
      // A change set member also needs the set's authorization, bound to the set digest S (design doc 9 §3.2).
      // The first member's commit consumes it for this set; it never authorizes another set (G13).
      if (set) {
        const [s] = await tx.query<Row>("select * from authorizations where authorization_id = $1", [set.authorizationId]);
        if (!s) throw new Violation("MDT-E0406", `Commit of a change set member without the set's authorization.`);
        const sa = toAuth(s);
        if (sa.action_digest !== set.digest) throw new Violation("MDT-E0406", `The set authorization was given for another change set (digest ${sa.action_digest}, set ${set.digest}).`);
        if (sa.consumed_by !== null && sa.consumed_by !== set.key) throw new Violation("MDT-E0407", `Authorization ${set.authorizationId} was already consumed by ${sa.consumed_by}.`);
        if (sa.consumed_by === null) {
          if (sa.expires_at !== null && this.now() >= sa.expires_at) throw new Fault("Rejected", ["authorization_expired"]);
          await tx.query("update authorizations set consumed_by = $2 where authorization_id = $1", [set.authorizationId, set.key]);
          await tx.query("update changesets set state = 'committing' where set_key = $1", [set.key]);
        }
      }
      await tx.query("update authorizations set consumed_by = $2 where authorization_id = $1", [authorizationId, operationKey]);
      await tx.query("update actions set state = 'dispatched' where operation_key = $1", [operationKey]);
      await tx.query(
        "insert into outbox (operation_key, run_id, state) values ($1, $2, 'pending') on conflict (operation_key) do update set state = 'pending'",
        [operationKey, runId],
      );
      await this.event(tx, runId, "action_committed", { operation: operationKey, authorization: authorizationId });
      return { ...action, state: "dispatched" };
    });
  }

  /** Records what the adapter said. With `fence`, only the lease holder may write. */
  async finishAction(
    runId: string,
    fence: number | undefined,
    operationKey: string,
    state: Exclude<ActionState, "dispatched">,
    data: { receipt?: Value; detail?: Value },
  ): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      await tx.query("update actions set state = $2, receipt = coalesce($3, receipt), detail = $4 where operation_key = $1", [
        operationKey,
        state,
        data.receipt === undefined ? null : json(data.receipt),
        json(data.detail ?? null),
      ]);
      await tx.query("update outbox set state = $2, attempts = attempts + 1 where operation_key = $1", [operationKey, state === "prepared" ? "pending" : "done"]);
      await this.event(tx, runId, `action_${state}`, { operation: operationKey, ...(data.detail !== undefined ? { detail: data.detail } : {}) });
    });
  }

  // ── change sets (design doc 9 §3) ─────────────────────────────────────

  /** Records a prepared change set once: its digest S and its members in commit order. */
  async prepareChangeset(runId: string, fence: number, c: { setKey: string; commandId: string; setDigest: string; members: Value; summary: Value; state?: "prepared" | "would_apply" | "simulated" }): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [row] = await tx.query<Row>("select set_key from changesets where set_key = $1", [c.setKey]);
      if (row) return;
      const state = c.state ?? "prepared";
      await tx.query("insert into changesets (set_key, run_id, command_id, set_digest, members, state, summary) values ($1, $2, $3, $4, $5, $6, $7)", [c.setKey, runId, c.commandId, c.setDigest, json(c.members), state, json(c.summary)]);
      await this.event(tx, runId, `changeset_${state}`, { set: c.setDigest, command: c.commandId, members: c.members });
    });
  }

  /** A change set's state: `committing`, `committed`, `partial` (some members applied) or `failed` (none). */
  async changesetState(runId: string, fence: number, setKey: string, state: "committed" | "partial" | "failed", detail: Value): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      await tx.query("update changesets set state = $2, detail = $3 where set_key = $1", [setKey, state, json(detail)]);
      await this.event(tx, runId, `changeset_${state}`, detail);
    });
  }

  async changesets(runId: string): Promise<ChangesetRow[]> {
    const rows = await this.db.query<Row>("select * from changesets where run_id = $1 order by command_id", [runId]);
    return rows.map((r) => ({
      set_key: String(r["set_key"]),
      command_id: String(r["command_id"]),
      set_digest: String(r["set_digest"]),
      members: (r["members"] ?? []) as Value,
      state: String(r["state"]),
      detail: (r["detail"] ?? null) as Value,
      summary: (r["summary"] ?? null) as Value,
    }));
  }

  async evidence(runId: string, ids?: string[]): Promise<EvidenceRow[]> {
    const rows = await this.db.query<Row>(
      `select * from evidence where run_id = $1${ids ? " and evidence_id = any($2)" : ""} order by criterion, method, evidence_id`,
      ids ? [runId, ids] : [runId],
    );
    return rows.map(toEvidence);
  }

  /** Records a signed evidence record once; a record for the same check is never replaced. */
  async recordEvidence(runId: string, e: { record: EvidenceRecord; key_id: string; signature: string }): Promise<void> {
    const r = e.record;
    await this.db.query(
      `insert into evidence (evidence_id, run_id, contract, criterion, method, passed, detail, subject, record, key_id, signature)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (evidence_id) do nothing`,
      [r.evidence_id, runId, r.contract, r.criterion, r.method, r.passed, json(r.detail), json(r.subject), json(r as unknown as Value), e.key_id, e.signature],
    );
  }

  /**
   * Keeps an accepted decision with its signature, under its record's digest
   * (spec/envelope.md "Signed decisions"). Returns that digest.
   */
  async recordDecision(tx: Tx, d: SignedDecision): Promise<string> {
    const r = d.record;
    const id = decisionId(r);
    await tx.query(
      `insert into decisions (decision_id, package_hash, run_id, command_id, kind, member, role, key_id, record, signature, accepted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (decision_id) do nothing`,
      [id, r.package, r.run ?? null, r.command ?? null, r.kind, r.member, r.role ?? null, r.key, json(r as unknown as Value), d.signature, this.now()],
    );
    return id;
  }

  /**
   * The stored approvals of a package's envelope, oldest first (spec/envelope.md "Approving an envelope"). They are
   * about the package and name no run. Whoever reads them checks each one again: a row is not a decision until its
   * record and signature say so.
   */
  async envelopeApprovals(packageHash: string): Promise<StoredDecision[]> {
    const rows = await this.db.query<Row>("select decision_id, record, signature from decisions where package_hash = $1 and kind = 'envelope' and run_id is null order by accepted_at, decision_id", [packageHash]);
    return rows.map((r) => ({ decision_id: String(r["decision_id"]), record: r["record"] as StoredDecision["record"], signature: String(r["signature"]) }));
  }

  /** A stored decision by its digest, whatever it is about. */
  async decision(decisionId: string): Promise<StoredDecision | undefined> {
    const [r] = await this.db.query<Row>("select decision_id, record, signature from decisions where decision_id = $1", [decisionId]);
    return r ? { decision_id: String(r["decision_id"]), record: r["record"] as StoredDecision["record"], signature: String(r["signature"]) } : undefined;
  }

  /**
   * The accepted decisions of a run, oldest first; with `tx`, read inside that transaction. The order is that of the
   * revisions they were made on, which is the order they were taken in: a clock may not move between two of them.
   */
  async decisions(runId: string, tx?: Tx): Promise<StoredDecision[]> {
    const rows = await (tx ?? this.db).query<Row>("select decision_id, record, signature from decisions where run_id = $1 order by (record->>'revision')::bigint nulls last, accepted_at, decision_id", [runId]);
    return rows.map((r) => ({ decision_id: String(r["decision_id"]), record: r["record"] as StoredDecision["record"], signature: String(r["signature"]) }));
  }

  /**
   * Records an inbound message once. The same key with the same payload is a
   * duplicate and returns false; the same key with a different payload is a
   * security error, never a silent choice (R03).
   */
  async inbox(tx: Tx, msg: { tenant: string; sender: string; messageId: string; payloadDigest: string }): Promise<boolean> {
    const [row] = await tx.query<Row>("select payload_digest from inbox where tenant = $1 and sender = $2 and message_id = $3", [msg.tenant, msg.sender, msg.messageId]);
    if (row) {
      if (row["payload_digest"] !== msg.payloadDigest) {
        throw new Violation("inbox_payload_mismatch", `Message ${msg.messageId} from ${msg.sender} was received before with a different payload.`);
      }
      return false;
    }
    await tx.query("insert into inbox (tenant, sender, message_id, payload_digest, received_at) values ($1, $2, $3, $4, $5)", [
      msg.tenant,
      msg.sender,
      msg.messageId,
      msg.payloadDigest,
      this.now(),
    ]);
    return true;
  }

  /** Retention: drops result payloads but keeps the record that they existed (R14). */
  async purgePayloads(runId: string): Promise<void> {
    await this.db.query("update commands set result = null, payload_purged = true where run_id = $1 and state = 'succeeded'", [runId]);
  }
}

function json(v: Value): string {
  return JSON.stringify(v);
}

function toRun(r: Row): RunRow {
  return {
    run_id: String(r["run_id"]),
    tenant: String(r["tenant"]),
    package_hash: String(r["package_hash"]),
    workflow: String(r["workflow"]),
    input: r["input"] as Value,
    policy: r["policy"] as Value,
    state: r["state"] as RunState,
    revision: num(r["revision"]),
    fence: num(r["fence"]),
    cancel_requested: Boolean(r["cancel_requested"]),
    waiting: (r["waiting"] ?? null) as Value,
    attention: (r["attention"] ?? null) as Value,
    result: (r["result"] ?? null) as Value,
    error: (r["error"] ?? null) as Value,
    summary: (r["summary"] ?? null) as Value,
    manifest: (r["manifest"] ?? null) as Value,
    manifest_hash: (r["manifest_hash"] ?? null) as string | null,
  };
}

function toCommand(r: Row): CommandRow {
  return {
    command_id: String(r["command_id"]),
    kind: String(r["kind"]),
    state: r["state"] as CommandState,
    fence: num(r["fence"]),
    request_digest: String(r["request_digest"]),
    result: (r["result"] ?? null) as Value,
    error: (r["error"] ?? null) as Value,
    payload_purged: Boolean(r["payload_purged"]),
    throttled: num(r["throttled"]),
    package: (r["package"] ?? null) as string | null,
  };
}

function toEvidence(r: Row): EvidenceRow {
  return {
    evidence_id: String(r["evidence_id"]),
    contract: String(r["contract"]),
    criterion: String(r["criterion"]),
    method: String(r["method"]),
    passed: Boolean(r["passed"]),
    detail: (r["detail"] ?? null) as Value,
    subject: (r["subject"] ?? null) as Value,
    record: (r["record"] ?? null) as Value,
    key_id: (r["key_id"] ?? null) as string | null,
    signature: (r["signature"] ?? null) as string | null,
  };
}

function toAuth(r: Row): AuthorizationRow {
  return {
    authorization_id: String(r["authorization_id"]),
    action_digest: String(r["action_digest"]),
    decided_by: String(r["decided_by"]),
    expires_at: r["expires_at"] === null || r["expires_at"] === undefined ? null : num(r["expires_at"]),
    consumed_by: (r["consumed_by"] ?? null) as string | null,
  };
}
