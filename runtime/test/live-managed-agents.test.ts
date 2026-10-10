// A live Managed Agents trial of the bridge (BACKLOG item 39; K15, K40): runs
// only with MANDATE_LIVE=1 and MANDATE_MA=1, never in PR CI. It deploys one
// agent and an environment for real, runs one delegation as a session whose
// every tool call comes back to the runtime, and checks what the service
// reported against the journal and the lock. Tier economy, a 2 USD run.
//
// It reports the input tokens the service adds to each request beyond the
// conversation the runtime counts, the measure for the binding's
// `harness_tokens`.

import { existsSync } from "node:fs";
import { check, type Lock } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { anthropicClient } from "../src/control.js";
import { deployManagedAgents, managedAgentsExecutor, sdkApi, type ManagedAgentsApi } from "../src/managed-agents.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimChat, SimSandboxHost } from "../src/sim.js";
import { isObj, type Value } from "../src/values.js";
import { closeAll, world } from "./helpers.js";

const LIVE = process.env["MANDATE_LIVE"] === "1" && process.env["MANDATE_MA"] === "1";
const envFile = new URL("../../.env", import.meta.url);
if (LIVE && !process.env["CLAUDE_API_KEY"] && existsSync(envFile)) process.loadEnvFile(envFile);

const SRC = `mandate @ 0.3

module live.bridge @ 0.1

use std.{fs, model}

capability RepoRead = fs.read("/work/repo")
capability ModelEco = model.infer(tier: economy)

type Finding = { file: Path, line: Int where line >= 1, claim: Text }

agent Explorer {
  role   "Finds where the bug is, with evidence. Does not change code."
  caps   RepoRead, ModelEco
  budget { tokens: 1M, spend: 2 USD, steps: 6 }
  skill locate(issue: Text) -> Inferred<List<Finding>> ! {Fs.Read, Model}
}

workflow Locate(issue: Text) -> Inferred<List<Finding>>
  caps   RepoRead, ModelEco
  budget { spend: 2 USD }
{
  delegate Explorer.locate(issue)
}
`;

// On Managed Agents the lock states the model's output ceiling (K80).
const LOCK: Lock = {
  modules: {},
  models: { economy: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", max_input_tokens: 128_000, max_output_tokens: 128_000 } },
  tariffs: { "claude-sonnet-5-5": { currency: "USD", as_of: "2026-10-09", micros_per_mtok: { input: 2_000_000, output: 10_000_000, cache_read: 200_000, cache_write: 2_500_000 } } },
};

afterAll(closeAll);

describe.skipIf(!LIVE)("live: an agent loop on Managed Agents through the bridge (item 39)", () => {
  it("deploys, validates the binding, runs every turn in one session and every tool here, and replays without the service", async () => {
    const api: ManagedAgentsApi = sdkApi(anthropicClient(process.env, "the live trial"));
    // Count every call the executor makes, to check that replay makes none.
    let calls = 0;
    const counts: number[] = [];
    const counted: ManagedAgentsApi = new Proxy(api, {
      get: (t, k) => {
        const f = t[k as keyof ManagedAgentsApi];
        if (typeof f !== "function") return f;
        return async (...a: unknown[]) => {
          calls++;
          const r = await (f as (...x: unknown[]) => Promise<unknown>).apply(t, a);
          if (k === "countTokens") counts.push(r as number);
          return r;
        };
      },
    });

    const program = check(SRC, "mdt").program!;
    const binding = await deployManagedAgents({ program, lock: LOCK, api, name: "mandate-live" });
    console.log(`live MA deploy: ${JSON.stringify(binding)}`);
    const lock: Lock = { ...LOCK, bindings: { "managed-agents": binding } };
    const w = await world(SRC, { lock });
    const host = new SimSandboxHost();
    host.files.set("/work/repo/src/range.ts", "export function inRange(x: number, lo: number, hi: number): boolean {\n  return x > lo && x < hi;\n}\n");
    host.files.set("/work/repo/README.md", "inRange(x, lo, hi) is true when lo <= x <= hi.\n");
    const local = new SimChat(() => {
      throw new Error("a bound agent never talks to the local model");
    });
    w.adapters.loop = {
      chat: local,
      sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }),
      executor: managedAgentsExecutor({ binding, lock, api: counted, pollMs: 1000, title: "live" }),
    };

    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Locate", input: { issue: "inRange(5, 5, 10) returns false; the README says the bounds are inclusive." }, runId: "live-ma-1" });
    const report = await w.rt.budgetReport("live-ma-1");
    const turns = report.commands.filter((c) => c.kind === "turn");
    const metas = (await w.rt.journal.events("live-ma-1")).filter((e) => e.type === "command_completed" && isObj(e.data) && isObj(e.data["meta"] ?? null) && (e.data["meta"] as Record<string, Value>)["executor"] === "managed-agents").map((e) => (e.data as Record<string, Value>)["meta"] as Record<string, Value>);
    // What the service added: its reported input against the conversation the runtime counted for each turn's bound.
    const harness = metas.map((m, i) => {
      const u = (m["usage"] ?? {}) as Record<string, number>;
      const reported = (u["input_tokens"] ?? 0) + (u["cache_read_input_tokens"] ?? 0) + (u["cache_creation_input_tokens"] ?? 0);
      return { reported, counted: counts[i] ?? 0, added: reported - (counts[i] ?? 0) };
    });
    console.log(`live MA run: ${JSON.stringify({ state: run.state, result: run.result ?? run.error, turns: turns.length, tools: host.executions.map((x) => x.req.argv.join(" ")), spend: report.dimensions, metas, harness })}`);
    expect(run.state).toBe("succeeded");
    expect(run.result).toEqual(expect.arrayContaining([expect.objectContaining({ file: expect.stringContaining("range.ts"), line: 2 })]));
    expect(local.calls).toHaveLength(0);
    expect(host.executions.length).toBeGreaterThan(0);
    expect(turns.every((t) => t.cost && t.cost !== "unknown")).toBe(true);
    expect(report.dimensions.find((d) => d.dimension === "spend:USD")).toMatchObject({ reserved: 0 });

    const before = calls;
    expect(await w.rt.replayRun("live-ma-1")).toEqual({ status: "complete", value: run.result });
    expect(calls).toBe(before);
  }, 600_000);
});
