// Signed decisions (0.4; spec/envelope.md "Signed decisions", cases H01, H02
// and H04, INV-16). A person's decision is a record they sign with a key the
// package's lock lists under their name. A record that is not that is not a
// decision: it is refused, `decision_refused` is the one thing recorded, and
// the wait stays open. Each rule is shown by one decision that breaks it.

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  approvalProblem,
  DECISION_FORMAT,
  decisionId,
  decisionKeysIn,
  InvalidDecision,
  isSignedDecision,
  keyFileName,
  memberOf,
  newDecisionKey,
  payloadOf,
  privateKeyProblem,
  readDecisionKey,
  signDecision,
  type DecisionKind,
  type Shown,
  type SignedDecision,
} from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys, type EvidenceRecord } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { Runtime, type Lock } from "../src/runtime.js";
import { SimAgents, SimTool, SimVerifier } from "../src/sim.js";
import { isObj, type Value } from "../src/values.js";
import { BUG, FIXBUG, fixbugAgents, USD, waitOf } from "./fixbug.js";
import { closeAll, LOCK, UNSIGNED, world, type World } from "./helpers.js";
import { FOLLOW, ISSUE } from "./programs.js";

afterAll(closeAll);

// ── the people ──────────────────────────────────────────────────────────

interface Person {
  member: string;
  key: EvidenceSigner;
}

/**
 * Alice owns the code and also reviews, and holds two keys. Bob reviews.
 * Carol is a member with no role. Mallory has a key the runtime knows and
 * the lock lists under nobody; nobody has heard of the stranger's key.
 */
function people() {
  const key = () => EvidenceSigner.generate();
  const alice = { member: "alice", key: key() };
  const aliceOther = { member: "alice", key: key() };
  const bob = { member: "bob", key: key() };
  const carol = { member: "carol", key: key() };
  const mallory = { member: "mallory", key: key() };
  const stranger = { member: "alice", key: key() };
  const members = { alice: { keys: [alice.key.keyId, aliceOther.key.keyId] }, bob: { keys: [bob.key.keyId] }, carol: { keys: [carol.key.keyId] } };
  const roles = { code_owner: ["alice"], reviewer: ["alice", "bob"] };
  const keys = new TrustedKeys([alice, aliceOther, bob, carol, mallory].map((p) => p.key.publicKey));
  return { alice, aliceOther, bob, carol, mallory, stranger, members, roles, keys };
}

type People = ReturnType<typeof people>;

/** Two approvals that must come from two people, then a question for a reviewer. */
const PEOPLE = `mandate @ 0.4

module test.people @ 0.1

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
  let d = delegate A.s(x)
  let v = verify d against Ready(d)
  let go = human.ask("Go on?", role: reviewer)
  "done"
}
`;

interface Signed extends World {
  who: People;
}

/** The 0.4 program on a runtime that takes signed decisions, started and waiting for the code owner. */
async function started(runId: string): Promise<Signed & { run: RunRow }> {
  const who = people();
  const agents = new SimAgents().on("A.s", () => ({ ok: { text: "a draft" }, cost: { steps: 1 } }));
  const w = await world(PEOPLE, { agents, lock: { modules: {}, members: who.members, roles: who.roles }, decisions: { keys: who.keys } });
  const run = await w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { x: "the task" }, runId });
  expect(run.state).toBe("waiting");
  return { ...w, who, run };
}

let n = 0;
const msg = (sender = "cli") => ({ sender, messageId: `m${++n}` });

/** `who`'s signed record of a decision on what the run shows now; `change` makes it say something else first. */
async function sign(w: World, runId: string, who: Person, kind: DecisionKind, o: { payload?: string; change?: (s: Shown) => Shown; about?: "wait" | "run" | { reconcile: string } } = {}): Promise<SignedDecision> {
  const shown = await w.rt.shown(runId, o.about ?? "wait");
  return signDecision(who.key, o.change ? o.change(shown) : shown, { kind, member: who.member, ...(o.payload !== undefined ? { payload: o.payload } : {}), at: new Date(w.adapters.clock.now()) });
}

/** Everything a refused decision must leave as it was. */
async function state(w: World, runId: string) {
  const run = await w.rt.getRun(runId);
  const count = async (sql: string) => Number((await w.db.query<{ n: number }>(sql, [runId]))[0]!.n);
  return {
    state: run.state,
    revision: run.revision,
    waiting: run.waiting,
    decisions: await count("select count(*) as n from decisions where run_id = $1"),
    inbox: Number((await w.db.query<{ n: number }>("select count(*) as n from inbox"))[0]!.n),
    waits: await w.db.query("select command_id, state from commands where run_id = $1 and kind in ('input', 'decision') order by command_id", [runId]),
    events: (await w.rt.journal.events(runId)).filter((e) => e.type !== "decision_refused").length,
  };
}

async function refusals(w: World, runId: string): Promise<Value[]> {
  return (await w.rt.journal.events(runId)).filter((e) => e.type === "decision_refused").map((e) => e.data);
}

/** The run refuses `attempt` for `reason`, records only that, and is otherwise exactly as it was. */
async function refused(w: World, runId: string, attempt: () => Promise<unknown>, reason: string, who?: { member: string | null; key: string | null }): Promise<void> {
  const before = await state(w, runId);
  const seen = (await refusals(w, runId)).length;
  const e = await attempt().then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(InvalidDecision);
  expect(e).toMatchObject({ reason, code: reason === "stale_revision" ? "stale_revision" : "invalid_decision" });
  expect(await state(w, runId)).toEqual(before);
  const after = await refusals(w, runId);
  expect(after).toHaveLength(seen + 1);
  expect(after.at(-1)).toMatchObject({ reason, ...(who ? who : {}) });
}

// ── the record ──────────────────────────────────────────────────────────

