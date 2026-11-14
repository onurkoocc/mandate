import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grant, inFlightOverlap, mapScopes, narrow } from "../src/authority.js";

// The cases are the run-time authority decisions as the interpreter made them in 0.5: each input with the output
// the TypeScript gives. The Rust port is held to the same file.
interface Case {
  name: string;
  fn: string;
  input: unknown;
  output: unknown;
}

const cases = JSON.parse(readFileSync(new URL("./authority-cases.json", import.meta.url), "utf8")) as Case[];
const FNS: Record<string, (input: never) => unknown> = { grant, narrow, mapScopes, inFlightOverlap };

/** The value with every object and array in it frozen, so that a change to it throws. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** Whether the value is plain JSON: objects, arrays, strings, finite numbers, booleans and null, and nothing undefined. */
function plainJson(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(plainJson);
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v as object).every(plainJson);
  return false;
}

describe("the cases", () => {
  it("are well formed: a known function, and no name twice for one function", () => {
    const seen = new Set<string>();
    for (const c of cases) {
      expect(Object.keys(FNS), c.name).toContain(c.fn);
      expect(seen.has(`${c.fn}: ${c.name}`), `${c.fn}: ${c.name} twice`).toBe(false);
      seen.add(`${c.fn}: ${c.name}`);
    }
  });

  it("cover every function", () => {
    expect(new Set(cases.map((c) => c.fn))).toEqual(new Set(Object.keys(FNS)));
  });

  it("cover every kind of result of every function", () => {
    const kinds = new Set(cases.map((c) => `${c.fn} ${Object.keys(c.output as object).join(",")}${c.fn === "inFlightOverlap" ? ((c.output as { overlap: unknown }).overlap ? " refused" : " clear") : ""}`));
    expect([...kinds].sort()).toEqual(
      [
        "grant available",
        "grant granted",
        "grant refused",
        "narrow caps",
        "narrow partial",
        "narrow notText",
        "narrow refused",
        "mapScopes items,writes",
        "mapScopes partial",
        "mapScopes refused",
        "inFlightOverlap overlap clear",
        "inFlightOverlap overlap refused",
      ].sort(),
    );
  });
});

describe.each(cases.map((c) => [`${c.fn}: ${c.name}`, c] as const))("%s", (_, c) => {
  const fn = FNS[c.fn]!;

  it("gives the recorded output", () => {
    // Strictly: a member set to undefined is not the same as one left out.
    expect(fn(structuredClone(c.input) as never)).toStrictEqual(c.output);
  });

  it("leaves its input unchanged, gives the same output twice, and gives plain JSON", () => {
    const input = deepFreeze(structuredClone(c.input));
    const first = fn(input as never);
    const second = fn(input as never);
    expect(input).toEqual(c.input);
    expect(second).toEqual(first);
    expect(plainJson(first)).toBe(true);
    // Through JSON and back, as a door would carry it: nothing is lost.
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
