// A lead's sub-program (spec/envelope.md "The sub-program"): the module the
// runtime starts for it, what it may define (E1705, N09), what it sees of its
// parent, how its workflow stands under the parent's envelope, and whether its
// claim fits what is left (E1706, N01). Each rule is shown refused and in its
// nearest accepted form, and each test names every diagnostic the check gives.

import { describe, expect, it } from "vitest";
import { check, checkSubprogram, load, subprogramLinked, type SubprogramCheck } from "../src/check.js";
import { leadClasses } from "../src/check/static.js";
import { containment, opened, skeleton, subprogramShape, type Room } from "../src/check/subprogram.js";
import { capsOf, showCap } from "../src/check/caps.js";
import type { Diagnostic } from "../src/diag.js";
import { hashProgram } from "../src/hash.js";
import type { Program } from "../src/ir/types.js";
import type { Json } from "../src/json/strict-json.js";
import { link, type Modules } from "../src/modules.js";
import type { PatchOp } from "../src/patch/patch.js";
import type { DataClass } from "../src/std/std.js";

const pairs = (ds: Diagnostic[]): Array<[string, string | undefined]> => ds.map((d) => [d.code, d.at.path]);
const errors = (ds: Diagnostic[]): Diagnostic[] => ds.filter((d) => d.severity === "error");
/** Every error of a check, with its facts. */
const told = (r: { diagnostics: Diagnostic[] }): unknown[] => errors(r.diagnostics).map((d) => [d.code, d.at.path, d.facts]);

/** A module the parent imports a type from. */
const DOMAIN = `mandate @ 0.4

module example.domain @ 0.1

type Ticket = { id: Text, title: Text }
`;

/** The parent: an envelope, a lead that plans, a worker, and a document of a higher class than the envelope's default. */
const parentSource = (spawn = "\n    spawn   { max_concurrent: 4 }", leadArg = "items"): string => `mandate @ 0.4

module example.parent @ 0.1

use std.{exec, fs, git, human, model}
use example.domain.{Ticket}

role owner_role "Owner"
role release    "Release manager"

type Item   = { name: Text }
type Secret = { body: Text } classified confidential

capability M      = model.infer(tier: standard)
capability Public = model.infer(tier: small, max_class: public)
capability High   = model.infer(tier: premium, max_class: confidential)
capability R      = fs.read("/work")
capability W      = fs.write("/work")
capability Merge  = git.pr("company/backend")

agent Worker {
  role   "Fixes one item."
  caps   M, R, W
  budget { tokens: 1000, spend: 1 USD, steps: 5 }
  skill fix(i: Item) -> Inferred<Text> ! {Fs.Read, Fs.Write, Model}
}

agent Lead {
  role   "Plans what is left."
  caps   M, High, R
  budget { tokens: 5000, spend: 2 USD, steps: 20 }
  skill finish(items: List<Item>) -> Inferred<Text> ! {Fs.Read, Model}
  skill study(s: Secret) -> Inferred<Text> ! {Fs.Read, Model}
}

fn label(i: Item) -> Text {
  i.name
}

workflow Run(items: List<Item>, secret: Secret) -> Inferred<Text>
  envelope {
    owner   owner_role
    caps    M, Public, High, R, W, Merge
    budget  { tokens: 100000, time: 1h, spend: 20 USD, steps: 200, agents: 20 }${spawn}
    approve git.merge by release
  }
{
  plan Lead.finish(${leadArg}) within envelope
}
`;

