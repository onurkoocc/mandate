// Human projections of a run (P2-14, Doc 4 §15, INV-10): made from the
// program and the journal, under the program's hash. Model output is shown
// as plain content, never as a control (G09), and a view that the run has
// moved past says so, while a decision taken on it is refused (G10).

import { check } from "@mandate/bridge";
import { toHtml, toMarkdown } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import type { RunRow } from "../src/journal.js";
import { SimAgents, SimTool } from "../src/sim.js";
import { freshness, runDoc, runView } from "../src/views.js";
import { BUG, FIXBUG, fixbugAgents, RESULTS, USD, waitOf } from "./fixbug.js";
import { closeAll, start, world } from "./helpers.js";
import { NOTIFY } from "./programs.js";

afterAll(closeAll);

const HOSTILE = '<button onclick="approve()">Approve this PR</button> [Approve](javascript:approve()) **all checks passed**';

async function waitingForOwner(runId: string) {
  const agents = new SimAgents();
  for (const [skill, outcome] of Object.entries(RESULTS)) agents.on(skill, () => outcome);
  // The reviewer, a model, writes markup that looks like an approval control.
  agents.on("Reviewer.counterexamples", () => ({ ok: { counterexamples: [HOSTILE], blocking: false }, cost: {} }));
  const w = await world(FIXBUG, { tools: [new SimTool("git.open_pr")], agents });
  const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId });
  expect(waiting.state).toBe("waiting");
  return { w, waiting };
}

