// What 0.1 only checked and 0.2 enforces at run time (P2-17): a delegation's
// `timeout` (§8.7, §9.1) and a workflow's `ensures` (§4.6). Running a
// program's `tests` with effect handlers (§6.4) is in tests.test.ts.

import { afterAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimAgents, SimChat, SimSandboxHost, toolUse, type SimTurn } from "../src/sim.js";
import { closeAll, commandIds, world } from "./helpers.js";

afterAll(closeAll);

const PROGRAM = `mandate @ 0.2

module enforce @ 0.1

use std.{fs, model}

capability RepoRead = fs.read("/work/repo")
capability ModelStd = model.infer(tier: standard)

type Issue = { id: Text, reproducible: Bool }

agent Worker {
  caps   RepoRead, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 6 }
  skill fix(issue: Issue) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow Quick(issue: Issue) -> Inferred<Text>
  caps   RepoRead, ModelStd
  budget { spend: 5 USD }
{
  delegate Worker.fix(issue) timeout 1m
}

workflow Retried(issue: Issue) -> Inferred<Text>
  caps   RepoRead, ModelStd
  budget { spend: 5 USD }
{
  delegate Worker.fix(issue) timeout 1m supervise restart(max: 1)
}

workflow Promise(issue: Issue) -> Bool
  caps   RepoRead
  ensures result
{
  issue.reproducible
}
`;

const ISSUE = { issue: { id: "BUG-9", reproducible: true } };

describe("a delegation's timeout (§8.7, §9.1)", () => {
  it("discards a result that comes after the deadline, settling what it spent", async () => {
    const agents = new SimAgents().on("Worker.fix", () => {
      w.clock.advance(90_000);
      return { ok: "too late", cost: { spend: { micros: 300_000, currency: "USD" } } };
    });
    const w = await world(PROGRAM, { agents });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Quick", input: ISSUE, runId: "t1" });
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ $tag: "Timeout", $args: [{ delegate: "Worker.fix", after_ms: 60_000, late_result: true }] });
    expect(agents.calls[0]!.deadline).toBe(w.clock.t - 90_000 + 60_000);
    const report = await w.rt.budgetReport("t1");
    expect(report.dimensions).toEqual([{ dimension: "spend:USD", limit: 5_000_000, settled: 300_000, reserved: 0, available: 4_700_000 }]);
    expect(await w.rt.replayRun("t1")).toMatchObject({ status: "failed" });
  });

  it("is restartable: a later attempt has a deadline of its own", async () => {
    const agents = new SimAgents().on("Worker.fix", (_req, n) => {
      if (n === 1) w.clock.advance(90_000);
      return { ok: `attempt ${n}`, cost: {} };
    });
    const w = await world(PROGRAM, { agents });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Retried", input: ISSUE, runId: "t2" });
    expect(run.state).toBe("succeeded");
    expect(run.result).toBe("attempt 2");
    expect(await commandIds(w, "t2", "time")).toEqual(["/defs/Retried/body/0/value#1/started", "/defs/Retried/body/0/value/started"]);
  });

  it("stops an agent loop before its next step once the deadline passed, keeping what it wrote", async () => {
    const w = await world(PROGRAM);
    const host = new SimSandboxHost();
    host.files.set("/work/repo/a.ts", "bug");
    // Each turn takes 35 seconds: the second ends past the deadline, so its tool call is never run.
    const script = (_req: TurnRequest, n: number): SimTurn => {
      w.clock.advance(35_000);
      return [toolUse(`t${n}`, "read_file", { path: n === 1 ? "/work/repo/a.ts" : "a.ts" })];
    };
    const chat = new SimChat(script);
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Quick", input: ISSUE, runId: "t3" });
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ $tag: "Timeout", $args: [{ delegate: "Worker.fix", after_ms: 60_000, partial: { written: [] } }] });
    // Nothing was sent after the deadline.
    expect(chat.calls).toHaveLength(2);
    expect(host.executions).toHaveLength(1);
    expect(await commandIds(w, "t3", "turn")).toEqual(["/defs/Quick/body/0/value/step/0", "/defs/Quick/body/0/value/step/1"]);
    expect(await w.rt.replayRun("t3")).toMatchObject({ status: "failed", error: { $tag: "Timeout" } });
  });
});

describe("a workflow's ensures (§4.6)", () => {
  it("lets a run whose result keeps the promise succeed, and fails one that breaks it", async () => {
    const w = await world(PROGRAM);
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Promise", input: ISSUE, runId: "e1" })).state).toBe("succeeded");
    const broken = await w.rt.startRun({ pkg: w.pkg, workflow: "Promise", input: { issue: { id: "BUG-9", reproducible: false } }, runId: "e2" });
    expect(broken.state).toBe("failed");
    expect(broken.error).toEqual({ $tag: "Rejected", $args: [{ reason: "ensures", workflow: "Promise" }] });
  });
});
