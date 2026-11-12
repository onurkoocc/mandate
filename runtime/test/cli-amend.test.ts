// Deciding an amendment from the control CLI (language 0.4; spec/envelope.md
// "Amendments" and "The CLI", case N04). A lead asks for a wider envelope, and
// the run waits. `mandate status` shows the owner what the amendment changes
// and the hash they would sign for; `mandate amend <run> approve` or `decline`
// is their signed decision. Every call here is a separate CLI call over one
// PGlite database in a directory, as a person would make it. The lead is a
// model, which this configuration does not have: a worker that has one runs
// the lead over the same database, before the decision and after it.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, load, packagedLock, type Lock, type WorkflowDef } from "@mandate/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { connect, readConfig, runtimeOptions } from "../src/control.js";
import type { RunRow } from "../src/journal.js";
import type { WorkerChecker } from "../src/plan.js";
import { buildPackage, Runtime, type Package } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimSandboxHost, SimTool, simulate, toolUse } from "../src/sim.js";
import type { Value } from "../src/values.js";
import { planChecker } from "./helpers.js";
import { finish, leadChat, program, type Turn } from "./planning.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-amend-"));
const CONFIG = join(dir, "mandate.runtime.json");
const KEYS = join(dir, "decision-keys");
const PLAN = join(dir, "plan.mdt");
const LOCK = join(dir, "mandate.lock.json");
/** The envelope with twice the tokens: what the lead asks for. */
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

/** One CLI call, as a person would make it; returns its exit status and output. */
async function mandate(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, "--config", CONFIG], (s) => (out += s), {});
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

interface Person {
  key: string;
  id: string;
  pem: string;
}

/** A person's key, made by `mandate key new` in a directory of their own. */
async function person(name: string): Promise<Person> {
  const home = join(dir, "people", name);
  mkdirSync(home, { recursive: true });
  const key = join(home, `${name}.key`);
  const made = await mandate("key", "new", "--out", key);
  expect(made.code, made.err).toBe(0);
  const id = made.out.match(/^key (sha256:[0-9a-f]{64})\n/)![1]!;
  return { key, id, pem: join(home, `${id.slice("sha256:".length)}.pem`) };
}

