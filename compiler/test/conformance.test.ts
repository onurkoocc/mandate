// Conformance cases about representation (Doc 4 §25): S01, S02, S03, S10,
// S11, S12. The static cases (S04–S08, V01–V08) are in static.test.ts.

import { describe, expect, it } from "vitest";
import { check, load } from "../src/check.js";
import { hashProgram } from "../src/hash.js";
import type { Program } from "../src/ir/types.js";
import type { Json } from "../src/json/strict-json.js";
import { applyPatch } from "../src/patch/patch.js";
import { semanticDiff } from "../src/views/views.js";
import { checkJson, codes, minimal } from "./helpers.js";

describe("S01 duplicate JSON key", () => {
  it("is rejected before schema validation", () => {
    const text = `{"language":"mandate/0.1","module":"m","version":"0.1","defs":{},"defs":{}}`;
    const r = check(text, "json");
    expect(r.ok).toBe(false);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0102"]);
    expect(r.diagnostics[0]!.at.path).toBe("/defs");
    expect(r.diagnostics[0]!.at.span?.[0]).toBe(1);
  });

  it("is rejected inside nested objects too", () => {
    const text = `{"language":"mandate/0.1","module":"m","version":"0.1",
      "defs":{"T":{"kind":"type","type":{"ref":"Text","ref":"Int"}}}}`;
    const r = check(text, "json");
    expect(codes(r.diagnostics)).toEqual(["MDT-E0102"]);
    expect(r.diagnostics[0]!.at.path).toBe("/defs/T/type/ref");
  });
});

describe("S02 unknown field or language version", () => {
  it("rejects an unknown language version explicitly", () => {
    const r = checkJson({ ...minimal(), language: "mandate/0.9" });
    expect(codes(r.diagnostics)).toEqual(["MDT-E0103"]);
    expect(r.diagnostics[0]!.facts).toMatchObject({ expected: ["mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4"], found: "mandate/0.9" });
  });

  it("rejects a missing language field", () => {
    const p = minimal();
    delete p["language"];
    expect(codes(checkJson(p).diagnostics)).toEqual(["MDT-E0103"]);
  });

  it("rejects an unknown top-level field instead of ignoring it", () => {
    const r = checkJson({ ...minimal(), extensions: {} });
    expect(codes(r.diagnostics)).toEqual(["MDT-E0104"]);
    expect(r.diagnostics[0]!.at.path).toBe("/extensions");
  });

  it("rejects an unknown field deep inside a definition", () => {
    const p = minimal();
    p["defs"] = { Greeting: { kind: "type", type: { ref: "Text", nullable: true } } };
    const r = checkJson(p);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.at.path)).toContain("/defs/Greeting/type/nullable");
  });

  it("rejects an unknown definition kind", () => {
    const p = minimal();
    p["defs"] = { X: { kind: "macro" } };
    const r = checkJson(p);
    expect(codes(r.diagnostics)).toContain("MDT-E0104");
  });
});

