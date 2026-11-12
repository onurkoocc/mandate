// The static rules of `map` (spec/envelope.md "map", "Static checks"): a map
// says how many elements it accepts (E1702), runs no more items at once than
// the envelope lets delegations be in flight (E1703), waits for no person and
// runs no critical effect in its body (E1708), hands items that run side by
// side scopes of their own to write (E0320), and fits its body in its budget
// (E0501, E0504). Last, the static cost a map adds to its workflow. Each rule
// is shown refused and in its nearest accepted form, and each test names every
// diagnostic the check gives.

import { describe, expect, it } from "vitest";
import { check, kindOf, loadModules } from "../src/check.js";
import { staticCost } from "../src/check/cost.js";
import type { Diagnostic } from "../src/diag.js";
import type { Modules } from "../src/modules.js";
import { cost as costView } from "../src/views/views.js";
import { readRepo } from "./helpers.js";

function diagnostics(src: string, mods: Modules = {}): Diagnostic[] {
  return check(src, "mdt", { modules: mods }).diagnostics;
}

const pairs = (ds: Diagnostic[]): Array<[string, string | undefined]> => ds.map((d) => [d.code, d.at.path]);

/** A diagnostic's facts without the breakdown, which only explains them. */
function factsBut(d: Diagnostic): Record<string, unknown> {
  const { breakdown: _, ...rest } = d.facts ?? {};
  return rest;
}

/** `src` with one textual change; fails loudly if the text is gone. */
function mutate(src: string, from: string, to: string): string {
  expect(src.includes(from), from).toBe(true);
  return src.replace(from, to);
}

/** The workflow's envelope: `caps` must all be used, or W0310 says so. */
const ENVELOPE = (caps = "M", spawn = "\n    spawn  { max_concurrent: 4 }", budget = "{ steps: 60, agents: 12 }"): string =>
  `envelope {\n    owner  owner_role\n    caps   ${caps}\n    budget ${budget}${spawn}\n  }`;
/** A workflow's own caps and budget, in place of an envelope. */
const OWN = "caps   M\n  budget { steps: 60 }";

/**
 * A small 0.4 program whose workflow body is the case at hand. A answers in 3 steps; Writer writes one item in 5.
 * The functions each hold one thing that waits for a person, or none.
 */
const program = (body: string, bounds = ENVELOPE()): string => `mandate @ 0.4

module example.maps @ 0.1

use std.{fs, git, human, model}

role owner_role "Owner"

type Item = { name: Text, root: Path }

capability M  = model.infer(tier: standard)
capability W  = fs.write("/work")
capability PR = git.pr("company/backend")

agent A {
  role   "Answers."
  caps   M
  budget { steps: 3 }
  skill s(t: Text) -> Inferred<Text> ! {Model}
}

agent Writer {
  role   "Writes one item."
  caps   M, W
  budget { steps: 5 }
  skill w(i: Item) -> Inferred<Text> ! {Fs.Write, Model}
}

contract Approved(t: Text) {
  accept ok "The owner approved it" by human.approve(role: owner_role)
}

fn ask(t: Text) -> Untrusted<Text> {
  human.ask(t, role: owner_role)
}

fn raise(t: Text) -> Text {
  escalate human(t, role: owner_role)
}

fn wait(t: Text) -> Text {
  pause
}

fn approved(t: Text) -> Verified<Text, Approved> {
  verify t against Approved(t)
}

fn watched(t: Text) -> Inferred<Text> {
  delegate A.s(t) supervise escalate(human, role: owner_role)
}

fn outer(t: Text) -> Text {
  raise(t)
}

fn helper(t: Text) -> Inferred<Text> {
  delegate A.s(t)
}

fn store(i: Item) -> Inferred<Text> {
  delegate Writer.w(i)
}

fn plain(t: Text) -> Text {
  t
}

workflow Run(items: List<Item>, t: Text, p: Path) -> Bool
  ${bounds}
{
${body}
  true
}
`;