/** JCS for a decision record, written here so the check below uses nothing of Mandate's: strings and one integer, keys sorted. */
function jcs(record: Record<string, string | number>): string {
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(record[k])}`)
    .join(",")}}`;
}

/** What an auditor does with a record, its signature and a public key: node:crypto and nothing else. */
function auditorAccepts(signed: { record: Record<string, string | number>; signature: string }, publicKeyPem: string): { ok: boolean; digest: string } {
  const bytes = Buffer.from(`mandate/decision/0.1\n${jcs(signed.record)}`, "utf8");
  const key = createPublicKey(publicKeyPem);
  const keyId = `sha256:${createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex")}`;
  const ok = signed.record["key"] === keyId && signed.signature.startsWith("ed25519:") && verifySignature(null, bytes, key, Buffer.from(signed.signature.slice("ed25519:".length), "base64"));
  return { ok, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

describe("a decision record", () => {
  const key = EvidenceSigner.generate();
  const shown: Shown = { package: "sha256:aa", run: "run_1", revision: 41, command: "/defs/W/body/1/value", subject: "sha256:bb", role: "code_owner" };

  it("names the package, the run and its revision, the wait, the subject, the role, the member and the key", () => {
    const d = signDecision(key, shown, { kind: "approve", member: "alice", at: "2026-11-10T14:02:11Z" });
    expect(d.record).toEqual({ format: "mandate/decision/0.1", kind: "approve", package: "sha256:aa", run: "run_1", revision: 41, command: "/defs/W/body/1/value", subject: "sha256:bb", role: "code_owner", member: "alice", key: key.keyId, at: "2026-11-10T14:02:11Z" });
    expect(d.signature).toMatch(/^ed25519:/);
    expect(isSignedDecision(d)).toBe(true);
    // A date is written in UTC to the second.
    expect(signDecision(key, shown, { kind: "approve", member: "alice", at: new Date("2026-11-10T14:02:11.250Z") }).record.at).toBe("2026-11-10T14:02:11Z");
    // No role and no command when the run shows none; a payload when something comes with the decision.
    const raise = signDecision(key, { package: "sha256:aa", run: "run_1", revision: 41, subject: "sha256:aa" }, { kind: "raise_limits", member: "alice", payload: "sha256:cc", at: "2026-11-10T14:02:11Z" });
    expect(Object.keys(raise.record).sort()).toEqual(["at", "format", "key", "kind", "member", "package", "payload", "revision", "run", "subject"]);
  });

  it("is signed over the format, a newline and the record's JCS bytes, and its digest is the SHA-256 of the same bytes", () => {
    const d = signDecision(key, shown, { kind: "approve", member: "alice", at: "2026-11-10T14:02:11Z" });
    const audit = auditorAccepts(d as never, key.publicKeyPem());
    expect(audit.ok).toBe(true);
    expect(audit.digest).toBe(decisionId(d.record));
    // One changed field, and neither holds.
    const changed = { record: { ...d.record, kind: "decline" as const }, signature: d.signature };
    expect(auditorAccepts(changed as never, key.publicKeyPem()).ok).toBe(false);
    expect(decisionId(changed.record)).not.toBe(decisionId(d.record));
    // Another key's public half does not accept it either.
    expect(auditorAccepts(d as never, EvidenceSigner.generate().publicKeyPem()).ok).toBe(false);
  });

  it("is a record of the format and nothing else", () => {
    const d = signDecision(key, shown, { kind: "approve", member: "alice", at: "2026-11-10T14:02:11Z" });
    const bad = (change: (r: Record<string, unknown>) => void): boolean => {
      const record = { ...d.record } as Record<string, unknown>;
      change(record);
      return isSignedDecision({ record, signature: d.signature });
    };
    expect(bad((r) => (r["format"] = "mandate/decision/0.2"))).toBe(false);
    expect(bad((r) => (r["kind"] = "permit"))).toBe(false);
    expect(bad((r) => delete r["member"])).toBe(false);
    expect(bad((r) => delete r["subject"])).toBe(false);
    expect(bad((r) => (r["revision"] = "41"))).toBe(false);
    expect(bad((r) => (r["note"] = "also approve the next one"))).toBe(false);
    expect(isSignedDecision({ ...d, extra: 1 })).toBe(false);
    expect(isSignedDecision({ record: d.record })).toBe(false);
    expect(isSignedDecision(null)).toBe(false);
  });

  it("names its member by the lock: one key belongs to one member", () => {
    const lock: Lock = { modules: {}, members: { bob: { keys: ["sha256:01"] }, alice: { keys: ["sha256:02", key.keyId] } } };
    expect(memberOf(lock, key.keyId)).toBe("alice");
    expect(memberOf(lock, "sha256:03")).toBeUndefined();
    expect(memberOf({ modules: {} }, key.keyId)).toBeUndefined();
  });
});

describe("the members' keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-decision-keys-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("are the <key id>.pem files of a directory; a file that is not the key its name says is refused", () => {
    const [a, b] = [EvidenceSigner.generate(), EvidenceSigner.generate()];
    const keys = join(dir, "keys");
    expect(decisionKeysIn(keys).ids()).toEqual([]);
    const at = mkdtempSync(join(dir, "k-"));
    writeFileSync(join(at, keyFileName(a.keyId)), a.publicKeyPem());
    writeFileSync(join(at, "notes.txt"), "not a key");
    expect(decisionKeysIn(at).ids()).toEqual([a.keyId]);
    // Bob's key under Alice's name would let Bob sign as whoever the lock says Alice's key is.
    const swapped = mkdtempSync(join(dir, "k-"));
    writeFileSync(join(swapped, keyFileName(a.keyId)), b.publicKeyPem());
    expect(() => decisionKeysIn(swapped)).toThrow(/bad_decision_key.*not the key its name says/);
    const junk = mkdtempSync(join(dir, "k-"));
    writeFileSync(join(junk, keyFileName(a.keyId)), "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----\n");
    expect(() => decisionKeysIn(junk)).toThrow(/bad_decision_key/);
  });

  it("are created once: a key file is never replaced, and is read back as the same key", () => {
    const file = join(dir, "alice.key");
    const key = newDecisionKey(file);
    expect(readFileSync(file, "utf8")).toContain("PRIVATE KEY");
    expect(() => newDecisionKey(file)).toThrow(/key_exists/);
    expect(readDecisionKey(file).keyId).toBe(key.keyId);
    expect(() => readDecisionKey(join(dir, "nobody.key"))).toThrow(/no_key/);
    writeFileSync(join(dir, "junk.key"), "not a key", { mode: 0o600 });
    expect(() => readDecisionKey(join(dir, "junk.key"))).toThrow(/bad_decision_key/);
  });

  it.skipIf(process.platform === "win32")("are refused when others can read the private key file", () => {
    const file = join(dir, "open.key");
    newDecisionKey(file);
    expect(privateKeyProblem(file)).toBeUndefined();
    chmodSync(file, 0o644);
    expect(privateKeyProblem(file)).toContain("chmod 600");
    expect(() => readDecisionKey(file)).toThrow(/key_not_private/);
  });
});

