// The ledger under a sub-program, at the journal (spec/envelope.md "The
// ledger"; N02, INV-15). A sub-program is admitted with its whole budget
// reserved from the run. What runs inside it takes a share of that
// reservation and gives back what it did not spend, so that the program and
// its commands together never hold more of the run than it was admitted
// with. Each rule is shown on the rows it writes.

import { afterAll, describe, expect, it } from "vitest";
import type { Cost } from "../src/adapters.js";
import type { Admission, Journal } from "../src/journal.js";
import { closeAll, world } from "./helpers.js";
import { FIX } from "./programs.js";

afterAll(closeAll);

const RUN = "ledger";
const PLAN = "/defs/W/body/0/value";
const P = (n = 1): string => `${PLAN}/program/${n}`;
const D = (i: number, n = 1): string => `${P(n)}/defs/Fix/body/${i}/value`;

interface Ledger {
  j: Journal;
  fence: number;
  /** What each command holds now, by dimension. */
  held(): Promise<Record<string, Record<string, number>>>;
  /** What the run has settled and what it holds, by dimension. */
  run(): Promise<Record<string, [settled: number, reserved: number]>>;
  admit(n: number, budget: Cost): Promise<Admission>;
  send(id: string, reserve: Cost | undefined, o?: { within?: string; inside?: string }): Promise<unknown>;
  done(id: string, cost: Cost | "unknown", within?: string): Promise<void>;
  events(type: string): Promise<unknown[]>;
}

/** A run with these limits and nothing dispatched, and the worker that holds its lease. */
async function ledger(limits: Record<string, number>): Promise<Ledger> {
  const w = await world(FIX);
  const j = w.rt.journal;
  await w.db.query("insert into packages (package_hash, program, lock, modules) values ('sha256:p', '{}', '{}', '{}')");
  await w.db.tx((tx) => j.createRun(tx, { runId: RUN, tenant: "default", packageHash: "sha256:p", workflow: "W", input: {}, policy: {}, limits, manifest: {}, manifestHash: "sha256:m" }));
  const l: Ledger = {
    j,
    fence: (await j.acquire(RUN)).fence,
    async held() {
      const rows = await w.db.query<{ command_id: string; dimension: string; amount: string }>("select command_id, dimension, amount from reservations where run_id = $1 and state = 'active' order by command_id, dimension", [RUN]);
      const out: Record<string, Record<string, number>> = {};
      for (const r of rows) (out[r.command_id] ??= {})[r.dimension] = Number(r.amount);
      return out;
    },
    async run() {
      return Object.fromEntries(Object.entries(await j.budget(RUN)).map(([dim, b]) => [dim, [b.settled, b.reserved]]));
    },
    admit: (n, budget) => j.admitProgram(RUN, l.fence, { plan: PLAN, number: n, step: `${PLAN}/step/${n}/tool/0`, command: P(n), hash: `sha256:h${n}`, base: `sha256:b${n}`, artifact: `sha256:a${n}`, workflow: "Fix" }, budget, `digest:${n}`, async () => {}),
    send: (id, reserve, o = {}) => j.dispatch(RUN, l.fence, { id, kind: id.includes("/step/") ? "turn" : "delegate", digest: `digest:${id}` }, reserve, o.within, o.inside),
    // Only a call that failed may not know what it cost yet: a timeout, or a cancellation (R16).
    done: (id, cost, within) => j.complete(RUN, l.fence, id, cost === "unknown" ? { error: { tag: "Timeout", args: [] }, cost } : { ok: null, cost }, within),
    events: async (type) => (await j.events(RUN)).filter((e) => e.type === type).map((e) => e.data),
  };
  return l;
}

const LIMITS = { tokens: 5000, steps: 50, agents: 10 };
const BUDGET: Cost = { tokens: 1000, steps: 10, agents: 2 } as Cost;
const SHARE: Cost = { tokens: 400, steps: 4, agents: 1 } as Cost;

