// The review of a batch and its waivers (0.6; spec/library.md "`human.review` and waivers"). A person's signed
// decision turns what failed a contract's criteria into values a later step accepts, so every rule that a review,
// its decision and a waiver record are held to is written here, once; the interpreter (interp.ts) and the control
// API (runtime.ts) call these and decide nothing of the kind themselves:
//
//   waiversOf         which criteria of a contract a person may waive, and who: its `waive by`, never a criterion a
//                     person approves (E1504)
//   asVerdict         what a 0.6 verify against such a contract journaled of its outcome: the value it was given, by
//                     its digest too, which criteria it failed and the failed records of each
//   classify          which items are accepted (passed), open (failed only what the review's role may waive),
//                     declined without being asked (anything else failed), or failed (their work faulted)
//   questionOf        what the review's wait asks, whose digest a decision is bound to (its `subject`)
//   listsRefusal      a decision decides every open item, each once, in one list or the other, and nothing else
//                     (`incomplete_review`)
//   waiveRoleRefusal  the decision's role is named by the `waive by` of every failed criterion of each item it waives
//                     (`not_in_role`)
//   verifyRecord      the record a 0.6 verify writes of itself as a whole: the value and the contract's arguments by
//                     their digests, which `require` held, what it did not meet and on which records; every Verified
//                     value of a 0.6 run rests on exactly one, and on records of that verify alone (interp.ts
//                     `checkVerified`), so a value whose `require` failed is never accepted
//   waiverRecord      the evidence record of one waiver, beside the failed record it waives
//   waiverProblem     whether a waiver record holds, which is what a `Verified` value resting on it is accepted on
//                     (`forged_evidence` otherwise)
//
// A person's answer, and what a run is started with, never hold the members the runtime's own values are known by
// (`$verified`, `$evidence`, …): `Runtime.submitInput` refuses one (`reserved_value`), and the interpreter stops on
// one the journal holds anyway.
//
// An item's value is the one its verify journaled, read from the journal, never a value a decision carries: a
// decision names input indices and nothing else.

import type { Def, Lock } from "@mandate/bridge";
import { declaredMethods } from "./criteria.js";
import { payloadOf, storedProblem, type Refusal, type StoredDecision } from "./decisions.js";
import { EVIDENCE_FORMAT, type EvidenceRecord, type TrustedKeys } from "./evidence.js";
import type { EvidenceRow, Journal } from "./journal.js";
import type { Tx } from "./db.js";
import { canonical, digest, isObj, plain, verified, type Obj, type Value } from "./values.js";

/** The kind of a review's wait, and of the signed decision that answers it. */
export const REVIEW = "review";
/** The kind of the command a 0.6 verify against a contract with a waiver journals its outcome as. */
export const VERDICT = "verdict";
/** The method of a waiver's evidence record: never a check's, so "passed" and "waived" stay apart. */
export const WAIVER = "waiver";
/**
 * The method of the record a 0.6 verify writes of itself as a whole (`verifyRecord`): the value, the contract's
 * arguments, which `require` held, what it did not meet, and the records of its criteria. A Verified value of a 0.6
 * run is accepted only on one of these (interp.ts `checkVerified`).
 */
export const VERIFY = "verify";
/** The criterion a verify's own record names: the contract whole, a name no criterion can have. */
export const WHOLE = "*";

/** What a 0.6 verify against a contract with a waiver journals of its outcome, as the command `<verify>/verdict`. */
export interface Verdict {
  contract: string;
  /** The value the verify was given, as it had it. */
  value: Value;
  /** The request digest of that value with every Verified wrapper taken off: what every record of it names (B25). */
  value_digest: string;
  met: boolean;
  /** What it did not meet, in the verify's order: a criterion's name, or `require/<i>`. */
  unmet: string[];
  /** Each unmet criterion's failed records, by id. */
  failed: Record<string, string[]>;
  /** The passing records, by id, in order. */
  evidence: string[];
  /** The id of the verify's own record (`VERIFY`). */
  verify: string;
}

