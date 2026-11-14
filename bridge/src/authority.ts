// The run-time authority decisions (decision 2 of the plan for 0.6): what a delegation is granted, what a narrowing
// at run time stands for, what each item of a `map` is handed and whether two items write the same place, and
// whether a map writes where a sub-program in flight may write. The interpreter makes no such decision itself: it
// evaluates, journals, waits and raises, and asks these four functions.
//
// Each function takes one plain JSON value and gives one back: objects, arrays, strings, numbers, booleans and null.
// None reads anything but its input, none changes its input, and the same input always gives the same output. The
// order of an object's members never carries meaning; the order of an array does where the contract says so. A
// capability value in an input or an output is a `CapVal` written as JSON (below), with an absent member for one
// the value does not have, never `null`. An input with a `null` where the contract says a member is absent or has
// a type, or with a member of another type than the contract gives, is outside the contract: the TypeScript may
// throw or answer anything there, and a port is not held to it.
//
// A `CapVal` has `ctor` (a string, the constructor, e.g. "fs.write"), `effect` (a string), `write` (a boolean),
// and, each perhaps absent: `scope` (strings), `maxClass` (a data class name), `tier` (a string), `argsPrefix`
// (lists of strings), `methods` (strings), `name`, `via`, `root` (strings), `components` (strings). Members not
// named in a rule below are carried along unread, unknown ones included.
//
// This is the reference the Rust port (`mandate-check/src/grant.rs`) is written and tested against. It is the code
// the interpreter ran in 0.5, moved here unchanged, over the same predicates of the compiler; their Rust
// counterparts are in `mandate-check/src/caps.rs` (`cap_covers`, `scope_within`, `writes_overlap`, `show_cap`).
// The recorded cases (bridge/test/authority-cases.json) are this implementation's own outputs. That it decides as
// the 0.5 interpreter did rests on the code having been moved and not changed, and on the runtime's tests, which
// pass unchanged over it; the cases hold a port to this implementation, not to the interpreter.
//
// The predicates, as these functions use them. "Present" means the member is there, whatever its value: an empty
// list or string is present. Strings compare by exact UTF-16 code unit, with no case folding or normalization.
//
//   covers(a, b)    capCovers. It reads `ctor`, `scope`, `maxClass`, `tier`, `argsPrefix` and `methods`, and no
//                   other member: `write`, `effect`, `name`, `via`, `root`, `components` and any unknown member may
//                   differ. b is covered when all of these hold:
//                   - a.ctor equals b.ctor;
//                   - within(a.ctor, b.scope, a.scope);
//                   - data class: when both `maxClass` are truthy (an empty string is not), the rank of b's is not
//                     above the rank of a's, where the rank is the index in [public, internal, confidential,
//                     restricted] and -1 for any other name: an unknown class ranks below public and equal to every
//                     other unknown class, so an unknown outer class covers only unknown inner ones, and an unknown
//                     inner class is covered by every outer one;
//                   - tier: when a's `tier` is present (even ""), b's is present and equal to it; when a has none,
//                     b's tier is not read (tiers are not ordered, and a capability without one allows any);
//                   - argument prefixes: when a's `argsPrefix` is present, b's is present (an empty list is), and
//                     each of b's prefixes extends one of a's: a's prefix is no longer, and equals b's prefix over
//                     its length, element by element (equal lists included; an empty prefix of a extends to all);
//                   - methods: when a's `methods` is present, b's is present (an empty list is), and each of b's is
//                     one of a's.
//   within(c, i, o) scopeWithin, for constructor c, inner scope i, outer scope o: true when o is absent (unknown is
//                   unbounded); otherwise false when i is absent; otherwise every item of i lies inside some item of
//                   o (so an empty i lies inside anything present, and an empty o holds no item). For a `ctor`
//                   starting with "fs." an item lies inside another by path segment. Each path is split at "/";
//                   from left to right, an empty or "." segment is dropped, ".." drops the last segment kept so far
//                   (nothing when none is kept, so ".." at the root stays at the root), and any other segment is
//                   kept. A relative path is read as if it began at the root. The inner item lies inside the outer
//                   one when the outer's kept segments are a prefix of the inner's, segment by segment, by exact
//                   code units. `\`, `:` and NUL are ordinary characters here. Any other constructor compares items
//                   for exact equality.
//   overlap(a, b)   writesOverlap: `write` is read by truthiness, and both must be truthy; a.ctor equals b.ctor;
//                   then, when either scope is absent, they overlap; otherwise some item of a's scope and some item
//                   of b's are equal or, for a `ctor` starting with "fs.", one lies inside the other by segment (as
//                   in within). Two empty scopes do not overlap; an empty scope overlaps an absent one.
//   show(c)         showCap: `<name> = ` when `name` is truthy (not empty), then `<via> → ` when `via` is truthy,
//                   then `ctor`, then, when `scope` is present (even empty) or `methods` is present,
//                   "(" + the scope items, each as JSON.stringify writes it, then `methods: [M, …]` with the methods
//                   written as they are and joined by ", ", all joined by ", " + ")". It shows no `tier`,
//                   `maxClass` or `argsPrefix`.

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
   * - `remote`: whether the agent is remote: a remote agent is handed a map's `with caps` whatever it holds (step
   *   3). Nothing else differs: its `own` and its `held` are held to the context as any agent's are.
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
 * 2. out = the members of `held` that are inside, in their order: inside avail, which inside a map is what the
 *    item was given, not the workflow's `bounds`.
 * 3. given = `own`, then the members k of `context.handed` (in order) whose `ctor` no member of `own` has and that
 *    the agent holds at least as widely: `remote`, or covers(h, k) for some member h of `held`.
 * 4. When given is not empty: out = the members of out whose `ctor` no member of given has, then given. So a held
 *    capability of a kind the map hands is replaced by what is handed, even one that is narrower.
 * 5. `{ granted: out }`, sorted by key, where the key of c is the JSON text (as JSON.stringify writes it, with no
 *    space and with its escapes) of `{"ctor":c.ctor}`, or of `{"ctor":c.ctor,"scope":c.scope}` when c's scope is
 *    present, an empty one included (`{"ctor":"fs.write","scope":[]}`). Keys compare as whole strings by UTF-16
 *    code unit, not item by item, not by UTF-8 byte or code point. Members with the same key keep their order
 *    among themselves. The TypeScript gets that from the engine: its comparator answers "before" or "after" and
 *    never "equal", and the engine's sort is stable, so a port must use a stable sort (the cases hold it to this,
 *    beyond the length at which an engine stops sorting by insertion). The order carries meaning: the interpreter
 *    derives the delegation's sandbox requirement and its agent loop's tier from it.
 *
 * Nothing is de-duplicated: a capability held, given or handed twice is granted twice. The capability values in
 * the output are those of the input, unchanged, every member kept.
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
 * order, the first problem met deciding; "files" is whether `base.ctor` starts with "fs." (the dot included):
 *
 * 1. s not a string: `{ notText: i }`. The interpreter raises its `bad_scope` violation for argument i. A list is
 *    opened one level only: a list inside a list is a member that is not a string, and so is null. This is decided
 *    while `complete` is false too, as soon as the argument is there.
 * 2. files, and s holds `\`, `:` or the NUL character anywhere, absolute or relative: refused, with
 *    `{ refused: { tag: "PolicyDenied", args: [{ reason: "outside_capability", capability: show(base), requested: [s] }] } }`.
 *    A host may read such a path another way than `within` does. Also decided while `complete` is false.
 * 3. files, s does not start with "/" and `base.scope` is present (an empty one included): for each item b of
 *    `base.scope` in order, b without its trailing "/"s, then "/", then s, is added to the scope; under an empty
 *    base scope nothing is added. Otherwise s is added as it is (a relative s under a base without a scope stays
 *    relative, and so does any s of a constructor that is not "fs.").
 *
 * Then, with `complete: false`, `{ partial: true }`: nothing else is decided, `within` included. With `complete:
 * true`: when the scope is not within(base.ctor, scope, base.scope), refused with
 * `{ refused: { tag: "PolicyDenied", args: [{ reason: "outside_capability", capability: show(base), requested: scope }] } }`;
 * otherwise `{ caps: [n] }`, where n is `base` with every member kept, `scope` the scope (in the order above) and
 * `name` `<base.name>.narrow`, or `<base.ctor>.narrow` when `name` is absent (an empty name is kept, giving
 * ".narrow").
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
 *    Every item given is checked, with `complete` false or true, the earlier items again included: the first
 *    item, in order, with a member outside decides.
 * 2. Its scopes: null when g is empty (the item stands in the map's context). Otherwise `given` is
 *    `context.given` with g appended, and `handed` is the members of `context.handed` whose `ctor` no member of g
 *    has, in order, then g.
 * 3. Its writes: the members of g whose `write` is truthy, in order.
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
 * out; one whose command equals `map`, or is a prefix of it without the "/", is not. The members of `writes` and
 * of a sub-program's writes are compared with overlap, which reads their `write` too: a member whose `write` is
 * not truthy overlaps nothing. Over the others: the first, for item i in order, then a over its writes in order,
 * then each sub-program p in order, where some member of p's writes overlaps a (overlap(a, b), b the first such),
 * gives `{ overlap: { tag: "Rejected", args: ["overlapping_scopes", { map, items: [i], left: show(a), right: show(b), program: p.command }] } }`,
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
