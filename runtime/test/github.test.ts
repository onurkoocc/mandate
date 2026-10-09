// The git.open_pr adapter for GitHub (P1-9, K17, K18) against an in-memory
// GitHub: FixBug opens one pull request with the verified files, a lost
// response is reconciled to that one pull request, a request that never
// arrived is sent again without a second one, a cancelled run resolves an
// action that never took effect, and a program bound to another repository
// does not start (§16.1 ValidateBinding, Cancel).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitHubPullRequests } from "../src/github.js";
import type { RunRow } from "../src/journal.js";
import { FakeGitHub } from "./fake-github.js";
import { BUG, FIXBUG, fixbugAgents, waitOf } from "./fixbug.js";
import { closeAll, world, type World } from "./helpers.js";

const workdir = mkdtempSync(join(tmpdir(), "mandate-gh-"));
mkdirSync(join(workdir, "src"), { recursive: true });
writeFileSync(join(workdir, "src", "a.ts"), "export const a = 2;\n");
afterAll(async () => {
  rmSync(workdir, { recursive: true, force: true });
  await closeAll();
});

async function fixbug(gh: FakeGitHub, repo = "company/backend"): Promise<World & { adapter: GitHubPullRequests }> {
  const w = await world(FIXBUG, { agents: fixbugAgents() });
  const adapter = new GitHubPullRequests({ token: "github_pat_test", repo, workdir, fetch: gh.fetch });
  w.adapters.tools["git.open_pr"] = adapter;
  return { ...w, adapter };
}

