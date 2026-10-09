// Supervision strategies and rate limits (P2-18, Doc 4 §8.6, §8.7):
// escalate(human) asks a person whether to try again, degrade(to: F) hands
// the job once to a fallback that does the same work with no more
// authority, and a call that is Throttled (by the provider, or by a shared
// token bucket) waits and is sent again without counting as an attempt,
// without holding its reservation, and without a BudgetExceeded (V14).

import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/runtime.js";
import { SimAgents, SimModel } from "../src/sim.js";
import { closeAll, commandIds, world } from "./helpers.js";

afterAll(closeAll);

const PROGRAM = `module supervise @ 0.1

use std.{fs, model}

capability ModelStd = model.infer(tier: standard)
capability ModelEco = model.infer(tier: economy)
capability RepoRead = fs.read("/work/repo")
capability SrcRead  = fs.read("/work/repo/src")

type Issue = { id: Text, reproducible: Bool }

agent Worker {
  caps   ModelStd, ModelEco, RepoRead
  budget { tokens: 10k, spend: 2 USD, steps: 5 }
  skill fix(issue: Issue) -> Inferred<Text> ! {Model, Fs.Read}
}

agent Cheap {
  caps   ModelEco, SrcRead
  budget { tokens: 10k, spend: 1 USD, steps: 5 }
  skill fix(issue: Issue) -> Inferred<Text> ! {Model, Fs.Read}
}

workflow Escalated(issue: Issue) -> Inferred<Text>
  caps   ModelStd, ModelEco, RepoRead
  budget { spend: 10 USD }
{
  delegate Worker.fix(issue) supervise escalate(human, role: "lead")
}

workflow Degraded(issue: Issue) -> Inferred<Text>
  caps   ModelStd, ModelEco, RepoRead
  budget { spend: 10 USD }
{
  delegate Worker.fix(issue) supervise degrade(to: Cheap)
}

workflow Retried(issue: Issue) -> Inferred<Text>
  caps   ModelStd, ModelEco, RepoRead
  budget { spend: 10 USD }
{
  delegate Worker.fix(issue) supervise restart(max: 1)
}

workflow Ask(issue: Issue) -> Inferred<Text>
  caps   ModelStd
  budget { tokens: 10k }
{
  infer Text from quote(issue) using ModelStd
}
`;

const ISSUE = { issue: { id: "BUG-3", reproducible: true } };
const failed = { error: { tag: "SkillFailed", args: [{ kind: "GoalNotMet", detail: "could not fix it" }] }, cost: {} };

describe("escalate(human) (§8.7)", () => {
  it("asks a person whether to try again, and tries again on 'retry'", async () => {
    const agents = new SimAgents().on("Worker.fix", (_r, n) => (n === 1 ? failed : { ok: "fixed", cost: {} }));
    const w = await world(PROGRAM, { agents });
    const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "Escalated", input: ISSUE, runId: "s1" });
    expect(waiting.state).toBe("waiting");
    const wait = waiting.waiting as { kind: string; command: string; request: Record<string, unknown> };
    expect(wait).toMatchObject({ kind: "input", command: "/defs/Escalated/body/0/value/escalate", request: { role: "lead", options: ["retry", "fail"], escalation: { delegate: "Worker.fix", attempt: 0, fault: { $tag: "SkillFailed" } } } });
    const done = await w.rt.submitInput("s1", { sender: "lead", messageId: "m1" }, { commandId: wait.command, revision: waiting.revision, value: "retry" });
    expect(done.state).toBe("succeeded");
    expect(done.result).toBe("fixed");
    expect(agents.calls.map((c) => c.attempt)).toEqual([0, 1]);
    expect(await w.rt.replayRun("s1")).toEqual({ status: "complete", value: "fixed" });
  });

  it("lets the failure stand on any other answer, and escalates PolicyDenied too", async () => {
    const agents = new SimAgents().on("Worker.fix", () => ({ error: { tag: "PolicyDenied", args: [{ reason: "unsupported_sandbox_profile" }] }, cost: {} }));
    const w = await world(PROGRAM, { agents });
    const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "Escalated", input: ISSUE, runId: "s2" });
    const wait = waiting.waiting as { command: string };
    const done = await w.rt.submitInput("s2", { sender: "lead", messageId: "m1" }, { commandId: wait.command, revision: waiting.revision, value: "give up" });
    expect(done.state).toBe("failed");
    expect(done.error).toMatchObject({ $tag: "PolicyDenied" });
    expect(agents.count()).toBe(1);
  });
});

