// An amendment of an envelope (0.4; spec/envelope.md "Amendments", N04).
//
// A lead asks for one with `request_amendment`: a new envelope for the run's
// workflow, and nothing else. The program with that envelope is a new
// program, and is checked as any program is. One rule is the amendment's
// own:
//
//   E1709  an amendment only widens: the new envelope holds every capability
//          the old one held, gives each budget dimension at least what it
//          gave and names no other, and bounds the run's delegations no more
//          tightly
//
// So what ran under the old envelope still lies inside the new one (INV-15),
// and a check that passed before the amendment passes after it. Who owns the
// envelope and who approves an effect may change: the owner is shown both as
// governance changes, like every other change the amendment makes.

import { diag, ptr, type Diagnostic } from "../diag.js";
import { BUDGET_DIMENSIONS, budgetAmount, type Budget, type Def, type Envelope } from "../ir/types.js";
import { classRank } from "../std/std.js";
import { capCovers, capsOf, showCap, type CapOptions } from "./caps.js";

/** A budget's amount in each dimension it names: `tokens`, `steps`, `agents`, `time` in milliseconds, `spend:<currency>` in micro-units. */
function amounts(b: Budget | undefined): Map<string, { field: string; amount: number }> {
  const out = new Map<string, { field: string; amount: number }>();
  for (const field of BUDGET_DIMENSIONS) {
    const amount = budgetAmount(b, field);
    if (amount !== undefined) out.set(field === "spend" ? `spend:${b!.spend!.currency}` : field, { field, amount });
  }
  return out;
}

/**
 * E1709: what `after` takes away from `before`, the envelope of `workflow`.
 * `defs` is every definition the program sees, read as `opts` says (its
 * language). Each diagnostic names the
 * dimension, what the envelope gave and what the amendment asks, so that a
 * lead can ask again for no less.
 */
export function narrowings(defs: Record<string, Def>, workflow: string, before: Envelope, after: Envelope, opts: CapOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = `${ptr("defs", workflow)}/envelope`;
  const no = (message: string, path: string, facts: Record<string, unknown>): void => void out.push(diag("E1709", message, { path }, { facts }));

  // Authority: every capability the envelope held lies inside one it holds now.
  const held = (after.caps ?? []).flatMap((c) => capsOf(defs, c, opts));
  for (const c of (before.caps ?? []).flatMap((e) => capsOf(defs, e, opts))) {
    if (held.some((w) => capCovers(w, c))) continue;
    no(`The amendment leaves out ${showCap(c)}, which the envelope holds. An amendment only widens: what ran under the envelope must still lie inside it.`, `${at}/caps`, {
      dimension: "capability",
      capability: showCap(c),
      asked: held.map(showCap),
    });
  }

  // The budget: the same dimensions, each with at least what it had. A dimension without an amount has no limit,
  // so naming a new one would add a limit, and leaving one out would leave the run's limit with nothing above it.
  const was = amounts(before.budget);
  const now = amounts(after.budget);
  for (const [dimension, b] of was) {
    const a = now.get(dimension);
    if (a === undefined) {
      no(`The amendment's budget names no ${dimension}, and the envelope gives ${b.amount}. An amendment names every dimension the envelope names.`, after.budget ? `${at}/budget` : at, { dimension, was: b.amount, asked: null });
    } else if (a.amount < b.amount) {
      no(`The amendment gives ${a.amount} ${dimension}, and the envelope gives ${b.amount}. An amendment only raises a budget.`, `${at}/budget/${a.field}`, { dimension, was: b.amount, asked: a.amount });
    }
  }
  for (const [dimension, a] of now) {
    if (was.has(dimension)) continue;
    no(`The amendment limits ${dimension} to ${a.amount}, and the envelope does not limit it. An amendment adds no limit.`, `${at}/budget/${a.field}`, { dimension, was: null, asked: a.amount });
  }

  // How many delegations at once, and how high a data class they may receive.
  const k0 = before.spawn?.max_concurrent;
  const k1 = after.spawn?.max_concurrent;
  if (k1 !== undefined && (k0 === undefined || k1 < k0)) {
    no(
      k0 === undefined ? `The amendment allows ${k1} delegations at once, and the envelope does not bound them. An amendment adds no bound.` : `The amendment allows ${k1} delegations at once, and the envelope allows ${k0}. An amendment only raises it.`,
      `${at}/spawn/max_concurrent`,
      { dimension: "max_concurrent", was: k0 ?? null, asked: k1 },
    );
  }
  const c0 = before.spawn?.max_class ?? "internal";
  const c1 = after.spawn?.max_class ?? "internal";
  if (classRank(c1) < classRank(c0)) {
    no(`The amendment allows a delegation at most ${c1} data, and the envelope allows ${c0}. An amendment only raises it.`, after.spawn?.max_class !== undefined ? `${at}/spawn/max_class` : at, { dimension: "max_class", was: c0, asked: c1 });
  }
  return out;
}
