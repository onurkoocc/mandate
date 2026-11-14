// The acceptance of release 0.5, Boundary, from end to end (spec/boundary.md; the plan's last piece). One agent, the
// program and lock of fixtures/boundary/reach.*, is run through the runtime with a model that does three things: it
// prints its environment, it makes a GET to the one host its capability allows, and it makes a request to a host
// outside its grant. What the release promises of that run is asserted here:
//
//   1. the agent's environment holds the placeholder, never the secret, and the secret is nowhere else the agent or
//      anyone who reads the run could look: the model's transcript, the journal, a view, the export;
//   2. the GET gets its 200 and the upstream received the secret; the other host is denied, and the denial stands in
//      the run's audit view as a violation (a role's view shows it without its detail);
//   3. `mandate journal export` and `mandate journal key` give an export and a public key the journal verifies from
//      (`verified`); with one event changed in the database, the next export is `chain_broken` at that event.
//
// The first tier runs everywhere: MXC is a fake SDK whose processes send their requests to their session's proxy port
// as a sandbox's would, the proxy is the in-process one with a resolver and a dialer that lead to a local stand-in
// for the upstream, the model is scripted, and nothing reaches the network. The second runs only on Linux with
// MANDATE_MXC=1 (CI's `sandbox` job): the same scenario in a real Bubblewrap sandbox, with `curl` inside it. When
// MANDATE_ACCEPTANCE_OUT names a directory it leaves there the exports the independent Rust verifier is given.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lock } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { openDb, type Db } from "../src/db.js";
import { serveAdmin, type AdminServer } from "../src/egress/admin.js";
import { egressConfig, readEgressConfig } from "../src/egress/config.js";
import { EgressProxy } from "../src/egress/proxy.js";
import { EvidenceSigner } from "../src/evidence.js";
import type { HostProbe } from "../src/fitness.js";
import { EgressLink } from "../src/gateway.js";
import type { JournalReport } from "../src/journal-chain.js";
import { MxcHost, type MxcContainerRequest } from "../src/mxc.js";
import { Runtime } from "../src/runtime.js";
import { placeholderVariable } from "../src/sandbox.js";
import { SimChat, toolUse } from "../src/sim.js";
import { runView, type AuditView, type RoleView } from "../src/views.js";
import { adapter, EgressSdk } from "./egress-sdk.js";
import { adminPath, http, portOf, SECRET, seenHeader, send, world as egressWorld } from "./egress-world.js";
import { closeAll, world as runtimeWorld } from "./helpers.js";

const fixture = (name: string): string => readFileSync(new URL(`../../fixtures/boundary/${name}`, import.meta.url), "utf8");
const SRC = fixture("reach.mdt");
const LOCK = JSON.parse(fixture("reach.lock.json")) as Lock;

/** The two fixed scripts the program's `exec` capability lets the agent run through `sh -c`, as the program writes them. */
const GET = 'curl -sS -i --max-time 20 -H "authorization: Bearer $MANDATE_EGRESS_PLACEHOLDER_GITHUB" http://api.github.com/repos/acme/app/issues/1';
const OUTSIDE = "curl -sS -i --max-time 20 http://example.org/";
/** A string as a Mandate string literal, as the program spells it. */
const mdt = (s: string): string => `"${s.replace(/[\\"{}]/g, (c) => `\\${c}`)}"`;

/** The workflow's one delegation, and the step of the agent's third turn (its tool call 0): where the denial happens. */
const DELEGATE = "/defs/Reach/body/0/value";
const OUTSIDE_STEP = `${DELEGATE}/step/2/tool/0`;
const RUN = "boundary-acceptance";

afterAll(closeAll);

// ── What the model does ────────────────────────────────────────────────────

/** The model's script: env, the allowed GET, the request outside the grant, and an answer. */
const script = (n: number) => {
  const sh = (id: string, s: string) => toolUse(id, "run", { command: "sh", args: ["-c", s] });
  return n === 1 ? [toolUse("env", "run", { command: "env", args: [] })] : n === 2 ? [sh("get", GET)] : n === 3 ? [sh("outside", OUTSIDE)] : [toolUse("done", "finish", { result: "done" })];
};

