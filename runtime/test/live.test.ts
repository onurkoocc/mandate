// Live model calls (BACKLOG K15): run only with MANDATE_LIVE=1, never in PR
// CI. The key is CLAUDE_API_KEY, from the environment or the repo's .env
// (gitignored); a key that is not scoped to a workspace also needs the
// workspace id, CLAUDE_WORKSPACE_ID or anthropic-workspace-id. Each case
// spends real money; keep them small (K14).

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { AnthropicModel, priceUsage } from "../src/anthropic.js";
import { GitHubPullRequests } from "../src/github.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimSandboxHost } from "../src/sim.js";
import { isObj } from "../src/values.js";
import { ASK_CAPITAL, LOCK, OPEN_PR, READ_LOOP } from "./models.js";
import { closeAll, world } from "./helpers.js";

const LIVE = process.env["MANDATE_LIVE"] === "1";
export const workspaceId = (): string | undefined => process.env["CLAUDE_WORKSPACE_ID"] ?? process.env["anthropic-workspace-id"];
const envFile = new URL("../../.env", import.meta.url);
if (LIVE && !process.env["CLAUDE_API_KEY"] && existsSync(envFile)) process.loadEnvFile(envFile);

afterAll(closeAll);

describe.skipIf(!LIVE)("live: one real model call (P1-6)", () => {
  it("is journaled with the snapshot that answered and settled at its real price", async () => {
    const apiKey = process.env["CLAUDE_API_KEY"];
    expect(apiKey, "CLAUDE_API_KEY").toBeTruthy();
    const program = check(ASK_CAPITAL, "mdt").program!;
    const ws = workspaceId();
    const model = new AnthropicModel({ lock: LOCK, program, apiKey: apiKey!, ...(ws ? { workspaceId: ws } : {}) });
    const w = await world(ASK_CAPITAL, { lock: LOCK, realModel: model });

    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "live-1" });
    expect(run.state).toBe("succeeded");
    expect(run.result).toMatchObject({ capital: expect.stringMatching(/ankara/i) });

    const report = await w.rt.budgetReport("live-1");
    const infer = report.commands.find((c) => c.kind === "infer")!;
    const event = (await w.rt.journal.events("live-1")).find((e) => e.type === "command_completed")!;
    const meta = isObj(event.data) && isObj(event.data["meta"]) ? event.data["meta"] : {};
    const u = meta["usage"] as { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
    // The ledger holds exactly what the reported usage costs at the locked tariff, and no more than was reserved.
    const priced = priceUsage(LOCK.tariffs!["claude-opus-5-5"]!, u);
    expect(infer.cost).toEqual({ ...priced, steps: 1 });
    expect(priced.spend!.micros).toBeLessThanOrEqual(infer.reserved["spend:USD"]!);
    expect(report.dimensions.find((d) => d.dimension === "spend:USD")).toMatchObject({ settled: priced.spend!.micros, reserved: 0 });
    expect(meta).toMatchObject({ locked: "claude-opus-5-5", effort: "high", model: expect.stringMatching(/^claude-opus-5-5/) });
    console.log(`live: ${JSON.stringify({ result: run.result, cost: infer.cost, reserved: infer.reserved, model: meta["model"] })}`);
    expect(await w.rt.replayRun("live-1")).toEqual({ status: "complete", value: run.result });
  });
});

