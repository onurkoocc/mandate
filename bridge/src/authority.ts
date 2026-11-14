// The run-time authority decisions (decision 2 of the plan for 0.6): what a delegation is granted, what a narrowing
// at run time stands for, what each item of a `map` is handed and whether two items write the same place, and
// whether a map writes where a sub-program in flight may write. The interpreter makes no such decision itself: it
// evaluates, journals, waits and raises, and asks these four functions.
//
// Each function takes one plain JSON value and gives one back: objects, arrays, strings, numbers, booleans and null.
// None reads anything but its input, none changes its input, and the same input always gives the same output. The
// order of an object's members never carries meaning; the order of an array does where the contract says so. A
// capability value in an input or an output is a `CapVal` written as JSON (below), with an absent member for one
// the value does not have, never `null`.
//
// This is the reference the Rust port (`mandate-check/src/grant.rs`) is written and tested against. It is the code
// the interpreter ran in 0.5, moved here unchanged, over the same predicates of the compiler; their Rust
// counterparts are in `mandate-check/src/caps.rs` (`cap_covers`, `scope_within`, `writes_overlap`, `show_cap`).
//
// The predicates, as these functions use them:
//
//   covers(a, b)    capCovers: a and b have the same `ctor`; b's `scope` lies within a's (scopeWithin); when both
//                   have a `maxClass`, b's is no higher than a's (public < internal < confidential < restricted);
//                   when a has a `tier`, b has the same one (tiers are not ordered, and a capability without one
//                   allows any); when a has `argsPrefix`, b has some and each of b's extends one of a's; when a has
//                   `methods`, b has some and each of b's is one of a's.
//   within(c, i, o) scopeWithin, for constructor c, inner scope i, outer scope o: true when o is absent (unknown is
//                   unbounded); false when i is absent and o is not; otherwise every item of i lies inside some
//                   item of o. For a `ctor` starting with "fs." an item lies inside another by path segment: both are
//                   split at "/", empty and "." segments are dropped, ".." drops the segment before it (none at the
//                   root), and the outer's segments are a prefix of the inner's. Any other constructor compares
//                   items for equality.
//   overlap(a, b)   writesOverlap: both have `write: true` and the same `ctor`, and either scope is absent, or some
//                   item of a's scope and some item of b's are equal or, for "fs." constructors, one lies inside the
//                   other by segment (as above).
//   show(c)         showCap: `name = ` when c has a `name`, then `via → ` when it has a `via`, then `ctor`, then,
//                   when it has a `scope` (even an empty one) or `methods`, "(" + each scope item as JSON.stringify
//                   writes it, then `methods: [M, …]` when it has `methods`, joined by ", " + ")". It shows no
//                   `tier`, `maxClass` or `argsPrefix`.

import { capCovers, scopeWithin, showCap, writesOverlap, type CapVal, type Json } from "@mandate/compiler";

/**
 * A refusal: the fault the interpreter raises, `Fault(tag, args)`, whose message is made from the tag and the
 * arguments alone. The arguments are plain JSON.
 */
export interface Refusal {
  tag: string;
  args: Json[];
}

/**
 * Where a command stands, as far as authority goes.
 *
 * - `bounds`: what the workflow whose body is running holds, in the order it writes them: its envelope's `caps`
 *   (the envelope the command stands under, for a delegation) or its own, each as the capability values it stands
 *   for. The interpreter reads them from the program and the run's epoch; no coverage is decided in reading them.
 * - `given`: inside a map's body, each map around the item's `with caps`, outermost first, as `mapScopes` gave
 *   them; empty outside a map.
 * - `handed`: inside a map's body, what the maps around it hand each delegation of the body, as `mapScopes` gave
 *   it; empty outside a map.
 */
export interface AuthorityContext {
  bounds: CapVal[];
  given: CapVal[][];
  handed: CapVal[];
}

/**
 * avail(ctx) (C2): `bounds`, then for each list of `given` in order, the capabilities whose `ctor` some member of
 * that list has are taken out, and the list is appended. Its order is that, and carries no meaning to the
 * interpreter.
 */
function available(ctx: AuthorityContext): CapVal[] {
  let avail = ctx.bounds;
  for (const given of ctx.given) {
    const kinds = new Set(given.map((g) => g.ctor));
    avail = [...avail.filter((c) => !kinds.has(c.ctor)), ...given];
  }
  return avail;
}