/** What the model was shown for each tool call: the text of each tool result (its exit code, then what the process printed), by the call id. */
function shown(chat: SimChat): Map<string, string> {
  const out = new Map<string, string>();
  for (const call of chat.calls)
    for (const m of call.messages as unknown as Array<{ content: unknown }>)
      if (Array.isArray(m.content)) for (const b of m.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) if (b.type === "tool_result" && b.tool_use_id) out.set(b.tool_use_id, typeof b.content === "string" ? b.content : JSON.stringify(b.content));
  return out;
}

// ── The sandbox of the first tier ──────────────────────────────────────────

/** `sh -c <script>` as the host's command line gives it: the script, unquoted. */
const scriptOf = (command: string): string => {
  const quoted = command.slice("sh -c ".length);
  return quoted.startsWith("'") && quoted.endsWith("'") ? quoted.slice(1, -1).replaceAll("'\\''", "'") : quoted;
};

/** A line of shell cut into words: double quotes group, and `$NAME` is what the environment says, as `sh` would read it. */
function words(line: string, env: Record<string, string>): string[] {
  const out: string[] = [];
  let word: string | undefined;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      quoted = !quoted;
      word ??= "";
    } else if (c === " " && !quoted) {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else if (c === "$") {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i + 1))?.[0] ?? "";
      word = (word ?? "") + (env[name] ?? "");
      i += name.length;
    } else word = (word ?? "") + c;
  }
  if (word !== undefined) out.push(word);
  return out;
}

/**
 * The first tier's `sh` and `env`. `sh -c` runs a `curl` of the shapes the fixture's scripts have (-i, -H, a URL),
 * sending its request to the sandbox's proxy in absolute form, as curl does with `http_proxy` set, and printing the
 * answer as `curl -i` does. `env` prints what the SDK gave the process: its environment, and the proxy variable.
 */
function programs(sdk: EgressSdk): void {
  sdk.programs.set("env", async (request: MxcContainerRequest) => {
    const proxy = request.network.runtimeConfig?.networkProxy;
    return { stdout: [...Object.entries(request.environment ?? {}).map(([k, v]) => `${k}=${v}\n`), ...(proxy ? [`http_proxy=${proxy}/\n`] : [])].join("") };
  });
  sdk.programs.set("sh", async (request: MxcContainerRequest) => {
    const [cmd, ...args] = words(scriptOf(request.command), request.environment ?? {});
    const proxy = request.network.runtimeConfig?.networkProxy;
    if (cmd !== "curl" || !proxy) return { stdout: "", exitCode: 127 };
    const headers: string[] = [];
    let url = "";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-H") headers.push(args[++i]!);
      else if (args[i] === "--max-time") i++;
      else if (args[i]!.startsWith("http://")) url = args[i]!;
    }
    const r = await send(portOf(proxy), http([`GET ${url} HTTP/1.1`, `host: ${new URL(url).host}`, ...headers]));
    return { stdout: r.raw.slice(0, r.raw.indexOf("\r\n\r\n") + 4) + r.body };
  });
}

// ── The scenario, and what it leaves ───────────────────────────────────────

/** What a tier brings: how its sandboxes are run, the upstream the proxy sends to, and what it does with the results. */
interface Setup {
  host: MxcHost;
  link: EgressLink;
  /** The requests that reached the upstream. */
  upstream(): Array<{ method: string; url: string; authorization: string | undefined }>;
  /** How the runtime reads the host's tools: a probe of the test's own, or none for the machine's. */
  hostProbe?: HostProbe;
  /** What of the run to say to the log, where a log is all one has. */
  log?: (what: string, text: string) => void;
  /** A directory to leave the exports in, for the Rust verifier. */
  out?: string;
}

/** What the run left, read while the database was open. */
interface Played {
  state: string;
  detail: string;
  chat: SimChat;
  events: Array<{ seq: number; type: string; data: unknown }>;
  audit: AuditView;
  role: RoleView;
  chainBefore: JournalReport;
}

const cli = (dir: () => string) => async (args: string[], config = true): Promise<{ code: number; out: string; err: string }> => {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main(config ? [...args, "--config", join(dir(), "mandate.runtime.json")] : args, (s) => (out += s), {});
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
};

