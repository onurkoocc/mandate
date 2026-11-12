// The language surface of 0.4 (spec/envelope.md): the spec's MigrateAll
// example checks, hashes, prints and reads back; its IR has the shape the spec
// gives; every 0.4 construct in an older program is refused by name (E0104);
// `map` and `plan` are typed; the envelope's caps and budget are the
// workflow's; the views show it; and changing an envelope is a governance
// change. Each rule is shown on one change to a program that checks.

import { describe, expect, it } from "vitest";
import { check, kindOf, loadModules } from "../src/check.js";
import { hashProgram } from "../src/hash.js";
import type { Program } from "../src/ir/types.js";
import { canonicalize } from "../src/json/jcs.js";
import type { Json } from "../src/json/strict-json.js";
import type { Modules } from "../src/modules.js";
import { RESERVED } from "../src/parse/parser.js";
import { applyPatch } from "../src/patch/patch.js";
import { printProgram } from "../src/print/printer.js";
import { architecture, authority, cost, semanticDiff } from "../src/views/views.js";
import { readRepo } from "./helpers.js";

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

function said(src: string, mods: Modules = modules()): Array<[string, string | undefined]> {
  return check(src, "mdt", { modules: mods }).diagnostics.map((d) => [d.code, d.at.path]);
}

function codesOf(src: string, mods: Modules = modules()): string[] {
  return check(src, "mdt", { modules: mods }).diagnostics.map((d) => d.code);
}

/** The map's body ends the workflow, so the workflow returns what the map returns. */
function returningTheMap(returns: string): string {
  const src = mutate("workflow MigrateAll(repos: List<Repo>) -> Inferred<Summary>", `workflow MigrateAll(repos: List<Repo>) -> ${returns}`);
  return mutate("  plan Lead.finish(repos, done) within envelope\n", "  done\n", src);
}

