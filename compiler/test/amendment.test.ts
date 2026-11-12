// An amendment of an envelope (spec/envelope.md "Amendments", N04): the
// program with the new envelope is a new program, checked as any program is,
// and the new envelope takes nothing away from the old one (E1709). Each part
// of the rule is shown refused and in its nearest accepted form, and each
// test names every error the check gives.

import { describe, expect, it } from "vitest";
import { check, checkAmendment, load, type AmendmentCheck } from "../src/check.js";
import type { Diagnostic } from "../src/diag.js";
import type { Envelope, Program, WorkflowDef } from "../src/ir/types.js";
import type { Modules } from "../src/modules.js";
import { envelopeChanges, semanticDiff } from "../src/views/views.js";

interface Parts {
  owner?: string;
  caps?: string;
  budget?: string;
  spawn?: string;
  approve?: string;
}

const BUDGET = "{ tokens: 100000, time: 1h, spend: 20 USD, steps: 200, agents: 20 }";

/** A workflow with an envelope and a lead that plans under it. A test gives the lines of the envelope that matter to it. */
const source = (o: Parts = {}): string => `mandate @ 0.4

module example.amend @ 0.1

use std.{fs, git, model}

role owner_role "Owner"
role other_role "Another owner"
role release    "Release manager"

type Item = { name: Text }

capability M     = model.infer(tier: standard)
capability R     = fs.read("/work")
capability W     = fs.write("/work")
capability Wsrc  = fs.write("/work/src")
capability Docs  = fs.write("/docs")
capability Merge = git.pr("company/backend")

agent Lead {
  role   "Plans what is left."
  caps   M, R
  budget { tokens: 5000, spend: 2 USD, steps: 20 }
  skill finish(items: List<Item>) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow Run(items: List<Item>) -> Inferred<Text>
  envelope {
    owner   ${o.owner ?? "owner_role"}
    caps    ${o.caps ?? "M, R, W, Merge"}
    budget  ${o.budget ?? BUDGET}${o.spawn === undefined ? "\n    spawn   { max_concurrent: 4 }" : o.spawn ? `\n    spawn   ${o.spawn}` : ""}${o.approve === undefined ? "\n    approve git.merge by release" : o.approve ? `\n    approve ${o.approve}` : ""}
  }
{
  plan Lead.finish(items) within envelope
}
`;

const errors = (ds: Diagnostic[]): Diagnostic[] => ds.filter((d) => d.severity === "error");
/** Every error of a check, with its facts. */
const told = (r: { diagnostics: Diagnostic[] }): unknown[] => errors(r.diagnostics).map((d) => [d.code, d.at.path, d.facts]);

/** The program a run has: it checks. */
function program(o: Parts = {}): Program {
  const r = check(source(o), "mdt");
  expect(told(r)).toEqual([]);
  return r.program!;
}

/** The envelope a lead sends: the one this source would give the workflow, as IR. It need not check. */
function envelope(o: Parts = {}): Envelope {
  const r = load(source(o), "mdt");
  expect(told(r)).toEqual([]);
  return (r.program!.defs["Run"] as WorkflowDef).envelope!;
}

/** The check of an amendment from the envelope `from` gives to the one `to` gives. */
const amend = (from: Parts, to: Parts): AmendmentCheck => checkAmendment({ parent: program(from), workflow: "Run", envelope: envelope(to) });

const AT = "/defs/Run/envelope";

