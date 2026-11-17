// The driver loop (spec/attention.md "The driver loop"): what makes a deadline pass, an escalation happen and a decided
// wait go on when no scheduler drives the runs.
//
// - `tickOpenWaits` is `Runtime.tick` for a run of 0.7. It acts on every open wait whose deadline has passed, the
//   `commands` rows in state `waiting`, not only on the one `runs.waiting` names (a `par` can leave several open): a
//   decision and an amendment expire, a review is escalated once and then expires. It also drives a run whose wait's
//   command is no longer waiting (decided, and not driven on since), and a run whose timer is due. Everything it does
//   is done in one transaction that holds the run's row lock and reads the waits again under it, and each wait is
//   changed only while it is still `waiting`: a second tick of the same run, a `mandate tick` beside a Temporal worker,
//   finds nothing left to do and writes nothing. A run of 0.1 to 0.6 never comes here (runtime.ts `tick`).
// - `tickPass` is one pass of `mandate tick`: every run in state `waiting`, each `tick`ed by a runtime built for its
//   own package, then the notification pass (notify.ts). `driveLoop` makes one pass, or with `follow` one pass every
//   interval until its signal aborts.

import { isProgram07OrLater } from "@mandate/bridge";
import type { Db, Row, Tx } from "./db.js";
import type { RunRow } from "./journal.js";
import type { Journal } from "./journal.js";
import type { Adapters } from "./adapters.js";
import { WAIT_KINDS } from "./classes.js";
import { notifyPass, type NotifyOptions, type NotifyReport } from "./notify.js";
import { questionIn, REVIEW } from "./review.js";
import { isObj, type Obj, type Value } from "./values.js";

/** What `tickOpenWaits` needs of the runtime it acts for, besides its database, journal and clock. */
export interface TickHooks {
  /** Checks this host against the run's lock before anything is expired or driven (`unfit_host`), as `tick` does. */
  fit(): Promise<void>;
  /** Moves the run on: inline, or by waking its scheduler. */
  drive(runId: string): Promise<RunRow>;
}

/** An open wait of a run: a `commands` row in state `waiting`, and (0.7) the sub-program it was asked in, if any. */
interface OpenWait {
  command: string;
  kind: string;
  request: Obj;
  inside: string | null;
}

/**
 * The escalation of the review at `command` is a question (spec/attention.md "Counting"): counted, in the caller's
 * transaction that escalates it, against the reservation of the sub-program it was asked in (`inside`) or the run's
 * own. Whether the run's `asks` are exhausted: then nothing is counted, one `asks_exhausted` is written, and the
 * escalation is not made: the review expires, every open item declined by nobody. A run without an `asks` limit (every
 * run of 0.1 to 0.6) counts nothing, and is never refused.
 */
export async function escalationRefused(journal: Journal, tx: Tx, run: RunRow, command: string, inside: unknown): Promise<boolean> {
  const program = typeof inside === "string" ? inside : undefined;
  const out = await journal.countAsk(tx, run, program !== undefined ? { from: "program", program } : { from: "parent" });
  if (!out) return false;
  await journal.event(tx, run.run_id, "asks_exhausted", { command, kind: "review", limit: out.limit, settled: out.settled, ...(program !== undefined ? { inside: program } : {}) });
  return true;
}

/** The kinds of wait a deadline ends. An input asks without a deadline, and a timer is no row of its own. */
const EXPIRING = new Set(["decision", "amendment", REVIEW]);

/**
 * How long a run that waits on a wait already decided must not have moved before a tick drives it on. Whoever decided
 * drives the run right after the decision commits, and until then the run still says `waiting`; a tick in that gap
 * would take the lease from that drive, and two drives would replay at once. What is compared is the runtime's clock
 * with the time of the run's last event: every write of a run (a decision, a lease, an expiry) writes one.
 */
export const STALE_DRIVE_MS = 30_000;