/** `let r = map x in items <opts> { <body> }`, the first statement of the workflow. */
const map = (opts: string, body: string): string => `  let r = map x in items ${opts} {\n    ${body}\n  }`;
/** A delegation after the map, so that the envelope's M is used when the map's body does not use it. */
const AFTER = "\n  let after = delegate A.s(t)";
const MAP = "/defs/Run/body/0/value";
const STEP = `${MAP}/body/0/value`;

describe("an unbounded map (E1702)", () => {
  it("refuses a map with no max in a workflow without an envelope, at the map", () => {
    const ds = diagnostics(program(map("", "delegate A.s(x.name)"), OWN));
    expect(pairs(ds)).toEqual([["MDT-E1702", MAP]]);
    expect(ds[0]!.facts).toEqual({ envelope: false });
  });

  it("accepts the same map once it says max 3", () => {
    expect(pairs(diagnostics(program(map("max 3", "delegate A.s(x.name)"), OWN)))).toEqual([]);
  });

  it("refuses a map with no max in a function's body, even beside a workflow with an envelope", () => {
    const src = mutate(program(map("max 3", "delegate A.s(x.name)")), "workflow Run", "fn each(xs: List<Item>) -> Bool {\n  let r = map x in xs {\n    x.name\n  }\n  true\n}\n\nworkflow Run");
    const ds = diagnostics(src);
    expect(pairs(ds)).toEqual([["MDT-E1702", "/defs/each/body/0/value"]]);
    expect(ds[0]!.facts).toEqual({ envelope: false });
  });

  it("refuses a map with no max inside an envelope when its body starts no delegation", () => {
    const ds = diagnostics(program(map("", "x.name") + AFTER));
    expect(pairs(ds)).toEqual([["MDT-E1702", MAP]]);
    expect(ds[0]!.facts).toEqual({ envelope: true, delegates: false });
  });

  it("accepts that body inside an envelope with max 3", () => {
    expect(pairs(diagnostics(program(map("max 3", "x.name") + AFTER)))).toEqual([]);
  });

  it("accepts a map with no max inside an envelope when its body delegates, also inside an if", () => {
    expect(pairs(diagnostics(program(map("", "delegate A.s(x.name)"))))).toEqual([]);
    expect(pairs(diagnostics(program(map("", 'if x.name == "a" {\n      delegate A.s(x.name)\n    }'))))).toEqual([]);
  });

  it("accepts a map with no max inside an envelope when a function its body calls delegates", () => {
    // A map with no max takes all 12 agents, so M is used by a model call after it, not by a 13th delegation.
    const infer = '\n  let n = infer Text from quote("Say {t}")';
    expect(pairs(diagnostics(program(map("", "helper(x.name)") + infer)))).toEqual([]);
    // The nearest refused form: a function that does not delegate.
    expect(pairs(diagnostics(program(map("", "plain(x.name)") + infer)))).toEqual([["MDT-E1702", MAP]]);
  });
});

describe("map concurrency above the envelope (E1703)", () => {
  it("refuses par 5 when the envelope lets 4 delegations be in flight, at par", () => {
    const ds = diagnostics(program(map("max 3 par 5", "delegate A.s(x.name)")));
    expect(pairs(ds)).toEqual([["MDT-E1703", `${MAP}/par`]]);
    expect(ds[0]!.facts).toEqual({ par: 5, max_concurrent: 4 });
  });

  it("accepts par equal to max_concurrent", () => {
    expect(pairs(diagnostics(program(map("max 3 par 4", "delegate A.s(x.name)"))))).toEqual([]);
  });

  it("says nothing when the envelope names no max_concurrent, or there is no envelope", () => {
    expect(pairs(diagnostics(program(map("max 3 par 50", "delegate A.s(x.name)"), ENVELOPE("M", ""))))).toEqual([]);
    expect(pairs(diagnostics(program(map("max 3 par 50", "delegate A.s(x.name)"), OWN)))).toEqual([]);
  });
});