describe("MigrateAll, the spec's example", () => {
  it("checks with its domain module, without a diagnostic, warnings included", () => {
    const r = check(MIGRATE_ALL, "mdt", { modules: modules() });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    expect(r.program!.language).toBe("mandate/0.4");
  });

  it("checks without its domain module too, which is then opaque", () => {
    const r = check(MIGRATE_ALL, "mdt");
    expect(r.ok).toBe(true);
    expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  it("has a pinned program hash", () => {
    // A change to this hash is a change to the IR of 0.4 and needs a reason in the commit that makes it.
    expect(check(MIGRATE_ALL, "mdt", { modules: modules() }).hashes!.program).toBe("sha256:c6ca75ca9aed59eca642c289b5b503fba33889d68dea3b75839c87087a8b0e18");
  });

  it("prints to text that reads back to the same IR and hash, and printing again changes nothing", () => {
    const p = migrateAll();
    const printed = printProgram(p);
    const back = check(printed, "mdt", { modules: modules() });
    expect(back.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    expect(canonicalize(back.program as unknown as Json)).toBe(canonicalize(p as unknown as Json));
    expect(back.hashes!.program).toBe(hashProgram(p as unknown as Json).program);
    expect(printProgram(back.program!)).toBe(printed);
  });

  it("checks as JSON IR to the same hash", () => {
    const p = migrateAll();
    const r = check(JSON.stringify(p), "json", { modules: modules() });
    expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    expect(r.hashes!.program).toBe(hashProgram(p as unknown as Json).program);
  });
});

describe("the IR of 0.4, as spec/envelope.md gives it", () => {
  it("keeps the workflow's caps empty and puts the envelope beside them", () => {
    const wf = migrateAll().defs["MigrateAll"]!;
    expect(wf.kind).toBe("workflow");
    if (wf.kind !== "workflow") return;
    expect(wf.caps).toEqual([]);
    expect(wf.budget).toBeUndefined();
    expect(wf.envelope).toEqual({
      owner: "platform_lead",
      caps: ["Build", "Merge", "ModelStd", "RepoRead", "SrcWrite"].map((name) => ({ op: "var", name })),
      budget: { tokens: 80_000_000, spend: { micros: 120_000_000, currency: "USD" }, time: { ms: 21_600_000 }, steps: 2000, agents: 200 },
      spawn: { max_concurrent: 16, max_class: "internal" },
      approve: { "git.merge": "release_manager" },
    });
  });

  it("has a role as a definition with a description", () => {
    const p = migrateAll();
    expect(p.defs["platform_lead"]).toEqual({ kind: "role", description: "Platform lead" });
    expect(p.defs["release_manager"]).toEqual({ kind: "role", description: "Release manager" });
  });

  it("has map and plan as expressions", () => {
    const wf = migrateAll().defs["MigrateAll"]!;
    if (wf.kind !== "workflow") throw new Error("MigrateAll is a workflow");
    const [first, second] = wf.body;
    expect(first).toMatchObject({ op: "let", name: "done" });
    const map = (first as { value: Record<string, unknown> }).value;
    expect(map).toMatchObject({ op: "map", bind: "repo", over: { op: "var", name: "repos" }, max: 150, par: 16 });
    expect(map["caps"]).toEqual([
      { op: "call", callee: { op: "field", of: { op: "var", name: "SrcWrite" }, name: "narrow" }, args: [{ value: { op: "field", of: { op: "var", name: "repo" }, name: "root" } }] },
    ]);
    expect(map["body"]).toEqual([{ op: "expr", value: { op: "delegate", agent: "Migrator", skill: "migrate", args: [{ value: { op: "var", name: "repo" } }] } }]);
    expect(second).toEqual({
      op: "expr",
      value: { op: "plan", agent: "Lead", skill: "finish", args: [{ value: { op: "var", name: "repos" } }, { value: { op: "var", name: "done" } }] },
    });
  });
});

describe("a 0.4 construct in an older program is refused by name (E0104)", () => {
  it("names each construct of MigrateAll declared 0.3, at its place", () => {
    const r = check(mutate("mandate @ 0.4", "mandate @ 0.3"), "mdt", { modules: modules() });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => [d.code, d.at.path, d.facts])).toEqual([
      ["MDT-E0104", "/defs/platform_lead/kind", { kind: "role", language: "mandate/0.3" }],
      ["MDT-E0104", "/defs/release_manager/kind", { kind: "role", language: "mandate/0.3" }],
      ["MDT-E0104", "/defs/MigrateAll/envelope", { field: "envelope", language: "mandate/0.3" }],
      ["MDT-E0104", "/defs/MigrateAll/body/0/value", { op: "map", language: "mandate/0.3" }],
      ["MDT-E0104", "/defs/MigrateAll/body/1/value", { op: "plan", language: "mandate/0.3" }],
      ["MDT-E0104", "/defs/MigrateAll/envelope/budget/agents", { field: "agents", language: "mandate/0.3" }],
    ]);
  });

  const program = (version: string, body: string) => `mandate @ ${version}

module example.gate @ 0.1

use std.{model}

capability M = model.infer(tier: standard)

${body}
`;
  const agent = (budget: string) => `agent A {
  caps   M
  budget ${budget}
  skill s(x: Text) -> Inferred<Text> ! {Model}
}`;

  /** One program per construct: in 0.3 the construct is the only thing newer than the program. */
  const ONE: Record<string, { body: string; at: string; facts: Record<string, string> }> = {
    role: { body: `role auditor "Auditor"`, at: "/defs/auditor/kind", facts: { kind: "role" } },
    envelope: {
      body: `workflow W(x: Text) -> Text\n  envelope {\n    owner auditor\n    caps  M\n    budget { steps: 2 }\n  }\n{\n  x\n}`,
      at: "/defs/W/envelope",
      facts: { field: "envelope" },
    },
    agents: { body: agent("{ steps: 2, agents: 3 }"), at: "/defs/A/budget/agents", facts: { field: "agents" } },
    map: { body: `workflow W(xs: List<Text>) -> List<Outcome<Text>>\n  caps M\n{\n  map x in xs max 3 {\n    x\n  }\n}`, at: "/defs/W/body/0/value", facts: { op: "map" } },
    plan: { body: `${agent("{ steps: 2 }")}\n\nworkflow W(x: Text) -> Inferred<Text>\n  caps M\n{\n  plan A.s(x) within envelope\n}`, at: "/defs/W/body/0/value", facts: { op: "plan" } },
  };

  for (const [construct, { body, at, facts }] of Object.entries(ONE)) {
    it(`refuses ${construct} alone in a 0.3 program, and not in 0.4`, () => {
      const old = check(program("0.3", body), "mdt").diagnostics;
      expect(old.map((d) => [d.code, d.at.path, d.facts])).toEqual([["MDT-E0104", at, { ...facts, language: "mandate/0.3" }]]);
      expect(old.every((d) => d.code === "MDT-E0104")).toBe(true);
      expect(codesOf(program("0.4", body), {})).not.toContain("MDT-E0104");
    });
  }

  it("refuses agents in a 0.1 and a 0.2 program as well", () => {
    for (const version of ["0.1", "0.2"]) {
      expect(said(program(version, agent("{ steps: 2, agents: 3 }")), {}), version).toEqual([["MDT-E0104", "/defs/A/budget/agents"]]);
    }
  });
});

describe("Outcome is a built-in type from 0.4", () => {
  const program = (version: string) => `mandate @ ${version}

module example.outcome @ 0.1

type Result = { item: Outcome<Text> }
`;

  it("is unknown in a 0.3 program (E0120) and known in a 0.4 one", () => {
    expect(said(program("0.3"), {})).toEqual([["MDT-E0120", "/defs/Result/type/record/item/ref"]]);
    const r = check(program("0.4"), "mdt");
    expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });
});

describe("0.4 adds no reserved words", () => {
  // The words of the new forms are contextual: an older program that uses them as names reads as before.
  const WORDS = ["map", "plan", "role", "envelope", "max", "agents", "within"];

  it("does not reserve the words of the new forms", () => {
    for (const w of WORDS) expect(RESERVED.has(w), w).toBe(false);
  });

  for (const version of ["0.1", "0.4"]) {
    it(`lets a ${version} program use them as parameters, variables and record fields`, () => {
      const src = `mandate @ ${version}

module example.words @ 0.1

type R = { ${WORDS.map((w) => `${w}: Text`).join(", ")} }

fn f(${WORDS.map((w) => `${w}: Text`).join(", ")}) -> R {
${WORDS.map((w) => `  let ${w}_copy = ${w}`).join("\n")}
  let first = map
  let n = len([map, plan])
  R { ${WORDS.map((w) => `${w}: ${w}`).join(", ")} }
}
`;
      const r = check(src, "mdt");
      expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
      expect(Object.keys((r.program!.defs["R"] as { type: { record: Record<string, unknown> } }).type.record)).toEqual(WORDS);
    });
  }
});

describe("typing of map", () => {
  it("gives a List<Outcome<T>> for a body of type T", () => {
    const ok = check(returningTheMap("List<Outcome<Inferred<Summary>>>"), "mdt", { modules: modules() });
    expect(ok.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
    const plain = check(returningTheMap("List<Inferred<Summary>>"), "mdt", { modules: modules() });
    expect(plain.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.at.path, d.message])).toEqual([
      ["MDT-E0201", "/defs/MigrateAll/body/1/value", "Expected List<Inferred<Summary>> but got List<Outcome<Inferred<Summary>>>."],
    ]);
  });

  it("runs over a List only (E0201 at over)", () => {
    const src = mutate("map repo in repos max", "map repo in one max", mutate("workflow MigrateAll(repos: List<Repo>)", "workflow MigrateAll(repos: List<Repo>, one: Repo)"));
    expect(said(src)).toEqual([["MDT-E0201", "/defs/MigrateAll/body/0/value/over"]]);
  });

  // In the next three the map runs a dozen items one at a time: side by side, a write scope every item shares is E0320.
  const IN_TURN = mutate(" max 150 par 16", " max 12");

  it("hands its body only capabilities the context holds (E0701)", () => {
    const wide = mutate('capability SrcWrite = fs.write("/work/repos")', 'capability SrcWrite = fs.write("/work/repos")\ncapability Wide     = fs.write("/work")', IN_TURN);
    expect(said(wide)).toEqual([]);
    expect(said(mutate("with caps SrcWrite.narrow(repo.root)", "with caps Wide", wide))).toEqual([["MDT-E0701", "/defs/MigrateAll/body/0/value/caps/0"]]);
  });

  it("hands its capabilities to the delegations of its body, as if each named them", () => {
    // A scope that is known statically narrows what the item's agent is granted; the delegation needs no `with caps`.
    const narrow = mutate("with caps SrcWrite.narrow(repo.root)", 'with caps SrcWrite.narrow("/work/repos/a")', IN_TURN);
    expect(said(narrow)).toEqual([]);
    const row = authority(check(narrow, "mdt", { modules: modules() }).program!).rows.find((r) => r.kind === "delegation" && r.who.includes("Migrator.migrate"))!;
    expect(row.write).toEqual(["/work/repos/a"]);
    expect(row.read).toEqual(["/work/repos"]);
    // Without the map's `with caps` the agent is granted what it holds inside the envelope.
    const whole = authority(check(mutate(" with caps SrcWrite.narrow(repo.root)", "", IN_TURN), "mdt", { modules: modules() }).program!).rows.find((r) => r.kind === "delegation" && r.who.includes("Migrator.migrate"))!;
    expect(whole.write).toEqual(["/work/repos"]);
  });

  it("lets a delegation of its body narrow further, and only inside what the map hands it (E0701)", () => {
    const inside = mutate("delegate Migrator.migrate(repo)", 'delegate Migrator.migrate(repo) with caps SrcWrite.narrow("/work/repos/a/src")', mutate("with caps SrcWrite.narrow(repo.root)", 'with caps SrcWrite.narrow("/work/repos/a")', IN_TURN));
    expect(said(inside)).toEqual([]);
    expect(said(mutate('SrcWrite.narrow("/work/repos/a/src")', 'SrcWrite.narrow("/work/repos/b")', inside))).toEqual([["MDT-E0701", "/defs/MigrateAll/body/0/value/body/0/value/caps/0"]]);
  });

  it("hands a capability only to an agent that holds that kind (E0301)", () => {
    // Migrator writes elsewhere, outside the envelope: the map's narrowed write is not one it holds, so it is
    // not handed to it, and nothing in the delegation's grant covers the skill's Fs.Write.
    const elsewhere = mutate('capability SrcWrite = fs.write("/work/repos")', 'capability SrcWrite = fs.write("/work/repos")\ncapability Elsewhere = fs.write("/work/elsewhere")');
    const src = mutate("caps   RepoRead, SrcWrite, Build, ModelStd", "caps   RepoRead, Elsewhere, Build, ModelStd", elsewhere);
    expect(said(src)).toEqual([["MDT-E0301", "/defs/MigrateAll/body/0/value/body/0/value"]]);
  });

  it("never lets model output choose a scope it hands its body (E0215)", () => {
    const r = check(mutate("workflow MigrateAll(repos: List<Repo>)", "workflow MigrateAll(repos: Inferred<List<Repo>>)"), "mdt", { modules: modules() });
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toContainEqual(["MDT-E0215", "/defs/MigrateAll/body/0/value/caps/0/args/0/value"]);
    expect(codesOf(MIGRATE_ALL)).not.toContain("MDT-E0215");
  });

  it("takes fail_fast but not restart_all (E0714)", () => {
    expect(said(mutate("par 16 with", "par 16 supervise fail_fast with"))).toEqual([]);
    const r = check(mutate("par 16 with", "par 16 supervise restart_all with"), "mdt", { modules: modules() });
    expect(r.diagnostics.map((d) => [d.code, d.at.path, d.facts])).toEqual([["MDT-E0714", "/defs/MigrateAll/body/0/value/supervise", { strategy: "restart_all", allowed: ["fail_fast"] }]]);
  });
});

