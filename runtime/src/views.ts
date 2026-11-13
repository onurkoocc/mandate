// Human projections of a run (Doc 4 §15, INV-10): what a person needs to see
// to decide, made from the program and the run's journal and nothing else.
//
//   status     the run's state, and if it waits for a person, what for and
//              about what, with the command that answers it at this revision
//   evidence   each criterion's records: method, result, who produced it,
//              whether its signature holds, its outputs (§15.4)
//   cost       the budget table: limits, settled, reserved, per command
//   actions    external actions: state, operation, receipt
//   change sets  per set (design doc 9 §8.2): the approved plan, the change per
//              component with declared and measured interface changes, the
//              criterion × component evidence matrix, the order and why, what
//              was real and what simulated, and what it changes in authority
//   decisions  each decision a person made on the run: who, in which role,
//              and whether its signature holds, or that it was unsigned
//
// and of a run under an envelope (0.4; spec/envelope.md "Views"):
//
//   envelope   its owner, what is left of it in each dimension, and each
//              amendment with both package hashes and who approved it
//   plans      per `plan` node, what its lead submitted: each sub-program
//              with its number, whether it was admitted, its hash, its
//              reservation, the codes that refused it, and its text
//   maps       per map, its items by input index with their outcome
//
// plus the program's own views (architecture, authority), under the same
// program hash. Each run view names the revision and the last event it
// shows; `freshness` tells how far the run has moved since (G10), and a
// decision taken on an older revision is refused (stale_revision). Anything
// that came from a model, a tool or a person's answer is shown as untrusted
// plain content (G09).

import { architecture, architectureBlocks, authority, authorityBlocks, check, governanceFiles, hashProgram, linkedProgram, printProgram, programRef, rolesNamed, semanticDiff, VIEW_FORMAT, type Block, type Cell, type ComponentDef, type Doc, type Json, type Modules, type ProgramRef, type Program } from "@mandate/compiler";
import { eventClass, sectionClass, shows, stepClass, TRACE_KINDS, type Audience, type ViewClass } from "./classes.js";
import { authorizationId } from "./decisions.js";
import { costDims, type BudgetReport, type ChangesetRow, type EvidenceRow, type HaltRow } from "./journal.js";
import type { JournalReport } from "./journal-chain.js";
import type { Runtime } from "./runtime.js";
import { Violation } from "./signals.js";
import { covers, type ChangeKind } from "./specdiff.js";
import { canonical, digest, isObj, show, type Obj, type Value } from "./values.js";

export interface AsOf {
  revision: number;
  /** The run's last event this view includes. */
  event: number;
}

export interface RunView {
  format: typeof VIEW_FORMAT;
  kind: "run";
  program: ProgramRef;
  package: string;
  run: { id: string; workflow: string; tenant: string; state: string };
  /** What the run started from (B3): the manifest's hash R, its mode (B6), and each component at its base commit. */
  manifest: { hash: string | null; mode: string; components: Array<{ name: string; repo: string; base: string }> };
  /** The modules the program imports, such as its system model, by program hash (INV-10). */
  modules: Array<{ module: string; hash: string }>;
  as_of: AsOf;
  waiting: Value;
  attention: Value;
  result: Value;
  error: Value;
  evidence: Array<{ evidence_id: string; contract: string; criterion: string; method: string; passed: boolean; producer: Value; signature_valid: boolean; artifacts: Value; at: number | null }>;
  budget: BudgetReport;
  actions: Array<{ effect: string; state: string; operation: string; action_digest: string; receipt: Value; artifacts: Value }>;
  changesets: ChangesetView[];
  /** Each decision a person made on the run, oldest first. */
  decisions: DecisionView[];
  /** The envelope the run is under, and what is left of it; null for a run without one. */
  envelope: EnvelopeView | null;
  /** What each `plan` node's lead submitted, by the node's path. */
  plans: PlanView[];
  /** Each map that began to run its items, in the order they began. */
  maps: MapView[];
}

/** A decision a person made on a run (spec/envelope.md "Views"): who, in which role, and whether its signature holds. */
export interface DecisionView {
  /**
   * `envelope`, `approve`, `decline`, `answer`, `amend`, `raise_limits`, `reconcile` or `cancel`. `decision` where
   * the journal does not say: for an unsigned one that came after its wait's deadline, and for one whose record
   * is not stored any more.
   */
  kind: string;
  /** The wait it answered or the action it reconciled; null for a decision about the run or its package. */
  about: string | null;
  /** The member who signed, as the lock names them. For an unsigned decision, the name the caller gave, if any. */
  by: string | null;
  role: string | null;
  /** A signed record is checked again now: `valid` or `invalid`. `unsigned` where the runtime took a name. */
  signature: "valid" | "invalid" | "unsigned";
  /** Why a signed record does not hold. */
  problem: string | null;
  decision_id: string | null;
}

/** The envelope a run is under (spec/envelope.md "Views"). */
export interface EnvelopeView {
  workflow: string;
  owner: string | null;
  /** In each dimension the run is limited in: what the envelope gives, the run's limit, and what is left of it. */
  remainder: Array<{ dimension: string; envelope: number | null; limit: number; settled: number; reserved: number; left: number }>;
  /** `time` is no ledger dimension: it is the run's deadline, its start plus the envelope's `time`. Null without one. */
  deadline: number | null;
  /** Each amendment the owner approved, oldest first: the run's package before and after, and the limits that rose. */
  amendments: Array<{ from: string; to: string; by: string | null; role: string | null; command: string; limits: Record<string, { from: number; to: number }> }>;
}

/** What the lead of one `plan` node submitted (spec/envelope.md "Views"). */
export interface PlanView {
  node: string;
  lead: string | null;
  submissions: Array<{
    step: string;
    number: number;
    /** `admitted`, `refused`, or `submitted` when the journal holds neither yet. */
    outcome: "admitted" | "refused" | "submitted";
    /** The hash of the sub-program the lead's patch made; null when the patch made none. */
    hash: string | null;
    /** The codes of the errors that refused it. */
    codes: string[];
    /** The kinds of change in it that a person approves in a program of their own (§13.2). */
    governance: string[];
    /** What its admission reserved of the envelope, by dimension. */
    reservation: Record<string, number>;
    /** The command it runs as, and how that stands: `dispatched`, `succeeded` or `failed`. */
    command: string | null;
    state: string | null;
    /**
     * The admitted sub-program as text. A model wrote it. Null when it was not admitted, and when what is stored
     * is `gone` (retention) or is a `mismatch`: it does not hash to what was admitted, and is not shown.
     */
    text: string | null;
    stored: "kept" | "gone" | "mismatch" | null;
  }>;
  /** The amendments its lead asked for: `waiting`, `approved`, `declined`, or why the wait ended unanswered. */
  amendments: Array<{ step: string; from: string; package: string; outcome: string; by: string | null }>;
}

/** One map of a run (spec/envelope.md "Views"). */
export interface MapView {
  node: string;
  items: number;
  par: number;
  /** `running` until the map has ended; `ended` with every outcome, or `failed` when `fail_fast` stopped it. */
  state: "running" | "ended" | "failed";
  /** The fault that failed the map. */
  failed: string | null;
  /**
   * By input index. Of a map that has ended: `Ok`, the item's fault, or `no outcome` for an item a failed map did
   * not start or did not let end. Of one that runs: `not started`, `in flight`, or `settled` for an item whose
   * commands have all ended.
   */
  outcomes: string[];
}

type Cellval = "passed" | "failed" | "unknown";

/** One change set as a person decides on it (design doc 9 §8.2). */
export interface ChangesetView {
  node: string;
  set_digest: string;
  /** `prepared`, `committed`, `partial`, `failed`, `would_apply` (read_only) or `simulated` (design). */
  state: string;
  /** What of it is real: the run's mode and what happened to each member. */
  reality: string;
  plan: { value: Value; digest: string; evidence: string[]; approved_by: Array<{ criterion: string; by: string | null; role: string | null }> };
  components: Array<{
    component: string;
    effect: string;
    approver: string;
    /** The member's action: `confirmed`, `prepared`, …, or `simulated`. */
    action: string;
    files: string[];
    /** Its governance-class files (K70), each with its kind: the component's owner approves these whatever else authorizes the member. */
    governance: Array<{ file: string; kind: string }>;
    /** The component's owner, who approves its governance-class files. */
    owner: string;
    /** Each interface the component provides that the set or the plan names, or whose spec a check measured. */
    interfaces: Array<{ interface: string; declared: string | null; measured: string | null }>;
    /** Why the change is not the plan's, if it is not. */
    unplanned: string[];
  }>;
  /** Rows: criteria of the members' evidence; columns: components. */
  matrix: Array<{ contract: string; criterion: string; method: string; cells: Record<string, { result: Cellval; evidence_id: string | null }> }>;
  order: Array<{ component: string; because: string[] }>;
  /** What the set changes in Mandate's own terms: programs, the system model, the lock. Empty when it changes none. */
  authority: Array<{ component: string; file: string; changes: string[] }>;
}

