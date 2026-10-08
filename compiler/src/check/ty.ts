// Checker-side types and the epistemic assignability rules (Doc 4 §5.2).
//
// A value's type carries how it is known. Ordered from most to least trusted:
//
//   Verified<T, C>  <:  T  <:  Inferred<T>  <:  Untrusted<T>
//
// R1  Inferred<T> is not a T                               (E0210)
// R3  Verified<T> can be used wherever T is expected
// R4  critical effect parameters take only T or Verified<T> (E0210, E0211)
// R6  taint is contagious: fields, operators and records built from
//     Inferred parts stay Inferred until verified
// E0212: Verified<T, C> is accepted only where contract C is expected.
//
// `unknown` stands for a type the checker cannot see (an opaque import, an
// undescribed std call). It is compatible with everything, so missing
// knowledge never produces a false error.

import type { Def, TypeExpr } from "../ir/types.js";

export type Ty =
  | { k: "unknown" }
  | { k: "named"; name: string; args: Ty[] }
  | { k: "record"; fields: Record<string, Ty> };

export const UNKNOWN: Ty = { k: "unknown" };
export const named = (name: string, ...args: Ty[]): Ty => ({ k: "named", name, args });
export const BOOL = named("Bool");
export const TEXT = named("Text");

export type Level = "verified" | "plain" | "inferred" | "untrusted";
const LEVEL_RANK: Record<Level, number> = { verified: 0, plain: 1, inferred: 2, untrusted: 3 };

export interface Epistemic {
  level: Level;
  inner: Ty;
  /** For Verified<T, C>: the contract, when named. */
  contract?: string;
}

/** Peels Inferred/Untrusted/Verified wrappers; the weakest knowledge wins. */
export function epistemic(ty: Ty): Epistemic {
  let level: Level = "plain";
  let contract: string | undefined;
  let cur = ty;
  let sawVerified = false;
  for (;;) {
    if (cur.k !== "named") break;
    if (cur.name === "Inferred" || cur.name === "Untrusted") {
      const l: Level = cur.name === "Inferred" ? "inferred" : "untrusted";
      if (LEVEL_RANK[l] > LEVEL_RANK[level]) level = l;
      cur = cur.args[0] ?? UNKNOWN;
      continue;
    }
    if (cur.name === "Verified") {
      sawVerified = true;
      const c = cur.args[1];
      if (c && c.k === "named") contract = c.name;
      cur = cur.args[0] ?? UNKNOWN;
      continue;
    }
    break;
  }
  if (sawVerified && level === "plain") level = "verified";
  const out: Epistemic = { level, inner: cur };
  if (contract !== undefined && level === "verified") out.contract = contract;
  return out;
}

/** Wraps `inner` at `level`. */
export function withLevel(inner: Ty, level: Level, contract?: string): Ty {
  switch (level) {
    case "plain":
      return inner;
    case "inferred":
      return named("Inferred", inner);
    case "untrusted":
      return named("Untrusted", inner);
    case "verified":
      return contract ? named("Verified", inner, named(contract)) : named("Verified", inner);
  }
}

/** The weaker of two levels. Verified joined with plain is plain. */
export function joinLevel(a: Level, b: Level): Level {
  const r = Math.max(LEVEL_RANK[a], LEVEL_RANK[b], 1);
  return (Object.keys(LEVEL_RANK) as Level[]).find((l) => LEVEL_RANK[l] === r)!;
}

export function levelRank(l: Level): number {
  return LEVEL_RANK[l];
}

export function show(ty: Ty): string {
  switch (ty.k) {
    case "unknown":
      return "?";
    case "named":
      return ty.args.length ? `${ty.name}<${ty.args.map(show).join(", ")}>` : ty.name;
    case "record":
      return `{ ${Object.entries(ty.fields).map(([k, v]) => `${k}: ${show(v)}`).join(", ")} }`;
  }
}

export interface Problem {
  code: string;
  message: string;
}

/** Looks up local type definitions. */
export interface TypeEnv {
  typeDef(name: string): Extract<Def, { kind: "type" }> | undefined;
  isContract(name: string): boolean;
}

export function fromTypeExpr(t: TypeExpr, env: TypeEnv, generics: Map<string, Ty> = new Map()): Ty {
  if ("ref" in t) {
    if (t.ref === "?") return UNKNOWN;
    const g = generics.get(t.ref);
    if (g) return g;
    return named(t.ref, ...(t.args ?? []).map((a) => fromTypeExpr(a, env, generics)));
  }
  if ("record" in t) {
    const fields: Record<string, Ty> = {};
    for (const [k, v] of Object.entries(t.record)) fields[k] = fromTypeExpr(v, env, generics);
    return { k: "record", fields };
  }
  if ("refine" in t) return fromTypeExpr(t.refine, env, generics);
  return UNKNOWN;
}

