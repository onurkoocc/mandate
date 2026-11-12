// Roles (0.4; spec/envelope.md "Roles", "The lock: members and roles",
// "distinct_from"): in a 0.4 module every place that names a role names a role
// definition, local or imported (E1501); with a lock, every role has a member
// (E1502); and distinct_from names a role approved earlier in the same
// criterion (E1503). A 0.1 to 0.3 program names roles with any text, as before.
// Each rule fires on one change to a program that checks.

import { describe, expect, it } from "vitest";
import { check, loadModules } from "../src/check.js";
import { roleSites, rolesNamed } from "../src/check/roles.js";
import { CODES } from "../src/codes.js";
import { hashProgram } from "../src/hash.js";
import type { Json } from "../src/json/strict-json.js";
import type { Lock } from "../src/lock.js";
import type { Modules } from "../src/modules.js";
import { readRepo } from "./helpers.js";

/** Every place a person is asked, each naming a role: approvals, a question and two escalations. */
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
    on unmet(c) => escalate human("Open: {c}", role: code_owner)
  let go = human.ask("Go on?", role: reviewer)
  "done"
}
`;

const ACME = readRepo("fixtures/system/acme.system.mdt");

/** Acme's change set, in 0.4: the set and one member approved by a role, beside a component and an environment of its own. */
const LAND = (() => {
  let src = readRepo("fixtures/system/land.mdt");
  const swap = (from: string, to: string): void => {
    expect(src.includes(from), from).toBe(true);
    src = src.replace(from, to);
  };
  swap("mandate @ 0.3", "mandate @ 0.4");
  swap(
    "type Plan",
    `role architect "Architect"

component billing {
  repo     "acme/billing"
  root     "/work/acme-billing"
  lang     ts
  owner    role "architect"
}

environment qa {
  class internal
  authorize deploy by human(role: "architect")
}

