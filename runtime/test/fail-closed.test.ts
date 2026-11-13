// What 0.5 asks that a host does not enforce is refused by name, never
// dropped (spec/boundary.md, INV-11). A sandbox requirement 0.2 that asks
// nothing beyond 0.1 gives the policy a 0.1 requirement gives. Method limits
// and credentials are enforced only by a host that reaches its hosts through
// the egress proxy (sandbox-egress.test.ts); every other host refuses them.

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
    ["credentials", [net()], { egress: { Reader: { "api.github.com": "github" } } }, "credentials for outbound hosts: api.github.com"],
  ])("that asks for %s is refused by name, on a host that enforces all of 0.1 but reaches no proxy", async (_what, caps, lock, line) => {
    const planned = await adapter().plan(requirementFor(subject, caps, 60_000, { ...v05, lock: { modules: {}, ...lock } as Lock }));
    expect(planned).toEqual({ unsupported: [line] });
  });

  it("that limits methods and binds a credential is planned on a host that reaches its hosts through a proxy holding it", async () => {
    const through = new MxcAdapter({ host: new SimSandboxHost({ ...FULL_SANDBOX, egress: { credentials: ["github"] } }), schemaVersion: "1.0", modelEndpoints: {}, modelsInControlPlane: true });
    const planned = await through.plan(requirementFor(subject, [net(["GET"])], 60_000, { ...v05, lock: { modules: {}, egress: { Reader: { "api.github.com": "github" } } } }));
    expect(planned).toMatchObject({ policy: { network: { allowOutbound: true, allowedHosts: ["api.github.com"], methods: { "api.github.com": ["GET"] }, credentials: { "api.github.com": "github" } } } });
    const other = await through.plan(requirementFor(subject, [net()], 60_000, { ...v05, lock: { modules: {}, egress: { Reader: { "api.github.com": "gh-app" } } } }));
    expect(other).toEqual({ unsupported: ["credential gh-app for api.github.com"] });
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

  it("whose lock sets all three loads: the runtime enforces each, egress through the proxy", () => {
    expect(notRunYet(fetchProgram(), packaged)).toEqual([]);
    expect(refusal(fetchProgram(), packaged)).toBeUndefined();
    expect(refusal(fetchProgram(), { modules: {}, models: packaged.models, tariffs: packaged.tariffs, egress: packaged.egress } as Lock)).toBeUndefined();
    expect(refusal(fetchProgram(), { modules: {}, models: packaged.models, tariffs: packaged.tariffs } as Lock)).toBeUndefined();
    expect(notRunYet(fetchProgram())).toEqual([]);
  });

  it("whose lock binds a credential is not started on a runtime that names no egress proxy (no_egress_proxy)", async () => {
    const inner = new SimAgents();
    const w = await world(FETCH.replace(", methods: [GET])", ")"), { agents: new SandboxedAgents(adapter(), (req) => inner.run(req)) as unknown as SimAgents, lock: { modules: {}, models: packaged.models, tariffs: packaged.tariffs, egress: packaged.egress } as Lock, decisions: { keys: new TrustedKeys([]) } });
    const e = await w.rt.startRun({ pkg: w.pkg, workflow: "Summarize", input: { issue: "#7" }, runId: "b05-np" }).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Violation);
    expect(e).toMatchObject({ code: "no_egress_proxy" });
    expect(inner.calls).toEqual([]);
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
