// The methods a contract's criteria use (§10). The interpreter picks a
// check's method here, and the checks of evidence read here which methods a
// criterion declares, so the two cannot differ: a record's method is one the
// program says, never one the record says.

import { calleePath, type Def, type Verifier } from "@mandate/bridge";
import { digest } from "./values.js";

/**
 * The id of the evidence record of one part of a criterion: from the run, the part's path in the program, its
 * method and its result. A verifier's attestation names the run and the part, so the checks of evidence compute
 * the id it stands for here, as the interpreter does.
 */
export function evidenceIdOf(run: string, part: string, method: string, passed: boolean): string {
  return digest("request", { run, criterion: part, method, passed });
}

/** A criterion satisfied by a person: `human.approve(…)` (§10). */
export function needsPerson(v: Verifier): boolean {
  return "call" in v && v.call.op === "call" && calleePath(v.call.callee) === "human.approve";
}

/**
 * The method of one part of a criterion, as its evidence record names it: `static` for a static part,
 * `human.approve` for a person's, and otherwise the verifier call's callee path.
 */
export function partMethod(v: Exclude<Verifier, { all: Verifier[] }>): string {
  if ("static" in v) return "static";
  if (needsPerson(v)) return "human.approve";
  return v.call.op === "call" ? (calleePath(v.call.callee) ?? "call") : "call";
}

/** The method of every part of a criterion, in order, once per part: an `all` declares each of its parts' methods. */
export function declaredMethods(v: Verifier): string[] {
  return "all" in v ? v.all.flatMap(declaredMethods) : [partMethod(v)];
}

/** The methods a contract's criterion declares, once per part; undefined when `c` is not a contract with that criterion. */
export function criterionMethods(c: Def | undefined, criterion: string): string[] | undefined {
  if (c?.kind !== "contract") return undefined;
  const k = Object.hasOwn(c.accept, criterion) ? c.accept[criterion] : c.invariant && Object.hasOwn(c.invariant, criterion) ? c.invariant[criterion] : undefined;
  return k ? declaredMethods(k.by) : undefined;
}

/**
 * The declared methods that `passed`, the methods of a criterion's passing records, leave without a record: each
 * method as many times as the criterion's parts use it, so one part's record never stands for another's.
 */
export function uncovered(declared: readonly string[], passed: readonly string[]): string[] {
  const have = new Map<string, number>();
  for (const m of passed) have.set(m, (have.get(m) ?? 0) + 1);
  const out: string[] = [];
  for (const m of declared) {
    const n = have.get(m) ?? 0;
    if (n > 0) have.set(m, n - 1);
    else out.push(m);
  }
  return out;
}
