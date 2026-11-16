// `human.review` and waivers at run time (0.6; spec/library.md "`human.review` and waivers", "What `Verified`
// accepts", "Runtime"; cases H08, H09). A map verifies each item; one review asks a person once about the items that
// failed only what a person may waive; one signed decision waives or declines each of them; a waived item goes on as
// a Verified value whose evidence holds a waiver beside its failed record, and a later effect accepts it only on that
// waiver, for that very value. Each rule of the decision is shown by one decision that breaks it, refused by name,
// with nothing changed; each rule of what a Verified value is accepted on, by one record forged against it.
//
// The Rust compiler alone reads a program of 0.6: with MANDATE_COMPILER=ts these tests are skipped by name.

import { readFileSync } from "node:fs";
import { toMarkdown, type Def, type LibrarySource, type Lock } from "@mandate/bridge";
import { compilerMode } from "@mandate/bridge/mode";
import { afterAll, describe, expect, it } from "vitest";
import { commandClass, EVENT_CLASSES, stepClass, WAIT_KINDS } from "../src/classes.js";
import { InvalidDecision, payloadOf, signDecision, type DecisionKind, type Shown, type SignedDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys, type EvidenceRecord } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { NOT_RUN_YET_06, reservedMethods } from "../src/package.js";
import { forbidden } from "../src/connectors.js";
import { buildPackage, verifyPackage } from "../src/runtime.js";
import { classify, givenValueProblem, listsRefusal, outcomeProblem, RESERVED_MEMBERS, questionOf as askOf, waiverFacts, waiverProblem, waiveRoleRefusal, waiversOf, type Question, type Verdict, type WaiverFacts } from "../src/review.js";
import { Crash } from "../src/signals.js";
import { SimAgents, SimTool } from "../src/sim.js";
import { digest, isObj, plain, type Obj, type Value } from "../src/values.js";
import { roleDoc, runDoc, runView } from "../src/views.js";
import { closeAll, world, type World } from "./helpers.js";

afterAll(closeAll);

const rust = compilerMode() !== "ts";
const needs06 = rust ? describe : describe.skip;

const PROGRAM = `mandate @ 0.6

module test.review @ 0.1

use std.{fs, human, model}

role accountant   "Accountant"
role finance_lead "Finance lead"
role clerk        "Clerk"

type Invoice = { invoice_no: Text, vendor_id: Text, total_cents: Int }
type Match   = { invoice_no: Text, vendor_id: Text, total_cents: Int }
type DraftId = { draft_id: Text }
type Batch   = { posted: List<Outcome<Receipt<DraftId>>>, declined: List<Declined<Match>>, failed: List<Int> }

capability ModelStd = model.infer(tier: standard, max_class: internal)
capability Files    = fs.write("/work/drafts")

effect post_draft(m: Verified<Match, Matched>) -> Receipt<DraftId>
  requires caps fs.write("/work/drafts")
  critical
  idempotency required

/// Whether \`a\` is within \`pct\` percent of \`b\`.
fn near(a: Int, b: Int, pct: Int) -> Bool ! {} {
  a * 100 <= b * (100 + pct) and a * 100 >= b * (100 - pct)
}

/// A match names its invoice and its vendor; its total may be off by more than 2% when a person waives it.
contract Matched(inv: Invoice, m: Match) {
  accept same_invoice "The match is for this invoice"
    by static m.invoice_no == inv.invoice_no
  accept vendor "The invoice's vendor is the match's"
    by static m.vendor_id == inv.vendor_id
  accept totals "The total is within 2% of the invoice's"
    by static near(m.total_cents, inv.total_cents, 2)
    waive by accountant, finance_lead
}

agent Matcher {
  role   "Matches one invoice."
  caps   ModelStd
  budget { tokens: 6k, steps: 2 }
  skill match(inv: Invoice) -> Inferred<Match> ! {Model}
}

/// Matches every invoice, asks the accountant once about the rest, and posts each accepted match.
workflow ReviewAll(items: List<Invoice>) -> Batch
  caps   ModelStd, Files
  budget { time: 2h }
{
  let checked = map it in items max 10 par 2 {
    let out = delegate Matcher.match(it)
    verify out against Matched(it, out)
  }
  let reviewed = human.review(checked, role: accountant, deadline: 1d, escalate_to: finance_lead)
  let posted = map v in reviewed.accepted max 10 {
    effect post_draft(v) idempotent_by v.invoice_no
  }
  Batch { posted: posted, declined: reviewed.declined, failed: reviewed.failed }
}
`;

/** The same program, whose review asks the accountant alone: it is not escalated. */
const UNESCALATED = PROGRAM.replace(", escalate_to: finance_lead)", ")");

const DAY = 86_400_000;
const REVIEW_AT = "/defs/ReviewAll/body/1/value";
const MAP_AT = "/defs/ReviewAll/body/0/value";

// ── the people ──────────────────────────────────────────────────────────

interface Person {
  member: string;
  key: EvidenceSigner;
}

/** Ana and Dee are accountants, Ben the finance lead, Cid a clerk. */
function people() {
  const person = (member: string): Person => ({ member, key: EvidenceSigner.generate() });
  const ana = person("ana");
  const ben = person("ben");
  const cid = person("cid");
  const dee = person("dee");
  const all = [ana, ben, cid, dee];
  const members = Object.fromEntries(all.map((p) => [p.member, { keys: [p.key.keyId] }]));
  const roles = { accountant: ["ana", "dee"], finance_lead: ["ben"], clerk: ["cid"] };
  return { ana, ben, cid, dee, members, roles, keys: new TrustedKeys(all.map((p) => p.key.publicKey)) };
}

type People = ReturnType<typeof people>;

// ── the batch ───────────────────────────────────────────────────────────

const inv = (no: string, total = 1000, vendor = "V1"): Obj => ({ invoice_no: no, vendor_id: vendor, total_cents: total });

/**
 * Five invoices: 0 is matched exactly; 1 is off by 10%; 2 names another vendor (and is off too); 3's matching
 * fails; 4 is off by 5%. So 0 passes, 1 and 4 are open, 2 is declined without asking, 3 failed.
 */
const MIXED = [inv("I0"), inv("I1"), inv("I2"), inv("I3"), inv("I4")];
const MATCHES: Record<string, Obj | "fail"> = { I0: inv("I0"), I1: inv("I1", 1100), I2: inv("I2", 1100, "V2"), I3: "fail", I4: inv("I4", 1050) };

interface RWorld extends World {
  who: People;
  tool: SimTool;
}

async function rworld(o: { src?: string; matches?: Record<string, Obj | "fail"> } = {}): Promise<RWorld> {
  const who = people();
  const matches = o.matches ?? MATCHES;
  const agents = new SimAgents().on("Matcher.match", (req) => {
    const m = matches[String((req.args[0] as Obj)["invoice_no"])];
    return m === "fail" || m === undefined ? { error: { tag: "SkillFailed", args: ["no_match"] }, cost: { steps: 1 } } : { ok: m, cost: { steps: 1 } };
  });
  const tool = new SimTool("post_draft");
  const w = await world(o.src ?? PROGRAM, { agents, tools: [tool], lock: { modules: {}, members: who.members, roles: who.roles }, decisions: { keys: who.keys } });
  return { ...w, who, tool };
}

const start = (w: World, runId: string, items: Obj[] = MIXED): Promise<RunRow> => w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items }, runId });

let n = 0;
const msg = (sender = "cli") => ({ sender, messageId: `m${++n}` });

interface Signing {
  change?: (s: Shown) => Shown;
  payload?: string;
  kind?: DecisionKind;
}

/** `who`'s signed review decision on what the run shows now; `change` makes the record say something else first. */
async function signed(w: World, runId: string, who: Person, d: { waive: number[]; decline: number[] }, o: Signing = {}): Promise<SignedDecision> {
  const shown = await w.rt.shown(runId, "wait");
  return signDecision(who.key, o.change ? o.change(shown) : shown, { kind: o.kind ?? "review", member: who.member, payload: o.payload ?? payloadOf.review(d), at: new Date(w.adapters.clock.now()) });
}

/** `who` decides the review as `d` says. */
async function decide(w: World, runId: string, who: Person, d: { waive: number[]; decline: number[] }, o: Signing = {}): Promise<RunRow> {
  return w.rt.decideReview(runId, msg(), { signed: await signed(w, runId, who, d, o), ...d });
}

const requestOf = (r: RunRow): Obj => (isObj(r.waiting) && isObj(r.waiting["request"] ?? null) ? (r.waiting["request"] as Obj) : {});
const questionOf = (r: RunRow): Obj => requestOf(r)["question"] as Obj;
const state = (r: RunRow): string => `${r.state} ${JSON.stringify(r.error ?? r.attention ?? null)}`;
const posted = (t: SimTool): string[] => t.executions.map((e) => String((plain(e.params) as Obj[])[0]!["invoice_no"]));
const valueOf = (m: Obj | "fail"): string => digest("request", plain(m as Value));

async function events(w: World, runId: string, type: string): Promise<Obj[]> {
  return (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data as Obj);
}

/** Everything a refused decision must leave as it was. */
async function snapshot(w: World, runId: string) {
  const run = await w.rt.getRun(runId);
  const count = async (sql: string, params: unknown[] = [runId]) => Number((await w.db.query<{ n: number }>(sql, params))[0]!.n);
  return {
    state: run.state,
    revision: run.revision,
    waiting: run.waiting,
    decisions: await count("select count(*) as n from decisions where run_id = $1"),
    evidence: await count("select count(*) as n from evidence where run_id = $1"),
    inbox: await count("select count(*) as n from inbox", []),
    actions: await count("select count(*) as n from actions where run_id = $1"),
    waits: await w.db.query("select command_id, state, result from commands where run_id = $1 and kind = 'review'", [runId]),
    events: (await w.rt.journal.events(runId)).filter((e) => e.type !== "decision_refused").length,
  };
}

/** A decision `make` sends is refused with `code` and `reason`, `decision_refused` names that reason, and nothing else changes. */
async function refusedAs(w: World, runId: string, make: () => Promise<unknown>, code: string, reason: string): Promise<string> {
  const before = await snapshot(w, runId);
  const refusals = (await events(w, runId, "decision_refused")).length;
  let thrown: unknown;
  try {
    await make();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `${reason} is refused`).toBeInstanceOf(InvalidDecision);
  expect({ code: (thrown as InvalidDecision).code, reason: (thrown as InvalidDecision).reason }).toEqual({ code, reason });
  expect(await snapshot(w, runId)).toEqual(before);
  const refused = await events(w, runId, "decision_refused");
  expect(refused).toHaveLength(refusals + 1);
  expect(refused.at(-1)!["reason"]).toBe(reason);
  return (thrown as InvalidDecision).message;
}