// ── H01 ─────────────────────────────────────────────────────────────────

describe("H01: a decision with no valid signature, an unknown key, or a member outside the role is refused", () => {
  it("refuses each, records it as decision_refused, and leaves the wait open", async () => {
    const w = await started("h1");
    const { alice, bob, mallory, stranger } = w.who;
    const wait = waitOf(w.run.waiting);
    expect(wait.request).toMatchObject({ criterion: "approved", role: "code_owner" });
    const decide = (signed: SignedDecision, m = msg()) => w.rt.decideAction("h1", m, { signed });
    const named = { member: "alice", key: alice.key.keyId };

    // No signature at all: who decided is only the caller's word.
    const first = msg("alice");
    await refused(w, "h1", () => w.rt.decideAction("h1", first, { commandId: wait.command, revision: w.run.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "alice" }), "invalid_signature", { member: null, key: null });
    // Not a record.
    await refused(w, "h1", () => decide({ record: { kind: "approve", member: "alice" }, signature: "ed25519:AAAA" } as never), "invalid_signature");

    const good = await sign(w, "h1", alice, "decline");
    // The record was changed after it was signed.
    await refused(w, "h1", () => decide({ record: { ...good.record, kind: "approve" }, signature: good.signature }), "invalid_signature", named);
    // The signature is another key's.
    await refused(w, "h1", async () => decide({ record: good.record, signature: (await sign(w, "h1", mallory, "decline")).signature }), "invalid_signature", named);
    // A key the runtime holds no public half of.
    await refused(w, "h1", async () => decide(await sign(w, "h1", stranger, "approve")), "unknown_key", { member: "alice", key: stranger.key.keyId });
    // A key the lock lists under nobody, whatever member the record claims.
    await refused(w, "h1", async () => decide(await sign(w, "h1", { member: "alice", key: mallory.key }, "approve")), "unknown_key", { member: "alice", key: mallory.key.keyId });
    await refused(w, "h1", async () => decide(await sign(w, "h1", mallory, "approve")), "unknown_key", { member: "mallory", key: mallory.key.keyId });
    // Bob's key, in Alice's name.
    await refused(w, "h1", async () => decide(await sign(w, "h1", { member: "alice", key: bob.key }, "approve")), "unknown_key", { member: "alice", key: bob.key.keyId });
    // Bob is a member, and not a code owner.
    await refused(w, "h1", async () => decide(await sign(w, "h1", bob, "approve")), "not_in_role", { member: "bob", key: bob.key.keyId });
    // Alice is a code owner, but this record decides as a reviewer, or in no role.
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "approve", { change: (s) => ({ ...s, role: "reviewer" }) })), "not_in_role", named);
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "approve", { change: ({ role: _role, ...s }) => s })), "not_in_role", named);

    // The record is for something else than the run shows now.
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "approve", { change: (s) => ({ ...s, revision: s.revision - 1 }) })), "stale_revision", named);
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "approve", { change: (s) => ({ ...s, subject: "sha256:another" }) })), "subject_mismatch", named);
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "approve", { change: (s) => ({ ...s, command: `${s.command}/other` }) })), "subject_mismatch", named);
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "approve", { change: (s) => ({ ...s, run: "h1b" }) })), "subject_mismatch", named);
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "approve", { change: (s) => ({ ...s, package: "sha256:another" }) })), "subject_mismatch", named);
    // An answer is not a decision on an approval, and an approval carries nothing with it.
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "answer", { payload: payloadOf.answer("yes") })), "subject_mismatch", named);
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "approve", { payload: payloadOf.answer("and the next one too") })), "subject_mismatch", named);
    // A record of a kind that does not answer an approval is not a decline of it.
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "cancel")), "subject_mismatch", named);
    await refused(w, "h1", async () => decide(await sign(w, "h1", alice, "envelope")), "subject_mismatch", named);
    // An approval sent as an answer.
    await refused(w, "h1", async () => w.rt.submitInput("h1", msg(), { value: "yes", signed: await sign(w, "h1", alice, "approve") }), "subject_mismatch", named);

    // Nothing of all that was kept: the code owner's own decision, under the first message's id, is taken.
    expect((await w.rt.getRun("h1")).revision).toBe(w.run.revision);
    const approved = await decide(await sign(w, "h1", alice, "approve"), first);
    expect(approved.state).toBe("waiting");
    expect(waitOf(approved.waiting).request).toMatchObject({ role: "reviewer", distinct_from: "code_owner" });
  });

  it("takes any member for a wait that asks no role, and nobody else", async () => {
    // FixBug's budget handler asks "Continue or cancel?" of nobody in particular.
    const w = await fixbug({ signed: true });
    const { alice, carol, mallory } = w.who;
    const stopped = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "h1c", limits: { spend: { micros: 12 * USD, currency: "USD" } } });
    expect(waitOf(stopped.waiting).request).toEqual({ question: "Budget exceeded. Continue or cancel?" });
    const answer = (signed: SignedDecision, value = "cancel") => w.rt.submitInput("h1c", msg(), { value, signed });
    const payload = payloadOf.answer("cancel");
    await refused(w, "h1c", () => w.rt.submitInput("h1c", msg(), { commandId: waitOf(stopped.waiting).command, revision: stopped.revision, value: "cancel" }), "invalid_signature");
    await refused(w, "h1c", async () => answer(await sign(w, "h1c", mallory, "answer", { payload })), "unknown_key");
    // Deciding "as code owner" where no role is asked claims an authority the wait does not give.
    await refused(w, "h1c", async () => answer(await sign(w, "h1c", alice, "answer", { payload, change: (s) => ({ ...s, role: "code_owner" }) })), "not_in_role");
    // The signed payload is the answer's digest: another answer under the same signature is not what was signed.
    await refused(w, "h1c", async () => answer(await sign(w, "h1c", carol, "answer", { payload }), "continue"), "subject_mismatch");
    await refused(w, "h1c", async () => answer(await sign(w, "h1c", carol, "answer")), "subject_mismatch");
    // Carol holds no role, and is a member.
    const answered = await answer(await sign(w, "h1c", carol, "answer", { payload }));
    expect(answered.revision).toBeGreaterThan(stopped.revision);
    expect((await w.rt.journal.events("h1c")).find((e) => e.type === "input_received")!.data).toMatchObject({ member: "carol", role: null, key: carol.key.keyId, decision: expect.stringMatching(/^sha256:/) });
  });
});

