// A workflow's `owner` and the promotion ladder at run time (spec/attention.md "Card approval", "Promotion"; slice B6).
//
// - card approval: a workflow of 0.7 with an `owner` starts in no mode until a member of the owner role has signed an
//   `envelope` decision on the package hash, as a workflow with an envelope does; `approveEnvelope` takes it;
// - the ladder, under a lock with `promotion: "required"`: a `design` run needs no promotion; a `read_only` run starts
//   only under a signed `promote` decision made on a `design` run of the same package and workflow that succeeded, and a
//   `live` run only under one made on such a `read_only` run, which itself started under a promotion; the card first;
// - who: the owner role, or the envelope's owner; nobody else's promotion is taken, and a refused one stores nothing;
// - binding: a promotion is for one package, one workflow, one from-run and one rung; its subject names them all, and
//   for `live` the digest of the shadow diff; one is not taken once the evidence it was made on changed;
// - entries: only `startRun` creates a run, so no resume, replay, tick or sub-program starts one above its rung;
// - before: a lock without `promotion`, and a package older than 0.7, run as they did.
//
// Every key is made at run time (GitGuardian scans each commit). Counts are read with Number (PostgreSQL's are text).

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "@mandate/bridge";
import ts from "typescript";
import { describe, afterAll, expect, it } from "vitest";
import { shadowCounts } from "../src/cli.js";
import { DECISION_FORMAT, payloadOf, promotionSubject, shownPackage, signDecision, type DecisionRecord, type SignedDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { verifyPackage } from "../src/package.js";
import { buildPackage, Runtime, type Lock, type Package } from "../src/runtime.js";
import { SimAgents, SimTool } from "../src/sim.js";
import { runTests } from "../src/testing.js";
import { digest, isObj, type Obj, type Value } from "../src/values.js";
import { runView, shadowDiff } from "../src/views.js";
import { closeAll, world, type World } from "./helpers.js";

afterAll(closeAll);

const SRC = `mandate @ 0.7

module test.ladder @ 0.1

use std.{git}

role accountant   "Accountant"
role finance_lead "Finance lead"

capability PR = git.pr("company/backend")

type Issue = { id: Text }

workflow Note(issue: Issue) -> Bool
  owner   accountant
  caps    PR
  budget  { steps: 4 }
{
  effect git.comment(issue, "noted")
    idempotent_by issue.id
  true
}

workflow Other(issue: Issue) -> Bool
  owner   accountant
  caps    PR
  budget  { steps: 4 }
{
  effect git.comment(issue, "other")
    idempotent_by issue.id
  true
}

workflow Kept(issue: Issue) -> Bool
  envelope {
    owner   finance_lead
    caps    PR
    budget  { steps: 4, agents: 1 }
  }
{
  effect git.comment(issue, "kept")
    idempotent_by issue.id
  true
}
`;

/** The same and a workflow with neither an owner nor an envelope, which a lock that asks for promotion refuses (E1910). */
const WITH_PLAIN = `${SRC.replace("module test.ladder @ 0.1", "module test.plain @ 0.1")}
workflow Plain(issue: Issue) -> Bool
  caps    PR
  budget  { steps: 4 }
{
  effect git.comment(issue, "plain")
    idempotent_by issue.id
  true
}
`;

/** Only the workflow with neither: nothing to approve. */
const ONLY_PLAIN = `mandate @ 0.7

module test.only_plain @ 0.1

use std.{git}

capability PR = git.pr("company/backend")

type Issue = { id: Text }

workflow Plain(issue: Issue) -> Bool
  caps    PR
  budget  { steps: 4 }
{
  effect git.comment(issue, "plain")
    idempotent_by issue.id
  true
}
`;

// ── the people ──────────────────────────────────────────────────────────

interface Person {
  member: string;
  key: EvidenceSigner;
}

const person = (member: string): Person => ({ member, key: EvidenceSigner.generate() });
/** Ana and Dan are accountants, Ben the finance lead, Cem a member with no role; Mal has a key the runtime knows and the lock lists under nobody. */
const ana = person("ana");
const dan = person("dan");
const ben = person("ben");
const cem = person("cem");
const mal = person("mal");
const KEYS = new TrustedKeys([ana, dan, ben, cem, mal].map((p) => p.key.publicKey));

function lockOf(promotion: boolean, extra: Obj = {}): Lock {
  return {
    modules: {},
    members: { ana: { keys: [ana.key.keyId] }, dan: { keys: [dan.key.keyId] }, ben: { keys: [ben.key.keyId] }, cem: { keys: [cem.key.keyId] }, ...extra },
    roles: { accountant: ["ana", "dan"], finance_lead: ["ben"] },
    ...(promotion ? { promotion: "required" } : {}),
  } as unknown as Lock;
}

interface LWorld extends World {
  tool: SimTool;
}

async function ladder(o: { promotion?: boolean; src?: string } = {}): Promise<LWorld> {
  const tool = new SimTool("git.comment", "reconcilable");
  const w = await world(o.src ?? SRC, { tools: [tool], lock: lockOf(o.promotion ?? true), decisions: { keys: KEYS } });
  return { ...w, tool };
}

const at = (w: World): Date => new Date(w.adapters.clock.now());

/** `who`'s signed approval of `pkg`'s card as `role`. */
const card = (w: World, who: Person, role: string, pkg: Package = w.pkg): SignedDecision => signDecision(who.key, shownPackage(pkg.hash, role), { kind: "envelope", member: who.member, at: at(w) });

/** The cards of the package approved: Note's and Other's by Ana, Kept's by Ben. */
async function approveCards(w: World, pkg: Package = w.pkg): Promise<void> {
  await w.rt.approveEnvelope(pkg, card(w, ana, "accountant", pkg));
  await w.rt.approveEnvelope(pkg, card(w, ben, "finance_lead", pkg));
}

/** `who`'s signed promotion of run `runId` to `to`, as the runtime shows it; `change` makes the record say something else, signed again by `who`. */
async function promotion(w: World, who: Person, runId: string, to: "read_only" | "live", o: { role?: string; payload?: string; change?: (r: DecisionRecord) => DecisionRecord; forge?: boolean } = {}): Promise<SignedDecision> {
  const shown = await w.rt.promotionShown(runId, to);
  const signed = signDecision(who.key, { package: shown.package, run: shown.run, revision: shown.revision, subject: shown.subject, role: o.role ?? shown.role }, { kind: "promote", member: who.member, payload: o.payload ?? payloadOf.promotion(to), at: at(w) });
  if (!o.change) return signed;
  const record = o.change(signed.record);
  // A forged record keeps the signature of the one that was signed; a changed one is signed again.
  return { record, signature: o.forge ? signed.signature : who.key.signStatement(DECISION_FORMAT, record as unknown as Value).signature };
}

const ISSUE = { issue: { id: "I-1" } };

function start(w: World, workflow: string, runId: string, mode: "design" | "read_only" | "live", pkg: Package = w.pkg) {
  return w.rt.startRun({ pkg, workflow, input: ISSUE, runId, mode });
}

async function count(w: World, sql: string, args: unknown[] = []): Promise<number> {
  const [r] = await w.db.query<Obj>(`select count(*) as n from ${sql}`, args);
  return Number(r!["n"]);
}

const manifestOf = async (w: World, runId: string): Promise<Obj> => (await w.rt.getRun(runId)).manifest as Obj;
const eventsOf = async (w: World, runId: string, type: string): Promise<unknown[]> => (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data);

/** A design run of `workflow` that succeeded, and its promotion to read_only by `who`. */
async function promotedDesign(w: LWorld, workflow: string, runId: string, who: Person = ana): Promise<string> {
  const d = await start(w, workflow, runId, "design");
  expect(d.state, JSON.stringify(d.error ?? d.attention)).toBe("succeeded");
  return w.rt.promote(w.pkg, await promotion(w, who, runId, "read_only"));
}

// ── card approval ───────────────────────────────────────────────────────

describe("the card of a workflow with an owner (spec/attention.md \"Card approval\")", () => {
  it("starts in no mode before a member of the owner role approves the package, and in every mode after", async () => {
    const w = await ladder({ promotion: false });
    for (const mode of ["design", "read_only", "live"] as const) {
      await expect(start(w, "Note", `c0-${mode}`, mode)).rejects.toMatchObject({ code: "unapproved_envelope", message: expect.stringContaining("No member of accountant has approved package") });
    }
    expect(await count(w, "runs")).toBe(0);
    const decision = await w.rt.approveEnvelope(w.pkg, card(w, ana, "accountant"));
    for (const mode of ["design", "read_only", "live"] as const) {
      const run = await start(w, "Note", `c1-${mode}`, mode);
      expect(run.state, JSON.stringify(run.error ?? run.attention)).toBe("succeeded");
      const m = await manifestOf(w, `c1-${mode}`);
      expect(m["envelope_approval"]).toEqual({ decision, member: "ana", role: "accountant", key: ana.key.keyId });
      expect(m).not.toHaveProperty("promotion");
      expect(await eventsOf(w, `c1-${mode}`, "envelope_approved")).toHaveLength(1);
      expect(await eventsOf(w, `c1-${mode}`, "promotion_accepted")).toEqual([]);
    }
    expect(w.tool.executions).toHaveLength(1);
  });

  it("takes the approval of the owner role only: another role's opens another workflow's card", async () => {
    const w = await ladder({ promotion: false });
    // Ben is the finance lead: his approval is taken, as Kept's owner's, and does not start Note.
    await w.rt.approveEnvelope(w.pkg, card(w, ben, "finance_lead"));
    await expect(start(w, "Note", "r1", "design")).rejects.toMatchObject({ code: "unapproved_envelope" });
    expect((await start(w, "Kept", "r2", "design")).state).toBe("succeeded");
    // Ben claiming the accountant's role, and Cem, who holds none, are no approval of Note's card.
    await expect(w.rt.approveEnvelope(w.pkg, card(w, ben, "accountant"))).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    await expect(w.rt.approveEnvelope(w.pkg, card(w, cem, "accountant"))).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    await expect(w.rt.approveEnvelope(w.pkg, card(w, cem, "nobody"))).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    await expect(start(w, "Note", "r3", "design")).rejects.toMatchObject({ code: "unapproved_envelope" });
    expect(await count(w, "decisions")).toBe(1);
  });

  it("takes no forged record, no key the lock lists under nobody, no key nobody knows, and no other package's approval", async () => {
    const w = await ladder({ promotion: false });
    const forged = card(w, ana, "accountant");
    await expect(w.rt.approveEnvelope(w.pkg, { record: { ...forged.record, member: "dan" }, signature: forged.signature })).rejects.toMatchObject({ code: "invalid_decision" });
    await expect(w.rt.approveEnvelope(w.pkg, card(w, mal, "accountant"))).rejects.toMatchObject({ code: "invalid_decision" });
    await expect(w.rt.approveEnvelope(w.pkg, card(w, { member: "ana", key: EvidenceSigner.generate() }, "accountant"))).rejects.toMatchObject({ code: "invalid_decision" });
    // Another lock is another package: its approval is no approval of this one, and is taken for its own.
    const other = buildPackage(w.pkg.program, lockOf(false, { eda: { keys: [EvidenceSigner.generate().keyId] } }));
    expect(other.hash).not.toBe(w.pkg.hash);
    await expect(w.rt.approveEnvelope(w.pkg, card(w, ana, "accountant", other))).rejects.toMatchObject({ code: "invalid_decision", reason: "subject_mismatch" });
    await w.rt.approveEnvelope(other, card(w, ana, "accountant", other));
    await expect(start(w, "Note", "f1", "design")).rejects.toMatchObject({ code: "unapproved_envelope" });
    expect((await start(w, "Note", "f2", "design", other)).state).toBe("succeeded");
    expect(await count(w, "decisions")).toBe(1);
  });

  it("is no approval once the runtime no longer knows the key it was signed with", async () => {
    const w = await ladder({ promotion: false });
    await w.rt.approveEnvelope(w.pkg, card(w, ana, "accountant"));
    const without = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { keys: new TrustedKeys([dan, ben].map((p) => p.key.publicKey)) } });
    await expect(without.startRun({ pkg: w.pkg, workflow: "Note", input: ISSUE, runId: "k1", mode: "design" })).rejects.toMatchObject({ code: "unapproved_envelope" });
  });

  it("a workflow with neither an owner nor an envelope starts as before, approved by nobody", async () => {
    const w = await ladder({ promotion: false, src: WITH_PLAIN });
    for (const mode of ["design", "read_only", "live"] as const) {
      expect((await start(w, "Plain", `p-${mode}`, mode)).state).toBe("succeeded");
      const m = await manifestOf(w, `p-${mode}`);
      expect(m).not.toHaveProperty("envelope_approval");
      expect(m).not.toHaveProperty("promotion");
    }
    expect(await count(w, "decisions")).toBe(0);
    // A package with no workflow that has an owner or an envelope has nothing to approve.
    const p = await ladder({ promotion: false, src: ONLY_PLAIN });
    await expect(p.rt.approveEnvelope(p.pkg, card(p, ana, "accountant"))).rejects.toMatchObject({ code: "no_envelope", message: expect.stringContaining("no workflow with an envelope or an owner") });
  });
});

