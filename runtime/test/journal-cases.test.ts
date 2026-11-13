// The journal conformance cases (conformance/README.md "A journal case"):
// for each, the TypeScript verifier gives the committed report for the
// committed export and keys. The cases come from real runs on PGlite
// (runtime/scripts/journal-cases.mjs) with fresh keys, so writing them again
// changes every file; this is the test that holds them.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publicKeysIn, verifyExport } from "../src/journal-chain.js";

const root = new URL("../../conformance/", import.meta.url);

interface JournalCase {
  id: string;
  kind: string;
  title: string;
  journal?: { export: string; keys: string[]; report: string };
}

const cases = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/case.json`, root)))
  .map((d) => ({ dir: new URL(`${d.name}/`, root), c: JSON.parse(readFileSync(new URL(`${d.name}/case.json`, root), "utf8")) as JournalCase }))
  .filter(({ c }) => c.kind === "journal");

describe("journal conformance cases", () => {
  it("are J01 to J16", () => {
    expect(cases.map(({ c }) => c.id)).toEqual(Array.from({ length: 16 }, (_, i) => `J${String(i + 1).padStart(2, "0")}`));
  });

  for (const { dir, c } of cases) {
    it(`${c.id} ${c.title}`, () => {
      const j = c.journal!;
      const keys = j.keys.flatMap((k) => publicKeysIn(readFileSync(new URL(k, dir), "utf8")));
      expect(keys.length).toBeGreaterThan(0);
      const report = verifyExport(readFileSync(new URL(j.export, dir)), keys);
      expect(report).toEqual(JSON.parse(readFileSync(new URL(j.report, dir), "utf8")));
      // A case holds public keys only.
      for (const k of j.keys) expect(readFileSync(new URL(k, dir), "utf8")).not.toMatch(/PRIVATE/);
    });
  }
});