describe("a person in a map body (E1708)", () => {
  const person = (what: string, map = MAP, via?: string) => ({ map, kind: "person", what, ...(via ? { via } : {}) });

  it("refuses human.ask and human.approve in the body, at the call, as a human step", () => {
    for (const step of ["human.ask(x.name, role: owner_role)", "human.approve(role: owner_role)"]) {
      const ds = diagnostics(program(map("max 3", step) + AFTER));
      expect(pairs(ds), step).toEqual([["MDT-E1708", STEP]]);
      expect(ds[0]!.facts).toEqual(person("human step"));
    }
  });

  it("accepts the same steps before and after the map", () => {
    const src = program(`  let q = human.ask(t, role: owner_role)\n${map("max 3", "delegate A.s(x.name)")}\n  let z = human.approve(role: owner_role)`);
    expect(pairs(diagnostics(src))).toEqual([]);
  });

  it("finds a human step nested in an if or a par branch of the body", () => {
    const inIf = diagnostics(program(map("max 3", 'if x.name == "a" {\n      human.ask(x.name, role: owner_role)\n    }') + AFTER));
    expect(pairs(inIf)).toEqual([["MDT-E1708", `${MAP}/body/0/then/0/value`]]);
    expect(inIf[0]!.facts).toEqual(person("human step"));
    const inPar = diagnostics(program(map("max 3", "par {\n      a = human.ask(x.name, role: owner_role)\n      b = delegate A.s(x.name)\n    }")));
    expect(pairs(inPar)).toEqual([["MDT-E1708", `${MAP}/body/0/branches/a`]]);
    expect(inPar[0]!.facts).toEqual(person("human step"));
  });

  it("refuses escalate in the body, and names the inner map when it stands in one", () => {
    const ds = diagnostics(program(map("max 3", "escalate human(x.name, role: owner_role)") + AFTER));
    expect(pairs(ds)).toEqual([["MDT-E1708", STEP]]);
    expect(ds[0]!.facts).toEqual(person("escalate"));
    const inner = diagnostics(program(map("max 3", "map y in items max 2 {\n      escalate human(y.name, role: owner_role)\n    }") + AFTER));
    expect(pairs(inner)).toEqual([["MDT-E1708", `${STEP}/body/0/value`]]);
    expect(inner[0]!.facts).toEqual(person("escalate", STEP));
  });

  it("counts an envelope's capability as used by a delegation inside a function the body calls (W0310)", () => {
    // Nothing but the function's delegation uses M and W here.
    expect(pairs(diagnostics(program("  let one = store(Item { name: t, root: p })", ENVELOPE("M, W"))))).toEqual([]);
    // A workflow's own capabilities are reported as they were before 0.4.
    expect(pairs(diagnostics(program("  let one = helper(t)", OWN)))).toEqual([["MDT-W0310", "/defs/Run/caps/0"]]);
  });

  it("reports a human step in a map inside a map once, for the inner map", () => {
    const ds = diagnostics(program(map("max 3", "map y in items max 2 {\n      human.ask(y.name, role: owner_role)\n    }") + AFTER));
    expect(pairs(ds)).toEqual([["MDT-E1708", `${STEP}/body/0/value`]]);
    expect(ds[0]!.facts).toEqual(person("human step", STEP));
  });

  it("refuses a pause with nothing after it, and accepts pause and a value", () => {
    const ds = diagnostics(program(map("max 3", "pause") + AFTER));
    expect(pairs(ds)).toEqual([["MDT-E1708", STEP]]);
    expect(ds[0]!.facts).toEqual(person("pause"));
    expect(pairs(diagnostics(program(map("max 3", "pause and x.name") + AFTER)))).toEqual([]);
  });

  it("refuses a delegation supervised by escalate(human), at its supervise, and accepts restart", () => {
    const ds = diagnostics(program(map("max 3", "delegate A.s(x.name) supervise escalate(human, role: owner_role)")));
    expect(pairs(ds)).toEqual([["MDT-E1708", `${STEP}/supervise`]]);
    expect(ds[0]!.facts).toEqual(person("supervise escalate"));
    expect(pairs(diagnostics(program(map("max 3", "delegate A.s(x.name) supervise restart(max: 1)"))))).toEqual([]);
  });

  it("refuses a verify against a contract that a person approves, and accepts it before the map", () => {
    const ds = diagnostics(program(map("max 3", "verify x.name against Approved(x.name)") + AFTER));
    expect(pairs(ds)).toEqual([["MDT-E1708", STEP]]);
    expect(ds[0]!.facts).toEqual(person("verify against Approved"));
    expect(pairs(diagnostics(program(`  let v = verify t against Approved(t)\n${map("max 3", "delegate A.s(x.name)")}`)))).toEqual([]);
  });

  /** [function, what it holds, via]: a call of each in the body is refused at the call. */
  const CALLS: Array<[string, string, string?]> = [
    ["raise", "escalate", "raise"],
    ["wait", "pause", "wait"],
    ["approved", "verify against Approved", "approved"],
    ["watched", "supervise escalate", "watched"],
    ["outer", "escalate", "outer"],
    ["ask", "human step"],
  ];
  for (const [fn, what, via] of CALLS) {
    it(`refuses a call of ${fn}, which holds ${what}${via ? ", naming the function" : ", as the human step it is"}`, () => {
      const ds = diagnostics(program(map("max 3", `${fn}(x.name)`) + AFTER));
      expect(pairs(ds)).toEqual([["MDT-E1708", STEP]]);
      expect(ds[0]!.facts).toEqual(person(what, MAP, via));
    });
  }

  it("accepts a call of a function that waits for nobody", () => {
    expect(pairs(diagnostics(program(map("max 3", "plain(x.name)") + AFTER)))).toEqual([]);
  });

  it("accepts every one of those functions called outside the map", () => {
    const calls = ["ask", "raise", "wait", "approved", "watched", "outer"].map((f, i) => `  let c${i} = ${f}(t)\n`).join("");
    expect(pairs(diagnostics(program(calls + map("max 3", "delegate A.s(x.name)"))))).toEqual([]);
  });
});