/** Runs FixBug to the code owner's approval and approves. */
async function approved(w: World, runId: string): Promise<RunRow> {
  const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId });
  const wait = waitOf(waiting.waiting);
  return w.rt.decideAction(runId, { sender: "carol", messageId: `approve-${runId}` }, { commandId: wait.command, revision: waiting.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" });
}

describe("git.open_pr on GitHub", () => {
  it("opens one pull request with the verified files on a branch of the operation", async () => {
    const gh = new FakeGitHub("company/backend");
    const w = await fixbug(gh);
    const done = await approved(w, "gh1");
    expect(done.state).toBe("succeeded");
    expect(gh.pulls).toHaveLength(1);
    const pr = gh.pulls[0]!;
    expect(pr.head.ref).toMatch(/^mandate\/bug-7-[0-9a-f]{12}$/);
    expect(pr.base.ref).toBe("main");
    expect(gh.filesOf(pr.head.ref)!.get("src/a.ts")).toBe("export const a = 2;\n");
    const [action] = await w.rt.journal.actions("gh1");
    expect(pr.body).toContain(action!.operation_key);
    expect(pr.body).toContain(action!.action_digest);
    expect(done.result).toMatchObject({ system: "github", number: 1, branch: pr.head.ref });
    expect(action).toMatchObject({ state: "confirmed", retry_class: "reconcilable" });
  });

  it("reconciles a lost response to the one pull request it opened", async () => {
    const gh = new FakeGitHub("company/backend");
    gh.pullFaults.push("lose_response");
    const w = await fixbug(gh);
    const lost = await approved(w, "gh2");
    expect(lost.state).toBe("attention_required");
    const [action] = await w.rt.journal.actions("gh2");
    expect(action!.state).toBe("unknown_outcome");
    expect(gh.pulls).toHaveLength(1);
    const done = await w.rt.reconcileAction("gh2", action!.operation_key);
    expect(done.state).toBe("succeeded");
    expect(gh.pulls).toHaveLength(1);
    expect(done.result).toMatchObject({ number: 1, operation: action!.operation_key });
  });

  it("sends again a request that never arrived, reusing the branch, and still opens one pull request", async () => {
    const gh = new FakeGitHub("company/backend");
    gh.pullFaults.push("network");
    const w = await fixbug(gh);
    expect((await approved(w, "gh3")).state).toBe("attention_required");
    const [action] = await w.rt.journal.actions("gh3");
    const done = await w.rt.reconcileAction("gh3", action!.operation_key);
    expect(done.state).toBe("succeeded");
    expect(gh.pulls).toHaveLength(1);
    expect(gh.calls.filter((c) => c === "PATCH /repos/company/backend/git/refs/heads/" + gh.pulls[0]!.head.ref)).toHaveLength(1);
  });

  it("resolves an action that never took effect when the run is cancelled (§16.1 Cancel)", async () => {
    const gh = new FakeGitHub("company/backend");
    gh.pullFaults.push(500);
    const w = await fixbug(gh);
    expect((await approved(w, "gh4")).state).toBe("attention_required");
    const cancelled = await w.rt.cancelRun("gh4");
    expect(cancelled.state).toBe("cancelled");
    const [action] = await w.rt.journal.actions("gh4");
    expect(action).toMatchObject({ state: "cancelled", detail: { cancelled: expect.stringContaining("no pull request") } });
    expect(gh.pulls).toHaveLength(0);
  });

  it("does not start a run bound to another repository (§16.1 ValidateBinding)", async () => {
    const gh = new FakeGitHub("onurkoocc/mandate-fixbug-target");
    const w = await fixbug(gh, "onurkoocc/mandate-fixbug-target");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "gh5" })).rejects.toMatchObject({ code: "unsupported_binding" });
    expect(gh.calls).toHaveLength(0);
  });

  it("refuses at prepare a draft whose files are not in the working copy", async () => {
    const adapter = new GitHubPullRequests({ token: "t", repo: "company/backend", workdir, fetch: new FakeGitHub("company/backend").fetch });
    expect(await adapter.prepare([{ issue: { id: "1" }, patch: { files: ["src/missing.ts"] } }])).toEqual({ rejected: "src/missing.ts does not exist in the working copy" });
    expect(await adapter.prepare([{ issue: { id: "1" }, patch: { files: ["../etc/passwd"] } }])).toEqual({ rejected: "../etc/passwd is outside the working copy" });
    expect(await adapter.prepare([{ issue: { id: "1" }, patch: { files: ["src/a.ts"] } }])).toEqual({ prepared: true, artifacts: [{ path: "src/a.ts", content: "export const a = 2;\n" }] });
  });

  it("sends the files as they were frozen at prepare, not as the working copy has them at execute (§8.8)", async () => {
    const gh = new FakeGitHub("company/backend");
    const w = await fixbug(gh);
    const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "gh6", authorize: { "git.open_pr": { by: "human", role: "maintainer" } } });
    const owner = waitOf(waiting.waiting);
    const prepared = await w.rt.decideAction("gh6", { sender: "carol", messageId: "a1" }, { commandId: owner.command, revision: waiting.revision, digest: String(owner.request["subject_digest"]), approve: true, by: "carol" });
    // The action is prepared and waits for the maintainer; meanwhile the working copy changes.
    const authorize = waitOf(prepared.waiting);
    expect(authorize.request).toMatchObject({ effect: "git.open_pr", role: "maintainer" });
    const [action] = await w.rt.journal.actions("gh6");
    expect(action!.artifacts).toMatchObject({ "src/a.ts": { ref: expect.stringMatching(/^blob:sha256:/) } });
    writeFileSync(join(workdir, "src", "a.ts"), "export const a = 666;\n");
    try {
      const done = await w.rt.decideAction("gh6", { sender: "dave", messageId: "a2" }, { commandId: authorize.command, revision: prepared.revision, digest: String(authorize.request["action_digest"]), approve: true, by: "dave" });
      expect(done.state).toBe("succeeded");
      expect(gh.filesOf(gh.pulls[0]!.head.ref)!.get("src/a.ts")).toBe("export const a = 2;\n");
    } finally {
      writeFileSync(join(workdir, "src", "a.ts"), "export const a = 2;\n");
    }
  });
});