/** What the record of a verify as a whole holds in its `detail` (`VERIFY`). */
export interface VerifyDetail {
  /** Each `require` of the contract, in order: whether it held. */
  requires: boolean[];
  /** What the verify did not meet: a criterion's name, or `require/<i>`. */
  unmet: string[];
  /** The passing records of its criteria, by id, in order. */
  evidence: string[];
  /** Each unmet criterion's failed records, by id. */
  failed: Record<string, string[]>;
}

/**
 * The record of a 0.6 verify as a whole (evidence format `mandate/evidence/0.1`, method `verify`, criterion `*`):
 * `passed` when it met everything, `require`s included; its subject the contract's arguments and the value, by their
 * digests; its detail what it met and on which records. Signed by the runtime like every record.
 */
export function verifyRecord(o: { id: string; run: string; package: string; contract: string; contract_hash: string; contract_args: string; value: string; detail: VerifyDetail; producer: Value; at: number; mode?: "design" | "read_only" }): EvidenceRecord {
  return {
    format: EVIDENCE_FORMAT,
    evidence_id: o.id,
    run: o.run,
    package: o.package,
    contract: o.contract,
    contract_hash: o.contract_hash,
    criterion: WHOLE,
    method: VERIFY,
    passed: o.detail.unmet.length === 0,
    subject: { contract_args: o.contract_args, value: o.value },
    producer: o.producer,
    artifacts: [],
    detail: o.detail as unknown as Value,
    at: o.at,
    ...(o.mode ? { mode: o.mode } : {}),
  };
}

/** An item a review asks about: its index, its value as the map recorded it, and each criterion it failed. */
export interface OpenItem {
  index: number;
  value: Value;
  value_digest: string;
  unmet: Array<{ criterion: string; description: string | null; failed: string[]; waive: string[] }>;
}

/** What a review's wait asks: the decision's subject is its request digest (`questionDigest`). */
export interface Question {
  /** The review's wait, the contract its map verifies against, and the map. */
  review: string;
  contract: string;
  map: string;
  /** The role asked first, the role it is escalated to, and the deadline each is given. */
  role: string;
  escalate_to: string | null;
  deadline_ms: number;
  /** The open items, by index. */
  items: OpenItem[];
  /** The items declined without being asked, with what they did not meet. */
  declined: Array<{ index: number; unmet: string[] }>;
  /** The items whose work failed, and those accepted without being asked. */
  failed: number[];
  accepted: number[];
}

/** How a review's items split, by input index. */
export interface Split {
  accepted: number[];
  open: number[];
  declined: number[];
  failed: number[];
}

/** What a review's wait ended with: the decision, or the expiry, as the wait's result holds it. */
export interface Outcome {
  /** The digest of what was asked. */
  subject: string;
  waive: number[];
  decline: number[];
  /** The member who decided; null when the wait expired. */
  by: string | null;
  role: string | null;
  member?: string;
  key?: string;
  /** The stored decision's digest. */
  decision?: string;
  expired?: true;
}

/** The ids a list holds when it is a list of integers, each at least 0. */
export function indices(v: Value | undefined): number[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0) ? (v as number[]) : undefined;
}

const ascending = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

/**
 * The criteria of a contract a person may waive, each with the roles its `waive by` names, sorted and once each. A
 * criterion whose method is or includes `human.approve` is never one, whatever it says (E1504): the person who would
 * waive it is the one it asks.
 */
export function waiversOf(c: Def | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (c?.kind !== "contract") return out;
  for (const group of [c.accept, c.invariant ?? {}]) {
    for (const [name, k] of Object.entries(group)) {
      const roles = (k as { waive?: unknown }).waive;
      if (!Array.isArray(roles) || !roles.length || !roles.every((r) => typeof r === "string" && r !== "")) continue;
      if (declaredMethods(k.by).includes("human.approve")) continue;
      out.set(name, [...new Set(roles as string[])].sort());
    }
  }
  return out;
}

/** A criterion's description, as the contract writes it. */
function descriptionOf(c: Def | undefined, name: string): string | null {
  if (c?.kind !== "contract") return null;
  const k = Object.hasOwn(c.accept, name) ? c.accept[name] : c.invariant && Object.hasOwn(c.invariant, name) ? c.invariant[name] : undefined;
  return typeof k?.description === "string" ? k.description : null;
}