// ── the ladder ──────────────────────────────────────────────────────────

describe("the promotion ladder (spec/attention.md \"Promotion\")", () => {
  it("asks for the card first, then for a promotion: design needs none, and read_only and live start in none without one", async () => {
    const w = await ladder();
    await expect(start(w, "Note", "u0", "read_only")).rejects.toMatchObject({ code: "unapproved_envelope" });
    await approveCards(w);
    const d = await start(w, "Note", "u1", "design");
    expect(d.state).toBe("succeeded");
    expect(w.tool.prepares).toHaveLength(0);
    expect(await manifestOf(w, "u1")).not.toHaveProperty("promotion");
    for (const mode of ["read_only", "live"] as const) {
      await expect(start(w, "Note", `u-${mode}`, mode)).rejects.toMatchObject({ code: "unpromoted", message: expect.stringContaining(`mandate promote <run> --to ${mode}`) });
    }
    // Nothing of a refused start is written.
    expect(await count(w, "runs")).toBe(1);
    expect(w.tool.prepares).toHaveLength(0);
  });

  it("climbs one rung at a time, and each promotion lets every later run of its rung start", async () => {
    const w = await ladder();
    await approveCards(w);
    const toRead = await promotedDesign(w, "Note", "d1");
    // A promotion to live from a design run skips a rung.
    await expect(w.rt.promote(w.pkg, await promotion(w, ana, "d1", "read_only", { payload: payloadOf.promotion("live") }))).rejects.toMatchObject({ code: "bad_promotion" });
    await expect(w.rt.promotionShown("d1", "live")).rejects.toMatchObject({ code: "bad_promotion" });

    for (const id of ["r1", "r2"]) {
      const r = await start(w, "Note", id, "read_only");
      expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
      expect((await manifestOf(w, id))["promotion"]).toEqual({ decision: toRead, from: { run: "d1", mode: "design" }, to: "read_only" });
      expect(await eventsOf(w, id, "promotion_accepted")).toEqual([{ decision: toRead, member: "ana", role: "accountant", key: ana.key.keyId, from: { run: "d1", mode: "design" }, to: "read_only" }]);
      // The card is approved first, then the promotion is taken.
      const types = (await w.rt.journal.events(id)).map((e) => e.type);
      expect(types.indexOf("envelope_approved")).toBeLessThan(types.indexOf("promotion_accepted"));
    }
    expect(w.tool.executions).toHaveLength(0);
    await expect(start(w, "Note", "l0", "live")).rejects.toMatchObject({ code: "unpromoted" });
    // A read_only run is promoted to read_only no further.
    await expect(w.rt.promotionShown("r1", "read_only")).rejects.toMatchObject({ code: "bad_promotion" });

    // Dan, the other accountant, promotes the read_only run to live.
    const toLive = await w.rt.promote(w.pkg, await promotion(w, dan, "r1", "live"));
    const l = await start(w, "Note", "l1", "live");
    expect(l.state, JSON.stringify(l.error ?? l.attention)).toBe("succeeded");
    expect(w.tool.executions).toHaveLength(1);
    expect((await manifestOf(w, "l1"))["promotion"]).toEqual({ decision: toLive, from: { run: "r1", mode: "read_only" }, to: "live" });
    expect(await eventsOf(w, "l1", "promotion_accepted")).toEqual([{ decision: toLive, member: "dan", role: "accountant", key: dan.key.keyId, from: { run: "r1", mode: "read_only" }, to: "live" }]);
    expect((await start(w, "Note", "r3", "read_only")).state).toBe("succeeded");

    // The decisions the run started under are listed and hold; the role view shows the promotion to its owner role alone.
    expect((await w.rt.verifyDecisions("l1")).map((d) => [d.decision_id, d.record.kind, d.valid])).toEqual([
      [expect.any(String), "envelope", true],
      [toLive, "promote", true],
    ]);
    const mine = (await runView(w.rt, "l1", { role: "accountant" })).view as unknown as Obj;
    const theirs = (await runView(w.rt, "l1", { role: "finance_lead" })).view as unknown as Obj;
    expect((mine["decisions"] as Obj[]).map((d) => d["kind"])).toContain("promote");
    expect((theirs["decisions"] as Obj[]).map((d) => d["kind"])).not.toContain("promote");
  });

  it("takes a promotion from the owner role only, stores no refused one, and writes nothing of it", async () => {
    const w = await ladder();
    await approveCards(w);
    expect((await start(w, "Note", "d1", "design")).state).toBe("succeeded");
    const events = (await w.rt.journal.events("d1")).length;
    const refusals: Array<[string, Promise<SignedDecision>, string?]> = [
      ["the finance lead, as the accountant", promotion(w, ben, "d1", "read_only"), "not_in_role"],
      ["the finance lead, as himself", promotion(w, ben, "d1", "read_only", { role: "finance_lead" })],
      ["a member with no role", promotion(w, cem, "d1", "read_only"), "not_in_role"],
      ["a key the lock lists under nobody", promotion(w, mal, "d1", "read_only")],
      ["a key nobody knows", promotion(w, { member: "ana", key: EvidenceSigner.generate() }, "d1", "read_only")],
      ["a forged record", promotion(w, ana, "d1", "read_only", { forge: true, change: (r) => ({ ...r, member: "dan" }) })],
      ["a record of another kind", promotion(w, ana, "d1", "read_only", { change: (r) => ({ ...r, kind: "approve" }) }), "subject_mismatch"],
      ["a payload that is no promotion", promotion(w, ana, "d1", "read_only", { payload: "made-up" }), "subject_mismatch"],
      ["a stale revision", promotion(w, ana, "d1", "read_only", { change: (r) => ({ ...r, revision: (r.revision ?? 0) + 1 }) }), "stale_revision"],
    ];
    for (const [what, signed, reason] of refusals) {
      await expect(w.rt.promote(w.pkg, await signed), what).rejects.toMatchObject({ code: reason === "stale_revision" ? reason : "invalid_decision", ...(reason ? { reason } : {}) });
    }
    expect(await count(w, "decisions where kind = 'promote'")).toBe(0);
    expect((await w.rt.journal.events("d1")).length).toBe(events);
    await expect(start(w, "Note", "r1", "read_only")).rejects.toMatchObject({ code: "unpromoted" });
  });

  it("takes no promotion written into the store directly by a member of another role, or of none", async () => {
    const w = await ladder();
    await approveCards(w);
    expect((await start(w, "Note", "d1", "design")).state).toBe("succeeded");
    // As a writer that is not Runtime.promote would write them: each row is signed and names the run, but not by an accountant.
    const write = (s: SignedDecision): Promise<string> => w.db.tx((tx) => w.rt.journal.recordDecision(tx, s));
    await write(await promotion(w, ben, "d1", "read_only"));
    await write(await promotion(w, ben, "d1", "read_only", { role: "finance_lead" }));
    await write(await promotion(w, cem, "d1", "read_only"));
    expect(await count(w, "decisions where kind = 'promote'")).toBe(3);
    await expect(start(w, "Note", "r1", "read_only")).rejects.toMatchObject({ code: "unpromoted" });
    // The accountant's, written the same way, is taken: the rows above were refused for their role, not for how they came.
    const hers = await write(await promotion(w, ana, "d1", "read_only"));
    expect((await start(w, "Note", "r2", "read_only")).state).toBe("succeeded");
    expect((await manifestOf(w, "r2"))["promotion"]).toMatchObject({ decision: hers });
  });

  it("takes the envelope owner's promotion of a workflow with an envelope, and nobody else's", async () => {
    const w = await ladder();
    await approveCards(w);
    expect((await start(w, "Kept", "k1", "design")).state).toBe("succeeded");
    expect((await w.rt.promotionShown("k1", "read_only")).role).toBe("finance_lead");
    await expect(w.rt.promote(w.pkg, await promotion(w, ana, "k1", "read_only"))).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    await expect(w.rt.promote(w.pkg, await promotion(w, ana, "k1", "read_only", { role: "accountant" }))).rejects.toMatchObject({ code: "invalid_decision" });
    await expect(start(w, "Kept", "k2", "read_only")).rejects.toMatchObject({ code: "unpromoted", message: expect.stringContaining("a member of finance_lead") });
    await w.rt.promote(w.pkg, await promotion(w, ben, "k1", "read_only"));
    expect((await start(w, "Kept", "k3", "read_only")).state).toBe("succeeded");
  });

  it("binds a promotion to its package, its workflow, its from-run and its rung", async () => {
    const w = await ladder();
    await approveCards(w);
    await promotedDesign(w, "Note", "d1");
    expect((await start(w, "Note", "d2", "design")).state).toBe("succeeded");
    // Another workflow of the package is not promoted by Note's promotion.
    await expect(start(w, "Other", "o1", "read_only")).rejects.toMatchObject({ code: "unpromoted" });
    // Another package, whose card is approved, is not promoted by this one's; this one's promotion is not taken for it.
    const other = buildPackage(w.pkg.program, lockOf(true, { eda: { keys: [EvidenceSigner.generate().keyId] } }));
    await approveCards(w, other);
    await expect(start(w, "Note", "x1", "read_only", other)).rejects.toMatchObject({ code: "unpromoted" });
    await expect(w.rt.promote(other, await promotion(w, ana, "d2", "read_only"))).rejects.toMatchObject({ code: "invalid_decision", reason: "subject_mismatch" });
    // A promotion signed on one run is not one of another: its subject names the run.
    await expect(w.rt.promote(w.pkg, await promotion(w, ana, "d1", "read_only", { change: (r) => ({ ...r, run: "d2" }) }))).rejects.toMatchObject({ code: "invalid_decision", reason: "subject_mismatch" });
    // One on a run that is not stored, or not of this package, is no promotion.
    const nowhere = signDecision(ana.key, { package: w.pkg.hash, run: "nowhere", revision: 0, subject: "made-up", role: "accountant" }, { kind: "promote", member: "ana", payload: payloadOf.promotion("read_only"), at: at(w) });
    await expect(w.rt.promote(w.pkg, nowhere)).rejects.toMatchObject({ code: "bad_promotion" });
    expect((await start(w, "Note", "y1", "design", other)).state).toBe("succeeded");
    await expect(w.rt.promote(w.pkg, await promotion(w, ana, "y1", "read_only", { change: (r) => ({ ...r, package: w.pkg.hash }) }))).rejects.toMatchObject({ code: "bad_promotion" });
    // A promotion to read_only does not start a live run, nor one to live a read_only run.
    await expect(start(w, "Note", "l1", "live")).rejects.toMatchObject({ code: "unpromoted" });
    expect(await count(w, "decisions where kind = 'promote'")).toBe(1);
  });

  it("takes no promotion once the evidence it was made on changed, and keeps the runs that started under it", async () => {
    const w = await ladder();
    await approveCards(w);
    await promotedDesign(w, "Note", "d1");
    expect((await start(w, "Note", "r1", "read_only")).state).toBe("succeeded");
    await w.rt.promote(w.pkg, await promotion(w, ana, "r1", "live"));
    expect((await start(w, "Note", "l1", "live")).state).toBe("succeeded");

    // The read_only run's actions changed: the shadow diff the live promotion carries is another, and it is not taken.
    await w.db.query(`update actions set params = '{"changed": true}'::jsonb where run_id = $1`, ["r1"]);
    await expect(start(w, "Note", "l2", "live")).rejects.toMatchObject({ code: "unpromoted" });
    // The design run's manifest changed: it no longer hashes to its manifest hash, and the read_only promotion fails too.
    await w.db.query(`update runs set manifest = jsonb_set(manifest, '{input}', '"made-up"') where run_id = $1`, ["d1"]);
    await expect(start(w, "Note", "r2", "read_only")).rejects.toMatchObject({ code: "unpromoted" });
    // The runs that started under them stand, and replaying one starts nothing.
    const runs = await count(w, "runs");
    expect((await w.rt.getRun("l1")).state).toBe("succeeded");
    expect(await w.rt.replayRun("l1")).toMatchObject({ status: "complete" });
    expect(await count(w, "runs")).toBe(runs);
  });

  it("takes no promotion whose key the runtime no longer knows, nor one made on a run that did not start under a promotion", async () => {
    const w = await ladder();
    // Dan approves the card, Ana promotes.
    await w.rt.approveEnvelope(w.pkg, card(w, dan, "accountant"));
    await promotedDesign(w, "Note", "d1", ana);
    const without = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { keys: new TrustedKeys([dan, ben].map((p) => p.key.publicKey)) } });
    await expect(without.startRun({ pkg: w.pkg, workflow: "Note", input: ISSUE, runId: "n1", mode: "read_only" })).rejects.toMatchObject({ code: "unpromoted" });
    expect((await start(w, "Note", "r1", "read_only")).state).toBe("succeeded");
    // A read_only run whose manifest says it started under no promotion (written so, and hashed again) cannot be promoted to live.
    const [row] = await w.db.query<Obj>("select manifest from runs where run_id = $1", ["r1"]);
    const { promotion: _gone, ...bare } = row!["manifest"] as Obj;
    await w.db.query("update runs set manifest = $2::jsonb, manifest_hash = $3 where run_id = $1", ["r1", JSON.stringify(bare), digest("run", bare as Value)]);
    await expect(w.rt.promotionShown("r1", "live")).rejects.toMatchObject({ code: "bad_promotion", message: expect.stringContaining("did not start under a promotion") });
  });

  it("shows a shadow diff as counts per effect, and never what an action carries", async () => {
    const w = await ladder();
    await approveCards(w);
    const secret = "zebra-quartz";
    const d = await w.rt.startRun({ pkg: w.pkg, workflow: "Note", input: { issue: { id: secret } }, runId: "d1", mode: "design" });
    expect(d.state).toBe("succeeded");
    await w.rt.promote(w.pkg, await promotion(w, ana, "d1", "read_only"));
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Note", input: { issue: { id: secret } }, runId: "r1", mode: "read_only" })).state).toBe("succeeded");
    expect((await w.rt.promotionShown("r1", "live")).design).toBe("d1");
    const lines = shadowCounts(await shadowDiff(w.rt, "d1", "r1"));
    expect(lines).toEqual(["shadow diff against design run d1:", "  git.comment: 1 would apply (0 as in the design run, 0 otherwise, 1 not in it); 0 only in the design run"]);
    expect(lines.join("\n")).not.toContain(secret);
  });
});