describe("plan", () => {
  it("names an agent and a skill (E0120)", () => {
    const agent = check(mutate("plan Lead.finish", "plan Leed.finish"), "mdt", { modules: modules() }).diagnostics;
    expect(agent.map((d) => [d.code, d.at.path, d.facts?.["did_you_mean"]])).toEqual([["MDT-E0120", "/defs/MigrateAll/body/1/value/agent", "Lead"]]);
    const skill = check(mutate("plan Lead.finish", "plan Lead.finnish"), "mdt", { modules: modules() }).diagnostics;
    expect(skill.map((d) => [d.code, d.at.path, d.facts?.["did_you_mean"]])).toEqual([["MDT-E0120", "/defs/MigrateAll/body/1/value/skill", "finish"]]);
  });

  it("passes the skill's arguments, as many and of the types it takes (E0201)", () => {
    expect(said(mutate("plan Lead.finish(repos, done)", "plan Lead.finish(repos)"))).toEqual([["MDT-E0201", "/defs/MigrateAll/body/1/value"]]);
    expect(said(mutate("plan Lead.finish(repos, done)", "plan Lead.finish(done, done)"))).toEqual([["MDT-E0201", "/defs/MigrateAll/body/1/value/args/0/value"]]);
  });
});

describe("the envelope's budget is the workflow's (E0501)", () => {
  it("fits the spec's numbers: 85 USD, 62,000k tokens, 3 h 20 min", () => {
    // 150 × 0.5 USD + 10 USD; 150 × 400k + 2000k tokens; ⌈150 / 16⌉ × 20 min.
    expect(codesOf(MIGRATE_ALL)).toEqual([]);
  });

  it("refuses a map whose items hand out more money than the envelope has", () => {
    // 300 × 0.5 USD for the items alone is 150 USD; with the lead's 10 USD, 160 USD against 120 USD.
    const r = check(mutate("max 150", "max 300"), "mdt", { modules: modules() });
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toEqual([["MDT-E0501", "/defs/MigrateAll/envelope/budget"]]);
    expect(r.diagnostics[0]!.facts!["spend"]).toEqual({ limit: "120 USD", declared_by_children: "160 USD" });
  });

  it("counts a map's time as ⌈n / k⌉ times one item's", () => {
    // par 1: 150 × 20 min = 50 h against 6 h; money and tokens still fit.
    const r = check(mutate("par 16", "par 1"), "mdt", { modules: modules() });
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toEqual([["MDT-E0501", "/defs/MigrateAll/envelope/budget"]]);
    expect(Object.keys(r.diagnostics[0]!.facts!).filter((k) => k !== "breakdown")).toEqual(["time_ms"]);
    expect(r.diagnostics[0]!.facts!["time_ms"]).toEqual({ limit: 21_600_000, declared_by_children: 150 * 1_200_000 });
  });
});