/**
 * The scenario's assertions, for a tier. The run is made once, in `beforeAll`, over a database in a directory of its
 * own; the command line is then given that directory's configuration, as an operator's shell would have it.
 */
function acceptance(setup: () => Promise<Setup>, close: () => Promise<void>): void {
  let dir = "";
  const mandate = cli(() => dir);
  const file = (name: string): string => join(dir, name);
  let s: Setup;
  let played: Played;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mandate-acceptance-"));
    s = await setup();
    writeFileSync(file("mandate.runtime.json"), JSON.stringify({ database: "pglite:db" }));
    const rw = await runtimeWorld(SRC, { lock: LOCK, decisions: { mode: "signed" } });
    const chat = new SimChat((_r, n) => script(n));
    rw.adapters.loop = { chat, sandbox: adapter(s.host) };
    rw.adapters.egress = { ready: (need) => s.link.ready({}, need?.credentials ?? []), close: async () => {} };
    rw.adapters.revoke = (scope) => s.link.revoke(scope);
    const db: Db = await openDb(`pglite:${file("db")}`);
    try {
      const signer = EvidenceSigner.createIn(file(".mandate/evidence.key"));
      const rt = new Runtime(db, rw.adapters, rw.faults, undefined, { signer, decisions: { mode: "signed" }, ...(s.hostProbe ? { hostProbe: s.hostProbe } : {}) });
      const ended = await rt.startRun({ pkg: rw.pkg, workflow: "Reach", input: { task: "reach what you are granted" }, runId: RUN, tenant: "acme" });
      const events = (await rt.journal.events(RUN)).map((e) => ({ seq: e.seq, type: e.type, data: e.data as unknown }));
      const detail = JSON.stringify({ state: ended.state, error: ended.error ?? null, attention: ended.attention ?? null, host: s.host.egressUnavailable ?? s.host.unavailable ?? "(no problem reported)", violations: events.filter((e) => e.type === "violation").map((e) => e.data) }, null, 1);
      s.log?.("the run", detail);
      played = {
        state: ended.state,
        detail,
        chat,
        events,
        audit: (await runView(rt, RUN, { audit: true })).view,
        role: (await runView(rt, RUN, { role: "operator" })).view,
        chainBefore: await rt.verifyJournal(RUN),
      };
    } finally {
      await db.close();
    }
    for (const [id, text] of shown(played.chat)) s.log?.(`what the model was shown for ${id}`, text);
  }, 120_000);

  afterAll(async () => {
    await close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("ends the run, and the agent's tool results hold the placeholder, the answers of the proxy and never the secret", () => {
    expect(played.state, played.detail).toBe("succeeded");
    const results = shown(played.chat);
    expect([...results.keys()], played.detail).toEqual(["env", "get", "outside"]);

    // 1. The environment: the placeholder in its variable, the proxy variable the SDK sets, and no secret.
    const env = results.get("env")!;
    expect(env, played.detail).toMatch(new RegExp(`^${placeholderVariable("github")}=mdt-ph-[0-9a-f]{32}$`, "m"));
    expect(env, played.detail).toMatch(/^http_proxy=http:\/\/[0-9.]+:\d+\/?$/m);
    expect(env).not.toContain(SECRET);

    // 2. The allowed GET: 200, and what the upstream echoed of the credential came back as the placeholder.
    const get = results.get("get")!;
    expect(get, played.detail).toMatch(/^HTTP\/1\.1 200 /m);
    expect(get, played.detail).toMatch(/upstream got Bearer mdt-ph-[0-9a-f]{32}/);
    expect(get).not.toContain(SECRET);
    // The other host: the proxy's own denial, which says it did not send the request.
    const outside = results.get("outside")!;
    expect(outside, played.detail).toMatch(/^HTTP\/1\.1 403 /m);
    expect(outside, played.detail).toMatch(/^x-mandate-egress-denied: host_not_allowed\r?$/im);
    expect(outside).not.toContain(SECRET);
  });

  it("puts the secret into the one request that was allowed, and into nothing else", () => {
    // Only the GET reached the upstream, with the secret the proxy holds; the denied request was never sent.
    expect(s.upstream(), played.detail).toEqual([{ method: "GET", url: "/repos/acme/app/issues/1", authorization: `Bearer ${SECRET}` }]);
  });

  it("leaves the secret nowhere a reader of the run could look: the transcript, the journal, the views, the export, the command line", async () => {
    // The command line's own reading of the run, and the export, are made here, in the order a person would.
    const audit = await mandate(["show", RUN, "--audit"]);
    const auditJson = await mandate(["show", RUN, "--audit", "--format", "json"]);
    const role = await mandate(["show", RUN, "--role", "operator", "--format", "json"]);
    const plain = await mandate(["show", RUN]);
    const exported = await mandate(["journal", "export", RUN]);
    for (const r of [audit, auditJson, role, plain, exported]) expect(r.code, r.err).toBe(0);
    const secretFree: Array<[string, string]> = [
      ["the model's transcript", JSON.stringify(played.chat.calls)],
      ["the journal's events", JSON.stringify(played.events)],
      ["the audit view", JSON.stringify(played.audit)],
      ["the role's view", JSON.stringify(played.role)],
      ["mandate show --audit", audit.out],
      ["mandate show --audit --format json", auditJson.out],
      ["mandate show --role operator", role.out],
      ["mandate show", plain.out],
      ["the export", exported.out],
    ];
    for (const [where, text] of secretFree) {
      expect(text.length, where).toBeGreaterThan(0);
      expect(text, where).not.toContain(SECRET);
    }
    // The placeholder, which proves nothing, is what the transcript and the audit view do hold of the credential: they are not empty of what a tool printed.
    for (const i of [0, 2]) expect(secretFree[i]![1], secretFree[i]![0]).toMatch(/mdt-ph-[0-9a-f]{32}/);
  });

  it("writes the request outside the grant to the journal as one egress_denied violation, and the audit view shows it", async () => {
    const violations = played.events.filter((e) => e.type === "violation").map((e) => e.data as { kind: string; agent: string; step: string; count: number; detail: { denials: Array<{ host: string; method: string; why: string; path_digest: string }>; more: number; counted: number } });
    expect(violations, played.detail).toHaveLength(1);
    const [v] = violations;
    expect(v).toMatchObject({ kind: "egress_denied", delegate: DELEGATE, agent: "Reacher", step: OUTSIDE_STEP, count: 1 });
    expect(v!.detail.denials.map((d) => [d.host, d.method, d.why])).toEqual([["example.org", "GET", "host_not_allowed"]]);
    expect([v!.detail.more, v!.detail.counted]).toEqual([0, 1]);
    // The allowed GET is no violation: the proxy denied nothing of it.
    expect(played.events.filter((e) => e.type === "violation")).toHaveLength(1);

    // Through the API: the audit view carries the violation with its detail, and the chain as verified.
    expect(played.audit.exceptions.violations).toEqual([{ seq: expect.any(Number), at: expect.any(Number), kind: "egress_denied", delegate: DELEGATE, agent: "Reacher", step: OUTSIDE_STEP, count: 1, detail: v!.detail }]);
    expect(played.audit.events.filter((e) => e.type === "violation")).toHaveLength(1);
    expect(played.audit.chain.status).toBe("verified");

    // Through the command line, in the text a person reads and in JSON.
    const text = (await mandate(["show", RUN, "--audit"])).out;
    expect(text).toContain("verified: the chain holds and every state change is anchored.");
    expect(text).toContain("egress_denied");
    expect(text).toContain(v!.detail.denials[0]!.path_digest);
    expect(text).toContain("host_not_allowed");
    const json = JSON.parse((await mandate(["show", RUN, "--audit", "--format", "json"])).out) as AuditView;
    expect(json.kind).toBe("run_audit");
    expect(json.exceptions.violations.map((x) => [x.kind, x.agent, x.step, x.count])).toEqual([["egress_denied", "Reacher", OUTSIDE_STEP, 1]]);
    expect(json.exceptions.violations[0]!.detail).toEqual(v!.detail);
  });

  it("shows a role of the program that a violation happened, and not what it was", async () => {
    expect(played.role.exceptions.violations.map((x) => [x.kind, x.agent, x.step, x.count])).toEqual([["egress_denied", "Reacher", OUTSIDE_STEP, 1]]);
    expect(played.role.exceptions.violations[0]).not.toHaveProperty("detail");
    const digest = (played.audit.exceptions.violations[0]!.detail as { denials: Array<{ path_digest: string }> }).denials[0]!.path_digest;
    const viaCli = await mandate(["show", RUN, "--role", "operator"]);
    const viaJson = await mandate(["show", RUN, "--role", "operator", "--format", "json"]);
    for (const [where, text] of [["the API", JSON.stringify(played.role)], ["the command line", viaCli.out], ["its JSON", viaJson.out]] as const) {
      // A text view escapes the underscore.
      expect(text, where).toMatch(/egress\\?_denied/);
      expect(text, where).not.toContain(digest);
      expect(text, where).not.toContain("host_not_allowed");
      expect(text, where).not.toContain("path_digest");
    }
  });

  it("exports the journal and the key through the command line, verifies it, and finds an event changed in the database where it was changed", async () => {
    // The independent reader's files: the export and the keys, from the command line alone.
    expect(played.chainBefore.status).toBe("verified");
    const exported = await mandate(["journal", "export", RUN, "--out", file("run.json")]);
    expect(exported.code, exported.err).toBe(0);
    expect(exported.out).toMatch(new RegExp(`^run ${RUN}: ${played.events.length} events, \\d+ anchors, written to `));
    const key = await mandate(["journal", "key", "--out", file("cp.pub.pem")]);
    expect(key.code, key.err).toBe(0);
    expect(readFileSync(file("cp.pub.pem"), "utf8")).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----\n$/);
    expect(readFileSync(file("cp.pub.pem"), "utf8")).not.toContain("PRIVATE");

    // From those two files alone, no configuration and no database: verified, through every event.
    const ok = await mandate(["journal", "verify", file("run.json"), "--key", file("cp.pub.pem"), "--json"], false);
    expect(ok.code, ok.out).toBe(0);
    const verified = JSON.parse(ok.out) as JournalReport;
    expect(verified, ok.out).toMatchObject({ status: "verified", findings: [] });
    expect(verified.anchored_through).toBeGreaterThan(0);
    s.log?.("the export verified", ok.out);

    // One event changed in the database: the violation's, as someone who wished it away would.
    const changed = played.events.find((e) => e.type === "violation")!.seq;
    const db = await openDb(`pglite:${file("db")}`);
    try {
      const n = await db.query<{ seq: number }>("update events set data = jsonb_set(data, '{count}', '0') where run_id = $1 and seq = $2 returning seq", [RUN, changed]);
      expect(n).toHaveLength(1);
    } finally {
      await db.close();
    }
    const again = await mandate(["journal", "export", RUN, "--out", file("tampered.json")]);
    expect(again.code, again.err).toBe(0);
    const broken = await mandate(["journal", "verify", file("tampered.json"), "--key", file("cp.pub.pem"), "--json"], false);
    expect(broken.code, broken.out).toBe(1);
    const report = JSON.parse(broken.out) as JournalReport;
    s.log?.("the export after one event was changed", broken.out);
    expect(report.status, broken.out).toBe("broken");
    expect(report.findings.filter((f) => f.code === "chain_broken").map((f) => f.seq), broken.out).toContain(changed);
    expect((await mandate(["journal", "verify", file("tampered.json"), "--key", file("cp.pub.pem")], false)).out).toContain(`chain_broken at seq ${changed}: `);
    // The audit view of the changed journal says so too.
    const view = JSON.parse((await mandate(["show", RUN, "--audit", "--format", "json"])).out) as AuditView;
    expect(view.chain.status).toBe("broken");

    if (s.out) {
      mkdirSync(s.out, { recursive: true });
      for (const name of ["run.json", "tampered.json", "cp.pub.pem"]) writeFileSync(join(s.out, name), readFileSync(file(name)));
      writeFileSync(join(s.out, "tampered-seq"), `${changed}\n`);
    }
  }, 60_000);
}

