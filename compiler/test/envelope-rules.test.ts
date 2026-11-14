// The envelope's static rules (spec/envelope.md "The envelope", "Static
// checks"): a malformed envelope (E1701), an approval of an effect that is not
// critical or not covered (E1704), a `plan` outside an envelope (E1707), the
// envelope's budget held to steps and agents (E0501), the envelope's data
// class (E0220), and the static cost they are compared with. Each rule is
// shown by one change to a program that checks without a diagnostic, and each
// test names every diagnostic the check gives.

import { describe, expect, it } from "vitest";
import { kindOf, loadModules } from "../src/check.js";
import { staticCost } from "../src/check/cost.js";
import type { Diagnostic } from "../src/diag.js";
import type { Program, WorkflowDef } from "../src/ir/types.js";
import { link, type Modules } from "../src/modules.js";
import { checkLessMoved as check, readRepo } from "./helpers.js";

const MIGRATE_ALL = readRepo("fixtures/envelope/migrate-all.mdt");
const DOMAIN = "fixtures/envelope/domain.mdt";

function modules(): Modules {
  const { modules, problems } = loadModules([{ file: DOMAIN, text: readRepo(DOMAIN), kind: kindOf(DOMAIN) }]);
  expect(problems).toEqual([]);
  return modules;
}

/** MigrateAll, checked with its domain module; it must check without a single diagnostic. */
function migrateAll(): Program {
  const r = check(MIGRATE_ALL, "mdt", { modules: modules() });
  expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return r.program!;
}

/** MigrateAll with one textual change; fails loudly if the text is gone. */
function mutate(from: string, to: string, src = MIGRATE_ALL): string {
  expect(src.includes(from), from).toBe(true);
  return src.replace(from, to);
}

function diagnostics(src: string, kind: "mdt" | "json" = "mdt", mods: Modules = modules()): Diagnostic[] {
  return check(src, kind, { modules: mods }).diagnostics;
}

const pairs = (ds: Diagnostic[]): Array<[string, string | undefined]> => ds.map((d) => [d.code, d.at.path]);

/** MigrateAll's IR with one change to its workflow, as JSON IR: for what the text form cannot write. */
function changedIr(change: (wf: WorkflowDef) => void): string {
  const p = structuredClone(migrateAll());
  const wf = p.defs["MigrateAll"];
  if (wf?.kind !== "workflow") throw new Error("MigrateAll is a workflow");
  change(wf);
  return JSON.stringify(p);
}

/** A diagnostic's facts without the breakdown, which only explains them. */
function factsBut(d: Diagnostic): Record<string, unknown> {
  const { breakdown: _, ...rest } = d.facts ?? {};
  return rest;
}

const ENVELOPE = `  envelope {
    owner   platform_lead
    caps    RepoRead, SrcWrite, Build, ModelStd, Merge
    budget  { tokens: 80000k, time: 6h, spend: 120 USD, steps: 2000, agents: 200 }
    spawn   { max_concurrent: 16, max_class: internal }
    approve git.merge by release_manager
  }
`;

