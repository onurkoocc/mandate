// What a person is shown of a run of 0.7 (spec/attention.md "Masking and how a value is known", "A role's view",
// "`WatchRun`"; spec/boundary.md "Classes"): the facts each wait was opened under, the role view's sections `stages`,
// `reports` and `programs`, and the fixed allow-list each event type is projected through.
//
// Everything here reads the journal's events and the attention facts stored with the run (at its start, with an
// amendment, at a sub-program's admission), and nothing else: no class is worked out of a value, and no event's data
// is copied but by the fields the allow-list names. There is no server, no listener and no authenticated read: whoever
// reaches the database reads everything already (spec/attention.md "The command line"), so these are projections for
// people, not a security boundary of their own; they are made as if they were one.

import { DATA_CLASSES, type AttentionFacts, type AttentionStage, type DataClass, type Lock } from "@mandate/bridge";
import { readFacts } from "./attention.js";
import { addressee, eventClass, shows, type Audience, type ViewClass } from "./classes.js";
import type { RunRow } from "./journal.js";
import { capOf, digestAs, hides, labelOf, maskedAs, maskRequest, maskValue, siteOf, waitFacts, type Cap, type Label, type ShownValue, type WaitFacts } from "./mask.js";
import type { Runtime } from "./runtime.js";
import { Violation } from "./signals.js";
import { isObj, type Obj, type Value } from "./values.js";

/** An event as the projections read it. */
export interface Ev {
  seq: number;
  type: string;
  data: Value;
  at: number;
}

const text = (v: Value | undefined): string | null => (typeof v === "string" ? v : null);
const objOf = (v: Value | undefined): Obj => (isObj(v ?? null) ? (v as Obj) : {});

// ── the facts each wait was opened under ────────────────────────────────

/** A sub-program a run's lead admitted: its command, its `plan` node and number, and the digest of its stored facts. */
interface Admitted {
  command: string;
  plan: string;
  number: number;
  attention: string | undefined;
}

/**
 * What the projections of a run of 0.7 read besides its events: its package's lock (the roles' caps), the facts of
 * its own program in force now, the facts of each sub-program, and the facts of each wait, by its command.
 */
export interface AttentionContext {
  lock: Lock | undefined;
  /** The facts of the run's own program in force at the last event read (after an amendment, the amended workflow's). */
  facts: AttentionFacts | undefined;
  /** Each admitted sub-program, by its `plan` node and number (`plan#number`), with its stored facts. */
  programs: Map<string, { command: string; plan: string; number: number; facts: AttentionFacts | undefined }>;
  /** Each wait's facts, by its command: from the facts in force where it was opened, by its site tag. */
  waits: Map<string, WaitFacts>;
  /** The wait each action's digest was asked about, by `action_digest` (an `action_authorized` names the digest, not the wait). */
  actions: Map<string, string>;
  /**
   * The class of what each sub-program's lead received, by `plan#number`, as its `program_started` records it: what a
   * lead wrote into a sub-program (its stages' names and titles, its reports' titles, its workflow's name and shape) is
   * a value of that class a model wrote. Absent where no `program_started` names one: such text is masked for every role.
   */
  leads: Map<string, DataClass>;
}

/** The key of a sub-program by its `plan` node and number. */
export const programKey = (plan: string, number: number): string => `${plan}#${number}`;

/**
 * The context of run `run` from its events `events` (in order): which facts were in force at each wait (the run's
 * manifest's, then each `package_amended`'s, or the admission's of the sub-program the wait stands in), read once per
 * digest. Facts that are missing or do not hash to their digest give no labels, so every value they would label is
 * masked; nothing is thrown, so that one broken run does not hide the waits of the others.
 */
