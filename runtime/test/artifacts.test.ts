// The artifact store (P2-12, Doc 4 §16.1) and the binding of evidence to the
// artifacts it checked: G01 (an artifact changed after its test cannot be
// committed on the old evidence) and G08 (another tenant's or run's artifact
// is refused without saying whether it exists).

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore, DirBlobs, MemoryBlobs, sha256Of } from "../src/artifacts.js";
import { SimTool, SimVerifier, SimWorkspace } from "../src/sim.js";
import { isObj } from "../src/values.js";
import { BUG, FIXBUG, fixbugAgents, waitOf } from "./fixbug.js";
import { closeAll, world, type World } from "./helpers.js";

afterAll(closeAll);

const A = { tenant: "acme", runId: "r1" };

describe("the artifact store (§16.1)", () => {
  it("stores bytes once by content and reads them back only in the run that recorded them (G08)", async () => {
    const w = await world(FIXBUG);
    const blobs = new MemoryBlobs();
    const store = new ArtifactStore(w.db, blobs);
    const ref = await store.put(A, "test log: 3 passed\n");
    expect(ref).toEqual({ ref: `blob:${sha256Of("test log: 3 passed\n")}`, digest: sha256Of("test log: 3 passed\n"), size: 19, media_type: "text/plain; charset=utf-8" });
    expect(await store.text(A, ref.ref)).toBe("test log: 3 passed\n");
    expect(await store.put(A, "test log: 3 passed\n")).toEqual(ref);

    // Another tenant, another run of the same tenant, and a digest nobody stored are refused alike.
    const missing = `blob:${sha256Of("never stored")}`;
    const refusals = await Promise.all(
      [
        () => store.get({ tenant: "other", runId: "r1" }, ref.ref),
        () => store.get({ tenant: "acme", runId: "r2" }, ref.ref),
        () => store.get(A, missing),
        () => store.get(A, "sha256:not-a-ref"),
      ].map((f) => f().then(() => "read", (e: Error & { code?: string }) => `${e.code}: ${e.message}`)),
    );
    expect(new Set(refusals)).toEqual(new Set(["artifact_not_found: artifact_not_found: No such artifact in this run."]));

    // Bytes that no longer match their digest are never handed out.
    blobs.tamper(ref.digest, new TextEncoder().encode("test log: 3 passed!\n"));
    await expect(store.get(A, ref.ref)).rejects.toMatchObject({ code: "artifact_corrupt" });
  });

  it("keeps bytes in a content-addressed directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-blobs-"));
    try {
      const w = await world(FIXBUG);
      const store = new ArtifactStore(w.db, new DirBlobs(dir));
      const ref = await store.put(A, new Uint8Array([0, 1, 2, 255]), "application/octet-stream");
      const hex = ref.digest.slice("sha256:".length);
      await expect(new DirBlobs(dir).get(ref.digest)).resolves.toEqual(new Uint8Array([0, 1, 2, 255]));
      expect(existsSync(join(dir, "sha256", hex.slice(0, 2), hex))).toBe(true);
      expect((await store.get(A, ref.ref)).media_type).toBe("application/octet-stream");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evidence is bound to the artifacts it checked (G01)", () => {
  async function fixbug(): Promise<World & { pr: SimTool; ws: SimWorkspace }> {
    const ws = new SimWorkspace({ "src/a.ts": "export const limit = 10;\n", "test/a.test.ts": "test('limit')\n" });
    const pr = new SimTool("git.open_pr", "idempotent", ws);
    const w = await world(FIXBUG, { tools: [pr], agents: fixbugAgents(), verifier: new SimVerifier({}, ws) });
    return { ...w, pr, ws };
  }

  async function toOwner(w: World, runId: string) {
    const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId });
    expect(waiting.state).toBe("waiting");
    const wait = waitOf(waiting.waiting);
    return (by: string) =>
      w.rt.decideAction(runId, { sender: by, messageId: `${runId}-${by}` }, { commandId: wait.command, revision: waiting.revision, digest: String(wait.request["subject_digest"]), approve: true, by });
  }

  it("records what each test ran against, and commits the files with those bytes", async () => {
    const w = await fixbug();
    const approve = await toOwner(w, "g01a");
    const tests = (await w.rt.evidence("g01a")).filter((e) => e.method.startsWith("test."));
    expect(tests.map((e) => e.criterion).sort()).toEqual(["regression_test", "suite_green"]);
    for (const e of tests) {
      expect(e.subject).toMatchObject({ files: { "src/a.ts": sha256Of("export const limit = 10;\n") }, tree: expect.stringMatching(/^blob:sha256:/) });
      // The tree is an artifact of the run.
      const tree = JSON.parse(new TextDecoder().decode((await w.rt.artifact("g01a", String((e.subject as { tree: string }).tree))).bytes)) as unknown;
      expect(tree).toEqual({ format: "mandate/tree/0.1", files: (e.subject as { files: unknown }).files });
    }
    const done = await approve("carol");
    expect(done.state).toBe("succeeded");
    const [action] = await w.rt.journal.actions("g01a");
    expect(w.pr.sent.get(action!.operation_key)).toEqual({ "src/a.ts": "export const limit = 10;\n" });
    expect(await w.rt.replayRun("g01a")).toEqual({ status: "complete", value: done.result });
  });

  it("refuses to commit a file changed after its test: the evidence is stale", async () => {
    const w = await fixbug();
    const approve = await toOwner(w, "g01b");
    // While the code owner looks, someone changes the tested file.
    w.ws.write("src/a.ts", "export const limit = 1000;\n");
    const after = await approve("carol");
    expect(after.state).toBe("attention_required");
    expect(after.attention).toMatchObject({ violation: "stale_evidence" });
    expect(String(isObj(after.attention) ? after.attention["message"] : "")).toContain("src/a.ts (regression_test: changed since the check)");
    expect(w.pr.executions).toHaveLength(0);
    expect(await w.rt.journal.actions("g01b")).toHaveLength(0);
  });

  it("refuses a file the checks never saw", async () => {
    const ws = new SimWorkspace({ "src/a.ts": "export const limit = 10;\n" });
    const pr = new SimTool("git.open_pr", "idempotent", ws);
    const verifier = new SimVerifier({}, new SimWorkspace({ "README.md": "nothing tested here\n" }));
    const w = await world(FIXBUG, { tools: [pr], agents: fixbugAgents(), verifier });
    const approve = await toOwner(w, "g01c");
    const after = await approve("carol");
    expect(after.attention).toMatchObject({ violation: "stale_evidence" });
    expect(String(isObj(after.attention) ? after.attention["message"] : "")).toContain("not in what was checked");
    expect(pr.executions).toHaveLength(0);
  });
});
