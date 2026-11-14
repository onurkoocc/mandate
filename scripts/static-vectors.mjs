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

import { readFileSync, writeFileSync } from "node:fs";

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

const types = load(`${inputs.types.join("\n")}\n`, "mdt").program.defs;
const env = {
  typeDef: (n) => (Object.hasOwn(types, n) && types[n].kind === "type" ? types[n] : undefined),
  isContract: (n) => Object.hasOwn(types, n) && types[n].kind === "contract",
};
const out = {
  checks,
  costs,
  leads,
  assignable: inputs.assignable.map(([a, e]) => JSON.stringify(assignable(a, e, env) ?? null)),
  show: inputs.show.map((t) => show(t)),
  micros: inputs.micros.map(([m, currency]) => microsText(Number(m), currency)),
};
const ascii = (text) => text.replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
writeFileSync(new URL("expected.json", dir), ascii(JSON.stringify(out, null, 2)) + "\n");