describe("S03 reference to a missing node", () => {
  const src = (body: string): string => `module m @ 0.1\nuse company.domain.{Issue}\n${body}\n`;

  it("reports an unknown type with a repair when one name is close", () => {
    const r = check(src("type Finding = { file: Pathh }"), "mdt");
    expect(codes(r.diagnostics)).toEqual(["MDT-E0120"]);
    const d = r.diagnostics[0]!;
    expect(d.at.path).toBe("/defs/Finding/type/record/file/ref");
    expect(d.at.span?.[0]).toBe(3);
    expect(d.facts).toMatchObject({ name: "Pathh", did_you_mean: "Path" });
    expect(d.repair?.[0]?.patch[0]).toEqual({ op: "replace", path: "/defs/Finding/type/record/file/ref", value: "Path" });
  });

  it("reports unknown capabilities, agents, skills, contracts and variables", () => {
    const r = check(
      src(`
capability Read = fs.read("/repo")
agent A {
  caps Read, Writ
  skill go(i: Issue) -> Inferred<Text> ! {Model}
}
workflow W(issue: Issue) -> Text
  caps Read
{
  let a = delegate A.goo(issue)
  let b = delegate B.go(issue)
  let c = verify a against Missing(issue)
  isue
}`),
      "mdt",
    );
    const byName = Object.fromEntries(r.diagnostics.map((d) => [String(d.facts?.["name"]), d]));
    expect(Object.keys(byName).sort()).toEqual(["B", "Missing", "Writ", "fs", "goo", "isue"].sort());
    expect(byName["Writ"]!.facts?.["expected"]).toBe("capability");
    expect(byName["goo"]!.facts?.["did_you_mean"]).toBe("go");
    expect(byName["isue"]!.facts?.["did_you_mean"]).toBe("issue");
    expect(r.diagnostics.every((d) => d.code === "MDT-E0120")).toBe(true);
  });

  it("does not let par branches see each other", () => {
    const r = check(
      src(`
agent A {
  skill go(i: Issue) -> Inferred<Text> ! {Model}
}
workflow W(issue: Issue) -> Text
  caps A
{
  par {
    x = delegate A.go(issue)
    y = delegate A.go(x)
  }
  y
}`),
      "mdt",
    );
    // `caps A` names an agent, not a capability; `x` is not visible to the sibling branch.
    expect(r.diagnostics.map((d) => d.facts?.["name"]).sort()).toEqual(["A", "x"]);
  });

  it("reports an effect whose name only Object.prototype has, like any unknown effect", () => {
    const withEffect = (name: string): string => `mandate @ 0.3
module m @ 0.1
use std.{fs}
capability R = fs.read("/repo")
environment prod {
  class internal
  authorize ${name} by policy
}
workflow W(t: Text) -> Bool
  caps R
{
  effect ${name}(t)
  true
}`;
    const expected = (name: string) => [
      { code: "MDT-E0120", path: "/defs/prod/authorize/" + name, name },
      { code: "MDT-E0120", path: "/defs/W/body/0/value/name", name },
    ];
    const shape = (src: string) => check(src, "mdt").diagnostics.map((d) => ({ code: d.code, path: d.at.path, name: d.facts?.["name"] }));
    expect(shape(withEffect("nope"))).toEqual(expected("nope"));
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf"]) expect(shape(withEffect(name)), name).toEqual(expected(name));
  });

  it("checks the JSON IR the same way as text", () => {
    const p = minimal();
    p["defs"] = { Greeting: { kind: "type", type: { ref: "Txt" } } };
    const r = checkJson(p);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0120"]);
    expect(r.diagnostics[0]!.at.span).toBeDefined();
  });
});

describe("S10 key order does not change the hash", () => {
  it("hashes two key orders of the same program identically", () => {
    const a = `{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"A":{"kind":"type","type":{"ref":"Text"}},"B":{"kind":"type","type":{"ref":"Int"}}}}`;
    const b = `{"defs":{"B":{"type":{"ref":"Int"},"kind":"type"},"A":{"type":{"ref":"Text"},"kind":"type"}},"version":"0.1","module":"m","language":"mandate/0.1"}`;
    const ra = check(a, "json");
    const rb = check(b, "json");
    expect(ra.ok && rb.ok).toBe(true);
    expect(ra.hashes!.program).toBe(rb.hashes!.program);
    expect(ra.hashes!.defs).toEqual(rb.hashes!.defs);
  });

  it("hashes text written in a different order identically", () => {
    const a = `module m @ 0.1
use std.{fs, net}
capability R = fs.read("/a")
type T = { x: Int, y: Text }
agent A {
  caps R
  skill s(t: T) -> Inferred<T> ! {Model, Fs.Read}
}`;
    const b = `module m @ 0.1
use std.{net, fs}
agent A {
  skill s(t: T) -> Inferred<T> ! {Fs.Read, Model}
  caps R
}
type T = { y: Text, x: Int }
capability R = fs.read("/a")`;
    // Hashing does not depend on the static checks (this agent has no step budget).
    const hash = (t: string): string => hashProgram(load(t, "mdt").program as unknown as Json).program;
    expect(hash(a)).toBe(hash(b));
  });
});

