// Gate 1 static checks (Doc 4 §5–§10, §25): the remaining S cases, the
// Mandate-specific V cases, the §20 FixBug table, and one mutation of FixBug
// per rule so each check is seen firing on the program it was designed for.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import type { Diagnostic } from "../src/diag.js";
import { readRepo } from "./helpers.js";

/** Error and warning codes of a program, in report order. */
function codesOf(src: string): string[] {
  return check(src, "mdt").diagnostics.map((d) => d.code);
}

function errorsOf(src: string): string[] {
  return check(src, "mdt")
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.code);
}

function only(src: string, code: string): Diagnostic {
  const r = check(src, "mdt");
  const found = r.diagnostics.filter((d) => d.code === code);
  expect(found, r.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n")).toHaveLength(1);
  return found[0]!;
}

const FIXBUG = readRepo("examples/fixbug/fixbug.mdt");

/** FixBug with one textual change; fails loudly if the text to replace is gone. */
function fixbug(from: string, to: string): string {
  expect(FIXBUG.includes(from), `FixBug no longer contains: ${from}`).toBe(true);
  return FIXBUG.replace(from, to);
}

const fixbugErrors = (from: string, to: string): string[] => errorsOf(fixbug(from, to));

const program = (body: string): string => `module m @ 0.1
use std.{fs, git, human, model, money, test}
use std.decision.{DecisionModel, Choice, threshold, Confident, Uncertain}
use company.domain.{Issue, Patch, PullRequestDraft, PullRequest}
${body}
`;

describe("FixBug (§20) passes Gate 1", () => {
  it("has no errors, only the two run-time static criteria", () => {
    const r = check(FIXBUG, "mdt");
    expect(r.ok).toBe(true);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["MDT-W0601", "MDT-W0601"]);
  });

  it("stays inside its 20 USD budget with 18.5 USD declared by its agents", () => {
    const d = only(fixbug("budget  { spend: 20 USD, time: 3h }", "budget  { spend: 18 USD, time: 3h }"), "MDT-E0501");
    expect(d.at.path).toBe("/defs/FixBug/budget");
    expect(d.facts).toMatchObject({ spend: { limit: "18 USD", declared_by_children: "18.5 USD" } });
    const from = (d.facts!["breakdown"] as Array<{ from: string }>).map((p) => p.from);
    expect(from).toEqual(["Explorer.locate", "Planner.plan", "Implementer.apply", "TestWriter.regression", "Reviewer.counterexamples"]);
    expect(errorsOf(fixbug("budget  { spend: 20 USD, time: 3h }", "budget  { spend: 18.5 USD, time: 3h }"))).toEqual([]);
  });

  it("counts time in par as the longest branch: 15m + max(45m, 20m) fits in 1h", () => {
    expect(errorsOf(fixbug("budget  { spend: 20 USD, time: 3h }", "budget  { spend: 20 USD, time: 1h }"))).toEqual([]);
    const d = only(fixbug("budget  { spend: 20 USD, time: 3h }", "budget  { spend: 20 USD, time: 59m }"), "MDT-E0501");
    expect(d.facts).toMatchObject({ time_ms: { limit: 59 * 60_000, declared_by_children: 60 * 60_000 } });
  });

  it("delegates only capabilities the workflow holds (caps subset)", () => {
    // Without SrcWrite in the workflow, Implementer gets A.caps ∩ avail(ctx), which cannot write.
    const r = fixbugErrors("caps    RepoRead, SrcWrite, TestWrite, Build, ModelStd, PR", "caps    RepoRead, TestWrite, Build, ModelStd, PR");
    expect(r).toEqual(["MDT-E0301"]);
    expect(fixbugErrors("patch = delegate Implementer.apply(plan)", "patch = delegate Implementer.apply(plan) with caps PR")).toEqual(["MDT-E0701"]);
  });

  // FixBug with more capabilities in the workflow, so that only the agent side of C2 can fail.
  const WORKFLOW_CAPS = "caps    RepoRead, SrcWrite, TestWrite, Build, ModelStd, PR";
  const withMore = (more: string, from: string, to: string): string[] =>
    errorsOf(
      fixbug('capability PR        = git.pr("company/backend")', 'capability PR        = git.pr("company/backend")\ncapability MvnAny    = exec(commands: ["mvn"])')
        .replace(WORKFLOW_CAPS, `${WORKFLOW_CAPS}, ${more}`)
        .replace(from, to),
    );

  it("E0701: with caps cannot hand over another model tier than the agent holds (C2)", () => {
    const plan = "let plan     = delegate Planner.plan(issue, findings)";
    expect(withMore("ModelEco", plan, `${plan} with caps ModelEco`)).toEqual(["MDT-E0701"]);
    // Nor a tier the context does not hold: ModelStd does not cover ModelEco.
    expect(fixbugErrors(plan, `${plan} with caps ModelEco`)).toEqual(["MDT-E0701", "MDT-E0701"]);
    // An agent whose model capability names no tier may be given any tier.
    expect(
      errorsOf(
        fixbug("caps   ModelStd\n  budget { tokens: 150k", "caps   model.infer()\n  budget { tokens: 150k")
          .replace(WORKFLOW_CAPS, `${WORKFLOW_CAPS}, ModelEco`)
          .replace(plan, `${plan} with caps ModelEco`),
      ),
    ).toEqual([]);
  });

  it("E0701: with caps cannot hand over wider command arguments than the agent holds (C2)", () => {
    const apply = "patch = delegate Implementer.apply(plan)";
    // Build allows `mvn -q test …` and `mvn -q verify …`; `mvn -q …` and plain `mvn …` are wider.
    expect(withMore("MvnAny", apply, `${apply} with caps exec(commands: ["mvn"], args_prefix: [["-q"]])`)).toEqual(["MDT-E0701"]);
    expect(withMore("MvnAny", apply, `${apply} with caps MvnAny`)).toEqual(["MDT-E0701"]);
    // A longer prefix of an allowed one is narrower, and accepted.
    expect(withMore("MvnAny", apply, `${apply} with caps exec(commands: ["mvn"], args_prefix: [["-q", "test", "-Dtest=A"]])`)).toEqual([]);
  });

  it("gives the two par branches disjoint write scopes", () => {
    const r = check(fixbug('capability TestWrite = fs.write("/work/repo/test")', 'capability TestWrite = fs.write("/work/repo")'), "mdt");
    const d = r.diagnostics.find((x) => x.code === "MDT-E0320")!;
    expect(d.at.path).toBe("/defs/FixBug/body/2/branches/tests");
    expect(d.facts).toMatchObject({ branches: ["patch", "tests"] });
  });

  it("requires a step limit for every bodiless skill", () => {
    const d = only(fixbug("budget { tokens: 400k, time: 15m, spend: 3 USD, steps: 40 }", "budget { tokens: 400k, time: 15m, spend: 3 USD }"), "MDT-E0503");
    expect(d.at.path).toBe("/defs/Explorer/skills/locate");
  });

  it("never accepts review alone as evidence", () => {
    const src = fixbug("by static not pr.review.blocking\n       and review(model: standard, isolated)", "by review(model: standard, isolated)");
    expect(only(src, "MDT-E0603").at.path).toBe("/defs/FixAccepted/accept/no_blocking_review/by");
  });

  it("opens the PR only with a verified draft (V01, R4)", () => {
    expect(fixbugErrors("effect git.open_pr(checked)", "effect git.open_pr(draft)")).toEqual(["MDT-E0210"]);
    expect(fixbugErrors("effect git.open_pr(checked)", "effect git.open_pr(review)")).toEqual(["MDT-E0210"]);
  });

  it("opens the PR idempotently", () => {
    expect(fixbugErrors("    idempotent_by issue.id\n", "")).toEqual(["MDT-E0403"]);
  });

  it("does not send confidential findings to a model limited to internal data", () => {
    const src = fixbug(
      "type Finding = { file: Path, line: Int where line >= 1, claim: Text, evidence: EvidenceRef }",
      "type Finding = { file: Path, line: Int where line >= 1, claim: Text, evidence: EvidenceRef } classified confidential",
    );
    // Model output inherits the highest class of its input, so every later delegate is confidential too.
    const r = check(src, "mdt").diagnostics.filter((d) => d.code === "MDT-E0220");
    expect(r.map((d) => d.at.path)).toEqual(["/defs/FixBug/body/1/value", "/defs/FixBug/body/2/branches/patch", "/defs/FixBug/body/3/value"]);
    expect(r[0]!.facts).toEqual({ data_class: "confidential", allowed: "internal" });
    const allowed = src.replace("capability ModelStd  = model.infer(tier: standard)", "capability ModelStd  = model.infer(tier: standard, max_class: confidential)");
    expect(errorsOf(allowed)).toEqual([]);
  });

  it("flags capabilities nothing uses", () => {
    const src = fixbug("capability PR        = git.pr(\"company/backend\")", "capability PR        = git.pr(\"company/backend\")\ncapability Web       = net.https(hosts: [\"example.com\"])").replace(
      "caps    RepoRead, SrcWrite, TestWrite, Build, ModelStd, PR",
      "caps    RepoRead, SrcWrite, TestWrite, Build, ModelStd, PR, Web",
    );
    expect(only(src, "MDT-W0310").at.path).toBe("/defs/FixBug/caps/6");
    expect(check(src, "mdt").ok).toBe(true);
  });
});

