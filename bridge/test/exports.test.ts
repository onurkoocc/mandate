import { describe, expect, it } from "vitest";
import * as bridge from "../src/index.js";
import * as authority from "../src/authority.js";
import * as library from "../src/library.js";
import * as compiler from "../../compiler/src/index.js";
import { DOOR_BACKED } from "../src/doors.js";
import { compilerMode } from "../src/mode.js";

// In `ts` mode (MANDATE_COMPILER=ts), every name is the reference compiler's (or the authority decision's) very value. In
// `rust` (the default) and `both`, a door-backed function is the facade's and CODES the Rust's table (test/facade.test.ts), and
// every other name is still the very value. In every mode the names of language 0.6 are the bridge's own (src/library.ts),
// `atLeast` among them, which reads 0.6 as well.
const ours = compilerMode() === "ts" ? new Set<string>() : new Set<string>([...Object.keys(DOOR_BACKED), "CODES"]);
const own06 = Object.keys(library).filter((n) => Object.hasOwn(bridge, n));

describe("the bridge", () => {
  it("exports exactly the names the compiler's entry point exports, and the same values, the authority decisions, and the names of 0.6", () => {
    expect(Object.keys(bridge).sort()).toEqual([...new Set([...Object.keys(compiler), ...Object.keys(authority), ...own06])].sort());
    for (const [name, value] of Object.entries(compiler)) if (!ours.has(name) && !own06.includes(name)) expect((bridge as Record<string, unknown>)[name]).toBe(value);
    for (const [name, value] of Object.entries(authority)) if (!ours.has(name)) expect((bridge as Record<string, unknown>)[name]).toBe(value);
    for (const name of own06) expect((bridge as Record<string, unknown>)[name]).toBe((library as Record<string, unknown>)[name]);
  });

  it("adds no name the compiler has, but atLeast, which it reads over 0.6 too", () => {
    expect(Object.keys(authority).filter((n) => Object.hasOwn(compiler, n))).toEqual([]);
    expect(own06.filter((n) => Object.hasOwn(compiler, n))).toEqual(["atLeast"]);
  });

  it("exports the four authority decisions, and nothing else of its own but the names of 0.6", () => {
    expect(Object.keys(authority).sort()).toEqual(["grant", "inFlightOverlap", "mapScopes", "narrow"]);
    expect(own06.sort()).toEqual(["atLeast", "BRIDGE_LANGUAGE_VERSIONS", "isProgram06", "LANGUAGE_06", "LIBRARY_FORMAT", "libraryVerify", "LOCK_FORMAT_06", "NoReference"].sort());
  });
});
