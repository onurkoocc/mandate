// Change sets (design doc 9 §3; BACKLOG item 32, B4). Kervan's three-member
// set (auth, core, mcp) is prepared, approved by each component's owner and
// then by the architect over the set digest S, and committed in the order the
// interface graph asks for. An unknown outcome on the middle member stops the
// set as `changeset_partial`, and reconciliation takes it on from there; an
// approval binds to S, so a set with another member is another approval.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { GitHubMerges } from "../src/github-merge.js";
import type { RunRow } from "../src/journal.js";
import { buildPackage, Runtime } from "../src/runtime.js";
import { SimTool } from "../src/sim.js";
import { isObj, type Obj } from "../src/values.js";
import type { WorkspaceAdapter } from "../src/workspace.js";
import { fakeGitHubs } from "./fake-github.js";
import { closeAll, world, type World } from "./helpers.js";
import { KERVAN_SOURCE, kervanModules, lockFor } from "./kervan.js";
import { LAND } from "./kervan-changeset.js";

afterAll(closeAll);

async function land(o: { tool?: SimTool; src?: string } = {}): Promise<World & { merge: SimTool }> {
  const modules = kervanModules();
  const merge = o.tool ?? new SimTool("git.merge", "reconcilable");
  const w = await world(o.src ?? LAND, { modules, lock: lockFor(modules), tools: [merge] });
  return { ...w, merge };
}

/** Approves every decision the run waits for, as the role it asks for; returns the run and who approved, in order. */
async function approveAll(w: World, run: RunRow): Promise<{ run: RunRow; roles: string[]; requests: Obj[] }> {
  const roles: string[] = [];
  const requests: Obj[] = [];
  let n = 0;
  while (run.state === "waiting" && isObj(run.waiting) && run.waiting["kind"] === "decision") {
    const req = run.waiting["request"] as Obj;
    roles.push(String(req["role"]));
    requests.push(req);
    run = await w.rt.decideAction(run.run_id, { sender: String(req["role"]), messageId: `m${++n}` }, { commandId: String(run.waiting["command"]), revision: run.revision, digest: String(req["action_digest"]), approve: true, by: String(req["role"]) });
  }
  return { run, roles, requests };
}

const componentOf = (w: World & { merge: SimTool }, op: string): string => {
  const p = w.merge.executions.find((e) => e.operationKey === op)!.params as Obj[];
  return String(p[0]!["component"]);
};

