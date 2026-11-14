#!/usr/bin/env node
// Writes crates/mandate-check/tests/lock/expected.json: what the TypeScript
// compiler gives for the inputs of crates/mandate-check/tests/lock/inputs.json
// from the lock (compiler/src/lock.ts), the Managed Agents binding checks
// (compiler/src/target/managed-agents.ts) and the sandbox requirements
// (compiler/src/target/sandbox.ts), so that the branches no stored result of
// the corpus, the conformance cases or the golden outputs reaches, and the
// hand-ported JavaScript in the Rust port of them (double arithmetic, the
// coercions of a lock that was not validated, Object.prototype names, the
// order of object members, sorting by UTF-16 code units), are tested against
// the TypeScript (crates/mandate-check/tests/lock.rs reads both files).
//
//   npm ci --ignore-scripts && npm run build    (once: it reads compiler/dist)
//   node scripts/lock-vectors.mjs
//
// The inputs are written by hand to reach those branches; each result is the
// text JSON.stringify gives for what the function returns (a Set as an array,
// `undefined` as null, a function that throws as { "throws": message }), so
// that a number the strict reader of the Rust port would refuse (a double
// beyond 2^53, NaN written as null) is compared as text. Running it again
// writes the same bytes. A `check` is compared on the
// diagnostics of the lock (E0140-E0142, E0504 and W0504, E0903-E0905, E1502,
// E1802, E1803) and on `ok`; it stops when a `check` gives an error of any
// other stage, since these inputs are meant to reach the lock alone.

import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const dist = (path) => import(new URL(`compiler/dist/${path}`, root).href);
const { check, load } = await dist("check.js");
const { link, linkedProgram } = await dist("modules.js");
const { lockChecks, moduleLockChecks, roleLockChecks, sandboxLockChecks, validateLock, packagedLock, own, perCallBound, modelTiers } = await dist("lock.js");
const { agentModels, bindingChecks } = await dist("target/managed-agents.js");
const { sandboxRequirements, requirementFor, floorFor, coTenancyFor, denialDiagnostics, ISOLATION_LEVELS } = await dist("target/sandbox.js");
const { DATA_CLASSES } = await dist("std/std.js");

const dir = new URL("crates/mandate-check/tests/lock/", root);
const inputs = JSON.parse(readFileSync(new URL("inputs.json", dir), "utf8"));

const programs = new Map();
const program = (name) => {
  if (!programs.has(name)) {
    const r = load(inputs.programs[name], "mdt");
    if (!r.program) throw new Error(`the program ${name} does not load: ${JSON.stringify(r.diagnostics)}`);
    programs.set(name, r.program);
  }
  return programs.get(name);
};
const modulesOf = (names) =>
  Object.fromEntries(
    names.map((n) => {
      const r = load(inputs.modules[n], "mdt");
      if (!r.program) throw new Error(`the module ${n} does not load`);
      return [n, r.program];
    }),
  );

/** The codes of the lock's stages: a check is compared on these alone. */
const LOCK_CODES = /^MDT-(E014[012]|W0504|E0504|E090[345]|E1502|E180[23])$/;

const section = (items, run) => {
  const out = {};
  for (const item of items) {
    if (Object.hasOwn(out, item.id)) throw new Error(`the id ${item.id} is given twice`);
    let text;
    try {
      text = JSON.stringify(run(item));
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      text = JSON.stringify({ throws: e.message });
    }
    out[item.id] = text ?? "null";
  }
  return out;
};
/** A section whose calls must not throw: the Rust port does not imitate an exception there. */
const noThrow = (items, run) => {
  const out = section(items, run);
  for (const [id, text] of Object.entries(out)) if (text.startsWith('{"throws"')) throw new Error(`${id} throws: ${text}`);
  return out;
};

const checks = noThrow(inputs.checks, (c) => {
  const r = check(inputs.programs[c.program], "mdt", { modules: modulesOf(c.modules), lock: c.lock });
  // A warning of the static checks is left out; an error of any other stage would change `ok` and is refused.
  const stray = r.diagnostics.filter((d) => !LOCK_CODES.test(d.code) && d.severity === "error");
  if (stray.length) throw new Error(`the check ${c.id} gives ${stray.map((d) => d.code).join(", ")}, which is not a code of the lock`);
  return { ok: r.ok, diagnostics: r.diagnostics.filter((d) => LOCK_CODES.test(d.code)) };
});

const direct = noThrow(inputs.direct, (c) => {
  const p = program(c.program);
  const modules = modulesOf(c.modules);
  switch (c.fn) {
    case "lockChecks":
      return lockChecks(linkedProgram(p, modules), c.lock);
    case "bindingChecks":
      return bindingChecks(linkedProgram(p, modules), c.lock);
    case "sandboxLockChecks":
      return sandboxLockChecks(linkedProgram(p, modules), c.lock);
    case "roleLockChecks":
      return roleLockChecks(p, link(p, modules), c.lock);
    case "moduleLockChecks":
      return moduleLockChecks(p, c.lock, modules);
    default:
      throw new Error(`no function ${c.fn}`);
  }
});

const sandbox = noThrow(inputs.sandbox, (c) => sandboxRequirements(program(c.program), modulesOf(c.modules), Object.hasOwn(c, "lock") ? c.lock : undefined));

const requirements = noThrow(inputs.requirements, (c) => requirementFor(c.subject, c.caps, c.timeout, { ...(c.language !== undefined ? { language: c.language } : {}), ...(Object.hasOwn(c, "lock") ? { lock: c.lock } : {}) }));

const isolation = noThrow(inputs.isolation, (c) => {
  const iso = c.iso;
  return {
    levels: ISOLATION_LEVELS,
    floor: Object.fromEntries(DATA_CLASSES.map((k) => [k, floorFor(iso, k)])),
    co_tenancy: Object.fromEntries(DATA_CLASSES.map((k) => [k, coTenancyFor(iso, k)])),
  };
});

const bounds = noThrow(inputs.bounds, (c) => perCallBound(c.lock, c.tier) ?? null);

const models = noThrow(inputs.models, (c) => {
  const p = linkedProgram(program(c.program), modulesOf(c.modules));
  return {
    tiers: [...modelTiers(p)],
    agents: Object.fromEntries(Object.entries(p.defs).filter(([, d]) => d.kind === "agent").map(([n, d]) => [n, agentModels(p, d)])),
  };
});

const packaged = noThrow(inputs.packaged, (c) => packagedLock(Object.hasOwn(c, "lock") ? c.lock : undefined));

const owns = noThrow(inputs.own, (c) => ({ value: own(Object.hasOwn(c, "o") ? c.o : undefined, c.k) }));

// A denial report that makes the function throw is a result: its message.
const denials = section(inputs.denials, (c) => denialDiagnostics(program(c.program), c.report));

const validate = noThrow(inputs.validate, (c) => validateLock(Object.hasOwn(c, "value") ? c.value : undefined));

const out = { checks, direct, sandbox, requirements, isolation, bounds, models, packaged, own: owns, denials, validate };
const ascii = (text) => text.replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
// One result a line, so that a difference shows as one.
const lines = [];
for (const [name, results] of Object.entries(out)) {
  const items = Object.entries(results).map(([id, text]) => `  ${JSON.stringify(id)}: ${JSON.stringify(text)}`);
  lines.push(` ${JSON.stringify(name)}: {\n${items.join(",\n")}\n }`);
}
writeFileSync(new URL("expected.json", dir), ascii(`{\n${lines.join(",\n")}\n}\n`));
