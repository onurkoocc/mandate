#!/usr/bin/env node
// Writes crates/mandate-views/tests/data/acs/expected.json: what the TypeScript
// compiler gives for the inputs of crates/mandate-views/tests/data/acs/inputs.json
// from acsTarget (compiler/src/target/acs.ts: each local agent's ACS manifest and
// Rego policy, E0906 and W0907), so that the Rust port of it is held to the
// TypeScript (crates/mandate-views/tests/acs.rs reads both files). The groups
// of cases:
//
//   x05        the programs of compiler/test/acs.test.ts (case X05), with their
//              locks, as the test gives them. The first is the one whose Rego
//              the gated part of that test evaluates on a real OPA (MANDATE_OPA):
//              CI runs it against the TypeScript's Rego, and the Rust is held to
//              the same bytes, so what the OPA showed is true of the Rust too.
//              The whole Rego of that agent is committed here, with the hashes in
//              it written as BINDING and PROGRAM.
//   fixtures   every program under fixtures/ that has agents, with and without
//              its lock and with and without the modules it imports
//   branches   tests/data/acs/branches.mdt, one agent for each thing the target
//              does differently (no capability, only a read, only a write,
//              commands with and without prefixes, models of every class,
//              effects that stay with the runtime, a capability with no static
//              scope, euros, budgets in skills, escapes, colliding names), with
//              the locks of the repository, a lock with bindings, and the language
//              of the program changed (the sandbox requirement's format)
//   locks      tests/data/acs/small.mdt with locks that are not locks, locks
//              that map a tier to a list, a model, nothing, or a model that is
//              no text, names that sort differently by UTF-16 code units and by
//              code points, a tier named constructor
//   numbers    budgets of every size and kind: tokens, time, spend, the skills'
//   errors     E0906 for a capability with no scope and for a currency, W0907 and
//              when it is not given, remote agents, programs with no agent
//   names      agents named with non-ASCII letters (İ and the Kelvin sign
//              lowercase to ASCII), quotes, slashes, __proto__, constructor, an
//              index, the empty name; and the order of agents and diagnostics
//   malformed  inputs the TypeScript throws on and the Rust does not (their
//              expected value is the TypeError; inputs.json says what the Rust
//              gives instead and why)
//
//   npm ci --ignore-scripts && npm run build    (once: it reads compiler/dist)
//   node scripts/acs-vectors.mjs                (writes expected.json)
//   node scripts/acs-vectors.mjs --show NAME    (prints what the TypeScript
//                                                gives for one input, whole)
//
// Each result is held as the SHA-256 digest (the first 16 hex digits) of the
// text JSON.stringify writes for the whole target, so that every character of
// every manifest and Rego text is held; beside it, for each agent, the digest
// of its manifest, its Rego and its sandbox requirement, and (the first time a
// Rego text appears) the lines of it that vary (the roots, the commands, the
// tools, the limits, the models), so that a difference can be read. Running it
// again writes the same bytes.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const dist = (path) => import(new URL(`compiler/dist/${path}`, root).href);
const { check, kindOf, load, loadModules } = await dist("check.js");
const { parseStrictJson } = await dist("json/strict-json.js");
const { acsTarget } = await dist("target/acs.js");

const dir = new URL("crates/mandate-views/tests/data/acs/", root);
const inputs = JSON.parse(readFileSync(new URL("inputs.json", dir), "utf8"));
const show = process.argv.includes("--show") ? process.argv[process.argv.indexOf("--show") + 1] : undefined;

const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

/** The value as the strict reader makes it: objects without a prototype, as a program or a lock from a file has. */
const strict = (value) => {
  const r = parseStrictJson(JSON.stringify(value));
  if (!r.ok) throw new Error("not strict JSON");
  return r.value.value;
};

/** `edited(program, edits)`: a member set (or an element, or the whole value at []) or deleted. */
function edited(program, edits) {
  for (const e of edits ?? []) {
    const path = e.set ?? e.delete;
    let parent = program;
    for (const k of path.slice(0, -1)) parent = parent[k];
    const last = path[path.length - 1];
    if (e.set !== undefined) parent[last] = strict(e.to);
    else if (Array.isArray(parent)) parent.splice(last, 1);
    else delete parent[last];
  }
  return program;
}

function programOf(ref) {
  let program;
  if (ref.file !== undefined) {
    const loaded = load(readFileSync(new URL(ref.file, root), "utf8"), kindOf(ref.file));
    if (!loaded.program) throw new Error(`${ref.file} does not load`);
    program = strict(loaded.program);
  } else {
    program = strict(ref.raw);
  }
  return edited(program, ref.edit);
}

const lockOf = (c) => {
  if (c.lock_file !== undefined) return strict(JSON.parse(readFileSync(new URL(c.lock_file, root), "utf8")));
  if (c.lock_ref !== undefined) return strict(inputs.locks[c.lock_ref]);
  return c.lock === undefined ? undefined : strict(c.lock);
};

