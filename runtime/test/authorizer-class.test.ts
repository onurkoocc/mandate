// The runtime's configuration may hand an authorization to another role than the program names
// (spec/attention.md "Effects and the runtime's configuration"): `authorize[E] = { by: "human", role }` overrides an
// irreversible action's `owner`. E1909 compares what the authorization shows with the role the program names; the
// start compares it with the role the configuration names, and refuses a run that would ask a role to decide on data
// above its cap (`authorizer_below_class`) before anything is written.
import { load, type Lock, type Program } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { payloadOf, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { baseOf, type WorkerChecker } from "../src/plan.js";
import { SimTool, toolUse } from "../src/sim.js";
import type { Value } from "../src/values.js";
import { closeAll, planChecker, world } from "./helpers.js";
import { finish, ITEMS, MODULE, msg, planned, program, refusals, state, type Planned } from "./planning.js";

afterAll(closeAll);

/** An irreversible merge of a confidential change the owner approved: under the default policy the role `owner` decides it. */
const SRC = `mandate @ 0.7

module example.authorizer @ 0.1

use std.{human, git}

role owner  "Owner"
role intern "Intern"

type Change = { files: List<Text> } classified confidential

capability Pr = git.pr("example/api")

contract Ready(c: Change) {
  accept owned "The owner approves the change" by human.approve(role: owner)
}

workflow Merging(c: Change) -> Text
  caps   Pr
  budget { steps: 4, asks: 3 }
{
  let ok = verify c against Ready(c)
  let merged = effect git.merge(ok) idempotent_by "merge"
  "merged"
}
`;

const AT = "/defs/Merging/body/1/value";
const ana = EvidenceSigner.generate();
const cy = EvidenceSigner.generate();

/** Ana is the owner and Cy the intern; the owner may be shown confidential data, the intern `intern`'s class. */
function lockWith(intern?: string): Lock {
  return {
    modules: {},
    members: { ana: { keys: [ana.keyId] }, cy: { keys: [cy.keyId] } },
    roles: { owner: ["ana"], intern: ["cy"] },
    role_classes: { owner: "confidential", ...(intern ? { intern } : {}) },
  } as unknown as Lock;
}

const input = { c: { files: ["a.ts"] } };
const toIntern = { "git.merge": { by: "human" as const, role: "intern" } };

describe("an authorization the configuration hands to another role", () => {
  it("is refused at the start when that role's cap is below what it shows, before anything is written", async () => {
    const w = await world(SRC, { tools: [new SimTool("git.merge", "reconcilable")], lock: lockWith(), decisions: { keys: new TrustedKeys([ana.publicKey, cy.publicKey]) } });
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Merging", runId: "low", input, authorize: toIntern })).rejects.toThrow(
      /authorizer_below_class: The runtime's configuration hands the authorization of git\.merge to role intern, which may be shown data up to internal .*, and it shows confidential data \(the program names owner for it\)/,
    );
    const rows = await w.db.query<{ n: unknown }>("select count(*) as n from runs where run_id = $1", ["low"]);
    expect(Number(rows[0]!.n)).toBe(0);
    expect(await w.rt.listWaits({ member: "cy" })).toEqual([]);
    // Without the configuration the owner, whose cap covers it, is asked.
    const own = await w.rt.startRun({ pkg: w.pkg, workflow: "Merging", runId: "own", input });
    expect(own.state).toBe("waiting");
    // Handed to policy, nobody is asked, and the run starts.
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Merging", runId: "policy", input, authorize: { "git.merge": { by: "policy" } } })).resolves.toBeDefined();
  });

  it("runs when that role's cap covers it, and asks that role, unmasked", async () => {
    const w = await world(SRC, { tools: [new SimTool("git.merge", "reconcilable")], lock: lockWith("confidential"), decisions: { keys: new TrustedKeys([ana.publicKey, cy.publicKey]) } });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Merging", runId: "high", input, authorize: toIntern });
    expect(r.state).toBe("waiting");
    // The owner approves the change; the merge then waits for the intern.
    const signed = signDecision(ana, await w.rt.shown("high", "wait"), { kind: "approve", member: "ana", at: new Date(w.adapters.clock.now()) });
    expect((await w.rt.decideAction("high", { sender: "t", messageId: "m1" }, { signed })).state).toBe("waiting");
    const waits = await w.rt.listWaits({ member: "cy" });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ command: `${AT}/authorize`, role: "intern" });
    expect(JSON.stringify(waits[0])).not.toContain('"masked":true');
  });
});