describe("unused capabilities of an envelope (W0310)", () => {
  it("does not report Merge, which MigrateAll holds for its sub-programs", () => {
    expect(codesOf(MIGRATE_ALL)).not.toContain("MDT-W0310");
  });

  it("reports a capability nothing uses when the workflow does not plan", () => {
    const r = check(returningTheMap("List<Outcome<Inferred<Summary>>>"), "mdt", { modules: modules() });
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toEqual([["MDT-W0310", "/defs/MigrateAll/envelope/caps/1"]]);
    expect(r.diagnostics[0]!.message).toContain("Merge");
  });
});

describe("views of a workflow with an envelope", () => {
  it("draws the map, its body and the plan", () => {
    const [wf] = architecture(migrateAll()).workflows;
    expect(wf!.workflow).toBe("MigrateAll");
    expect(wf!.nodes.map((n) => [n.kind, n.label])).toEqual([
      ["map", "map repo"],
      ["delegate", "Migrator.migrate"],
      ["delegate", "plan Lead.finish"],
    ]);
    expect(wf!.nodes[0]!.detail).toEqual(expect.arrayContaining(["at most 150 items", "16 at a time"]));
    expect(wf!.edges).toEqual([
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
    ]);
  });

  it("costs the map's body 150 times and the lead once, against the envelope's budget", () => {
    const [wf] = cost(migrateAll()).workflows;
    expect(wf!.rows.map((r) => [r.call, r.times])).toEqual([
      ["Migrator.migrate", 150],
      ["Lead.finish", 1],
    ]);
    expect(wf!.total).toBe("85 USD · 62000000 tokens · 1840 steps · 151 agents");
    expect(wf!.limit).toContain("200 agents");
    expect(wf!.limit).toContain("120 USD");
  });

  it("gives the workflow the envelope's authority, the pull requests of Merge included", () => {
    const row = authority(migrateAll()).rows.find((r) => r.who === "MigrateAll")!;
    expect(row.kind).toBe("workflow");
    expect(row.repos).toEqual(["company/backend", "company/frontend"]);
    expect(row.write).toEqual(["/work/repos"]);
  });
});

