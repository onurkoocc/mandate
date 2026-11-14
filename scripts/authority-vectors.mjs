#!/usr/bin/env node
// Writes vectors/authority/cases.json: generated cases of the four run-time
// authority decisions of bridge/src/authority.ts (grant, narrow, mapScopes,
// inFlightOverlap), each an input and the output the built TypeScript gives,
// so that the Rust port (crates/mandate-check/src/grant.rs) is held to them
// beyond the recorded cases of bridge/test/authority-cases.json. The Rust
// test crates/mandate-check/tests/authority.rs gives each input to the door of
// its function and compares the output.
//
//   npm ci --ignore-scripts && npm run build    (once: it reads bridge/dist)
//   node scripts/authority-vectors.mjs           (what CI runs)
//
// The cases come from a generator written here, seeded with SEED below, with
// no Math.random and no clock: running the script again writes the same
// bytes, and CI fails when the file changes. The generator is aimed at the
// places a port goes wrong rather than spread evenly: scopes are made of a
// small alphabet of path segments (".", "..", empty segments, trailing
// slashes, relative paths, non-ASCII and astral characters, "\", ":" and
// NUL), so that containment and overlap actually happen; every kind of
// capability, with and without each member, and with the members a
// predicate reads by truthiness given values that are falsy or not booleans;
// capabilities derived from what the context holds, so that a fair share are
// inside it; layered `given` and `handed`; remote and local agents; granted
// lists long enough to exercise the sort with equal keys (some of 64 members
// and more); narrowing arguments of every JSON type at every position; maps
// with `par` 1 and above; sub-programs left out and not. It prints how many
// cases of each function ended in each kind of result, and fails when a kind
// is under 5% of its function's cases, when no granted list has 64 members,
// or when the file passes 1,000,000 bytes (the strict reader takes at most
// 1 MiB).
//
// The file is `{ format, generator, seed, counts, cases }`: `counts` is the
// number of cases of each function by kind of result (the member names of the
// result object, and for inFlightOverlap "clear" or "refused"), and `cases`
// is one case a line, `{ fn, input, output }`. The input is what the Rust
// door takes as its `input`; the output is the TypeScript function's result
// for that input read back from its JSON text. Every character from U+007F up
// is a \u escape, and every number is an integer.
//
// It is a file in a directory of its own because compiler/test/vectors.test.ts
// holds the files at the top of vectors/ to the ones its generator writes.

import { mkdirSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
let bridge;
try {
  bridge = await import(new URL("bridge/dist/index.js", root).href);
} catch (e) {
  throw new Error(`cannot load bridge/dist/index.js: build it first (npm ci --ignore-scripts && npm run build): ${e.message}`);
}
const FNS = { grant: bridge.grant, narrow: bridge.narrow, mapScopes: bridge.mapScopes, inFlightOverlap: bridge.inFlightOverlap };
for (const [name, f] of Object.entries(FNS)) if (typeof f !== "function") throw new Error(`the bridge exports no function ${name}`);

const SEED = 20261114;
const FORMAT = "mandate/vectors/authority/0.1";
const MAX_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// The generator: mulberry32, a 32-bit generator over Math.imul, the same on
// every engine.

let state = SEED >>> 0;
function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (n) => Math.floor(random() * n);
const chance = (p) => random() < p;
const pick = (xs) => xs[int(xs.length)];
const some = (n, f) => Array.from({ length: n }, (_, i) => f(i));
function shuffle(xs) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

// ---------------------------------------------------------------------------
// What capabilities are made of.

/** Path segments: plain ones often, so that paths meet, and every kind of odd one. */
const SEGMENTS = ["a", "b", "a", "b", "c", "a", "ab", ".", "..", "", "\uff5e", "\u{1f600}", "\u00e9", "a\\b", "a:b", "n\u0000"];
/** Segments without the characters a narrowing refuses. */
const PLAIN = ["a", "b", "a", "c", "ab", ".", "..", "", "\uff5e", "\u{1f600}", "\u00e9"];
const HOSTS = ["api.x", "api.y", "api.x", "h:1", "a\\b", "\u{1f600}.io", "x/", ""];
const WORDS = ["npm", "make", "npm", "x:y", "a\\b", "\u{1f600}", "n\u0000"];
const REPOS = ["acme/app", "acme/lib", "acme/app", "acme/app/", "acme/./app"];
const CLASSES = ["public", "internal", "confidential", "restricted", "internal", "confidential", "secret", ""];
const RANKED = ["public", "internal", "confidential", "restricted"];
const TIERS = ["standard", "fast", "standard", ""];
const NAMES = ["Src", "n", "", "Src.narrow", "\u00e9"];
const VIAS = ["component.read(c)", "", "data.read(db)"];
const METHODS = ["GET", "POST", "PUT", "HEAD"];
const ARGS = ["ci", "test", "-x", "run"];
const EXTRA = [() => null, () => 7, () => "x", () => [1, "a"], () => ({ k: true }), () => false];

/** The kinds of capability, with the scope each is written with; the last three a port might take for file scopes. */
const KINDS = [
  { ctor: "fs.read", effect: "Fs.Read", write: false, scope: "path", weight: 5 },
  { ctor: "fs.write", effect: "Fs.Write", write: true, scope: "path", weight: 7 },
  { ctor: "exec", effect: "Exec", write: false, scope: "word", weight: 2 },
  { ctor: "net.https", effect: "Net", write: false, scope: "host", weight: 2 },
  { ctor: "git.pr", effect: "git.*", write: true, scope: "repo", weight: 2 },
  { ctor: "model.infer", effect: "Model", write: false, scope: "none", weight: 3 },
  { ctor: "env.deploy", effect: "Deploy", write: true, scope: "word", weight: 1 },
  { ctor: "fs", effect: "Fs", write: true, scope: "path", weight: 1 },
  { ctor: "fsx.write", effect: "Fs.Write", write: true, scope: "path", weight: 1 },
  { ctor: "fs.", effect: "Fs", write: true, scope: "path", weight: 1 },
];
const WEIGHTED = KINDS.flatMap((k) => some(k.weight, () => k));
const kindOf = (ctor) => KINDS.find((k) => k.ctor === ctor) ?? KINDS[0];
const files = (ctor) => ctor.startsWith("fs.");

/** A path: absolute mostly, of up to three segments, now and then with a trailing slash. */
function path(segments = SEGMENTS) {
  let p = some(int(4), () => pick(segments)).join("/");
  if (chance(0.8)) p = `/${p}`;
  if (chance(0.15)) p += "/";
  return p;
}

/** A scope item of a kind. */
function item(kind) {
  switch (kind.scope) {
    case "path":
      return path();
    case "host":
      return pick(HOSTS);
    case "repo":
      return pick(REPOS);
    default:
      return pick(WORDS);
  }
}

const scopeOf = (kind) => some(pick([0, 1, 1, 1, 2, 2, 3]), () => item(kind));

/** `write`: the kind's boolean mostly, else another value read by truthiness (never null). */
const writeValue = (w) => (chance(0.92) ? w : pick([1, 0, "yes", "", [], {}, !w]));

/** A capability of `kind`, with each member it may have now and then, its members in an order of their own now and then. */
function cap(kind = pick(WEIGHTED)) {
  const members = [
    ["ctor", kind.ctor],
    ["effect", kind.effect],
    ["write", writeValue(kind.write)],
  ];
  if (kind.scope === "none" ? chance(0.1) : chance(0.8)) members.push(["scope", scopeOf(kind)]);
  const model = kind.ctor === "model.infer";
  if (model ? chance(0.85) : chance(0.04)) members.push(["maxClass", pick(CLASSES)]);
  if (model ? chance(0.5) : chance(0.04)) members.push(["tier", pick(TIERS)]);
  if (kind.ctor === "exec" ? chance(0.45) : chance(0.03)) members.push(["argsPrefix", some(int(3), () => some(int(3), () => pick(ARGS)))]);
  if (kind.ctor === "net.https" ? chance(0.45) : chance(0.03)) members.push(["methods", some(int(4), () => pick(METHODS))]);
  if (chance(0.25)) members.push(["name", pick(NAMES)]);
  if (chance(0.08)) members.push(["via", pick(VIAS)]);
  if (chance(0.04)) members.push(["components", ["c"]]);
  if (chance(0.04)) members.push(["root", "/r"]);
  if (chance(0.05)) members.push([pick(["extra", "extra", "0"]), pick(EXTRA)()]);
  if (chance(0.15)) shuffle(members);
  return Object.fromEntries(members);
}

/** A data class no higher than `c`, as the order ranks them (an unknown one or an empty one, anything). */
function lower(c) {
  const i = RANKED.indexOf(c);
  return i < 0 ? pick(CLASSES) : RANKED[int(i + 1)];
}

/** A capability that `c` most often covers: a copy with its scope narrowed and its limits kept or lowered. */
function narrower(c) {
  const n = { ...c };
  if (Array.isArray(c.scope)) {
    if (files(c.ctor)) {
      n.scope = c.scope.length && chance(0.9)
        ? some(1 + int(2), () => {
            const b = pick(c.scope);
            return chance(0.6) ? `${b.replace(/\/+$/, "")}/${pick(SEGMENTS)}` : b;
          })
        : chance(0.5) ? [] : [...c.scope];
    } else n.scope = c.scope.length ? some(1 + int(2), () => pick(c.scope)) : [];
  } else if (chance(0.5)) n.scope = scopeOf(kindOf(c.ctor));
  if (typeof c.maxClass === "string" && chance(0.5)) n.maxClass = lower(c.maxClass);
  if (Array.isArray(c.methods) && chance(0.6)) n.methods = c.methods.filter(() => chance(0.6));
  if (Array.isArray(c.argsPrefix) && chance(0.6)) n.argsPrefix = c.argsPrefix.map((p) => (chance(0.5) ? [...p, pick(ARGS)] : p));
  // A tier set or taken off now and then: an outer tier, an empty one too, covers that tier and no other.
  if (chance(0.15)) n.tier = pick(TIERS);
  else if (chance(0.06)) delete n.tier;
  if (chance(0.3)) n.name = pick(NAMES);
  if (chance(0.1)) n.effect = "Other";
  if (chance(0.08)) n.write = writeValue(c.write === true);
  return n;
}

/** A context: bounds, layers of given (as many as `layers` names), and what is handed, mostly drawn from what is given. */
function context(layers = [0, 0, 1, 1, 2, 3]) {
  const bounds = some(int(5), () => cap());
  const given = some(pick(layers), () => some(1 + int(2), () => (bounds.length && chance(0.7) ? narrower(pick(bounds)) : cap())));
  const pool = given.flat();
  const handed = some(pool.length ? int(3) : pick([0, 0, 0, 1]), () => (pool.length && chance(0.75) ? pick(pool) : cap()));
  return { bounds, given, handed };
}

const available = (ctx) => bridge.grant({ context: ctx, delegation: null }).available;
const fromPool = (pool, p) => (pool.length && chance(p) ? narrower(pick(pool)) : cap());

// ---------------------------------------------------------------------------
// The cases of each function.

function grantInput() {
  const ctx = context();
  if (chance(0.12)) return { context: ctx, delegation: null };
  const avail = available(ctx);
  const own = some(pick([0, 0, 0, 1, 1, 1, 2, 3]), () => fromPool(avail, 0.82));
  const held = some(pick([0, 1, 2, 3, 4, 5, 6]), () => fromPool([...avail, ...ctx.handed], 0.65));
  return { context: ctx, delegation: { agent: pick(["coder", "rev", "\u00e9"]), held, remote: chance(0.3), own } };
}

/** Keys that sort apart only by an escape, a code unit or the member `scope`. */
const SORT_SCOPES = [undefined, [], ["/a"], ["/a", "/b"], ["/a/b"], ["\u{1f600}"], ["\uff5e"], ['"q'], ["a\u0001"], ["/a\\b"], ["/"], [""]];
const SORT_CTORS = ["fs.read", "fs.read", "fs", "fs.read.x", "exec", "\u00e9"];

/** A delegation whose held list is long, inside a context that holds everything of its kinds, keys often equal. */
function sortInput(n) {
  const ctors = [...new Set(SORT_CTORS)];
  const bounds = ctors.map((ctor) => ({ ctor, effect: "E", write: false }));
  const held = some(n, (i) => {
    const scope = pick(SORT_SCOPES);
    const c = { ctor: pick(SORT_CTORS), effect: "E", write: false, name: `m${i}` };
    if (scope !== undefined) c.scope = scope;
    return c;
  });
  return { context: { bounds, given: [], handed: [] }, delegation: { agent: "coder", held, remote: false, own: [] } };
}

/** A narrowing argument that is text, meant to land inside the base often. */
function textArg(base) {
  const scope = Array.isArray(base.scope) ? base.scope : [];
  if (!files(base.ctor)) return scope.length && chance(0.7) ? pick(scope) : item(kindOf(base.ctor));
  const segments = chance(0.08) ? SEGMENTS : PLAIN;
  if (chance(0.5)) return some(1 + int(3), () => pick(segments)).join("/");
  if (scope.length && chance(0.7)) return `${pick(scope).replace(/\/+$/, "")}/${some(int(3), () => pick(segments)).join("/")}`;
  return path(segments);
}

const NOT_TEXT = [() => 7, () => 0, () => true, () => false, () => null, () => ({ p: "/a" }), () => ["/a"], () => []];

/** A narrowing argument of any JSON type: text, a list (whose members are text mostly), or another value. */
function narrowArg(base) {
  const r = random();
  if (r < 0.62) return textArg(base);
  if (r < 0.86) return some(int(4), () => (chance(0.88) ? textArg(base) : pick(NOT_TEXT)()));
  return pick(NOT_TEXT)();
}

function narrowInput() {
  const kind = pick([...WEIGHTED.filter((k) => k.scope !== "none"), kindOf("fs.write"), kindOf("fs.read")]);
  const base = cap(kind);
  if (chance(0.8)) {
    const outer = files(kind.ctor) ? ["/", "/a", "/a/", "/a/b", "/b//", "", "a", "/\u{1f600}", "/a/./b"] : [item(kind), item(kind)];
    base.scope = some(pick([0, 1, 1, 1, 2, 2, 3]), () => pick(outer));
  } else delete base.scope;
  return { base, args: some(pick([0, 1, 1, 2, 2, 3, 4]), () => narrowArg(base)), complete: chance(0.75) };
}

function mapScopesInput() {
  const ctx = context([0, 0, 0, 1, 1, 2]);
  const avail = available(ctx);
  // Items drawn from one capability of the context half the time, so that their writes meet.
  const writes = avail.filter((c) => c.write === true);
  const focus = writes.length && chance(0.6) ? [pick(writes)] : avail;
  const items = some(pick([0, 1, 2, 2, 3, 3, 4]), () => (chance(0.25) ? [] : some(1 + int(2), () => fromPool(chance(0.6) ? focus : avail, 0.92))));
  return { map: pick(["/defs/W/body/0", "/m", "/defs/W/body/1/then/0"]), par: pick([1, 1, 2, 3, 4]), context: ctx, items, complete: chance(0.78) };
}

/** A write a map or a sub-program may hold: of a writing kind mostly, its scope from a small alphabet. */
function writeCap() {
  const kind = pick([kindOf("fs.write"), kindOf("fs.write"), kindOf("fs.write"), kindOf("git.pr"), kindOf("fs"), kindOf("fs.read")]);
  const c = { ctor: kind.ctor, effect: kind.effect, write: writeValue(kind.write) };
  if (chance(0.85)) c.scope = some(pick([0, 1, 1, 2]), () => (kind.scope === "repo" ? pick(REPOS) : pick(["/w", "/w/a", "/w/b", "/w/a/..", "/w/a/", "w/a", "/x", "/w/\u{1f600}"])));
  if (chance(0.2)) c.name = pick(NAMES);
  return c;
}

const MAPS = ["/p/1/defs/W/body/0", "/p/1", "/p/12/defs/W/body/0", "/q/defs/W/body/0", "/p/1/", "p/1/x"];

/** A sub-program's command for a map: one it runs inside, the map itself, a prefix not ending at a "/", or another. */
function command(map) {
  const cuts = [...map.matchAll(/\//g)].map((m) => map.slice(0, m.index)).filter((p) => p !== map);
  const r = random();
  if (r < 0.3 && cuts.length) return pick(cuts);
  if (r < 0.5) return map;
  if (r < 0.65) return map.slice(0, Math.max(0, map.length - 1 - int(3)));
  return pick(["/p/2", "/q", "/p/12", "", "/p/1/defs"]);
}

function inFlightInput() {
  const map = pick(MAPS);
  return {
    map,
    writes: some(pick([0, 1, 1, 2, 2, 3]), () => some(int(4), () => writeCap())),
    programs: some(pick([0, 1, 1, 2, 2, 3]), () => ({ command: command(map), writes: some(1 + int(3), () => writeCap()) })),
  };
}

// ---------------------------------------------------------------------------
// The file.

const PLAN = [
  ["grant", 360, grantInput],
  ["grant", 14, () => sortInput(8 + int(20))],
  ["grant", 3, () => sortInput(64 + int(16))],
  ["narrow", 360, narrowInput],
  ["mapScopes", 260, mapScopesInput],
  ["inFlightOverlap", 230, inFlightInput],
];

/** The kind of result, as the Rust test counts it. */
function kindOfResult(fn, out) {
  if (fn === "inFlightOverlap") return out.overlap === null ? "clear" : "refused";
  return Object.keys(out).join(",");
}

/** A finer kind, printed only: which refusal, how long a granted list, whether an item has scopes of its own. */
function detail(fn, out) {
  if (out.refused) return `${out.refused.tag} ${typeof out.refused.args[0] === "string" ? out.refused.args[0] : out.refused.args[0].reason}`;
  if (fn === "inFlightOverlap") return out.overlap === null ? "clear" : "overlapping a program";
  if (out.granted) return out.granted.length >= 64 ? "granted 64 or more" : out.granted.length ? "granted some" : "granted none";
  if (out.items) return out.items.some((i) => i !== null) ? "items with scopes" : "items in the map's context";
  return Object.keys(out).join(",");
}

const cases = [];
const counts = {};
const details = {};
for (const [fn, n, make] of PLAN) {
  for (let i = 0; i < n; i++) {
    // The input as the Rust door reads it: through its JSON text.
    const input = JSON.parse(JSON.stringify(make()));
    const output = JSON.parse(JSON.stringify(FNS[fn](structuredClone(input))));
    cases.push({ fn, input, output });
    const kind = kindOfResult(fn, output);
    counts[fn] ??= {};
    counts[fn][kind] = (counts[fn][kind] ?? 0) + 1;
    details[fn] ??= {};
    const d = detail(fn, output);
    details[fn][d] = (details[fn][d] ?? 0) + 1;
  }
}
for (const fn of Object.keys(counts)) counts[fn] = Object.fromEntries(Object.entries(counts[fn]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const ascii = (text) => text.replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const lines = cases.map((c) => `    ${JSON.stringify(c)}`);
const text = ascii(
  `{\n  "format": ${JSON.stringify(FORMAT)},\n  "generator": "scripts/authority-vectors.mjs",\n  "seed": ${SEED},\n  "counts": ${JSON.stringify(counts)},\n  "cases": [\n${lines.join(",\n")}\n  ]\n}\n`,
);

const problems = [];
for (const [fn, kinds] of Object.entries(counts)) {
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  const expected = { grant: 3, narrow: 4, mapScopes: 3, inFlightOverlap: 2 }[fn];
  if (Object.keys(kinds).length !== expected) problems.push(`${fn}: ${Object.keys(kinds).length} kinds of result, not ${expected}`);
  for (const [kind, n] of Object.entries(kinds)) if (n * 20 < total) problems.push(`${fn}: ${kind} is ${n} of ${total}, under 5%`);
}
if (!cases.some((c) => c.output.granted?.length >= 64)) problems.push("no granted list has 64 members");
if (Buffer.byteLength(text) > MAX_BYTES) problems.push(`the file is ${Buffer.byteLength(text)} bytes, over ${MAX_BYTES}`);

for (const [fn, kinds] of Object.entries(counts)) {
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  const shown = Object.entries(kinds).map(([k, n]) => `${k} ${n} (${Math.round((100 * n) / total)}%)`);
  console.log(`${fn}: ${total} cases: ${shown.join(", ")}`);
  console.log(`  ${Object.entries(details[fn]).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ")}`);
}
console.log(`vectors/authority/cases.json: ${cases.length} cases, ${Buffer.byteLength(text)} bytes`);
if (problems.length) throw new Error(`the generated cases do not cover what they must:\n${problems.join("\n")}`);
mkdirSync(new URL("vectors/authority/", root), { recursive: true });
writeFileSync(new URL("vectors/authority/cases.json", root), text);
