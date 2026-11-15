import { describe, expect, it } from "vitest";
import * as bridge from "../src/index.js";
import * as authority from "../src/authority.js";
import * as compiler from "../../compiler/src/index.js";
import { DOOR_BACKED } from "../src/doors.js";
import { compilerMode } from "../src/mode.js";

// In `ts` mode, the default, every name is the reference compiler's (or the authority decision's) very value. In
// `rust` and `both`, a door-backed function is the facade's and CODES the Rust's table (test/facade.test.ts), and
// every other name is still the very value.
const ours = compilerMode() === "ts" ? new Set<string>() : new Set<string>([...Object.keys(DOOR_BACKED), "CODES"]);

describe("the bridge", () => {
  it("exports exactly the names the compiler's entry point exports, and the same values, and the authority decisions", () => {
    expect(Object.keys(bridge).sort()).toEqual([...Object.keys(compiler), ...Object.keys(authority)].sort());
    for (const [name, value] of Object.entries(compiler)) if (!ours.has(name)) expect((bridge as Record<string, unknown>)[name]).toBe(value);
    for (const [name, value] of Object.entries(authority)) if (!ours.has(name)) expect((bridge as Record<string, unknown>)[name]).toBe(value);
  });

  it("adds no name the compiler has", () => {
    expect(Object.keys(authority).filter((n) => Object.hasOwn(compiler, n))).toEqual([]);
  });

  it("exports the four authority decisions, and nothing else of its own", () => {
    expect(Object.keys(authority).sort()).toEqual(["grant", "inFlightOverlap", "mapScopes", "narrow"]);
  });
});