// ── the compiler's fixture ──────────────────────────────────────────────

describe("the compiler's fixture of owners (fixtures/attention/owner.mdt)", () => {
  /** Its lock, with keys made now for Ana and Ben, and without role_classes, which this runtime does not run yet (B4). */
  function ownerLock(): Lock {
    const given = JSON.parse(readFileSync(new URL("../../fixtures/attention/owner.lock.json", import.meta.url), "utf8")) as Obj;
    const { role_classes: _b4, ...rest } = given;
    expect(rest["promotion"]).toBe("required");
    return { ...rest, members: { ana: { keys: [ana.key.keyId] }, ben: { keys: [ben.key.keyId] } } } as unknown as Lock;
  }

  it("takes no promotion from a run that did not succeed, or has not ended", async () => {
    let calls = 0;
    const agents = new SimAgents().on("Writer.write", () => (calls++ === 0 ? { error: { tag: "SkillFailed", args: [{ kind: "made-up" }] }, cost: { steps: 1 } } : { ok: "a line", cost: { steps: 1 } }));
    const w = await world(readFileSync(new URL("../../fixtures/attention/owner.mdt", import.meta.url), "utf8"), { agents, lock: ownerLock(), decisions: { keys: KEYS } });
    await approveCards(w);
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Describe", input: { name: "a" }, runId: "f1", mode: "design" })).state).toBe("failed");
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Check", input: {}, runId: "w1", mode: "design" })).state).toBe("waiting");
    for (const [runId, who, role, state] of [["f1", ana, "accountant", "failed"], ["w1", ben, "finance_lead", "waiting"]] as const) {
      await expect(w.rt.promotionShown(runId, "read_only")).rejects.toMatchObject({ code: "bad_promotion", message: expect.stringContaining(`is ${state}, and has not succeeded`) });
      // A record signed on the subject the run would have, were its state not asked, is refused the same, and not stored.
      const run = await w.rt.getRun(runId);
      const subject = promotionSubject({ package: w.pkg.hash, workflow: run.workflow, from: { run: runId, mode: "design", manifest: run.manifest_hash! }, to: "read_only", shadow: null });
      const signed = signDecision(who.key, { package: w.pkg.hash, run: runId, revision: run.revision, subject, role }, { kind: "promote", member: who.member, payload: payloadOf.promotion("read_only"), at: at(w) });
      await expect(w.rt.promote(w.pkg, signed)).rejects.toMatchObject({ code: "bad_promotion", message: expect.stringContaining(`is ${state}`) });
    }
    expect(await count(w, "decisions where kind = 'promote'")).toBe(0);
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Describe", input: { name: "a" }, runId: "r1", mode: "read_only" })).rejects.toMatchObject({ code: "unpromoted" });
  });

  it("asks the owner of a workflow that applies a pattern, as its expansion keeps it, for its card and its promotion", async () => {
    const agents = new SimAgents().on("Writer.write", () => ({ ok: "a line", cost: { steps: 1 } }));
    const w = await world(readFileSync(new URL("../../fixtures/attention/owner.mdt", import.meta.url), "utf8"), { agents, lock: ownerLock(), decisions: { keys: KEYS } });
    const input = { name: "a" };
    await w.rt.approveEnvelope(w.pkg, card(w, ana, "accountant"));
    // Check applies the pattern Line, and the finance lead owns it: the accountant's approval does not start it.
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Check", input: {}, runId: "c0", mode: "design" })).rejects.toMatchObject({ code: "unapproved_envelope", message: expect.stringContaining("No member of finance_lead") });
    await w.rt.approveEnvelope(w.pkg, card(w, ben, "finance_lead"));
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Check", input: {}, runId: "c1", mode: "design" })).state).not.toBe("failed");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Check", input: {}, runId: "c2", mode: "read_only" })).rejects.toMatchObject({ code: "unpromoted", message: expect.stringContaining("a member of finance_lead") });
    // Describe is the accountant's: a design run, her promotion, and its read_only runs start.
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Describe", input, runId: "d1", mode: "design" })).state).toBe("succeeded");
    await expect(w.rt.promote(w.pkg, await promotion(w, ben, "d1", "read_only"))).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    await w.rt.promote(w.pkg, await promotion(w, ana, "d1", "read_only"));
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Describe", input, runId: "r1", mode: "read_only" })).state).toBe("succeeded");
  });
});