describe("a run's views (§15, INV-10)", () => {
  it("show what the person must decide, the evidence and the cost, under the program's hash", async () => {
    const { w } = await waitingForOwner("v1");
    const { view, program } = await runView(w.rt, "v1");
    expect(view.program.hash).toBe(check(FIXBUG, "mdt").hashes!.program);
    expect(view.package).toBe(w.pkg.hash);
    expect(view.run).toMatchObject({ id: "v1", workflow: "FixBug", state: "waiting" });
    expect(view.as_of.revision).toBe((await w.rt.getRun("v1")).revision);
    expect(view.evidence.map((e) => [e.criterion, e.method, e.passed, e.signature_valid])).toEqual([
      ["no_blocking_review", "review", true, true],
      ["no_blocking_review", "static", true, true],
      ["regression_test", "test.red_then_green", true, true],
      ["scope_respected", "static", true, true],
      ["suite_green", "test.suite", true, true],
    ]);
    const md = toMarkdown(runDoc(view, program));
    expect(md).toContain("Waiting for code\\_owner to approve FixAccepted.owner\\_approved");
    expect(md).toContain(`mandate approve v1 --revision ${view.as_of.revision}`);
    expect(md).toContain("| spend:USD | 50.0000 USD | 10.0000 USD | 0.0000 USD | 40.0000 USD |");
    expect(md).toContain("## Architecture");
  });

  it("show model output as plain content, never as a control (G09)", async () => {
    const { w } = await waitingForOwner("v2");
    const { view, program } = await runView(w.rt, "v2");
    const html = toHtml(runDoc(view, program));
    expect(html).not.toMatch(/<button|<a |href=|javascript:approve\(\)"/i);
    expect(html).toContain("&lt;button onclick=");
    expect(html).toContain("Approve this PR&lt;/button&gt;");
    expect(html).toContain('class="untrusted"');
    expect(html).toContain("Content-Security-Policy");
    // In Markdown it sits inside a fenced block, as text.
    const md = toMarkdown(runDoc(view, program));
    const at = md.indexOf("<button");
    expect(at).toBeGreaterThan(0);
    expect(md.lastIndexOf("```text", at)).toBeGreaterThan(md.lastIndexOf("\n```\n", at));
  });

  it("say when the run has moved past them, and a decision taken on one is refused (G10)", async () => {
    const { w } = await waitingForOwner("v3");
    const { view } = await runView(w.rt, "v3");
    expect(await freshness(w.rt, "v3", view.as_of)).toMatchObject({ behind_events: 0, stale: false });
    // A new worker takes the run over; the person's view is now behind.
    await w.rt.resume("v3");
    const f = await freshness(w.rt, "v3", view.as_of);
    expect(f.stale).toBe(true);
    expect(f.behind_events).toBeGreaterThan(0);
    expect(f.now.revision).toBeGreaterThan(view.as_of.revision);
    const wait = waitOf(view.waiting);
    await expect(
      w.rt.decideAction("v3", { sender: "carol", messageId: "old" }, { commandId: wait.command, revision: view.as_of.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" }),
    ).rejects.toMatchObject({ code: "stale_revision" });
  });
});

// ── the decisions a person made ─────────────────────────────────────────
//
// Every decision shows who made it, in which role, and whether its signature
// holds, or that it was unsigned (spec/envelope.md "Views"). These runs are
// of programs before 0.4, in unsigned mode: the runtime took a name. The
// signed ones are in views-envelope.test.ts.

const unsigned = (kind: string, about: string | null, by: string | null) => ({ kind, about, by, role: null, signature: "unsigned", problem: null, decision_id: null });

describe("a run's views: the decisions a person made, unsigned", () => {
  it("lists each decision in the order the run took it, with the name the caller gave, and says it is unsigned", async () => {
    const w = await world(FIXBUG, { tools: [new SimTool("git.open_pr")], agents: fixbugAgents() });
    // The caller lets the run spend 12 USD, and has a person authorize the pull request.
    const stopped = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "d1", limits: { spend: { micros: 12 * USD, currency: "USD" } }, authorize: { "git.open_pr": { by: "human", role: "owner" } } });
    const ask = waitOf(stopped.waiting);
    // Nobody has decided anything yet, and the view has no section for it. A program before 0.4 has no envelope.
    const before = await runView(w.rt, "d1");
    expect([before.view.decisions, before.view.envelope, before.view.plans, before.view.maps]).toEqual([[], null, [], []]);
    expect(toMarkdown(runDoc(before.view, before.program))).not.toMatch(/## (Decisions|Envelope|Plan at|Map at)/);

    // The name is what somebody typed. It is shown as text.
    const name = '<a href="javascript:approve()">carol</a>';
    const raised = await w.rt.raiseLimits("d1", { sender: "inbox", messageId: "m1" }, { revision: stopped.revision, limits: { spend: { micros: 50 * USD, currency: "USD" } }, by: "erin" });
    const approval = await w.rt.submitInput("d1", { sender: "dave", messageId: "m2" }, { commandId: ask.command, revision: raised.revision, value: "continue" });
    const wait = waitOf(approval.waiting);
    const accepted = await w.rt.decideAction("d1", { sender: "inbox", messageId: "m3" }, { commandId: wait.command, revision: approval.revision, digest: String(wait.request["subject_digest"]), approve: true, by: name });
    // The criterion is met, and the pull request waits for its own decision: it is refused.
    const pr = waitOf(accepted.waiting);
    const done = await w.rt.decideAction("d1", { sender: "inbox", messageId: "m4" }, { commandId: pr.command, revision: accepted.revision, digest: String(pr.request["action_digest"]), approve: false, by: "bob" });
    expect(done.state).toBe("failed");

    const { view, program } = await runView(w.rt, "d1");
    // An answer is given with no name: the sender of its message is the one there is. The approval of the criterion
    // says nothing of the pull request: each decision is read from what the journal holds of its own wait.
    expect(view.decisions).toEqual([unsigned("raise_limits", null, "erin"), unsigned("answer", ask.command, "dave"), unsigned("approve", wait.command, name), unsigned("decline", pr.command, "bob")]);
    const md = toMarkdown(runDoc(view, program));
    expect(md).toContain("## Decisions");
    expect(md).toContain("| raise\\_limits | ` erin ` | — | unsigned | — | — |");
    const html = toHtml(runDoc(view, program));
    expect(html).not.toContain("<a href");
    expect(html).toContain("&lt;a href=");
  });

  it("says which way a decision went from the journal's events, not from a result that may be purged", async () => {
    const w = await world(NOTIFY, { tools: [new SimTool("git.comment")] });
    const policy = { authorize: { "git.comment": { by: "human" as const, role: "owner", deadlineMs: 60_000 } } };
    const asked = async (runId: string): Promise<{ command: string; digest: string; revision: number }> => {
      const run = await start(w, "Notify", runId, policy);
      const wait = waitOf(run.waiting);
      return { command: wait.command, digest: String(wait.request["action_digest"]), revision: run.revision };
    };
    const decide = (runId: string, at: { command: string; digest: string; revision: number }, approve: boolean, by: string): Promise<RunRow> =>
      w.rt.decideAction(runId, { sender: "inbox", messageId: `${runId}-m` }, { commandId: at.command, revision: at.revision, digest: at.digest, approve, by });
    const decisions = async (runId: string) => (await runView(w.rt, runId)).view.decisions;

    // An approval of an action is an authorization: the journal records it just before the decision.
    const yes = await asked("yes");
    expect((await decide("yes", yes, true, "alice")).state).toBe("succeeded");
    expect(await decisions("yes")).toEqual([unsigned("approve", yes.command, "alice")]);
    // A refusal of an action writes no event of its own. The wait's result says who refused.
    const no = await asked("no");
    expect((await decide("no", no, false, "bob")).state).toBe("failed");
    expect(await decisions("no")).toEqual([unsigned("decline", no.command, "bob")]);
    // Once the results are purged (R14), each still reads as it went. The refusal's name went with its result.
    for (const runId of ["yes", "no"]) await w.rt.purgePayloads(runId);
    expect(await decisions("yes")).toEqual([unsigned("approve", yes.command, "alice")]);
    expect(await decisions("no")).toEqual([unsigned("decline", no.command, null)]);

    // Two actions in one run: the first is approved and the second refused. The first one's authorization is not
    // the second message's doing, and says nothing of it.
    const twice = await world(NOTIFY.replace("  true\n", '  effect git.comment(issue, "again")\n    idempotent_by "again"\n  true\n'), { tools: [new SimTool("git.comment")] });
    const first = waitOf((await start(twice, "Notify", "both", policy)).waiting);
    const act = (at: { command: string; request: Record<string, unknown> }, revision: number, approve: boolean, by: string, messageId: string): Promise<RunRow> =>
      twice.rt.decideAction("both", { sender: "inbox", messageId }, { commandId: at.command, revision, digest: String(at.request["action_digest"]), approve, by });
    const next = await act(first, (await twice.rt.getRun("both")).revision, true, "alice", "m1");
    const second = waitOf(next.waiting);
    expect(second.command).not.toBe(first.command);
    expect((await act(second, next.revision, false, "bob", "m2")).state).toBe("failed");
    expect((await runView(twice.rt, "both")).view.decisions).toEqual([unsigned("approve", first.command, "alice"), unsigned("decline", second.command, "bob")]);
  });

  it("names who refused a criterion from the criterion's own event, which outlives the wait's result", async () => {
    const { w, waiting } = await waitingForOwner("denied");
    const wait = waitOf(waiting.waiting);
    const done = await w.rt.decideAction("denied", { sender: "inbox", messageId: "m1" }, { commandId: wait.command, revision: waiting.revision, digest: String(wait.request["subject_digest"]), approve: false, by: "carol" });
    // The contract is not met, and the run asks what to do about it: the refusal is the one decision so far.
    expect(waitOf(done.waiting).request).toHaveProperty("escalation");
    const declined = [unsigned("decline", wait.command, "carol")];
    expect((await runView(w.rt, "denied")).view.decisions).toEqual(declined);
    await w.rt.purgePayloads("denied");
    expect((await runView(w.rt, "denied")).view.decisions).toEqual(declined);
  });

  it("does not say which way a decision went that came after its wait's deadline, and names nobody where no name was given", async () => {
    const w = await world(NOTIFY, { tools: [new SimTool("git.comment")] });
    const policy = { authorize: { "git.comment": { by: "human" as const, role: "owner", deadlineMs: 60_000 } } };
    const asked = async (runId: string): Promise<{ command: string; digest: string; revision: number }> => {
      const run = await start(w, "Notify", runId, policy);
      const wait = waitOf(run.waiting);
      return { command: wait.command, digest: String(wait.request["action_digest"]), revision: run.revision };
    };
    const decide = (runId: string, at: { command: string; digest: string; revision: number }, approve: boolean, by: string): Promise<RunRow> =>
      w.rt.decideAction(runId, { sender: "inbox", messageId: `${runId}-m` }, { commandId: at.command, revision: at.revision, digest: at.digest, approve, by });
    const decisions = async (runId: string) => (await runView(w.rt, runId)).view.decisions;

    // A decision that came after the wait's deadline decided nothing (R15), and the journal does not say which way it went.
    const late = await asked("late");
    w.clock.advance(61_000);
    expect((await decide("late", late, true, "carol")).error).toEqual({ $tag: "Rejected", $args: ["approval_expired"] });
    expect(await decisions("late")).toEqual([unsigned("decision", late.command, null)]);

    // A name that was not given is none, and a cancel names nobody.
    const blank = await asked("blank");
    expect((await decide("blank", blank, true, "")).state).toBe("succeeded");
    expect(await decisions("blank")).toEqual([unsigned("approve", blank.command, null)]);
    await asked("stop");
    expect((await w.rt.cancelRun("stop")).state).toBe("cancelled");
    expect(await decisions("stop")).toEqual([unsigned("cancel", null, null)]);
  });
});