describe("a change set over Kervan (B4)", () => {
  it("asks each owner for its member, then the architect for the set, and lands the members in order", async () => {
    const w = await land();
    const started = await w.rt.startRun({ pkg: w.pkg, workflow: "Land", input: { task: "add scope" }, runId: "cs1" });
    const { run, roles, requests } = await approveAll(w, started);
    expect(run.state, JSON.stringify(run.attention ?? run.error)).toBe("succeeded");
    expect(roles).toEqual(["identity_owner", "core_owner", "support_platform_owner", "architect"]);
    // The architect sees the whole set: members in order with their digests, and the declared interface changes.
    const set = requests[3]!;
    expect(set["order"]).toEqual(["auth", "core", "mcp"]);
    expect(set["changes"]).toEqual({ CoreApi: "additive", TokenIssuance: "additive" });
    expect((set["members"] as Obj[]).map((m) => [m["component"], m["approver"], m["action_digest"]])).toEqual(requests.slice(0, 3).map((r) => [r["component"], r["role"], r["action_digest"]]));
    expect(w.merge.executions.map((e) => componentOf(w, e.operationKey))).toEqual(["auth", "core", "mcp"]);
    // Each member names its component and the base commit the run started from.
    expect((w.merge.executions[1]!.params as Obj[])[0]).toEqual({ base: "core-commit-1", component: "core", repo: "onurkoocc/kervan-core", root: "/work/kervan-core" });
    const [cs] = await w.rt.journal.changesets("cs1");
    expect(cs).toMatchObject({ state: "committed", set_digest: set["action_digest"] });
    expect(await w.rt.replayRun("cs1")).toEqual({ status: "complete", value: "landed" });
  });

  it("stops at an unknown outcome on the middle member: auth applied, core unknown, mcp not sent; reconciliation finds core applied and the set goes on", async () => {
    const w = await land({ tool: new SimTool("git.merge", "reconcilable").then("confirm", "lose_response") });
    const { run } = await approveAll(w, await w.rt.startRun({ pkg: w.pkg, workflow: "Land", input: { task: "t" }, runId: "cs2" }));
    expect(run.state).toBe("attention_required");
    const partial = (run.attention as Obj)["changeset_partial"] as Obj;
    expect((partial["applied"] as Obj[]).map((a) => a["component"])).toEqual(["auth"]);
    expect(partial["stopped_at"]).toMatchObject({ component: "core", state: "unknown_outcome" });
    expect(partial["not_sent"]).toEqual(["mcp"]);
    // Compensation is offered, never run (§8.5).
    expect(partial["compensation"]).toEqual([{ component: "auth", effect: "git.revert", undoes: w.merge.executions[0]!.operationKey }]);
    expect(w.merge.executions).toHaveLength(2);
    expect((await w.rt.journal.changesets("cs2"))[0]!.state).toBe("partial");

    const core = (partial["stopped_at"] as Obj)["operation"] as string;
    const after = await w.rt.reconcileAction("cs2", core);
    expect(after.state, JSON.stringify(after.attention ?? after.error)).toBe("succeeded");
    expect(w.merge.executions.map((e) => componentOf(w, e.operationKey))).toEqual(["auth", "core", "mcp"]);
    expect(w.merge.appliedCount()).toBe(3);
    expect((await w.rt.journal.changesets("cs2"))[0]!.state).toBe("committed");
  });

  it("when reconciliation proves the middle member did not land, sends it again under the same operation, once applied", async () => {
    const w = await land({ tool: new SimTool("git.merge", "reconcilable").then("confirm", "timeout") });
    const { run } = await approveAll(w, await w.rt.startRun({ pkg: w.pkg, workflow: "Land", input: { task: "t" }, runId: "cs3" }));
    expect(run.state).toBe("attention_required");
    const core = ((run.attention as Obj)["changeset_partial"] as Obj)["stopped_at"] as Obj;
    const after = await w.rt.reconcileAction("cs3", String(core["operation"]));
    expect(after.state, JSON.stringify(after.attention ?? after.error)).toBe("succeeded");
    const sent = w.merge.executions.map((e) => componentOf(w, e.operationKey));
    expect(sent).toEqual(["auth", "core", "core", "mcp"]);
    expect(w.merge.executions[1]!.operationKey).toBe(w.merge.executions[2]!.operationKey);
    expect(w.merge.appliedCount()).toBe(3);
  });

  it("fails cleanly when the first member is refused: nothing landed, nothing else sent", async () => {
    const w = await land({ tool: new SimTool("git.merge", "reconcilable").then("reject") });
    const { run } = await approveAll(w, await w.rt.startRun({ pkg: w.pkg, workflow: "Land", input: { task: "t" }, runId: "cs4" }));
    expect(run.state).toBe("failed");
    expect(w.merge.executions).toHaveLength(1);
    expect((await w.rt.journal.changesets("cs4"))[0]!.state).toBe("failed");
  });

  it("binds approvals to the set: another member is another set digest, and an approval of one set never commits another", async () => {
    const a = await land();
    const first = await approveAll(a, await a.rt.startRun({ pkg: a.pkg, workflow: "Land", input: { task: "t" }, runId: "cs5" }));
    const s1 = String(first.requests[3]!["action_digest"]);

    // The same set, except that core's change touches one more file.
    const b = await land({ src: LAND.replace('let c = verify Change { files: ["src/main/java/Api.java"] } against ChangeAccepted(Change { files: ["src/main/java/Api.java"] })', 'let c = verify Change { files: ["src/main/java/Api.java", "src/main/java/Scopes.java"] } against ChangeAccepted(Change { files: ["src/main/java/Api.java", "src/main/java/Scopes.java"] })') });
    let run = await b.rt.startRun({ pkg: b.pkg, workflow: "Land", input: { task: "t" }, runId: "cs6" });
    for (let i = 0; i < 3; i++) {
      const req = (run.waiting as Obj)["request"] as Obj;
      run = await b.rt.decideAction("cs6", { sender: "o", messageId: `o${i}` }, { commandId: String((run.waiting as Obj)["command"]), revision: run.revision, digest: String(req["action_digest"]), approve: true, by: String(req["role"]) });
    }
    const setWait = run.waiting as Obj;
    const s2 = String((setWait["request"] as Obj)["action_digest"]);
    expect(s2).not.toBe(s1);
    // The architect's approval of the first set does not apply to this one.
    await expect(b.rt.decideAction("cs6", { sender: "architect", messageId: "a1" }, { commandId: String(setWait["command"]), revision: run.revision, digest: s1, approve: true, by: "architect" })).rejects.toThrow(/names something other than what is waiting/);
    expect(b.merge.executions).toHaveLength(0);

    // And a set authorization for another digest never commits a member (E0406).
    const [cs] = await b.rt.journal.changesets("cs6");
    const member = (cs!.members as Obj[])[0]!;
    await b.db.query("insert into authorizations (authorization_id, run_id, action_digest, decided_by, expires_at) values ('forged', 'cs6', $1, 'architect', null)", [s1]);
    await b.db.query("insert into authorizations (authorization_id, run_id, action_digest, decided_by, expires_at) values ('member', 'cs6', $1, 'identity_owner', null)", [member["action_digest"]]);
    const fence = (await b.rt.getRun("cs6")).fence;
    await expect(b.rt.journal.commit("cs6", fence, String(member["operation"]), "member", { key: cs!.set_key, digest: cs!.set_digest, authorizationId: "forged" })).rejects.toThrow(/another change set/);
  });
});

