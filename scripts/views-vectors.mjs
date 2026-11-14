#!/usr/bin/env node
// Writes crates/mandate-views/tests/data/expected.json: what the TypeScript
// compiler gives for the inputs of crates/mandate-views/tests/data/inputs.json
// from the functions that compare two programs and apply patches
// (compiler/src/views/views.ts, compiler/src/patch/patch.ts) and from the
// document renderers (compiler/src/views/doc.ts), so that the hand-ported
// JavaScript in the Rust port of them is tested against the TypeScript
// (crates/mandate-views/tests/vectors.rs reads both files):
//
//   numbers   Number(text), as a patch's array index and a lock's version
//             segment read a string
//   docs      toMarkdown and toHtml of a document with the text that Markdown
//             and HTML escape: backticks, pipes, \r\n, a lone \r, quotes
//   patches   applyOps and applyPatch of the program of a file, on paths that
//             name an array index as JavaScript reads one ("1e0", " 1 ",
//             "-0"), a ~ and a / in a name, __proto__, a root, an operation
//             that is no operation
//   diffs     semanticDiff, governanceChanges, envelopeChanges, lockDiff,
//             lockLimitsDiff and diffDoc of two programs (as IR, edited from
//             a base program, or read from a file) and two locks: names that
//             sort differently by UTF-16 code units and by code points,
//             index-like names (which JavaScript puts first), the numbers of
//             budgets, every kind of step of a workflow
//   graphs    the nodes and the edges of the graph of each workflow (architecture)
//   fixtures  semanticDiff of each program of the repository against itself
//             with the bodies of its workflows emptied, and back: the steps
//             of every workflow the repository has
//   views     architecture, authority, cost (with and without a lock, which
//             may be unvalidated), system and programDoc of a program, as
//             JSON and as Markdown and HTML: the budgets of every dimension
//             and where each comes from, restart and degrade, loops, maps,
//             if, switch and par in the cost, the rows of delegations and
//             plans in the order of the members of the IR, the kinds a map
//             hands with a scope the run chooses, names that sort differently
//             by UTF-16 code units and by code points, Mermaid text that
//             escapes, systems of every type form, imported modules, and
//             documents of a program with no workflow and no agent
//   cards     card and cardDoc (the envelope card, `mandate view --card`) of a
//             workflow of tests/data/cards.mdt, or of that program edited, or
//             of MigrateAll, with a lock and modules or without: an envelope
//             with every dimension, without a budget, a budget without spend
//             or in another currency, without approvals, owner, spawn or caps;
//             the numbers grouped, in hours, zero, negative left; maps with no
//             max, with a scope the run chooses or none known, over every kind
//             of expression; plans from the call, the skill, the agent or none;
//             a wait for a person in the body, a function, a contract, a
//             supervision and a change set, with members bound; locks that
//             are not locks; a workflow with no envelope, that is no workflow,
//             that does not exist
//
//   npm ci --ignore-scripts && npm run build    (once: it reads compiler/dist)
//   node scripts/views-vectors.mjs              (writes expected.json)
//   node scripts/views-vectors.mjs --show NAME  (prints what the TypeScript
//                                                gives for one input, whole)
//
// The inputs are written by hand to reach the branches the vectors of
// vectors/diff/ and the golden outputs do not; each result is held as a digest
// of its text (the first 16 hex digits of the SHA-256 of JSON.stringify(v,
// null, 2), or of the Markdown or the HTML) with what is worth reading beside
// it, so that the data stays small. Running it again writes the same bytes.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const dist = (path) => import(new URL(`compiler/dist/${path}`, root).href);
const { kindOf, load, loadModules } = await dist("check.js");
const { hashProgram } = await dist("hash.js");
const { parseStrictJson } = await dist("json/strict-json.js");
const { applyOps, applyPatch } = await dist("patch/patch.js");
const { architecture, authority, card, cardDoc, cost, diffDoc, envelopeChanges, envelopeWorkflows, governanceChanges, hasSystem, lockDiff, lockLimitsDiff, programDoc, semanticDiff, system } = await dist("views/views.js");
const { toHtml, toMarkdown } = await dist("views/doc.js");