export interface GrantInput {
  context: AuthorityContext;
  /**
   * The delegation to decide, or null to ask only what is available in the context.
   *
   * - `agent`: the agent's name, named in a refusal.
   * - `held`: what the agent declares it holds (its `caps`), as capability values, in its order.
   * - `remote`: whether the agent is remote: a remote agent is handed a map's `with caps` whatever it holds.
   * - `own`: the delegation's own `with caps`, evaluated (a narrowing at run time as `narrow` gave it), in order.
   */
  delegation: { agent: string; held: CapVal[]; remote: boolean; own: CapVal[] } | null;
}

/** A delegation `grant` decides. */
export type GrantDelegation = NonNullable<GrantInput["delegation"]>;

export type GrantOutput = { available: CapVal[] } | { granted: CapVal[] } | { refused: Refusal };

/**
 * What the capabilities in force grant (C2, §9.1; spec/envelope.md "map"): what is available in a context, or what
 * a delegation is granted in it. Replaces the interpreter's `available` and `grants`.
 *
 * With `delegation: null`: `{ available }`, avail(ctx) as above (`context.handed` is not read). The interpreter
 * reads the model tiers in it (one tier among them is a model call's), in no particular order.
 *
 * With a delegation, avail = avail(ctx), and a capability c is inside when some member a of avail covers it
 * (covers(a, c)):
 *
 * 1. Each member of `own`, in order: the first that is not inside is refused, with
 *    `{ refused: { tag: "PolicyDenied", args: [{ reason: "outside_authority", delegate: agent, capability: show(g) }] } }`.
 * 2. out = the members of `held` that are inside, in their order.
 * 3. given = `own`, then the members k of `context.handed` (in order) whose `ctor` no member of `own` has and that
 *    the agent holds at least as widely: `remote`, or covers(h, k) for some member h of `held`.
 * 4. When given is not empty: out = the members of out whose `ctor` no member of given has, then given.
 * 5. `{ granted: out }`, sorted by key, where the key of c is the JSON text (as JSON.stringify writes it) of
 *    `{"ctor": c.ctor}`, or `{"ctor": c.ctor, "scope": c.scope}` when c has a scope; keys compare by UTF-16 code
 *    unit. Members with the same key keep their order (the sort is stable). The order carries meaning: the
 *    interpreter derives the delegation's sandbox requirement and its agent loop's tier from it.
 *
 * The capability values in the output are those of the input, unchanged.
 */
export function grant(input: { context: AuthorityContext; delegation: null }): { available: CapVal[] };
export function grant(input: { context: AuthorityContext; delegation: GrantDelegation }): { granted: CapVal[] } | { refused: Refusal };
export function grant(input: GrantInput): GrantOutput;
export function grant(input: GrantInput): GrantOutput {
  const avail = available(input.context);
  const d = input.delegation;
  if (!d) return { available: avail };
  const inside = (c: CapVal): boolean => avail.some((a) => capCovers(a, c));
  let out = d.held.filter(inside);
  for (const g of d.own) {
    if (!inside(g)) return { refused: { tag: "PolicyDenied", args: [{ reason: "outside_authority", delegate: d.agent, capability: showCap(g) }] } };
  }
  const named = new Set(d.own.map((g) => g.ctor));
  const given = [...d.own, ...input.context.handed.filter((k) => !named.has(k.ctor) && (d.remote || d.held.some((a) => capCovers(a, k))))];
  if (given.length) {
    const kinds = new Set(given.map((g) => g.ctor));
    out = [...out.filter((c) => !kinds.has(c.ctor)), ...given];
  }
  const key = (c: CapVal): string => JSON.stringify(c.scope ? { ctor: c.ctor, scope: c.scope } : { ctor: c.ctor });
  return { granted: out.sort((a, b) => (key(a) < key(b) ? -1 : 1)) };
}

export interface NarrowInput {
  /** The one capability `c` of `c.narrow(…)`. */
  base: CapVal;
  /**
   * The values of the narrowing's arguments, in order, each as the interpreter evaluated it: a string, a list (whose
   * members are read one by one), or any other JSON value. While `complete` is false, the first ones only.
   */
  args: Json[];
  /**
   * Whether `args` holds every argument. The interpreter evaluates the arguments one at a time and asks after each
   * one with `complete: false`, so a refused value stops the evaluation where it stopped before; then once more,
   * with every argument and `complete: true`.
   */
  complete: boolean;
}

