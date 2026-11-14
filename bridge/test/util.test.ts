// The helpers the bridge keeps for itself (src/util.ts) because the compiler's entry point does not export them, held
// equal to the compiler's own on a set of inputs. This is the one place the compiler's internal is imported.

import { describe, expect, it } from "vitest";
import { ptrToken as compilers } from "../../compiler/src/diag.js";
import { ptrToken } from "../src/util.js";

describe("ptrToken", () => {
  it("escapes a JSON Pointer reference token as the compiler's does", () => {
    const inputs: Array<string | number> = ["", "a", "a/b", "a~b", "~", "/", "~/", "/~", "~0", "~1", "a//b", "~~//", "defs", "caps/with~tilde/and/slashes", "ğ/ü~", " ", "0", 0, 7, -1, 1.5, 1e21];
    for (const s of inputs) expect(ptrToken(s), String(s)).toBe(compilers(s));
    expect(ptrToken("a/b~c")).toBe("a~1b~0c");
  });
});
