// The chained journal's hash input survives the database (spec/journal.md
// "The event hash"). An event's hash is computed when it is written, over its
// data as `JSON.parse(JSON.stringify(data))`; a verifier recomputes it from the
// data the database gives back. This proves the two are the same value for
// what a run can journal, with values from a seeded generator, on PGlite and,
// when MANDATE_TEST_DATABASE_URL names one, on PostgreSQL.

import { afterAll, describe, expect, it } from "vitest";
import { eventHash } from "../src/journal-chain.js";
import { canonical, type Value } from "../src/values.js";
import { closeAll, start, world, type World } from "./helpers.js";
import { ASK } from "./programs.js";

afterAll(closeAll);

/** mulberry32: a small seeded generator, so a failing value can be made again from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EDGE_NUMBERS = [
  0, -0, 1, -1, 2, 10, 100, 1e6,
  Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, -(2 ** 53), 2 ** 53, 2 ** 53 + 2, 2 ** 60, 2 ** 64, -(2 ** 70),
  0.1, 0.5, -0.25, 1 / 3, 2 / 3, 0.1 + 0.2, 123.456, -987654.321, 1.5e-5, 4.35, 0.000001, 1e-7,
  1e21, 1e20, 9.999999999999999e20, 1.2345678901234567e25, 1e100, 1e300, 1.7976931348623157e308, -1.7976931348623157e308,
  5e-324, -5e-324, 2.2250738585072014e-308, 2.225073858507201e-308, 1e-300, 4.9406564584124654e-324, 123456789e-320,
];

const EDGE_STRINGS = [
  "", "a", "A", "z", "Z", " ", "0", "true", "null", "\"", "\\", "/", "\b\f\n\r\t", "\u0001\u001f\u007f", "line\u2028sep\u2029",
  "é", "e\u0301", "ı", "İ", "ğüşöç", "ß", "Ω", "日本語", "한국어", "עברית", "العربية", "\ufeff", "\uffff", "\ufffd",
  "😀", "𝄞", "\u{10ffff}", "a😀b", "👩\u200d👩\u200d👧", "\u{1f600}\u{1f601}", "$tag", "$verified", "__proto__", "constructor",
];

/** Keys whose order differs between UTF-16 code units and code points: an astral character sorts before U+FFFF in the first. */
const EDGE_KEYS = ["", "a", "B", "b", "aa", "ab", "é", "\uffff", "\uff61", "😀", "𝄞", "\ue000", "Z", "_", "$tag", "10", "9", "__proto__", "constructor", "key with space"];

function gen(r: () => number, depth: number): Value | undefined {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const roll = r();
  if (depth <= 0 || roll < 0.45) {
    const k = r();
    if (k < 0.08) return null;
    if (k < 0.14) return r() < 0.5;
    if (k < 0.3) return pick(EDGE_NUMBERS);
    if (k < 0.38) return Math.floor((r() - 0.5) * 2 ** 53);
    if (k < 0.46) {
      // A double from random bits, as a model or an adapter might return any of them; never NaN or an infinity.
      const b = new DataView(new ArrayBuffer(8));
      b.setUint32(0, Math.floor(r() * 2 ** 32));
      b.setUint32(4, Math.floor(r() * 2 ** 32));
      const x = b.getFloat64(0);
      return Number.isFinite(x) ? x : 0;
    }
    if (k < 0.52) return (r() - 0.5) * 10 ** Math.floor(r() * 40 - 20);
    if (k < 0.75) return pick(EDGE_STRINGS);
    if (k < 0.97) {
      let s = "";
      const n = Math.floor(r() * 12);
      for (let i = 0; i < n; i++) {
        const c = r();
        // Any code point but U+0000 and the surrogates, which a database text cannot hold (see the test below).
        const cp = c < 0.5 ? 0x20 + Math.floor(r() * 0x5f) : c < 0.7 ? 1 + Math.floor(r() * 0x1f) : c < 0.9 ? 0x80 + Math.floor(r() * (0xd800 - 0x80)) : 0x10000 + Math.floor(r() * 0xfffff);
        s += String.fromCodePoint(cp);
      }
      return s;
    }
    return undefined;
  }
  if (roll < 0.7) {
    const n = r() < 0.15 ? 0 : Math.floor(r() * 6);
    const out: Value[] = [];
    for (let i = 0; i < n; i++) out.push((gen(r, depth - 1) ?? null) as Value);
    return out;
  }
  const n = r() < 0.15 ? 0 : Math.floor(r() * 7);
  const out: Record<string, Value | undefined> = {};
  for (let i = 0; i < n; i++) {
    const key = r() < 0.6 ? pick(EDGE_KEYS) : `k${Math.floor(r() * 100)}${r() < 0.2 ? "😀" : ""}`;
    Object.defineProperty(out, key, { value: gen(r, depth - 1), enumerable: true, writable: true, configurable: true });
  }
  return out as Value;
}