describe("changing an envelope is a governance change", () => {
  it("is reported by a patch that raises the envelope's spend", () => {
    const p = migrateAll();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "replace", path: "/defs/MigrateAll/envelope/budget/spend", value: { micros: 150_000_000, currency: "USD" } }], modules());
    expect(r.ok).toBe(true);
    expect(r.governance).toEqual([{ kind: "envelope_changed", path: "/defs/MigrateAll/envelope", detail: expect.any(String) }]);
  });

  it("is reported by a patch that raises the envelope's agents", () => {
    const p = migrateAll();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "replace", path: "/defs/MigrateAll/envelope/budget/agents", value: 300 }], modules());
    expect(r.ok).toBe(true);
    expect(r.governance).toEqual([{ kind: "envelope_changed", path: "/defs/MigrateAll/envelope", detail: "~ MigrateAll: envelope changed" }]);
  });

  it("is reported by a patch that removes an envelope, or adds one", () => {
    const p = migrateAll();
    const r = applyPatch(p, hashProgram(p as unknown as Json).program, [{ op: "remove", path: "/defs/MigrateAll/envelope" }], modules());
    expect(r.ok).toBe(true);
    expect(r.governance).toEqual([{ kind: "envelope_changed", path: "/defs/MigrateAll/envelope", detail: "~ MigrateAll: envelope removed" }]);
    const without = r.program!;
    const back = applyPatch(without, r.hash!, [{ op: "add", path: "/defs/MigrateAll/envelope", value: (p.defs["MigrateAll"] as { envelope: unknown }).envelope }], modules());
    expect(back.ok).toBe(true);
    expect(back.governance).toEqual([{ kind: "envelope_changed", path: "/defs/MigrateAll/envelope", detail: "~ MigrateAll: envelope added" }]);
  });

  it("is reported, with the envelope's capabilities, for a new workflow with an envelope", () => {
    const p = migrateAll();
    const r = applyPatch(p, hashProgram(p as unknown as Json).program, [{ op: "add", path: "/defs/MigrateAgain", value: p.defs["MigrateAll"] }], modules());
    expect(r.ok).toBe(true);
    expect(r.governance.map((g) => [g.kind, g.path])).toEqual([
      ["capability_added", "/defs/MigrateAgain/envelope/caps/0"],
      ["capability_added", "/defs/MigrateAgain/envelope/caps/1"],
      ["capability_added", "/defs/MigrateAgain/envelope/caps/2"],
      ["capability_added", "/defs/MigrateAgain/envelope/caps/3"],
      ["capability_added", "/defs/MigrateAgain/envelope/caps/4"],
      ["envelope_changed", "/defs/MigrateAgain/envelope"],
    ]);
  });

  it("is not reported by a patch that lowers a map's max", () => {
    const p = migrateAll();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "replace", path: "/defs/MigrateAll/body/0/value/max", value: 100 }], modules());
    expect(r.ok).toBe(true);
    expect(r.governance).toEqual([]);
  });

  it("is listed under governance in the semantic diff", () => {
    const before = migrateAll();
    const after = check(mutate("spend: 120 USD", "spend: 150 USD"), "mdt", { modules: modules() }).program!;
    const v = semanticDiff(before, after);
    expect(v.governance.map((g) => g.path)).toEqual(["/defs/MigrateAll/envelope"]);
    expect(v.behavior).toEqual([]);
    const smaller = check(mutate("max 150", "max 100"), "mdt", { modules: modules() }).program!;
    expect(semanticDiff(before, smaller).governance).toEqual([]);
  });
});