export async function attentionContext(rt: Runtime, run: RunRow, events: readonly Ev[], lock: Lock | undefined): Promise<AttentionContext> {
  const manifest = isObj(run.manifest) ? text(run.manifest["attention"]) : null;
  let inForce: string | null = manifest;
  const admitted: Admitted[] = [];
  const opened: Array<{ command: string; site: Value | undefined; digest: string | null }> = [];
  const escalated = new Set<string>();
  const actions = new Map<string, string>();
  const leads = new Map<string, DataClass>();
  for (const e of events) {
    const d = objOf(e.data);
    if (e.type === "package_amended" && typeof d["attention"] === "string") inForce = d["attention"];
    else if (e.type === "program_admitted" && typeof d["command"] === "string") admitted.push({ command: d["command"], plan: String(d["plan"]), number: Number(d["number"]), attention: text(d["attention"]) ?? undefined });
    else if (e.type === "review_escalated" && typeof d["command"] === "string") escalated.add(d["command"]);
    else if (e.type === "program_started" && typeof d["plan"] === "string" && (DATA_CLASSES as readonly unknown[]).includes(d["class"])) leads.set(programKey(d["plan"], Number(d["number"])), d["class"] as DataClass);
    else if (e.type === "wait_opened" && typeof d["command"] === "string") {
      const cmd = d["command"];
      // A wait of a sub-program stands under the command it was admitted as; the longest such command is its own.
      const inside = admitted.filter((a) => cmd.startsWith(`${a.command}/`)).sort((a, b) => b.command.length - a.command.length)[0];
      opened.push({ command: cmd, site: d["site"], digest: inside ? (inside.attention ?? null) : inForce });
      const action = objOf(d["request"])["action_digest"];
      if (typeof action === "string" && !actions.has(action)) actions.set(action, cmd);
    }
  }
  const scope = { tenant: run.tenant, runId: run.run_id };
  const read = new Map<string, Promise<AttentionFacts | undefined>>();
  const factsOf = (digest: string | null | undefined): Promise<AttentionFacts | undefined> => {
    if (!digest) return Promise.resolve(undefined);
    if (!read.has(digest)) {
      read.set(
        digest,
        readFacts(rt.artifacts, scope, digest, `Run ${run.run_id}`).catch((e: unknown) => {
          if (e instanceof Violation) return undefined;
          throw e;
        }),
      );
    }
    return read.get(digest)!;
  };
  const waits = new Map<string, WaitFacts>();
  for (const w of opened) if (!waits.has(w.command)) waits.set(w.command, waitFacts(await factsOf(w.digest), siteOf(w.site), escalated.has(w.command)));
  const programs: AttentionContext["programs"] = new Map();
  for (const a of admitted) programs.set(programKey(a.plan, a.number), { command: a.command, plan: a.plan, number: a.number, facts: await factsOf(a.attention) });
  return { lock, facts: await factsOf(inForce), programs, waits, actions, leads };
}

/**
 * Whether `cap` is not shown the values of the wait `command`, and the label they are masked with: a wait the context
 * knows (one it saw opened), whose label hides its values from `cap`. A command that is no wait the run opened gives
 * undefined: what is decided on it (an envelope, a raise of the limits) is no value of a wait.
 */
export function waitHidden(ctx: AttentionContext, command: string | undefined, cap: Cap): { label: Label | undefined } | undefined {
  if (command === undefined || !ctx.waits.has(command)) return undefined;
  const label = ctx.waits.get(command)!.label;
  return hides(label, cap) ? { label } : undefined;
}

/**
 * A digest computed over the values of the wait `wait` (a decision's id, an action's digest, a waiver's evidence id,
 * the subject a decision names) as `cap` is given it: the one rule of every path a role is given one by (the role
 * view, `WatchRun`, `ListWaits`). Masked, as the wait's values are, where the wait's label hides them from `cap`;
 * masked too where it is not known which wait it is of (`wait` undefined); as it is for a command that is no wait the
 * run opened (an envelope's approval, a raise of the limits), and for the audit audience.
 */
export function maskDigest(ctx: AttentionContext, wait: string | undefined, cap: Cap, value: Value): Value {
  if (wait !== undefined && !ctx.waits.has(wait)) return value;
  return digestAs(wait === undefined ? undefined : ctx.waits.get(wait)!.label, cap, value);
}

/** The sub-program the command `command` stands in, by its `plan#number`: the admitted one whose command is the longest prefix of it. */
export function programOfCommand(ctx: AttentionContext, command: string): string | undefined {
  let best: { key: string; length: number } | undefined;
  for (const [key, p] of ctx.programs) if (command.startsWith(`${p.command}/`) && (!best || p.command.length > best.length)) best = { key, length: p.command.length };
  return best?.key;
}