// ── what an accepted decision leaves ────────────────────────────────────

describe("an accepted decision", () => {
  it("is stored with its signature, named by the events and the evidence, and verifies with node:crypto alone", async () => {
    const w = await started("ok1");
    const { alice, bob } = w.who;
    const first = await sign(w, "ok1", alice, "approve");
    const second = await w.rt.decideAction("ok1", msg("alice"), { signed: first });
    const asked = await w.rt.decideAction("ok1", msg("bob"), { signed: await sign(w, "ok1", bob, "approve") });
    expect(waitOf(asked.waiting).request).toEqual({ question: "Go on?", role: "reviewer" });
    const done = await w.rt.submitInput("ok1", msg("bob"), { value: "yes", signed: await sign(w, "ok1", bob, "answer", { payload: payloadOf.answer("yes") }) });
    expect(done.state).toBe("succeeded");
    expect(done.result).toBe("done");
    expect(second.revision).toBeGreaterThan(w.run.revision);

    // The store: each record as it was signed, under its digest.
    const stored = await w.rt.verifyDecisions("ok1");
    expect(stored.map((d) => [d.record.kind, d.record.member, d.record.role ?? null, d.valid])).toEqual([
      ["approve", "alice", "code_owner", true],
      ["approve", "bob", "reviewer", true],
      ["answer", "bob", "reviewer", true],
    ]);
    expect(stored[0]).toMatchObject({ decision_id: decisionId(first.record), record: first.record, signature: first.signature });

    // The events say who, in which role, with which key, and which record.
    const events = await w.rt.journal.events("ok1");
    const who = { by: "alice", member: "alice", role: "code_owner", key: alice.key.keyId, decision: decisionId(first.record) };
    expect(events.find((e) => e.type === "criterion_approved")!.data).toEqual({ command: first.record.command, ...who });
    expect(events.find((e) => e.type === "decision_received")!.data).toMatchObject({ command: first.record.command, sender: "alice", member: "alice", decision: decisionId(first.record) });
    expect(events.filter((e) => e.type === "decision_refused")).toEqual([]);

    // The evidence of each approval names the member, the role, the key and the decision record's digest.
    const evidence = (await w.rt.evidence("ok1")).map((e) => e.record as unknown as EvidenceRecord);
    expect(evidence.map((r) => r.producer)).toEqual([
      { kind: "person", via: "DecideAction", ...who },
      { kind: "person", via: "DecideAction", by: "bob", member: "bob", role: "reviewer", key: bob.key.keyId, decision: stored[1]!.decision_id },
    ]);
    expect(evidence.map((r) => r.detail)).toEqual([who, { by: "bob", member: "bob", role: "reviewer", key: bob.key.keyId, decision: stored[1]!.decision_id }]);
    expect((await w.rt.verifyEvidence("ok1")).map((e) => e.valid)).toEqual([true, true]);

    // An auditor holds the record, the signature and the member's public key, and nothing of Mandate's.
    for (const d of stored) {
      const pem = (d.record.member === "alice" ? alice : bob).key.publicKeyPem();
      const exported = JSON.parse(JSON.stringify({ record: d.record, signature: d.signature })) as { record: Record<string, string | number>; signature: string };
      expect(auditorAccepts(exported, pem)).toEqual({ ok: true, digest: d.decision_id });
      expect(auditorAccepts({ ...exported, record: { ...exported.record, member: "mallory" } }, pem).ok).toBe(false);
    }

    // Replay reads the journal: the decisions are in it, and no key is asked for again.
    expect(await w.rt.replayRun("ok1")).toEqual({ status: "complete", value: "done" });
  });

  it("is taken once: the same message again changes nothing", async () => {
    const w = await started("ok2");
    const m = msg("alice");
    const signed = await sign(w, "ok2", w.who.alice, "approve");
    const once = await w.rt.decideAction("ok2", m, { signed });
    const twice = await w.rt.decideAction("ok2", m, { signed });
    expect(twice.revision).toBe(once.revision);
    expect(await w.rt.verifyDecisions("ok2")).toHaveLength(1);
    // The same record under a new message id is a decision on a wait that is no longer open.
    await refused(w, "ok2", () => w.rt.decideAction("ok2", msg("alice"), { signed }), "stale_revision");
  });

  it("can be a decline: the criterion is unmet, by a decision that is recorded like an approval", async () => {
    const w = await started("ok3");
    const declined = await w.rt.decideAction("ok3", msg(), { signed: await sign(w, "ok3", w.who.alice, "decline") });
    // The second approval of the criterion is still asked; both parts are evidence.
    expect(waitOf(declined.waiting).request).toMatchObject({ role: "reviewer" });
    expect((await w.rt.journal.events("ok3")).find((e) => e.type === "criterion_denied")!.data).toMatchObject({ member: "alice", role: "code_owner" });
    const [row] = await w.rt.evidence("ok3");
    expect(row).toMatchObject({ passed: false });
    expect((await w.rt.verifyEvidence("ok3")).map((e) => e.valid)).toEqual([true]);
  });
});

