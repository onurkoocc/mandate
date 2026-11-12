// What 0.5 asks that this runtime does not enforce yet is refused by name,
// never dropped (spec/boundary.md, INV-11). A sandbox requirement 0.2 that
// asks nothing beyond 0.1 gives the policy a 0.1 requirement gives.

import { readFileSync } from "node:fs";
import { requirementFor, type CapVal, type Lock } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { TrustedKeys } from "../src/evidence.js";
import { MxcAdapter, SandboxedAgents } from "../src/sandbox.js";
import { FULL_SANDBOX, SimAgents, SimSandboxHost } from "../src/sim.js";
import { closeAll, world } from "./helpers.js";

afterAll(closeAll);

const subject = { agent: "Reader", def: "sha256:0" };
const net = (methods?: string[]): CapVal => ({ ctor: "net.https", effect: "Net", write: false, scope: ["api.github.com"], ...(methods ? { methods } : {}) });
const read: CapVal = { ctor: "fs.read", effect: "Fs.Read", write: false, scope: ["/work/repo"] };
const v05 = { language: "mandate/0.5" } as const;

/** An adapter over a simulated host that can enforce everything 0.1 asks, an outbound host allow-list included. */
const adapter = (): MxcAdapter => new MxcAdapter({ host: new SimSandboxHost(FULL_SANDBOX), schemaVersion: "1.0", modelEndpoints: {}, modelsInControlPlane: true });

describe("a sandbox requirement 0.2 on today's hosts", () => {
  it("that asks nothing beyond 0.1 gives the policy of the 0.1 requirement, byte for byte", async () => {
    for (const caps of [[read], [read, net()]]) {
      const old = await adapter().plan(requirementFor(subject, caps, 60_000));
      const now = await adapter().plan(requirementFor(subject, caps, 60_000, v05));
      expect("policy" in now).toBe(true);
      expect(JSON.stringify(now)).toBe(JSON.stringify(old));
    }
  });

  it.each([
    ["method limits", [net(["GET"])], {}, "method limits on outbound hosts: api.github.com"],
    ["an isolation floor", [read], { isolation: { floor: { public: "user_kernel" } } }, "isolation user_kernel (this host gives process)"],
    ["a sandbox that may not share its host", [read], { isolation: { co_tenancy: { public: "forbidden" } } }, "co_tenancy forbidden (this host may share)"],
    ["credentials", [net()], { egress: { Reader: { "api.github.com": "github" } } }, "credentials for outbound hosts: api.github.com"],
  ])("that asks for %s is refused by name, on a host that enforces all of 0.1", async (_what, caps, lock, line) => {
    const planned = await adapter().plan(requirementFor(subject, caps, 60_000, { ...v05, lock: { modules: {}, ...lock } as Lock }));
    expect(planned).toEqual({ unsupported: [line] });
  });
});

describe("a 0.5 package", () => {
  const FETCH = readFileSync(new URL("../../fixtures/boundary/fetch.mdt", import.meta.url), "utf8");

  async function run(src: string, runId: string) {
    const inner = new SimAgents();
    const agents = new SandboxedAgents(adapter(), (req) => inner.run(req));
    const w = await world(src, { agents: agents as unknown as SimAgents, decisions: { keys: new TrustedKeys([]) } });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Summarize", input: { issue: "#7" }, runId });
    return { r, inner, agents };
  }

  it("runs, and its delegation's sandbox is built from requirement 0.2", async () => {
    const { r, inner, agents } = await run(FETCH.replace(", methods: [GET])", ")"), "b05-run");
    expect(r.state).toBe("succeeded");
    expect(inner.calls.map((c) => c.sandbox?.format)).toEqual(["mandate/sandbox-requirement/0.2"]);
    expect(inner.calls[0]!.sandbox).toMatchObject({ network: { hosts: ["api.github.com"], methods: {} }, isolation: { min: "process", co_tenancy: "allowed" }, egress: { credentials: {} } });
    expect(agents.sandboxes.map((s) => s.policy.network)).toEqual([{ allowOutbound: true, allowedHosts: ["api.github.com"] }]);
  });

  it("whose agent may only GET a host is not started on a host that cannot hold it to GET", async () => {
    const { r, inner, agents } = await run(FETCH, "b05-get");
    expect(inner.calls).toEqual([]);
    expect(agents.sandboxes).toEqual([]);
    expect(JSON.stringify(r)).toContain("method limits on outbound hosts: api.github.com");
  });
});
