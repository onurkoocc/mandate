// What a test run of a workspace needs of the compiler behind the bridge, for vitest: `compilerGlobalSetup` (once, in
// vitest's own process, with its teardown). The runtime's vitest configuration uses it too (runtime/test/global-setup.ts).
//
// - The run needs the Rust compiler's module, in the bridge's own place with its digest (`npm run build:wasm`), or
//   where MANDATE_WASM names it: when it is not there or is refused, the run stops before any test, saying why and how
//   to build one. Nothing is put in the environment: a child process a test starts inherits MANDATE_WASM from the
//   test's own environment, and finds the module where the bridge it runs finds it (test/tree.ts copies it into a
//   tree it builds, and the runtime's bundles keep the bridge's own address).
// - What a test notes for the run's end (`note`, the timing gate's numbers) is printed when the run ends.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_HINT, compileModuleAt, modulePlace } from "../src/wasm/module.js";

const KEY = "mandateReport";

/** vitest's globalSetup: checks for the module, and opens the directory the workers' notes are written to. */
export function compilerGlobalSetup(project: { provide(key: string, value: unknown): void }): () => void {
  try {
    compileModuleAt(modulePlace());
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`The tests need the Rust compiler's WebAssembly module, and have none they take: ${why}${why.includes(BUILD_HINT) ? "" : `. ${BUILD_HINT}`}.`);
  }
  const dir = mkdtempSync(join(tmpdir(), "mandate-report-"));
  project.provide(KEY, dir);
  return () => {
    const notes: string[] = [];
    for (const f of readdirSync(dir).sort()) notes.push(readFileSync(join(dir, f), "utf8"));
    rmSync(dir, { recursive: true, force: true });
    if (notes.length) process.stdout.write(`\n${notes.join("\n")}\n`);
  };
}

/** A line for the end of the run: what `inject` gives in a test file's worker is the directory to write it to. */
export function note(dir: unknown, text: string): void {
  if (typeof dir !== "string") return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}-${Math.random().toString(36).slice(2)}.txt`), text);
}

export const REPORT_KEY = KEY;