describe("admission", () => {
  it("reserves the sub-program's whole budget from the run, as one command", async () => {
    const l = await ledger(LIMITS);
    const a = await l.admit(1, BUDGET);
    expect(a).toMatchObject({ command: P(), number: 1, reservation: { tokens: 1000, steps: 10, agents: 2 } });
    expect(await l.held()).toEqual({ [P()]: { tokens: 1000, steps: 10, agents: 2 } });
    expect(await l.run()).toEqual({ tokens: [0, 1000], steps: [0, 10], agents: [0, 2] });
    expect(await l.j.command(RUN, P())).toMatchObject({ kind: "program", state: "dispatched" });
    expect(await l.events("program_admitted")).toHaveLength(1);
  });

  it("refuses a sub-program the run has no room for, and writes nothing of it", async () => {
    const l = await ledger({ ...LIMITS, tokens: 1500 });
    await l.admit(1, BUDGET);
    await expect(l.admit(2, BUDGET)).rejects.toMatchObject({ tag: "BudgetExceeded", args: [{ dimension: "tokens", requested: 1000, available: 500 }] });
    expect(Object.keys(await l.held())).toEqual([P(1)]);
    expect(await l.j.command(RUN, P(2))).toBeUndefined();
    expect(await l.events("program_admitted")).toHaveLength(1);
  });

  it("admits a step's sub-program once: asked again, it answers with the first admission and reserves nothing more", async () => {
    const l = await ledger(LIMITS);
    const first = await l.admit(1, BUDGET);
    let stored = 0;
    const again = await l.j.admitProgram(RUN, l.fence, { ...first, hash: "sha256:other" }, BUDGET, "digest:1", async () => void stored++);
    expect(again).toEqual(first);
    expect(stored).toBe(0);
    expect(await l.run()).toEqual({ tokens: [0, 1000], steps: [0, 10], agents: [0, 2] });
    expect(await l.events("program_admitted")).toHaveLength(1);
  });
});

describe("a command inside a sub-program", () => {
  it("takes its share out of the program's reservation: the run holds no more than before", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    expect(await l.held()).toEqual({ [P()]: { tokens: 600, steps: 6, agents: 1 }, [D(0)]: { tokens: 400, steps: 4, agents: 1 } });
    expect(await l.run()).toEqual({ tokens: [0, 1000], steps: [0, 10], agents: [0, 2] });
  });

  it("gives back what it did not spend; an attempt is spent once it is sent", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await l.done(D(0), { tokens: 150, steps: 2 });
    expect(await l.held()).toEqual({ [P()]: { tokens: 850, steps: 8, agents: 1 } });
    expect(await l.run()).toEqual({ tokens: [150, 850], steps: [2, 8], agents: [1, 1] });
  });

  it("N02: is refused a share the program has not left, though the run has plenty, and holds nothing", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), { tokens: 700, steps: 4, agents: 1 } as Cost, { inside: P() });
    await expect(l.send(D(1), SHARE, { inside: P() })).rejects.toMatchObject({ tag: "BudgetExceeded", args: [{ dimension: "tokens", requested: 400, available: 300, program: P() }] });
    expect(await l.held()).toEqual({ [P()]: { tokens: 300, steps: 6, agents: 1 }, [D(0)]: { tokens: 700, steps: 4, agents: 1 } });
    expect(await l.j.command(RUN, D(1))).toBeUndefined();
    // The last agent of a sub-program cannot be taken twice either.
    await l.send(D(2), { tokens: 100, steps: 1, agents: 1 } as Cost, { inside: P() });
    await expect(l.send(D(3), { tokens: 100, steps: 1, agents: 1 } as Cost, { inside: P() })).rejects.toMatchObject({ tag: "BudgetExceeded", args: [{ dimension: "agents", requested: 1, available: 0, program: P() }] });
  });

  it("takes a dimension the program does not hold from the run", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, { tokens: 1000 });
    await l.send(D(0), { tokens: 400, steps: 4 }, { inside: P() });
    expect(await l.held()).toEqual({ [P()]: { tokens: 600 }, [D(0)]: { tokens: 400, steps: 4 } });
    expect(await l.run()).toMatchObject({ tokens: [0, 1000], steps: [0, 4] });
    await expect(l.send(D(1), { tokens: 100, steps: 47 }, { inside: P() })).rejects.toMatchObject({ tag: "BudgetExceeded", args: [{ dimension: "steps", requested: 47, available: 46 }] });
    await l.done(D(0), { tokens: 100, steps: 3 });
    expect(await l.held()).toEqual({ [P()]: { tokens: 900 } });
    expect(await l.run()).toMatchObject({ tokens: [100, 900], steps: [3, 0] });
  });

  it("gives its share back when it is throttled, and takes one again when it is sent again", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await l.j.throttle(RUN, l.fence, D(0), { $tag: "Throttled", $args: [] });
    expect(await l.held()).toEqual({ [P()]: { tokens: 1000, steps: 10, agents: 2 } });
    await l.send(D(0), SHARE, { inside: P() });
    expect(await l.held()).toEqual({ [P()]: { tokens: 600, steps: 6, agents: 1 }, [D(0)]: { tokens: 400, steps: 4, agents: 1 } });
  });

  it("holds one share, not two, when a new worker sends it again after a crash", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    l.fence = (await l.j.acquire(RUN)).fence;
    await l.send(D(0), SHARE, { inside: P() });
    expect(await l.held()).toEqual({ [P()]: { tokens: 600, steps: 6, agents: 1 }, [D(0)]: { tokens: 400, steps: 4, agents: 1 } });
    expect(await l.run()).toEqual({ tokens: [0, 1000], steps: [0, 10], agents: [0, 2] });
  });

  it("keeps its share while its cost is not known, and gives the rest back when the charge arrives", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await l.done(D(0), "unknown");
    expect(await l.held()).toEqual({ [P()]: { tokens: 600, steps: 6, agents: 1 }, [D(0)]: { tokens: 400, steps: 4, agents: 1 } });
    await l.j.settleCharge(RUN, D(0), { tokens: 250, steps: 1 });
    expect(await l.held()).toEqual({ [P()]: { tokens: 750, steps: 9, agents: 1 } });
    expect(await l.run()).toEqual({ tokens: [250, 750], steps: [1, 9], agents: [1, 1] });
  });

  it("that spent more than its share takes the rest out of the program's reservation", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await l.done(D(0), { tokens: 500, steps: 4 });
    expect(await l.held()).toEqual({ [P()]: { tokens: 500, steps: 6, agents: 1 } });
    expect(await l.run()).toEqual({ tokens: [500, 500], steps: [4, 6], agents: [1, 1] });
  });
});