export type NarrowOutput = { caps: CapVal[] } | { partial: true } | { notText: number } | { refused: Refusal };

/**
 * `c.narrow(v…)` with a value known only at run time (C3, K68): c with the scope the values name, held to c. The
 * checker bounded it without knowing the values. Replaces the interpreter's `capsAt` for one base; what is not such
 * a narrowing, or narrows a capability that stands for several, is what the compiler reads it as statically.
 *
 * Each argument i in order, and each item s of it (its members when it is a list, else the argument itself), in
 * order; "files" is whether `base.ctor` starts with "fs.":
 *
 * 1. s not a string: `{ notText: i }`. The interpreter raises its `bad_scope` violation for argument i.
 * 2. files, and s holds `\`, `:` or the NUL character: refused, with
 *    `{ refused: { tag: "PolicyDenied", args: [{ reason: "outside_capability", capability: show(base), requested: [s] }] } }`.
 *    A host may read such a path another way than `within` does.
 * 3. files, s does not start with "/" and `base` has a scope: for each item b of `base.scope` in order, b without
 *    its trailing "/"s, then "/", then s, is added to the scope. Otherwise s is added as it is (a relative s under
 *    a base without a scope stays relative).
 *
 * Then, with `complete: false`, `{ partial: true }`. With `complete: true`: when the scope is not within(base.ctor,
 * scope, base.scope), refused with
 * `{ refused: { tag: "PolicyDenied", args: [{ reason: "outside_capability", capability: show(base), requested: scope }] } }`;
 * otherwise `{ caps: [n] }`, where n is `base` with `scope` the scope (in the order above) and `name`
 * `<base.name, or base.ctor when it has none>.narrow`.
 */
export function narrow(input: NarrowInput): NarrowOutput {
  const { base } = input;
  const scope: string[] = [];
  for (let i = 0; i < input.args.length; i++) {
    const v = input.args[i]!;
    const named = Array.isArray(v) ? v : [v];
    for (const s of named) {
      if (typeof s !== "string") return { notText: i };
      const files = base.ctor.startsWith("fs.");
      if (files && /[\\:\0]/.test(s)) return { refused: { tag: "PolicyDenied", args: [{ reason: "outside_capability", capability: showCap(base), requested: [s] }] } };
      if (files && !s.startsWith("/") && base.scope) scope.push(...base.scope.map((b) => `${b.replace(/\/+$/, "")}/${s}`));
      else scope.push(s);
    }
  }
  if (!input.complete) return { partial: true };
  if (!scopeWithin(base.ctor, scope, base.scope)) {
    return { refused: { tag: "PolicyDenied", args: [{ reason: "outside_capability", capability: showCap(base), requested: scope }] } };
  }
  return { caps: [{ ...base, scope, name: `${base.name ?? base.ctor}.narrow` }] };
}

export interface MapScopesInput {
  /** The map's path, named in a refusal. */
  map: string;
  /** How many items run side by side, at least 1. */
  par: number;
  /** The context the map stands in. */
  context: AuthorityContext;
  /**
   * Each item's `with caps`, evaluated (a narrowing at run time as `narrow` gave it), in the order of the map's list;
   * an empty list for an item, or every item, of a map without `with caps`. While `complete` is false, the first
   * items only.
   */
  items: CapVal[][];
  /**
   * Whether `items` holds every item. The interpreter evaluates the items' `with caps` one item at a time and asks
   * after each with `complete: false`, so an item outside the context stops the evaluation where it stopped before;
   * then once more, with every item and `complete: true`.
   */
  complete: boolean;
}

/** What one item of a map stands in: its context's `given` and `handed`, or null when it is the map's own. */
export type ItemScopes = { given: CapVal[][]; handed: CapVal[] } | null;

export type MapScopesOutput = { items: ItemScopes[]; writes: CapVal[][] } | { partial: true } | { refused: Refusal };