/** How far a run has moved since a view of it was made (G10). */
export interface Freshness {
  as_of: AsOf;
  now: AsOf;
  behind_events: number;
  stale: boolean;
}

/**
 * A run as one role sees it (spec/boundary.md "Views by role and the audit view"): the sections of the run's view in
 * S1 and S2 as they are, and of S0 what was asked of this role; nothing of a step's request or result, or of a trace.
 */
export interface RoleView {
  format: typeof VIEW_FORMAT;
  kind: "run_role";
  role: string;
  program: ProgramRef;
  package: string;
  run: RunView["run"];
  manifest: RunView["manifest"];
  modules: RunView["modules"];
  as_of: AsOf;
  /** The wait the run is in, whole, when it is asked of this role; null otherwise. */
  waiting: Value;
  /** The decisions asked of this role, oldest first. */
  decisions: DecisionView[];
  exceptions: Exceptions;
  /** The budget's dimensions, and of its commands each one's step that is not an agent loop's, nor a wait asked of another role. */
  budget: BudgetReport;
  /** The envelope, with its amendments only for the role that owns it. */
  envelope: EnvelopeView | null;
  maps: MapView[];
}

/** How the run ended, and what stopped or bent it (S1), by the fields named: no message, no fault argument. */
export interface Exceptions {
  /** The tag of the fault the run failed with, or that left it attention_required. */
  fault: string | null;
  /** Why the run needs a person, while it is attention_required. */
  attention: {
    /** The code of the invariant violation that stopped it, `violation_limit` among them. */
    violation: string | null;
    /** The halt that left an action open. */
    halted: string | null;
    /** The code of another reason, such as `delivery_unknown`. */
    reason: string | null;
    /** The command the reason is about. */
    command: string | null;
    /** A change set stopped with some of its members applied. */
    changeset_partial: boolean;
    /** The actions whose outcome is not final, by operation, effect and state. */
    actions: Array<{ operation: string | null; effect: string | null; state: string | null }>;
  } | null;
  /** Each violation, in the order the journal took them. `detail`, which holds what the agent asked for, only in the audit view. */
  violations: Array<{ seq: number; at: number; kind: string | null; delegate: string | null; agent: string | null; step: string | null; count: number; detail?: Value }>;
  /** The halt that ended the run: its id, who halted and why, and the fence it revoked. */
  halt: { halt: string; reason: string | null; by: string | null; fence: number | null; seq: number; at: number } | null;
}

/** One command of a run as the audit view shows it: its step, its request's digest and its result. */
export interface CommandView {
  command: string;
  kind: string;
  label: string | null;
  state: string;
  request_digest: string;
  result: Value;
  error: Value;
  /** Retention purged its payloads (R14): the result and the error are gone. */
  purged: boolean;
}

/** Everything of a run (spec/boundary.md "Views by role and the audit view"): S0 to S4, its events and its journal's status. */
export interface AuditView extends Omit<RunView, "kind"> {
  kind: "run_audit";
  /** What the run was started with. */
  input: Value;
  exceptions: Exceptions;
  /** Each command that is not an agent loop's, in command-id order. */
  steps: CommandView[];
  /** Each command of an agent loop: its sessions, turns and tool calls. */
  trace: CommandView[];
  /** Every event the view reaches, with its class, time, hash and data. */
  events: Array<{ seq: number; type: string; class: ViewClass; at: number; hash: string | null; data: Value }>;
  /** Every halt that covers the run's tenant, in force or lifted, oldest first. */
  halts: HaltRow[];
  /** The journal's chain, as `Runtime.verifyJournal` reports it when the view is made. */
  chain: JournalReport;
}

/**
 * A run's view (§15): with no audience as it always was; for `{ role }` what that role may see; for `{ audit: true }`
 * everything, with the chain's status. Only the audit view verifies the chain, as a step of its own: the default view
 * and a role's never read more than the journal's events and rows.
 */
export async function runView(rt: Runtime, runId: string): Promise<{ view: RunView; program: Program }>;
export async function runView(rt: Runtime, runId: string, audience: { role: string }): Promise<{ view: RoleView; program: Program }>;
export async function runView(rt: Runtime, runId: string, audience: { audit: true }): Promise<{ view: AuditView; program: Program }>;
export async function runView(rt: Runtime, runId: string, audience?: Audience): Promise<{ view: RunView | RoleView | AuditView; program: Program }> {
  const { view, program, modules } = await defaultView(rt, runId);
  if (!audience) return { view, program };
  if ("role" in audience) {
    const named = programRoles(program, modules);
    if (!named.includes(audience.role)) throw new Violation("unknown_role", `Run ${runId}'s program names no role ${audience.role}; it names ${named.length ? named.join(", ") : "none"}.`);
  }
  const events = await storedEvents(rt, runId, view.as_of.event);
  if ("role" in audience) return { view: roleView(view, audience.role, events), program };
  const run = await rt.getRun(runId);
  const commands = await commandViews(rt, runId);
  const halts = (await rt.halts()).filter((h) => h.tenant === null || h.tenant === view.run.tenant);
  // The chain is checked here and nowhere else a view is made, after everything the view shows has been read.
  const chain = await rt.verifyJournal(runId);
  const audit: AuditView = {
    ...view,
    kind: "run_audit",
    input: run.input,
    exceptions: exceptionsOf(view, events, true),
    steps: commands.filter((c) => !TRACE_KINDS.has(c.kind)),
    trace: commands.filter((c) => TRACE_KINDS.has(c.kind)),
    events: events.map((e) => ({ seq: e.seq, type: e.type, class: eventClass(e.type), at: e.at, hash: e.hash, data: e.data })),
    halts,
    chain,
  };
  return { view: audit, program };
}

/** The roles a program names: its role definitions and every place it names one, with the modules it imports (0.4 roles; earlier names). */
export function programRoles(program: Program, modules: Modules): string[] {
  const defs = linkedProgram(program, modules).defs;
  return [...new Set([...Object.entries(defs).flatMap(([name, d]) => (d.kind === "role" ? [name] : [])), ...rolesNamed(defs)])].sort();
}

type Stored = { seq: number; type: string; data: Value; at: number; hash: string | null };

/** The run's events through `through`, with their times and hashes, as they are stored. Nothing here checks the chain. */
async function storedEvents(rt: Runtime, runId: string, through: number): Promise<Stored[]> {
  const rows = await rt.db.query<{ seq: unknown; type: string; data: Value; at: unknown; hash: string | null }>("select seq, type, data, at, hash from events where run_id = $1 and seq <= $2 order by seq", [runId, through]);
  return rows.map((r) => ({ seq: Number(r.seq), type: String(r.type), data: r.data, at: Number(r.at), hash: r.hash ?? null }));
}

async function commandViews(rt: Runtime, runId: string): Promise<CommandView[]> {
  const rows = await rt.db.query<{ command_id: string; kind: string; label: string | null; state: string; request_digest: string; result: Value; error: Value; payload_purged: unknown }>(
    "select command_id, kind, label, state, request_digest, result, error, payload_purged from commands where run_id = $1 order by command_id",
    [runId],
  );
  return rows.map((r) => ({ command: r.command_id, kind: r.kind, label: r.label ?? null, state: r.state, request_digest: r.request_digest, result: r.result ?? null, error: r.error ?? null, purged: r.payload_purged === true }));
}

/** The role each wait was asked of, by its command, as `wait_opened` names it. */
function waitRoles(events: Stored[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "wait_opened" || !isObj(e.data)) continue;
    const request = isObj(e.data["request"] ?? null) ? (e.data["request"] as Obj) : {};
    const role = text(request["role"]);
    if (role !== null) out.set(String(e.data["command"]), role);
  }
  return out;
}

/** The role the run's wait is asked of. */
function waitingRole(waiting: Value): string | null {
  const w = isObj(waiting) ? waiting : {};
  return text(isObj(w["request"] ?? null) ? (w["request"] as Obj)["role"] : undefined);
}

/**
 * What a role sees of a run. Each section of the run's view goes by its class (classes.ts) and nothing else: one in
 * S1 or S2 is shown whole; one in S0 shows what was asked of this role, row by row, by the role its wait or its
 * decision names; one in S3 or S4 is not shown. What the run ended with and what stopped it is `exceptions`, made of
 * the fields its section names.
 */
function roleView(v: RunView, role: string, events: Stored[]): RoleView {
  const audience = { role };
  const may = (section: string, askedOf?: string | null): boolean => shows(audience, sectionClass(section), askedOf);
  const asked = waitRoles(events);
  const askedOf = (d: DecisionView): string | null => (d.about !== null ? asked.get(d.about) : undefined) ?? d.role;
  const out: Record<string, unknown> = { format: v.format, kind: "run_role", role };
  for (const [section, value] of Object.entries(v)) if (section !== "format" && section !== "kind" && may(section)) out[section] = value;
  out["waiting"] = may("waiting", waitingRole(v.waiting)) ? v.waiting : null;
  out["decisions"] = v.decisions.filter((d) => may("decisions", askedOf(d)));
  if (out["budget"]) out["budget"] = { dimensions: v.budget.dimensions, commands: v.budget.commands.filter((c) => shows(audience, stepClass(c.kind), asked.get(c.command))) };
  if (v.envelope && out["envelope"]) out["envelope"] = { ...v.envelope, amendments: may("envelope.amendments", v.envelope.owner) ? v.envelope.amendments : [] };
  // What stopped the run is drawn from the events of the classes the role sees, by their types.
  if (may("exceptions")) out["exceptions"] = exceptionsOf(v, events.filter((e) => shows(audience, eventClass(e.type))), may("exceptions.violations.detail"));
  const first = ROLE_ORDER.filter((k) => Object.hasOwn(out, k));
  return Object.fromEntries([...first, ...Object.keys(out).filter((k) => !first.includes(k))].map((k) => [k, out[k]])) as unknown as RoleView;
}

