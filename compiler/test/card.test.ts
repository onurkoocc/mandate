// The envelope's card (spec/envelope.md "Views"; spec/views.md "The card"):
// for MigrateAll, the spec's example, the five questions a person reads
// before approving an envelope, each answered from the IR and the lock, and
// the package hash the approval is signed for. Older programs' views do not
// change (golden.test.ts pins them).

import { describe, expect, it } from "vitest";
import { kindOf, loadModules } from "../src/check.js";
import { domainHash, hashProgram } from "../src/hash.js";
import type { Program } from "../src/ir/types.js";
import type { Json } from "../src/json/strict-json.js";
import type { Lock } from "../src/lock.js";
import type { Modules } from "../src/modules.js";
import { toHtml, toMarkdown } from "../src/views/doc.js";
import { card, cardDoc, envelopeWorkflows } from "../src/views/views.js";
import { checkLessMoved as check, readRepo } from "./helpers.js";

const MIGRATE_ALL = readRepo("fixtures/envelope/migrate-all.mdt");
const DOMAIN = "fixtures/envelope/domain.mdt";
const KEY_A = `sha256:${"a".repeat(64)}`;
const KEY_B = `sha256:${"b".repeat(64)}`;
const KEY_C = `sha256:${"c".repeat(64)}`;

function modules(): Modules {
  const { modules, problems } = loadModules([{ file: DOMAIN, text: readRepo(DOMAIN), kind: kindOf(DOMAIN) }]);
  expect(problems).toEqual([]);
  return modules;
}

function program(src = MIGRATE_ALL): Program {
  const r = check(src, "mdt", { modules: modules() });
  expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return r.program!;
}

function mutate(from: string, to: string, src = MIGRATE_ALL): string {
  expect(src.includes(from), from).toBe(true);
  return src.replace(from, to);
}

/** A lock binding two members to the platform lead and one to the release manager. */
function lock(): Lock {
  return {
    lock: "mandate/lock/0.4",
    modules: { "company.domain": hashProgram(modules()["company.domain"]! as unknown as Json).program },
    members: { ana: { keys: [KEY_A, KEY_B] }, ben: { keys: [KEY_C] } },
    roles: { platform_lead: ["ana"], release_manager: ["ben"] },
  };
}

/** The card of MigrateAll with `l`, or with the test lock; `null` is no lock. */
const cardOf = (p: Program, l: Lock | null = lock()) => card(p, "MigrateAll", { modules: modules(), ...(l ? { lock: l } : {}) })!;

describe("the card of MigrateAll", () => {
  it("is a view of the workflow, under the program hash", () => {
    const p = program();
    const v = cardOf(p);
    expect(v.format).toBe("mandate/view/0.1");
    expect(v.kind).toBe("card");
    expect(v.workflow).toBe("MigrateAll");
    expect(v.program.hash).toBe(hashProgram(p as unknown as Json).program);
    expect(envelopeWorkflows(p)).toEqual(["MigrateAll"]);
  });

  it("shows what it does: the map with its bounds and what it hands each item, and the plan with its lead", () => {
    const { does } = cardOf(program());
    expect(does.maps).toEqual([
      { bind: "repo", over: "repos", max: 150, par: 16, delegates: ["Migrator.migrate"], handed: [{ cap: "SrcWrite.narrow(repo.root)", kinds: ["fs.write"], scope: null, by_item: true }] },
    ]);
    expect(does.plans).toEqual([
      { lead: "Lead.finish", budget: "10 USD · 2000000 tokens · 40 steps", from: "agent", numbers: { spend: { micros: 10_000_000, currency: "USD" }, tokens: 2_000_000, time_ms: null, steps: 40, agents: null } },
    ]);
    expect(does.steps.map((s) => s.split(" [")[0])).toEqual(["map repo", "delegate Migrator.migrate", "delegate plan Lead.finish"]);
  });

  it("shows what it can touch: paths, the command, the model tier, the repositories and max_class", () => {
    const { touches } = cardOf(program());
    expect(touches.read).toEqual(["/work/repos"]);
    expect(touches.write).toEqual(["/work/repos"]);
    expect(touches.exec).toEqual(["npm ci; npm test"]);
    expect(touches.model).toEqual(["standard (up to internal)"]);
    expect(touches.repos).toEqual(["company/backend", "company/frontend"]);
    expect(touches.network).toEqual([]);
    expect(touches.unbounded).toEqual([]);
    expect(touches.max_class).toBe("internal");
    expect(touches.max_concurrent).toBe(16);
  });

  it("names max_class internal when the envelope does not say", () => {
    const p = program(mutate("{ max_concurrent: 16, max_class: internal }", "{ max_concurrent: 16 }"));
    expect(cardOf(p).touches.max_class).toBe("internal");
  });

  it("shows the most it spends: the envelope, the static part and what is left, as numbers and as text", () => {
    const { spends } = cardOf(program());
    expect(spends.map((r) => [r.dimension, r.text.envelope, r.text.static, r.text.left])).toEqual([
      ["spend", "120 USD", "85 USD", "35 USD"],
      ["tokens", "80,000,000", "62,000,000", "18,000,000"],
      ["time", "6 h", "3 h 20 min", "2 h 40 min"],
      ["steps", "2,000", "1,840", "160"],
      ["agents", "200", "151", "49"],
    ]);
    expect(spends.map((r) => [r.unit, r.currency, r.envelope, r.static, r.left])).toEqual([
      ["micros", "USD", 120_000_000, 85_000_000, 35_000_000],
      ["tokens", null, 80_000_000, 62_000_000, 18_000_000],
      ["ms", null, 21_600_000, 12_000_000, 9_600_000],
      ["steps", null, 2000, 1840, 160],
      ["agents", null, 200, 151, 49],
    ]);
  });

  it("shows when it asks whom: git.merge by the release manager, with its member", () => {
    const { asks } = cardOf(program());
    expect(asks.approvals).toEqual([{ effect: "git.merge", role: "release_manager", members: ["ben"] }]);
    expect(asks.waits).toEqual([]);
  });

  it("shows a wait for a person the body reaches, by role", () => {
    const src = mutate("  plan Lead.finish(repos, done) within envelope\n", '  let go = human.ask("Plan what is left?", role: platform_lead)\n  plan Lead.finish(repos, done) within envelope\n');
    const { asks } = cardOf(program(src));
    expect(asks.waits.map((w) => [w.kind, w.role, w.in, w.members])).toEqual([["human.ask", "platform_lead", "its body", ["ana"]]]);
    expect(asks.waits[0]!.path).toBe("/defs/MigrateAll/body/1/value/args/1/value");
  });

  it("shows who approves it and may amend it: the owner role and its members with their keys", () => {
    const { approves } = cardOf(program());
    expect(approves).toEqual({
      role: "platform_lead",
      description: "Platform lead",
      lock: true,
      members: [{ member: "ana", keys: 2 }],
      bound: true,
      text: "A member of platform_lead approves it, and every amendment: ana (2 keys).",
    });
  });

  it("says plainly that nobody can approve it yet, with no lock or no one bound to the owner role", () => {
    const none = cardOf(program(), null).approves;
    expect(none).toMatchObject({ lock: false, members: [], bound: false });
    expect(none.text).toBe("Nobody can approve it yet: there is no lock, so no member holds the role platform_lead.");
    const { platform_lead: _gone, ...roles } = lock().roles!;
    const unbound = cardOf(program(), { ...lock(), roles }).approves;
    expect(unbound).toMatchObject({ lock: true, members: [], bound: false });
    expect(unbound.text).toBe("Nobody can approve it yet: the lock binds no member to the role platform_lead.");
  });
});

