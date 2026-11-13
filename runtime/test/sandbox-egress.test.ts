// Sandbox egress (spec/boundary.md "Sandbox egress", INV-23, INV-24, G15, G16):
// a sandboxed agent's tools reach the hosts its capability allows, and only
// those, through a forward session of its own at the egress proxy. The sandbox
// sees placeholders, never a secret; the proxy puts the secret in on the way
// out; what the proxy denies is written to the journal as a violation.
//
// The first part runs everywhere: MXC is a fake SDK whose "processes" send
// their requests to the session's proxy port as a sandbox's would, and the
// proxy is the in-process one of egress-world.ts, with an in-process upstream
// and no network. The secrets are made-up strings, held by the proxy only.
//
// The second part runs only on Linux with MANDATE_MXC=1 (CI's `sandbox` job):
// real Bubblewrap sandboxes held to the proxy by MXC, curl inside them, the
// proxy pointed at local servers through the resolver and dialer the test
// gives it, and a TLS server whose certificate openssl makes at test time.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { check, requirementFor, type CapVal, type Lock, type SandboxRequirement } from "@mandate/compiler";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapters } from "../src/adapters.js";
import { adaptersFor, readConfig, type RuntimeConfig } from "../src/control.js";
import { serveAdmin, type AdminServer } from "../src/egress/admin.js";
import { egressConfig } from "../src/egress/config.js";
import { EgressProxy, type DenialReason, type SessionRequest } from "../src/egress/proxy.js";
import { EgressLink } from "../src/gateway.js";
import { MxcHost, SANDBOX_SESSION_TTL_MS, type MxcContainerRequest, type MxcSdk } from "../src/mxc.js";
import { WindowsMxcHost, type WindowsContainerRequest, type WindowsMxcSdk } from "../src/mxc-windows.js";
import { Runtime } from "../src/runtime.js";
import { EGRESS_DENIALS_KEPT, MxcAdapter, placeholderVariable, type ExecResult, type MxcPolicy, type SandboxOwner } from "../src/sandbox.js";
import { SimChat, toolUse } from "../src/sim.js";
import { Violation } from "../src/signals.js";
import { adapter, EgressSdk, fetcher, SUPPORTED } from "./egress-sdk.js";
import { adminPath, http, OTHER_SECRET, portOf, SECRET, seenHeader, send, world as egressWorld, type World as EgressWorld } from "./egress-world.js";
import { closeAll, world as runtimeWorld } from "./helpers.js";
import { LOCK as MODELS_LOCK } from "./models.js";

const net = (hosts: string[], methods?: string[]): CapVal => ({ ctor: "net.https", effect: "Net", write: false, scope: hosts, ...(methods ? { methods } : {}) });
const FETCH: CapVal = { ctor: "exec", effect: "Exec", write: false, scope: ["fetch"] };
const MODEL: CapVal = { ctor: "model.infer", effect: "Model", write: false, tier: "standard", maxClass: "internal" };

/** A 0.5 requirement for `caps`, the lock binding each host of `bound` to its credential for agent Fetcher. */
function req05(caps: CapVal[], bound: Record<string, string> = {}, timeoutMs = 30_000): SandboxRequirement {
  return requirementFor({ agent: "Fetcher", def: "sha256:0" }, [...caps, FETCH, MODEL], timeoutMs, { language: "mandate/0.5", lock: { modules: {}, ...(Object.keys(bound).length ? { egress: { Fetcher: bound } } : {}) } });
}

const OWNER: SandboxOwner = { run: "r-egress", tenant: "acme", command: "/defs/Fetch/body/0/value" };

async function open(host: MxcHost, req: SandboxRequirement, owner: SandboxOwner = OWNER): Promise<{ handle: string; policy: MxcPolicy }> {
  const planned = await adapter(host).plan(req);
  if ("unsupported" in planned) throw new Error(`refused: ${planned.unsupported.join("; ")}`);
  return { handle: await host.create(planned.policy, owner), policy: planned.policy };
}

let w: EgressWorld;
/** What the proxy was asked to open and close, as the admin channel handed it over. */
const opened: Array<SessionRequest & { id?: unknown; op?: unknown }> = [];
const closed: string[] = [];
const links: EgressLink[] = [];
const link = (o: { admin?: string; now?: () => number } = {}): EgressLink => {
  const l = new EgressLink({ admin: o.admin ?? w.config.admin, ...(o.now ? { now: o.now } : {}) });
  links.push(l);
  return l;
};

beforeAll(async () => {
  w = await egressWorld();
  const realOpen = w.proxy.openSession.bind(w.proxy);
  w.proxy.openSession = async (r) => {
    opened.push(structuredClone(r));
    return realOpen(r);
  };
  const realClose = w.proxy.closeSession.bind(w.proxy);
  w.proxy.closeSession = async (id) => {
    closed.push(id);
    return realClose(id);
  };
});
afterAll(async () => {
  for (const l of links) await l.closeAll();
  await w.close();
  await closeAll();
});
beforeEach(() => {
  opened.length = 0;
  closed.length = 0;
  w.up.seen.length = 0;
});

/** Whether anything listens on a session's port: a closed session's port takes no connection. */
const listening = (url: string): Promise<boolean> =>
  new Promise((ok) => {
    const s = connect({ host: "127.0.0.1", port: portOf(url) }, () => (s.destroy(), ok(true)));
    s.on("error", () => ok(false));
  });

