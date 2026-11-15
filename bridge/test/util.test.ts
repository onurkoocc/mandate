// The helpers the bridge keeps for itself (src/util.ts) because the compiler's entry point does not export them, held
// equal to the compiler's own on a set of inputs (but viewModules, the bridge's own). This is the one place the
// compiler's internal is imported.

import { describe, expect, it } from "vitest";
import { ptrToken as compilers } from "../../compiler/src/diag.js";
import type { Modules, Program } from "../src/index.js";
import { ptrToken, viewModules } from "../src/util.js";

describe("viewModules", () => {
  const program = (language: string): Program => ({ language, module: "m", version: "0.1", defs: {} }) as unknown as Program;
  const modules = { "m.pat": program("mandate/0.6") } as unknown as Modules;

  it("gives a view the caller's modules for a program of 0.6, and none for one of 0.1 to 0.5", () => {
    expect(viewModules(modules, program("mandate/0.6"))).toBe(modules);
    expect(viewModules(modules, program("mandate/0.5"), program("mandate/0.6"))).toBe(modules);
    for (const v of ["mandate/0.1", "mandate/0.4", "mandate/0.5"]) expect(viewModules(modules, program(v)), v).toBeUndefined();
    expect(viewModules(undefined, program("mandate/0.6"))).toBeUndefined();
  });
});

describe("ptrToken", () => {
  it("escapes a JSON Pointer reference token as the compiler's does", () => {
    const inputs: Array<string | number> = ["", "a", "a/b", "a~b", "~", "/", "~/", "/~", "~0", "~1", "a//b", "~~//", "defs", "caps/with~tilde/and/slashes", "ğ/ü~", " ", "0", 0, 7, -1, 1.5, 1e21];
    for (const s of inputs) expect(ptrToken(s), String(s)).toBe(compilers(s));
    expect(ptrToken("a/b~c")).toBe("a~1b~0c");
  });
});
