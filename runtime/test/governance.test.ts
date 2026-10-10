// Governance-class files (K70; BACKLOG item 46). A change to a file that
// decides what the next run may do (a CI workflow, a lockfile, agent
// settings, the Mandate lock, CODEOWNERS, or a component's own pattern)
// needs the code owner's approval. A run's policy never lowers it, and
// another approver does not replace it: the owner decides first. The change
// set view shows these files as a class of their own.

import { readFileSync } from "node:fs";
import { toMarkdown } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import type { PreparedFile } from "../src/adapters.js";
import type { RunRow } from "../src/journal.js";
import { SimTool, SimWorkspace } from "../src/sim.js";
import { isObj, type Obj, type Value } from "../src/values.js";
import { runDoc, runView } from "../src/views.js";
import { acmeModules, lockFor } from "./acme.js";
import { closeAll, world, type World } from "./helpers.js";

afterAll(closeAll);

const LOOSEN_CI = readFileSync(new URL("../../fixtures/system/loosen-ci.mdt", import.meta.url), "utf8");

/** git.merge for a change set member: prepare freezes the files its change names, from core's working copy. */
class MemberMerge extends SimTool {
  constructor(readonly copy: SimWorkspace) {
    super("git.merge", "reconcilable");
  }
  override async prepare(params: Value): Promise<{ prepared: true; artifacts?: PreparedFile[] } | { rejected: string }> {
    this.prepares.push(params);
    const change = Array.isArray(params) && isObj(params[1] ?? null) ? (params[1] as Obj) : {};
    const files = Array.isArray(change["files"]) ? change["files"].map(String) : [];
    return { prepared: true, artifacts: files.map((f) => ({ path: f, content: this.copy.files.get(f) ?? "" })) };
  }
}

const CORE = new SimWorkspace({
  "src/main/java/Api.java": "class Api { /* faster */ }\n",
  // The agent's change drops the test step from core's CI.
  ".github/workflows/ci.yml": "on: [push]\njobs:\n  build:\n    steps:\n      - run: mvn -B -q -DskipTests package\n",
  "deploy/release.sh": "#!/bin/sh\nkubectl apply -f deploy/\n",
});

async function acme(): Promise<World & { merge: MemberMerge }> {
  const modules = acmeModules();
  const merge = new MemberMerge(CORE);
  const w = await world(LOOSEN_CI, { modules, lock: lockFor(modules), tools: [merge] });
  return { ...w, merge };
}

const waiting = (run: RunRow): { command: string; request: Obj } => {
  expect(run.state, JSON.stringify(run.error ?? run.attention)).toBe("waiting");
  return run.waiting as { command: string; request: Obj };
};

function decide(w: World, run: RunRow, approve: boolean, n: number): Promise<RunRow> {
  const { command, request } = waiting(run);
  const by = String(request["role"]);
  return w.rt.decideAction(run.run_id, { sender: by, messageId: `${run.run_id}-${n}` }, { commandId: command, revision: run.revision, digest: String(request["action_digest"]), approve, by });
}

/** Under this policy nothing would ask a person about git.merge: only a governance-class file does. */
const byPolicy = { "git.merge": { by: "policy" as const } };