describe("S11 no implicit Unicode or number normalization", () => {
  const withText = (value: string): string =>
    JSON.stringify({ ...minimal(), defs: { G: { kind: "const", value: { op: "text", value } } } });

  it("keeps NFC and NFD text distinct", () => {
    const nfc = "café";
    const nfd = "café";
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    const a = check(withText(nfc), "json");
    const b = check(withText(nfd), "json");
    expect(a.ok && b.ok).toBe(true);
    expect(a.hashes!.program).not.toBe(b.hashes!.program);
  });

  it("rejects a lone surrogate with a defined error", () => {
    const text = withText("x").replace('"x"', '"\\ud800"');
    expect(codes(check(text, "json").diagnostics)).toEqual(["MDT-E0107"]);
  });

  it("rejects fractional and exponent numbers instead of rounding", () => {
    for (const n of ["1.0", "1e3", "0.1"]) {
      const text = `{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"N":{"kind":"const","value":{"op":"int","value":${n}}}}}`;
      expect(codes(check(text, "json").diagnostics)).toEqual(["MDT-E0106"]);
    }
  });

  it("rejects integers outside ±(2^53−1) and negative zero", () => {
    for (const n of ["9007199254740992", "-9007199254740992", "-0"]) {
      const text = `{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"N":{"kind":"const","value":{"op":"int","value":${n}}}}}`;
      expect(codes(check(text, "json").diagnostics)).toEqual(["MDT-E0106"]);
    }
  });

  it("rejects non-ASCII identifiers in text and in IR", () => {
    expect(codes(check("module m @ 0.1\ntype Ünlü = Text\n", "mdt").diagnostics)).toEqual(["MDT-E0101"]);
    const p = minimal();
    p["defs"] = { "Ünlü": { kind: "type", type: { ref: "Text" } } };
    expect(codes(checkJson(p).diagnostics)).toContain("MDT-E0104");
  });

  it("keeps decimals as written, as strings", () => {
    const r = check("module m @ 0.1\nlet x = 0.850\n", "mdt");
    expect(r.ok).toBe(true);
    expect(r.program!.defs["x"]).toEqual({ kind: "const", value: { op: "dec", value: "0.850" } });
  });
});

describe("S12 patch against a stale base", () => {
  const program = (): Program => check(`module m @ 0.1\ntype T = Text\n`, "mdt").program!;

  it("is refused with stale_base", () => {
    const p = program();
    const r = applyPatch(p, "sha256:" + "0".repeat(64), [{ op: "add", path: "/defs/U", value: { kind: "type", type: { ref: "Int" } } }]);
    expect(r.ok).toBe(false);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0130"]);
    expect(r.diagnostics[0]!.facts?.["current"]).toBe(hashProgram(p as unknown as Json).program);
  });

  it("applies against the current base and returns the new hash", () => {
    const p = program();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "add", path: "/defs/U", value: { kind: "type", type: { ref: "Int" } } }]);
    expect(r.ok).toBe(true);
    expect(r.hash).not.toBe(base);
    expect(Object.keys(r.program!.defs).sort()).toEqual(["T", "U"]);
    // The input is not modified.
    expect(Object.keys(p.defs)).toEqual(["T"]);
  });

  it("validates the patched program", () => {
    const p = program();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "replace", path: "/defs/T/type/ref", value: "Txt" }]);
    expect(r.ok).toBe(false);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0120"]);
  });

  it("reports a path that does not exist", () => {
    const p = program();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "remove", path: "/defs/Nope" }]);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0131"]);
  });
});