/** An event appended as the runtime appends one: under the run's row lock. */
async function append(w: World, runId: string, type: string, data: Value): Promise<void> {
  await w.db.tx(async (tx) => {
    await w.rt.journal.lock(tx, runId);
    await w.rt.journal.event(tx, runId, type, data);
  });
}

async function stored(w: World, runId: string): Promise<Array<{ seq: number; type: string; data: Value; at: number; hash: string | null }>> {
  const rows = await w.db.query<{ seq: unknown; type: string; data: Value; at: unknown; hash: string | null }>("select seq, type, data, at, hash from events where run_id = $1 order by seq", [runId]);
  return rows.map((r) => ({ seq: Number(r.seq), type: r.type, data: r.data, at: Number(r.at), hash: r.hash }));
}

describe("the event hash survives the database (spec/journal.md)", () => {
  it("is the same over the data as written and as read back, for nested values, edge numbers and any string", async () => {
    const w = await world(ASK);
    await start(w, "Ask", "prop");
    const written: Array<{ seed: number; data: Value }> = [];
    for (let seed = 1; seed <= 400; seed++) {
      const data = (gen(rng(seed), 5) ?? null) as Value;
      written.push({ seed, data });
      await append(w, "prop", "probe", data);
    }
    // Every edge number and string once more, alone and as keys, so none depends on the generator reaching it.
    for (const [i, x] of [...EDGE_NUMBERS, ...EDGE_STRINGS].entries()) {
      const data = { x, [typeof x === "string" ? x : String(x)]: [x] } as Value;
      written.push({ seed: -i, data });
      await append(w, "prop", "probe", data);
    }
    const events = await stored(w, "prop");
    const probes = events.filter((e) => e.type === "probe");
    expect(probes).toHaveLength(written.length);
    let prev: string | null = null;
    const mismatched: string[] = [];
    for (const e of events) {
      expect(e.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      // Recomputed from what the database gave back, linked to the hash stored before it.
      if (eventHash({ run: "prop", seq: e.seq, type: e.type, data: e.data, at: e.at, prev }) !== e.hash) mismatched.push(`seq ${e.seq}`);
      prev = e.hash;
    }
    expect(mismatched).toEqual([]);
    // The value itself comes back: the same canonical bytes as `JSON.parse(JSON.stringify(data))`.
    const different = probes.flatMap((e, i) => (canonical(e.data) === canonical(JSON.parse(JSON.stringify(written[i]!.data)) as Value) ? [] : [`seed ${written[i]!.seed}`]));
    expect(different).toEqual([]);
  });

  it("is never computed over what the database cannot hold: U+0000 and a lone surrogate are refused on insert", async () => {
    const w = await world(ASK);
    await start(w, "Ask", "nul");
    const before = (await stored(w, "nul")).length;
    for (const bad of ["a\u0000b", "\ud800", "x\udc00y"]) {
      await expect(append(w, "nul", "probe", { s: bad })).rejects.toThrow();
    }
    expect((await stored(w, "nul")).length).toBe(before);
  });

  it("chains every event of a new run, from a first event whose prev is null", async () => {
    const w = await world(ASK);
    await start(w, "Ask", "chained");
    const events = await stored(w, "chained");
    expect(events.length).toBeGreaterThan(1);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    let prev: string | null = null;
    for (const e of events) {
      expect(e.hash).toBe(eventHash({ run: "chained", seq: e.seq, type: e.type, data: e.data, at: e.at, prev }));
      prev = e.hash;
    }
  });

  it("leaves a run begun before the chain unchained: its new events get no hash", async () => {
    const w = await world(ASK);
    await start(w, "Ask", "old");
    // As a run written before this change: no event has a hash.
    await w.db.query("update events set hash = null where run_id = $1", ["old"]);
    const n = (await stored(w, "old")).length;
    await append(w, "old", "probe", { more: true });
    const run = await w.rt.getRun("old");
    await w.rt.submitInput("old", { sender: "ann", messageId: "m1" }, { commandId: String((run.waiting as { command: string }).command), revision: run.revision, value: "yes" });
    const events = await stored(w, "old");
    expect(events.length).toBeGreaterThan(n + 2);
    expect(events.filter((e) => e.hash !== null)).toEqual([]);
    expect((await w.rt.getRun("old")).state).toBe("succeeded");
  });
});