describe("a step of a delegation inside a sub-program", () => {
  const STEP = (i: number): string => `${D(0)}/step/${i}`;

  it("is paid from its delegation's share, and reserves nothing of its own", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await l.send(STEP(0), { tokens: 100, steps: 1 }, { within: D(0), inside: P() });
    expect(await l.held()).toEqual({ [P()]: { tokens: 600, steps: 6, agents: 1 }, [D(0)]: { tokens: 400, steps: 4, agents: 1 } });
    await l.done(STEP(0), { tokens: 80, steps: 1 }, D(0));
    expect(await l.held()).toEqual({ [P()]: { tokens: 600, steps: 6, agents: 1 }, [D(0)]: { tokens: 320, steps: 3, agents: 1 } });
    expect(await l.run()).toEqual({ tokens: [80, 920], steps: [1, 9], agents: [0, 2] });
    // The delegation ends: what its steps left goes back to the program, and its agent is spent.
    await l.done(D(0), {});
    expect(await l.held()).toEqual({ [P()]: { tokens: 920, steps: 9, agents: 1 } });
    expect(await l.run()).toEqual({ tokens: [80, 920], steps: [1, 9], agents: [1, 1] });
  });

  it("is refused what its delegation has not left, as a step limit and not as the program's budget", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await expect(l.send(STEP(0), { tokens: 401, steps: 1 }, { within: D(0), inside: P() })).rejects.toMatchObject({ tag: "SkillFailed", args: [{ kind: "StepLimit" }] });
  });

  it("that spent more than its delegation had left takes the rest out of the program's reservation", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await l.send(STEP(0), { tokens: 300, steps: 1 }, { within: D(0), inside: P() });
    await l.done(STEP(0), { tokens: 580, steps: 1 }, D(0));
    // 400 came out of the delegation's share and 180 out of the program's: together they still hold 1000 of the run.
    expect(await l.held()).toEqual({ [P()]: { tokens: 420, steps: 6, agents: 1 }, [D(0)]: { tokens: 0, steps: 3, agents: 1 } });
    expect(await l.run()).toEqual({ tokens: [580, 420], steps: [1, 9], agents: [0, 2] });
  });

  it("outside a sub-program is paid as it always was", async () => {
    const l = await ledger(LIMITS);
    const top = "/defs/W/body/1/value";
    await l.send(top, { tokens: 400, steps: 4 });
    await l.send(`${top}/step/0`, { tokens: 300, steps: 1 }, { within: top });
    await l.done(`${top}/step/0`, { tokens: 580, steps: 1 }, top);
    expect(await l.held()).toEqual({ [top]: { tokens: 0, steps: 3 } });
    expect(await l.run()).toEqual({ tokens: [580, 0], steps: [1, 3], agents: [0, 0] });
  });
});