describe("governance changes (§13.2)", () => {
  const src = `module m @ 0.1
use std.{fs, human}
use company.domain.{Issue}
capability Read = fs.read("/repo")
capability Write = fs.write("/repo")
contract Done(i: Issue) {
  accept owner "Owner approved" by human.approve(role: "owner")
  accept tests "Tests pass" by human.approve(role: "qa")
}
agent A {
  caps Read
  budget { tokens: 1000, steps: 5 }
  skill go(i: Issue) -> Inferred<Text> ! {Model}
}`;

  it("flags added capabilities, larger budgets and dropped criteria", () => {
    const p = check(src, "mdt").program!;
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [
      { op: "add", path: "/defs/A/caps/-", value: { op: "var", name: "Write" } },
      { op: "replace", path: "/defs/A/budget/steps", value: 50 },
      { op: "remove", path: "/defs/Done/accept/tests" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.governance.map((g) => g.kind).sort()).toEqual(["budget_increased", "capability_added", "criterion_removed"]);
  });

  it("flags the capabilities of a new workflow", () => {
    const p = check(src, "mdt").program!;
    const base = hashProgram(p as unknown as Json).program;
    const leak = check(`${src}\nworkflow Leak(t: Text) -> Bool\n  caps Write, fs.write("/")\n{\n  true\n}\n`, "mdt").program!.defs["Leak"];
    const r = applyPatch(p, base, [{ op: "add", path: "/defs/Leak", value: leak }]);
    expect(r.diagnostics).toEqual([]);
    expect(r.governance).toEqual([
      { kind: "capability_added", path: "/defs/Leak/caps/0", detail: '+ Leak: fs.write("/")' },
      { kind: "capability_added", path: "/defs/Leak/caps/1", detail: '+ Leak: Write = fs.write("/repo")' },
    ]);
  });

  it("flags a dropped criterion whatever it is named", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      const p = check(src.replace("accept tests", `accept ${name}`), "mdt").program!;
      const base = hashProgram(p as unknown as Json).program;
      const r = applyPatch(p, base, [{ op: "remove", path: `/defs/Done/accept/${name}` }]);
      expect(r.ok, name).toBe(true);
      expect(r.governance, name).toEqual([{ kind: "criterion_removed", path: `/defs/Done/accept/${name}`, detail: `- Done.${name} (human.approve) removed` }]);
    }
  });

  it("reports nothing for a change that narrows authority", () => {
    const p = check(src, "mdt").program!;
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "replace", path: "/defs/A/budget/steps", value: 3 }]);
    expect(r.ok).toBe(true);
    expect(r.governance).toEqual([]);
  });

  /** `src` with `from` replaced by `to`, checked; its definition `name`. */
  const defIn = (from: string, to: string, name: string): unknown => {
    expect(src).toContain(from);
    const r = check(src.replace(from, to), "mdt");
    expect(r.program, to).toBeDefined();
    return r.program!.defs[name];
  };

  /** Applies `ops` to `p` and returns its governance changes, as kind, path and detail. */
  const changes = (p: Program, ops: Parameters<typeof applyPatch>[2]) => {
    const r = applyPatch(p, hashProgram(p as unknown as Json).program, ops);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return r.governance;
  };

  it("classifies a changed capability by what it authorizes: a narrowing is not reported, a widening is", () => {
    const p = check(src, "mdt").program!;
    expect(changes(p, [{ op: "replace", path: "/defs/Read", value: defIn('fs.read("/repo")', 'fs.read("/repo/src")', "Read") }])).toEqual([]);
    expect(changes(p, [{ op: "replace", path: "/defs/Read", value: defIn('fs.read("/repo")', 'fs.read("/repo", "/etc")', "Read") }])).toEqual([
      { kind: "capability_added", path: "/defs/Read", detail: '+ Read: read path "/etc"' },
    ]);
  });

  it("flags a changed capability whose scopes do not show the change", () => {
    // What `money.spend` allows is not a scope. Raising it widens authority all the same, so the change is reported.
    const spend = `use std.{fs, human, money}`;
    const withSpend = `${src.replace("use std.{fs, human}", spend)}\ncapability Spend = money.spend(max: 20 USD, per: workflow_run)\n`;
    const p = check(withSpend, "mdt").program!;
    const raised = check(withSpend.replace("max: 20 USD", "max: 2000 USD"), "mdt").program!;
    expect(changes(p, [{ op: "replace", path: "/defs/Spend", value: raised.defs["Spend"] }])).toEqual([{ kind: "capability_added", path: "/defs/Spend", detail: "~ capability Spend changed" }]);
    expect(semanticDiff(p, raised).governance).toEqual([{ path: "/defs/Spend", text: "~ capability Spend changed" }]);
    // A narrowing the scopes do show stays a behavior change.
    const narrowed = check(withSpend.replace('fs.read("/repo")', 'fs.read("/repo/src")'), "mdt").program!;
    expect(semanticDiff(p, narrowed).governance).toEqual([]);
  });

  it("flags a criterion checked another way, and a changed require", () => {
    const p = check(src, "mdt").program!;
    const done = p.defs["Done"]!;
    if (done.kind !== "contract") throw new Error("Done is a contract");
    expect(changes(p, [{ op: "replace", path: "/defs/Done/accept/tests/by", value: done.accept["owner"]!.by }])).toEqual([
      { kind: "criterion_changed", path: "/defs/Done/accept/tests", detail: "~ Done.tests: human.approve → human.approve" },
    ]);
    const required = defIn("contract Done(i: Issue) {\n", "contract Done(i: Issue) {\n  require i.reproducible\n", "Done");
    expect(changes(p, [{ op: "replace", path: "/defs/Done", value: required }])).toEqual([{ kind: "require_changed", path: "/defs/Done/require", detail: "~ Done: require changed" }]);
  });

  it("flags a definition that becomes another kind", () => {
    const p = check(src, "mdt").program!;
    expect(changes(p, [{ op: "replace", path: "/defs/Write", value: { kind: "type", type: { ref: "Text" } } }])).toEqual([
      { kind: "kind_changed", path: "/defs/Write", detail: "~ Write: capability → type" },
    ]);
  });

  it("flags an effect that becomes irreversible, and a new one that is", () => {
    const wipe = `effect ops.wipe(i: Issue) -> Bool\n  requires caps Write\n  critical\n  idempotency required\n  retry_class reconcilable\n`;
    const p = check(`${src}\n${wipe}`, "mdt").program!;
    const q = check(`${src}\n${wipe}  irreversible\n`, "mdt").program!;
    expect(q.defs["ops.wipe"]).toMatchObject({ kind: "effect", irreversible: true });
    expect(changes(p, [{ op: "add", path: "/defs/ops.wipe/irreversible", value: true }])).toEqual([{ kind: "irreversible_added", path: "/defs/ops.wipe", detail: "~ effect ops.wipe became irreversible" }]);
    expect(changes(q, [{ op: "remove", path: "/defs/ops.wipe/irreversible" }])).toEqual([]);
    expect(changes(check(src, "mdt").program!, [{ op: "add", path: "/defs/ops.wipe", value: q.defs["ops.wipe"] }])).toEqual([{ kind: "irreversible_added", path: "/defs/ops.wipe", detail: "+ irreversible effect ops.wipe" }]);
  });

  it("flags a removed contract once, as its criteria removed", () => {
    const p = check(src, "mdt").program!;
    expect(changes(p, [{ op: "remove", path: "/defs/Done" }])).toEqual([{ kind: "criterion_removed", path: "/defs/Done", detail: "- contract Done removed" }]);
  });

  it("flags a new remote agent and a changed remote binding", () => {
    const remote = `agent remote Partner = a2a("https://partner.example/.well-known/agent-card.json")
  version  "1.0"
  trust    untrusted
  caps     net.https(hosts: ["partner.example"])
  skills {
    review(i: Issue) -> Bool
  }`;
    const withNet = src.replace("use std.{fs, human}", "use std.{fs, human, net}");
    const p = check(withNet, "mdt").program!;
    const q = check(`${withNet}\n${remote}\n`, "mdt").program!;
    expect(changes(p, [{ op: "add", path: "/defs/Partner", value: q.defs["Partner"] }])).toEqual([{ kind: "remote_agent_added", path: "/defs/Partner", detail: "+ remote agent Partner" }]);
    expect(changes(q, [{ op: "replace", path: "/defs/Partner/remote/version", value: "2.0" }])).toEqual([
      { kind: "remote_binding_changed", path: "/defs/Partner/remote", detail: "~ Partner: remote binding changed" },
    ]);
  });

  it("flags a raised function budget, and not a lowered one", () => {
    const p = check(`${src}\nfn shorten(t: Text) -> Text\n  budget { steps: 2 }\n{\n  t\n}\n`, "mdt").program!;
    expect(changes(p, [{ op: "replace", path: "/defs/shorten/budget/steps", value: 5 }])).toEqual([
      { kind: "budget_increased", path: "/defs/shorten/budget", detail: "~ shorten.budget.steps: 2 → 5" },
    ]);
    expect(changes(p, [{ op: "replace", path: "/defs/shorten/budget/steps", value: 1 }])).toEqual([]);
  });

  it("flags more agents in a workflow's, an agent's, a skill's and a function's budget", () => {
    const p = structuredClone(check(`${src}\nfn shorten(t: Text) -> Text\n  budget { steps: 2 }\n{\n  t\n}\nworkflow W(t: Text) -> Bool\n  caps Read\n  budget { steps: 2 }\n{\n  true\n}\n`, "mdt").program!);
    // `agents` is a mandate/0.4 budget field.
    p.language = "mandate/0.4";
    const defs = p.defs as Record<string, { budget?: Record<string, unknown>; skills?: Record<string, { budget?: Record<string, unknown> }> }>;
    for (const b of [defs["W"]!.budget!, defs["A"]!.budget!, defs["shorten"]!.budget!]) b["agents"] = 2;
    defs["A"]!.skills!["go"]!.budget = { agents: 2 };
    const paths = ["/defs/W/budget/agents", "/defs/A/budget/agents", "/defs/A/skills/go/budget/agents", "/defs/shorten/budget/agents"];
    const r = changes(p, paths.map((path) => ({ op: "replace" as const, path, value: 3 })));
    expect(r.map((g) => [g.kind, g.path, g.detail])).toEqual([
      ["budget_increased", "/defs/A/budget", "~ A.budget.agents: 2 → 3"],
      ["budget_increased", "/defs/A/skills/go/budget", "~ A.go.budget.agents: 2 → 3"],
      ["budget_increased", "/defs/W/budget", "~ W.budget.agents: 2 → 3"],
      ["budget_increased", "/defs/shorten/budget", "~ shorten.budget.agents: 2 → 3"],
    ]);
  });
});
