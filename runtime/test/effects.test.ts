// External effects: unknown outcomes, cancellation, authorization (Doc 4 §8.5,
// §8.8, §8.9; R04, R05, R08, R09, R10, R15, E0406, E0407).

import { afterAll, describe, expect, it } from "vitest";
import type { AuthorizePolicy } from "../src/interp.js";
import { deferred, SimAgents, SimTool } from "../src/sim.js";
import type { RunRow } from "../src/journal.js";
import { isObj } from "../src/values.js";
import { closeAll, start, until, world, flush } from "./helpers.js";
import { FOLLOW, NOTIFY, RACE } from "./programs.js";

afterAll(closeAll);

const byOwner = (deadlineMs?: number): Record<string, AuthorizePolicy> => ({
  "git.comment": { by: "human", role: "owner", ...(deadlineMs ? { deadlineMs } : {}) },
});

/** The decision a run waits for, and the revision it was seen at. */
function waiting(run: RunRow): { command: string; digest: string; revision: number } {
  const v = run.waiting;
  if (!isObj(v) || !isObj(v["request"])) throw new Error(`not waiting for a decision: ${JSON.stringify(v)}`);
  return { command: String(v["command"]), digest: String(v["request"]["action_digest"]), revision: run.revision };
}

describe("R04: a lost response is reconciled, never guessed", () => {
  it("applied but unanswered: attention, then reconciliation confirms it", async () => {
    const tool = new SimTool("git.comment", "reconcilable").then("lose_response");
    const w = await world(FOLLOW, { tools: [tool] });
    const run = await start(w, "Follow", "r4");
    expect(run.state).toBe("attention_required");
    expect(run.attention).toMatchObject({ effect: "git.comment", state: "unknown_outcome" });
    expect(w.agents.count()).toBe(0);
    const [action] = await w.rt.journal.actions("r4");
    const done = await w.rt.reconcileAction("r4", action!.operation_key);
    expect(done.state).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
    expect(w.agents.count()).toBe(1);
  });

  it("not applied: after reconciliation it is sent again under the same key", async () => {
    const tool = new SimTool("git.comment", "reconcilable").then("timeout");
    const w = await world(FOLLOW, { tools: [tool] });
    expect((await start(w, "Follow", "r4b")).state).toBe("attention_required");
    const [action] = await w.rt.journal.actions("r4b");
    expect((await w.rt.reconcileAction("r4b", action!.operation_key)).state).toBe("succeeded");
    expect(tool.executions.map((e) => e.operationKey)).toEqual([action!.operation_key, action!.operation_key]);
    expect(tool.appliedCount()).toBe(1);
  });
});

describe("R05: a non-retryable action with an unknown outcome is never retried", () => {
  it("stays open across resumes and blocks a clean end, even on cancel", async () => {
    const tool = new SimTool("git.comment", "non_retryable").then("timeout");
    const w = await world(FOLLOW, { tools: [tool] });
    expect((await start(w, "Follow", "r5")).state).toBe("attention_required");
    expect((await w.rt.resume("r5")).state).toBe("attention_required");
    expect(tool.executions).toHaveLength(1);
    const cancelled = await w.rt.cancelRun("r5");
    expect(cancelled.state).toBe("attention_required");
    expect(cancelled.attention).toMatchObject({ open_actions: [{ effect: "git.comment", state: "unknown_outcome" }] });
  });
});

