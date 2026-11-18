// `asks` at run time (spec/attention.md "`asks` at run time", "The attention bound"; language 0.7).
//
// A run of 0.7 may declare `asks: N`, the most questions it puts to people. This module holds what the journal, the
// interpreter, the runtime and the test hook read in common:
//
// - SITE_KINDS, the closed list of kinds a question has (the compiler's `SiteKind`): every wait the runtime opens for a
//   person in a run of 0.7 carries a site tag (`SiteTag`) of one of them, its static site;
// - the limit (`asksLimit`): the declared `asks` and the caller's `--limit asks=N` taken together as every other limit
//   is, the smaller of the two;
// - the bound under the runtime's configuration (`boundUnder`): the static total of the facts, plus the multiplicity
//   of every effect site the configuration hands to a person and the static total does not count;
// - the row of the facts a tag names (`rowOf`), which the hook holds every wait to.
//
// Nothing here writes: the count is kept by the journal, in the transaction that opens a wait (journal.ts `openWait`).

import type { AttentionCount, AttentionEffect, AttentionFacts, AttentionPlan, AttentionQuestion, AttentionSiteKind } from "@mandate/bridge";
import type { AuthorizePolicy } from "./interp.js";

/** The dimension of a run's budget that is its `asks` (spec/attention.md "`asks`"): the runtime's own, not the compiler's. */
export const ASKS = "asks";

/**
 * The kinds of question, one for each row of spec/attention.md "What counts as a question": a closed list, the
 * compiler's (`SiteKind` in crates/mandate-check/src/asks.rs). The test of the sources holds every wait the runtime
 * opens to carry one of these.
 */
export const SITE_KINDS: readonly AttentionSiteKind[] = ["verify", "ask", "escalate", "pause", "supervise_escalate", "effect", "changeset", "governance", "review", "plan"];

/** The most escalations `supervise escalate` makes for one delegation (the compiler's `SUPERVISE_ESCALATIONS`). */
export const SUPERVISE_ESCALATIONS = 5;

/**
 * The static site of a wait (spec/attention.md "The static form of a wait"): its kind, the IR path of the construct
 * that opens it in the program the interpreter runs (a function's site under `/defs/f/…`, a contract's under
 * `/defs/C/…`, a sub-program's in its own program), and the wait in its static form: that path and the part the
 * runtime adds for the wait it opens there. A wait of the `on budget_exceeded` handler, or the pause it falls back
 * to, is marked `only: "budget_exceeded"`: it is not counted, and recurs once per budget episode.
 */
export interface SiteTag {
  kind: AttentionSiteKind;
  path: string;
  wait: string;
  only?: "budget_exceeded";
}

/**
 * What a wait's opening counts against (journal.ts `openWait`): the run's own reservation for its program's
 * questions (`parent`), a sub-program's reservation (`program`, by its command), or what is left of the run's `asks`
 * (`left`: a lead's amendment request). A run without an `asks` limit counts nothing.
 */
export type AskFrom = { from: "parent" } | { from: "program"; program: string } | { from: "left" };

/** What `openWait` is told of a wait for a person in a run of 0.7: its tag, and what it counts against (none: not counted). */
export interface AskSite {
  tag: SiteTag;
  count?: AskFrom;
}

/** The command id a run's own reservation of `asks` is kept under (the `reservations` row of the run's workflow). */
export function parentReservation(workflow: string): string {
  return `/defs/${workflow}`;
}

/** The refusal's tag and argument of a question past the run's `asks`, or past a sub-program's reservation. */
export const ASKS_EXHAUSTED = "asks_exhausted";

/**
 * The run's `asks` limit (spec/attention.md "The limit"): the declared value and the caller's, taken together as every
 * other limit is (`minLimits`): only one, that one; both, the smaller; neither, none.
 */
export function asksLimit(declared: number | null | undefined, caller: number | undefined): number | undefined {
  const d = typeof declared === "number" ? declared : undefined;
  if (d === undefined) return caller;
  return caller === undefined ? d : Math.min(d, caller);
}

/** `a + b` of the bound's counts. */
export function plus(a: AttentionCount, b: AttentionCount): AttentionCount {
  return a === "unbounded" || b === "unbounded" ? "unbounded" : a + b;
}

/** Whether the configuration hands an effect to a person: `StartRun`'s `authorize` names it `by: human`. */
export function handsToPerson(authorize: Record<string, AuthorizePolicy> | undefined, effect: string): boolean {
  return !!authorize && Object.hasOwn(authorize, effect) && authorize[effect]?.by === "human";
}

/**
 * The effect sites the configuration hands to a person and the static total does not count (spec/attention.md
 * "Effects and the runtime's configuration"): `counted: false`, no batch commit step (which never asks a person, and
 * whose effect a configuration may not hand to one: `person_in_map`), and named `by: human` in `authorize`.
 */