describe("a critical effect in a map body (E1708)", () => {
  const COMMENT = 'effect git.comment(x.name, "seen") idempotent_by x.name';

  it("refuses git.comment in the body, at the effect", () => {
    const ds = diagnostics(program(map("max 3", COMMENT) + AFTER, ENVELOPE("M, PR")));
    expect(pairs(ds)).toEqual([["MDT-E1708", STEP]]);
    expect(ds[0]!.facts).toEqual({ map: MAP, kind: "critical_effect", what: "git.comment" });
  });

  it("accepts git.comment after the map", () => {
    const src = program(`${map("max 3", "delegate A.s(x.name)")}\n  effect git.comment(t, "seen") idempotent_by t`, ENVELOPE("M, PR"));
    expect(pairs(diagnostics(src))).toEqual([]);
  });

  it("refuses git.merge of an approved value in the body", () => {
    const src = program(`  let v = verify t against Approved(t)\n${map("max 3", "effect git.merge(v) idempotent_by x.name")}${AFTER}`, ENVELOPE("M, PR"));
    const ds = diagnostics(src);
    expect(pairs(ds)).toEqual([["MDT-E1708", "/defs/Run/body/1/value/body/0/value"]]);
    expect(ds[0]!.facts).toEqual({ map: "/defs/Run/body/1/value", kind: "critical_effect", what: "git.merge" });
  });

  // Acme's change set, in 0.4: it checks with the two warnings of its static criteria.
  const ACME = (): Modules => {
    const { modules, problems } = loadModules([{ file: "acme.system.mdt", text: readRepo("fixtures/system/acme.system.mdt"), kind: kindOf("acme.system.mdt") }]);
    expect(problems).toEqual([]);
    return modules;
  };
  const LAND = mutate(mutate(readRepo("fixtures/system/land.mdt"), "mandate @ 0.3", "mandate @ 0.4"), "type Plan", 'role architect "Architect"\n\ntype Plan');
  const WARNINGS: Array<[string, string]> = [
    ["MDT-W0601", "/defs/ChangeAccepted/accept/listed/by/static"],
    ["MDT-W0601", "/defs/PlanAccepted/accept/summarized/by/static"],
  ];

  it("refuses a change set in the body, and accepts it outside a map", () => {
    expect(pairs(diagnostics(LAND, ACME()))).toEqual(WARNINGS);
    const set = LAND.slice(LAND.indexOf("  let landed = changeset"), LAND.indexOf("idempotent_by task\n") + "idempotent_by task\n".length);
    const inMap = mutate(LAND, set, `  let landed = map k in [task] max 1 {\n  ${set.trim().replace("let landed = ", "")}\n  }\n`);
    const ds = diagnostics(inMap, ACME());
    expect(pairs(ds)).toEqual([WARNINGS[0], ["MDT-E1708", "/defs/Land/body/4/value/body/0/value"], WARNINGS[1]]);
    expect(ds[1]!.facts).toEqual({ map: "/defs/Land/body/4/value", kind: "critical_effect", what: "changeset" });
  });
});