/**
 * The items of `map x in xs with caps K … { body }` before any is dispatched (spec/envelope.md "map", N03, C5): what
 * each item is handed, whether it lies inside the context, and, with `par > 1`, whether two items write the same
 * place. Replaces the interpreter's item loop of `map` and its overlap check.
 *
 * avail = avail(context). Each item i in order, with g = items[i]:
 *
 * 1. Each member c of g in order: when no member a of avail covers it (covers(a, c)), refused with
 *    `{ refused: { tag: "PolicyDenied", args: [{ reason: "outside_authority", map, item: i, capability: show(c) }] } }`.
 * 2. Its scopes: null when g is empty (the item stands in the map's context). Otherwise `given` is
 *    `context.given` with g appended, and `handed` is the members of `context.handed` whose `ctor` no member of g
 *    has, in order, then g.
 * 3. Its writes: the members of g with `write: true`, in order.
 *
 * Then, with `complete: false`, `{ partial: true }`. With `complete: true` and `par > 1`: the first pair, for i
 * ascending, then j > i ascending, then a over item i's writes in order, where some member of item j's writes
 * overlaps a (overlap(a, b), b the first such), is refused with
 * `{ refused: { tag: "Rejected", args: ["overlapping_scopes", { map, items: [i, j], left: show(a), right: show(b) }] } }`.
 * Otherwise `{ items, writes }`: each item's scopes and writes, in the order of `items`. Two maps that are not
 * nested (on two branches of a `par`, say) are never compared with each other.
 */
export function mapScopes(input: MapScopesInput): MapScopesOutput {
  const { map, context } = input;
  const outer = available(context);
  const items: ItemScopes[] = [];
  const writes: CapVal[][] = [];
  for (let i = 0; i < input.items.length; i++) {
    const given = input.items[i]!;
    for (const g of given) {
      if (!outer.some((a) => capCovers(a, g))) return { refused: { tag: "PolicyDenied", args: [{ reason: "outside_authority", map, item: i, capability: showCap(g) }] } };
    }
    if (given.length) {
      const kinds = new Set(given.map((g) => g.ctor));
      items.push({ given: [...context.given, given], handed: [...context.handed.filter((c) => !kinds.has(c.ctor)), ...given] });
    } else items.push(null);
    writes.push(given.filter((c) => c.write));
  }
  if (!input.complete) return { partial: true };
  if (input.par > 1) {
    for (let i = 0; i < writes.length; i++) {
      for (let j = i + 1; j < writes.length; j++) {
        for (const a of writes[i]!) {
          const b = writes[j]!.find((c) => writesOverlap(a, c));
          if (b) return { refused: { tag: "Rejected", args: ["overlapping_scopes", { map, items: [i, j], left: showCap(a), right: showCap(b) }] } };
        }
      }
    }
  }
  return { items, writes };
}

export interface InFlightOverlapInput {
  /** The map's path, named in the refusal and compared with each sub-program's command. */
  map: string;
  /** Each item's writes, as `mapScopes` gave them, in the order of the map's list. */
  writes: CapVal[][];
  /**
   * The sub-programs in flight, in the order the run's journal lists them: each by the command it was admitted as,
   * with what its workflow may write (its write capabilities, in order).
   */
  programs: Array<{ command: string; writes: CapVal[] }>;
}

export type InFlightOverlapOutput = { overlap: Refusal | null };

/**
 * C5 across the run, for a map: whether an item writes where a sub-program in flight may write. Replaces the
 * decision in the interpreter's `besidePrograms`; the interpreter keeps what is not one: the journal, which
 * records a refusal so that a resumed run and a replay read it, and a map the journal shows started, which is let
 * through when the run comes to it again.
 *
 * A sub-program whose command c is such that `map` starts with c + "/" is the one the map runs inside, and is left
 * out. Over the others: the first, for item i in order, then a over its writes in order, then each sub-program p
 * in order, where some member of p's writes overlaps a (overlap(a, b), b the first such), gives
 * `{ overlap: { tag: "Rejected", args: ["overlapping_scopes", { map, items: [i], left: show(a), right: show(b), program: p.command }] } }`,
 * the refusal the interpreter raises. None gives `{ overlap: null }`.
 */
export function inFlightOverlap(input: InFlightOverlapInput): InFlightOverlapOutput {
  const programs = input.programs.filter((p) => !input.map.startsWith(`${p.command}/`));
  for (const [i, held] of input.writes.entries()) {
    for (const a of held) {
      for (const p of programs) {
        const b = p.writes.find((c) => writesOverlap(a, c));
        if (!b) continue;
        return { overlap: { tag: "Rejected", args: ["overlapping_scopes", { map: input.map, items: [i], left: showCap(a), right: showCap(b), program: p.command }] } };
      }
    }
  }
  return { overlap: null };
}