// ── H02 ─────────────────────────────────────────────────────────────────

describe("H02: distinct_from refuses a second approval by the same member, whichever key signs it", () => {
  it("refuses the member who approved as code owner, with either of their keys, and takes another reviewer", async () => {
    const w = await started("h2");
    const { alice, aliceOther, bob } = w.who;
    await w.rt.decideAction("h2", msg(), { signed: await sign(w, "h2", alice, "approve") });
    expect(waitOf((await w.rt.getRun("h2")).waiting).request).toMatchObject({ role: "reviewer", distinct_from: "code_owner" });
    // Alice is a reviewer too, so only this rule stands between her and both approvals.
    await refused(w, "h2", async () => w.rt.decideAction("h2", msg(), { signed: await sign(w, "h2", alice, "approve") }), "same_member", { member: "alice", key: alice.key.keyId });
    await refused(w, "h2", async () => w.rt.decideAction("h2", msg(), { signed: await sign(w, "h2", aliceOther, "approve") }), "same_member", { member: "alice", key: aliceOther.key.keyId });
    // Nor may she decline it: the second decision is someone else's to make.
    await refused(w, "h2", async () => w.rt.decideAction("h2", msg(), { signed: await sign(w, "h2", aliceOther, "decline") }), "same_member");
    const next = await w.rt.decideAction("h2", msg(), { signed: await sign(w, "h2", bob, "approve") });
    expect(waitOf(next.waiting).request).toEqual({ question: "Go on?", role: "reviewer" });
    // The question asks a reviewer and has no such rule: Alice may answer it.
    const done = await w.rt.submitInput("h2", msg(), { value: "yes", signed: await sign(w, "h2", alice, "answer", { payload: payloadOf.answer("yes") }) });
    expect(done.state).toBe("succeeded");
  });

  it("holds when the first decision was a decline", async () => {
    const w = await started("h2b");
    const { alice, aliceOther, bob } = w.who;
    await w.rt.decideAction("h2b", msg(), { signed: await sign(w, "h2b", alice, "decline") });
    await refused(w, "h2b", async () => w.rt.decideAction("h2b", msg(), { signed: await sign(w, "h2b", aliceOther, "approve") }), "same_member");
    expect((await w.rt.decideAction("h2b", msg(), { signed: await sign(w, "h2b", bob, "approve") })).state).toBe("failed");
  });

  it("asks a role where a question names one (0.4): a member outside it cannot answer", async () => {
    const w = await started("h2c");
    const { alice, bob, carol } = w.who;
    await w.rt.decideAction("h2c", msg(), { signed: await sign(w, "h2c", alice, "approve") });
    await w.rt.decideAction("h2c", msg(), { signed: await sign(w, "h2c", bob, "approve") });
    const payload = payloadOf.answer("yes");
    await refused(w, "h2c", async () => w.rt.submitInput("h2c", msg(), { value: "yes", signed: await sign(w, "h2c", carol, "answer", { payload }) }), "not_in_role", { member: "carol", key: carol.key.keyId });
    await refused(w, "h2c", async () => w.rt.submitInput("h2c", msg(), { value: "yes", signed: await sign(w, "h2c", carol, "answer", { payload, change: ({ role: _role, ...s }) => s }) }), "not_in_role");
  });
});

// ── modes (INV-16) ──────────────────────────────────────────────────────

/** FixBug, a 0.2 program whose owner approval names its role by text, with the people in its lock when it takes signed decisions. */
async function fixbug(o: { signed: boolean; keys?: boolean } = { signed: false }): Promise<World & { pr: SimTool; who: People }> {
  const who = people();
  const pr = new SimTool("git.open_pr");
  const lock = { ...LOCK, members: who.members, roles: who.roles };
  const decisions = o.signed ? { keys: who.keys } : o.keys ? { ...UNSIGNED.decisions, keys: who.keys } : UNSIGNED.decisions;
  const w = await world(FIXBUG, { tools: [pr], agents: fixbugAgents(), verifier: new SimVerifier(), lock, decisions });
  return { ...w, pr, who };
}