describe("R08, R09: cancellation is ordered against dispatch", () => {
  it("R08: cancelled before commit, the action is never sent", async () => {
    const held = deferred<void>();
    const agents = new SimAgents().on("Worker.fix", async () => {
      await held.promise;
      return { ok: "patched", cost: { steps: 1 } };
    });
    const tool = new SimTool("git.comment");
    const w = await world(NOTIFY, { tools: [tool], agents });
    const p = start(w, "Notify", "r8");
    await until(() => w.agents.count() === 1, "the delegate");
    expect((await w.rt.cancelRun("r8")).cancel_requested).toBe(true);
    held.resolve();
    const run = await p;
    expect(run.state).toBe("cancelled");
    expect(run.summary).toEqual({ effects_completed_before_or_during_cancel: [] });
    expect(tool.executions).toHaveLength(0);
  });

  it("R08: a late approval of a cancelled run sends nothing", async () => {
    const tool = new SimTool("git.comment");
    const w = await world(NOTIFY, { tools: [tool] });
    const run = await start(w, "Notify", "r8b", { authorize: byOwner() });
    const wait = waiting(run);
    const cancelled = await w.rt.cancelRun("r8b");
    expect(cancelled.state).toBe("cancelled");
    // An approval given on the view before the cancel is refused; one given after it still sends nothing.
    const approve = (messageId: string, revision: number) =>
      w.rt.decideAction("r8b", { sender: "alice", messageId }, { commandId: wait.command, revision, digest: wait.digest, approve: true, by: "alice" });
    await expect(approve("m1", wait.revision)).rejects.toMatchObject({ code: "stale_revision" });
    const late = await approve("m2", cancelled.revision);
    expect(late.state).toBe("cancelled");
    expect(tool.executions).toHaveLength(0);
  });

  it("R09: an action in flight when cancel arrives is followed to its result and reported", async () => {
    const held = deferred<void>();
    const tool = new SimTool("git.comment").then({ hold: held });
    const w = await world(FOLLOW, { tools: [tool] });
    const p = start(w, "Follow", "r9");
    await until(() => tool.executions.length === 1, "the comment to be sent");
    await w.rt.cancelRun("r9");
    held.resolve();
    const run = await p;
    expect(run.state).toBe("cancelled");
    const [action] = await w.rt.journal.actions("r9");
    expect(run.summary).toEqual({ effects_completed_before_or_during_cancel: [{ effect: "git.comment", operation: action!.operation_key }] });
    // The delegate after the effect was refused.
    expect(w.agents.count()).toBe(0);
  });
});

describe("R10: fail_fast waits for an external action in flight", () => {
  const failingAgent = (gate: Promise<void>) =>
    new SimAgents().on("Worker.fix", async () => {
      await gate;
      return { error: { tag: "SkillFailed", args: ["boom"] }, cost: { steps: 1 } };
    });

  it("the run is not terminal until the action settles", async () => {
    const gate = deferred<void>();
    const held = deferred<void>();
    const tool = new SimTool("git.comment").then({ hold: held });
    const w = await world(RACE, { tools: [tool], agents: failingAgent(gate.promise) });
    let settled = false;
    const p = start(w, "Race", "r10").finally(() => (settled = true));
    await until(() => tool.executions.length === 1 && w.agents.count() === 1, "both branches in flight");
    gate.resolve();
    await flush();
    expect(settled).toBe(false);
    expect((await w.rt.getRun("r10")).state).toBe("running");
    held.resolve();
    const run = await p;
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ $tag: "SkillFailed", $args: ["boom"] });
    expect((await w.rt.journal.actions("r10"))[0]!.state).toBe("confirmed");
  });

  it("an action that ends unknown makes the run need attention, not fail", async () => {
    const gate = deferred<void>();
    const tool = new SimTool("git.comment", "non_retryable").then("timeout");
    const w = await world(RACE, { tools: [tool], agents: failingAgent(gate.promise) });
    const p = start(w, "Race", "r10b");
    await until(() => tool.executions.length === 1 && w.agents.count() === 1, "both branches in flight");
    gate.resolve();
    const run = await p;
    expect(run.state).toBe("attention_required");
  });
});