/** The time of the run's last event, by the runtime's clock. */
async function lastMoved(q: Pick<Tx, "query">, runId: string): Promise<number> {
  const [r] = await q.query<Row>("select max(at) as at from events where run_id = $1", [runId]);
  return Number(r?.["at"] ?? 0);
}

async function openWaits(q: Pick<Tx, "query">, runId: string): Promise<OpenWait[]> {
  const rows = await q.query<Row>("select command_id, kind, result, inside from commands where run_id = $1 and state = 'waiting' order by command_id", [runId]);
  return rows.map((r) => ({ command: String(r["command_id"]), kind: String(r["kind"]), request: isObj((r["result"] ?? null) as Value) ? (r["result"] as Obj) : {}, inside: typeof r["inside"] === "string" ? r["inside"] : null }));
}

/** What a tick of the run would do now: the waits past their deadline, and whether the run is to be driven anyway. */
async function planOf(q: Pick<Tx, "query">, run: RunRow, open: OpenWait[], now: number): Promise<{ due: OpenWait[]; stale: boolean; timer: boolean }> {
  const due = open.filter((w) => EXPIRING.has(w.kind) && typeof w.request["deadline"] === "number" && now >= w.request["deadline"]);
  const w = isObj(run.waiting) ? run.waiting : {};
  const req = isObj(w["request"] ?? null) ? (w["request"] as Obj) : {};
  // A timer is due once its end has come; it is the one wait that is no row of a person's.
  const timer = w["kind"] === "timer" && typeof req["deadline"] === "number" && now >= req["deadline"];
  // A run that waits on a person's wait whose command is no longer waiting was decided and not driven on since, once it
  // has not moved for `STALE_DRIVE_MS`: until then the drive of whoever decided, or of the tick that expired it, is on its way.
  let stale = false;
  if (w["kind"] !== "timer" && typeof w["command"] === "string" && !open.some((o) => o.command === w["command"])) {
    const [row] = await q.query<Row>("select kind, state from commands where run_id = $1 and command_id = $2", [run.run_id, w["command"]]);
    stale = !!row && WAIT_KINDS.has(String(row["kind"])) && row["state"] !== "waiting" && now - (await lastMoved(q, run.run_id)) >= STALE_DRIVE_MS;
  }
  return { due, stale, timer };
}

/**
 * `tick` for a run of 0.7 (spec/attention.md "The driver loop"). Within its deadlines, with no wait decided and not
 * driven on, it does nothing and asks nothing of the host. Otherwise it checks the host first (an unfit one acts on
 * nothing), then, in one transaction under the run's lock:
 *
 * - a decision or an amendment past its deadline expires: its command fails `Rejected(approval_expired)`, and
 *   `wait_expired` is written;
 * - a review past its deadline is escalated once, when it has a role to escalate to: the same question is asked of
 *   that role with a whole deadline of its own (`review_escalated`), and the run's revision moves; otherwise, or once
 *   the escalated deadline has passed too, every open item is declined, by nobody (`review_expired`, `wait_expired`).
 *
 * Each in the order of the commands' ids, each only while its row is still `waiting`. Then the run is driven when a
 * wait expired, when the wait `runs.waiting` names was decided and not driven on (and the run has not moved for
 * `STALE_DRIVE_MS`), or when its timer is due. For the wait `runs.waiting` names, what is written is what `tick`
 * writes for a run of 0.6.
 */
