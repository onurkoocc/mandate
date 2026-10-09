// Temporal as the scheduler (step 3b, Doc 4 §16.1). The same runs as the
// other tests, but driven by a Temporal workflow: activities resume the run
// against PostgreSQL, control calls wake it with a signal, and a durable
// timer expires a decision's deadline.
//
// The local Temporal dev server is downloaded by the SDK, or taken from
// TEMPORAL_CLI_PATH.

import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime as TemporalRuntime, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/runtime.js";
import { SimAgents, SimTool, wallClock } from "../src/sim.js";
import { createWorker, TemporalDriver, workflowsPath } from "../src/temporal/index.js";
import { isObj } from "../src/values.js";
import { closeAll, world, type World } from "./helpers.js";
import { BUG, FIXBUG, fixbugAgents, RESULTS, USD, waitOf } from "./fixbug.js";
import { ASK, FIX, ISSUE, NOTIFY } from "./programs.js";

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  TemporalRuntime.install({ logger: new DefaultLogger("WARN") });
  const path = process.env["TEMPORAL_CLI_PATH"];
  env = await TestWorkflowEnvironment.createLocal(path ? { server: { executable: { type: "existing-path", path } } } : {});
  bundle = await bundleWorkflowCode({ workflowsPath: workflowsPath(), logger: new DefaultLogger("WARN") });
}, 180_000);

afterAll(async () => {
  await env?.teardown();
  await closeAll();
});

interface Scheduled extends World {
  control: Runtime;
  driver: TemporalDriver;
  /** Runs the test body while a worker serves the run's task queue. */
  serve<T>(body: () => Promise<T>): Promise<T>;
}

async function scheduled(src: string, o: Parameters<typeof world>[1] = {}): Promise<Scheduled> {
  const w = await world(src, o);
  const taskQueue = `mandate-${randomUUID()}`;
  const worker = await createWorker({ connection: env.nativeConnection, taskQueue, runtime: w.rt, workflowBundle: bundle });
  const driver = new TemporalDriver(env.client, taskQueue);
  return { ...w, driver, control: new Runtime(w.db, w.adapters, w.faults, driver), serve: (body) => worker.runUntil(body()) };
}