/** A worker that has a model, over the CLI's database and stores: it plays the lead's next turns. */
async function withModel<T>(lead: Turn[], fn: (rt: Runtime) => Promise<T>, tools: SimTool[] = []): Promise<T> {
  const config = readConfig(CONFIG);
  const db = await connect(config);
  try {
    const sim = simulate({ tools });
    sim.adapters.loop = { chat: leadChat(lead).chat, sandbox: new MxcAdapter({ host: new SimSandboxHost(), schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    return await fn(new Runtime(db, sim.adapters, undefined, undefined, { ...runtimeOptions(config, db), plan: { checker } }));
  } finally {
    await db.close();
  }
}

const asks = (reason: string): Turn => [toolUse("a1", "request_amendment", { envelope: (load(WIDER, "mdt").program!.defs["W"] as WorkflowDef).envelope as unknown as Value, reason })];

interface Status {
  run: RunRow;
  decisions?: Array<{ decision_id: string; valid: boolean; record: { kind: string; member: string; subject: string; role?: string } }>;
}

let alice: Person;
let bob: Person;
let pkg: Package;
/** The lock the packages of these tests are built with. */
let locked: Lock;
/** The hash of the package the runs start under, and of the one with the wider envelope. */
let from: string;
let to: string;

describe("mandate amend", () => {
  it("shows the owner what a lead asks for, takes nobody else's decision, and moves the run on the owner's", async () => {
    // Alice is the platform lead, who owns the envelope. Bob is the release manager.
    [alice, bob] = [await person("alice"), await person("bob")];
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
    const approved = await mandate("approve-envelope", PLAN, "--key", alice.key, "--json");
    expect(approved.code, approved.err).toBe(0);
    from = (JSON.parse(approved.out) as { package: string }).package;
    locked = packagedLock(lock as Lock)!;
    pkg = buildPackage(check(program(), "mdt").program!, locked);
    expect(pkg.hash).toBe(from);
    to = buildPackage(check(WIDER, "mdt").program!, locked).hash;

    // The lead asks, and the run waits.
    const asked = await withModel([asks("three more repositories")], (rt) => rt.startRun({ pkg, workflow: "W", input: { items: [] }, runId: "a1" }));
    expect(asked.waiting).toMatchObject({ kind: "amendment", request: { from, package: to } });
    const rev = String(asked.revision);

    // What the owner reads before signing: who asks, both hashes, each line that changes, and the lead's reason as a model's text.
    const status = await mandate("status", "a1");
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain("waiting for: platform_lead to decide an amendment of W's envelope, asked by Lead.finish");
    expect(status.out).toContain(`package ${from} → ${to}`);
    expect(status.out).toContain("~ W.envelope.budget.tokens: 200000 → 400000");
    expect(status.out).toContain('the lead\'s reason (model output): "three more repositories"');
    expect(status.out).toContain(`approve: mandate amend a1 --revision ${rev} --key <your key file> approve`);
    expect(status.out).toContain(`decline: mandate amend a1 --revision ${rev} --key <your key file> decline`);

    // The run's views say the same, with the lead's reason marked as a model's text.
    const shown = await mandate("show", "a1");
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain("to decide an amendment of W's envelope, which Lead.finish asked for.");
    expect(shown.out).toContain("W.envelope.budget.tokens: 200000 → 400000");
    expect(shown.out).toContain("```text\nthree more repositories\n```");
    expect(shown.out).toContain(`mandate amend a1 --revision ${rev} --key`);
    expect(shown.out).not.toContain("Waiting for an answer");

    // An amendment is not an approval of an action, and the command says which one it is.
    const plain = await mandate("approve", "a1", "--revision", rev, "--key", alice.key);
    expect(plain.code).toBe(1);
    expect(plain.err).toContain(`mandate amend a1 --revision ${rev} --key FILE approve`);
    const neither = await mandate("amend", "a1", "--revision", rev, "--key", alice.key);
    expect(neither.code).toBe(2);
    expect(neither.err).toContain("amend takes approve or decline");
    const unsigned = await mandate("amend", "a1", "--revision", rev, "approve");
    expect(unsigned.code).toBe(2);
    expect(unsigned.err).toContain("--key FILE is required");
    const unseen = await mandate("amend", "a1", "--key", alice.key, "approve");
    expect(unseen.code).toBe(2);
    expect(unseen.err).toContain("--revision is required");
    // The release manager does not own the envelope, and the owner's decision on an older revision is no decision.
    const bobs = await mandate("amend", "a1", "--revision", rev, "--key", bob.key, "approve");
    expect(bobs.code).toBe(1);
    expect(bobs.err).toContain("invalid_decision: not_in_role");
    const stale = await mandate("amend", "a1", "--revision", String(asked.revision - 1), "--key", alice.key, "approve");
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("stale_revision");
    const still = JSON.parse((await mandate("status", "a1", "--json")).out) as Status;
    expect([still.run.state, still.run.revision, still.run.package_hash]).toEqual(["waiting", asked.revision, from]);

    // Alice approves. The run is under the new package from that moment.
    const done = await mandate("amend", "a1", "--revision", rev, "--key", alice.key, "approve", "--json");
    expect(done.code, done.err).toBe(0);
    const after = JSON.parse(done.out) as Status;
    expect(after.run.package_hash).toBe(to);
    expect(after.decisions!.map((d) => [d.record.kind, d.record.member, d.record.role, d.record.subject, d.valid])).toEqual([
      ["envelope", "alice", "platform_lead", from, true],
      ["amend", "alice", "platform_lead", to, true],
    ]);
    // This configuration has no model to run the lead with, so the run stops for a person where the lead would go on.
    expect(after.run.state).toBe("attention_required");
    expect(after.run.attention).toMatchObject({ violation: "no_agent_loop" });

    // The owner's decision can be printed and checked without the runtime, like any other.
    const printed = await mandate("decision", "a1", after.decisions![1]!.decision_id);
    expect(printed.code, printed.err).toBe(0);
    const file = join(dir, "amendment.json");
    writeFileSync(file, printed.out);
    const verified = await mandate("verify-decision", file, "--key", alice.pem, "--lock", LOCK);
    expect(verified.code, verified.out).toBe(0);
    expect(verified.out).toContain("amend by alice as platform_lead");

    // A worker with the model takes the run on: the lead is told, and finishes under the new package.
    const finished = await withModel([finish("went on")], (rt) => rt.resume("a1"));
    expect([finished.state, finished.result, finished.package_hash]).toEqual(["succeeded", "went on", to]);
    const again = await mandate("amend", "a1", "--revision", String(finished.revision), "--key", alice.key, "approve");
    expect(again.code).toBe(1);
    expect(again.err).toContain("no_wait");
  });

  it("leaves the envelope as it was when the owner declines", async () => {
    const asked = await withModel([asks("more of everything")], (rt) => rt.startRun({ pkg, workflow: "W", input: { items: [] }, runId: "a2" }));
    expect(asked.waiting).toMatchObject({ kind: "amendment" });
    const done = await mandate("amend", "a2", "--revision", String(asked.revision), "--key", alice.key, "decline", "--json");
    expect(done.code, done.err).toBe(0);
    const after = JSON.parse(done.out) as Status;
    expect(after.run.package_hash).toBe(from);
    expect(after.decisions!.map((d) => [d.record.kind, d.record.member, d.record.subject, d.valid])).toEqual([
      ["envelope", "alice", from, true],
      ["decline", "alice", to, true],
    ]);
    const finished = await withModel([finish("did less")], (rt) => rt.resume("a2"));
    expect([finished.state, finished.result, finished.package_hash]).toEqual(["succeeded", "did less", from]);
  });

  it("is for a run that waits on an amendment: one that waits on something else is told so, and no decision is made", async () => {
    // Another program: its workflow comments before its lead plans, and the release manager approves a comment.
    const src = program({ body: `  effect git.comment(Item { name: "first" }, "starting")\n    idempotent_by "first"\n  plan Lead.finish(items) within envelope`, approve: "git.comment by release_manager" });
    const file = join(dir, "comment.mdt");
    writeFileSync(file, src);
    const approved = await mandate("approve-envelope", file, "--key", alice.key, "--json");
    expect(approved.code, approved.err).toBe(0);
    const other = buildPackage(check(src, "mdt").program!, locked);
    expect((JSON.parse(approved.out) as { package: string }).package).toBe(other.hash);
    const waiting = await withModel([], (rt) => rt.startRun({ pkg: other, workflow: "W", input: { items: [] }, runId: "a3" }), [new SimTool("git.comment", "reconcilable")]);
    expect(waiting.waiting).toMatchObject({ kind: "decision", request: { effect: "git.comment", role: "release_manager" } });

    const wrong = await mandate("amend", "a3", "--revision", String(waiting.revision), "--key", alice.key, "approve");
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("no_wait: Run a3 is not waiting for a decision on an amendment.");
    // Nothing was signed and nothing was refused: the run is where it was, with the one decision it started on.
    const still = JSON.parse((await mandate("status", "a3", "--json")).out) as Status;
    expect([still.run.state, still.run.revision]).toEqual(["waiting", waiting.revision]);
    expect(still.decisions!.map((d) => d.record.kind)).toEqual(["envelope"]);
  });
});