describe("signed and unsigned mode", () => {
  it("does not start a 0.4 package in unsigned mode (signed_decisions_required)", async () => {
    const who = people();
    const w = await world(PEOPLE, { lock: { modules: {}, members: who.members, roles: who.roles }, decisions: { mode: "unsigned", keys: who.keys } });
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { x: "t" }, runId: "m0" })).rejects.toMatchObject({ code: "signed_decisions_required" });
    expect(await w.db.query("select run_id from runs")).toEqual([]);
  });

  it("takes signed decisions for an earlier package too, unless the runtime is told unsigned: a raise, an answer and an approval", async () => {
    const w = await fixbug({ signed: true });
    const { alice, bob, carol } = w.who;
    const stopped = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "m1", limits: { spend: { micros: 12 * USD, currency: "USD" } } });
    const limits = { spend: { micros: 50 * USD, currency: "USD" } };
    const to = { "spend:USD": 50 * USD };

    // A raise names the run's package, and what it raises the limits to.
    await refused(w, "m1", () => w.rt.raiseLimits("m1", msg("erin"), { revision: stopped.revision, limits, by: "erin" }), "invalid_signature");
    await refused(w, "m1", async () => w.rt.raiseLimits("m1", msg(), { limits, signed: await sign(w, "m1", carol, "raise_limits", { about: "run", payload: payloadOf.limits({ "spend:USD": 20 * USD }) }) }), "subject_mismatch");
    await refused(w, "m1", async () => w.rt.raiseLimits("m1", msg(), { limits, signed: await sign(w, "m1", carol, "raise_limits", { about: "run", payload: payloadOf.limits(to), change: (s) => ({ ...s, revision: s.revision - 1 }) }) }), "stale_revision");
    // A raise names no command: one that names a wait's is about something else.
    await refused(w, "m1", async () => w.rt.raiseLimits("m1", msg(), { limits, signed: await sign(w, "m1", carol, "raise_limits", { about: "run", payload: payloadOf.limits(to), change: (s) => ({ ...s, command: waitOf(stopped.waiting).command }) }) }), "subject_mismatch");
    // A record for the wait is not a record for the run.
    await refused(w, "m1", async () => w.rt.raiseLimits("m1", msg(), { limits, signed: await sign(w, "m1", carol, "raise_limits", { payload: payloadOf.limits(to) }) }), "subject_mismatch");
    const raised = await w.rt.raiseLimits("m1", msg("carol"), { limits, signed: await sign(w, "m1", carol, "raise_limits", { about: "run", payload: payloadOf.limits(to) }) });
    expect(raised.revision).toBe(stopped.revision + 1);
    expect((await w.rt.journal.events("m1")).find((e) => e.type === "limits_raised")!.data).toMatchObject({ by: "carol", member: "carol", role: null, key: carol.key.keyId, from: { "spend:USD": 12 * USD }, to });

    const approval = await w.rt.submitInput("m1", msg(), { value: "continue", signed: await sign(w, "m1", carol, "answer", { payload: payloadOf.answer("continue") }) });
    const wait = waitOf(approval.waiting);
    expect(wait.request).toMatchObject({ criterion: "owner_approved", role: "code_owner" });
    // The role is a text in this program; the lock binds it all the same.
    await refused(w, "m1", () => w.rt.decideAction("m1", msg("carol"), { commandId: wait.command, revision: approval.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" }), "invalid_signature");
    await refused(w, "m1", async () => w.rt.decideAction("m1", msg(), { signed: await sign(w, "m1", bob, "approve") }), "not_in_role");
    const done = await w.rt.decideAction("m1", msg(), { signed: await sign(w, "m1", alice, "approve") });
    expect(done.state).toBe("succeeded");
    expect(w.pr.appliedCount()).toBe(1);
    expect((await w.rt.verifyDecisions("m1")).map((d) => [d.record.kind, d.record.member, d.valid])).toEqual([
      ["raise_limits", "carol", true],
      ["answer", "carol", true],
      ["approve", "alice", true],
    ]);
    expect((await w.rt.verifyEvidence("m1")).every((e) => e.valid)).toBe(true);
  });

  it("in unsigned mode takes a name, as before, and still holds a record to its signature when one is sent", async () => {
    const w = await fixbug({ signed: false, keys: true });
    const { alice, bob } = w.who;
    const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "m2" });
    await refused(w, "m2", async () => w.rt.decideAction("m2", msg(), { signed: await sign(w, "m2", bob, "approve") }), "not_in_role");
    const good = await sign(w, "m2", alice, "approve");
    await refused(w, "m2", () => w.rt.decideAction("m2", msg(), { signed: { record: { ...good.record, member: "bob" }, signature: good.signature } }), "invalid_signature");
    const done = await w.rt.decideAction("m2", msg(), { signed: good });
    expect(done.state).toBe("succeeded");
    expect(await w.rt.verifyDecisions("m2")).toHaveLength(1);

    // By name, on another run of the same world: nothing is stored, and the evidence says who the caller said.
    const second = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "m3" });
    const wait = waitOf(second.waiting);
    const named = await w.rt.decideAction("m3", msg("carol"), { commandId: wait.command, revision: second.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" });
    expect(named.state).toBe("succeeded");
    expect(await w.rt.verifyDecisions("m3")).toEqual([]);
    const owner = (await w.rt.evidence("m3")).find((e) => e.criterion === "owner_approved")!.record as unknown as EvidenceRecord;
    expect(owner.producer).toEqual({ kind: "person", by: "carol", role: "code_owner", via: "DecideAction" });
    expect((await w.rt.verifyEvidence("m3")).every((e) => e.valid)).toBe(true);
    expect(waiting.state).toBe("waiting");
  });

  it("does not count an approval by name as one once decisions must be signed", async () => {
    const w = await fixbug({ signed: false });
    const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "m4" });
    const wait = waitOf(waiting.waiting);
    await w.rt.decideAction("m4", msg("carol"), { commandId: wait.command, revision: waiting.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" });
    expect((await w.rt.verifyEvidence("m4")).every((e) => e.valid)).toBe(true);
    // The same store, read by a runtime that takes signed decisions only.
    const strict = new Runtime(w.db, w.adapters, undefined, undefined, { artifacts: w.rt.artifacts, signer: w.rt.signer, decisions: { keys: w.who.keys } });
    expect((await strict.verifyEvidence("m4")).filter((e) => !e.valid).map((e) => e.criterion)).toEqual(["owner_approved"]);
  });

  it("holds a 0.4 run to signed decisions whatever the mode of the runtime that reads it", async () => {
    const w = await started("m5");
    const wait = waitOf(w.run.waiting);
    // The same store, read by a runtime in unsigned mode: it would not have started this run, and takes no name for it.
    const lax = { ...w, rt: new Runtime(w.db, w.adapters, undefined, undefined, { artifacts: w.rt.artifacts, signer: w.rt.signer, decisions: { mode: "unsigned", keys: w.who.keys } }) };
    await refused(lax, "m5", () => lax.rt.decideAction("m5", msg("alice"), { commandId: wait.command, revision: w.run.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "alice" }), "invalid_signature", { member: null, key: null });
    await refused(lax, "m5", () => lax.rt.raiseLimits("m5", msg("alice"), { revision: w.run.revision, limits: { steps: 30 }, by: "alice" }), "invalid_signature");
    const approved = await lax.rt.decideAction("m5", msg(), { signed: await sign(lax, "m5", w.who.alice, "approve") });
    expect(waitOf(approved.waiting).request).toMatchObject({ role: "reviewer", distinct_from: "code_owner" });
    expect((await lax.rt.verifyDecisions("m5")).map((d) => [d.record.member, d.valid])).toEqual([["alice", true]]);
  });
});

