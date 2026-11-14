// `map` at run time (0.4; spec/envelope.md "map"; cases R11, R12, N03, N08).
// The body runs once for each element, at most `par` at a time, and the
// results come in the order of the list. A fault in one item is that item's
// outcome. Before any item is dispatched the list is held to its bound, each
// item's `with caps` is evaluated and held to the context, and with
// `par > 1` no two items may write overlapping scopes. Each rule is shown by
// one run that keeps it and one that breaks it.

import { check, kindOf, loadModules, type Modules } from "@mandate/bridge";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { DelegateRequest, Outcome } from "../src/adapters.js";
import { payloadOf, shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { Crash } from "../src/signals.js";
import { deferred, SimAgents } from "../src/sim.js";
import type { Obj, Value } from "../src/values.js";
import { closeAll, commandIds, until, world, type World } from "./helpers.js";

afterAll(closeAll);

// ── the program ─────────────────────────────────────────────────────────

/**
 * A 0.4 workflow whose envelope lets it read and write below /work/repos. A repository says where it is checked
 * out below that, as a `Path`, which is relative. A test gives the workflow its body, and where it matters the
 * envelope's tokens and agents, its `spawn` line and what the workflow returns.
 */
const program = (o: { body: string; returns?: string; tokens?: string; agents?: number; spawn?: string }): string => `mandate @ 0.4

module test.map @ 0.1

use std.{fs, model}

role platform_lead "Platform lead"

type Repo = { name: Text, root: Path, src: Path }

capability RepoRead = fs.read("/work/repos")
capability SrcWrite = fs.write("/work/repos")
capability ModelStd = model.infer(tier: standard)

agent Migrator {
  role   "Moves one repository."
  caps   RepoRead, SrcWrite, ModelStd
  budget { tokens: 1k, steps: 5 }
  skill migrate(repo: Repo) -> Inferred<Text> ! {Fs.Read, Fs.Write, Model}
}

agent Reader {
  role   "Reads one repository."
  caps   RepoRead, ModelStd
  budget { tokens: 1k, steps: 5 }
  skill look(repo: Repo) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow W(repos: List<Repo>) -> ${o.returns ?? "List<Outcome<Inferred<Text>>>"}
  envelope {
    owner   platform_lead
    caps    RepoRead, SrcWrite, ModelStd
    budget  { tokens: ${o.tokens ?? "100k"}, steps: 400, agents: ${o.agents ?? 40} }${o.spawn ? `\n    spawn   ${o.spawn}` : ""}
  }
{
${o.body}
}
`;

const BY_ROOT = "with caps SrcWrite.narrow(repo.root)";
const MIGRATE = "    delegate Migrator.migrate(repo)\n  }";
/** `map repo in repos <options> { delegate Migrator.migrate(repo) }`, as the workflow's whole body. */
const mapped = (options: string): string => `  map repo in repos ${options} {\n${MIGRATE}`;

const MAP = "/defs/W/body/0/value";
const item = (i: number): string => `${MAP}[${i}]/body/0/value`;

const repo = (name: string, root = name): Obj => ({ name, root, src: `${root}/src` });
const repos = (...names: string[]): Obj[] => names.map((n) => repo(n));
const named = (req: DelegateRequest): string => String((req.args[0] as Obj)["name"]);

// ── the people ──────────────────────────────────────────────────────────

/** The program on a runtime where Alice, the platform lead, has approved its envelope. Carol holds no role. */
async function approved(src: string, o: Parameters<typeof world>[1] = {}): Promise<World & { carol: EvidenceSigner }> {
  const alice = EvidenceSigner.generate();
  const carol = EvidenceSigner.generate();
  const lock = { modules: {}, ...(o.lock ?? {}), members: { alice: { keys: [alice.keyId] }, carol: { keys: [carol.keyId] } }, roles: { platform_lead: ["alice"] } };
  const w = await world(src, { ...o, lock, decisions: { keys: new TrustedKeys([alice.publicKey, carol.publicKey]) } });
  await w.rt.approveEnvelope(w.pkg, signDecision(alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) }));
  return { ...w, carol };
}

const run = (w: World, runId: string, list: Obj[], o: Partial<Parameters<World["rt"]["startRun"]>[0]> = {}): Promise<RunRow> =>
  w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { repos: list }, runId, ...o });

const events = async (w: World, runId: string, type: string): Promise<Obj[]> => (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data as Obj);

const ok = (v: Value): Value => ({ $tag: "Ok", $args: [v] });
const failed = (tag: string, ...args: Value[]): Value => ({ $tag: "Failed", $args: [{ $tag: tag, $args: args }] });
const done = (req: DelegateRequest): Outcome => ({ ok: `moved ${named(req)}`, cost: { steps: 1 } });
const noLuck = (): Outcome => ({ error: { tag: "SkillFailed", args: ["no luck"] }, cost: { steps: 1 } });

