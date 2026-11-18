// `WatchRun` and `ListWaits` (spec/attention.md "`WatchRun`", "`ListWaits`"; language 0.7): a run's events as an
// audience may see them, after a cursor, and every open question across all runs for a role or a member.
//
// Both read the journal and the attention facts stored with each run, and give what projection.ts and mask.ts make
// of them: an event only when its class lets the audience see it, through the fixed allow-list of its type's fields;
// a wait's values masked by the cap of the role it is asked of, and labelled. A run of 0.1 to 0.6 is given as it is
// recorded: nothing of it is masked or labelled. Following a run is polling with the cursor `next`: there is no
// listener and no subscription. There is no server and no authenticated read either: whoever reaches the database
// reads everything already, so these are projections for people, not a security boundary of their own; they are made
// as if they were one.

import { isProgram07OrLater, type Lock } from "@mandate/bridge";
import type { Audience } from "./classes.js";
import { TERMINAL, type RunRow } from "./journal.js";
import { capOf, DEFAULT_CAP, holdsNoRole, plainValues, type MaskedValue, type NamedShown, type UnlabelledValue } from "./mask.js";
import { askedOf, attentionContext, given, maskDigest, maskedWait, projectEvent, type AttentionContext, type Ev, type ProjectedEvent } from "./projection.js";
import { shownBy, type Runtime } from "./runtime.js";
import { Violation } from "./signals.js";
import { isObj, type Obj, type Value } from "./values.js";
import { programRoles } from "./views.js";

/** The most events one call of `watchRun` gives. */
export const WATCH_LIMIT = 500;

/** How many events `watchRun` gives when it is not told. */
export const WATCH_DEFAULT = 100;

/** What `watchRun` gives: the events after the cursor that the audience may see, and the cursor to ask from next. */
export interface Watched {
  run: string;
  /** The run's revision and last event when the call read it. */
  as_of: { revision: number; event: number };
  events: ProjectedEvent[];
  /** The sequence number to give as `afterSeq` next: the last event this call read, whether it was given or not. */
  next: number;
  /** The run has ended and every event of it was read. */
  ended: boolean;
}

/** The event types a projection's context is made of: who each wait asks and which facts it was opened under. */
const CONTEXT_TYPES = ["wait_opened", "review_requested", "review_escalated", "amendment_requested", "program_admitted", "package_amended"];

const toEv = (r: { seq: unknown; type: unknown; data: unknown; at: unknown }): Ev => ({ seq: Number(r.seq), type: String(r.type), data: (r.data ?? null) as Value, at: Number(r.at) });

/** The events of a run's context through `through` (every one without it), in order. */
async function contextEvents(rt: Runtime, runId: string, through?: number): Promise<Ev[]> {
  const rows = await rt.db.query<{ seq: unknown; type: unknown; data: unknown; at: unknown }>(
    `select seq, type, data, at from events where run_id = $1${through === undefined ? "" : " and seq <= $2"} and type in (${CONTEXT_TYPES.map((t) => `'${t}'`).join(", ")}) order by seq`,
    through === undefined ? [runId] : [runId, through],
  );
  return rows.map(toEv);
}

/**
 * The events of run `runId` after `afterSeq` that `audience` may see, at most `limit` of them read (at most
 * WATCH_LIMIT): each by its class (`given`) and projected through its type's allow-list (`projectEvent`), with a wait's
 * request and a report's fields masked and labelled in a run of 0.7. A role the run's program does not name is refused
 * (`unknown_role`), as its view is.
 */
