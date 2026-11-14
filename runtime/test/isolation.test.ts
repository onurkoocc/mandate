// Isolation levels (spec/boundary.md "Isolation level and host fitness"). A
// sandbox host reports the level it gives and whether it may share its host;
// the adapter holds a requirement 0.2's `isolation` to that report, and
// refuses by name what the host does not give (E0902). A requirement 0.1 is
// planned as it always was, whatever the host reports.

import { readFileSync } from "node:fs";
import { check, requirementFor, type CapVal, type Lock, type Program } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import { TrustedKeys } from "../src/evidence.js";
import { buildPackage, notRunYet, verifyPackage } from "../src/runtime.js";
import { MxcAdapter, SandboxedAgents, type Enforceable } from "../src/sandbox.js";
import { FULL_SANDBOX, SimAgents, SimSandboxHost } from "../src/sim.js";
import { closeAll, world } from "./helpers.js";

afterAll(closeAll);

const subject = { agent: "Reader", def: "sha256:0" };
const read: CapVal = { ctor: "fs.read", effect: "Fs.Read", write: false, scope: ["/work/repo"] };
const net: CapVal = { ctor: "net.https", effect: "Net", write: false, scope: ["api.github.com"] };
const model: CapVal = { ctor: "model.infer", effect: "Model", write: false, tier: "standard", maxClass: "restricted" };

const adapter = (can: Enforceable = FULL_SANDBOX): MxcAdapter => new MxcAdapter({ host: new SimSandboxHost(can), schemaVersion: "1.0", modelEndpoints: {}, modelsInControlPlane: true });
/** A 0.5 requirement for `caps` under a lock with `isolation`. */
const req05 = (isolation: Lock["isolation"], caps: CapVal[] = [read]) => requirementFor(subject, caps, 60_000, { language: "mandate/0.5", lock: { modules: {}, ...(isolation ? { isolation } : {}) } });

describe("the sandbox adapter and a host's isolation level", () => {
  it("refuses a level above the one the host gives, naming both; a host that does not say gives process", async () => {
    const floor = { floor: { public: "user_kernel" as const } };
    expect(await adapter().plan(req05(floor))).toEqual({ unsupported: ["isolation user_kernel (this host gives process)"] });
    expect(await adapter({ ...FULL_SANDBOX, level: "process" }).plan(req05(floor))).toEqual({ unsupported: ["isolation user_kernel (this host gives process)"] });
    expect(await adapter({ ...FULL_SANDBOX, level: "microvm" }).plan(req05({ floor: { public: "dedicated_host" } }))).toEqual({ unsupported: ["isolation dedicated_host (this host gives microvm)"] });
  });

  it("plans a requirement whose level the host gives, or exceeds", async () => {
    for (const [given, asked] of [["user_kernel", "user_kernel"], ["microvm", "user_kernel"], ["dedicated_host", "microvm"], ["process", "process"]] as const) {
      const planned = await adapter({ ...FULL_SANDBOX, level: given }).plan(req05({ floor: { public: asked } }));
      expect("policy" in planned, `${asked} on ${given}: ${JSON.stringify(planned)}`).toBe(true);
    }
  });

  it("holds the floor a data class has in effect and the untrusted network's floor", async () => {
    const isolation: Lock["isolation"] = { floor: { confidential: "user_kernel", restricted: "microvm" }, untrusted_network: "microvm" };
    const host = adapter({ ...FULL_SANDBOX, level: "user_kernel" });
    // restricted data: microvm, which a user_kernel host does not give; with a network, the same.
    expect(await host.plan(req05(isolation, [read, model]))).toEqual({ unsupported: ["isolation microvm (this host gives user_kernel)"] });
    expect(await host.plan(req05(isolation, [read, net]))).toEqual({ unsupported: ["isolation microvm (this host gives user_kernel)"] });
    expect("policy" in (await host.plan(req05(isolation, [read])))).toBe(true);
  });

  it("refuses a sandbox that may not share its host on a host that may share; a host that does not say may", async () => {
    const forbidden = { co_tenancy: { public: "forbidden" as const } };
    expect(await adapter().plan(req05(forbidden))).toEqual({ unsupported: ["co_tenancy forbidden (this host may share)"] });
    expect(await adapter({ ...FULL_SANDBOX, co_tenancy: "shared" }).plan(req05(forbidden))).toEqual({ unsupported: ["co_tenancy forbidden (this host may share)"] });
    expect("policy" in (await adapter({ ...FULL_SANDBOX, co_tenancy: "exclusive" }).plan(req05(forbidden)))).toBe(true);
    expect("policy" in (await adapter().plan(req05({ co_tenancy: { public: "allowed" } })))).toBe(true);
  });

  it("refuses a level it does not know, whichever side names it", async () => {
    expect(await adapter({ ...FULL_SANDBOX, level: "vm" as never }).plan(req05({ floor: { public: "user_kernel" } }))).toEqual({ unsupported: ["isolation user_kernel (this host gives vm)"] });
    const odd = { ...req05(undefined), isolation: { ...req05(undefined).isolation!, min: "enclave" as never } };
    expect(await adapter({ ...FULL_SANDBOX, level: "dedicated_host" }).plan(odd)).toEqual({ unsupported: ["isolation enclave (this host gives dedicated_host)"] });
  });

  it("lists isolation after what the host cannot enforce of 0.1 and the method limits, before the credentials", async () => {
    const r = requirementFor(subject, [read, { ...net, methods: ["GET"] }], 60_000, {
      language: "mandate/0.5",
      lock: { modules: {}, isolation: { floor: { public: "microvm" }, co_tenancy: { public: "forbidden" } }, egress: { Reader: { "api.github.com": "github" } } },
    });
    expect(await adapter({ ...FULL_SANDBOX, ui: false }).plan(r)).toEqual({
      unsupported: ["turning off desktop and clipboard access", "method limits on outbound hosts: api.github.com", "isolation microvm (this host gives process)", "co_tenancy forbidden (this host may share)", "credentials for outbound hosts: api.github.com"],
    });
  });

  it("gives a 0.2 requirement the host satisfies the policy of the 0.1 requirement, byte for byte", async () => {
    const strong: Enforceable = { ...FULL_SANDBOX, level: "microvm", co_tenancy: "exclusive" };
    const now = await adapter(strong).plan(req05({ floor: { public: "microvm" }, co_tenancy: { public: "forbidden" } }));
    const old = await adapter(strong).plan(requirementFor(subject, [read], 60_000));
    expect("policy" in now).toBe(true);
    expect(JSON.stringify(now)).toBe(JSON.stringify(old));
  });

  it("plans a 0.1 requirement as before, whatever level and sharing the host reports", async () => {
    const r = requirementFor(subject, [read, net], 60_000);
    expect(r.isolation).toBeUndefined();
    const expected = JSON.stringify({
      policy: {
        $generator: "mandate-mxc@0.1 (MXC SDK v1)",
        $source: "Reader@sha256:0",
        version: "1.0",
        isolation: "process",
        filesystem: { readOnly: ["/work/repo"], readWrite: [] },
        network: { allowOutbound: true, allowedHosts: ["api.github.com"] },
        process: { allowedCommands: [] },
        ui: { allowDesktop: false, allowClipboard: false },
        timeoutSeconds: 60,
        mode: "enforcement",
      },
    });
    for (const can of [FULL_SANDBOX, { ...FULL_SANDBOX, level: "process", co_tenancy: "shared" }, { ...FULL_SANDBOX, level: "dedicated_host", co_tenancy: "exclusive" }] as Enforceable[]) {
      expect(JSON.stringify(await adapter(can).plan(r))).toBe(expected);
    }
  });
});