/**
 * A plan whose envelope hands the irreversible merge of a confidential change to the release manager (`approve`),
 * whose cap covers it; the runtime's configuration hands it to the platform lead, whose cap (internal) does not, and
 * which the envelope's `approve` overrides. An amendment may change `approve` (spec/envelope.md "Amendments"). The
 * owner's gate of a governance-class file shows the role `owner` the merge's parameters, so the lock gives it a class.
 */
const amending = (approve?: string): string =>
  program({ budget: "{ tokens: 200k, steps: 400, agents: 12, asks: 5 }", ...(approve ? { approve } : {}), body: MERGED })
    .replace("mandate @ 0.4", "mandate @ 0.7")
    .replace("use std.{fs, git, model}", "use std.{fs, git, human, model}")
    .replace("type Item = { name: Text }", `type Item = { name: Text }\ntype Change = { files: List<Text> } classified confidential\n\ncontract Listed(c: Change) {\n  accept listed "The release manager approves the change" by human.approve(role: release_manager)\n}`);
const MERGED = `  let first = pause
  let done = plan Lead.finish(items) within envelope
  let c = verify Change { files: ["a.ts"] } against Listed(Change { files: ["a.ts"] })
  let merged = effect git.merge(c) idempotent_by "merge"
  done`;
const toLead = { "git.merge": { by: "human" as const, role: "platform_lead" } };
const amendLock = (lead?: string): Record<string, unknown> => ({
  roles: { platform_lead: ["alice"], release_manager: ["bob"], owner: ["bob"] },
  role_classes: { release_manager: "confidential", owner: "confidential", ...(lead ? { platform_lead: lead } : {}) },
});

/** Answers the run's own pause, as Alice. */
async function answerPause(w: Planned, runId: string): Promise<RunRow> {
  const signed = signDecision(w.alice, await w.rt.shown(runId, "wait"), { kind: "answer", member: "alice", payload: payloadOf.answer("go on"), at: new Date(w.adapters.clock.now()) });
  return w.rt.submitInput(runId, msg(), { value: "go on", signed });
}

describe("an amendment that would hand an authorization to a role below its class", () => {
  let checker: WorkerChecker;
  beforeAll(async () => {
    checker = await planChecker();
  }, 60_000);
  afterAll(() => checker.close());

  // Dropping `approve` hands the merge to the configuration's platform lead from then on.
  const dropped = (): Value => (load(amending(), "mdt").program!.defs["W"] as unknown as { envelope: Value }).envelope;
  const lead = () => [[toolUse("a1", "request_amendment", { envelope: dropped(), reason: "no approver" })], finish("asked")];

  it("is refused to the lead, and nothing changes in the run (authorizer_below_class)", async () => {
    const w = await planned(checker, lead(), { src: amending("git.merge by release_manager"), tools: [new SimTool("git.merge", "reconcilable")], lock: amendLock() });
    // The envelope's approve overrides the configuration: the run starts.
    let r = await w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { items: ITEMS }, runId: "a", authorize: toLead });
    expect(r.state, state(r)).toBe("waiting");
    r = await answerPause(w, "a");
    // The lead is refused, nobody is asked, and the run keeps its package.
    expect(refusals(w.told[0])).toEqual([["authorizer_below_class", null, { effect: "git.merge", role: "platform_lead", class: "internal", shown: "confidential" }]]);
    expect(String((w.told[0]!["diagnostics"] as Array<Record<string, unknown>>)[0]!["message"])).toMatch(
      /^The runtime's configuration hands the authorization of git\.merge to role platform_lead, which may be shown data up to internal .*: the amendment is not asked for/,
    );
    const types = (await w.rt.journal.events("a")).map((e) => e.type);
    expect(types).not.toContain("amendment_requested");
    expect(types).not.toContain("package_amended");
    expect((await w.rt.getRun("a")).package_hash).toBe(w.pkg.hash);
    expect(await w.rt.listWaits({ member: "alice" })).toEqual([]);
  });

  it("is asked of the owner when the configured role's cap covers what it shows, and the merge then asks that role", async () => {
    const w = await planned(checker, lead(), { src: amending("git.merge by release_manager"), tools: [new SimTool("git.merge", "reconcilable")], lock: amendLock("confidential") });
    let r = await w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { items: ITEMS }, runId: "b", authorize: toLead });
    r = await answerPause(w, "b");
    expect(r.state, state(r)).toBe("waiting");
    expect(refusals(w.told[0] ?? {})).toEqual([]);
    r = await w.rt.decideAmendment("b", msg(), signDecision(w.alice, await w.rt.shown("b", "wait"), { kind: "amend", member: "alice", at: new Date(w.adapters.clock.now()) }));
    expect(r.state, state(r)).toBe("waiting");
    // The release manager approves the change; the merge then waits for the platform lead.
    r = await w.rt.decideAction("b", msg(), { signed: signDecision(w.bob, await w.rt.shown("b", "wait"), { kind: "approve", member: "bob", at: new Date(w.adapters.clock.now()) }) });
    expect(r.state, state(r)).toBe("waiting");
    const [wait] = await w.rt.listWaits({ member: "alice" });
    expect(wait).toMatchObject({ command: "/defs/W/body/3/value/authorize", asked_of: "platform_lead" });
    expect(JSON.stringify(wait)).not.toContain('"masked":true');
  });
});