/** The order of a role's view's sections, as a person reads them. */
const ROLE_ORDER = ["format", "kind", "role", "program", "package", "run", "manifest", "modules", "as_of", "waiting", "decisions", "exceptions", "budget", "envelope", "maps"];

/** A fault's tag: the name of what went wrong, never its arguments. */
const tagOf = (v: Value | undefined): string | null => (isObj(v ?? null) ? text((v as Obj)["$tag"]) : null);

/** How the run ended and what stopped it, from its state and the journal's S1 events, by the fields named. */
function exceptionsOf(v: RunView, events: Stored[], detail: boolean): Exceptions {
  const a = v.run.state === "attention_required" && isObj(v.attention) ? v.attention : undefined;
  const open = a && Array.isArray(a["open_actions"]) ? (a["open_actions"].filter(isObj) as Obj[]) : [];
  const single = a && typeof a["effect"] === "string" ? [a] : [];
  const cancel = events.find((e) => e.type === "cancel_requested" && isObj(e.data) && typeof e.data["halt"] === "string");
  const halt = cancel && isObj(cancel.data) ? String(cancel.data["halt"]) : undefined;
  const revoked = halt === undefined ? undefined : events.find((e) => e.type === "lease_revoked" && isObj(e.data) && e.data["halt"] === halt);
  return {
    fault: tagOf(v.run.state === "failed" ? v.error : undefined) ?? tagOf(a?.["error"]),
    attention: a
      ? {
          violation: text(a["violation"]),
          halted: text(a["halted"]),
          reason: text(a["reason"]),
          command: text(a["command"]),
          changeset_partial: Object.hasOwn(a, "changeset_partial"),
          actions: [...open, ...single].map((x) => ({ operation: text(x["operation"]), effect: text(x["effect"]), state: text(x["state"]) })),
        }
      : null,
    violations: events
      .filter((e) => e.type === "violation")
      .map((e) => {
        const d = isObj(e.data) ? e.data : {};
        return { seq: e.seq, at: e.at, kind: text(d["kind"]), delegate: text(d["delegate"]), agent: text(d["agent"]), step: text(d["step"]), count: Number(d["count"]), ...(detail ? { detail: d["detail"] ?? null } : {}) };
      }),
    halt:
      cancel && halt !== undefined && isObj(cancel.data)
        ? { halt, reason: text(cancel.data["reason"]), by: text(cancel.data["by"]), fence: revoked && isObj(revoked.data) && typeof revoked.data["fence"] === "number" ? revoked.data["fence"] : null, seq: cancel.seq, at: cancel.at }
        : null,
  };
}

async function defaultView(rt: Runtime, runId: string): Promise<{ view: RunView; program: Program; modules: Modules }> {
  // The view's position first: everything below is at least this new, and a later decision names this revision.
  const run = await rt.getRun(runId);
  const as_of = { revision: run.revision, event: await lastEvent(rt, runId) };
  const [row] = await rt.db.query<{ program: Program; modules: Modules | null }>("select program, modules from packages where package_hash = $1", [run.package_hash]);
  const program = row!.program;
  const modules = row!.modules ?? {};
  const signed = new Map((await rt.verifyEvidence(runId)).map((e) => [e.evidence_id, e.valid]));
  const evidence = (await rt.evidence(runId)).map((e) => {
    const rec = isObj(e.record) ? e.record : {};
    return {
      evidence_id: e.evidence_id,
      contract: e.contract,
      criterion: e.criterion,
      method: e.method,
      passed: e.passed,
      producer: rec["producer"] ?? null,
      signature_valid: signed.get(e.evidence_id) ?? false,
      artifacts: rec["artifacts"] ?? [],
      at: typeof rec["at"] === "number" ? rec["at"] : null,
    };
  });
  const actions = (await rt.journal.actions(runId)).map((a) => ({ effect: a.effect, state: a.state, operation: a.operation_key, action_digest: a.action_digest, receipt: a.receipt ?? null, artifacts: a.artifacts ?? null }));
  const events = await rt.journal.events(runId);
  const commands = await rt.db.query<{ command_id: string; state: string; result: Value; error: Value }>("select command_id, state, result, error from commands where run_id = $1", [runId]);
  const budget = await rt.budgetReport(runId);
  const view: RunView = {
    format: VIEW_FORMAT,
    kind: "run",
    program: programRef(program),
    package: run.package_hash,
    run: { id: run.run_id, workflow: run.workflow, tenant: run.tenant, state: run.state },
    manifest: {
      hash: run.manifest_hash,
      mode: isObj(run.manifest) && typeof run.manifest["mode"] === "string" ? run.manifest["mode"] : "live",
      components: Object.entries(isObj(run.manifest) && isObj(run.manifest["components"] ?? null) ? (run.manifest["components"] as Obj) : {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, c]) => ({ name, repo: String((c as Obj)["repo"]), base: String((c as Obj)["base"]) })),
    },
    modules: Object.entries(modules).sort(([a], [b]) => (a < b ? -1 : 1)).map(([module, p]) => ({ module, hash: hashProgram(p as unknown as Json).program })),
    as_of,
    waiting: run.waiting,
    attention: run.attention,
    result: run.result,
    error: run.error,
    evidence,
    budget,
    actions,
    changesets: await changesetViews(rt, runId, program, modules),
    decisions: await decisionViews(rt, runId, events, commands),
    envelope: envelopeView(program, run.workflow, budget, events, await rt.journal.startedAt(runId)),
    plans: await planViews(rt, { tenant: run.tenant, runId }, events, commands),
    maps: mapViews(events, commands),
  };
  return { view, program, modules };
}

type Event = { seq: number; type: string; data: Value };
type CommandState = { command_id: string; state: string; result: Value; error: Value };

const text = (v: Value | undefined): string | null => (typeof v === "string" ? v : null);

/** The one event a decision leaves that the runtime took by name, and the kind of decision it is. */
const UNSIGNED: Record<string, string> = { decision_received: "decision", input_received: "answer", limits_raised: "raise_limits", cancel_requested: "cancel" };
/** What a decision on a criterion or on a governance gate writes beside its `decision_received`, naming the same wait. */
const SAID: Record<string, string> = { criterion_approved: "approve", governance_approved: "approve", criterion_denied: "decline", governance_denied: "decline" };

/**
 * Each decision a person made on the run, in the order the journal took them. One that was signed is read from
 * the stored records and checked again now (INV-16): the envelope's approval, which the run started on, is the
 * first. Where the runtime took a name instead (unsigned mode), the journal's events are all there is, and the
 * row says `unsigned`. A stored record that no event names is listed last, so that none is left out.
 */
async function decisionViews(rt: Runtime, runId: string, events: Event[], commands: CommandState[]): Promise<DecisionView[]> {
  const records = await rt.verifyDecisions(runId);
  const listed = new Set<string>();
  const signed = (d: (typeof records)[number]): DecisionView => {
    listed.add(d.decision_id);
    return { kind: d.record.kind, about: d.record.command ?? null, by: d.record.member, role: d.record.role ?? null, signature: d.valid ? "valid" : "invalid", problem: d.problem ?? null, decision_id: d.decision_id };
  };
  const out: DecisionView[] = [];
  for (const e of events) {
    const d = isObj(e.data) ? e.data : {};
    const about = text(d["command"]);
    const id = text(d["decision"]);
    if (id !== null) {
      // A signed decision is named by every event it wrote. It is listed where the first of them is.
      if (listed.has(id)) continue;
      const record = records.find((r) => r.decision_id === id);
      // A record that is not stored any more cannot be checked, and is not shown as holding.
      if (record) out.push(signed(record));
      else {
        listed.add(id);
        out.push({ kind: "decision", about, by: text(d["member"]), role: text(d["role"]), signature: "invalid", problem: "the record the journal names is not stored", decision_id: id });
      }
      continue;
    }
    const kind = Object.hasOwn(UNSIGNED, e.type) ? UNSIGNED[e.type]! : undefined;
    if (kind === undefined) continue;
    // A halt's cancel is an operator's, not a person's decision on the run (spec/boundary.md "Violations and halt").
    if (e.type === "cancel_requested" && d["halt"] !== undefined) continue;
    // Unsigned. Which way a decision on a wait went is in the journal. One on a criterion or a gate writes an
    // event that names the wait. An approval of an action writes the authorization it made, whose id names the
    // message that carried the approval. A refusal of an action writes neither. The wait's result says it too,
    // but a result may be purged.
    const decided = e.type === "decision_received";
    const gate = decided ? events.find((x) => Object.hasOwn(SAID, x.type) && isObj(x.data) && x.data["command"] === about) : undefined;
    const authorized = decided ? events.find((x) => x.type === "action_authorized" && isObj(x.data) && x.data["authorization"] === authorizationId(String(x.data["digest"]), String(x.data["by"]), String(d["message"]))) : undefined;
    const said = gate ?? authorized;
    const wait = commands.find((c) => c.command_id === about);
    const result = wait && isObj(wait.result) ? wait.result : {};
    // The name the caller gave. An answer is given with none: the sender of its message is the one name there is.
    const by = decided ? ((said && isObj(said.data) ? text(said.data["by"]) : null) ?? text(result["by"])) : e.type === "input_received" ? text(d["sender"]) : text(d["by"]);
    out.push({
      kind: !decided ? kind : gate ? SAID[gate.type]! : authorized ? "approve" : wait?.state === "failed" ? "decision" : "decline",
      about,
      by: by === "" ? null : by,
      role: null,
      signature: "unsigned",
      problem: null,
      decision_id: null,
    });
  }
  for (const r of records) if (!listed.has(r.decision_id)) out.push(signed(r));
  return out;
}