// ── the wait ────────────────────────────────────────────────────────────

needs06("a review's wait", () => {
  it("with every item passing, opens no wait: all are accepted and posted, and nobody is asked", async () => {
    const w = await rworld({ matches: { I0: inv("I0"), I1: inv("I1"), I2: inv("I2") } });
    const r = await start(w, "w1", [inv("I0"), inv("I1"), inv("I2")]);
    expect(state(r)).toBe("succeeded null");
    expect(await w.db.query("select 1 from commands where run_id = 'w1' and kind = 'review'")).toEqual([]);
    expect(await events(w, "w1", "review_requested")).toEqual([]);
    expect(await events(w, "w1", "wait_opened")).toEqual([]);
    expect(posted(w.tool)).toEqual(["I0", "I1", "I2"]);
    const result = r.result as Obj;
    expect([(result["posted"] as Value[]).length, result["declined"], result["failed"]]).toEqual([3, [], []]);
    // Each item's verify journaled its verdict: what a review reads, and nothing else.
    expect(Number((await w.db.query<{ n: number | string }>("select count(*) as n from commands where run_id = 'w1' and kind = 'verdict'"))[0]!.n)).toBe(3);
  });

  it("with a mixed batch, opens one wait for the accountant that lists only the items that failed what may be waived", async () => {
    const w = await rworld();
    const r = await start(w, "w2");
    expect(r.state, state(r)).toBe("waiting");
    expect(r.waiting).toMatchObject({ kind: "review", command: REVIEW_AT });
    expect(await w.db.query("select command_id, state from commands where run_id = 'w2' and kind = 'review'")).toEqual([{ command_id: REVIEW_AT, state: "waiting" }]);
    const req = requestOf(r);
    expect(req).toMatchObject({ role: "accountant", escalate_to: "finance_lead", deadline: w.adapters.clock.now() + DAY, deadline_ms: DAY });
    const q = questionOf(r);
    expect(q).toMatchObject({ review: REVIEW_AT, contract: "Matched", map: MAP_AT, accepted: [0], failed: [3], declined: [{ index: 2, unmet: ["totals", "vendor"] }] });
    const items = q["items"] as Obj[];
    expect(items.map((i) => i["index"])).toEqual([1, 4]);
    // Each open item: its value as the map recorded it, what it failed, its failed record, and who may waive it.
    expect(items[0]).toMatchObject({ value: MATCHES["I1"], value_digest: valueOf(MATCHES["I1"]!), unmet: [{ criterion: "totals", description: "The total is within 2% of the invoice's", waive: ["accountant", "finance_lead"] }] });
    const failedId = ((items[0]!["unmet"] as Obj[])[0]!["failed"] as string[])[0]!;
    const [failed] = await w.rt.journal.evidence("w2", [failedId]);
    expect(failed).toMatchObject({ contract: "Matched", criterion: "totals", method: "static", passed: false });
    expect((failed!.subject as Obj)["value"]).toBe(valueOf(MATCHES["I1"]!));
    // The subject a decision is signed on is the digest of the question; the role asked, the accountant.
    const shown = await w.rt.shown("w2", "wait");
    expect(shown).toMatchObject({ command: REVIEW_AT, role: "accountant", subject: digest("request", q as Value) });
    expect(await events(w, "w2", "review_requested")).toEqual([
      { node: REVIEW_AT, contract: "Matched", map: MAP_AT, role: "accountant", escalate_to: "finance_lead", deadline: req["deadline"], open: [1, 4], declined: [2], failed: [3], accepted: [0] },
    ]);
    // Nothing is posted while it waits.
    expect(w.tool.executions).toEqual([]);
    expect(await w.rt.journal.actions("w2")).toEqual([]);
  });

  it("a decision that waives some and declines the rest gives the three lists: the waived go on, the declined stop", async () => {
    const w = await rworld();
    await start(w, "w3");
    const done = await decide(w, "w3", w.who.ana, { waive: [1], decline: [4] });
    expect(state(done)).toBe("succeeded null");
    const result = done.result as Obj;
    expect(result["failed"]).toEqual([3]);
    expect(result["declined"]).toEqual([
      { index: 2, value: MATCHES["I2"], unmet: ["totals", "vendor"], by: null },
      { index: 4, value: MATCHES["I4"], unmet: ["totals"], by: "ana" },
    ]);
    expect((result["posted"] as Value[]).length).toBe(2);
    expect(posted(w.tool)).toEqual(["I0", "I1"]);
    // What was posted for item 1 is the value its verify journaled.
    expect((plain(w.tool.executions[1]!.params) as Value[])[0]).toEqual(MATCHES["I1"]);
    const [decided] = await events(w, "w3", "review_decided");
    expect(decided).toMatchObject({ command: REVIEW_AT, waive: [1], decline: [4], member: "ana", role: "accountant" });
    expect(await events(w, "w3", "criterion_waived")).toEqual([expect.objectContaining({ command: REVIEW_AT, index: 1, contract: "Matched", criterion: "totals", decision: decided!["decision"] })]);
    const decisions = await w.rt.verifyDecisions("w3");
    expect(decisions.map((d) => [d.record.kind, d.record.member, d.record.role, d.valid])).toEqual([["review", "ana", "accountant", true]]);
    expect(decisions[0]!.record.payload).toBe(payloadOf.review({ waive: [1], decline: [4] }));
  });

  it("keeps a waiver apart from a pass: a record of its own beside the failed one, bound to the decision, the criterion, the role and the value", async () => {
    const w = await rworld();
    await start(w, "w4");
    await decide(w, "w4", w.who.ana, { waive: [1, 4], decline: [] });
    const rows = await w.rt.evidence("w4");
    const totals = rows.filter((r) => r.criterion === "totals");
    // Item 0 passed totals; items 1, 2 and 4 failed it; 1 and 4 are waived.
    expect(totals.map((r) => [r.method, r.passed]).sort()).toEqual([
      ["static", false],
      ["static", false],
      ["static", false],
      ["static", true],
      ["waiver", true],
      ["waiver", true],
    ]);
    const [decided] = await events(w, "w4", "review_decided");
    for (const [i, m] of [
      [1, MATCHES["I1"]],
      [4, MATCHES["I4"]],
    ] as const) {
      const waiver = totals.find((r) => r.method === "waiver" && (r.detail as Obj)["index"] === i)!;
      const record = waiver.record as unknown as EvidenceRecord;
      const failed = rows.find((r) => r.evidence_id === (record.detail as Obj)["waives"])!;
      expect(failed).toMatchObject({ method: "static", passed: false, criterion: "totals" });
      expect(record).toMatchObject({ method: "waiver", passed: true, contract: "Matched", criterion: "totals", subject: failed.subject, producer: { kind: "person", via: "Review", member: "ana", role: "accountant", decision: decided!["decision"] } });
      expect((record.subject as Obj)["value"]).toBe(valueOf(m!));
      expect(record.detail).toEqual({ waives: failed.evidence_id, review: REVIEW_AT, index: i });
    }
    // Both kinds of record hold, each by its own rule.
    expect((await w.rt.verifyEvidence("w4")).every((e) => e.valid)).toBe(true);
    // The view shows a waiver as waived, never as met, and the review item by item.
    const { view, program } = await runView(w.rt, "w4");
    const md = toMarkdown(runDoc(view, program));
    expect(md).toContain("| Matched.totals | waiver | waived |");
    expect(md).toContain(`## Review at ${REVIEW_AT}`);
    expect(view.reviews).toEqual([
      expect.objectContaining({
        node: REVIEW_AT,
        role: "accountant",
        escalate_to: "finance_lead",
        escalated: null,
        state: "decided",
        decision: expect.objectContaining({ by: "ana", role: "accountant", signature: "valid" }),
      }),
    ]);
    expect(view.reviews![0]!.items.map((i) => [i.index, i.outcome, i.by, i.waivers.length])).toEqual([
      [0, "accepted", null, 0],
      [1, "waived", "ana", 1],
      [2, "declined without asking", null, 0],
      [3, "failed", null, 0],
      [4, "waived", "ana", 1],
    ]);
    expect(view.reviews![0]!.items[1]!.waivers[0]!.signature_valid).toBe(true);
  });

  it("is shown to the role it asks, and to no other", async () => {
    const w = await rworld();
    await start(w, "w5");
    const asked = await runView(w.rt, "w5", { role: "accountant" });
    expect(asked.view.waiting).toMatchObject({ kind: "review" });
    expect(asked.view.reviews?.map((r) => r.node)).toEqual([REVIEW_AT]);
    const doc = toMarkdown(roleDoc(asked.view, asked.program));
    expect(doc).toContain(`mandate review w5 --revision ${asked.view.as_of.revision} --key \\<your key file\\> --waive \\<indices\\> --decline \\<indices\\>`);
    expect(doc).toContain(`## Review at ${REVIEW_AT}`);
    const other = await runView(w.rt, "w5", { role: "clerk" });
    expect(other.view.waiting).toBeNull();
    expect(other.view.reviews).toEqual([]);
  });
});

// ── the rules of the decision ───────────────────────────────────────────

