// The lock's people in the semantic diff (spec/envelope.md, "The lock: members
// and roles"; spec/views.md, "What changed between two versions"): a member,
// a member's key or a member of a role added or removed is a governance
// change, and two locks with the same people add nothing to the diff.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import type { Lock } from "../src/lock.js";
import { toMarkdown } from "../src/views/doc.js";
import { diffDoc, lockDiff, semanticDiff } from "../src/views/views.js";
import { readRepo } from "./helpers.js";

const PEOPLE = `mandate @ 0.4

module example.people @ 0.1

use std.{human, model}

role code_owner "Code owner"
role reviewer   "Reviewer"

capability M = model.infer(tier: standard)

type Draft = { text: Text }

agent A {
  caps   M
  budget { steps: 2 }
  skill s(x: Text) -> Inferred<Draft> ! {Model}
}

contract Ready(d: Draft) {
  accept approved "Two people approved"
    by human.approve(role: code_owner) and human.approve(role: reviewer, distinct_from: code_owner)
}

workflow W(x: Text) -> Text
  caps M
{
  let d = delegate A.s(x) supervise escalate(human, role: code_owner)
  let v = verify d against Ready(d)
  "done"
}
`;

const FIXBUG_LOCK = JSON.parse(readRepo("fixtures/fixbug/mandate.lock.json")) as Lock;
const K1 = `sha256:${"1".repeat(64)}`;
const K2 = `sha256:${"2".repeat(64)}`;
const K3 = `sha256:${"3".repeat(64)}`;

/** A 0.4 lock over fixbug's models and modules, with these people. */
const V04 = (members: Record<string, { keys: string[] }>, roles: Record<string, string[]>): Lock => ({ ...structuredClone(FIXBUG_LOCK), lock: "mandate/lock/0.4", members, roles });
const BASE = (): Lock => V04({ alice: { keys: [K1] }, bob: { keys: [K2] } }, { code_owner: ["alice"], reviewer: ["bob"] });