describe("S04 call cycle", () => {
  it("rejects mutual recursion", () => {
    const d = only(program("fn even(n: Int) -> Bool { odd(n - 1) }\nfn odd(n: Int) -> Bool { even(n - 1) }"), "MDT-E0502");
    expect(d.facts).toEqual({ cycle: ["even", "odd"] });
  });
});

describe("S05 missing union arm", () => {
  it("rejects a switch that leaves out a variant", () => {
    const d = only(
      program(`type Kind = Bug | Feature | Question
fn label(k: Kind) -> Text {
  switch k {
    Bug => "bug"
    Feature => "feature"
  }
}`),
      "MDT-E0230",
    );
    expect(d.facts).toEqual({ missing: ["Question"] });
  });

  it("accepts a catch-all arm", () => {
    expect(errorsOf(program("type Kind = Bug | Feature\nfn label(k: Kind) -> Text {\n  switch k {\n    Bug => \"bug\"\n    _ => \"other\"\n  }\n}"))).toEqual([]);
  });
});

describe("S06 unbounded iteration", () => {
  it("rejects a loop with neither max_iter nor until", () => {
    expect(errorsOf(program("fn spin(n: Int) -> Int {\n  loop {\n    n\n  }\n  n\n}"))).toEqual(["MDT-E0502"]);
    expect(errorsOf(program("fn spin(n: Int) -> Int {\n  loop max_iter 3 {\n    n\n  }\n  n\n}"))).toEqual([]);
  });
});

