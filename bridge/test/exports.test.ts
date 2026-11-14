import { describe, expect, it } from "vitest";
import * as bridge from "../src/index.js";
import * as compiler from "../../compiler/src/index.js";

describe("the bridge", () => {
  it("exports exactly the names the compiler's entry point exports, and the same values", () => {
    expect(Object.keys(bridge).sort()).toEqual(Object.keys(compiler).sort());
    for (const [name, value] of Object.entries(compiler)) expect((bridge as Record<string, unknown>)[name]).toBe(value);
  });
});
