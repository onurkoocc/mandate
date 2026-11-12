// `plan` at run time (0.4; spec/envelope.md "plan"; cases N01, N02, N05, N06,
// N07, N09, N10; INV-15). A lead is an agent loop with two more tools. A
// sub-program it submits is checked against what is left of the envelope,
// admitted with its whole budget reserved, and run inside the same run; a
// sub-program that does not fit is refused and nothing of it runs. Each rule
// is shown by one run that keeps it and one that breaks it.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Program, SubprogramInput } from "@mandate/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { readConfig, runtimeOptions, type RuntimeConfig } from "../src/control.js";
import { shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import type { RuntimeOptions } from "../src/runtime.js";
import { CHECK_MS, MAX_OPS, overLimit, type ProgramChecker, type WorkerChecker } from "../src/plan.js";
import { MxcAdapter } from "../src/sandbox.js";
import { Crash } from "../src/signals.js";
import { deferred, SimChat, SimModel, SimSandboxHost, SimTool, toolUse, type SimTurn } from "../src/sim.js";
import { isObj, type Obj, type Value } from "../src/values.js";
import { closeAll, commandIds, planChecker, until, world, type World } from "./helpers.js";
import { answered, base, BUDGET, CAPS, check, commenting, finish, fixed, fixes, itemOf, leadChat, MODULE, ops, PLAN, program, programAt, sub, submit, toolStep, type Turn } from "./planning.js";

let checker: WorkerChecker;
let stuck: WorkerChecker;
let broken: WorkerChecker;
let greedy: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
  stuck = await planChecker("./fixtures/stuck-plan-worker.ts");
  broken = await planChecker("./fixtures/broken-plan-worker.ts");
  greedy = await planChecker("./fixtures/greedy-plan-worker.ts", 32);
}, 60_000);

afterAll(async () => {
  for (const c of [checker, stuck, broken, greedy]) await c.close();
  await closeAll();
});

/** The checker, counting what it is asked: a step that was admitted is never checked again. */
function counting(): ProgramChecker & { calls: SubprogramInput[] } {
  const calls: SubprogramInput[] = [];
  return { calls, check: (input, ms) => (calls.push(input), checker.check(input, ms)) };
}

// ── the people and the model ────────────────────────────────────────────

interface Planned extends World {
  chat: SimChat;
  host: SimSandboxHost;
  alice: EvidenceSigner;
  bob: EvidenceSigner;
  /** What each of the lead's tool calls answered, in order. */
  told: Obj[];
}

/**
 * The program on a runtime where Alice, the platform lead, has approved its envelope, and Bob is the release
 * manager. `lead` is the lead's turns in order; a worker finishes at once, saying which item it fixed.
 */
async function planned(lead: Turn[], o: { src?: string; worker?: (req: TurnRequest) => SimTurn | Promise<SimTurn>; plan?: RuntimeOptions["plan"]; tools?: SimTool[]; model?: SimModel } = {}): Promise<Planned> {
  const alice = EvidenceSigner.generate();
  const bob = EvidenceSigner.generate();
  const lock = { modules: {}, members: { alice: { keys: [alice.keyId] }, bob: { keys: [bob.keyId] } }, roles: { platform_lead: ["alice"], release_manager: ["bob"] } };
  const w = await world(o.src ?? program(), { lock, decisions: { keys: new TrustedKeys([alice.publicKey, bob.publicKey]) }, plan: o.plan ?? { checker }, ...(o.tools ? { tools: o.tools } : {}), ...(o.model ? { model: o.model } : {}) });
  const host = new SimSandboxHost();
  const { chat, told } = leadChat(lead, o.worker);
  w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
  await w.rt.approveEnvelope(w.pkg, signDecision(alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) }));
  return { ...w, chat, host, alice, bob, told };
}

const ITEMS: Obj[] = [{ name: "a" }, { name: "b" }];

const run = (w: World, runId: string, o: Partial<Parameters<World["rt"]["startRun"]>[0]> = {}): Promise<RunRow> => w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { items: ITEMS }, runId, ...o });

const events = async (w: World, runId: string, type: string): Promise<Obj[]> => (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data as Obj);

/** The diagnostics a tool call answered with, as code, path and facts. */
const refusals = (answer: Obj | undefined): unknown[] => ((answer?.["diagnostics"] ?? []) as Obj[]).filter((d) => d["severity"] === "error").map((d) => [d["code"], d["path"] ?? null, d["facts"] ?? null]);

const state = (r: RunRow): string => `${r.state} ${JSON.stringify(r.error ?? r.attention ?? r.waiting ?? null)}`;

async function sign(w: Planned, runId: string, who: "alice" | "bob", kind: "approve" | "decline") {
  return signDecision(w[who], await w.rt.shown(runId, "wait"), { kind, member: who, at: new Date(w.adapters.clock.now()) });
}
let n = 0;
const msg = (): { sender: string; messageId: string } => ({ sender: "test", messageId: `m${++n}` });

// ── a sub-program runs inside the run ───────────────────────────────────