// ── reconcile and cancel ────────────────────────────────────────────────

describe("a reconciliation and a cancel", () => {
  async function lost(runId: string): Promise<World & { who: People; tool: SimTool; operation: string }> {
    const who = people();
    const tool = new SimTool("git.comment", "reconcilable").then("lose_response");
    const w = await world(FOLLOW, { tools: [tool], lock: { ...LOCK, members: who.members, roles: who.roles }, decisions: { keys: who.keys } });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Follow", runId, input: ISSUE });
    expect(run.state).toBe("attention_required");
    const [action] = await w.rt.journal.actions(runId);
    return { ...w, who, tool, operation: action!.operation_key };
  }

  it("a reconciliation is a member's signed record of the action and the revision it was asked on", async () => {
    const w = await lost("rc1");
    const { carol, mallory } = w.who;
    const payload = payloadOf.reconcile(w.operation);
    const about = { reconcile: w.operation };
    await refused(w, "rc1", () => w.rt.reconcileAction("rc1", w.operation), "invalid_signature");
    await refused(w, "rc1", async () => w.rt.reconcileAction("rc1", w.operation, await sign(w, "rc1", mallory, "reconcile", { about, payload })), "unknown_key");
    await refused(w, "rc1", async () => w.rt.reconcileAction("rc1", w.operation, await sign(w, "rc1", carol, "reconcile", { about, payload: payloadOf.reconcile("another") })), "subject_mismatch");
    await refused(w, "rc1", async () => w.rt.reconcileAction("rc1", w.operation, await sign(w, "rc1", carol, "reconcile", { about, payload, change: (s) => ({ ...s, subject: "sha256:another" }) })), "subject_mismatch");
    await refused(w, "rc1", async () => w.rt.reconcileAction("rc1", w.operation, await sign(w, "rc1", carol, "reconcile", { about, payload, change: (s) => ({ ...s, command: `${s.command}/other` }) })), "subject_mismatch");
    await refused(w, "rc1", async () => w.rt.reconcileAction("rc1", w.operation, await sign(w, "rc1", carol, "reconcile", { about, payload, change: ({ command: _command, ...s }) => s })), "subject_mismatch");
    await refused(w, "rc1", async () => w.rt.reconcileAction("rc1", w.operation, await sign(w, "rc1", carol, "reconcile", { about, payload, change: (s) => ({ ...s, revision: s.revision + 1 }) })), "stale_revision");
    expect(w.tool.executions).toHaveLength(1);
    const done = await w.rt.reconcileAction("rc1", w.operation, await sign(w, "rc1", carol, "reconcile", { about, payload }));
    expect(done.state).toBe("succeeded");
    expect((await w.rt.journal.events("rc1")).find((e) => e.type === "reconcile_requested")!.data).toMatchObject({ operation: w.operation, member: "carol", key: carol.key.keyId });
    expect((await w.rt.verifyDecisions("rc1")).map((d) => [d.record.kind, d.valid])).toEqual([["reconcile", true]]);
  });

  it("a cancel is always taken: a signature that holds says who asked, and one that does not is recorded as refused", async () => {
    const signedBy = async (runId: string, how: (w: Signed & { run: RunRow }) => Promise<SignedDecision | undefined>) => {
      const w = await started(runId);
      const cancelled = await w.rt.cancelRun(runId, await how(w));
      expect(cancelled.state).toBe("cancelled");
      const events = await w.rt.journal.events(runId);
      return { w, request: events.find((e) => e.type === "cancel_requested")!.data, refused: events.filter((e) => e.type === "decision_refused").map((e) => e.data), stored: await w.rt.verifyDecisions(runId) };
    };
    const plain = await signedBy("cx1", async () => undefined);
    expect(plain.request).toEqual({});
    expect(plain.refused).toEqual([]);

    const good = await signedBy("cx2", (w) => sign(w, "cx2", w.who.carol, "cancel", { about: "run" }));
    expect(good.request).toMatchObject({ member: "carol", role: null, key: good.w.who.carol.key.keyId, decision: good.stored[0]!.decision_id });
    expect(good.refused).toEqual([]);

    // A cancel signed on an older revision is still a cancel, and still says who.
    const old = await signedBy("cx3", (w) => sign(w, "cx3", w.who.carol, "cancel", { about: "run", change: (s) => ({ ...s, revision: s.revision - 1 }) }));
    expect(old.request).toMatchObject({ member: "carol" });

    const bad = await signedBy("cx4", (w) => sign(w, "cx4", w.who.mallory, "cancel", { about: "run" }));
    expect(bad.request).toEqual({});
    expect(bad.refused).toEqual([expect.objectContaining({ reason: "unknown_key", kind: "cancel", member: "mallory" })]);
    expect(bad.stored).toEqual([]);
  });
});