describe("Authorization by a person (§8.8, G02) and its deadline (R15)", () => {
  it("an approval authorizes exactly the action that was shown", async () => {
    const tool = new SimTool("git.comment");
    const w = await world(NOTIFY, { tools: [tool] });
    const run = await start(w, "Notify", "h1", { authorize: byOwner() });
    expect(run.state).toBe("waiting");
    const wait = waiting(run);
    expect(wait.command).toMatch(/\/authorize$/);
    const msg = { sender: "alice", messageId: "m1" };
    await expect(w.rt.decideAction("h1", msg, { commandId: wait.command, revision: wait.revision, digest: "sha256:other", approve: true, by: "alice" })).rejects.toMatchObject({ code: "decision_digest_mismatch" });
    const done = await w.rt.decideAction("h1", { sender: "alice", messageId: "m2" }, { commandId: wait.command, revision: wait.revision, digest: wait.digest, approve: true, by: "alice" });
    expect(done.state).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
    const [auth] = await w.db.query("select authorization_id, decided_by, consumed_by from authorizations where run_id = $1", ["h1"]);
    expect(auth).toMatchObject({ authorization_id: tool.executions[0]!.authorization, decided_by: "alice" });
  });

  it("an approval given on an older view of the run is refused (§16.1)", async () => {
    const tool = new SimTool("git.comment");
    const w = await world(NOTIFY, { tools: [tool] });
    const seen = waiting(await start(w, "Notify", "h3", { authorize: byOwner() }));
    // After the person looked, the run moved on: a new worker took it over and is waiting again.
    const now = await w.rt.resume("h3");
    expect(now.state).toBe("waiting");
    expect(now.revision).toBeGreaterThan(seen.revision);
    const approve = (messageId: string, revision: number) =>
      w.rt.decideAction("h3", { sender: "alice", messageId }, { commandId: seen.command, revision, digest: seen.digest, approve: true, by: "alice" });
    await expect(approve("m1", seen.revision)).rejects.toMatchObject({ code: "stale_revision" });
    // Nothing was recorded: no authorization, the wait is still open, nothing was sent.
    expect(await w.db.query("select authorization_id from authorizations where run_id = $1", ["h3"])).toHaveLength(0);
    expect(await w.rt.getRun("h3")).toMatchObject({ state: "waiting", revision: now.revision });
    expect(tool.executions).toHaveLength(0);
    // Looking again, the same person can approve.
    expect((await approve("m2", now.revision)).state).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
  });

  it("a denial fails the run without sending", async () => {
    const tool = new SimTool("git.comment");
    const w = await world(NOTIFY, { tools: [tool] });
    const wait = waiting(await start(w, "Notify", "h2", { authorize: byOwner() }));
    const run = await w.rt.decideAction("h2", { sender: "bob", messageId: "m1" }, { commandId: wait.command, revision: wait.revision, digest: wait.digest, approve: false, by: "bob" });
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ $tag: "Rejected", $args: [{ denied_by: "bob" }] });
    expect(tool.executions).toHaveLength(0);
  });

  it("R15: past the deadline nothing is sent, whether the clock or a late answer gets there first", async () => {
    const tool = new SimTool("git.comment");
    const w = await world(NOTIFY, { tools: [tool] });
    await start(w, "Notify", "r15", { authorize: byOwner(60_000) });
    w.clock.advance(59_000);
    expect((await w.rt.tick("r15")).state).toBe("waiting");
    w.clock.advance(1_000);
    const run = await w.rt.tick("r15");
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ $tag: "Rejected", $args: ["approval_expired"] });

    const wait = waiting(await start(w, "Notify", "r15b", { authorize: byOwner(60_000) }));
    w.clock.advance(61_000);
    const late = await w.rt.decideAction("r15b", { sender: "alice", messageId: "m1" }, { commandId: wait.command, revision: wait.revision, digest: wait.digest, approve: true, by: "alice" });
    expect(late.state).toBe("failed");
    expect(tool.executions).toHaveLength(0);
  });
});

describe("Commit checks in the journal (E0406, E0407)", () => {
  it("refuses a commit without a matching authorization, and an authorization used twice", async () => {
    const w = await world(NOTIFY, { tools: [new SimTool("git.comment")] });
    const run = await start(w, "Notify", "e1", { authorize: byOwner() });
    const j = w.rt.journal;
    const [action] = await j.actions("e1");
    const op = action!.operation_key;
    await expect(j.commit("e1", run.fence, op, "sha256:missing")).rejects.toMatchObject({ code: "MDT-E0406" });
    await j.authorize("e1", { id: "auth-other", actionDigest: "sha256:other", decidedBy: "policy" });
    await expect(j.commit("e1", run.fence, op, "auth-other")).rejects.toMatchObject({ code: "MDT-E0406" });

    await j.authorize("e1", { id: "auth-1", actionDigest: action!.action_digest, decidedBy: "policy" });
    await j.prepare("e1", run.fence, { operationKey: "op-2", commandId: "copy", effect: "git.comment", actionDigest: action!.action_digest, params: action!.params, retryClass: "idempotent" });
    expect((await j.commit("e1", run.fence, "op-2", "auth-1")).state).toBe("dispatched");
    await expect(j.commit("e1", run.fence, op, "auth-1")).rejects.toMatchObject({ code: "MDT-E0407" });
    expect((await j.action(op))!.state).toBe("prepared");
  });

  it("refuses an expired authorization", async () => {
    const w = await world(NOTIFY, { tools: [new SimTool("git.comment")] });
    const run = await start(w, "Notify", "e2", { authorize: byOwner() });
    const j = w.rt.journal;
    const [action] = await j.actions("e2");
    await j.authorize("e2", { id: "auth-1", actionDigest: action!.action_digest, decidedBy: "policy", expiresAt: w.clock.now() + 1000 });
    w.clock.advance(1000);
    await expect(j.commit("e2", run.fence, action!.operation_key, "auth-1")).rejects.toMatchObject({ tag: "Rejected", args: ["authorization_expired"] });
  });
});