type Plan`,
  );
  swap("member mcp = git.merge(m)", 'member mcp = git.merge(m) approved_by role "architect"');
  return src;
})();

const MIGRATE_ALL = readRepo("fixtures/envelope/migrate-all.mdt");

function acme(): Modules {
  const { modules, problems } = loadModules([{ file: "acme.system.mdt", text: ACME, kind: "mdt" }]);
  expect(problems).toEqual([]);
  return modules;
}

function domain(): Modules {
  const { modules, problems } = loadModules([{ file: "domain.mdt", text: readRepo("fixtures/envelope/domain.mdt"), kind: "mdt" }]);
  expect(problems).toEqual([]);
  return modules;
}

/** `src` with one textual change; fails loudly if the text is gone. */
function mutate(src: string, from: string, to: string): string {
  expect(src.includes(from), from).toBe(true);
  return src.replace(from, to);
}

/** The errors of a check, by code and path; warnings (W0601 for Land's static criteria) are left out. */
function errors(src: string, opts: Parameters<typeof check>[2] = {}): Array<[string, string | undefined]> {
  return check(src, "mdt", opts)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => [d.code, d.at.path]);
}

/** A role definition added before the program's first one: the declaration that makes a name a role. */
function declare(src: string, role: string): string {
  expect(/^role \w+ "/m.test(src)).toBe(true);
  return src.replace(/^(role \w+ ")/m, `role ${role} "A role"\n$1`);
}

describe("the programs under test", () => {
  it("check without errors", () => {
    expect(check(PEOPLE, "mdt").diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    expect(errors(LAND, { modules: acme() })).toEqual([]);
    expect(check(MIGRATE_ALL, "mdt", { modules: domain() }).diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });
});

describe("E1501: a role named in a 0.4 module is a role definition", () => {
  // Each place, with the role it names changed to `auditor`, which no definition declares.
  const SITES: Array<{ where: string; src: string; from: string; to: string; path: string; opts?: () => Parameters<typeof check>[2] }> = [
    {
      where: "human.approve(role: …)",
      src: PEOPLE,
      from: "human.approve(role: reviewer, distinct_from",
      to: "human.approve(role: auditor, distinct_from",
      path: "/defs/Ready/accept/approved/by/all/1/call/args/0/value",
    },
    { where: "human.ask(…, role: …)", src: PEOPLE, from: 'human.ask("Go on?", role: reviewer)', to: 'human.ask("Go on?", role: auditor)', path: "/defs/W/body/2/value/args/1/value" },
    {
      where: "escalate human(…, role: …)",
      src: PEOPLE,
      from: 'escalate human("Open: {c}", role: code_owner)',
      to: 'escalate human("Open: {c}", role: auditor)',
      path: "/defs/W/body/1/value/on_unmet/then/to/args/1/value",
    },
    { where: "supervise escalate(human, role: …)", src: PEOPLE, from: "escalate(human, role: code_owner)", to: "escalate(human, role: auditor)", path: "/defs/W/body/0/value/supervise/args/1/value" },
    { where: "a change set's approve role", src: LAND, from: '    approve role "architect"', to: '    approve role "auditor"', path: "/defs/Land/body/4/value/approver", opts: () => ({ modules: acme() }) },
    {
      where: "a change set member's approved_by role",
      src: LAND,
      from: 'approved_by role "architect"',
      to: 'approved_by role "auditor"',
      path: "/defs/Land/body/4/value/members/mcp/approver",
      opts: () => ({ modules: acme() }),
    },
    { where: "a component's owner", src: LAND, from: 'owner    role "architect"', to: 'owner    role "auditor"', path: "/defs/billing/owner", opts: () => ({ modules: acme() }) },
    {
      where: "an environment's authorize … by human(role: …)",
      src: LAND,
      from: 'authorize deploy by human(role: "architect")',
      to: 'authorize deploy by human(role: "auditor")',
      path: "/defs/qa/authorize/deploy/role",
      opts: () => ({ modules: acme() }),
    },
    { where: "an envelope's owner", src: MIGRATE_ALL, from: "owner   platform_lead", to: "owner   auditor", path: "/defs/MigrateAll/envelope/owner", opts: () => ({ modules: domain() }) },
    {
      where: "an envelope's approve",
      src: MIGRATE_ALL,
      from: "approve git.merge by release_manager",
      to: "approve git.merge by auditor",
      path: "/defs/MigrateAll/envelope/approve/git.merge",
      opts: () => ({ modules: domain() }),
    },
  ];

  for (const s of SITES) {
    it(`at ${s.where}`, () => {
      const changed = mutate(s.src, s.from, s.to);
      const r = check(changed, "mdt", s.opts?.() ?? {});
      const found = r.diagnostics.filter((d) => d.severity === "error");
      expect(found.map((d) => [d.code, d.at.path])).toEqual([["MDT-E1501", s.path]]);
      expect(found[0]!.facts).toMatchObject({ role: "auditor" });
      // Declaring the role is the fix.
      expect(errors(declare(changed, "auditor"), s.opts?.() ?? {})).toEqual([]);
    });
  }

  it("reports every place when the definitions are gone", () => {
    const bare = mutate(PEOPLE, 'role code_owner "Code owner"\nrole reviewer   "Reviewer"\n', "");
    expect(errors(bare)).toEqual([
      ["MDT-E1501", "/defs/Ready/accept/approved/by/all/0/call/args/0/value"],
      ["MDT-E1501", "/defs/Ready/accept/approved/by/all/1/call/args/0/value"],
      ["MDT-E1501", "/defs/Ready/accept/approved/by/all/1/call/args/1/value"],
      ["MDT-E1501", "/defs/W/body/0/value/supervise/args/1/value"],
      ["MDT-E1501", "/defs/W/body/1/value/on_unmet/then/to/args/1/value"],
      ["MDT-E1501", "/defs/W/body/2/value/args/1/value"],
    ]);
  });

  it("resolves the text form role: \"…\" by the same name", () => {
    const text = mutate(PEOPLE, 'human.ask("Go on?", role: reviewer)', 'human.ask("Go on?", role: "reviewer")');
    expect(errors(text)).toEqual([]);
    expect(errors(mutate(text, 'role: "reviewer"', 'role: "auditor"'))).toEqual([["MDT-E1501", "/defs/W/body/2/value/args/1/value"]]);
  });

  it("does not apply to the same programs in 0.3, with text roles and no role definitions", () => {
    let old = mutate(PEOPLE, "mandate @ 0.4", "mandate @ 0.3");
    old = mutate(old, 'role code_owner "Code owner"\nrole reviewer   "Reviewer"\n', "");
    old = old.replace(/(role|distinct_from): (\w+)/g, '$1: "$2"');
    expect(check(old, "mdt").diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    // Any text names a role in 0.3.
    expect(errors(old.replace(/"reviewer"/g, '"nobody"'))).toEqual([]);
    // Land as it is in the repository: 0.3, with the text role "architect" and no definition of it.
    expect(errors(readRepo("fixtures/system/land.mdt"), { modules: acme() })).toEqual([]);
  });

  it("refuses a name that is another kind of definition", () => {
    const r = check(mutate(PEOPLE, 'human.ask("Go on?", role: reviewer)', 'human.ask("Go on?", role: M)'), "mdt");
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toEqual([["MDT-E1501", "/defs/W/body/2/value/args/1/value"]]);
    expect(r.diagnostics[0]!.message).toContain("'M' is a capability, not a role");
    // A call is named as it is written; a place of the system model starts the sentence.
    expect(r.diagnostics[0]!.message.startsWith("human.ask names the role 'M'")).toBe(true);
    const owner = check(mutate(MIGRATE_ALL, "owner   platform_lead", "owner   Merge"), "mdt", { modules: domain() }).diagnostics[0]!;
    expect(owner.message.startsWith("An envelope's owner names the role 'Merge'")).toBe(true);
    expect(r.diagnostics[0]!.facts).toMatchObject({ role: "M", roles: ["code_owner", "reviewer"] });
  });

  it("suggests the nearest role, with a repair that replaces the name", () => {
    const path = "/defs/W/body/2/value/args/1/value";
    const r = check(mutate(PEOPLE, 'human.ask("Go on?", role: reviewer)', 'human.ask("Go on?", role: reviewr)'), "mdt");
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toEqual([["MDT-E1501", path]]);
    const d = r.diagnostics[0]!;
    expect(d.facts).toMatchObject({ role: "reviewr", did_you_mean: "reviewer" });
    expect(d.repair).toEqual([{ id: "r1", summary: "Use 'reviewer'", patch: [{ op: "replace", path, value: { op: "var", name: "reviewer" } }], risk: "low" }]);
    // The text form is repaired as text, and an envelope's owner, which is a name in the IR, as a name.
    const text = check(mutate(PEOPLE, 'human.ask("Go on?", role: reviewer)', 'human.ask("Go on?", role: "reviewr")'), "mdt").diagnostics[0]!;
    expect(text.repair![0]!.patch).toEqual([{ op: "replace", path, value: { op: "text", value: "reviewer" } }]);
    const owner = check(mutate(MIGRATE_ALL, "owner   platform_lead", "owner   platform_led"), "mdt", { modules: domain() }).diagnostics[0]!;
    expect(owner.facts).toMatchObject({ role: "platform_led", did_you_mean: "platform_lead" });
    expect(owner.repair![0]!.patch).toEqual([{ op: "replace", path: "/defs/MigrateAll/envelope/owner", value: "platform_lead" }]);
  });

  it("refuses a role that is computed, not named", () => {
    const r = check(mutate(PEOPLE, 'human.ask("Go on?", role: reviewer)', 'human.ask("Go on?", role: "re" + "viewer")'), "mdt");
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toEqual([["MDT-E1501", "/defs/W/body/2/value/args/1/value"]]);
    expect(r.diagnostics[0]!.facts).toEqual({ where: "human.ask", roles: ["code_owner", "reviewer"] });
  });

  it("does not suggest a name that is far from every role", () => {
    const d = check(mutate(PEOPLE, 'human.ask("Go on?", role: reviewer)', 'human.ask("Go on?", role: treasurer)'), "mdt").diagnostics[0]!;
    expect(d.code).toBe("MDT-E1501");
    expect(d.facts).not.toHaveProperty("did_you_mean");
    expect(d.repair).toBeUndefined();
  });
});

describe("E1501 with an imported role", () => {
  const PEOPLE_MODULE = `mandate @ 0.4

