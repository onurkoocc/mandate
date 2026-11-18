// Masking and how a value is known (spec/attention.md "Masking and how a value is known"; language 0.7).
//
// In a run of 0.7 each value shown to a role is a `ShownValue` (the specification's `Shown`): `masked: false` and the
// value, or `masked: true` and no value when its data class is above what the role may be shown, with its class and
// how it is known either way. That a value is masked is a member of the `ShownValue` itself, never a marker inside its
// value, so no value a program holds can read as a mask. A digest computed over a wait's values is masked with them
// (`maskRequest`): the rest of what it is computed over is shown to the role, so a value with few possibilities could
// be found by trying each against the digest. The class and the level are the compiler's, from the attention facts the run stored at its start (a
// wait's, found by its site tag) or from the `report` event (a report's fields, which carry their own): nothing here
// works a class out of a value. A value whose class is not known is masked for every role (`UNKNOWN`).
//
// A role's cap is `role_classes[role]` in the package's lock, else `internal`. The order of the classes is the
// language's (`DATA_CLASSES`, `classRank`, through the bridge). The audit audience sees every value, still labelled.
// A run of 0.1 to 0.6 is never masked or labelled: its projections do not call this module.
//
// There is no server, no listener and no authenticated read: whoever reaches the database reads everything already
// (spec/attention.md "The command line"), so these projections are for people and not a security boundary of their
// own. The masking is still done as if it were one: what is not known to be shown is not shown.

import { classRank, DATA_CLASSES, type AttentionFacts, type DataClass, type Known, type Lock } from "@mandate/bridge";
import { rowOf, type SiteTag } from "./asks.js";
import { isObj, type Obj, type Value } from "./values.js";

export type { DataClass, Known };

/** The levels a value can be known at, from the best to the weakest (spec/attention.md "`known`"). */
export const KNOWN_LEVELS: readonly Known[] = ["verified", "plain", "model", "external"];

/**
 * A value as a role of a run of 0.7 is shown it: the specification's `Shown` (named `ShownValue` here, since
 * decisions.ts's `Shown` is the record a decision signs).
 */
export type ShownValue = { masked: false; value: Value; class: DataClass; known: Known } | MaskedValue;

/** A value, or a digest of values, a role is not shown: its class and how it is known, and no value. */
export interface MaskedValue {
  masked: true;
  class: DataClass;
  known: Known;
}

/** A value's class and level, as the facts or a report's event give them. */
export interface Label {
  class: DataClass;
  known: Known;
}

/** Whom a value is shown to: a role's cap, or the audit audience, which sees every value. */
export type Cap = DataClass | "audit";

/**
 * The label of a value whose class is not known (a site the facts hold no row with a class for, a class the runtime
 * does not know): the highest class and the weakest level. Such a value is masked for every role, whatever its cap.
 */
export const UNKNOWN: Label = { class: DATA_CLASSES[DATA_CLASSES.length - 1]!, known: KNOWN_LEVELS[KNOWN_LEVELS.length - 1]! };

/** The class a role may be shown when the lock does not name it (spec/attention.md "Lock 0.7"). */
export const DEFAULT_CAP: DataClass = "internal";

const isClass = (c: unknown): c is DataClass => typeof c === "string" && (DATA_CLASSES as readonly string[]).includes(c);
const isKnown = (k: unknown): k is Known => typeof k === "string" && (KNOWN_LEVELS as readonly string[]).includes(k);

/**
 * The highest class `role` may be shown under `lock`: its `role_classes` entry, else `internal`. An entry that is no
 * class (a lock the load let through malformed) gives the lowest class, so that it shows less, never more.
 */
export function capOf(lock: Lock | undefined, role: string): DataClass {
  const classes = lock && isObj((lock as { role_classes?: Value }).role_classes ?? null) ? ((lock as { role_classes?: Obj }).role_classes as Obj) : undefined;
  if (!classes || !Object.hasOwn(classes, role)) return DEFAULT_CAP;
  const c = classes[role];
  return isClass(c) ? c : DATA_CLASSES[0]!;
}

/** A label from a class and a level as given, or undefined when either is not one the runtime knows. */
export function labelOf(cls: unknown, known: unknown): Label | undefined {
  return isClass(cls) && isKnown(known) ? { class: cls, known } : undefined;
}