describe("a malformed envelope (E1701)", () => {
  it("names a missing owner, at the envelope", () => {
    const ds = diagnostics(mutate("    owner   platform_lead\n", ""));
    expect(pairs(ds)).toEqual([["MDT-E1701", "/defs/MigrateAll/envelope"]]);
    expect(ds[0]!.facts).toEqual({ missing: ["owner"] });
  });

  it("names a missing budget", () => {
    const ds = diagnostics(mutate("    budget  { tokens: 80000k, time: 6h, spend: 120 USD, steps: 2000, agents: 200 }\n", ""));
    expect(pairs(ds)).toEqual([["MDT-E1701", "/defs/MigrateAll/envelope"]]);
    expect(ds[0]!.facts).toEqual({ missing: ["budget"] });
  });

  it("names a budget without agents as budget.agents", () => {
    const ds = diagnostics(mutate("steps: 2000, agents: 200 }", "steps: 2000 }"));
    expect(pairs(ds)).toEqual([["MDT-E1701", "/defs/MigrateAll/envelope"]]);
    expect(ds[0]!.facts).toEqual({ missing: ["budget.agents"] });
  });

  it("names missing caps, and what the run then cannot do follows from it", () => {
    // Without caps the envelope authorizes nothing: git.merge is uncovered (E1704), the map cannot hand
    // SrcWrite to its body (E0701), and no delegation is granted what its skill uses (E0301).
    const ds = diagnostics(mutate("    caps    RepoRead, SrcWrite, Build, ModelStd, Merge\n", ""));
    expect(pairs(ds)).toEqual([
      ["MDT-E1701", "/defs/MigrateAll/envelope"],
      ["MDT-E1704", "/defs/MigrateAll/envelope/approve/git.merge"],
      ["MDT-E0701", "/defs/MigrateAll/body/0/value/caps/0"],
      ["MDT-E0301", "/defs/MigrateAll/body/0/value/body/0/value"],
      ["MDT-E0301", "/defs/MigrateAll/body/0/value/body/0/value"],
      ["MDT-E0301", "/defs/MigrateAll/body/0/value/body/0/value"],
      ["MDT-E0301", "/defs/MigrateAll/body/1/value"],
      ["MDT-E0301", "/defs/MigrateAll/body/1/value"],
    ]);
    expect(ds[0]!.facts).toEqual({ missing: ["caps"] });
  });

  it("names everything missing in one diagnostic, in the order owner, caps, budget, budget.agents", () => {
    const ds = diagnostics(changedIr((wf) => {
      delete wf.envelope!.owner;
      delete wf.envelope!.budget!.agents;
    }), "json");
    expect(pairs(ds)).toEqual([["MDT-E1701", "/defs/MigrateAll/envelope"]]);
    expect(ds[0]!.facts).toEqual({ missing: ["owner", "budget.agents"] });
    const all = diagnostics(changedIr((wf) => {
      delete wf.envelope!.owner;
      delete wf.envelope!.caps;
      delete wf.envelope!.budget;
    }), "json");
    expect(all[0]!.facts).toEqual({ missing: ["owner", "caps", "budget"] });
  });

  it("refuses caps of the workflow's own beside an envelope, at those caps", () => {
    // The text form writes no workflow caps when there is an envelope, so the IR is changed.
    const ds = diagnostics(changedIr((wf) => void (wf.caps = [{ op: "var", name: "RepoRead" }])), "json");
    expect(pairs(ds)).toEqual([["MDT-E1701", "/defs/MigrateAll/caps"]]);
    expect(ds[0]!.facts).toEqual({ field: "caps" });
  });

  it("refuses a budget of the workflow's own beside an envelope, at that budget", () => {
    const ds = diagnostics(changedIr((wf) => void (wf.budget = { steps: 10 })), "json");
    expect(pairs(ds)).toEqual([["MDT-E1701", "/defs/MigrateAll/budget"]]);
    expect(ds[0]!.facts).toEqual({ field: "budget" });
  });
});

describe("an envelope approval of a non-critical or uncovered effect (E1704)", () => {
  it("refuses an approval of an effect that is not critical", () => {
    // fs.write_text is a std function, not an effect that goes through prepare, authorize and commit.
    const ds = diagnostics(mutate("approve git.merge by", "approve fs.write_text by"));
    expect(pairs(ds)).toEqual([["MDT-E1704", "/defs/MigrateAll/envelope/approve/fs.write_text"]]);
    expect(ds[0]!.facts).toEqual({ effect: "fs.write_text", role: "release_manager", critical: false });
  });

  it("refuses an approval of a name that is no effect at all, as not critical", () => {
    const ds = diagnostics(mutate("approve git.merge by", "approve git.mrege by"));
    expect(pairs(ds)).toEqual([["MDT-E1704", "/defs/MigrateAll/envelope/approve/git.mrege"]]);
    expect(ds[0]!.facts).toEqual({ effect: "git.mrege", role: "release_manager", critical: false });
  });

  it("refuses git.merge when no capability of the envelope covers it, and lists what the envelope has", () => {
    const ds = diagnostics(mutate("ModelStd, Merge\n", "ModelStd\n"));
    expect(pairs(ds)).toEqual([["MDT-E1704", "/defs/MigrateAll/envelope/approve/git.merge"]]);
    expect(ds[0]!.facts).toEqual({
      effect: "git.merge",
      role: "release_manager",
      critical: true,
      available: ['Build = exec("npm")', "ModelStd = model.infer", 'RepoRead = fs.read("/work/repos")', 'SrcWrite = fs.write("/work/repos")'],
    });
  });
});