describe.skipIf(!LIVE)("live: an agent loop (P1-7)", () => {
  it("reads in its sandbox, finishes with a typed result, and settles each turn", async () => {
    const ws = workspaceId();
    const program = check(READ_LOOP, "mdt").program!;
    const model = new AnthropicModel({ lock: LOCK, program, apiKey: process.env["CLAUDE_API_KEY"]!, ...(ws ? { workspaceId: ws } : {}) });
    const w = await world(READ_LOOP, { lock: LOCK, realModel: model });
    const host = new SimSandboxHost();
    host.files.set("/work/repo/src/range.ts", "export function inRange(x: number, lo: number, hi: number): boolean {\n  return x > lo && x < hi;\n}\n");
    host.files.set("/work/repo/README.md", "inRange(x, lo, hi) is true when lo <= x <= hi.\n");
    w.adapters.loop = { chat: model, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };

    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Locate", input: { issue: "inRange(5, 5, 10) returns false; the README says the bounds are inclusive." }, runId: "live-2" });
    const report = await w.rt.budgetReport("live-2");
    const turns = report.commands.filter((c) => c.kind === "turn");
    console.log(`live loop: ${JSON.stringify({ state: run.state, result: run.result ?? run.error, turns: turns.length, tools: host.executions.map((x) => x.req.argv.join(" ")), spend: report.dimensions })}`);
    expect(run.state).toBe("succeeded");
    expect(run.result).toEqual(expect.arrayContaining([expect.objectContaining({ file: expect.stringContaining("range.ts"), line: 2 })]));
    expect(host.executions.length).toBeGreaterThan(0);
    expect(turns.every((t) => t.cost && t.cost !== "unknown" && Object.keys(t.reserved).length === 0)).toBe(true);
    expect(await w.rt.replayRun("live-2")).toEqual({ status: "complete", value: run.result });
  });
});

const TARGET = "onurkoocc/mandate-fixbug-target";
const githubToken = (): string | undefined => process.env["MANDATE_GITHUB_TOKEN"] ?? process.env["GITHUB_TOKEN"];

describe.skipIf(!LIVE || !githubToken())("live: git.open_pr on the test repository (P1-9)", () => {
  it("leaves exactly one pull request after a lost response is reconciled", async () => {
    const token = githubToken()!;
    const workdir = mkdtempSync(join(tmpdir(), "mandate-live-pr-"));
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "pagination.ts"), "// live test of git.open_pr; this pull request is closed by the test\n");
    const real = new GitHubPullRequests({ token, repo: TARGET, workdir });
    // The pull request is opened for real, then its answer is lost.
    let sent = 0;
    const lossy = Object.assign(Object.create(real) as GitHubPullRequests, {
      execute: async (...a: Parameters<GitHubPullRequests["execute"]>) => {
        sent++;
        const r = await real.execute(...a);
        return "confirmed" in r ? { unknown: "the response was lost" } : r;
      },
    });
    const w = await world(OPEN_PR);
    w.adapters.tools["git.open_pr"] = lossy;
    const draft = { issue: { id: `live-${Date.now()}`, title: "live test of git.open_pr" }, patch: { files: ["src/pagination.ts"] } };
    let branch: string | undefined;
    try {
      const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "Open", input: { draft }, runId: "live-3" });
      const wait = waiting.waiting as { command: string; request: { subject_digest: string } };
      const lost = await w.rt.decideAction("live-3", { sender: "test", messageId: "a1" }, { commandId: wait.command, revision: waiting.revision, digest: wait.request.subject_digest, approve: true, by: "test" });
      expect(lost.state).toBe("attention_required");
      const [action] = await w.rt.journal.actions("live-3");
      expect(action!.state).toBe("unknown_outcome");

      const done = await w.rt.reconcileAction("live-3", action!.operation_key);
      expect(done.state).toBe("succeeded");
      const [settled] = await w.rt.journal.actions("live-3");
      const receipt = settled!.receipt as { number: number; url: string; branch: string };
      branch = receipt.branch;
      const res = await fetch(`https://api.github.com/repos/${TARGET}/pulls?state=all&head=onurkoocc:${encodeURIComponent(branch)}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
      const prs = (await res.json()) as Array<{ number: number }>;
      console.log(`live pr: ${JSON.stringify({ receipt, sent, pulls: prs.map((p) => p.number) })}`);
      expect(prs.map((p) => p.number)).toEqual([receipt.number]);
      expect(sent).toBe(1);
    } finally {
      // Leave the test repository as it was: close the pull request and delete its branch.
      const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
      const [settled] = await w.rt.journal.actions("live-3");
      const n = (settled?.receipt as { number?: number } | null)?.number;
      if (n) await fetch(`https://api.github.com/repos/${TARGET}/pulls/${n}`, { method: "PATCH", headers, body: JSON.stringify({ state: "closed" }) });
      if (branch) await fetch(`https://api.github.com/repos/${TARGET}/git/refs/heads/${branch}`, { method: "DELETE", headers });
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