/**
 * `value` as `cap` is shown it: masked when its class is above the cap, or when its class is not known (`label`
 * undefined) and the audience is a role; labelled either way. The audit audience sees the value.
 */
export function maskValue(value: Value, label: Label | undefined, cap: Cap): ShownValue {
  return hides(label, cap) ? maskedAs(label) : { masked: false, value, class: (label ?? UNKNOWN).class, known: (label ?? UNKNOWN).known };
}

/** Whether `cap` is not shown a value labelled `label`: one above the cap, or one whose class is not known, to a role. */
export function hides(label: Label | undefined, cap: Cap): boolean {
  return cap !== "audit" && (label === undefined || classRank(label.class) > classRank(cap));
}

/** The masked form of a value, or of a digest of values, labelled `label` (`UNKNOWN` when undefined). */
export function maskedAs(label: Label | undefined): MaskedValue {
  const l = label ?? UNKNOWN;
  return { masked: true, class: l.class, known: l.known };
}

/**
 * A digest computed over values labelled `label` (a wait's), as `cap` is given it: masked with them where the label
 * hides them, so no digest can be checked against a guess of what it is over. The one rule of every path a role is
 * given a digest by: a wait's request here, and the events, the role view and the list of waits by
 * `projection.ts` `maskDigest`.
 */
export function digestAs(label: Label | undefined, cap: Cap, v: Value): Value {
  return hides(label, cap) ? (maskedAs(label) as unknown as Value) : v;
}

// ── a wait's request ────────────────────────────────────────────────────

/**
 * The members of a wait's request that are the runtime's or the program's own, by the kind of the wait: who is
 * asked, until when, what it is about by name and digest. Every other member is a value the wait shows (a question's
 * text, a criterion's subject, an action's parameters, a change set's changes, a lead's reason, a fault an
 * escalation names), and is masked and labelled. A member this list does not name is masked: a new one is shown only
 * once it is added here.
 */
const PLAIN: Readonly<Record<string, ReadonlySet<string>>> = {
  input: new Set(["role", "options", "pause", "deadline"]),
  decision: new Set(["contract", "criterion", "role", "subject_digest", "deadline", "distinct_from", "criterion_path", "effect", "action_digest", "changeset", "component", "environment", "tier", "governance", "gate", "then"]),
  review: new Set(["subject_digest", "role", "escalate_to", "deadline", "deadline_ms", "escalated"]),
  amendment: new Set(["plan", "workflow", "lead", "from", "package", "role", "envelope", "diff", "changes", "deadline", "attention"]),
};

/**
 * The members of a request that are digests computed over the wait's values (`interp.ts`: a criterion's
 * `subject_digest` is over its subject, an action's `action_digest` over its parameters, a change set member's
 * `changeset` over the set's actions, a review's `subject_digest` over its items). Each is masked, as its wait's
 * values are, for a role the wait's label hides (`maskRequest`); otherwise it is shown as it is.
 */
export const DIGEST_MEMBERS: ReadonlySet<string> = new Set(["subject_digest", "action_digest", "changeset"]);

/** The members of a review's question (review.ts `Question`) that are the runtime's own; its items are read below. */
const REVIEW_PLAIN = new Set(["review", "contract", "map", "role", "escalate_to", "deadline_ms", "declined", "failed", "accepted"]);

/** The members of an open item of a review's question that are the runtime's own: its index and what it did not meet. */
const ITEM_PLAIN = new Set(["index", "unmet"]);

/** A value the wait shows, with where it stands in the request (`question`, `subject`, `question.items[0].value`, …). */
export type NamedShown = ShownValue & { name: string };

/** A value of a run of 0.1 to 0.6, which nothing labels: its class and level are not known, and it is not masked. */
export interface UnlabelledValue {
  name: string;
  value: Value;
  class: null;
  known: null;
}

/**
 * A wait's request as `cap` is shown it (0.7): the same members, each value the wait shows replaced by its
 * `ShownValue` under the wait's label (the facts give one class per question, the highest of what it shows, so a
 * masked wait masks every value of it), and the list of those values in the request's order. A review's question
 * keeps its items' indices and what they did not meet, and shows each item's value (and its digest) so.
 */
export function maskRequest(kind: string, request: Value, label: Label | undefined, cap: Cap): { request: Value; shown: NamedShown[] } {
  const shown: NamedShown[] = [];
  const one = (name: string, v: Value): Value => {
    const s = maskValue(v, label, cap);
    shown.push({ name, ...s });
    return s as unknown as Value;
  };
  // The wait's label is one for all it shows: when it hides a value, it hides every digest over its values too.
  return { request: splitRequest(kind, request, one, (v) => digestAs(label, cap, v)), shown };
}