// ── H04 ─────────────────────────────────────────────────────────────────

describe("H04: evidence for human.approve whose decision record was changed after signing is invalid", () => {
  /** FixBug approved by its code owner, with the worker dead just before git.open_pr is prepared. */
  async function approvedThenCrashed(runId: string) {
    const w = await fixbug({ signed: true });
    await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId });
    w.faults.arm("after_dispatch", (i) => i.kind === "prepare");
    await expect(w.rt.decideAction(runId, msg(), { signed: await sign(w, runId, w.who.alice, "approve") })).rejects.toThrow(/crash at after_dispatch/);
    expect((await w.rt.verifyEvidence(runId)).every((e) => e.valid)).toBe(true);
    return w;
  }

  const invalid = async (w: World, runId: string) => (await w.rt.verifyEvidence(runId)).filter((e) => !e.valid).map((e) => e.criterion);

  it.each([
    ["the record now names another member", "update decisions set record = jsonb_set(record, '{member}', '\"bob\"') where run_id = $1", "was changed after it was signed"],
    ["the record now says decline", "update decisions set record = jsonb_set(record, '{kind}', '\"decline\"') where run_id = $1", "was changed after it was signed"],
    ["the signature was replaced", "update decisions set signature = 'ed25519:AAAA' where run_id = $1", "does not verify"],
    ["the record is gone", "delete from decisions where run_id = $1", "is not recorded"],
  ])("when %s, the evidence shows as invalid and the Verified value resting on it is refused (forged_evidence)", async (_what, sql, why) => {
    const runId = `h4-${++n}`;
    const w = await approvedThenCrashed(runId);
    await w.db.query(sql, [runId]);
    expect(await invalid(w, runId)).toEqual(["owner_approved"]);
    const resumed = await w.rt.resume(runId);
    expect(resumed.state).toBe("attention_required");
    expect(resumed.attention).toMatchObject({ violation: "forged_evidence" });
    expect(String(isObj(resumed.attention) ? resumed.attention["message"] : "")).toContain(why);
    expect(w.pr.prepares).toHaveLength(0);
  });

  it("untouched, the run goes on to the pull request", async () => {
    const w = await approvedThenCrashed("h4-ok");
    expect(await invalid(w, "h4-ok")).toEqual([]);
    expect((await w.rt.resume("h4-ok")).state).toBe("succeeded");
    expect(w.pr.appliedCount()).toBe(1);
  });

  it("another decision of the run does not stand in for the approval", async () => {
    const w = await fixbug({ signed: true });
    const stopped = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "h4-swap", limits: { spend: { micros: 12 * USD, currency: "USD" } } });
    expect(stopped.state).toBe("waiting");
    const limits = { spend: { micros: 50 * USD, currency: "USD" } };
    await w.rt.raiseLimits("h4-swap", msg(), { limits, signed: await sign(w, "h4-swap", w.who.alice, "raise_limits", { about: "run", payload: payloadOf.limits({ "spend:USD": 50 * USD }) }) });
    await w.rt.submitInput("h4-swap", msg(), { value: "continue", signed: await sign(w, "h4-swap", w.who.alice, "answer", { payload: payloadOf.answer("continue") }) });
    w.faults.arm("after_dispatch", (i) => i.kind === "prepare");
    await expect(w.rt.decideAction("h4-swap", msg(), { signed: await sign(w, "h4-swap", w.who.alice, "approve") })).rejects.toThrow(/crash at after_dispatch/);
    // The evidence names the approval. Naming her answer or her raise instead, records she did sign and the run
    // does hold, would not make it evidence: the decision must be this criterion's, with this result.
    const stored = new Map((await w.rt.verifyDecisions("h4-swap")).map((d) => [d.decision_id, d]));
    const evidence = (await w.rt.evidence("h4-swap")).find((e) => e.criterion === "owner_approved")!.record as unknown as EvidenceRecord;
    const producer = evidence.producer as Record<string, Value>;
    expect(stored.get(String(producer["decision"]))!.record.kind).toBe("approve");
    expect(approvalProblem(evidence, stored, w.who.keys, w.pkg.lock, true)).toBeUndefined();
    for (const kind of ["answer", "raise_limits"]) {
      const other = [...stored.values()].find((d) => d.record.kind === kind)!;
      expect(other.valid).toBe(true);
      expect(approvalProblem({ ...evidence, producer: { ...producer, decision: other.decision_id } }, stored, w.who.keys, w.pkg.lock, true)).toContain("is not the decision of this criterion");
    }
    // Nor does the approval hold up a result it did not give.
    expect(approvalProblem({ ...evidence, passed: false }, stored, w.who.keys, w.pkg.lock, true)).toContain("is not the decision of this criterion");
    // The approval's row is made to hold Alice's answer instead: a record she did sign, for something else.
    const [answer] = await w.db.query<{ record: unknown; signature: string }>("select record, signature from decisions where run_id = 'h4-swap' and kind = 'answer'");
    await w.db.query("update decisions set record = $1, signature = $2 where run_id = 'h4-swap' and kind = 'approve'", [JSON.stringify(answer!.record), answer!.signature]);
    expect(await invalid(w, "h4-swap")).toEqual(["owner_approved"]);
    expect((await w.rt.resume("h4-swap")).attention).toMatchObject({ violation: "forged_evidence" });
  });
});

describe("the format", () => {
  it("is mandate/decision/0.1", () => {
    expect(DECISION_FORMAT).toBe("mandate/decision/0.1");
  });
});