describe("plan outside an envelope (E1707)", () => {
  const PLAN = "  plan Lead.finish(repos, done) within envelope\n";

  it("refuses a plan in a workflow without an envelope, at the plan", () => {
    // MigrateAll with its own caps and budget in place of the envelope; Merge goes, since nothing would use it.
    const src = mutate(ENVELOPE, "  caps    RepoRead, SrcWrite, Build, ModelStd\n  budget  { tokens: 80000k, time: 6h, spend: 120 USD, steps: 2000 }\n");
    const ds = diagnostics(src);
    expect(pairs(ds)).toEqual([["MDT-E1707", "/defs/MigrateAll/body/1/value"]]);
    expect(ds[0]!.facts).toEqual({ def: "MigrateAll", kind: "workflow", envelope: false });
  });

  it("refuses a plan in a function's body, whoever calls it", () => {
    const src = `${MIGRATE_ALL}\nfn finishing(repos: List<Repo>, done: List<Outcome<Inferred<Summary>>>) -> Inferred<Summary> {\n${PLAN}}\n`;
    const ds = diagnostics(src);
    expect(pairs(ds)).toEqual([["MDT-E1707", "/defs/finishing/body/0/value"]]);
    expect(ds[0]!.facts).toEqual({ def: "finishing", kind: "fn", envelope: false });
  });

  it("refuses a plan in an on handler of a workflow that has an envelope, which is outside its body", () => {
    const ds = diagnostics(`${MIGRATE_ALL}\non timeout in MigrateAll => plan Lead.finish(repos, []) within envelope\n`);
    expect(pairs(ds)).toEqual([["MDT-E1707", "/defs/MigrateAll/on/0/then"]]);
    expect(ds[0]!.facts).toEqual({ def: "MigrateAll", kind: "workflow", envelope: true });
  });

  it("accepts a plan in the branches of an if in the body", () => {
    const branches = "  if len(repos) > 0 {\n    return plan Lead.finish(repos, done) within envelope\n  } else {\n    return plan Lead.finish(repos, done) within envelope\n  }\n";
    expect(pairs(diagnostics(mutate(PLAN, branches + PLAN)))).toEqual([]);
  });

  it("accepts a plan inside a block in the body", () => {
    // The text form has a block only as a switch arm; the IR wraps the plan in one directly.
    const src = changedIr((wf) => {
      const stmt = wf.body[1]!;
      if (stmt.op !== "expr") throw new Error("the plan is an expression statement");
      stmt.value = { op: "block", body: [{ op: "expr", value: stmt.value }] };
    });
    expect(pairs(diagnostics(src, "json"))).toEqual([]);
  });
});

