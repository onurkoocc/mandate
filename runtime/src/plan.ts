// `plan`: a lead agent and its sub-programs (0.4; spec/envelope.md "plan").
//
// A lead is an agent loop with three more tools, which the runtime answers
// itself:
//
//   check_program(base, ops)    checks a sub-program and admits nothing
//   submit_program(base, ops)   the same check; a sub-program that fits is
//                               admitted, run to its end, and its result
//                               returned to the lead
//   request_amendment(envelope, reason)
//                               asks the envelope's owner for a wider
//                               envelope; the run waits for their signed
//                               decision, and the call with it (N04)
//
// Each call is a journaled step of the lead's delegation. What happens to a
// submission is recorded as it happens:
//
//   program_submitted   what was sent and by whom, and whether it checked
//   program_refused     that it did not fit, and the codes that say why
//   program_admitted    its number, its hash, where its IR is kept, and what
//                       was reserved for it
//
// The check is bounded (N10): input over a limit is refused before the
// compiler sees it, and the compiler runs in a worker that is stopped when
// it takes longer than `checkMs` or needs more memory than a check may.
// Either is a diagnostic to the lead, `check_limit`, and the run goes on. So
// does a checker that fails on what it was given (`check_failed`): a
// sub-program is a model's writing, and nothing in it may stop the run.
//
// Admission is one transaction (Journal.admitProgram): the sub-program's
// whole budget is reserved, its IR is stored, and the event is written. A
// check and the admission it leads to are one step among the leads of a run,
// so two of them cannot both be given the same remainder or the same place
// to write.
//
// A step whose sub-program was admitted is never checked again. A resumed
// run finds the admission and runs the sub-program against the journal, and
// so does a replay, which reads its IR from the artifact store by what
// `program_admitted` names and calls no checker (N06).
//
// An amendment is checked within the same limits. The program with the new
// envelope is a new package; it is stored, `amendment_requested` is written
// and the wait is opened in one transaction. Nothing of the run changes
// until the owner's decision arrives (Runtime.decideAmendment).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  capsOf,
  governanceChanges,
  hashProgram,
  LIMITS,
  showCap,
  skeleton,
  subprogramLinked,
  type CapVal,
  type DataClass,
  type Diagnostic,
  type Envelope,
  type Json,
  type Lock,
  type Modules,
  type Program,
  type Room,
  type SubprogramCheck,
  type SubprogramInput,
} from "@mandate/compiler";
import type { Outcome, ToolSpec } from "./adapters.js";
import { refOf, sha256Of, type ArtifactScope, type ArtifactStore } from "./artifacts.js";
import type { Admission, CommandRow, Journal } from "./journal.js";
import type { AmendedCheck, AmendedInput } from "./package.js";
import { Fault, Suspend, Violation } from "./signals.js";
import { canonical, digest, isObj, type Value } from "./values.js";

export const CHECK_PROGRAM = "check_program";
export const SUBMIT_PROGRAM = "submit_program";
export const REQUEST_AMENDMENT = "request_amendment";

/** How long a sub-program's check may take, unless `plan.checkMs` says otherwise. */
export const CHECK_MS = 2000;
/** The most memory a check may use, in megabytes of the worker's heap. */
export const CHECK_MB = 256;
/** The most operations one patch may hold. A sub-program has at most 64 definitions; this leaves room to change them. */
export const MAX_OPS = 256;
/** The most diagnostics a lead is shown for one check; the rest are counted. */
const MAX_DIAGNOSTICS = 40;
/** The most of a lead's reason for an amendment that is kept and shown, in characters. */
const MAX_REASON = 2000;

export const PROGRAM_MEDIA_TYPE = "application/vnd.mandate.program+json";

const OPS = {
  type: "array",
  items: { type: "object", properties: { op: { enum: ["add", "remove", "replace"] }, path: { type: "string" }, value: {} }, required: ["op", "path"], additionalProperties: false },
};
const INPUT = { type: "object", properties: { base: { type: "string" }, ops: OPS }, required: ["base", "ops"], additionalProperties: false };

