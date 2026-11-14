// The checks of .github/workflows/boundary-live.yml (runtime/scripts/boundary-live-check.mjs), on what a run leaves.
// The good input is made here as the workflow makes it, by the same program and lock (fixtures/boundary/reach.*) and
// the same commands, with what only the live run has replaced as the acceptance test replaces it
// (boundary-acceptance.test.ts): a scripted model, a fake sandbox SDK whose processes send their requests to the
// in-process proxy, and a stand-in for api.github.com that answers as GitHub documents, with an x-ratelimit-limit
// of 1,000 to a request with the token and 401 with 60 to one without. The Rust verifier's report is stood in for
// by `mandate journal verify --json`, whose report CI's `rust` job holds byte for byte to the Rust one.
//
// The script passes on that, and for each of the four checks, the evidence that check reads changed makes it fail
// naming that check and no other. It never prints the secret, and prints no file that holds it.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lock } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { EvidenceSigner } from "../src/evidence.js";
import { EgressLink } from "../src/gateway.js";
import { MxcHost, type MxcContainerRequest } from "../src/mxc.js";
import { Runtime } from "../src/runtime.js";
import { SimChat, toolUse } from "../src/sim.js";
import { adapter, EgressSdk } from "./egress-sdk.js";
import { http, portOf, SECRET, send, world as egressWorld } from "./egress-world.js";
import { closeAll, world as runtimeWorld } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../scripts/boundary-live-check.mjs", import.meta.url));
const fixture = (name: string): string => readFileSync(new URL(`../../fixtures/boundary/${name}`, import.meta.url), "utf8");
const SRC = fixture("reach.mdt");
const LOCK = JSON.parse(fixture("reach.lock.json")) as Lock;
const RUN = "reach1";

const GET = 'curl -sS -i --max-time 20 -H "authorization: Bearer $MANDATE_EGRESS_PLACEHOLDER_GITHUB" http://api.github.com/repos/acme/app/issues/1';
const OUTSIDE = "curl -sS -i --max-time 20 http://example.org/";
/** A string as a Mandate string literal, as the program spells it. */
const mdt = (s: string): string => `"${s.replace(/[\\"{}]/g, (c) => `\\${c}`)}"`;

afterAll(closeAll);