describe("S07 external write inside a call", () => {
  it("rejects a critical effect in a function", () => {
    const d = only(
      program(`fn note(issue: Issue) -> Bool {
  effect git.comment(issue, "seen") idempotent_by issue.id
  true
}`),
      "MDT-E0408",
    );
    expect(d.at.path).toBe("/defs/note/body/0/value");
  });

  it("rejects a skill that declares a critical effect", () => {
    const src = program(`capability PR = git.pr("company/backend")
agent Bot {
  caps PR
  budget { steps: 5 }
  skill ship(d: Verified<PullRequestDraft>) -> PullRequest ! {git.open_pr}
}`);
    expect(codesOf(src)).toContain("MDT-E0408");
  });
});

describe("S08 protected nominal types", () => {
  it("rejects a skill that returns Evidence", () => {
    const src = program(`capability M = model.infer(tier: standard)
agent A {
  caps M
  budget { steps: 5 }
  skill prove(i: Issue) -> Evidence<Text> ! {Model}
}`);
    expect(only(src, "MDT-E0213").at.path).toBe("/defs/A/skills/prove/returns");
  });

  it("rejects building Authorization in a program and inferring Receipt", () => {
    expect(errorsOf(program("fn forge(i: Issue) -> Bool {\n  let a = Authorization { by: \"me\" }\n  true\n}"))).toEqual(["MDT-E0213"]);
    expect(errorsOf(program("fn fake(t: Text) -> Inferred<Receipt<Text>> ! {Model} {\n  infer Receipt<Text> from quote(t)\n}"))).toEqual(["MDT-E0213"]);
  });

  it("rejects host code that claims to produce Verified", () => {
    expect(errorsOf(program('extern ts "x.ts"::check(p: Patch) -> Verified<Patch>\n  ! {}'))).toEqual(["MDT-E0213"]);
  });
});