/** Expands a local alias (`type X = Text`) to what it names; records, enums and unions stay nominal. */
export function unalias(ty: Ty, env: TypeEnv, depth = 0): Ty {
  if (ty.k !== "named" || depth > 16) return ty;
  const d = env.typeDef(ty.name);
  if (!d || d.generics) return ty;
  let te = d.type;
  while ("refine" in te) te = te.refine;
  if ("ref" in te) return unalias(fromTypeExpr(te, env), env, depth + 1);
  return ty;
}

/** Fields of a type, when the checker can see them. */
export function fieldsOf(ty: Ty, env: TypeEnv): Record<string, Ty> | undefined {
  const u = unalias(ty, env);
  if (u.k === "record") return u.fields;
  if (u.k === "named") {
    const d = env.typeDef(u.name);
    if (!d) return undefined;
    let te = d.type;
    while ("refine" in te) te = te.refine;
    if ("record" in te) {
      const generics = new Map<string, Ty>();
      (d.generics ?? []).forEach((g, i) => generics.set(g, u.args[i] ?? UNKNOWN));
      return (fromTypeExpr(te, env, generics) as { fields: Record<string, Ty> }).fields;
    }
  }
  return undefined;
}

const NUMERIC_WIDENING: Record<string, string[]> = { Int: ["Dec"] };

/**
 * Can a value of type `actual` be used where `expected` is required?
 * Returns undefined when it can, or the problem when it cannot.
 */
export function assignable(actual: Ty, expected: Ty, env: TypeEnv): Problem | undefined {
  if (actual.k === "unknown" || expected.k === "unknown") return undefined;
  const a = epistemic(actual);
  const e = epistemic(expected);

  if (e.level === "verified") {
    if (a.level !== "verified") {
      const how = e.contract ? ` against ${e.contract}` : "";
      return {
        code: a.level === "plain" ? "E0201" : a.level === "inferred" ? "E0210" : "E0211",
        message: `Expected ${show(expected)} but got ${show(actual)}; verify the value${how} first.`,
      };
    }
    if (e.contract && a.contract !== e.contract) {
      return {
        code: "E0212",
        message: `Expected a value verified against ${e.contract}, but this one was verified against ${a.contract ?? "an unnamed contract"}.`,
      };
    }
  } else if (levelRank(a.level) > levelRank(e.level)) {
    const code = a.level === "inferred" ? "E0210" : "E0211";
    const what = a.level === "inferred" ? "Model output" : "Untrusted content";
    return {
      code,
      message: `${what} of type ${show(actual)} cannot be used where ${show(expected)} is expected; verify it first.`,
    };
  }
  return sameShape(a.inner, e.inner, env, actual, expected);
}

function sameShape(a: Ty, e: Ty, env: TypeEnv, fullA: Ty, fullE: Ty): Problem | undefined {
  const ua = unalias(a, env);
  const ue = unalias(e, env);
  if (ua.k === "unknown" || ue.k === "unknown") return undefined;
  const mismatch = (): Problem => ({ code: "E0201", message: `Expected ${show(fullE)} but got ${show(fullA)}.` });
  if (ua.k === "named" && ue.k === "named") {
    if (ua.name !== ue.name && !(NUMERIC_WIDENING[ua.name] ?? []).includes(ue.name)) return mismatch();
    const n = Math.min(ua.args.length, ue.args.length);
    for (let i = 0; i < n; i++) {
      const p = assignable(ua.args[i]!, ue.args[i]!, env);
      if (p) return p.code === "E0201" ? mismatch() : p;
    }
    return undefined;
  }
  const fa = fieldsOf(ua, env);
  const fe = fieldsOf(ue, env);
  if (fa && fe) {
    for (const [k, v] of Object.entries(fe)) {
      if (!(k in fa)) return mismatch();
      const p = assignable(fa[k]!, v, env);
      if (p) return p;
    }
    return undefined;
  }
  return mismatch();
}

/** True when the type mentions a name from `names` anywhere. */
export function mentions(ty: Ty, names: Set<string>): string | undefined {
  if (ty.k === "named") {
    if (names.has(ty.name)) return ty.name;
    for (const a of ty.args) {
      const m = mentions(a, names);
      if (m) return m;
    }
  } else if (ty.k === "record") {
    for (const v of Object.values(ty.fields)) {
      const m = mentions(v, names);
      if (m) return m;
    }
  }
  return undefined;
}
