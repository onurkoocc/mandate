// A cancel against a resume of the same run (§8.9, R06, R08): whichever way the two interleave, the run ends once,
// with one `run_cancelled`, and once cancelled it stays cancelled. A cancel that ends an idle run itself raises its
// fence in its first transaction and again in its close, so a worker that took the lease before the cancel, or
// between its first transaction and its close, writes nothing; the close re-reads the run under the row lock and
// leaves a run that has ended meanwhile as it ended.
//
// Every interleaving here is forced by a seam, never by timing: the adapter's `cancel`, which the cancel calls
// outside any lock, `Journal.acquire`, held just after the lease was taken, and `Journal.dispatch`, held before it
// starts. Each hold is outside a transaction, so the tests run the same on PGlite's one connection and on a
// PostgreSQL pool.

import { afterAll, describe, expect, it } from "vitest";
import type { ToolAdapter } from "../src/adapters.js";
import type { RunRow } from "../src/journal.js";
import { deferred, SimAgents, SimTool, type Deferred } from "../src/sim.js";
import { closeAll, until, world, type World } from "./helpers.js";
import { ISSUE } from "./programs.js";

const PROGRAM = `module test.cancelrace @ 0.1
use std.{fs, git, human, model, test}
use company.domain.{Issue, PullRequestDraft}

capability PR       = git.pr("company/backend")
capability ModelStd = model.infer(tier: standard)

agent Worker {
  caps   ModelStd
  budget { tokens: 1k, steps: 5 }
  skill fix(issue: Issue) -> Inferred<Text> ! {Model}
}

workflow Follow(issue: Issue) -> Inferred<Text>
  caps    PR, ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  effect git.comment(issue, "fixed")
    idempotent_by issue.id
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

workflow Ask(issue: Issue) -> Untrusted<Text>
  caps    ModelStd
{
  human.ask("Proceed?")
}

workflow AskThenFix(issue: Issue) -> Inferred<Text>
  caps    ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  let answer = human.ask("Proceed?")
  delegate Worker.fix(issue)
}
`;

afterAll(closeAll);

const STATES = /^run_/;

/** The run's state events, in order: `run_running`, `run_cancelled` and the like. */
async function states(w: World, runId: string): Promise<string[]> {
  return (await w.rt.journal.events(runId)).map((e) => e.type).filter((t) => STATES.test(t));
}

async function count(w: World, runId: string, type: string): Promise<number> {
  return (await w.rt.journal.events(runId)).filter((e) => e.type === type).length;
}

/** Ended once, cancelled, and never moved after it was: nothing follows the one `run_cancelled`. */
async function cancelledOnce(w: World, runId: string): Promise<void> {
  const s = await states(w, runId);
  expect(s.filter((t) => t === "run_cancelled")).toEqual(["run_cancelled"]);
  expect(s.at(-1)).toBe("run_cancelled");
  expect((await w.rt.getRun(runId)).state).toBe("cancelled");
  expect((await w.rt.verifyJournal(runId)).status).toBe("verified");
}

/**
 * Holds the next lease taken: once `Journal.acquire` has committed, `acquired` resolves and the caller waits for
 * `release` before it goes on. Nothing is held inside a transaction.
 */
function holdLease(w: World): { acquired: Deferred<void>; release: Deferred<void> } {
  const acquired = deferred<void>();
  const release = deferred<void>();
  const journal = w.rt.journal;
  const real = journal.acquire.bind(journal);
  let once = false;
  journal.acquire = async (runId) => {
    const r = await real(runId);
    if (!once) {
      once = true;
      acquired.resolve();
      await release.promise;
    }
    return r;
  };
  return { acquired, release };
}

/**
 * A comment tool whose first call has an unknown outcome, and whose `cancel` proves it never applied. The first
 * `cancel` runs `between` before it answers: the cancel calls it outside any lock, after its first transaction and
 * before its close. A `cancel` made while `between` runs answers `inner`.
 */
function stoppable(between: () => Promise<void>, inner: "cancelled" | "unknown" = "cancelled"): SimTool {
  const tool = new SimTool("git.comment", "non_retryable").then("timeout");
  let once = false;
  (tool as unknown as ToolAdapter).cancel = async () => {
    if (once) return inner === "cancelled" ? { cancelled: "the comment was never posted" } : { unknown: "the system of record does not answer" };
    once = true;
    await between();
    return { cancelled: "the comment was never posted" };
  };
  return tool;
}

/** A run of Follow left `attention_required` by its comment's unknown outcome. */
async function unknownOutcome(w: World, runId: string): Promise<RunRow> {
  const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Follow", input: ISSUE, runId });
  expect(run.state).toBe("attention_required");
  expect((await w.rt.journal.actions(runId))[0]!.state).toBe("unknown_outcome");
  return run;
}

