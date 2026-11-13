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
import { CHECK_MS, MAX_OPS, overLimit, Shared, type ProgramChecker, type WorkerChecker } from "../src/plan.js";
import { Crash } from "../src/signals.js";
import { deferred, SimModel, SimTool, toolUse, type SimTurn } from "../src/sim.js";
import { isObj, type Obj, type Value } from "../src/values.js";
import { closeAll, commandIds, planChecker, until } from "./helpers.js";
import { base, BRANCHES, BUDGET, CAPS, check, commenting, events, finish, fixed, fixes, itemOf, landing, leads, MODULE, msg, ONE, ops, PLAN, planned as plannedWith, program, programAt, refusals, run, sign, state, sub, submit, toolStep, TWO, type Planned, type Turn } from "./planning.js";

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

/** The program on a runtime with this file's checker (planning.ts `planned`). */
const planned = (lead: Turn[], o: Parameters<typeof plannedWith>[2] = {}): Promise<Planned> => plannedWith(checker, lead, o);

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
    expect(w.chat.calls[0]!.tools.map((t) => t.name)).toEqual(["read_file", "list_dir", "grep", "check_program", "submit_program", "request_amendment", "finish"]);
    // It is told the envelope it starts under, as IR, to write an amendment from.
    expect(first).toContain(`The envelope as you start, as JSON IR: {\\"budget\\":{\\"agents\\":12,\\"steps\\":400,\\"tokens\\":200000}`);
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

  it("is shown at most 40 diagnostics of a refusal, and told how many more there are", async () => {
    const roles = Array.from({ length: 45 }, (_, i) => `role extra_${i} "One more role"`).join("\n");
    const w = await planned([submit(1, `${roles}\n\n${fixes(["a"])}`), finish()]);
    const r = await run(w, "many");
    expect(state(r)).toBe("succeeded null");
    expect(w.told[0]).toMatchObject({ admitted: false, number: 1, more: 5 });
    expect(refusals(w.told[0])).toHaveLength(40);
    expect(new Set(refusals(w.told[0]).map((d) => (d as unknown[])[0]))).toEqual(new Set(["MDT-E1705"]));
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

// ── more leads than one ─────────────────────────────────────────────────


/** A sub-program that hands one item to a worker, which may write below `dir` and nowhere else. */
const narrowed = (dir: string, item: string): string => `capability Mine = SrcWrite.narrow("${dir}")\n\n${sub(`  delegate Worker.fix(Item { name: "${item}" }) with caps Mine`, BUDGET, "RepoRead, Mine, ModelStd")}`;

/** What refuses a sub-program of `narrowed` that asks to write below `asks` while `held` is held. */
const heldBy = (asks: string, held: string): unknown[] => [["MDT-E1706", "/defs/Fix/caps/0", { dimension: "write_scope", capability: `Mine = fs.write("${asks}")`, in_flight: held }]];

/** What a map item holds when the map hands it `SrcWrite.narrow(i.name)`. */
const ITEM = (name: string): string => `SrcWrite.narrow = fs.write("/work/repos/${name}")`;

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

  it("N02: a sub-program that asks for nothing of a dimension gets nothing of it, and takes none from the run", async () => {
    // An `infer` reserves 1000 tokens when it is sent. This sub-program asked for none, and the run has 200,000.
    const model = new SimModel(async () => ({ ok: "said", cost: { tokens: 100 } }));
    const none = sub(`  infer Text from quote("one")`, "{ tokens: 0, steps: 10, agents: 1 }", "ModelStd");
    const w = await planned([submit(1, none), finish("told")], { model });
    const r = await run(w, "nothing");
    expect(state(r)).toBe("succeeded null");
    expect(refusals(w.told[0])).toEqual([]);
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, error: { $tag: "BudgetExceeded", $args: [{ dimension: "tokens", requested: 1000, available: 0, program: programAt(1) }] } });
    expect(w.model.calls).toHaveLength(0);
    expect(await events(w, "nothing", "budget_exceeded")).toEqual([]);
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
    const gate = deferred<void>();
    let inFlight = 0;
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      inFlight++;
      if (itemOf(req) === "a") await gate.promise;
      return fixed(req);
    };
    const w = await planned([], { src: program({ body: BRANCHES }) });
    const told = leads(
      w,
      {
        [ONE]: [submit(1, narrowed("/work/repos/a", "a")), finish("one")],
        [TWO]: [
          async () => {
            await until(() => inFlight === 1, "the first lead's worker in flight");
            return submit(1, narrowed("/work/repos/a/src", "b"));
          },
          submit(1, narrowed("/work/repos/b", "b")),
          () => {
            gate.resolve();
            return finish("two");
          },
        ],
      },
      worker,
    );
    const r = await run(w, "writes");
    expect(state(r)).toBe("succeeded null");
    expect(told[TWO]![0]).toMatchObject({ admitted: false, room: { writes_in_flight: ['Mine = fs.write("/work/repos/a")'] } });
    expect(refusals(told[TWO]![0])).toEqual([["MDT-E1706", "/defs/Fix/caps/0", { dimension: "write_scope", capability: 'Mine = fs.write("/work/repos/a/src")', in_flight: 'Mine = fs.write("/work/repos/a")' }]]);
    expect(told[TWO]![1]).toMatchObject({ admitted: true, number: 1, result: "fixed b" });
    expect(told[ONE]![0]).toMatchObject({ admitted: true, number: 1, result: "fixed a" });
    // Each lead numbers its own sub-programs.
    expect(await commandIds(w, "writes", "program")).toEqual([programAt(1, `${ONE}`), programAt(1, `${TWO}`)]);
  });

  it("keeps a sub-program clear of one that waits for a person: it has not ended, and still holds its writes", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    // The first lead's sub-program writes below /work/repos/a and then comments, which waits for the release manager.
    const waits = `capability Mine = SrcWrite.narrow("/work/repos/a")\n\n${sub(`  let note = delegate Worker.fix(Item { name: "a" }) with caps Mine\n  effect git.comment(Item { name: "a" }, "fixed")\n    idempotent_by "a"\n  note`, BUDGET, "RepoRead, Mine, ModelStd, Merge")}`;
    const w = await planned([], { src: program({ body: BRANCHES, approve: "git.comment by release_manager" }), tools: [tool] });
    const commentWaits = async (): Promise<void> => {
      for (let i = 0; i < 2500 && !(await w.rt.journal.actions("held")).length; i++) await new Promise((r) => setTimeout(r, 2));
    };
    const told = leads(w, {
      [ONE]: [submit(1, waits), finish("one")],
      [TWO]: [
        async () => {
          await commentWaits();
          return submit(1, narrowed("/work/repos/a/src", "b"));
        },
        finish("two"),
      ],
    });
    const stopped = await run(w, "held");
    expect(state(stopped)).toContain("waiting");
    expect(stopped.waiting).toMatchObject({ kind: "decision", request: { effect: "git.comment", role: "release_manager" } });
    // The other lead asked while the first one's sub-program waited: nothing of that one runs now, and it holds its place.
    expect(told[TWO]![0]).toMatchObject({ admitted: false, room: { writes_in_flight: ['Merge = git.pr("company/backend")', 'Mine = fs.write("/work/repos/a")'] } });
    expect(refusals(told[TWO]![0])).toEqual(heldBy("/work/repos/a/src", 'Mine = fs.write("/work/repos/a")'));
    expect(await commandIds(w, "held", "program")).toEqual([programAt(1, ONE)]);

    const done = await w.rt.decideAction("held", msg(), { signed: await sign(w, "held", "bob", "approve") });
    expect(state(done)).toBe("succeeded null");
    expect(told[ONE]![0]).toMatchObject({ admitted: true, number: 1, result: "fixed a" });
    expect(tool.executions).toHaveLength(1);
  });

  it("decides admissions one after the other: of two leads that ask at once for the same place, one is admitted and the other is told it is held", async () => {
    const gate = deferred<void>();
    let asking = 0;
    let checking = 0;
    let peak = 0;
    // A check that does not end before both leads have asked.
    const slow: ProgramChecker = {
      check: async (input, ms) => {
        peak = Math.max(peak, ++checking);
        // Two checks at once would both see the place free. The run is let go on, so that the test can say so.
        if (checking > 1) gate.resolve();
        try {
          await until(() => asking === 2, "both leads asking");
          await new Promise((r) => setTimeout(r, 25));
          return await checker.check(input, ms);
        } finally {
          checking--;
        }
      },
    };
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      await gate.promise;
      return fixed(req);
    };
    const lead = (name: string): Turn[] => [
      () => {
        asking++;
        return submit(1, narrowed("/work/repos/a", name));
      },
      () => {
        gate.resolve();
        return finish(name);
      },
    ];
    const w = await planned([], { src: program({ body: BRANCHES }), plan: { checker: slow } });
    const told = leads(w, { [ONE]: lead("one"), [TWO]: lead("two") }, worker);
    const r = await run(w, "at-once");
    expect(state(r)).toBe("succeeded null");
    expect(peak).toBe(1);
    const first = [told[ONE]![0]!, told[TWO]![0]!];
    expect(first.map((t) => t["admitted"]).sort()).toEqual([false, true]);
    expect(refusals(first.find((t) => t["admitted"] === false))).toEqual(heldBy("/work/repos/a", 'Mine = fs.write("/work/repos/a")'));
    expect(await events(w, "at-once", "program_admitted")).toHaveLength(1);
  });

  it("keeps a sub-program clear of what a map still writes: the item in flight, and the items that have not started", async () => {
    const body = `  par {\n    moved = map i in items max 4 with caps SrcWrite.narrow(i.name) {\n      delegate Worker.fix(i)\n    }\n    planned = plan Lead.finish(items) within envelope\n  }\n  planned`;
    const LEAD = "/defs/W/body/0/branches/planned";
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      const item = itemOf(req);
      started.push(item);
      if (item === "a") await first.promise;
      if (item === "b") await second.promise;
      return fixed(req);
    };
    const w = await planned([], { src: program({ body }) });
    const told = leads(
      w,
      {
        [LEAD]: [
          async () => {
            await until(() => started.includes("a"), "the first item in flight");
            return submit(1, narrowed("/work/repos/a/src", "s1"));
          },
          submit(1, narrowed("/work/repos/b", "s2")),
          submit(1, narrowed("/work/repos/c", "s3")),
          async () => {
            first.resolve();
            await until(() => started.includes("b"), "the second item in flight");
            return submit(2, narrowed("/work/repos/a", "s4"));
          },
          () => {
            second.resolve();
            return finish("planned");
          },
        ],
      },
      worker,
    );
    const r = await run(w, "map-writes");
    expect(state(r)).toBe("succeeded null");
    const [inFlight, notStarted, beside, ended] = told[LEAD]!;
    // The item in flight holds its place, and so does the item the map has not started yet.
    expect(refusals(inFlight)).toEqual(heldBy("/work/repos/a/src", ITEM("a")));
    expect(refusals(notStarted)).toEqual(heldBy("/work/repos/b", ITEM("b")));
    expect(beside).toMatchObject({ admitted: true, number: 1, result: "fixed s3" });
    // An item that has ended holds nothing.
    expect(ended).toMatchObject({ admitted: true, number: 2, result: "fixed s4" });
  });

  it("holds nothing for the items a map did not start before it failed", async () => {
    const body = `  let moved = map i in items max 4 supervise fail_fast with caps SrcWrite.narrow(i.name) {\n    delegate Worker.fix(i)\n  }\n  on error(SkillFailed(why)) => map i in items max 4 {\n    "left"\n  }\n  plan Lead.finish(items) within envelope`;
    const worker = (req: TurnRequest): SimTurn => (itemOf(req) === "a" ? { error: { tag: "SkillFailed", args: ["no luck"] }, cost: { steps: 1 } } : fixed(req));
    const w = await planned([], { src: program({ body }) });
    const LEAD = "/defs/W/body/2/value";
    const told = leads(w, { [LEAD]: [submit(1, narrowed("/work/repos/b", "s1")), finish("planned")] }, worker);
    const r = await run(w, "map-failed");
    expect(state(r)).toBe("succeeded null");
    // The first item failed and the map with it: the second never started, and its place is free.
    expect(w.chat.calls.filter((c) => c.agent === "Worker").map(itemOf)).toEqual(["a", "s1"]);
    expect(told[LEAD]![0]).toMatchObject({ admitted: true, number: 1, result: "fixed s1" });
  });

  it("does not hold a map item's own place against the sub-program its lead plans inside it, and holds the other items'", async () => {
    const body = `  let outs = map i in items max 2 with caps SrcWrite.narrow(i.name) {\n    plan Lead.finish([i]) within envelope\n  }\n  plan Lead.finish(items) within envelope`;
    const item = (n: number): string => `/defs/W/body/0/value[${n}]`;
    const w = await planned([], { src: program({ body }) });
    const told = leads(w, {
      [item(0)]: [submit(1, narrowed("/work/repos/a/src", "s1")), submit(2, narrowed("/work/repos/b", "s2")), finish("a")],
      [item(1)]: [finish("b")],
      "/defs/W/body/1/value": [finish("planned")],
    });
    const r = await run(w, "inside");
    expect(state(r)).toBe("succeeded null");
    expect(told[item(0)]![0]).toMatchObject({ admitted: true, number: 1, result: "fixed s1" });
    expect(refusals(told[item(0)]![1])).toEqual(heldBy("/work/repos/b", ITEM("b")));
  });
});

