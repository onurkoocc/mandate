// Static capability values (Doc 4 §7): what a capability authorizes and over
// which scope, how narrowing works (C3), and whether write scopes overlap (C5).

import type { Arg, Expr } from "../ir/types.js";
import { CAP_CTORS, DEFAULT_MODEL_MAX_CLASS, DATA_CLASSES, type DataClass } from "../std/std.js";

export interface CapVal {
  /** The capability's name when it comes from a `capability` definition. */
  name?: string;
  /** Constructor, e.g. `fs.write`. */
  ctor: string;
  /** Authorized effect: `Fs.Write`, `Model`, or a namespace such as `git.*`. */
  effect: string;
  write: boolean;
  /** Paths, hosts, commands or repositories; undefined means not statically known (treated as unbounded). */
  scope?: string[];
  /** For model.infer: the highest data class it may receive. */
  maxClass?: DataClass;
  /** For model.infer: the model tier, e.g. `standard`. */
  tier?: string;
  /** For exec: the argument prefixes a command may start with. */
  argsPrefix?: string[][];
}

/** Dotted path of a callee such as `fs.read` or `git.pr`, if it is one. */
export function calleePath(e: Expr): string | undefined {
  if (e.op === "var") return e.name;
  if (e.op === "field") {
    const base = calleePath(e.of);
    return base === undefined ? undefined : `${base}.${e.name}`;
  }
  return undefined;
}

function literalStrings(e: Expr): string[] | undefined {
  if (e.op === "text") return [e.value];
  if (e.op === "list") {
    const out: string[] = [];
    for (const i of e.items) {
      const s = literalStrings(i);
      if (!s) return undefined;
      out.push(...s);
    }
    return out;
  }
  return undefined;
}

function symbol(e: Expr): string | undefined {
  return e.op === "var" ? e.name : e.op === "text" ? e.value : undefined;
}

/**
 * Evaluates a capability constructor call such as `fs.write("/work/repo/src")`.
 * Returns undefined when the expression is not a known constructor.
 */
export function capFromCall(e: Expr): CapVal | undefined {
  if (e.op !== "call") return undefined;
  const ctor = calleePath(e.callee);
  if (!ctor) return undefined;
  const spec = CAP_CTORS[ctor];
  if (!spec) return undefined;
  const cap: CapVal = { ctor, effect: spec.effect, write: spec.write };
  const named = (n: string): Arg | undefined => e.args.find((a) => a.name === n);
  switch (spec.scope) {
    case "positional": {
      const pos = e.args.filter((a) => a.name === undefined);
      const vals = pos.map((a) => literalStrings(a.value));
      if (pos.length && vals.every((v) => v !== undefined)) cap.scope = vals.flat() as string[];
      break;
    }
    case "hosts": {
      const h = named("hosts");
      const v = h && literalStrings(h.value);
      if (v) cap.scope = v;
      break;
    }
    case "commands": {
      const c = named("commands");
      const v = c && literalStrings(c.value);
      if (v) cap.scope = v;
      const p = named("args_prefix");
      if (p && p.value.op === "list") {
        const prefixes = p.value.items.map((i) => (i.op === "list" ? literalStrings(i) : undefined));
        if (prefixes.every((x) => x !== undefined)) cap.argsPrefix = prefixes as string[][];
      }
      break;
    }
  }
  if (ctor === "model.infer") {
    const m = named("max_class");
    const s = m && symbol(m.value);
    cap.maxClass = s && (DATA_CLASSES as string[]).includes(s) ? (s as DataClass) : DEFAULT_MODEL_MAX_CLASS;
    const t = named("tier");
    const tier = t && symbol(t.value);
    if (tier) cap.tier = tier;
  }
  return cap;
}

/** Normalizes an absolute path into segments; `..` and `.` are resolved, trailing slashes dropped. */
export function segments(path: string): string[] {
  const out: string[] = [];
  for (const s of path.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out;
}

/** True when path `inner` lies at or below `outer`, segment by segment (not by string prefix). */
export function within(inner: string, outer: string): boolean {
  const a = segments(inner);
  const b = segments(outer);
  return b.length <= a.length && b.every((s, i) => a[i] === s);
}

export function pathsOverlap(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function scopeItemWithin(ctor: string, item: string, outer: string): boolean {
  return ctor.startsWith("fs.") ? within(item, outer) : item === outer;
}

/** C3: every item of `inner` lies inside some item of `outer`. Unknown scopes are not provably inside. */
export function scopeWithin(ctor: string, inner: string[] | undefined, outer: string[] | undefined): boolean {
  if (outer === undefined) return true;
  if (inner === undefined) return false;
  return inner.every((i) => outer.some((o) => scopeItemWithin(ctor, i, o)));
}

/** Every argument prefix in `inner` extends one in `outer`. No prefixes means any arguments. */
export function prefixesWithin(inner: string[][] | undefined, outer: string[][] | undefined): boolean {
  if (outer === undefined) return true;
  if (inner === undefined) return false;
  return inner.every((p) => outer.some((o) => o.length <= p.length && o.every((s, i) => p[i] === s)));
}

/** Does `cap` authorize everything `need` authorizes? */
export function capCovers(cap: CapVal, need: CapVal): boolean {
  if (cap.ctor !== need.ctor) return false;
  if (!scopeWithin(cap.ctor, need.scope, cap.scope)) return false;
  if (need.maxClass && cap.maxClass && DATA_CLASSES.indexOf(need.maxClass) > DATA_CLASSES.indexOf(cap.maxClass)) return false;
  // Tiers are not ordered: a capability without a tier allows any, one with a tier allows only that one.
  if (cap.tier !== undefined && need.tier !== cap.tier) return false;
  if (!prefixesWithin(need.argsPrefix, cap.argsPrefix)) return false;
  return true;
}

/** Does `cap` authorize effect `effect`, optionally over `scope`? */
export function capAuthorizes(cap: CapVal, effect: string, scope?: string[]): boolean {
  if (cap.effect.endsWith(".*")) {
    if (!effect.startsWith(cap.effect.slice(0, -1))) return false;
  } else if (cap.effect !== effect) {
    return false;
  }
  return scope === undefined || scopeWithin(cap.ctor, scope, cap.scope);
}

/** C5: two write capabilities whose scopes intersect. Unknown scopes are assumed to overlap. */
export function writesOverlap(a: CapVal, b: CapVal): boolean {
  if (!a.write || !b.write || a.ctor !== b.ctor) return false;
  if (a.scope === undefined || b.scope === undefined) return true;
  const fs = a.ctor.startsWith("fs.");
  return a.scope.some((x) => b.scope!.some((y) => (fs ? pathsOverlap(x, y) : x === y)));
}

export function showCap(c: CapVal): string {
  const scope = c.scope ? `(${c.scope.map((s) => JSON.stringify(s)).join(", ")})` : "";
  return `${c.name ? `${c.name} = ` : ""}${c.ctor}${scope}`;
}
