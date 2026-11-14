// The control plane's own adapters behind the egress proxy's gateway sessions
// (spec/boundary.md "The egress proxy", INV-23, G18): with a gateway on, the
// runtime holds a placeholder and a gateway's address, never the secret; the
// proxy, here in-process with an in-process upstream and no network, puts the
// secret in on the way out. The secrets are made-up strings.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "@mandate/bridge";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Adapters, ToolAdapter } from "../src/adapters.js";
import { main } from "../src/cli.js";
import { adaptersFor, readConfig, type RuntimeConfig } from "../src/control.js";
import { verifierEnv } from "../src/env.js";
import { EgressLink, Gateway, GATEWAY_ENV, givenGateway, refuseCredentials } from "../src/gateway.js";
import type { RunRow } from "../src/journal.js";
import { Violation } from "../src/signals.js";
import { ProcessVerifier } from "../src/verifier-service.js";
import { runView } from "../src/views.js";
import { adminPath, OTHER_SECRET, SECRET, seenHeader, world as egressWorld, type World as EgressWorld } from "./egress-world.js";
import { waitOf } from "./fixbug.js";
import { Runtime } from "../src/runtime.js";
import { closeAll, UNSIGNED, world as runtimeWorld } from "./helpers.js";
import { LOCK } from "./models.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** One model call, then a question, then another model call: a run that keeps its gateway between two steps. */
const ASK_TWICE = `mandate @ 0.2

module gateway.probe @ 0.1

use std.{model, human}

capability ModelStd = model.infer(tier: standard)

type Answer = { capital: Text }

workflow Ask(country: Text) -> Inferred<Answer>
  caps   ModelStd
  budget { spend: 1 USD, tokens: 200k }
{
  let first = infer Answer from quote(country)
  let more = human.ask("Again?")
  infer Answer from quote(more)
}
`;
const PROGRAM = check(ASK_TWICE, "mdt").program!;

/** A question and nothing else: a run that calls no adapter. */
const HUMAN = `mandate @ 0.2

module gateway.human @ 0.1

use std.{fs, human}

capability Note = fs.read("/tmp/notes")

workflow Go() -> Untrusted<Text>
  caps   Note
  budget { spend: 1 USD }
{
  human.ask("Go on?")
}
`;

/** Anthropic's two endpoints the model adapter uses, as the in-process upstream answers them. */
function anthropicUpstream(w: EgressWorld): void {
  w.up.handler = (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/messages/count_tokens") return void res.end(JSON.stringify({ input_tokens: 12 }));
    res.end(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: '{"value":{"capital":"Ankara"}}' }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    );
  };
}

let dirs = 0;
/** A runtime configuration in a directory of its own. */
function configWith(extra: Record<string, unknown>): RuntimeConfig {
  const dir = mkdtempSync(join(tmpdir(), "mandate-gw-"));
  const file = join(dir, `mandate.runtime.${++dirs}.json`);
  writeFileSync(file, JSON.stringify({ database: "pglite:db", ...extra }));
  return readConfig(file);
}

const gatewaysOn = (w: EgressWorld, extra: Record<string, unknown> = {}): RuntimeConfig =>
  configWith({ model: { provider: "anthropic" }, github: { repo: "acme/app", workdir: "." }, egress: { admin: w.config.admin, gateways: { model: "model", github: "github" } }, ...extra });

const msg = (id: string) => ({ sender: "test", messageId: id });

let w: EgressWorld;
beforeAll(async () => {
  w = await egressWorld();
});
afterAll(async () => {
  await w.close();
  await closeAll();
});
beforeEach(() => {
  w.up.seen.length = 0;
  anthropicUpstream(w);
});

const opened: Adapters[] = [];
afterAll(async () => {
  for (const a of opened) await a.egress?.close();
});
function adapters(config: RuntimeConfig, run: string, env: NodeJS.ProcessEnv = {}): Adapters {
  const a = adaptersFor(config, PROGRAM, LOCK, env, undefined, { tenant: "acme", run });
  opened.push(a);
  return a;
}

/** A runtime whose model, tools, revocation and proxy check are the configuration's, over the test database. */
async function runtimeWith(a: Adapters) {
  const rw = await runtimeWorld(ASK_TWICE, { lock: LOCK, realModel: a.model });
  Object.assign(rw.rt.adapters, { revoke: a.revoke, egress: a.egress, tools: a.tools });
  return rw;
}