describe("syntax errors of the new forms", () => {
  it("refuses an envelope field given twice, as any repeated field (E0121)", () => {
    // The spec names no code; the parser reports every repeated field, member or option as E0121.
    const r = check(mutate("    owner   platform_lead\n", "    owner   platform_lead\n    owner   platform_lead\n"), "mdt");
    expect(r.diagnostics.map((d) => [d.code, d.facts])).toEqual([["MDT-E0121", { name: "owner" }]]);
  });

  const SYNTAX: Array<[string, string, string]> = [
    ["an empty spawn", "{ max_concurrent: 16, max_class: internal }", "{ }"],
    ["max 0", "max 150", "max 0"],
    ["par 0", "par 16", "par 0"],
    ["a plan without within envelope", "plan Lead.finish(repos, done) within envelope", "plan Lead.finish(repos, done)"],
    ["an unknown envelope field", "    owner   platform_lead\n", "    owner   platform_lead\n    deadline 6h\n"],
    ["an unknown spawn field", "max_class: internal", "max_class: internal, max_depth: 2"],
    ["an unknown data class", "max_class: internal", "max_class: secret"],
  ];
  for (const [what, from, to] of SYNTAX) {
    it(`refuses ${what} (E0101)`, () => {
      expect(codesOf(mutate(from, to))).toEqual(["MDT-E0101"]);
    });
  }

  it("names agents among the budget fields of a 0.4 program only", () => {
    const old = check(mutate("steps: 2000, agents: 200", "steps: 2000, agentz: 200", mutate("mandate @ 0.4", "mandate @ 0.3")), "mdt").diagnostics;
    expect(old.map((d) => [d.code, d.message])).toEqual([["MDT-E0101", "Unknown budget field 'agentz'; expected tokens, spend, time or steps."]]);
    const now = check(mutate("steps: 2000, agents: 200", "steps: 2000, agentz: 200"), "mdt").diagnostics;
    expect(now.map((d) => [d.code, d.message])).toEqual([["MDT-E0101", "Unknown budget field 'agentz'; expected tokens, spend, time, steps or agents."]]);
  });
});