/** The request digest of a value with every Verified wrapper taken off: what a 0.6 record names as `subject.value`. */
export function valueDigest(v: Value): string {
  return digest("request", plain(v));
}

/** The value a record names in its subject (B25), when it names one. */
export function subjectValue(record: EvidenceRecord | null | undefined): string | undefined {
  const s = record && isObj(record.subject) ? record.subject : undefined;
  return s && typeof s["value"] === "string" ? s["value"] : undefined;
}

/**
 * A verdict as the journal holds it, held to its own shape: of `contract`, met when it failed nothing, and naming the
 * digest of the value it holds. Undefined when it is none.
 */
export function asVerdict(v: Value, contract: string): Verdict | undefined {
  if (!isObj(v) || v["contract"] !== contract || typeof v["value_digest"] !== "string" || typeof v["met"] !== "boolean" || !Object.hasOwn(v, "value") || typeof v["verify"] !== "string") return undefined;
  const unmet = v["unmet"];
  const evidence = v["evidence"];
  const failed = v["failed"];
  if (!Array.isArray(unmet) || !unmet.every((u) => typeof u === "string") || !Array.isArray(evidence) || !evidence.every((e) => typeof e === "string") || !isObj(failed ?? null)) return undefined;
  const byCriterion: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(failed as Obj)) {
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) return undefined;
    byCriterion[k] = ids as string[];
  }
  if (v["met"] !== (unmet.length === 0)) return undefined;
  if (valueDigest(v["value"]!) !== v["value_digest"]) return undefined;
  return { contract, value: v["value"]!, value_digest: v["value_digest"], met: v["met"], unmet: unmet as string[], failed: byCriterion, evidence: evidence as string[], verify: v["verify"] };
}

/**
 * How a review's items split (spec/library.md "The wait and the decision"), by input index, from what each item's
 * verify journaled (`undefined`: the item's work faulted before its verify ended):
 *
 * - passed: accepted, without anyone being asked;
 * - failed only criteria whose `waive by` names `role`: open, asked about;
 * - failed anything else, a `require` or a criterion nobody (or not `role`) may waive among it: declined without
 *   being asked, and no decision may waive it;
 * - no verdict: failed, by its index.
 */
export function classify(verdicts: ReadonlyArray<Verdict | undefined>, c: Def | undefined, role: string): Split {
  const waivers = waiversOf(c);
  const s: Split = { accepted: [], open: [], declined: [], failed: [] };
  verdicts.forEach((v, i) => {
    if (!v) s.failed.push(i);
    else if (v.met) s.accepted.push(i);
    else if (v.unmet.length > 0 && v.unmet.every((u) => waivers.get(u)?.includes(role) === true)) s.open.push(i);
    else s.declined.push(i);
  });
  return s;
}

/** What a review's wait asks, from its verdicts and how they split. */
export function questionOf(o: { review: string; contract: string; map: string; role: string; escalate_to: string | null; deadline_ms: number; c: Def | undefined; verdicts: ReadonlyArray<Verdict | undefined>; split: Split }): Question {
  const waivers = waiversOf(o.c);
  return {
    review: o.review,
    contract: o.contract,
    map: o.map,
    role: o.role,
    escalate_to: o.escalate_to,
    deadline_ms: o.deadline_ms,
    items: o.split.open.map((i) => {
      const v = o.verdicts[i]!;
      return { index: i, value: v.value, value_digest: v.value_digest, unmet: v.unmet.map((u) => ({ criterion: u, description: descriptionOf(o.c, u), failed: [...(v.failed[u] ?? [])].sort(), waive: waivers.get(u) ?? [] })) };
    }),
    declined: o.split.declined.map((i) => ({ index: i, unmet: o.verdicts[i]!.unmet })),
    failed: o.split.failed,
    accepted: o.split.accepted,
  };
}

/** The digest a review's decision names as its `subject`: the request digest of the question, as it was recorded. */
export function questionDigest(q: Question | Value): string {
  return digest("request", q as unknown as Value);
}

