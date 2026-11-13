// A hard halt (spec/boundary.md "Violations and halt"; G22, INV-26): every open run of a tenant, or of every
// tenant, ends in one transaction; a result in flight is not written, since its worker no longer holds the lease;
// a start or a resume in the scope is refused before it takes a lease; the adapters are told to revoke once the
// runs have ended; a lift is recorded with who lifted it and brings no run back.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters, ToolAdapter } from "../src/adapters.js";
import type { RunRow } from "../src/journal.js";
import type { WorkerChecker } from "../src/plan.js";
import { Runtime, type Driver } from "../src/runtime.js";
import { deferred, SimAgents, SimTool, type Deferred } from "../src/sim.js";
import type { Value } from "../src/values.js";
import { runView } from "../src/views.js";
import { closeAll, planChecker, UNSIGNED, until, world, type World } from "./helpers.js";
import { finish, fixed, fixes, planned, programAt, run, submit } from "./planning.js";
import { ISSUE } from "./programs.js";

const PROGRAM = `module test.halt @ 0.1
use std.{fs, git, human, model, test}
use company.domain.{Issue, PullRequestDraft}

capability PR       = git.pr("company/backend")
capability ModelStd = model.infer(tier: standard)

agent Worker {
  caps   ModelStd
  budget { tokens: 1k, steps: 5 }
  skill fix(issue: Issue) -> Inferred<Text> ! {Model}
}

workflow Fix(issue: Issue) -> Inferred<Text>
  caps    ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  delegate Worker.fix(issue)
}

workflow Notify(issue: Issue) -> Bool
  caps    PR, ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  let note = delegate Worker.fix(issue)
  effect git.comment(issue, "fixed")
    idempotent_by issue.id
  true
}

workflow Follow(issue: Issue) -> Inferred<Text>
  caps    PR, ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  effect git.comment(issue, "fixed")
    idempotent_by issue.id
  delegate Worker.fix(issue)
}

workflow Retry(issue: Issue) -> Inferred<Text>
  caps    ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  delegate Worker.fix(issue) supervise restart(max: 2, backoff: 30s)
}

workflow Ask(issue: Issue) -> Untrusted<Text>
  caps    ModelStd
{
  human.ask("Proceed?")
}
`;

const issue = (id: string) => ({ issue: { ...ISSUE.issue, id } });

interface Halting extends World {
  /** A runtime whose timers are durable, as a scheduler's is: a run that backs off waits, asleep. */
  durable: Runtime;
  /** A runtime with a scheduler that drives nothing: a run it starts stays `accepted`. */
  scheduled: Runtime;
  /** Runs the scheduler was asked to wake. */
  woken: string[];
  /** The delegation of Fix waits for this before it answers. */
  held: Deferred<void>;
  tool: SimTool;
  /** What `Adapters.revoke` was asked, and the states of the runs when it was. */
  revoked: Array<{ scope: Value; states: Record<string, string> }>;
}

/**
 * The program on runtimes that share one database and one evidence key. Worker.fix answers Fix only once `held` is
 * released, fails Retry's first attempt with a Timeout, and answers everything else at once. The comment tool gives
 * an unknown outcome to its first call.
 */
async function halting(o: { tool?: SimTool; revoke?: Adapters["revoke"] | false } = {}): Promise<Halting> {
  const held = deferred<void>();
  const agents = new SimAgents().on("Worker.fix", async (req) => {
    if (req.commandId.startsWith("/defs/Fix/")) {
      await held.promise;
      return { ok: "patched", cost: { steps: 1 } };
    }
    if (req.commandId.startsWith("/defs/Retry/") && req.attempt === 0) return { error: { tag: "Timeout", args: [] }, cost: { steps: 1 } };
    return { ok: "patched", cost: { steps: 1 } };
  });
  const tool = o.tool ?? new SimTool("git.comment", "non_retryable").then("timeout");
  const w = await world(PROGRAM, { agents, tools: [tool] });
  const revoked: Halting["revoked"] = [];
  if (o.revoke !== false) {
    w.adapters.revoke =
      o.revoke ??
      (async (scope) => {
        const rows = await w.db.query<{ run_id: string; state: string }>("select run_id, state from runs order by run_id");
        revoked.push({ scope: scope as Value, states: Object.fromEntries(rows.map((r) => [r.run_id, r.state])) });
      });
  }
  const woken: string[] = [];
  const driver: Driver = { start: async () => undefined, wake: async (runId) => void woken.push(runId) };
  const options = { ...UNSIGNED, signer: w.rt.signer };
  return {
    ...w,
    durable: new Runtime(w.db, w.adapters, w.faults, undefined, { ...options, durableTimers: true }),
    scheduled: new Runtime(w.db, w.adapters, w.faults, driver, options),
    woken,
    held,
    tool,
    revoked,
  };
}