/**
 * Text a lead wrote into sub-program `key` (a stage's name or title, a report's title, its workflow's name or shape)
 * as `cap` is shown it: a value a model wrote, of the class of what the lead received; masked for every role when
 * that class is not known.
 */
export function leadText(ctx: AttentionContext, key: string, v: Value, cap: Cap): ShownValue {
  const cls = ctx.leads.get(key);
  if (cls !== undefined) return maskValue(v, { class: cls, known: "model" }, cap);
  return { ...maskValue(v, undefined, cap), known: "model" };
}

/** The cap of an audience: a role's, from the lock, or the audit's, which sees every value. */
export function capFor(ctx: AttentionContext, audience: Audience): Cap {
  return "audit" in audience ? "audit" : capOf(ctx.lock, audience.role);
}

/** A wait's request as `cap` is shown it, with the values it shows (`maskRequest`), under the wait's facts. */
export function maskedWait(ctx: AttentionContext, command: string, kind: string, request: Value, cap: Cap): ReturnType<typeof maskRequest> {
  return maskRequest(kind, request, ctx.waits.get(command)?.label, cap);
}

// ── the role view's sections of 0.7 ─────────────────────────────────────

/** A stage as a role's view shows it (spec/attention.md "A role's view"). */
export interface StageView {
  /** A stage of the run's own program: its name and title as the program says them. A sub-program's: `ShownValue`s (`leadText`). */
  stage: string | ShownValue;
  title: string | ShownValue;
  state: "done" | "current" | "not_started";
  started_at: number | null;
  ended_at: number | null;
  /** A sub-program's stage: its `plan` node and number. */
  program?: { plan: string; number: number };
  /** The stages of the sub-programs that started while this stage was the run's own current one. */
  stages?: StageView[];
}

/** A report addressed to a role, its fields as `ShownValue`s, each with its name and type. */
export interface ReportView {
  node: string;
  command: string;
  /** As the program says it; a sub-program's report's, a `ShownValue` (`leadText`). */
  title: string | ShownValue;
  seq: number;
  at: number;
  fields: Array<{ name: string; type: string } & ShownValue>;
}

/** How many sub-programs started and ended (0.7, `program_started` and `program_ended`). */
export interface ProgramsView {
  started: number;
  ended: number;
}

/**
 * The stages of a run of 0.7: each stage of its own program in the order of the facts, done, current or not started,
 * with the times of its `stage_started` and `stage_ended`; under each, the stages of the sub-programs that started
 * while it was current (each with its `program`); a sub-program that started before any stage of the run's own, in
 * the list itself.
 */