describe("plan: a lead's sub-program", () => {
  it("is admitted, runs to its end inside the run, and its result goes back to the lead", async () => {
    const w = await planned([submit(1, fixes(["a", "b"])), finish("all fixed")]);
    const r = await run(w, "p1");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toBe("all fixed");
    // The lead was told how its sub-program ended, and where the next one starts.
    expect(w.told).toEqual([{ admitted: true, number: 1, hash: expect.stringMatching(/^sha256:/), result: "fixed b", next: { number: 2, base: base(2) } }]);
    // Its workflow ran under the command it was admitted as.
    expect(await commandIds(w, "p1", "delegate")).toEqual([PLAN, `${programAt(1)}/defs/Fix/body/0/value`, `${programAt(1)}/defs/Fix/body/1/value`]);
    expect(await commandIds(w, "p1", "program")).toEqual([programAt(1)]);
    const [admitted] = await events(w, "p1", "program_admitted");
    expect(admitted).toMatchObject({ plan: PLAN, number: 1, base: base(1), command: programAt(1), workflow: "Fix", step: toolStep(1), reservation: { tokens: 20_000, steps: 40, agents: 4 } });
    expect(await events(w, "p1", "program_submitted")).toMatchObject([{ plan: PLAN, number: 1, step: toolStep(1), lead: "Lead.finish", base: base(1), ok: true, hash: admitted!["hash"] }]);
    expect(await events(w, "p1", "program_refused")).toEqual([]);
    // The lead and two workers are three of the envelope's agents, and nothing is held once the run has ended.
    const b = await w.rt.journal.budget("p1");
    expect(b["agents"]).toEqual({ limit: 12, settled: 3, reserved: 0 });
    expect(b["tokens"]!.reserved).toBe(0);
    expect(b["steps"]).toEqual({ limit: 400, settled: 4, reserved: 0 });
  });

  it("is told to the lead with what its sub-programs may use and where the first one starts", async () => {
    const w = await planned([finish()]);
    await run(w, "p-brief");
    const first = JSON.stringify(w.chat.calls[0]!.messages[0]);
    expect(first).toContain(base(1));
    expect(first).toContain(`${MODULE}.plan_1`);
    expect(first).toContain("agent: Lead, Worker");
    expect(w.chat.calls[0]!.tools.map((t) => t.name)).toEqual(["read_file", "list_dir", "grep", "check_program", "submit_program", "finish"]);
    // A worker is no lead: it has no such tools.
    const w2 = await planned([submit(1, fixes(["a"])), finish()]);
    await run(w2, "p-brief2");
    const worker = w2.chat.calls.find((c) => c.agent === "Worker")!;
    expect(worker.tools.map((t) => t.name)).toEqual(["read_file", "list_dir", "grep", "write_file", "finish"]);
    expect(JSON.stringify(worker.messages[0])).not.toContain("sub-program");
  });

  it("is only checked by check_program: nothing is admitted and nothing runs", async () => {
    const w = await planned([check(1, fixes(["a"])), check(1, fixes(["a"], "{ tokens: 500k, steps: 40, agents: 4 }")), finish()]);
    const r = await run(w, "p-check");
    expect(state(r)).toBe("succeeded null");
    expect(w.told[0]).toMatchObject({ ok: true, number: 1, base: base(1), diagnostics: [], room: { left: { tokens: 140_000, steps: 370, agents: 11 }, writes_in_flight: [] } });
    expect(w.told[1]).toMatchObject({ ok: false, number: 1, base: base(1) });
    expect(refusals(w.told[1])).toEqual([["MDT-E1706", "/defs/Fix/budget/tokens", { dimension: "tokens", asked: 500_000, left: 140_000 }]]);
    expect(await commandIds(w, "p-check", "program")).toEqual([]);
    expect(await commandIds(w, "p-check", "delegate")).toEqual([PLAN]);
    for (const type of ["program_submitted", "program_refused", "program_admitted"]) expect(await events(w, "p-check", type)).toEqual([]);
    expect(w.chat.calls.filter((c) => c.agent === "Worker")).toEqual([]);
  });

  it("N01, INV-15: is refused when it asks for a capability outside the envelope, and nothing of it runs", async () => {
    const outside = `capability Etc = fs.write("/etc")\n\n${sub(`  delegate Worker.fix(Item { name: "a" })`, BUDGET, `${CAPS}, Etc`)}`;
    const w = await planned([submit(1, outside), finish("gave up")]);
    const r = await run(w, "n01");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toBe("gave up");
    expect(w.told[0]).toMatchObject({ admitted: false, number: 1, base: base(1) });
    // A workflow's capabilities are kept in name order, so the one outside the envelope is its first.
    expect(refusals(w.told[0])).toEqual([
      ["MDT-E1706", "/defs/Fix/caps/0", { dimension: "capability", capability: 'Etc = fs.write("/etc")', envelope: ['Merge = git.pr("company/backend")', "ModelStd = model.infer", 'RepoRead = fs.read("/work/repos")', 'SrcWrite = fs.write("/work/repos")'] }],
    ]);
    // The model was told it is an error, and nothing was reserved, stored or run.
    const result = (w.chat.calls[1]!.messages.at(-1) as { content: Obj[] }).content[0]!;
    expect(result["is_error"]).toBe(true);
    expect(await commandIds(w, "n01", "program")).toEqual([]);
    expect(await commandIds(w, "n01", "delegate")).toEqual([PLAN]);
    expect(await events(w, "n01", "program_admitted")).toEqual([]);
    expect(await events(w, "n01", "program_submitted")).toMatchObject([{ plan: PLAN, number: 1, ok: false }]);
    // The lead was also warned that its workflow holds a capability it does not use; a warning refuses nothing.
    expect(((w.told[0]!["diagnostics"] ?? []) as Obj[]).map((d) => d["code"])).toEqual(["MDT-E1706", "MDT-W0310"]);
    expect(await events(w, "n01", "program_refused")).toMatchObject([{ plan: PLAN, number: 1, step: toolStep(1), codes: ["MDT-E1706"], diagnostics: expect.stringMatching(/^sha256:/) }]);
    expect((await w.rt.journal.budget("n01"))["agents"]).toEqual({ limit: 12, settled: 1, reserved: 0 });
  });

  it("N01: is refused when it asks for more than the envelope has left, with the numbers", async () => {
    // The lead's own delegation holds 60k of the envelope's 200k tokens, so 140k are left.
    const w = await planned([submit(1, fixes(["a"], "{ tokens: 140001, steps: 40, agents: 4 }")), submit(1, fixes(["a"], "{ tokens: 140k, steps: 40, agents: 4 }")), finish()]);
    const r = await run(w, "n01b");
    expect(state(r)).toBe("succeeded null");
    expect(refusals(w.told[0])).toEqual([["MDT-E1706", "/defs/Fix/budget/tokens", { dimension: "tokens", asked: 140_001, left: 140_000 }]]);
    expect(w.told[1]).toMatchObject({ admitted: true, number: 1, result: "fixed a" });
    expect(await events(w, "n01b", "program_admitted")).toMatchObject([{ number: 1, reservation: { tokens: 140_000 } }]);
  });

  it("N09: is refused when it defines what only the approved program may define", async () => {
    const contract = `contract Fine(i: Item) {\n  accept named "The item has a name" by static len(i.name) >= 1\n}\n\n${fixes(["a"])}`;
    const w = await planned([submit(1, contract), finish()]);
    const r = await run(w, "n09");
    expect(state(r)).toBe("succeeded null");
    expect(refusals(w.told[0])).toEqual([["MDT-E1705", "/defs/Fine", { def: "Fine", kind: "contract" }]]);
    expect(await commandIds(w, "n09", "program")).toEqual([]);
    expect(await events(w, "n09", "program_refused")).toMatchObject([{ codes: ["MDT-E1705"] }]);
  });

  it("is numbered by what was admitted: a refused submission does not advance the number, and an old base is stale", async () => {
    const w = await planned([
      submit(1, fixes(["a"], "{ tokens: 500k, steps: 40, agents: 4 }")),
      submit(1, fixes(["a"])),
      // The first sub-program was admitted, so the next one is number 2: a patch against number 1's module is stale.
      submit(1, fixes(["b"])),
      submit(2, fixes(["b"])),
      finish(),
    ]);
    const r = await run(w, "numbers");
    expect(state(r)).toBe("succeeded null");
    expect(w.told.map((t) => [t["admitted"], t["number"]])).toEqual([[false, 1], [true, 1], [false, 2], [true, 2]]);
    expect(w.told[2]).toMatchObject({ base: base(2) });
    expect(refusals(w.told[2]).map((x) => (x as unknown[])[0])).toEqual(["MDT-E0130"]);
    expect(w.told[3]).toMatchObject({ result: "fixed b", next: { number: 3, base: base(3) } });
    expect((await events(w, "numbers", "program_admitted")).map((e) => [e["number"], e["command"], e["step"]])).toEqual([[1, programAt(1), toolStep(2)], [2, programAt(2), toolStep(4)]]);
    expect(await commandIds(w, "numbers", "program")).toEqual([programAt(1), programAt(2)]);
  });

  it("returns a sub-program's fault to the lead, which may plan again", async () => {
    const worker = (req: TurnRequest): SimTurn => (itemOf(req) === "a" ? { error: { tag: "SkillFailed", args: ["no luck"] }, cost: { steps: 1 } } : fixed(req));
    const w = await planned([submit(1, fixes(["a"])), submit(2, fixes(["b"])), finish("b only")], { worker });
    const r = await run(w, "fault");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toBe("b only");
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, error: { $tag: "SkillFailed" }, next: { number: 2 } });
    expect(w.told[0]!["result"]).toBeUndefined();
    expect(w.told[1]).toMatchObject({ admitted: true, number: 2, result: "fixed b" });
    const rows = await w.db.query<{ command_id: string; state: string }>("select command_id, state from commands where run_id = 'fault' and kind = 'program' order by command_id");
    expect(rows).toEqual([{ command_id: programAt(1), state: "failed" }, { command_id: programAt(2), state: "succeeded" }]);
  });
});

