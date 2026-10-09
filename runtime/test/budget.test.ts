// Budget reservations, supervision and parallel results (Doc 4 §7.4, §8.6,
// §8.7; R07, R11 by name, R16).

import { afterAll, describe, expect, it } from "vitest";
import { deferred, SimAgents } from "../src/sim.js";
import { closeAll, commandIds, start, until, world } from "./helpers.js";
import { BOTH, FIX, ISSUE, RETRY } from "./programs.js";
import { Runtime } from "../src/runtime.js";

afterAll(closeAll);

describe("R07: reservations are taken atomically with dispatch", () => {
  it("parallel siblings cannot both reserve what only one fits", async () => {
    // The first call is held, so its reservation is still active when the
    // sibling tries to reserve; otherwise the two could run one after the other.
    const gate = deferred<void>();
    const held = async () => {
      await gate.promise;
      return { ok: "done", cost: { steps: 1 } };
    };
    const w = await world(BOTH, { agents: new SimAgents().on("Worker.fix", held).on("Worker.test", held) });
    let refused = 0;
    const dispatch = w.rt.journal.dispatch.bind(w.rt.journal);
    w.rt.journal.dispatch = async (...a) => {
      try {
        return await dispatch(...a);
      } catch (e) {
        refused++;
        throw e;
      }
    };
    // Each delegate reserves the agent's budget (5 steps); the caller allows 7.
    const p = start(w, "Both", "r7", { limits: { steps: 7 } });
    await until(() => refused === 1 && w.agents.count() === 1, "one dispatch refused, one in flight");
    gate.resolve();
    const run = await p;
    expect(w.agents.count()).toBe(1);
    expect(run.state).toBe("waiting");
    expect(run.waiting).toMatchObject({ kind: "budget_exceeded", detail: { $tag: "BudgetExceeded", $args: [{ dimension: "steps", requested: 5, available: 2 }] } });
    expect((await w.rt.journal.budget("r7"))["steps"]).toEqual({ limit: 7, settled: 1, reserved: 0 });
  });

  it("the run's limit is the smaller of the caller's and the workflow's", async () => {
    const w = await world(BOTH);
    await start(w, "Both", "r7b", { limits: { steps: 100, tokens: 1500 } });
    const b = await w.rt.journal.budget("r7b");
    expect(b["steps"]!.limit).toBe(20);
    expect(b["tokens"]!.limit).toBe(1500);
  });
});

describe("R11 (by name): parallel results bind to branch names, not completion order", () => {
  it("joins patch and tests in program order although tests finished first", async () => {
    const held = deferred<void>();
    const agents = new SimAgents()
      .on("Worker.fix", async () => {
        await held.promise;
        return { ok: "patch;", cost: { steps: 1 } };
      })
      .on("Worker.test", () => ({ ok: "tests;", cost: { steps: 1 } }));
    const w = await world(BOTH, { agents });
    const p = start(w, "Both", "r11");
    await until(() => w.agents.count() === 2, "both branches");
    held.resolve();
    const run = await p;
    expect(run.state).toBe("succeeded");
    expect(run.result).toBe("patch;tests;");
  });
});

describe("R16: an unknown charge keeps its reservation", () => {
  it("until the provider reports what it cost", async () => {
    const agents = new SimAgents().on("Worker.fix", () => ({ error: { tag: "Timeout" }, cost: "unknown" }));
    const w = await world(FIX, { agents });
    const run = await start(w, "Fix", "r16");
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ $tag: "Timeout" });
    expect((await w.rt.journal.budget("r16"))["steps"]).toEqual({ limit: 20, settled: 0, reserved: 5 });
    const [cmd] = await commandIds(w, "r16", "delegate");
    await w.rt.settleCharge("r16", cmd!, { steps: 3, tokens: 200 });
    const b = await w.rt.journal.budget("r16");
    expect(b["steps"]).toEqual({ limit: 20, settled: 3, reserved: 0 });
    expect(b["tokens"]).toEqual({ limit: 10_000, settled: 200, reserved: 0 });
  });
});