describe("the package hash on the card", () => {
  it("is the package hash of the program and the lock without its format field", () => {
    const p = program();
    const l = lock();
    const { lock: _format, ...pinned } = l;
    expect(cardOf(p, l).package).toBe(domainHash("package", { program: hashProgram(p as unknown as Json).program, lock: pinned } as unknown as Json));
    // No lock is a package with no pins.
    expect(cardOf(p, null).package).toBe(domainHash("package", { program: hashProgram(p as unknown as Json).program, lock: { modules: {} } } as unknown as Json));
  });

  it("changes when a member is added to the lock", () => {
    const p = program();
    const more = lock();
    more.members!["cem"] = { keys: [`sha256:${"d".repeat(64)}`] };
    more.roles!["platform_lead"] = ["ana", "cem"];
    expect(cardOf(p, more).package).not.toBe(cardOf(p).package);
    expect(cardOf(p, more).approves.members).toEqual([
      { member: "ana", keys: 2 },
      { member: "cem", keys: 1 },
    ]);
  });

  it("changes when one character of the program changes", () => {
    const other = program(mutate('role platform_lead   "Platform lead"', 'role platform_lead   "Platform Lead"'));
    expect(cardOf(other).package).not.toBe(cardOf(program()).package);
  });
});

describe("the card as a document", () => {
  it("renders to Markdown and HTML with the package hash", () => {
    const p = program();
    const doc = cardDoc(p, "MigrateAll", { lock: lock(), modules: modules() })!;
    const hash = cardOf(p).package;
    expect(doc.meta[0]).toEqual(["Package", hash]);
    const md = toMarkdown(doc);
    expect(md).toContain(hash);
    expect(md).toContain("| spend (USD) | 120 USD | 85 USD | 35 USD |");
    expect(md).toContain("| agents | 200 | 151 | 49 |");
    expect(md).toContain("| git.merge | release\\_manager | ben |");
    const html = toHtml(doc);
    expect(html).toContain(hash);
    expect(html).not.toMatch(/<script|<form|<button|<a /i);
  });

  it("says in the document that nobody can approve it yet", () => {
    const md = toMarkdown(cardDoc(program(), "MigrateAll", { modules: modules() })!);
    expect(md).toContain("> Nobody can approve it yet: there is no lock, so no member holds the role platform\\_lead.");
  });

  it("escapes markup in a role's description and a capability's path", () => {
    const src = mutate('fs.read("/work/repos")', 'fs.read("/work/<b>repos</b>")', mutate('role platform_lead   "Platform lead"', 'role platform_lead   "Platform <b>lead</b>"'));
    const doc = cardDoc(program(src), "MigrateAll", { lock: lock(), modules: modules() })!;
    const md = toMarkdown(doc);
    expect(md).toContain("Platform \\<b\\>lead\\</b\\>");
    expect(md).toContain("/work/\\<b\\>repos\\</b\\>");
    const html = toHtml(doc);
    expect(html).toContain("Platform &lt;b&gt;lead&lt;/b&gt;");
    expect(html).toContain("/work/&lt;b&gt;repos&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });
});

describe("a workflow without an envelope", () => {
  it("has no card", () => {
    const src = `mandate @ 0.4

module example.plain @ 0.1

use std.{fs}

capability R = fs.read("/repo")

workflow W(t: Text) -> Bool
  caps R
  budget { spend: 1 USD }
{
  true
}
`;
    const r = check(src, "mdt");
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(card(r.program!, "W")).toBeUndefined();
    expect(cardDoc(r.program!, "W")).toBeUndefined();
    expect(envelopeWorkflows(r.program!)).toEqual([]);
    expect(card(program(), "NoSuchWorkflow")).toBeUndefined();
  });
});