describe("map items that share a write scope (E0320)", () => {
  const MW = ENVELOPE("M, W");
  const WRITE = "delegate Writer.w(x)";
  const shared = (capability = 'W = fs.write("/work")') => ({ par: 2, capability, by_item: [] });

  it("refuses par 2 when every item's delegation is granted the agent's whole write capability", () => {
    const ds = diagnostics(program(map("max 3 par 2", WRITE), MW));
    expect(pairs(ds)).toEqual([["MDT-E0320", MAP]]);
    expect(ds[0]!.facts).toEqual(shared());
  });

  it("accepts par 2 when the map hands each item W narrowed by the item", () => {
    expect(pairs(diagnostics(program(map("max 3 par 2 with caps W.narrow(x.root)", WRITE), MW)))).toEqual([]);
  });

  it("accepts the shared write when items run one at a time: par 1, or no par", () => {
    expect(pairs(diagnostics(program(map("max 3 par 1", WRITE), MW)))).toEqual([]);
    expect(pairs(diagnostics(program(map("max 3", WRITE), MW)))).toEqual([]);
  });

  it("accepts par 2 when the body writes nothing", () => {
    expect(pairs(diagnostics(program(map("max 3 par 2", "delegate A.s(x.name)"))))).toEqual([]);
  });

  it("refuses a narrow to a literal path, which is the same for every item", () => {
    const ds = diagnostics(program(map('max 3 par 2 with caps W.narrow("/work/a")', WRITE), MW));
    expect(pairs(ds)).toEqual([["MDT-E0320", MAP]]);
    expect(ds[0]!.facts).toEqual(shared('W = fs.write("/work/a")'));
  });

  it("refuses a narrow to a workflow parameter, which is not the bound variable", () => {
    const ds = diagnostics(program(map("max 3 par 2 with caps W.narrow(p)", WRITE), MW));
    expect(pairs(ds)).toEqual([["MDT-E0320", MAP]]);
    expect(ds[0]!.facts).toEqual(shared());
  });

  it("refuses a delegation that narrows by the item itself when the map hands nothing of that kind", () => {
    const ds = diagnostics(program(map("max 3 par 2", "delegate Writer.w(x) with caps M, W.narrow(x.root)"), MW));
    expect(pairs(ds)).toEqual([["MDT-E0320", MAP]]);
    expect(ds[0]!.facts).toEqual(shared());
  });

  it("refuses an outer map with par 2 whose inner map narrows by the inner variable only, at the outer map", () => {
    const inner = "map y in items max 2 with caps W.narrow(y.root) {\n      delegate Writer.w(y)\n    }";
    const ds = diagnostics(program(map("max 3 par 2", inner), MW));
    expect(pairs(ds)).toEqual([["MDT-E0320", MAP]]);
    expect(ds[0]!.facts).toEqual(shared());
  });

  it("refuses the shared write of a delegation inside a function the body calls, and accepts it under the map's narrow", () => {
    const ds = diagnostics(program(map("max 3 par 2", "store(x)"), MW));
    expect(pairs(ds)).toEqual([["MDT-E0320", MAP]]);
    expect(ds[0]!.facts).toEqual(shared());
    expect(pairs(diagnostics(program(map("max 3 par 2 with caps W.narrow(x.root)", "store(x)"), MW)))).toEqual([]);
    // What the map hands every item alike reaches the function's delegation too, and is as shared there.
    const alike = diagnostics(program(map('max 3 par 2 with caps W.narrow("/work/a")', "store(x)"), MW));
    expect(pairs(alike)).toEqual([["MDT-E0320", MAP]]);
    expect(alike[0]!.facts).toEqual(shared('W = fs.write("/work/a")'));
    // A function that delegates to an agent that writes nothing shares nothing.
    expect(pairs(diagnostics(program(map("max 3 par 2", "helper(x.name)"))))).toEqual([]);
  });

  it("refuses a write the body makes itself, and accepts it under the map's narrow", () => {
    const write = 'fs.write_text(x.root, "done")';
    const ds = diagnostics(program(map("max 3 par 2", write) + AFTER, MW));
    expect(pairs(ds)).toEqual([["MDT-E0320", MAP]]);
    expect(ds[0]!.facts).toEqual(shared());
    expect(pairs(diagnostics(program(map("max 3 par 2 with caps W.narrow(x.root)", write) + AFTER, MW)))).toEqual([]);
  });
});