/** The script, on a directory, with the secret in its environment as the workflow's check step has it. */
function check(dir: string, secret: string | null = SECRET): { code: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["GITHUB_ACTIONS"];
  delete env["BOUNDARY_LIVE_SECRET"];
  if (secret !== null) env["BOUNDARY_LIVE_SECRET"] = secret;
  const r = spawnSync(process.execPath, [SCRIPT, "check", dir], { env, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
}

/** The verdict lines of the script's output, by check. */
const verdicts = (out: string): Record<string, "PASS" | "FAIL"> => Object.fromEntries([...out.matchAll(/^(PASS|FAIL) (\d [a-z ]+):/gm)].map((m) => [m[2]!, m[1] as "PASS" | "FAIL"]));
const ALL = ["1 environment", "2 authenticated", "3 violation", "4 verified"];

// ── What the model and the sandbox do, as in the acceptance test ───────────

const script = (n: number) => {
  const sh = (id: string, s: string) => toolUse(id, "run", { command: "sh", args: ["-c", s] });
  return n === 1 ? [toolUse("env", "run", { command: "env", args: [] })] : n === 2 ? [sh("get", GET)] : n === 3 ? [sh("outside", OUTSIDE)] : [toolUse("done", "finish", { result: "done" })];
};

/** `sh -c 'curl … URL'` and `env`, as the acceptance test's fake sandbox runs them: the request goes to the session's proxy. */
function programs(sdk: EgressSdk): void {
  sdk.programs.set("env", async (request: MxcContainerRequest) => {
    const proxy = request.network.runtimeConfig?.networkProxy;
    return { stdout: [...Object.entries(request.environment ?? {}).map(([k, v]) => `${k}=${v}\n`), ...(proxy ? [`http_proxy=${proxy}/\n`] : [])].join("") };
  });
  sdk.programs.set("sh", async (request: MxcContainerRequest) => {
    const env = request.environment ?? {};
    const url = /http:\/\/\S+/.exec(request.command)![0].replace(/'$/, "");
    const headers = url.includes("api.github.com") ? [`authorization: Bearer ${env["MANDATE_EGRESS_PLACEHOLDER_GITHUB"] ?? ""}`] : [];
    const proxy = request.network.runtimeConfig!.networkProxy!;
    const r = await send(portOf(proxy), http([`GET ${url} HTTP/1.1`, `host: ${new URL(url).host}`, "user-agent: curl/8.5.0", ...headers]));
    return { stdout: r.raw.slice(0, r.raw.indexOf("\r\n\r\n") + 4) + r.body };
  });
}

describe("boundary-live-check.mjs, the checks of the live acceptance", () => {
  let good = "";
  const dirs: string[] = [];

  beforeAll(async () => {
    good = mkdtempSync(join(tmpdir(), "mandate-live-check-"));
    dirs.push(good);
    const file = (name: string): string => join(good, name);
    const w = await egressWorld();
    // The stand-in for api.github.com: with the token, its 404 for an issue it does not have, with the authenticated
    // rate limit of a GITHUB_TOKEN; without it, 401 with the limit of an unauthenticated request.
    w.up.handler = (req, res) => {
      const authed = req.headers["authorization"] === `Bearer ${SECRET}`;
      res.writeHead(authed ? 404 : 401, { "content-type": "application/json; charset=utf-8", "x-github-request-id": "C0DE:1234:5678:9ABC:DEF0", "x-ratelimit-limit": authed ? "1000" : "60", "x-ratelimit-remaining": authed ? "999" : "59", "x-ratelimit-resource": "core" });
      res.end(authed ? '{"message":"Not Found","status":"404"}' : '{"message":"Bad credentials","status":"401"}');
    };
    const sdk = new EgressSdk();
    programs(sdk);
    const link = new EgressLink({ admin: w.config.admin });
    try {
      writeFileSync(file("mandate.runtime.json"), JSON.stringify({ database: "pglite:db" }));
      writeFileSync(file("input.json"), spawnSync(process.execPath, [SCRIPT, "input"], { encoding: "utf8" }).stdout);
      const rw = await runtimeWorld(SRC, { lock: LOCK, decisions: { mode: "signed" } });
      const host = new MxcHost({ sdk, egress: link });
      rw.adapters.loop = { chat: new SimChat((_r, n) => script(n)), sandbox: adapter(host) };
      rw.adapters.egress = { ready: (need) => link.ready({}, need?.credentials ?? []), close: async () => {} };
      rw.adapters.revoke = (scope) => link.revoke(scope);
      const db = await openDb(`pglite:${file("db")}`);
      try {
        const signer = EvidenceSigner.createIn(file(".mandate/evidence.key"));
        const probe = { read: async (tool: string) => (tool === "node" ? { output: "22.23.4" } : { output: "bubblewrap 0.11.0\n", path: "/usr/bin/bwrap", setuid: false }) };
        const rt = new Runtime(db, rw.adapters, rw.faults, undefined, { signer, decisions: { mode: "signed" }, hostProbe: probe });
        const input = JSON.parse(readFileSync(file("input.json"), "utf8")) as { task: string };
        const ended = await rt.startRun({ pkg: rw.pkg, workflow: "Reach", input, runId: RUN, tenant: "default" });
        expect(ended.state, JSON.stringify(ended.error ?? null)).toBe("succeeded");
      } finally {
        await db.close();
      }
    } finally {
      await link.closeAll();
      await w.close();
    }
    // What the workflow's steps write, with the same commands.
    const mandate = async (args: string[], config = true): Promise<{ code: number; out: string }> => {
      let out = "";
      const code = await main(config ? [...args, "--config", file("mandate.runtime.json")] : args, (s) => (out += s), {});
      return { code, out };
    };
    writeFileSync(file("egress.log"), "mandate egress: ready, (the proxy's ready line)\n");
    writeFileSync(file("run.out"), (await mandate(["status", RUN])).out);
    writeFileSync(file("audit.md"), (await mandate(["show", RUN, "--audit"])).out);
    writeFileSync(file("audit.json"), (await mandate(["show", RUN, "--audit", "--format", "json"])).out);
    writeFileSync(file("export.out"), (await mandate(["journal", "export", RUN, "--out", file("run.json")])).out + (await mandate(["journal", "key", "--out", file("cp.pub.pem")])).out);
    const verify = await mandate(["journal", "verify", file("run.json"), "--key", file("cp.pub.pem"), "--json"], false);
    writeFileSync(file("verify.json"), verify.out);
    writeFileSync(file("verify.exit"), `${verify.code}\n`);
  }, 120_000);

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A copy of the good directory with one file changed. */
  function mutated(name: string, change: (text: string) => string): string {
    const dir = mkdtempSync(join(tmpdir(), "mandate-live-check-"));
    dirs.push(dir);
    cpSync(good, dir, { recursive: true });
    const before = readFileSync(join(dir, name), "utf8");
    const after = change(before);
    expect(after, `the change of ${name}`).not.toBe(before);
    writeFileSync(join(dir, name), after);
    return dir;
  }

  /** The audit view's JSON, with the tool result of one tool call changed. */
  const auditWith = (pick: (call: { stdout: string }) => boolean, change: (stdout: string) => string) => (text: string) => {
    const audit = JSON.parse(text) as { trace: Array<{ kind: string; result: { stdout?: string } | null }> };
    for (const c of audit.trace) if (c.kind === "tool" && c.result && typeof c.result.stdout === "string" && pick({ stdout: c.result.stdout })) c.result.stdout = change(c.result.stdout);
    return JSON.stringify(audit, null, 2);
  };
  const isEnv = (c: { stdout: string }) => c.stdout.includes("MANDATE_EGRESS_PLACEHOLDER_GITHUB=");
  const isGet = (c: { stdout: string }) => c.stdout.includes("x-github-request-id");

  /** The script fails, naming `which` and only it (and `also`, the evidence that holds the secret), and prints no secret. */
  function failsOnly(dir: string, which: string, why: RegExp, also: string[] = []): string {
    const r = check(dir);
    expect(r.code, r.out).toBe(1);
    const v = verdicts(r.out);
    expect(v, r.out).toEqual(Object.fromEntries([...also.map((n) => [n, "FAIL"]), ...ALL.map((n) => [n, n === which ? "FAIL" : "PASS"])]));
    expect(r.out).toMatch(new RegExp(`^FAIL ${which}: ${why.source}`, "m"));
    expect(r.out).toContain(`not shown: ${[...also, which].join("; ")}\n`);
    expect(r.out).not.toContain(SECRET);
    return r.out;
  }

  it("is given the fixture's two scripts, and a task that names each call exactly", () => {
    for (const s of [GET, OUTSIDE]) expect(SRC).toContain(mdt(s));
    const input = JSON.parse(readFileSync(join(good, "input.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(input)).toEqual(["task"]);
    const task = String(input["task"]);
    expect(task).toContain('command "env" with args []');
    for (const s of [GET, OUTSIDE]) expect(task).toContain(`["-c", ${JSON.stringify(s)}]`);
  });

  it("passes on what a good run leaves, prints the evidence, each line quoted, and not the secret", () => {
    const r = check(good);
    expect(r.code, r.out).toBe(0);
    expect(verdicts(r.out), r.out).toEqual(Object.fromEntries(ALL.map((n) => [n, "PASS"])));
    expect(r.out).toMatch(/^PASS 2 authenticated: api\.github\.com answered the GET: \S+ HTTP 404, x-ratelimit-limit 1000 /m);
    expect(r.out).toMatch(/^PASS 3 violation: .* example\.org, host_not_allowed$/m);
    expect(r.out).toContain("all four shown");
    expect(r.out).toContain("the run ended succeeded");
    // The evidence: the audit view a person reads, the verifier's report; every line of a file starts with "| ".
    expect(r.out).toContain("── audit.md ──\n| # Run reach1: Reach, audit\n");
    expect(r.out).toMatch(/^\| {3}"status": "verified",$/m);
    expect(r.out).not.toMatch(/^::/m);
    expect(r.out).not.toContain(SECRET);
  });

  it("1: fails `environment` when the output of env holds the secret, and prints no file that holds it", () => {
    const out = failsOnly(mutated("audit.json", auditWith(isEnv, (s) => `${s}LEAKED=${SECRET}\n`)), "1 environment", /the output of env \(\S+\) holds the secret/, ["0 no secret in the evidence"]);
    // audit.json is searched and never printed (audit.md shows the same view); audit.md, made from the same run, would hold it too.
    expect(out).not.toContain("── audit.json");
    expect(out).toMatch(/^FAIL 0 no secret in the evidence: the secret is in audit\.json$/m);
  });

  it("1: fails `environment` when env has no placeholder, or has a variable that carries a secret", () => {
    failsOnly(mutated("audit.json", auditWith(isEnv, (s) => s.replace(/^MANDATE_EGRESS_PLACEHOLDER_GITHUB=.*\n/m, ""))), "1 environment", /.* has no MANDATE_EGRESS_PLACEHOLDER_GITHUB/);
    failsOnly(mutated("audit.json", auditWith(isEnv, (s) => `${s}CLAUDE_API_KEY=made-up\n`)), "1 environment", /.* has CLAUDE_API_KEY/);
  });

  it("1: says which file holds the secret and does not print it, whichever file it is", () => {
    const r = check(mutated("audit.md", (t) => `${t}\n${SECRET}\n`));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("── audit.md ──\n(not printed: it holds the secret)\n");
    expect(r.out).toMatch(/^FAIL 0 no secret in the evidence: the secret is in audit\.md$/m);
    expect(r.out).not.toContain(SECRET);
  });

  it("2: fails `authenticated` on the rate limit of an unauthenticated request, a 401, or an answer that is not GitHub's", () => {
    failsOnly(mutated("audit.json", auditWith(isGet, (s) => s.replace(/x-ratelimit-limit: 1000/i, "x-ratelimit-limit: 60"))), "2 authenticated", /.*x-ratelimit-limit 60: GitHub's limit for an unauthenticated request is 60/);
    failsOnly(mutated("audit.json", auditWith(isGet, (s) => s.replace(/^HTTP\/1\.1 404 [^\r\n]*/, "HTTP/1.1 401 Unauthorized"))), "2 authenticated", /.*HTTP 401, .*: GitHub answered 401/);
    failsOnly(mutated("audit.json", auditWith(isGet, (s) => s.replace(/^x-github-request-id: .*\r\n/im, ""))), "2 authenticated", /.*no x-github-request-id/);
    failsOnly(mutated("audit.json", auditWith(isGet, () => "HTTP/1.1 403 Forbidden\r\nx-mandate-egress-denied: tunnel_not_allowed\r\n\r\n")), "2 authenticated", /.*the egress proxy denied the GET/);
  });

  it("3: fails `violation` when the audit view has no egress_denied violation for example.org", () => {
    const without = (text: string) => {
      const audit = JSON.parse(text) as { exceptions: { violations: unknown[] } };
      audit.exceptions.violations = [];
      return JSON.stringify(audit, null, 2);
    };
    failsOnly(mutated("audit.json", without), "3 violation", /the audit view has no egress_denied violation for example\.org \(it has 0 violations\)/);
    failsOnly(mutated("audit.json", (t) => t.replaceAll('"host": "example.org"', '"host": "example.net"')), "3 violation", /the audit view has no egress_denied violation for example\.org/);
  });

  it("4: fails `verified` when the verifier's report is not verified, has a finding, or it did not exit 0", () => {
    failsOnly(mutated("verify.json", (t) => t.replace('"status": "verified"', '"status": "broken"')), "4 verified", /verify-journal reports "broken", not verified/);
    failsOnly(mutated("verify.json", (t) => t.replace('"findings": []', '"findings": [{ "code": "chain_broken", "seq": 3 }]')), "4 verified", /verify-journal reports verified with 1 findings/);
    failsOnly(mutated("verify.exit", () => "1\n"), "4 verified", /verify-journal exited 1, not 0/);
    failsOnly(mutated("verify.json", (t) => t.replace(`"run": "${RUN}"`, '"run": "another"')), "4 verified", /verify-journal's report is of run "another"/);
  });

  it("checks nothing without the secret to compare with, and fails every check when the run left nothing", () => {
    for (const secret of [null, ""]) {
      const r = check(good, secret);
      expect(r.code, r.out).toBe(2);
      expect(r.out).toContain("BOUNDARY_LIVE_SECRET is not set");
    }
    const empty = mkdtempSync(join(tmpdir(), "mandate-live-check-"));
    dirs.push(empty);
    const r = check(empty);
    expect(r.code, r.out).toBe(1);
    expect(verdicts(r.out), r.out).toEqual(Object.fromEntries(ALL.map((n) => [n, "FAIL"])));
    expect(r.out).toContain("── audit.md ──\n(not written)\n");
  });
});
