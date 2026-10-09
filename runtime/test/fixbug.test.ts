// FixBug end to end (Doc 4 §20): discovery, plan, parallel implementation
// and regression test, isolated review, the acceptance contract with the
// code owner's approval, and the pull request, on simulated adapters.

import { afterAll, describe, expect, it } from "vitest";
import { deferred, SimTool, SimVerifier } from "../src/sim.js";
import { closeAll, until, world, type World } from "./helpers.js";
import { BUG, FIXBUG, fixbugAgents, RESERVED, RESULTS, USD, waitOf } from "./fixbug.js";

afterAll(closeAll);

const OWNER = { sender: "carol", messageId: "approve-1" };

async function fixbug(o: { verifier?: SimVerifier; hold?: Record<string, Promise<void>> } = {}): Promise<World & { pr: SimTool }> {
  const pr = new SimTool("git.open_pr");
  const w = await world(FIXBUG, { tools: [pr], agents: fixbugAgents(o.hold), ...(o.verifier ? { verifier: o.verifier } : {}) });
  return { ...w, pr };
}

describe("FixBug runs end to end", () => {
  it("waits for the code owner, then opens one PR backed by the contract's evidence", async () => {
    const implementer = deferred<void>();
    const testWriter = deferred<void>();
    const w = await fixbug({ hold: { "Implementer.apply": implementer.promise, "TestWriter.regression": testWriter.promise } });
    const started = w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "fb1" });

    // Implementer and TestWriter run in parallel; both hold their reservation.
    await until(() => w.agents.count("Implementer.apply") + w.agents.count("TestWriter.regression") === 2, "both parallel agents");
    const during = await w.rt.budgetReport("fb1");
    expect(during.dimensions).toEqual([{ dimension: "spend:USD", limit: 20 * USD, settled: 3 * USD, reserved: 11 * USD, available: 6 * USD }]);
    implementer.resolve();
    testWriter.resolve();

    // Every check a machine can make passed; now the code owner decides.
    const waiting = await started;
    expect(waiting.state).toBe("waiting");
    const wait = waitOf(waiting.waiting);
    expect(wait.command).toBe("/defs/FixBug/body/5/value/contract/accept/owner_approved/call");
    expect(wait.request).toMatchObject({ contract: "FixAccepted", criterion: "owner_approved", role: "code_owner" });
    // Tests before the review, as §10.4 orders them.
    expect(w.verifier.calls.map((c) => c.criterion)).toEqual(["regression_test", "suite_green", "no_blocking_review"]);
    expect(w.pr.prepares).toHaveLength(0);

    // A decision about some other subject is refused; the owner's approval is not.
    await expect(w.rt.decideAction("fb1", { sender: "carol", messageId: "stale" }, { commandId: wait.command, revision: waiting.revision, digest: "sha256:other", approve: true, by: "carol" })).rejects.toMatchObject({
      code: "decision_digest_mismatch",
    });
    // So is an approval given on a view the run has since moved past (§16.1): here a new worker took the run over.
    const moved = await w.rt.resume("fb1");
    expect(moved.revision).toBeGreaterThan(waiting.revision);
    const approve = (msg: typeof OWNER, revision: number) =>
      w.rt.decideAction("fb1", msg, { commandId: wait.command, revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" });
    await expect(approve({ sender: "carol", messageId: "old-view" }, waiting.revision)).rejects.toMatchObject({ code: "stale_revision" });
    expect(await w.rt.evidence("fb1")).not.toContainEqual(expect.objectContaining({ criterion: "owner_approved" }));
    const done = await approve(OWNER, moved.revision);
    expect(done.state).toBe("succeeded");
    // Resuming after the approval took the earlier checks from the journal.
    expect(w.verifier.calls).toHaveLength(3);

    // One PR, opened under policy authorization with the issue as its business key.
    expect(w.pr.appliedCount()).toBe(1);
    expect(w.pr.executions).toHaveLength(1);
    const [action] = await w.rt.journal.actions("fb1");
    expect(action).toMatchObject({ effect: "git.open_pr", state: "confirmed" });
    expect(done.result).toEqual(action!.receipt);
    // Each agent was called once, and the review was isolated.
    expect(Object.keys(RESULTS).map((s) => w.agents.count(s))).toEqual([1, 1, 1, 1, 1]);
    expect(w.agents.calls.find((c) => c.agent === "Reviewer")?.isolated).toBe(true);

    // The contract's evidence: one result per check, all passed; the review never stands alone.
    const evidence = await w.rt.evidence("fb1");
    expect(evidence.map((e) => [e.criterion, e.method, e.passed])).toEqual([
      ["no_blocking_review", "review", true],
      ["no_blocking_review", "static", true],
      ["owner_approved", "human.approve", true],
      ["regression_test", "test.red_then_green", true],
      ["scope_respected", "static", true],
      ["suite_green", "test.suite", true],
    ]);
    expect(evidence.find((e) => e.criterion === "owner_approved")?.detail).toEqual({ by: "carol", role: "code_owner" });

    // The budget table: each delegate reserved its agent's budget (18.5 of 20 USD) and settled what it spent (11 USD).
    const report = await w.rt.budgetReport("fb1");
    expect(report.dimensions).toEqual([{ dimension: "spend:USD", limit: 20 * USD, settled: 11 * USD, reserved: 0, available: 9 * USD }]);
    const delegates = report.commands.filter((c) => c.kind === "delegate");
    expect(Object.fromEntries(delegates.map((c) => [c.label, c.reserved["spend:USD"]]))).toEqual(RESERVED);
    expect(delegates.reduce((n, c) => n + c.reserved["spend:USD"]!, 0)).toBe(18.5 * USD);
    expect(Object.fromEntries(delegates.map((c) => [c.label, c.cost]))).toEqual(Object.fromEntries(Object.entries(RESULTS).map(([k, v]) => [k, v.cost])));
    expect(delegates.every((c) => c.open.length === 0)).toBe(true);

    // Replay rebuilds the same result from the journal without calling anyone.
    expect(await w.rt.replayRun("fb1")).toEqual({ status: "complete", value: done.result });
  });

  it("a failing check is escalated and the code owner is never asked", async () => {
    const w = await fixbug({ verifier: new SimVerifier({ suite_green: false }) });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "fb2" });
    expect(run.state).toBe("waiting");
    const wait = waitOf(run.waiting);
    expect(wait.command).toBe("/defs/FixBug/body/5/value/on_unmet/then");
    expect(wait.request).toEqual({ escalation: 'Open acceptance criteria: ["suite_green","owner_approved"]' });
    const evidence = await w.rt.evidence("fb2");
    expect(evidence.filter((e) => !e.passed).map((e) => e.criterion)).toEqual(["suite_green"]);
    expect(evidence.some((e) => e.criterion === "owner_approved")).toBe(false);

    expect((await w.rt.cancelRun("fb2")).state).toBe("cancelled");
    expect(w.pr.prepares).toHaveLength(0);
  });

  it("when the code owner declines, an answer to the escalation cannot stand in for the evidence", async () => {
    const w = await fixbug();
    const started = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "fb3" });
    const asked = waitOf(started.waiting);
    const declined = await w.rt.decideAction("fb3", OWNER, { commandId: asked.command, revision: started.revision, digest: String(asked.request["subject_digest"]), approve: false, by: "carol" });
    expect(declined.state).toBe("waiting");
    const escalation = waitOf(declined.waiting);
    expect(escalation.request).toEqual({ escalation: 'Open acceptance criteria: ["owner_approved"]' });

    // Whatever the person answers, the draft is still not Verified, so no PR is prepared (INV-13).
    const run = await w.rt.submitInput("fb3", { sender: "dave", messageId: "m1" }, { commandId: escalation.command, revision: declined.revision, value: "ship it anyway" });
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ $tag: "PolicyDenied", $args: [{ effect: "git.open_pr", parameter: 0, reason: "unverified_parameter" }] });
    expect(w.pr.prepares).toHaveLength(0);
    expect((await w.rt.evidence("fb3")).find((e) => e.criterion === "owner_approved")).toMatchObject({ passed: false, detail: { by: "carol", role: "code_owner" } });
  });

  it("an approval not given before its deadline is unmet: on unmet escalates and no PR is prepared (R15)", async () => {
    const DAY = 86_400_000;
    const src = FIXBUG.replace('by human.approve(role: "code_owner")', 'by human.approve(role: "code_owner", deadline: 24h)');
    const pr = new SimTool("git.open_pr");
    const w = await world(src, { tools: [pr], agents: fixbugAgents() });
    const t0 = w.clock.now();
    const asked = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "fb5" });
    const approval = waitOf(asked.waiting);
    expect(approval.request).toMatchObject({ criterion: "owner_approved", deadline: t0 + DAY });

    // A new worker taking the run over does not move the deadline.
    w.clock.advance(DAY - 1);
    expect(waitOf((await w.rt.resume("fb5")).waiting).request["deadline"]).toBe(t0 + DAY);
    expect((await w.rt.tick("fb5")).waiting).toMatchObject({ command: approval.command });

    // At the deadline the criterion is unmet, and the run goes to `on unmet`.
    w.clock.advance(1);
    const expired = await w.rt.tick("fb5");
    expect(expired.state).toBe("waiting");
    const escalation = waitOf(expired.waiting);
    expect(escalation.command).toBe("/defs/FixBug/body/5/value/on_unmet/then");
    expect(escalation.request).toEqual({ escalation: 'Open acceptance criteria: ["owner_approved"]' });
    expect((await w.rt.evidence("fb5")).find((e) => e.criterion === "owner_approved")).toMatchObject({ passed: false, detail: { by: null, role: "code_owner", expired: true } });

    // A late approval finds nothing to approve, and nothing was sent.
    await expect(w.rt.decideAction("fb5", OWNER, { commandId: approval.command, revision: expired.revision, digest: String(approval.request["subject_digest"]), approve: true, by: "carol" })).rejects.toMatchObject({
      code: "no_wait",
    });
    expect(pr.prepares).toHaveLength(0);
    expect((await w.rt.cancelRun("fb5")).state).toBe("cancelled");
    expect(pr.executions).toHaveLength(0);
  });

  it("an approval that arrives after its deadline, before the clock expires it, is unmet too (R15)", async () => {
    const src = FIXBUG.replace('by human.approve(role: "code_owner")', 'by human.approve(role: "code_owner", deadline: 1h)');
    const pr = new SimTool("git.open_pr");
    const w = await world(src, { tools: [pr], agents: fixbugAgents() });
    const asked = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "fb6" });
    const approval = waitOf(asked.waiting);
    w.clock.advance(3_600_000);
    const late = await w.rt.decideAction("fb6", OWNER, { commandId: approval.command, revision: asked.revision, digest: String(approval.request["subject_digest"]), approve: true, by: "carol" });
    expect(waitOf(late.waiting).request).toEqual({ escalation: 'Open acceptance criteria: ["owner_approved"]' });
    expect((await w.rt.evidence("fb6")).find((e) => e.criterion === "owner_approved")).toMatchObject({ passed: false, detail: { expired: true } });
    expect(pr.prepares).toHaveLength(0);
  });

  it("a caller limit below the agents' budgets stops at budget_exceeded before the PR", async () => {
    const w = await fixbug();
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "fb4", limits: { spend: { micros: 10 * USD, currency: "USD" } } });
    // 3 USD settled by Explorer and Planner; Implementer needs 8 USD reserved and 7 USD at most are left.
    expect(run.state).toBe("waiting");
    expect(run.waiting).toMatchObject({ kind: "budget_exceeded", handler: true, episode: 0, detail: { $tag: "BudgetExceeded", $args: [{ dimension: "spend:USD", requested: 8 * USD }] } });
    // The workflow's handler asks a person.
    expect(waitOf(run.waiting)).toEqual({ command: "/defs/FixBug/on/0@0/then/then", request: { question: "Budget exceeded. Continue or cancel?" } });
    expect(w.agents.count("Implementer.apply")).toBe(0);
    expect(w.agents.count("Reviewer.counterexamples")).toBe(0);
    const report = await w.rt.budgetReport("fb4");
    expect(report.dimensions[0]).toMatchObject({ limit: 10 * USD, reserved: 0 });
    expect(report.dimensions[0]!.settled + report.dimensions[0]!.available).toBe(10 * USD);
    expect((await w.rt.cancelRun("fb4")).state).toBe("cancelled");
    expect(w.pr.prepares).toHaveLength(0);
  });

  it("stopped at 10 USD, a person raises the limit to 20 USD and the run goes on from where it stopped to the PR", async () => {
    const w = await fixbug();
    const stopped = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "fb7", limits: { spend: { micros: 10 * USD, currency: "USD" } } });
    const ask = waitOf(stopped.waiting);
    const ADMIN = { sender: "erin", messageId: "raise-1" };
    const raise = (revision: number, micros: number, msg = ADMIN) => w.rt.raiseLimits("fb7", msg, { revision, limits: { spend: { micros, currency: "USD" } }, by: "erin" });

    // A raise only goes up, and never past the workflow's own 20 USD.
    await expect(raise(stopped.revision, 25 * USD, { sender: "erin", messageId: "too-much" })).rejects.toMatchObject({ code: "above_program_budget" });
    await expect(raise(stopped.revision, 5 * USD, { sender: "erin", messageId: "lower" })).rejects.toMatchObject({ code: "not_a_raise" });
    await expect(raise(stopped.revision - 1, 20 * USD, { sender: "erin", messageId: "old-view" })).rejects.toMatchObject({ code: "stale_revision" });
    const raised = await raise(stopped.revision, 20 * USD);
    expect(raised.state).toBe("waiting");
    expect(raised.revision).toBe(stopped.revision + 1);
    // Sent again, the same raise is a duplicate.
    expect((await raise(stopped.revision, 20 * USD)).revision).toBe(raised.revision);
    expect((await w.rt.journal.events("fb7")).filter((e) => e.type === "limits_raised")).toEqual([
      expect.objectContaining({ data: { by: "erin", sender: "erin", message: "raise-1", from: { "spend:USD": 10 * USD }, to: { "spend:USD": 20 * USD } } }),
    ]);

    // Answering the handler's question resumes the run at the Implementer; Explorer and Planner are not called again.
    const approval = await w.rt.submitInput("fb7", { sender: "erin", messageId: "continue" }, { commandId: ask.command, revision: raised.revision, value: "continue" });
    expect(approval.state).toBe("waiting");
    const wait = waitOf(approval.waiting);
    expect(wait.request).toMatchObject({ criterion: "owner_approved" });
    const done = await w.rt.decideAction("fb7", OWNER, { commandId: wait.command, revision: approval.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" });
    expect(done.state).toBe("succeeded");
    expect(w.pr.appliedCount()).toBe(1);
    expect(Object.keys(RESULTS).map((s) => w.agents.count(s))).toEqual([1, 1, 1, 1, 1]);

    // The budget table: the raised limit, 18.5 USD reserved by the agents and 11 USD settled.
    const report = await w.rt.budgetReport("fb7");
    expect(report.dimensions).toEqual([{ dimension: "spend:USD", limit: 20 * USD, settled: 11 * USD, reserved: 0, available: 9 * USD }]);
    const delegates = report.commands.filter((c) => c.kind === "delegate");
    expect(Object.fromEntries(delegates.map((c) => [c.label, c.reserved["spend:USD"]]))).toEqual(RESERVED);
    expect(await w.rt.replayRun("fb7")).toEqual({ status: "complete", value: done.result });
  });

  it("answered without a raise, the run asks again in a new episode", async () => {
    const w = await fixbug();
    const stopped = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "fb8", limits: { spend: { micros: 10 * USD, currency: "USD" } } });
    const first = waitOf(stopped.waiting);
    const again = await w.rt.submitInput("fb8", { sender: "erin", messageId: "m1" }, { commandId: first.command, revision: stopped.revision, value: "continue" });
    expect(again.waiting).toMatchObject({ kind: "budget_exceeded", episode: 1, command: "/defs/FixBug/on/0@1/then/then" });
    expect(w.agents.count("Implementer.apply")).toBe(0);
    // A new worker on the waiting run finds the same question, not a third one.
    expect((await w.rt.resume("fb8")).waiting).toMatchObject({ episode: 1, command: "/defs/FixBug/on/0@1/then/then" });
  });
});