needs06("the rules of a review's decision, each refused by name with nothing changed", () => {
  it("refuses each decision that breaks a rule, and then takes one that keeps them", async () => {
    const w = await rworld();
    await start(w, "d1");
    const both = { waive: [1, 4], decline: [] };
    const { ana, ben, cid } = w.who;
    // Who signed.
    const real = await signed(w, "d1", ana, both);
    await refusedAs(w, "d1", () => w.rt.decideReview("d1", msg(), { signed: { record: real.record, signature: "ed25519:AAAA" }, ...both }), "invalid_decision", "invalid_signature");
    await refusedAs(w, "d1", () => w.rt.decideReview("d1", msg(), { signed: { record: real.record } as unknown as SignedDecision, ...both }), "invalid_decision", "invalid_signature");
    // What the record is for: the run, the wait, what it asks, the revision, the kind, the items' digest.
    await refusedAs(w, "d1", () => decide(w, "d1", ana, both, { change: (s) => ({ ...s, run: "another run" }) }), "invalid_decision", "subject_mismatch");
    await refusedAs(w, "d1", () => decide(w, "d1", ana, both, { change: (s) => ({ ...s, command: `${s.command}/other` }) }), "invalid_decision", "subject_mismatch");
    await refusedAs(w, "d1", () => decide(w, "d1", ana, both, { change: (s) => ({ ...s, subject: digest("request", { another: "question" }) }) }), "invalid_decision", "subject_mismatch");
    await refusedAs(w, "d1", () => decide(w, "d1", ana, both, { change: (s) => ({ ...s, revision: s.revision - 1 }) }), "stale_revision", "stale_revision");
    await refusedAs(w, "d1", () => decide(w, "d1", ana, both, { kind: "approve" }), "invalid_decision", "subject_mismatch");
    await refusedAs(w, "d1", () => decide(w, "d1", ana, { waive: [1], decline: [4] }, { payload: payloadOf.review(both) }), "invalid_decision", "subject_mismatch");
    // A review's decision answers no other wait: an approval's.
    await refusedAs(w, "d1", async () => w.rt.decideAction("d1", msg(), { signed: await signed(w, "d1", ana, both) }), "invalid_decision", "subject_mismatch");
    // The role: a member who does not hold the role asked, and a decision made in another role.
    await refusedAs(w, "d1", () => decide(w, "d1", cid, both), "invalid_decision", "not_in_role");
    await refusedAs(w, "d1", () => decide(w, "d1", ben, both), "invalid_decision", "not_in_role");
    await refusedAs(w, "d1", () => decide(w, "d1", ana, both, { change: (s) => ({ ...s, role: "finance_lead" }) }), "invalid_decision", "not_in_role");
    // The items: every open item, each once, in one list or the other, and nothing else.
    const lists: Array<[string, { waive: number[]; decline: number[] }, RegExp]> = [
      ["an unknown item", { waive: [1, 4, 9], decline: [] }, /the map has no item 9/],
      ["an item twice", { waive: [1, 1, 4], decline: [] }, /item 1 twice in waive/],
      ["an item in both lists", { waive: [1, 4], decline: [4] }, /item 4 both to waive and to decline/],
      ["an open item left out", { waive: [1], decline: [] }, /leaves open item 4 undecided/],
      ["no item at all", { waive: [], decline: [] }, /leaves open items 1, 4 undecided/],
      ["an item that passed", { waive: [0, 1, 4], decline: [] }, /item 0, which passed and was accepted without anyone being asked/],
      ["an item no one may waive", { waive: [1, 2, 4], decline: [] }, /item 2, which failed totals, vendor, which no one asked may waive/],
      ["an item whose work failed", { waive: [1, 4], decline: [3] }, /item 3, whose work failed/],
      ["what is not an index", { waive: [1, 4], decline: [-1] }, /-1 in decline, which is not an item's index/],
    ];
    for (const [what, d, why] of lists) expect(await refusedAs(w, "d1", () => decide(w, "d1", ana, d), "incomplete_review", "incomplete_review"), what).toMatch(why);
    // The wait stayed open through all of it; a decision that keeps every rule is taken.
    const done = await decide(w, "d1", ana, both);
    expect(state(done)).toBe("succeeded null");
    expect(posted(w.tool)).toEqual(["I0", "I1", "I4"]);
    // It cannot be taken again: the run has moved on from the revision it names. Nor on another run's wait at the same
    // node, whose question names that run's own failed records: even signed on all it shows there, it names its run.
    await refusedAs(w, "d1", () => w.rt.decideReview("d1", msg(), { signed: real, ...both }), "stale_revision", "stale_revision");
    await start(w, "d1b");
    const there = await w.rt.shown("d1b", "wait");
    expect(there.command).toBe(real.record.command);
    expect(there.subject).not.toBe(real.record.subject);
    const replayed = signDecision(ana.key, { ...there, run: "d1" }, { kind: "review", member: "ana", payload: payloadOf.review(both), at: new Date(w.adapters.clock.now()) });
    await refusedAs(w, "d1b", () => w.rt.decideReview("d1b", msg(), { signed: replayed, ...both }), "invalid_decision", "subject_mismatch");
  });

  it("refuses a decision past the wait's deadline: the wait is escalated or expires, and nothing is decided on its own", async () => {
    const w = await rworld();
    await start(w, "d2");
    w.clock.advance(DAY);
    await refusedAs(w, "d2", () => decide(w, "d2", w.who.ana, { waive: [1, 4], decline: [] }), "invalid_decision", "past_deadline");
  });

  it("reads the decision for its indices alone: a value sent with it is no item's, and the journaled one is posted", async () => {
    const w = await rworld();
    await start(w, "d3");
    const forged = inv("FORGED", 1);
    const d = { waive: [1, 4], decline: [] };
    const done = await w.rt.decideReview("d3", msg(), { signed: await signed(w, "d3", w.who.ana, d), ...d, value: forged, values: { 1: forged, 4: forged }, items: [{ index: 1, value: forged }] } as never);
    expect(state(done)).toBe("succeeded null");
    expect(w.tool.executions.map((e) => (plain(e.params) as Value[])[0])).toEqual([MATCHES["I0"], MATCHES["I1"], MATCHES["I4"]]);
    expect(JSON.stringify(await w.db.query("select * from commands where run_id = 'd3'"))).not.toContain("FORGED");
  });

  it("holds the role to every criterion an item failed: a role a criterion's waive by does not name waives nothing (unreachable past E1508, so held here alone)", () => {
    const totals = { description: "The total is near", by: { static: { op: "bool", value: true } }, waive: ["finance_lead"] };
    const vendor = { description: "The vendor is the same", by: { static: { op: "bool", value: true } }, waive: ["accountant", "finance_lead"] };
    const c = { kind: "contract", params: [], accept: { totals, vendor } } as unknown as Def;
    const q = { review: "/r", contract: "C", map: "/m", role: "accountant", escalate_to: null, deadline_ms: 1, accepted: [], failed: [], declined: [], items: [{ index: 1, value: 1, value_digest: "d", unmet: [{ criterion: "vendor", description: null, failed: ["f1"], waive: [] }, { criterion: "totals", description: null, failed: ["f2"], waive: ["accountant"] }] }] } as unknown as Question;
    // The program's contract decides, never what the question says of it.
    expect(waiveRoleRefusal(c, q, [1], "accountant")).toEqual({ reason: "not_in_role", message: "Item 1 failed C.totals, which accountant may not waive: its waive by names finance_lead." });
    expect(waiveRoleRefusal(c, q, [1], "finance_lead")).toBeUndefined();
    expect(waiveRoleRefusal(c, q, [], "accountant")).toBeUndefined();
    expect(waiveRoleRefusal(c, q, [1], undefined)?.reason).toBe("not_in_role");
    // A criterion a person approves is never one a person may waive, whatever it says (E1504).
    const approved = { kind: "contract", params: [], accept: { ok: { description: "", by: { call: { op: "call", callee: { op: "field", of: { op: "var", name: "human" }, name: "approve" }, args: [] } }, waive: ["accountant"] } } } as unknown as Def;
    expect([...waiversOf(approved)]).toEqual([]);
    // An item that failed a criterion the review's role may not waive is not open, and no list may name it.
    const v = (unmet: string[]): Verdict => ({ contract: "C", value: 1, value_digest: "d", met: unmet.length === 0, unmet, failed: {}, evidence: [], verify: "v" });
    const split = classify([v([]), v(["totals"]), v(["vendor"]), undefined, v(["require/0"])], c, "accountant");
    expect(split).toEqual({ accepted: [0], open: [2], declined: [1, 4], failed: [3] });
    const asked = askOf({ review: "/r", contract: "C", map: "/m", role: "accountant", escalate_to: null, deadline_ms: 1, c, verdicts: [v([]), v(["totals"]), v(["vendor"]), undefined, v(["require/0"])], split });
    expect(listsRefusal(asked, { waive: [2], decline: [] })).toBeUndefined();
    expect(listsRefusal(asked, { waive: [1, 2], decline: [] })?.reason).toBe("incomplete_review");
  });
});

// ── escalation and expiry ───────────────────────────────────────────────

needs06("escalation and expiry (H08)", () => {
  it("past the deadline goes once to escalate_to, refusing the first role then; past the second every open item is declined", async () => {
    const w = await rworld();
    const r = await start(w, "e1");
    const first = requestOf(r)["deadline"] as number;
    // Before the deadline, a tick changes nothing.
    w.clock.advance(DAY - 1);
    expect((await w.rt.tick("e1")).revision).toBe(r.revision);
    w.clock.advance(1);
    const escalated = await w.rt.tick("e1");
    expect(escalated.state).toBe("waiting");
    expect(escalated.revision).toBeGreaterThan(r.revision);
    expect(requestOf(escalated)).toMatchObject({ role: "finance_lead", deadline: first + DAY, escalated: { from: "accountant", at: first } });
    expect(questionOf(escalated)).toEqual(questionOf(r));
    expect(await events(w, "e1", "review_escalated")).toEqual([{ command: REVIEW_AT, from: "accountant", to: "finance_lead", deadline: first + DAY }]);
    expect(await w.rt.shown("e1", "wait")).toMatchObject({ role: "finance_lead", subject: (await w.rt.shown("e1", "wait")).subject });
    // The accountant, who was asked first, is asked no more: whichever role her record names.
    const both = { waive: [1, 4], decline: [] };
    await refusedAs(w, "e1", () => decide(w, "e1", w.who.ana, both), "invalid_decision", "not_in_role");
    await refusedAs(w, "e1", () => decide(w, "e1", w.who.ana, both, { change: (s) => ({ ...s, role: "accountant" }) }), "invalid_decision", "not_in_role");
    // It is escalated once: a tick before the second deadline changes nothing.
    w.clock.advance(DAY - 1);
    expect((await w.rt.tick("e1")).revision).toBe(escalated.revision);
    w.clock.advance(1);
    const expired = await w.rt.tick("e1");
    expect(state(expired)).toBe("succeeded null");
    expect(await events(w, "e1", "review_expired")).toEqual([{ command: REVIEW_AT, role: "finance_lead", declined: [1, 4] }]);
    expect(await events(w, "e1", "wait_expired")).toEqual([{ command: REVIEW_AT }]);
    const result = expired.result as Obj;
    expect((result["declined"] as Obj[]).map((d) => [d["index"], d["by"]])).toEqual([
      [1, null],
      [2, null],
      [4, null],
    ]);
    expect(posted(w.tool)).toEqual(["I0"]);
    expect(await w.db.query("select 1 from evidence where run_id = 'e1' and method = 'waiver'")).toEqual([]);
    const { view } = await runView(w.rt, "e1");
    expect(view.reviews![0]).toMatchObject({ state: "expired", escalated: { to: "finance_lead", deadline: first + DAY } });
    expect(view.reviews![0]!.items.map((i) => i.outcome)).toEqual(["accepted", "declined at expiry", "declined without asking", "failed", "declined at expiry"]);
  });

  it("once escalated, the finance lead decides, and the waivers name that role", async () => {
    const w = await rworld();
    await start(w, "e2");
    w.clock.advance(DAY);
    await w.rt.tick("e2");
    const done = await decide(w, "e2", w.who.ben, { waive: [4], decline: [1] });
    expect(state(done)).toBe("succeeded null");
    expect(posted(w.tool)).toEqual(["I0", "I4"]);
    const [waiver] = await w.db.query<{ record: Obj }>("select record from evidence where run_id = 'e2' and method = 'waiver'");
    expect(waiver!.record["producer"]).toMatchObject({ member: "ben", role: "finance_lead" });
    // The finance lead's view shows the review it was asked; the accountant's still shows the one it was asked first.
    expect((await runView(w.rt, "e2", { role: "finance_lead" })).view.reviews?.length).toBe(1);
    expect((await runView(w.rt, "e2", { role: "accountant" })).view.reviews?.length).toBe(1);
  });

  it("a late tick escalates and nothing more: the role escalated to has a whole deadline from when it is asked", async () => {
    const w = await rworld();
    await start(w, "e3");
    w.clock.advance(3 * DAY);
    const asked = w.adapters.clock.now();
    const r = await w.rt.tick("e3");
    expect(r.state, state(r)).toBe("waiting");
    expect(requestOf(r)).toMatchObject({ role: "finance_lead", deadline: asked + DAY, escalated: { from: "accountant", at: asked } });
    expect(await events(w, "e3", "review_escalated")).toEqual([{ command: REVIEW_AT, from: "accountant", to: "finance_lead", deadline: asked + DAY }]);
    // Within its deadline the finance lead may still decide; past it, every open item is declined.
    w.clock.advance(DAY - 1);
    expect((await w.rt.tick("e3")).state).toBe("waiting");
    w.clock.advance(1);
    expect(state(await w.rt.tick("e3"))).toBe("succeeded null");
    expect((await w.rt.journal.events("e3")).map((e) => e.type).filter((t) => t.startsWith("review_"))).toEqual(["review_requested", "review_escalated", "review_expired"]);
  });

  it("a review decided while the drive after it did not run is driven by the next tick, before any deadline", async () => {
    const w = await rworld();
    await start(w, "e5");
    // The drive after the decision fails before it takes the run (a compiler or host that is not there, a crash).
    const resume = w.rt.resume.bind(w.rt);
    let failing = true;
    w.rt.resume = async (runId: string) => {
      if (failing) {
        failing = false;
        throw new Error("the drive did not run");
      }
      return resume(runId);
    };
    await expect(decide(w, "e5", w.who.ana, { waive: [1], decline: [4] })).rejects.toThrow("the drive did not run");
    const stuck = await w.rt.getRun("e5");
    expect(stuck.state).toBe("waiting");
    expect(await w.db.query("select state from commands where run_id = 'e5' and kind = 'review'")).toEqual([{ state: "succeeded" }]);
    const done = await w.rt.tick("e5");
    expect(state(done)).toBe("succeeded null");
    expect(posted(w.tool)).toEqual(["I0", "I1"]);
  });

  it("without escalate_to, expires at its first deadline", async () => {
    const w = await rworld({ src: UNESCALATED });
    const r = await start(w, "e4");
    expect(requestOf(r)).toMatchObject({ role: "accountant", escalate_to: null });
    w.clock.advance(DAY);
    const done = await w.rt.tick("e4");
    expect(state(done)).toBe("succeeded null");
    expect(await events(w, "e4", "review_escalated")).toEqual([]);
    expect(await events(w, "e4", "review_expired")).toEqual([{ command: REVIEW_AT, role: "accountant", declined: [1, 4] }]);
  });
});

// ── what a Verified value is accepted on ────────────────────────────────

/** Changes the run's one waiver record as `change` says, and signs it again with `key` (the runtime's own, unless named). */
async function forge(w: World, runId: string, change: (r: Obj) => void, key: EvidenceSigner = w.rt.signer): Promise<void> {
  const [row] = await w.db.query<{ evidence_id: string; record: Obj }>("select evidence_id, record from evidence where run_id = $1 and method = 'waiver'", [runId]);
  const record = structuredClone(row!.record);
  change(record);
  const sig = key.sign(record as unknown as EvidenceRecord);
  await w.db.query("update evidence set record = $2, key_id = $3, signature = $4, subject = $5, detail = $6 where evidence_id = $1", [row!.evidence_id, JSON.stringify(record), sig.key_id, sig.signature, JSON.stringify(record["subject"]), JSON.stringify(record["detail"])]);
}

needs06("what a Verified value is accepted on (H09)", () => {
  /**
   * A run of one open invoice, waived by Ana, that crashes once its post is dispatched: its waiver is then forged as
   * `change` says, and the run resumed. It stops for a person, `forged_evidence`, before anything is prepared.
   */
  async function forged(runId: string, change: (w: RWorld, r: Obj) => void | Promise<void>, key?: (w: RWorld) => EvidenceSigner): Promise<{ run: RunRow; w: RWorld }> {
    const w = await rworld();
    await start(w, runId, [inv("I1")]);
    w.faults.arm("after_dispatch", (i) => i.kind === "prepare");
    await expect(decide(w, runId, w.who.ana, { waive: [0], decline: [] })).rejects.toBeInstanceOf(Crash);
    let pending: Promise<void> | undefined;
    await forge(
      w,
      runId,
      (r) => {
        const p = change(w, r);
        if (p) pending = p;
      },
      key?.(w),
    );
    await pending;
    const run = await w.rt.resume(runId);
    return { run, w };
  }

  it("a waiver that holds is accepted: the resumed run posts the waived item once", async () => {
    const { run, w } = await forged("v0", () => undefined);
    expect(state(run)).toBe("succeeded null");
    expect(posted(w.tool)).toEqual(["I1"]);
  });

  const cases: Array<[string, (w: RWorld, r: Obj) => void, RegExp, ((w: RWorld) => EvidenceSigner)?]> = [
    ["names another decision", (_w, r) => void ((r["producer"] as Obj)["decision"] = digest("decision", { another: "decision" })), /is not recorded/],
    ["names a decision that waived nothing of it", (_w, r) => void ((r["detail"] as Obj)["index"] = 3), /does not waive item 3|did not decide the items/],
    ["is of another value", (_w, r) => void ((r["subject"] as Obj)["value"] = digest("request", { another: "value" })), /another value|another contract, criterion or subject/],
    ["is made in a role the criterion does not name", (_w, r) => void ((r["producer"] as Obj)["role"] = "clerk"), /may be waived by accountant, finance_lead, not by clerk/],
    ["waives another record", (_w, r) => void ((r["detail"] as Obj)["waives"] = digest("request", { another: "record" })), /did not ask about/],
    ["is signed by a key the runtime does not trust", () => undefined, /not signed by a trusted key/, () => EvidenceSigner.generate()],
  ];
  for (const [what, change, why, key] of cases) {
    it(`a waiver that ${what} is not accepted at the effect: forged_evidence, before anything is prepared`, async () => {
      const { run, w } = await forged(`v-${what.replaceAll(" ", "-")}`, change, key);
      expect(run.state, state(run)).toBe("attention_required");
      expect(run.attention).toMatchObject({ violation: "forged_evidence" });
      expect(String((run.attention as Obj)["message"])).toMatch(why);
      expect(w.tool.executions).toEqual([]);
      expect(await w.rt.journal.actions(run.run_id)).toEqual([]);
      // Its record does not hold either, as a view checks it.
      expect((await w.rt.verifyEvidence(run.run_id)).filter((e) => !e.valid).length).toBeGreaterThan(0);
    });
  }

  it("a waiver whose decision was changed after it was signed is not accepted, and the review itself stops for a person", async () => {
    const w = await rworld();
    await start(w, "v9", [inv("I1")]);
    w.faults.arm("after_dispatch", (i) => i.kind === "prepare");
    await expect(decide(w, "v9", w.who.ana, { waive: [0], decline: [] })).rejects.toBeInstanceOf(Crash);
    const [d] = await w.db.query<{ decision_id: string; record: Obj }>("select decision_id, record from decisions where run_id = 'v9'");
    await w.db.query("update decisions set record = $2 where decision_id = $1", [d!.decision_id, JSON.stringify({ ...d!.record, member: "dee" })]);
    const run = await w.rt.resume("v9");
    expect(run.state, state(run)).toBe("attention_required");
    expect(run.attention).toMatchObject({ violation: "invalid_decision" });
    expect(w.tool.executions).toEqual([]);
  });

  it("a waived value without the passing records of what it met is not accepted: a waiver covers its own criterion and no other", async () => {
    const w = await rworld();
    await start(w, "v10", [inv("I1")]);
    // Once the map has ended, the verdict the review reads has lost the passing records of the criteria the item met
    // (the verify itself reads the one the journal holds, and finds it whole).
    const journal = w.rt.journal;
    const mapEnded = journal.mapEnded.bind(journal);
    const command = journal.command.bind(journal);
    let ended = false;
    journal.mapEnded = async (...a: Parameters<typeof mapEnded>) => {
      await mapEnded(...a);
      ended = true;
    };
    const id = `${MAP_AT}[0]/body/1/value/verdict`;
    journal.command = async (runId: string, commandId: string) => {
      const row = await command(runId, commandId);
      return ended && row && commandId === id ? { ...row, result: { ...(row.result as Obj), evidence: [] } } : row;
    };
    const run = await decide(w, "v10", w.who.ana, { waive: [0], decline: [] });
    expect(run.state, state(run)).toBe("attention_required");
    expect(run.attention).toMatchObject({ violation: "forged_evidence" });
    expect(String((run.attention as Obj)["message"])).toMatch(/no evidence for Matched\.same_invoice; no evidence for Matched\.vendor/);
    expect(w.tool.executions).toEqual([]);
  });

  it("holds a waiver record to each of its rules (review.ts waiverProblem), one change at a time", async () => {
    const w = await rworld();
    await start(w, "v11");
    await decide(w, "v11", w.who.ana, { waive: [1, 4], decline: [] });
    const { program } = await w.rt.runProgram("v11");
    const base = await waiverFacts(w.rt.journal, "v11", { contract: (n) => program.defs[n], keys: w.who.keys, lock: w.pkg.lock, trusted: w.rt.trusted });
    const [row] = await w.db.query<{ record: EvidenceRecord }>("select record from evidence where run_id = 'v11' and method = 'waiver' and detail->>'index' = '1'");
    const record = row!.record;
    expect(waiverProblem(record, base)).toBeUndefined();
    const other = (await w.db.query<{ record: EvidenceRecord }>("select record from evidence where run_id = 'v11' and method = 'waiver' and detail->>'index' = '4'"))[0]!.record;
    const failed = base.evidence.get(String((record.detail as Obj)["waives"]))!;
    /** The record changed as `change` says, with the facts changed as `facts` says; why it does not hold. */
    const why = (change: (r: Obj) => void, facts: (f: WaiverFacts) => WaiverFacts = (f) => f): string | undefined => {
      const r = structuredClone(record) as unknown as Obj;
      change(r);
      return waiverProblem(r as unknown as EvidenceRecord, facts(base));
    };
    const at = (k: string) => (r: Obj) => r[k] as Obj;
    // 1. Who may waive the criterion is the program's to say.
    expect(why((r) => void (at("producer")(r)["role"] = "clerk"))).toBe("Matched.totals may be waived by accountant, finance_lead, not by clerk");
    expect(why((r) => void (r["criterion"] = "vendor"))).toBe("Matched.vendor is not a criterion a person may waive (waive by)");
    // 2. The decision.
    expect(why((r) => void (at("producer")(r)["decision"] = "sha256:none"))).toBe("decision sha256:none is not recorded");
    expect(why((r) => void (at("producer")(r)["member"] = "dee"))).toMatch(/was not made by the member, key and role the waiver names/);
    expect(why((r) => void (r["package"] = "sha256:another"))).toMatch(/is not a review's decision of this run/);
    expect(why((r) => void (at("detail")(r)["review"] = "/another/review"))).toMatch(/did not decide the review the waiver names/);
    expect(why(() => undefined, (f) => ({ ...f, outcomes: new Map([[REVIEW_AT, { ...(f.outcomes.get(REVIEW_AT) as Obj), waive: [1] }]]) }))).toMatch(/did not decide the items the waiver names/);
    expect(why((r) => void (at("detail")(r)["index"] = 2))).toMatch(/does not waive item 2/);
    expect(why(() => undefined, (f) => ({ ...f, questions: new Map([[REVIEW_AT, { ...(f.questions.get(REVIEW_AT) as Obj), deadline_ms: 1 }]]) }))).toMatch(/was not made on what review .* asked/);
    // 3. The failed record: one the review asked about for this item, signed, failed, of this contract, criterion and subject.
    expect(why((r) => void (at("detail")(r)["waives"] = (other.detail as Obj)["waives"]!))).toMatch(/did not ask about .* for item 1/);
    expect(why(() => undefined, (f) => ({ ...f, evidence: new Map([...f.evidence].filter(([id]) => id !== failed.evidence_id)) }))).toMatch(/is not a record of this run signed by a trusted key/);
    expect(why(() => undefined, (f) => ({ ...f, trusted: new TrustedKeys() }))).toMatch(/is not a record of this run signed by a trusted key/);
    // 4. The value: with its failed record forged to the same other value, signed by the runtime's own key.
    const elsewhere = digest("request", { another: "value" });
    const forgedFailed = { ...(failed.record as unknown as EvidenceRecord), subject: { ...((failed.record as Obj)["subject"] as Obj), value: elsewhere } };
    const signedAgain = { ...failed, record: forgedFailed as unknown as Value, ...w.rt.signer.sign(forgedFailed) };
    expect(why((r) => void (at("subject")(r)["value"] = elsewhere), (f) => ({ ...f, evidence: new Map([...f.evidence, [failed.evidence_id, signedAgain]]) }))).toMatch(/is a waiver of another value than the one review .* asked about for item 1/);
    // And its own shape: a waiver passes, of this run, under the id its decision and failed record give.
    expect(why((r) => void (r["passed"] = false))).toBe("a waiver that does not pass waives nothing");
    expect(why((r) => void (r["run"] = "another run"))).toBe("it is a waiver of another run");
    expect(why((r) => void (r["evidence_id"] = "sha256:another"))).toBe("its id is not the one its decision and its failed record give");
  });

  it("holds the outcome a review's wait ends with to what it asked (review.ts outcomeProblem)", async () => {
    const w = await rworld();
    const r = await start(w, "v12");
    const q = questionOf(r) as unknown as Question;
    const subject = digest("request", q as unknown as Value);
    const decided = { subject, waive: [1], decline: [4], by: "ana", role: "accountant", member: "ana", key: "k", decision: "d" };
    expect(outcomeProblem(decided, q, subject)).toBeUndefined();
    expect(outcomeProblem({ ...decided, subject: "sha256:other" }, q, subject)).toMatch(/another question/);
    expect(outcomeProblem({ ...decided, waive: [1, 2] }, q, subject)).toMatch(/item 2/);
    expect(outcomeProblem({ ...decided, decline: [] }, q, subject)).toMatch(/leaves open item 4 undecided/);
    expect(outcomeProblem({ ...decided, decision: undefined } as unknown as Value, q, subject)).toMatch(/names no signed decision/);
    expect(outcomeProblem({ subject, waive: [], decline: [1, 4], by: null, role: "accountant", expired: true }, q, subject)).toBeUndefined();
    expect(outcomeProblem({ subject, waive: [1], decline: [4], by: null, role: "accountant", expired: true }, q, subject)).toMatch(/an expired review waived items/);
  });
});

// ── what the journal holds of a review, changed under it ────────────────

needs06("a review whose journal was changed under it", () => {
  it("a question changed while it waits: the decision is not taken (forged_evidence), and a resume stops for a person", async () => {
    const w = await rworld();
    await start(w, "j1");
    const [row] = await w.db.query<{ result: Obj }>("select result from commands where run_id = 'j1' and command_id = $1", [REVIEW_AT]);
    const changed = structuredClone(row!.result);
    ((changed["question"] as Obj)["items"] as Obj[])[0]!["value"] = inv("I1", 1000);
    await w.db.query("update commands set result = $3 where run_id = $1 and command_id = $2", ["j1", REVIEW_AT, JSON.stringify(changed)]);
    const before = await snapshot(w, "j1");
    await expect(decide(w, "j1", w.who.ana, { waive: [1, 4], decline: [] })).rejects.toMatchObject({ code: "forged_evidence" });
    expect(await snapshot(w, "j1")).toEqual(before);
    const resumed = await w.rt.resume("j1");
    expect(resumed.state, state(resumed)).toBe("attention_required");
    expect(resumed.attention).toMatchObject({ violation: "nondeterministic_replay" });
  });

  it("a failed record changed under the decision: the decision is not taken (forged_evidence)", async () => {
    const w = await rworld();
    const r = await start(w, "j2");
    const failedId = (((questionOf(r)["items"] as Obj[])[0]!["unmet"] as Obj[])[0]!["failed"] as string[])[0]!;
    const [row] = await w.db.query<{ record: Obj }>("select record from evidence where evidence_id = $1", [failedId]);
    const record = { ...row!.record, subject: { ...(row!.record["subject"] as Obj), value: digest("request", { another: "value" }) } } as unknown as EvidenceRecord;
    const sig = w.rt.signer.sign(record);
    await w.db.query("update evidence set record = $2, signature = $3 where evidence_id = $1", [failedId, JSON.stringify(record), sig.signature]);
    const before = await snapshot(w, "j2");
    await expect(decide(w, "j2", w.who.ana, { waive: [1, 4], decline: [] })).rejects.toMatchObject({ code: "forged_evidence" });
    expect(await snapshot(w, "j2")).toEqual(before);
  });

  it("a verdict the review reads that is not what its map gave: the run stops for a person, and asks nobody", async () => {
    const w = await rworld();
    // Once the map has ended, what the journal gives for item 1's verdict says it passed, which the map failed.
    const journal = w.rt.journal;
    const mapEnded = journal.mapEnded.bind(journal);
    const command = journal.command.bind(journal);
    let ended = false;
    journal.mapEnded = async (...a: Parameters<typeof mapEnded>) => {
      await mapEnded(...a);
      ended = true;
    };
    const id = `${MAP_AT}[1]/body/1/value/verdict`;
    journal.command = async (runId: string, commandId: string) => {
      const row = await command(runId, commandId);
      return ended && row && commandId === id ? { ...row, result: { ...(row.result as Obj), met: true, unmet: [], failed: {} } } : row;
    };
    const r = await start(w, "j4");
    expect(r.state, state(r)).toBe("attention_required");
    expect(r.attention).toMatchObject({ violation: "nondeterministic_replay" });
    expect(String((r.attention as Obj)["message"])).toContain("Item 1 of the map");
    expect(await events(w, "j4", "review_requested")).toEqual([]);
  });

  it("a verdict of a passing item changed while it waits, with what it asks left as it was: the resumed run's verify stops for a person", async () => {
    const w = await rworld();
    await start(w, "j5");
    // Item 0 passed: what the review asks of it is its index alone, so only its verify can tell that its records went.
    const id = `${MAP_AT}[0]/body/1/value/verdict`;
    const [row] = await w.db.query<{ result: Obj }>("select result from commands where run_id = 'j5' and command_id = $1", [id]);
    await w.db.query("update commands set result = $3 where run_id = $1 and command_id = $2", ["j5", id, JSON.stringify({ ...row!.result, evidence: [] })]);
    const resumed = await w.rt.resume("j5");
    expect(resumed.state, state(resumed)).toBe("attention_required");
    expect(resumed.attention).toMatchObject({ violation: "nondeterministic_replay" });
    expect(String((resumed.attention as Obj)["message"])).toContain("is not the one its criteria give");
  });

  it("a verdict that says an item passed which its criteria failed: the resumed run's verify stops for a person, and asks nobody", async () => {
    const w = await rworld();
    await start(w, "j3");
    const id = `${MAP_AT}[1]/body/1/value/verdict`;
    const [row] = await w.db.query<{ result: Obj }>("select result from commands where run_id = 'j3' and command_id = $1", [id]);
    await w.db.query("update commands set result = $3 where run_id = $1 and command_id = $2", ["j3", id, JSON.stringify({ ...row!.result, met: true, unmet: [], failed: {} })]);
    const resumed = await w.rt.resume("j3");
    expect(resumed.state, state(resumed)).toBe("attention_required");
    expect(resumed.attention).toMatchObject({ violation: "nondeterministic_replay" });
  });
});

// ── what cannot be undone, and what a person answers ────────────────────

const UNDONE = `mandate @ 0.6

module test.undone @ 0.1

use std.{fs, human}

role owner    "Owner"
role reviewer "Reviewer"

type Change = { branch: Text, risk: Int }

capability Tags = fs.write("/work/tags")

effect tag_release(c: Verified<Change>) -> Receipt<Text>
  requires caps fs.write("/work/tags")
  critical
  irreversible
  idempotency required

/// A change is small, or its owner waives that.
contract Small(c: Change) {
  accept small "The change is small"
    by static c.risk < 3
    waive by owner
}

/// A change names its branch, and a reviewer approves it.
contract Named(c: Change) {
  accept named "The change names its branch"
    by static len(c.branch) >= 1
  accept approved "A reviewer approves it"
    by human.approve(role: reviewer)
}

/// Reviews the changes, then tags the release of the one that is named, or of what a person answers for it.
workflow Ship(changes: List<Change>, c: Change) -> Bool
  caps   Tags
  budget { time: 1h }
{
  let checked = map x in changes max 5 {
    verify x against Small(x)
  }
  let reviewed = human.review(checked, role: owner, deadline: 1h)
  let named = verify c against Named(c)
    on unmet(u) => escalate human("Which change is named?")
  effect tag_release(named) idempotent_by c.branch
  true
}
`;

const NESTED = `mandate @ 0.6

module test.nested @ 0.1

use std.{fs, human}

type Change = { branch: Text, risk: Int }

capability Notes = fs.write("/work/notes")

effect note_all(cs: List<Verified<Change, Named>>) -> Receipt<Text>
  requires caps fs.write("/work/notes")
  critical
  idempotency required

effect note_one(c: Verified<Change, Named>) -> Receipt<Text>
  requires caps fs.write("/work/notes")
  critical
  idempotency required

/// A change names its branch.
contract Named(c: Change) {
  accept named "The change names its branch"
    by static len(c.branch) >= 1
}

/// Notes two changes as one list: one that is named, and one that is named or what a person answers for it.
workflow NoteAll(a: Change, b: Change) -> Bool
  caps   Notes
  budget { time: 1h }
{
  let first = verify a against Named(a)
  let second = verify b against Named(b)
    on unmet(u) => escalate human("Is it named?")
  effect note_all([first, second]) idempotent_by b.branch
  true
}

/// Notes one change that is named, or what a person answers for it.
workflow NoteOne(a: Change, b: Change) -> Bool
  caps   Notes
  budget { time: 1h }
{
  let first = verify a against Named(a)
  let second = verify b against Named(b)
    on unmet(u) => escalate human("Is it named?")
  effect note_one(second) idempotent_by b.branch
  true
}
`;

/** A person's answer to the escalation the run waits on, signed by `who`. */
async function answer(w: World, runId: string, who: Person, value: Value): Promise<RunRow> {
  const shown = await w.rt.shown(runId, "wait");
  const s = signDecision(who.key, shown, { kind: "answer", member: who.member, payload: payloadOf.answer(value), at: new Date(w.adapters.clock.now()) });
  return w.rt.submitInput(runId, msg(), { value, signed: s });
}

/** The checks a drive of the run makes of a Verified value, as the run's own interpreter makes them, called alone. */
interface Checks {
  checkVerified(effect: string, v: Obj, irreversible?: boolean): Promise<void>;
  verifiedIn(t: Value, v: Value, at: string, out: Array<{ at: string; value: Value; contract: string | undefined }>, generic: Map<string, Value>, depth: number): void;
}
async function checksOf(w: World, runId: string): Promise<Checks> {
  const rt = w.rt as unknown as { loaded(hash: string, run: RunRow): Promise<unknown>; interpreter(run: RunRow, loaded: unknown, fence: number, replay: boolean, adapters: unknown, startedAt: number, earlier: unknown[]): Checks };
  const run = await w.rt.getRun(runId);
  return rt.interpreter(run, await rt.loaded(run.package_hash, run), run.fence, false, w.adapters, await w.rt.journal.startedAt(runId), []);
}

/** What `make` throws, as a violation's code and message. */
async function violationOf(make: () => Promise<unknown>): Promise<{ code: string; message: string } | undefined> {
  try {
    await make();
    return undefined;
  } catch (e) {
    return { code: (e as { code?: string }).code ?? "none", message: (e as Error).message };
  }
}

const PAIR = `mandate @ 0.6

module test.pair @ 0.1

use std.{fs}

type Item = { key: Text, n: Int }

capability Notes = fs.read("/work/notes")

/// An item is not negative, is under the limit, is within ten of it, and has a key.
contract Pair(x: Item, limit: Int) {
  require x.n >= 0
  accept small "It is under the limit"
    by static x.n < limit
  accept wide "It is within ten of the limit"
    by static x.n > limit - 10
  accept named "It has a key"
    by static len(x.key) >= 1
}

/// Verifies an item once and another twice, against two limits, and goes on whatever they meet.
workflow Probe(a: Item, b: Item) -> Bool
  caps   Notes
  budget { time: 1h }
{
  let one = verify a against Pair(a, 3) on unmet(u) => false
  let two = verify b against Pair(b, 3) on unmet(u) => false
  let three = verify b against Pair(b, 20) on unmet(u) => false
  true
}
`;

needs06("a value that rests on a waiver, or on a person's answer", () => {
  it("a person's answer that holds the runtime's own members is refused by name, and the wait stays open (1a)", async () => {
    const who = people();
    const tool = new SimTool("tag_release");
    const w = await world(UNDONE, { tools: [tool], lock: { modules: {}, members: who.members, roles: { owner: ["ana"], reviewer: ["ben"] } }, decisions: { keys: who.keys } });
    const risky = { branch: "b1", risk: 5 };
    let r = await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { changes: [risky], c: { branch: "", risk: 0 } }, runId: "u1" });
    r = await decide(w, "u1", who.ana, { waive: [0], decline: [] });
    expect(r.waiting).toMatchObject({ kind: "input" });
    const [waiver] = await w.db.query<{ evidence_id: string }>("select evidence_id from evidence where run_id = 'u1' and method = 'waiver'");
    // As the waived value, wrapped as the review gave it; and nested, deep in a value of the person's own.
    const waived = { $verified: risky, $contract: "Small", $evidence: [waiver!.evidence_id] };
    for (const value of [waived as unknown as Value, { note: [{ deep: { $evidence: ["x"] } }] }, { $capability: "Tags" }]) {
      await refusedAs(w, "u1", () => answer(w, "u1", who.ana, value), "invalid_decision", "reserved_value");
    }
    expect(tool.prepares).toEqual([]);
    // A run is never started with one either.
    expect(await violationOf(() => w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { changes: [waived as unknown as Value], c: risky }, runId: "u1b" }))).toMatchObject({ code: "reserved_value" });
    expect(await w.db.query("select 1 from runs where run_id = 'u1b'")).toEqual([]);
  });

  it("a waived value never reaches an effect that cannot be undone, at run time too (E1505): waived_irreversible", async () => {
    const who = people();
    const w = await world(UNDONE, { tools: [new SimTool("tag_release")], lock: { modules: {}, members: who.members, roles: { owner: ["ana"], reviewer: ["ben"] } }, decisions: { keys: who.keys } });
    const risky = { branch: "b1", risk: 5 };
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { changes: [risky], c: { branch: "", risk: 0 } }, runId: "u2" });
    await decide(w, "u2", who.ana, { waive: [0], decline: [] });
    // The value as the review accepted it: its verify's record and the waiver.
    const rows = await w.db.query<{ evidence_id: string }>("select evidence_id from evidence where run_id = 'u2' and contract = 'Small' and (method = 'waiver' or method = 'verify')");
    const waived = { $verified: risky, $contract: "Small", $evidence: rows.map((r) => r.evidence_id).sort() };
    const checks = await checksOf(w, "u2");
    expect(await violationOf(() => checks.checkVerified("tag_release", waived, true))).toMatchObject({ code: "waived_irreversible" });
    // It holds at an effect that can be undone: the waiver is the review's, for this very value.
    expect(await violationOf(() => checks.checkVerified("note", waived, false))).toBeUndefined();
  });

  it("a value whose require failed is never accepted, whatever it arrives in; nor one without its verify's record (1c)", async () => {
    const w = await world(PAIR, { lock: { modules: {} }, decisions: { keys: new TrustedKeys() } });
    const a = { key: "a", n: -1 };
    const b = { key: "b", n: 5 };
    expect(state(await w.rt.startRun({ pkg: w.pkg, workflow: "Probe", input: { a, b }, runId: "p1" }))).toBe("succeeded null");
    const rows = await w.rt.evidence("p1");
    const of = (value: Value) => rows.filter((r) => isObj(r.subject) && r.subject["value"] === digest("request", value));
    // Every criterion of a's verify passed, and its require did not.
    const forA = of(a);
    expect(forA.map((r) => [r.criterion, r.passed]).sort()).toEqual([["*", false], ["named", true], ["small", true], ["wide", true]]);
    expect((forA.find((r) => r.criterion === "*")!.detail as Obj)).toMatchObject({ requires: [false], unmet: ["require/0"] });
    const checks = await checksOf(w, "p1");
    const whole = forA.map((r) => r.evidence_id).sort();
    expect((await violationOf(() => checks.checkVerified("post", { $verified: a, $contract: "Pair", $evidence: whole })))?.message).toMatch(/Pair was not met by it: require\/0 failed/);
    const criteria = forA.filter((r) => r.criterion !== "*").map((r) => r.evidence_id).sort();
    expect((await violationOf(() => checks.checkVerified("post", { $verified: a, $contract: "Pair", $evidence: criteria })))?.message).toMatch(/it rests on no verify of Pair/);
  });

  it("records of two verifies of one value, against other arguments, are not one verify's (1b)", async () => {
    const w = await world(PAIR, { lock: { modules: {} }, decisions: { keys: new TrustedKeys() } });
    const b = { key: "b", n: 5 };
    await w.rt.startRun({ pkg: w.pkg, workflow: "Probe", input: { a: { key: "a", n: 1 }, b }, runId: "p2" });
    const forB = (await w.rt.evidence("p2")).filter((r) => isObj(r.subject) && r.subject["value"] === digest("request", b));
    const wholes = forB.filter((r) => r.criterion === "*");
    // Against 3, b fails small; against 20, it fails wide: neither verify met everything.
    expect(wholes.map((r) => (r.detail as Obj)["unmet"]).sort()).toEqual([["small"], ["wide"]]);
    const [three, twenty] = [wholes.find((r) => ((r.detail as Obj)["unmet"] as string[])[0] === "small")!, wholes.find((r) => ((r.detail as Obj)["unmet"] as string[])[0] === "wide")!];
    const ownOf = (v: (typeof forB)[number]) => new Set((v.detail as Obj)["evidence"] as string[]);
    // Each criterion's passing record, from whichever verify passed it, under the first verify's own record.
    const small = forB.find((r) => r.criterion === "small" && r.passed && ownOf(twenty).has(r.evidence_id))!;
    const wide = forB.find((r) => r.criterion === "wide" && r.passed && ownOf(three).has(r.evidence_id))!;
    const named = forB.find((r) => r.criterion === "named" && ownOf(three).has(r.evidence_id))!;
    expect(isObj(small.subject) && isObj(wide.subject) && small.subject["contract_args"] !== wide.subject["contract_args"]).toBe(true);
    const checks = await checksOf(w, "p2");
    const message = (await violationOf(() => checks.checkVerified("post", { $verified: b, $contract: "Pair", $evidence: [three.evidence_id, small.evidence_id, wide.evidence_id, named.evidence_id].sort() })))?.message;
    expect(message).toMatch(new RegExp(`${small.evidence_id} is not a record of the verify it rests on`));
    expect(message).toMatch(new RegExp(`${small.evidence_id} is evidence of another verify than the one it rests on`));
    expect(message).toMatch(/Pair\.small was not met, and no waiver covers it/);
  });

  it("holds the place of any other type with arguments that say Verified, and reads a Result's either side (2)", async () => {
    const who = people();
    const w = await world(NESTED, { tools: [new SimTool("note_all"), new SimTool("note_one")], lock: { modules: {}, members: who.members, roles: {} }, decisions: { keys: who.keys } });
    await w.rt.startRun({ pkg: w.pkg, workflow: "NoteAll", input: { a: { branch: "b1", risk: 0 }, b: { branch: "", risk: 0 } }, runId: "r2" });
    const checks = await checksOf(w, "r2");
    const verifiedChange = { ref: "Verified", args: [{ ref: "Change" }, { ref: "Named" }] };
    const places = (t: Value, v: Value) => {
      const out: Array<{ at: string; value: Value; contract: string | undefined }> = [];
      checks.verifiedIn(t, v, "", out, new Map(), 0);
      return out.map((o) => [o.at, o.contract ?? null, o.value]);
    };
    const result = { ref: "Result", args: [verifiedChange, { ref: "Text" }] };
    expect(places(result, { $tag: "Ok", $args: ["yes"] })).toEqual([["/$args/0", "Named", "yes"]]);
    expect(places({ ref: "Result", args: [{ ref: "Text" }, verifiedChange] }, { $tag: "Err", $args: ["no"] })).toEqual([["/$args/0", "Named", "no"]]);
    expect(places(result, { $tag: "Err", $args: ["no"] })).toEqual([]);
    // A type this runtime does not read whose arguments say Verified is held as a Verified place itself.
    for (const ref of ["Receipt", "Declined", "DecisionOutcome", "Later"]) expect(places({ ref, args: [verifiedChange] }, { anything: 1 }), ref).toEqual([["", null, { anything: 1 }]]);
    expect(places({ ref: "Receipt", args: [{ ref: "Text" }] }, { anything: 1 })).toEqual([]);
  });

  it("reads what a waiver is held to once for a drive, however many waived items it posts; a waiver's detail is small (6)", async () => {
    const w = await rworld();
    await start(w, "m1");
    const journal = w.rt.journal;
    const decisions = journal.decisions.bind(journal);
    let reads = 0;
    journal.decisions = async (...a: Parameters<typeof decisions>) => {
      reads++;
      return decisions(...a);
    };
    const done = await decide(w, "m1", w.who.ana, { waive: [1, 4], decline: [] });
    expect(state(done)).toBe("succeeded null");
    expect(posted(w.tool)).toEqual(["I0", "I1", "I4"]);
    expect(reads).toBe(1);
    const details = await w.db.query<{ detail: Obj }>("select detail from evidence where run_id = 'm1' and method = 'waiver'");
    for (const d of details) expect(Object.keys(d.detail).sort()).toEqual(["index", "review", "waives"]);
  });

  it("a number or text the journal cannot keep exactly is refused with a reason of its own, in an answer and in a run's input (r3.2)", async () => {
    const who = people();
    const w = await world(UNDONE, { tools: [new SimTool("tag_release")], lock: { modules: {}, members: who.members, roles: { owner: ["ana"], reviewer: ["ben"] } }, decisions: { keys: who.keys } });
    // A 19-digit id, read already rounded: the run is not started, and says why.
    const refused = await violationOf(() => w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { changes: [], c: { branch: "b", risk: 1234567890123456789 } }, runId: "k0" }));
    expect(refused).toMatchObject({ code: "unkeepable_value" });
    expect(refused!.message).toMatch(/the number 1234567890123456800, a whole number past 2\^53, which cannot be kept exactly .*give it as text/);
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { changes: [{ branch: "b1", risk: 5 }], c: { branch: "", risk: 0 } }, runId: "k1" });
    await decide(w, "k1", who.ana, { waive: [0], decline: [] });
    for (const value of [-0, { n: 2 ** 60 }, ["ok", Number.NaN]] as Value[]) {
      const message = await refusedAs(w, "k1", () => answer(w, "k1", who.ana, value), "invalid_decision", "unkeepable_value");
      expect(message).not.toContain("member of the runtime's own values");
    }
    // A reserved member is named as such, whatever else the answer holds.
    expect(await refusedAs(w, "k1", () => answer(w, "k1", who.ana, { $evidence: [], n: -0 }), "invalid_decision", "reserved_value")).toContain("It holds $evidence");
    // The members held reserved are the ones a server's answer may not hold either (connectors.ts forbidden).
    for (const k of RESERVED_MEMBERS) expect(forbidden({ [k]: 1 } as Value), k).toBe(true);
    for (const k of ["$tag", "$args", "$money", "$currency"]) expect(givenValueProblem({ [k]: 1 } as Value), k).toBeUndefined();
  });

  it("a verify's own record, as every record, is this run's, under its package and of its mode (r3.3)", async () => {
    const who = people();
    const w = await world(NESTED, { tools: [new SimTool("note_all"), new SimTool("note_one")], lock: { modules: {}, members: who.members, roles: {} }, decisions: { keys: who.keys } });
    const a = { branch: "b1", risk: 0 };
    await w.rt.startRun({ pkg: w.pkg, workflow: "NoteAll", input: { a, b: { branch: "", risk: 0 } }, runId: "k3" });
    const rows = await w.db.query<{ evidence_id: string; method: string; record: Obj }>("select evidence_id, method, record from evidence where run_id = 'k3' and (passed or method = 'verify') and subject->>'value' = $1", [digest("request", a)]);
    const ids = rows.map((r) => r.evidence_id).sort();
    const whole = rows.find((r) => r.method === "verify")!;
    const checks = await checksOf(w, "k3");
    const wrapper = { $verified: a, $contract: "Named", $evidence: ids };
    expect(await violationOf(() => checks.checkVerified("note_all", wrapper))).toBeUndefined();
    for (const [change, why] of [
      [{ run: "another run" }, /is a record of another run/],
      [{ package: `sha256:${"0".repeat(64)}` }, /is a record of another package than this run's/],
      [{ mode: "design" }, /is a record of a design run, and this run is live/],
    ] as const) {
      const record = { ...whole.record, ...change } as unknown as EvidenceRecord;
      const sig = w.rt.signer.sign(record);
      await w.db.query("update evidence set record = $2, signature = $3 where evidence_id = $1", [whole.evidence_id, JSON.stringify(record), sig.signature]);
      expect((await violationOf(() => checks.checkVerified("note_all", wrapper)))?.message).toMatch(why);
    }
  });

  it("a tick of a review within its deadline asks nothing of the host; one with something to do asks first (r3.4)", async () => {
    const who = people();
    let fit = true;
    let asked = 0;
    const hostProbe = { read: async () => (asked++, fit ? { output: "99.0.0" } : { output: "1.0.0" }) } as never;
    const tool = new SimTool("post_draft");
    const agents = new SimAgents().on("Matcher.match", (req) => {
      const m = MATCHES[String((req.args[0] as Obj)["invoice_no"])];
      return m === "fail" || m === undefined ? { error: { tag: "SkillFailed", args: ["no_match"] }, cost: { steps: 1 } } : { ok: m, cost: { steps: 1 } };
    });
    const w = await world(PROGRAM, { agents, tools: [tool], lock: { modules: {}, members: who.members, roles: who.roles, host: { node: "22.0.0" } } as Lock, decisions: { keys: who.keys }, hostProbe });
    const r = await start(w, "k4");
    expect(r.state).toBe("waiting");
    // The host is unfit now: a tick within the deadline leaves the run as it was, reads nothing of the host, throws nothing.
    fit = false;
    const before = asked;
    w.clock.advance(DAY - 1);
    expect((await w.rt.tick("k4")).revision).toBe(r.revision);
    expect(asked).toBe(before);
    // At the deadline there is something to do, and the host is asked first: an unfit one escalates nothing.
    w.clock.advance(1);
    expect(await violationOf(() => w.rt.tick("k4"))).toMatchObject({ code: "unfit_host" });
    expect(asked).toBeGreaterThan(before);
    expect(await events(w, "k4", "review_escalated")).toEqual([]);
  });

  it("a criterion whose check would write a record of the runtime's own methods is refused at load (r3.5)", async () => {
    const w = await world(PAIR, { lock: { modules: {} }, decisions: { keys: new TrustedKeys() } });
    for (const method of ["waiver", "verify"]) {
      const program = structuredClone(w.pkg.program) as unknown as { defs: Record<string, { accept: Record<string, { by: unknown }> }> };
      program.defs["Pair"]!.accept["small"]!.by = { call: { op: "call", callee: { op: "var", name: method }, args: [] } };
      expect(reservedMethods(program as never)).toEqual(["Pair.small"]);
      expect(await violationOf(async () => verifyPackage(buildPackage(program as never, w.pkg.lock)))).toMatchObject({ code: "reserved_method", message: expect.stringContaining("Pair.small would write evidence of a method the runtime keeps") });
    }
    expect(reservedMethods(w.pkg.program)).toEqual([]);
  });

  it("a BigInt in a decision's lists is a recorded refusal, never a failure of the digest (r3, BigInt)", async () => {
    const w = await rworld();
    await start(w, "k5");
    const s = await signed(w, "k5", w.who.ana, { waive: [], decline: [] });
    await refusedAs(w, "k5", () => w.rt.decideReview("k5", msg(), { signed: s, waive: [1n, 4], decline: [] } as never), "incomplete_review", "incomplete_review");
  });

  it("a decision whose lists are not lists is refused after who signed it, and recorded, like every refusal (7)", async () => {
    const w = await rworld();
    await start(w, "m2");
    const none = { waive: [] as number[], decline: [] as number[] };
    const s = await signed(w, "m2", w.who.ana, none);
    await refusedAs(w, "m2", () => w.rt.decideReview("m2", msg(), { signed: s, waive: "1,4", decline: [] } as never), "incomplete_review", "incomplete_review");
    await refusedAs(w, "m2", () => w.rt.decideReview("m2", msg(), { signed: undefined, waive: 1, decline: null } as never), "invalid_decision", "invalid_signature");
    await refusedAs(w, "m2", () => w.rt.decideReview("m2", msg(), { signed: { record: null, signature: 7 }, waive: [1, 4], decline: [] } as never), "invalid_decision", "invalid_signature");
  });

  it("an answer nested in a list is no Verified value: refused at the effect, where 0.5 never looked (unverified_parameter)", async () => {
    const who = people();
    const all = new SimTool("note_all");
    const one = new SimTool("note_one");
    const w = await world(NESTED, { tools: [all, one], lock: { modules: {}, members: who.members, roles: {} }, decisions: { keys: who.keys } });
    const input = { a: { branch: "b1", risk: 0 }, b: { branch: "", risk: 0 } };
    for (const [runId, workflow, at] of [
      ["n1", "NoteAll", { at: "/1" }],
      ["n2", "NoteOne", {}],
    ] as const) {
      const r = await w.rt.startRun({ pkg: w.pkg, workflow, input, runId });
      expect(r.waiting).toMatchObject({ kind: "input" });
      const done = await answer(w, runId, who.ana, "yes, it is named");
      expect(done.state, state(done)).toBe("failed");
      expect(done.error).toEqual({ $tag: "PolicyDenied", $args: [{ effect: workflow === "NoteAll" ? "note_all" : "note_one", parameter: 0, reason: "unverified_parameter", ...at }] });
    }
    expect([all.prepares, one.prepares]).toEqual([[], []]);
  });

  it("evidence names the value it was given for (B25): another value carrying it is not accepted", async () => {
    const who = people();
    const w = await world(NESTED, { tools: [new SimTool("note_all"), new SimTool("note_one")], lock: { modules: {}, members: who.members, roles: {} }, decisions: { keys: who.keys } });
    const a = { branch: "b1", risk: 0 };
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "NoteAll", input: { a, b: { branch: "", risk: 0 } }, runId: "n3" });
    expect(r.waiting).toMatchObject({ kind: "input" });
    const passed = await w.db.query<{ evidence_id: string; subject: Obj }>("select evidence_id, subject from evidence where run_id = 'n3' and (passed or method = 'verify') and subject->>'value' = $1", [digest("request", a)]);
    expect(passed.length).toBe(2);
    const ids = passed.map((p) => p.evidence_id).sort();
    const checks = await checksOf(w, "n3");
    // A Verified value of another change, carrying the evidence of the one that passed.
    expect((await violationOf(() => checks.checkVerified("note_all", { $verified: { branch: "forged", risk: 0 }, $contract: "Named", $evidence: ids })))?.message).toContain("is evidence for another value than the one note_all is given");
    // The very value it was given for is accepted.
    expect(await violationOf(() => checks.checkVerified("note_all", { $verified: a, $contract: "Named", $evidence: ids }))).toBeUndefined();
  });
});

