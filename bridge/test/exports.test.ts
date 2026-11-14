import { describe, expect, it } from "vitest";
import * as bridge from "../src/index.js";
import * as authority from "../src/authority.js";
import * as compiler from "../../compiler/src/index.js";

describe("the bridge", () => {
  it("exports exactly the names the compiler's entry point exports, and the same values, and the authority decisions", () => {
    expect(Object.keys(bridge).sort()).toEqual([...Object.keys(compiler), ...Object.keys(authority)].sort());
    for (const [name, value] of Object.entries(compiler)) expect((bridge as Record<string, unknown>)[name]).toBe(value);
    for (const [name, value] of Object.entries(authority)) expect((bridge as Record<string, unknown>)[name]).toBe(value);
  });

  it("adds no name the compiler has", () => {
    expect(Object.keys(authority).filter((n) => Object.hasOwn(compiler, n))).toEqual([]);
  });

  it("exports the four authority decisions, and nothing else of its own", () => {
    expect(Object.keys(authority).sort()).toEqual(["grant", "inFlightOverlap", "mapScopes", "narrow"]);
  });
});