module company.people @ 0.1

role code_owner "Code owner"

type Note = { text: Text }
`;
  const people = (): Modules => {
    const { modules, problems } = loadModules([{ file: "people.mdt", text: PEOPLE_MODULE, kind: "mdt" }]);
    expect(problems).toEqual([]);
    return modules;
  };
  const program = (name: string) => `mandate @ 0.4

module example.asks @ 0.1

use std.{human}
use company.people.{${name}}

fn ask(x: Text) -> Text {
  let go = human.ask("Go on?", role: ${name})
  x
}
`;

  it("accepts a role of a loaded module", () => {
    expect(check(program("code_owner"), "mdt", { modules: people() }).diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  it("refuses an imported name that the loaded module defines as something else", () => {
    const r = check(program("Note"), "mdt", { modules: people() });
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toEqual([["MDT-E1501", "/defs/ask/body/0/value/args/1/value"]]);
    expect(r.diagnostics[0]!.message).toContain("'Note' is a type, not a role");
  });

  it("takes an imported name on trust when its module is not loaded", () => {
    expect(errors(program("code_owner"))).toEqual([]);
    expect(errors(program("Note"))).toEqual([]);
  });
});

describe("E1503: distinct_from names a role approved earlier in the same criterion", () => {
  const BOTH = "human.approve(role: code_owner) and human.approve(role: reviewer, distinct_from: code_owner)";

  it("accepts the approval it compares with, earlier in the criterion", () => {
    expect(errors(PEOPLE)).toEqual([]);
  });

  it("refuses it before the approval it names", () => {
    const r = check(mutate(PEOPLE, BOTH, "human.approve(role: reviewer, distinct_from: code_owner) and human.approve(role: code_owner)"), "mdt");
    expect(r.diagnostics.map((d) => [d.code, d.at.path, d.facts])).toEqual([
      ["MDT-E1503", "/defs/Ready/accept/approved/by/all/0/call/args/1/value", { distinct_from: "code_owner", approved_earlier: [] }],
    ]);
  });

  it("refuses it when the role it names is approved in another criterion", () => {
    const r = check(mutate(PEOPLE, BOTH, 'human.approve(role: reviewer, distinct_from: code_owner)\n  accept owner "The code owner approved"\n    by human.approve(role: code_owner)'), "mdt");
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toEqual([["MDT-E1503", "/defs/Ready/accept/approved/by/call/args/1/value"]]);
  });

  it("refuses it on an approval that is not in a contract criterion", () => {
    const r = check(mutate(PEOPLE, 'let go = human.ask("Go on?", role: reviewer)', "let go = human.approve(role: reviewer, distinct_from: code_owner)"), "mdt");
    expect(r.diagnostics.map((d) => [d.code, d.at.path])).toEqual([["MDT-E1503", "/defs/W/body/2/value/args/1/value"]]);
  });
});

describe("E1502: with a lock, every role the package names has a member", () => {
  const FIXBUG_LOCK = JSON.parse(readRepo("fixtures/fixbug/mandate.lock.json")) as Lock;
  const K1 = `sha256:${"1".repeat(64)}`;
  const K2 = `sha256:${"2".repeat(64)}`;
  const V04 = (roles: Record<string, string[]>, modules: Record<string, string> = FIXBUG_LOCK.modules): Lock => ({
    ...structuredClone(FIXBUG_LOCK),
    lock: "mandate/lock/0.4",
    modules,
    members: { alice: { keys: [K1] }, bob: { keys: [K2] } },
    roles,
  });
  const withLock = (src: string, lock: Lock, modules: Modules = {}) => check(src, "mdt", { lock, modules }).diagnostics;

  it("accepts a 0.4 lock that binds every role", () => {
    expect(withLock(PEOPLE, V04({ code_owner: ["alice"], reviewer: ["bob"] })).map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  it("refuses a role with no entry, at the first place that names it", () => {
    const d = withLock(PEOPLE, V04({ code_owner: ["alice"] }));
    expect(d.map((x) => [x.code, x.at.path])).toEqual([["MDT-E1502", "/defs/Ready/accept/approved/by/all/1/call/args/0/value"]]);
    expect(d[0]!.facts).toEqual({ role: "reviewer", lock: "mandate/lock/0.4", bound: ["code_owner"] });
  });

  it("refuses a role with an empty member list, as a malformed lock (E0140, spec/lock.md)", () => {
    // spec/lock.md "Members and roles": a role lists at least one member, reported as MDT-E0140.
    const d = withLock(PEOPLE, V04({ code_owner: ["alice"], reviewer: [] }));
    expect(d.map((x) => [x.code, x.at.path])).toEqual([["MDT-E0140", "/roles/reviewer"]]);
  });

  it("refuses each role against a lock older than 0.4, and says a 0.4 lock is needed", () => {
    const d = withLock(PEOPLE, { ...structuredClone(FIXBUG_LOCK), lock: "mandate/lock/0.3" });
    expect(d.map((x) => [x.code, x.facts?.["role"]])).toEqual([
      ["MDT-E1502", "code_owner"],
      ["MDT-E1502", "reviewer"],
    ]);
    for (const x of d) {
      expect(x.message).toContain("mandate/lock/0.4");
      expect(x.facts).toMatchObject({ lock: "mandate/lock/0.3", bound: [] });
    }
  });

  it("does not apply to a 0.3 program, whatever the lock", () => {
    let old = mutate(PEOPLE, "mandate @ 0.4", "mandate @ 0.3");
    old = mutate(old, 'role code_owner "Code owner"\nrole reviewer   "Reviewer"\n', "");
    old = old.replace(/(role|distinct_from): (\w+)/g, '$1: "$2"');
    expect(withLock(old, structuredClone(FIXBUG_LOCK)).map((d) => d.code)).toEqual([]);
    expect(withLock(old, V04({})).map((d) => d.code)).toEqual([]);
  });

  it("counts a role named only by an imported component's owner", () => {
    const MODULE = `mandate @ 0.4

