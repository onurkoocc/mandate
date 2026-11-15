// What a test run of a workspace needs of the compiler behind the bridge, for vitest: `compilerGlobalSetup` (once,
// in vitest's own process, with its teardown) and `compilerSetup` (in each test file's worker). The runtime's
// vitest configuration uses them too (runtime/test/global-setup.ts, runtime/test/setup.ts).
//
// - In `rust` and `both` mode (MANDATE_COMPILER) the run needs the Rust compiler's module, in the bridge's own place
//   with its digest (`npm run build:wasm`), or where MANDATE_WASM names it: when it is not there or is refused, the
//   run stops before any test, saying why and how to build one. Nothing is put in the environment: a child process a
//   test starts finds the module where the bridge it runs finds it (test/tree.ts copies it into a tree it builds, and
//   the runtime's bundles keep the bridge's own address). In `ts` mode, the default, nothing is looked for: a run
//   needs neither the module nor any dist/.
// - A CompilerDivergence (compare.ts) fails the test that made it, also when the code under test caught it: each
//   test's are taken after it, and those a file's own last hooks made after its last test, after the file.
// - Each worker's counts of `both` (how many calls each named exemption excused, how many of language 0.6 skipped
//   the TypeScript, how many were compared), and what a test notes for the run's end (`note`, the timing gate's
//   numbers), are printed when the run ends.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exemptionCounts, PROCESS_MODE, takeDivergences } from "../src/mode.js";
import { BUILD_HINT, compileModuleAt, modulePlace } from "../src/wasm/module.js";

const KEY = "mandateReport";

/** vitest's globalSetup: checks for the module the mode needs, and opens the directory the workers report to. */
export function compilerGlobalSetup(project: { provide(key: string, value: unknown): void }): () => void {
  let path = "(none)";
  if (PROCESS_MODE !== "ts") {
    try {
      const place = modulePlace();
      path = place.path;
      compileModuleAt(place);
    } catch (e) {
      throw new Error(`MANDATE_COMPILER=${PROCESS_MODE} needs the Rust compiler's WebAssembly module, and has none it takes: ${e instanceof Error ? e.message : String(e)}. ${BUILD_HINT}.`);
    }
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
    if (typeof dir === "string" && Object.keys(counts).length) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${process.pid}-${Math.random().toString(36).slice(2)}.counts.json`), JSON.stringify(counts));
    }
    // What the file's own afterAll hooks (which run before this one, registered first) found after its last test.
    const left = takeDivergences();
    if (left.length) throw new Error(`${left.length} call(s) the two compilers answered differently after the file's last test:\n${left.map((d) => d.message).join("\n")}`);
  });
}

export const REPORT_KEY = KEY;