// ── the ledger ──────────────────────────────────────────────────────────

describe("the ledger under a sub-program (N02, INV-15)", () => {
  it("reserves the sub-program's whole budget at admission, and gives back what it did not use when it ends", async () => {
    const gate = deferred<void>();
    let inFlight = 0;
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      inFlight++;
      await gate.promise;
      return fixed(req);
    };
    const w = await planned([submit(1, fixes(["a"])), finish()], { worker });
    const p = run(w, "ledger");
    await until(() => inFlight === 1, "the worker in flight");
    // While it runs: the lead's delegation and the sub-program hold 60k + 20k tokens between them, whatever was
    // spent or handed on inside. The worker took its share out of the sub-program's reservation.
    const during = await w.rt.journal.budget("ledger");
    expect(during["tokens"]!.settled + during["tokens"]!.reserved).toBe(80_000);
    expect(during["agents"]).toEqual({ limit: 12, settled: 0, reserved: 5 });
    const held = await w.db.query<{ command_id: string; dimension: string; amount: string }>(
      "select command_id, dimension, amount from reservations where run_id = 'ledger' and state = 'active' and dimension in ('agents', 'tokens') and command_id <> $1 order by command_id, dimension",
      [PLAN],
    );
    expect(held.map((h) => [h.command_id, h.dimension, Number(h.amount)])).toEqual([
      [programAt(1), "agents", 3],
      [programAt(1), "tokens", 17_000],
      [`${programAt(1)}/defs/Fix/body/0/value`, "agents", 1],
      [`${programAt(1)}/defs/Fix/body/0/value`, "tokens", 3_000],
    ]);
    gate.resolve();
    const r = await p;
    expect(state(r)).toBe("succeeded null");
    const after = await w.rt.journal.budget("ledger");
    expect(after["agents"]).toEqual({ limit: 12, settled: 2, reserved: 0 });
    expect(after["tokens"]!.reserved).toBe(0);
    expect(after["tokens"]!.settled).toBe(300);
  });

  it("N02: two siblings inside a sub-program cannot both reserve what only one fits, though the run has plenty", async () => {
    // Each `infer` reserves 1000 tokens when it is sent. The sub-program was admitted with 1500.
    const gate = deferred<void>();
    const model = new SimModel(async () => {
      await gate.promise;
      return { ok: "said", cost: { tokens: 100 } };
    });
    const both = sub(`  par {\n    one = infer Text from quote("one")\n    two = infer Text from quote("two")\n  }\n  one`, "{ tokens: 1500, steps: 10, agents: 1 }", "ModelStd");
    const w = await planned([submit(1, both), finish("told")], { model });
    let refused = 0;
    const dispatch = w.rt.journal.dispatch.bind(w.rt.journal);
    w.rt.journal.dispatch = async (...a) => {
      try {
        return await dispatch(...a);
      } catch (e) {
        refused++;
        throw e;
      }
    };
    const p = run(w, "n02");
    await until(() => refused === 1 && w.model.calls.length === 1, "one infer refused, one in flight");
    gate.resolve();
    const r = await p;
    // The run did not stop for its own budget: the fault was the sub-program's, and the lead was told.
    expect(state(r)).toBe("succeeded null");
    expect(w.model.calls).toHaveLength(1);
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, error: { $tag: "BudgetExceeded", $args: [{ dimension: "tokens", requested: 1000, available: 500, program: programAt(1) }] } });
    expect(await events(w, "n02", "budget_exceeded")).toEqual([]);
    expect((await w.rt.journal.budget("n02"))["tokens"]!.reserved).toBe(0);
  });

  it("N02: a sub-program that no longer fits when it is admitted is refused, as if the check had seen it", async () => {
    // Between the check and the admission something else takes what was left: here, a reservation made behind the checker's back.
    let taken = false;
    const racing: ProgramChecker = {
      check: async (input, ms) => {
        const r = await checker.check(input, ms);
        if (!taken) {
          taken = true;
          await w.db.query("insert into reservations (run_id, command_id, dimension, amount, state) values ('race', 'elsewhere', 'tokens', 130000, 'active')");
        }
        return r;
      },
    };
    const w = await planned([submit(1, fixes(["a"])), finish()], { plan: { checker: racing } });
    const r = await run(w, "race");
    expect(state(r)).toBe("succeeded null");
    expect(w.told[0]).toMatchObject({ admitted: false, number: 1 });
    expect(refusals(w.told[0])).toEqual([["MDT-E1706", "/defs/Fix/budget", { dimension: "tokens", asked: 20_000, left: 10_000 }]]);
    expect(await commandIds(w, "race", "program")).toEqual([]);
    expect(await events(w, "race", "program_admitted")).toEqual([]);
    expect(await events(w, "race", "program_refused")).toMatchObject([{ codes: ["MDT-E1706"] }]);
  });

  it("keeps a sub-program clear of what another one in flight may write (C5 across the run)", async () => {
    // Two leads in two branches. The first one's sub-program writes below /work/repos/a and is held in flight.
    const body = `  par {\n    one = plan Lead.finish(items) within envelope\n    two = plan Lead.finish(items) within envelope\n  }\n  one`;
    const ONE = "/defs/W/body/0/branches/one";
    const TWO = "/defs/W/body/0/branches/two";
    const gate = deferred<void>();
    let inFlight = 0;
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      inFlight++;
      if (itemOf(req) === "a") await gate.promise;
      return fixed(req);
    };
    const narrow = (dir: string, item: string): string => `capability Mine = SrcWrite.narrow("${dir}")\n\n${sub(`  delegate Worker.fix(Item { name: "${item}" }) with caps Mine`, BUDGET, "RepoRead, Mine, ModelStd")}`;
    const turns: Record<string, Turn[]> = {
      [ONE]: [submit(1, narrow("/work/repos/a", "a")), finish("one")],
      [TWO]: [
        async () => {
          await until(() => inFlight === 1, "the first lead's worker in flight");
          return submit(1, narrow("/work/repos/a/src", "b"));
        },
        submit(1, narrow("/work/repos/b", "b")),
        () => {
          gate.resolve();
          return finish("two");
        },
      ],
    };
    const told: Record<string, Obj[]> = { [ONE]: [], [TWO]: [] };
    const w = await planned([], { src: program({ body }) });
    w.chat["script" as never] = (async (req: TurnRequest) => {
      if (req.agent !== "Lead") return worker(req);
      const branch = req.commandId.startsWith(ONE) ? ONE : TWO;
      const answer = answered(req);
      if (answer) told[branch]!.push(answer);
      const turn = turns[branch]!.shift()!;
      return typeof turn === "function" ? turn(req) : turn;
    }) as never;
    const r = await run(w, "writes");
    expect(state(r)).toBe("succeeded null");
    expect(told[TWO]![0]).toMatchObject({ admitted: false, room: { writes_in_flight: ['Mine = fs.write("/work/repos/a")'] } });
    expect(refusals(told[TWO]![0])).toEqual([["MDT-E1706", "/defs/Fix/caps/0", { dimension: "write_scope", capability: 'Mine = fs.write("/work/repos/a/src")', in_flight: 'Mine = fs.write("/work/repos/a")' }]]);
    expect(told[TWO]![1]).toMatchObject({ admitted: true, number: 1, result: "fixed b" });
    expect(told[ONE]![0]).toMatchObject({ admitted: true, number: 1, result: "fixed a" });
    // Each lead numbers its own sub-programs.
    expect(await commandIds(w, "writes", "program")).toEqual([programAt(1, `${ONE}`), programAt(1, `${TWO}`)]);
  });
});