describe("the envelope's budget holds the static part to steps and agents (E0501)", () => {
  it("refuses 150 agents for 150 Migrators and one Lead", () => {
    const ds = diagnostics(mutate("agents: 200", "agents: 150"));
    expect(pairs(ds)).toEqual([["MDT-E0501", "/defs/MigrateAll/envelope/budget"]]);
    expect(factsBut(ds[0]!)).toEqual({ agents: { limit: 150, declared_by_children: 151 } });
  });

  it("refuses 1,800 steps for 150 × 12 steps and the Lead's 40", () => {
    const ds = diagnostics(mutate("steps: 2000", "steps: 1800"));
    expect(pairs(ds)).toEqual([["MDT-E0501", "/defs/MigrateAll/envelope/budget"]]);
    expect(factsBut(ds[0]!)).toEqual({ steps: { limit: 1800, declared_by_children: 1840 } });
  });

  it("accepts exactly 151 agents and 1,840 steps", () => {
    expect(pairs(diagnostics(mutate("steps: 2000, agents: 200", "steps: 1840, agents: 151")))).toEqual([]);
  });

  // A small 0.4 program with an envelope, whose body is the case at hand. A has 3 steps, B 2.
  const counting = (body: string, budget: string, returns = "Bool"): string => `mandate @ 0.4

module example.count @ 0.1

use std.{model}

role owner_role "Owner"

capability M = model.infer(tier: standard)

agent A {
  role   "Answers."
  caps   M
  budget { steps: 3 }
  skill s(x: Text) -> Inferred<Text> ! {Model}
}

agent B {
  role   "Answers more cheaply."
  caps   M
  budget { steps: 2 }
  skill s(x: Text) -> Inferred<Text> ! {Model}
}

workflow W(x: Text, xs: List<Text>) -> ${returns}
  envelope {
    owner  owner_role
    caps   M
    budget ${budget}
  }
{
${body}
}
`;

  it("checks the small program cleanly with one delegation", () => {
    const r = check(counting("  let a = delegate A.s(x)\n  true", "{ steps: 3, agents: 1 }"), "mdt");
    expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  /** [what, body, agents, steps, returns]: the body counts exactly `agents` attempts and `steps` steps. */
  const CASES: Array<[string, string, number, number, string?]> = [
    ["restart(max: 2) is three attempts", "  let a = delegate A.s(x) supervise restart(max: 2)\n  true", 3, 9],
    ["degrade(to: B) adds one attempt, with B's steps", "  let a = delegate A.s(x) supervise degrade(to: B)\n  true", 2, 5],
    ["par branches add up", "  par {\n    a = delegate A.s(x)\n    b = delegate B.s(x)\n  }\n  true", 2, 5],
    [
      "an if takes the larger branch",
      '  if x == "a" {\n    let a = delegate A.s(x)\n  } else {\n    let b = delegate A.s(x) supervise restart(max: 3)\n  }\n  true',
      4,
      12,
    ],
    ["a map is max times its body", "  let r = map y in xs max 5 {\n    delegate A.s(y)\n  }\n  true", 5, 15],
    ["a plan is one agent, its lead", "  plan A.s(x) within envelope", 1, 3, "Inferred<Text>"],
  ];

  for (const [what, body, agents, steps, returns] of CASES) {
    it(`counts ${what}: ${agents} agents, ${steps} steps`, () => {
      expect(pairs(diagnostics(counting(body, `{ steps: ${steps}, agents: ${agents} }`, returns), "mdt", {}))).toEqual([]);
      const ds = diagnostics(counting(body, `{ steps: ${steps - 1}, agents: ${agents - 1} }`, returns), "mdt", {});
      expect(pairs(ds)).toEqual([["MDT-E0501", "/defs/W/envelope/budget"]]);
      expect(factsBut(ds[0]!)).toEqual({ steps: { limit: steps - 1, declared_by_children: steps }, agents: { limit: agents - 1, declared_by_children: agents } });
    });
  }

  // A workflow without an envelope whose delegation has more steps than the workflow's own budget.
  const own = (version: string): string => `mandate @ ${version}

module example.own @ 0.1

use std.{model}

capability M = model.infer(tier: standard)

agent A {
  caps   M
  budget { steps: 10 }
  skill s(x: Text) -> Inferred<Text> ! {Model}
}

workflow W(x: Text) -> Inferred<Text>
  caps   M
  budget { steps: 5 }
{
  delegate A.s(x)
}
`;

  for (const version of ["0.3", "0.4"]) {
    it(`does not compare steps for a ${version} workflow without an envelope, as before 0.4`, () => {
      const r = check(own(version), "mdt");
      expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
      // The steps do not fit, and still nothing is said.
      expect(staticCost(r.program!, "W")!.steps).toBe(10);
    });
  }
});

describe("the envelope's data class (E0220, spawn.max_class)", () => {
  // A confidential document handed to an agent whose model capability is `cap`.
  const classes = (spawn: string, cap: string, body = "  delegate A.s(d)"): string => `mandate @ 0.4

module example.classes @ 0.1

use std.{model}

role owner_role "Owner"

type Doc = { body: Text } classified confidential

capability M = ${cap}

agent A {
  role   "Summarizes."
  caps   M
  budget { steps: 3 }
  skill s(d: Doc) -> Inferred<Text> ! {Model}
}

workflow W(d: Doc) -> Inferred<Text>
  envelope {
    owner  owner_role
    caps   M
    budget { steps: 10, agents: 2 }${spawn}
  }
{
${body}
}
`;
  const CONFIDENTIAL_MODEL = "model.infer(tier: standard, max_class: confidential)";
  const RAISED = "\n    spawn  { max_class: confidential }";
  const facts = (ds: Diagnostic[]) => ds.map((d) => d.facts);

  it("is internal when the envelope does not say, and refuses a delegation that receives more", () => {
    const ds = diagnostics(classes("", CONFIDENTIAL_MODEL), "mdt", {});
    expect(pairs(ds)).toEqual([["MDT-E0220", "/defs/W/body/0/value"]]);
    expect(ds[0]!.facts).toEqual({ data_class: "confidential", allowed: "internal", by: "envelope" });
  });

  it("accepts the delegation once max_class is raised to its class", () => {
    expect(pairs(diagnostics(classes(RAISED, CONFIDENTIAL_MODEL), "mdt", {}))).toEqual([]);
  });

  it("is told apart from the agent's model capability by facts.by", () => {
    // The model capability allows internal only: both rules refuse the delegation.
    const both = diagnostics(classes("", "model.infer(tier: standard)"), "mdt", {});
    expect(pairs(both)).toEqual([
      ["MDT-E0220", "/defs/W/body/0/value"],
      ["MDT-E0220", "/defs/W/body/0/value"],
    ]);
    expect(facts(both)).toEqual([
      { data_class: "confidential", allowed: "internal" },
      { data_class: "confidential", allowed: "internal", by: "envelope" },
    ]);
    // Raising max_class takes away the envelope's, and the capability's stays.
    const raised = diagnostics(classes(RAISED, "model.infer(tier: standard)"), "mdt", {});
    expect(pairs(raised)).toEqual([["MDT-E0220", "/defs/W/body/0/value"]]);
    expect(facts(raised)).toEqual([{ data_class: "confidential", allowed: "internal" }]);
  });

  it("bounds a model call in the body too", () => {
    const infer = '  infer Text from quote("Summarize {d.body}")';
    const ds = diagnostics(classes("", CONFIDENTIAL_MODEL, infer), "mdt", {});
    expect(pairs(ds)).toEqual([["MDT-E0220", "/defs/W/body/0/value"]]);
    expect(ds[0]!.facts).toEqual({ data_class: "confidential", allowed: "internal", by: "envelope" });
    expect(pairs(diagnostics(classes(RAISED, CONFIDENTIAL_MODEL, infer), "mdt", {}))).toEqual([]);
  });
});

describe("the envelope's data class in what the workflow reaches (E0220, spawn.max_class)", () => {
  // The bound is on every delegation and model call in the run, so a function the body calls and the body of a
  // skill it delegates to are held to it too. `bounds` is the workflow's envelope, or its own caps and budget.
  const ENVELOPE = (spawn = "") => `envelope {\n    owner  owner_role\n    caps   M\n    budget { steps: 60, agents: 12 }${spawn}\n  }`;
  const RAISED = "\n    spawn  { max_class: confidential }";
  const reaches = (body: string, bounds = ENVELOPE()): string => `mandate @ 0.4

module example.reach @ 0.1

use std.{model}

role owner_role "Owner"

type Doc = { body: Text } classified confidential

capability M = model.infer(tier: standard, max_class: confidential)

agent A {
  role   "Summarizes."
  caps   M
  budget { steps: 3 }
  skill s(d: Doc) -> Inferred<Text> ! {Model}
  skill echo(t: Text) -> Inferred<Text> ! {Model}
}

agent Outer {
  role   "Makes a document of a text, and has it summarized."
  caps   M
  budget { steps: 3 }
  skill wrap(t: Text) -> Inferred<Text> ! {Delegate} {
    delegate A.s(Doc { body: t })
  }
  skill ask(t: Text) -> Inferred<Text> ! {Model} {
    let x = Doc { body: t }
    infer Text from quote("Summarize {x.body}")
  }
  skill relay(t: Text) -> Inferred<Text> ! {Delegate} {
    delegate Outer.wrap(t)
  }
  skill plain(t: Text) -> Inferred<Text> ! {Delegate} {
    delegate A.echo(t)
  }
}

fn via(d: Doc) -> Inferred<Text> {
  delegate A.s(d)
}

fn outer(d: Doc) -> Inferred<Text> {
  via(d)
}

fn label(d: Doc, t: Text) -> Inferred<Text> {
  delegate A.echo(t)
}

fn calm(t: Text) -> Inferred<Text> {
  delegate A.echo(t)
}

fn through(t: Text) -> Inferred<Text> {
  delegate Outer.wrap(t)
}

workflow W(d: Doc, t: Text) -> Inferred<Text>
  ${bounds}
{
  let first = delegate A.echo(t)
${body}
}
`;
  const AT = "/defs/W/body/1/value";
  const facts = (ds: Diagnostic[]) => ds.map((d) => d.facts);

  it("accepts the program when nothing in it receives more than internal data", () => {
    for (const body of ["  calm(t)", "  delegate Outer.plain(t)"]) expect(pairs(diagnostics(reaches(body), "mdt", {}))).toEqual([]);
  });

  it("refuses a delegation inside a function the body calls, at the call, however deep", () => {
    for (const [body, fn] of [["  via(d)", "via"], ["  outer(d)", "via"]] as const) {
      const ds = diagnostics(reaches(body), "mdt", {});
      expect(pairs(ds)).toEqual([["MDT-E0220", AT]]);
      expect(facts(ds)).toEqual([{ data_class: "confidential", allowed: "internal", by: "envelope", via: fn }]);
      expect(ds[0]!.message).toContain(`A.s receives confidential data inside ${fn}`);
      expect(pairs(diagnostics(reaches(body, ENVELOPE(RAISED)), "mdt", {}))).toEqual([]);
    }
  });

  it("holds a function to the class of what it is handed, whichever argument it passes on", () => {
    const ds = diagnostics(reaches("  label(d, t)"), "mdt", {});
    expect(pairs(ds)).toEqual([["MDT-E0220", AT]]);
    expect(facts(ds)).toEqual([{ data_class: "confidential", allowed: "internal", by: "envelope", via: "label" }]);
  });

  it("refuses a delegation in the body of a skill the workflow delegates to, where data first has the higher class", () => {
    const ds = diagnostics(reaches("  delegate Outer.wrap(t)"), "mdt", {});
    expect(pairs(ds)).toEqual([["MDT-E0220", "/defs/Outer/skills/wrap/body/0/value"]]);
    expect(facts(ds)).toEqual([{ data_class: "confidential", allowed: "internal", by: "envelope", workflow: "W", skill: "Outer.wrap" }]);
    expect(ds[0]!.message).toContain("A.s receives confidential data inside Outer.wrap, which W reaches");
    expect(pairs(diagnostics(reaches("  delegate Outer.wrap(t)", ENVELOPE(RAISED)), "mdt", {}))).toEqual([]);
  });

  it("refuses a model call in such a skill's body", () => {
    const ds = diagnostics(reaches("  delegate Outer.ask(t)"), "mdt", {});
    expect(pairs(ds)).toEqual([["MDT-E0220", "/defs/Outer/skills/ask/body/1/value"]]);
    expect(facts(ds)).toEqual([{ data_class: "confidential", allowed: "internal", by: "envelope", workflow: "W", skill: "Outer.ask" }]);
    expect(ds[0]!.message).toContain("confidential data is sent to a model inside Outer.ask");
  });

  it("follows a skill that delegates to another, and one a function delegates to, and reports each place once", () => {
    for (const body of ["  delegate Outer.relay(t)", "  through(t)", "  let again = delegate Outer.wrap(t)\n  delegate Outer.relay(t)"]) {
      const ds = diagnostics(reaches(body), "mdt", {});
      expect(pairs(ds)).toEqual([["MDT-E0220", "/defs/Outer/skills/wrap/body/0/value"]]);
      expect(facts(ds)).toEqual([{ data_class: "confidential", allowed: "internal", by: "envelope", workflow: "W", skill: "Outer.wrap" }]);
    }
  });

  it("is the envelope's rule: a workflow with caps and a budget of its own is not held to it", () => {
    const own = "caps   M\n  budget { steps: 60 }";
    for (const body of ["  via(d)", "  delegate Outer.wrap(t)", "  delegate Outer.ask(t)"]) expect(pairs(diagnostics(reaches(body, own), "mdt", {}))).toEqual([]);
  });
});

describe("the static cost of MigrateAll", () => {
  it("is the spec's numbers: 151 agents, 85 USD, 62,000k tokens, 1,840 steps, 3 h 20 min", () => {
    const p = migrateAll();
    const c = staticCost(p, "MigrateAll", link(p, modules()).defs)!;
    expect({ agents: c.agents, spend: c.spend, tokens: c.tokens, steps: c.steps, time: c.time }).toEqual({
      agents: 151,
      spend: { USD: 85_000_000 },
      tokens: 62_000_000,
      steps: 1840,
      time: 12_000_000,
    });
    expect(c.parts.map((x) => [x.from, x.at])).toEqual([
      ["Migrator.migrate ×150", "/defs/MigrateAll/body/0/value/body/0/value"],
      ["Lead.finish", "/defs/MigrateAll/body/1/value"],
    ]);
  });

  it("is undefined for a name that is not a workflow", () => {
    expect(staticCost(migrateAll(), "Lead")).toBeUndefined();
  });
});
