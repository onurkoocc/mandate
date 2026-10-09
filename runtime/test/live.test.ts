// Live model calls (BACKLOG K15): run only with MANDATE_LIVE=1, never in PR
// CI. The key is CLAUDE_API_KEY, from the environment or the repo's .env
// (gitignored); a key that is not scoped to a workspace also needs the
// workspace id, CLAUDE_WORKSPACE_ID or anthropic-workspace-id. Each case
// spends real money; keep them small (K14).

import { existsSync } from "node:fs";
import { check } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { AnthropicModel, priceUsage } from "../src/anthropic.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimSandboxHost } from "../src/sim.js";
import { isObj } from "../src/values.js";
import { ASK_CAPITAL, LOCK, READ_LOOP } from "./models.js";
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
