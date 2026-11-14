// What the compiler says about every program in the repository is pinned
// here, by digest: a 0.1 to 0.3 program reads, checks, hashes, prints and
// shows exactly as it did. A later version adds to the language; it does not
// change what an earlier program means. The programs of 0.4 and 0.5 (the
// MigrateAll example with its domain module, and the two programs of
// fixtures/boundary) are pinned beside them, so what the compiler says of
// them changes only with a reason too. A Rust compiler must give these same
// digests (release 0.5).
//
// The digests are in golden/outputs.json. A change to one of them is a change
// to an earlier version's behavior and needs a reason in the commit that
// makes it. To write the file again: MANDATE_UPDATE_GOLDEN=1 npm test.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allOutputs, digests, json, outputFileName, PROGRAMS, sha256Of, writeOutputs } from "./golden-outputs.js";
import { repoRoot } from "./helpers.js";

const GOLDEN = `${repoRoot}compiler/test/golden/outputs.json`;

describe("every program in the repository", () => {
  const now = digests();

  if (process.env["MANDATE_UPDATE_GOLDEN"] === "1") {
    writeFileSync(GOLDEN, json(now));
  }
  // MANDATE_GOLDEN_OUT=<dir> writes every output text to <dir>/<program path>/<output file name> (vectors/README.md),
  // for a job that compares them with another compiler's by `diff -ru`. Nothing is written when it is not set.
  const outDir = process.env["MANDATE_GOLDEN_OUT"];
  if (outDir) writeOutputs(outDir);
  const pinned = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Record<string, string>>;

  it("pins every program in the repository", () => {
    expect(Object.keys(pinned).sort()).toEqual([...PROGRAMS].sort());
  });

  for (const file of PROGRAMS) {
    it(`${file} gives the outputs it gave`, () => {
      expect(now[file]).toEqual(pinned[file]);
    });
  }

  it("checks, hashes and shows something for each of them", () => {
    // A pin of nothing would pass for ever: every program loads, and every one that checks has its views.
    for (const file of PROGRAMS) {
      const names = Object.keys(now[file]!);
      expect(names, file).toEqual(expect.arrayContaining(["check", "check --module", "load", "ir --canonical", "fmt"]));
    }
    const shown = PROGRAMS.filter((f) => "view --format json" in now[f]!);
    expect(shown.length).toBeGreaterThanOrEqual(PROGRAMS.length - 1);
  });
});

describe("the output texts written for a comparison", () => {
  it("have one file name for each output of each program", () => {
    const all = allOutputs();
    const names = new Set<string>();
    for (const [file, texts] of Object.entries(all)) {
      const files = Object.keys(texts).map(outputFileName);
      expect(new Set(files).size, file).toBe(files.length);
      for (const f of files) names.add(`${file}/${f}`);
    }
    expect(names.size).toBe(Object.values(all).reduce((n, t) => n + Object.keys(t).length, 0));
    expect(outputFileName("view --format json")).toBe("view_--format_json");
  });

  it("are files whose digests are the pinned ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-golden-"));
    try {
      const written = writeOutputs(dir);
      const pinned = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Record<string, string>>;
      const expected = Object.entries(pinned).flatMap(([file, row]) => Object.keys(row).map((name) => `${file}/${outputFileName(name)}`));
      expect(written.sort()).toEqual(expected.sort());
      expect(written.length).toBe(234);
      for (const [file, row] of Object.entries(pinned)) {
        for (const [name, digest] of Object.entries(row)) expect(sha256Of(readFileSync(join(dir, file, outputFileName(name)), "utf8")), `${file} ${name}`).toBe(digest);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