export async function tickOpenWaits(rt: { db: Db; journal: Journal; adapters: Pick<Adapters, "clock"> }, runId: string, hooks: TickHooks): Promise<RunRow> {
  const run = await rt.journal.run(runId);
  if (run.state !== "waiting") return run;
  const plan = await planOf(rt.db, run, await openWaits(rt.db, runId), rt.adapters.clock.now());
  if (!plan.due.length && !plan.stale && !plan.timer) return run;
  if (plan.due.length || plan.stale) await hooks.fit();
  const now = rt.adapters.clock.now();
  const drive = await rt.db.tx(async (tx) => {
    const locked = await rt.journal.lock(tx, runId);
    if (locked.state !== "waiting") return false;
    // Read again under the lock: what another tick, a decision or a worker did meanwhile is seen here.
    const again = await planOf(tx, locked, await openWaits(tx, runId), now);
    let waiting: Obj = isObj(locked.waiting) ? locked.waiting : {};
    let expired = false;
    let escalated = false;
    for (const w of again.due) {
      if (w.kind !== REVIEW) {
        const [hit] = await tx.query<Row>("update commands set state = 'failed', error = $3 where run_id = $1 and command_id = $2 and state = 'waiting' returning command_id", [
          runId,
          w.command,
          JSON.stringify({ tag: "Rejected", args: ["approval_expired"] }),
        ]);
        if (!hit) continue;
        await rt.journal.event(tx, runId, "wait_expired", { command: w.command });
        expired = true;
        continue;
      }
      const req = w.request;
      const q = questionIn(req);
      const deadline = req["deadline"];
      const ms = req["deadline_ms"];
      if (!q || typeof deadline !== "number" || typeof ms !== "number" || now < deadline) continue;
      const role = String(req["role"]);
      const to = req["escalate_to"];
      // The escalation is counted against `asks` here; past them it is not made, and the review expires below.
      if (typeof to === "string" && to !== role && req["escalated"] === undefined && !(await escalationRefused(rt.journal, tx, locked, w.command, w.inside))) {
        const next: Obj = { ...req, role: to, deadline: now + ms, escalated: { from: role, at: now } };
        const [hit] = await tx.query<Row>("update commands set result = $3 where run_id = $1 and command_id = $2 and state = 'waiting' returning command_id", [runId, w.command, JSON.stringify(next)]);
        if (!hit) continue;
        await rt.journal.event(tx, runId, "review_escalated", { command: w.command, from: role, to, deadline: now + ms });
        if (waiting["command"] === w.command) waiting = { ...waiting, request: next };
        escalated = true;
        continue;
      }
      const open = q.items.map((i) => i.index).sort((a, b) => a - b);
      const outcome: Obj = { subject: String(req["subject_digest"]), waive: [], decline: open, by: null, role, expired: true };
      const [hit] = await tx.query<Row>("update commands set state = 'succeeded', result = $3, error = null where run_id = $1 and command_id = $2 and state = 'waiting' returning command_id", [
        runId,
        w.command,
        JSON.stringify(outcome),
      ]);
      if (!hit) continue;
      await rt.journal.event(tx, runId, "review_expired", { command: w.command, role, declined: open });
      await rt.journal.event(tx, runId, "wait_expired", { command: w.command });
      expired = true;
    }
    // An escalation moves the run's revision, so a decision made on what the first role was shown is stale; the wait
    // the run names asks the new role from here on.
    if (escalated) await rt.journal.setState(tx, runId, "waiting", { waiting });
    return expired || again.stale || again.timer;
  });
  return drive ? hooks.drive(runId) : rt.journal.run(runId);
}

// ── the pass ────────────────────────────────────────────────────────────

/** How long `mandate tick --follow` waits between two passes unless told otherwise. */
export const TICK_INTERVAL_MS = 10_000;

/** What a pass needs: a runtime for each run's package, and (unless `--no-notify`) the notification pass's options. */
export interface PassOptions {
  /**
   * A runtime for the package of run `runId`, with what to close once the run is ticked: the CLI builds one from the
   * configuration for each run, with the run's adapters; a test gives its own.
   */
  runtimeFor(runId: string): Promise<{ rt: { tick(runId: string): Promise<RunRow> }; close?: () => Promise<void> }>;
  /** The notification pass after the runs are ticked; none without it. */
  notify?: Omit<NotifyOptions, "signal">;
  /** Told of each run whose tick moved it (its revision changed). */
  onTicked?: (r: { run: string; before: { state: string; revision: number }; after: RunRow }) => void;
  /** Told of each run whose tick failed; the pass goes on with the next run. */
  onError?: (run: string, e: unknown) => void;
  /** Told when the notification pass failed as a whole. */
  onNotifyError?: (e: unknown) => void;
  /** The runtime's clock, which says what is due: a runtime is built only for a run with something due. */
  now?: () => number;
}