/** What must be true of a run that was refused before any item was dispatched. */
async function nothingRan(w: World, runId: string): Promise<void> {
  expect(w.agents.count()).toBe(0);
  expect(await commandIds(w, runId, "delegate")).toEqual([]);
  expect(await events(w, runId, "map_started")).toEqual([]);
}

/**
 * An agent that stays in flight until `most` are, or until the last of `total` has come, so that the highest
 * number in flight does not depend on how fast the machine is. The pause after that lets one too many show.
 */
function crowd(most: number, total: number) {
  let inFlight = 0;
  let arrived = 0;
  let peak = 0;
  const full: Array<() => void> = [];
  const script = async (req: DelegateRequest): Promise<Outcome> => {
    inFlight++;
    arrived++;
    peak = Math.max(peak, inFlight);
    if (inFlight < most && arrived < total) await new Promise<void>((r) => full.push(r));
    for (const r of full.splice(0)) r();
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    return done(req);
  };
  return { script, peak: () => peak };
}

// ── R11, R12 ────────────────────────────────────────────────────────────

describe("map: the body once for each element", () => {
  it("R11: gives the results in the order of the list, whatever order the items finish in", async () => {
    const gates = new Map(["a", "b", "c"].map((n) => [n, deferred<void>()]));
    const finished: string[] = [];
    const agents = new SimAgents().on("Migrator.migrate", async (req) => {
      await gates.get(named(req))!.promise;
      finished.push(named(req));
      return done(req);
    });
    const w = await approved(program({ body: mapped(`max 3 par 3 ${BY_ROOT}`) }), { agents });
    const p = run(w, "r11", repos("a", "b", "c"));
    await until(() => w.agents.count() === 3, "all three items in flight");
    // The last item finishes first, the first one last.
    for (const n of ["c", "b", "a"]) {
      gates.get(n)!.resolve();
      await until(() => finished.includes(n), `${n} finished`);
    }
    const r = await p;
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(finished).toEqual(["c", "b", "a"]);
    expect(r.result).toEqual([ok("moved a"), ok("moved b"), ok("moved c")]);
  });

  it("runs item i under <map>[i]: its commands are <map>[i]/body/…", async () => {
    const w = await approved(program({ body: mapped(`max 3 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    expect((await run(w, "ids", repos("a", "b", "c"))).state).toBe("succeeded");
    expect(await commandIds(w, "ids", "delegate")).toEqual([item(0), item(1), item(2)]);
    expect(w.agents.calls.map((c) => [c.commandId, named(c)])).toEqual([[item(0), "a"], [item(1), "b"], [item(2), "c"]]);
  });

  it("records that it started, once, with the number of items and its par", async () => {
    const w = await approved(program({ body: mapped(`max 3 par 2 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    expect((await run(w, "started", repos("a", "b", "c"))).state).toBe("succeeded");
    expect(await events(w, "started", "map_started")).toEqual([{ map: MAP, items: 3, par: 2 }]);
    // Without `par` the items run one at a time.
    const one = await approved(program({ body: mapped(`max 3 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    expect((await run(one, "started-1", repos("a"))).state).toBe("succeeded");
    expect(await events(one, "started-1", "map_started")).toEqual([{ map: MAP, items: 1, par: 1 }]);
  });

  it("gives an empty list for an empty list", async () => {
    const w = await approved(program({ body: mapped(`max 3 par 2 ${BY_ROOT}`) }));
    const r = await run(w, "empty", []);
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(r.result).toEqual([]);
    expect(await events(w, "empty", "map_started")).toEqual([{ map: MAP, items: 0, par: 2 }]);
    expect(await events(w, "empty", "map_ended")).toEqual([{ map: MAP, outcomes: [] }]);
  });

  it.each([
    ["no par", "", 1],
    ["par 2", "par 2 ", 2],
    ["par 5", "par 5 ", 5],
  ])("with %s, at most %s items run at once", async (_what, par, most) => {
    const c = crowd(most as number, 5);
    const w = await approved(program({ body: mapped(`max 5 ${par}${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", c.script) });
    const r = await run(w, `par-${most}`, repos("a", "b", "c", "d", "e"));
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(c.peak()).toBe(most);
    expect(r.result).toEqual(["a", "b", "c", "d", "e"].map((n) => ok(`moved ${n}`)));
  });

  it("holds the delegations of its items to the envelope's max_concurrent, like any other", async () => {
    // Each item delegates twice, side by side: par 2 would put four delegations in flight, and the envelope allows three.
    const body = `  map repo in repos max 4 par 2 ${BY_ROOT} {\n    par {\n      seen  = delegate Reader.look(repo)\n      moved = delegate Migrator.migrate(repo)\n    }\n    moved\n  }`;
    const c = crowd(3, 8);
    const agents = new SimAgents().on("Migrator.migrate", c.script).on("Reader.look", c.script);
    const w = await approved(program({ body, spawn: "{ max_concurrent: 3 }" }), { agents });
    const r = await run(w, "mc", repos("a", "b", "c", "d"));
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(w.agents.count()).toBe(8);
    expect(c.peak()).toBe(3);
  });

  it("R12: a failed item is that item's outcome, and the others go on", async () => {
    const agents = new SimAgents().on("Migrator.migrate", (req) => (named(req) === "b" ? noLuck() : done(req)));
    const w = await approved(program({ body: mapped(`max 3 ${BY_ROOT}`) }), { agents });
    const r = await run(w, "r12", repos("a", "b", "c"));
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(r.result).toEqual([ok("moved a"), failed("SkillFailed", "no luck"), ok("moved c")]);
    expect(w.agents.count()).toBe(3);
    // How it ended is recorded for the run's views: each item's outcome by input index, `Ok` or its fault.
    expect(await events(w, "r12", "map_ended")).toEqual([{ map: MAP, outcomes: ["Ok", "SkillFailed", "Ok"] }]);
  });

  it("lets the program tell an item that failed from one that did not", async () => {
    const body = `  let moved = map repo in repos max 3 ${BY_ROOT} {\n${MIGRATE}\n  map o in moved max 3 {\n    switch o {\n      Ok(text)  => peek(text)\n      Failed(f) => "failed"\n    }\n  }`;
    const agents = new SimAgents().on("Migrator.migrate", (req) => (named(req) === "b" ? noLuck() : done(req)));
    const w = await approved(program({ body, returns: "List<Outcome<Text>>" }), { agents });
    const r = await run(w, "tell", repos("a", "b", "c"));
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(r.result).toEqual([ok("moved a"), ok("failed"), ok("moved c")]);
    // The second map delegates nothing: its three items are no agents.
    expect((await w.rt.journal.budget("tell"))["agents"]).toMatchObject({ settled: 3, reserved: 0 });
  });

  it("counts each item's delegation as one of the envelope's agents", async () => {
    const w = await approved(program({ body: mapped(`max 4 par 2 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    expect((await run(w, "agents", repos("a", "b", "c", "d"))).state).toBe("succeeded");
    expect((await w.rt.journal.budget("agents"))["agents"]).toEqual({ limit: 40, settled: 4, reserved: 0 });
  });
});

// ── fail_fast ───────────────────────────────────────────────────────────

describe("map under supervise fail_fast", () => {
  it("stops the items not yet started at the first fault, waits for those in flight, and fails with that fault", async () => {
    const gate = deferred<void>();
    const agents = new SimAgents().on("Migrator.migrate", async (req) => {
      if (named(req) === "b") return noLuck();
      await gate.promise;
      return done(req);
    });
    const w = await approved(program({ body: mapped(`max 4 par 2 supervise fail_fast ${BY_ROOT}`) }), { agents });
    const p = run(w, "ff", repos("a", "b", "c", "d"));
    // b has failed while a is still in flight: c and d must not start.
    await until(() => w.agents.count() === 2, "a and b sent");
    await new Promise((r) => setTimeout(r, 30));
    expect(w.agents.count()).toBe(2);
    gate.resolve();
    const r = await p;
    expect(r.state).toBe("failed");
    expect(r.error).toEqual({ $tag: "SkillFailed", $args: ["no luck"] });
    // a was waited for: its result is recorded, and its agent is spent.
    expect(await w.db.query("select command_id, state from commands where kind = 'delegate' order by command_id")).toEqual([
      { command_id: item(0), state: "succeeded" },
      { command_id: item(1), state: "failed" },
    ]);
    // The map is recorded as failed, with the fault that failed it. The items it did not start have no outcome.
    expect(await events(w, "ff", "map_ended")).toEqual([{ map: MAP, outcomes: ["Ok", "SkillFailed", null, null], failed: "SkillFailed" }]);
  });

  it("fails with the fault of the first failed item in the list, not of the one that failed first", async () => {
    const gate = deferred<void>();
    const agents = new SimAgents().on("Migrator.migrate", async (req) => {
      if (named(req) === "b") return { error: { tag: "SkillFailed", args: ["b first"] }, cost: { steps: 1 } };
      await gate.promise;
      return { error: { tag: "Timeout", args: [] }, cost: { steps: 1 } };
    });
    const w = await approved(program({ body: mapped(`max 2 par 2 supervise fail_fast ${BY_ROOT}`) }), { agents });
    const p = run(w, "ff-order", repos("a", "b"));
    await until(() => w.agents.count() === 2, "both sent");
    await new Promise((r) => setTimeout(r, 30));
    gate.resolve();
    const r = await p;
    expect(r.state).toBe("failed");
    expect(r.error).toEqual({ $tag: "Timeout" });
    // A replay, in which every item ends at once, decides the same.
    expect(await w.rt.replayRun("ff-order")).toEqual({ status: "failed", error: { $tag: "Timeout" } });
  });

  it("without it, the program handles nothing: every item ran", async () => {
    const agents = new SimAgents().on("Migrator.migrate", noLuck);
    const w = await approved(program({ body: mapped(`max 3 par 2 ${BY_ROOT}`) }), { agents });
    const r = await run(w, "no-ff", repos("a", "b", "c"));
    expect(r.state).toBe("succeeded");
    expect(r.result).toEqual([failed("SkillFailed", "no luck"), failed("SkillFailed", "no luck"), failed("SkillFailed", "no luck")]);
  });
});

// ── N08 ─────────────────────────────────────────────────────────────────

describe("N08: a list longer than the map's bound is refused before any item is dispatched", () => {
  it("refuses a list longer than max (Rejected over_limit), and runs one that is exactly max", async () => {
    const w = await approved(program({ body: mapped(`max 3 par 2 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    const r = await run(w, "n8", repos("a", "b", "c", "d"));
    expect(r.state).toBe("failed");
    expect(r.error).toEqual({ $tag: "Rejected", $args: ["over_limit", { map: MAP, items: 4, max: 3 }] });
    await nothingRan(w, "n8");
    expect((await run(w, "n8-fits", repos("a", "b", "c"))).state).toBe("succeeded");
  });

  it("without max, the bound is the envelope's agents", async () => {
    const w = await approved(program({ body: mapped(BY_ROOT), agents: 2 }), { agents: new SimAgents().on("Migrator.migrate", done) });
    const r = await run(w, "n8-agents", repos("a", "b", "c"));
    expect(r.state).toBe("failed");
    expect(r.error).toEqual({ $tag: "Rejected", $args: ["over_limit", { map: MAP, items: 3, max: 2 }] });
    await nothingRan(w, "n8-agents");
    expect((await run(w, "n8-agents-fits", repos("a", "b"))).state).toBe("succeeded");
  });

  it("is a fault the program can handle", async () => {
    const body = `  let moved = map repo in repos max 1 ${BY_ROOT} {\n${MIGRATE}\n  on error(Rejected(why, detail)) => map repo in repos max 9 {\n    "left"\n  }\n  moved`;
    const w = await approved(program({ body, returns: "List<Outcome<Inferred<Text>>>" }), { agents: new SimAgents().on("Migrator.migrate", done) });
    const r = await run(w, "n8-handled", repos("a", "b"));
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(r.result).toEqual([ok("left"), ok("left")]);
    expect(w.agents.count()).toBe(0);
  });
});

// ── with caps, N03 ──────────────────────────────────────────────────────

describe("map with caps: what each item is handed", () => {
  const write = (c: DelegateRequest): string[] | undefined => c.caps.find((x) => x.ctor === "fs.write")?.scope;
  const read = (c: DelegateRequest): string[] | undefined => c.caps.find((x) => x.ctor === "fs.read")?.scope;

  it("hands each item's delegation the scope its element names, in place of what the agent holds of that kind", async () => {
    const w = await approved(program({ body: mapped(`max 2 par 2 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    expect((await run(w, "caps", repos("a", "b"))).state).toBe("succeeded");
    const calls = [...w.agents.calls].sort((x, y) => (named(x) < named(y) ? -1 : 1));
    expect(calls.map((c) => [named(c), write(c), read(c)])).toEqual([
      ["a", ["/work/repos/a"], ["/work/repos"]],
      ["b", ["/work/repos/b"], ["/work/repos"]],
    ]);
  });

  it("hands a kind only to an agent that holds it: a reader gets no write scope", async () => {
    const body = `  map repo in repos max 2 ${BY_ROOT} {\n    delegate Reader.look(repo)\n  }`;
    const w = await approved(program({ body }), { agents: new SimAgents() });
    expect((await run(w, "caps-reader", repos("a"))).state).toBe("succeeded");
    expect(w.agents.calls.map((c) => [write(c), read(c)])).toEqual([[undefined, ["/work/repos"]]]);
  });

  it("without with caps, the delegation is granted what its agent holds inside the envelope", async () => {
    const w = await approved(program({ body: mapped("max 2") }), { agents: new SimAgents().on("Migrator.migrate", done) });
    expect((await run(w, "caps-none", repos("a"))).state).toBe("succeeded");
    expect(w.agents.calls.map(write)).toEqual([["/work/repos"]]);
  });

  it("reads a relative path below the capability it narrows, and a text that names a place the same way", async () => {
    const w = await approved(program({ body: mapped("max 2 with caps SrcWrite.narrow(repo.name)") }), { agents: new SimAgents().on("Migrator.migrate", done) });
    expect((await run(w, "caps-text", [repo("a"), repo("/work/repos/b", "b")])).state).toBe("succeeded");
    expect(w.agents.calls.map(write)).toEqual([["/work/repos/a"], ["/work/repos/b"]]);
  });

  it("refuses the map when an element names a scope outside the capability it narrows (PolicyDenied), before any item", async () => {
    // A `Path` cannot leave the capability it is read below. A text can name any place, so the map narrows by the name here.
    const w = await approved(program({ body: mapped("max 3 with caps SrcWrite.narrow(repo.name)") }), { agents: new SimAgents().on("Migrator.migrate", done) });
    const r = await run(w, "caps-outside", [repo("a"), repo("/etc", "etc")]);
    expect(r.state).toBe("failed");
    expect(r.error).toEqual({ $tag: "PolicyDenied", $args: [{ reason: "outside_capability", capability: 'SrcWrite = fs.write("/work/repos")', requested: ["/etc"] }] });
    await nothingRan(w, "caps-outside");
    // A name that climbs out of the capability is outside it too, and so is one that only begins like it. One that
    // a host may read another way than `/` by `/` (a backslash, a drive) is inside nothing.
    for (const [id, name, requested] of [
      ["caps-dots", "../secrets", "/work/repos/../secrets"],
      ["caps-prefix", "/work/repos-old", "/work/repos-old"],
      ["caps-backslash", "a\\..\\..\\secrets", "a\\..\\..\\secrets"],
      ["caps-drive", "C:/work/repos/a", "C:/work/repos/a"],
    ] as const) {
      const out = await run(w, id, [repo(name, "x")]);
      expect(out.state).toBe("failed");
      expect(out.error).toEqual({ $tag: "PolicyDenied", $args: [{ reason: "outside_capability", capability: 'SrcWrite = fs.write("/work/repos")', requested: [requested] }] });
      await nothingRan(w, id);
    }
  });

  it("lets a delegation of the body narrow further inside what its item was handed", async () => {
    const body = `  map repo in repos max 2 par 2 ${BY_ROOT} {\n    delegate Migrator.migrate(repo) with caps SrcWrite.narrow(repo.src)\n  }`;
    const w = await approved(program({ body }), { agents: new SimAgents().on("Migrator.migrate", done) });
    expect((await run(w, "caps-own", repos("a", "b"))).state).toBe("succeeded");
    expect(w.agents.calls.map(write).sort()).toEqual([["/work/repos/a/src"], ["/work/repos/b/src"]]);
  });

  it("refuses a delegation that names a scope outside what its item was handed: that item fails, and is not sent", async () => {
    const body = `  map repo in repos max 2 ${BY_ROOT} {\n    delegate Migrator.migrate(repo) with caps SrcWrite.narrow(repo.src)\n  }`;
    const w = await approved(program({ body }), { agents: new SimAgents().on("Migrator.migrate", done) });
    // b's src is inside the envelope's write scope, and outside b's own root: it is a's.
    const r = await run(w, "caps-own-outside", [repo("a"), { name: "b", root: "b", src: "a/src" }]);
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(r.result).toEqual([ok("moved a"), failed("PolicyDenied", { reason: "outside_authority", delegate: "Migrator", capability: "SrcWrite.narrow = fs.write(\"/work/repos/a/src\")" })]);
    expect(w.agents.calls.map(named)).toEqual(["a"]);
  });

  it("holds a map inside a map to what the outer item was handed: a scope outside it is refused before any inner item", async () => {
    const body = `  map repo in repos max 2 ${BY_ROOT} {\n    map inner in repos max 2 with caps SrcWrite.narrow(inner.root) {\n      delegate Migrator.migrate(inner)\n    }\n  }`;
    const w = await approved(program({ body, returns: "List<Outcome<List<Outcome<Inferred<Text>>>>>" }), { agents: new SimAgents().on("Migrator.migrate", done) });
    // One repository: the inner item's scope is the outer item's.
    const one = await run(w, "nested-one", repos("a"));
    expect(one.state, JSON.stringify(one.error ?? one.attention)).toBe("succeeded");
    expect(one.result).toEqual([ok([ok("moved a")])]);
    expect(w.agents.calls.map(write)).toEqual([["/work/repos/a"]]);
    // Two: inside a's item the inner map would hand b's root, and inside b's item a's.
    const two = await run(w, "nested-two", repos("a", "b"));
    expect(two.state, JSON.stringify(two.error ?? two.attention)).toBe("succeeded");
    const refused = (outer: number, i: number, root: string): Value =>
      failed("PolicyDenied", { reason: "outside_authority", map: `${MAP}[${outer}]/body/0/value`, item: i, capability: `SrcWrite.narrow = fs.write("/work/repos/${root}")` });
    expect(two.result).toEqual([refused(0, 1, "b"), refused(1, 0, "a")]);
    expect(w.agents.count()).toBe(1);
  });

  it("holds a scope chosen at run time to the capability it narrows outside a map too", async () => {
    const body = '  let first = delegate Migrator.migrate(one) with caps SrcWrite.narrow(one.name)\n  map repo in repos max 1 {\n    "seen"\n  }';
    const src = program({ body, returns: "List<Outcome<Text>>" }).replace("workflow W(repos: List<Repo>)", "workflow W(repos: List<Repo>, one: Repo)");
    const w = await approved(src, { agents: new SimAgents().on("Migrator.migrate", done) });
    const start = (id: string, one: Obj) => w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { repos: [], one }, runId: id });
    expect((await start("late", repo("a"))).state).toBe("succeeded");
    expect(w.agents.calls.map(write)).toEqual([["/work/repos/a"]]);
    const out = await start("late-outside", repo("/etc", "etc"));
    expect(out.state).toBe("failed");
    expect(out.error).toMatchObject({ $tag: "PolicyDenied", $args: [{ reason: "outside_capability", requested: ["/etc"] }] });
    expect(w.agents.count()).toBe(1);
  });
});

describe("N03: with par > 1, no two items may write overlapping scopes", () => {
  const SAME = [repo("a"), repo("twin", "a")];
  const NESTED = [repo("a"), repo("inner", "a/vendor/inner")];

  it.each([
    ["the same scope", SAME, 'SrcWrite.narrow = fs.write("/work/repos/a")', 'SrcWrite.narrow = fs.write("/work/repos/a")'],
    ["a scope inside another's", NESTED, 'SrcWrite.narrow = fs.write("/work/repos/a")', 'SrcWrite.narrow = fs.write("/work/repos/a/vendor/inner")'],
  ])("refuses the map when two items would write %s (Rejected overlapping_scopes), before any item", async (_what, list, left, right) => {
    const w = await approved(program({ body: mapped(`max 3 par 2 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    const r = await run(w, "n3", [repo("z"), ...list]);
    expect(r.state).toBe("failed");
    expect(r.error).toEqual({ $tag: "Rejected", $args: ["overlapping_scopes", { map: MAP, items: [1, 2], left, right }] });
    await nothingRan(w, "n3");
  });

  it("runs items whose scopes are apart, however alike their names", async () => {
    const w = await approved(program({ body: mapped(`max 3 par 3 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    const r = await run(w, "n3-apart", [repo("a"), repo("ab"), repo("a-b")]);
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(w.agents.count()).toBe(3);
  });

  it("one at a time, items may write the same scope in turn", async () => {
    const w = await approved(program({ body: mapped(`max 3 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    const r = await run(w, "n3-turn", SAME);
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(w.agents.count()).toBe(2);
  });
});

// ── the run's budget, a crash, a replay ─────────────────────────────────

describe("map and the run", () => {
  it("leaves the run's BudgetExceeded to the run: it is no item's outcome, and the map goes on once the limit is raised", async () => {
    const spends = (req: DelegateRequest): Outcome => ({ ok: `moved ${named(req)}`, cost: { steps: 1, tokens: 1000 } });
    const w = await approved(program({ body: mapped(`max 3 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", spends) });
    // Each delegation reserves 1k tokens and spends them; the caller lets this run spend two of them.
    const stopped = await run(w, "budget", repos("a", "b", "c"), { limits: { tokens: 2000 } });
    expect(stopped.state).toBe("waiting");
    expect(stopped.waiting).toMatchObject({ kind: "budget_exceeded", detail: { $tag: "BudgetExceeded", $args: [{ dimension: "tokens" }] } });
    expect(w.agents.calls.map(named)).toEqual(["a", "b"]);
    // The run stopped inside the map: the map has not ended, and nothing says it has.
    expect(await events(w, "budget", "map_ended")).toEqual([]);

    const sign = async (kind: "raise_limits" | "answer", about: "run" | "wait", payload: string) =>
      signDecision(w.carol, await w.rt.shown("budget", about), { kind, member: "carol", payload, at: new Date(w.adapters.clock.now()) });
    await w.rt.raiseLimits("budget", { sender: "cli", messageId: "raise" }, { limits: { tokens: 5000 }, signed: await sign("raise_limits", "run", payloadOf.limits({ tokens: 5000 })) });
    const r = await w.rt.submitInput("budget", { sender: "cli", messageId: "go" }, { value: "continue", signed: await sign("answer", "wait", payloadOf.answer("continue")) });
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(r.result).toEqual([ok("moved a"), ok("moved b"), ok("moved c")]);
    // The items that ran are not sent again, and the map started once.
    expect(w.agents.calls.map(named)).toEqual(["a", "b", "c"]);
    expect(await events(w, "budget", "map_started")).toHaveLength(1);
    expect(await events(w, "budget", "map_ended")).toEqual([{ map: MAP, outcomes: ["Ok", "Ok", "Ok"] }]);
  });

  it("resumes after a crash without sending a finished item again", async () => {
    const w = await approved(program({ body: mapped(`max 3 ${BY_ROOT}`) }), { agents: new SimAgents().on("Migrator.migrate", done) });
    w.faults.arm("after_record", (i) => i.id === item(1));
    await expect(run(w, "crash", repos("a", "b", "c"))).rejects.toBeInstanceOf(Crash);
    expect(w.agents.calls.map(named)).toEqual(["a", "b"]);
    const r = await w.rt.resume("crash");
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(r.result).toEqual([ok("moved a"), ok("moved b"), ok("moved c")]);
    expect(w.agents.calls.map(named)).toEqual(["a", "b", "c"]);
    expect(await events(w, "crash", "map_started")).toEqual([{ map: MAP, items: 3, par: 1 }]);
  });

  it("records how it ended once, also when a resumed run comes to the ended map again", async () => {
    // A reader looks at one more repository after the map. The run crashes there, with the map's end recorded.
    const body = `  let moved = map repo in repos max 3 ${BY_ROOT} {\n${MIGRATE}\n  let seen = delegate Reader.look(Repo { name: "z", root: "z", src: "z/src" })\n  moved`;
    const agents = new SimAgents().on("Migrator.migrate", (req) => (named(req) === "b" ? noLuck() : done(req))).on("Reader.look", done);
    const w = await approved(program({ body }), { agents });
    w.faults.arm("after_record", (i) => i.id === "/defs/W/body/1/value");
    await expect(run(w, "again", repos("a", "b", "c"))).rejects.toBeInstanceOf(Crash);
    const ended = [{ map: MAP, outcomes: ["Ok", "SkillFailed", "Ok"] }];
    expect(await events(w, "again", "map_ended")).toEqual(ended);
    const r = await w.rt.resume("again");
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(await events(w, "again", "map_ended")).toEqual(ended);
  });

  it("replays to the same result without calling an agent", async () => {
    const agents = new SimAgents().on("Migrator.migrate", (req) => (named(req) === "b" ? noLuck() : done(req)));
    const w = await approved(program({ body: mapped(`max 3 par 3 ${BY_ROOT}`) }), { agents });
    const r = await run(w, "replay", repos("a", "b", "c"));
    expect(r.state).toBe("succeeded");
    const before = w.agents.count();
    expect(await w.rt.replayRun("replay")).toEqual({ status: "complete", value: r.result });
    expect(w.agents.count()).toBe(before);
    // A replay records nothing: the map started once, and ended once.
    expect(await events(w, "replay", "map_started")).toHaveLength(1);
    expect(await events(w, "replay", "map_ended")).toHaveLength(1);
    // Also where the journal holds no end of the map: a replay does not write one.
    await w.db.query("delete from events where run_id = $1 and type = 'map_ended'", ["replay"]);
    expect(await w.rt.replayRun("replay")).toEqual({ status: "complete", value: r.result });
    expect(await events(w, "replay", "map_ended")).toEqual([]);
  });

  it("stops with the items of a failed branch around it", async () => {
    // The other branch of the par fails while the first item is in flight: the second item is not sent.
    const gate = deferred<void>();
    // The reader fails only once the first item has been sent. The two branches of the par race for which of them
    // reaches its agent first, and a reader that failed before any item was sent would stop a map that sent none.
    const sent = deferred<void>();
    const agents = new SimAgents()
      .on("Migrator.migrate", async (req) => {
        sent.resolve();
        await gate.promise;
        return done(req);
      })
      .on("Reader.look", async () => {
        await sent.promise;
        return noLuck();
      });
    const body = `  par {\n    moved = map repo in repos max 2 ${BY_ROOT} {\n${MIGRATE.replaceAll("\n", "\n  ").replace("    delegate", "      delegate")}\n    seen = delegate Reader.look(repos_first)\n  }\n  moved`;
    const src = program({ body }).replace("workflow W(repos: List<Repo>)", "workflow W(repos: List<Repo>, repos_first: Repo)");
    const w = await approved(src, { agents });
    const p = w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { repos: repos("a", "b"), repos_first: repo("a") }, runId: "sibling" });
    await until(() => w.agents.count("Reader.look") === 1 && w.agents.count("Migrator.migrate") === 1, "the reader failed and the first item is in flight");
    await new Promise((r) => setTimeout(r, 30));
    gate.resolve();
    const r = await p;
    expect(r.state).toBe("failed");
    expect(r.error).toEqual({ $tag: "SkillFailed", $args: ["no luck"] });
    expect(w.agents.count("Migrator.migrate")).toBe(1);
    // The map was stopped, not ended: it has no outcomes to record.
    expect(await events(w, "sibling", "map_ended")).toEqual([]);
  });
});

// ── the first half of the demo ──────────────────────────────────────────

describe("MigrateAll's map: 24 repositories, 24 migrators", () => {
  const here = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
  const DOMAIN = "fixtures/envelope/domain.mdt";

  function modules(): Modules {
    const { modules, problems } = loadModules([{ file: DOMAIN, text: here(DOMAIN), kind: kindOf(DOMAIN) }]);
    expect(problems).toEqual([]);
    return modules;
  }

  it("moves every repository inside its own root, sixteen at a time at most, and hands the lead the outcomes in order", async () => {
    // The fixture's lead plans sub-programs (demo.test.ts runs it whole). Here the lead is delegated to, so that
    // the map is seen on its own, with every agent answered by the delegate adapter.
    const src = here("fixtures/envelope/migrate-all.mdt").replace("plan Lead.finish(repos, done) within envelope", "delegate Lead.finish(repos, done)");
    expect(src).toContain("delegate Lead.finish(repos, done)");
    const mods = modules();
    const domain = check(here(DOMAIN), "mdt").program!;
    const names = Array.from({ length: 24 }, (_, i) => `svc-${String(i + 1).padStart(2, "0")}`);
    const list = names.map((n) => ({ name: n, root: n }));
    const c = crowd(16, 24);
    let handed: Value = null;
    const agents = new SimAgents()
      .on("Migrator.migrate", async (req) => {
        const out = await c.script(req);
        // svc-07 cannot be moved in bulk; the lead is told so.
        if (named(req) === "svc-07") return noLuck();
        return "ok" in out ? { ok: { migrated: [named(req)], left: [], notes: "" }, cost: { steps: 3, tokens: 1000 } } : out;
      })
      .on("Lead.finish", (req) => {
        handed = req.args[1] ?? null;
        return { ok: { migrated: names.filter((n) => n !== "svc-07"), left: ["svc-07"], notes: "one left" }, cost: { steps: 2, tokens: 5000 } };
      });
    const alice = EvidenceSigner.generate();
    const bob = EvidenceSigner.generate();
    const { hashProgram } = await import("@mandate/bridge");
    const lock = {
      modules: { "company.domain": hashProgram(domain as never).program },
      members: { alice: { keys: [alice.keyId] }, bob: { keys: [bob.keyId] } },
      roles: { platform_lead: ["alice"], release_manager: ["bob"] },
    };
    const w = await world(src, { agents, modules: mods, lock, decisions: { keys: new TrustedKeys([alice.publicKey, bob.publicKey]) } });
    await w.rt.approveEnvelope(w.pkg, signDecision(alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) }));

    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "MigrateAll", input: { repos: list }, runId: "demo" });
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(r.result).toEqual({ migrated: names.filter((n) => n !== "svc-07"), left: ["svc-07"], notes: "one left" });

    // 24 migrators and the lead: 25 of the envelope's 200 agents.
    expect(w.agents.count("Migrator.migrate")).toBe(24);
    expect((await w.rt.journal.budget("demo"))["agents"]).toEqual({ limit: 200, settled: 25, reserved: 0 });
    expect(c.peak()).toBe(16);
    expect(await events(w, "demo", "map_started")).toEqual([{ map: "/defs/MigrateAll/body/0/value", items: 24, par: 16 }]);
    // Each migrator writes below its own repository and nowhere else.
    for (const call of w.agents.calls.filter((x) => x.agent === "Migrator")) {
      expect(call.caps.find((x) => x.ctor === "fs.write")?.scope).toEqual([`/work/repos/${named(call)}`]);
    }
    // The lead got one outcome for each repository, in the order of the list.
    const outcomes = handed as unknown as Obj[];
    expect(outcomes).toHaveLength(24);
    expect(outcomes.map((o) => o["$tag"])).toEqual(names.map((n) => (n === "svc-07" ? "Failed" : "Ok")));
    expect(outcomes[0]).toEqual(ok({ migrated: ["svc-01"], left: [], notes: "" }));

    const calls = w.agents.count();
    expect(await w.rt.replayRun("demo")).toEqual({ status: "complete", value: r.result });
    expect(w.agents.count()).toBe(calls);
  });
});