/** A question as the journal holds it, when it is one: its items, declined, failed and accepted lists. */
export function asQuestion(q: Value | undefined): Question | undefined {
  if (!isObj(q ?? null)) return undefined;
  const o = q as Obj;
  const items = o["items"];
  if (!Array.isArray(items) || !items.every((i) => isObj(i) && typeof i["index"] === "number" && Array.isArray(i["unmet"]))) return undefined;
  if (!Array.isArray(o["declined"]) || !indices(o["failed"]) || !indices(o["accepted"])) return undefined;
  return o as unknown as Question;
}

/** The question a review's wait request holds, when it holds one. */
export function questionIn(request: Value | undefined): Question | undefined {
  return asQuestion(isObj(request ?? null) ? (request as Obj)["question"] : undefined);
}

const incomplete = (message: string): Refusal => ({ reason: "incomplete_review", message });

/**
 * Whether a decision decides every open item of `q`, each once, in one list or the other, and names nothing else
 * (spec/library.md "The wait and the decision"): otherwise it is refused, `incomplete_review`, and the wait stays open.
 */
export function listsRefusal(q: Question, d: { waive: readonly unknown[]; decline: readonly unknown[] }): Refusal | undefined {
  const open = new Set(q.items.map((i) => i.index));
  const seen = new Map<number, string>();
  for (const [list, xs] of [["waive", d.waive], ["decline", d.decline]] as const) {
    for (const x of xs) {
      if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) return incomplete(`It names ${JSON.stringify(x) ?? String(x)} in ${list}, which is not an item's index.`);
      const before = seen.get(x);
      if (before !== undefined) return incomplete(before === list ? `It names item ${x} twice in ${list}.` : `It names item ${x} both to waive and to decline.`);
      seen.set(x, list);
      if (open.has(x)) continue;
      if (q.accepted.includes(x)) return incomplete(`It names item ${x}, which passed and was accepted without anyone being asked.`);
      const declined = q.declined.find((i) => i.index === x);
      if (declined) return incomplete(`It names item ${x}, which failed ${declined.unmet.join(", ")}, which no one asked may waive: it was declined without being asked.`);
      if (q.failed.includes(x)) return incomplete(`It names item ${x}, whose work failed: no one may waive it.`);
      return incomplete(`It names item ${x}, which the review did not ask about: the map has no item ${x}.`);
    }
  }
  const missing = [...open].filter((i) => !seen.has(i)).sort((a, b) => a - b);
  if (missing.length) return incomplete(`It leaves ${missing.length === 1 ? "open item" : "open items"} ${missing.join(", ")} undecided: a decision decides every open item.`);
  return undefined;
}

/**
 * Whether `role`, the role the decision is made in, may waive each item it waives: every criterion that item failed
 * names it in its `waive by`, as the program's contract declares it (never as the wait's request says).
 */
export function waiveRoleRefusal(c: Def | undefined, q: Question, waive: readonly number[], role: string | undefined): Refusal | undefined {
  const waivers = waiversOf(c);
  for (const i of waive) {
    const item = q.items.find((x) => x.index === i);
    if (!item) return { reason: "not_in_role", message: `Item ${i} is not open.` };
    for (const u of item.unmet) {
      const roles = waivers.get(u.criterion);
      if (role === undefined || !roles?.includes(role)) {
        return { reason: "not_in_role", message: `Item ${i} failed ${q.contract}.${u.criterion}, which ${role ?? "no role"} may not waive: ${roles?.length ? `its waive by names ${roles.join(", ")}` : "no one may waive it"}.` };
      }
    }
  }
  return undefined;
}

/** The id of the waiver record of one failed record, by one review decision. */
export function waiverIdOf(run: string, failed: string, decision: string): string {
  return digest("request", { run, method: WAIVER, waives: failed, decision });
}

/**
 * The evidence record of one waiver (spec/library.md "Waiver evidence"): `method: "waiver"`, `passed: true`, for the
 * same contract, criterion and subject as the failed record it waives, which `detail.waives` names; its producer is
 * the member, role and key of the review's decision and its digest; its detail names the review and the item, and
 * nothing more: the lists the decision's payload is the digest of are the review's outcome's (`WaiverFacts.outcomes`),
 * read once, so a record stays small however many items a review decides. The runtime signs it like every record.
 */