async function answer(rw: Awaited<ReturnType<typeof runtimeWith>>, runId: string, run: RunRow, value: string): Promise<RunRow> {
  return rw.rt.submitInput(runId, msg(`${runId}-${run.revision}`), { commandId: waitOf(run.waiting).command, revision: run.revision, value });
}

describe("the configuration", () => {
  it("takes egress { admin, gateways: { model, github } } and reads it strictly", () => {
    const c = configWith({ egress: { admin: "egress.sock", gateways: { model: "anthropic", github: "github" } } });
    expect(c.egress).toEqual({ admin: join(c.file!, "..", "egress.sock"), gateways: { model: "anthropic", github: "github" } });
    expect(configWith({ egress: { admin: "\\\\.\\pipe\\mandate-egress" } }).egress?.admin).toBe("\\\\.\\pipe\\mandate-egress");
    expect(() => configWith({ egress: { admin: "a.sock", proxy: "x" } })).toThrow(/unknown field egress\.proxy/);
    expect(() => configWith({ egress: { admin: "a.sock", gateways: { model: "anthropic", docker: "d" } } })).toThrow(/unknown field egress\.gateways\.docker/);
    expect(() => configWith({ egress: { admin: "a.sock", gateways: { model: "not a name" } } })).toThrow(/bad_config.*egress\.gateways\.model/);
    expect(() => configWith({ egress: { admin: 3 } })).toThrow(/bad_config.*egress\.admin/);
  });

  it("without egress, builds the adapters as before: the key from the environment, no revocation, no proxy", () => {
    const a = adaptersFor(configWith({ model: { provider: "anthropic" } }), PROGRAM, LOCK, { CLAUDE_API_KEY: "made-up" });
    expect(a.revoke).toBeUndefined();
    expect(a.egress).toBeUndefined();
    expect(() => adaptersFor(configWith({ model: { provider: "anthropic" } }), PROGRAM, LOCK, {})).toThrow(/no_credentials/);
  });
});

