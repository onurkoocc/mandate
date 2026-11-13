// The classes of what a run's projections carry (spec/boundary.md "Views by role and the audit view"; INV-17).
//
//   S0  a decision: what was asked of whom, and how it was decided
//   S1  an outcome or an exception: how the run ended, a fault, a violation, a halt
//   S2  progress: steps begun and ended, budget left
//   S3  a step's detail: its request and result
//   S4  a trace: an agent loop's turns, tool calls and outputs
//
// Each event is in one class by its type, each part of a run's view by its section, and each command by its kind,
// and by nothing else: no projection reads an event's data, a section's content or a command's result to decide
// what may be shown. A role's view shows S0 asked of that role, S1 and S2; the audit view shows S0 to S4. The
// OpenTelemetry projection reads the same table. Whatever the table does not name is S4, shown to no role.

export type ViewClass = "S0" | "S1" | "S2" | "S3" | "S4";

/** The classes, from the least restricted to the most. */
export const CLASSES: readonly ViewClass[] = ["S0", "S1", "S2", "S3", "S4"];

/** What each class holds. */
export const CLASS_HOLDS: Readonly<Record<ViewClass, string>> = {
  S0: "a decision: what was asked of whom, and how it was decided",
  S1: "an outcome or an exception: how the run ended, a fault, a violation, a halt",
  S2: "progress: steps begun and ended, budget left",
  S3: "a step's detail: its request and result",
  S4: "a trace: an agent loop's turns, tool calls and outputs",
};

/** The class of every event type the runtime writes. A test reads the runtime's sources and fails on one missing here. */
export const EVENT_CLASSES: Readonly<Record<string, ViewClass>> = {
  // S0: what a person was asked, and what they decided.
  wait_opened: "S0",
  wait_expired: "S0",
  decision_received: "S0",
  input_received: "S0",
  decision_refused: "S0",
  criterion_approved: "S0",
  criterion_denied: "S0",
  governance_approved: "S0",
  governance_denied: "S0",
  action_authorized: "S0",
  envelope_approved: "S0",
  amendment_requested: "S0",
  package_amended: "S0",
  limits_raised: "S0",
  reconcile_requested: "S0",
  // S1: how the run ended, and what stopped or bent it.
  run_succeeded: "S1",
  run_failed: "S1",
  run_cancelled: "S1",
  run_cancelling: "S1",
  run_attention_required: "S1",
  cancel_requested: "S1",
  lease_revoked: "S1",
  violation: "S1",
  budget_exceeded: "S1",
  guarantee_lowered: "S1",
  // S2: the run and its steps begun and ended, and what they cost.
  run_accepted: "S2",
  run_running: "S2",
  run_waiting: "S2",
  lease_acquired: "S2",
  command_dispatched: "S2",
  command_completed: "S2",
  command_throttled: "S2",
  charge_pending: "S2",
  charge_settled: "S2",
  map_started: "S2",
  map_ended: "S2",
  // S3: an external action and a change set, with what they carry.
  action_prepared: "S3",
  action_committed: "S3",
  action_confirmed: "S3",
  action_rejected: "S3",
  action_unknown_outcome: "S3",
  action_cancelled: "S3",
  action_would_apply: "S3",
  changeset_prepared: "S3",
  changeset_would_apply: "S3",
  changeset_simulated: "S3",
  changeset_committed: "S3",
  changeset_partial: "S3",
  changeset_failed: "S3",
  // S4: what a lead's tool calls submitted, and an agent's sandbox.
  program_submitted: "S4",
  program_refused: "S4",
  program_admitted: "S4",
  sandbox_stopped: "S4",
};

/** An event's class, by its type alone. A type the table does not name is S4. */
export function eventClass(type: string): ViewClass {
  return Object.hasOwn(EVENT_CLASSES, type) ? EVENT_CLASSES[type]! : "S4";
}

/**
 * The class of each section of a run's views (`runView`), and of the parts of a section that are in another class
 * than the section. A section is in the most restricted class of what it can hold: the run's `result`, a fault's
 * arguments and a wait's `attention` can each hold a step's result, so each is S3 whole, and a role's view shows
 * what of them it may in sections of its own (`exceptions`).
 */
export const SECTION_CLASSES: Readonly<Record<string, ViewClass>> = {
  // What names the run and the view: the program, the package, what it started from, and how far the view reaches.
  format: "S2",
  kind: "S2",
  role: "S2",
  program: "S2",
  package: "S2",
  manifest: "S2",
  modules: "S2",
  as_of: "S2",
  // The run's state.
  run: "S1",
  // The wait the run is in, with the request it asks: shown to the role it asks.
  waiting: "S0",
  // Each decision a person made, shown to the role it was asked of.
  decisions: "S0",
  // How the run ended and what stopped it, by the fields named: the fault's tag; of `attention`, the violation's code,
  // the halt, the reason's code and the open actions' effects and states; each violation but its detail; the halt.
  exceptions: "S1",
  "exceptions.violations.detail": "S4",
  // The budget's dimensions; its rows are each a command's, in the class of the command's step (`stepClass`).
  budget: "S2",
  // The envelope's owner, deadline and what is left; its amendments are its owner's decisions.
  envelope: "S2",
  "envelope.amendments": "S0",
  maps: "S2",
  // Whole values a step's result can be in.
  attention: "S3",
  result: "S3",
  error: "S3",
  evidence: "S3",
  actions: "S3",
  changesets: "S3",
  // Each command's request digest and result: a step's (`steps`) or an agent loop's (`trace`), by its kind.
  steps: "S3",
  trace: "S4",
  // What the lead of a plan wrote.
  plans: "S4",
  // The program's own views, made from its IR alone.
  architecture: "S2",
  authority: "S2",
  // The audit's own: what the run was started with, the halts that cover its tenant, the chain's status as
  // `verifyJournal` reports it, and every event with its data. A role's view is made of the sections above.
  input: "S3",
  halts: "S1",
  chain: "S1",
  events: "S4",
};

/** A section's class. A section the table does not name is S4. */
export function sectionClass(section: string): ViewClass {
  return Object.hasOwn(SECTION_CLASSES, section) ? SECTION_CLASSES[section]! : "S4";
}

/** The kinds of command an agent loop's trace is made of: its session, its turns and its tool calls. */
export const TRACE_KINDS: ReadonlySet<string> = new Set(["session", "turn", "tool"]);

/** The kinds of command that wait for a person. */
export const WAIT_KINDS: ReadonlySet<string> = new Set(["input", "decision", "amendment"]);

/** The class of a command as a step of the run: its id, kind, label, state, reservation and cost. */
export function stepClass(kind: string): ViewClass {
  return TRACE_KINDS.has(kind) ? "S4" : WAIT_KINDS.has(kind) ? "S0" : "S2";
}

/** The class of a command's request and result. */
export function commandClass(kind: string): ViewClass {
  return TRACE_KINDS.has(kind) ? "S4" : WAIT_KINDS.has(kind) ? "S0" : "S3";
}

/** Who a view is for: a role the run's program names, or an auditor. */
export type Audience = { role: string } | { audit: true };

/**
 * Whether a view for `audience` shows what is in class `cls`. The audit view shows every class. A role's view shows
 * S1 and S2, and S0 where it was asked of that role: `askedOf` is the role the wait or the decision names.
 */
export function shows(audience: Audience, cls: ViewClass, askedOf?: string | null): boolean {
  if ("audit" in audience) return true;
  if (cls === "S0") return askedOf !== undefined && askedOf !== null && askedOf === audience.role;
  return cls === "S1" || cls === "S2";
}
