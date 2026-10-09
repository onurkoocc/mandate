// Human projections of a program (P2-14, Doc 4 §15, INV-10): FixBug's
// architecture, authority and cost views, each naming the program hash it
// shows, and the semantic diff between two versions (§15.3), which shows a
// new network target as a governance change (G11).

import { describe, expect, it } from "vitest";
import { check, type Lock, type Program } from "../src/index.js";
import { htmlEscape, toHtml, toMarkdown } from "../src/views/doc.js";
import { architecture, authority, cost, programDoc, semanticDiff } from "../src/views/views.js";
import { readRepo } from "./helpers.js";

const FIXBUG = readRepo("examples/fixbug/fixbug.mdt");
const LOCK = JSON.parse(readRepo("examples/fixbug/mandate.lock.json")) as Lock;

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