describe("MxcHost and the egress proxy", () => {
  it("reports an outbound host allow-list only where the SDK holds a sandbox to its proxy and the proxy answers, asked at every probe", async () => {
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link() });
    expect(await host.probe()).toMatchObject({ network: "host_allow_list", egress: { credentials: ["github", "model"] } });
    expect(host.egressUnavailable).toBeUndefined();

    sdk.support = { ...SUPPORTED, bubblewrapNetwork: { proxyEnforcement: "unsupported", warnings: ["Bubblewrap: network.proxy requires 'slirp4netns' on PATH"] } };
    const without = await host.probe();
    expect(without).toMatchObject({ network: "deny_all" });
    expect(without.egress).toBeUndefined();
    expect(host.egressUnavailable).toContain("proxyEnforcement is unsupported (Bubblewrap: network.proxy requires 'slirp4netns' on PATH)");
    expect(await adapter(host).plan(req05([net(["api.github.com"])]))).toEqual({ unsupported: ["an outbound host allow-list"] });

    sdk.support = { isSupported: true, availableMethods: ["bubblewrap"] };
    expect(await host.probe()).toMatchObject({ network: "deny_all" });
    expect(host.egressUnavailable).toContain("does not report bubblewrapNetwork");

    // Asked again at the next probe: the SDK says it can again, and the host says so.
    sdk.support = SUPPORTED;
    expect(await host.probe()).toMatchObject({ network: "host_allow_list" });

    const none = new MxcHost({ sdk });
    expect(await none.probe()).toMatchObject({ network: "deny_all" });
    expect(none.egressUnavailable).toContain("names no egress proxy (egress.admin)");
    expect(await adapter(none).plan(req05([net(["api.github.com"])]))).toEqual({ unsupported: ["an outbound host allow-list"] });
  });

  it("refuses a host by name at create too where it cannot hold a sandbox to a proxy, as the SDK says then", async () => {
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link() });
    const { policy } = (await adapter(host).plan(req05([net(["api.github.com"])]))) as { policy: MxcPolicy };
    // No proxy configured: refused by name, never created.
    await expect(new MxcHost({ sdk }).create(policy, OWNER)).rejects.toMatchObject({ unsupported: ["an outbound host allow-list"] });
    // The SDK no longer holds a sandbox to its proxy between the plan and the create: the same.
    sdk.support = { ...SUPPORTED, bubblewrapNetwork: { proxyEnforcement: "unsupported", warnings: ["iptables is missing"] } };
    await expect(host.create(policy, OWNER)).rejects.toMatchObject({ unsupported: ["an outbound host allow-list"] });
    expect(opened).toEqual([]);
  });

  it("stops at a configured proxy that does not answer, egress_unavailable, at plan and at create, for a sandbox that needs a host and for no other", async () => {
    const where = adminPath();
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link({ admin: where.path }) });
    // Nothing listens: a sandbox that needs a host stops the run for a person; one that needs none is planned and runs.
    const can = await host.probe();
    expect(can).toMatchObject({ network: "deny_all", egressDown: expect.stringMatching(/^the egress proxy at /) });
    expect(host.egressUnavailable).toMatch(/^egress_unavailable: the egress proxy at /);
    await expect(adapter(host).plan(req05([net(["api.github.com"])]))).rejects.toMatchObject({ code: "egress_unavailable" });
    const quiet = (await adapter(host).plan(req05([]))) as { policy: MxcPolicy };
    expect(quiet.policy.network).toEqual({ allowOutbound: false, allowedHosts: [] });
    const handle = await host.create(quiet.policy, OWNER);
    expect((await host.execute(handle, { argv: ["fetch"] })).exitCode).toBe(7);
    await host.destroy(handle);

    // It answers: planned. It stops answering before the sandbox is created: egress_unavailable, nothing left open.
    const admin = await serveAdmin(w.proxy, where.path);
    const planned = (await adapter(host).plan(req05([net(["api.github.com"])]))) as { policy: MxcPolicy };
    expect(planned.policy.network.allowedHosts).toEqual(["api.github.com"]);
    await admin.close();
    await expect(host.create(planned.policy, OWNER)).rejects.toMatchObject({ code: "egress_unavailable" });
    expect(opened).toEqual([]);
    where.cleanup();
  });

  it("lets no probe of one sandbox decide another's create: a proxy silent for a moment does not refuse a sandbox planned before", async () => {
    const where = adminPath();
    const admin = await serveAdmin(w.proxy, where.path);
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link({ admin: where.path }) });
    const first = (await adapter(host).plan(req05([net(["api.github.com"])]))) as { policy: MxcPolicy };
    // Another delegation's probe, while the proxy is gone for a moment, finds it down.
    await admin.close();
    await expect(adapter(host).plan(req05([net(["registry.npmjs.org"])]))).rejects.toMatchObject({ code: "egress_unavailable" });
    // It is back when the first sandbox is created: the first is created, its session opened.
    const again = await serveAdmin(w.proxy, where.path);
    const handle = await host.create(first.policy, OWNER);
    expect(opened.map((s) => s.destinations.map((d) => d.host))).toEqual([["api.github.com"]]);
    await host.destroy(handle);
    await again.close();
    where.cleanup();
  });

  it("opens one forward session per sandbox for exactly its hosts, methods and credentials, for its run and tenant, and closes it when the sandbox is destroyed", async () => {
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link() });
    const { handle, policy } = await open(host, req05([net(["api.github.com"], ["GET"]), net(["registry.npmjs.org"])], { "api.github.com": "github" }));
    expect(policy.network).toEqual({ allowOutbound: true, allowedHosts: ["api.github.com", "registry.npmjs.org"], methods: { "api.github.com": ["GET"] }, credentials: { "api.github.com": "github" } });
    expect(opened.map(({ id: _id, op: _op, ...r }) => r)).toEqual([
      {
        session: expect.stringMatching(/^sbx\.[0-9a-f]{16}$/),
        tenant: "acme",
        run: "r-egress",
        command: OWNER.command,
        kind: "forward",
        destinations: [
          { host: "api.github.com", methods: ["GET"], credential: "github" },
          { host: "registry.npmjs.org", methods: null, credential: null },
        ],
        ttl_ms: SANDBOX_SESSION_TTL_MS,
      },
    ]);
    await host.execute(handle, { argv: ["fetch"] });
    const url = sdk.spawned[0]!.network.runtimeConfig!.networkProxy;
    expect(await listening(url)).toBe(true);
    expect(await host.destroy(handle)).toBe("destroyed");
    expect(closed).toEqual([opened[0]!.session]);
    expect(await listening(url)).toBe(false);
  });

  it("hands MXC the session's address and the placeholders, and no secret: the process gets a placeholder, the upstream the secret", async () => {
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link(), path: ["/opt/tools/bin"] });
    const { handle } = await open(host, req05([net(["api.github.com"], ["GET"])], { "api.github.com": "github" }));
    const r = await host.execute(handle, { argv: ["fetch", "GET", "http://api.github.com/repos/acme/app"] });
    expect(r.stdout).toBe("GET http://api.github.com/repos/acme/app 200 ok\n");
    const request = sdk.spawned[0]!;
    expect(request.network).toEqual({ egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" }, runtimeConfig: { networkProxy: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) } });
    // The placeholders, laid over the backend's default environment, where the SDK puts the proxy variables; and PATH, as before.
    expect(request.environment).toEqual({ PATH: "/opt/tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", MANDATE_EGRESS_PLACEHOLDER_GITHUB: expect.stringMatching(/^mdt-ph-[0-9a-f]{32}$/) });
    expect(request.inheritDefaultEnvironment).toBe(true);
    expect(seenHeader(w.up.seen[0]!, "authorization")).toEqual([`Bearer ${SECRET}`]);
    // No secret in what MXC got, in the process's result, or in the runtime's own environment (INV-23).
    for (const text of [JSON.stringify(sdk.spawned), JSON.stringify(r), JSON.stringify(process.env)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(OTHER_SECRET);
    }
    await host.destroy(handle);
  });

  it("asks MXC for no network and no environment, as before, for a sandbox that reaches no host", async () => {
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link() });
    const planned = await adapter(host).plan(req05([]));
    expect((planned as { policy: MxcPolicy }).policy.network).toEqual({ allowOutbound: false, allowedHosts: [] });
    const handle = await host.create((planned as { policy: MxcPolicy }).policy, OWNER);
    await host.execute(handle, { argv: ["fetch"] });
    expect(opened).toEqual([]);
    expect(sdk.spawned[0]!.network).toEqual({ egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } });
    expect(sdk.spawned[0]!.environment).toBeUndefined();
    expect(sdk.spawned[0]!.inheritDefaultEnvironment).toBeUndefined();
    await host.destroy(handle);
  });

  it("reads what the proxy denied a process into its result: each reason and path digest, never a path, the first 100 and how many more", async () => {
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link() });
    const { handle } = await open(host, req05([net(["api.github.com"], ["GET"])], { "api.github.com": "github" }));
    const r = await host.execute(handle, { argv: ["fetch", "POST", "http://api.github.com/repos/acme/app/issues", "GET", "http://evil.example/secret-path", "+GET", "http://evil.example/leak", "GET", "http://api.github.com/x"] });
    expect(r.stdout).toBe(
      "POST http://api.github.com/repos/acme/app/issues 403 method_not_allowed\nGET http://evil.example/secret-path 403 host_not_allowed\n+GET http://evil.example/leak 403 placeholder_misuse\nGET http://api.github.com/x 200 ok\n",
    );
    const denial = (host: string, method: string, why: string) => ({ id: expect.any(Number), host, method, why, path_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), at: expect.any(String) });
    expect(r.egress_denials).toEqual({
      denials: [denial("api.github.com", "POST", "method_not_allowed"), denial("evil.example", "GET", "host_not_allowed"), denial("evil.example", "GET", "placeholder_misuse")],
      more: 0,
      counted: 3,
    });
    // A denial carries a digest of the path, never the path, and no placeholder; nothing of a denied request went upstream.
    expect(JSON.stringify(r.egress_denials)).not.toMatch(/secret-path|leak|mdt-ph-/);
    expect(w.up.seen.map((s) => s.url)).toEqual(["/x"]);
    // Only what was denied since the last process: the next one that is denied nothing has none.
    expect((await host.execute(handle, { argv: ["fetch", "GET", "http://api.github.com/y"] })).egress_denials).toBeUndefined();
    const many = Array.from({ length: EGRESS_DENIALS_KEPT + 7 }, (_, i) => ["GET", `http://evil.example/${i}`]).flat();
    const lots = await host.execute(handle, { argv: ["fetch", ...many] });
    expect(lots.egress_denials?.denials).toHaveLength(EGRESS_DENIALS_KEPT);
    expect(lots.egress_denials?.more).toBe(7);
    expect(lots.egress_denials?.counted).toBe(EGRESS_DENIALS_KEPT + 7);
    await host.destroy(handle);
  });

  it("counts what it pages past by its reason, and what the proxy did not keep, whose reason is gone, as crossing the grant", async () => {
    const l = link();
    const host = new MxcHost({ sdk: new EgressSdk(), egress: l });
    const { handle } = await open(host, req05([net(["api.github.com"])]));
    const d = (id: number, why: DenialReason) => ({ id, host: "evil.example", method: "GET", why, path_digest: null, at: "2026-11-13T00:00:00.000Z" });
    // The proxy's store was full: it recorded nothing more, and counts what it dropped.
    vi.spyOn(l, "denials").mockResolvedValueOnce({ denials: [], dropped: 4 });
    expect((await host.execute(handle, { argv: ["fetch"] })).egress_denials).toEqual({ denials: [], more: 4, counted: 4 });
    // The first 100 only say the session ended; one the host paged past did cross the grant.
    vi.spyOn(l, "denials").mockResolvedValueOnce({ denials: [...Array.from({ length: EGRESS_DENIALS_KEPT }, (_, i) => d(100 + i, "session_revoked")), d(300, "host_not_allowed")], dropped: 4 });
    expect((await host.execute(handle, { argv: ["fetch"] })).egress_denials).toMatchObject({ more: 1, counted: 1 });
    // All listed, all the session's end: none counted.
    vi.spyOn(l, "denials").mockResolvedValueOnce({ denials: [d(400, "session_revoked"), d(401, "session_expired")], dropped: 4 });
    expect((await host.execute(handle, { argv: ["fetch"] })).egress_denials).toMatchObject({ more: 0, counted: 0 });
    await host.destroy(handle);
  });

  it("refuses by name a credential the proxy does not hold, one it does not bind to the host, and a host that is not a host name (E0902)", async () => {
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link() });
    expect(await adapter(host).plan(req05([net(["api.github.com"])], { "api.github.com": "nope" }))).toEqual({ unsupported: ["credential nope for api.github.com"] });
    expect(await adapter(host).plan(req05([net(["api.github.com:443", "*.github.com"])]))).toEqual({
      unsupported: ["an outbound host that is not a host name the egress proxy takes: *.github.com", "an outbound host that is not a host name the egress proxy takes: api.github.com:443"],
    });
    // A character outside ASCII that lower-cases into ASCII (U+212A KELVIN SIGN to "k") is not read as the ASCII name.
    expect("Kube.example".toLowerCase()).toBe("kube.example");
    expect(await adapter(host).plan(req05([net(["Kube.example"])]))).toEqual({ unsupported: ["an outbound host that is not a host name the egress proxy takes: Kube.example"] });
    // The proxy holds `github`, for api.github.com and uploads.github.com only: which secret may go where is its configuration's to say.
    const planned = await adapter(host).plan(req05([net(["api.example.com"])], { "api.example.com": "github" }));
    expect("policy" in planned).toBe(true);
    await expect(host.create((planned as { policy: MxcPolicy }).policy, OWNER)).rejects.toMatchObject({ unsupported: ["credential github for api.example.com"] });
    expect(opened).toHaveLength(1);
    expect(sdk.spawned).toEqual([]);
  });

  it("refuses by name two credentials of one sandbox whose placeholders would share a variable, and a name a lock may not bind", async () => {
    const host = new MxcHost({ sdk: new EgressSdk(), egress: link() });
    // A proxy that says it holds what no conforming proxy holds: the names are still held to the lock's rule.
    const can = { ...(await host.probe()), egress: { credentials: ["gh-a", "gh_a", "gh=x"] } };
    const odd = new MxcAdapter({ host: { probe: async () => can } as never, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true });
    expect(await odd.plan(req05([net(["api.github.com", "uploads.github.com"])], { "api.github.com": "gh-a", "uploads.github.com": "gh_a" }))).toEqual({
      unsupported: ["credentials gh-a and gh_a for one sandbox, whose placeholders would both be MANDATE_EGRESS_PLACEHOLDER_GH_A"],
    });
    expect(await odd.plan(req05([net(["api.github.com"])], { "api.github.com": "gh=x" }))).toEqual({ unsupported: ["credential gh=x for api.github.com"] });
  });

  it("reads a host in lower case, and hosts that are one name are one destination", async () => {
    const host = new MxcHost({ sdk: new EgressSdk(), egress: link() });
    const { handle, policy } = await open(host, req05([net(["API.GitHub.com"], ["GET"]), net(["api.github.com"], ["HEAD"])]));
    expect(policy.network).toEqual({ allowOutbound: true, allowedHosts: ["api.github.com"], methods: { "api.github.com": ["GET", "HEAD"] } });
    expect(opened[0]!.destinations).toEqual([{ host: "api.github.com", methods: ["GET", "HEAD"], credential: null }]);
    await host.destroy(handle);
    expect(await adapter(host).plan(req05([net(["API.github.com"]), net(["api.github.com"])], { "API.github.com": "github", "api.github.com": "model" }))).toEqual({
      unsupported: ["credentials github and model for one host: api.github.com"],
    });
  });

  it("gives a 0.4 program's hosts any method and no credential: it reaches them through a configured proxy, a tunnel included", async () => {
    const sdk = new EgressSdk();
    let tunnel = "";
    sdk.programs.set("tunnel", async (request) => {
      const port = portOf(request.network.runtimeConfig!.networkProxy);
      const r = await send(port, http(["CONNECT registry.npmjs.org:443 HTTP/1.1", "host: registry.npmjs.org:443"]), { then: (s) => s.write(http(["GET /left-pad HTTP/1.1", "host: registry.npmjs.org", "connection: close"])) });
      tunnel = r.raw;
      return { stdout: String(r.status) };
    });
    const host = new MxcHost({ sdk, egress: link() });
    const req01 = requirementFor({ agent: "Fetcher", def: "sha256:0" }, [net(["registry.npmjs.org"]), FETCH, { ...FETCH, scope: ["tunnel"] }, MODEL], 30_000);
    expect(req01.format).toBe("mandate/sandbox-requirement/0.1");
    const { handle, policy } = await open(host, req01);
    expect(policy.network).toEqual({ allowOutbound: true, allowedHosts: ["registry.npmjs.org"] });
    expect(opened[0]!.destinations).toEqual([{ host: "registry.npmjs.org", methods: null, credential: null }]);
    expect((await host.execute(handle, { argv: ["fetch", "DELETE", "http://registry.npmjs.org/x"] })).stdout).toBe("DELETE http://registry.npmjs.org/x 200 ok\n");
    expect(sdk.spawned[0]!.environment).toBeUndefined();
    expect((await host.execute(handle, { argv: ["tunnel"] })).stdout).toBe("200");
    expect(tunnel).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 OK\r\n/);
    expect(w.up.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["DELETE /x", "GET /left-pad"]);
    await host.destroy(handle);
  });

  it("replaces a session near its end before a process that could outlive it: new placeholders, and the old session closed", async () => {
    let now = 1_000_000;
    const sdk = new EgressSdk();
    const host = new MxcHost({ sdk, egress: link({ now: () => now }) });
    const { handle } = await open(host, req05([net(["api.github.com"])], { "api.github.com": "github" }));
    await host.execute(handle, { argv: ["fetch", "GET", "http://api.github.com/a"] });
    // Six hours on, less is left than the process's 30 seconds and a minute: the next process gets a new session.
    now += SANDBOX_SESSION_TTL_MS - 60_000;
    await host.execute(handle, { argv: ["fetch", "GET", "http://api.github.com/b", "GET", "http://evil.example/"] });
    expect(opened).toHaveLength(2);
    expect(opened[1]!.destinations).toEqual(opened[0]!.destinations);
    expect(closed).toEqual([opened[0]!.session]);
    const [first, second] = sdk.spawned;
    expect(second!.network.runtimeConfig!.networkProxy).not.toBe(first!.network.runtimeConfig!.networkProxy);
    expect(second!.environment![placeholderVariable("github")]).not.toBe(first!.environment![placeholderVariable("github")]);
    expect(w.up.seen.map((s) => seenHeader(s, "authorization")[0])).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
    await host.destroy(handle);
    expect(closed).toEqual([opened[0]!.session, opened[1]!.session]);
  });

  it("stops the run when the proxy does not say what it denied (egress_unavailable): the session is unknown to it, or its admin channel is gone", async () => {
    // The session was closed at the proxy while the process ran: the proxy answers unknown_session.
    const sdk = new EgressSdk();
    sdk.programs.set("gone", async () => {
      await w.proxy.closeSession(opened.at(-1)!.session);
      return { stdout: "" };
    });
    const host = new MxcHost({ sdk, egress: link() });
    const { handle } = await open(host, req05([net(["api.github.com"]), { ...FETCH, scope: ["gone"] }]));
    await expect(host.execute(handle, { argv: ["gone"] })).rejects.toThrow(/^egress_unavailable: the egress proxy at .* did not say what it denied session sbx\.[0-9a-f]+: unknown_session: /);
    await host.destroy(handle);

    // The admin channel closed between the process and the read.
    const where = adminPath();
    const admin = await serveAdmin(w.proxy, where.path);
    const cut = new EgressSdk();
    cut.programs.set("cut", async () => {
      await admin.close();
      return { stdout: "" };
    });
    const other = new MxcHost({ sdk: cut, egress: link({ admin: where.path }) });
    const sbx = await open(other, req05([net(["api.github.com"]), { ...FETCH, scope: ["cut"] }]));
    await expect(other.execute(sbx.handle, { argv: ["cut"] })).rejects.toThrow(/^egress_unavailable: the egress proxy at .* did not say what it denied session /);
    await other.destroy(sbx.handle);
    await w.proxy.closeSession(opened.at(-1)!.session).catch(() => undefined);
    where.cleanup();
  });

  it("gives MXC no session address but http://127.0.0.1:<port>: any other is refused by name, and the session closed first", async () => {
    const l = link();
    const host = new MxcHost({ sdk: new EgressSdk(), egress: l });
    const planned = (await adapter(host).plan(req05([net(["api.github.com"])]))) as { policy: MxcPolicy };
    const real = l.openForward.bind(l);
    for (const url of ["http://[::1]:4100", "https://127.0.0.1:4100", "http://127.0.0.1", "http://user@127.0.0.1:4100", "http://127.0.0.1:4100/x", "http://127.0.0.1:4100/?q=1", "http://127.0.0.1:4100#f", "http://127.0.0.1:70000", "not a url"]) {
      closed.length = 0;
      vi.spyOn(l, "openForward").mockImplementationOnce(async (...a) => ({ ...(await real(...a)), proxy_url: url }));
      await expect(host.create(planned.policy, OWNER), url).rejects.toMatchObject({ unsupported: [`an egress proxy whose session is at ${JSON.stringify(url)} (a Bubblewrap sandbox is shown to reach its proxy at http://127.0.0.1:<port> only)`] });
      expect(closed, url).toEqual([opened.at(-1)!.session]);
    }
  });

  it("stops at a proxy whose session lacks a placeholder it was asked for (egress_unavailable), and closes the session first", async () => {
    const l = link();
    const host = new MxcHost({ sdk: new EgressSdk(), egress: l });
    const planned = (await adapter(host).plan(req05([net(["api.github.com"])], { "api.github.com": "github" }))) as { policy: MxcPolicy };
    const real = l.openForward.bind(l);
    vi.spyOn(l, "openForward").mockImplementationOnce(async (...a) => ({ ...(await real(...a)), placeholders: {} }));
    await expect(host.create(planned.policy, OWNER)).rejects.toThrow(/^egress_unavailable: the egress proxy at .* gave session sbx\.[0-9a-f]+ no placeholder for github: it does not answer in the protocol's format$/);
    expect(closed).toEqual([opened[0]!.session]);
  });
});