/** A sub-program that merges a confidential change its parent's contract has a person approve: an irreversible effect. */
const MERGING_SUB = `workflow Fix() -> Text
  caps   RepoRead, SrcWrite, ModelStd, Merge
  budget { tokens: 20k, steps: 40, agents: 4 }
{
  let c = verify Change { files: ["a.ts"] } against Listed(Change { files: ["a.ts"] })
  let merged = effect git.merge(c) idempotent_by "merge"
  "fixed"
}`;

/** The lead's submission of `defs` as sub-program 1. */
function submitting(defs: string) {
  const r = load(`mandate @ 0.7\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\n${defs}\n`, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  const ops = Object.entries((r.program as Program).defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d as unknown as Value }));
  return [toolUse("s1", "submit_program", { base: baseOf(MODULE, 1, "mandate/0.7" as never), ops })];
}

describe("a sub-program whose effect the configuration hands to a role below its class", () => {
  let checker: WorkerChecker;
  beforeAll(async () => {
    checker = await planChecker();
  }, 60_000);
  afterAll(() => checker.close());

  // The parent plans, and holds no merge of its own: its start compares nothing.
  const parent = amending().replace(MERGED, "  plan Lead.finish(items) within envelope");

  it("is refused to the lead at its admission, and nothing of it runs (authorizer_below_class)", async () => {
    const w = await planned(checker, [submitting(MERGING_SUB), finish("refused")], { src: parent, tools: [new SimTool("git.merge", "reconcilable")], lock: amendLock() });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { items: ITEMS }, runId: "s", authorize: toLead });
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: false });
    expect(refusals(w.told[0])).toEqual([["authorizer_below_class", "/defs/Fix/body/1/value", { effect: "git.merge", role: "platform_lead", class: "internal", shown: "confidential" }]]);
    const types = (await w.rt.journal.events("s")).map((e) => e.type);
    expect(types).toContain("program_refused");
    expect(types).not.toContain("program_admitted");
    // Without the configuration the owner, whose cap covers it, would be asked: the same sub-program is admitted.
    const v = await planned(checker, [submitting(MERGING_SUB), finish("admitted")], { src: parent, tools: [new SimTool("git.merge", "reconcilable")], lock: amendLock() });
    const s = await v.rt.startRun({ pkg: v.pkg, workflow: "W", input: { items: ITEMS }, runId: "t" });
    expect(s.state, state(s)).toBe("waiting");
    expect(v.told).toEqual([]);
    expect((await v.rt.journal.events("t")).map((e) => e.type)).toContain("program_admitted");
  });
});