export function waiverRecord(o: { run: string; package: string; failed: EvidenceRecord; decision: { id: string; member: string; role: string; key: string }; review: string; index: number; at: number }): EvidenceRecord {
  const f = o.failed;
  return {
    format: EVIDENCE_FORMAT,
    evidence_id: waiverIdOf(o.run, f.evidence_id, o.decision.id),
    run: o.run,
    package: o.package,
    contract: f.contract,
    contract_hash: f.contract_hash,
    criterion: f.criterion,
    method: WAIVER,
    passed: true,
    subject: f.subject,
    producer: { kind: "person", by: o.decision.member, role: o.decision.role, via: "Review", member: o.decision.member, key: o.decision.key, decision: o.decision.id },
    artifacts: [],
    detail: { waives: f.evidence_id, review: o.review, index: o.index },
    at: o.at,
    ...(f.mode ? { mode: f.mode } : {}),
  };
}

/** What a waiver record is checked against: the run's program, its stored decisions and evidence, and what its reviews asked. */
export interface WaiverFacts {
  run: string;
  /** A contract of the run's program, by name. */
  contract: (name: string) => Def | undefined;
  decisions: ReadonlyMap<string, StoredDecision>;
  /** The members' decision keys, and the lock that binds them to members and roles. */
  keys: TrustedKeys;
  lock: Lock;
  /** The run's evidence rows, by id. */
  evidence: ReadonlyMap<string, EvidenceRow>;
  /** The keys whose evidence signatures the runtime accepts. */
  trusted: TrustedKeys;
  /** What each review's wait asked, by its command, as its `wait_opened` recorded it. */
  questions: ReadonlyMap<string, Value>;
  /** What each decided review's wait ended with, by its command: the lists its decision waived and declined. */
  outcomes: ReadonlyMap<string, Value>;
}

/**
 * Why a waiver record does not hold, or undefined when it does (spec/library.md "What `Verified` accepts"). The
 * record itself was checked against its signature before. It holds only when all of these do:
 *
 * 1. its criterion has `waive by`, and the decision's role is one of its roles;
 * 2. it names a stored `review` decision of this run that still hashes to its digest, signed by a key the lock binds
 *    to its member and that role, which decided the review the record names, on what that review asked (its
 *    subject is the question's digest), and whose payload is the digest of the lists the review's outcome holds,
 *    which waive the record's item;
 * 3. `detail.waives` names a failed record of this run, signed by a trusted key, for the same contract, criterion and
 *    subject, and the review asked about that record for that item;
 * 4. its subject names the value the review asked about for that item, by its digest;
 *
 * and its id is the one its decision and failed record give. That the value an effect is given is that value is
 * the caller's to hold, for every record a value rests on.
 */
