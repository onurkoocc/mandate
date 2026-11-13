// `mandate halt` revokes the egress proxy's sessions (spec/boundary.md "Violations and halt", "The control plane's
// gateways"): the operator's command holds no secret and opens no session, but it reaches the proxy named in
// `egress.admin` to cut the sessions of the halted tenant, or of every tenant. The proxy and its upstream are
// in-process, on a socket or pipe of the test's own, with made-up secrets; nothing reaches the network.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { adaptersFor, operatorAdapters, readConfig, type RuntimeConfig } from "../src/control.js";
import { EgressLink, Gateway } from "../src/gateway.js";
import { Runtime } from "../src/runtime.js";
import { adminPath, world as egressWorld, type World as EgressWorld } from "./egress-world.js";
import { closeAll, UNSIGNED, world as runtimeWorld } from "./helpers.js";
import { LOCK } from "./models.js";
import { check } from "@mandate/compiler";

const dir = mkdtempSync(join(tmpdir(), "mandate-halt-revoke-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HUMAN = `mandate @ 0.2

module halt.revoke @ 0.1

use std.{fs, human}

capability Note = fs.read("/tmp/notes")

workflow Ask() -> Untrusted<Text>
  caps   Note
  budget { spend: 1 USD }
{
  human.ask("Ship it?")
}
`;
writeFileSync(join(dir, "ask.mdt"), HUMAN);

let n = 0;
/** A runtime configuration in a directory of its own, with a database of its own. */
function configWith(extra: Record<string, unknown>): { config: RuntimeConfig; file: string } {
  const d = mkdtempSync(join(dir, "c-"));
  const file = join(d, `mandate.runtime.${++n}.json`);
  writeFileSync(file, JSON.stringify({ database: "pglite:db", decisions: { mode: "unsigned" }, ...extra }));
  return { config: readConfig(file), file };
}

async function mandate(file: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, "--config", file], (s) => (out += s), env);
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

let w: EgressWorld;
beforeAll(async () => {
  w = await egressWorld();
});
afterAll(async () => {
  await w.close();
  await closeAll();
});

const links: EgressLink[] = [];
/** A gateway session of a run of `tenant`, open at the proxy once it has carried a request: the way a runtime's adapter holds one. */
async function session(tenant: string, run: string): Promise<Gateway> {
  const link = new EgressLink({ admin: w.config.admin, scope: { tenant, run } });
  links.push(link);
  const gw = new Gateway(link, "github", "github");
  expect((await gw.fetch("https://api.github.com/repos/acme/app")).status).toBe(200);
  return gw;
}
afterEach(async () => {
  for (const l of links.splice(0)) await l.closeAll();
});

/** What the proxy says of a request on the gateway's session: `ok`, or the reason it denied it. */
async function state(gw: Gateway): Promise<string> {
  const r = await gw.fetch("https://api.github.com/repos/acme/app").catch((e: Error) => e);
  if (r instanceof Error) return /session_revoked/.test(r.message) ? "session_revoked" : r.message;
  return r.headers.get("x-mandate-egress-denied") ?? (r.status === 200 ? "ok" : `status ${r.status}`);
}

/** An admin channel that counts the connections it takes, answers `revoke` and `hello`, and tells when they have closed. */
async function counting(mode: "answer" | "silent" = "answer"): Promise<{ path: string; accepted: () => number; open: () => number; requests: string[]; close(): Promise<void> }> {
  const where = adminPath();
  let accepted = 0;
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const server: Server = createServer((s) => {
    accepted++;
    sockets.add(s);
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        requests.push(line);
        if (mode === "answer") s.write(JSON.stringify({ id: (JSON.parse(line) as { id: unknown }).id, ok: true, result: { revoked: [] } }) + "\n");
      }
    });
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
  });
  await new Promise<void>((ok) => server.listen(where.path, ok));
  return {
    path: where.path,
    accepted: () => accepted,
    open: () => sockets.size,
    requests,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
      where.cleanup();
    },
  };
}

async function untilClosed(c: { open(): number }): Promise<void> {
  for (let i = 0; i < 200 && c.open() > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

describe("the operator's adapters", () => {
  it("hold a revoke through the proxy whenever the configuration names one, with or without gateways, and none without", () => {
    expect(operatorAdapters(configWith({}).config).revoke).toBeUndefined();
    expect(operatorAdapters(configWith({}).config).egress).toBeUndefined();
    const admin = operatorAdapters(configWith({ egress: { admin: w.config.admin } }).config);
    expect(admin.revoke).toBeTypeOf("function");
    expect(admin.egress).toBeDefined();
    expect(operatorAdapters(configWith({ egress: { admin: w.config.admin, gateways: { model: "model", github: "github" } } }).config).revoke).toBeTypeOf("function");
    // Gateways without a proxy are a configuration adaptersFor refuses; the halt has nothing to reach, and is not refused.
    expect(operatorAdapters(configWith({ egress: { gateways: { model: "model" } } }).config).revoke).toBeUndefined();
  });

  it("hold no secret and open no session: no connection is made when they are built, and none by a call that revokes nothing", async () => {
    const c = await counting();
    try {
      const a = operatorAdapters(configWith({ egress: { admin: c.path, gateways: { model: "model" } } }).config);
      await a.egress?.close();
      expect(c.accepted()).toBe(0);
      expect(Object.keys(a.tools)).toEqual([]);
      await expect(a.model.infer({} as never)).rejects.toThrow(/no_adapter/);
    } finally {
      await c.close();
    }
  });

  it("refuse no credential in the environment, which the adapters of a run do", async () => {
    const { config } = configWith({ model: { provider: "anthropic" }, github: { repo: "acme/app", workdir: "." }, egress: { admin: w.config.admin, gateways: { model: "model", github: "github" } } });
    const saved = { a: process.env["CLAUDE_API_KEY"], g: process.env["MANDATE_GITHUB_TOKEN"] };
    process.env["CLAUDE_API_KEY"] = "made-up";
    process.env["MANDATE_GITHUB_TOKEN"] = "made-up";
    try {
      expect(() => adaptersFor(config, check(HUMAN, "mdt").program!, LOCK, process.env)).toThrow(/^credential_in_environment: /);
      const a = operatorAdapters(config);
      await a.revoke!({ all: true });
      await a.egress!.close();
    } finally {
      for (const [k, v] of [["CLAUDE_API_KEY", saved.a], ["MANDATE_GITHUB_TOKEN", saved.g]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("Runtime.halt with the operator's adapters", () => {
  /** A run of tenant acme and one of other, waiting, and a session at the proxy for each. */
  async function twoTenants() {
    const rw = await runtimeWorld(HUMAN);
    for (const [tenant, runId] of [["acme", "ha"], ["other", "hb"]] as const) expect((await rw.rt.startRun({ pkg: rw.pkg, workflow: "Ask", input: {}, runId, tenant })).state).toBe("waiting");
    return { rw, a: await session("acme", "ha"), b: await session("other", "hb") };
  }

  it("a halt of a tenant cuts that tenant's sessions and leaves another's working", async () => {
    const { rw, a, b } = await twoTenants();
    const op = new Runtime(rw.db, operatorAdapters(configWith({ egress: { admin: w.config.admin } }).config), undefined, undefined, UNSIGNED);
    const r = await op.halt({ tenant: "acme" }, { by: "ops" });
    await op.adapters.egress?.close();
    expect(r.revoke).toBe("revoked");
    expect(r.ended.map((e) => [e.run, e.state])).toEqual([["ha", "cancelled"]]);
    expect(await state(a)).toBe("session_revoked");
    expect(await state(b)).toBe("ok");
  });

  it("a halt of every tenant cuts every session, those of tenants it ended no run of too", async () => {
    const { rw, a, b } = await twoTenants();
    const c = await session("idle", "hc");
    const op = new Runtime(rw.db, operatorAdapters(configWith({ egress: { admin: w.config.admin, gateways: { github: "github" } } }).config), undefined, undefined, UNSIGNED);
    const r = await op.halt({ all: true });
    await op.adapters.egress?.close();
    expect(r.revoke).toBe("revoked");
    expect(r.ended.map((e) => e.run).sort()).toEqual(["ha", "hb"]);
    for (const gw of [a, b, c]) expect(await state(gw)).toBe("session_revoked");
  });

  it("revokes the scope it was halted for: the proxy is asked for the tenant, or for all, and for nothing else", async () => {
    const rw = await runtimeWorld(HUMAN);
    const c = await counting();
    try {
      const op = new Runtime(rw.db, operatorAdapters(configWith({ egress: { admin: c.path } }).config), undefined, undefined, UNSIGNED);
      await op.halt({ tenant: "acme" });
      await op.halt({ all: true });
      await op.adapters.egress?.close();
      expect(c.requests.map((l) => JSON.parse(l) as Record<string, unknown>).map(({ id: _id, ...rest }) => rest)).toEqual([
        { op: "revoke", tenant: "acme" },
        { op: "revoke", all: true },
      ]);
      expect(c.accepted()).toBe(1);
    } finally {
      await c.close();
    }
  });

  it("a proxy that accepts and never answers fails the revoke within the time it was given, and the halt stands", async () => {
    const rw = await runtimeWorld(HUMAN);
    expect((await rw.rt.startRun({ pkg: rw.pkg, workflow: "Ask", input: {}, runId: "hs", tenant: "acme" })).state).toBe("waiting");
    const c = await counting("silent");
    try {
      const op = new Runtime(rw.db, operatorAdapters(configWith({ egress: { admin: c.path } }).config, { timeoutMs: 300 }), undefined, undefined, UNSIGNED);
      const t = Date.now();
      const r = await op.halt({ tenant: "acme" });
      expect(Date.now() - t).toBeLessThan(5000);
      expect(r.revoke).toEqual({ failed: expect.stringMatching(/^egress_unavailable: the egress proxy at .* did not revoke \{"tenant":"acme"\}: .*did not answer revoke within 300 ms/) });
      expect(r.ended.map((e) => [e.run, e.state])).toEqual([["hs", "cancelled"]]);
      expect(await op.journal.openHalt("acme")).toMatchObject({ lifted_at: null });
      await op.adapters.egress?.close();
    } finally {
      await c.close();
    }
  });
});

describe("mandate halt", () => {
  it("--tenant revokes that tenant's sessions and --all every session; the admin connection is closed when the command ends", async () => {
    const { file } = configWith({ egress: { admin: w.config.admin } });
    const a = await session("default", "ca");
    const b = await session("other", "cb");
    expect((await mandate(file, ["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "c1"])).out).toContain("waiting");

    // The runtime the command builds for a run opens no session of its own here: it has no gateway.
    const halted = await mandate(file, ["halt", "--tenant", "default", "--reason", "drill"]);
    expect(halted.code, halted.err).toBe(0);
    expect(halted.out).toContain("1 run ended\n  c1  default  cancelled\n");
    expect(halted.out).toContain("revoke: done\n");
    expect(await state(a)).toBe("session_revoked");
    expect(await state(b)).toBe("ok");

    await mandate(file, ["halt", "--lift", "--tenant", "default", "--by", "erin"]);
    const all = await mandate(file, ["halt", "--all", "--json"]);
    expect(all.code, all.err).toBe(0);
    expect(JSON.parse(all.out)).toMatchObject({ revoke: "revoked" });
    expect(await state(b)).toBe("session_revoked");
  });

  it("closes its connection to the proxy when it ends, so that nothing holds the process open", async () => {
    const c = await counting();
    try {
      const { file } = configWith({ egress: { admin: c.path } });
      const r = await mandate(file, ["halt", "--tenant", "default"]);
      expect(r.code, r.err).toBe(0);
      expect(c.accepted()).toBe(1);
      await untilClosed(c);
      expect(c.open()).toBe(0);
    } finally {
      await c.close();
    }
  });

  it("--lift and --list never connect to the proxy", async () => {
    const c = await counting();
    try {
      const { file } = configWith({ egress: { admin: c.path } });
      expect((await mandate(file, ["halt", "--tenant", "default"])).code).toBe(0);
      expect(c.accepted()).toBe(1);
      for (const args of [["halt", "--list"], ["halt", "--list", "--json"], ["halt", "--lift", "--tenant", "default", "--by", "erin"], ["halt", "--lift", "--all", "--by", "erin"]]) {
        await mandate(file, args);
      }
      expect(c.accepted()).toBe(1);
      expect(c.requests).toHaveLength(1);
    } finally {
      await c.close();
    }
  });

  it("a dead proxy: the runs have ended and the halt is in force, the report says revoking failed and why, and the exit is 1", async () => {
    const gone = adminPath();
    const { file } = configWith({ egress: { admin: gone.path } });
    expect((await mandate(file, ["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "d1"])).out).toContain("waiting");
    const t = Date.now();
    const r = await mandate(file, ["halt", "--tenant", "default", "--reason", "drill"]);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.code).toBe(1);
    expect(r.out).toContain("1 run ended\n  d1  default  cancelled\n");
    expect(r.out).toMatch(/revoke: FAILED: egress_unavailable: the egress proxy at .* did not revoke \{"tenant":"default"\}: .*cannot reach the egress proxy/);
    expect(r.err).toContain("the halt is in force and its runs have ended, but revoking failed");
    expect((await mandate(file, ["status", "d1"])).out).toContain("cancelled");
    expect((await mandate(file, ["halt", "--list"])).out).toMatch(/tenant default {2}in force; halted at \S+: drill\n$/);
    expect((await mandate(file, ["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "d2"])).err).toContain("halted: Run d2 does not start");
    gone.cleanup();
  });

  it("mandate cancel reaches the proxy from the command line the same way: the run's sessions are cut, another run's are not", async () => {
    const { file } = configWith({ egress: { admin: w.config.admin } });
    expect((await mandate(file, ["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "k1"])).out).toContain("waiting");
    const mine = await session("default", "k1");
    const other = await session("default", "k2");
    const r = await mandate(file, ["cancel", "k1"]);
    expect(r.code, r.err).toBe(0);
    expect(await state(mine)).toBe("session_revoked");
    expect(await state(other)).toBe("ok");
  });

  it("without egress in the configuration, it is as it was: nothing to revoke, exit 0", async () => {
    const { file } = configWith({});
    expect((await mandate(file, ["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "n1"])).out).toContain("waiting");
    const r = await mandate(file, ["halt", "--tenant", "default"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^halted tenant default: halt-\S+\n1 run ended\n {2}n1 {2}default {2}cancelled\nstarts and resumes in tenant default are refused until mandate halt --lift --tenant default --by <you>\nrevoke: nothing configured holds sessions to revoke\n$/);
  });

  it("a credential in the environment does not refuse a halt, with the gateways on", async () => {
    const { file } = configWith({ model: { provider: "anthropic" }, egress: { admin: w.config.admin, gateways: { model: "model" } } });
    const saved = process.env["CLAUDE_API_KEY"];
    process.env["CLAUDE_API_KEY"] = "made-up";
    try {
      const r = await mandate(file, ["halt", "--tenant", "nobody"], { CLAUDE_API_KEY: "made-up", ANTHROPIC_API_KEY: "made-up" });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("revoke: done\n");
    } finally {
      if (saved === undefined) delete process.env["CLAUDE_API_KEY"];
      else process.env["CLAUDE_API_KEY"] = saved;
    }
  });
});
