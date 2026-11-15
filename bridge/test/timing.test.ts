// The timing gate of the Rust path: what a call through the module costs beside the TypeScript's, measured in the
// run and held under a generous bound (a call is a fresh instance of the module: about 0.1 ms to make, and a few
// milliseconds for a check). The numbers are printed at the end of the run.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, inject, it } from "vitest";
import * as reference from "../src/ts.js";
import * as rust from "../src/rust.js";
import { modulePath } from "../src/wasm/module.js";
import { note, REPORT_KEY } from "./compiler-setup.js";
import { repoRoot } from "./tree.js";

const there = existsSync(modulePath());
const needs = there ? describe : describe.skip;

/** The median and the 90th percentile of `n` runs of `f`, in milliseconds, after two runs to warm up. */
function measure(f: () => unknown, n: number): { median: number; p90: number } {
  f();
  f();
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    f();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(n / 2)]!, p90: times[Math.floor(n * 0.9)]! };
}

const ms = (x: number): string => `${x.toFixed(2)} ms`;
const lines: string[] = [];

/** How the interpreter asks mapScopes for a map of `items` items, `caps` capabilities each: after each item, then once with all. */
function mapAsTheInterpreterAsks(m: typeof reference.mapScopes, items: number, caps: number): void {
  const context = { bounds: [{ ctor: "fs.write", effect: "Fs.Write", write: true, scope: ["/work"] }, { ctor: "model.infer", effect: "Model", write: false, tier: "standard" }], given: [], handed: [] };
  const all = Array.from({ length: items }, (_, i) => Array.from({ length: caps }, (_, j) => ({ ctor: "fs.write", effect: "Fs.Write", write: true, scope: [`/work/item-${i}/part-${j}`] })));
  for (let i = 1; i <= items; i++) m({ map: "/defs/W/body/0/value", par: 4, context, items: all.slice(0, i), complete: false });
  m({ map: "/defs/W/body/0/value", par: 4, context, items: all, complete: true });
}

needs("the timing gate of the Rust path", () => {
  const text = readFileSync(join(repoRoot, "fixtures", "fixbug", "fixbug.mdt"), "utf8");
  const program = reference.check(text, "mdt").program!;
  const cap = { ctor: "fs.write", effect: "Fs.Write", write: true, scope: ["/work/repos"], name: "SrcWrite" };

  it("a small call costs the Rust path a few milliseconds more than the TypeScript, and a check of a program tens", () => {
    const small = { ts: measure(() => reference.showCap(cap), 200), rust: measure(() => rust.showCap(cap), 200) };
    const checks = { ts: measure(() => reference.check(text, "mdt"), 40), rust: measure(() => rust.check(text, "mdt"), 40) };
    const hash = { ts: measure(() => reference.hashProgram(program as never), 40), rust: measure(() => rust.hashProgram(program as never), 40) };
    const e = (program.defs["Implementer"] as unknown as { caps: Parameters<typeof reference.capsOf>[1][] }).caps[0]!;
    const caps = { ts: measure(() => reference.capsOf(program.defs, e), 100), rust: measure(() => rust.capsOf(program.defs, e), 100) };
    lines.push(
      "timing of the Rust path (median, 90th percentile; TypeScript beside it):",
      `  showCap, a small call:           ${ms(small.rust.median)}, ${ms(small.rust.p90)}   (TypeScript ${ms(small.ts.median)})`,
      `  check of fixbug.mdt:             ${ms(checks.rust.median)}, ${ms(checks.rust.p90)}   (TypeScript ${ms(checks.ts.median)})`,
      `  hashProgram of its IR:           ${ms(hash.rust.median)}, ${ms(hash.rust.p90)}   (TypeScript ${ms(hash.ts.median)})`,
      `  capsOf over its definitions:     ${ms(caps.rust.median)}, ${ms(caps.rust.p90)}   (TypeScript ${ms(caps.ts.median)})`,
    );
    // Generous: some ten times what this machine measures, for a loaded CI runner.
    expect(small.rust.median - small.ts.median).toBeLessThan(25);
    expect(checks.rust.median).toBeLessThan(250);
    expect(hash.rust.median).toBeLessThan(100);
    expect(caps.rust.median).toBeLessThan(100);
  }, 120_000);

  it("mapScopes as the interpreter asks it, after every item: a map of 60 items and one of 1000", () => {
    const at = (items: number, n: number): { ts: number; rust: number } => {
      const t = (m: typeof reference.mapScopes): number => {
        const times: number[] = [];
        for (let i = 0; i < n; i++) {
          const s = performance.now();
          mapAsTheInterpreterAsks(m, items, 3);
          times.push(performance.now() - s);
        }
        return times.sort((a, b) => a - b)[Math.floor(n / 2)]!;
      };
      return { ts: t(reference.mapScopes), rust: t(rust.mapScopes) };
    };
    const small = at(60, 5);
    const large = at(1000, 1);
    lines.push(
      `  mapScopes, a map of 60 items with 3 capabilities each (61 calls): ${ms(small.rust)}   (TypeScript ${ms(small.ts)})`,
      `  mapScopes, a map of 1000 items with 3 capabilities each (1001 calls): ${ms(large.rust)}   (TypeScript ${ms(large.ts)})`,
    );
    expect(small.rust).toBeLessThan(2_000);
    expect(large.rust).toBeLessThan(120_000);
    note(inject(REPORT_KEY as never), lines.join("\n"));
  }, 300_000);
});
