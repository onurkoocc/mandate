// A 0.4 program's tests (Doc 4 §6.4; spec/envelope.md "Signed decisions"):
// a 0.4 package takes signed decisions only, so the test runner makes up two
// members for each role the program names and signs for them. The handlers
// decide as before: `auto_approve()` approves every wait, with a second member
// where an approval must be `distinct_from` an earlier one; `auto_approve(role:
// r)` decides only r's waits; `answer(text)` answers a question a role is
// asked. The same program as 0.3, with its roles as texts, still decides by
// name, as it always did.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, type Program } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runTests, type TestResult } from "../src/testing.js";
import { closeAll, world } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-tests-signed-"));
afterAll(async () => {
  await closeAll();
  rmSync(dir, { recursive: true, force: true });
});

const TESTS = `test "both approve" {
  with handlers { Human = auto_approve() }
  run Ship("v1") expect ok
}

test "both decline" {
  with handlers { Human = auto_decline() }
  run Ship("v1") expect failed
}

test "the code owner alone" {
  with handlers { Human = auto_approve(role: "code_owner") }
  run Ship("v1") expect waiting
}

test "a reviewer answers" {
  with handlers { Human = answer("yes") }
  run Ask("v1") expect ok
}
`;

const SIGNED = `mandate @ 0.4

module t.signed @ 0.1

use std.{fs, human}

role code_owner "Code owner"
role reviewer   "Reviewer"

capability Note = fs.read("/tmp/notes")

contract Approved(t: Text) {
  accept approved "Two people approved"
    by human.approve(role: code_owner) and human.approve(role: reviewer, distinct_from: code_owner)
}

workflow Ship(t: Text) -> Text
  caps Note
{
  let checked = verify t against Approved(t)
  "shipped"
}

workflow Ask(t: Text) -> Untrusted<Text>
  caps Note
{
  human.ask("Go on?", role: reviewer)
}

${TESTS}`;

/** The same program before 0.4: no role definitions, roles as texts, and no distinct_from. */
const NAMED = `mandate @ 0.3

module t.named @ 0.1

use std.{fs, human}

capability Note = fs.read("/tmp/notes")

contract Approved(t: Text) {
  accept approved "Two people approved"
    by human.approve(role: "code_owner") and human.approve(role: "reviewer")
}

workflow Ship(t: Text) -> Text
  caps Note
{
  let checked = verify t against Approved(t)
  "shipped"
}

workflow Ask(t: Text) -> Untrusted<Text>
  caps Note
{
  human.ask("Go on?", role: "reviewer")
}

${TESTS}`;

function program(src: string): Program {
  const r = check(src, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return r.program!;
}

async function results(src: string): Promise<Record<string, TestResult>> {
  const w = await world(src);
  return Object.fromEntries((await runTests(program(src), { db: w.db, dir })).map((r) => [r.test, r]));
}

describe("a 0.4 program's tests", () => {
  it("sign for made-up members of each role: two approvals by two people, two declines, one role's, and a reviewer's answer", async () => {
    const w = await world(SIGNED);
    const by = Object.fromEntries((await runTests(program(SIGNED), { db: w.db, dir })).map((r) => [r.test, r]));
    expect(by["both approve"]).toMatchObject({ ok: true, state: "succeeded", detail: "shipped" });
    expect(by["both decline"]).toMatchObject({ ok: true, state: "failed" });
    // auto_approve(role:) decides the code owner's wait only, so the run waits for the reviewer.
    expect(by["the code owner alone"]).toMatchObject({ ok: true, state: "waiting", detail: expect.objectContaining({ request: expect.objectContaining({ role: "reviewer", distinct_from: "code_owner" }) }) });
    expect(by["a reviewer answers"]).toMatchObject({ ok: true, state: "succeeded", detail: "yes" });

    // Every decision is a signed record; the two approvals are by two members, each in the role asked.
    const decisions = await w.db.query<{ run_id: string; record: { kind: string; member: string; role?: string } }>("select run_id, record from decisions order by run_id, decision_id");
    const of = (test: string) => decisions.filter((d) => d.run_id === `test:${test}:0`).map((d) => [d.record.kind, d.record.member, d.record.role]);
    expect(of("both approve").sort()).toEqual([
      ["approve", "test_1_code_owner", "code_owner"],
      ["approve", "test_2_reviewer", "reviewer"],
    ]);
    expect(of("both decline").sort()).toEqual([
      ["decline", "test_1_code_owner", "code_owner"],
      ["decline", "test_2_reviewer", "reviewer"],
    ]);
    expect(of("the code owner alone")).toEqual([["approve", "test_1_code_owner", "code_owner"]]);
    expect(of("a reviewer answers")).toEqual([["answer", "test_1_reviewer", "reviewer"]]);
  }, 120_000);

  it("pass through `mandate test`, which needs no configuration", async () => {
    const file = join(dir, "signed.mdt");
    writeFileSync(file, SIGNED);
    let out = "";
    const code = await main(["test", file], (s) => (out += s), {});
    expect(out).toContain("ok   both approve: Ship expected ok, got it");
    expect(out).toContain("ok   a reviewer answers: Ask expected ok, got it");
    expect(code, out).toBe(0);
  }, 120_000);
});

describe("an earlier program's tests", () => {
  it("decide by name, as before: the same tests pass on the program as 0.3", async () => {
    const by = await results(NAMED);
    expect(Object.values(by).map((r) => [r.test, r.state, r.ok])).toEqual([
      ["a reviewer answers", "succeeded", true],
      ["both approve", "succeeded", true],
      ["both decline", "failed", true],
      ["the code owner alone", "waiting", true],
    ]);
    expect(by["the code owner alone"]!.detail).toMatchObject({ request: { role: "reviewer" } });
    const w = await world(NAMED);
    await runTests(program(NAMED), { db: w.db, dir });
    expect(await w.db.query("select decision_id from decisions")).toEqual([]);
  }, 120_000);
});