// ── crash, resume and replay ────────────────────────────────────────────

needs06("a review across crashes, resumes and a replay", () => {
  it("while it waits: a resumed run asks the same question with the same deadline, once", async () => {
    const w = await rworld();
    const r = await start(w, "c1");
    w.clock.advance(1000);
    const again = await w.rt.resume("c1");
    expect(again.state).toBe("waiting");
    expect(requestOf(again)).toEqual(requestOf(r));
    expect(await events(w, "c1", "review_requested")).toHaveLength(1);
    expect(await events(w, "c1", "wait_opened")).toHaveLength(1);
    expect(await w.rt.replayRun("c1")).toEqual({ status: "partial", stoppedAt: REVIEW_AT });
  });

  it("after the decision, before anything is posted: the resumed run posts each accepted item once", async () => {
    const w = await rworld();
    await start(w, "c2");
    w.faults.arm("after_dispatch", (i) => i.kind === "prepare");
    await expect(decide(w, "c2", w.who.ana, { waive: [1], decline: [4] })).rejects.toBeInstanceOf(Crash);
    const done = await w.rt.resume("c2");
    expect(state(done)).toBe("succeeded null");
    expect(posted(w.tool)).toEqual(["I0", "I1"]);
    expect(await events(w, "c2", "review_decided")).toHaveLength(1);
    expect(await events(w, "c2", "criterion_waived")).toHaveLength(1);
  });

  it("in the middle of the commit map after it: each draft is posted once, and a replay gives the same result", async () => {
    const w = await rworld();
    await start(w, "c3");
    w.faults.arm("after_execute", (i) => i.kind === "effect");
    await expect(decide(w, "c3", w.who.ana, { waive: [1, 4], decline: [] })).rejects.toBeInstanceOf(Crash);
    expect(w.tool.applied.size).toBe(1);
    const done = await w.rt.resume("c3");
    expect(state(done)).toBe("succeeded null");
    expect(w.tool.applied.size).toBe(3);
    expect(new Set(w.tool.executions.map((e) => e.operationKey)).size).toBe(3);
    expect(await w.rt.replayRun("c3")).toEqual({ status: "complete", value: done.result });
  });
});

