// A failure of the compiler behind the bridge is never read as a pass, at any place the runtime asks a compiler:
// loading a package refuses it (`load_verification_failed`), a lead's sub-program or amendment is not admitted
// (`check_failed`, or `check_limit` for the time and the memory a check may take, as the worker reports them), the
// command line exits 2, and a run whose authority decision fails grants nothing and goes no further.
//
// The failing compiler is a module that traps, loops or runs out of memory (bridge/test/wasm-bytes.ts), for the
// whole of a block or for one door, the Rust compiler's own module answering the others (those tests need it,
// `npm run build:wasm`, and are skipped without it in `ts` mode, the only mode a run can start in without it).

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompilerFailure, withCompiler } from "@mandate/bridge/mode";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { SubprogramInput } from "@mandate/bridge";
import type { WorkerChecker } from "../src/plan.js";
import { modulePath } from "../../bridge/src/wasm/module.js";
import { MODULES } from "../../bridge/test/wasm-bytes.js";
import { shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { closeAll, planChecker, world, type World } from "./helpers.js";
import { base, check, finish, fixes, ops, planned as plannedWith, program, refusals, run, state, type Turn } from "./planning.js";
import { FIX, ISSUE } from "./programs.js";
import { createActivities } from "../src/temporal/activities.js";

const real = existsSync(modulePath());
const needsModule = real ? describe : describe.skip;

const TRAP = MODULES.trap();
const LOOP = MODULES.loop();
const OOM = MODULES.outOfMemory();

let checker: WorkerChecker;
const work = mkdtempSync(join(tmpdir(), "mdt-compiler-failure-"));
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);
afterAll(async () => {
  await checker.close();
  await closeAll();
  rmSync(work, { recursive: true, force: true });
});

const planned = (lead: Turn[]) => plannedWith(checker, lead);

/** A 0.4 workflow whose map hands each item the scope of its repository (`with caps … .narrow(…)`), approved. */
async function mapWorld(): Promise<World> {
  const src = `mandate @ 0.4

module test.map @ 0.1

use std.{fs, model}

role platform_lead "Platform lead"

type Repo = { name: Text, root: Path }

capability RepoRead = fs.read("/work/repos")
capability SrcWrite = fs.write("/work/repos")
capability ModelStd = model.infer(tier: standard)

agent Migrator {
  role   "Moves one repository."
  caps   RepoRead, SrcWrite, ModelStd
  budget { tokens: 1k, steps: 5 }
  skill migrate(repo: Repo) -> Inferred<Text> ! {Fs.Read, Fs.Write, Model}
}

workflow W(repos: List<Repo>) -> List<Outcome<Inferred<Text>>>
  envelope {
    owner   platform_lead
    caps    RepoRead, SrcWrite, ModelStd
    budget  { tokens: 100k, steps: 400, agents: 40 }
  }
{
  map repo in repos with caps SrcWrite.narrow(repo.root) {
    delegate Migrator.migrate(repo)
  }
}
`;
  const alice = EvidenceSigner.generate();
  const lock = { modules: {}, members: { alice: { keys: [alice.keyId] } }, roles: { platform_lead: ["alice"] } };
  const w = await world(src, { lock, decisions: { keys: new TrustedKeys([alice.publicKey]) } });
  await w.rt.approveEnvelope(w.pkg, signDecision(alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) }));
  return w;
}

/** What a checker is asked for the first sub-program of the planning program. */
async function asked(): Promise<SubprogramInput> {
  return { parent: (await planned([])).pkg.program, modules: {}, workflow: "W", number: 1, base: base(1), ops: ops(fixes(["a"])) as never, lead: "public", room: { left: {}, writes: [] } };
}