// ── Everywhere: a fake sandbox SDK, the real proxy in process, a local stand-in upstream ──

describe("the acceptance of 0.5, with a simulated sandbox", () => {
  let w: Awaited<ReturnType<typeof egressWorld>>;
  let link: EgressLink;

  acceptance(
    async () => {
      w = await egressWorld();
      // The stand-in upstream echoes what it was sent, so that a secret that came back would show: the proxy scrubs it.
      w.up.handler = (req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`upstream got ${String(req.headers["authorization"])}\n`);
      };
      const sdk = new EgressSdk();
      programs(sdk);
      link = new EgressLink({ admin: w.config.admin });
      return {
        host: new MxcHost({ sdk, egress: link }),
        link,
        upstream: () => w.up.seen.map((x) => ({ method: x.method, url: x.url, authorization: seenHeader(x, "authorization")[0] })),
        // The lock names least versions; the probe says the tools are there, as a host that has them does.
        hostProbe: { read: async (tool) => (tool === "node" ? { output: "22.23.4" } : { output: "bubblewrap 0.11.0\n", path: "/usr/bin/bwrap", setuid: false }) },
      };
    },
    async () => {
      await link?.closeAll();
      await w?.close();
    },
  );

  it("is the program and lock of the fixture, whose scripts are the ones the model runs, and whose proxy configuration is one the proxy reads", () => {
    for (const s of [GET, OUTSIDE]) expect(SRC).toContain(mdt(s));
    expect(LOCK.egress).toEqual({ Reacher: { "api.github.com": "github" } });
    const where = adminPath();
    try {
      const config = egressConfig({ ...JSON.parse(fixture("reach.egress.json")), admin: where.path }, "reach.egress.json", tmpdir());
      expect(config.credentials["github"]).toEqual({ env: "MANDATE_EGRESS_GITHUB", hosts: ["api.github.com"], header: "authorization", template: "Bearer {secret}" });
    } finally {
      where.cleanup();
    }
    // The example is read as the command line reads it, from its own file.
    expect(readEgressConfig(new URL("../../fixtures/boundary/reach.egress.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).credentials["github"]!.env).toBe("MANDATE_EGRESS_GITHUB");
  });
});

// ── On the CI runner: the same scenario in a real Bubblewrap sandbox, with curl ──

const REAL = process.platform === "linux" && process.env["MANDATE_MXC"] === "1";

describe.runIf(REAL)("the acceptance of 0.5, through a real Bubblewrap sandbox (the CI runner)", () => {
  const where = adminPath();
  let upstream: HttpServer;
  let admin: AdminServer;
  let proxy: EgressProxy;
  let link: EgressLink;
  const seen: Array<{ method: string; url: string; authorization: string | undefined }> = [];

  acceptance(
    async () => {
      upstream = createHttpServer((req, res) => {
        seen.push({ method: req.method!, url: req.url!, authorization: req.headers["authorization"] });
        res.writeHead(200, { "content-type": "text/plain" });
        // It echoes what it was sent: the proxy scrubs the secret to the placeholder on the way back.
        res.end(`upstream got ${String(req.headers["authorization"])}\n`);
      });
      await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
      const port = (upstream.address() as { port: number }).port;
      const config = egressConfig({ ...JSON.parse(fixture("reach.egress.json")), admin: where.path }, "reach.egress.json", tmpdir());
      proxy = new EgressProxy({
        config,
        secrets: new Map([["github", Buffer.from(SECRET)]]),
        // Every name resolves to one public address and every connection goes to the local server: no network.
        resolve: async () => [{ address: "93.184.215.14", family: 4 }],
        dial: () =>
          new Promise((ok, fail) => {
            const c = connect({ host: "127.0.0.1", port });
            c.once("connect", () => ok(c));
            c.once("error", fail);
          }),
      });
      admin = await serveAdmin(proxy, where.path);
      link = new EgressLink({ admin: where.path });
      // The log is all that is left of a run on the runner: everything needed to diagnose a failure is printed.
      const log = (what: string, text: string): void => console.log(`[boundary acceptance] ${what}:\n${text}`);
      const host = new MxcHost({ egress: link });
      log("the host", JSON.stringify(await host.probe()));
      return { host, link, upstream: () => [...seen], log, ...(process.env["MANDATE_ACCEPTANCE_OUT"] ? { out: process.env["MANDATE_ACCEPTANCE_OUT"] } : {}) };
    },
    async () => {
      await link?.closeAll();
      await proxy?.close();
      await admin?.close();
      await new Promise<void>((ok) => (upstream ? upstream.close(() => ok()) : ok()));
      where.cleanup();
    },
  );
});