export function waiverProblem(record: EvidenceRecord, f: WaiverFacts): string | undefined {
  if (record.method !== WAIVER) return undefined;
  if (record.passed !== true) return "a waiver that does not pass waives nothing";
  if (record.run !== f.run) return "it is a waiver of another run";
  const p = isObj(record.producer) ? record.producer : {};
  const d = isObj(record.detail) ? record.detail : {};
  // 1. Who may waive the criterion is the program's to say.
  const roles = waiversOf(f.contract(record.contract)).get(record.criterion);
  if (!roles) return `${record.contract}.${record.criterion} is not a criterion a person may waive (waive by)`;
  const role = p["role"];
  if (typeof role !== "string" || !roles.includes(role)) return `${record.contract}.${record.criterion} may be waived by ${roles.join(", ")}, not by ${typeof role === "string" ? role : "no role"}`;
  // 2. The decision: stored, unchanged, signed by the member in that role, for this review, waiving this item.
  const id = p["decision"];
  if (typeof id !== "string") return "it names no review decision";
  const decision = f.decisions.get(id);
  if (!decision) return `decision ${id} is not recorded`;
  const why = storedProblem(decision, f.keys, f.lock);
  if (why) return `decision ${id}: ${why}`;
  const r = decision.record;
  if (r.kind !== REVIEW || r.run !== record.run || r.package !== record.package) return `decision ${id} is not a review's decision of this run`;
  if (r.member !== p["member"] || r.key !== p["key"] || (r.role ?? null) !== role) return `decision ${id} was not made by the member, key and role the waiver names`;
  const review = d["review"];
  if (typeof review !== "string" || r.command !== review) return `decision ${id} did not decide the review the waiver names`;
  const outcome = f.outcomes.get(review);
  const waive = isObj(outcome ?? null) ? indices((outcome as Obj)["waive"]) : undefined;
  const decline = isObj(outcome ?? null) ? indices((outcome as Obj)["decline"]) : undefined;
  if (!waive || !decline || r.payload !== payloadOf.review({ waive, decline })) return `decision ${id} did not decide the items the waiver names`;
  const index = d["index"];
  if (typeof index !== "number" || !waive.includes(index)) return `decision ${id} does not waive item ${String(index)}`;
  const asked = f.questions.get(review);
  if (asked === undefined || questionDigest(asked) !== r.subject) return `decision ${id} was not made on what review ${review} asked`;
  const item = asQuestion(asked)?.items.find((x) => x.index === index);
  if (!item) return `review ${review} did not ask about item ${index}`;
  // 3. The failed record it waives: one the review asked about, of this run, for the same contract, criterion and subject.
  const waives = d["waives"];
  if (typeof waives !== "string") return "it names no failed record";
  const failed = item.unmet.find((u) => isObj(u as unknown as Value) && u.criterion === record.criterion);
  if (!failed || !Array.isArray(failed.failed) || !failed.failed.includes(waives)) return `review ${review} did not ask about ${waives} for item ${index}`;
  const row = f.evidence.get(waives);
  const fr = (row?.record ?? null) as EvidenceRecord | null;
  if (!row || !fr || !row.key_id || !row.signature || !f.trusted.verify(fr, { key_id: row.key_id, signature: row.signature })) return `${waives} is not a record of this run signed by a trusted key`;
  if (fr.evidence_id !== row.evidence_id || fr.passed !== row.passed || fr.contract !== row.contract || fr.criterion !== row.criterion || fr.method !== row.method) return `${waives} does not match its signed record`;
  if (fr.passed !== false || fr.method === WAIVER || fr.run !== record.run) return `${waives} is not a failed check of this run`;
  if (fr.contract !== record.contract || fr.criterion !== record.criterion || canonical(fr.subject) !== canonical(record.subject)) return `${waives} is a record of another contract, criterion or subject`;
  // 4. The value the review asked about.
  const value = subjectValue(record);
  if (value === undefined || value !== item.value_digest) return `it is a waiver of another value than the one review ${review} asked about for item ${index}`;
  if (record.evidence_id !== waiverIdOf(record.run, waives, id)) return "its id is not the one its decision and its failed record give";
  return undefined;
}

/** The facts `waiverProblem` reads, from the run's journal; with `tx`, inside that transaction. */
export async function waiverFacts(journal: Journal, runId: string, o: { contract: WaiverFacts["contract"]; keys: TrustedKeys; lock: Lock; trusted: TrustedKeys }, tx?: Tx): Promise<WaiverFacts> {
  return {
    run: runId,
    ...o,
    decisions: new Map((await journal.decisions(runId, tx)).map((d) => [d.decision_id, d])),
    evidence: new Map((await journal.evidence(runId, undefined, tx)).map((e) => [e.evidence_id, e])),
    questions: new Map([...(await journal.waitsOpened(runId, REVIEW, tx))].flatMap(([command, request]) => {
      const q = isObj(request ?? null) ? (request as Obj)["question"] : undefined;
      return q === undefined ? [] : [[command, q] as const];
    })),
    outcomes: new Map((await (tx ?? journal.db).query<{ command_id: string; result: Value }>("select command_id, result from commands where run_id = $1 and kind = $2 and state = 'succeeded'", [runId, REVIEW])).map((r) => [r.command_id, r.result ?? null])),
  };
}