export interface PassReport {
  /** The runs that were waiting when the pass began. */
  waiting: number;
  /** Those with something due, for which a runtime was built and `tick` called. */
  due: number;
  /** Those whose tick moved them. */
  moved: number;
  /** Those whose tick failed, and a notification pass that failed as a whole. */
  failed: number;
  notify?: NotifyReport;
}

/**
 * Whether a waiting run has something for `tick` to do now, read without a runtime, by the rules `tick` itself
 * follows for the run's language:
 *
 * - a run of 0.7 (`tickOpenWaits`): the deadline of an open wait has passed, its timer is due, or the wait
 *   `runs.waiting` names was decided and the run has not moved for `STALE_DRIVE_MS`;
 * - a run of 0.1 to 0.6 (runtime.ts `tick`, as before): its review is past its deadline or was decided, or the
 *   deadline of its decision, its amendment or its timer has passed.
 */
async function dueNow(db: Db, runId: string, now: number, is07: (hash: string) => Promise<boolean>): Promise<boolean> {
  const [run] = await db.query<Row>("select waiting, package_hash from runs where run_id = $1 and state = 'waiting'", [runId]);
  if (!run) return false;
  const w = isObj((run["waiting"] ?? null) as Value) ? (run["waiting"] as Obj) : undefined;
  const req = w && isObj(w["request"] ?? null) ? (w["request"] as Obj) : {};
  const passed = typeof req["deadline"] === "number" && now >= req["deadline"];
  if (!(await is07(String(run["package_hash"])))) {
    if (!w) return false;
    if (w["kind"] === REVIEW) {
      if (passed) return true;
      const [row] = await db.query<Row>("select state from commands where run_id = $1 and command_id = $2", [runId, String(w["command"])]);
      return !!row && row["state"] !== "waiting";
    }
    return passed && (w["kind"] === "timer" || w["kind"] === "decision" || w["kind"] === "amendment");
  }
  const open = await openWaits(db, runId);
  if (open.some((o) => EXPIRING.has(o.kind) && typeof o.request["deadline"] === "number" && now >= o.request["deadline"])) return true;
  if (!w) return false;
  if (w["kind"] === "timer") return passed;
  if (typeof w["command"] !== "string" || open.some((o) => o.command === w["command"])) return false;
  const [row] = await db.query<Row>("select kind, state from commands where run_id = $1 and command_id = $2", [runId, w["command"]]);
  return !!row && WAIT_KINDS.has(String(row["kind"])) && row["state"] !== "waiting" && now - (await lastMoved(db, runId)) >= STALE_DRIVE_MS;
}

/**
 * Whether the package of hash `hash` is of 0.7 or later (package.ts `isPackage07OrLater`), read from the database once:
 * its `is_07`, written when it was stored, or for a package stored without it, the languages of its program and modules.
 */
function packageIs07(db: Db): (hash: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>();
  return (hash) => {
    let k = known.get(hash);
    if (!k) {
      k = db
        .query<Row>(
          `select p.is_07, case when p.is_07 is null then p.program->'language' end as language,
                  case when p.is_07 is null then (select coalesce(jsonb_agg(m.value->'language'), '[]'::jsonb) from jsonb_each(case when jsonb_typeof(p.modules) = 'object' then p.modules else '{}'::jsonb end) m) end as modules
             from packages p where package_hash = $1`,
          [hash],
        )
        .then(([p]) => !!p && (typeof p["is_07"] === "boolean" ? p["is_07"] : [p["language"], ...(Array.isArray(p["modules"]) ? (p["modules"] as Value[]) : [])].some((language) => isProgram07OrLater({ language }))));
      known.set(hash, k);
    }
    return k;
  };
}