describe("a package whose lock sets isolation", () => {
  const FETCH = readFileSync(new URL("../../fixtures/boundary/fetch.mdt", import.meta.url), "utf8").replace(", methods: [GET])", ")");
  const LOCK05 = JSON.parse(readFileSync(new URL("../../fixtures/boundary/mandate.lock.json", import.meta.url), "utf8")) as Lock;
  const { lock: _format, ...packaged } = LOCK05;
  const lock = { modules: {}, models: packaged.models, tariffs: packaged.tariffs, isolation: packaged.isolation } as Lock;

  async function run(can: Enforceable, runId: string) {
    const inner = new SimAgents();
    const agents = new SandboxedAgents(adapter(can), (req) => inner.run(req));
    const w = await world(FETCH, { agents: agents as unknown as SimAgents, lock, decisions: { keys: new TrustedKeys([]) } });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Summarize", input: { issue: "#7" }, runId });
    return { r, inner, agents };
  }

  it("loads: the runtime enforces it", () => {
    const program = check(FETCH, "mdt", { lock: LOCK05 }).program!;
    expect(notRunYet(program, lock)).toEqual([]);
    expect(() => verifyPackage(buildPackage(program, lock))).not.toThrow();
  });

  it("runs its agent on a host that gives the floor its data class has in effect (confidential: user_kernel)", async () => {
    const { r, inner, agents } = await run({ ...FULL_SANDBOX, level: "user_kernel" }, "iso-fit");
    expect(r.state, JSON.stringify(r.error)).toBe("succeeded");
    expect(inner.calls[0]!.sandbox?.isolation).toEqual({ min: "user_kernel", co_tenancy: "allowed", data_class: "confidential", untrusted_network: true });
    expect(agents.sandboxes).toHaveLength(1);
  });

  it("does not start its agent on a host that gives less, and says why (E0902)", async () => {
    const { r, inner, agents } = await run(FULL_SANDBOX, "iso-unfit");
    expect(inner.calls).toEqual([]);
    expect(agents.sandboxes).toEqual([]);
    const text = JSON.stringify(r);
    expect(text).toContain("unsupported_sandbox_profile");
    expect(text).toContain("MDT-E0902");
    expect(text).toContain("isolation user_kernel (this host gives process)");
  });

  it("of a program before 0.5 is refused at load: its requirements carry no level, so the floor would not hold (MDT-E1803)", () => {
    const old = (src: string): Program => check(src, "mdt").program!;
    const program = old(FETCH.replace("mandate @ 0.5", "mandate @ 0.4"));
    expect(program.language).toBe("mandate/0.4");
    let e: unknown;
    try {
      verifyPackage(buildPackage(program, lock));
    } catch (x) {
      e = x;
    }
    expect(e).toMatchObject({ code: "load_verification_failed" });
    expect((e as Error).message).toContain("MDT-E1803");
    expect(() => verifyPackage(buildPackage(program, { modules: {}, models: packaged.models, tariffs: packaged.tariffs } as Lock))).not.toThrow();
  });
});