// ── a map beside a sub-program in flight ────────────────────────────────

/**
 * A workflow whose lead plans in one branch while the other runs a map over the items, each item writing below its
 * name. The map comes after a delegation of the branch's own, to the item `gate`, so a test says when it starts.
 */
const BESIDE = `  par {\n    planned = plan Lead.finish(items) within envelope\n    moved = map g in items max 1 {\n      delegate Worker.fix(Item { name: "gate" })\n      map i in items max 2 with caps SrcWrite.narrow(i.name) {\n        delegate Worker.fix(i)\n      }\n    }\n  }\n  moved`;
const beside = (o: { body?: string; returns?: string; approve?: string } = {}): string =>
  program({ body: o.body ?? BESIDE, ...(o.approve ? { approve: o.approve } : {}) }).replace("-> Inferred<Text>\n  envelope", `-> ${o.returns ?? "List<Outcome<List<Outcome<Inferred<Text>>>>>"}\n  envelope`);
const PLANNED = "/defs/W/body/0/branches/planned";
const OUTER = "/defs/W/body/0/branches/moved";
const INNER = `${OUTER}[0]/body/1/value`;
const GATE = `${OUTER}[0]/body/0/value`;
const A = { items: [{ name: "a" }] };
const ok = (v: Value): Value => ({ $tag: "Ok", $args: [v] });
const failed = (tag: string, ...args: Value[]): Value => ({ $tag: "Failed", $args: [{ $tag: tag, $args: args }] });
const MINE_A = 'Mine = fs.write("/work/repos/a")';
/** What the program sees of the map at `map`, refused because its first item would write where sub-program `program` may write `held`. */
const besideProgram = (map: string, held: string, program: string): Value => failed("Rejected", "overlapping_scopes", { map, items: [0], left: ITEM("a"), right: held, program });
/** The outer map's one item, as the program sees it when the inner map was refused because of sub-program 1. */
const REFUSED = [besideProgram(INNER, MINE_A, programAt(1, PLANNED))];
/** A sub-program that fixes `s1` below /work/repos/a and then comments on `a`, which waits for the release manager. */
const waits = `capability Mine = SrcWrite.narrow("/work/repos/a")\n\n${sub(`  let note = delegate Worker.fix(Item { name: "s1" }) with caps Mine\n  effect git.comment(Item { name: "a" }, "fixed")\n    idempotent_by "a"\n  note`, BUDGET, "RepoRead, Mine, ModelStd, Merge")}`;

