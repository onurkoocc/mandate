#!/usr/bin/env node
// Writes crates/mandate-check/tests/doors/expected.json: what the TypeScript
// compiler gives for the inputs of crates/mandate-check/tests/doors/inputs.json
// from the system model's checks (compiler/src/check/static.ts: checkSystem,
// checkRead, dataRead, changeset, through check) and from the three front doors
// of compiler/src/check.ts (checkPatch, checkSubprogram, checkAmendment, and
// subprogramLinked), with compiler/src/check/subprogram.ts and amendment.ts
// behind them, so that the Rust port of them (crates/mandate-check/src/statics/
// system.rs, doors.rs, subprogram.rs, amendment.rs) is tested against the
// TypeScript on what no stored result reaches: each code of the slice and each
// branch of a rule that has several, the doors' own order and shape, the
// locations in the re-written JSON text, and the JavaScript semantics the code
// depends on (crates/mandate-check/tests/doors.rs reads both files).
//
//   npm ci --ignore-scripts && npm run build    (once: it reads compiler/dist)
//   node scripts/doors-vectors.mjs
//
// The inputs are written by hand and read from that one file, plus the fixtures
// it names. A program is `{ file | mdt | ir, replace?, append?, edit? }`: its
// text (a fixture, lines, or an IR), with each `[from, to]` of `replace`
// applied once to the text, the lines of `append` added, and the loaded IR
// edited by `edit` (each `{ path, value }` sets, each `{ path, remove }`
// deletes, a list element is taken out); `{ from: "name", ... }` is a program
// of `programs` with its other members changed, and a bare name is that program.
// An answer is the sha256 of the JSON.stringify text of what the check or the
// door returns (a program as the sha256 of its text), with the code and path of
// each diagnostic, or the message of the Error it throws. An entry marked
// `held` is one whose result holds a diagnostic of a rule the Rust does not
// give yet (none today): its whole text is kept too, so that the Rust is held
// to it with some diagnostics left out; take the mark off, and the text, when
// the Rust gives the rule. Running it again writes the same bytes.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const dist = (path) => import(new URL(`compiler/dist/${path}`, root).href);
const { check, load, checkPatch, checkSubprogram, checkAmendment, subprogramLinked } = await dist("check.js");
const { skeleton } = await dist("check/subprogram.js");
const { hashProgram } = await dist("hash.js");
const { CAP_CTORS } = await dist("std/std.js");

const dir = new URL("crates/mandate-check/tests/doors/", root);
const inputs = JSON.parse(readFileSync(new URL("inputs.json", dir), "utf8"));
const read = (file) => readFileSync(new URL(file, root), "utf8");
const sha256 = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/**
 * A program of the inputs: itself, a name of `programs`, or `{ from, ... }`, the
 * program `from` names with the other members given in its place.
 */
function resolve(p) {
  if (typeof p === "string") return inputs.programs[p];
  if (!p.from) return p;
  const { from, ...own } = p;
  return { ...inputs.programs[from], ...own };
}

/** The text and kind of a program of the inputs. */
function source(spec) {
  const p = resolve(spec);
  if (p.ir) return { text: JSON.stringify(p.ir, null, 2), kind: "json" };
  let text = p.file ? read(p.file) : `${p.mdt.join("\n")}\n`;
  for (const [from, to] of p.replace ?? []) {
    if (!text.includes(from)) throw new Error(`the text to replace is not there: ${JSON.stringify(from)}`);
    text = text.replace(from, () => to);
  }
  for (const line of p.append ?? []) text += `${line}\n`;
  return { text, kind: "mdt" };
}

/** `{ path, value }` sets and `{ path, remove }` deletes, in order, in a copy of `ir`. */
function edited(ir, edits) {
  const out = structuredClone(ir);
  for (const e of edits ?? []) {
    const tokens = e.path.split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = tokens.pop();
    const parent = tokens.reduce((node, t) => node[t], out);
    if (e.remove) Array.isArray(parent) ? parent.splice(Number(last), 1) : delete parent[last];
    else parent[last] = e.value;
  }
  return out;
}

/** The text a check is given: the program as it is, or its IR as JSON text once `edit` has edited it. */
function checkSource(spec) {
  const p = resolve(spec);
  if (!p.edit) return source(p);
  const { text, kind } = source(p);
  const r = load(text, kind);
  if (!r.program) throw new Error("a program of the inputs does not load");
  return { text: JSON.stringify(edited(r.program, p.edit), null, 2), kind: "json" };
}

/** The program IR as `load` gives it, edited. */
function programOf(spec) {
  const p = resolve(spec);
  const { text, kind } = source(p);
  const r = load(text, kind);
  if (!r.program) throw new Error(`a program of the inputs does not load: ${r.diagnostics.map((d) => d.code).join(", ")}`);
  return edited(r.program, p.edit);
}

