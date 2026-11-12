// Human projections of a program (P2-14, Doc 4 §15, INV-10): FixBug's
// architecture, authority and cost views, each naming the program hash it
// shows, and the semantic diff between two versions (§15.3), which shows a
// new network target as a governance change (G11).

import { describe, expect, it } from "vitest";
import { applyPatch, check, type Json, type Lock, type PatchOp, type Program } from "../src/index.js";
import { htmlEscape, toHtml, toMarkdown } from "../src/views/doc.js";
import { architecture, authority, cost, programDoc, semanticDiff } from "../src/views/views.js";
import { readRepo } from "./helpers.js";

const FIXBUG = readRepo("fixtures/fixbug/fixbug.mdt");
const LOCK = JSON.parse(readRepo("fixtures/fixbug/mandate.lock.json")) as Lock;

function program(src: string): Program {
  const r = check(src, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return r.program!;
}

const fixbug = program(FIXBUG);
const HASH = check(FIXBUG, "mdt").hashes!.program;

describe("the architecture view (§15.1)", () => {
  it("draws FixBug as §15.1 does: discovery, plan, two parallel agents, an isolated review, the contract, the PR", () => {
    const v = architecture(fixbug);
    expect(v.program.hash).toBe(HASH);
    const w = v.workflows[0]!;
    expect(w.workflow).toBe("FixBug");
    expect(w.nodes.map((n) => [n.kind, n.label])).toEqual([
      ["delegate", "Explorer.locate"],
      ["delegate", "Planner.plan"],
      ["delegate", "Implementer.apply"],
      ["delegate", "TestWriter.regression"],
      ["delegate", "Reviewer.counterexamples"],
      ["verify", "verify FixAccepted"],
      ["human", "person: escalation"],
      ["effect", "git.open_pr"],
    ]);
    const label = (id: string) => w.nodes.find((n) => n.id === id)!.label;
    expect(w.edges.map((e) => `${label(e.from)} -> ${label(e.to)}${e.label ? ` (${e.label})` : ""}`)).toEqual([
      "Explorer.locate -> Planner.plan",
      "Planner.plan -> Implementer.apply",
      "Planner.plan -> TestWriter.regression",
      "Implementer.apply -> Reviewer.counterexamples",
      "TestWriter.regression -> Reviewer.counterexamples",
      "Reviewer.counterexamples -> verify FixAccepted",
      "verify FixAccepted -> person: escalation (open criteria)",
      "verify FixAccepted -> git.open_pr",
    ]);
    // Each delegation shows the grant it really gets: the Implementer writes only /work/repo/src.
    expect(w.nodes[2]!.detail[0]).toContain("write /work/repo/src");
    expect(w.nodes[4]!.detail).toContain("isolated");
    expect(w.nodes[7]!.detail).toEqual(["critical", "idempotent", "compensation offered: git.close_pr"]);
    expect(w.mermaid).toContain('n6 -->|open criteria| n7');
    expect(w.mermaid).toContain('n8[("git.open_pr<br/>critical<br/>idempotent<br/>compensation offered: git.close_pr")]');
  });
});

describe("the authority view (§15.2)", () => {
  it("lists what each agent, workflow and delegation may do", () => {
    const rows = Object.fromEntries(authority(fixbug).rows.map((r) => [r.who, r]));
    expect(rows["Implementer"]).toMatchObject({ kind: "agent", read: ["/work/repo"], write: ["/work/repo/src"], exec: ["mvn -q test; mvn -q verify"], model: ["standard (up to internal)"] });
    expect(rows["Planner"]).toMatchObject({ read: [], write: [], network: [] });
    expect(rows["FixBug"]).toMatchObject({ kind: "workflow", repos: ["company/backend"], effects: ["git.open_pr (critical; policy authorizes)"] });
    expect(rows["FixBug → Reviewer.counterexamples"]).toMatchObject({ kind: "delegation", read: ["/work/repo"], write: [] });
  });
});

describe("the cost view", () => {
  it("adds up what FixBug hands out, with the lock's per-call bound", () => {
    const [w] = cost(fixbug, LOCK).workflows;
    expect(w!.limit).toBe("50 USD · 3h");
    expect(w!.total).toBe("49.28 USD · 7840000 tokens · 56 steps");
    expect(w!.rows.find((r) => r.call === "Implementer.apply")).toEqual({
      call: "Implementer.apply",
      times: 1,
      budget: "17.6 USD · 2800000 tokens · 20 steps · 45m",
      from: "agent",
      per_call: "0.88 USD · 140000 tokens",
      steps_bound: "17.6 USD · 2800000 tokens",
    });
  });
});

describe("the semantic diff (§15.3)", () => {
  const mutate = (from: string, to: string): Program => {
    expect(FIXBUG).toContain(from);
    return program(FIXBUG.replace(from, to));
  };

  it("shows a new network target as a governance change (G11)", () => {
    const withCi = mutate("capability PR        = git.pr(\"company/backend\")", 'capability PR        = git.pr("company/backend")\ncapability CI        = net.https(hosts: ["ci.internal.example"])');
    const ci = program(FIXBUG.replace('capability PR        = git.pr("company/backend")', 'capability PR        = git.pr("company/backend")\ncapability CI        = net.https(hosts: ["ci.internal.example"])').replace("caps    RepoRead, SrcWrite, TestWrite, Build, ModelStd, PR", "caps    RepoRead, SrcWrite, TestWrite, Build, ModelStd, PR, CI"));
    const exfil = program(FIXBUG.replace('capability PR        = git.pr("company/backend")', 'capability PR        = git.pr("company/backend")\ncapability CI        = net.https(hosts: ["ci.internal.example", "paste.example.net"])').replace("caps    RepoRead, SrcWrite, TestWrite, Build, ModelStd, PR", "caps    RepoRead, SrcWrite, TestWrite, Build, ModelStd, PR, CI"));
    const d = semanticDiff(ci, exfil);
    expect(d.from.hash).not.toBe(d.to.hash);
    expect(d.governance.map((c) => c.text)).toEqual(['+ CI: network host "paste.example.net"']);
    expect(d.unchanged).not.toContain("no authority added");
    // Adding the capability at all is a governance change too.
    expect(semanticDiff(fixbug, withCi).governance.map((c) => c.text)).toEqual(['+ capability CI = net.https("ci.internal.example")']);
  });

  it("separates governance from behavior, and says what stayed the same", () => {
    const after = program(
      FIXBUG.replace("budget  { spend: 50 USD, time: 3h }", "budget  { spend: 60 USD, time: 3h }")
        .replace('  accept owner_approved "The code owner approved"\n    by human.approve(role: "code_owner")\n', "")
        .replace("let review = delegate Reviewer.counterexamples(patch, tests) isolated", "let review = delegate Reviewer.counterexamples(patch, tests)"),
    );
    const d = semanticDiff(fixbug, after);
    expect(d.governance.map((c) => c.text)).toEqual(["- FixAccepted.owner_approved (human.approve) removed", "~ FixBug.budget.spend: 50 USD → 60 USD"]);
    expect(d.behavior.map((c) => c.text)).toEqual([
      "+ step: delegate Reviewer.counterexamples [read /work/repo · model standard (up to internal)]",
      "- step: delegate Reviewer.counterexamples [read /work/repo · model standard (up to internal), isolated]",
    ]);
    expect(d.unchanged).toEqual(["external effects unchanged: git.open_pr (critical; policy authorizes)", "no authority added"]);
    // Narrowing is behavior, not governance.
    const narrower = semanticDiff(fixbug, mutate('capability RepoRead  = fs.read("/work/repo")', 'capability RepoRead  = fs.read("/work/repo/src")'));
    expect(narrower.governance).toEqual([]);
    expect(narrower.behavior.map((c) => c.text)).toContain('- RepoRead: read path "/work/repo" (narrowed)');
  });

  it("shows a new workflow's capabilities as governance changes: a new network target always shows (G11)", () => {
    const leak = program(`${FIXBUG}\nworkflow Leak(t: Text) -> Bool\n  caps net.https(hosts: ["paste.example.net"]), RepoRead\n{\n  true\n}\n`);
    const d = semanticDiff(fixbug, leak);
    expect(d.governance.map((c) => [c.path, c.text])).toEqual([
      ["/defs/Leak/caps/0", '+ Leak: net.https("paste.example.net")'],
      ["/defs/Leak/caps/1", '+ Leak: RepoRead = fs.read("/work/repo")'],
    ]);
    expect(d.behavior.map((c) => c.text)).toEqual(["+ workflow Leak"]);
    expect(d.unchanged).not.toContain("no authority added");
    // Removing it again narrows authority: behavior only.
    expect(semanticDiff(leak, fixbug).governance).toEqual([]);
  });

  it("shows a spend limit in another currency with each side's own currency, as a governance change", () => {
    const spending = (spend: string): Program => program(`module m @ 0.1\nuse std.{fs}\ncapability R = fs.read("/repo")\nworkflow W(t: Text) -> Bool\n  caps R\n  budget { spend: ${spend} }\n{\n  true\n}\n`);
    const d = semanticDiff(spending("50 USD"), spending("49 KWD"));
    expect(d.governance.map((c) => c.text)).toEqual(["~ W.budget.spend: 50 USD → 49 KWD"]);
    expect(d.behavior).toEqual([]);
    expect(d.unchanged).not.toContain("no budget raised");
    // Within one currency nothing changes: lower is behavior, higher is governance.
    expect(semanticDiff(spending("50 USD"), spending("49 USD")).behavior.map((c) => c.text)).toEqual(["~ W.budget.spend: 50 USD → 49 USD"]);
    expect(semanticDiff(spending("49 USD"), spending("50 USD")).governance.map((c) => c.text)).toEqual(["~ W.budget.spend: 49 USD → 50 USD"]);
  });

  it("shows a raised function budget as a governance change, as an agent's", () => {
    const fn = (steps: number): Program => program(`module m @ 0.1\nfn shorten(t: Text) -> Text\n  budget { steps: ${steps} }\n{\n  t\n}\n`);
    const d = semanticDiff(fn(2), fn(5));
    expect(d.governance).toEqual([{ path: "/defs/shorten/budget", text: "~ shorten.budget.steps: 2 → 5" }]);
    expect(d.behavior.map((c) => c.text)).toEqual(["~ fn shorten changed"]);
    expect(d.unchanged).not.toContain("no budget raised");
    expect(semanticDiff(fn(5), fn(2)).governance).toEqual([]);
  });

  it("reports a removed or added criterion whatever it is named", () => {
    const criterion = '  accept owner_approved "The code owner approved"\n    by human.approve(role: "code_owner")\n';
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      const named = mutate(criterion, criterion.replace("owner_approved", name));
      const without = mutate(criterion, "");
      expect(semanticDiff(named, without).governance.map((c) => c.text), name).toEqual([`- FixAccepted.${name} (human.approve) removed`]);
      expect(semanticDiff(without, named).behavior.map((c) => c.text), name).toEqual([`+ FixAccepted.${name} by human.approve`]);
    }
    const skill = "  skill locate(issue: Issue) -> Inferred<List<Finding>> ! {Fs.Read, Model}\n";
    const withSkill = mutate(skill, `${skill}  skill constructor(issue: Issue) -> Inferred<List<Finding>> ! {Fs.Read, Model}\n`);
    expect(semanticDiff(fixbug, withSkill).behavior.map((c) => c.text)).toEqual(["+ skill Explorer.constructor"]);
    expect(semanticDiff(withSkill, fixbug).behavior.map((c) => c.text)).toEqual(["- skill Explorer.constructor"]);
  });

  it("classifies a patch's governance changes as it lists them: same paths, same texts", () => {
    const base = check(FIXBUG, "mdt").hashes!.program;
    const defOf = (from: string, to: string, name: string): Json => mutate(from, to).defs[name] as unknown as Json;
    const fixAccepted = fixbug.defs["FixAccepted"] as unknown as { accept: Record<string, { by: Json }> };
    const patches: Array<[string, PatchOp[], string[]]> = [
      ["raise a budget", [{ op: "replace", path: "/defs/FixBug/budget/spend/micros", value: 60_000_000 }], ["budget_increased"]],
      ["lower a budget", [{ op: "replace", path: "/defs/Explorer/budget/steps", value: 6 }], []],
      ["narrow a capability", [{ op: "replace", path: "/defs/RepoRead/value/args/0/value/value", value: "/work/repo/src" }], []],
      ["widen a capability", [{ op: "replace", path: "/defs/RepoRead", value: defOf('fs.read("/work/repo")', 'fs.read("/work")', "RepoRead") }], ["capability_added"]],
      ["change a model tier", [{ op: "replace", path: "/defs/ModelStd", value: defOf("model.infer(tier: standard)", "model.infer(tier: premium)", "ModelStd") }], ["capability_added"]],
      ["give an agent a capability", [{ op: "add", path: "/defs/Planner/caps/-", value: { op: "var", name: "PR" } }], ["capability_added"]],
      ["drop a criterion", [{ op: "remove", path: "/defs/FixAccepted/accept/owner_approved" }], ["criterion_removed"]],
      ["check a criterion another way", [{ op: "replace", path: "/defs/FixAccepted/accept/owner_approved/by", value: fixAccepted.accept["suite_green"]!.by }], ["criterion_changed"]],
      [
        "drop a criterion and raise an agent's steps",
        [
          { op: "remove", path: "/defs/FixAccepted/accept/scope_respected" },
          { op: "replace", path: "/defs/Reviewer/budget/steps", value: 9 },
        ],
        ["criterion_removed", "budget_increased"],
      ],
    ];
    for (const [what, ops, kinds] of patches) {
      const r = applyPatch(fixbug, base, ops);
      expect(r.ok, what).toBe(true);
      const v = semanticDiff(fixbug, r.program!);
      expect(r.governance.map((g) => g.kind), what).toEqual(kinds);
      expect(r.governance.map((g) => g.path), what).toEqual(v.governance.map((g) => g.path));
      expect(r.governance.map((g) => g.detail), what).toEqual(v.governance.map((g) => g.text));
    }
  });
});

describe("rendering", () => {
  it("names the program hash, and escapes what it shows", () => {
    const doc = programDoc(fixbug, LOCK);
    expect(doc.meta[0]).toEqual(["Program", HASH]);
    const md = toMarkdown(doc);
    expect(md).toContain(HASH);
    expect(md).toContain("| Implementer | agent | /work/repo | /work/repo/src |");
    const html = toHtml(doc);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'`);
    expect(html).not.toMatch(/<script|<form|<button|<a /i);
    expect(htmlEscape('<b onclick="x">&</b>')).toBe("&lt;b onclick=&quot;x&quot;&gt;&amp;&lt;/b&gt;");
    const hostile = toMarkdown({ title: "t", meta: [], blocks: [{ table: { head: ["a"], rows: [[{ text: "x | [Approve](javascript:alert(1)) <b>`y`</b>", untrusted: true }]] } }] });
    expect(hostile).toContain("`` x ¦ [Approve](javascript:alert(1)) <b>`y`</b> ``");
  });
});