describe("git.merge on GitHub (B4)", () => {
  it("lands each member on its repository from the run's base commit, merged at the head it made; a lost merge answer is reconciled", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mandate-merge-"));
    try {
      const roots = { auth: join(tmp, "kervan-auth"), core: join(tmp, "kervan-core"), mcp: join(tmp, "kervan-mcp") };
      let src = KERVAN_SOURCE;
      for (const [c, r] of Object.entries(roots)) src = src.replace(`"/work/kervan-${c}"`, JSON.stringify(r.replace(/\\/g, "/")));
      const modules = kervanModules(src);
      const files: Record<string, string> = { auth: "src/token.ts", core: "src/main/java/Api.java", mcp: "src/tools.ts" };
      for (const [c, f] of Object.entries(files)) {
        mkdirSync(join(roots[c as keyof typeof roots], f, ".."), { recursive: true });
        writeFileSync(join(roots[c as keyof typeof roots], f), `// ${c} change\n`);
      }
      const gh = fakeGitHubs(["onurkoocc/kervan-auth", "onurkoocc/kervan-core", "onurkoocc/kervan-mcp"]);
      gh.repos["onurkoocc/kervan-core"]!.mergeFaults.push("lose_response");
      const merges = new GitHubMerges({ token: "t", repos: Object.keys(gh.repos), fetch: gh.fetch });
      // The base each run starts from is each repository's main.
      const workspace: WorkspaceAdapter = { prepare: async (cs) => Object.fromEntries(cs.map((c) => [c.name, { base: gh.repos[c.repo]!.refs.get("heads/main")! }])) };

      const w = await world(LAND, { modules, lock: lockFor(modules) });
      w.adapters.tools["git.merge"] = merges;
      w.adapters.workspace = workspace;
      const rt = new Runtime(w.db, w.adapters);
      const program = check(LAND, "mdt", { modules }).program!;
      const { run } = await approveAll({ ...w, rt }, await rt.startRun({ pkg: buildPackage(program, lockFor(modules), modules), workflow: "Land", input: { task: "scope" }, runId: "gm1" }));
      expect(run.state).toBe("attention_required");
      const stopped = ((run.attention as Obj)["changeset_partial"] as Obj)["stopped_at"] as Obj;
      expect(stopped).toMatchObject({ component: "core", state: "unknown_outcome" });
      expect(gh.repos["onurkoocc/kervan-mcp"]!.pulls).toHaveLength(0);

      const done = await rt.reconcileAction("gm1", String(stopped["operation"]));
      expect(done.state, JSON.stringify(done.attention ?? done.error)).toBe("succeeded");
      for (const [c, f] of Object.entries(files)) {
        const repo = gh.repos[`onurkoocc/kervan-${c}`]!;
        expect(repo.pulls).toHaveLength(1);
        expect(repo.pulls[0]!.merged).toBe(true);
        expect(repo.filesOf("main")!.get(f)).toBe(`// ${c} change\n`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