const byOwner = { "git.comment": { by: "human" as const, role: "owner" } };

async function types(w: World, runId: string): Promise<string[]> {
  return (await w.rt.journal.events(runId)).map((e) => e.type);
}

async function eventsOf(w: World, runId: string, type: string): Promise<Value[]> {
  return (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data);
}

/** A run of every state a run can be in before it ends, in tenant acme, and one waiting in tenant other. */
async function everyState(w: Halting): Promise<{ running: Promise<RunRow> }> {
  const running = w.durable.startRun({ pkg: w.pkg, workflow: "Fix", input: issue("F"), runId: "running", tenant: "acme" });
  await until(() => w.agents.calls.some((c) => c.commandId.startsWith("/defs/Fix/")), "Fix's delegation");
  expect((await w.durable.startRun({ pkg: w.pkg, workflow: "Ask", input: issue("A"), runId: "input", tenant: "acme" })).waiting).toMatchObject({ kind: "input" });
  expect((await w.durable.startRun({ pkg: w.pkg, workflow: "Notify", input: issue("N"), runId: "decision", tenant: "acme", authorize: byOwner })).waiting).toMatchObject({ kind: "decision" });
  expect((await w.durable.startRun({ pkg: w.pkg, workflow: "Retry", input: issue("R"), runId: "asleep", tenant: "acme" })).waiting).toMatchObject({ kind: "timer" });
  expect((await w.durable.startRun({ pkg: w.pkg, workflow: "Follow", input: issue("U"), runId: "unknown", tenant: "acme" })).state).toBe("attention_required");
  expect((await w.scheduled.startRun({ pkg: w.pkg, workflow: "Ask", input: issue("S"), runId: "accepted", tenant: "acme" })).state).toBe("accepted");
  expect((await w.durable.startRun({ pkg: w.pkg, workflow: "Ask", input: issue("O"), runId: "elsewhere", tenant: "other" })).state).toBe("waiting");
  return { running };
}

afterAll(closeAll);

