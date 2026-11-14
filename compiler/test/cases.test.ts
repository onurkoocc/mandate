// Runs every conformance/<id>/case.json (conformance/README.md). A directory
// without a good case.json fails; it is never skipped. A case of a language
// only the Rust compiler reads (0.6) is skipped here, and counted: the Rust
// conformance gate runs it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caseDirs, caseFile, CASES_DIR, compareResult, readCase, runCompileCase, RUST_ONLY_CASES, rustOnly, rustOnlyCaseDirs, type Case } from "./cases-runner.js";

const dirs = caseDirs();

describe("conformance cases", () => {
  it("finds at least one case", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  const skipped: string[] = [];
  for (const name of dirs) {
    let c: Case | undefined;
    let problem: string | undefined;
    try {
      c = readCase(name);
    } catch (e) {
      problem = (e as Error).message;
    }
    if (c && rustOnly(c)) {
      // Of a language this compiler does not read: the Rust compiler's case, with its expectation written by hand.
      skipped.push(name);
      it.skip(`${c.id} ${c.title} (${c.language}, which only the Rust compiler reads)`, () => {});
      continue;
    }
    it(c ? `${c.id} ${c.title}` : `${name} is a case`, () => {
      if (!c) throw new Error(problem);
      // A journal case is about the runtime's verifier, and runtime/test/journal-cases.test.ts runs it. Here its files must be there.
      if (c.kind === "journal") {
        const j = c.journal!;
        for (const f of [j.export, j.report, ...j.keys]) expect(existsSync(caseFile(join(CASES_DIR, name), f)), `${c.id}: ${f}`).toBe(true);
        return;
      }
      if (c.kind === "run") throw new Error(`${c.id}: run cases have no runner yet, so this case is not checked; do not add one until a runner exists`);
      const result = runCompileCase(name, c);
      expect(compareResult(c.expect, result)).toEqual([]);
    });
  }

  it("skips only the cases of a language only the Rust compiler reads, and exactly as many as RUST_ONLY_CASES says", () => {
    expect(skipped).toEqual(rustOnlyCaseDirs());
    expect(skipped.length).toBe(RUST_ONLY_CASES);
  });
});