describe("refusals at start", () => {
  it("refuses a gateway without a proxy to go through: no_egress_proxy", () => {
    expect(() => adaptersFor(configWith({ model: { provider: "anthropic" }, egress: { gateways: { model: "model" } } }), PROGRAM, LOCK, {})).toThrow(/^no_egress_proxy: .*model gateway/);
    // A section that turns no gateway on asks for nothing.
    expect(adaptersFor(configWith({ egress: { gateways: {} } }), PROGRAM, LOCK, {}).egress).toBeUndefined();
  });

  it("refuses, per variable, a gateway's secret in the runtime's environment: credential_in_environment, naming the variable and not its value", () => {
    const config = gatewaysOn(w);
    for (const name of ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY", "MANDATE_GITHUB_TOKEN"]) {
      let thrown: unknown;
      try {
        adaptersFor(config, PROGRAM, LOCK, { [name]: "made-up-value-91c2" }, undefined, { tenant: "acme", run: "r" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Violation);
      expect((thrown as Violation).code).toBe("credential_in_environment");
      expect((thrown as Violation).message).toContain(name);
      expect((thrown as Violation).message).not.toContain("made-up-value-91c2");
    }
    // Each gateway refuses its own secret: with only the model gateway on, the GitHub token is the GitHub adapter's.
    expect(() => refuseCredentials({ model: "model" }, { MANDATE_GITHUB_TOKEN: "made-up" }, false)).not.toThrow();
    expect(() => refuseCredentials({ github: "github" }, { MANDATE_GITHUB_TOKEN: "made-up" }, false)).toThrow(/credential_in_environment.*MANDATE_GITHUB_TOKEN/);
    // On Windows a variable is found in any case, as Windows reads it; an empty one holds nothing.
    expect(() => refuseCredentials({ model: "model" }, { claude_api_key: "made-up" }, true)).toThrow(/claude_api_key/);
    expect(() => refuseCredentials({ model: "model" }, { claude_api_key: "made-up" }, false)).not.toThrow();
    expect(() => refuseCredentials({ model: "model" }, { CLAUDE_API_KEY: "" }, false)).not.toThrow();
  });

  it("refuses to start a run when the proxy does not answer, or does not hold a gateway's credential: egress_unavailable", async () => {
    const gone = adminPath();
    const down = adapters(configWith({ model: { provider: "anthropic" }, egress: { admin: gone.path, gateways: { model: "model" } } }), "u1");
    const rw = await runtimeWith(down);
    await expect(rw.rt.startRun({ pkg: rw.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "u1" })).rejects.toThrow(/^egress_unavailable: the egress proxy at .*cannot reach/);
    const lacking = adapters(configWith({ model: { provider: "anthropic" }, egress: { admin: w.config.admin, gateways: { model: "anthropic" } } }), "u2");
    const rw2 = await runtimeWith(lacking);
    await expect(rw2.rt.startRun({ pkg: rw2.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "u2" })).rejects.toThrow(/^egress_unavailable: .*holds no credential anthropic, which the model gateway sends/);
    // Nothing started.
    expect(await rw2.db.query("select run_id from runs")).toEqual([]);
    gone.cleanup();
  });
});

describe("the adapters through gateways", () => {
  it("send a model call with the placeholder; the upstream gets the real secret in the configured header", async () => {
    // The SDK client would read a token of its own from the process's environment; through a gateway it reads none.
    process.env["ANTHROPIC_AUTH_TOKEN"] = "made-up-auth-token-3f";
    let a: Adapters;
    try {
      a = adapters(gatewaysOn(w), "g1");
    } finally {
      delete process.env["ANTHROPIC_AUTH_TOKEN"];
    }
    const rw = await runtimeWith(a);
    const run = await rw.rt.startRun({ pkg: rw.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "g1" });
    expect(run.state).toBe("waiting");
    for (const s of w.up.seen) expect(seenHeader(s, "authorization")).toEqual([]);
    // count_tokens and messages, each with the secret the proxy holds for "model", in x-api-key, and nothing else of it.
    expect(w.up.seen.map((s) => s.url)).toEqual(["/v1/messages/count_tokens", "/v1/messages"]);
    for (const s of w.up.seen) {
      expect(seenHeader(s, "x-api-key")).toEqual([OTHER_SECRET]);
      expect(seenHeader(s, "host")).toEqual(["api.anthropic.com"]);
      expect(JSON.stringify(s.headers)).not.toContain("mandate-egress-gateway");
    }
    // The session is the run's, so revoking the run names it.
    expect(await w.client.revoke({ run: "g1" })).toEqual([expect.stringMatching(/^gw\.model\./)]);
  });

  it("send a GitHub call with the placeholder; the upstream gets the real token as a bearer token", async () => {
    w.up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"full_name":"acme/app"}');
    };
    const a = adapters(gatewaysOn(w), "g2");
    expect(await a.tools["git.open_pr"]!.validateBinding!({ repos: ["acme/app"] })).toEqual({ supported: true });
    expect(w.up.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /repos/acme/app"]);
    expect(seenHeader(w.up.seen[0]!, "authorization")).toEqual([`Bearer ${SECRET}`]);
    expect(seenHeader(w.up.seen[0]!, "host")).toEqual(["api.github.com"]);
  });
});

describe("revocation", () => {
  it("after revoke, the run's next model call is refused and the run stops naming session_revoked; no other session is opened", async () => {
    const a = adapters(gatewaysOn(w), "g3");
    const rw = await runtimeWith(a);
    const waiting = await rw.rt.startRun({ pkg: rw.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "g3" });
    const ids = await w.client.revoke({ run: "g3" });
    w.up.seen.length = 0;
    const stopped = await answer(rw, "g3", waiting, "Peru");
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "egress_denied", message: expect.stringContaining("session_revoked") });
    expect(w.up.seen).toEqual([]);
    // The gateway keeps refusing, here, without asking the proxy for a new session.
    await expect(a.model.infer({ type: { ref: "Answer" }, input: "x", tier: "standard", commandId: "c" })).rejects.toThrow(/^egress_denied: session_revoked/);
    expect(await w.client.revoke({ run: "g3" })).toEqual(ids);
  });

  it("a revoked GitHub gateway leaves an action unknown, to be reconciled, never rejected as if GitHub refused it", async () => {
    const a = adapters(gatewaysOn(w), "g4");
    const pr = a.tools["git.open_pr"] as ToolAdapter;
    expect(await pr.validateBinding!({ repos: ["acme/app"] })).toEqual({ supported: true });
    await w.client.revoke({ tenant: "acme" });
    const r = await pr.execute({ effect: "git.open_pr", params: { issue: { id: "7" }, patch: { files: ["a.ts"] } }, actionDigest: "sha256:x", operationKey: "op-1" }, { authorizationId: "z", decidedBy: "ann" }, "op-1");
    expect(r).toEqual({ unknown: expect.stringContaining("egress_denied: session_revoked") });
    expect(await pr.reconcile("op-1")).toEqual({ unknown: expect.stringContaining("session_revoked") });
  });

  it("a cancelled run's sessions are revoked, wherever they were opened", async () => {
    const holder = adapters(gatewaysOn(w), "g5");
    const rw = await runtimeWith(holder);
    expect((await rw.rt.startRun({ pkg: rw.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "g5" })).state).toBe("waiting");
    // Another runtime, as another CLI call would make it, cancels the run.
    const other = adapters(gatewaysOn(w), "g5");
    const rw2 = new Runtime(rw.db, { ...rw.rt.adapters, revoke: other.revoke, egress: other.egress }, undefined, undefined, UNSIGNED);
    expect((await rw2.cancelRun("g5")).state).toBe("cancelled");
    await expect(holder.model.infer({ type: { ref: "Answer" }, input: "x", tier: "standard", commandId: "c" })).rejects.toThrow(/session_revoked/);
  });

  it("revokes by run, tenant or all through the admin channel, and a failure names the proxy", async () => {
    const a = adapters(gatewaysOn(w), "g6");
    const gw = new Gateway(new EgressLink({ admin: w.config.admin, scope: { tenant: "other", run: "g6b" } }), "github", "github");
    expect((await gw.fetch("https://api.github.com/repos/acme/app")).status).toBe(200);
    await a.revoke!({ tenant: "other" });
    expect((await gw.fetch("https://api.github.com/repos/acme/app")).headers.get("x-mandate-egress-denied")).toBe("session_revoked");
    await a.revoke!({ run: "g6" });
    await a.revoke!({ all: true });
    const gone = adminPath();
    const down = adapters(configWith({ egress: { admin: gone.path } }), "g6");
    await expect(down.revoke!({ all: true })).rejects.toThrow(new RegExp(`egress_unavailable: the egress proxy at ${gone.path.replace(/[\\.]/g, "\\$&")} did not revoke`));
    // A cancel is recorded all the same, and the caller is told the proxy did not revoke.
    const rw = await runtimeWorld(HUMAN);
    rw.rt.adapters.revoke = down.revoke;
    expect((await rw.rt.startRun({ pkg: rw.pkg, workflow: "Go", input: {}, runId: "g6c" })).state).toBe("waiting");
    await expect(rw.rt.cancelRun("g6c")).rejects.toThrow(/^egress_unavailable: run g6c is cancelled, and its egress sessions were not revoked: .*did not revoke/);
    expect((await rw.rt.getRun("g6c")).state).toBe("cancelled");
    gone.cleanup();
  });
});