const modulesOf = (files) => {
  const { modules, problems } = loadModules((files ?? []).map((file) => ({ file, text: readFileSync(new URL(file, root), "utf8"), kind: kindOf(file) })));
  if (problems.length) throw new Error(`modules do not load: ${files}`);
  return modules;
};

/** The lines of a Rego text that change from agent to agent. */
const VARIES = /^(package|cwd|read_roots|write_roots|commands|tools|limits|models|max_class|binding|model_call) /;
const lines = (rego) => rego.split("\n").filter((l) => VARIES.test(l) && !l.startsWith("binding "));

function run(c) {
  const program = programOf(c.program);
  const lock = lockOf(c);
  const modules = modulesOf(c.modules);
  return { program, lock, modules, target: acsTarget(program, modules, lock) };
}

// The source of the euro program is the test's, as it is written there.
{
  const test = readFileSync(new URL("compiler/test/acs.test.ts", root), "utf8");
  const src = test.slice(test.indexOf("const src = `") + "const src = `".length, test.indexOf("`;", test.indexOf("const src = `")));
  const mdt = readFileSync(new URL("eur.mdt", dir), "utf8");
  if (!mdt.endsWith(src)) throw new Error("eur.mdt is not the source of the test in compiler/test/acs.test.ts");
}

function results() {
  const out = {};
  const shown = new Set();
  for (const c of inputs.cases) {
    if (Object.hasOwn(out, c.name)) throw new Error(`two cases are named ${c.name}`);
    let r;
    try {
      r = run(c);
    } catch (e) {
      if (!c.known_difference) throw new Error(`${c.name}: the TypeScript throws: ${e.message}`);
      out[c.name] = { threw: `${e.name}: ${e.message}` };
      continue;
    }
    if (c.known_difference) throw new Error(`${c.name}: is listed as one the TypeScript throws on, and it does not`);
    const { target: t } = r;
    const whole = JSON.stringify(t);
    // Same input, same output.
    if (JSON.stringify(acsTarget(r.program, r.modules, r.lock)) !== whole) throw new Error(`${c.name}: acsTarget is not deterministic`);
    const agents = {};
    for (const [name, a] of Object.entries(t.agents)) {
      const rego = digest(a.rego);
      // The lines are there to be read when a digest differs; a Rego text that an earlier case has shown is not shown again.
      agents[name] = { manifest: digest(JSON.stringify(a.manifest)), rego, requirement: digest(JSON.stringify(a.requirement)), ...(shown.has(rego) ? {} : { lines: lines(a.rego) }) };
      shown.add(rego);
    }
    out[c.name] = {
      agents: Object.keys(t.agents),
      codes: t.diagnostics.map((d) => d.code),
      // W0907 says the same in every case, and its text is held by the digest of the whole.
      diagnostics: t.diagnostics.map((d) => (d.code === "MDT-W0907" ? `${d.code} ${d.at.path} (${d.facts.not_carried.length} guarantees)` : `${d.code} ${d.at.path} ${d.message}`)),
      whole: digest(whole),
      whole_length: whole.length,
      program: digest(t.program),
      binding: digest(t.binding),
      by_agent: agents,
    };
    if (c.opa) {
      // The Rego the gated test sends to OPA, whole: the binding and the program hash are the two hashes in it.
      const name = c.opa;
      out[c.name].rego_text = { agent: name, text: t.agents[name].rego.replaceAll(t.binding, "BINDING").replaceAll(t.program, "PROGRAM") };
    }
    if (c.group === "x05") {
      // The test calls check() and passes its program; load() gives the same one.
      const src = readFileSync(new URL(c.program.file, root), "utf8");
      const l = lockOf(c);
      const checked = check(src, kindOf(c.program.file), l ? { lock: l } : {});
      if (JSON.stringify(acsTarget(checked.program, {}, l)) !== whole) throw new Error(`${c.name}: check() and load() give different targets`);
    }
    if (show === c.name) {
      console.log(JSON.stringify({ ...t, agents: Object.keys(t.agents) }, null, 2));
      for (const [n, a] of Object.entries(t.agents)) console.log(`\n---- ${n}.manifest.json\n${JSON.stringify(a.manifest, null, 2)}\n---- ${n}.rego\n${a.rego}\n---- ${n}.sandbox-requirement.json\n${JSON.stringify(a.requirement, null, 2)}`);
    }
  }
  return out;
}

const out = { format: "mandate/acs-vectors/expected/0.1", cases: results() };
if (show === undefined) {
  const ascii = (text) => text.replace(/[^\x00-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const line = (x) => ascii(JSON.stringify(x));
  const cases = Object.entries(out.cases).map(([n, x]) => `    ${line(n)}: ${line(x)}`);
  writeFileSync(new URL("expected.json", dir), `{\n  ${line("format")}: ${line(out.format)},\n  "cases": {\n${cases.join(",\n")}\n  }\n}\n`);
}