// ── places ──────────────────────────────────────────────────────────────

describe("spawn.max_concurrent under a sub-program", () => {
  it("lets a sub-program's delegation run while its lead waits for it, though one delegation may be in flight", async () => {
    const w = await planned([submit(1, fixes(["a", "b"])), finish()], { src: program({ spawn: "{ max_concurrent: 1 }" }) });
    const r = await run(w, "one-place");
    expect(state(r)).toBe("succeeded null");
    expect(w.told[0]).toMatchObject({ admitted: true, result: "fixed b" });
  });

  it("holds a sub-program's map to the envelope's concurrency, and bounds a map without max by the sub-program's own agents", async () => {
    let inFlight = 0;
    let peak = 0;
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return fixed(req);
    };
    // An agent of the sub-program's own, which only reads: a map's items may then run side by side.
    const reader = `agent Reader {\n  role   "Reads one item."\n  caps   RepoRead, ModelStd\n  budget { tokens: 3k, steps: 4 }\n  skill look(i: Item) -> Inferred<Text> ! {Fs.Read, Model}\n}`;
    const mapped = (names: string[]): string =>
      `${reader}\n\n${sub(`  let rs = map i in [${names.map((x) => `Item { name: "${x}" }`).join(", ")}] par 2 {\n    delegate Reader.look(i)\n  }\n  "mapped"`, "{ tokens: 20k, steps: 40, agents: 3 }", "RepoRead, ModelStd")}`;
    // The static check counts a map without `max` as the sub-program's agents: three. Four items are over it.
    const w = await planned([submit(1, mapped(["a", "b", "c", "d"])), submit(2, mapped(["a", "b", "c"])), finish()], { src: program({ spawn: "{ max_concurrent: 2 }" }), worker });
    const r = await run(w, "sub-map");
    expect(state(r)).toBe("succeeded null");
    expect(refusals(w.told[0])).toEqual([]);
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, error: { $tag: "Rejected", $args: ["over_limit", { items: 4, max: 3 }] } });
    expect(w.told[1]).toMatchObject({ admitted: true, number: 2, result: "mapped" });
    expect(peak).toBe(2);
    expect(await events(w, "sub-map", "map_started")).toEqual([{ map: `${programAt(2)}/defs/Fix/body/0/value`, items: 3, par: 2 }]);
  });
});

