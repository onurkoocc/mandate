// The methods a contract's criteria use (§10). The interpreter picks a
// check's method here, and the checks of evidence read here which methods a
// criterion declares, so the two cannot differ: a record's method is one the
// program says, never one the record says.

import { calleePath, type ContractDef, type Verifier } from "@mandate/compiler";

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

/** The methods a contract's criterion declares, once per part; undefined when the contract has no such criterion. */
export function criterionMethods(c: ContractDef, criterion: string): string[] | undefined {
  const k = Object.hasOwn(c.accept, criterion) ? c.accept[criterion] : c.invariant && Object.hasOwn(c.invariant, criterion) ? c.invariant[criterion] : undefined;
  return k ? declaredMethods(k.by) : undefined;
}