/** The tools a lead has beside those its grant gives. */
export const PLAN_TOOLS: ToolSpec[] = [
  {
    name: CHECK_PROGRAM,
    description:
      "Check a sub-program without running it. `base` is the hash of the module the runtime started for it; `ops` are JSON Patch operations (RFC 6902: add, remove, replace) that add its definitions. Returns the diagnostics, with what is left of the envelope. Nothing is admitted.",
    input_schema: INPUT as unknown as Value,
  },
  {
    name: SUBMIT_PROGRAM,
    description:
      "Check a sub-program and, if it fits the envelope, run it to its end and get its result. `base` and `ops` are as for check_program; send every operation again. A sub-program that does not fit is not run, and the diagnostics say what does not fit.",
    input_schema: INPUT as unknown as Value,
  },
  {
    name: REQUEST_AMENDMENT,
    description:
      "Ask the envelope's owner for a wider envelope, when a sub-program needs more than the envelope allows. `envelope` is the whole new envelope as JSON IR. It holds everything the envelope holds now: every capability, and every budget dimension with at least its amount. It may raise a budget or add a capability. `reason` says why, for the person who decides. The run waits for their decision. Returns whether the envelope was amended, the envelope as it is then, and what is left of it.",
    input_schema: { type: "object", properties: { envelope: { type: "object" }, reason: { type: "string" } }, required: ["envelope", "reason"], additionalProperties: false } as unknown as Value,
  },
];

/** The hash of the module the runtime starts for sub-program `n`: the `base` of the lead's patch. */
export function baseOf(parent: string, n: number): string {
  return hashProgram(skeleton(parent, n) as unknown as Json).program;
}

/**
 * What a lead is told about sub-programs, after its inputs. It says the same on every run of the loop, since a
 * resumed loop is replayed from its first message: what changes while the run goes on, the next base and what is
 * left of the envelope, comes with each tool result. `envelope` is the envelope as it was when the lead was first
 * sent, which an amendment does not change for that lead; an amendment's answer gives the envelope as it is then.
 */
export function planBrief(parent: Program, envelope: Envelope): string {
  const by = (kind: string): string[] => Object.keys(parent.defs).filter((n) => parent.defs[n]!.kind === kind).sort();
  const names = (["agent", "capability", "type", "fn", "contract", "effect"] as const).flatMap((k) => (by(k).length ? [`  ${k}: ${by(k).join(", ")}`] : []));
  return [
    "",
    "You can hand work to a sub-program: a Mandate module, written as JSON IR, that the runtime checks and then runs inside this run's envelope.",
    `- The runtime starts sub-program n as this module, with n in place of 1: ${canonical(skeleton(parent.module, 1) as unknown as Value)}`,
    `- \`base\` is that module's hash. For the first sub-program it is ${baseOf(parent.module, 1)}. Every tool result gives the base to use next.`,
    "- `ops` add definitions under /defs/<Name>: types, constants, capabilities, functions, local agents, and exactly one workflow, which takes no parameters and is what runs.",
    "- The workflow's `caps` and `budget` are what it asks of the envelope. Each capability must lie inside one of the envelope's. The budget must name every dimension the run is limited in, and a time.",
    `- It may use every definition of ${parent.module}${names.length ? ":" : "."}`,
    ...names,
    `- ${CHECK_PROGRAM} checks and runs nothing. ${SUBMIT_PROGRAM} checks, and a sub-program that fits runs to its end; you get its result. One sub-program runs at a time; put parallel work inside it, in par and map.`,
    `- The envelope as you start, as JSON IR: ${canonical(envelope as unknown as Value)}`,
    `- ${REQUEST_AMENDMENT} asks the envelope's owner for a wider one, when a sub-program needs more than it allows. Send the whole new envelope. It keeps everything this one holds and may raise a budget or add a capability. A person decides, and the run waits for them.`,
  ].join("\n");
}

// ── the bounded check ───────────────────────────────────────────────────

/** A check that was stopped because it ran over a limit. */
export interface OverLimit {
  limit: "time" | "memory" | "size" | "depth" | "operations";
  max: number;
}

/** A check that ended without an answer: the checker failed on what it was given. */
export interface CheckFailed {
  failed: string;
}