describe("an amendment is a new program", () => {
  it("is the program with the new envelope and nothing else changed, with the hash writing it so gives", () => {
    const to: Parts = { caps: "M, R, W, Merge, Docs", budget: "{ tokens: 250000, time: 2h, spend: 50 USD, steps: 400, agents: 40 }" };
    const parent = program();
    const before = JSON.stringify(parent);
    const r = checkAmendment({ parent, workflow: "Run", envelope: envelope(to) });
    const written = check(source(to), "mdt");
    expect(told(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.hash).toBe(written.hashes!.program);
    expect(r.hash).not.toBe(check(source(), "mdt").hashes!.program);
    expect(r.program).toEqual(written.program);
    // The program the run has is not touched.
    expect(JSON.stringify(parent)).toBe(before);
  });

  it("is checked as any program is: what the new envelope names must be there, and it must be an envelope", () => {
    const parent = program();
    const now = envelope();
    // A role nobody declared, a capability nobody defined, an effect under `approve` that is not critical.
    expect(told(checkAmendment({ parent, workflow: "Run", envelope: { ...now, owner: "nobody" } }))).toEqual([
      ["MDT-E1501", `${AT}/owner`, { role: "nobody", where: "an envelope's owner", roles: ["other_role", "owner_role", "release"] }],
    ]);
    expect(checkAmendment({ parent, workflow: "Run", envelope: { ...now, caps: [...now.caps!, { op: "var", name: "Nothing" }] } }).ok).toBe(false);
    expect(told(checkAmendment({ parent, workflow: "Run", envelope: { ...now, approve: { "fs.read": "release" } } })).map((d) => (d as unknown[])[0])).toEqual(["MDT-E1704"]);
    // Not an object: there is no envelope to check.
    for (const none of [null, "wider", 7, [now]]) {
      expect(told(checkAmendment({ parent, workflow: "Run", envelope: none }))).toEqual([["MDT-E1701", AT, { missing: ["owner", "caps", "budget"] }]]);
    }
    // An object that is no envelope is told what it lacks, and is not held to the old one: there is nothing to compare.
    const empty = checkAmendment({ parent, workflow: "Run", envelope: {} });
    expect(empty.ok).toBe(false);
    expect(errors(empty.diagnostics).map((d) => d.code)).toContain("MDT-E1701");
    expect(errors(empty.diagnostics).map((d) => d.code)).not.toContain("MDT-E1709");
    // A refused amendment makes no program and has no hash.
    expect([empty.program, empty.hash]).toEqual([undefined, undefined]);
  });

  it("is asked of a workflow that has an envelope: anything else is the caller's mistake", () => {
    const parent = program();
    expect(() => checkAmendment({ parent, workflow: "Nobody", envelope: envelope() })).toThrow(/Nobody is not a workflow with an envelope/);
    expect(() => checkAmendment({ parent, workflow: "Lead", envelope: envelope() })).toThrow(/Lead is not a workflow with an envelope/);
    expect(() => checkAmendment({ parent, workflow: "toString", envelope: envelope() })).toThrow(/toString is not a workflow with an envelope/);
  });
});

describe("E1709: an amendment only widens", () => {
  it("holds every capability the envelope held: one left out or narrowed is refused, one widened or added is not", () => {
    const asked = ['M = model.infer', 'Merge = git.pr("company/backend")', 'R = fs.read("/work")'];
    expect(told(amend({}, { caps: "M, R, Merge" }))).toEqual([["MDT-E1709", `${AT}/caps`, { dimension: "capability", capability: 'W = fs.write("/work")', asked }]]);
    // A capability over part of what the old one covered does not hold it.
    expect(told(amend({}, { caps: "M, R, Wsrc, Merge" }))).toEqual([
      ["MDT-E1709", `${AT}/caps`, { dimension: "capability", capability: 'W = fs.write("/work")', asked: ['M = model.infer', 'Merge = git.pr("company/backend")', 'R = fs.read("/work")', 'Wsrc = fs.write("/work/src")'] }],
    ]);
    // Each capability left out is named.
    expect(told(amend({ approve: "" }, { caps: "M, R", approve: "" })).map((d) => ((d as unknown[])[2] as { capability: string }).capability)).toEqual(['Merge = git.pr("company/backend")', 'W = fs.write("/work")']);
    // A program that does not check is not held to the old envelope as well: without Merge, nothing covers the merge under `approve`.
    expect(told(amend({}, { caps: "M, R" })).map((d) => (d as unknown[])[0])).toEqual(["MDT-E1704"]);
    // The other way round: a wider capability holds the narrower one, and a new one takes nothing away.
    expect(told(amend({ caps: "M, R, Wsrc, Merge" }, { caps: "M, R, W, Merge" }))).toEqual([]);
    expect(told(amend({}, { caps: "M, R, W, Merge, Docs" }))).toEqual([]);
  });

  it("gives each budget dimension at least what the envelope gave", () => {
    const with_ = (line: string): Parts => ({ budget: BUDGET.replace(/tokens: 100000|time: 1h|spend: 20 USD|steps: 200|agents: 20/g, (m) => (m.startsWith(line.split(":")[0]!) ? line : m)) });
    expect(told(amend({}, with_("tokens: 99999")))).toEqual([["MDT-E1709", `${AT}/budget/tokens`, { dimension: "tokens", was: 100000, asked: 99999 }]]);
    expect(told(amend({}, with_("time: 59m")))).toEqual([["MDT-E1709", `${AT}/budget/time`, { dimension: "time", was: 3_600_000, asked: 3_540_000 }]]);
    expect(told(amend({}, with_("spend: 19 USD")))).toEqual([["MDT-E1709", `${AT}/budget/spend`, { dimension: "spend:USD", was: 20_000_000, asked: 19_000_000 }]]);
    expect(told(amend({}, with_("steps: 199")))).toEqual([["MDT-E1709", `${AT}/budget/steps`, { dimension: "steps", was: 200, asked: 199 }]]);
    expect(told(amend({}, with_("agents: 19")))).toEqual([["MDT-E1709", `${AT}/budget/agents`, { dimension: "agents", was: 20, asked: 19 }]]);
    // Every dimension that is lowered is named, and one that is raised beside it is not.
    expect(told(amend({}, { budget: "{ tokens: 50000, time: 1h, spend: 40 USD, steps: 100, agents: 20 }" })).map((d) => (d as unknown[])[1])).toEqual([`${AT}/budget/tokens`, `${AT}/budget/steps`]);
    // The same amounts take nothing away, and neither does more of each.
    expect(told(amend({}, {}))).toEqual([]);
    expect(told(amend({}, { budget: "{ tokens: 100001, time: 61m, spend: 21 USD, steps: 201, agents: 21 }" }))).toEqual([]);
  });

  it("names the dimensions the envelope names, and no other", () => {
    const untimed = "{ tokens: 100000, spend: 20 USD, steps: 200, agents: 20 }";
    // Leaving a dimension out would leave the run's limit with nothing above it.
    expect(told(amend({}, { budget: untimed }))).toEqual([["MDT-E1709", `${AT}/budget`, { dimension: "time", was: 3_600_000, asked: null }]]);
    // Naming a new one would add a limit the run never had.
    expect(told(amend({ budget: untimed }, {}))).toEqual([["MDT-E1709", `${AT}/budget/time`, { dimension: "time", was: null, asked: 3_600_000 }]]);
    expect(told(amend({ budget: untimed }, { budget: untimed }))).toEqual([]);
  });

  it("bounds the delegations that run at once no more tightly", () => {
    expect(told(amend({}, { spawn: "{ max_concurrent: 3 }" }))).toEqual([["MDT-E1709", `${AT}/spawn/max_concurrent`, { dimension: "max_concurrent", was: 4, asked: 3 }]]);
    // A bound where there was none is a new limit.
    expect(told(amend({ spawn: "" }, { spawn: "{ max_concurrent: 64 }" }))).toEqual([["MDT-E1709", `${AT}/spawn/max_concurrent`, { dimension: "max_concurrent", was: null, asked: 64 }]]);
    // The same, more, or no bound at all.
    expect(told(amend({}, { spawn: "{ max_concurrent: 4 }" }))).toEqual([]);
    expect(told(amend({}, { spawn: "{ max_concurrent: 5 }" }))).toEqual([]);
    expect(told(amend({}, { spawn: "" }))).toEqual([]);
    expect(told(amend({ spawn: "" }, { spawn: "" }))).toEqual([]);
  });

  it("lets a delegation receive data of no lower class", () => {
    const high = "{ max_concurrent: 4, max_class: confidential }";
    expect(told(amend({ spawn: high }, { spawn: "{ max_concurrent: 4, max_class: internal }" }))).toEqual([["MDT-E1709", `${AT}/spawn/max_class`, { dimension: "max_class", was: "confidential", asked: "internal" }]]);
    // Left out, the class is `internal`: that is lower than confidential, and it is the envelope that says so.
    expect(told(amend({ spawn: high }, {}))).toEqual([["MDT-E1709", AT, { dimension: "max_class", was: "confidential", asked: "internal" }]]);
    expect(told(amend({}, { spawn: "{ max_concurrent: 4, max_class: public }" }))).toEqual([["MDT-E1709", `${AT}/spawn/max_class`, { dimension: "max_class", was: "internal", asked: "public" }]]);
    // The same class, written or left out, and a higher one.
    expect(told(amend({ spawn: high }, { spawn: high }))).toEqual([]);
    expect(told(amend({}, { spawn: "{ max_concurrent: 4, max_class: internal }" }))).toEqual([]);
    expect(told(amend({}, { spawn: high }))).toEqual([]);
    expect(told(amend({ spawn: high }, { spawn: "{ max_concurrent: 4, max_class: restricted }" }))).toEqual([]);
  });

  it("may change who owns the envelope and who approves an effect: the owner is shown both", () => {
    expect(told(amend({}, { owner: "other_role" }))).toEqual([]);
    expect(told(amend({}, { approve: "" }))).toEqual([]);
    expect(told(amend({ approve: "" }, {}))).toEqual([]);
    expect(told(amend({}, { approve: "git.merge by other_role" }))).toEqual([]);
  });
});

describe("what an amendment changes, as the owner who decides it is shown", () => {
  /** The lines for the change from the envelope `from` gives to the one `to` gives. */
  const changes = (from: Parts, to: Parts): string[] => envelopeChanges(program(from), program(to), "Run").map((c) => `${c.path}  ${c.text}`);

  it("names each line of the envelope that changed, with what it was and what it is", () => {
    const to: Parts = {
      owner: "other_role",
      caps: "M, R, W, Merge, Docs",
      budget: "{ tokens: 250000, time: 2h, spend: 50 USD, steps: 400, agents: 40 }",
      spawn: "{ max_concurrent: 8, max_class: confidential }",
      approve: "git.merge by other_role",
    };
    expect(changes({}, to)).toEqual([
      `${AT}/owner  ~ Run.envelope.owner: owner_role → other_role`,
      `${AT}/caps/0  + Run.envelope: Docs = fs.write("/docs")`,
      `${AT}/budget  ~ Run.envelope.budget.spend: 20 USD → 50 USD`,
      `${AT}/budget  ~ Run.envelope.budget.tokens: 100000 → 250000`,
      `${AT}/budget  ~ Run.envelope.budget.steps: 200 → 400`,
      `${AT}/budget  ~ Run.envelope.budget.time: 1h → 2h`,
      `${AT}/budget  ~ Run.envelope.budget.agents: 20 → 40`,
      `${AT}/spawn/max_concurrent  ~ Run.envelope.spawn.max_concurrent: 4 → 8`,
      `${AT}/spawn/max_class  ~ Run.envelope.spawn.max_class: internal → confidential`,
      `${AT}/approve/git.merge  ~ Run.envelope.approve: git.merge by release → other_role`,
    ]);
    // The diff of the two programs says one thing of all this: the envelope changed, which a person approves.
    expect(semanticDiff(program(), program(to)).governance).toEqual([{ path: AT, text: "~ Run: envelope changed" }]);
  });

  it("names what went as well as what came: a bound dropped, a rule added or taken away, a capability left out", () => {
    expect(changes({}, { spawn: "" })).toEqual([`${AT}/spawn/max_concurrent  ~ Run.envelope.spawn.max_concurrent: 4 → no bound`]);
    expect(changes({ spawn: "" }, {})).toEqual([`${AT}/spawn/max_concurrent  ~ Run.envelope.spawn.max_concurrent: no bound → 4`]);
    expect(changes({}, { approve: "" })).toEqual([`${AT}/approve/git.merge  - Run.envelope.approve: git.merge by release`]);
    expect(changes({ approve: "" }, {})).toEqual([`${AT}/approve/git.merge  + Run.envelope.approve: git.merge by release`]);
    expect(changes({ approve: "" }, { caps: "M, R, W", approve: "" })).toEqual([`${AT}/caps  - Run.envelope: Merge = git.pr("company/backend")`]);
    expect(changes({}, { budget: "{ tokens: 100000, spend: 20 USD, steps: 200, agents: 20 }" })).toEqual([`${AT}/budget  ~ Run.envelope.budget.time: 1h → no limit`]);
    expect(changes({}, { budget: "{ tokens: 50000, time: 1h, spend: 20 USD, steps: 200, agents: 20 }" })).toEqual([`${AT}/budget  ~ Run.envelope.budget.tokens: 100000 → 50000`]);
  });

  it("reads a capability the program imports as its module defines it: the rule and the owner's lines both", () => {
    // Docs is defined in a module of its own, and the program imports it.
    const modules: Modules = { "example.caps": load('mandate @ 0.4\n\nmodule example.caps @ 0.1\n\nuse std.{fs}\n\ncapability Docs = fs.write("/docs")\n', "mdt").program! };
    const imported = (o: Parts): string => source(o).replace('capability Docs  = fs.write("/docs")\n', "").replace("use std.{fs, git, model}", "use std.{fs, git, model}\nuse example.caps.{Docs}");
    const checked = (o: Parts): Program => {
      const r = check(imported(o), "mdt", { modules });
      expect(told(r)).toEqual([]);
      return r.program!;
    };
    const held = checked({ caps: "M, R, W, Merge, Docs" });
    const without = checked({});
    const envelopeIn = (p: Program): Envelope => (p.defs["Run"] as WorkflowDef).envelope!;
    // Left out, it is named with what it stands for: the envelope held it.
    expect(told(checkAmendment({ parent: held, modules, workflow: "Run", envelope: envelopeIn(without) }))).toEqual([
      ["MDT-E1709", `${AT}/caps`, { dimension: "capability", capability: 'Docs = fs.write("/docs")', asked: ['M = model.infer', 'Merge = git.pr("company/backend")', 'R = fs.read("/work")', 'W = fs.write("/work")'] }],
    ]);
    expect(told(checkAmendment({ parent: without, modules, workflow: "Run", envelope: envelopeIn(held) }))).toEqual([]);
    expect(envelopeChanges(without, held, "Run", modules).map((c) => c.text)).toEqual(['+ Run.envelope: Docs = fs.write("/docs")']);
    expect(envelopeChanges(held, without, "Run", modules).map((c) => c.text)).toEqual(['- Run.envelope: Docs = fs.write("/docs")']);
  });

  it("is nothing for the same envelope, and nothing where there is no envelope to compare", () => {
    expect(changes({}, {})).toEqual([]);
    const without = load(source(), "mdt").program!;
    delete (without.defs["Run"] as WorkflowDef).envelope;
    expect(envelopeChanges(without, program(), "Run")).toEqual([]);
    expect(envelopeChanges(program(), without, "Run")).toEqual([]);
    expect(envelopeChanges(program(), program(), "Lead")).toEqual([]);
    expect(envelopeChanges(program(), program(), "Nobody")).toEqual([]);
  });
});
