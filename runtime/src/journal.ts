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

import type { Budget } from "@mandate/compiler";
import type { Cost, Outcome } from "./adapters.js";
import { num, type Db, type Row, type Tx } from "./db.js";
import { Cancelled, Fault, StaleFence, Violation } from "./signals.js";
import type { Value } from "./values.js";

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
}

export interface EvidenceRow {
  evidence_id: string;
  contract: string;
  criterion: string;
  method: string;
  passed: boolean;
  detail: Value;
}

export interface BudgetReport {
  dimensions: Array<{ dimension: string; limit: number; settled: number; reserved: number; available: number }>;
  /** Commands in command-id order. `reserved` is the upper bound taken at dispatch; `open` lists dimensions still reserved. */
  commands: Array<{ command: string; kind: string; label: string | null; state: string; reserved: Record<string, number>; open: string[]; cost: Cost | "unknown" | null }>;
}

export type CommandState = "dispatched" | "waiting" | "succeeded" | "failed";

export interface CommandRow {
  command_id: string;
  kind: string;
  state: CommandState;
  fence: number;
  request_digest: string;
  result: Value;
  error: Value;
  payload_purged: boolean;
}

export type ActionState = "prepared" | "dispatched" | "confirmed" | "rejected" | "unknown_outcome" | "cancelled";

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
}

export interface AuthorizationRow {
  authorization_id: string;
  action_digest: string;
  decided_by: string;
  expires_at: number | null;
  consumed_by: string | null;
}

/** Budget dimensions: `tokens`, `steps`, and `spend:<currency>` in micro-units. */
export function costDims(c: Cost | Budget | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!c) return out;
  if (c.tokens !== undefined) out["tokens"] = c.tokens;
  if (c.steps !== undefined) out["steps"] = c.steps;
  if (c.spend) out[`spend:${c.spend.currency}`] = c.spend.micros;
  return out;
}

export class Journal {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
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

  async event(tx: Tx, runId: string, type: string, data: Value): Promise<void> {
    const [r] = await tx.query<Row>("select coalesce(max(seq), 0) + 1 as seq from events where run_id = $1", [runId]);
    await tx.query("insert into events (run_id, seq, type, data, at) values ($1, $2, $3, $4, $5)", [runId, num(r?.["seq"]), type, json(data), this.now()]);
  }

