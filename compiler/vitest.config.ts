import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const include = ["test/**/*.test.ts"];

// The collecting mode of the compiled corpus (vectors/README.md, "corpus/"): MANDATE_CORPUS=1, and also
// MANDATE_UPDATE_VECTORS=1, which writes every vector file again. Every test file but corpus.test.ts runs first, with
// test/corpus-record.ts recording each call it makes to a front door of the compiler into MANDATE_CORPUS_DIR; then
// corpus.test.ts runs alone and compares what was recorded with vectors/corpus/ (or writes it). Without the mode the
// suite is one project, as it always was, and corpus.test.ts checks the stored entries alone.
const collecting = process.env["MANDATE_CORPUS"] === "1" || process.env["MANDATE_UPDATE_VECTORS"] === "1";
if (collecting && !process.env["MANDATE_CORPUS_DIR"]) process.env["MANDATE_CORPUS_DIR"] = mkdtempSync(join(tmpdir(), "mandate-corpus-"));

export default defineConfig({
  test: collecting
    ? {
        projects: [
          { test: { name: "suite", include, exclude: ["test/corpus.test.ts"], setupFiles: ["test/corpus-record.ts"], sequence: { groupOrder: 0 } } },
          { test: { name: "corpus", include: ["test/corpus.test.ts"], sequence: { groupOrder: 1 } } },
        ],
      }
    : { include },
});
