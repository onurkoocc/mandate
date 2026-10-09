// Human projections of a run (P2-14, Doc 4 §15, INV-10): made from the
// program and the journal, under the program's hash. Model output is shown
// as plain content, never as a control (G09), and a view that the run has
// moved past says so, while a decision taken on it is refused (G10).

import { check } from "@mandate/compiler";
import { toHtml, toMarkdown } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { SimAgents, SimTool } from "../src/sim.js";
import { freshness, runDoc, runView } from "../src/views.js";
import { BUG, FIXBUG, RESULTS, waitOf } from "./fixbug.js";
import { closeAll, world } from "./helpers.js";

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
