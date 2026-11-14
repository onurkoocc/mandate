#!/usr/bin/env node
// Writes crates/mandate-check/tests/statics/expected.json: what the TypeScript
// compiler gives for the inputs of crates/mandate-check/tests/statics/inputs.json
// from its static checks (compiler/src/check/static.ts, through check), its
// types (compiler/src/check/ty.ts: assignable, show) and its cost model
// (compiler/src/check/cost.ts: staticCost, microsText), and leadClasses, so that
// the Rust port of them (crates/mandate-check/src/statics, ty.rs, cost.rs) is
// tested against the TypeScript on what no stored result reaches: the codes no
// conformance case has, the order the memos of constants and functions give,
// the canonical order of definitions, criteria, fields and branches, the node
// count, sums and products past 2^53 (crates/mandate-check/tests/statics.rs
// reads both files).
//
//   npm ci --ignore-scripts && npm run build    (once: it reads compiler/dist)
//   node scripts/static-vectors.mjs
//
// The inputs are written by hand; each result is held as its JSON.stringify
// text, so that a number past 2^53 or a fraction reaches the Rust test as the
// TypeScript wrote it. A check is check(text, kind, { modules, claim }) as its
// { ok, diagnostics }, or { throws } with the message when it throws; a cost is
// staticCost(program, workflow, link(program, modules).defs) for every
// workflow of every check whose program loads and of the fixtures listed; a
// lead is leadClasses(program, linked) of every check that passes. Running it
// again writes the same bytes.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const root = new URL("..", import.meta.url);
const dist = (path) => import(new URL(`compiler/dist/${path}`, root).href);
const { check, load, loadModules, kindOf } = await dist("check.js");
const { link } = await dist("modules.js");
const { staticCost, microsText } = await dist("check/cost.js");
const { leadClasses } = await dist("check/static.js");
const { assignable, show } = await dist("check/ty.js");

const dir = new URL("crates/mandate-check/tests/statics/", root);
const inputs = JSON.parse(readFileSync(new URL("inputs.json", dir), "utf8"));
const read = (file) => readFileSync(new URL(file, root), "utf8");

/** The text and kind a check input is given as. */
const source = (c) => (c.mdt ? { text: `${c.mdt.join("\n")}\n`, kind: "mdt" } : { text: JSON.stringify(c.ir, null, 2), kind: "json" });

