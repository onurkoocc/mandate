// A rehearsal of the Gate 3 acceptance run (P1-10) that spends nothing:
// examples/fixbug-target/fixbug.mdt against the seeded project at
// /work/repo, every agent and every test in a real Bubblewrap sandbox, the
// real verifier, a scripted model and an in-memory GitHub. Linux with
// MANDATE_MXC=1 only (CI job `sandbox`); /work must be writable.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, type Lock } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelAdapter, TurnRequest } from "../src/adapters.js";
import { GitHubPullRequests } from "../src/github.js";
import { MxcHost } from "../src/mxc.js";
import { buildPackage, Runtime } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimChat, toolUse, wallClock, type SimTurn } from "../src/sim.js";
import { SandboxVerifier } from "../src/verifier.js";
import { FakeGitHub } from "./fake-github.js";
import { closeAll, world } from "./helpers.js";

const REAL = process.platform === "linux" && process.env["MANDATE_MXC"] === "1";
const example = (f: string) => new URL(`../../examples/fixbug-target/${f}`, import.meta.url);
const WORK = "/work/repo";

const FIXED = (readFileSync(example("seed/src/pagination.ts"), "utf8") as string).replace("Math.floor(total / perPage)", "Math.ceil(total / perPage)");
const REGRESSION = `import assert from "node:assert/strict";
import { test } from "node:test";
import { page, pageCount } from "../src/pagination.ts";

test("counts and returns a partial last page (issue #1)", () => {
  assert.equal(pageCount(11, 5), 3);
  assert.deepEqual(page([1, 2, 3, 4, 5], 3, 2), [5]);
});
`;

/** What each agent does, turn by turn. */
const SCRIPTS: Record<string, SimTurn[]> = {
  Explorer: [
    [toolUse("e1", "grep", { pattern: "Math\\.floor", path: "src" })],
    [toolUse("e2", "finish", { result: [{ file: "src/pagination.ts", line: 6, claim: "pageCount rounds down, losing the partial last page", evidence: "Math.floor(total / perPage)" }] })],
  ],
  Planner: [[toolUse("p1", "finish", { result: { steps: ["Round the page count up with Math.ceil"], touches: ["src/pagination.ts"], risks: [] } })]],
  Implementer: [
    [toolUse("i1", "read_file", { path: "src/pagination.ts" })],
    [toolUse("i2", "write_file", { path: "src/pagination.ts", content: FIXED })],
    [toolUse("i3", "run", { command: "node", args: ["--test", "test/pagination.test.ts"] })],
    [toolUse("i4", "finish", { result: { files: ["src/pagination.ts"], summary: "pageCount rounds up" } })],
  ],
  TestWriter: [
    [toolUse("t1", "write_file", { path: "test/partial-page.test.ts", content: REGRESSION })],
    [toolUse("t2", "finish", { result: { files: ["test/partial-page.test.ts"], cases: ["a partial last page"] } })],
  ],
  Reviewer: [[toolUse("r1", "finish", { result: { counterexamples: [], blocking: false } })]],
};

function script(req: TurnRequest): SimTurn {
  const agent = Object.keys(SCRIPTS).find((a) => req.system.startsWith(`You are ${a},`))!;
  const turn = req.messages.filter((m) => (m as { role?: string }).role === "assistant").length;
  return SCRIPTS[agent]![turn]!;
}

describe.runIf(REAL)("Gate 3 rehearsal: FixBug on the seeded project in Bubblewrap sandboxes", () => {
  afterAll(async () => {
    rmSync(WORK, { recursive: true, force: true });
    await closeAll();
  });

  it("finds, fixes and tests the bug, checks the contract in its own sandboxes, waits for the owner, and opens one pull request", async () => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(dirname(WORK), { recursive: true });
    cpSync(example("seed"), WORK, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", WORK, "-c", "user.email=gate3@mandate", "-c", "user.name=gate3", ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    git("tag", "seed");

    const src = readFileSync(example("fixbug.mdt"), "utf8");
    const lockJson = JSON.parse(readFileSync(example("mandate.lock.json"), "utf8")) as Lock;
    const { lock: _format, ...lock } = lockJson;
    expect(check(src, "mdt", { lock: lockJson }).ok).toBe(true);
    const w = await world(src, { lock });

    const node = dirname(dirname(process.execPath));
    const host = new MxcHost({ baseline: [node] });
    const sandbox = new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true });
    const chat = new SimChat(script);
    const review: ModelAdapter = { upperBound: () => ({}), infer: async () => ({ ok: { blocking: false, findings: [] }, cost: {} }) };
    const gh = new FakeGitHub("onurkoocc/mandate-fixbug-target");
    w.adapters.loop = { chat, sandbox };
    w.adapters.verifier = new SandboxVerifier({ workdir: WORK, base: "seed", suites: { unit: "test/**/*.test.ts", integration: "acceptance/**/*.test.ts" } }, sandbox, review);
    w.adapters.tools["git.open_pr"] = new GitHubPullRequests({ token: "t", repo: "onurkoocc/mandate-fixbug-target", workdir: WORK, fetch: gh.fetch });
    w.adapters.clock = wallClock;
    const rt = new Runtime(w.db, w.adapters);

    const issue = JSON.parse(readFileSync(example("issue.json"), "utf8")) as { issue: Record<string, unknown> };
    const waiting = await rt.startRun({ pkg: buildPackage(check(src, "mdt").program!, lock), workflow: "FixBug", input: issue as never, runId: "g3" });
    const evidence = await rt.evidence("g3");
    expect(waiting.state, JSON.stringify({ attention: waiting.attention, error: waiting.error, evidence })).toBe("waiting");
    expect(Object.fromEntries(evidence.map((e) => [e.criterion, e.passed]))).toMatchObject({ regression_test: true, scope_respected: true, suite_green: true, no_blocking_review: true });

    // The agents' work stayed in their grants: the fix in src/, the test in test/, the acceptance tests untouched.
    expect(readFileSync(join(WORK, "src/pagination.ts"), "utf8")).toBe(FIXED);
    expect(existsSync(join(WORK, "test/partial-page.test.ts"))).toBe(true);
    expect(git("status", "--porcelain", "acceptance")).toBe("");
    expect(chat.calls).toHaveLength(Object.values(SCRIPTS).reduce((n, s) => n + s.length, 0));

    const wait = waiting.waiting as { command: string; request: { subject_digest: string; role: string } };
    expect(wait.request.role).toBe("code_owner");
    const done = await rt.decideAction("g3", { sender: "owner", messageId: "m1" }, { commandId: wait.command, revision: waiting.revision, digest: wait.request.subject_digest, approve: true, by: "owner" });
    expect(done.state, JSON.stringify(done.attention ?? done.error)).toBe("succeeded");
    expect(gh.pulls).toHaveLength(1);
    const files = gh.filesOf(gh.pulls[0]!.head.ref)!;
    expect(files.get("src/pagination.ts")).toBe(FIXED);
    expect(files.get("test/partial-page.test.ts")).toBe(REGRESSION);
    expect(await rt.replayRun("g3")).toEqual({ status: "complete", value: done.result });
  });
});