export function stagesView(ctx: AttentionContext, events: readonly Ev[], cap: Cap): StageView[] {
  type Seen = { started: Ev | undefined; ended: Ev | undefined };
  const seen = new Map<string, Seen>();
  const progOf = (d: Obj): string => {
    const p = objOf(d["program"]);
    return typeof p["plan"] === "string" ? programKey(p["plan"], Number(p["number"])) : "";
  };
  // The program each sub-program's stages begin under: its `program_started`, else its first stage's event.
  const anchors = new Map<string, number>();
  const order: string[] = [];
  for (const e of events) {
    const d = objOf(e.data);
    if (e.type === "program_started" && typeof d["plan"] === "string") {
      const k = programKey(d["plan"], Number(d["number"]));
      if (!anchors.has(k)) {
        anchors.set(k, e.seq);
        order.push(k);
      }
    }
    if (e.type !== "stage_started" && e.type !== "stage_ended") continue;
    const p = progOf(d);
    if (p !== "" && !anchors.has(p)) {
      anchors.set(p, e.seq);
      order.push(p);
    }
    const key = `${p}|${String(d["node"])}`;
    const s = seen.get(key) ?? { started: undefined, ended: undefined };
    if (e.type === "stage_started" && !s.started) s.started = e;
    if (e.type === "stage_ended" && !s.ended) s.ended = e;
    seen.set(key, s);
  }
  const view = (p: string, facts: readonly AttentionStage[], program?: { plan: string; number: number }): Array<{ view: StageView; startedSeq: number | undefined }> => {
    // The stages the facts name, in their order; then any the journal holds and the facts do not, as they began.
    const listed = [...facts].sort((a, b) => a.index - b.index).map((f) => ({ node: f.path, stage: f.name, title: f.title }));
    for (const e of events) {
      const d = objOf(e.data);
      if (e.type === "stage_started" && progOf(d) === p && !listed.some((l) => l.node === d["node"])) listed.push({ node: String(d["node"]), stage: String(d["stage"]), title: String(d["title"]) });
    }
    return listed.map((l) => {
      const s = seen.get(`${p}|${l.node}`);
      const state = s?.ended ? "done" : s?.started ? "current" : "not_started";
      // What a lead wrote is a value a model wrote, masked by the role's cap (`leadText`); the run's own program's is the program's.
      const named = (v: string): string | ShownValue => (program ? leadText(ctx, p, v, cap) : v);
      return { view: { stage: named(l.stage), title: named(l.title), state, started_at: s?.started?.at ?? null, ended_at: s?.ended?.at ?? null, ...(program ? { program } : {}) }, startedSeq: s?.started?.seq };
    });
  };
  const own = view("", ctx.facts?.stages ?? []);
  const top: StageView[] = own.map((s) => s.view);
  for (const k of order) {
    const p = ctx.programs.get(k);
    const plan = p ? p.plan : k.slice(0, k.lastIndexOf("#"));
    const number = p ? p.number : Number(k.slice(k.lastIndexOf("#") + 1));
    const stages = view(k, p?.facts?.stages ?? [], { plan, number }).map((s) => s.view);
    if (!stages.length) continue;
    // Under the run's own stage that began last before the sub-program did: the stage its `plan` node stands in.
    const at = anchors.get(k)!;
    const host = own.filter((s) => s.startedSeq !== undefined && s.startedSeq < at).at(-1)?.view;
    if (host) host.stages = [...(host.stages ?? []), ...stages];
    else top.push(...stages);
  }
  return top;
}

/** The reports addressed to `audience` (`shows`'s `addressed`: a role sees those to it; the audit view every one), its fields masked by `cap`. */
export function reportsView(audience: Audience, cap: Cap, events: readonly Ev[], ctx: AttentionContext): ReportView[] {
  return events
    .filter((e) => e.type === "report" && shows(audience, eventClass(e.type), undefined, addressee(e.type, e.data)))
    .map((e) => {
      const d = objOf(e.data);
      const key = programOfCommand(ctx, String(d["command"]));
      const title = key !== undefined ? leadText(ctx, key, String(d["title"]), cap) : String(d["title"]);
      return { node: String(d["node"]), command: String(d["command"]), title, seq: e.seq, at: e.at, fields: reportFields(d["fields"], cap) };
    });
}

/** A report's fields as `cap` is shown them: each by its own class and level, as the event carries them; a field whose class is not known is masked. */
function reportFields(fields: Value | undefined, cap: Cap): ReportView["fields"] {
  return (Array.isArray(fields) ? fields : []).map((f) => {
    const o = objOf(f);
    return { name: String(o["name"]), type: String(o["type"]), ...maskValue(o["value"] ?? null, labelOf(o["class"], o["known"]), cap) };
  });
}

/** How many sub-programs started and ended. */
export function programsView(events: readonly Ev[]): ProgramsView {
  return { started: events.filter((e) => e.type === "program_started").length, ended: events.filter((e) => e.type === "program_ended").length };
}

// ── the allow-list of `WatchRun` ────────────────────────────────────────

/** An event type a role is given only its shell of: `{seq, at, type, class}`, no data. */
export const NOTHING = "nothing";

/**
 * The fields each event type is projected through for a role (spec/attention.md "`WatchRun`"; the table beside the
 * class table of spec/boundary.md, which a test holds equal to this one). Only these members of an event's data are
 * given, and only those of `MASKED` go through the mask; every other member is left out, whatever it holds. An event
 * type with no entry here is given as its shell alone, as one whose entry is `NOTHING` is; a test holds every type
 * the runtime writes to have one, and every field it writes to be named here or in `WITHHELD`.
 */