/** The run's envelope: what it gives, what is left of it, and how it was amended. */
function envelopeView(program: Program, workflow: string, budget: BudgetReport, events: Event[], startedAt: number): EnvelopeView | null {
  const wf = Object.hasOwn(program.defs, workflow) ? program.defs[workflow] : undefined;
  if (wf?.kind !== "workflow" || !wf.envelope) return null;
  const gives = costDims(wf.envelope.budget);
  const amendments: EnvelopeView["amendments"] = [];
  for (const e of events) {
    if (e.type !== "package_amended" || !isObj(e.data)) continue;
    const d = e.data;
    const limits = isObj(d["limits"] ?? null) ? (d["limits"] as Obj) : {};
    const [from, to] = [isObj(limits["from"] ?? null) ? (limits["from"] as Obj) : {}, isObj(limits["to"] ?? null) ? (limits["to"] as Obj) : {}];
    amendments.push({
      from: String(d["from"]),
      to: String(d["to"]),
      by: text(d["member"]),
      role: text(d["role"]),
      command: String(d["command"]),
      limits: Object.fromEntries(Object.keys(to).sort().map((dim) => [dim, { from: Number(from[dim]), to: Number(to[dim]) }])),
    });
  }
  return {
    workflow,
    owner: wf.envelope.owner ?? null,
    remainder: budget.dimensions.map((d) => ({ dimension: d.dimension, envelope: gives[d.dimension] ?? null, limit: d.limit, settled: d.settled, reserved: d.reserved, left: d.available })),
    deadline: wf.envelope.budget?.time ? startedAt + wf.envelope.budget.time.ms : null,
    amendments,
  };
}

/**
 * An admitted sub-program as text, from the artifact store. It is shown only when it hashes to what was admitted
 * (INV-02), as a replay runs it only then.
 */
async function storedProgram(rt: Runtime, scope: { tenant: string; runId: string }, artifact: string, hash: string): Promise<{ text: string | null; stored: "kept" | "gone" | "mismatch" }> {
  let sub: Program;
  try {
    sub = JSON.parse(await rt.artifacts.text(scope, artifact)) as Program;
  } catch {
    // The payload is gone (retention): the hash still names what ran.
    return { text: null, stored: "gone" };
  }
  if (hashProgram(sub as unknown as Json).program !== hash) return { text: null, stored: "mismatch" };
  return { text: printProgram(sub), stored: "kept" };
}

/**
 * What each `plan` node's lead submitted, from `program_submitted`, `program_refused` and `program_admitted`, and
 * the amendments it asked for. An admitted sub-program is read from the artifact store and printed: it is the
 * lead's writing, and is shown as such (G09).
 */
async function planViews(rt: Runtime, scope: { tenant: string; runId: string }, events: Event[], commands: CommandState[]): Promise<PlanView[]> {
  const plans = new Map<string, PlanView>();
  const at = (node: string): PlanView => {
    let p = plans.get(node);
    if (!p) plans.set(node, (p = { node, lead: null, submissions: [], amendments: [] }));
    return p;
  };
  const of = (type: string, step: string): Obj | undefined => events.map((e) => (e.type === type && isObj(e.data) && e.data["step"] === step ? e.data : undefined)).find((d) => d !== undefined);
  const stateOf = (id: string): CommandState | undefined => commands.find((c) => c.command_id === id);
  for (const e of events) {
    const d = isObj(e.data) ? e.data : {};
    if (e.type === "program_submitted") {
      const p = at(String(d["plan"]));
      p.lead ??= text(d["lead"]);
      const step = String(d["step"]);
      const refused = of("program_refused", step);
      const admitted = of("program_admitted", step);
      const command = admitted ? String(admitted["command"]) : null;
      const written = admitted ? await storedProgram(rt, scope, String(admitted["artifact"]), String(admitted["hash"])) : { text: null, stored: null };
      p.submissions.push({
        step,
        number: Number(d["number"]),
        outcome: admitted ? "admitted" : refused ? "refused" : "submitted",
        hash: text(d["hash"]),
        codes: refused && Array.isArray(refused["codes"]) ? refused["codes"].map(String) : [],
        governance: Array.isArray(d["governance"]) ? d["governance"].map(String) : [],
        reservation: admitted && isObj(admitted["reservation"] ?? null) ? Object.fromEntries(Object.entries(admitted["reservation"] as Obj).map(([dim, n]) => [dim, Number(n)])) : {},
        command,
        state: command ? (stateOf(command)?.state ?? null) : null,
        ...written,
      });
    } else if (e.type === "amendment_requested") {
      const p = at(String(d["plan"]));
      p.lead ??= text(d["lead"]);
      const step = String(d["step"]);
      const wait = stateOf(`${step}/amendment`);
      const result = wait && isObj(wait.result) ? wait.result : {};
      const error = wait && isObj(wait.error) && Array.isArray(wait.error["args"]) ? wait.error["args"][0] : undefined;
      const outcome = !wait || wait.state === "waiting" ? "waiting" : wait.state === "succeeded" ? (result["approved"] === true ? "approved" : "declined") : String(error ?? "ended");
      p.amendments.push({ step, from: String(d["from"]), package: String(d["package"]), outcome, by: wait?.state === "succeeded" ? text(result["member"]) : null });
    }
  }
  // In the order the journal first names each plan.
  return [...plans.values()];
}

/** Each map the run began, from `map_started` and `map_ended`; of a map that still runs, how its items' commands stand. */
function mapViews(events: Event[], commands: CommandState[]): MapView[] {
  const out: MapView[] = [];
  for (const e of events) {
    if (e.type !== "map_started" || !isObj(e.data)) continue;
    const node = String(e.data["map"]);
    const items = Number(e.data["items"]);
    const ended = events.map((x) => (x.type === "map_ended" && isObj(x.data) && x.data["map"] === node ? x.data : undefined)).find((d) => d !== undefined);
    const recorded = ended && Array.isArray(ended["outcomes"]) ? ended["outcomes"] : undefined;
    const running = (i: number): string => {
      const mine = commands.filter((c) => c.command_id.startsWith(`${node}[${i}]/`));
      if (!mine.length) return "not started";
      return mine.some((c) => c.state !== "succeeded" && c.state !== "failed") ? "in flight" : "settled";
    };
    out.push({
      node,
      items,
      par: Number(e.data["par"]),
      state: !ended ? "running" : typeof ended["failed"] === "string" ? "failed" : "ended",
      failed: ended ? text(ended["failed"]) : null,
      outcomes: Array.from({ length: items }, (_, i) => (recorded ? (typeof recorded[i] === "string" ? (recorded[i] as string) : "no outcome") : running(i))),
    });
  }
  return out;
}

/** Each change set of a run, from its journal (doc 9 §8.2). */
async function changesetViews(rt: Runtime, runId: string, program: Program, modules: Modules): Promise<ChangesetView[]> {
  const sets = await rt.journal.changesets(runId);
  if (!sets.length) return [];
  const defs = linkedProgram(program, modules).defs;
  const evidence = new Map((await rt.evidence(runId)).map((e) => [e.evidence_id, e]));
  const actions = new Map((await rt.journal.actions(runId)).map((a) => [a.operation_key, a]));
  const out: ChangesetView[] = [];
  for (const s of sets) out.push(await changesetView(rt, runId, s, defs, program, modules, evidence, actions));
  return out;
}