// ── mandate test ────────────────────────────────────────────────────────

/** A 0.7 program with an owner and a test of it. */
const TESTED = `mandate @ 0.7

module test.ladder_tests @ 0.1

use std.{fs}

role accountant "Accountant"

capability Note = fs.read("/tmp/notes")

workflow Close(title: Text) -> Bool
  owner  accountant
  caps   Note
  budget { steps: 2 }
{
  true
}

test "it closes" {
  run Close("Q3") expect ok
}
`;

describe("mandate test of a 0.7 program whose lock asks for promotion", () => {
  it("runs each test live, its card approved by the test's own people: a test climbs no ladder", async () => {
    const r = check(TESTED, "mdt");
    expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const w = await ladder({ promotion: false });
    const dir = mkdtempSync(join(tmpdir(), "mandate-ladder-tests-"));
    try {
      const results = await runTests(r.program!, { db: w.db, dir, lock: { modules: {}, promotion: "required" } as unknown as Lock });
      expect(results.map((x) => [x.test, x.ok, x.state])).toEqual([["it closes", true, "succeeded"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the entries ─────────────────────────────────────────────────────────

describe("where a run starts", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  /** Every source, its folders (egress/, temporal/) too. */
  const files = (readdirSync(src, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/")).filter((f) => f.endsWith(".ts"));
  const text = (f: string): string => readFileSync(join(src, f), "utf8");

  it("is startRun alone, by construction: createRun takes only the start startRun made, for its run and manifest, once", async () => {
    const w = await ladder({ promotion: false });
    await approveCards(w);
    const { claimRunStarts } = await import("../src/journal.js");
    // The maker of starts is runtime.ts's: nobody claims it again.
    expect(() => claimRunStarts()).toThrow("claimed already");
    const bare = { runId: "z1", tenant: "default", packageHash: w.pkg.hash, workflow: "Note", input: ISSUE as unknown as Value, policy: { tenant: "default" }, limits: {}, manifest: {}, manifestHash: "sha256:m" };
    // A start written out is none.
    await expect(w.db.tx((tx) => w.rt.journal.createRun(tx, { runId: "z1", manifestHash: "sha256:m" } as never, bare))).rejects.toThrow("createRun takes only the start");
    // The start startRun makes is for its run and its manifest, and is taken once.
    const j = w.rt.journal;
    const real = j.createRun.bind(j);
    const tried: string[] = [];
    const attempt = (what: string, p: Promise<void>): Promise<void> => p.then(() => void tried.push(`${what}: created`), (e: Error) => void tried.push(`${what}: ${e.message.split(" for run")[0]}`));
    j.createRun = async (tx, start, r) => {
      await attempt("another run", real(tx, start, { ...r, runId: `${r.runId}-other` }));
      await attempt("another manifest", real(tx, start, { ...r, manifestHash: "sha256:other" }));
      await real(tx, start, r);
      // The same run again: the start was taken, so it is refused before anything is written.
      await attempt("again", real(tx, start, r));
    };
    expect((await start(w, "Note", "z2", "design")).state).toBe("succeeded");
    expect(tried).toEqual(["another run: createRun takes only the start Runtime.startRun made", "another manifest: createRun takes only the start Runtime.startRun made", "again: createRun takes only the start Runtime.startRun made"]);
    expect((await w.db.query<Obj>("select run_id from runs order by run_id")).map((r) => r["run_id"])).toEqual(["z2"]);
  });

  /**
   * Each place a source names `name` that is not one of `allowed` (`<file>:<what>`): an identifier, or a string or a
   * template that holds the name. `what` is `declared`, `called` (the callee of a call, as `x.name(…)` or `name(…)`),
   * `imported`, or `named` for any other mention (`x.name` handed on, `.bind`, `.call`, `x["name"]`, a string).
   */
  function mentions(name: string): string[] {
    const out: string[] = [];
    for (const f of files) {
      const body = text(f);
      if (!body.includes(name)) continue;
      const source = ts.createSourceFile(f, body, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && n.text === name) {
          const p = n.parent;
          const declared = (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name === n;
          const imported = ts.isImportSpecifier(p);
          const callee = ts.isPropertyAccessExpression(p) && p.name === n ? p : n;
          const called = !declared && !imported && ts.isCallExpression(callee.parent) && callee.parent.expression === callee;
          out.push(`${f}:${declared ? "declared" : imported ? "imported" : called ? "called" : "named"}`);
        } else if ((ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) && n.getText().includes(name)) {
          out.push(`${f}:named in ${n.getText().slice(0, 40)}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(source);
    }
    return out.sort();
  }

  it("and by its sources: createRun is declared once and called once, in startRun after the ladder; one insert writes a run", () => {
    expect(files).toContain("temporal/workflows.ts");
    // The message of its refusal names it; nothing else does, but the one call and the one declaration.
    expect(mentions("createRun")).toEqual(["journal.ts:declared", "journal.ts:named in `createRun takes only the start Runtime.", "runtime.ts:called"]);
    expect(mentions("claimRunStarts")).toEqual(["journal.ts:declared", "runtime.ts:called", "runtime.ts:imported"]);
    const runtime = text("runtime.ts");
    const startRun = runtime.indexOf("async startRun(");
    const next = runtime.indexOf("\n  async ", startRun + 1);
    const call = runtime.indexOf(".createRun(", startRun);
    expect(call > startRun && call < next, "the one call is in startRun").toBe(true);
    expect(runtime.indexOf("promotionAtStart(", startRun)).toBeLessThan(call);
    expect(runtime.indexOf("runStart(runId", startRun)).toBeLessThan(call);
    // An insert into runs, with a schema or without, quoted or not, in any case and spacing: the one is createRun's.
    const insert = /insert\s+into\s+(?:["`]?\w+["`]?\s*\.\s*)?["`]?runs["`]?(?!\w)/gi;
    expect(files.flatMap((f) => (text(f).match(insert) ?? []).map(() => f))).toEqual(["journal.ts"]);
  });
});

// ── before ──────────────────────────────────────────────────────────────

describe("a lock without promotion, and a package older than 0.7", () => {
  it("run as before: no promotion is asked, none is listed, and a stored one changes nothing", async () => {
    const w = await ladder({ promotion: false });
    await approveCards(w);
    expect((await start(w, "Note", "d1", "design")).state).toBe("succeeded");
    // A promotion may be signed and kept, but no run asks for it.
    await w.rt.promote(w.pkg, await promotion(w, ana, "d1", "read_only"));
    for (const [id, mode] of [["r1", "read_only"], ["l1", "live"]] as const) {
      expect((await start(w, "Note", id, mode)).state).toBe("succeeded");
      expect(await manifestOf(w, id)).not.toHaveProperty("promotion");
      expect(await eventsOf(w, id, "promotion_accepted")).toEqual([]);
    }
  });

  it("a package of 0.6 whose lock names promotion is refused at load as before (E0140), with members or without", async () => {
    const r = check(ONLY_PLAIN.replace("mandate @ 0.7", "mandate @ 0.6"), "mdt");
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.program!.language).toBe("mandate/0.6");
    const refusal = (lock: Obj): unknown => {
      try {
        verifyPackage(buildPackage(r.program!, lock as unknown as Lock));
        return undefined;
      } catch (e) {
        const v = e as { code?: unknown; message?: unknown };
        return { code: v.code, message: v.message };
      }
    };
    // As before this slice: without other fields the compiler's check refuses it; with members the lock's schema of 0.6 does.
    expect(refusal({ modules: {}, promotion: "required" })).toEqual({ code: "load_verification_failed", message: "load_verification_failed: The program does not pass the compiler's checks: MDT-E0140." });
    expect(refusal({ ...(lockOf(false) as unknown as Obj), promotion: "required" })).toMatchObject({ code: "malformed_lock", message: expect.stringContaining("spec/lock-0.6.schema.json: / must NOT have additional properties") });
  });
});