describe("a sub-program's end", () => {
  it("releases what is left of its reservation, once", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await l.done(D(0), { tokens: 150, steps: 2 });
    await l.j.closeProgram(RUN, l.fence, P(), { ok: "done" });
    expect(await l.held()).toEqual({});
    expect(await l.run()).toEqual({ tokens: [150, 0], steps: [2, 0], agents: [1, 0] });
    expect(await l.j.command(RUN, P())).toMatchObject({ state: "succeeded", result: "done" });
    // A program that has ended stays as it ended.
    await l.j.closeProgram(RUN, l.fence, P(), { error: { tag: "SkillFailed", args: [] } });
    expect(await l.j.command(RUN, P())).toMatchObject({ state: "succeeded", result: "done" });
    expect(await l.events("command_completed")).toHaveLength(2);
  });

  it("records a fault as the program's outcome", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.j.closeProgram(RUN, l.fence, P(), { error: { tag: "Rejected", args: ["over_limit"] } });
    expect(await l.j.command(RUN, P())).toMatchObject({ state: "failed", error: { tag: "Rejected", args: ["over_limit"] } });
    expect(await l.held()).toEqual({});
  });

  it("leaves a charge that arrives after it to the run", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await l.done(D(0), "unknown");
    await l.j.closeProgram(RUN, l.fence, P(), { ok: null });
    await l.j.settleCharge(RUN, D(0), { tokens: 250, steps: 1 });
    expect(await l.held()).toEqual({});
    expect(await l.run()).toEqual({ tokens: [250, 0], steps: [1, 0], agents: [1, 0] });
  });

  it("is refused for what is no sub-program", async () => {
    const l = await ledger(LIMITS);
    await l.send("/defs/W/body/1/value", { tokens: 10 });
    await expect(l.j.closeProgram(RUN, l.fence, "/defs/W/body/1/value", { ok: null })).rejects.toMatchObject({ code: "not_dispatched" });
  });
});

describe("what a lead's own steps cost", () => {
  it("does not count the commands of its sub-programs, which run below its delegation", async () => {
    const l = await ledger(LIMITS);
    await l.send(PLAN, { tokens: 2000, steps: 20, agents: 1 } as Cost);
    await l.send(`${PLAN}/step/0`, { tokens: 100, steps: 1 }, { within: PLAN });
    await l.done(`${PLAN}/step/0`, { tokens: 90, steps: 1 }, PLAN);
    await l.admit(1, BUDGET);
    await l.send(D(0), SHARE, { inside: P() });
    await l.done(D(0), { tokens: 150, steps: 2 });
    expect(await l.j.childCost(RUN, PLAN)).toEqual({ tokens: 90, steps: 1 });
    expect(await l.j.childCost(RUN, P())).toEqual({ tokens: 150, steps: 2 });
  });

  it("lists a plan's admissions in the order they were admitted", async () => {
    const l = await ledger(LIMITS);
    await l.admit(1, BUDGET);
    await l.admit(2, BUDGET);
    expect((await l.j.admissions(RUN, PLAN)).map((a) => [a.number, a.command])).toEqual([[1, P(1)], [2, P(2)]]);
    expect(await l.j.admissions(RUN, "/defs/W/body/5/value")).toEqual([]);
  });
});