async function stateOf(s: Scheduled, runId: string, state: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await s.control.getRun(runId)).state === state) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} never reached ${state}`);
}

describe("Temporal schedules runs", () => {
  it("drives a run to its result; StartRun only starts the workflow", async () => {
    const s = await scheduled(FIX);
    const started = await s.control.startRun({ pkg: s.pkg, workflow: "Fix", input: ISSUE, runId: "t1" });
    expect(started.state).toBe("accepted");
    const done = await s.serve(() => s.driver.result("t1"));
    expect(done).toEqual({ runId: "t1", state: "succeeded", wakeInMs: null });
    expect(s.agents.count()).toBe(1);
    // Starting the same run again does not start a second workflow.
    await s.driver.start("t1");
  });

  it("a worker that dies is replaced by Temporal's retry, and the journal prevents a second call (R01)", async () => {
    const s = await scheduled(FIX);
    s.faults.arm("after_record", (i) => i.kind === "delegate");
    await s.control.startRun({ pkg: s.pkg, workflow: "Fix", input: ISSUE, runId: "t2" });
    const done = await s.serve(() => s.driver.result("t2"));
    expect(done.state).toBe("succeeded");
    expect(s.agents.count()).toBe(1);
    const leases = (await s.control.journal.events("t2")).filter((e) => e.type === "lease_acquired");
    expect(leases).toHaveLength(2);
  });

  it("a crash after commit does not send the action twice (R02)", async () => {
    const tool = new SimTool("git.comment");
    const s = await scheduled(NOTIFY, { tools: [tool] });
    s.faults.arm("after_commit");
    await s.control.startRun({ pkg: s.pkg, workflow: "Notify", input: ISSUE, runId: "t3" });
    expect((await s.serve(() => s.driver.result("t3"))).state).toBe("succeeded");
    expect(tool.appliedCount()).toBe(1);
  });

  it("an input wakes the waiting run", async () => {
    const s = await scheduled(ASK);
    await s.control.startRun({ pkg: s.pkg, workflow: "Ask", input: ISSUE, runId: "t4" });
    const done = await s.serve(async () => {
      await stateOf(s, "t4", "waiting");
      const run = await s.control.getRun("t4");
      const cmd = isObj(run.waiting) ? String(run.waiting["command"]) : "";
      await s.control.submitInput("t4", { sender: "alice", messageId: "m1" }, { commandId: cmd, revision: run.revision, value: "yes" });
      return s.driver.result("t4");
    });
    expect(done.state).toBe("succeeded");
    expect((await s.control.getRun("t4")).result).toBe("yes");
  });

  it("an approval wakes the run and the action is sent once", async () => {
    const tool = new SimTool("git.comment");
    const s = await scheduled(NOTIFY, { tools: [tool] });
    await s.control.startRun({ pkg: s.pkg, workflow: "Notify", input: ISSUE, runId: "t5", authorize: { "git.comment": { by: "human", role: "owner" } } });
    const done = await s.serve(async () => {
      await stateOf(s, "t5", "waiting");
      const run = await s.control.getRun("t5");
      const w = run.waiting;
      const req = isObj(w) && isObj(w["request"]) ? w["request"] : {};
      await s.control.decideAction("t5", { sender: "alice", messageId: "m1" }, { commandId: String(isObj(w) ? w["command"] : ""), revision: run.revision, digest: String(req["action_digest"]), approve: true, by: "alice" });
      return s.driver.result("t5");
    });
    expect(done.state).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
  });

  it("a durable timer expires an approval deadline and nothing is sent (R15)", async () => {
    const tool = new SimTool("git.comment");
    const s = await scheduled(NOTIFY, { tools: [tool], clock: wallClock });
    const t0 = Date.now();
    await s.control.startRun({ pkg: s.pkg, workflow: "Notify", input: ISSUE, runId: "t6", authorize: { "git.comment": { by: "human", role: "owner", deadlineMs: 1_500 } } });
    const done = await s.serve(() => s.driver.result("t6"));
    expect(done.state).toBe("failed");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500);
    expect((await s.control.getRun("t6")).error).toEqual({ $tag: "Rejected", $args: ["approval_expired"] });
    expect(tool.executions).toHaveLength(0);
  });

  it("cancelling a waiting run ends its workflow", async () => {
    const s = await scheduled(ASK);
    await s.control.startRun({ pkg: s.pkg, workflow: "Ask", input: ISSUE, runId: "t7" });
    const done = await s.serve(async () => {
      await stateOf(s, "t7", "waiting");
      expect((await s.control.cancelRun("t7")).state).toBe("cancelled");
      return s.driver.result("t7");
    });
    expect(done.state).toBe("cancelled");
  });

  it("an unknown outcome parks the run until reconciliation wakes it (R04)", async () => {
    const tool = new SimTool("git.comment", "reconcilable").then("lose_response");
    const agents = new SimAgents();
    const s = await scheduled(NOTIFY, { tools: [tool], agents });
    await s.control.startRun({ pkg: s.pkg, workflow: "Notify", input: ISSUE, runId: "t8" });
    const done = await s.serve(async () => {
      await stateOf(s, "t8", "attention_required");
      const [action] = await s.control.journal.actions("t8");
      await s.control.reconcileAction("t8", action!.operation_key);
      return s.driver.result("t8");
    });
    expect(done.state).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
  });

  it("runs FixBug end to end: the code owner's approval wakes it, and a crash after commit opens one PR", async () => {
    const pr = new SimTool("git.open_pr");
    const s = await scheduled(FIXBUG, { tools: [pr], agents: fixbugAgents() });
    s.faults.arm("after_commit");
    await s.control.startRun({ pkg: s.pkg, workflow: "FixBug", input: BUG, runId: "t9" });
    const done = await s.serve(async () => {
      await stateOf(s, "t9", "waiting");
      const run = await s.control.getRun("t9");
      const wait = waitOf(run.waiting);
      expect(wait.request).toMatchObject({ contract: "FixAccepted", criterion: "owner_approved", role: "code_owner" });
      expect(pr.prepares).toHaveLength(0);
      await s.control.decideAction("t9", { sender: "carol", messageId: "m1" }, { commandId: wait.command, revision: run.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" });
      return s.driver.result("t9");
    });
    expect(done.state).toBe("succeeded");
    expect(pr.appliedCount()).toBe(1);
    expect(Object.keys(RESULTS).map((k) => s.agents.count(k))).toEqual([1, 1, 1, 1, 1]);
    expect((await s.control.evidence("t9")).every((e) => e.passed)).toBe(true);
    expect((await s.control.budgetReport("t9")).dimensions).toEqual([{ dimension: "spend:USD", limit: 20 * USD, settled: 11 * USD, reserved: 0, available: 9 * USD }]);
    // Started, woken by the approval, and resumed by Temporal's retry after the crash.
    const leases = (await s.control.journal.events("t9")).filter((e) => e.type === "lease_acquired");
    expect(leases).toHaveLength(3);
  });
});