const dir = new URL("crates/mandate-views/tests/data/", root);
const inputs = JSON.parse(readFileSync(new URL("inputs.json", dir), "utf8"));
const show = process.argv.includes("--show") ? process.argv[process.argv.indexOf("--show") + 1] : undefined;

const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const pretty = (v) => JSON.stringify(v, null, 2);
/** A value as plain JSON (what JSON.stringify keeps, in the compiler's member order). */
const plain = (v) => JSON.parse(JSON.stringify(v));
/** The value as the strict reader makes it: objects without a prototype, as a program from a file has. */
const strict = (value) => {
  const r = parseStrictJson(JSON.stringify(value));
  if (!r.ok) throw new Error("not strict JSON");
  return r.value.value;
};
const byUtf16 = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- programs ------------------------------------------------------------------------------------------------

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
    program = strict(inputs.view_programs?.[ref.program] ?? inputs.programs[ref.program]);
  }
  return edited(program, ref.edit);
}

const modulesOf = (files) => {
  const { modules, problems } = loadModules((files ?? []).map((file) => ({ file, text: readFileSync(new URL(file, root), "utf8"), kind: kindOf(file) })));
  if (problems.length) throw new Error(`modules do not load: ${files}`);
  return modules;
};

// ---- the results -----------------------------------------------------------------------------------------------

function numbers() {
  return inputs.numbers.map((s) => {
    const n = Number(s);
    return Object.is(n, -0) ? "-0" : String(n);
  });
}

function docs() {
  const cell = (c) => c;
  return Object.fromEntries(
    inputs.docs.map(({ name, doc }) => {
      const md = toMarkdown(doc);
      const html = toHtml(doc);
      return [name, { markdown: md, html_sha256: digest(html), html_length: html.length }];
    }),
  );
}

function patches() {
  const out = {};
  for (const p of inputs.patches) {
    const program = programOf(p.program);
    const base = p.base === "current" ? hashProgram(program).program : p.base === "stale" ? `sha256:${"0".repeat(64)}` : p.base;
    const modules = modulesOf(p.modules);
    // Operations as the strict reader makes them (mandate patch), or, with "plain", as JSON.parse makes them
    // (the MCP server, the tests): a __proto__ member of such a value is a prototype, and of the first, a member.
    const ops = p.plain ? p.ops : strict(p.ops);
    const applied = applyOps(program, base, ops);
    const patched = applyPatch(program, base, ops, modules);
    const programText = (x) => (x === undefined ? null : digest(JSON.stringify(x)));
    const opsResult = { program: programText(applied.program), diagnostics: applied.diagnostics };
    const patchResult = { ok: patched.ok, diagnostics: patched.diagnostics, governance: patched.governance, hash: patched.hash ?? null, program: programText(patched.program) };
    out[p.name] = { ok: patched.ok, codes: [...new Set(patched.diagnostics.map((d) => d.code))], governance: patched.governance.length, apply_ops: digest(pretty(plain(opsResult))), apply_patch: digest(pretty(plain(patchResult))) };
    if (show === p.name) console.log(pretty({ apply_ops: opsResult, apply_patch: patchResult }));
  }
  return out;
}

function diffResults(before, after, locks, modules) {
  const workflows = (g) => Object.entries(g.defs).filter(([, d]) => d.kind === "workflow").map(([n]) => n);
  const both = workflows(before).filter((n) => workflows(after).includes(n)).sort(byUtf16);
  const doc = diffDoc(before, after, locks);
  const markdown = toMarkdown(doc);
  const html = toHtml(doc);
  const values = {
    diff: plain(semanticDiff(before, after, locks)),
    governance_changes: plain(governanceChanges(before, after, modules)),
    envelope_changes: plain(both.map((workflow) => ({ workflow, changes: envelopeChanges(before, after, workflow, modules) }))),
    ...(locks ? { lock_diff: plain(lockDiff(locks.before, locks.after)), lock_limits_diff: plain(lockLimitsDiff(locks.before, locks.after)) } : {}),
  };
  return { values, markdown, html };
}