describe("degrade(to: F) (§8.7)", () => {
  it("hands the job once to the fallback, with the same arguments and its own, narrower grant", async () => {
    const agents = new SimAgents().on("Worker.fix", () => ({ error: { tag: "Timeout" }, cost: {} })).on("Cheap.fix", () => ({ ok: "fixed cheaply", cost: {} }));
    const w = await world(PROGRAM, { agents });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Degraded", input: ISSUE, runId: "s3" });
    expect(run.state).toBe("succeeded");
    expect(run.result).toBe("fixed cheaply");
    expect(agents.calls.map((c) => [c.agent, c.args])).toEqual([
      ["Worker", [ISSUE.issue]],
      ["Cheap", [ISSUE.issue]],
    ]);
    expect(agents.calls[1]!.caps).toEqual([{ ctor: "fs.read", scope: ["/work/repo/src"] }, { ctor: "model.infer" }]);
    expect(await commandIds(w, "s3", "delegate")).toEqual(["/defs/Degraded/body/0/value", "/defs/Degraded/body/0/value~Cheap"]);
  });

  it("does not degrade on a fault a fallback cannot fix", async () => {
    const agents = new SimAgents().on("Worker.fix", () => ({ error: { tag: "Rejected", args: ["no"] }, cost: {} }));
    const w = await world(PROGRAM, { agents });
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Degraded", input: ISSUE, runId: "s4" })).state).toBe("failed");
    expect(agents.count("Cheap.fix")).toBe(0);
  });
});

describe("Throttled (§8.6, V14)", () => {
  it("waits and sends the same call again: no attempt counted, no BudgetExceeded", async () => {
    const throttled = { error: { tag: "Throttled", args: [{ retry_after_ms: 5_000 }] }, cost: {} };
    const agents = new SimAgents().on("Worker.fix", (_r, n) => (n <= 2 ? throttled : { ok: "fixed", cost: { spend: { micros: 100_000, currency: "USD" } } }));
    const w = await world(PROGRAM, { agents });
    const t0 = w.clock.now();
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Retried", input: ISSUE, runId: "s5" });
    expect(run.state).toBe("succeeded");
    // Three sends of attempt 0: the supervisor's restart was never used.
    expect(agents.calls.map((c) => c.attempt)).toEqual([0, 0, 0]);
    expect(w.clock.now() - t0).toBe(10_000);
    const events = await w.rt.journal.events("s5");
    expect(events.filter((e) => e.type === "command_throttled")).toHaveLength(2);
    expect(events.some((e) => e.type === "budget_exceeded")).toBe(false);
    expect((await w.rt.budgetReport("s5")).dimensions).toEqual([{ dimension: "spend:USD", limit: 10_000_000, settled: 100_000, reserved: 0, available: 9_900_000 }]);
    expect(await w.rt.replayRun("s5")).toEqual({ status: "complete", value: "fixed" });
  });

  it("holds no reservation while it waits on a durable timer", async () => {
    const model = new SimModel((_r, n) => (n === 1 ? { error: { tag: "Throttled", args: [{ retry_after_ms: 60_000 }] }, cost: {} } : { ok: "an answer", cost: { tokens: 100 } }));
    const w = await world(PROGRAM, { model });
    const rt = new Runtime(w.db, w.adapters, w.faults, undefined, { durableTimers: true, signer: w.rt.signer });
    const waiting = await rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "s6" });
    expect(waiting.waiting).toMatchObject({ kind: "timer", request: { reason: "throttled" } });
    expect((await rt.budgetReport("s6")).dimensions).toEqual([{ dimension: "tokens", limit: 10_000, settled: 0, reserved: 0, available: 10_000 }]);
    w.clock.advance(60_000);
    const done = await rt.tick("s6");
    expect(done.state).toBe("succeeded");
    expect(model.calls).toHaveLength(2);
  });
});

describe("a shared token bucket (§8.6)", () => {
  it("is shared by every run: the second run waits for a token, then goes on", async () => {
    const w = await world(PROGRAM);
    const rt = new Runtime(w.db, w.adapters, w.faults, undefined, { durableTimers: true, signer: w.rt.signer, rateLimits: { model: { capacity: 1, perSecond: 0.01 } } });
    expect((await rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "b1" })).state).toBe("succeeded");
    const second = await rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "b2" });
    // The model was never called for the second run: the bucket said not yet.
    expect(w.model.calls).toHaveLength(1);
    expect(second.waiting).toMatchObject({ kind: "timer", request: { reason: "throttled" } });
    const until = (second.waiting as { request: { until: number } }).request.until;
    expect(until - w.clock.now()).toBe(100_000);
    w.clock.advance(100_000);
    expect((await rt.tick("b2")).state).toBe("succeeded");
    expect(w.model.calls).toHaveLength(2);
  });

  it("refuses outright when too many calls already wait: back pressure, never a silent queue", async () => {
    const w = await world(PROGRAM);
    const rt = new Runtime(w.db, w.adapters, w.faults, undefined, { durableTimers: true, signer: w.rt.signer, rateLimits: { "model:standard": { capacity: 1, perSecond: 0.01, queue: 0 } } });
    expect((await rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "b3" })).state).toBe("succeeded");
    const refused = await rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "b4" });
    expect(refused.state).toBe("failed");
    expect(refused.error).toEqual({ $tag: "Throttled", $args: [{ retry_after_ms: 100_000, bucket: "model:standard", queue_full: true }] });
  });
});
