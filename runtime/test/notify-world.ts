// What the tests of the driver loop and of notifications share (spec/attention.md "The driver loop",
// "Notifications"): the programs, written in 0.6 and run as 0.6 or relabelled 0.7 (the header, and nothing else: a
// package of 0.7 that uses nothing 0.7 adds runs as the same package of 0.6), the people who decide, and worlds over
// helpers.ts's database, so that every test runs on PGlite and on PostgreSQL. The made-up words are no secrets.

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payloadOf, shownPackage, signDecision, type DecisionKind } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import type { NotificationsConfig } from "../src/notify.js";
import { SimAgents } from "../src/sim.js";
import type { Obj, Value } from "../src/values.js";
import { world, type World } from "./helpers.js";

/** A program of 0.6 as the language under test writes it: `0.6` itself, or relabelled `0.7`. */
export function under(src: string, language: "0.6" | "0.7"): string {
  if (!src.startsWith("mandate @ 0.6\n")) throw new Error("a program of these tests is written in 0.6");
  return language === "0.6" ? src : src.replace("mandate @ 0.6\n", "mandate @ 0.7\n");
}

/**
 * A batch, one review of what failed, and a workflow that fails: `Matcher` matches each invoice, the accountant is
 * asked once about the matches whose totals are off (escalated to the finance lead after a day), and `Fail` ends with
 * the Matcher's error. Every text a test plants a marker in can be any text.
 */
export const REVIEW = `mandate @ 0.6

module test.attention.notify @ 0.1

use std.{fs, human, model}

role accountant   "Accountant"
role finance_lead "Finance lead"

type Invoice = { invoice_no: Text, vendor_id: Text, total_cents: Int }
type Match   = { invoice_no: Text, vendor_id: Text, total_cents: Int }

capability ModelStd = model.infer(tier: standard, max_class: internal)

fn near(a: Int, b: Int, pct: Int) -> Bool ! {} {
  a * 100 <= b * (100 + pct) and a * 100 >= b * (100 - pct)
}

contract Matched(inv: Invoice, m: Match) {
  accept same_invoice "The match is for this invoice"
    by static m.invoice_no == inv.invoice_no
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

workflow ReviewAll(items: List<Invoice>) -> Int
  caps   ModelStd
  budget { time: 7d }
{
  let checked = map it in items max 10 par 2 {
    let out = delegate Matcher.match(it)
    verify out against Matched(it, out)
  }
  let reviewed = human.review(checked, role: accountant, deadline: 1d, escalate_to: finance_lead)
  len(reviewed.accepted)
}

workflow Fail(inv: Invoice) -> Inferred<Match>
  caps   ModelStd
  budget { time: 1h }
{
  delegate Matcher.match(inv)
}
`;

/** Two approvals in a \`par\`, each with a deadline of its own: two waits open at once. */
export const BOTH = `mandate @ 0.6

module test.attention.waits @ 0.1

use std.{fs, human}

role accountant   "Accountant"
role finance_lead "Finance lead"

type Note = { text: Text }

capability Notes = fs.read("/work/notes")

contract FirstOk(n: Note) {
  accept first "The accountant approved"
    by human.approve(role: accountant, deadline: 1h)
}

contract SecondOk(n: Note) {
  accept second "The finance lead approved"
    by human.approve(role: finance_lead, deadline: 2h)
}

workflow Both(n: Note) -> Text
  caps   Notes
  budget { time: 7d }
{
  par {
    a = verify n against FirstOk(n)
    b = verify n against SecondOk(n)
  }
  "done"
}
`;

/** A workflow under an envelope whose owner is the platform lead: one question asks no role, one asks the reviewer. */
export const OWNED = `mandate @ 0.6

module test.attention.owned @ 0.1

use std.{fs, human}

role platform_lead "Platform lead"
role reviewer      "Reviewer"

capability Note = fs.read("/tmp/notes")

workflow Ship(title: Text) -> Untrusted<Text>
  envelope {
    owner  platform_lead
    caps   Note
    budget { steps: 5, agents: 2 }
  }
{
  let why = human.ask("Why ship it?")
  human.ask("Is it good?", role: reviewer)
}
`;

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const REVIEW_AT = "/defs/ReviewAll/body/1/value";

export interface Person {
  member: string;
  key: EvidenceSigner;
}

/** Ana is an accountant, Ben the finance lead, Pat the platform lead, Rex a reviewer. */
export function people() {
  const person = (member: string): Person => ({ member, key: EvidenceSigner.generate() });
  const all = { ana: person("ana"), ben: person("ben"), pat: person("pat"), rex: person("rex") };
  const members = Object.fromEntries(Object.values(all).map((p) => [p.member, { keys: [p.key.keyId] }]));
  const roles = { accountant: ["ana"], finance_lead: ["ben"], platform_lead: ["pat"], reviewer: ["rex"] };
  return { ...all, members, roles, keys: new TrustedKeys(Object.values(all).map((p) => p.key.publicKey)) };
}
export type People = ReturnType<typeof people>;