function diffs() {
  const out = {};
  for (const c of inputs.diffs) {
    const before = programOf(c.before);
    const after = programOf(c.after);
    const lockOf = (l) => (l === undefined || l === null ? undefined : strict(l));
    const b = lockOf(c.locks?.before);
    const a = lockOf(c.locks?.after);
    const locks = b || a ? { ...(b ? { before: b } : {}), ...(a ? { after: a } : {}) } : undefined;
    const r = diffResults(before, after, locks, modulesOf(c.modules));
    const d = r.values.diff;
    out[c.name] = {
      counts: [d.governance.length, d.behavior.length, d.unchanged.length, r.values.governance_changes.length],
      ...Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, digest(pretty(v))])),
      markdown: digest(r.markdown),
      html: digest(r.html),
      html_length: r.html.length,
    };
    if (show === c.name) console.log(pretty(r.values) + "\n" + r.markdown);
  }
  return out;
}

/** The graph of each workflow (the nodes and the edges architecture() gives): what the steps of a diff are made of. */
function graphs() {
  const out = {};
  for (const g of inputs.graphs) {
    const workflows = architecture(programOf(g.program)).workflows.map(({ workflow, nodes, edges }) => ({ workflow, nodes, edges }));
    out[g.name] = { workflows: workflows.length, nodes: workflows.reduce((n, w) => n + w.nodes.length, 0), edges: workflows.reduce((n, w) => n + w.edges.length, 0), sha256: digest(pretty(workflows)) };
    if (show === g.name) console.log(pretty(workflows));
  }
  return out;
}

/** The program with the body of each of its workflows emptied. */
function emptied(program) {
  const p = strict(program);
  for (const d of Object.values(p.defs)) if (d.kind === "workflow") d.body = [];
  return p;
}

function fixtures() {
  const out = {};
  for (const file of inputs.fixtures) {
    const p = programOf({ file });
    const e = emptied(p);
    const removed = semanticDiff(p, e).behavior;
    const added = semanticDiff(e, p).behavior;
    out[file] = { removed: removed.length, added: added.length, sha256: digest(pretty({ removed, added })) };
    if (show === file) console.log(pretty({ removed, added }));
  }
  return out;
}

/** What the views of one program give: the three views of its JSON, its document, its system, with a lock and modules. */
function views() {
  const out = {};
  for (const c of inputs.views) {
    const p = programOf(c.program);
    const lock = c.lock === undefined ? undefined : strict(c.lock);
    const modules = modulesOf(c.modules);
    const arch = architecture(p);
    const auth = authority(p);
    const cst = cost(p, lock);
    const sys = system(p, modules);
    // The command line gives programDoc no modules (cli.ts); the golden test gives them.
    const doc = c.doc_without_modules ? programDoc(p, lock) : programDoc(p, lock, modules);
    const markdown = toMarkdown(doc);
    const html = toHtml(doc);
    out[c.name] = {
      workflows: arch.workflows.map((w) => w.workflow),
      who: auth.rows.map((r) => r.who),
      calls: cst.workflows.flatMap((w) => w.rows.map((r) => `${w.workflow}: ${r.call} x${r.times} ${r.budget} (${r.from})${r.per_call ? ` | ${r.per_call}` : ""}${r.steps_bound ? ` | ${r.steps_bound}` : ""}`)),
      totals: cst.workflows.map((w) => `${w.workflow}: limit ${w.limit}; total ${w.total}`),
      has_system: hasSystem(p, modules),
      architecture: digest(pretty(arch)),
      // `rights`, not `authority`: a digest under a name with "auth" in it reads as a credential to a secret scanner.
      rights: digest(pretty(auth)),
      cost: digest(pretty(cst)),
      system: digest(pretty(sys)),
      json: digest(pretty({ architecture: arch, authority: auth, cost: cst }) + "\n"),
      markdown: digest(markdown),
      html: digest(html),
      html_length: html.length,
    };
    if (show === c.name) console.log(pretty({ architecture: arch, authority: auth, cost: cst, system: sys }) + "\n" + markdown);
  }
  return out;
}