  async run(runId: string): Promise<RunRow> {
    const [row] = await this.db.query<Row>("select * from runs where run_id = $1", [runId]);
    if (!row) throw new Violation("unknown_run", `No run '${runId}'.`);
    return toRun(row);
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
    r: { runId: string; tenant: string; packageHash: string; workflow: string; input: Value; policy: Value; limits: Record<string, number> },
  ): Promise<void> {
    const at = this.now();
    await tx.query(
      "insert into runs (run_id, tenant, package_hash, workflow, input, policy, state, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, 'accepted', $7, $7)",
      [r.runId, r.tenant, r.packageHash, r.workflow, json(r.input), json(r.policy), at],
    );
    for (const [dim, limit] of Object.entries(r.limits)) {
      await tx.query("insert into budgets (run_id, dimension, limit_value) values ($1, $2, $3)", [r.runId, dim, limit]);
    }
    await this.event(tx, r.runId, "run_accepted", { workflow: r.workflow, package: r.packageHash, limits: r.limits });
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
    await this.event(tx, runId, `run_${state}`, { ...fields } as Value);
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
   */
  async dispatch(
    runId: string,
    fence: number,
    cmd: { id: string; kind: string; digest: string; label?: string },
    reserve: Cost | Budget | undefined,
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
      if (existing) {
        // A worker died between dispatch and result; release what it reserved before reserving again.
        await tx.query("update reservations set state = 'released' where run_id = $1 and command_id = $2 and state = 'active'", [runId, cmd.id]);
      }
      await this.reserve(tx, runId, cmd.id, costDims(reserve));
      await tx.query(
        `insert into commands (run_id, command_id, kind, state, fence, request_digest, label) values ($1, $2, $3, 'dispatched', $4, $5, $6)
         on conflict (run_id, command_id) do update set state = 'dispatched', fence = $4`,
        [runId, cmd.id, cmd.kind, fence, cmd.digest, cmd.label ?? null],
      );
      await this.event(tx, runId, "command_dispatched", { command: cmd.id, kind: cmd.kind, reserved: costDims(reserve) });
      return undefined;
    });
  }

  /** available = limit − settled − active reservations; reserve only if it fits (§8.6). */
  private async reserve(tx: Tx, runId: string, commandId: string, dims: Record<string, number>): Promise<void> {
    for (const [dim, amount] of Object.entries(dims)) {
      if (amount <= 0) continue;
      const [b] = await tx.query<Row>("select limit_value, settled from budgets where run_id = $1 and dimension = $2", [runId, dim]);
      if (b) {
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
  async complete(runId: string, fence: number, commandId: string, outcome: Outcome): Promise<void> {
    await this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [row] = await tx.query<Row>("select state from commands where run_id = $1 and command_id = $2", [runId, commandId]);
      if (!row || row["state"] !== "dispatched") throw new Violation("not_dispatched", `Command ${commandId} is not in flight.`);
      const cost = outcome.cost;
      if (cost === "unknown") {
        await this.event(tx, runId, "charge_pending", { command: commandId });
      } else {
        await this.settle(tx, runId, commandId, costDims(cost));
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
      await this.event(tx, runId, "command_completed", { command: commandId, ok, cost: (cost ?? null) as Value });
    });
  }

  private async settle(tx: Tx, runId: string, commandId: string, dims: Record<string, number>): Promise<void> {
    for (const [dim, amount] of Object.entries(dims)) {
      await tx.query("update budgets set settled = settled + $3 where run_id = $1 and dimension = $2", [runId, dim, amount]);
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

  /** Opens a wait for a person (input or decision); returns the earlier row if it exists. */
  async openWait(runId: string, fence: number, cmd: { id: string; kind: string; digest: string }, request: Value): Promise<CommandRow> {
    return this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [row] = await tx.query<Row>("select * from commands where run_id = $1 and command_id = $2", [runId, cmd.id]);
      if (row) return toCommand(row);
      await tx.query(
        "insert into commands (run_id, command_id, kind, state, fence, request_digest, result) values ($1, $2, $3, 'waiting', $4, $5, $6)",
        [runId, cmd.id, cmd.kind, fence, cmd.digest, json(request)],
      );
      await this.event(tx, runId, "wait_opened", { command: cmd.id, kind: cmd.kind, request });
      const [created] = await tx.query<Row>("select * from commands where run_id = $1 and command_id = $2", [runId, cmd.id]);
      return toCommand(created!);
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
    a: { operationKey: string; commandId: string; effect: string; actionDigest: string; params: Value; retryClass: string },
  ): Promise<ActionRow> {
    return this.db.tx(async (tx) => {
      await this.lock(tx, runId, fence);
      const [row] = await tx.query<Row>("select * from actions where operation_key = $1", [a.operationKey]);
      if (row) return row as unknown as ActionRow;
      await tx.query(
        "insert into actions (operation_key, run_id, command_id, effect, action_digest, params, retry_class, state) values ($1, $2, $3, $4, $5, $6, $7, 'prepared')",
        [a.operationKey, runId, a.commandId, a.effect, a.actionDigest, json(a.params), a.retryClass],
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
  async commit(runId: string, fence: number, operationKey: string, authorizationId: string): Promise<ActionRow> {
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

  async evidence(runId: string): Promise<EvidenceRow[]> {
    const rows = await this.db.query<Row>("select evidence_id, contract, criterion, method, passed, detail from evidence where run_id = $1 order by criterion, method, evidence_id", [runId]);
    return rows.map((r) => ({
      evidence_id: String(r["evidence_id"]),
      contract: String(r["contract"]),
      criterion: String(r["criterion"]),
      method: String(r["method"]),
      passed: Boolean(r["passed"]),
      detail: (r["detail"] ?? null) as Value,
    }));
  }

  async recordEvidence(runId: string, e: { id: string; contract: string; criterion: string; method: string; passed: boolean; detail?: Value }): Promise<void> {
    await this.db.query(
      "insert into evidence (evidence_id, run_id, contract, criterion, method, passed, detail) values ($1, $2, $3, $4, $5, $6, $7) on conflict (evidence_id) do nothing",
      [e.id, runId, e.contract, e.criterion, e.method, e.passed, json(e.detail ?? null)],
    );
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
