// Which compiler answers when nothing says: the Rust compiler's module (MANDATE_COMPILER unset or empty is `rust`),
// and a value that names no mode is refused rather than guessed at. How a whole process behaves in the default mode,
// with a module that traps or none, is test/refusal.test.ts.

import { describe, expect, it } from "vitest";
import { DEFAULT_MODE, modeFrom, MODES, PROCESS_MODE } from "../src/mode.js";

describe("the default mode", () => {
  it("is the Rust compiler when MANDATE_COMPILER is not set, and when it is empty", () => {
    expect(DEFAULT_MODE).toBe("rust");
    expect(modeFrom(undefined)).toBe("rust");
    expect(modeFrom("")).toBe("rust");
  });

  it("is the mode of this very run, which is read once from the environment it was started in", () => {
    expect(PROCESS_MODE).toBe(modeFrom(process.env["MANDATE_COMPILER"]));
  });

  it("leaves `ts`, `rust` and `both` selectable by name", () => {
    expect([...MODES]).toEqual(["ts", "rust", "both"]);
    for (const m of MODES) expect(modeFrom(m)).toBe(m);
  });

  it("refuses a value that names no mode, whatever its case or spacing", () => {
    for (const v of ["rsut", "TS", "Rust", " rust", "rust ", "both,ts", "0", "false"]) expect(() => modeFrom(v), v).toThrow(`MANDATE_COMPILER is ${JSON.stringify(v)}: it is ts, rust or both`);
  });
});