export function addedEffects(facts: AttentionFacts, authorize: Record<string, AuthorizePolicy> | undefined): AttentionEffect[] {
  return (facts.effects ?? []).filter((e) => !e.counted && !e.batch && handsToPerson(authorize, e.effect));
}

/**
 * The bound under the runtime's configuration: the static total of the facts plus the multiplicity of each effect
 * site `addedEffects` gives. A sum, so it is sound and not tight. Undefined for facts that give no total.
 */
export function boundUnder(facts: AttentionFacts, authorize: Record<string, AuthorizePolicy> | undefined): AttentionCount | undefined {
  const total = facts.totals?.questions;
  if (total !== "unbounded" && (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)) return undefined;
  return addedEffects(facts, authorize).reduce<AttentionCount>((n, e) => plus(n, e.multiplicity), total);
}

/**
 * What a lead's sub-program's admission reserves of the run's `asks` (spec/attention.md "Sub-programs and amendments";
 * D4 of slice B3): its declared `asks`, else its static total, plus the effect sites the run's configuration hands to
 * a person and its static total does not count. Undefined for facts that give no total.
 */
export function reservationOf(facts: AttentionFacts, authorize: Record<string, AuthorizePolicy> | undefined): AttentionCount | undefined {
  const declared = typeof facts.asks === "number" ? facts.asks : undefined;
  const added = addedEffects(facts, authorize).reduce<AttentionCount>((n, e) => plus(n, e.multiplicity), 0);
  if (declared !== undefined) return plus(declared, added);
  return boundUnder(facts, authorize);
}

/** The row of the facts a tag names, and the table it is in. */
export type Row = { table: "questions"; row: AttentionQuestion } | { table: "effects"; row: AttentionEffect } | { table: "plans"; row: AttentionPlan } | { table: "budget_exceeded"; row: AttentionQuestion };

/**
 * The row of `facts` that a wait tagged `tag` stands for (D1 of slice B3, and the rule for effects under the
 * runtime's configuration):
 *
 * - an approval (`verify`): the row of its static wait, one per `human.approve` a criterion holds;
 * - a review: the row of its path, `only: on_escalation` for its escalation (`escalation`);
 * - the owner's gate of an effect (`governance`): the governance row of the effect's static path, whichever suffix
 *   its wait has;
 * - an authorization by a role (`effect`, `changeset`: a member's or the set's): the question row of its static path
 *   when the static total counts it, else its `effects` row (an effect's, or a change set member's), `counted: false`,
 *   which the configuration must hand to a person (`authorize`); a change set's own approval is always counted;
 * - a lead's amendment request (`plan`): the row of its `plan`, by its path and, where the row gives it, its wait;
 * - any other: the row of its kind and static wait.
 *
 * A wait of the `on budget_exceeded` handler is found among the handler's rows by the same rules.
 */
export function rowOf(facts: AttentionFacts, tag: SiteTag, o: { escalation?: boolean; authorize?: Record<string, AuthorizePolicy> } = {}): Row | undefined {
  const handler = tag.only === "budget_exceeded";
  const qs = (handler ? facts.budget_exceeded : facts.questions) ?? [];
  const table = handler ? "budget_exceeded" : "questions";
  const of = (row: AttentionQuestion | undefined): Row | undefined => (row ? ({ table, row } as Row) : undefined);
  switch (tag.kind) {
    case "verify":
      return of(qs.find((q) => q.kind === "verify" && q.wait === tag.wait));
    case "review":
      return of(qs.find((q) => q.kind === "review" && q.path === tag.path && (q.only ?? null) === (o.escalation ? "on_escalation" : null)));
    case "governance":
      return of(qs.find((q) => q.kind === "governance" && q.path === tag.path));
    case "effect":
    case "changeset": {
      const counted = qs.find((q) => q.kind === tag.kind && q.path === tag.path);
      if (counted) return of(counted);
      // An effect the static total does not count asks a person only when the configuration hands it to one. The
      // handler's rows hold no effect sites of their own: there, only a counted row names it.
      const e = handler ? undefined : (facts.effects ?? []).find((x) => x.path === tag.path && !x.counted && !x.batch);
      if (e && handsToPerson(o.authorize, e.effect)) return { table: "effects", row: e };
      return undefined;
    }
    case "plan": {
      const p = (facts.plans ?? []).find((x) => x.path === tag.path && (typeof x["wait"] !== "string" || x["wait"] === tag.wait));
      return p ? { table: "plans", row: p } : undefined;
    }
    default:
      return of(qs.find((q) => q.kind === tag.kind && q.wait === tag.wait));
  }
}

/**
 * The IR path of the node a command path stands at, within one definition: without what a run adds to it, a loop's
 * iteration (`@i`), a restarted `par` round (`#allN`) and a map's item (`[i]`).
 */
export function staticPath(path: string): string {
  return path.replace(/@\d+|#all\d+|\[\d+\]/g, "");
}
