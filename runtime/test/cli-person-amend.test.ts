// `mandate decide` on an amendment (0.7; spec/attention.md "The command line"; spec/envelope.md "Amendments"): the owner
// of an envelope is shown what a lead asks for and decides it from the list of what waits for their key, signing as
// `mandate amend` would. Every call is a separate CLI call over one PGlite database in a directory. The lead is a model,
// which this configuration does not have: a worker that has one runs the lead over the same database, before the
// decision, as test/cli-amend.test.ts does. The made-up words are no secrets.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, load, packagedLock, type Lock, type WorkflowDef } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { connect, readConfig, runtimeOptions } from "../src/control.js";
import type { WorkerChecker } from "../src/plan.js";
import { buildPackage, Runtime, type Package } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimSandboxHost, simulate, toolUse } from "../src/sim.js";
import type { Value } from "../src/values.js";
import { planChecker } from "./helpers.js";
import { leadChat, program, type Turn } from "./planning.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-person-amend-"));
const CONFIG = join(dir, "mandate.runtime.json");
const KEYS = join(dir, "decision-keys");
const PLAN = join(dir, "plan.mdt");
const LOCK = join(dir, "mandate.lock.json");
const WIDER = program({ budget: "{ tokens: 400k, steps: 400, agents: 12 }" });
writeFileSync(PLAN, program());
writeFileSync(CONFIG, JSON.stringify({ database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" } }));

let checker: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);
afterAll(async () => {
  await checker.close();
  rmSync(dir, { recursive: true, force: true });
});

async function mandate(args: string[], input?: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  const lines =
    input === undefined
      ? undefined
      : (async function* (): AsyncGenerator<string> {
          yield* input;
        })();
  try {
    const code = await main([...args, "--config", CONFIG], (s) => (out += s), {}, undefined, lines);
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

async function person(name: string): Promise<{ key: string; id: string; pem: string }> {
  const home = join(dir, "people", name);
  mkdirSync(home, { recursive: true });
  const key = join(home, `${name}.key`);
  const made = await mandate(["key", "new", "--out", key]);
  expect(made.code, made.err).toBe(0);
  const id = made.out.match(/^key (sha256:[0-9a-f]{64})\n/)![1]!;
  return { key, id, pem: join(home, `${id.slice("sha256:".length)}.pem`) };
}

async function withModel<T>(lead: Turn[], fn: (rt: Runtime) => Promise<T>): Promise<T> {
  const config = readConfig(CONFIG);
  const db = await connect(config);
  try {
    const sim = simulate({});
    sim.adapters.loop = { chat: leadChat(lead).chat, sandbox: new MxcAdapter({ host: new SimSandboxHost(), schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    return await fn(new Runtime(db, sim.adapters, undefined, undefined, { ...runtimeOptions(config, db), plan: { checker } }));
  } finally {
    await db.close();
  }
}

const asks = (reason: string): Turn => [toolUse("a1", "request_amendment", { envelope: (load(WIDER, "mdt").program!.defs["W"] as WorkflowDef).envelope as unknown as Value, reason })];

describe("mandate decide, on an amendment", () => {
  it("lists what a lead asks for, and signs approve and decline as `amend` does", { timeout: 240_000 }, async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    mkdirSync(KEYS);
    for (const p of [alice, bob]) copyFileSync(p.pem, join(KEYS, `${p.id.slice("sha256:".length)}.pem`));
    const lock = {
      lock: "mandate/lock/0.4",
      modules: {},
      models: { standard: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", max_input_tokens: 2000, max_output_tokens: 500 } },
      tariffs: { "claude-opus-5-5": { currency: "USD", as_of: "2026-10-09", micros_per_mtok: { input: 4_000_000, output: 20_000_000, cache_read: 200_000, cache_write: 5_000_000 } } },
      members: { alice: { keys: [alice.id] }, bob: { keys: [bob.id] } },
      roles: { platform_lead: ["alice"], release_manager: ["bob"] },
    };
    writeFileSync(LOCK, JSON.stringify(lock));
    const approved = await mandate(["approve-envelope", PLAN, "--key", alice.key, "--json"]);
    expect(approved.code, approved.err).toBe(0);
    const locked = packagedLock(lock as Lock)!;
    const pkg: Package = buildPackage(check(program(), "mdt").program!, locked);
    // A lead's reason is a model's text: a script and a terminal control in it must stay text.
    const reason = "three <script>alert(1)</script> more\u001b[2J‮ repositories";
    for (const id of ["m1", "m2", "m3", "m4"]) {
      const asked = await withModel([asks(reason)], (rt) => rt.startRun({ pkg, workflow: "W", input: { items: [] }, runId: id }));
      expect(asked.waiting).toMatchObject({ kind: "amendment" });
    }
    // Bob owns no envelope: nothing waits for his key.
    expect((await mandate(["decide", "--key", bob.key])).out).toContain("nothing waits for key");
    const list = await mandate(["decide", "--key", alice.key], []);
    expect(list.out).toMatch(/^4 open decisions for key /);
    const number = (id: string): string => list.out.split("\n").find((l) => l.includes(`run ${id} `))!.match(/^(\d+)\./)![1]!;
    const here = await mandate(["decide", "--key", alice.key], [number("m1"), "approve", "y"]);
    expect(here.code, here.out + here.err).toBe(0);
    for (const raw of ["\u001b", "‮"]) expect(here.out).not.toContain(raw);
    expect(here.out).toContain("amendment, asked of platform_lead");
    expect(here.out).toContain("About to sign as alice (platform_lead): approve");
    expect(here.out).toMatch(/run m1 is now attention_required/);
    const rev = async (id: string): Promise<string> => (await mandate(["status", id])).out.match(/revision (\d+)/)![1]!;
    expect((await mandate(["amend", "m2", "--revision", await rev("m2"), "--key", alice.key, "approve"])).code).toBe(0);
    const record = async (id: string, kind: string): Promise<unknown> => {
      const s = JSON.parse((await mandate(["status", id, "--json"])).out) as { decisions: Array<{ valid: boolean; record: Record<string, unknown> }> };
      const d = s.decisions.find((x) => x.record["kind"] === kind)!;
      expect(d.valid).toBe(true);
      const { at: _at, run: _run, ...rest } = d.record;
      return rest;
    };
    expect(await record("m1", "amend")).toEqual(await record("m2", "amend"));
    // A decline leaves the envelope as it was, and is the same record `amend ... decline` makes.
    // The list is numbered again each time: the number is read from a fresh one.
    const fresh = (await mandate(["decide", "--key", alice.key], [])).out;
    const third = fresh.split("\n").find((l) => l.includes("run m3 "))!.match(/^(\d+)\./)![1]!;
    const declined = await mandate(["decide", "--key", alice.key], [third, "decline", "yes"]);
    expect(declined.code, declined.out + declined.err).toBe(0);
    expect((await mandate(["amend", "m4", "--revision", await rev("m4"), "--key", alice.key, "decline"])).code).toBe(0);
    expect(await record("m3", "decline")).toEqual(await record("m4", "decline"));
  });
});