describe("V02 untrusted text in an instruction position", () => {
  const fn = (part: string): string =>
    program(`fn summarize(path: Path) -> Inferred<Text> ! {Fs.Read, Model} {
  let log = fs.read_text(path)
  infer Text from prompt"""
    Summarize this log.
    ${part}
  """
}`);

  it("rejects untrusted text interpolated into a prompt", () => {
    expect(only(fn("{log}"), "MDT-E0215").facts).toEqual({ level: "untrusted" });
  });

  it("accepts it as quoted data", () => {
    expect(errorsOf(fn("{quote(log)}"))).toEqual([]);
  });
});

describe("R5 untrusted scope", () => {
  it("rejects narrowing a capability to a path read from a file", () => {
    const src = program(`capability W = fs.write("/work")
capability R = fs.read("/work")
agent A {
  caps W
  budget { steps: 5 }
  skill s(t: Text) -> Bool ! {Fs.Write}
}
workflow Wf(p: Path) -> Bool
  caps R, W
{
  let target = fs.read_text(p)
  delegate A.s("x") with caps W.narrow(target)
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0215"]);
    expect(only(src, "MDT-E0215").facts).toEqual({ level: "untrusted" });
    // A trusted run-time path is fine: narrow intersects with the base scope at run time.
    expect(errorsOf(src.replace("let target = fs.read_text(p)", "let target = p"))).toEqual([]);
  });
});

describe("V03 overlapping writes in par", () => {
  const SPLIT = readRepo("compiler/test/fixtures/syntax/supervision.mdt");
  const narrow = 'with caps RepoWrite.narrow("/work/repo/src")';

  it("accepts disjoint narrowed scopes (§7.4)", () => {
    expect(check(SPLIT, "mdt").ok).toBe(true);
  });

  it("rejects a branch that keeps the whole write capability", () => {
    expect(errorsOf(SPLIT.replace(narrow, "with caps RepoWrite"))).toEqual(["MDT-E0320"]);
  });

  it("compares paths by segment, not by string prefix", () => {
    const split = SPLIT.replace(
      'capability RepoWrite = fs.write("/work/repo/src", "/work/repo/test")',
      'capability RepoWrite = fs.write("/work/repo/src", "/work/repo/src2")',
    ).replace('RepoWrite.narrow("/work/repo/test")', 'RepoWrite.narrow("/work/repo/src2")');
    expect(errorsOf(split)).toEqual([]);
  });

  it("rejects widening a capability with narrow (C3)", () => {
    expect(errorsOf(SPLIT.replace(narrow, 'with caps RepoWrite.narrow("/work")'))).toContain("MDT-E0305");
  });
});

describe("V04 restricted data to a model", () => {
  const src = (cap: string): string =>
    program(`type Record = { name: Text } classified restricted
capability M = ${cap}
agent Summarizer {
  caps M
  budget { steps: 5 }
  skill summarize(r: Record) -> Inferred<Text> ! {Model}
}
workflow Summarize(r: Record) -> Inferred<Text>
  caps M
{
  delegate Summarizer.summarize(r)
}`);

  it("rejects it under the default max_class (internal)", () => {
    expect(only(src("model.infer(tier: standard)"), "MDT-E0220").facts).toEqual({ data_class: "restricted", allowed: "internal" });
  });

  it("accepts it when the model capability allows restricted data", () => {
    expect(errorsOf(src("model.infer(tier: local, max_class: restricted)"))).toEqual([]);
  });

  it("keeps the class through fields and string building", () => {
    const fn = program(`type Record = { name: Text } classified restricted
capability M = model.infer(tier: standard)
workflow Greet(r: Record) -> Inferred<Text>
  caps M
{
  let name = r.name
  infer Text from quote("Hello {name}")
}`);
    expect(errorsOf(fn)).toEqual(["MDT-E0220"]);
  });
});

describe("V05 dynamic spawn", () => {
  it("is not available in 0.1", () => {
    const src = program(`capability M = model.infer(tier: standard)
agent A {
  caps M
  budget { steps: 5 }
  skill s(i: Issue) -> Inferred<Text> ! {Model}
}
workflow W(i: Issue) -> Bool
  caps M
{
  let t = spawn A.s(i)
  true
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0711"]);
  });
});

describe("V06 UnknownOutcome", () => {
  const src = (strategy: string): string =>
    program(`capability PR = git.pr("company/backend")
workflow W(i: Issue) -> Bool
  caps PR
{
  effect git.comment(i, "hello") idempotent_by i.id
  on error(UnknownOutcome) => ${strategy}
  true
}`);

  it("can only be reconciled, never restarted", () => {
    expect(errorsOf(src("restart"))).toEqual(["MDT-E0712"]);
    expect(errorsOf(src("reconcile"))).toEqual([]);
  });
});

describe("decision models (V07, V08, D2, D8)", () => {
  const DECISION = readRepo("compiler/test/fixtures/syntax/decision.mdt");

  it("V07 requires the Uncertain arm", () => {
    const src = DECISION.replace('    Uncertain            => escalate human("Request type is unclear: {d.distribution}")\n', "");
    expect(only(src, "MDT-E0230").facts).toEqual({ missing: ["Uncertain"] });
  });

  it("V08 never binds a decision to a critical effect", () => {
    const src = program(`type Kind = Merge | Other
capability PR = git.pr("company/backend")
fn decide(i: Issue) -> Inferred<Decision<Kind>> ! {Model} {
  infer Choice<Kind> from quote(i.title)
}
workflow W(i: Issue) -> Bool
  caps PR, model.infer(tier: decision)
{
  let d = decide(i)
  effect git.merge(d) idempotent_by i.id
  true
}`);
    expect(errorsOf(src)).toContain("MDT-E0210");
  });

  it("D2 rejects a switch on a raw decision", () => {
    expect(errorsOf(DECISION.replace("switch threshold(d, min_confidence: 0.85) {", "switch d {"))).toContain("MDT-E0231");
  });

  it("D8 warns about a Choice without an out-of-scope option", () => {
    const src = DECISION.replace("type RequestKind = Refund | Complaint | Question | Other", "type RequestKind = Refund | Complaint | Question");
    const d = only(src, "MDT-W0232");
    expect(d.severity).toBe("warning");
    expect(check(src, "mdt").ok).toBe(true);
  });
});

describe("types and epistemic rules", () => {
  it("R1: model output does not become a plain value", () => {
    const src = program(`fn plan(i: Issue) -> Inferred<Text> ! {Model} {
  infer Text from quote(i.title)
}
fn use_it(i: Issue) -> Text ! {Model} {
  plan(i)
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0210"]);
  });

  it("R6: a record built from inferred parts stays inferred", () => {
    const src = program(`type Pair = { a: Text, b: Text }
fn guess(i: Issue) -> Inferred<Text> ! {Model} {
  infer Text from quote(i.title)
}
fn pair(i: Issue) -> Pair ! {Model} {
  Pair { a: "x", b: guess(i) }
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0210"]);
  });

  it("E0211: untrusted content is not a trusted value", () => {
    const src = program(`fn read(p: Path) -> Text ! {Fs.Read} {
  fs.read_text(p)
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0211"]);
  });

  it("E0212: a value verified against another contract is rejected", () => {
    const src = program(`contract A(d: PullRequestDraft) {
  accept ok "ok" by human.approve(role: "owner")
}
contract B(d: PullRequestDraft) {
  accept ok "ok" by human.approve(role: "owner")
}
fn ship(d: Verified<PullRequestDraft, A>) -> Bool { true }
fn go(d: PullRequestDraft) -> Bool {
  let v = verify d against B(d)
  ship(v)
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0212"]);
  });

  it("E0202 and E0203: record fields are checked against local types", () => {
    expect(errorsOf(program('type P = { a: Text, b: Int }\nlet x = P { a: "x", c: 1 }'))).toEqual(["MDT-E0202", "MDT-E0203"]);
    expect(errorsOf(program("type P = { a: Text }\nfn f(p: P) -> Text { p.b }"))).toEqual(["MDT-E0202"]);
  });

  it("E0201: wrong argument types and counts", () => {
    expect(errorsOf(program('fn f(n: Int) -> Int { n }\nlet x = f("one")'))).toEqual(["MDT-E0201"]);
    expect(errorsOf(program("fn f(n: Int) -> Int { n }\nlet x = f(1, 2)"))).toEqual(["MDT-E0201"]);
  });

  it("W0207: peek is allowed but reported", () => {
    const src = program(`fn guess(i: Issue) -> Inferred<Text> ! {Model} {
  infer Text from quote(i.title)
}
fn look(i: Issue) -> Text ! {Model} {
  peek(guess(i))
}`);
    expect(codesOf(src)).toEqual(["MDT-W0207"]);
  });
});

describe("effects", () => {
  it("E0401: a function uses an effect it does not declare", () => {
    const d = only(program("fn f(t: Text) -> Inferred<Text> ! {Fs.Read} {\n  infer Text from quote(t)\n}"), "MDT-E0401");
    expect(d.facts).toEqual({ used: "Model", declared: ["Fs.Read"] });
  });

  it("E0401: a public function must declare its effects", () => {
    expect(errorsOf(program("pub fn f(t: Text) -> Text { t }"))).toEqual(["MDT-E0401"]);
  });

  it("E0401: effects propagate through calls", () => {
    const src = program(`fn a(t: Text) -> Inferred<Text> ! {Model} {
  infer Text from quote(t)
}
fn b(t: Text) -> Inferred<Text> ! {} {
  a(t)
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0401"]);
  });

  it("E0402: unknown effect names", () => {
    expect(errorsOf(program("fn f(t: Text) -> Text ! {Fs.Rread} { t }"))).toEqual(["MDT-E0402"]);
  });

  it("E0403: a critical effect must declare idempotency", () => {
    const src = program(`effect pay(amount: Money) -> Bool
  requires caps money.spend()
  critical`);
    expect(errorsOf(src)).toEqual(["MDT-E0403"]);
  });

  it("E0405: an irreversible effect needs a human approval first", () => {
    const src = (pre: string): string =>
      program(`capability PR = git.pr("company/backend")
contract Reviewed(d: PullRequestDraft) {
  accept ok "ok" by test.suite(["unit"])
}
workflow Merge(d: PullRequestDraft, i: Issue) -> Bool
  caps PR
{
  let v = verify d against Reviewed(d)
${pre}  effect git.merge(v) idempotent_by i.id
  true
}`);
    expect(errorsOf(src(""))).toEqual(["MDT-E0405"]);
    expect(errorsOf(src('  let ok = human.approve(role: "owner")\n'))).toEqual([]);
  });

  it("E0210: critical effect parameters cannot be declared Inferred", () => {
    const src = program(`effect publish(text: Inferred<Text>) -> Bool
  requires caps git.pr(repo)
  critical
  idempotency required`);
    expect(errorsOf(src)).toEqual(["MDT-E0210"]);
  });
});

describe("capabilities", () => {
  it("E0301: a workflow uses an effect no capability authorizes", () => {
    const src = program(`capability R = fs.read("/a")
workflow W(t: Text) -> Inferred<Text>
  caps R
{
  infer Text from quote(t)
}`);
    const d = only(src, "MDT-E0301");
    expect(d.facts).toEqual({ required: "Model", available: ['R = fs.read("/a")'] });
  });

  it("E0301: an agent's skill uses an effect its capabilities do not cover", () => {
    const src = program(`capability R = fs.read("/a")
agent A {
  caps R
  budget { steps: 5 }
  skill s(t: Text) -> Inferred<Text> ! {Fs.Read, Model}
}`);
    expect(only(src, "MDT-E0301").at.path).toBe("/defs/A/skills/s/effects/1");
  });

  it("E0701: with caps cannot hand over more than the agent holds", () => {
    const src = program(`capability R = fs.read("/a")
capability W = fs.write("/a")
agent A {
  caps R
  budget { steps: 5 }
  skill s(t: Text) -> Bool ! {Fs.Read}
}
workflow Wf(t: Text) -> Bool
  caps R, W
{
  delegate A.s(t) with caps W
}`);
    expect(errorsOf(src)).toContain("MDT-E0701");
  });
});

describe("budgets and supervision", () => {
  const agents = `capability M = model.infer(tier: standard)
capability PR = git.pr("company/backend")
agent A {
  caps M
  budget { spend: 2 USD, tokens: 10k, steps: 5 }
  skill s(i: Issue) -> Inferred<Text> ! {Model}
}`;

  it("multiplies loop bodies by max_iter", () => {
    const src = program(`${agents}
workflow W(i: Issue) -> Bool
  caps M
  budget { spend: 5 USD }
{
  loop max_iter 3 {
    let t = delegate A.s(i)
  }
  true
}`);
    const d = only(src, "MDT-E0501");
    expect(d.facts).toMatchObject({ spend: { limit: "5 USD", declared_by_children: "6 USD" } });
  });

  it("counts only one switch arm, and what budget-less functions delegate", () => {
    const src = (limit: string): string =>
      program(`${agents}
type Kind = Small | Large
fn twice(i: Issue) -> Bool {
  let a = delegate A.s(i)
  let b = delegate A.s(i)
  true
}
workflow W(i: Issue, k: Kind) -> Bool
  caps M
  budget { spend: ${limit} }
{
  switch k {
    Small => delegate A.s(i)
    Large => twice(i)
  }
  true
}`);
    expect(errorsOf(src("4 USD"))).toEqual([]);
    const d = only(src("3 USD"), "MDT-E0501");
    expect(d.facts).toMatchObject({ spend: { limit: "3 USD", declared_by_children: "4 USD" } });
    expect((d.facts!["breakdown"] as Array<{ at: string }>).map((p) => p.at)).toEqual([
      "/defs/W/body/0/value/cases/0/then",
      "/defs/W/body/0/value/cases/1/then",
      "/defs/W/body/0/value/cases/1/then",
    ]);
  });

  it("E0504: never converts currencies", () => {
    const src = program(`${agents.replace("2 USD", "2 EUR")}
workflow W(i: Issue) -> Bool
  caps M
  budget { spend: 5 USD }
{
  let t = delegate A.s(i)
  true
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0504"]);
  });

  it("E0710: restart_all cannot restart branches with external effects", () => {
    const src = program(`${agents}
workflow W(i: Issue) -> Bool
  caps M, PR
{
  par supervise restart_all {
    a = delegate A.s(i)
    b = effect git.comment(i, "x") idempotent_by i.id
  }
  true
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0710"]);
  });

  it("E0713: restart is capped at 5 retries", () => {
    const src = program(`${agents}
workflow W(i: Issue) -> Bool
  caps M
{
  let t = delegate A.s(i) supervise restart(max: 6)
  true
}`);
    expect(errorsOf(src)).toEqual(["MDT-E0713"]);
  });

  it("E0105: a workflow expands to at most 1000 static nodes", () => {
    const src = program(`${agents}
workflow W(i: Issue) -> Bool
  caps M
{
  loop max_iter 600 {
    let t = delegate A.s(i)
  }
  true
}`);
    const d = only(src, "MDT-E0105");
    // 600 × (let + delegate) + the loop + the tail expression
    expect(d.facts).toEqual({ nodes: 1202, limit: 1000 });
  });
});

describe("diagnostics", () => {
  it("are the same for the text form and the canonical IR", () => {
    const src = fixbug("effect git.open_pr(checked)", "effect git.open_pr(draft)");
    const fromText = check(src, "mdt");
    const fromIr = check(JSON.stringify(fromText.program), "json");
    const strip = (ds: Diagnostic[]): unknown[] => ds.map((d) => ({ code: d.code, path: d.at.path, facts: d.facts }));
    expect(strip(fromIr.diagnostics)).toEqual(strip(fromText.diagnostics));
  });
});