// ── the acceptance program ──────────────────────────────────────────────

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function fixtureLibrary(dir: string): LibrarySource {
  const manifest = read(`fixtures/library/${dir}/mandate.library.json`);
  const files = Object.fromEntries((JSON.parse(manifest).modules as string[]).map((f) => [f, read(`fixtures/library/${dir}/${f}`)]));
  return { manifest, files };
}

needs06("the acceptance program (invoices.mdt)", () => {
  it("loads, starts in design mode, reaches its review wait, and once decided posts each accepted match as a simulated draft", async () => {
    const who = people();
    const { lock: _format, ...fixture } = JSON.parse(read("fixtures/library/invoices.lock.json")) as Lock & { lock?: string };
    const lock = { ...fixture, members: { ana: { keys: [who.ana.key.keyId] }, ben: { keys: [who.ben.key.keyId] } }, roles: { accountant: ["ana"], finance_lead: ["ben"] } } as Lock;
    const connectors = fixtureLibrary("acme.connectors");
    const order = (vendor: string, total: number): Obj => ({ order_no: `PO-${vendor}`, vendor_id: vendor, total_cents: total });
    const invoices = [
      { invoice_no: "A", vendor_id: "V1", total_cents: 1000 },
      { invoice_no: "B", vendor_id: "V1", total_cents: 1100 },
      { invoice_no: "C", vendor_id: "V2", total_cents: 1000 },
    ];
    const agents = new SimAgents().on("Matcher.match", (req) => {
      const i = req.args[0] as Obj;
      // A matches; B's order is 10% off; C's order is of another vendor.
      const o = i["invoice_no"] === "A" ? order("V1", 1000) : i["invoice_no"] === "B" ? order("V1", 1000) : order("V9", 1000);
      return { ok: { invoice_no: i["invoice_no"]!, order: o }, cost: { steps: 1 } };
    });
    const w = await world(read("fixtures/library/invoices.mdt"), { agents, libraries: [connectors], lock, decisions: { keys: who.keys } });
    w.adapters.samples = { tool: (name: string) => (name === "acme.connectors.mailbox.list_invoices" ? { result: invoices } : undefined) } as never;
    expect(NOT_RUN_YET_06.map((r) => r.name)).toEqual(["shapes"]);
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "MatchInvoices", input: {}, runId: "acc1", mode: "design" });
    expect(r.state, state(r)).toBe("waiting");
    expect(r.waiting).toMatchObject({ kind: "review" });
    const q = questionOf(r);
    expect(q).toMatchObject({ contract: "Matched", role: "accountant", escalate_to: "finance_lead", deadline_ms: DAY, accepted: [0], declined: [{ index: 2, unmet: ["vendor"] }], failed: [] });
    expect((q["items"] as Obj[]).map((i) => [i["index"], (i["unmet"] as Obj[]).map((u) => u["criterion"])])).toEqual([[1, ["totals"]]]);
    const done = await decide(w, "acc1", who.ana, { waive: [1], decline: [] });
    expect(state(done)).toBe("succeeded null");
    const result = done.result as Obj;
    expect((result["posted"] as Obj[]).map((p) => (p as Obj)["$tag"])).toEqual(["Ok", "Ok"]);
    expect(((result["posted"] as Obj[])[1]!["$args"] as Obj[])[0]).toMatchObject({ simulated: true, effect: "erp.post_draft_invoice" });
    expect((result["declined"] as Obj[]).map((d) => [d["index"], d["by"]])).toEqual([[2, null]]);
    expect(result["failed"]).toEqual([]);
    expect(await w.rt.replayRun("acc1")).toEqual({ status: "complete", value: done.result });
  });
});

// ── the shapes of the journal ───────────────────────────────────────────

describe("the journal's shapes for a review", () => {
  it("names the review's wait among the kinds that wait for a person, and its events among the decisions", () => {
    expect(WAIT_KINDS.has("review")).toBe(true);
    expect([stepClass("review"), commandClass("review"), stepClass("verdict"), commandClass("verdict")]).toEqual(["S0", "S0", "S2", "S3"]);
    for (const e of ["review_requested", "review_decided", "review_escalated", "review_expired", "criterion_waived"]) expect(EVENT_CLASSES[e], e).toBe("S0");
  });
});
