import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, type CheckResult } from "../src/check.js";
import type { Diagnostic } from "../src/diag.js";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function readRepo(path: string): string {
  return readFileSync(repoRoot + path, "utf8");
}

export function syntaxFixtures(): string[] {
  return readdirSync(repoRoot + "compiler/test/fixtures/syntax")
    .filter((f) => f.endsWith(".mdt"))
    .map((f) => `compiler/test/fixtures/syntax/${f}`);
}

/**
 * The lock of a program, as a path in the repository: `<name>.lock.json` beside it when that exists
 * (`reach.mdt` has `reach.lock.json`), else `mandate.lock.json` beside it, else none.
 */
export function lockFileOf(source: string): string | undefined {
  const dir = source.slice(0, source.lastIndexOf("/") + 1);
  const name = source.slice(dir.length).replace(/\.[^.]*$/, "");
  return [`${dir}${name}.lock.json`, `${dir}mandate.lock.json`].find((path) => existsSync(repoRoot + path));
}

export function checkJson(value: unknown): CheckResult {
  return check(JSON.stringify(value), "json");
}

export function codes(diags: Diagnostic[]): string[] {
  return diags.map((d) => d.code);
}

/** The smallest valid program, as JSON IR. */
export function minimal(): Record<string, unknown> {
  return {
    language: "mandate/0.1",
    module: "example.minimal",
    version: "0.1",
    defs: {
      Greeting: { kind: "type", type: { ref: "Text" } },
    },
  };
}

/**
 * `check`, less the two W0601 that `Moved` in fixtures/envelope/migrate-all.mdt gives: its static criteria need
 * the run's values, so they become run-time checks. The tests of that fixture are about what they change in it;
 * envelope.test.ts has the one test that states these warnings.
 */
export const checkLessMoved: typeof check = (...args) => {
  const r = check(...args);
  return { ...r, diagnostics: r.diagnostics.filter((d) => !(d.code === "MDT-W0601" && (d.at.path ?? "").startsWith("/defs/Moved/"))) };
};