describe("a resume that comes between a cancel's first transaction and its close", () => {
  it("takes the lease while the cancel asks the adapter to stop, and writes nothing after the cancel closed the run: one run_cancelled", async () => {
    let w!: World;
    let resumed: Promise<RunRow> | undefined;
    const lease = { acquired: deferred<void>(), release: deferred<void>() };
    const tool = stoppable(async () => {
      // Another worker resumes the run (a person's reconciliation, a timer, a scheduler) and takes its lease.
      resumed = w.rt.resume("between");
      await lease.acquired.promise;
    });
    w = await world(PROGRAM, { tools: [tool] });
    await unknownOutcome(w, "between");
    Object.assign(lease, holdLease(w));
    const cancelled = await w.rt.cancelRun("between");
    expect(cancelled.state).toBe("cancelled");
    // The worker goes on only now, after the cancel has closed the run.
    lease.release.resolve();
    const after = await resumed!;
    expect(after.state).toBe("cancelled");
    await cancelledOnce(w, "between");
    expect(await count(w, "between", "cancel_requested")).toBe(1);
    // Nothing was sent again, and the delegate after the comment never went out.
    expect(tool.executions).toHaveLength(1);
    expect(w.agents.count()).toBe(0);
    expect((await w.rt.journal.actions("between"))[0]!.state).toBe("cancelled");
  });

  it("runs to its end while the cancel asks the adapter to stop: the worker leaves the run for its open action, and the close ends it", async () => {
    let w!: World;
    let inside: RunRow | undefined;
    const tool = stoppable(async () => {
      inside = await w.rt.resume("inside");
    });
    w = await world(PROGRAM, { tools: [tool] });
    await unknownOutcome(w, "inside");
    const cancelled = await w.rt.cancelRun("inside");
    // The resumed worker held a lease taken after the cancel, and stopped where the comment was still open.
    expect(inside).toMatchObject({ state: "attention_required", attention: { effect: "git.comment", state: "unknown_outcome" } });
    expect(cancelled.state).toBe("cancelled");
    await cancelledOnce(w, "inside");
    expect(tool.executions).toHaveLength(1);
    expect(w.agents.count()).toBe(0);
  });

  it("is still running when the cancel closes the run: the close takes the lease from it, and it writes nothing more", async () => {
    let w!: World;
    let resumed: Promise<RunRow> | undefined;
    const reached = deferred<void>();
    const go = deferred<void>();
    const tool = stoppable(async () => {
      resumed = w.rt.resume("worker");
      await reached.promise;
    });
    w = await world(PROGRAM, { tools: [tool] });
    await unknownOutcome(w, "worker");
    // The worker is held at its first dispatch (the replay of the comment's command), once it has written `running`
    // under the lease it took after the cancel's first transaction.
    const journal = w.rt.journal;
    const dispatch = journal.dispatch.bind(journal);
    let once = false;
    journal.dispatch = async (...args: Parameters<typeof dispatch>) => {
      if (!once) {
        once = true;
        reached.resolve();
        await go.promise;
      }
      return dispatch(...args);
    };
    const cancelled = await w.rt.cancelRun("worker");
    expect(await states(w, "worker")).toEqual(["run_accepted", "run_running", "run_attention_required", "run_running", "run_cancelled"]);
    expect(cancelled).toMatchObject({ state: "cancelled", cancel_requested: true });
    // Let go, it finds the comment cancelled; without the lease it records nothing, and the run does not end `failed`.
    go.resolve();
    expect((await resumed!).state).toBe("cancelled");
    await cancelledOnce(w, "worker");
    expect(tool.executions).toHaveLength(1);
    expect(w.agents.count()).toBe(0);
  });
});