class WindowsSdk implements WindowsMxcSdk {
  readonly runs: WindowsContainerRequest[] = [];
  getPlatformSupport() {
    return { isSupported: true, availableMethods: ["processcontainer"] };
  }
  getAvailableBackends() {
    return [{ backend: "processcontainer", capabilities: [] }];
  }
  async run(request: WindowsContainerRequest) {
    this.runs.push(request);
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
  }
}

let configs = 0;
function configWith(extra: Record<string, unknown>): RuntimeConfig {
  const dir = mkdtempSync(join(tmpdir(), "mandate-sbx-"));
  const file = join(dir, `mandate.runtime.${++configs}.json`);
  writeFileSync(file, JSON.stringify({ database: "pglite:db", ...extra }));
  return readConfig(file);
}

const built: Adapters[] = [];
afterAll(async () => {
  for (const a of built) await a.egress?.close();
});
function configured(config: RuntimeConfig, src: string, lock: Lock = { modules: {} }, env: NodeJS.ProcessEnv = {}): Adapters {
  const a = adaptersFor(config, check(src, "mdt").program!, lock, env);
  built.push(a);
  return a;
}

describe("Windows", () => {
  it("refuses outbound hosts, method limits and credentials by name: an AppContainer's proxy is best effort", async () => {
    const host = new WindowsMxcHost({ sdk: new WindowsSdk(), build: { build: 26100, ubr: 9550 } });
    expect(await adapter(host).plan(req05([net(["api.github.com"], ["GET"])], { "api.github.com": "github" }))).toEqual({
      unsupported: ["an outbound host allow-list", "method limits on outbound hosts: api.github.com", "credentials for outbound hosts: api.github.com"],
    });
  });

  it("is given no egress proxy by the configuration, which gives a Linux host one", () => {
    const a = configured(configWith({ model: { provider: "anthropic" }, sandbox: { host: "mxc" }, egress: { admin: w.config.admin } }), RUN_SRC, { ...MODELS_LOCK, ...LOCK_BOUND }, { CLAUDE_API_KEY: "made-up" });
    const host = a.loop!.sandbox.o.host;
    if (process.platform === "win32") expect(host).toBeInstanceOf(WindowsMxcHost);
    else expect((host as MxcHost).o.egress).toBeInstanceOf(EgressLink);
  });
});

