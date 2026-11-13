// Runs every conformance/<id>/case.json (conformance/README.md). A directory
// without a good case.json fails; it is never skipped.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caseDirs, caseFile, CASES_DIR, compareResult, readCase, runCompileCase, type Case } from "./cases-runner.js";

const dirs = caseDirs();

describe("conformance cases", () => {
  it("finds at least one case", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const name of dirs) {
    let c: Case | undefined;
    let problem: string | undefined;
    try {
      c = readCase(name);
    } catch (e) {
      problem = (e as Error).message;
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
});