/** The modules of an input, by the name it gives each, in order. */
const modulesOf = (m) => (m ? Object.fromEntries(Object.entries(m).map(([name, p]) => [name, programOf(p)])) : undefined);

/**
 * The result of `f()`: the digest of its JSON text, with each program as its own
 * digest, and the code and path of each diagnostic to read a difference by; for an
 * entry marked `held` (the TypeScript's result holds a diagnostic of a rule the
 * Rust does not give yet), the diagnostics whole too. Or the message `f` throws.
 */
function attempt(f, held) {
  try {
    const r = f();
    const shown = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "program" ? sha256(JSON.stringify(v)) : v]));
    const text = JSON.stringify(shown);
    const told = (r.diagnostics ?? []).map((d) => `${d.code}@${d.at.path ?? ""}`);
    return { digest: sha256(text), ...(told.length ? { told } : {}), ...(held ? { result: text } : {}) };
  } catch (e) {
    return { throws: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

const out = { checks: [], patches: [], subprograms: [], amendments: [], linked: [] };

for (const c of inputs.checks) {
  const { text, kind } = checkSource(c);
  const modules = modulesOf(c.modules);
  out.checks.push({
    name: c.name,
    ...attempt(() => {
      const r = check(text, kind, { ...(modules ? { modules } : {}), ...(c.claim ? { claim: c.claim } : {}) });
      return { ok: r.ok, diagnostics: r.diagnostics };
    }, c.held),
  });
}

for (const c of inputs.patches) {
  const program = programOf(c.program);
  const modules = modulesOf(c.modules);
  const base = c.base ?? hashProgram(program).program;
  out.patches.push({ name: c.name, ...attempt(() => checkPatch(program, base, c.ops, ...(modules ? [modules] : [])), c.held) });
}

/** The operations of a sub-program written as text: one `add` for each definition. */
function opsOf(parent, defs) {
  const p = load(`mandate @ 0.4\n\nmodule ${parent.module}.plan_1 @ 0.1\n\nuse ${parent.module}\n\n${defs.join("\n")}\n`, "mdt");
  if (!p.program) throw new Error(`the defs of a sub-program do not load: ${p.diagnostics.map((d) => `${d.code} ${d.message}`).join(", ")}`);
  return Object.entries(p.program.defs).map(([name, value]) => ({ op: "add", path: `/defs/${name}`, value }));
}

for (const c of inputs.subprograms) {
  const parent = programOf(c.parent);
  const modules = modulesOf(c.modules);
  const number = Number(c.number ?? 1);
  const writes = (c.room.writes ?? []).map((w) => ({ ctor: w.ctor, effect: CAP_CTORS[w.ctor].effect, write: CAP_CTORS[w.ctor].write, scope: [...w.scope] }));
  const input = {
    parent,
    ...(modules ? { modules } : {}),
    workflow: c.workflow,
    number,
    base: c.base ?? hashProgram(skeleton(parent.module, number, parent.language)).program,
    ops: [...(c.defs ? opsOf(parent, c.defs) : []), ...(c.ops ?? [])],
    lead: c.lead ?? "public",
    room: { left: { ...c.room.left }, ...(c.room.time_left_ms !== undefined ? { time_left_ms: c.room.time_left_ms } : {}), writes },
  };
  out.subprograms.push({ name: c.name, ...attempt(() => checkSubprogram(input), c.held) });
}

for (const c of inputs.amendments) {
  const parent = programOf(c.parent);
  const modules = modulesOf(c.modules);
  const envelope = c.envelope_edit ? edited(parent.defs[c.workflow].envelope, c.envelope_edit) : c.envelope;
  const input = { parent, ...(modules ? { modules } : {}), workflow: c.workflow, ...("envelope" in c || c.envelope_edit ? { envelope } : {}) };
  out.amendments.push({ name: c.name, ...attempt(() => checkAmendment(input), c.held) });
}

for (const c of inputs.linked) {
  const parent = programOf(c.parent);
  const sub = programOf(c.sub);
  const modules = modulesOf(c.modules);
  out.linked.push({
    name: c.name,
    ...attempt(() => {
      const linked = subprogramLinked(sub, parent, ...(modules ? [modules] : []));
      return { keys: Object.keys(linked), defs: Object.keys(linked.defs), program: linked };
    }, true),
  });
}

const ascii = (text) => text.replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
// One entry a line, to keep the file small and a difference readable.
const sections = Object.entries(out).map(([section, list]) => `  ${JSON.stringify(section)}: [\n${list.map((e) => `    ${JSON.stringify(e)}`).join(",\n")}\n  ]`);
writeFileSync(new URL("expected.json", dir), ascii(`{\n${sections.join(",\n")}\n}\n`));