/** `f()` as JSON text, or the message it throws. */
const attempt = (f) => {
  try {
    return { result: JSON.stringify(f()) ?? null };
  } catch (e) {
    return { throws: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
};

/** Every workflow of `program`, costed with `modules`. */
const costsOf = (name, program, modules) =>
  Object.entries(program.defs)
    .filter(([, d]) => d.kind === "workflow")
    .map(([workflow]) => ({ name, workflow, ...attempt(() => staticCost(program, workflow, link(program, modules).defs)) }));

const checks = [];
const costs = [];
const leads = [];
for (const c of inputs.checks) {
  const { text, kind } = source(c);
  const opts = { ...(c.modules ? { modules: c.modules } : {}), ...(c.claim ? { claim: c.claim } : {}) };
  const out = attempt(() => {
    const r = check(text, kind, opts);
    return { ok: r.ok, diagnostics: r.diagnostics };
  });
  checks.push({ name: c.name, ...out });
  const loaded = load(text, kind);
  if (loaded.program) costs.push(...costsOf(c.name, loaded.program, c.modules ?? {}));
  if (out.result && JSON.parse(out.result).ok) {
    leads.push({ name: c.name, ...attempt(() => leadClasses(loaded.program, link(loaded.program, c.modules ?? {}).defs)) });
  }
}
for (const f of inputs.costs) {
  const { modules } = loadModules(f.modules.map((file) => ({ text: read(file), kind: kindOf(file), file })));
  const program = load(read(f.file), kindOf(f.file)).program;
  costs.push(...costsOf(f.file, program, modules));
  leads.push({ name: f.file, ...attempt(() => leadClasses(program, link(program, modules).defs)) });
}

/**
 * The program of a deep shape: `fns` functions (constants, types), each
 * calling the next under `depth` levels of the form `shape`. The same rule
 * as deep_program in crates/mandate-check/tests/statics.rs.
 */
function deepProgram(shape, fns, depth) {
  const lines = [];
  const nest = (e, wrap) => {
    for (let k = 0; k < depth; k++) e = wrap(e);
    return e;
  };
  if (shape === "const") {
    lines.push("module m @ 0.1");
    for (let i = 0; i < fns; i++) lines.push(`let c${i} = ${nest(i + 1 < fns ? `c${i + 1}` : "1", (e) => `${e}.a`)}`);
  } else if (shape === "types") {
    lines.push("module m @ 0.1");
    for (let i = 0; i + 1 < fns; i++) lines.push(`type T${i} = { a: ${nest(i + 2 < fns ? `T${i + 1}` : "Int", (t) => `List<${t}>`)} } classified internal`);
    lines.push("fn f(x: T0) -> Int { x }");
  } else if (["field", "not", "list", "paren"].includes(shape)) {
    const wrap = { field: (e) => `${e}.a`, not: (e) => `not ${e}`, list: (e) => `[${e}]`, paren: (e) => `(1 + ${e})` }[shape];
    lines.push("module m @ 0.1");
    for (let i = 0; i < fns; i++) lines.push(`fn f${i}(n: Int) -> Int { ${nest(i + 1 < fns ? `f${i + 1}(n)` : "n", wrap)} }`);
  } else {
    const wrap = {
      if: (e) => `if n == 1 {\n${e}\n}`,
      record: (e) => `R { a: ${e} }`,
      switch: (e) => `switch n {\n_ => ${e}\n}`,
      delegate: (e) => `delegate A.s(${e})`,
      map: (e) => `map x in [n] max 1 {\n${e}\n}`,
    }[shape];
    lines.push("mandate @ 0.4", "module m @ 0.1", "use std.{model}", "type R = { a: Int }", "capability M = model.infer(tier: standard)");
    lines.push("agent A {", "  caps M", "  budget { steps: 3 }", "  skill s(t: Inferred<Int>) -> Int ! {Model}", "}");
    for (let i = 0; i < fns; i++) lines.push(`fn f${i}(n: Int) -> Int {\n${nest(i + 1 < fns ? `f${i + 1}(n)` : "n", wrap)}\n}`);
  }
  return `${lines.join("\n")}\n`;
}

/** `check` of each text in a worker thread with a stack of `mb` megabytes, as `{ result }` or `{ throws }`. */
async function checkedWithStack(texts, mb) {
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { check } = await import(workerData.check);
  parentPort.postMessage(workerData.texts.map((text) => {
    try {
      const r = check(text, "mdt");
      return { result: JSON.stringify({ ok: r.ok, diagnostics: r.diagnostics }) };
    } catch (e) {
      return { throws: e instanceof Error ? e.name + ": " + e.message : String(e) };
    }
  }));
})();`,
    { eval: true, workerData: { check: new URL("compiler/dist/check.js", root).href, texts }, resourceLimits: { stackSizeMb: mb } },
  );
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

const sha256 = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const deepShapes = inputs.deep.shapes;
const deepResults = await checkedWithStack(deepShapes.map(([shape, fns, depth]) => deepProgram(shape, fns, depth)), 256);
const deep = deepShapes.map(([shape, fns, depth], i) => {
  const r = deepResults[i];
  if (r.throws) return { name: `${shape}:${fns}:${depth}`, throws: r.throws };
  const parsed = JSON.parse(r.result);
  return { name: `${shape}:${fns}:${depth}`, ok: parsed.ok, diagnostics: parsed.diagnostics.length, digest: sha256(r.result) };
});

const types = load(`${inputs.types.join("\n")}\n`, "mdt").program.defs;
const env = {
  typeDef: (n) => (Object.hasOwn(types, n) && types[n].kind === "type" ? types[n] : undefined),
  isContract: (n) => Object.hasOwn(types, n) && types[n].kind === "contract",
};
const out = {
  checks,
  deep,
  costs,
  leads,
  assignable: inputs.assignable.map(([a, e]) => JSON.stringify(assignable(a, e, env) ?? null)),
  show: inputs.show.map((t) => show(t)),
  micros: inputs.micros.map(([m, currency]) => microsText(Number(m), currency)),
};
const ascii = (text) => text.replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
writeFileSync(new URL("expected.json", dir), ascii(JSON.stringify(out, null, 2)) + "\n");
