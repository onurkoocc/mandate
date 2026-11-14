#!/usr/bin/env node
// Fails unless the tests of a vitest run really ran. A test that is gated by an
// environment variable is skipped, and a skipped test is a pass, so a step that
// sets the variable wrongly would stay green and show nothing. CI runs such a
// step with `--reporter=json --outputFile.json=FILE` and then this:
//
//   node scripts/assert-ran.mjs FILE "what the step shows"
//
// It exits 0 when at least one test passed and none was skipped, todo or failed;
// otherwise it says what it found and exits 1.

import { readFileSync } from "node:fs";

const [file, what = "the gated tests"] = process.argv.slice(2);
if (file === undefined) {
  console.error("usage: node scripts/assert-ran.mjs <vitest json report> [what the step shows]");
  process.exit(2);
}
const r = JSON.parse(readFileSync(file, "utf8"));
const found = { passed: r.numPassedTests, failed: r.numFailedTests, skipped_or_todo: r.numPendingTests + (r.numTodoTests ?? 0) };
if (!(found.passed >= 1) || found.failed !== 0 || found.skipped_or_todo !== 0) {
  console.error(`::error::${what}: expected at least one passed test and none skipped or failed, found ${JSON.stringify(found)}`);
  process.exit(1);
}
console.log(`${what}: ${found.passed} tests passed, none skipped`);