/**
 * One pass of the driver loop: each run in state `waiting`, oldest first, that has something due (`dueNow`) is
 * `tick`ed by a runtime built for its own package, closed once it is done; a run whose tick fails (an unfit host, a
 * halted tenant, a package that no longer loads) is reported and left as it is, and the pass goes on. Then, with
 * `notify`, the notification pass, with the pass's signal: a stop cuts a request in flight.
 */
export async function tickPass(db: Db, o: PassOptions, signal?: AbortSignal): Promise<PassReport> {
  const runs = (await db.query<Row>("select run_id from runs where state = 'waiting' order by created_at, run_id")).map((r) => String(r["run_id"]));
  const report: PassReport = { waiting: runs.length, due: 0, moved: 0, failed: 0 };
  const now = o.now ?? Date.now;
  const is07 = packageIs07(db);
  for (const runId of runs) {
    if (signal?.aborted) break;
    let made: Awaited<ReturnType<PassOptions["runtimeFor"]>> | undefined;
    try {
      if (!(await dueNow(db, runId, now(), is07))) continue;
      report.due++;
      const [row] = await db.query<Row>("select state, revision from runs where run_id = $1", [runId]);
      made = await o.runtimeFor(runId);
      const before = { state: String(row?.["state"]), revision: Number(row?.["revision"]) };
      const after = await made.rt.tick(runId);
      if (after.revision !== before.revision) {
        report.moved++;
        o.onTicked?.({ run: runId, before, after });
      }
    } catch (e) {
      report.failed++;
      o.onError?.(runId, e);
    } finally {
      await made?.close?.().catch(() => undefined);
    }
  }
  if (o.notify && !signal?.aborted) {
    // A pass that could not be made (the database, a channel that cannot be used) is reported; the cursors stand where
    // they were, and the next pass tries again.
    try {
      report.notify = await notifyPass(db, { ...o.notify, ...(signal ? { signal } : {}) });
    } catch (e) {
      report.failed++;
      o.onNotifyError?.(e);
    }
  }
  return report;
}

/** The longest interval a timer of Node takes: a longer one is cut to 1 ms, which would make `--follow` a busy loop. */
export const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * One pass, or with `follow` one pass every `intervalMs` until `signal` aborts. With `follow`, a pass that throws (the
 * database went away) is reported (`onPassError`), and the loop sleeps and goes on; without it, the throw is the
 * caller's. Gives the last pass's report, and how many passes were made.
 */
export async function driveLoop(
  db: Db,
  o: PassOptions & { follow?: boolean; intervalMs?: number; signal?: AbortSignal; onPass?: (r: PassReport) => void; onPassError?: (e: unknown) => void },
): Promise<{ last: PassReport | undefined; passes: number }> {
  const interval = o.intervalMs ?? TICK_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > MAX_INTERVAL_MS) throw new RangeError(`the interval is a whole number of milliseconds from 1 to ${MAX_INTERVAL_MS}`);
  if (!o.follow) {
    const last = await tickPass(db, o, o.signal);
    o.onPass?.(last);
    return { last, passes: 1 };
  }
  let last: PassReport | undefined;
  let passes = 0;
  for (;;) {
    try {
      last = await tickPass(db, o, o.signal);
      o.onPass?.(last);
    } catch (e) {
      if (o.signal?.aborted) break;
      o.onPassError?.(e);
    }
    passes++;
    if (o.signal?.aborted) break;
    await sleep(interval, o.signal);
    if (o.signal?.aborted) break;
  }
  return { last, passes };
}

/** Waits `ms`, or until `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}