export const inv = (no: string, total = 1000, vendor = "V1"): Obj => ({ invoice_no: no, vendor_id: vendor, total_cents: total });

/** Three invoices: 0 matches; 1 and 2 are off by 10%, which a person may waive. */
export const BATCH = [inv("I0"), inv("I1"), inv("I2")];

export interface NWorld extends World {
  who: People;
}

/**
 * A world of `src` under `language`, with signed decisions by the people above. `matches` says what the Matcher gives
 * for an invoice, by its number: a match, or `fail` with the error's argument.
 */
export async function nworld(src: string, language: "0.6" | "0.7", matches: Record<string, Obj | { fail: string }> = {}): Promise<NWorld> {
  const who = people();
  const agents = new SimAgents().on("Matcher.match", (req) => {
    const i = req.args[0] as Obj;
    // By default the first invoice is matched exactly and every other one 10% off.
    const m = matches[String(i["invoice_no"])] ?? { ...i, total_cents: i["invoice_no"] === "I0" ? Number(i["total_cents"]) : Math.round(Number(i["total_cents"]) * 1.1) };
    return "fail" in m ? { error: { tag: "SkillFailed", args: [m["fail"] as Value] }, cost: { steps: 1 } } : { ok: m as Value, cost: { steps: 1 } };
  });
  const w = await world(under(src, language), { agents, lock: { modules: {}, members: who.members, roles: who.roles }, decisions: { keys: who.keys } });
  return { ...w, who };
}

let n = 0;
export const msg = (sender = "cli") => ({ sender, messageId: `m${++n}` });

/** `who`'s signed decision of `kind` on the wait the run shows now. */
export async function sign(w: NWorld, runId: string, who: Person, kind: DecisionKind, payload?: string) {
  return signDecision(who.key, await w.rt.shown(runId, "wait"), { kind, member: who.member, ...(payload !== undefined ? { payload } : {}), at: new Date(w.adapters.clock.now()) });
}

/** The platform lead approves the package of an envelope workflow, so its runs may start. */
export async function approveCard(w: NWorld): Promise<void> {
  await w.rt.approveEnvelope(w.pkg, signDecision(w.who.pat.key, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "pat", at: new Date(w.adapters.clock.now()) }));
}

/** `who` answers the question the run waits on. */
export async function answer(w: NWorld, runId: string, who: Person, value: string): Promise<RunRow> {
  return w.rt.submitInput(runId, msg(), { value, signed: await sign(w, runId, who, "answer", payloadOf.answer(value)) });
}

/** A directory of the test's own for the file channels. */
export function scratch(): string {
  return mkdtempSync(join(tmpdir(), "mandate-notify-"));
}

/** The notifications a file channel holds, one JSON object a line. */
export function lines(file: string): Obj[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Obj);
}

/** A configuration of one file channel per role, and one that all roles share, every role with outcomes or not as given. */
export function fileChannels(dir: string, roles: Record<string, boolean>, link?: string): NotificationsConfig {
  const channels: NotificationsConfig["channels"] = { all: { file: join(dir, "all.jsonl") } };
  const out: NotificationsConfig["roles"] = {};
  for (const [role, outcomes] of Object.entries(roles)) {
    channels[role] = { file: join(dir, `${role}.jsonl`) };
    out[role] = { channels: [role, "all"], outcomes };
  }
  return { channels, roles: out, link: link ?? null };
}

/** What a notification says, in short: its event, its role and its command. */
export const brief = (n: Obj): string => `${String(n["event"])} ${String(n["role"])}${n["command"] !== null ? ` ${String(n["command"])}` : ""}`;

/** Appends an event to a run's journal, as the runtime writes one: under the run's lock. */
export async function append(w: World, runId: string, type: string, data: Value): Promise<number> {
  return w.db.tx(async (tx) => {
    await w.rt.journal.lock(tx, runId);
    return (await w.rt.journal.event(tx, runId, type, data)).seq;
  });
}

/** A wait the journal holds as waiting, for an event a test appends: a question is told only while it is asked. */
export async function waitingRow(w: World, runId: string, command: string, kind: string): Promise<void> {
  await w.db.query("insert into commands (run_id, command_id, kind, state, fence, request_digest) values ($1, $2, $3, 'waiting', 0, 'sha256:made-up')", [runId, command, kind]);
}

/** The number a count comes back as: a number on PGlite, a text on PostgreSQL. */
export async function count(w: World, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await w.db.query<{ n: unknown }>(sql, params))[0]!.n);
}