describe("a change that loosens CI (K70, item 46)", () => {
  it("does not land until core's owner approves it, although the run's policy authorizes git.merge", async () => {
    const w = await acme();
    const files = ["src/main/java/Api.java", ".github/workflows/ci.yml"];
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Speed", input: { task: "faster builds", files }, runId: "gov1", authorize: byPolicy });
    // The policy does not decide: core's owner does, and sees which file is why.
    const { request } = waiting(run);
    expect(request).toMatchObject({ role: "core_owner", component: "core", governance: [{ file: ".github/workflows/ci.yml", kind: "ci" }] });
    const declined = await decide(w, run, false, 1);
    expect(declined.state).toBe("failed");
    expect(declined.error).toMatchObject({ $tag: "Rejected", $args: [{ denied_by: "core_owner", governance: [{ file: ".github/workflows/ci.yml", kind: "ci" }] }] });
    expect(w.merge.executions).toEqual([]);
  });

  it("lands once the owner approves, and the view shows the workflow as a governance-class file", async () => {
    const w = await acme();
    const files = ["src/main/java/Api.java", ".github/workflows/ci.yml"];
    let run = await w.rt.startRun({ pkg: w.pkg, workflow: "Speed", input: { task: "faster builds", files }, runId: "gov2", authorize: byPolicy });
    run = await decide(w, run, true, 1);
    // The architect sees the set, with core's governance-class file named.
    const set = waiting(run).request;
    expect(set["role"]).toBe("architect");
    expect((set["members"] as Obj[])[0]).toMatchObject({ component: "core", governance: [{ file: ".github/workflows/ci.yml", kind: "ci" }] });
    run = await decide(w, run, true, 2);
    expect(run.state, JSON.stringify(run.error ?? run.attention)).toBe("succeeded");
    expect(w.merge.executions).toHaveLength(1);

    const { view, program } = await runView(w.rt, "gov2");
    const [cs] = view.changesets;
    expect(cs!.components[0]).toMatchObject({ component: "core", files: [".github/workflows/ci.yml", "src/main/java/Api.java"], governance: [{ file: ".github/workflows/ci.yml", kind: "ci" }], owner: "core_owner" });
    const md = toMarkdown(runDoc(view, program));
    expect(md).toContain("Governance-class files: they change what the next run may do");
    expect(md).toContain("| core | ` .github/workflows/ci.yml ` | CI | core\\_owner (the owner; also approves the member) |");
  });

  it("asks no one for a change without one: the run's policy authorizes the member", async () => {
    const w = await acme();
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Speed", input: { task: "faster code", files: ["src/main/java/Api.java"] }, runId: "gov3", authorize: byPolicy });
    expect(waiting(run).request["role"]).toBe("architect");
    const done = await decide(w, run, true, 1);
    expect(done.state).toBe("succeeded");
    const [cs] = (await runView(w.rt, "gov3")).view.changesets;
    expect(cs!.components[0]!.governance).toEqual([]);
  });

  it("asks core's owner before the member's own approver, for core's own pattern too; the owner's decision authorizes nothing by itself", async () => {
    const w = await acme();
    const files = ["deploy/release.sh", "src/main/java/Api.java"];
    let run = await w.rt.startRun({ pkg: w.pkg, workflow: "Release", input: { task: "release", files }, runId: "gov4" });
    const gate = waiting(run).request;
    expect(gate).toMatchObject({ gate: "governance", role: "core_owner", then: "release_manager", governance: [{ file: "deploy/release.sh", kind: "component" }] });
    run = await decide(w, run, true, 1);
    // A gate, not an authorization: nothing could commit on the owner's word alone.
    expect(await w.db.query("select authorization_id from authorizations where run_id = 'gov4'")).toEqual([]);
    expect((await w.rt.journal.events("gov4")).some((e) => e.type === "governance_approved")).toBe(true);
    expect(waiting(run).request).toMatchObject({ role: "release_manager", governance: [{ file: "deploy/release.sh", kind: "component" }] });
    run = await decide(w, run, true, 2);
    expect(waiting(run).request["role"]).toBe("architect");
    run = await decide(w, run, true, 3);
    expect(run.state).toBe("succeeded");

    // The owner declining stops it before the release manager is asked.
    const w2 = await acme();
    const r2 = await w2.rt.startRun({ pkg: w2.pkg, workflow: "Release", input: { task: "release", files }, runId: "gov5" });
    const stopped = await decide(w2, r2, false, 1);
    expect(stopped.state).toBe("failed");
    expect((await w2.rt.journal.events("gov5")).some((e) => e.type === "governance_denied")).toBe(true);
    expect(w2.merge.executions).toEqual([]);
  });
});

/** FixBug's last step, outside any system model: a pull request opened once the code owner approved the draft. */
const OPEN_PR = `mandate @ 0.3
module gov.pull @ 0.1
use std.{git, human}
use company.domain.{PullRequestDraft}

capability PR = git.pr("company/backend")

contract Approved(draft: PullRequestDraft) {
  accept reviewed "A person read the draft" by human.approve(role: "code_owner")
}

workflow Open(draft: PullRequestDraft) -> Bool
  caps PR
{
  let checked = verify draft against Approved(draft)
  effect git.open_pr(checked)
    idempotent_by draft.issue.id
  true
}
`;

describe("a pull request that changes agent settings (K70: Core, not only change sets)", () => {
  it("is opened only after the runtime's owner approves it, although git.open_pr is authorized by policy", async () => {
    const ws = new SimWorkspace({ "src/a.ts": "fixed\n", ".claude/settings.json": '{ "permissions": { "allow": ["Bash(*)"] } }\n' });
    const pr = new SimTool("git.open_pr", "idempotent", ws);
    const w = await world(OPEN_PR, { tools: [pr] });
    const draft = { issue: { id: "BUG-9" }, patch: { files: ["src/a.ts", ".claude/settings.json"] }, tests: { files: [] } };
    let run = await w.rt.startRun({ pkg: w.pkg, workflow: "Open", input: { draft }, runId: "gov6" });
    // The draft's reviewer first (a criterion), then the owner for the settings file.
    const review = waiting(run);
    run = await w.rt.decideAction("gov6", { sender: "r", messageId: "r1" }, { commandId: review.command, revision: run.revision, digest: String(review.request["subject_digest"]), approve: true, by: "code_owner" });
    expect(waiting(run).request).toMatchObject({ effect: "git.open_pr", role: "owner", governance: [{ file: ".claude/settings.json", kind: "agent_settings" }] });
    expect(pr.executions).toEqual([]);
    run = await decide(w, run, true, 2);
    expect(run.state).toBe("succeeded");
    expect(pr.executions).toHaveLength(1);
  });
});