export const PROJECTIONS: Readonly<Record<string, readonly string[] | typeof NOTHING>> = {
  // S0: who was asked what, and who decided, by name, role and digest; a wait's request and nothing else masked.
  wait_opened: ["command", "kind", "site", "request"],
  wait_expired: ["command"],
  decision_received: ["command", "member", "role", "decision"],
  input_received: ["command", "member", "role", "decision"],
  decision_refused: ["command", "reason", "kind", "member", "role"],
  criterion_approved: ["command", "by", "member", "role", "decision"],
  criterion_denied: ["command", "by", "member", "role", "decision"],
  governance_approved: ["command", "digest", "by", "member", "role", "decision"],
  governance_denied: ["command", "digest", "by", "member", "role", "decision"],
  action_authorized: ["authorization", "digest", "by", "member", "role", "decision"],
  envelope_approved: ["package", "member", "role", "decision"],
  amendment_requested: ["plan", "step", "lead", "from", "package", "diff"],
  package_amended: ["from", "to", "diff", "plan", "command", "limits", "superseded", "by", "member", "role", "decision", "attention"],
  limits_raised: ["by", "from", "to", "member", "role", "decision"],
  reconcile_requested: ["operation", "member", "role", "decision"],
  review_requested: ["node", "contract", "map", "role", "escalate_to", "deadline", "open", "declined", "failed", "accepted"],
  review_decided: ["command", "waive", "decline", "by", "member", "role", "decision"],
  review_escalated: ["command", "from", "to", "deadline"],
  review_expired: ["command", "role", "declined"],
  criterion_waived: ["command", "index", "contract", "criterion", "waiver", "failed", "decision"],
  // S1: how the run ended and what stopped it, by name and count; never a result, an error, a detail or a request.
  run_succeeded: NOTHING,
  run_failed: NOTHING,
  run_cancelled: NOTHING,
  run_cancelling: NOTHING,
  run_attention_required: NOTHING,
  cancel_requested: ["halt", "reason", "by", "member", "role", "decision"],
  lease_revoked: ["halt", "fence"],
  violation: ["kind", "delegate", "agent", "step", "count"],
  budget_exceeded: ["episode"],
  guarantee_lowered: ["agent", "delivery", "reason"],
  asks_exhausted: ["command", "kind", "limit", "settled", "inside"],
  // S2: progress, by command, kind, count and cost; a report's fields masked.
  run_accepted: ["workflow", "package", "limits", "manifest"],
  run_running: NOTHING,
  run_waiting: NOTHING,
  lease_acquired: ["fence"],
  command_dispatched: ["command", "kind", "reserved"],
  command_completed: ["command", "ok", "cost"],
  command_throttled: ["command", "times"],
  charge_pending: ["command"],
  charge_settled: ["command", "cost"],
  map_started: ["map", "items", "par"],
  map_ended: ["map", "outcomes", "failed"],
  stage_started: ["node", "stage", "title", "index", "program"],
  stage_ended: ["node", "stage", "program"],
  report: ["node", "command", "role", "title", "fields"],
  program_started: ["plan", "number", "command", "workflow", "shape", "class"],
  program_ended: ["plan", "number", "ok"],
  // S3 and S4: no role is given them; their entries say so.
  action_prepared: NOTHING,
  action_committed: NOTHING,
  action_confirmed: NOTHING,
  action_rejected: NOTHING,
  action_unknown_outcome: NOTHING,
  action_cancelled: NOTHING,
  action_would_apply: NOTHING,
  changeset_prepared: NOTHING,
  changeset_would_apply: NOTHING,
  changeset_simulated: NOTHING,
  changeset_committed: NOTHING,
  changeset_partial: NOTHING,
  changeset_failed: NOTHING,
  program_submitted: NOTHING,
  program_refused: NOTHING,
  program_admitted: NOTHING,
  sandbox_stopped: NOTHING,
};

/**
 * The fields of an event's data a role is never given, by its type: decided, and left out. A signing key's id, the
 * sender and message id of a request, a fault's arguments or a refused call's detail, a step's meta. A test holds
 * every field the runtime writes in an event whose type gives a role anything to be in `PROJECTIONS` or here, so a
 * new field is given to nobody until it is decided; and a field neither names is not given whatever it holds.
 */