describe("loading a package, when the compiler fails", () => {
  it("refuses the package (load_verification_failed) and starts no run", async () => {
    const w = await world(FIX);
    const start = withCompiler("rust", () => w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: ISSUE, runId: "trapped" }), { module: TRAP });
    await expect(start).rejects.toMatchObject({ code: "load_verification_failed" });
    await expect(start).rejects.toThrow(/the Rust compiler failed .*\(trap\)/);
    expect(await w.db.query("select run_id from runs")).toEqual([]);
    expect(w.agents.calls).toEqual([]);
  });

  it("refuses an envelope's approval the same way", async () => {
    const w = await planned([]);
    const approve = withCompiler("rust", () => w.rt.approveEnvelope(w.pkg, {} as never), { module: TRAP });
    await expect(approve).rejects.toMatchObject({ code: "load_verification_failed" });
  });
});

needsModule("loading a package, when one door fails and the Rust compiler answers the others", () => {
  it.each(["check", "hash_program", "package_hash", "linked_program", "sandbox_lock_checks", "role_lock_checks"])("%s traps: the package is refused", async (door) => {
    const w = await world(FIX);
    const start = withCompiler("rust", () => w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: ISSUE, runId: `trapped-${door}` }), { doors: { [door]: TRAP } });
    await expect(start).rejects.toMatchObject({ code: "load_verification_failed" });
    expect(await w.db.query("select run_id from runs")).toEqual([]);
  });

  it("and with nothing failing, the same package runs on the Rust compiler", async () => {
    const w = await world(FIX);
    const r = await withCompiler("rust", () => w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: ISSUE, runId: "untrapped" }));
    expect(r.state).toBe("succeeded");
  });
});