/**
 * Why the outcome a review's wait holds is not one of what it asked, or undefined: it is about the question whose
 * digest is `subject`; it decides every open item once (`listsRefusal`); an expiry waives nothing; a decision names
 * the stored decision it was taken on.
 */
export function outcomeProblem(o: Value, q: Question, subject: string): string | undefined {
  if (!isObj(o)) return "the review's wait holds no outcome";
  if (o["subject"] !== subject) return "the review's outcome is about another question than the one its verifies give";
  const waive = indices(o["waive"]);
  const decline = indices(o["decline"]);
  if (!waive || !decline) return "the review's outcome names no lists of items";
  const lists = listsRefusal(q, { waive, decline });
  if (lists) return lists.message;
  if (o["expired"] === true) return waive.length ? "an expired review waived items" : undefined;
  if (typeof o["decision"] !== "string" || typeof o["member"] !== "string" || typeof o["role"] !== "string" || typeof o["key"] !== "string") return "the review's outcome names no signed decision";
  return undefined;
}

/**
 * Why the decision a review's outcome names does not hold, or undefined: stored, unchanged, signed by a key the lock
 * binds to its member and role; of kind `review`, for this run, this review's wait and what it asked; its payload the
 * digest of the outcome's lists; made by the member, role and key the outcome names.
 */
export function decisionProblem(d: StoredDecision | undefined, o: { run: string; review: string; subject: string; outcome: Obj; keys: TrustedKeys; lock: Lock }): string | undefined {
  if (!d) return "its decision is not recorded";
  const why = storedProblem(d, o.keys, o.lock);
  if (why) return why;
  const r = d.record;
  const waive = indices(o.outcome["waive"]) ?? [];
  const decline = indices(o.outcome["decline"]) ?? [];
  if (r.kind !== REVIEW || r.run !== o.run || r.command !== o.review) return "it is not a decision of this review";
  if (r.subject !== o.subject) return "it was made on another question";
  if (r.payload !== payloadOf.review({ waive, decline })) return "it decided other items than the outcome says";
  if (r.member !== o.outcome["member"] || r.key !== o.outcome["key"] || (r.role ?? null) !== o.outcome["role"]) return "it was made by another member, key or role than the outcome says";
  return undefined;
}

/**
 * The value of a review, `Review<T, C>` (spec/library.md "human.review"), from its verdicts, how they split, and the
 * outcome of its wait (none when no item was open):
 *
 * - `accepted`: what passed, and what was waived, by input index, each a `Verified<T, C>` of the value its verify
 *   journaled, resting on its verify's own record and its passing records, and a waived one on the waivers its
 *   decision made too;
 * - `declined`: what was declined, without being asked (`by` absent) or by the decision (`by` its member) or at the
 *   expiry (`by` absent), by input index, each with its value and what it did not meet;
 * - `failed`: the indices of the items whose work failed.
 */
export function reviewValue(o: { run: string; contract: string; verdicts: ReadonlyArray<Verdict | undefined>; split: Split; outcome?: Outcome }): Value {
  const waived = new Set(o.outcome?.waive ?? []);
  const declinedBy = new Map<number, string | null>(o.split.declined.map((i) => [i, null]));
  for (const i of o.outcome?.decline ?? []) declinedBy.set(i, o.outcome?.expired ? null : (o.outcome?.by ?? null));
  const accepted = ascending([...o.split.accepted, ...waived]).map((i) => {
    const v = o.verdicts[i]!;
    const decision = o.outcome?.decision;
    const waivers = waived.has(i) && decision !== undefined ? Object.values(v.failed).flat().map((f) => waiverIdOf(o.run, f, decision)) : [];
    return verified(v.value, o.contract, [...new Set([...v.evidence, v.verify, ...waivers])].sort());
  });
  const declined = ascending([...declinedBy.keys()]).map((i): Value => ({ index: i, value: o.verdicts[i]!.value, unmet: o.verdicts[i]!.unmet, by: declinedBy.get(i) ?? null }));
  return { accepted, declined, failed: o.split.failed };
}