/**
 * The envelope card of a workflow (`mandate view --card`): card and cardDoc with the lock and the modules of the case.
 * A lock is given inline (`lock`, which may be null, an array or an object that is no lock) or by name (`lock_ref`, from
 * `card_locks`); `modules` are given as `--module` gives them, or not at all with `modules_omitted`. A workflow that has
 * no card is held as that: neither function gives anything.
 */
function cards() {
  const out = {};
  for (const c of inputs.cards) {
    const p = programOf(c.program);
    const lockInput = c.lock_ref !== undefined ? inputs.card_locks[c.lock_ref] : c.lock;
    const lock = lockInput === undefined ? undefined : strict(lockInput);
    const opts = { ...(c.modules_omitted ? {} : { modules: modulesOf(c.modules) }), ...(lock !== undefined ? { lock } : {}) };
    const v = card(p, c.workflow, opts);
    const doc = cardDoc(p, c.workflow, opts);
    if (v === undefined || doc === undefined) {
      if (v !== doc) throw new Error(`${c.name}: card and cardDoc disagree`);
      out[c.name] = { defined: false, workflows: envelopeWorkflows(p).join(",") };
      continue;
    }
    const markdown = toMarkdown(doc);
    const html = toHtml(doc);
    const num = (n) => (n === null ? "-" : String(n));
    out[c.name] = {
      defined: true,
      workflows: envelopeWorkflows(p).join(","),
      steps: `${v.does.steps.length}: ${digest(v.does.steps.join("\n"))}`,
      maps: v.does.maps.map((m) => `${m.bind} over ${m.over}: max ${num(m.max)} par ${m.par} -> ${m.delegates.join(",")} | ${m.handed.map((h) => `${h.cap} [${h.kinds.join("+")}] ${h.scope === null ? "?" : h.scope.join("+")} ${h.by_item}`).join("; ")}`),
      plans: v.does.plans.map((p) => `${p.lead}: ${p.budget} (${p.from})`),
      spends: v.spends.map((r) => `${r.dimension}${r.currency ? ` ${r.currency}` : ""}: ${r.text.envelope} | ${r.text.static} | ${r.text.left}`),
      waits: v.asks.waits.map((w) => `${w.kind} ${w.role} ${w.in} [${w.members.join(",")}]`),
      approvals: v.asks.approvals.map((a) => `${a.effect} ${a.role} [${a.members.join(",")}]`),
      text: v.approves.text,
      // The package hash is held as a digest of itself: it is a hash of the program and the lock, not a thing to read.
      package: digest(v.package),
      json: digest(pretty(v) + "\n"),
      markdown: digest(markdown),
      html: digest(html),
      html_length: html.length,
    };
    if (show === c.name) console.log(pretty(v) + "\n" + markdown);
  }
  return out;
}

const out = { format: "mandate/views-vectors/expected/0.1", numbers: numbers(), docs: docs(), patches: patches(), diffs: diffs(), graphs: graphs(), fixtures: fixtures(), views: views(), cards: cards() };
if (show === undefined) {
  const ascii = (text) => text.replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const line = (x) => ascii(JSON.stringify(x));
  const parts = Object.entries(out).map(([k, v]) => {
    if (Array.isArray(v)) return `  ${line(k)}: ${line(v)}`;
    if (v !== null && typeof v === "object") return `  ${line(k)}: {\n${Object.entries(v).map(([n, x]) => `    ${line(n)}: ${line(x)}`).join(",\n")}\n  }`;
    return `  ${line(k)}: ${line(v)}`;
  });
  writeFileSync(new URL("expected.json", dir), `{\n${parts.join(",\n")}\n}\n`);
}
