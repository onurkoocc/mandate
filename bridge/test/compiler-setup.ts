// What a test run of a workspace needs of the compiler behind the bridge, for vitest: `compilerGlobalSetup` (once,
// in vitest's own process, with its teardown) and `compilerSetup` (in each test file's worker). The runtime's
// vitest configuration uses them too (runtime/test/global-setup.ts, runtime/test/setup.ts).
//
// - In `rust` and `both` mode (MANDATE_COMPILER) the run needs the Rust compiler's module: when there is none, the
//   run stops before any test, saying where it looked and how to build one. Its absolute path is put in MANDATE_WASM,
//   so that a test's child process, which may run from a copy of the sources elsewhere, finds the same module. In
//   `ts` mode, the default, nothing is looked for: a run needs neither the module nor any dist/.
// - A CompilerDivergence (compare.ts) fails the test that made it, also when the code under test caught it: each
//   test's are taken after it, and any is an error.
// - Each worker's counts of `both` (how many calls each named exemption excused, how many of language 0.6 skipped
//   the TypeScript, how many were compared), and what a test notes for the run's end (`note`, the timing gate's
//   numbers), are printed when the run ends.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exemptionCounts, PROCESS_MODE, takeDivergences } from "../src/mode.js";
import { BUILD_HINT, modulePath } from "../src/wasm/module.js";

const KEY = "mandateReport";

/** vitest's globalSetup: checks for the module the mode needs, and opens the directory the workers report to. */
export function compilerGlobalSetup(project: { provide(key: string, value: unknown): void }): () => void {
  const path = modulePath();
  if (PROCESS_MODE !== "ts") {
    if (!existsSync(path)) throw new Error(`MANDATE_COMPILER=${PROCESS_MODE} needs the Rust compiler's WebAssembly module, and there is none at ${path}: ${BUILD_HINT}.`);
    process.env["MANDATE_WASM"] = path;
  }
  const dir = mkdtempSync(join(tmpdir(), "mandate-report-"));
  project.provide(KEY, dir);
  return () => {
    const total: Record<string, number> = {};
    const notes: string[] = [];
    for (const f of readdirSync(dir).sort()) {
      const text = readFileSync(join(dir, f), "utf8");
      if (f.endsWith(".counts.json")) for (const [k, n] of Object.entries(JSON.parse(text) as Record<string, number>)) total[k] = (total[k] ?? 0) + n;
      else notes.push(text);
    }
    rmSync(dir, { recursive: true, force: true });
    const lines = [...notes];
    if (PROCESS_MODE !== "ts") {
      const rows = Object.entries(total).filter(([k]) => k !== "compared").sort(([a], [b]) => (a < b ? -1 : 1));
      lines.push(`MANDATE_COMPILER=${PROCESS_MODE} (module ${path}): calls compared ${total["compared"] ?? 0}; calls excused or not compared, by rule:${rows.length ? "" : " none"}`, ...rows.map(([k, n]) => `  ${k}: ${n}`));
    }
    if (lines.length) process.stdout.write(`\n${lines.join("\n")}\n`);
  };
}

/** A line for the end of the run: what `inject` gives in a test file's worker is the directory to write it to. */
export function note(dir: unknown, text: string): void {
  if (typeof dir !== "string") return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}-${Math.random().toString(36).slice(2)}.txt`), text);
}

/** The part of a test file's setup that fails a test that made a divergence, and writes the file's counts at its end. */
export function compilerSetup(hooks: { afterEach(f: () => void): void; afterAll(f: () => void): void; inject(key: string): unknown }): void {
  hooks.afterEach(() => {
    const found = takeDivergences();
    if (found.length) throw new Error(`${found.length} call(s) the two compilers answered differently:\n${found.map((d) => d.message).join("\n")}`);
  });
  hooks.afterAll(() => {
    const dir = hooks.inject(KEY);
    const counts = Object.fromEntries(Object.entries(exemptionCounts()).filter(([, n]) => n > 0));
    if (typeof dir !== "string" || !Object.keys(counts).length) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.pid}-${Math.random().toString(36).slice(2)}.counts.json`), JSON.stringify(counts));
  });
}

export const REPORT_KEY = KEY;
