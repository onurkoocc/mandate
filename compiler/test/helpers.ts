import { readFileSync, readdirSync } from "node:fs";
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