// ── N05 ─────────────────────────────────────────────────────────────────

describe("N05: a critical effect in a sub-program", () => {
  it("is authorized on its own: admission authorizes nothing, and under approve only that role's signed decision does", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const counted = counting();
    const w = await planned([submit(1, commenting("a", "fixed")), finish("commented")], { src: program({ approve: "git.comment by release_manager" }), tools: [tool], plan: { checker: counted } });
    const stopped = await run(w, "n05");
    expect(state(stopped)).toContain("waiting");
    const effect = `${programAt(1)}/defs/Fix/body/1/value`;
    expect(stopped.waiting).toMatchObject({ kind: "decision", command: `${effect}/authorize`, request: { effect: "git.comment", role: "release_manager" } });
    // The sub-program was admitted and is in flight, with its reservation; nothing was sent.
    expect(tool.executions).toHaveLength(0);
    expect(await events(w, "n05", "program_admitted")).toHaveLength(1);
    expect((await w.rt.journal.budget("n05"))["agents"]).toMatchObject({ settled: 1, reserved: 4 });

    // The envelope's owner approved the envelope, not this action: her decision is no decision here.
    await expect(w.rt.decideAction("n05", msg(), { signed: await sign(w, "n05", "alice", "approve") })).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    expect(tool.executions).toHaveLength(0);

    const turns = w.chat.calls.length;
    const done = await w.rt.decideAction("n05", msg(), { signed: await sign(w, "n05", "bob", "approve") });
    expect(state(done)).toBe("succeeded null");
    expect(done.result).toBe("commented");
    expect(tool.executions).toHaveLength(1);
    expect(await events(w, "n05", "action_authorized")).toMatchObject([{ by: "bob", member: "bob", role: "release_manager" }]);
    // The resumed run went on from the journal: the lead's turn, the check and the worker were not run again.
    expect(w.chat.calls.length - turns).toBe(1);
    expect(counted.calls).toHaveLength(1);
    expect(await events(w, "n05", "program_admitted")).toHaveLength(1);
    expect(await events(w, "n05", "program_submitted")).toHaveLength(1);
    expect(w.told).toMatchObject([{ admitted: true, number: 1, result: "fixed a" }]);
    expect((await w.rt.journal.budget("n05"))["agents"]).toEqual({ limit: 12, settled: 2, reserved: 0 });
  });

  it("is the sub-program's fault when the role declines, and the lead is told", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await planned([submit(1, commenting("a", "fixed")), finish("declined")], { src: program({ approve: "git.comment by release_manager" }), tools: [tool] });
    await run(w, "n05-no");
    const done = await w.rt.decideAction("n05-no", msg(), { signed: await sign(w, "n05-no", "bob", "decline") });
    expect(state(done)).toBe("succeeded null");
    expect(done.result).toBe("declined");
    expect(tool.executions).toHaveLength(0);
    expect(w.told).toMatchObject([{ admitted: true, number: 1, error: { $tag: "Rejected" } }]);
  });

  it("is authorized by policy when the envelope names nobody for it, as in the parent", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await planned([submit(1, commenting("a", "fixed")), finish()], { tools: [tool] });
    const r = await run(w, "n05-policy");
    expect(state(r)).toBe("succeeded null");
    expect(tool.executions).toHaveLength(1);
    expect(await events(w, "n05-policy", "action_authorized")).toMatchObject([{ by: "policy" }]);
  });
});

// ── N07 ─────────────────────────────────────────────────────────────────

describe("N07: an effect's business key across the sub-programs of one plan", () => {
  it("is one action: a second sub-program with the same effect and key finds the first one's, and nothing is sent twice", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await planned([submit(1, commenting("a", "fixed")), submit(2, commenting("a", "fixed")), finish()], { tools: [tool] });
    const r = await run(w, "n07");
    expect(state(r)).toBe("succeeded null");
    expect(w.told.map((t) => [t["admitted"], t["number"], t["result"]])).toEqual([[true, 1, "fixed a"], [true, 2, "fixed a"]]);
    expect(tool.executions).toHaveLength(1);
    const actions = await w.rt.journal.actions("n07");
    expect(actions.map((a) => [a.effect, a.state, a.command_id])).toEqual([["git.comment", "confirmed", `${programAt(1)}/defs/Fix/body/1/value`]]);
  });

  it("is another action under another key", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await planned([submit(1, commenting("a", "fixed")), submit(2, commenting("b", "fixed")), finish()], { tools: [tool] });
    const r = await run(w, "n07b");
    expect(state(r)).toBe("succeeded null");
    expect(tool.executions).toHaveLength(2);
    expect(new Set((await w.rt.journal.actions("n07b")).map((a) => a.operation_key)).size).toBe(2);
  });

  it("refuses the same key over other parameters: it is not that action, and not a new one", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await planned([submit(1, commenting("a", "fixed")), submit(2, commenting("a", "fixed again")), finish()], { tools: [tool] });
    const r = await run(w, "n07c");
    expect(state(r)).toBe("succeeded null");
    expect(w.told[1]).toMatchObject({ admitted: true, number: 2, error: { $tag: "Rejected", $args: ["idempotency_conflict", { effect: "git.comment", command: `${programAt(1)}/defs/Fix/body/1/value` }] } });
    expect(tool.executions).toHaveLength(1);
    expect(await w.rt.journal.actions("n07c")).toHaveLength(1);
  });
});