/** Checks a lead's sub-program in at most `ms` milliseconds. Whatever it answers that is no check admits nothing. */
export interface ProgramChecker {
  check(input: SubprogramInput, ms: number): Promise<SubprogramCheck | OverLimit | CheckFailed>;
  /** Checks an amendment of the envelope and the package it makes, within the same limits. A checker without it checks none (`no_checker`). */
  amendment?(input: AmendedInput, ms: number): Promise<AmendedCheck | OverLimit | CheckFailed>;
  close?(): Promise<void>;
}

/**
 * The checker in a worker thread of its own (spec/envelope.md "Limits"). A check that is still running after `ms`
 * is stopped by ending its thread, which is the only way to stop the compiler in the middle of a check; the next
 * check starts a new one. A worker that finished is kept for the next check. The thread has a heap of its own, of
 * at most `maxMb`: a check that needs more ends with its thread, and the process that runs the workflows goes on.
 *
 * Only a worker that is not there is the runtime's fault (`no_checker`). A worker that fails on its input, or
 * ends, has checked nothing, and says so.
 */
export class WorkerChecker implements ProgramChecker {
  private readonly idle: Worker[] = [];
  private seq = 0;

  /** `entry` is the worker's file: `plan-worker.js` next to this module, unless the caller built it elsewhere. */
  constructor(
    readonly entry: string = fileURLToPath(new URL("./plan-worker.js", import.meta.url)),
    readonly maxMb: number = CHECK_MB,
  ) {}

  check(input: SubprogramInput, ms: number): Promise<SubprogramCheck | OverLimit | CheckFailed> {
    return this.ask<SubprogramCheck>({ input }, ms);
  }

  amendment(input: AmendedInput, ms: number): Promise<AmendedCheck | OverLimit | CheckFailed> {
    return this.ask<AmendedCheck>({ amendment: input }, ms);
  }

