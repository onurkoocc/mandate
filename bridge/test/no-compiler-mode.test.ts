// There is no compiler mode: one compiler, the Rust compiler's module, answers behind the bridge. The environment
// variable that once chose among the reference compiler, the Rust compiler and both is in no tracked file of the
// repository: not in the product, the scripts, the workflows, the Docker steps, the tests or the documents. The name
// is written in parts so that this file does not hold it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./tree.js";

const NAME = ["MANDATE", "COMPILER"].join("_");

describe("the compiler mode that is gone", () => {
  it(`names no ${NAME} in any tracked file of the repository`, () => {
    const listed = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
    expect(listed.length, "git lists the tracked files").toBeGreaterThan(100);
    const needle = Buffer.from(NAME);
    const found: string[] = [];
    for (const file of listed) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(repoRoot, file));
      } catch {
        // Listed and not on disk (deleted in the working tree, or a link to nowhere): there is no text to read.
        continue;
      }
      if (bytes.includes(needle)) found.push(file);
    }
    expect(found, `${NAME} is no longer read by anything; remove it from:\n${found.join("\n")}`).toEqual([]);
  });
});