describe("a map's budget holds its body (E0501, E0504)", () => {
  const BUDGET = `${MAP}/budget`;

  it("refuses a budget of 2 steps for an item whose delegation takes 3, at the map's budget", () => {
    const ds = diagnostics(program(map("max 3 budget { steps: 2 }", "delegate A.s(x.name)")));
    expect(pairs(ds)).toEqual([["MDT-E0501", BUDGET]]);
    expect(factsBut(ds[0]!)).toEqual({ steps: { limit: 2, declared_by_children: 3 } });
    expect(ds[0]!.facts!["breakdown"]).toEqual([{ from: "A.s", at: STEP, budget: { steps: 3, agents: 1 } }]);
  });

  it("accepts exactly 3 steps", () => {
    expect(pairs(diagnostics(program(map("max 3 budget { steps: 3 }", "delegate A.s(x.name)"))))).toEqual([]);
  });

  /** [dimension, a budget too small, a budget just large enough, the limit, the body, what one item declares]. */
  const DIMENSIONS: Array<[string, string, string, unknown, string, unknown]> = [
    ["tokens", "tokens: 4k", "tokens: 5k", 4000, "delegate A.s(x.name) budget { tokens: 5k, steps: 3 }", 5000],
    ["time_ms", "time: 10m", "time: 20m", 600_000, "delegate A.s(x.name) budget { time: 20m, steps: 3 }", 1_200_000],
    ["spend", "spend: 0.25 USD", "spend: 0.5 USD", "0.25 USD", "delegate A.s(x.name) budget { spend: 0.5 USD, steps: 3 }", "0.5 USD"],
    ["agents", "agents: 1", "agents: 2", 1, "let a = delegate A.s(x.name)\n    delegate A.s(x.name)", 2],
  ];
  for (const [key, tight, enough, limit, body, declared] of DIMENSIONS) {
    it(`compares ${key}: refuses less than one item hands out, and accepts exactly that`, () => {
      const ds = diagnostics(program(map(`max 3 budget { ${tight} }`, body)));
      expect(pairs(ds)).toEqual([["MDT-E0501", BUDGET]]);
      expect(factsBut(ds[0]!)).toEqual({ [key]: { limit, declared_by_children: declared } });
      expect(pairs(diagnostics(program(map(`max 3 budget { ${enough} }`, body))))).toEqual([]);
    });
  }

  it("names every exceeded dimension in one diagnostic", () => {
    const ds = diagnostics(program(map("max 3 budget { tokens: 4k, steps: 2 }", "delegate A.s(x.name) budget { tokens: 5k, steps: 3 }")));
    expect(pairs(ds)).toEqual([["MDT-E0501", BUDGET]]);
    expect(factsBut(ds[0]!)).toEqual({ tokens: { limit: 4000, declared_by_children: 5000 }, steps: { limit: 2, declared_by_children: 3 } });
  });

  it("refuses a body that spends another currency than the budget, at its spend", () => {
    const ds = diagnostics(program(map("max 3 budget { spend: 1 USD }", "delegate A.s(x.name) budget { spend: 0.5 EUR, steps: 3 }")));
    expect(pairs(ds)).toEqual([["MDT-E0504", `${BUDGET}/spend`]]);
    expect(ds[0]!.facts).toEqual({ currencies: ["EUR"] });
  });

  it("counts a map with no max inside the body as the envelope's agents, as the envelope's own budget does", () => {
    // One item runs the inner map over at most 12 elements, 3 steps each: 36 steps, above the 30 an item is given.
    const inner = "map y in items {\n      delegate A.s(y.name)\n    }";
    const ds = diagnostics(program(map("max 1 budget { steps: 30 }", inner)));
    expect(pairs(ds)).toEqual([["MDT-E0501", BUDGET]]);
    expect(factsBut(ds[0]!)).toEqual({ steps: { limit: 30, declared_by_children: 36 } });
    expect(pairs(diagnostics(program(map("max 1 budget { steps: 36 }", inner))))).toEqual([]);
  });

  it("holds a map's budget to its body outside an envelope too, steps included", () => {
    const ds = diagnostics(program(map("max 3 budget { steps: 2 }", "delegate A.s(x.name)"), OWN));
    expect(pairs(ds)).toEqual([["MDT-E0501", BUDGET]]);
    expect(factsBut(ds[0]!)).toEqual({ steps: { limit: 2, declared_by_children: 3 } });
  });
});