/** A 0.5 agent that may GET api.github.com with the github credential, and run `fetch`. */
const RUN_SRC = `mandate @ 0.5

module egress.run @ 0.1

use std.{exec, model, net}

capability GitHubRead = net.https(hosts: ["api.github.com"], methods: [GET])
capability Fetching   = exec(commands: ["fetch"])
capability ModelStd   = model.infer(tier: standard)

agent Fetcher {
  caps   GitHubRead, Fetching, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 8 }
  skill fetch(task: Text) -> Inferred<Text> ! {Net, Exec, Model}
}

workflow Fetch(task: Text) -> Inferred<Text>
  caps   GitHubRead, Fetching, ModelStd
  budget { spend: 2 USD }
{
  delegate Fetcher.fetch(task)
}
`;
const LOCK_BOUND: Lock = { modules: {}, egress: { Fetcher: { "api.github.com": "github" } } };
const D = "/defs/Fetch/body/0/value";
const run = (...requests: string[]) => toolUse(`t${requests.length}-${requests.join("").length}`, "run", { command: "fetch", args: requests.flatMap((r) => r.split(" ")) });

/** A run of RUN_SRC whose agent's tools run in an MxcHost with the fake SDK, and whose egress adapters are the configuration's. */
async function egressRun(script: (n: number) => ReturnType<typeof toolUse>[], o: { limit?: number; lock?: Lock; sdk?: EgressSdk; egress?: boolean; admin?: string } = {}) {
  const rw = await runtimeWorld(RUN_SRC, { lock: o.lock ?? LOCK_BOUND, decisions: { mode: "signed" } });
  const sdk = o.sdk ?? new EgressSdk();
  const hostLink = link(o.admin ? { admin: o.admin } : {});
  const host = new MxcHost({ sdk, egress: hostLink });
  const chat = new SimChat((_r, n) => script(n));
  rw.adapters.loop = { chat, sandbox: adapter(host), stopPollMs: 60_000 };
  if (o.egress !== false) {
    const a = configured(configWith({ sandbox: { host: "mxc" }, egress: { admin: w.config.admin } }), RUN_SRC, o.lock ?? LOCK_BOUND);
    Object.assign(rw.adapters, { egress: a.egress, revoke: a.revoke });
  }
  const rt = new Runtime(rw.db, rw.adapters, rw.faults, undefined, { decisions: { mode: "signed" }, ...(o.limit !== undefined ? { violations: { limit: o.limit } } : {}) });
  const violations = async (runId: string) => (await rt.journal.events(runId)).filter((e) => e.type === "violation").map((e) => e.data);
  return { ...rw, rt, sdk, host, hostLink, chat, violations };
}