describe("a halt of a tenant (G22, INV-26)", () => {
  it("ends every open run of the tenant, in every state a run is in before it ends, and no other tenant's", async () => {
    const w = await halting();
    const { running } = await everyState(w);
    const r = await w.scheduled.halt({ tenant: "acme" }, { reason: "drill", by: "ops" });
    expect(r.halt).toMatchObject({ halt_id: expect.stringMatching(/^halt-/), tenant: "acme", reason: "drill", halted_by: "ops", lifted_at: null });
    expect(Object.fromEntries(r.ended.map((e) => [e.run, e.state]))).toEqual({
      accepted: "cancelled",
      asleep: "cancelled",
      decision: "cancelled",
      input: "cancelled",
      running: "cancelled",
      // An action whose outcome is unknown keeps the run from a clean end (INV-12).
      unknown: "attention_required",
    });
    for (const e of r.ended) {
      expect(e.tenant).toBe("acme");
      const run = await w.rt.getRun(e.run);
      expect(run.state).toBe(e.state);
      expect(run.cancel_requested).toBe(true);
      expect(await eventsOf(w, e.run, "cancel_requested")).toEqual([{ halt: r.halt.halt_id, reason: "drill", by: "ops" }]);
      expect(await eventsOf(w, e.run, "lease_revoked")).toEqual([{ halt: r.halt.halt_id, fence: expect.any(Number) }]);
      // A halted run's journal is as verifiable as any other: each state change is anchored.
      expect((await w.rt.verifyJournal(e.run)).status).toBe("verified");
    }
    expect((await w.rt.getRun("unknown")).attention).toMatchObject({ halted: r.halt.halt_id, open_actions: [{ effect: "git.comment", state: "unknown_outcome" }] });
    expect((await w.rt.getRun("input")).summary).toEqual({ effects_completed_before_or_during_cancel: [], halt: r.halt.halt_id });
    // Another tenant's run goes on as it was.
    const elsewhere = await w.rt.getRun("elsewhere");
    expect(elsewhere.state).toBe("waiting");
    expect(await types(w, "elsewhere")).not.toContain("cancel_requested");
    // The scheduler is told of each run that ended, and the adapters revoke the tenant once all of them have.
    expect([...w.woken].sort()).toEqual(r.ended.map((e) => e.run).sort());
    expect(w.revoked).toEqual([{ scope: { tenant: "acme" }, states: { accepted: "cancelled", asleep: "cancelled", decision: "cancelled", elsewhere: "waiting", input: "cancelled", running: "cancelled", unknown: "attention_required" } }]);
    expect(r.revoke).toBe("revoked");
    w.held.resolve();
    expect((await running).state).toBe("cancelled");
  });

  it("leaves a worker that was mid-step unable to write its result: it no longer holds the lease", async () => {
    const w = await halting();
    const running = w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: ISSUE, runId: "mid", tenant: "acme" });
    await until(() => w.agents.count() === 1, "the delegation");
    const fence = (await w.rt.getRun("mid")).fence;
    await w.rt.halt({ tenant: "acme" });
    expect((await w.rt.getRun("mid")).fence).toBe(fence + 1);
    const before = await types(w, "mid");
    // The delegation answers now, after the halt: its worker's write is refused by the fence.
    w.held.resolve();
    const run = await running;
    expect(run.state).toBe("cancelled");
    const [cmd] = await w.db.query<{ state: string; result: Value }>("select state, result from commands where run_id = 'mid' and kind = 'delegate'");
    expect(cmd).toEqual({ state: "dispatched", result: null });
    expect(await types(w, "mid")).toEqual(before);
    expect(before).not.toContain("command_completed");
    expect((await w.rt.verifyJournal("mid")).status).toBe("verified");
  });

  it("INV-12: leaves a run whose action is in flight attention_required; the worker cannot record the outcome, and a reconciliation that finds it ends the run cancelled", async () => {
    const hold = deferred<void>();
    const tool = new SimTool("git.comment").then({ hold });
    const w = await halting({ tool });
    const running = w.rt.startRun({ pkg: w.pkg, workflow: "Follow", input: ISSUE, runId: "flight", tenant: "acme" });
    await until(() => tool.executions.length === 1, "the comment");
    const r = await w.rt.halt({ tenant: "acme" });
    expect(r.ended).toEqual([{ run: "flight", tenant: "acme", state: "attention_required" }]);
    expect((await w.rt.getRun("flight")).attention).toMatchObject({ halted: r.halt.halt_id, open_actions: [{ effect: "git.comment", state: "dispatched" }] });
    hold.resolve();
    expect((await running).state).toBe("attention_required");
    const [action] = await w.rt.journal.actions("flight");
    // The comment was made, and its worker could not say so: it stays open until the system of record is asked.
    expect(action!.state).toBe("dispatched");
    expect(w.agents.count()).toBe(0);
    // A halted scope resumes nothing: the reconciliation records what happened and ends the run as a cancel would.
    const done = await w.rt.reconcileAction("flight", action!.operation_key);
    expect(done.state).toBe("cancelled");
    expect(done.summary).toEqual({ effects_completed_before_or_during_cancel: [{ effect: "git.comment", operation: action!.operation_key }], halt: r.halt.halt_id });
    expect(w.agents.count()).toBe(0);
    expect((await w.rt.verifyJournal("flight")).status).toBe("verified");
  });

  it("asks an action whose outcome is unknown to stop, as a cancel does, and ends the run when the adapter proves it never applied", async () => {
    const tool = new SimTool("git.comment", "non_retryable").then("timeout");
    (tool as unknown as ToolAdapter).cancel = async () => ({ cancelled: "the comment was never posted" });
    const w = await halting({ tool });
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Follow", input: ISSUE, runId: "stopped", tenant: "acme" })).state).toBe("attention_required");
    const r = await w.rt.halt({ tenant: "acme" });
    expect(r.ended).toEqual([{ run: "stopped", tenant: "acme", state: "cancelled" }]);
    expect((await w.rt.journal.actions("stopped"))[0]!.state).toBe("cancelled");
    expect((await w.rt.verifyJournal("stopped")).status).toBe("verified");
  });

  it("refuses a start and every resume in the tenant before a lease is taken, and leaves other tenants alone", async () => {
    const w = await halting();
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Follow", input: ISSUE, runId: "open", tenant: "acme" })).state).toBe("attention_required");
    await w.rt.halt({ tenant: "acme" }, { reason: "incident 7" });
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "late", tenant: "acme" })).rejects.toMatchObject({ code: "halted", message: expect.stringContaining("incident 7") });
    expect(await w.db.query("select run_id from runs where run_id = 'late'")).toEqual([]);
    // The run the halt left for its open action is not resumed: no lease, no event.
    const before = await w.rt.getRun("open");
    const events = await types(w, "open");
    await expect(w.rt.resume("open")).rejects.toMatchObject({ code: "halted" });
    expect((await w.rt.getRun("open")).fence).toBe(before.fence);
    expect(await types(w, "open")).toEqual(events);
    // A run that has ended is as it was: a resume finds it ended.
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "fine", tenant: "other" })).state).toBe("waiting");
  });

  it("refuses the start in the transaction that would create the run, for a halt that came after the start's first look", async () => {
    const w = await halting();
    // The halt is recorded between the start's early look and the transaction that creates the run.
    const look = w.rt.journal.openHalt.bind(w.rt.journal);
    let once = false;
    w.rt.journal.openHalt = async (tenant, tx) => {
      const found = await look(tenant, tx);
      if (!once && tx === undefined) {
        once = true;
        await w.db.query("insert into halts (halt_id, tenant, halted_at) values ('halt-late', 'acme', 1)");
      }
      return found;
    };
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "raced", tenant: "acme" })).rejects.toMatchObject({ code: "halted" });
    expect(await w.db.query("select run_id from runs where run_id = 'raced'")).toEqual([]);
  });

  it("ends, in a second sweep, a run that a writer which does not take the halt's lock created while the first ran", async () => {
    const w = await halting();
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "first", tenant: "acme" })).state).toBe("waiting");
    const r = await w.rt.halt(
      { tenant: "acme" },
      {
        // As a runtime of an earlier version would: it creates a run and its worker takes the lease, checking no halt.
        between: async (tx) => {
          await w.rt.journal.createRun(tx, { runId: "slipped", tenant: "acme", packageHash: w.pkg.hash, workflow: "Ask", input: ISSUE, policy: { tenant: "acme" }, limits: {}, manifest: null, manifestHash: "sha256:00" });
          await tx.query("update runs set fence = 1 where run_id = 'slipped'");
          await w.rt.journal.setState(tx, "slipped", "running");
        },
      },
    );
    expect(r.ended.map((e) => [e.run, e.state])).toEqual([
      ["first", "cancelled"],
      ["slipped", "cancelled"],
    ]);
    expect((await w.rt.getRun("slipped")).fence).toBe(2);
  });
});