describe("sessions", () => {
  it("are renewed before they would end under a request, and opened again after the proxy says session_expired", async () => {
    let now = 1_000_000;
    const sent: string[] = [];
    const link = new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run: "s1" }, ttlMs: 60_000, renewMs: 10_000, now: () => now });
    const gw = new Gateway(link, "github", "github", "github", async (url, init) => {
      sent.push(new URL(String(url)).port);
      return fetch(url, init);
    });
    await gw.fetch("https://api.github.com/a");
    await gw.fetch("https://api.github.com/b");
    now += 50_001;
    await gw.fetch("https://api.github.com/c");
    expect(sent[0]).toBe(sent[1]);
    expect(sent[2]).not.toBe(sent[1]);
    // The session it replaced is closed; the run has one session left.
    expect(await w.client.revoke({ run: "s1" })).toHaveLength(1);

    const short = new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run: "s2" }, ttlMs: 50, renewMs: 0, now: () => 0 });
    const ports: string[] = [];
    const g2 = new Gateway(short, "github", "github", "github", async (url, init) => {
      ports.push(new URL(String(url)).port);
      return fetch(url, init);
    });
    expect((await g2.fetch("https://api.github.com/a")).status).toBe(200);
    await new Promise((ok) => setTimeout(ok, 120));
    w.up.seen.length = 0;
    // Its own clock says the session lives; the proxy says it expired: the request is sent again on a new one.
    expect((await g2.fetch("https://api.github.com/b")).status).toBe(200);
    expect(ports).toHaveLength(3);
    expect(ports[2]).not.toBe(ports[1]);
    expect(w.up.seen.map((s) => s.url)).toEqual(["/b"]);
    await link.closeAll();
    await short.closeAll();
  });

  it("a revoked session is not replaced, not even when it would be renewed", async () => {
    let now = 0;
    const link = new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run: "s5" }, ttlMs: 60_000, renewMs: 10_000, now: () => now });
    const gw = new Gateway(link, "github", "github");
    expect((await gw.fetch("https://api.github.com/a")).status).toBe(200);
    const ids = await w.client.revoke({ run: "s5" });
    expect((await gw.fetch("https://api.github.com/b")).headers.get("x-mandate-egress-denied")).toBe("session_revoked");
    now += 55_000;
    w.up.seen.length = 0;
    await expect(gw.fetch("https://api.github.com/c")).rejects.toThrow(/^egress_denied: session_revoked: .*opens no other/);
    expect(w.up.seen).toEqual([]);
    expect(await w.client.revoke({ run: "s5" })).toEqual(ids);
    await link.closeAll();
  });

  it("a session port that does not answer is egress_unavailable, and no other session is opened for it", async () => {
    const link = new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run: "s3" } });
    const gw = new Gateway(link, "github", "github");
    expect((await gw.fetch("https://api.github.com/a")).status).toBe(200);
    const [id] = await w.client.revoke({ run: "s3" });
    await w.client.closeSession(id!);
    await expect(gw.fetch("https://api.github.com/b")).rejects.toThrow(/^egress_unavailable: the github gateway's session .* does not answer/);
    expect(await w.client.revoke({ run: "s3" })).toEqual([]);
    await link.closeAll();
  });

  it("reach only their own host", async () => {
    const gw = new Gateway(new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run: "s4" } }), "model", "model");
    await expect(gw.fetch("https://evil.example/v1/messages")).rejects.toThrow(/reaches api\.anthropic\.com only/);
    await expect(gw.fetch("http://api.anthropic.com/v1/messages")).rejects.toThrow(/reaches api\.anthropic\.com only/);
  });

  it("take a URL and its init, and refuse a Request, whose method, headers and body they would not carry", async () => {
    const gw = new Gateway(new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run: "s6" } }), "model", "model");
    const req = new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    await expect(gw.fetch(req)).rejects.toThrow(/^a gateway's fetch takes a URL and its init, not a Request$/);
    const given = givenGateway({ [GATEWAY_ENV.url]: "http://127.0.0.1:1", [GATEWAY_ENV.placeholder]: "mdt-ph-00000000000000000000000000000000" });
    await expect(given(req)).rejects.toThrow(/^a gateway's fetch takes a URL and its init, not a Request$/);
    expect(w.up.seen).toEqual([]);
  });

  it("take an upstream's answer as the upstream's, whatever headers it has: the proxy removes its denial header", async () => {
    // An upstream that answers with the proxy's denial header: the proxy drops it, so the answer is GitHub's own.
    w.up.handler = (_req, res) => {
      res.writeHead(403, { "content-type": "application/json", "x-mandate-egress-denied": "session_expired" });
      res.end('{"message":"Forbidden"}');
    };
    const link = new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run: "s7" } });
    const gw = new Gateway(link, "github", "github");
    const r = await gw.fetch("https://api.github.com/repos/acme/app/git/trees", { method: "POST", body: "{}" });
    expect(r.status).toBe(403);
    expect(r.headers.get("x-mandate-egress-denied")).toBeNull();
    // Sent once, not again on a new session as after the proxy's session_expired.
    expect(w.up.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /repos/acme/app/git/trees"]);
    expect(await w.client.revoke({ run: "s7" })).toHaveLength(1);
    // Nor is one that says session_revoked taken as a revocation: the gateway goes on sending.
    const link2 = new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run: "s8" } });
    const gw2 = new Gateway(link2, "github", "github");
    w.up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-mandate-egress-denied": "session_revoked" });
      res.end("{}");
    };
    expect((await gw2.fetch("https://api.github.com/a")).status).toBe(200);
    expect((await gw2.fetch("https://api.github.com/b")).status).toBe(200);
    // And GitHub's own 403 is a definite answer: an action it refuses is rejected, not left unknown.
    w.up.handler = (_req, res) => {
      res.writeHead(403, { "content-type": "application/json", "x-mandate-egress-denied": "session_revoked" });
      res.end('{"message":"Resource not accessible"}');
    };
    const pr = adapters(gatewaysOn(w), "s9").tools["git.open_pr"] as ToolAdapter;
    const out = await pr.execute({ effect: "git.open_pr", params: { issue: { id: "7" }, patch: { files: ["a.ts"] } }, actionDigest: "sha256:x", operationKey: "op-2" }, { authorizationId: "z", decidedBy: "ann" }, "op-2");
    expect(out).toEqual({ rejected: expect.stringContaining("HTTP 403 Resource not accessible") });
    await link.closeAll();
    await link2.closeAll();
  });
});