describe("a resume that took the lease before the cancel", () => {
  it("is refused when it writes: the run is cancelled once and never runs again", async () => {
    const w = await world(PROGRAM, {});
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "AskThenFix", input: ISSUE, runId: "early" })).state).toBe("waiting");
    const lease = holdLease(w);
    const resumed = w.rt.resume("early");
    await lease.acquired.promise;
    const before = (await w.rt.getRun("early")).fence;
    const cancelled = await w.rt.cancelRun("early");
    expect(cancelled.state).toBe("cancelled");
    // The cancel took the lease from the worker that held it.
    expect(cancelled.fence).toBeGreaterThan(before);
    lease.release.resolve();
    expect((await resumed).state).toBe("cancelled");
    await cancelledOnce(w, "early");
    expect(w.agents.count()).toBe(0);
  });

  it("a person's answer that arrives during the cancel gets the cancelled run back, not an error, and runs nothing", async () => {
    const w = await world(PROGRAM, {});
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "answered" });
    expect(run.state).toBe("waiting");
    const wait = run.waiting as { command: string };
    const lease = holdLease(w);
    // The answer is taken; the worker it wakes takes the lease, and the cancel comes before that worker writes.
    const answered = w.rt.submitInput("answered", { sender: "alice", messageId: "m1" }, { commandId: wait.command, revision: run.revision, value: "yes" });
    await lease.acquired.promise;
    expect((await w.rt.cancelRun("answered")).state).toBe("cancelled");
    lease.release.resolve();
    // The person is told the run is cancelled: what they answered does not end it `succeeded`.
    expect(await answered).toMatchObject({ state: "cancelled", cancel_requested: true, result: null });
    await cancelledOnce(w, "answered");
    expect(await states(w, "answered")).not.toContain("run_succeeded");
  });

  it("a person's answer whose worker took the lease before the cancel and goes on before the cancel's close writes nothing: the run does not end succeeded", async () => {
    const w = await world(PROGRAM, {});
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "window" });
    const wait = run.waiting as { command: string };
    const lease = holdLease(w);
    const answered = w.rt.submitInput("window", { sender: "alice", messageId: "m1" }, { commandId: wait.command, revision: run.revision, value: "yes" });
    await lease.acquired.promise;
    // The cancel reads the run's actions between its first transaction and its close: the worker goes on there, to its end.
    const journal = w.rt.journal;
    const actions = journal.actions.bind(journal);
    let between: RunRow | undefined;
    let once = false;
    journal.actions = async (runId) => {
      if (!once) {
        once = true;
        lease.release.resolve();
        between = await answered;
      }
      return actions(runId);
    };
    const cancelled = await w.rt.cancelRun("window");
    // The worker's lease went with the cancel's first transaction: it wrote nothing, and saw the run not yet closed.
    expect(between).toMatchObject({ state: "waiting", cancel_requested: true });
    expect(cancelled.state).toBe("cancelled");
    await cancelledOnce(w, "window");
    expect(await states(w, "window")).toEqual(["run_accepted", "run_running", "run_waiting", "run_cancelled"]);
  });

  it("a person's answer given on the view before the cancel is refused as stale, as it always was", async () => {
    const w = await world(PROGRAM, {});
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "stale" });
    const wait = run.waiting as { command: string };
    expect((await w.rt.cancelRun("stale")).state).toBe("cancelled");
    await expect(w.rt.submitInput("stale", { sender: "alice", messageId: "m1" }, { commandId: wait.command, revision: run.revision, value: "yes" })).rejects.toMatchObject({ code: "stale_revision" });
    await cancelledOnce(w, "stale");
  });
});

describe("the other interleavings", () => {
  it("a resume first, then the cancel: the run is cancelled once", async () => {
    const w = await world(PROGRAM, {});
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "first" })).state).toBe("waiting");
    expect((await w.rt.resume("first")).state).toBe("waiting");
    expect((await w.rt.cancelRun("first")).state).toBe("cancelled");
    // A resume after the cancel finds the run ended and runs nothing.
    expect((await w.rt.resume("first")).state).toBe("cancelled");
    await cancelledOnce(w, "first");
  });

  it("two cancels at once: both are recorded, and the run is cancelled once", async () => {
    let w!: World;
    let inner: RunRow | undefined;
    const tool = stoppable(async () => {
      inner = await w.rt.cancelRun("twice");
    });
    w = await world(PROGRAM, { tools: [tool] });
    await unknownOutcome(w, "twice");
    const outer = await w.rt.cancelRun("twice");
    expect(inner!.state).toBe("cancelled");
    expect(outer.state).toBe("cancelled");
    expect(await count(w, "twice", "cancel_requested")).toBe(2);
    await cancelledOnce(w, "twice");
  });

  it("a cancel of a run that a halt is ending: the halt ends it, and the cancel's close leaves it as the halt left it", async () => {
    let w!: World;
    let halted: Awaited<ReturnType<World["rt"]["halt"]>> | undefined;
    const tool = stoppable(async () => {
      halted = await w.rt.halt({ tenant: "default" }, { reason: "drill" });
    });
    w = await world(PROGRAM, { tools: [tool] });
    const run = await unknownOutcome(w, "halted");
    expect(run.tenant).toBe("default");
    const cancelled = await w.rt.cancelRun("halted");
    expect(halted!.ended).toEqual([{ run: "halted", tenant: "default", state: "cancelled" }]);
    expect(cancelled.state).toBe("cancelled");
    // The halt's summary stands: the cancel did not end the run a second time.
    expect(cancelled.summary).toMatchObject({ halt: halted!.halt.halt_id });
    await cancelledOnce(w, "halted");
  });

  it("a cancel while a worker is in the middle of a dispatch: the worker keeps its lease and ends the run itself", async () => {
    const held = deferred<void>();
    const agents = new SimAgents().on("Worker.fix", async () => {
      await held.promise;
      return { ok: "patched", cost: { steps: 1 } };
    });
    const tool = new SimTool("git.comment");
    const w = await world(PROGRAM, { tools: [tool], agents });
    const running = w.rt.startRun({ pkg: w.pkg, workflow: "Notify", input: ISSUE, runId: "busy" });
    await until(() => w.agents.count() === 1, "the delegate");
    const fence = (await w.rt.getRun("busy")).fence;
    const cancelled = await w.rt.cancelRun("busy");
    expect(cancelled).toMatchObject({ state: "running", cancel_requested: true, fence });
    held.resolve();
    // The delegate's result is recorded by the worker that still holds the lease; the effect after it is refused.
    expect((await running).state).toBe("cancelled");
    await cancelledOnce(w, "busy");
    expect(await count(w, "busy", "command_completed")).toBe(1);
    expect(tool.executions).toHaveLength(0);
  });
});