function parsed(src: string): Program {
  const r = load(src, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.program!;
}

const DOMAIN_PROGRAM = parsed(DOMAIN);
const MODULES: Modules = { "example.domain": DOMAIN_PROGRAM };
const PARENT = parsed(parentSource());

it("the parent of these tests passes the checks", () => {
  expect(check(parentSource(), "mdt", { modules: MODULES }).diagnostics).toEqual([]);
});

/** The envelope has all of this left; nothing else of the run is in flight. */
const ROOM: Room = { left: { tokens: 50_000, steps: 100, agents: 10, "spend:USD": 10_000_000 }, time_left_ms: 1_800_000, writes: [] };

/** The definitions of a sub-program, written as text, as the operations a lead would send. */
function ops(defs: string): PatchOp[] {
  const p = parsed(`mandate @ 0.4\n\nmodule example.parent.plan_1 @ 0.1\n\nuse example.parent\n\n${defs}\n`);
  return Object.entries(p.defs).map(([name, d]) => ({ op: "add" as const, path: `/defs/${name}`, value: d }));
}

const BASE = hashProgram(skeleton("example.parent", 1) as unknown as Json).program;

interface Opts {
  parent?: Program;
  room?: Room;
  lead?: DataClass;
  number?: number;
  base?: string;
}

function submit(o: PatchOp[] | string, opts: Opts = {}): SubprogramCheck {
  return checkSubprogram({
    parent: opts.parent ?? PARENT,
    modules: MODULES,
    workflow: "Run",
    number: opts.number ?? 1,
    base: opts.base ?? BASE,
    ops: typeof o === "string" ? ops(o) : o,
    lead: opts.lead ?? "public",
    room: opts.room ?? ROOM,
  });
}

/** A workflow that asks for `caps` and `budget` and hands one item to the worker. */
const FIX = (caps = "M, R, Wa", budget = "{ tokens: 2000, time: 10m, spend: 2 USD, steps: 10, agents: 2 }", body = `delegate Worker.fix(Item { name: "a" }) with caps Wa`): string => `capability Wa = W.narrow("/work/a")

workflow Fix() -> Inferred<Text>
  caps   ${caps}
  budget ${budget}
{
  ${body}
}`;

describe("the skeleton and the patch", () => {
  it("starts a module named after its parent and its number, which sees the parent and defines nothing", () => {
    expect(skeleton("example.parent", 3)).toEqual({ language: "mandate/0.4", module: "example.parent.plan_3", version: "0.1", uses: [{ module: "example.parent" }], defs: {} });
  });

  it("admits a sub-program that fits, with its hash and its workflow", () => {
    const r = submit(FIX());
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.workflow).toBe("Fix");
    // The hash is of what the lead wrote: the skeleton with its definitions, not what the checks open it into.
    expect(r.program!.uses).toEqual([{ module: "example.parent" }]);
    expect(r.hash).toBe(hashProgram(r.program as unknown as Json).program);
    expect(Object.keys(r.program!.defs).sort()).toEqual(["Fix", "Wa"]);
  });

  it("refuses a patch written against another skeleton (stale_base)", () => {
    const other = hashProgram(skeleton("example.parent", 2) as unknown as Json).program;
    const r = submit(FIX(), { base: other });
    expect(pairs(r.diagnostics)).toEqual([["MDT-E0130", ""]]);
    expect(r.diagnostics[0]!.facts).toEqual({ base: other, current: BASE });
    expect(r.ok).toBe(false);
    expect(r.program).toBeUndefined();
    // The same patch is for number 2 when it names that skeleton.
    expect(submit(FIX(), { base: other, number: 2 }).ok).toBe(true);
  });

  it("refuses an operation that does not apply, and a patch that makes no valid IR", () => {
    expect(pairs(submit([{ op: "remove", path: "/defs/Nothing" }]).diagnostics)).toEqual([["MDT-E0131", "/defs/Nothing"]]);
    const r = submit([{ op: "add", path: "/defs/Fix", value: { kind: "workflow" } }]);
    expect(r.ok).toBe(false);
    expect([...new Set(r.diagnostics.map((d) => d.code))]).toEqual(["MDT-E0104"]);
  });
});