// ── N06 ─────────────────────────────────────────────────────────────────

describe("N06: replay", () => {
  it("runs an admitted sub-program against the journal, from the IR the artifact store holds, and calls no model, adapter or checker", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const counted = counting();
    const w = await planned([submit(1, fixes(["a"], "{ tokens: 500k, steps: 40, agents: 4 }")), submit(1, commenting("a", "fixed")), finish("replayed")], { tools: [tool], plan: { checker: counted } });
    const r = await run(w, "n06");
    expect(state(r)).toBe("succeeded null");
    const turns = w.chat.calls.length;
    expect(counted.calls).toHaveLength(2);

    expect(await w.rt.replayRun("n06")).toEqual({ status: "complete", value: "replayed" });
    expect(w.chat.calls).toHaveLength(turns);
    expect(counted.calls).toHaveLength(2);
    expect(tool.executions).toHaveLength(1);
    expect(tool.prepares).toHaveLength(1);

    // The IR is read by what `program_admitted` names, and held to the hash it was admitted with.
    const [admitted] = await events(w, "n06", "program_admitted");
    const stored = await w.rt.artifacts.text({ tenant: "default", runId: "n06" }, String(admitted!["artifact"]));
    expect((JSON.parse(stored) as Program).module).toBe(`${MODULE}.plan_1`);
    await w.db.query("update events set data = jsonb_set(data, '{hash}', '\"sha256:00\"') where run_id = 'n06' and type = 'program_admitted'");
    await expect(w.rt.replayRun("n06")).rejects.toMatchObject({ code: "program_hash_mismatch" });
  });

  it("stops where the journal ends inside a sub-program that is still in flight", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await planned([submit(1, commenting("a", "fixed")), finish()], { src: program({ approve: "git.comment by release_manager" }), tools: [tool] });
    const stopped = await run(w, "n06-wait");
    expect(stopped.state).toBe("waiting");
    expect(await w.rt.replayRun("n06-wait")).toEqual({ status: "partial", stoppedAt: `${programAt(1)}/defs/Fix/body/1/value` });
  });

  it("refuses a sub-program that ends otherwise than the journal says", async () => {
    const w = await planned([submit(1, fixes(["a"])), finish()]);
    await run(w, "n06-other");
    await w.db.query("update commands set result = '\"something else\"' where run_id = 'n06-other' and command_id = $1", [programAt(1)]);
    await expect(w.rt.replayRun("n06-other")).rejects.toMatchObject({ code: "nondeterministic_replay" });
  });
});

// ── N10 ─────────────────────────────────────────────────────────────────

describe("N10: a bounded check", () => {
  it("stops a check that takes longer than the limit, tells the lead, and goes on", async () => {
    const w = await planned([check(1, fixes(["a"])), submit(1, fixes(["a"])), finish("went on")], { plan: { checker: stuck, checkMs: 150 } });
    const r = await run(w, "n10");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toBe("went on");
    const limit = [["check_limit", null, { limit: "time", max: 150 }]];
    expect(w.told[0]).toMatchObject({ ok: false, number: 1 });
    expect(refusals(w.told[0])).toEqual(limit);
    expect(w.told[1]).toMatchObject({ admitted: false, number: 1 });
    expect(refusals(w.told[1])).toEqual(limit);
    expect(await commandIds(w, "n10", "program")).toEqual([]);
    expect(await events(w, "n10", "program_refused")).toMatchObject([{ codes: ["check_limit"] }]);
  });

  it("the checker it stopped is gone, and the next check gets a new one", async () => {
    const input = await asked();
    expect(await stuck.check(input, 100)).toEqual({ limit: "time", max: 100 });
    expect(await stuck.check(input, 100)).toEqual({ limit: "time", max: 100 });
    expect(await checker.check(input, 5000)).toMatchObject({ ok: true, workflow: "Fix" });
  });

  it("ends a check that needs more memory than a check may, and the process goes on", async () => {
    const input = await asked();
    expect(await greedy.check(input, 20_000)).toEqual({ limit: "memory", max: 32 });
    expect(await checker.check(input, 5000)).toMatchObject({ ok: true, workflow: "Fix" });
  });

  it.each([
    ["more operations than a patch may hold", (): Value[] => Array.from({ length: MAX_OPS + 1 }, (_, i) => ({ op: "add", path: `/defs/T${i}`, value: {} })), { limit: "operations", max: MAX_OPS }],
    ["operations nested deeper than the IR may be", (): Value[] => [{ op: "add", path: "/defs/Deep", value: Array.from({ length: 70 }).reduce<Value>((v) => [v], "x") }], { limit: "depth", max: 64 }],
  ])("refuses %s before the checker sees them", async (_what, make, facts) => {
    const counted = counting();
    const w = await planned([[toolUse("s1", "submit_program", { base: base(1), ops: make() })], finish("went on")], { plan: { checker: counted } });
    const r = await run(w, `n10-${facts.limit}`);
    expect(state(r)).toBe("succeeded null");
    expect(refusals(w.told[0])).toEqual([["check_limit", null, facts]]);
    expect(counted.calls).toHaveLength(0);
    expect(await commandIds(w, `n10-${facts.limit}`, "program")).toEqual([]);
  });
});