describe("sandbox egress in a run", () => {
  it("records what the proxy denied a tool call as one egress_denied violation of its step, stops at the limit, and a resumed run counts nothing twice", async () => {
    const r = await egressRun(
      (n) =>
        n === 1
          ? [run("GET http://api.github.com/repos/acme/app")]
          : n === 2
            ? [run("POST http://api.github.com/repos/acme/app/issues", "GET http://evil.example/x")]
            : n === 3
              ? [run("DELETE http://api.github.com/repos/acme/app")]
              : [toolUse("f", "finish", { result: "done" })],
      { limit: 2 },
    );
    const stopped = await r.rt.startRun({ pkg: r.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-run", tenant: "acme" });
    expect(stopped.state, JSON.stringify(stopped.attention ?? stopped.error)).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "violation_limit" });
    const denial = (host: string, method: string, why: string) => ({ id: expect.any(Number), host, method, why, path_digest: expect.stringMatching(/^sha256:/), at: expect.any(String) });
    expect(await r.violations("eg-run")).toEqual([
      { kind: "egress_denied", delegate: D, agent: "Fetcher", step: `${D}/step/1/tool/0`, detail: { denials: [denial("api.github.com", "POST", "method_not_allowed"), denial("evil.example", "GET", "host_not_allowed")], more: 0, counted: 2 }, count: 1 },
      { kind: "egress_denied", delegate: D, agent: "Fetcher", step: `${D}/step/2/tool/0`, detail: { denials: [denial("api.github.com", "DELETE", "method_not_allowed")], more: 0, counted: 1 }, count: 2 },
    ]);
    // The allowed GET went upstream with the secret; the model was told what the process printed, never the secret.
    expect(w.up.seen.map((s) => `${s.method} ${s.url} ${seenHeader(s, "authorization")[0]}`)).toEqual([`GET /repos/acme/app Bearer ${SECRET}`]);
    expect(JSON.stringify(r.chat.calls)).not.toContain(SECRET);
    expect(JSON.stringify(await r.rt.journal.events("eg-run"))).not.toContain(SECRET);

    const resumed = await r.rt.resume("eg-run");
    expect(resumed.state).toBe("succeeded");
    expect(await r.violations("eg-run")).toHaveLength(2);
    expect(r.sdk.spawned).toHaveLength(3);
    // Each sandbox had its session, for this run and tenant, and each was closed with its sandbox.
    expect(opened.map((s) => [s.run, s.tenant, s.command])).toEqual([
      ["eg-run", "acme", D],
      ["eg-run", "acme", D],
    ]);
    expect(closed).toEqual(opened.map((s) => s.session));
    expect((await r.rt.verifyJournal("eg-run")).status).toBe("verified");
  });

  it("counts a tool call whose denials the proxy did not keep: a violation of its step, from the step's result alone", async () => {
    const r = await egressRun((n) => (n === 1 ? [run("GET http://evil.example/a")] : [toolUse("f", "finish", { result: "done" })]));
    // The session's store is full: the proxy kept none of this process's denials, and counts them as dropped.
    vi.spyOn(r.hostLink, "denials").mockResolvedValueOnce({ denials: [], dropped: 6 });
    const ended = await r.rt.startRun({ pkg: r.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-dropped", tenant: "acme" });
    expect(ended.state, JSON.stringify(ended.attention ?? ended.error)).toBe("succeeded");
    expect(await r.violations("eg-dropped")).toEqual([{ kind: "egress_denied", delegate: D, agent: "Fetcher", step: `${D}/step/0/tool/0`, detail: { denials: [], more: 6, counted: 6 }, count: 1 }]);
  });

  it("stops a run whose configured proxy does not answer for a person (egress_unavailable), and goes on when it is resumed once the proxy answers", async () => {
    const where = adminPath();
    const r = await egressRun((n) => (n === 1 ? [run("GET http://api.github.com/repos/acme/app")] : [toolUse("f", "finish", { result: "done" })]), { admin: where.path });
    const stopped = await r.rt.startRun({ pkg: r.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-down", tenant: "acme" });
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "egress_unavailable", message: expect.stringMatching(/^egress_unavailable: the egress proxy at /) });
    expect(r.chat.calls).toEqual([]);
    const admin = await serveAdmin(w.proxy, where.path);
    const resumed = await r.rt.resume("eg-down");
    expect(resumed.state, JSON.stringify(resumed.attention ?? resumed.error)).toBe("succeeded");
    expect(w.up.seen.map((s) => s.url)).toEqual(["/repos/acme/app"]);
    await admin.close();
    where.cleanup();
  });

  it("a cancel revokes the sandbox's session: the process's next request is denied, and that denial is no violation", async () => {
    let entered!: () => void;
    const inside = new Promise<void>((ok) => (entered = ok));
    let go!: () => void;
    const gate = new Promise<void>((ok) => (go = ok));
    const sdk = new EgressSdk();
    sdk.programs.set("fetch", async (request) => {
      entered();
      await gate;
      return fetcher(request);
    });
    const r = await egressRun((n) => (n === 1 ? [run("GET http://api.github.com/repos/acme/app")] : [toolUse("f", "finish", { result: "done" })]), { sdk });
    const running = r.rt.startRun({ pkg: r.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-cancel", tenant: "acme" });
    await inside;
    await r.rt.cancelRun("eg-cancel");
    go();
    const ended = await running;
    expect(ended.state).toBe("cancelled");
    const tool = await r.rt.journal.command("eg-cancel", `${D}/step/0/tool/0`);
    expect((tool?.result as unknown as ExecResult).stdout).toBe("GET http://api.github.com/repos/acme/app 403 session_revoked\n");
    expect((tool?.result as unknown as ExecResult).egress_denials?.denials.map((d) => d.why)).toEqual(["session_revoked"]);
    expect(await r.violations("eg-cancel")).toEqual([]);
    expect(w.up.seen).toEqual([]);
  });

  it("a halt revokes the sandbox's session of every run of its tenant", async () => {
    let entered!: () => void;
    const inside = new Promise<void>((ok) => (entered = ok));
    let go!: () => void;
    const gate = new Promise<void>((ok) => (go = ok));
    let printed = "";
    const sdk = new EgressSdk();
    sdk.programs.set("fetch", async (request) => {
      entered();
      await gate;
      const out = await fetcher(request);
      printed = out.stdout ?? "";
      return out;
    });
    const r = await egressRun((n) => (n === 1 ? [run("GET http://api.github.com/repos/acme/app")] : [toolUse("f", "finish", { result: "done" })]), { sdk });
    const running = r.rt.startRun({ pkg: r.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-halt", tenant: "acme" });
    await inside;
    const report = await r.rt.halt({ tenant: "acme" }, { reason: "test" });
    expect(report.revoke).toBe("revoked");
    go();
    await running;
    expect(printed).toBe("GET http://api.github.com/repos/acme/app 403 session_revoked\n");
    expect(w.up.seen).toEqual([]);
    expect((await r.rt.journal.run("eg-halt")).state).toBe("cancelled");
  });

  it("refuses a start that needs the proxy: no_egress_proxy with none configured; egress_unavailable when it does not answer or lacks a bound credential", async () => {
    const noProxy = await egressRun(() => [], { egress: false });
    await expect(noProxy.rt.startRun({ pkg: noProxy.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-np" })).rejects.toThrow(
      "no_egress_proxy: The package's lock binds github to Fetcher's requests to api.github.com; a credential is put in only by the egress proxy, and this runtime's configuration names none (egress.admin).",
    );
    const [row] = await noProxy.db.query<{ n: number }>("select count(*)::int as n from runs");
    expect(row!.n).toBe(0);

    const silent = await egressRun(() => [], { egress: false });
    const gone = configured(configWith({ sandbox: { host: "mxc" }, egress: { admin: adminPath().path } }), RUN_SRC, LOCK_BOUND);
    silent.rt.adapters.egress = gone.egress!;
    await expect(silent.rt.startRun({ pkg: silent.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-silent" })).rejects.toThrow(/^egress_unavailable: the egress proxy at /);

    const lacking: Lock = { modules: {}, egress: { Fetcher: { "api.github.com": "elsewhere" } } };
    const unheld = await egressRun(() => [], { lock: lacking });
    await expect(unheld.rt.startRun({ pkg: unheld.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-unheld" })).rejects.toThrow(
      /^egress_unavailable: the egress proxy at .* holds no credential elsewhere, which the package's lock binds to Fetcher's requests to api.github.com$/,
    );
  });

  it("asks the proxy nothing at a start whose package needs nothing of it, with no gateway on", async () => {
    const quiet = `mandate @ 0.5

module egress.quiet @ 0.1

use std.{exec, model}

capability Fetching = exec(commands: ["fetch"])
capability ModelStd = model.infer(tier: standard)

agent Fetcher {
  caps   Fetching, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 8 }
  skill fetch(task: Text) -> Inferred<Text> ! {Exec, Model}
}

workflow Fetch(task: Text) -> Inferred<Text>
  caps   Fetching, ModelStd
  budget { spend: 2 USD }
{
  delegate Fetcher.fetch(task)
}
`;
    const rw = await runtimeWorld(quiet, { lock: { modules: {} }, decisions: { mode: "signed" } });
    rw.adapters.loop = { chat: new SimChat(() => [toolUse("f", "finish", { result: "done" })]), sandbox: adapter(new MxcHost({ sdk: new EgressSdk() })) };
    rw.adapters.egress = configured(configWith({ sandbox: { host: "mxc" }, egress: { admin: adminPath().path } }), quiet).egress!;
    const rt = new Runtime(rw.db, rw.adapters, rw.faults, undefined, { decisions: { mode: "signed" } });
    expect((await rt.startRun({ pkg: rw.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-quiet" })).state).toBe("succeeded");
  });

  it("does not start an agent whose credential the proxy does not bind to its host, and says why (E0902)", async () => {
    const lock: Lock = { modules: {}, egress: { Fetcher: { "api.github.com": "model" } } };
    const r = await egressRun(() => [toolUse("f", "finish", { result: "done" })], { lock });
    const ended = await r.rt.startRun({ pkg: r.pkg, workflow: "Fetch", input: { task: "t" }, runId: "eg-unbound" });
    expect(ended.state).toBe("failed");
    expect(JSON.stringify(ended.error)).toContain('"unsupported_sandbox_profile"');
    expect(JSON.stringify(ended.error)).toContain('"unsupported":["credential model for api.github.com"]');
    expect(r.chat.calls).toEqual([]);
    expect(r.sdk.spawned).toEqual([]);
  });
});

// ── On the CI runner: real Bubblewrap sandboxes held to the proxy by MXC ────

const REAL = process.platform === "linux" && process.env["MANDATE_MXC"] === "1";

/** A string as a Mandate string literal: escaped, with no interpolation. */
const mdt = (s: string): string => `"${s.replace(/[\\"{}]/g, (c) => `\\${c}`)}"`;

describe.runIf(REAL)("sandbox egress through real Bubblewrap sandboxes (the CI runner)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-sbx-egress-"));
  const cert = join(dir, "cert.pem");
  const where = adminPath();
  let upstream: HttpServer;
  let tls: HttpsServer;
  let admin: AdminServer;
  let proxy: EgressProxy;
  let host: MxcHost;
  let realLink: EgressLink;
  const upSeen: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  const tlsSeen: Array<{ url: string; servername: string | false | null | undefined }> = [];
  const port = (s: HttpServer | HttpsServer): number => (s.address() as { port: number }).port;

  // What the sandbox runs: curl, which honours the proxy variables the SDK sets; -i prints the status line. The
  // scripts are fixed text, as an exec capability's argument prefixes are, so they are made once the servers listen.
  const CURL = "curl -sS -i --max-time 20";
  const AUTH = `-H "authorization: Bearer $${placeholderVariable("github")}"`;
  /** The address the sandbox sees the proxy at, and its port, read from the proxy variable the SDK set. */
  const AT = 'h=${http_proxy#http://}; h=${h%%:*}; p=${http_proxy##*:}; p=${p%/}; echo "proxy is at $h:$p"; ';
  const DIRECT = "curl -sS --max-time 5 --noproxy '*' -o /dev/null -w 'status=%{http_code}' ";
  let S: Record<"get" | "post" | "other" | "tunnel" | "connectCred" | "directLoopback" | "directGateway" | "proxyPortDirect", string>;
  const shell = (): CapVal => ({ ctor: "exec", effect: "Exec", write: false, scope: ["sh"], argsPrefix: Object.values(S).map((s) => ["-c", s]) });
  const ENV: CapVal = { ctor: "exec", effect: "Exec", write: false, scope: ["env"] };
  const realReq = () =>
    requirementFor({ agent: "Fetcher", def: "sha256:real" }, [net(["cred.test"], ["GET"]), net(["tunnel.test"]), { ctor: "fs.read", effect: "Fs.Read", write: false, scope: [dir] } as CapVal, shell(), ENV, MODEL], 60_000, {
      language: "mandate/0.5",
      lock: { modules: {}, egress: { Fetcher: { "cred.test": "github" } } },
    });
  /** Everything one would need to see from the log: what the sandbox printed and what the proxy denied. */
  const told = (what: string, r: ExecResult): string => `${what}: exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n--- denials ---\n${JSON.stringify(r.egress_denials ?? null)}\n--- host ---\n${host.egressUnavailable ?? host.unavailable ?? "(no problem reported)"}`;
  const sh = async (handle: string, script: string): Promise<ExecResult> => {
    const r = await host.execute(handle, { argv: ["sh", "-c", script] });
    console.log(`[sandbox egress] ${told(script, r)}`);
    return r;
  };

  beforeAll(async () => {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", cert, "-days", "1", "-subj", "/CN=tunnel.test", "-addext", "subjectAltName=DNS:tunnel.test"], { stdio: "ignore" });
    upstream = createHttpServer((req, res) => {
      upSeen.push({ method: req.method!, url: req.url!, authorization: req.headers["authorization"] });
      res.writeHead(200, { "content-type": "text/plain" });
      // It echoes what it was sent, so a secret that came back would show: the proxy scrubs it to the placeholder.
      res.end(`upstream got ${String(req.headers["authorization"])}\n`);
    });
    tls = createHttpsServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(cert) }, (req, res) => {
      tlsSeen.push({ url: req.url!, servername: (req.socket as TLSSocket).servername });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("tunnel-ok\n");
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
    await new Promise<void>((ok) => tls.listen(0, "127.0.0.1", ok));
    const up = port(upstream);
    S = {
      get: `${CURL} ${AUTH} http://cred.test/repos/acme/app`,
      post: `${CURL} -X POST -d x ${AUTH} http://cred.test/repos/acme/app/issues`,
      other: `${CURL} http://other.test/`,
      tunnel: `${CURL} --cacert ${cert} https://tunnel.test/hello`,
      connectCred: `${CURL} https://cred.test/`,
      // Around the proxy: the upstream's own port on the sandbox's loopback, and on the address it sees the proxy at.
      directLoopback: `${DIRECT}http://127.0.0.1:${up}/direct-loopback`,
      directGateway: `${AT}${DIRECT}"http://$h:${up}/direct-gateway"`,
      // The control: the same address, the session's port, answers (400: a forward session takes absolute-form only).
      proxyPortDirect: `${AT}${DIRECT}"http://$h:$p/direct-proxy"`,
    };
    const config = egressConfig({ admin: where.path, credentials: { github: { env: "MANDATE_EGRESS_GITHUB", hosts: ["cred.test"], header: "authorization", template: "Bearer {secret}" } } }, "test", dir);
    proxy = new EgressProxy({
      config,
      secrets: new Map([["github", Buffer.from(SECRET)]]),
      // Every name resolves to one public address, and every connection goes to a local server: no network.
      resolve: async () => [{ address: "93.184.215.14", family: 4 }],
      dial: (r) =>
        new Promise((ok, fail) => {
          // A forwarded request (TLS upstream, as the dialer would give it) to the plain upstream; a tunnel's bytes to the TLS server.
          const s = connect({ host: "127.0.0.1", port: r.tls ? port(upstream) : port(tls) });
          s.once("connect", () => ok(s));
          s.once("error", fail);
        }),
    });
    admin = await serveAdmin(proxy, where.path);
    realLink = new EgressLink({ admin: where.path });
    host = new MxcHost({ egress: realLink });
  });

  afterAll(async () => {
    await realLink?.closeAll();
    await proxy?.close();
    await admin?.close();
    await new Promise<void>((ok) => (upstream ? upstream.close(() => ok()) : ok()));
    await new Promise<void>((ok) => (tls ? tls.close(() => ok()) : ok()));
    where.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("probes Bubblewrap with the proxy as able to hold a sandbox to its hosts", async () => {
    const sdk = (await import("@microsoft/mxc-sdk/v1" as string)) as MxcSdk;
    console.log(`[sandbox egress] bubblewrapNetwork: ${JSON.stringify(sdk.getPlatformSupport().bubblewrapNetwork)}`);
    const can = await host.probe();
    expect(can, `${host.egressUnavailable} / ${host.unavailable}`).toMatchObject({ network: "host_allow_list", egress: { credentials: ["github"] } });
  });

  it("shows the sandbox the placeholder and the proxy variables, never the secret or the runtime's environment", async () => {
    process.env["MANDATE_CANARY_EGRESS"] = "canary-value-e7";
    const { handle } = await open(host, realReq());
    try {
      const r = await host.execute(handle, { argv: ["env"] });
      console.log(`[sandbox egress] ${told("env", r)}`);
      // The names alone, letters apart, so that a log that masks a line still shows which variables the sandbox has.
      const names = r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => l.slice(0, l.indexOf("=")));
      console.log(`[sandbox egress] env names: ${names.map((n) => [...n].join(" ")).join(" | ")}`);
      expect(r.exitCode, told("env", r)).toBe(0);
      expect(r.stdout, told("env", r)).toMatch(new RegExp(`^${placeholderVariable("github")}=mdt-ph-[0-9a-f]{32}$`, "m"));
      expect(r.stdout, told("env", r)).toMatch(/^http_proxy=http:\/\/[0-9.]+:\d+\/?$/m);
      expect(r.stdout).not.toContain(SECRET);
      expect(r.stdout).not.toContain("canary-value-e7");
    } finally {
      delete process.env["MANDATE_CANARY_EGRESS"];
      await host.destroy(handle);
    }
  });

  it("lets an allowed request through, with the secret put in on the way out and scrubbed on the way back", async () => {
    const { handle } = await open(host, realReq());
    try {
      upSeen.length = 0;
      const r = await sh(handle, S.get);
      expect(r.stdout, told("get", r)).toMatch(/^HTTP\/1\.1 200 /);
      expect(upSeen, told("get", r)).toEqual([{ method: "GET", url: "/repos/acme/app", authorization: `Bearer ${SECRET}` }]);
      expect(r.stdout, told("get", r)).toMatch(/upstream got Bearer mdt-ph-[0-9a-f]{32}/);
      expect(r.stdout).not.toContain(SECRET);
      expect(r.egress_denials, told("get", r)).toBeUndefined();
    } finally {
      await host.destroy(handle);
    }
  });

  it("denies another host, a method not allowed, a tunnel to a host with a credential", async () => {
    const { handle } = await open(host, realReq());
    try {
      upSeen.length = 0;
      const post = await sh(handle, S.post);
      expect(post.stdout, told("post", post)).toMatch(/^HTTP\/1\.1 403 [^\n]*\r?\n[\s\S]*x-mandate-egress-denied: method_not_allowed/i);
      expect(post.egress_denials?.denials.map((d) => [d.host, d.method, d.why]), told("post", post)).toEqual([["cred.test", "POST", "method_not_allowed"]]);
      const other = await sh(handle, S.other);
      expect(other.egress_denials?.denials.map((d) => [d.host, d.why]), told("other", other)).toEqual([["other.test", "host_not_allowed"]]);
      const tunnel = await sh(handle, S.connectCred);
      expect(tunnel.exitCode, told("connect to cred.test", tunnel)).not.toBe(0);
      expect(tunnel.egress_denials?.denials.map((d) => [d.host, d.method, d.why]), told("connect to cred.test", tunnel)).toEqual([["cred.test", "CONNECT", "connect_not_allowed"]]);
      expect(upSeen).toEqual([]);
    } finally {
      await host.destroy(handle);
    }
  });

  it("reaches nothing around the proxy: not the upstream's port on the sandbox's loopback, nor on the address it sees the proxy at, where only the session's port answers", async () => {
    const { handle } = await open(host, realReq());
    try {
      upSeen.length = 0;
      // The control: from inside, the proxy's address and port as the proxy variable gives them do answer, the
      // proxy itself, 400 to a request that is not in the form its session takes.
      const control = await sh(handle, S.proxyPortDirect);
      expect(control.stdout, told("the session's port, directly", control)).toMatch(/^proxy is at [0-9.]+:\d+\n[\s\S]*status=400$/);
      expect(control.egress_denials?.denials.map((d) => d.why), told("the session's port, directly", control)).toEqual(["malformed_request"]);
      const loopback = await sh(handle, S.directLoopback);
      expect(loopback.exitCode, told("the upstream's port on the sandbox's loopback", loopback)).not.toBe(0);
      expect(loopback.stdout, told("the upstream's port on the sandbox's loopback", loopback)).not.toMatch(/status=[1-9]/);
      const gateway = await sh(handle, S.directGateway);
      expect(gateway.stdout, told("the upstream's port at the proxy's address", gateway)).toMatch(/^proxy is at [0-9.]+:\d+\n/);
      expect(gateway.exitCode, told("the upstream's port at the proxy's address", gateway)).not.toBe(0);
      expect(gateway.stdout, told("the upstream's port at the proxy's address", gateway)).not.toMatch(/status=[1-9]/);
      expect(upSeen).toEqual([]);
    } finally {
      await host.destroy(handle);
    }
  });

  it("opens an HTTPS tunnel to a host without a credential or a method limit; TLS is the sandbox's own", async () => {
    const { handle } = await open(host, realReq());
    try {
      tlsSeen.length = 0;
      const r = await sh(handle, S.tunnel);
      expect(r.exitCode, told("tunnel", r)).toBe(0);
      // The origin's own answer, over the sandbox's TLS; whether curl also prints the proxy's 200 to CONNECT is curl's to say.
      expect(r.stdout, told("tunnel", r)).toMatch(/HTTP\/1\.1 200 [^\n]*\r?\n[\s\S]*tunnel-ok/);
      expect(r.stdout, told("tunnel", r)).not.toMatch(/x-mandate-egress-denied/i);
      expect(tlsSeen, told("tunnel", r)).toEqual([{ url: "/hello", servername: "tunnel.test" }]);
      expect(r.egress_denials, told("tunnel", r)).toBeUndefined();
    } finally {
      await host.destroy(handle);
    }
  });

  it("writes what the proxy denied an agent's tool call to the journal as a violation", async () => {
    const src = `mandate @ 0.5

module egress.real @ 0.1

use std.{exec, model, net}

capability CredRead = net.https(hosts: ["cred.test"], methods: [GET])
capability Shell    = exec(commands: ["sh"], args_prefix: [["-c", ${mdt(S.get)}], ["-c", ${mdt(S.post)}], ["-c", ${mdt(S.other)}]])
capability ModelStd = model.infer(tier: standard)

agent Fetcher {
  caps   CredRead, Shell, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 8 }
  skill fetch(task: Text) -> Inferred<Text> ! {Net, Exec, Model}
}

workflow Fetch(task: Text) -> Inferred<Text>
  caps   CredRead, Shell, ModelStd
  budget { spend: 2 USD }
{
  delegate Fetcher.fetch(task)
}
`;
    const lock: Lock = { modules: {}, egress: { Fetcher: { "cred.test": "github" } } };
    const rw = await runtimeWorld(src, { lock, decisions: { mode: "signed" } });
    const shell = (id: string, script: string) => toolUse(id, "run", { command: "sh", args: ["-c", script] });
    const chat = new SimChat((_r, n) => (n === 1 ? [shell("a", S.get)] : n === 2 ? [shell("b", S.post), shell("c", S.other)] : [toolUse("f", "finish", { result: "done" })]));
    rw.adapters.loop = { chat, sandbox: adapter(host) };
    rw.adapters.egress = { ready: (need) => realLink.ready({}, need?.credentials ?? []), close: async () => {} };
    rw.adapters.revoke = (scope) => realLink.revoke(scope);
    const rt = new Runtime(rw.db, rw.adapters, rw.faults, undefined, { decisions: { mode: "signed" } });
    const ended = await rt.startRun({ pkg: rw.pkg, workflow: "Fetch", input: { task: "t" }, runId: "real-egress", tenant: "acme" });
    const events = await rt.journal.events("real-egress");
    const v = events.filter((e) => e.type === "violation").map((e) => e.data as { step: string; detail: { denials: Array<{ why: string; host: string }> } });
    const shown = JSON.stringify({ state: ended.state, error: ended.error ?? null, attention: ended.attention ?? null, violations: v }, null, 1);
    console.log(`[sandbox egress] the run: ${shown}`);
    expect(ended.state, shown).toBe("succeeded");
    expect(v.map((x) => [x.step, x.detail.denials.map((d) => `${d.host} ${d.why}`)]), shown).toEqual([
      [`${D}/step/1/tool/0`, ["cred.test method_not_allowed"]],
      [`${D}/step/1/tool/1`, ["other.test host_not_allowed"]],
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(chat.calls)).not.toContain(SECRET);
  });
});