describe("a halt of every tenant", () => {
  it("ends the open runs of every tenant and refuses their starts; a tenant's own halt covers only that tenant", async () => {
    const w = await halting();
    for (const t of ["acme", "other"]) expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: `ask-${t}`, tenant: t })).state).toBe("waiting");
    const tenant = await w.rt.halt({ tenant: "acme" });
    expect(tenant.ended.map((e) => e.run)).toEqual(["ask-acme"]);
    expect((await w.rt.getRun("ask-other")).state).toBe("waiting");
    const all = await w.rt.halt({ all: true }, { reason: "everything" });
    expect(all.halt.tenant).toBeNull();
    expect(all.ended.map((e) => e.run)).toEqual(["ask-other"]);
    expect(w.revoked.map((x) => x.scope)).toEqual([{ tenant: "acme" }, { all: true }]);
    for (const t of ["acme", "other", "new"]) await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, tenant: t })).rejects.toMatchObject({ code: "halted" });
  });
});

describe("revoking", () => {
  it("is reported when it fails, and undoes nothing: the runs have ended and the halt is in force", async () => {
    const w = await halting({
      revoke: async () => {
        throw new Error("the proxy did not answer");
      },
    });
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "r", tenant: "acme" })).state).toBe("waiting");
    const r = await w.rt.halt({ tenant: "acme" });
    expect(r.revoke).toEqual({ failed: "the proxy did not answer" });
    expect((await w.rt.getRun("r")).state).toBe("cancelled");
    expect(await w.rt.halts({ open: true })).toHaveLength(1);
  });

  it("is none when no adapter holds anything to revoke", async () => {
    const w = await halting({ revoke: false });
    expect((await w.rt.halt({ all: true })).revoke).toBe("none");
  });
});