  /** One check in the worker: `what` says which, and the answer is its result. */
  private async ask<T>(what: { input: SubprogramInput } | { amendment: AmendedInput }, ms: number): Promise<T | OverLimit | CheckFailed> {
    if (!existsSync(this.entry)) throw new Violation("no_checker", `The sub-program checker's worker is not at ${this.entry}.`);
    const worker = this.idle.pop() ?? new Worker(this.entry, { resourceLimits: { maxOldGenerationSizeMb: this.maxMb } });
    worker.unref();
    const id = ++this.seq;
    return new Promise<T | OverLimit | CheckFailed>((done) => {
      const end = (keep: boolean): void => {
        clearTimeout(timer);
        worker.removeAllListeners("message");
        worker.removeAllListeners("error");
        worker.removeAllListeners("exit");
        if (keep) this.idle.push(worker);
        else void worker.terminate();
      };
      const timer = setTimeout(() => {
        end(false);
        done({ limit: "time", max: ms });
      }, ms);
      worker.on("message", (m: { id: number; result?: T; error?: string }) => {
        if (m.id !== id) return;
        end(true);
        done(m.result ?? { failed: m.error ?? "the checker gave no result" });
      });
      worker.on("error", (e) => {
        end(false);
        done((e as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY" ? { limit: "memory", max: this.maxMb } : { failed: e instanceof Error ? e.message : String(e) });
      });
      worker.on("exit", (code) => {
        end(false);
        done({ failed: `the checker's worker ended with code ${code}` });
      });
      worker.postMessage({ id, ...what });
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.idle.splice(0).map((w) => w.terminate()));
  }
}

/**
 * Whether a patch is over a limit, found without building anything from it: the walk stops at the first limit it
 * passes, so input far over a limit costs no more than input just over it.
 */
export function overLimit(ops: unknown): OverLimit | undefined {
  if (Array.isArray(ops) && ops.length > MAX_OPS) return { limit: "operations", max: MAX_OPS };
  let bytes = 0;
  let over: OverLimit | undefined;
  const walk = (v: unknown, depth: number): void => {
    if (over) return;
    if (depth > LIMITS.jsonDepth) {
      over = { limit: "depth", max: LIMITS.jsonDepth };
      return;
    }
    if (typeof v === "string") bytes += Buffer.byteLength(v, "utf8") + 2;
    else if (Array.isArray(v)) {
      bytes += 2;
      for (const x of v) {
        bytes += 1;
        walk(x, depth + 1);
        if (over) return;
      }
    } else if (v && typeof v === "object") {
      bytes += 2;
      for (const [k, x] of Object.entries(v)) {
        bytes += Buffer.byteLength(k, "utf8") + 4;
        walk(x, depth + 1);
      }
    } else bytes += 8;
    if (bytes > LIMITS.sourceBytes) over = { limit: "size", max: LIMITS.sourceBytes };
  };
  walk(ops, 0);
  return over;
}

/** `sent` is what the lead wrote: the operations of a sub-program, or the envelope of an amendment. */
function limitDiagnostic(o: OverLimit, sent: "operations" | "envelope" = "operations"): Value {
  const The = sent === "operations" ? "The operations are" : "The envelope is";
  const what =
    o.limit === "time"
      ? `The check took longer than ${o.max} ms and was stopped.`
      : o.limit === "memory"
        ? `The check needed more than ${o.max} MB and was stopped.`
        : o.limit === "size"
          ? `${The} larger than ${o.max} bytes.`
          : o.limit === "depth"
            ? `${The} nested deeper than ${o.max} levels.`
            : `There are more than ${o.max} operations.`;
  return { code: "check_limit", severity: "error", message: `${what} Nothing was checked or run. Send a smaller ${sent === "operations" ? "sub-program" : "envelope"}.`, facts: { limit: o.limit, max: o.max } };
}

function failedDiagnostic(f: CheckFailed, sent: "operations" | "envelope" = "operations"): Value {
  const it = sent === "operations" ? "sub-program" : "envelope";
  return { code: "check_failed", severity: "error", message: `The checker failed on this ${it} and checked nothing of it. Nothing was ${sent === "operations" ? "run" : "asked"}. Send another ${it}.`, facts: { reason: f.failed.slice(0, 200) } };
}

// ── what the interpreters of one run share ──────────────────────────────

/**
 * What the interpreters of one run share: the run's own and those of its sub-programs. One worker drives a run at
 * a time (R06), so this lives in memory and is rebuilt as a resumed run comes to where it was.
 */
export class Shared {
  /** Delegations in flight in the run, and those waiting for a place among them (`spawn.max_concurrent`). */
  inFlight = 0;
  readonly waiting: Array<() => void> = [];
  /**
   * The write capabilities that the items of a map in flight hold, by the path each runs under (C5 across the
   * run). Those of a sub-program in flight are read from the journal (`Journal.inFlight`).
   */
  readonly writes = new Map<string, CapVal[]>();
  private last: Promise<unknown> = Promise.resolve();

  /** Runs `fn` after every admission asked for before it has been decided. */
  admitting<T>(fn: () => Promise<T>): Promise<T> {
    const mine = this.last.then(fn);
    this.last = mine.catch(() => undefined);
    return mine;
  }

  /** The writes in flight that are not held around `path`: a map item's own writes are not in the way of what runs inside it. */
  writesBeside(path: string): CapVal[] {
    return [...this.writes].filter(([holder]) => !path.startsWith(`${holder}/`)).flatMap(([, caps]) => caps);
  }
}


// ── a lead's tools ──────────────────────────────────────────────────────

/** What a lead's tools need from the interpreter that runs the lead. */
export interface PlanHost {
  journal: Journal;
  runId: string;
  fence: number;
  /** Replay reads the journal and the artifact store, and calls no checker. */
  replay: boolean;
  artifacts: ArtifactStore;
  scope: ArtifactScope;
  now(): number;
  /** The program of the run's package now, as it was packaged, and the modules packaged with it. */
  parent: Program;
  modules: Modules;
  /** The run's package now, and its lock: an amended package keeps the lock. */
  package: string;
  lock: Lock;
  /** The run's workflow, whose envelope bounds every sub-program. */
  workflow: string;
  /** The `plan` node, as the path the lead's delegation runs under. */
  plan: string;
  /** The lead, as `Agent.skill`. */
  lead: string;
  /** The class of what the lead received (§2.2): a sub-program is its output. */
  leadClass: DataClass;
  /** When the run must have ended: its start plus the envelope's `time`. Absent when the envelope names no time. */
  deadline?: number;
  checker: ProgramChecker;
  checkMs: number;
  shared: Shared;
  /** Runs one journaled step of the lead's delegation. */
  step(id: string, request: Value, call: () => Promise<Outcome>, label: string): Promise<Value>;
  /** Runs an admitted sub-program's workflow to its end and returns its value. */
  run(a: Admission, sub: Program): Promise<Value>;
}

type Answer = { content: string; is_error?: boolean };

/** Answers the `check_program`, `submit_program` and `request_amendment` calls of one lead. */
export class Planner {
  constructor(private readonly h: PlanHost) {}

  /** One call of a lead's tool, as the step `id` of the lead's delegation. */
  async call(id: string, name: string, input: Record<string, unknown>, label: string): Promise<Answer> {
    const answer = (): Promise<Value> => (name === REQUEST_AMENDMENT ? this.amendment(id, input) : this.answer(id, name, input));
    return shown(await this.h.step(id, { tool: name, input: input as Value }, async () => ({ ok: await answer(), cost: {} }), label));
  }

  /**
   * `request_amendment(envelope, reason)` at the step `step` (spec/envelope.md "Amendments", N04).
   *
   * The new envelope is checked within the limits of every check (N10): the run's program with it in place of its
   * workflow's own passes the compiler's checks, takes nothing away from the envelope (E1709), and makes a package
   * the runtime would start. One that does not is refused here with the diagnostics, and nobody is asked.
   *
   * One that does is a new package. It is stored, `amendment_requested` is written, and the run waits for a member
   * of the envelope's `owner` role, whose signed decision names the new package hash. The step waits with it: a
   * resumed run comes back here, finds the wait, and checks nothing again. When the decision is there the lead is
   * told: the envelope was amended and the run is under the new package, or it was declined, or the wait ended
   * unanswered, and the envelope is as it was.
   */
  private async amendment(step: string, input: Record<string, unknown>): Promise<Value> {
    const h = this.h;
    const id = `${step}/amendment`;
    const wf = h.parent.defs[h.workflow];
    const now = wf?.kind === "workflow" ? wf.envelope : undefined;
    if (!now) throw new Violation("unsupported", `${h.workflow} has no envelope to amend.`);
    const told = async (): Promise<Value> => {
      const number = (await h.journal.admissions(h.runId, h.plan)).length + 1;
      const room = await this.room();
      return { envelope: now as unknown as Value, number, base: baseOf(h.parent.module, number), room: { left: room.left, ...(room.time_left_ms !== undefined ? { time_left_ms: room.time_left_ms } : {}), writes_in_flight: room.writes.map(showCap) } };
    };
    let wait: CommandRow | undefined = await h.journal.command(h.runId, id);
    if (!wait) {
      const refuse = async (ds: Value[]): Promise<Value> => ({ amended: false, ...((await told()) as object), ...listed(ds), $error: true });
      const over = overLimit(input["envelope"]);
      if (!over && !h.checker.amendment) throw new Violation("no_checker", "This runtime's checker checks no amendments.");
      const checked = over ?? (await h.checker.amendment!({ parent: h.parent, modules: h.modules, workflow: h.workflow, envelope: input["envelope"], lock: h.lock }, h.checkMs));
      if ("limit" in checked) return refuse([limitDiagnostic(checked, "envelope")]);
      if ("failed" in checked) return refuse([failedDiagnostic(checked, "envelope")]);
      const diagnostics = [...checked.diagnostics.filter((d) => d.severity === "error"), ...checked.diagnostics.filter((d) => d.severity !== "error")].map(forLead);
      const to = checked.program?.defs[h.workflow];
      if (!checked.ok || !checked.program || !checked.package || !checked.diff || to?.kind !== "workflow" || !to.envelope) return refuse(diagnostics);
      if (checked.package === h.package) {
        return refuse([{ code: "unchanged", severity: "error", message: "This is the envelope as it is: the amendment changes nothing, and nobody was asked.", facts: { package: h.package } }]);
      }
      const diff = digest("request", checked.diff as unknown as Value);
      const request = {
        plan: h.plan,
        workflow: h.workflow,
        lead: h.lead,
        from: h.package,
        package: checked.package,
        role: now.owner ?? "",
        // A lead's words, for the person who decides: shown as a model's writing, and cut where a person would stop reading.
        reason: String(input["reason"] ?? "").slice(0, MAX_REASON),
        envelope: to.envelope as unknown as Value,
        diff,
        changes: (checked.changes ?? []) as unknown as Value,
        // The owner has until the run's own deadline, when its envelope names a time.
        deadline: h.deadline ?? null,
      };
      wait = await h.journal.openAmendment(
        h.runId,
        h.fence,
        { id, digest: digest("request", { kind: "amendment", request }) },
        request,
        { hash: checked.package, program: checked.program as unknown as Value, lock: h.lock as unknown as Value, modules: h.modules as unknown as Value },
        { plan: h.plan, step, lead: h.lead, from: h.package, package: checked.package, diff },
      );
    }
    // The request as first recorded: a resumed worker must not move its deadline.
    if (wait.state === "waiting") throw new Suspend({ kind: "amendment", command: id, request: wait.result });
    const decided = isObj(wait.result) ? wait.result : {};
    if (wait.state === "succeeded" && decided["approved"] === true) return { amended: true, package: decided["package"] ?? null, ...((await told()) as object) };
    // Declined by a person, or ended unanswered: past its deadline, or because another amendment was approved first.
    const error = isObj(wait.error) && Array.isArray(wait.error["args"]) ? wait.error["args"][0] : undefined;
    return { amended: false, declined: { reason: wait.state === "succeeded" ? "declined" : String(error ?? "declined"), by: decided["by"] ?? null }, ...((await told()) as object), $error: true };
  }

  /**
   * A replay of the lead (N06). The lead's loop is not run again: its result is in the journal, and so is every
   * check and every refused submission, as a tool result. Each sub-program it had admitted is read from the
   * artifact store and run against the journal, in the order they were admitted, and must end as it did.
   */
  async replay(): Promise<void> {
    for (const a of await this.h.journal.admissions(this.h.runId, this.h.plan)) await this.result(a);
  }

  private async admittedAt(step: string): Promise<Admission | undefined> {
    return (await this.h.journal.admissions(this.h.runId, this.h.plan)).find((a) => a.step === step);
  }

  private async answer(step: string, name: string, input: Record<string, unknown>): Promise<Value> {
    const h = this.h;
    const submit = name === SUBMIT_PROGRAM;
    // A resumed run comes back to a step whose sub-program was admitted: it runs on, and is not checked again.
    const earlier = submit ? await this.admittedAt(step) : undefined;
    if (earlier) return this.result(earlier);
    const decided = await h.shared.admitting(async (): Promise<{ answer: Value } | { admitted: Admission; sub: Program }> => {
      const number = (await h.journal.admissions(h.runId, h.plan)).length + 1;
      const base = baseOf(h.parent.module, number);
      const room = await this.room();
      const told = { number, base, room: { left: room.left, ...(room.time_left_ms !== undefined ? { time_left_ms: room.time_left_ms } : {}), writes_in_flight: room.writes.map(showCap) } };
      const over = overLimit(input["ops"]);
      const checked = over ?? (await h.checker.check({ parent: h.parent, modules: h.modules, workflow: h.workflow, number, base: String(input["base"]), ops: input["ops"] as SubprogramInput["ops"], lead: h.leadClass, room }, h.checkMs));
      // A check that was stopped, or that failed, is no check: it admits nothing, and the lead is told which.
      const stopped = "limit" in checked ? limitDiagnostic(checked) : "failed" in checked ? failedDiagnostic(checked) : undefined;
      const r = "limit" in checked || "failed" in checked ? undefined : checked;
      // The errors come first: they are what the lead must act on, and a long list is cut at its end.
      const diagnostics = stopped ? [stopped] : [...r!.diagnostics.filter((d) => d.severity === "error"), ...r!.diagnostics.filter((d) => d.severity !== "error")].map(forLead);
      const ok = !!r?.ok && !!r.program && !!r.hash && !!r.workflow;
      if (!submit) return { answer: { ok, ...told, ...listed(diagnostics) } };
      const record = { plan: h.plan, number, step };
      const refuse = async (ds: Value[]): Promise<{ answer: Value }> => {
        // The codes are those of the errors: a warning refuses nothing. The digest is of all the lead was shown.
        const errors = ds.filter((d) => (d as { severity?: Value }).severity === "error");
        await h.journal.programEvent(h.runId, h.fence, "program_refused", { ...record, diagnostics: digest("request", ds), codes: [...new Set(errors.map((d) => String((d as { code?: Value }).code)))].sort() });
        return { answer: { admitted: false, ...told, ...listed(ds), $error: true } };
      };
      await h.journal.programEvent(h.runId, h.fence, "program_submitted", {
        ...record,
        lead: h.lead,
        base: String(input["base"]),
        patch: digest("request", { base: String(input["base"]), ops: input["ops"] as Value }),
        ok,
        // What the lead's patch makes of the module it was given, and what in it a person would have had to approve
        // in a program of their own. Here the envelope's owner approved it beforehand, within the envelope.
        ...(ok ? { hash: r!.hash!, governance: [...new Set(governanceChanges(skeleton(h.parent.module, number), r!.program!, { ...h.modules, [h.parent.module]: h.parent }).map((c) => c.kind))].sort() } : {}),
      });
      if (!ok) return refuse(diagnostics);
      const sub = r!.program!;
      const bytes = canonical(sub as unknown as Value);
      const wf = sub.defs[r!.workflow!];
      const a: Admission = { ...record, command: `${h.plan}/program/${number}`, hash: r!.hash!, base: String(input["base"]), artifact: refOf(sha256Of(bytes)), workflow: r!.workflow! };
      try {
        const admitted = await h.journal.admitProgram(h.runId, h.fence, a, wf?.kind === "workflow" ? wf.budget : undefined, digest("request", { kind: "program", request: { plan: a.plan, number, hash: a.hash } }), async (tx) => {
          await h.artifacts.put(h.scope, bytes, PROGRAM_MEDIA_TYPE, tx);
        });
        return { admitted, sub };
      } catch (e) {
        // Something reserved what the check saw as left, between the check and the admission.
        if (!(e instanceof Fault) || e.tag !== "BudgetExceeded") throw e;
        const f = isObj(e.args[0] ?? null) ? (e.args[0] as { dimension?: Value; requested?: Value; available?: Value }) : {};
        return refuse([
          {
            code: "MDT-E1706",
            severity: "error",
            message: `${a.workflow} asks for ${String(f.requested)} ${String(f.dimension)}, and the envelope has ${String(f.available)} left.`,
            path: `/defs/${a.workflow}/budget`,
            facts: { dimension: f.dimension ?? null, asked: f.requested ?? null, left: f.available ?? null },
          },
        ]);
      }
    });
    return "answer" in decided ? decided.answer : this.result(decided.admitted, decided.sub);
  }

  /** What is left of the envelope now (spec/envelope.md "Containment"). */
  private async room(): Promise<Room> {
    const h = this.h;
    const left = Object.fromEntries(Object.entries(await h.journal.budget(h.runId)).map(([dim, b]) => [dim, b.limit - b.settled - b.reserved]));
    // A sub-program that was admitted and has not ended holds its writes, whether it runs now or waits, for a
    // person or for the run to be resumed. The journal says which those are, so no order of events hides one.
    const programs: CapVal[] = [];
    for (const a of await h.journal.inFlight(h.runId)) programs.push(...this.writes(await this.load(a), a.workflow));
    return { left, ...(h.deadline !== undefined ? { time_left_ms: h.deadline - h.now() } : {}), writes: [...h.shared.writesBeside(h.plan), ...programs] };
  }

  /** The write capabilities a sub-program's workflow holds while it runs. */
  private writes(sub: Program, workflow: string): CapVal[] {
    const defs = subprogramLinked(sub, this.h.parent, this.h.modules).defs;
    const wf = Object.hasOwn(defs, workflow) ? defs[workflow] : undefined;
    return wf?.kind === "workflow" ? wf.caps.flatMap((c) => capsOf(defs, c)).filter((c) => c.write) : [];
  }

  /** An admitted sub-program's IR, from the artifact store, held to the hash it was admitted with (INV-02). */
  private async load(a: Admission): Promise<Program> {
    const sub = JSON.parse(await this.h.artifacts.text(this.h.scope, a.artifact)) as Program;
    const hash = hashProgram(sub as unknown as Json).program;
    if (hash !== a.hash) throw new Violation("program_hash_mismatch", `Sub-program ${a.number} of ${a.plan} was admitted as ${a.hash}, and what is stored hashes to ${hash}.`);
    return sub;
  }

  /**
   * Runs an admitted sub-program to its end, or finds how it ended, and says it as the lead is told. A fault of
   * the sub-program is its result: the lead is told, and may plan again. Anything else that stops it stops the
   * lead's step where it is.
   */
  private async result(a: Admission, sub?: Program): Promise<Value> {
    const h = this.h;
    const row = await h.journal.command(h.runId, a.command);
    const next = { number: a.number + 1, base: baseOf(h.parent.module, a.number + 1) };
    const told = (o: { ok: Value } | { error: Value }): Value => ({ admitted: true, number: a.number, hash: a.hash, ...("ok" in o ? { result: o.ok } : { error: o.error, $error: true }), next });
    const ended = row && (row.state === "succeeded" || row.state === "failed") ? (row.state === "succeeded" ? { ok: row.result } : { error: faultValue(row.error) }) : undefined;
    // A replay runs it against the journal even when the journal says how it ended, and holds the two to each other.
    if (ended && !h.replay) return told(ended);
    sub ??= await this.load(a);
    let outcome: { ok: Value } | { error: { tag: string; args: Value[] } };
    try {
      outcome = { ok: await h.run(a, sub) };
    } catch (e) {
      // A fault is how the sub-program ended, a budget that ran out among them: what runs inside it is paid from
      // its own reservation and never from the run's (N02). Anything else stops the lead's step where it is.
      if (!(e instanceof Fault)) throw e;
      outcome = { error: { tag: e.tag, args: e.args } };
    }
    const now = "ok" in outcome ? { ok: outcome.ok } : { error: new Fault(outcome.error.tag, outcome.error.args).value() };
    if (h.replay) {
      if (ended && canonical(ended as unknown as Value) !== canonical(now as unknown as Value)) {
        throw new Violation("nondeterministic_replay", `Sub-program ${a.number} of ${a.plan} ended differently in the replay than the journal recorded.`);
      }
      return told(now);
    }
    await h.journal.closeProgram(h.runId, h.fence, a.command, "ok" in outcome ? outcome : { error: outcome.error });
    return told(now);
  }
}

/** A diagnostic as a lead is shown it: what it is, where, and the facts to act on. */
function forLead(d: Diagnostic): Value {
  return { code: d.code, severity: d.severity, message: d.message, ...(d.at.path !== undefined ? { path: d.at.path } : {}), ...(d.facts ? { facts: d.facts as unknown as Value } : {}) };
}

function listed(ds: Value[]): { diagnostics: Value[]; more?: number } {
  return ds.length > MAX_DIAGNOSTICS ? { diagnostics: ds.slice(0, MAX_DIAGNOSTICS), more: ds.length - MAX_DIAGNOSTICS } : { diagnostics: ds };
}

/** A recorded answer as the model is shown it. `$error` marks an answer that is an error to the model. */
function shown(v: Value): Answer {
  if (!isObj(v)) return { content: canonical(v) };
  const { $error, ...rest } = v;
  return { content: canonical(rest), ...($error === true ? { is_error: true } : {}) };
}

/** A recorded fault, `{ tag, args }`, as the value a program sees. */
function faultValue(e: Value): Value {
  const f = isObj(e) ? e : {};
  return new Fault(String(f["tag"] ?? "SkillFailed"), Array.isArray(f["args"]) ? f["args"] : []).value();
}
