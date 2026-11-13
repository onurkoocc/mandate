// The commands that take a run id and a gateway's secret in the environment (spec/boundary.md "Where secrets live",
// INV-23): with a gateway on, a command that can run an adapter is refused when the secret is in the runtime's
// environment (`credential_in_environment`); a command that cannot, because the process holds no adapter that could
// use the secret, is not. The read-only commands are built without adapters, `replay` with its tool map and every call
// refused, `cancel` stays refused (it asks an adapter to stop an action) and points to `mandate halt`. The stand-in
// secret is the plain word "made-up". The egress proxy named in the configuration is a socket that only counts the
// connections made to it: a command that reached an adapter of a gateway would make one.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters, ToolAdapter } from "../src/adapters.js";
import { ArtifactStore, DirBlobs } from "../src/artifacts.js";
import { main } from "../src/cli.js";
import { connect, readConfig, replayAdapters } from "../src/control.js";
import { refusingAdapters } from "../src/runtime.js";
import { adminPath } from "./egress-world.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-readonly-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROGRAM = `mandate @ 0.4

module readonly.commands @ 0.1

use std.{fs, human}

role platform_lead "Platform lead"
role reviewer      "Reviewer"

capability Note = fs.read("/tmp/notes")

workflow Ship(title: Text) -> Untrusted<Text>
  envelope {
    owner  platform_lead
    caps   Note
    budget { steps: 5, agents: 2 }
  }
{
  human.ask("Why ship it?", role: reviewer)
}
`;

const SHIP = join(dir, "ship.mdt");
const CLEAN = join(dir, "mandate.runtime.json");
const GATEWAYS = join(dir, "mandate.gateways.json");
const KEYS = join(dir, "decision-keys");
writeFileSync(SHIP, PROGRAM);

/** The secrets of both gateways, in the runtime's environment. */
const SECRET = "made-up";
const SECRETS: NodeJS.ProcessEnv = { CLAUDE_API_KEY: SECRET, ANTHROPIC_API_KEY: SECRET, MANDATE_GITHUB_TOKEN: SECRET };

/** The egress proxy of the configuration: counts the connections it takes, answers none. */
const proxy = adminPath();
let accepted = 0;
const sockets = new Set<Socket>();
const server: Server = createServer((s) => {
  accepted++;
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
  s.on("error", () => undefined);
});

/** One CLI call under a configuration, with an environment of its own. */
async function mandate(config: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, "--config", config], (s) => (out += s), env);
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

let alice: string;
let decision: string;
let artifact: string;

beforeAll(async () => {
  await new Promise<void>((ok) => server.listen(proxy.path, ok));
  writeFileSync(CLEAN, JSON.stringify({ database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" } }));
  // The same database, with both gateways on: what a run is looked at through, with the secrets in the environment.
  writeFileSync(
    GATEWAYS,
    JSON.stringify({ database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" }, model: { provider: "anthropic" }, github: { repos: ["acme/app"] }, egress: { admin: proxy.path, gateways: { model: "model", github: "github" } } }),
  );
  mkdirSync(join(dir, "alice"));
  alice = join(dir, "alice", "alice.key");
  const made = await mandate(CLEAN, {}, "key", "new", "--out", alice);
  expect(made.code, made.err).toBe(0);
  const id = made.out.match(/^key (sha256:[0-9a-f]{64})\n/)![1]!;
  mkdirSync(KEYS);
  copyFileSync(join(dir, "alice", `${id.slice("sha256:".length)}.pem`), join(KEYS, `${id.slice("sha256:".length)}.pem`));
  writeFileSync(join(dir, "mandate.lock.json"), JSON.stringify({ lock: "mandate/lock/0.4", modules: {}, members: { alice: { keys: [id] } }, roles: { platform_lead: ["alice"], reviewer: ["alice"] } }));

  const approved = await mandate(CLEAN, {}, "approve-envelope", SHIP, "--key", alice, "--json");
  expect(approved.code, approved.err).toBe(0);
  decision = (JSON.parse(approved.out) as { decision: string }).decision;
  for (const id of ["r1", "r2"]) {
    const started = await mandate(CLEAN, {}, "run", SHIP, "--workflow", "Ship", "--input", '{"title":"v1"}', "--run-id", id);
    expect(started.code, started.err).toBe(0);
    expect(started.out).toContain("waiting");
  }
  // An artifact of r1, which `mandate artifact` prints.
  const config = readConfig(CLEAN);
  const db = await connect(config);
  try {
    artifact = (await new ArtifactStore(db, new DirBlobs(config.artifacts)).put({ tenant: "default", runId: "r1" }, "the stored bytes")).ref;
  } finally {
    await db.close();
  }
}, 120_000);

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((ok) => server.close(() => ok()));
  proxy.cleanup();
});

describe("the read-only commands with a gateway's secret in the environment", () => {
  const readOnly = (): string[][] => [
    ["status", "r1"],
    ["status", "r1", "--json"],
    ["show", "r1"],
    ["show", "r1", "--format", "json"],
    ["show", "r1", "--audit"],
    ["denials", "r1"],
    ["artifact", "r1", artifact],
    ["decision", "r1", decision],
    ["shadow-diff", "r1", "r2"],
    ["shadow-diff", "r1", "r2", "--json"],
  ];

  it("each runs, and gives what it gives without the secret; the secret is in none of its output, and the proxy is not reached", async () => {
    const before = accepted;
    for (const args of readOnly()) {
      const without = await mandate(GATEWAYS, {}, ...args);
      expect(without.code, `${args.join(" ")}: ${without.err}`).toBe(0);
      const with_ = await mandate(GATEWAYS, SECRETS, ...args);
      expect(with_.code, `${args.join(" ")}: ${with_.err}`).toBe(0);
      expect(with_.out, args.join(" ")).toBe(without.out);
      expect(with_.err, args.join(" ")).toBe(without.err);
      expect(with_.out + with_.err, args.join(" ")).not.toContain(SECRET);
      expect(with_.out, args.join(" ")).not.toContain("credential_in_environment");
    }
    expect(accepted).toBe(before);
  }, 120_000);

  it("print what they print: the run, the stored bytes, the signed decision, the shadow diff", async () => {
    expect((await mandate(GATEWAYS, SECRETS, "status", "r1")).out).toContain("run r1  Ship  waiting");
    expect((await mandate(GATEWAYS, SECRETS, "artifact", "r1", artifact)).out).toBe("the stored bytes");
    expect(JSON.parse((await mandate(GATEWAYS, SECRETS, "decision", "r1", decision)).out)).toMatchObject({ record: { kind: "envelope", member: "alice" } });
    expect((await mandate(GATEWAYS, SECRETS, "shadow-diff", "r1", "r2")).out).toContain("committed in r1");
    expect(JSON.parse((await mandate(GATEWAYS, SECRETS, "denials", "r1")).out)).toMatchObject({ denials: [] });
  }, 60_000);

  it("work with any one of the secrets alone in the environment, and report an unknown run as they did", async () => {
    for (const name of Object.keys(SECRETS)) {
      const r = await mandate(GATEWAYS, { [name]: SECRET }, "status", "r1");
      expect(r.code, `${name}: ${r.err}`).toBe(0);
    }
    const unknown = await mandate(GATEWAYS, SECRETS, "status", "nope");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown_run");
  }, 60_000);
});

describe("replay with a gateway's secret in the environment", () => {
  it("runs, and gives what it gives without the secret; the proxy is not reached", async () => {
    const before = accepted;
    const without = await mandate(GATEWAYS, {}, "replay", "r1");
    expect(without.code, without.err).toBe(0);
    expect(without.out).toMatch(/^replay: partial at \S+\n$/);
    const with_ = await mandate(GATEWAYS, SECRETS, "replay", "r1");
    expect(with_.code, with_.err).toBe(0);
    expect(with_.out).toBe(without.out);
    const json = await mandate(GATEWAYS, SECRETS, "replay", "r1", "--json");
    expect(json.code, json.err).toBe(0);
    expect(json.out + with_.out + with_.err).not.toContain(SECRET);
    expect(accepted).toBe(before);
  }, 60_000);

  it("is built with the configuration's tool map and no adapter that can be called: every call fails with replay_called_adapter", async () => {
    const before = accepted;
    const config = readConfig(GATEWAYS);
    // The secrets are in the environment, and the adapters are built all the same.
    const a = replayAdapters(config, SECRETS);
    expect(Object.keys(a.tools)).toEqual(["git.merge"]);
    expect(a.tools["git.merge"]!.describe().id).toBeTypeOf("string");
    // Nothing that can reach the outside is in the set: no loop, no workspace, no way to revoke, no proxy connection.
    for (const absent of ["loop", "workspace", "revoke", "egress", "executor"]) expect(a, absent).not.toHaveProperty(absent);
    const refused = /^replay_called_adapter: /;
    const tool = a.tools["git.merge"] as ToolAdapter;
    expect(() => a.agents.run({} as never)).toThrow(refused);
    expect(() => a.model.infer({} as never)).toThrow(refused);
    expect(() => a.verifier.check({} as never)).toThrow(refused);
    expect(() => a.reads.call("r", [], {})).toThrow(refused);
    expect(() => a.broker!.query({} as never)).toThrow(refused);
    expect(() => a.samples!.query({} as never)).toThrow(refused);
    expect(() => a.random()).toThrow(refused);
    expect(() => tool.prepare({})).toThrow(refused);
    expect(() => tool.execute({} as never, {} as never, "op")).toThrow(refused);
    expect(() => tool.reconcile({} as never)).toThrow(refused);
    // A call that was not refused would have gone through the github gateway to the proxy.
    expect(accepted).toBe(before);
  });

  it("still refuses a gateway without a proxy", () => {
    expect(() => replayAdapters({ ...readConfig(GATEWAYS), egress: { gateways: { github: "github" } } }, SECRETS)).toThrow(/^no_egress_proxy: /);
  });

  it("refusingAdapters calls nothing it wraps: counted on adapters of its own", async () => {
    const calls: string[] = [];
    const count =
      <T extends (...args: never[]) => unknown>(name: string, f: T) =>
      (...args: Parameters<T>): ReturnType<T> => {
        calls.push(name);
        return f(...args) as ReturnType<T>;
      };
    const tool: ToolAdapter = {
      describe: () => ({ id: "t", digest: "d" }) as ReturnType<ToolAdapter["describe"]>,
      prepare: count("prepare", async () => ({ prepared: true as const })),
      execute: count("execute", async () => ({ unknown: "x" })) as never,
      reconcile: count("reconcile", async () => ({ unknown: "x" })) as never,
    };
    const real = {
      agents: { run: count("agent", async () => ({})) },
      model: { infer: count("infer", async () => ({})), upperBound: count("upperBound", () => ({})) },
      verifier: { check: count("check", async () => ({})) },
      reads: { call: count("read", async () => ({})) },
      tools: { "git.merge": tool },
      clock: { now: () => 0, sleep: async () => undefined },
      random: count("random", () => 0.5),
    } as unknown as Adapters;
    const a = refusingAdapters(real);
    for (const f of [() => a.agents.run({} as never), () => a.model.infer({} as never), () => a.verifier.check({} as never), () => a.reads.call("r", [], {}), () => a.random(), () => a.tools["git.merge"]!.prepare({}), () => a.tools["git.merge"]!.execute({} as never, {} as never, "op"), () => a.tools["git.merge"]!.reconcile({} as never)]) {
      expect(f).toThrow(/^replay_called_adapter: /);
    }
    expect(calls).toEqual([]);
  });
});

describe("the commands that can run an adapter", () => {
  /** Every command that takes a run id and is not read-only, nor replay; and the two that take a program. */
  const refused = (): Array<[string, string[]]> => [
    ["run", ["run", SHIP, "--workflow", "Ship", "--input", '{"title":"v1"}', "--run-id", "r9"]],
    ["approve-envelope", ["approve-envelope", SHIP, "--key", alice]],
    ["approve", ["approve", "r1", "--revision", "1", "--by", "bob"]],
    ["decline", ["decline", "r1", "--revision", "1", "--by", "bob"]],
    ["answer", ["answer", "r1", "--revision", "1", "--by", "bob", "because"]],
    ["reconcile", ["reconcile", "r1", "op"]],
    ["raise-limits", ["raise-limits", "r1", "--revision", "1", "--by", "bob", "--limit", "spend=30USD"]],
    ["amend", ["amend", "r1", "approve", "--revision", "1", "--key", alice]],
    ["cancel", ["cancel", "r1"]],
  ];

  it("are still refused with credential_in_environment, naming the variable and not its value, and the proxy is not reached", async () => {
    const before = accepted;
    for (const [cmd, args] of refused()) {
      const r = await mandate(GATEWAYS, SECRETS, ...args);
      expect(r.code, `${cmd}: ${r.out}${r.err}`).toBe(1);
      expect(r.err, cmd).toMatch(/^mandate: credential_in_environment: the (model|github) gateway is on, and \w+ is set in the runtime's environment/);
      expect(r.out + r.err, cmd).not.toContain(SECRET);
    }
    expect(accepted).toBe(before);
  }, 120_000);

  it("are refused by each secret alone", async () => {
    for (const name of Object.keys(SECRETS)) {
      const r = await mandate(GATEWAYS, { [name]: SECRET }, "approve", "r1", "--revision", "1", "--by", "bob");
      expect(r.code, name).toBe(1);
      expect(r.err, name).toContain(`${name} is set`);
    }
  }, 60_000);

  it("are not refused when the environment holds none", async () => {
    // The refusal is the credential check and nothing else: without a secret the same command gets further.
    const r = await mandate(GATEWAYS, {}, "approve", "r1", "--revision", "1", "--by", "bob");
    expect(r.err).not.toContain("credential_in_environment");
  }, 60_000);
});

describe("mandate cancel with a gateway's secret in the environment", () => {
  it("is refused, and the message points to mandate halt, which stops the run without an adapter; the run is as it was", async () => {
    const r = await mandate(GATEWAYS, SECRETS, "cancel", "r1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("credential_in_environment");
    expect(r.err).toContain("mandate halt --tenant default");
    expect(r.err).toContain("mandate cancel r1 from an environment without the secret");
    expect(r.err).not.toContain(SECRET);
    expect(r.out).toBe("");
    expect((await mandate(GATEWAYS, SECRETS, "status", "r1")).out).toContain("run r1  Ship  waiting");
  }, 60_000);

  it("is the only refusal that points to it, and the pointer is right: mandate halt works from this environment", async () => {
    const other = await mandate(GATEWAYS, SECRETS, "approve", "r1", "--revision", "1", "--by", "bob");
    expect(other.err).not.toContain("mandate halt");
    const listed = await mandate(GATEWAYS, SECRETS, "halt", "--list");
    expect(listed.code, listed.err).toBe(0);
    expect(listed.err).not.toContain("credential_in_environment");
  }, 60_000);
});