describe("lifting a halt", () => {
  it("is recorded with who lifted it, brings no run back, and lets new runs start", async () => {
    const w = await halting();
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "before", tenant: "acme" })).state).toBe("waiting");
    const { halt } = await w.rt.halt({ tenant: "acme" }, { by: "ops" });
    const lifted = await w.rt.liftHalt({ tenant: "acme" }, "erin");
    expect(lifted).toEqual([{ ...halt, lifted_by: "erin", lifted_at: expect.any(Number) }]);
    expect(await w.rt.halts({ open: true })).toEqual([]);
    expect(await w.rt.halts()).toEqual(lifted);
    // What the halt ended stays ended; a resume finds it so.
    expect((await w.rt.resume("before")).state).toBe("cancelled");
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "after", tenant: "acme" })).state).toBe("waiting");
  });

  it("lifts exactly the scope it names: a lift of all leaves a tenant's halt, and a tenant's lift leaves a halt of all", async () => {
    const w = await halting();
    const tenant = (await w.rt.halt({ tenant: "acme" })).halt;
    const all = (await w.rt.halt({ all: true })).halt;
    expect((await w.rt.liftHalt({ all: true }, "erin")).map((h) => h.halt_id)).toEqual([all.halt_id]);
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, tenant: "acme" })).rejects.toMatchObject({ code: "halted" });
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, tenant: "other" })).state).toBe("waiting");
    await w.rt.halt({ all: true });
    expect((await w.rt.liftHalt({ tenant: "acme" }, "erin")).map((h) => h.halt_id)).toEqual([tenant.halt_id]);
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, tenant: "acme" })).rejects.toMatchObject({ code: "halted" });
  });

  it("needs who lifts it, and a halt in force in that scope", async () => {
    const w = await halting();
    await expect(w.rt.liftHalt({ tenant: "acme" }, "erin")).rejects.toMatchObject({ code: "not_halted" });
    await w.rt.halt({ tenant: "acme" });
    await expect(w.rt.liftHalt({ tenant: "acme" }, " ")).rejects.toMatchObject({ code: "invalid_lift" });
    await expect(w.rt.liftHalt({ all: true }, "erin")).rejects.toMatchObject({ code: "not_halted" });
  });
});

describe("a halt of a run inside a lead's sub-program", () => {
  let checker: WorkerChecker;
  beforeAll(async () => {
    checker = await planChecker();
  }, 60_000);
  afterAll(() => checker.close());

  it("ends the run, and the sub-program's worker, mid-step, writes nothing: the sub-program runs inside the run, under its lease", async () => {
    const held = deferred<void>();
    const w = await planned(checker, [submit(1, fixes(["a"])), finish("done")], {
      worker: async (req) => {
        await held.promise;
        return fixed(req);
      },
    });
    const running = run(w, "sub", { tenant: "acme" });
    await until(() => w.chat.calls.some((c) => c.agent === "Worker"), "the sub-program's worker");
    const r = await w.rt.halt({ tenant: "acme" });
    expect(r.ended).toEqual([{ run: "sub", tenant: "acme", state: "cancelled" }]);
    const before = await types(w, "sub");
    held.resolve();
    expect((await running).state).toBe("cancelled");
    expect(await types(w, "sub")).toEqual(before);
    // The sub-program and its worker's turn stay as they were when the lease was revoked: in flight, without a result.
    const rows = await w.db.query<{ kind: string; state: string }>("select kind, state from commands where run_id = 'sub' and kind in ('program', 'turn') and command_id like $1 order by command_id", [`${programAt(1)}%`]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((c) => c.kind === "program")).toEqual([{ kind: "program", state: "dispatched" }]);
    expect(rows.filter((c) => c.kind === "turn").map((c) => c.state)).toEqual(["dispatched"]);
    expect((await w.rt.verifyJournal("sub")).status).toBe("verified");
  });
});

describe("a halted run read back", () => {
  it("replays, and its view lists no decision for the halt's cancel", async () => {
    const w = await halting();
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "seen", tenant: "acme" })).state).toBe("waiting");
    await w.rt.halt({ tenant: "acme" }, { by: "ops" });
    expect(await w.rt.replayRun("seen")).toMatchObject({ status: "partial" });
    const { view } = await runView(w.rt, "seen");
    expect(view.decisions).toEqual([]);
  });
});