/** Calls `then` after each call of the journal's `name` whose arguments `when` picks has returned. */
function after<K extends "mapEnded" | "closeProgram" | "openWait" | "dispatch">(w: Planned, name: K, when: (args: Parameters<Planned["rt"]["journal"][K]>) => boolean, then: () => void): void {
  const journal = w.rt.journal as unknown as Record<K, (...args: unknown[]) => Promise<unknown>>;
  const real = journal[name].bind(journal);
  journal[name] = async (...args: unknown[]) => {
    const out = await real(...args);
    if (when(args as Parameters<Planned["rt"]["journal"][K]>)) then();
    return out;
  };
}

const workers = (w: Planned): string[] => w.chat.calls.filter((c) => c.agent === "Worker").map(itemOf).sort();

describe("C5 across the run: a map beside a sub-program in flight", () => {
  it("refuses a map whose item would write where a sub-program in flight may write (Rejected overlapping_scopes), before the item runs", async () => {
    const inFlight = deferred<void>();
    const mapped = deferred<void>();
    // The map starts once the sub-program's worker is in flight, and the worker ends once the map has.
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      if (itemOf(req) === "gate") await inFlight.promise;
      if (itemOf(req) === "s1") {
        inFlight.resolve();
        await mapped.promise;
      }
      return fixed(req);
    };
    const w = await planned([], { src: beside() });
    after(w, "mapEnded", ([, , d]) => d.map === OUTER, () => mapped.resolve());
    const told = leads(w, { [PLANNED]: [submit(1, narrowed("/work/repos/a", "s1")), finish("planned")] }, worker);
    const r = await run(w, "beside", { input: A });
    expect(state(r)).toBe("succeeded null");
    // The same value and reason as two items that overlap, and the facts say which sub-program is in the way.
    expect(r.result).toEqual(REFUSED);
    expect(told[PLANNED]![0]).toMatchObject({ admitted: true, number: 1, result: "fixed s1" });
    // The item never ran, and the map never started.
    expect(workers(w)).toEqual(["gate", "s1"]);
    expect((await events(w, "beside", "map_started")).map((e) => e["map"])).toEqual([OUTER]);
    // The refusal is recorded, and a replay reads it there: what is in flight now is nothing.
    expect(await w.rt.journal.command("beside", `${INNER}/in_flight`)).toMatchObject({ kind: "refusal", state: "failed", error: { tag: "Rejected" } });
    expect(await w.rt.replayRun("beside")).toEqual({ status: "complete", value: REFUSED });
  });

  it("runs a map whose items write apart from what the sub-program in flight may write", async () => {
    const inFlight = deferred<void>();
    const mapped = deferred<void>();
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      if (itemOf(req) === "gate") await inFlight.promise;
      if (itemOf(req) === "s1") {
        inFlight.resolve();
        await mapped.promise;
      }
      return fixed(req);
    };
    const w = await planned([], { src: beside() });
    after(w, "mapEnded", ([, , d]) => d.map === OUTER, () => mapped.resolve());
    leads(w, { [PLANNED]: [submit(1, narrowed("/work/repos/b", "s1")), finish("planned")] }, worker);
    const r = await run(w, "apart", { input: A });
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toEqual([ok([ok("fixed a")])]);
    expect(workers(w)).toEqual(["a", "gate", "s1"]);
  });

  it("runs a map whose item writes where a sub-program wrote that has ended: it holds nothing", async () => {
    const closed = deferred<void>();
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      if (itemOf(req) === "gate") await closed.promise;
      return fixed(req);
    };
    const w = await planned([], { src: beside() });
    after(w, "closeProgram", () => true, () => closed.resolve());
    leads(w, { [PLANNED]: [submit(1, narrowed("/work/repos/a", "s1")), finish("planned")] }, worker);
    const r = await run(w, "ended", { input: A });
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toEqual([ok([ok("fixed a")])]);
    expect(workers(w)).toEqual(["a", "gate", "s1"]);
  });

  it("refuses a map whose item would write where a sub-program may write that waits for a person: it has not ended", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const asked = deferred<void>();
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      if (itemOf(req) === "gate") await asked.promise;
      return fixed(req);
    };
    const w = await planned([], { src: beside({ approve: "git.comment by release_manager" }), tools: [tool] });
    after(w, "openWait", ([, , cmd]) => cmd.kind === "decision", () => asked.resolve());
    leads(w, { [PLANNED]: [submit(1, waits), finish("planned")] }, worker);
    const stopped = await run(w, "waits", { input: A });
    expect(state(stopped)).toContain("waiting");
    expect(stopped.waiting).toMatchObject({ kind: "decision", request: { effect: "git.comment", role: "release_manager" } });
    const done = await w.rt.decideAction("waits", msg(), { signed: await sign(w, "waits", "bob", "approve") });
    expect(state(done)).toBe("succeeded null");
    expect(done.result).toEqual(REFUSED);
    expect(tool.executions).toHaveLength(1);
    expect(workers(w)).toEqual(["gate", "s1"]);
  });

  it("refuses a map whose item would write where a sub-program may write whose worker crashed: the resumed run finds it in flight", async () => {
    const inFlight = deferred<void>();
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      if (itemOf(req) === "gate") await inFlight.promise;
      if (itemOf(req) === "s1") inFlight.resolve();
      return fixed(req);
    };
    const w = await planned([], { src: beside() });
    leads(w, { [PLANNED]: [submit(1, narrowed("/work/repos/a", "s1")), finish("planned")] }, worker);
    // The worker dies before it records how the sub-program's worker and the map's gate ended: the map never came to its items.
    const S1 = `${programAt(1, PLANNED)}/defs/Fix/body/0/value`;
    w.faults.arm("before_record", (i) => i.id === S1).arm("before_record", (i) => i.id === GATE);
    await expect(run(w, "crashed", { input: A })).rejects.toBeInstanceOf(Crash);
    expect((await w.rt.journal.inFlight("crashed")).map((a) => a.command)).toEqual([programAt(1, PLANNED)]);
    expect(await commandIds(w, "crashed", "refusal")).toEqual([]);
    // In the resumed run, the sub-program ends only once the map has decided.
    const mapped = deferred<void>();
    after(w, "mapEnded", ([, , d]) => d.map === OUTER, () => mapped.resolve());
    const closeProgram = w.rt.journal.closeProgram.bind(w.rt.journal);
    w.rt.journal.closeProgram = async (...args: Parameters<typeof closeProgram>) => {
      await mapped.promise;
      return closeProgram(...args);
    };
    const r = await w.rt.resume("crashed");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toEqual(REFUSED);
    // Each worker's turn was recorded before the crash, and is read again, not asked again.
    expect(workers(w)).toEqual(["gate", "s1"]);
  });

  it("decides a map's items and a sub-program's admission one after the other: a sub-program being admitted is in the map's way", async () => {
    const checking = deferred<void>();
    const asked = deferred<void>();
    const mapped = deferred<void>();
    // The check waits for the map to ask to start its items, or, were the two not one after the other, for the
    // map's item to start.
    const slow: ProgramChecker = {
      check: async (input, ms) => {
        checking.resolve();
        await asked.promise;
        return checker.check(input, ms);
      },
    };
    const admitting = Shared.prototype.admitting;
    let afterCheck = false;
    void checking.promise.then(() => (afterCheck = true));
    Shared.prototype.admitting = function <T>(this: Shared, fn: () => Promise<T>): Promise<T> {
      if (afterCheck) asked.resolve();
      return admitting.call(this, fn) as Promise<T>;
    };
    try {
      const worker = async (req: TurnRequest): Promise<SimTurn> => {
        if (itemOf(req) === "gate") await checking.promise;
        if (itemOf(req) === "a") asked.resolve();
        if (itemOf(req) === "s1") await mapped.promise;
        return fixed(req);
      };
      const w = await planned([], { src: beside(), plan: { checker: slow } });
      after(w, "mapEnded", ([, , d]) => d.map === OUTER, () => mapped.resolve());
      const told = leads(w, { [PLANNED]: [submit(1, narrowed("/work/repos/a", "s1")), finish("planned")] }, worker);
      const r = await run(w, "one-after", { input: A });
      expect(state(r)).toBe("succeeded null");
      expect(told[PLANNED]![0]).toMatchObject({ admitted: true, number: 1, result: "fixed s1" });
      expect(r.result).toEqual(REFUSED);
      expect(workers(w)).toEqual(["gate", "s1"]);
    } finally {
      Shared.prototype.admitting = admitting;
    }
  });

  it("does not refuse a map inside a sub-program because of that sub-program", async () => {
    const inside = `capability Mine = SrcWrite.narrow("/work/repos/a")\n\n${sub(`  let moved = map i in [Item { name: "x" }, Item { name: "y" }] max 2 par 2 with caps Mine.narrow(i.name) {\n    delegate Worker.fix(i)\n  }\n  delegate Worker.fix(Item { name: "s1" }) with caps Mine`, BUDGET, "RepoRead, Mine, ModelStd")}`;
    const w = await planned([submit(1, inside), finish("planned")]);
    const r = await run(w, "own");
    expect(state(r)).toBe("succeeded null");
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, result: "fixed s1" });
    expect(workers(w)).toEqual(["s1", "x", "y"]);
    expect((await events(w, "own", "map_started")).map((e) => e["map"])).toEqual([`${programAt(1)}/defs/Fix/body/0/value`]);
  });

  it("does not refuse a map item, when the run comes to its map again, because of the sub-program its lead planned inside it", async () => {
    const body = `  let outs = map i in items max 2 with caps SrcWrite.narrow(i.name) {\n    plan Lead.finish([i]) within envelope\n  }\n  plan Lead.finish(items) within envelope`;
    const item = "/defs/W/body/0/value[0]";
    const w = await planned([], { src: program({ body }) });
    leads(w, { [item]: [submit(1, narrowed("/work/repos/a/src", "s1")), finish("a")], "/defs/W/body/1/value": [finish("planned")] });
    // The worker dies inside the item's sub-program, which is in flight when the resumed run comes to the map.
    w.faults.arm("after_dispatch", (i) => i.kind === "delegate" && i.id === `${programAt(1, `${item}/body/0/value`)}/defs/Fix/body/0/value`);
    await expect(run(w, "parent", { input: A })).rejects.toBeInstanceOf(Crash);
    expect((await w.rt.journal.inFlight("parent")).map((a) => a.command)).toEqual([programAt(1, `${item}/body/0/value`)]);
    const r = await w.rt.resume("parent");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toBe("planned");
    // The worker died before it sent the item's worker its task: that was sent once, by the resumed run.
    expect(workers(w)).toEqual(["s1"]);
    expect(await w.rt.replayRun("parent")).toEqual({ status: "complete", value: "planned" });
  });

  it("does not refuse a map the run began before when it comes to it again, resumed: a sub-program admitted since may write where its item wrote", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const body = `  par {\n    planned = plan Lead.finish(items) within envelope\n    moved = map i in items max 2 with caps SrcWrite.narrow(i.name) {\n      delegate Worker.fix(i)\n    }\n  }\n  moved`;
    const MAP = "/defs/W/body/0/branches/moved";
    const mapped = deferred<void>();
    const w = await planned([], { src: beside({ body, returns: "List<Outcome<Inferred<Text>>>", approve: "git.comment by release_manager" }), tools: [tool] });
    after(w, "mapEnded", ([, , d]) => d.map === MAP, () => mapped.resolve());
    // The lead plans once the map has ended: its sub-program writes where the map's item wrote, and waits for a person.
    leads(w, {
      [PLANNED]: [
        async () => {
          await mapped.promise;
          return submit(1, waits);
        },
        finish("planned"),
      ],
    });
    const stopped = await run(w, "again", { input: A });
    expect(state(stopped)).toContain("waiting");
    // The resumed run comes to the map again while the sub-program is still in flight: it ends only once the map has decided.
    const decided = deferred<void>();
    after(w, "mapEnded", ([, , d]) => d.map === MAP, () => decided.resolve());
    after(w, "dispatch", ([, , cmd]) => cmd.id === `${MAP}/in_flight`, () => decided.resolve());
    const closeProgram = w.rt.journal.closeProgram.bind(w.rt.journal);
    let inFlightAgain: string[] = [];
    w.rt.journal.closeProgram = async (...args: Parameters<typeof closeProgram>) => {
      inFlightAgain = (await w.rt.journal.inFlight("again")).map((a) => a.command);
      await decided.promise;
      return closeProgram(...args);
    };
    const done = await w.rt.decideAction("again", msg(), { signed: await sign(w, "again", "bob", "approve") });
    expect(state(done)).toBe("succeeded null");
    expect(inFlightAgain).toEqual([programAt(1, PLANNED)]);
    expect(done.result).toEqual([ok("fixed a")]);
    expect(await commandIds(w, "again", "refusal")).toEqual([]);
    expect(workers(w)).toEqual(["a", "s1"]);
    expect(await w.rt.replayRun("again")).toEqual({ status: "complete", value: [ok("fixed a")] });
  });

  it("keeps a map refused when the run comes to it again, resumed, though the sub-program in its way has ended since", async () => {
    const inFlight = deferred<void>();
    const mapped = deferred<void>();
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      if (itemOf(req) === "gate") await inFlight.promise;
      if (itemOf(req) === "s1") {
        inFlight.resolve();
        await mapped.promise;
      }
      return fixed(req);
    };
    const w = await planned([], { src: beside() });
    after(w, "mapEnded", ([, , d]) => d.map === OUTER, () => mapped.resolve());
    leads(w, { [PLANNED]: [submit(1, narrowed("/work/repos/a", "s1")), finish("planned")] }, worker);
    // The worker dies after the sub-program has ended, before the lead's step records it.
    w.faults.arm("before_record", (i) => i.kind === "tool" && i.id === toolStep(1, PLANNED));
    await expect(run(w, "kept", { input: A })).rejects.toBeInstanceOf(Crash);
    expect(await w.rt.journal.inFlight("kept")).toEqual([]);
    const r = await w.rt.resume("kept");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toEqual(REFUSED);
    expect(workers(w)).toEqual(["gate", "s1"]);
    expect(await w.rt.replayRun("kept")).toEqual({ status: "complete", value: REFUSED });
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

  it("gives a lead a place again only when there is one: two leads and their sub-programs never run two at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const counted = async (fn: () => SimTurn | Promise<SimTurn>): Promise<SimTurn> => {
      peak = Math.max(peak, ++inFlight);
      try {
        return await fn();
      } finally {
        inFlight--;
      }
    };
    // The second lead's worker and the first lead's next turn each wait a while for the other to be asked. They
    // meet only if the first lead goes on without a place.
    const worked = deferred<void>();
    const again = deferred<void>();
    const meet = (mine: { resolve: () => void }, other: { promise: Promise<void> }): Promise<unknown> => (mine.resolve(), Promise.race([other.promise, new Promise((r) => setTimeout(r, 300))]));
    const worker = (req: TurnRequest): Promise<SimTurn> =>
      counted(async () => {
        if (itemOf(req) === "b") await meet(worked, again);
        return fixed(req);
      });
    const w = await planned([], { src: program({ body: BRANCHES, spawn: "{ max_concurrent: 1 }" }) });
    const told = leads(
      w,
      {
        [ONE]: [() => counted(() => submit(1, narrowed("/work/repos/a", "a"))), () => counted(async () => (await meet(again, worked), finish("one")))],
        [TWO]: [() => counted(() => submit(1, narrowed("/work/repos/b", "b"))), () => counted(() => finish("two"))],
      },
      worker,
    );
    const r = await run(w, "places");
    expect(state(r)).toBe("succeeded null");
    expect(told[ONE]![0]).toMatchObject({ admitted: true, result: "fixed a" });
    expect(told[TWO]![0]).toMatchObject({ admitted: true, result: "fixed b" });
    expect(peak).toBe(1);
  });

  it("holds a sub-program's map to the envelope's concurrency, and bounds a map without max by the sub-program's own agents", async () => {
    let inFlight = 0;
    let peak = 0;
    let arrived = 0;
    // A worker stays in flight until two are, or until the last of the three items has come, so the peak does not
    // depend on how fast the machine and its database are. The pause after that is what lets one too many show.
    const full: Array<() => void> = [];
    const worker = async (req: TurnRequest): Promise<SimTurn> => {
      peak = Math.max(peak, ++inFlight);
      arrived++;
      if (inFlight < 2 && arrived < 3) await new Promise<void>((r) => full.push(r));
      for (const r of full.splice(0)) r();
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
    // The bound is the sub-program's own `agents`, which no amendment moves: its refusal is not a command of its own.
    expect(await commandIds(w, "sub-map", "refusal")).toEqual([]);
  });

  it("grants a delegation in a sub-program from the sub-program's own capabilities, not from the envelope's", async () => {
    // The envelope lets the run write below /work/repos. The sub-program's agent holds two directories of it, and
    // the sub-program's workflow holds one: the envelope would cover both, and the workflow gives the one it has.
    const part = [
      `capability PartA = fs.write("/work/repos/a")`,
      `capability PartB = fs.write("/work/repos/b")`,
      `agent Both {\n  role   "Fixes an item in one of two places."\n  caps   RepoRead, ModelStd, PartA, PartB\n  budget { tokens: 3k, steps: 4 }\n  skill fix(i: Item) -> Inferred<Text> ! {Fs.Read, Fs.Write, Model}\n}`,
      sub(`  delegate Both.fix(Item { name: "a" })`, BUDGET, "RepoRead, ModelStd, PartA"),
    ].join("\n\n");
    const w = await planned([submit(1, part), finish()]);
    const r = await run(w, "own-caps");
    expect(state(r)).toBe("succeeded null");
    expect(refusals(w.told[0])).toEqual([]);
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, result: "fixed a" });
    // Two sandboxes: the lead's, which writes nowhere below /work, and the agent's.
    const writable = w.host.created.map((c) => c.policy.filesystem.readWrite.filter((p) => p.startsWith("/work/")));
    expect(writable.filter((paths) => paths.length > 0)).toEqual([["/work/repos/a"]]);
    expect(w.chat.calls.filter((c) => c.agent === "Both")).toHaveLength(1);
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

  it("leaves the members of a change set their own actions: each is keyed by its place, under the set's one key", async () => {
    // Two components the release manager owns. A sub-program lands a change to each, as one set with one key.
    const src = landing();
    const land = `workflow Land() -> Text
  caps   Repos
  budget { tokens: 1k, steps: 10, agents: 1 }
{
  let a = verify Change { files: ["a.ts"] } against ChangeAccepted(Change { files: ["a.ts"] })
  let b = verify Change { files: ["b.ts"] } against ChangeAccepted(Change { files: ["b.ts"] })
  let landed = changeset(a) {
    member left = git.merge(a)
    member right = git.merge(b)
    order left, right
    approve role "release_manager"
  } idempotent_by "k"
  "landed"
}`;
    const merge = new SimTool("git.merge", "reconcilable");
    const w = await planned([submit(1, land), finish("planned")], { src, tools: [merge] });
    let r = await run(w, "set");
    expect(refusals(w.told[0])).toEqual([]);
    // Each member's owner, and then the set's approver: the release manager, three times.
    for (let i = 0; i < 3; i++) {
      expect(state(r)).toContain("waiting");
      r = await w.rt.decideAction("set", msg(), { signed: await sign(w, "set", "bob", "approve") });
    }
    expect(state(r)).toBe("succeeded null");
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, result: "landed" });
    expect(merge.executions).toHaveLength(2);
    expect(new Set(merge.executions.map((e) => e.operationKey)).size).toBe(2);
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

  it("is what the checker's own worker answers when the check throws, and the worker is kept", async () => {
    const input = await asked();
    expect(await checker.check({ ...input, workflow: "Nobody" }, 5000)).toEqual({ failed: "Nobody is not a workflow with an envelope, so it has no sub-programs" });
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
    // What comes after the limit in an object is not walked into either.
    let inner = 0;
    const after = new Proxy(["a", "b", "c"], {
      get: (t, k, r) => (typeof k === "string" && /^\d+$/.test(k) && inner++, Reflect.get(t, k, r)),
    });
    expect(overLimit([{ first: "x".repeat(1024 * 1024), then: after }])).toEqual({ limit: "size", max: 1024 * 1024 });
    expect(inner).toBe(0);
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
