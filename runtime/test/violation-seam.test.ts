// The seam an egress denial is recorded through (spec/boundary.md "Violations and halt", "Sandbox egress"): the
// agent loop calls `LoopIO.violation` with the kind. Here a stand-in calls it after each tool call, within its step,
// on a simulated host; what the interpreter gives the loop writes it once per step, counts it and holds the limit.
// The sandbox host that reads a real proxy's denials into the step's result is sandbox-egress.test.ts.

import { afterAll, describe, expect, it, vi } from "vitest";
import { Runtime } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimChat, SimSandboxHost, toolUse } from "../src/sim.js";
import { closeAll, world } from "./helpers.js";

vi.mock("../src/loop.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/loop.js")>();
  return {
    ...real,
    runAgentLoop: (task: Parameters<typeof real.runAgentLoop>[0], io: Parameters<typeof real.runAgentLoop>[1]) =>
      real.runAgentLoop(task, {
        ...io,
        step: async (id, kind, request, reserve, call, label) => {
          const value = await io.step(id, kind, request, reserve, call, label);
          if (kind === "tool") await io.violation!("egress_denied", id, { host: "evil.example", method: "POST", why: "host_not_allowed" });
          return value;
        },
      }),
  };
});

const SRC = `mandate @ 0.5

module seam @ 0.1

use std.{fs, model}

capability RepoRead = fs.read("/work/repo")
capability ModelStd = model.infer(tier: standard)

agent Fetcher {
  caps   RepoRead, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 8 }
  skill fetch(task: Text) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow Fetch(task: Text) -> Inferred<Text>
  caps   RepoRead, ModelStd
  budget { spend: 2 USD }
{
  delegate Fetcher.fetch(task)
}
`;

afterAll(closeAll);

describe("LoopIO.violation with egress_denied", () => {
  it("writes the denial once per step with its kind, stops the run at the limit, and a resumed run does not count it again", async () => {
    const w = await world(SRC, { decisions: { mode: "signed" } });
    const host = new SimSandboxHost();
    host.files.set("/work/repo/a.txt", "a");
    host.files.set("/work/repo/b.txt", "b");
    const chat = new SimChat((_r, n) => (n === 1 ? [toolUse("a", "read_file", { path: "a.txt" })] : n === 2 ? [toolUse("b", "read_file", { path: "b.txt" })] : [toolUse("f", "finish", { result: "done" })]));
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    const rt = new Runtime(w.db, w.adapters, w.faults, undefined, { decisions: { mode: "signed" }, violations: { limit: 2 } });

    const stopped = await rt.startRun({ pkg: w.pkg, workflow: "Fetch", input: { task: "t" }, runId: "egress" });
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "violation_limit" });
    const D = "/defs/Fetch/body/0/value";
    const written = async () => (await rt.journal.events("egress")).filter((e) => e.type === "violation").map((e) => e.data);
    expect(await written()).toEqual([
      { kind: "egress_denied", delegate: D, agent: "Fetcher", step: `${D}/step/0/tool/0`, detail: { host: "evil.example", method: "POST", why: "host_not_allowed" }, count: 1 },
      { kind: "egress_denied", delegate: D, agent: "Fetcher", step: `${D}/step/1/tool/0`, detail: { host: "evil.example", method: "POST", why: "host_not_allowed" }, count: 2 },
    ]);

    const resumed = await rt.resume("egress");
    expect(resumed.state).toBe("succeeded");
    expect(await written()).toHaveLength(2);
    expect(host.executions).toHaveLength(2);
    expect((await rt.verifyJournal("egress")).status).toBe("verified");
  });
});