describe("a lead's sub-program, when the compiler fails", () => {
  it("is check_failed when the module traps in the worker", async () => {
    const input = await asked();
    const r = await withCompiler("rust", () => checker.check(input, 5000), { module: TRAP });
    expect(r).toMatchObject({ failed: expect.stringMatching(/the Rust compiler failed .*\(trap\)/) });
    expect(r).not.toHaveProperty("ok");
  });

  it("is check_limit (memory) when the module reaches its ceiling", async () => {
    const input = await asked();
    const r = await withCompiler("rust", () => checker.check(input, 5000), { module: OOM });
    expect(r).toEqual({ limit: "memory", max: 256 });
  });

  it("is check_limit (time) when the module does not end: the worker is stopped", async () => {
    const started = Date.now();
    const input = await asked();
    const r = await withCompiler("rust", () => checker.check(input, 500), { module: LOOP });
    expect(r).toEqual({ limit: "time", max: 500 });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("is check_failed when there is no module", async () => {
    const input = await asked();
    const before = process.env["MANDATE_WASM"];
    process.env["MANDATE_WASM"] = join(work, "missing.wasm");
    try {
      const r = await withCompiler("rust", () => checker.check(input, 5000));
      expect(r).toMatchObject({ failed: expect.stringContaining("(module_missing)") });
    } finally {
      if (before === undefined) delete process.env["MANDATE_WASM"];
      else process.env["MANDATE_WASM"] = before;
    }
  });
});

needsModule("a lead's sub-program and amendment, when their door fails and the Rust compiler answers the rest of the run", () => {
  it("the lead is told check_failed, nothing is admitted, and the run goes on", async () => {
    const w = await planned([check(1, fixes(["a"])), finish("went on")]);
    const r = await withCompiler("rust", () => run(w, "sub-trapped"), { doors: { check_subprogram: TRAP } });
    expect(state(r)).toBe("succeeded null");
    expect(refusals(w.told[0])).toEqual([["check_failed", null, { reason: expect.stringMatching(/the Rust compiler failed on check_subprogram \(trap\)/) }]]);
    expect(w.told[0]).toMatchObject({ ok: false });
  });

  it("an amendment whose check traps is check_failed", async () => {
    const w = await planned([]);
    const parent = w.pkg.program;
    const envelope = (parent.defs["W"] as { envelope: unknown }).envelope;
    const r = await withCompiler("rust", () => checker.amendment({ parent, modules: {}, workflow: "W", envelope, lock: w.pkg.lock }, 5000), { doors: { check_amendment: TRAP } });
    expect(r).toMatchObject({ failed: expect.stringMatching(/check_amendment \(trap\)/) });
  });

  /** What a run that stopped for a compiler that failed shows: `compiler_failed`, with the kind and the door. */
  const stoppedOn = (r: { state: string; attention?: unknown }, door: string): void => {
    expect(r.state).toBe("attention_required");
    expect(r.attention).toMatchObject({ violation: "compiler_failed", message: expect.stringContaining(`(trap on ${door})`) });
  };

  it.each([
    ["map_scopes", false],
    ["narrow", false],
    ["grant", true],
  ])("a map whose %s traps hands its items nothing: no item's delegation is dispatched, and the run stops for a person (compiler_failed)", async (door, started) => {
    const w = await mapWorld();
    const r = await withCompiler("rust", () => w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { repos: [{ name: "a", root: "a" }, { name: "b", root: "b" }] }, runId: `map-${door}` }), { doors: { [door]: TRAP } });
    stoppedOn(r, door);
    expect(w.agents.calls).toEqual([]);
    // The map's own decisions come before it starts; a delegation's grant, inside an item, after.
    expect((await w.rt.journal.events(`map-${door}`)).some((e) => e.type === "map_started")).toBe(started);
  });

  it("an authority decision that traps grants nothing: the delegation does not start, and the run stops for a person (compiler_failed)", async () => {
    const w = await world(FIX);
    const r = await withCompiler("rust", () => w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: ISSUE, runId: "grant-trapped" }), { doors: { grant: TRAP } });
    stoppedOn(r, "grant");
    expect(w.agents.calls).toEqual([]);
  });

  it("a resume of a run its compiler stopped asks once, stops again, and dispatches nothing: it does not loop", async () => {
    const w = await mapWorld();
    const id = "narrow-resumed";
    const input = { repos: [{ name: "a", root: "a" }] };
    await withCompiler("rust", async () => {
      stoppedOn(await w.rt.startRun({ pkg: w.pkg, workflow: "W", input, runId: id }), "narrow");
      for (let i = 0; i < 3; i++) stoppedOn(await w.rt.resume(id), "narrow");
    }, { doors: { narrow: TRAP } });
    expect(w.agents.calls).toEqual([]);
    // With the compiler answering again, the same run goes on from where it stopped.
    const after = await withCompiler("rust", () => w.rt.resume(id));
    expect(after.state).toBe("succeeded");
    expect(w.agents.calls).toHaveLength(1);
  });

  it("through the Temporal driver's activity, the drive completes with the run stopped, so Temporal does not try it again", async () => {
    const w = await mapWorld();
    const id = "narrow-temporal";
    const activities = createActivities(w.rt);
    const env = new MockActivityEnvironment();
    await withCompiler("rust", async () => {
      stoppedOn(await w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { repos: [{ name: "a", root: "a" }] }, runId: id }), "narrow");
      // The activity answers (it does not throw, which Temporal would retry without end): the run is parked.
      expect(await env.run(activities.drive, id)).toMatchObject({ runId: id, state: "attention_required" });
    }, { doors: { narrow: TRAP } });
    expect(w.agents.calls).toEqual([]);
  });
});

needsModule("a journal's verification, when the compiler fails", () => {
  it("says nothing of the journal: the failure is thrown, never read as a package that does not hold", async () => {
    const w = await world(FIX);
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: ISSUE, runId: "verified" });
    expect(r.state).toBe("succeeded");
    expect((await withCompiler("rust", () => w.rt.verifyJournal("verified"))).status).toBe("verified");
    await expect(withCompiler("rust", () => w.rt.verifyJournal("verified"), { doors: { package_hash: TRAP } })).rejects.toBeInstanceOf(CompilerFailure);
  });
});

describe("the runtime's command line, when the compiler fails", () => {
  it("exits 2 and says so", async () => {
    const file = join(work, "fix.mdt");
    writeFileSync(file, `mandate @ 0.4\n\n${program().split("\n").slice(2).join("\n")}`);
    const err: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
    let code: number;
    try {
      code = await withCompiler("rust", () => main(["test", file], () => undefined), { module: TRAP });
    } finally {
      process.stderr.write = write;
    }
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/the Rust compiler failed .*\(trap\)/);
  });
});