describe("what a sub-program may define (E1705, N09)", () => {
  const shape = (o: PatchOp[] | string): Array<[string, string | undefined, unknown]> => submit(o).diagnostics.map((d) => [d.code, d.at.path, d.facts?.["kind"]]);

  it.each([
    ["contract", `contract Fine(t: Text) {\n  accept ok "Always" by static(true)\n}`, "Fine"],
    ["effect", `effect Publish(t: Text) -> Text critical`, "Publish"],
    ["extern", `extern py "tools/host.py"::host(t: Text) -> Text ! {Fs.Read}`, "host"],
    ["role", `role helper "Helper"`, "helper"],
  ])("refuses a %s", (kind, def, name) => {
    const r = submit(`${FIX()}\n\n${def}`);
    expect(r.diagnostics.map((d) => [d.code, d.at.path, d.facts])).toEqual([["MDT-E1705", `/defs/${name}`, { def: name, kind }]]);
    expect(r.ok).toBe(false);
  });

  it.each([
    ["component", { kind: "component", description: "A service", owner: "owner_role" }],
    ["interface", { kind: "interface", description: "An API" }],
    ["environment", { kind: "environment", class: "internal" }],
  ])("refuses a %s, which is the institution's model of its system", (kind, value) => {
    const r = submit([...ops(FIX()), { op: "add", path: "/defs/Sys", value }]);
    const first = r.diagnostics.filter((d) => d.code !== "MDT-E0104");
    // Whatever the definition says, its kind is refused where it stands, or it is no valid IR at all.
    expect(r.ok).toBe(false);
    if (first.length) expect(first.map((d) => [d.code, d.at.path, d.facts])).toEqual([["MDT-E1705", "/defs/Sys", { def: "Sys", kind }]]);
  });

  it("refuses a remote agent, and accepts a local one", () => {
    const local = `agent Helper {\n  role   "Helps."\n  caps   M\n  budget { tokens: 500, spend: 1 USD, steps: 3 }\n  skill help(t: Text) -> Inferred<Text> ! {Model}\n}`;
    const body = `delegate Helper.help("go")`;
    const ok = submit(`${FIX("M", undefined, body)}\n\n${local}`);
    expect(errors(ok.diagnostics)).toEqual([]);
    expect(ok.ok).toBe(true);
    const r = submit(`${FIX("M", undefined, body)}\n\nagent remote Helper = a2a("https://agents.example/.well-known/agent-card.json")`);
    expect(told(r)).toEqual([["MDT-E1705", "/defs/Helper/remote", { def: "Helper", kind: "remote agent" }]]);
    expect(r.ok).toBe(false);
  });

  it("refuses an envelope of its own", () => {
    const withEnvelope = ops(FIX()).map((o) =>
      o.path === "/defs/Fix" ? { ...o, value: { ...(o.value as object), envelope: { owner: "owner_role", caps: [], budget: { agents: 1 } } } } : o,
    );
    expect(shape(withEnvelope)).toEqual([["MDT-E1705", "/defs/Fix/envelope", "envelope"]]);
  });

  it("refuses a plan of its own, as E1705 and not as a plan outside an envelope", () => {
    expect(shape(FIX("M, R", undefined, `plan Lead.finish([Item { name: "a" }]) within envelope`))).toEqual([["MDT-E1705", "/defs/Fix/body/0/value", "plan"]]);
  });

  it("refuses a workflow with parameters", () => {
    const r = submit(FIX().replace("workflow Fix()", "workflow Fix(n: Text)"));
    expect(r.diagnostics.map((d) => [d.code, d.at.path, d.facts])).toEqual([["MDT-E1705", "/defs/Fix/params", { def: "Fix", kind: "parameters", params: 1 }]]);
  });

  it("has exactly one workflow", () => {
    const none = submit(`capability Wa = W.narrow("/work/a")`);
    expect(none.diagnostics.map((d) => [d.code, d.at.path, d.facts])).toEqual([["MDT-E1705", "/defs", { kind: "workflow", workflows: [] }]]);
    const two = submit(`${FIX()}\n\n${FIX().replace("capability Wa = W.narrow(\"/work/a\")\n\n", "").replace("workflow Fix()", "workflow Again()")}`);
    expect(two.diagnostics.map((d) => [d.code, d.at.path, d.facts])).toEqual([["MDT-E1705", "/defs", { kind: "workflow", workflows: ["Again", "Fix"] }]]);
  });

  it.each([
    ["module", "example.other"],
    ["version", "0.2"],
    ["language", "mandate/0.3"],
    ["uses", [{ module: "example.parent" }, { module: "std", names: ["net"] }]],
    ["tests", {}],
  ])("keeps the skeleton's %s", (field, value) => {
    // An earlier language has no `agents`, so this budget names none: the header is refused before anything is asked of it.
    const r = submit([...ops(FIX("M, R, Wa", "{ tokens: 2000, time: 10m, spend: 2 USD, steps: 10 }")), { op: "add", path: `/${field}`, value }]);
    expect(r.ok).toBe(false);
    expect(told(r)).toEqual([["MDT-E1705", `/${field}`, { field }]]);
  });

  it("checks nothing else of a sub-program that is not one", () => {
    // The body would not pass the checks either; the lead hears first what a sub-program is.
    const r = submit(`${FIX("M", undefined, "missing(1)")}\n\nrole helper "Helper"`);
    expect(pairs(r.diagnostics)).toEqual([["MDT-E1705", "/defs/helper"]]);
  });

  it("reads the shape from the program alone", () => {
    const sub = submit(FIX()).program!;
    expect(subprogramShape(sub, "example.parent", 1)).toEqual([]);
    expect(subprogramShape(sub, "example.parent", 2).map((d) => d.at.path)).toEqual(["/module"]);
    expect(subprogramShape(sub, "example.other", 1).map((d) => d.at.path)).toEqual(["/module", "/uses"]);
  });
});