/** What a checker is asked for the first sub-program of the test program, with nothing else in flight. */
async function asked(): Promise<SubprogramInput> {
  return { parent: (await planned([])).pkg.program, modules: {}, workflow: "W", number: 1, base: base(1), ops: ops(fixes(["a"])) as never, lead: "public", room: { left: {}, writes: [] } };
}

describe("a checker that fails on what it was given", () => {
  it("admits nothing: the lead is told the check failed, and the run goes on", async () => {
    const failing: ProgramChecker = { check: async () => ({ failed: "the checker broke" }) };
    const w = await planned([check(1, fixes(["a"])), submit(1, fixes(["a"])), finish("went on")], { plan: { checker: failing } });
    const r = await run(w, "failed");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toBe("went on");
    const failed = [["check_failed", null, { reason: "the checker broke" }]];
    expect(w.told[0]).toMatchObject({ ok: false, number: 1 });
    expect(refusals(w.told[0])).toEqual(failed);
    expect(w.told[1]).toMatchObject({ admitted: false, number: 1 });
    expect(refusals(w.told[1])).toEqual(failed);
    expect(await commandIds(w, "failed", "program")).toEqual([]);
    expect(await events(w, "failed", "program_submitted")).toMatchObject([{ ok: false }]);
    expect(await events(w, "failed", "program_refused")).toMatchObject([{ codes: ["check_failed"] }]);
  });

  it("is what a worker that throws has done, and the next check gets a new worker", async () => {
    const input = await asked();
    expect(await broken.check(input, 5000)).toEqual({ failed: "the checker broke" });
    expect(await broken.check(input, 5000)).toEqual({ failed: "the checker broke" });
    expect(await checker.check(input, 5000)).toMatchObject({ ok: true, workflow: "Fix" });
  });

  it("is not what a capability that names itself does: the check ends, and refuses what is handed nothing", async () => {
    const looping = (def: string): string => `${def}\n\n${sub(`  delegate Worker.fix(Item { name: "a" }) with caps Loop`, BUDGET, "RepoRead, Loop, ModelStd")}`;
    const w = await planned([
      submit(1, looping(`capability Loop = Loop.narrow("/work/repos/a")`)),
      submit(1, looping(`capability Loop = Back.narrow("/work/repos/a")\ncapability Back = Loop.narrow("/work/repos")`)),
      finish("went on"),
    ]);
    const r = await run(w, "looping");
    expect(state(r)).toBe("succeeded null");
    for (const answer of w.told) {
      expect(answer).toMatchObject({ admitted: false, number: 1 });
      expect(refusals(answer).map((x) => (x as unknown[]).slice(0, 2))).toEqual([["MDT-E0301", "/defs/Fix/body/0/value"]]);
    }
    expect(await commandIds(w, "looping", "program")).toEqual([]);
  });
});

describe("N10: the limits on a patch", () => {
  const big = (bytes: number): Value[] => [{ op: "add", path: "/defs/Big", value: "x".repeat(bytes) }];

  it("are a size, a depth and a count, each found before anything is built from the patch", () => {
    // A model's turn cannot carry a megabyte, so the size is shown here and not through a lead.
    expect(overLimit(big(1024 * 1024))).toEqual({ limit: "size", max: 1024 * 1024 });
    expect(overLimit(big(1024 * 1024 - 64))).toBeUndefined();
    expect(overLimit(Array.from({ length: MAX_OPS + 1 }, () => ({})))).toEqual({ limit: "operations", max: MAX_OPS });
    expect(overLimit(Array.from({ length: MAX_OPS }, () => ({})))).toBeUndefined();
    const nested = (depth: number): Value => Array.from({ length: depth }).reduce<Value>((v) => [v], "x");
    expect(overLimit(nested(65))).toEqual({ limit: "depth", max: 64 });
    expect(overLimit(nested(64))).toBeUndefined();
  });

  it("stop the walk where the first one is passed", () => {
    // Many megabytes after the limit cost nothing: the walk has ended.
    let read = 0;
    const counted = new Proxy(Array.from({ length: 200 }, () => "x".repeat(64 * 1024)), {
      get: (t, k, r) => (typeof k === "string" && /^\d+$/.test(k) && read++, Reflect.get(t, k, r)),
    });
    expect(overLimit(counted)).toEqual({ limit: "size", max: 1024 * 1024 });
    expect(read).toBeLessThan(20);
  });
});

describe("plan.checkMs in mandate.runtime.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-plan-config-"));
  const config = (plan?: unknown): RuntimeConfig => {
    writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify({ database: "pglite:db", ...(plan === undefined ? {} : { plan }) }));
    return readConfig(join(dir, "mandate.runtime.json"));
  };

  it("is how long a check may take on that runtime, and 2 s when the file does not say", async () => {
    const w = await planned([]);
    expect(runtimeOptions(config({ checkMs: 500 }), w.db).plan).toEqual({ checkMs: 500 });
    expect(runtimeOptions(config(), w.db).plan).toBeUndefined();
    expect(w.rt.checkMs).toBe(CHECK_MS);
    expect(CHECK_MS).toBe(2000);
  });

  it("is a whole number of milliseconds, and the only field of its section", () => {
    for (const bad of [0, -1, "2s", true]) expect(() => config({ checkMs: bad })).toThrow(/"plan.checkMs" is a whole number of milliseconds/);
    // The file is read as strict JSON, which has no fractions.
    expect(() => config({ checkMs: 1.5 })).toThrow(/bad_config.*not an integer/);
    expect(() => config({ checkMs: 500, workers: 2 })).toThrow(/unknown field plan.workers/);
  });
});

// ── recovery ────────────────────────────────────────────────────────────

