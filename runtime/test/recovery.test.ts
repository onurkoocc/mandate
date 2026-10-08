// Crash recovery and replay (Doc 4 §8.3, §8.9; R01, R02, R06, R13, R14).

import { afterAll, describe, expect, it } from "vitest";
import { deferred, SimAgents, SimTool } from "../src/sim.js";
import { Crash } from "../src/signals.js";
import { closeAll, commandIds, start, until, world } from "./helpers.js";
import { ASK, FIX, FOLLOW, NOTIFY } from "./programs.js";

afterAll(closeAll);

describe("R01: a journaled result is never fetched again", () => {
  it("crash after the result is recorded: the agent is not called again", async () => {
    const w = await world(FIX);
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(start(w, "Fix", "r1")).rejects.toBeInstanceOf(Crash);
    expect(w.agents.count()).toBe(1);
    const run = await w.rt.resume("r1");
    expect(run.state).toBe("succeeded");
    expect(w.agents.count()).toBe(1);
  });

  it("crash after dispatch, before the call: one call in total, reservation released", async () => {
    const w = await world(FIX);
    w.faults.arm("after_dispatch", (i) => i.kind === "delegate");
    await expect(start(w, "Fix", "r1b")).rejects.toBeInstanceOf(Crash);
    expect(w.agents.count()).toBe(0);
    expect((await w.rt.journal.budget("r1b"))["steps"]).toEqual({ limit: 20, settled: 0, reserved: 5 });
    expect((await w.rt.resume("r1b")).state).toBe("succeeded");
    expect(w.agents.count()).toBe(1);
    expect((await w.rt.journal.budget("r1b"))["steps"]).toEqual({ limit: 20, settled: 1, reserved: 0 });
  });

  it("crash between the call and its record: a delegate runs again (at least once)", async () => {
    const w = await world(FIX);
    w.faults.arm("before_record", (i) => i.kind === "delegate");
    await expect(start(w, "Fix", "r1c")).rejects.toBeInstanceOf(Crash);
    expect((await w.rt.resume("r1c")).state).toBe("succeeded");
    expect(w.agents.count()).toBe(2);
  });
});

describe("R02: a committed action survives a crash without a second application", () => {
  it("idempotent adapter, crash after commit: sent once on resume", async () => {
    const tool = new SimTool("git.comment", "idempotent");
    const w = await world(FOLLOW, { tools: [tool] });
    w.faults.arm("after_commit");
    await expect(start(w, "Follow", "r2a")).rejects.toBeInstanceOf(Crash);
    expect(tool.executions).toHaveLength(0);
    expect((await w.rt.resume("r2a")).state).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
    expect(tool.appliedCount()).toBe(1);
  });

  it("idempotent adapter, crash after execute: re-sent under the same operation key, applied once", async () => {
    const tool = new SimTool("git.comment", "idempotent");
    const w = await world(FOLLOW, { tools: [tool] });
    w.faults.arm("after_execute");
    await expect(start(w, "Follow", "r2b")).rejects.toBeInstanceOf(Crash);
    expect((await w.rt.resume("r2b")).state).toBe("succeeded");
    expect(tool.executions).toHaveLength(2);
    expect(tool.executions[0]!.operationKey).toBe(tool.executions[1]!.operationKey);
    expect(tool.appliedCount()).toBe(1);
  });

  it("reconcilable adapter, crash after execute: reconciled, not re-sent", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await world(FOLLOW, { tools: [tool] });
    w.faults.arm("after_execute");
    await expect(start(w, "Follow", "r2c")).rejects.toBeInstanceOf(Crash);
    const run = await w.rt.resume("r2c");
    expect(run.state).toBe("succeeded");
    expect(tool.reconciles).toHaveLength(1);
    expect(tool.executions).toHaveLength(1);
    expect((await w.rt.journal.actions("r2c"))[0]!.state).toBe("confirmed");
  });

  it("reconcilable adapter, crash after commit: the system of record proves it was not applied, so it is sent", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await world(FOLLOW, { tools: [tool] });
    w.faults.arm("after_commit");
    await expect(start(w, "Follow", "r2d")).rejects.toBeInstanceOf(Crash);
    expect((await w.rt.resume("r2d")).state).toBe("succeeded");
    expect(tool.reconciles).toHaveLength(1);
    expect(tool.executions).toHaveLength(1);
    expect(tool.appliedCount()).toBe(1);
  });

  it("non-retryable adapter, crash after commit: never re-sent; the outcome is unknown", async () => {
    const tool = new SimTool("git.comment", "non_retryable");
    const w = await world(FOLLOW, { tools: [tool] });
    w.faults.arm("after_commit");
    await expect(start(w, "Follow", "r2e")).rejects.toBeInstanceOf(Crash);
    const run = await w.rt.resume("r2e");
    expect(run.state).toBe("attention_required");
    expect(tool.executions).toHaveLength(0);
    expect((await w.rt.journal.actions("r2e"))[0]!.state).toBe("unknown_outcome");
  });
});

describe("R06: fencing", () => {
  it("a worker that lost its lease cannot write its late result", async () => {
    const held = deferred<void>();
    const agents = new SimAgents().on("Worker.fix", async (_req, n) => {
      if (n === 1) {
        await held.promise;
        return { ok: "from worker A", cost: { steps: 1 } };
      }
      return { ok: "from worker B", cost: { steps: 1 } };
    });
    const w = await world(FIX, { agents });
    const a = start(w, "Fix", "r6");
    await until(() => w.agents.count() === 1, "worker A's call");
    // Worker A looks dead; a new worker takes the lease and finishes the run.
    const b = await w.rt.resume("r6");
    expect(b.state).toBe("succeeded");
    expect(b.result).toBe("from worker B");
    held.resolve();
    const late = await a;
    expect(late.state).toBe("succeeded");
    expect(late.result).toBe("from worker B");
    expect(late.fence).toBe(2);
    const [cmd] = await commandIds(w, "r6", "delegate");
    expect((await w.rt.journal.command("r6", cmd!))!.result).toBe("from worker B");
  });
});

describe("R13, R14: replay", () => {
  it("rebuilds a finished run from the journal with no adapter call", async () => {
    const tool = new SimTool("git.comment");
    const w = await world(NOTIFY, { tools: [tool] });
    expect((await start(w, "Notify", "r13")).state).toBe("succeeded");
    const before = { agents: w.agents.count(), executions: tool.executions.length, prepares: tool.prepares.length };
    // The default replay adapters throw on any call.
    expect(await w.rt.replayRun("r13")).toEqual({ status: "complete", value: true });
    expect({ agents: w.agents.count(), executions: tool.executions.length, prepares: tool.prepares.length }).toEqual(before);
  });

  it("a run still waiting replays as partial", async () => {
    const w = await world(ASK);
    const run = await start(w, "Ask", "r13b");
    expect(run.state).toBe("waiting");
    const r = await w.rt.replayRun("r13b");
    expect(r.status).toBe("partial");
  });

  it("after retention purges payloads, replay says what is missing", async () => {
    const w = await world(FIX);
    expect((await start(w, "Fix", "r14")).state).toBe("succeeded");
    await w.rt.purgePayloads("r14");
    const [cmd] = await commandIds(w, "r14", "delegate");
    expect(await w.rt.replayRun("r14")).toEqual({ status: "incomplete_replay", missing: cmd });
  });
});