describe("the static cost of a map", () => {
  const cost = (src: string) => {
    const r = check(src, "mdt");
    expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    const c = staticCost(r.program!, "Run")!;
    return { c, dims: { agents: c.agents, steps: c.steps, tokens: c.tokens, time: c.time, spend: c.spend } };
  };

  it("is max times the body, with ceil(max / par) times one item's time", () => {
    const { dims } = cost(program(map("max 5 par 2", "delegate A.s(x.name) budget { time: 10m, steps: 3 }")));
    // Five items two at a time are three rounds of 10 minutes.
    expect(dims).toEqual({ agents: 5, steps: 15, tokens: 0, time: 1_800_000, spend: {} });
  });

  it("takes the map's budget in the dimensions it names, and the body in the others", () => {
    const { c, dims } = cost(program(map("max 3 par 3 budget { steps: 4, time: 5m }", "delegate A.s(x.name) budget { tokens: 2k, steps: 3 }")));
    expect(dims).toEqual({ agents: 3, steps: 12, tokens: 6000, time: 300_000, spend: {} });
    expect(c.parts).toEqual([
      { from: "map ×3", at: MAP, budget: { time_ms: 300_000, steps: 4 } },
      { from: "map (its body) ×3", at: MAP, budget: { agents: 1, tokens: 2000 } },
    ]);
  });

  it("counts a map with no max as the envelope's agents, which fits when nothing else delegates", () => {
    const { dims } = cost(program(map("", "delegate A.s(x.name)")));
    expect(dims).toEqual({ agents: 12, steps: 36, tokens: 0, time: 0, spend: {} });
  });

  it("shows the same number of items in the cost view", () => {
    const rows = (src: string) => {
      const r = check(src, "mdt");
      expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
      return costView(r.program!).workflows.find((w) => w.workflow === "Run")!.rows.map((x) => [x.call, x.times]);
    };
    expect(rows(program(map("max 5 par 2", "delegate A.s(x.name)")))).toEqual([["A.s", 5]]);
    expect(rows(program(map("", "delegate A.s(x.name)")))).toEqual([["A.s", 12]]);
  });

  it("refuses the envelope when a delegation after such a map needs a 13th agent", () => {
    const ds = diagnostics(program(map("", "delegate A.s(x.name)") + AFTER));
    expect(pairs(ds)).toEqual([["MDT-E0501", "/defs/Run/envelope/budget"]]);
    expect(factsBut(ds[0]!)).toEqual({ agents: { limit: 12, declared_by_children: 13 } });
  });
});

describe("a map and the node limit (E0105)", () => {
  it("counts the body once, whatever the bound: a map is not unrolled", () => {
    // A loop of 600 delegations is 1200 nodes and refused; a map that accepts 5000 elements is its body, once.
    const looped = program("  loop max_iter 600 {\n    let one = delegate A.s(t)\n  }", "caps   M");
    expect(pairs(diagnostics(looped))).toEqual([["MDT-E0105", "/defs/Run"]]);
    expect(pairs(diagnostics(program(map("max 5000", "delegate A.s(x.name)"), "caps   M")))).toEqual([]);
  });
});