module company.people @ 0.1

role platform_owner "Platform owner"

component api {
  repo  "company/api"
  root  "/work/api"
  lang  ts
  owner role "platform_owner"
}
`;
    const { modules, problems } = loadModules([{ file: "people.mdt", text: MODULE, kind: "mdt" }]);
    expect(problems).toEqual([]);
    const src = `mandate @ 0.4

module example.reads @ 0.1

use std.{component}
use company.people.{api}

capability Read = component.read(api)

workflow W(x: Text) -> Text
  caps Read
{
  x
}
`;
    const pinned = { "company.people": hashProgram(modules["company.people"] as unknown as Json).program };
    expect(roleSites(check(src, "mdt").program!.defs)).toEqual([]);
    const d = withLock(src, V04({}, pinned), modules).filter((x) => x.severity === "error");
    // The place that names the role is in the module, so the program's import is where it is reported.
    expect(d.map((x) => [x.code, x.at.path])).toEqual([["MDT-E1502", "/uses/0"]]);
    expect(check(src, "mdt").program!.uses![0]).toEqual({ module: "company.people", names: ["api"] });
    expect(d[0]!.facts).toEqual({ role: "platform_owner", lock: "mandate/lock/0.4", bound: [], named_by: "api", module: "company.people" });
    expect(withLock(src, V04({ platform_owner: ["alice"] }, pinned), modules).filter((x) => x.severity === "error")).toEqual([]);
  });
});

describe("roleSites and rolesNamed", () => {
  it("list the places in path order, and each role once, sorted", () => {
    const p = check(PEOPLE, "mdt").program!;
    expect(roleSites(p.defs).map((s) => [s.role, s.path, s.distinct])).toEqual([
      ["code_owner", "/defs/Ready/accept/approved/by/all/0/call/args/0/value", false],
      ["reviewer", "/defs/Ready/accept/approved/by/all/1/call/args/0/value", false],
      ["code_owner", "/defs/Ready/accept/approved/by/all/1/call/args/1/value", true],
      ["code_owner", "/defs/W/body/0/value/supervise/args/1/value", false],
      ["code_owner", "/defs/W/body/1/value/on_unmet/then/to/args/1/value", false],
      ["reviewer", "/defs/W/body/2/value/args/1/value", false],
    ]);
    expect(rolesNamed(p.defs)).toEqual(["code_owner", "reviewer"]);
  });

  it("find the system model's places and the envelope's", () => {
    const land = check(LAND, "mdt", { modules: acme() }).program!;
    expect(roleSites(land.defs).map((s) => s.path)).toEqual(["/defs/Land/body/4/value/approver", "/defs/Land/body/4/value/members/mcp/approver", "/defs/billing/owner", "/defs/qa/authorize/deploy/role"]);
    expect(rolesNamed(land.defs)).toEqual(["architect"]);
    const migrate = check(MIGRATE_ALL, "mdt", { modules: domain() }).program!;
    expect(roleSites(migrate.defs).map((s) => [s.role, s.path])).toEqual([
      ["release_manager", "/defs/MigrateAll/envelope/approve/git.merge"],
      ["platform_lead", "/defs/MigrateAll/envelope/owner"],
    ]);
    expect(rolesNamed(migrate.defs)).toEqual(["platform_lead", "release_manager"]);
  });
});

describe("the codes of 0.4", () => {
  it("are in CODES with the titles of spec/envelope.md", () => {
    const table = new Map<string, string>();
    for (const m of readRepo("spec/envelope.md").matchAll(/^\| (MDT-E1[57]\d\d) \| ([^|]+) \|/gm)) table.set(m[1]!, m[2]!.trim());
    const expected = ["MDT-E1501", "MDT-E1502", "MDT-E1503", ...Array.from({ length: 8 }, (_, i) => `MDT-E170${i + 1}`)];
    expect([...table.keys()].sort()).toEqual(expected);
    for (const code of expected) {
      expect(CODES[code]?.title, code).toBe(table.get(code));
      expect(CODES[code]!.explain.length, code).toBeGreaterThan(0);
    }
  });
});