async function changesetView(
  rt: Runtime,
  runId: string,
  s: ChangesetRow,
  defs: Program["defs"],
  program: Program,
  modules: Modules,
  evidence: Map<string, EvidenceRow>,
  actions: Map<string, { state: string; artifacts: Value; effect: string }>,
): Promise<ChangesetView> {
  const sum = isObj(s.summary) ? s.summary : {};
  const plan = isObj(sum["plan"] ?? null) ? (sum["plan"] as Obj) : {};
  const planChanges = isObj(plan["changes"] ?? null) ? (plan["changes"] as Obj) : {};
  const setChanges = isObj(sum["changes"] ?? null) ? (sum["changes"] as Obj) : {};
  const planComponents = Array.isArray(plan["components"]) ? plan["components"].filter((c): c is string => typeof c === "string") : undefined;
  const members = (Array.isArray(s.members) ? s.members : []).filter(isObj) as Obj[];
  const names = members.map((m) => String(m["component"]));
  const providerOf = (iface: string): string | undefined => Object.entries(defs).find(([, d]) => d.kind === "component" && d.provides?.includes(iface))?.[0];
  const ids = (v: Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

  const planEvidence = ids(sum["plan_evidence"]).map((id) => evidence.get(id)).filter((e): e is EvidenceRow => !!e);
  const approvedBy = planEvidence.filter((e) => e.method === "human.approve").map((e) => {
    const d = isObj(e.detail) ? e.detail : {};
    return { criterion: `${e.contract}.${e.criterion}`, by: typeof d["by"] === "string" ? d["by"] : null, role: typeof d["role"] === "string" ? d["role"] : null };
  });

  // The evidence matrix: each member's evidence, one row per criterion, a cell per component.
  const rows = new Map<string, ChangesetView["matrix"][number]>();
  for (const m of members) {
    const c = String(m["component"]);
    for (const e of ids(m["evidence"]).map((id) => evidence.get(id)).filter((e): e is EvidenceRow => !!e)) {
      const key = `${e.contract}.${e.criterion}`;
      const row = rows.get(key) ?? { contract: e.contract, criterion: e.criterion, method: e.method, cells: {} };
      row.cells[c] = { result: cellFor(e, c, providerOf), evidence_id: e.evidence_id };
      rows.set(key, row);
    }
  }
  for (const row of rows.values()) for (const c of names) row.cells[c] ??= { result: "unknown", evidence_id: null };

  const components: ChangesetView["components"] = [];
  for (const m of members) {
    const c = String(m["component"]);
    const action = typeof m["operation"] === "string" ? actions.get(m["operation"]) : undefined;
    const files = action && isObj(action.artifacts ?? null) ? Object.keys(action.artifacts as Obj).sort() : [];
    const mine = ids(m["evidence"]).map((id) => evidence.get(id)).filter((e): e is EvidenceRow => !!e);
    const measured = new Map<string, string>();
    const unplanned: string[] = [];
    for (const e of mine) {
      const d = isObj(e.detail) ? e.detail : {};
      if (e.method === "test.contract" && Array.isArray(d["interfaces"])) {
        for (const r of d["interfaces"].filter(isObj) as Obj[]) if (r["provider"] === c && typeof r["measured"] === "string") measured.set(String(r["interface"]), r["measured"]);
      }
      if (e.method === "test.planned" && Array.isArray(d["unplanned"])) {
        for (const u of d["unplanned"].filter(isObj) as Obj[]) if (u["component"] === c || (typeof u["interface"] === "string" && providerOf(u["interface"]) === c)) unplanned.push(String(u["detail"] ?? u["problem"]));
      }
    }
    if (planComponents && !planComponents.includes(c)) unplanned.push(`the plan's components do not include ${c}`);
    const declared = (iface: string): string | null => (typeof setChanges[iface] === "string" ? String(setChanges[iface]) : typeof planChanges[iface] === "string" ? String(planChanges[iface]) : null);
    const ifaces = new Set([...Object.keys(setChanges), ...Object.keys(planChanges)].filter((i) => providerOf(i) === c));
    for (const i of measured.keys()) ifaces.add(i);
    const comp = defs[c]?.kind === "component" ? (defs[c] as ComponentDef) : undefined;
    components.push({
      component: c,
      effect: String(m["effect"]),
      approver: String(m["approver"] ?? ""),
      action: s.state === "simulated" ? "simulated" : (action?.state ?? "not prepared"),
      files,
      governance: governanceFiles(files, comp?.governance ?? []),
      owner: comp?.owner ?? "owner",
      interfaces: [...ifaces].sort().map((i) => ({ interface: i, declared: declared(i), measured: measured.get(i) ?? null })),
      unplanned,
    });
  }

  // The order and why: who provides what a later member consumes (doc 9 §3.3).
  const order = names.map((c, i) => {
    const d = defs[c];
    const because: string[] = [];
    for (const p of names.slice(0, i)) {
      const pd = defs[p];
      if (d?.kind !== "component" || pd?.kind !== "component") continue;
      for (const iface of d.consumes ?? []) {
        if (!pd.provides?.includes(iface)) continue;
        const kind = typeof setChanges[iface] === "string" ? ` and this set changes it (${String(setChanges[iface])})` : "";
        because.push(`after ${p}: ${c} consumes ${iface}, which ${p} provides${kind}`);
      }
    }
    if (!because.length) because.push(i === 0 ? "first: it consumes nothing another member provides" : "nothing it consumes comes from an earlier member; the program chose its place");
    return { component: c, because };
  });

  // Authority: a member that lands a Mandate program, a system model or the lock changes what Mandate allows.
  const authority: ChangesetView["authority"] = [];
  for (const m of members) {
    const action = typeof m["operation"] === "string" ? actions.get(m["operation"]) : undefined;
    const frozen = action && isObj(action.artifacts ?? null) ? (action.artifacts as Obj) : {};
    for (const [file, a] of Object.entries(frozen).sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (file.endsWith("mandate.lock.json")) {
        authority.push({ component: String(m["component"]), file, changes: ["the lock: models, prices or module pins"] });
        continue;
      }
      if (!file.endsWith(".mdt") || !isObj(a)) continue;
      const text = new TextDecoder().decode((await rt.artifact(runId, String(a["ref"]))).bytes);
      const r = check(text, "mdt", { modules });
      if (!r.program) {
        authority.push({ component: String(m["component"]), file, changes: [`does not check: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).join(", ")}`] });
        continue;
      }
      const name = r.program.module;
      const before = name ? (modules[name] ?? (program.module === name ? program : undefined)) : undefined;
      if (!before) {
        authority.push({ component: String(m["component"]), file, changes: [`a new Mandate module${name ? ` ${name}` : ""}: this run's package has no earlier version of it`] });
        continue;
      }
      const diff = semanticDiff(before, r.program);
      authority.push({ component: String(m["component"]), file, changes: diff.governance.length ? diff.governance.map((g) => g.text) : [`${name}: no governance change (${diff.behavior.length} behavior changes)`] });
    }
  }

  const mode = s.state === "simulated" ? "design" : s.state === "would_apply" ? "read_only" : "live";
  const reality =
    mode === "design"
      ? "Design run: every member simulated; nothing was prepared, authorized or sent."
      : mode === "read_only"
        ? "Read-only run: every member prepared and frozen; nothing was authorized or committed."
        : `Live run: ${components.map((c) => `${c.component} ${c.action}`).join(", ")}.`;
  return {
    node: s.command_id,
    set_digest: s.set_digest,
    state: s.state,
    reality,
    plan: { value: sum["plan"] ?? null, digest: String(sum["plan_digest"] ?? ""), evidence: ids(sum["plan_evidence"]), approved_by: approvedBy },
    components,
    matrix: [...rows.values()].sort((a, b) => (`${a.contract}.${a.criterion}` < `${b.contract}.${b.criterion}` ? -1 : 1)),
    order,
    authority,
  };
}

/** One component's result in a check: its own part where the check reports per component, else the check's. */
function cellFor(e: EvidenceRow, c: string, providerOf: (iface: string) => string | undefined): Cellval {
  const d = isObj(e.detail) ? e.detail : {};
  const list = (k: string): Obj[] => (Array.isArray(d[k]) ? (d[k] as Value[]).filter(isObj) as Obj[] : []);
  if (e.method === "test.suite_each" && Array.isArray(d["runs"])) {
    const r = list("runs").find((x) => x["component"] === c);
    return r ? (r["passed"] === true ? "passed" : "failed") : "unknown";
  }
  if (e.method === "test.contract" && list("interfaces").length) {
    const rs = list("interfaces").filter((x) => x["provider"] === c);
    return rs.every((x) => !x["problem"] && !x["error"]) ? "passed" : "failed";
  }
  if (e.method === "test.planned" && Array.isArray(d["components"])) {
    return list("unplanned").some((u) => u["component"] === c || (typeof u["interface"] === "string" && providerOf(u["interface"]) === c)) ? "failed" : "passed";
  }
  return e.passed ? "passed" : "failed";
}

async function lastEvent(rt: Runtime, runId: string): Promise<number> {
  const [r] = await rt.db.query<{ n: unknown }>("select coalesce(max(seq), 0) as n from events where run_id = $1", [runId]);
  return Number(r?.n ?? 0);
}

/** Whether a view made at `asOf` still shows the run as it is (G10). */
export async function freshness(rt: Runtime, runId: string, asOf: AsOf): Promise<Freshness> {
  const run = await rt.getRun(runId);
  const now = { revision: run.revision, event: await lastEvent(rt, runId) };
  const behind = now.event - asOf.event;
  return { as_of: asOf, now, behind_events: behind, stale: behind > 0 || now.revision !== asOf.revision };
}

const untrusted = (v: Value): Cell => ({ text: typeof v === "string" ? v : canonical(v), untrusted: true });
const mono = (s: string): Cell => ({ text: s, mono: true });

function money(dim: string, n: number): string {
  return dim.startsWith("spend:") ? `${(n / 1_000_000).toFixed(4)} ${dim.slice(6)}` : String(n);
}

function statusBlocks(v: RunView): Block[] {
  const out: Block[] = [{ h: "Status" }, { p: `Run ${v.run.id} of ${v.run.workflow} is ${v.run.state} at revision ${v.as_of.revision} (event ${v.as_of.event}).` }, ...waitBlocks(v)];
  if (v.run.state === "attention_required") out.push({ p: "Needs attention:" }, { code: JSON.stringify(v.attention, null, 2), untrusted: true });
  if (v.run.state === "failed") out.push({ p: "Failed with:" }, { code: JSON.stringify(v.error, null, 2), untrusted: true });
  if (v.run.state === "succeeded") out.push({ p: "Result:" }, { code: JSON.stringify(v.result, null, 2), untrusted: true });
  return out;
}

/** What the run waits for, with the command that answers it at this revision. */
function waitBlocks(v: Pick<RunView, "run" | "as_of" | "waiting">): Block[] {
  const out: Block[] = [];
  const w = isObj(v.waiting) ? v.waiting : undefined;
  if (v.run.state === "waiting" && w) {
    const req = isObj(w["request"] ?? null) ? (w["request"] as Obj) : {};
    if (w["kind"] === "decision" && "criterion" in req) {
      out.push({ p: `Waiting for ${String(req["role"] ?? "a person")} to approve ${String(req["contract"])}.${String(req["criterion"])}. The decision applies only to this subject:` });
      out.push({ table: { head: ["Subject digest", "Deadline"], rows: [[mono(String(req["subject_digest"])), typeof req["deadline"] === "number" ? new Date(req["deadline"]).toISOString() : "—"]] } });
      out.push({ code: JSON.stringify(req["subject"] ?? null, null, 2), untrusted: true });
      out.push({ note: `Approve or decline at revision ${v.as_of.revision}: mandate approve ${v.run.id} --revision ${v.as_of.revision} --by <you>. A decision on an older revision is refused.` });
    } else if (w["kind"] === "decision") {
      out.push({ p: `Waiting for ${String(req["role"] ?? "a person")} to authorize ${String(req["effect"] ?? "an action")}, exactly these parameters:` });
      out.push({ table: { head: ["Action digest"], rows: [[mono(String(req["action_digest"]))]] } });
      out.push({ code: JSON.stringify(req["params"] ?? null, null, 2), untrusted: true });
    } else if (w["kind"] === "amendment") {
      // The owner's decision is for the hash of the package with the new envelope. The reason is the lead's own
      // text, and a model wrote it (G09).
      out.push({ p: `Waiting for ${String(req["role"] ?? "the owner")} to decide an amendment of ${String(req["workflow"])}'s envelope, which ${String(req["lead"])} asked for. The decision applies only to this package:` });
      out.push({ table: { head: ["Package now", "Package asked for", "Deadline"], rows: [[mono(String(req["from"])), mono(String(req["package"])), typeof req["deadline"] === "number" ? new Date(req["deadline"]).toISOString() : "—"]] } });
      const changes = (Array.isArray(req["changes"]) ? req["changes"] : []).flatMap((c) => (isObj(c) ? [String(c["text"])] : []));
      if (changes.length) out.push({ p: "What it changes in the envelope:" }, { list: changes });
      out.push({ p: "The lead's reason:" }, { code: String(req["reason"] ?? ""), untrusted: true });
      out.push({ note: `Approve or decline at revision ${v.as_of.revision}: mandate amend ${v.run.id} --revision ${v.as_of.revision} --key <your key file> approve. A decision on an older revision is refused.` });
    } else if (w["kind"] === "timer") {
      out.push({ p: `Waiting until ${typeof req["until"] === "number" ? new Date(req["until"]).toISOString() : "?"} (${String(req["reason"] ?? "a timer")}); the scheduler resumes it then.` });
    } else {
      out.push({ p: w["kind"] === "budget_exceeded" ? "Waiting for a person after the budget ran out. The question, as the program asks it:" : "Waiting for an answer. The question, as the program asks it:" });
      out.push({ code: show((req["question"] ?? req["escalation"] ?? null) as Value), untrusted: true });
    }
  }
  return out;
}

function evidenceBlocks(v: RunView): Block[] {
  if (!v.evidence.length) return [{ h: "Evidence" }, { p: "No criterion has been checked yet." }];
  return [
    { h: "Evidence" },
    {
      table: {
        head: ["Criterion", "Method", "Result", "Produced by", "Signature", "Outputs", "Evidence"],
        rows: v.evidence.map((e) => [
          `${e.contract}.${e.criterion}`,
          e.method,
          e.passed ? "met" : "not met",
          untrusted(e.producer),
          e.signature_valid ? "valid" : "INVALID",
          Array.isArray(e.artifacts) && e.artifacts.length ? mono(e.artifacts.map((a) => (isObj(a) ? `${String(a["kind"])}${a["phase"] ? `/${String(a["phase"])}` : ""} ${String(a["ref"])}` : "")).join("; ")) : "—",
          mono(e.evidence_id),
        ]),
      },
    },
  ];
}

function costBlocks(v: Pick<RunView, "budget">): Block[] {
  return [
    { h: "Cost" },
    { table: { head: ["Dimension", "Limit", "Settled", "Reserved", "Available"], rows: v.budget.dimensions.map((d) => [d.dimension, money(d.dimension, d.limit), money(d.dimension, d.settled), money(d.dimension, d.reserved), money(d.dimension, d.available)]) } },
    {
      table: {
        head: ["Command", "Label", "State", "Reserved", "Cost"],
        rows: v.budget.commands.map((c) => [mono(c.command), c.label ?? c.kind, c.state, Object.entries(c.reserved).map(([d, n]) => `${d.startsWith("spend:") ? money(d, n) : `${n} ${d}`}${c.open.includes(d) ? " (open)" : ""}`).join(", ") || "—", c.cost === null ? "—" : c.cost === "unknown" ? "unknown" : canonical(c.cost as unknown as Value)]),
      },
    },
  ];
}

const GOVERNANCE_LABEL: Record<string, string> = {
  ci: "CI",
  lockfile: "lockfile",
  agent_settings: "agent settings",
  mandate: "Mandate lock or configuration",
  code_owners: "code owners",
  component: "the component's own",
};

const RESULT: Record<Cellval, string> = { passed: "passed", failed: "FAILED", unknown: "unknown" };

function changesetBlocks(v: RunView): Block[] {
  const out: Block[] = [];
  for (const s of v.changesets) {
    const names = s.components.map((c) => c.component);
    const approved = s.plan.approved_by.map((a) => `${a.by ?? "?"}${a.role ? ` (${a.role})` : ""}`).join(", ");
    out.push({ h: `Change set at ${s.node}` });
    out.push({ p: `${s.reality} Set digest ${s.set_digest}, state ${s.state}.` });
    out.push({ p: `The plan (digest ${s.plan.digest})${approved ? `, approved by ${approved}` : ", with no person's approval in its evidence"}:` });
    out.push({ code: JSON.stringify(s.plan.value, null, 2), untrusted: true });
    out.push({
      table: {
        head: ["Component", "Files", "Interfaces: declared → measured", "Plan", "Action"],
        rows: s.components.map((c) => [
          c.component,
          c.files.length ? mono(`${c.files.length}: ${c.files.join(", ")}`) : "—",
          c.interfaces.length ? c.interfaces.map((i) => `${i.interface}: ${i.declared ?? "none"} → ${i.measured ?? "not measured"}${i.measured && !covers((i.declared ?? "none") as ChangeKind, i.measured as ChangeKind) ? " (understated)" : ""}`).join("; ") : "—",
          c.unplanned.length ? `UNPLANNED: ${c.unplanned.join("; ")}` : "in the plan",
          c.action,
        ]),
      },
    });
    if (s.matrix.length) {
      out.push({ table: { head: ["Criterion", "Method", ...names], rows: s.matrix.map((r) => [`${r.contract}.${r.criterion}`, r.method, ...names.map((n) => (r.cells[n]!.evidence_id ? mono(`${RESULT[r.cells[n]!.result]} ${r.cells[n]!.evidence_id!.slice(0, 19)}`) : RESULT[r.cells[n]!.result]))]) } });
    } else out.push({ p: "No member carries evidence." });
    out.push({ table: { head: ["#", "Component", "Why here"], rows: s.order.map((o, i) => [String(i + 1), o.component, o.because.join("; ")]) } });
    // K70: files that change what the next run may do are a class of their own, with who must approve them.
    const gov = s.components.flatMap((c) => c.governance.map((g) => [c.component, mono(g.file), GOVERNANCE_LABEL[g.kind] ?? g.kind, c.approver === c.owner ? `${c.owner} (the owner; also approves the member)` : `${c.owner} (the owner), before ${c.approver}`]));
    if (gov.length) out.push({ p: "Governance-class files: they change what the next run may do, so the component's owner approves them whatever else authorizes the member." }, { table: { head: ["Component", "File", "Class", "Needs"], rows: gov } });
    else out.push({ p: "No member carries a governance-class file (CI workflows, lockfiles, agent settings, the Mandate lock, CODEOWNERS, a component's own)." });
    if (s.authority.length) out.push({ table: { head: ["Component", "File", "What it changes in authority"], rows: s.authority.map((a) => [a.component, mono(a.file), a.changes.join("; ")]) } });
    else out.push({ p: "No member changes a Mandate program, the system model or the lock: the set changes no capability, budget or environment tier." });
  }
  return out;
}

/** Amounts by dimension as text, in the order of the dimensions' names. */
const amounts = (r: Record<string, number>): string =>
  Object.keys(r)
    .sort()
    .map((d) => `${d}: ${money(d, r[d]!)}`)
    .join(", ") || "—";

function decisionBlocks(v: Pick<RunView, "decisions">): Block[] {
  if (!v.decisions.length) return [];
  return [
    { h: "Decisions" },
    {
      table: {
        head: ["Decision", "By", "Role", "Signature", "About", "Record"],
        rows: v.decisions.map((d) => [
          d.kind,
          // A member's name is the lock's once the signature holds. Any other name is what somebody typed.
          d.by === null ? "—" : d.signature === "valid" ? d.by : untrusted(d.by),
          d.role ?? "—",
          d.signature === "invalid" ? `INVALID: ${d.problem ?? "it does not verify"}` : d.signature,
          d.about === null ? "—" : mono(d.about),
          d.decision_id === null ? "—" : mono(d.decision_id),
        ]),
      },
    },
  ];
}

function envelopeBlocks(v: Pick<RunView, "envelope">): Block[] {
  const e = v.envelope;
  if (!e) return [];
  const until = e.deadline === null ? "It sets no time, so the run has no deadline" : `The run's deadline is ${new Date(e.deadline).toISOString()}, its start plus the envelope's time`;
  const out: Block[] = [{ h: "Envelope" }, { p: `${e.workflow} runs under an envelope that ${e.owner ?? "nobody"} owns. ${until}. What is left of it:` }];
  out.push({
    table: {
      head: ["Dimension", "Envelope gives", "Run's limit", "Settled", "Reserved", "Left"],
      rows: e.remainder.map((d) => [d.dimension, d.envelope === null ? "no limit" : money(d.dimension, d.envelope), money(d.dimension, d.limit), money(d.dimension, d.settled), money(d.dimension, d.reserved), money(d.dimension, d.left)]),
    },
  });
  if (e.amendments.length) {
    out.push({ p: "The envelope was amended. Each amendment moved the run to another package:" });
    out.push({
      table: {
        head: ["#", "Package before", "Package after", "Approved by", "Limits raised"],
        rows: e.amendments.map((a, i) => [String(i + 1), mono(a.from), mono(a.to), `${a.by ?? "?"}${a.role ? ` (${a.role})` : ""}`, Object.entries(a.limits).map(([dim, l]) => `${dim}: ${money(dim, l.from)} → ${money(dim, l.to)}`).join(", ") || "none"]),
      },
    });
  } else out.push({ p: "The envelope has not been amended." });
  return out;
}

function planBlocks(v: RunView): Block[] {
  const out: Block[] = [];
  for (const p of v.plans) {
    const admitted = p.submissions.filter((s) => s.outcome === "admitted");
    out.push({ h: `Plan at ${p.node}` });
    out.push({ p: `${p.lead ?? "The lead"} submitted ${p.submissions.length} sub-program${p.submissions.length === 1 ? "" : "s"}: ${admitted.length} admitted, ${p.submissions.filter((s) => s.outcome === "refused").length} refused.` });
    if (p.submissions.length) {
      out.push({
        table: {
          head: ["Number", "Outcome", "Program", "Reserved of the envelope", "Governance changes in it", "Runs as", "State"],
          rows: p.submissions.map((s) => [
            String(s.number),
            s.outcome === "refused" ? `refused: ${s.codes.join(", ") || "no code"}` : s.outcome,
            s.hash === null ? "—" : mono(s.hash),
            s.outcome === "admitted" ? amounts(s.reservation) : "—",
            s.governance.join(", ") || "—",
            s.command === null ? "—" : mono(s.command),
            s.state ?? "—",
          ]),
        },
      });
    }
    if (p.submissions.some((s) => s.outcome === "refused")) out.push({ p: "A refused submission takes no number: the next one is checked under the same number." });
    for (const s of admitted) {
      if (s.text !== null) out.push({ p: `Sub-program ${s.number}, as the lead wrote it:` }, { code: s.text, untrusted: true });
      else if (s.stored === "mismatch") out.push({ p: `What is stored as sub-program ${s.number} does not hash to what was admitted, and is not shown.` });
      else out.push({ p: `Sub-program ${s.number} is not kept any more; its hash names what ran.` });
    }
    if (p.amendments.length) {
      out.push({ p: "Amendments of the envelope it asked for:" });
      out.push({ table: { head: ["Asked of package", "Asked for package", "Outcome"], rows: p.amendments.map((a) => [mono(a.from), mono(a.package), `${a.outcome}${a.by ? ` by ${a.by}` : ""}`]) } });
    }
  }
  return out;
}

function mapBlocks(v: Pick<RunView, "maps">): Block[] {
  const out: Block[] = [];
  for (const m of v.maps) {
    out.push({ h: `Map at ${m.node}` });
    const how = m.state === "running" ? "It has not ended" : m.state === "failed" ? `It failed with ${m.failed}, and started no further item` : "It has ended";
    out.push({ p: `${m.items} item${m.items === 1 ? "" : "s"}, at most ${m.par} at once. ${how}.` });
    if (m.items) out.push({ table: { head: ["Item", "Outcome"], rows: m.outcomes.map((o, i) => [String(i), o]) } });
  }
  return out;
}

function actionBlocks(v: RunView): Block[] {
  if (!v.actions.length) return [{ h: "External actions" }, { p: "None." }];
  return [{ h: "External actions" }, { table: { head: ["Effect", "State", "Operation", "Receipt"], rows: v.actions.map((a) => [a.effect, a.state, mono(a.operation), a.receipt === null ? "—" : untrusted(a.receipt)]) } }];
}

/** A run's views as one document: its status, evidence, cost and actions, and its program's views, under one hash. */
export function runDoc(v: RunView, program: Program): Doc {
  return {
    title: `Run ${v.run.id}: ${v.run.workflow}`,
    meta: metaOf(v, `${VIEW_FORMAT}, generated from the program and the run's journal`),
    blocks: [...runBlocks(v), ...architectureBlocks(architecture(program)), ...authorityBlocks(authority(program))],
  };
}

/** The sections of a run's view, in the order a person reads them. */
function runBlocks(v: RunView): Block[] {
  return [...statusBlocks(v), ...envelopeBlocks(v), ...planBlocks(v), ...mapBlocks(v), ...changesetBlocks(v), ...evidenceBlocks(v), ...decisionBlocks(v), ...costBlocks(v), ...actionBlocks(v)];
}

/** What a run's document shows, under which hashes, as of when. */
function metaOf(v: Pick<RunView, "program" | "package" | "run" | "manifest" | "modules" | "as_of">, what: string): Array<[string, string]> {
  return [
    ["Program", v.program.hash],
    ["Package", v.package],
    ["Run", `${v.run.id} (tenant ${v.run.tenant})`],
    ...(v.manifest.hash ? [["Started from", v.manifest.hash] as [string, string]] : []),
    ["Mode", v.manifest.mode === "live" ? "live" : v.manifest.mode === "read_only" ? "read_only: real reads, effects prepared and never committed" : "design: sample reads, effects simulated"],
    ...v.manifest.components.map((c) => [`Component ${c.name}`, `${c.repo} @ ${c.base}`] as [string, string]),
    ...v.modules.map((m) => [`Module ${m.module}`, m.hash] as [string, string]),
    ["As of", `revision ${v.as_of.revision}, event ${v.as_of.event}`],
    ["View", what],
  ];
}

/**
 * A role's view as one document: the run's state, what it waits for when that is asked of the role, how it ended and
 * what stopped it, the decisions asked of the role, the envelope, the maps and the cost, and the program's views.
 */
export function roleDoc(v: RoleView, program: Program): Doc {
  const status: Block[] = [{ h: "Status" }, { p: `Run ${v.run.id} of ${v.run.workflow} is ${v.run.state} at revision ${v.as_of.revision} (event ${v.as_of.event}).` }];
  if (v.run.state === "waiting") status.push(...(v.waiting === null ? [{ p: `It waits for nothing asked of ${v.role}.` }] : waitBlocks(v)));
  return {
    title: `Run ${v.run.id}: ${v.run.workflow}, as ${v.role} sees it`,
    meta: metaOf(v, `${VIEW_FORMAT}, the view of the role ${v.role}: what was asked of it, how the run ended and what stopped it, and its progress`),
    blocks: [
      ...status,
      ...exceptionBlocks(v.exceptions),
      ...envelopeBlocks(v),
      ...mapBlocks(v),
      ...decisionBlocks(v),
      ...costBlocks(v),
      ...architectureBlocks(architecture(program)),
      ...authorityBlocks(authority(program)),
    ],
  };
}

/** The audit view as one document: the run's view whole, with its exceptions, halts, steps, trace, events and chain. */
export function auditDoc(v: AuditView, program: Program): Doc {
  return {
    title: `Run ${v.run.id}: ${v.run.workflow}, audit`,
    meta: metaOf(v, `${VIEW_FORMAT}, the audit view: everything the run's journal holds, its events, and its chain as verified when the view was made`),
    blocks: [
      ...chainBlocks(v.chain),
      ...runBlocks({ ...v, kind: "run" }),
      { h: "Input" },
      { code: JSON.stringify(v.input, null, 2), untrusted: true },
      ...exceptionBlocks(v.exceptions),
      ...haltBlocks(v.halts),
      ...commandBlocks("Steps", v.steps),
      ...commandBlocks("Trace", v.trace),
      ...eventBlocks(v.events),
      ...architectureBlocks(architecture(program)),
      ...authorityBlocks(authority(program)),
    ],
  };
}

function exceptionBlocks(x: Exceptions): Block[] {
  const out: Block[] = [{ h: "Exceptions" }];
  if (x.fault !== null) out.push({ p: `The fault: ${x.fault}.` });
  if (x.attention) {
    const a = x.attention;
    const why = [
      ...(a.violation !== null ? [`the invariant violation ${a.violation}`] : []),
      ...(a.halted !== null ? [`the halt ${a.halted}, which left an action open`] : []),
      ...(a.reason !== null ? [`${a.reason}${a.command !== null ? ` at ${a.command}` : ""}`] : []),
      ...(a.changeset_partial ? ["a change set stopped with some of its members applied"] : []),
    ];
    out.push({ p: `It needs a person: ${why.join("; ") || "the reason has no code"}.` });
    if (a.actions.length) out.push({ table: { head: ["Effect", "State", "Operation"], rows: a.actions.map((o) => [o.effect ?? "—", o.state ?? "—", o.operation === null ? "—" : mono(o.operation)]) } });
  }
  if (x.violations.length) {
    const detail = x.violations.some((e) => "detail" in e);
    out.push({
      table: {
        head: ["Seq", "Kind", "Agent", "Step", "Count", ...(detail ? ["Detail"] : [])],
        rows: x.violations.map((e) => [String(e.seq), e.kind ?? "—", e.agent ?? "—", e.step === null ? "—" : mono(e.step), String(e.count), ...(detail ? [untrusted(e.detail ?? null)] : [])]),
      },
    });
  }
  if (x.halt) out.push({ p: `The run was halted by ${x.halt.halt}${x.halt.by !== null ? `, which ${x.halt.by} made` : ""}, at ${new Date(x.halt.at).toISOString()}; its lease was revoked${x.halt.fence !== null ? ` at fence ${x.halt.fence}` : ""}.` }, ...(x.halt.reason !== null ? [{ p: "The halt's reason:" }, { code: x.halt.reason, untrusted: true }] : []));
  if (out.length === 1) out.push({ p: "No fault, violation or halt." });
  return out;
}

const STATUS: Record<JournalReport["status"], string> = {
  verified: "the chain holds and every state change is anchored",
  broken: "the chain or its anchors do not hold",
  unchained: "the run began before its journal was chained: nothing can be verified either way",
  unreadable: "the export could not be read, so nothing is said about the journal",
};

function chainBlocks(r: JournalReport): Block[] {
  const out: Block[] = [{ h: "Journal" }, { p: `${r.status}: ${STATUS[r.status]}. ${r.events === 1 ? "1 event" : `${r.events} events`}, verified when this view was made.` }];
  if (r.status === "verified" && r.anchored_through !== null) out.push({ p: `Signed through event ${r.anchored_through} by ${r.signed_by.join(", ")}; ${r.unanchored === 1 ? "1 event" : `${r.unanchored} events`} after it covered by no signature.` });
  if (r.findings.length) out.push({ table: { head: ["Finding", "Seq"], rows: r.findings.map((f) => [f.code, f.seq === undefined ? "—" : String(f.seq)]) } });
  return out;
}

function haltBlocks(halts: HaltRow[]): Block[] {
  if (!halts.length) return [{ h: "Halts" }, { p: "No halt covers the run's tenant." }];
  const at = (n: number | null): string => (n === null ? "—" : new Date(n).toISOString());
  return [
    { h: "Halts" },
    {
      table: {
        head: ["Halt", "Scope", "Halted by", "Halted at", "Reason", "Lifted by", "Lifted at"],
        rows: halts.map((h) => [mono(h.halt_id), h.tenant === null ? "every tenant" : `tenant ${h.tenant}`, h.halted_by === null ? "—" : untrusted(h.halted_by), at(h.halted_at), h.reason === null ? "—" : untrusted(h.reason), h.lifted_by === null ? (h.lifted_at === null ? "in force" : "—") : untrusted(h.lifted_by), at(h.lifted_at)]),
      },
    },
  ];
}

function commandBlocks(title: string, commands: CommandView[]): Block[] {
  if (!commands.length) return [{ h: title }, { p: "None." }];
  const out: Block[] = [{ h: title }, { table: { head: ["Command", "Kind", "Label", "State", "Request digest"], rows: commands.map((c) => [mono(c.command), c.kind, c.label ?? "—", c.state, mono(c.request_digest)]) } }];
  for (const c of commands) {
    if (c.purged) out.push({ p: `${c.command}: purged.` });
    else if (c.error !== null) out.push({ p: `${c.command} failed with:` }, { code: JSON.stringify(c.error, null, 2), untrusted: true });
    else if (c.result !== null) out.push({ p: `${c.command}:` }, { code: JSON.stringify(c.result, null, 2), untrusted: true });
  }
  return out;
}

function eventBlocks(events: AuditView["events"]): Block[] {
  return [
    { h: "Events" },
    { table: { head: ["Seq", "Type", "Class", "Time", "Hash", "Data"], rows: events.map((e) => [String(e.seq), e.type, e.class, new Date(e.at).toISOString(), e.hash === null ? "—" : mono(e.hash), untrusted(e.data)]) } },
  ];
}

/** One external action of a shadow comparison: the same node in two runs. */
export interface ShadowRow {
  node: string;
  effect: string;
  /** `same`: the same action would be taken; `differs`: other parameters or files; `only_a` / `only_b`. */
  state: "same" | "differs" | "only_a" | "only_b";
  a?: { state: string; fingerprint: string };
  b?: { state: string; fingerprint: string };
}

/**
 * The shadow comparison (Doc 4 §8.3, V19; design doc 9 §5.2): what two runs
 * of the same workflow prepared, node by node, compared by what the action
 * would do (effect, parameters, frozen files, business key), not by run.
 * A `read_only` run commits nothing; the comparison says what it would have
 * changed compared with the other.
 */
export async function shadowDiff(rt: Runtime, a: string, b: string): Promise<{ a: { run: string; mode: string; committed: number }; b: { run: string; mode: string; committed: number }; rows: ShadowRow[] }> {
  const side = async (runId: string) => {
    const run = await rt.getRun(runId);
    const actions = await rt.journal.actions(runId);
    const byNode = new Map(actions.map((x) => [x.command_id, x]));
    const committed = actions.filter((x) => ["dispatched", "confirmed", "unknown_outcome", "rejected"].includes(x.state)).length;
    return { run: runId, mode: isObj(run.manifest) && typeof run.manifest["mode"] === "string" ? run.manifest["mode"] : "live", committed, byNode };
  };
  const fp = (x: { effect: string; params: Value; artifacts: Value }): string => digest("request", { effect: x.effect, params: x.params, artifacts: isObj(x.artifacts ?? null) ? Object.fromEntries(Object.entries(x.artifacts as Obj).map(([p, f]) => [p, isObj(f) ? f["digest"] ?? null : null])) : null });
  const A = await side(a);
  const B = await side(b);
  const rows: ShadowRow[] = [];
  for (const node of [...new Set([...A.byNode.keys(), ...B.byNode.keys()])].sort()) {
    const x = A.byNode.get(node);
    const y = B.byNode.get(node);
    const fx = x ? fp(x) : undefined;
    const fy = y ? fp(y) : undefined;
    rows.push({
      node,
      effect: (x ?? y)!.effect,
      state: !x ? "only_b" : !y ? "only_a" : fx === fy ? "same" : "differs",
      ...(x ? { a: { state: x.state, fingerprint: fx! } } : {}),
      ...(y ? { b: { state: y.state, fingerprint: fy! } } : {}),
    });
  }
  return { a: { run: A.run, mode: A.mode, committed: A.committed }, b: { run: B.run, mode: B.mode, committed: B.committed }, rows };
}