export const WITHHELD: Readonly<Record<string, readonly string[]>> = {
  // What `setState` writes with a run's state (journal.ts): `run_accepted` itself is written with what the run started from.
  run_accepted: ["waiting", "attention", "result", "error", "summary"],
  decision_received: ["sender", "message", "key"],
  input_received: ["sender", "message", "key"],
  decision_refused: ["key", "sender", "message"],
  criterion_approved: ["key"],
  criterion_denied: ["key"],
  governance_approved: ["key"],
  governance_denied: ["key"],
  action_authorized: ["key"],
  envelope_approved: ["key"],
  package_amended: ["key"],
  limits_raised: ["sender", "message", "key"],
  reconcile_requested: ["key"],
  review_decided: ["key"],
  cancel_requested: ["key"],
  violation: ["detail"],
  budget_exceeded: ["detail"],
  command_completed: ["meta"],
  command_throttled: ["fault"],
};

/** The fields of an entry whose values a role is given masked and labelled (0.7): a wait's request and a report's fields. */
export const MASKED: Readonly<Record<string, string>> = { wait_opened: "request", report: "fields" };

/**
 * The fields of an entry that are digests computed over a wait's values (0.7): a decision's id (its record holds the
 * wait's subject digest), a governance gate's or an authorization's action digest. Each is masked, as the wait's values
 * are, for a role the wait's label hides them from (`waitHidden`): the rest of what it is computed over is shown, so a
 * value with few possibilities could be found by trying each. The wait is the event's `command`; an authorization's,
 * the wait its digest was asked about, and when none is known the digests are masked.
 */
export const DIGESTS: Readonly<Record<string, readonly string[]>> = {
  decision_received: ["decision"],
  input_received: ["decision"],
  criterion_approved: ["decision"],
  criterion_denied: ["decision"],
  governance_approved: ["digest", "decision"],
  governance_denied: ["digest", "decision"],
  action_authorized: ["digest", "decision"],
  review_decided: ["decision"],
  // A waiver's evidence and the failure it waives are statements over the item's value: their ids are digests of it.
  criterion_waived: ["waiver", "failed", "decision"],
  package_amended: ["decision"],
};

/**
 * The fields of an entry that hold text a lead wrote, when the event is of a sub-program (0.7): each is a value a
 * model wrote, of the class of what the lead received (`leadText`). Of the run's own program, the program's text.
 */
export const LEAD_TEXT: Readonly<Record<string, readonly string[]>> = {
  stage_started: ["stage", "title"],
  stage_ended: ["stage"],
  report: ["title"],
  program_started: ["workflow", "shape"],
};

/** An event as `WatchRun` gives it. */
export interface ProjectedEvent {
  seq: number;
  at: number;
  type: string;
  class: ViewClass;
  /** The fields its type's entry names; absent for a type given as its shell alone. */
  data?: Obj;
}

/**
 * The roles each S0 event of `events` was asked of, by its sequence number, as the events up to it say: a wait's
 * (its `wait_opened`'s role), every role a review was asked of once escalated (the first and the one it went to), and
 * for a decision on no wait (an envelope's approval, a raise of the limits, a reconciliation) the role it was made in.
 * A wait that asks no role is asked of none.
 */
export function askedOf(events: readonly Ev[]): Map<number, string[]> {
  const roles = new Map<string, string[]>();
  const first = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "wait_opened") continue;
    const d = objOf(e.data);
    const role = text(objOf(d["request"])["role"]);
    if (typeof d["command"] === "string" && role !== null && role !== "" && !first.has(d["command"])) first.set(d["command"], role);
  }
  const add = (command: string, role: string | null): void => {
    if (role === null || role === "") return;
    const r = roles.get(command) ?? [];
    if (!r.includes(role)) roles.set(command, [...r, role]);
  };
  const out = new Map<number, string[]>();
  for (const e of events) {
    if (eventClass(e.type) !== "S0") continue;
    const d = objOf(e.data);
    let command = text(d["command"]);
    if (e.type === "wait_opened" && command !== null) add(command, text(objOf(d["request"])["role"]));
    if (e.type === "review_requested") {
      command = text(d["node"]);
      if (command !== null) add(command, text(d["role"]));
    }
    // An amendment's request is written with its wait, before it: the wait's command is its step's `/amendment`.
    if (e.type === "amendment_requested" && typeof d["step"] === "string") {
      command = `${d["step"]}/amendment`;
      add(command, first.get(command) ?? null);
    }
    if (e.type === "review_escalated" && command !== null) add(command, text(d["to"]));
    const signedRole = text(d["role"]);
    out.set(e.seq, command !== null && roles.has(command) ? roles.get(command)! : command === null && signedRole !== null ? [signedRole] : []);
  }
  return out;
}