export async function watchRun(rt: Runtime, runId: string, audience: Audience, o: { afterSeq?: number; limit?: number } = {}): Promise<Watched> {
  const after = o.afterSeq ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) throw new Violation("bad_cursor", `afterSeq is a whole number of 0 or more, not ${String(o.afterSeq)}.`);
  const limit = o.limit ?? WATCH_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WATCH_LIMIT) throw new Violation("bad_limit", `limit is a whole number from 1 to ${WATCH_LIMIT}, not ${String(o.limit)}.`);
  const run = await rt.getRun(runId);
  const { program, modules, source } = await rt.runProgram(runId);
  if ("role" in audience) {
    const named = programRoles(program, modules);
    if (!named.includes(audience.role)) throw new Violation("unknown_role", `Run ${runId}'s program names no role ${audience.role}; it names ${named.length ? named.join(", ") : "none"}.`);
  }
  const [last] = await rt.db.query<{ n: unknown }>("select coalesce(max(seq), 0) as n from events where run_id = $1", [runId]);
  const lastSeq = Number(last?.n ?? 0);
  const window = (await rt.db.query<{ seq: unknown; type: unknown; data: unknown; at: unknown }>("select seq, type, data, at from events where run_id = $1 and seq > $2 and seq <= $3 order by seq limit $4", [runId, after, lastSeq, limit])).map(toEv);
  const next = window.length ? window[window.length - 1]!.seq : after;
  const context = await contextEvents(rt, runId, next);
  const all = [...new Map([...context, ...window].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
  const asked = askedOf(all);
  const ctx = isProgram07OrLater(source) ? await attentionContext(rt, run, all, (await rt.packageOf(run.package_hash)).lock) : undefined;
  return {
    run: runId,
    as_of: { revision: run.revision, event: lastSeq },
    events: window.filter((e) => given(audience, e, asked)).map((e) => projectEvent(e, audience, ctx)),
    next,
    ended: TERMINAL.has(run.state) && next >= lastSeq,
  };
}

/** One open question for a person (spec/attention.md "`ListWaits`"). */
export interface WaitItem {
  run: string;
  tenant: string;
  workflow: string;
  /** The package the wait was opened under. */
  package: string;
  revision: number;
  command: string;
  kind: "input" | "decision" | "review" | "amendment";
  /** The role it asks, or null for a wait that asks none, which is listed to every role the package's lock binds. */
  asked_of: string | null;
  /**
   * The role it is listed to, whose cap masks what it shows: `asked_of`, or for a wait that asks none each role listed;
   * null for a wait that asks none listed to a member the lock lists and binds to no role, who is shown it at
   * `internal`, the cap of a role the lock does not name.
   */
  role: string | null;
  since: number;
  deadline: number | null;
  escalates_to: string | null;
  on_no_answer: string;
  stage: string | null;
  /**
   * The digest a decision on it names (`Runtime.shown`'s `subject`). In a run of 0.7, masked (`MaskedValue`) for a
   * role its values are masked from: it is computed over them, and the rest of what it is computed over is shown.
   */
  subject: string | MaskedValue;
  /** What it shows, by where each value stands in its request: masked and labelled in a run of 0.7, as recorded in an older one. */
  shown: Array<NamedShown | UnlabelledValue>;
}

const WAIT_KINDS = ["input", "decision", "review", "amendment"] as const;

/** What happens with no answer when the facts do not say it (a run of 0.1 to 0.6), from the wait's own request. */
function noAnswer(kind: string, req: Obj): string {
  if (kind === "review") return typeof req["escalate_to"] === "string" && req["escalated"] === undefined ? "escalates" : "declined";
  if (kind === "amendment") return "refused_to_lead";
  if (kind === "decision" && typeof req["criterion"] === "string" && typeof req["deadline"] === "number") return "unmet";
  return "waits";
}

/**
 * Every open question across all runs for a role or a member, optionally of one tenant (spec/attention.md
 * "`ListWaits`"). It reads the `commands` rows in state `waiting` of runs that have not ended (a `par` can leave
 * several open in one run), which the partial index `commands_waiting` serves; a member is resolved to roles through
 * each package's own lock. A wait asked of a role is listed to that role; one that asks none to every role the
 * package's lock binds, once per role, with `asked_of: null`. In a run of 0.7 what it shows is masked by the cap of
 * the role it is listed to and labelled from the facts it was opened under.
 */
export async function listWaits(rt: Runtime, who: { role: string } | { member: string }, o: { tenant?: string } = {}): Promise<WaitItem[]> {
  const rows = await rt.db.query<{ run_id: string; command_id: string; kind: string; result: Value; request_digest: string; package: string | null; state: string }>(
    `select c.run_id, c.command_id, c.kind, c.result, c.request_digest, c.package, c.state
       from commands c join runs r on r.run_id = c.run_id
      where c.state = 'waiting' and c.kind in ('input', 'decision', 'review', 'amendment')
        and r.state not in ('succeeded', 'failed', 'cancelled')${o.tenant !== undefined ? " and r.tenant = $1" : ""}
      order by c.run_id, c.command_id`,
    o.tenant !== undefined ? [o.tenant] : [],
  );
  const packages = new Map<string, Promise<{ is07: boolean; lock: Lock }>>();
  const packageOf = (hash: string): Promise<{ is07: boolean; lock: Lock }> => {
    if (!packages.has(hash)) packages.set(hash, rt.packageOf(hash).then((p) => ({ is07: isProgram07OrLater(p.program), lock: p.lock })));
    return packages.get(hash)!;
  };
  // One source for whether a wait is masked and for the facts it is masked by: the run's context, built from its events
  // and its package's lock whenever the run's package or the wait's is of 0.7. Should the two ever differ in language,
  // the wait is masked (the facts of a run of 0.6 give no label, so every value is).
  const runs = new Map<string, Promise<{ run: RunRow; events: Ev[]; is07: boolean; ctx: () => Promise<AttentionContext> }>>();
  const runOf = (runId: string): Promise<{ run: RunRow; events: Ev[]; is07: boolean; ctx: () => Promise<AttentionContext> }> => {
    if (!runs.has(runId)) {
      runs.set(
        runId,
        (async () => {
          const run = await rt.getRun(runId);
          const events = await contextEvents(rt, runId);
          const p = await packageOf(run.package_hash);
          let made: Promise<AttentionContext> | undefined;
          return { run, events, is07: p.is07, ctx: () => (made ??= attentionContext(rt, run, events, p.lock)) };
        })(),
      );
    }
    return runs.get(runId)!;
  };
  const out: WaitItem[] = [];
  for (const row of rows) {
    const r = await runOf(row.run_id);
    const { run, events } = r;
    const hash = row.package ?? run.package_hash;
    const { is07: wait07, lock } = await packageOf(hash);
    const ctx = r.is07 || wait07 ? await r.ctx() : undefined;
    const bound = isObj((lock.roles ?? null) as Value) ? (lock.roles as Record<string, unknown>) : {};
    const roles = "role" in who ? [who.role] : Object.entries(bound).filter(([, ms]) => Array.isArray(ms) && ms.includes(who.member)).map(([r]) => r);
    const req = isObj(row.result) ? row.result : {};
    const asked = typeof req["role"] === "string" && req["role"] !== "" ? req["role"] : null;
    // A member the lock lists and binds to no role may answer a wait that asks none (`roleRefusal`): it is listed to
    // them in no role, at the cap of a role the lock does not name. A wait asked of a role is not.
    const listed: Array<string | null> =
      asked !== null ? roles.filter((r) => r === asked) : "member" in who && holdsNoRole(lock, who.member) ? [null] : roles.filter((r) => Object.hasOwn(bound, r));
    if (!listed.length) continue;
    const opened = events.find((e) => e.type === "wait_opened" && isObj(e.data) && e.data["command"] === row.command_id);
    const facts = ctx?.waits.get(row.command_id);
    const escalated = req["escalated"] !== undefined;
    for (const role of listed) {
      const cap = role === null ? DEFAULT_CAP : capOf(lock, role);
      const subject = shownBy(run, row.command_id, { kind: row.kind, result: row.result, request_digest: row.request_digest }).subject;
      out.push({
        run: run.run_id,
        tenant: run.tenant,
        workflow: run.workflow,
        package: hash,
        revision: run.revision,
        command: row.command_id,
        kind: (WAIT_KINDS as readonly string[]).includes(row.kind) ? (row.kind as WaitItem["kind"]) : "input",
        asked_of: asked,
        role,
        since: opened?.at ?? 0,
        deadline: typeof req["deadline"] === "number" ? req["deadline"] : null,
        escalates_to: row.kind === "review" ? (typeof req["escalate_to"] === "string" && !escalated ? req["escalate_to"] : null) : (facts?.escalates_to ?? null),
        on_no_answer: facts?.on_no_answer ?? noAnswer(row.kind, req),
        stage: facts?.stage ?? null,
        // A wait the run's events do not show opened is not known to be shown: its subject is masked (`maskDigest`).
        subject: ctx ? (maskDigest(ctx, ctx.waits.has(row.command_id) ? row.command_id : undefined, cap, subject) as string | MaskedValue) : subject,
        shown: ctx ? maskedWait(ctx, row.command_id, row.kind, row.result, cap).shown : plainValues(row.kind, row.result),
      });
    }
  }
  return out.sort((a, b) => a.since - b.since || (a.run < b.run ? -1 : a.run > b.run ? 1 : 0) || (a.command < b.command ? -1 : a.command > b.command ? 1 : 0) || ((a.role ?? "") < (b.role ?? "") ? -1 : (a.role ?? "") > (b.role ?? "") ? 1 : 0));
}