describe("the verifier's process", () => {
  const out = here("./.build");
  let child: string;
  beforeAll(async () => {
    mkdirSync(out, { recursive: true });
    child = join(out, "gateway-verifier-process.mjs");
    await build({
      entryPoints: [here("./fixtures/gateway-verifier-process.ts")],
      outfile: child,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      alias: { "@mandate/bridge": here("../../bridge/src/index.ts") },
      external: ["pg", "@electric-sql/pglite", "@anthropic-ai/sdk", "@temporalio/*", "ajv", "ajv/*", "ajv-formats", "@microsoft/mxc-sdk", "@microsoft/mxc-sdk/*"],
      logLevel: "error",
    });
  }, 60_000);

  it("gets a session of its own: its address and placeholder, never a secret; its request reaches the upstream with the secret", async () => {
    const config = gatewaysOn(w, { verifier: { workdir: ".", base: "seed", suites: {}, process: {} } });
    const before = { ...process.env };
    // What the runtime's environment holds besides: nothing of the model's credential, since the gateway is on.
    process.env["MANDATE_CANARY_KEY"] = "sk-canary";
    process.env["CLAUDE_WORKSPACE_ID"] = "wrkspc_made_up";
    try {
      const env = { ...process.env };
      delete env["CLAUDE_API_KEY"];
      delete env["ANTHROPIC_API_KEY"];
      delete env["MANDATE_GITHUB_TOKEN"];
      const a = adaptersFor(config, PROGRAM, LOCK, env, [process.execPath, child], { tenant: "acme", run: "v1" });
      opened.push(a);
      const verifier = a.verifier as ProcessVerifier;
      const r = await verifier.check({ method: "test.suite", args: [], named: {}, contract: "C", criterion: "k" });
      verifier.close();
      const d = r.detail as { env: Record<string, string>; status: number; body: string };
      expect(d.status, JSON.stringify(d)).toBe(200);
      expect(seenHeader(w.up.seen.at(-1)!, "x-api-key")).toEqual([OTHER_SECRET]);
      const names = Object.keys(d.env).map((k) => k.toUpperCase());
      expect(d.env[GATEWAY_ENV.url]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(d.env[GATEWAY_ENV.placeholder]).toMatch(/^mdt-ph-[0-9a-f]{32}$/);
      expect(d.env["CLAUDE_WORKSPACE_ID"]).toBe("wrkspc_made_up");
      for (const secret of ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY", "MANDATE_GITHUB_TOKEN", "MANDATE_CANARY_KEY", "ANTHROPIC_BASE_URL", "HTTPS_PROXY"]) expect(names).not.toContain(secret);
      expect(JSON.stringify(d.env)).not.toContain(OTHER_SECRET);
      expect(JSON.stringify(d.env)).not.toContain(SECRET);
      // A session of its own, for the run: the runtime's model gateway opened none, since it sent nothing.
      expect(await w.client.revoke({ run: "v1" })).toEqual([expect.stringMatching(/^gw\.verifier\.model\./)]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      Object.assign(process.env, before);
    }
  });

  it("without the gateway, gets the model's key as before", () => {
    const from = { PATH: "/usr/bin", CLAUDE_API_KEY: "made-up", CLAUDE_WORKSPACE_ID: "w" };
    expect(verifierEnv({ model: true }, from)["CLAUDE_API_KEY"]).toBe("made-up");
    const gw = verifierEnv({ model: true, gateway: { url: "http://127.0.0.1:1", placeholder: "mdt-ph-0" } }, from);
    expect(gw).toEqual({ PATH: "/usr/bin", CLAUDE_WORKSPACE_ID: "w", [GATEWAY_ENV.url]: "http://127.0.0.1:1", [GATEWAY_ENV.placeholder]: "mdt-ph-0" });
  });
});

describe("replay and the views", () => {
  it("work with the proxy stopped: replay never touches it, and a view or a status calls no adapter", async () => {
    const own = await egressWorld();
    anthropicUpstream(own);
    const a = adaptersFor(gatewaysOn(own), PROGRAM, LOCK, {}, undefined, { tenant: "acme", run: "rp1" });
    const rw = await runtimeWith(a);
    const waiting = await rw.rt.startRun({ pkg: rw.pkg, workflow: "Ask", input: { country: "Turkey" }, runId: "rp1" });
    const done = await answer(rw, "rp1", waiting, "Peru");
    expect(done.state).toBe("succeeded");
    await a.egress!.close();
    await own.close();
    // A runtime made after the proxy stopped, as `mandate replay` or `mandate show` makes it.
    const later = adaptersFor(gatewaysOn(own), PROGRAM, LOCK, {}, undefined, { tenant: "acme", run: "rp1" });
    Object.assign(rw.rt.adapters, { model: later.model, revoke: later.revoke, egress: later.egress });
    expect(await rw.rt.replayRun("rp1")).toEqual({ status: "complete", value: { capital: "Ankara" } });
    const { view } = await runView(rw.rt, "rp1");
    expect(view.run.state).toBe("succeeded");
    await later.egress!.close();
  });

  it("from the CLI: a run starts with the proxy up; with it stopped, status, show and replay work and a start is refused", async () => {
    const own = await egressWorld();
    const dir = mkdtempSync(join(tmpdir(), "mandate-gw-cli-"));
    writeFileSync(join(dir, "ship.mdt"), HUMAN);
    const file = join(dir, "mandate.runtime.json");
    writeFileSync(file, JSON.stringify({ database: "pglite:db", decisions: { mode: "unsigned" }, github: { repos: ["acme/app"] }, egress: { admin: own.config.admin, gateways: { model: "model", github: "github" } } }));
    const mandate = async (env: NodeJS.ProcessEnv, ...args: string[]) => {
      let out = "";
      let err = "";
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
      try {
        return { code: await main([...args, "--config", file], (s) => (out += s), env), out, err };
      } finally {
        process.stderr.write = write;
      }
    };
    const started = await mandate({}, "run", join(dir, "ship.mdt"), "--workflow", "Go", "--input", "{}", "--run-id", "c1");
    expect(started.code, started.err).toBe(0);
    expect(started.out).toContain("waiting");
    // A command that can run an adapter is refused with the secret in the environment; a status holds no adapter, and is not
    // (test/readonly-commands.test.ts has the rest of the commands).
    const refused = await mandate({ MANDATE_GITHUB_TOKEN: "made-up" }, "approve", "c1");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("credential_in_environment");
    expect(refused.err).not.toContain("made-up");
    expect((await mandate({ MANDATE_GITHUB_TOKEN: "made-up" }, "status", "c1")).code).toBe(0);
    await own.close();
    for (const cmd of ["status", "show", "replay"]) {
      const r = await mandate({}, cmd, "c1");
      expect(r.code, `${cmd}: ${r.err}`).toBe(0);
    }
    const down = await mandate({}, "run", join(dir, "ship.mdt"), "--workflow", "Go", "--input", "{}", "--run-id", "c2");
    expect(down.code).toBe(1);
    expect(down.err).toContain("egress_unavailable");
    expect((await mandate({}, "status", "c2")).err).toContain("unknown_run");
  }, 30_000);
});