/**
 * Whether `audience` is given event `e` (rule 1 of `WatchRun`): by its class through `shows`, an S0 event only to a
 * role it was asked of (`asked`), a report only to the role it is addressed to.
 */
export function given(audience: Audience, e: Ev, asked: ReadonlyMap<number, string[]>): boolean {
  const cls = eventClass(e.type);
  const to = addressee(e.type, e.data);
  if (cls !== "S0") return shows(audience, cls, undefined, to);
  if ("audit" in audience) return true;
  return (asked.get(e.seq) ?? []).some((r) => shows(audience, cls, r, to));
}

/**
 * Event `e` projected for `audience` (rules 2 and 3 of `WatchRun`). The audit audience is given its data whole. A role
 * is given the fields its type's entry names and nothing else, `{seq, at, type, class}` alone for a type whose entry
 * is `NOTHING` or that has none; in a run of 0.7 (`ctx`), a wait's request and a report's fields masked by the role's
 * cap and labelled. Whether the event is given at all is `given`'s.
 */
export function projectEvent(e: Ev, audience: Audience, ctx: AttentionContext | undefined): ProjectedEvent {
  const shell = { seq: e.seq, at: e.at, type: e.type, class: eventClass(e.type) };
  if ("audit" in audience) return { ...shell, data: objOf(e.data) };
  const entry = Object.hasOwn(PROJECTIONS, e.type) ? PROJECTIONS[e.type]! : NOTHING;
  if (entry === NOTHING) return shell;
  const d = objOf(e.data);
  const masked = Object.hasOwn(MASKED, e.type) ? MASKED[e.type] : undefined;
  const cap = ctx ? capFor(ctx, audience) : undefined;
  const data: Obj = {};
  const digests = ctx && cap !== undefined && Object.hasOwn(DIGESTS, e.type) ? DIGESTS[e.type]! : [];
  const wait = ctx && digests.length ? digestWait(ctx, e.type, d) : undefined;
  const lead = ctx && cap !== undefined && Object.hasOwn(LEAD_TEXT, e.type) ? LEAD_TEXT[e.type]! : [];
  const key = ctx && lead.length ? leadKey(ctx, e.type, d) : undefined;
  for (const f of entry) {
    if (!Object.hasOwn(d, f)) continue;
    if (ctx && cap !== undefined && digests.includes(f)) data[f] = maskDigest(ctx, wait, cap, d[f]!);
    else if (ctx && cap !== undefined && key !== undefined && lead.includes(f)) data[f] = leadText(ctx, key, d[f]!, cap) as unknown as Value;
    else if (f !== masked || !ctx || cap === undefined) data[f] = d[f]!;
    else if (e.type === "report") data[f] = reportFields(d[f], cap) as unknown as Value;
    else data[f] = maskedWait(ctx, String(d["command"]), String(d["kind"]), d[f]!, cap).request;
  }
  return { ...shell, data };
}

/**
 * The wait the digests of event data `d` are computed over (`DIGESTS`): its `command`; an authorization's, the wait
 * its action's digest was asked about, undefined (so masked) when no wait of the run was.
 */
function digestWait(ctx: AttentionContext, type: string, d: Obj): string | undefined {
  if (type === "action_authorized") return ctx.actions.get(String(d["digest"]));
  return text(d["command"]) ?? undefined;
}

/** The sub-program an event of `LEAD_TEXT` is of, by `plan#number`; undefined for the run's own program. */
function leadKey(ctx: AttentionContext, type: string, d: Obj): string | undefined {
  if (type === "program_started") return typeof d["plan"] === "string" ? programKey(d["plan"], Number(d["number"])) : undefined;
  if (type === "report") return programOfCommand(ctx, String(d["command"]));
  const p = objOf(d["program"]);
  return typeof p["plan"] === "string" ? programKey(p["plan"], Number(p["number"])) : undefined;
}