describe("what a sub-program sees", () => {
  it("uses its parent's agents, capabilities, types and functions, what the parent imports, and the standard modules", () => {
    const r = submit(`type Batch = { tickets: List<Ticket>, items: List<Item> }

let first: Item = Item { name: "a" }

capability Wa = W.narrow("/work/a")
capability Wb = fs.write("/work/b")

fn name_of(i: Item) -> Text {
  label(i)
}

workflow Fix() -> Inferred<Text>
  caps   M, R, Wa, Wb
  budget { tokens: 4000, time: 10m, spend: 2 USD, steps: 10, agents: 2 }
{
  let n = name_of(first)
  delegate Worker.fix(Item { name: n }) with caps Wa
  delegate Worker.fix(first) with caps Wb
}`);
    expect(errors(r.diagnostics)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("does not see a name its parent does not have", () => {
    const r = submit(FIX("M, R, Wa", undefined, `delegate Stranger.fix(Item { name: "a" }) with caps Wa`));
    expect(r.ok).toBe(false);
    expect(pairs(errors(r.diagnostics))).toEqual([["MDT-E0120", "/defs/Fix/body/0/value/agent"]]);
  });

  it("cannot define a name its parent has, or one its parent imports", () => {
    const own = submit(`${FIX()}\n\ntype Item = { name: Text, extra: Text }`);
    expect(own.ok).toBe(false);
    expect(told(own)).toEqual([["MDT-E0121", "/defs/Item", { name: "Item", module: "example.parent" }]]);
    const imported = submit(`${FIX()}\n\ntype Ticket = { id: Text }`);
    expect(told(imported)).toEqual([["MDT-E0121", "/defs/Ticket", { name: "Ticket", module: "example.domain" }]]);
    // A capability under the parent's name would be authority under an approved name.
    const cap = submit(FIX().replace("capability Wa = W.narrow(\"/work/a\")", "capability Wa = W.narrow(\"/work/a\")\ncapability W = fs.write(\"/\")"));
    expect(told(cap)).toEqual([["MDT-E0121", "/defs/W", { name: "W", module: "example.parent" }]]);
  });

  it("opens the parent's use into names for the checks only", () => {
    const sub = submit(FIX()).program!;
    const view = opened(sub, PARENT);
    expect(view.uses).toEqual([...PARENT.uses!, { module: "example.parent", names: Object.keys(PARENT.defs).sort() }]);
    expect(view.defs).toBe(sub.defs);
    expect(sub.uses).toEqual([{ module: "example.parent" }]);
  });

  it("is linked for the interpreter with all its parent sees", () => {
    const sub = submit(FIX()).program!;
    const linked = subprogramLinked(sub, PARENT, MODULES);
    expect(Object.keys(linked.defs).sort()).toEqual([...new Set([...Object.keys(PARENT.defs), "Ticket", "Fix", "Wa"])].sort());
    expect(linked.module).toBe("example.parent.plan_1");
    expect(linked.uses).toEqual([{ module: "example.parent" }]);
  });
});

/** A sub-program that writes nothing: the lead's other skill over one item. */
const READS = `workflow Fix() -> Inferred<Text>\n  caps   M, R\n  budget { tokens: 6000, time: 10m, spend: 2 USD, steps: 25, agents: 2 }\n{\n  delegate Lead.finish([Item { name: "a" }])\n}`;

describe("containment: capabilities (E1706, N01)", () => {
  const ENVELOPE = ["High = model.infer", "M = model.infer", 'Merge = git.pr("company/backend")', "Public = model.infer", 'R = fs.read("/work")', 'W = fs.write("/work")'];
  /** A workflow that holds `Mine` beside what its one delegation needs. */
  const WITH = (cap: string): string =>
    `capability Mine = ${cap}\n\nworkflow Fix() -> Inferred<Text>\n  caps   M, R, Mine\n  budget { tokens: 6000, time: 10m, spend: 2 USD, steps: 25, agents: 2 }\n{\n  delegate Lead.finish([Item { name: "a" }])\n}`;

  it("refuses a capability outside every capability of the envelope", () => {
    const r = submit(WITH(`fs.write("/etc")`));
    expect(r.ok).toBe(false);
    expect(told(r)).toEqual([["MDT-E1706", "/defs/Fix/caps/1", { dimension: "capability", capability: 'Mine = fs.write("/etc")', envelope: ENVELOPE }]]);
    expect(r.program).toBeUndefined();
  });

  it("cannot name a standard module its parent does not import", () => {
    expect(pairs(errors(submit(WITH(`net.https(hosts: ["example.com"])`)).diagnostics))).toEqual([["MDT-E0120", "/defs/Mine/value/callee/of"]]);
  });

  it.each([
    ["a kind the envelope does not hold", `exec(commands: ["npm"])`],
    ["a model tier the envelope does not hold", `model.infer(tier: large)`],
    ["a model that may receive more than the envelope's", `model.infer(tier: standard, max_class: confidential)`],
    ["a repository the envelope does not hold", `git.pr("company/frontend")`],
    ["a scope that is not written out", `fs.write()`],
  ])("refuses %s", (_, cap) => {
    const r = submit(WITH(cap));
    expect(r.ok).toBe(false);
    expect(errors(r.diagnostics).map((d) => [d.code, d.at.path, d.facts?.["dimension"]])).toEqual([["MDT-E1706", "/defs/Fix/caps/1", "capability"]]);
  });

  it("accepts the envelope's own capabilities and narrowings of them", () => {
    expect(submit(FIX("M, R, W", undefined, `delegate Worker.fix(Item { name: "a" })`)).ok).toBe(true);
    expect(submit(FIX()).ok).toBe(true);
  });

  it("narrows a capability of its parent under any name", () => {
    // `A` comes before `W` in name order, which is the order the definitions are read in.
    const named = FIX("M, R, A").replaceAll("Wa", "A");
    expect(told(submit(named))).toEqual([]);
    expect(submit(named).ok).toBe(true);
    // It is still held to what it narrows.
    const outside = submit(named.replace('W.narrow("/work/a")', 'W.narrow("/etc")'));
    expect(outside.ok).toBe(false);
    expect(told(outside)).toContainEqual(["MDT-E0305", "/defs/A/value", { base: 'W = fs.write("/work")', requested: ["/etc"] }]);
  });

  it("holds nothing through a capability that names itself, and ends", () => {
    const loop = (def: string): string => `${def}\n\nworkflow Fix() -> Inferred<Text>\n  caps   M, R, Loop\n  budget { tokens: 2000, time: 10m, spend: 2 USD, steps: 10, agents: 2 }\n{\n  delegate Worker.fix(Item { name: "a" }) with caps Loop\n}`;
    for (const def of [`capability Loop = Loop.narrow("/work/a")`, `capability Loop = Back.narrow("/work/a")\ncapability Back = Loop.narrow("/work")`]) {
      const r = submit(loop(def));
      expect(r.ok).toBe(false);
      // The delegation was handed nothing to write with.
      expect(pairs(errors(r.diagnostics))).toEqual([["MDT-E0301", "/defs/Fix/body/0/value"]]);
    }
    const defs = parsed(`mandate @ 0.4\n\nmodule example.cycle @ 0.1\n\nuse std.{fs}\n\ncapability Loop = Back.narrow("/work/a")\ncapability Back = Loop.narrow("/work")\ncapability Fine = fs.write("/work")\ncapability Under = Fine.narrow("/work/a")\n`).defs;
    expect(capsOf(defs, { op: "var", name: "Loop" })).toEqual([]);
    expect(capsOf(defs, { op: "var", name: "Back" })).toEqual([]);
    expect(capsOf(defs, { op: "var", name: "Under" }).map(showCap)).toEqual(['Under = fs.write("/work/a")']);
  });

  it("refuses a write that overlaps one still in flight, and accepts one beside it", () => {
    const held = capsOf(link(PARENT, MODULES).defs, { op: "call", callee: { op: "field", of: { op: "var", name: "W" }, name: "narrow" }, args: [{ value: { op: "text", value: "/work/a/src" } }] });
    const r = submit(FIX(), { room: { ...ROOM, writes: held } });
    expect(r.ok).toBe(false);
    expect(told(r)).toEqual([["MDT-E1706", "/defs/Fix/caps/2", { dimension: "write_scope", capability: 'Wa = fs.write("/work/a")', in_flight: 'W.narrow = fs.write("/work/a/src")' }]]);
    const beside = capsOf(link(PARENT, MODULES).defs, { op: "call", callee: { op: "field", of: { op: "var", name: "W" }, name: "narrow" }, args: [{ value: { op: "text", value: "/work/b" } }] });
    expect(submit(FIX(), { room: { ...ROOM, writes: beside } }).ok).toBe(true);
    // A read is never in the way of a write in flight.
    expect(submit(READS, { room: { ...ROOM, writes: held } }).ok).toBe(true);
  });
});

describe("a capability that narrows one named after it", () => {
  const program = (version: string): string => `mandate @ ${version}

module example.order @ 0.1

use std.{fs, model}

capability M     = model.infer(tier: standard)
capability Zed   = fs.write("/work")
capability Alpha = Zed.narrow("/work/a")

agent Worker {
  role   "Fixes one thing."
  caps   Alpha, M
  budget { tokens: 3000, steps: 4 }
  skill fix(n: Text) -> Inferred<Text> ! {Fs.Write, Model}
}

workflow W(n: Text) -> Inferred<Text>
  caps   Alpha, M
  budget { tokens: 10000, steps: 10 }
{
  delegate Worker.fix(n)
}
`;

  it("is that narrowing from 0.4 on", () => {
    expect(pairs(errors(check(program("0.4"), "mdt").diagnostics))).toEqual([]);
    expect(pairs(errors(check(program("0.4").replace('Zed.narrow("/work/a")', 'Zed.narrow("/etc")'), "mdt").diagnostics))).toEqual([["MDT-E0305", "/defs/Alpha/value"]]);
  });

  it("is nothing before 0.4, as it always was", () => {
    const always = [
      ["MDT-E0301", "/defs/W/body/0/value"],
      ["MDT-E0301", "/defs/Worker/skills/fix/effects/0"],
    ];
    for (const version of ["0.1", "0.2", "0.3"]) {
      expect(pairs(errors(check(program(version), "mdt").diagnostics))).toEqual(always);
      expect(pairs(errors(check(program(version).replace('Zed.narrow("/work/a")', 'Zed.narrow("/etc")'), "mdt").diagnostics))).toEqual(always);
    }
  });
});

describe("containment: the budget (E1706, N01)", () => {
  const dims = (r: SubprogramCheck): unknown[] => errors(r.diagnostics).map((d) => (d.code === "MDT-E1706" ? [d.at.path, d.facts] : [d.code, d.at.path]));
  const budget = (b: string): string => FIX("M, R, Wa", b);

  it.each([
    ["tokens", "{ tokens: 50001, time: 10m, spend: 2 USD, steps: 10, agents: 2 }", "tokens", 50_001, 50_000],
    ["steps", "{ tokens: 2000, time: 10m, spend: 2 USD, steps: 101, agents: 2 }", "steps", 101, 100],
    ["agents", "{ tokens: 2000, time: 10m, spend: 2 USD, steps: 10, agents: 11 }", "agents", 11, 10],
    ["spend", "{ tokens: 2000, time: 10m, spend: 10.000001 USD, steps: 10, agents: 2 }", "spend:USD", 10_000_001, 10_000_000],
  ])("refuses more %s than the envelope has left, and accepts exactly what is left", (field, b, dimension, asked, left) => {
    const r = submit(budget(b));
    expect(r.ok).toBe(false);
    expect(dims(r)).toEqual([[`/defs/Fix/budget/${field}`, { dimension, asked, left }]]);
    const exact: Room = { ...ROOM, left: { ...ROOM.left, [dimension]: asked } };
    expect(submit(budget(b), { room: exact }).ok).toBe(true);
  });

  it("refuses more time than there is before the run's deadline", () => {
    const r = submit(budget("{ tokens: 2000, time: 31m, spend: 2 USD, steps: 10, agents: 2 }"));
    expect(dims(r)).toEqual([["/defs/Fix/budget/time", { dimension: "time", asked: 1_860_000, left: 1_800_000 }]]);
    expect(submit(budget("{ tokens: 2000, time: 30m, spend: 2 USD, steps: 10, agents: 2 }")).ok).toBe(true);
  });

  it.each([
    ["tokens", "{ time: 10m, spend: 2 USD, steps: 10, agents: 2 }", "tokens", 50_000],
    ["steps", "{ tokens: 2000, time: 10m, spend: 2 USD, agents: 2 }", "steps", 100],
    ["agents", "{ tokens: 2000, time: 10m, spend: 2 USD, steps: 10 }", "agents", 10],
    ["spend", "{ tokens: 2000, time: 10m, steps: 10, agents: 2 }", "spend:USD", 10_000_000],
    ["time", "{ tokens: 2000, spend: 2 USD, steps: 10, agents: 2 }", "time", 1_800_000],
  ])("refuses a budget that names no %s, which the run is limited in", (_, b, dimension, left) => {
    const r = submit(budget(b));
    expect(r.ok).toBe(false);
    expect(dims(r)).toEqual([["/defs/Fix/budget", { dimension, asked: null, left }]]);
  });

  it("refuses a workflow with no budget, once for each dimension", () => {
    const r = submit(FIX().replace(/\n  budget [^\n]*/, ""));
    expect(r.ok).toBe(false);
    expect(dims(r).map((d) => [(d as [string, { dimension: string }])[0], (d as [string, { dimension: string }])[1].dimension])).toEqual([
      ["/defs/Fix", "agents"],
      ["/defs/Fix", "spend:USD"],
      ["/defs/Fix", "steps"],
      ["/defs/Fix", "tokens"],
      ["/defs/Fix", "time"],
    ]);
  });

  it("does not hold a dimension the run has no limit in, but refuses money in a currency the envelope does not give", () => {
    const { tokens: _, ...noTokens } = ROOM.left;
    const { time_left_ms: __, ...noDeadline } = ROOM;
    expect(submit(budget("{ tokens: 9000000, spend: 2 USD, steps: 10, agents: 2 }"), { room: { ...noDeadline, left: noTokens } }).ok).toBe(true);
    // The body hands out no money, so nothing but containment speaks of the currency.
    const r = submit(`workflow Fix() -> Inferred<Text>\n  caps   M\n  budget { tokens: 2000, time: 10m, spend: 2 EUR, steps: 10, agents: 2 }\n{\n  infer Text from "Which is left?"\n}`);
    expect(dims(r)).toEqual([
      ["/defs/Fix/budget", { dimension: "spend:USD", asked: null, left: 10_000_000 }],
      ["/defs/Fix/budget/spend", { dimension: "spend:EUR", asked: 2_000_000, left: 0 }],
    ]);
  });

  it("refuses everything when nothing is left", () => {
    const r = submit(FIX(), { room: { left: { tokens: 0, steps: 0, agents: 0, "spend:USD": 0 }, time_left_ms: -5, writes: [] } });
    expect(dims(r).map((d) => (d as [string, { dimension: string }])[1].dimension)).toEqual(["tokens", "steps", "spend:USD", "agents", "time"]);
  });

  it("reads the claim from the definitions alone", () => {
    const sub = submit(FIX()).program!;
    const defs = subprogramLinked(sub, PARENT, MODULES).defs;
    const envelope = ["M", "R", "W"].flatMap((n) => capsOf(defs, { op: "var", name: n }));
    expect(containment(defs, "Fix", envelope, ROOM)).toEqual([]);
    expect(containment(defs, "Fix", envelope.slice(0, 2), ROOM).map((d) => d.facts?.["dimension"])).toEqual(["capability"]);
    expect(containment(defs, "Worker", envelope, ROOM)).toEqual([]);
  });
});

describe("a sub-program's workflow under its parent's envelope", () => {
  const WORK = (map: string, budget = "{ tokens: 20000, time: 20m, spend: 8 USD, steps: 40, agents: 8 }"): string => `let todo: List<Item> = [Item { name: "a" }, Item { name: "b" }]

workflow Fix() -> List<Outcome<Inferred<Text>>>
  caps   M, R
  budget ${budget}
{
  ${map}
}`;
  const BODY = `{\n    delegate Lead.finish([x])\n  }`;

  it("holds a map to the parent's max_concurrent (E1703)", () => {
    const r = submit(WORK(`map x in todo max 2 par 5 ${BODY}`, "{ tokens: 20000, time: 20m, spend: 8 USD, steps: 40, agents: 8 }"));
    expect(pairs(errors(r.diagnostics))).toEqual([["MDT-E1703", "/defs/Fix/body/0/value/par"]]);
    expect(r.diagnostics[0]!.facts).toEqual({ par: 5, max_concurrent: 4 });
    expect(submit(WORK(`map x in todo max 2 par 4 ${BODY}`)).ok).toBe(true);
  });

  it("lets a map go without max, bounded by the agents the sub-program asks for (E1702, E0501)", () => {
    // Without max the map counts as many items as the sub-program has agents: 8 × the lead's budget.
    const r = submit(WORK(`map x in todo par 2 ${BODY}`));
    expect(pairs(errors(r.diagnostics))).toEqual([["MDT-E0501", "/defs/Fix/budget"]]);
    expect(Object.keys(r.diagnostics[0]!.facts!).filter((k) => k !== "breakdown")).toEqual(["spend", "tokens", "steps"]);
    expect(submit(WORK(`map x in todo par 2 ${BODY}`, "{ tokens: 10000, time: 20m, spend: 4 USD, steps: 40, agents: 2 }")).ok).toBe(true);
    // A map that starts no delegation has no agents to bound it.
    const none = submit(WORK(`map x in todo {\n    label(x)\n  }`).replace("List<Outcome<Inferred<Text>>>", "List<Outcome<Text>>"));
    expect(pairs(errors(none.diagnostics))).toEqual([["MDT-E1702", "/defs/Fix/body/0/value"]]);
  });

  it("compares the budget with the body in steps and agents too (E0501)", () => {
    const r = submit(WORK(`map x in todo max 2 ${BODY}`, "{ tokens: 20000, time: 20m, spend: 8 USD, steps: 39, agents: 1 }"));
    expect(pairs(errors(r.diagnostics))).toEqual([["MDT-E0501", "/defs/Fix/budget"]]);
    const { breakdown: _, ...facts } = r.diagnostics[0]!.facts!;
    expect(facts).toEqual({ steps: { limit: 39, declared_by_children: 40 }, agents: { limit: 1, declared_by_children: 2 } });
    expect(submit(WORK(`map x in todo max 2 ${BODY}`, "{ tokens: 20000, time: 20m, spend: 8 USD, steps: 40, agents: 2 }")).ok).toBe(true);
  });
});

describe("containment: the data class (E1706)", () => {
  const CONFIDENTIAL = parsed(parentSource("\n    spawn   { max_concurrent: 4, max_class: confidential }", "items"));
  const facts = (r: SubprogramCheck): unknown[] => errors(r.diagnostics).map((d) => [d.code, d.at.path, d.facts]);
  const SECRET = `let secret: Secret = Secret { body: "the plan" }`;
  const STUDY = (caps: string, grant = ""): string => `${SECRET}

workflow Fix() -> Inferred<Text>
  caps   ${caps}
  budget { tokens: 6000, time: 10m, spend: 3 USD, steps: 25, agents: 2 }
{
  delegate Lead.study(secret)${grant}
}`;

  it("refuses data above the envelope's max_class, which is internal when the envelope does not say", () => {
    const r = submit(STUDY("High, R"));
    expect(facts(r)).toEqual([["MDT-E1706", "/defs/Fix/body/0/value", { dimension: "data_class", data_class: "confidential", allowed: "internal", by: "envelope" }]]);
    expect(r.diagnostics[0]!.message).toContain("the run's envelope allows at most internal");
    expect(submit(STUDY("High, R"), { parent: CONFIDENTIAL }).ok).toBe(true);
  });

  it("reports data that is too much for a model inside the sub-program as anywhere (E0220)", () => {
    // The lead may receive it and the envelope allows it; the standard model may not.
    const r = submit(STUDY("M, R"), { parent: CONFIDENTIAL });
    expect(facts(r)).toEqual([["MDT-E0220", "/defs/Fix/body/0/value", { data_class: "confidential", allowed: "internal" }]]);
  });

  it("holds every model in the sub-program to the class of what the lead received", () => {
    // An agent of the sub-program's own, on the model `cap` names.
    const noted = (cap: string): string => `agent Quiet {
  role   "Takes a note."
  caps   ${cap}
  budget { tokens: 500, spend: 1 USD, steps: 3 }
  skill note(t: Text) -> Inferred<Text> ! {Model}
}

workflow Fix() -> Inferred<Text>
  caps   ${cap}
  budget { tokens: 2000, time: 10m, spend: 2 USD, steps: 10, agents: 2 }
{
  delegate Quiet.note("go")
}`;
    // A lead that received public data wrote a public sub-program, which a model for public data may read.
    expect(submit(noted("Public"), { lead: "public" }).ok).toBe(true);
    const r = submit(noted("Public"), { lead: "internal" });
    expect(facts(r)).toEqual([["MDT-E1706", "/defs/Fix/body/0/value", { dimension: "data_class", data_class: "internal", allowed: "public", by: "lead", lead: "internal" }]]);
    expect(r.diagnostics[0]!.message).toContain("The lead received internal data, and a sub-program is its output.");
    // The same sub-program fits a model that may receive what the lead did.
    expect(submit(noted("M"), { lead: "internal" }).ok).toBe(true);
  });

  it("holds a question to a model in the sub-program's body to the lead's class too", () => {
    const ask = (cap: string): string => `workflow Fix() -> Inferred<Text>\n  caps   ${cap}\n  budget { tokens: 2000, time: 10m, spend: 2 USD, steps: 10, agents: 2 }\n{\n  infer Text from "Which is left?"\n}`;
    expect(submit(ask("Public"), { lead: "public" }).ok).toBe(true);
    const r = submit(ask("Public"), { lead: "internal" });
    expect(facts(r)).toEqual([["MDT-E1706", "/defs/Fix/body/0/value", { dimension: "data_class", data_class: "internal", allowed: "public", by: "lead", lead: "internal" }]]);
    expect(submit(ask("M"), { lead: "internal" }).ok).toBe(true);
  });

  it("knows the class of what each plan hands its lead", () => {
    const defs = link(PARENT, MODULES).defs;
    expect(leadClasses(PARENT, defs)).toEqual({ "/defs/Run/body/0/value": "public" });
    const secret = parsed(parentSource("\n    spawn   { max_concurrent: 4, max_class: confidential }", "items").replace("plan Lead.finish(items) within envelope", "plan Lead.study(secret) within envelope"));
    expect(leadClasses(secret, link(secret, MODULES).defs)).toEqual({ "/defs/Run/body/0/value": "confidential" });
  });
});

describe("dynamic spawn (E0711, V05)", () => {
  const spawn = (version: string): Diagnostic[] =>
    check(`mandate @ ${version}\n\nmodule example.dynamic @ 0.1\n\nuse std.{model}\n\ncapability M = model.infer(tier: standard)\n\nagent A {\n  role   "Answers."\n  caps   M\n  skill s(t: Text) -> Inferred<Text> ! {Model}\n}\n\nworkflow W(t: Text) -> Bool\n  caps M\n{\n  let x = spawn A.s(t)\n  true\n}\n`, "mdt").diagnostics.filter((d) => d.code === "MDT-E0711");

  it("names plan as the dynamic form in a 0.4 program, and says what it always said before", () => {
    expect(spawn("0.4").map((d) => d.message)).toEqual([
      "There is no 'spawn'. An agent plans work while a run is going with 'plan Agent.skill(…) within envelope', in a workflow that has an envelope; use delegate, par or a bounded map for work known beforehand (spec/envelope.md \"plan\", V05).",
    ]);
    expect(spawn("0.3").map((d) => d.message)).toEqual(["Dynamic spawn is not available in 0.1; use delegate, par, or a bounded map (§9.1, V05)."]);
  });
});