/** The values a wait's request shows in a run of 0.1 to 0.6, as they are, unlabelled, by the same split as `maskRequest`. */
export function plainValues(kind: string, request: Value): UnlabelledValue[] {
  const out: UnlabelledValue[] = [];
  splitRequest(
    kind,
    request,
    (name, value) => {
      out.push({ name, value, class: null, known: null });
      return value;
    },
    (v) => v,
  );
  return out;
}

/** The request with each value it shows given to `one`, by the kind's split; anything that is no object is one value. */
function splitRequest(kind: string, request: Value, one: (name: string, v: Value) => Value, digest: (v: Value) => Value): Value {
  if (!isObj(request)) return one("request", request) as Value;
  const plain = PLAIN[kind] ?? new Set<string>();
  const out: Obj = {};
  for (const [k, v] of Object.entries(request)) {
    if (plain.has(k) && DIGEST_MEMBERS.has(k)) out[k] = digest(v);
    else if (plain.has(k)) out[k] = v;
    else if (kind === "review" && k === "question" && isObj(v)) out[k] = reviewQuestion(v, one);
    else out[k] = one(k, v) as Value;
  }
  return out;
}

function reviewQuestion(q: Obj, one: (name: string, v: Value) => Value): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(q)) {
    if (REVIEW_PLAIN.has(k)) out[k] = v;
    else if (k === "items" && Array.isArray(v)) {
      out[k] = v.map((item, i) => {
        if (!isObj(item)) return one(`question.items[${i}]`, item) as Value;
        const o: Obj = {};
        for (const [ik, iv] of Object.entries(item)) o[ik] = ITEM_PLAIN.has(ik) ? iv : (one(`question.items[${i}].${ik}`, iv) as Value);
        return o;
      });
    } else out[k] = one(`question.${k}`, v) as Value;
  }
  return out;
}

// ── a wait's facts ──────────────────────────────────────────────────────

/** What the facts say of one wait: the label of what it shows, its stage, what happens with no answer, and whom it escalates to. */
export interface WaitFacts {
  label: Label | undefined;
  stage: string | null;
  on_no_answer: string | null;
  escalates_to: string | null;
}

/** A site tag as a `wait_opened` records it, or undefined when it is none. */
export function siteOf(v: Value | undefined): SiteTag | undefined {
  if (!isObj(v ?? null)) return undefined;
  const s = v as Obj;
  if (typeof s["kind"] !== "string" || typeof s["path"] !== "string" || typeof s["wait"] !== "string") return undefined;
  return { kind: s["kind"] as SiteTag["kind"], path: s["path"], wait: s["wait"], ...(s["only"] === "budget_exceeded" ? { only: "budget_exceeded" as const } : {}) };
}

/**
 * The facts of the wait tagged `site`, from the facts in force where it was opened (`facts`): the row its tag names
 * (asks.ts `rowOf`; a review's escalation row once it was escalated, `escalated`). A row of the questions, of the
 * handler or of the plans gives the class and the level of what the wait shows; any other (an effect's row, which the
 * runtime's configuration hands to a person, has none), or none, gives no label, and the wait's values are masked.
 */
export function waitFacts(facts: AttentionFacts | undefined, site: SiteTag | undefined, escalated = false): WaitFacts {
  const none: WaitFacts = { label: undefined, stage: null, on_no_answer: null, escalates_to: null };
  if (!facts || !site) return none;
  const found = rowOf(facts, site, { escalation: escalated }) ?? (escalated ? rowOf(facts, site) : undefined);
  if (!found) return none;
  const row = found.row as unknown as Obj;
  const labelled = found.table === "questions" || found.table === "budget_exceeded" || found.table === "plans";
  const esc = isObj(row["escalates"] ?? null) ? (row["escalates"] as Obj) : undefined;
  return {
    label: labelled ? labelOf(row["shown"], row["known"]) : undefined,
    stage: typeof row["stage"] === "string" ? row["stage"] : null,
    on_no_answer: typeof row["on_no_answer"] === "string" ? row["on_no_answer"] : null,
    escalates_to: esc && typeof esc["to"] === "string" ? esc["to"] : null,
  };
}