describe("a run that stops inside a sub-program", () => {
  it("goes on from the journal after a crash: the sub-program is not checked or admitted again, and nothing is reserved twice", async () => {
    const counted = counting();
    const w = await planned([submit(1, fixes(["a", "b"])), finish("recovered")], { plan: { checker: counted } });
    // The worker dies after the second worker's delegation was dispatched, with its share reserved.
    w.faults.arm("after_dispatch", (i) => i.kind === "delegate" && i.id === `${programAt(1)}/defs/Fix/body/1/value`);
    await expect(run(w, "crash")).rejects.toBeInstanceOf(Crash);
    const mid = await w.rt.journal.budget("crash");
    expect(mid["agents"]).toEqual({ limit: 12, settled: 1, reserved: 4 });
    expect(mid["tokens"]!.settled + mid["tokens"]!.reserved).toBe(80_000);

    const r = await w.rt.resume("crash");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toBe("recovered");
    expect(counted.calls).toHaveLength(1);
    expect(await events(w, "crash", "program_admitted")).toHaveLength(1);
    expect(await events(w, "crash", "program_submitted")).toHaveLength(1);
    // The first worker ran once; the second was sent again under the same command.
    expect(w.chat.calls.filter((c) => c.agent === "Worker").map(itemOf)).toEqual(["a", "b"]);
    const after = await w.rt.journal.budget("crash");
    expect(after["agents"]).toEqual({ limit: 12, settled: 3, reserved: 0 });
    expect(after["tokens"]!.reserved).toBe(0);
    expect(await w.rt.replayRun("crash")).toEqual({ status: "complete", value: "recovered" });
  });

  it("goes on after a crash between a sub-program's end and its step's record", async () => {
    const w = await planned([submit(1, fixes(["a"])), finish("recovered")]);
    w.faults.arm("before_record", (i) => i.kind === "tool" && i.id === toolStep(1));
    await expect(run(w, "crash2")).rejects.toBeInstanceOf(Crash);
    const turns = w.chat.calls.length;
    const r = await w.rt.resume("crash2");
    expect(state(r)).toBe("succeeded null");
    // The sub-program had ended: its outcome is in the journal, and it is told to the lead without running it again.
    expect(w.chat.calls.filter((c) => c.agent === "Worker")).toHaveLength(1);
    expect(w.chat.calls.length - turns).toBe(1);
    expect(w.told).toMatchObject([{ admitted: true, number: 1, result: "fixed a" }]);
  });

  it("is cancelled with the run", async () => {
    const gate = deferred<void>();
    let inFlight = 0;
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      inFlight++;
      await gate.promise;
      return fixed(req);
    };
    const w = await planned([submit(1, fixes(["a", "b"])), finish()], { worker });
    const p = run(w, "cancel");
    await until(() => inFlight === 1, "the worker in flight");
    await w.rt.cancelRun("cancel");
    gate.resolve();
    const r = await p;
    expect(r.state).toBe("cancelled");
    expect(w.chat.calls.filter((c) => c.agent === "Worker")).toHaveLength(1);
  });
});

// ── time and class ──────────────────────────────────────────────────────

describe("what the run's envelope still says of a sub-program", () => {
  it("holds a sub-program's time to the run's deadline: the run's start plus the envelope's time", async () => {
    const timed = (time: string): string => fixes(["a"], `{ tokens: 20k, time: ${time}, steps: 40, agents: 4 }`);
    const w = await planned([submit(1, fixes(["a"])), submit(1, timed("2h")), submit(1, timed("30m")), finish()], { src: program({ budget: "{ tokens: 200k, time: 1h, steps: 400, agents: 12 }" }) });
    const r = await run(w, "time");
    expect(state(r)).toBe("succeeded null");
    expect(refusals(w.told[0]).map((x) => (x as [string, string, Obj])[2]["dimension"])).toEqual(["time"]);
    expect((refusals(w.told[0])[0] as [string, string, Obj])[2]).toMatchObject({ dimension: "time", asked: null });
    expect((refusals(w.told[1])[0] as [string, string, Obj])[2]).toMatchObject({ dimension: "time", asked: 7_200_000 });
    expect(w.told[2]).toMatchObject({ admitted: true, number: 1 });
    const left = ((w.told[0]!["room"] as Obj)["time_left_ms"] as number) ?? 0;
    expect(left).toBeGreaterThan(3_590_000);
    expect(left).toBeLessThanOrEqual(3_600_000);
  });

  it("holds a sub-program to the class of what its lead received", async () => {
    // The lead is handed a confidential document; the worker's model may receive internal data at most.
    const src = program({ spawn: "{ max_class: confidential }", body: "  plan Lead.study(secret) within envelope" })
      .replace("type Item = { name: Text }", "type Item = { name: Text }\ntype Secret = { body: Text } classified confidential\n\ncapability ModelHigh = model.infer(tier: premium, max_class: confidential)")
      .replace("  caps   RepoRead, ModelStd\n  budget { tokens: 60k, steps: 30 }", "  caps   RepoRead, ModelHigh\n  budget { tokens: 60k, steps: 30 }")
      .replace("  skill finish(items: List<Item>) -> Inferred<Text> ! {Fs.Read, Model}", "  skill study(s: Secret) -> Inferred<Text> ! {Fs.Read, Model}")
      .replace("workflow W(items: List<Item>)", "workflow W(secret: Secret)")
      .replace("caps    RepoRead, SrcWrite, ModelStd, Merge", "caps    RepoRead, SrcWrite, ModelStd, ModelHigh, Merge");
    const w = await planned([submit(1, fixes(["a"])), finish()], { src });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { secret: { body: "the plan" } }, runId: "class" });
    expect(state(r)).toBe("succeeded null");
    expect(w.told[0]).toMatchObject({ admitted: false });
    const facts = refusals(w.told[0]).map((x) => (x as [string, string, Obj])[2]);
    expect(facts).toMatchObject([{ dimension: "data_class", by: "lead", lead: "confidential" }]);
    expect(isObj(w.told[0]!["room"] ?? null)).toBe(true);
  });
});
