// Run-time values. Everything a run journals is plain JSON, so values are
// JSON with a few reserved `$` keys:
//
//   { "$tag": "Confident", "$args": [ … ] }            union variant
//   { "$money": 18500000, "$currency": "USD" }           money (micro-units)
//   { "$verified": v, "$contract": "C", "$evidence": [ids] }
//                                                        a value that passed C
//
// Types were checked by the compiler; the runtime only keeps what it needs to
// enforce: which contract a value was verified against, and its evidence.

import { canonicalize, domainHash, type HashDomain, type Json } from "@mandate/compiler";

export type Value = null | boolean | number | string | Value[] | { [k: string]: Value };

export type Obj = { [k: string]: Value };

export function isObj(v: Value | undefined): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function tag(name: string, ...args: Value[]): Value {
  return args.length ? { $tag: name, $args: args } : { $tag: name };
}

export function tagOf(v: Value): { tag: string; args: Value[] } | undefined {
  if (isObj(v) && typeof v["$tag"] === "string") {
    const args = v["$args"];
    return { tag: v["$tag"], args: Array.isArray(args) ? args : [] };
  }
  return undefined;
}

export function verified(value: Value, contract: string, evidence: string[]): Value {
  return { $verified: value, $contract: contract, $evidence: evidence };
}

/** The value inside a Verified wrapper, or the value itself. */
export function unwrap(v: Value): Value {
  return isObj(v) && "$verified" in v ? (v["$verified"] as Value) : v;
}

/** Evidence ids a value carries, at any depth. */
export function evidenceOf(v: Value): string[] {
  const out: string[] = [];
  const walk = (x: Value): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x)) {
      if (Array.isArray(x["$evidence"])) out.push(...(x["$evidence"] as string[]));
      Object.values(x).forEach(walk);
    }
  };
  walk(v);
  return [...new Set(out)].sort();
}

/** Value with every Verified wrapper removed, for canonical parameters. */
export function plain(v: Value): Value {
  const u = unwrap(v);
  if (Array.isArray(u)) return u.map(plain);
  if (isObj(u)) return Object.fromEntries(Object.entries(u).map(([k, x]) => [k, plain(x)]));
  return u;
}

export function canonical(v: Value): string {
  return canonicalize(v as Json);
}

/** Domain-separated SHA-256 of a value's canonical JSON. */
export function digest(domain: HashDomain, v: Value): string {
  return domainHash(domain, v as Json);
}

export function money(micros: number, currency: string): Value {
  return { $money: micros, $currency: currency };
}

export function show(v: Value): string {
  const t = tagOf(v);
  if (t) return t.args.length ? `${t.tag}(${t.args.map(show).join(", ")})` : t.tag;
  if (isObj(v) && "$money" in v) return `${Number(v["$money"]) / 1_000_000} ${String(v["$currency"])}`;
  if (isObj(v) && "$verified" in v) return show(unwrap(v));
  if (typeof v === "string") return v;
  return canonical(v);
}

export function equal(a: Value, b: Value): boolean {
  return canonical(plain(a)) === canonical(plain(b));
}
