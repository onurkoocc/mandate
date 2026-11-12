// What 0.5 asks that this runtime does not enforce yet is refused by name,
// never dropped (spec/boundary.md, INV-11). A sandbox requirement 0.2 that
// asks nothing beyond 0.1 gives the policy a 0.1 requirement gives.

import { readFileSync } from "node:fs";
import { check, hashProgram, load, loadModules, requirementFor, type CapVal, type Json, type Lock, type Program } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { TrustedKeys } from "../src/evidence.js";
import { buildPackage, notRunYet, verifyPackage } from "../src/runtime.js";
import { Violation } from "../src/signals.js";
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

  const LOCK05 = JSON.parse(readFileSync(new URL("../../fixtures/boundary/mandate.lock.json", import.meta.url), "utf8")) as Lock;
  const { lock: _format, ...packaged } = LOCK05;
  const refusal = (program: Program, lock: Lock): unknown => {
    try {
      verifyPackage(buildPackage(program, lock));
      return undefined;
    } catch (e) {
      return e;
    }
  };
  const fetchProgram = (): Program => check(FETCH, "mdt", { lock: LOCK05 }).program!;

  it.each([
    ["host", { host: packaged.host }, "host (the least versions of the host's tools, which this runtime does not check yet)"],
    ["isolation", { isolation: packaged.isolation }, "isolation (isolation floors, which no sandbox host here reports a level for yet)"],
    ["egress", { egress: packaged.egress }, "egress (credentials for agents' requests, which go only through an egress proxy, and this runtime has none yet)"],
  ])("whose lock sets %s is refused at load, by that name, until the runtime enforces it", (name, field, said) => {
    const lock = { modules: {}, models: packaged.models, tariffs: packaged.tariffs, ...field } as Lock;
    expect(notRunYet(fetchProgram(), lock)).toEqual([`lock.${name}`]);
    const e = refusal(fetchProgram(), lock);
    expect(e).toBeInstanceOf(Violation);
    expect(e).toMatchObject({ code: "unsupported_lock" });
    expect((e as Violation).message).toBe(`unsupported_lock: The package's lock sets ${said}, which this runtime does not enforce yet (spec/boundary.md).`);
  });

  it("whose lock sets all three is refused naming each; without them it is accepted", () => {
    expect(notRunYet(fetchProgram(), packaged)).toEqual(["lock.egress", "lock.host", "lock.isolation"]);
    expect((refusal(fetchProgram(), packaged) as Violation).message).toMatch(/^unsupported_lock: The package's lock sets egress \(.*\), host \(.*\), isolation \(.*\), which/);
    expect(refusal(fetchProgram(), { modules: {}, models: packaged.models, tariffs: packaged.tariffs } as Lock)).toBeUndefined();
    expect(notRunYet(fetchProgram())).toEqual([]);
  });

  it("is not the only one: a package of any language whose lock sets host is refused too", () => {
    const old = check(FETCH.replace("mandate @ 0.5", "mandate @ 0.2"), "mdt").program!;
    expect(old.language).toBe("mandate/0.2");
    expect(refusal(old, { modules: {}, host: { node: "22.23.4" } })).toMatchObject({ code: "unsupported_lock" });
    expect(refusal(old, { modules: {} })).toBeUndefined();
  });

  it("is not reached into by an earlier one: a 0.4 package that imports a 0.5 method limit is refused at load (MDT-E1804)", () => {
    const text = readFileSync(new URL("../../conformance/E1804/github.mdt", import.meta.url), "utf8");
    const { modules } = loadModules([{ file: "github.mdt", text, kind: "mdt" }]);
    const src = readFileSync(new URL("../../conformance/E1804/program.mdt", import.meta.url), "utf8");
    const lock = { modules: { "example.github": hashProgram(modules["example.github"] as unknown as Json).program } };
    const program = (version: string): Program => load(src.replace("mandate @ 0.4", `mandate @ ${version}`), "mdt").program!;
    const refused = (p: Program): unknown => {
      try {
        verifyPackage(buildPackage(p, lock, modules));
        return undefined;
      } catch (e) {
        return e;
      }
    };
    const e = refused(program("0.4"));
    expect(e).toMatchObject({ code: "load_verification_failed" });
    expect((e as Violation).message).toContain("MDT-E1804");
    expect(refused(program("0.5"))).toBeUndefined();
  });

  it("whose agent may only GET a host is not started on a host that cannot hold it to GET", async () => {
    const { r, inner, agents } = await run(FETCH, "b05-get");
    expect(inner.calls).toEqual([]);
    expect(agents.sandboxes).toEqual([]);
    expect(JSON.stringify(r)).toContain("method limits on outbound hosts: api.github.com");
  });
});