describe("Supervision: restart with backoff and journaled jitter (§8.7)", () => {
  it("restarts after a timeout, and replay waits for nothing and draws nothing", async () => {
    const agents = new SimAgents().on("Worker.fix", (_req, n) => (n === 1 ? { error: { tag: "Timeout" }, cost: { steps: 1 } } : { ok: "fixed", cost: { steps: 1 } }));
    const w = await world(RETRY, { agents });
    const t0 = w.clock.now();
    const run = await start(w, "Retry", "s1");
    expect(run.state).toBe("succeeded");
    expect(run.result).toBe("fixed");
    expect(agents.calls.map((c) => c.attempt)).toEqual([0, 1]);
    // backoff 30s × 2^0 × (0.5 + jitter), jitter in [0, 1)
    const waited = w.clock.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(15_000);
    expect(waited).toBeLessThan(45_000);
    const ids = await commandIds(w, "s1", "delegate");
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(`${ids[0]}#1`);
    expect(await commandIds(w, "s1", "random")).toEqual([`${ids[0]}/jitter`]);
    const t1 = w.clock.now();
    expect(await w.rt.replayRun("s1")).toEqual({ status: "complete", value: "fixed" });
    expect(w.clock.now()).toBe(t1);
  });

  it("with durable timers, waits out the backoff as a run state, and the scheduler's tick resumes it (P2-16)", async () => {
    const agents = new SimAgents().on("Worker.fix", (_req, n) => (n === 1 ? { error: { tag: "Timeout" }, cost: { steps: 1 } } : { ok: "fixed", cost: { steps: 1 } }));
    const w = await world(RETRY, { agents });
    const rt = new Runtime(w.db, w.adapters, w.faults, undefined, { durableTimers: true, signer: w.rt.signer });
    const waiting = await rt.startRun({ pkg: w.pkg, workflow: "Retry", runId: "s4", input: ISSUE });
    // No worker sleeps through the backoff: the run waits, with the backoff's end as its deadline.
    expect(waiting.state).toBe("waiting");
    const wait = waiting.waiting as { kind: string; request: { reason: string; until: number; deadline: number } };
    expect(wait).toMatchObject({ kind: "timer", command: "/defs/Retry/body/0/value/backoff", request: { reason: "restart_backoff" } });
    expect(wait.request.until - w.clock.now()).toBeGreaterThanOrEqual(15_000);
    expect(agents.count()).toBe(1);
    // Too early: nothing happens. A worker that resumes it meanwhile waits again, for the same time.
    expect((await rt.tick("s4")).state).toBe("waiting");
    expect(((await rt.resume("s4")).waiting as { request: { until: number } }).request.until).toBe(wait.request.until);
    w.clock.advance(wait.request.until - w.clock.now());
    const done = await rt.tick("s4");
    expect(done.state).toBe("succeeded");
    expect(agents.calls.map((c) => c.attempt)).toEqual([0, 1]);
    expect(await rt.replayRun("s4")).toEqual({ status: "complete", value: "fixed" });
  });

  it("gives up after max restarts", async () => {
    const agents = new SimAgents().on("Worker.fix", () => ({ error: { tag: "SkillFailed", args: ["no"] }, cost: { steps: 1 } }));
    const w = await world(RETRY, { agents });
    const run = await start(w, "Retry", "s2");
    expect(run.state).toBe("failed");
    expect(agents.count()).toBe(3);
  });

  it("never restarts on other faults", async () => {
    const agents = new SimAgents().on("Worker.fix", () => ({ error: { tag: "PolicyDenied", args: ["fs.write"] }, cost: { steps: 1 } }));
    const w = await world(RETRY, { agents });
    expect((await start(w, "Retry", "s3")).state).toBe("failed");
    expect(agents.count()).toBe(1);
  });
});