describe("lockDiff", () => {
  it("lists a member added, with the number of its keys and not each key", () => {
    const after = BASE();
    after.members!.carol = { keys: [K3, `sha256:${"4".repeat(64)}`] };
    expect(lockDiff(BASE(), after)).toEqual([{ path: "/members/carol", text: "+ member carol (2 keys)" }]);
    after.members!.carol = { keys: [K3] };
    expect(lockDiff(BASE(), after)).toEqual([{ path: "/members/carol", text: "+ member carol (1 key)" }]);
  });

  it("lists a member removed, without its keys", () => {
    const before = BASE();
    before.members!.carol = { keys: [K3] };
    expect(lockDiff(before, BASE())).toEqual([{ path: "/members/carol", text: "- member carol" }]);
  });

  it("lists a key added to a member present on both sides, by its full id", () => {
    const after = BASE();
    after.members!.alice!.keys.push(K3);
    expect(lockDiff(BASE(), after)).toEqual([{ path: `/members/alice/keys/${K3}`, text: `+ key ${K3} for alice` }]);
  });

  it("lists a key removed from a member present on both sides", () => {
    const after = BASE();
    after.members!.alice!.keys = [];
    expect(lockDiff(BASE(), after)).toEqual([{ path: `/members/alice/keys/${K1}`, text: `- key ${K1} for alice` }]);
  });

  it("lists a member added to a role", () => {
    const after = BASE();
    after.roles!.reviewer!.push("alice");
    expect(lockDiff(BASE(), after)).toEqual([{ path: "/roles/reviewer/alice", text: "+ alice holds role reviewer" }]);
  });

  it("lists a member removed from a role", () => {
    const after = BASE();
    after.roles!.code_owner = [];
    expect(lockDiff(BASE(), after)).toEqual([{ path: "/roles/code_owner/alice", text: "- alice no longer holds role code_owner" }]);
  });

  it("lists each member of a new role as added", () => {
    const after = BASE();
    after.roles!.architect = ["bob", "alice"];
    expect(lockDiff(BASE(), after)).toEqual([
      { path: "/roles/architect/alice", text: "+ alice holds role architect" },
      { path: "/roles/architect/bob", text: "+ bob holds role architect" },
    ]);
  });

  it("lists each member of a role that is gone as removed", () => {
    const after = BASE();
    delete after.roles!.reviewer;
    expect(lockDiff(BASE(), after)).toEqual([{ path: "/roles/reviewer/bob", text: "- bob no longer holds role reviewer" }]);
  });

  it("finds nothing between two locks with the same people", () => {
    expect(lockDiff(BASE(), BASE())).toEqual([]);
  });

  it("finds nothing when there is no lock on either side", () => {
    expect(lockDiff(undefined, undefined)).toEqual([]);
  });

  it("reads a 0.3 lock, which has no members or roles, as binding no one", () => {
    expect(lockDiff(structuredClone(FIXBUG_LOCK), BASE()).map((c) => c.text)).toEqual(["+ member alice (1 key)", "+ member bob (1 key)", "+ alice holds role code_owner", "+ bob holds role reviewer"]);
    expect(lockDiff(BASE(), undefined).map((c) => c.text)).toEqual(["- member alice", "- member bob", "- alice no longer holds role code_owner", "- bob no longer holds role reviewer"]);
  });

  it("orders members by name with their keys sorted, then roles by name with their members sorted", () => {
    const before = V04({}, {});
    const after = V04({ zed: { keys: [K1] }, amy: { keys: [K2] } }, { zz_role: ["zed", "amy"], aa_role: ["zed"] });
    expect(lockDiff(before, after).map((c) => c.text)).toEqual(["+ member amy (1 key)", "+ member zed (1 key)", "+ zed holds role aa_role", "+ amy holds role zz_role", "+ zed holds role zz_role"]);
    const keyed = V04({ amy: { keys: [K3, K1, K2] } }, {});
    expect(lockDiff(V04({ amy: { keys: [] } }, {}), keyed).map((c) => c.text)).toEqual([`+ key ${K1} for amy`, `+ key ${K2} for amy`, `+ key ${K3} for amy`]);
  });

  it("reads a member or a role called constructor as any other name", () => {
    const after = V04({ constructor: { keys: [K1] } }, { constructor: ["constructor"] });
    expect(lockDiff(V04({}, {}), after).map((c) => c.text)).toEqual(["+ member constructor (1 key)", "+ constructor holds role constructor"]);
    expect(lockDiff(after, after)).toEqual([]);
  });

  it("escapes a name in the path as a JSON Pointer token", () => {
    expect(lockDiff(V04({}, {}), V04({ "a/b~c": { keys: [] } }, {}))).toEqual([{ path: "/members/a~1b~0c", text: "+ member a/b~c (0 keys)" }]);
  });
});

describe("the lock in the semantic diff", () => {
  const people = () => {
    const r = check(PEOPLE, "mdt", { lock: BASE() });
    expect(r.diagnostics).toEqual([]);
    return r.program!;
  };

  it("H05: lists a changed role binding of the same program under governance, with no behavior change", () => {
    const p = people();
    const after = BASE();
    after.roles!.code_owner = ["bob"];
    const v = semanticDiff(p, p, { before: BASE(), after });
    expect(v.behavior).toEqual([]);
    expect(v.governance).toEqual([
      { path: "/roles/code_owner/alice", text: "- alice no longer holds role code_owner" },
      { path: "/roles/code_owner/bob", text: "+ bob holds role code_owner" },
    ]);
    expect(v.unchanged).not.toContain("no authority added");
    expect(toMarkdown(diffDoc(p, p, { before: BASE(), after }))).toContain("+ bob holds role code_owner");
  });

  it("lists the lock's changes after the program's own governance changes", () => {
    const p = people();
    const wider = check(PEOPLE.replace("budget { steps: 2 }", "budget { steps: 3 }"), "mdt").program!;
    const after = BASE();
    after.members!.carol = { keys: [K3] };
    expect(semanticDiff(p, wider, { before: BASE(), after }).governance.map((g) => g.text)).toEqual(["~ A.budget.steps: 2 → 3", "+ member carol (1 key)"]);
  });

  it("adds nothing when both versions bind the same people, or when no lock is given", () => {
    const p = people();
    expect(semanticDiff(p, p, { before: BASE(), after: BASE() })).toEqual(semanticDiff(p, p));
    expect(semanticDiff(p, p, {})).toEqual(semanticDiff(p, p));
    expect(toMarkdown(diffDoc(p, p, { before: BASE(), after: BASE() }))).toEqual(toMarkdown(diffDoc(p, p)));
  });
});
