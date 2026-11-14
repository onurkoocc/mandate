#!/usr/bin/env node
// Writes crates/mandate-check/tests/data/*.json: what the TypeScript
// compiler gives for every exported function of compiler/src/check/caps.ts,
// compiler/src/std/std.ts, compiler/src/std/governance.ts and
// compiler/src/path.ts, and for the two functions of node:path's posix that
// caps.ts uses, so that crates/mandate-check is tested against the
// TypeScript and not against expectations written by hand
// (crates/mandate-check/tests/vectors.rs reads the files).
//
//   npm ci --ignore-scripts && npm run build    (once: it reads compiler/dist)
//   node scripts/caps-vectors.mjs
//
// The files (it removes the .json files it finds there first):
//   std.json           the std tables and constants, whole
//   programs-<k>.json  the capability expressions of every program under
//                      fixtures/, conformance/ (each compile case's input,
//                      patched, with its modules) and vectors/programs/,
//                      read in their programs' linked definitions, and the
//                      relations between the capabilities each one holds
//   edges-<k>.json     hand-written edges, one or more for each branch
//   sweep-<k>.json     a pseudo-random sweep (fixed seed) of the relations
//                      on paths and capabilities, the glob matcher,
//                      pathProblem, patternProblem and normalize
// A source is written in parts, <source>-1.json, <source>-2.json, …, each
// with the source's `tables` (the definitions a case names by index) and as
// many cases as keep it under 900 KB (900,000 bytes); today each fits in one.
// Every clone carries these files, so the sets are chosen to reach each
// branch, not to be exhaustive: a case whose function and arguments are
// already there is written once (programs read with the same definitions
// share a table), constructors are tried with the argument lists of their
// scope kind (one of each kind with all of them), and the script fails when
// the files together pass 2,000,000 bytes (about 1.5 MB today). The set it
// once wrote was three times larger and gave the same results.
//
// Each case is one line, [function, [arguments...], result]. An argument
// or a result that is undefined is written null (no function here takes or
// gives null otherwise). Expressions, definitions and capabilities are
// written as the JSON the TypeScript has. A case whose call throws in
// TypeScript is left out, and the script then fails (none does). Running
// the script again writes the same bytes. Every file is ASCII (each
// character from U+007F up is a \u escape) and holds integers only.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const dist = new URL("compiler/dist/", root);
const fromDist = async (p) => {
  try {
    return await import(new URL(p, dist));
  } catch (e) {
    throw new Error(`cannot load compiler/dist/${p}: build the compiler first (npm ci --ignore-scripts && npm run build): ${e.message}`);
  }
};
const caps = await fromDist("check/caps.js");
const std = await fromDist("std/std.js");
const gov = await fromDist("std/governance.js");
const pathTs = await fromDist("path.js");
const { load } = await fromDist("check.js");
const { link } = await fromDist("modules.js");
const { canonicalize } = await fromDist("json/jcs.js");

const LANGS = [undefined, "mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4", "mandate/0.5"];

// xorshift64*, from a fixed seed.
let state = 0x6a09e667f3bcc909n;
const next = () => {
  state ^= state >> 12n;
  state ^= (state << 25n) & 0xffffffffffffffffn;
  state ^= state >> 27n;
  return (state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const below = (n) => Number(next() % BigInt(n));
const pick = (xs) => xs[below(xs.length)];
const chance = (p) => below(1000) < p * 1000;

/** A copy of `v` as JSON has it: undefined members left out. */
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------- cases

/**
 * The cases of one source. A case whose function and arguments are those of
 * one already there is not added again (its result is still given back).
 */
function collector() {
  const cases = [];
  const seen = new Set();
  let thrown = 0;
  const add = (fn, args, call) => {
    let result;
    try {
      result = call();
    } catch {
      thrown++;
      return undefined;
    }
    const written = args.map(plain);
    const key = JSON.stringify([fn, written]);
    if (!seen.has(key)) {
      seen.add(key);
      cases.push([fn, written, plain(result)]);
    }
    return result;
  };
  return { cases, add, thrown: () => thrown };
}

/** Every case of the relations on capability values. */
function relations(add, a, b) {
  add("capCovers", [a, b], () => caps.capCovers(a, b));
  add("writesOverlap", [a, b], () => caps.writesOverlap(a, b));
}

// ---------------------------------------------------------------- expressions

const v = (name) => ({ op: "var", name });
const t = (value) => ({ op: "text", value });
const n = (value) => ({ op: "int", value });
const L = (...items) => ({ op: "list", items });
const S = (...items) => ({ op: "set", items });
const fld = (of, name) => ({ op: "field", of, name });
const path = (dotted) => dotted.split(".").slice(1).reduce((e, name) => fld(e, name), v(dotted.split(".")[0]));
const pos = (value) => ({ value });
const kw = (name, value) => ({ name, value });
const call = (callee, ...args) => ({ op: "call", callee: typeof callee === "string" ? path(callee) : callee, args });

// ---------------------------------------------------------------- programs

function readText(rel) {
  return readFileSync(new URL(rel, root), "utf8");
}

function loadSource(text, kind) {
  const r = load(text, kind);
  return r.program;
}

function applyOps(program, ops) {
  const doc = JSON.parse(JSON.stringify(program));
  for (const op of ops) {
    const tokens = op.path.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    const last = tokens.pop();
    let at = doc;
    for (const k of tokens) at = at[k];
    if (op.op === "remove") {
      if (Array.isArray(at)) at.splice(Number(last), 1);
      else delete at[last];
    } else if (Array.isArray(at) && op.op === "add") at.splice(last === "-" ? at.length : Number(last), 0, op.value);
    else at[last] = op.value;
  }
  return doc;
}

function files(dir, out = []) {
  for (const name of readdirSync(new URL(dir, root)).sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(new URL(rel, root)).isDirectory()) files(rel, out);
    else out.push(rel);
  }
  return out;
}

/** Each program: its source, the program, and the modules it is read with. */
function programs() {
  const out = [];
  const byDir = new Map();
  const loadFile = (rel) => {
    const kind = rel.endsWith(".mdt") ? "mdt" : "json";
    return loadSource(readText(rel), kind);
  };
  // fixtures/: each program, with the others of its directory as modules.
  for (const rel of files("fixtures")) {
    if (!rel.endsWith(".mdt") && !rel.endsWith(".ir.json")) continue;
    const p = loadFile(rel);
    if (!p) continue;
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push([rel, p]);
  }
  for (const [, list] of byDir) {
    for (const [rel, p] of list) {
      const modules = {};
      for (const [other, m] of list) if (other !== rel && !Object.hasOwn(modules, m.module)) modules[m.module] = m;
      out.push([rel, p, modules]);
    }
  }
  // conformance/: each case's input, patched, with its modules.
  for (const dir of readdirSync(new URL("conformance", root)).sort()) {
    const caseRel = `conformance/${dir}/case.json`;
    let c;
    try {
      c = JSON.parse(readText(caseRel));
    } catch {
      continue;
    }
    if (c.kind !== "compile" || !c.input) continue;
    const base = `conformance/${dir}/`;
    const resolve = (f) => fileURLToPath(new URL(f, new URL(base, root))).replace(/\\/g, "/");
    const relOf = (f) => posix.normalize(`${base}${f}`);
    let p = c.input.text !== undefined ? loadSource(c.input.text, c.input.kind) : (() => {
      try {
        return loadSource(readFileSync(resolve(c.input.file), "utf8"), c.input.kind);
      } catch {
        return undefined;
      }
    })();
    if (!p) continue;
    if (c.patch) {
      try {
        p = applyOps(p, c.patch);
      } catch {
        continue;
      }
    }
    const modules = {};
    for (const f of c.modules ?? []) {
      let m;
      try {
        m = loadSource(readFileSync(resolve(f), "utf8"), f.endsWith(".mdt") ? "mdt" : "json");
      } catch {
        m = undefined;
      }
      if (m && !Object.hasOwn(modules, m.module)) modules[m.module] = m;
    }
    out.push([`${caseRel} (${c.input.file ? relOf(c.input.file) : "text"})`, p, modules]);
  }
  // vectors/programs/: each canonical program, with the others as modules.
  const vectors = [];
  for (const name of readdirSync(new URL("vectors/programs", root)).sort()) {
    const rel = `vectors/programs/${name}`;
    const vec = JSON.parse(readText(rel));
    const p = loadSource(vec.canonical, "json");
    if (p) vectors.push([rel, p]);
  }
  for (const [rel, p] of vectors) {
    const modules = {};
    for (const [other, m] of vectors) if (other !== rel && !Object.hasOwn(modules, m.module)) modules[m.module] = m;
    out.push([rel, p, modules]);
  }
  // One of each program and modules.
  const seen = new Set();
  return out.filter(([, p, modules]) => {
    const key = canonicalize(p) + Object.keys(modules).sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The definitions the capability functions read, and only what of them they read. */
function table(defs) {
  const out = {};
  for (const [name, d] of Object.entries(defs)) {
    if (d.kind === "capability") out[name] = d;
    else if (d.kind === "component") {
      const c = { kind: "component", repo: d.repo, root: d.root };
      if (d.build) c.build = d.build;
      if (d.test) c.test = d.test;
      out[name] = c;
    } else if (d.kind === "environment") {
      const e = { kind: "environment" };
      if (d.reads) e.reads = Object.fromEntries(Object.keys(d.reads).map((r) => [r, {}]));
      out[name] = e;
    }
  }
  return out;
}

const CTOR_NAMES = new Set([...Object.keys(std.CAP_CTORS), "component.read", "component.write", "component.exec", "component.repo"]);

function programCases() {
  const { cases, add, thrown } = collector();
  const rel = collector();
  const tables = [];
  const sources = [];
  for (const [source, program, modules] of programs()) {
    const linked = link(program, modules);
    const defs = linked.defs;
    const language = program.language;
    // Programs read with the same definitions share a table, so that their
    // cases are found to be the same and written once.
    const tableText = JSON.stringify(table(defs));
    let ti = tables.findIndex((x) => JSON.stringify(x) === tableText);
    if (ti < 0) {
      ti = tables.length;
      tables.push(JSON.parse(tableText));
    }
    sources.push(source);
    const exprs = new Map();
    const callees = new Map();
    const methods = new Map();
    let others = 0;
    const visit = (x) => {
      if (Array.isArray(x)) return x.forEach(visit);
      if (!x || typeof x !== "object") return;
      if (x.op === "call" && x.callee) {
        callees.set(JSON.stringify(x.callee), x.callee);
        const ctor = caps.calleePath(x.callee);
        const narrow = x.callee.op === "field" && x.callee.name === "narrow";
        if ((ctor && CTOR_NAMES.has(ctor)) || narrow || others++ < 4) exprs.set(JSON.stringify(x), x);
        if (ctor === "net.https") for (const a of x.args) if (a.name === "methods") methods.set(JSON.stringify(a.value), a.value);
      }
      if (x.op === "var" && Object.hasOwn(defs, x.name) && defs[x.name].kind === "capability") exprs.set(JSON.stringify(x), x);
      for (const y of Object.values(x)) visit(y);
    };
    visit(program.defs);
    for (const [name, d] of Object.entries(defs)) if (d.kind === "capability") exprs.set(JSON.stringify(v(name)), v(name));
    for (const c of callees.values()) add("calleePath", [c], () => caps.calleePath(c));
    for (const m of methods.values()) add("readMethods", [m], () => caps.readMethods(m));
    const held = [];
    for (const e of exprs.values()) {
      const langs = JSON.stringify(e).includes('"methods"') ? [language, undefined] : [language];
      for (const lang of langs) {
        if (e.op === "call") {
          add("capFromCall", [e, lang], () => caps.capFromCall(e, { language: lang }));
          add("capsFromCall", [ti, e, lang], () => caps.capsFromCall(e, defs, { language: lang }));
        }
        const got = add("capsOf", [ti, e, lang], () => caps.capsOf(defs, e, { language: lang }));
        for (const c of got ?? []) if (!held.some((h) => JSON.stringify(h) === JSON.stringify(c))) held.push(c);
      }
    }
    // The relations between the capabilities a program holds: the first
    // 12 pairs, so that the file stays small.
    for (const c of held) {
      rel.add("showCap", [c], () => caps.showCap(c));
      for (const effect of [c.effect]) {
        rel.add("capAuthorizes", [c, effect, undefined], () => caps.capAuthorizes(c, effect));
        if (c.scope) rel.add("capAuthorizes", [c, effect, c.scope], () => caps.capAuthorizes(c, effect, c.scope));
      }
    }
    let pairs = 0;
    for (const a of held) for (const b of held) if (pairs++ < 12) relations(rel.add, a, b);
    // importedMethods, with what it reads of the linked program.
    const origin = Object.entries(linked.origin);
    const p = { language: program.language, uses: program.uses ?? [] };
    if (program.language === undefined) delete p.language;
    const odefs = Object.fromEntries(origin.filter(([k]) => Object.hasOwn(defs, k)).map(([k]) => [k, defs[k]]));
    // Of the modules, it reads the language of those an imported definition comes from.
    const mods = Object.fromEntries(Object.entries(modules).filter(([k]) => origin.some(([, o]) => o === k)).map(([k, m]) => [k, { language: m.language }]));
    add("importedMethods", [p, odefs, origin, mods], () => caps.importedMethods(program, linked, modules));
  }
  return { cases, rel: rel.cases, tables, sources, thrown: thrown() + rel.thrown() };
}

// ---------------------------------------------------------------- edges

const EDGE_DEFS = {
  api: {
    kind: "component",
    repo: "acme/api",
    root: "/work/api",
    lang: "ts",
    owner: "lead",
    build: [
      { command: "npm", args: ["run", "build"] },
      { command: "tsc", args: [] },
    ],
    test: [
      { command: "npm", args: ["test"] },
      { command: "npm", args: ["run", "build"] },
    ],
  },
  web: { kind: "component", repo: "acme/web", root: "/work/web/", lang: "ts", owner: "lead" },
  same: { kind: "component", repo: "acme/api", root: "/work/api", lang: "ts", owner: "lead", test: [{ command: "npm", args: ["test"] }] },
  win: { kind: "component", repo: "acme/win", root: "C:/work/win", lang: "cs", owner: "lead", build: [{ command: "dotnet", args: ["build"] }] },
  emptybuild: { kind: "component", repo: "acme/empty", root: "/work/empty", lang: "ts", owner: "lead", build: [] },
  zeta: {
    kind: "component",
    repo: "acme/zeta",
    root: "/",
    lang: "go",
    owner: "lead",
    build: [
      { command: "zz", args: ["b"] },
      { command: "aa", args: ["a"] },
      { command: "Zz", args: [] },
      { command: "\u00e9", args: [] },
      { command: "\u{1F600}", args: [] },
      { command: "\uFF5E", args: [] },
      { command: "aa", args: ["a"] },
    ],
  },
  staging: { kind: "environment", class: "internal", reads: { logs: {}, errors: {}, a_read: {} } },
  prod: { kind: "environment", class: "restricted", reads: {} },
  noreads: { kind: "environment", class: "public" },
  src: { kind: "capability", value: call("fs.write", pos(t("/work/repo/src"))) },
  ro: { kind: "capability", value: call("fs.read", pos(t("/work/repo"))) },
  alias: { kind: "capability", value: v("src") },
  self: { kind: "capability", value: v("self") },
  loopA: { kind: "capability", value: v("loopB") },
  loopB: { kind: "capability", value: v("loopA") },
  nar: { kind: "capability", value: call(fld(v("src"), "narrow"), pos(t("/work/repo/src/a"))) },
  nar2: { kind: "capability", value: v("nar") },
  apiread: { kind: "capability", value: call("component.read", pos(v("api"))) },
  apiexec: { kind: "capability", value: call("component.exec", pos(v("api")), pos(v("build"))) },
  broken: { kind: "capability", value: call("component.read", pos(v("nothere"))) },
  web_get: { kind: "capability", value: call("net.https", kw("hosts", L(t("api.example.com"))), kw("methods", L(v("GET")))) },
  model: { kind: "capability", value: call("model.infer", kw("max_class", v("confidential")), kw("tier", v("standard"))) },
  deploys: { kind: "capability", value: call("env.deploy", pos(v("staging")), pos(v("prod"))) },
  reads: { kind: "capability", value: call("data.read", pos(v("staging")), pos(v("logs"))) },
  notcap: { kind: "const", value: t("x") },
  lead: { kind: "role", description: "made-up" },
};

/** Argument lists for every constructor: each branch of capFromCall. */
const ARG_SETS = [
  [],
  [pos(t("/work/repo"))],
  [pos(t("/a")), pos(t("/b"))],
  [pos(L(t("/a"), t("/b")))],
  [pos(L(t("/a"), L(t("/b"), L(t("/c")))))],
  [pos(L())],
  [pos(t(""))],
  [pos(t("/a")), pos(t("/a"))],
  [pos(L(t("/a"), v("x")))],
  [pos(v("x"))],
  [pos(n(1))],
  [kw("path", t("/a"))],
  [pos(t("/a")), kw("path", t("/b"))],
  [kw("hosts", L(t("a.example"), t("b.example")))],
  [kw("hosts", t("a.example"))],
  [kw("hosts", v("h"))],
  [kw("hosts", L())],
  [kw("hosts", L(t("a.example"))), kw("hosts", L(t("b.example")))],
  [kw("hosts", L(t("a.example"))), kw("methods", L(v("POST"), v("GET"), v("GET")))],
  [kw("hosts", L(t("a.example"))), kw("methods", L(v("get"), t("PUT"), n(3), v("DELETE")))],
  [kw("hosts", L(t("a.example"))), kw("methods", v("GET"))],
  [kw("hosts", L(t("a.example"))), kw("methods", L())],
  [kw("methods", L(v("HEAD")))],
  [kw("hosts", L(t("a.example"))), kw("methods", L(v("PATCH"))), kw("methods", L(v("GET")))],
  [kw("commands", L(t("npm"), t("node")))],
  [kw("commands", t("npm"))],
  [kw("commands", v("c"))],
  [kw("commands", L(t("npm"))), kw("args_prefix", L(L(t("run"), t("test")), L(t("ci"))))],
  [kw("commands", L(t("npm"))), kw("args_prefix", L(L(t("run")), t("ci")))],
  [kw("commands", L(t("npm"))), kw("args_prefix", L())],
  [kw("commands", L(t("npm"))), kw("args_prefix", L(L()))],
  [kw("commands", L(t("npm"))), kw("args_prefix", t("run"))],
  [kw("commands", L(t("npm"))), kw("args_prefix", L(L(t("run"), L(t("a"), t("b")))))],
  [kw("commands", L(t("npm"))), kw("args_prefix", L(L(t("run"), v("x"))))],
  [kw("args_prefix", L(L(t("run"))))],
  [kw("max_class", v("public"))],
  [kw("max_class", v("internal"))],
  [kw("max_class", v("confidential"))],
  [kw("max_class", v("restricted"))],
  [kw("max_class", t("restricted"))],
  [kw("max_class", v("classified"))],
  [kw("max_class", t(""))],
  [kw("max_class", n(2))],
  [kw("max_class", v("public")), kw("max_class", v("restricted"))],
  [kw("tier", v("standard"))],
  [kw("tier", t("fast"))],
  [kw("tier", t(""))],
  [kw("tier", n(1))],
  [kw("max_class", v("confidential")), kw("tier", v("premium"))],
  [kw("tier", v("premium")), kw("max_class", v("public"))],
  [pos(v("staging")), pos(v("prod"))],
  [pos(t("staging"))],
];

const CALLEES = [
  ...Object.keys(std.CAP_CTORS),
  "component.read",
  "component.write",
  "component.exec",
  "component.repo",
  "fs.delete",
  "fs.read.extra",
  "toString",
  "constructor",
  "__proto__",
  "hasOwnProperty",
  "fs",
  "net",
  "model.infer.narrow",
];

function edgeCases() {
  const { cases, add, thrown } = collector();
  const defs = EDGE_DEFS;
  const tables = [defs, {}];
  // Only net.https reads the language (methods, from 0.5): it is read in
  // every language, before and after the gate; the rest without one, or
  // also in 0.5.
  const ALL = ["capFromCall", "capsFromCall", "capsOf"];
  const caller = (e, ti, ds, langs = [undefined, "mandate/0.5"], fns = ALL) => {
    for (const lang of langs) {
      if (fns.includes("capFromCall")) add("capFromCall", [e, lang], () => caps.capFromCall(e, { language: lang }));
      if (fns.includes("capsFromCall")) add("capsFromCall", [ti, e, lang], () => caps.capsFromCall(e, ds, { language: lang }));
      if (fns.includes("capsOf")) add("capsOf", [ti, e, lang], () => caps.capsOf(ds, e, { language: lang }));
    }
  };
  // The constructors with the argument lists: each constructor with the
  // lists of its scope kind, and one constructor of each kind (and
  // model.infer) with every list, for the lists that behave alike on all of
  // a kind. The others (constructors over components, names that are none)
  // with the first lists only. capsFromCall reads the definitions only for
  // the constructors over components, data.read and env.*; for the rest it
  // is capFromCall's capability, and given for the first three lists only;
  // capsOf, for the first list only.
  const GROUP = { positional: [0, 13], hosts: [13, 24], commands: [24, 35], model: [35, 50], env: [50, 52] };
  const inGroup = (i, g) => i >= GROUP[g][0] && i < GROUP[g][1];
  const FULL = new Set(["fs.read", "net.https", "exec", "model.infer", "money.spend"]);
  const SYSTEM = new Set(["component.read", "component.write", "component.exec", "component.repo", "data.read", "env.deploy", "env.migrate"]);
  for (const callee of CALLEES) {
    const spec = Object.hasOwn(std.CAP_CTORS, callee) ? std.CAP_CTORS[callee] : undefined;
    ARG_SETS.forEach((args, i) => {
      const own =
        spec !== undefined &&
        ((spec.scope === "positional" && (inGroup(i, "positional") || inGroup(i, "env"))) ||
          (spec.scope === "hosts" && inGroup(i, "hosts")) ||
          (spec.scope === "commands" && inGroup(i, "commands")) ||
          (callee === "model.infer" && inGroup(i, "model")));
      if (!(FULL.has(callee) || own || i < 2)) return;
      const methods = JSON.stringify(args).includes('"methods"');
      const fns = ["capFromCall", ...(SYSTEM.has(callee) || i < 3 || (FULL.has(callee) && own) ? ["capsFromCall"] : []), ...(i < 1 ? ["capsOf"] : [])];
      caller(call(callee, ...args), 0, defs, callee === "net.https" && methods ? LANGS : [undefined], fns);
    });
  }
  // Calls whose callee is no path, and what is no call.
  const odd = [
    call(call("fs.read"), pos(t("/a"))),
    call(t("fs.read"), pos(t("/a"))),
    call(v(""), pos(t("/a"))),
    call(fld(v(""), "read"), pos(t("/a"))),
    call(fld(call("fs"), "read"), pos(t("/a"))),
    t("fs.read"),
    v("fs"),
    L(call("fs.read", pos(t("/a")))),
    n(1),
  ];
  for (const e of odd) caller(e, 0, defs);
  // The constructors over components, environments and reads.
  const A = (...xs) => xs.map((x) => pos(typeof x === "string" ? v(x) : x));
  const system = [
    ["component.read"],
    ["component.read", "api"],
    ["component.read", "api", "web"],
    ["component.read", "api", "api"],
    ["component.read", "api", "missing"],
    ["component.read", "api", t("api")],
    ["component.read", "staging"],
    ["component.read", "notcap"],
    ["component.read", "toString"],
    ["component.read", ""],
    ["component.read", n(1)],
    ["component.repo", "api", "same"],
    ["component.repo", "web", "api", "web"],
    ["component.repo"],
    ["component.repo", "missing"],
    ["component.write"],
    ["component.write", "api"],
    ["component.write", "web"],
    ["component.write", "zeta"],
    ["component.write", "zeta", t("src")],
    ["component.write", "win", t("src")],
    ...["src", "src/", "./src", ".", "./", "", "a/..", "a/../", "/abs", "..", "../", "../x", "a/../../x", "src//lib/./x", "...", ".../x", "a\\b", "\u00e9/x", "a/b/../c/", "//x", ".a", "..a/b", "a/./.", "a/b/c/../../..", "x/../.."]
      .flatMap((p) => [["component.write", "api", t(p)], ["component.write", "web", t(p)]]),
    ["component.write", "api", t("src"), t("test")],
    ["component.write", "api", t("src"), t("/abs")],
    ["component.write", "api", v("x")],
    ["component.write", "api", t("src"), n(1)],
    ["component.write", "missing", t("src")],
    ["component.write", t("api"), t("src")],
    ["component.exec"],
    ["component.exec", "api"],
    ["component.exec", "api", "build"],
    ["component.exec", "api", "test"],
    ["component.exec", "api", "build", "test"],
    ["component.exec", "api", "test", "build"],
    ["component.exec", "api", "build", "build"],
    ["component.exec", "api", "deploy"],
    ["component.exec", "api", t("build")],
    ["component.exec", "api", "build", "deploy"],
    ["component.exec", "web", "build"],
    ["component.exec", "web", "test"],
    ["component.exec", "same", "test"],
    ["component.exec", "same", "build"],
    ["component.exec", "emptybuild", "build"],
    ["component.exec", "zeta", "build"],
    ["component.exec", "win", "build"],
    ["component.exec", "missing", "build"],
    ["component.exec", "staging", "build"],
    ["data.read"],
    ["data.read", "staging"],
    ["data.read", "staging", "logs"],
    ["data.read", "staging", "logs", "errors"],
    ["data.read", "staging", "logs", "a_read", "errors"],
    ["data.read", "staging", t("logs")],
    ["data.read", "staging", "logs", "logs"],
    ["data.read", "staging", "nope"],
    ["data.read", "staging", n(1)],
    ["data.read", "staging", t("")],
    ["data.read", "staging", "logs", "nope"],
    ["data.read", "prod"],
    ["data.read", "noreads"],
    ["data.read", "api"],
    ["data.read", "missing"],
    ["data.read", t("staging")],
    ["data.read", n(1)],
    ["env.deploy", "staging", "prod"],
    ["env.deploy", "prod", "staging", "prod"],
    ["env.deploy"],
    ["env.deploy", "api"],
    ["env.deploy", "staging", "missing"],
    ["env.deploy", t("staging")],
    ["env.deploy", ""],
    ["env.migrate", "staging"],
    ["env.migrate", "prod", "noreads"],
  ];
  for (const [ctor, ...args] of system) caller(call(ctor, ...A(...args)), 0, defs, [undefined]);
  // A named argument to a constructor over components counts as one.
  caller(call("component.read", kw("of", v("api"))), 0, defs);
  caller(call("component.write", pos(v("api")), kw("path", t("src"))), 0, defs);
  // Named capabilities and narrowing.
  const named = [
    v("src"),
    v("ro"),
    v("alias"),
    v("self"),
    v("loopA"),
    v("nar"),
    v("nar2"),
    v("apiread"),
    v("apiexec"),
    v("broken"),
    v("web_get"),
    v("model"),
    v("deploys"),
    v("reads"),
    v("notcap"),
    v("lead"),
    v("missing"),
    v("toString"),
    v("api"),
    call(fld(v("src"), "narrow"), pos(t("/a")), pos(t("/b"))),
    call(fld(v("src"), "narrow")),
    call(fld(v("src"), "narrow"), pos(v("x"))),
    call(fld(v("src"), "narrow"), pos(t("/a")), pos(v("x"))),
    call(fld(v("src"), "narrow"), kw("path", t("/a"))),
    call(fld(v("nar"), "narrow"), pos(t("/x"))),
    call(fld(v("nar2"), "narrow"), pos(t("/x"))),
    call(fld(v("alias"), "narrow"), pos(t("/work/repo/src/b"))),
    call(fld(call("fs.read", pos(t("/x"))), "narrow"), pos(t("/x/y"))),
    call(fld(call("component.exec", pos(v("api")), pos(v("build"))), "narrow"), pos(t("npm"))),
    call(fld(v("apiexec"), "narrow"), pos(t("npm"))),
    call(fld(v("apiread"), "narrow"), pos(t("/work/api/src"))),
    call(fld(v("missing"), "narrow"), pos(t("/a"))),
    call(fld(t("x"), "narrow"), pos(t("/a"))),
    call(fld(v("web_get"), "narrow"), pos(t("api.example.com"))),
    call(fld(v("model"), "narrow")),
    call(fld(call(fld(v("src"), "narrow"), pos(t("/a"))), "narrow"), pos(t("/a/b"))),
    call(fld(v("self"), "narrow"), pos(t("/a"))),
    call(fld(v("deploys"), "narrow"), pos(t("staging"))),
    call(fld(v("reads"), "narrow"), pos(t("staging.logs"))),
    call(fld(v("broken"), "narrow"), pos(t("/a"))),
  ];
  for (const e of named) {
    caller(e, 0, defs);
    caller(e, 1, {}, [undefined], ["capsOf"]);
  }
  // calleePath.
  for (const c of [v("fs"), v(""), path("a.b.c.d"), fld(v(""), "x"), fld(call("a"), "b"), t("a"), n(1), call("a"), fld(fld(t("x"), "y"), "z"), L()]) {
    add("calleePath", [c], () => caps.calleePath(c));
  }
  // readMethods and readsMethods.
  const methodValues = [
    v("GET"),
    t("GET"),
    S(v("GET")),
    n(1),
    L(),
    L(v("GET"), v("POST")),
    L(v("POST"), v("GET"), v("GET")),
    L(v("get")),
    L(t("GET")),
    L(n(1)),
    L(L(v("GET"))),
    L(v("GET"), t("POST"), v("BREW"), n(1), v("DELETE")),
    L(...caps.HTTP_METHODS.map(v)),
    L(...[...caps.HTTP_METHODS].reverse().map(v)),
    L(v("DELETE"), v("HEAD")),
    L(v("toString")),
    L(v("")),
    L(t("")),
  ];
  for (const m of methodValues) add("readMethods", [m], () => caps.readMethods(m));
  for (const lang of LANGS) add("readsMethods", [lang], () => caps.readsMethods(lang));
  // importedMethods.
  const fetch = { kind: "capability", value: call("net.https", kw("hosts", L(t("api.example.com"))), kw("methods", L(v("GET")))) };
  const plainFetch = { kind: "capability", value: call("net.https", kw("hosts", L(t("api.example.com")))) };
  const deep = { kind: "agent", skills: { s: { body: [{ s: "expr", value: { op: "block", body: [{ value: call("net.https", kw("methods", L(v("GET")))) }] } }] } }, caps: [] };
  const posMethods = { kind: "capability", value: call("net.https", pos(L(v("GET")))) };
  const viaField = { kind: "capability", value: call(fld(v("net"), "https"), kw("methods", L(v("GET")))) };
  const otherCall = { kind: "capability", value: call("fs.read", kw("methods", L(v("GET")))) };
  const M = (language) => (language === undefined ? {} : { language });
  const imports = [
    [{ language: "mandate/0.5", uses: [] }, { fetch }, [["fetch", "github"]], { github: M("mandate/0.5") }],
    [{ language: "mandate/0.4", uses: [{ module: "old" }, { module: "github", names: ["fetch"] }] }, { fetch }, [["fetch", "github"]], { github: M("mandate/0.5"), old: M("mandate/0.4") }],
    [{ language: "mandate/0.4", uses: [] }, { fetch }, [["fetch", "github"]], { github: M("mandate/0.5") }],
    [{ language: "mandate/0.1" }, { fetch }, [["fetch", "github"]], { github: M("mandate/0.5") }],
    [{ uses: [{ module: "github" }] }, { fetch }, [["fetch", "github"]], { github: M("mandate/0.5") }],
    [{ language: "mandate/0.9", uses: [{ module: "github" }] }, { fetch }, [["fetch", "github"]], { github: M("mandate/0.5") }],
    [{ language: "mandate/0.3", uses: [{ module: "github" }] }, { fetch }, [["fetch", "github"]], { github: M("mandate/0.4") }],
    [{ language: "mandate/0.3", uses: [{ module: "github" }] }, { fetch }, [["fetch", "github"]], { github: M("mandate/0.9") }],
    [{ language: "mandate/0.3", uses: [{ module: "github" }] }, { fetch }, [["fetch", "github"]], { github: M(undefined) }],
    [{ language: "mandate/0.3", uses: [{ module: "github" }] }, { fetch }, [["fetch", "github"]], {}],
    [{ language: "mandate/0.3", uses: [{ module: "github" }] }, {}, [["fetch", "github"]], { github: M("mandate/0.5") }],
    [{ language: "mandate/0.3", uses: [{ module: "github" }] }, { plainFetch }, [["plainFetch", "github"]], { github: M("mandate/0.5") }],
    [
      { language: "mandate/0.4", uses: [{ module: "a" }, { module: "b" }, { module: "a" }] },
      { zeta: fetch, Alpha: deep, alpha: posMethods, beta: viaField, gamma: otherCall, "\u00e9": fetch, "\u{1F600}": fetch, "\uFF5E": fetch },
      [["zeta", "a"], ["Alpha", "b"], ["alpha", "a"], ["beta", "b"], ["gamma", "a"], ["\u00e9", "b"], ["\u{1F600}", "a"], ["\uFF5E", "a"]],
      { a: M("mandate/0.5"), b: M("mandate/0.5") },
    ],
    [{ language: "mandate/0.4", uses: [{ module: "x/y~z" }] }, { fetch }, [["fetch", "x/y~z"]], { "x/y~z": M("mandate/0.5") }],
  ];
  for (const [program, ds, origin, modules] of imports) {
    const linked = { defs: ds, origin: Object.fromEntries(origin), diagnostics: [] };
    add("importedMethods", [program, ds, origin, modules], () => caps.importedMethods(program, linked, modules));
  }
  // The relations on paths.
  const PATHS = ["", "/", ".", "..", "/a", "/a/", "/a/b", "/a/b/", "a//b", "/a/./b", "/a/../b", "/../a", "a/../..", "/a/b/../../..", "...", "/ab", "/a/bc", "a", "a/b", "/work/repo", "/work/repo/src", "/work/repo/src/a", "/work/repository", "C:/work"];
  for (const p of PATHS) add("segments", [p], () => caps.segments(p));
  // pathsOverlap is symmetric: each unordered pair once.
  PATHS.forEach((a, i) =>
    PATHS.forEach((b, j) => {
      add("within", [a, b], () => caps.within(a, b));
      if (i <= j) add("pathsOverlap", [a, b], () => caps.pathsOverlap(a, b));
    }),
  );
  const SCOPES = [undefined, [], ["/a"], ["/a/b"], ["/a", "/b"], ["/a/b", "/c"], ["a.example"], ["a.example", "b.example"], ["/a/"]];
  for (const ctor of ["fs.read", "fs.", "fs", "git.pr"]) for (const i of SCOPES) for (const o of SCOPES) add("scopeWithin", [ctor, i, o], () => caps.scopeWithin(ctor, i, o));
  const PREFIXES = [undefined, [], [[]], [["run"]], [["run", "test"]], [["run"], ["ci"]], [["ci"]], [["run", "test", "x"]], [["Run"]]];
  for (const i of PREFIXES) for (const o of PREFIXES) add("prefixesWithin", [i, o], () => caps.prefixesWithin(i, o));
  // The relations on capability values.
  const c = (ctor, effect, write, more = {}) => ({ ctor, effect, write, ...more });
  const CAPS = [
    c("fs.read", "Fs.Read", false),
    c("fs.read", "Fs.Read", false, { scope: [] }),
    c("fs.read", "Fs.Read", false, { scope: ["/a"] }),
    c("fs.read", "Fs.Read", false, { scope: ["/a/b"] }),
    c("fs.write", "Fs.Write", true, { scope: ["/a"] }),
    c("fs.write", "Fs.Write", true, { scope: ["/a/b"], name: "src" }),
    c("fs.write", "Fs.Write", true),
    c("fs.write", "Fs.Write", true, { scope: ["/c"], via: "component.write(api)", components: ["api"] }),
    c("git.pr", "git.*", true, { scope: ["acme/api"] }),
    c("git.pr", "git.*", true, { scope: ["acme/api", "acme/web"] }),
    c("git.pr", "git.*", true),
    c("model.infer", "Model", false, { maxClass: "internal" }),
    c("model.infer", "Model", false, { maxClass: "restricted" }),
    c("model.infer", "Model", false, { maxClass: "public", tier: "standard" }),
    c("model.infer", "Model", false, { maxClass: "confidential", tier: "fast" }),
    c("model.infer", "Model", false),
    c("exec", "Exec", false, { scope: ["npm"], argsPrefix: [["run"]] }),
    c("exec", "Exec", false, { scope: ["npm"], argsPrefix: [["run", "test"]] }),
    c("exec", "Exec", false, { scope: ["npm"] }),
    c("exec", "Exec", false, { scope: ["npm"], argsPrefix: [] }),
    c("net.https", "Net", false, { scope: ["a.example"] }),
    c("net.https", "Net", false, { scope: ["a.example"], methods: ["GET"] }),
    c("net.https", "Net", false, { scope: ["a.example"], methods: ["GET", "POST"] }),
    c("net.https", "Net", false, { scope: ["a.example"], methods: [] }),
    c("net.https", "Net", false, { methods: ["GET"] }),
    c("env.deploy", "deploy", true, { scope: ["prod", "staging"], via: "env.deploy(staging, prod)" }),
    c("env.deploy", "deploy", true, { scope: ["staging"] }),
    c("data.read", "Data.Read", false, { scope: ["staging.logs"], via: "data.read(staging, logs)" }),
    c("money.spend", "Spend", false, { name: "" }),
    c("x.y", ".*", true, { via: "" }),
    c("x.z", "*", true, { scope: ['"quoted"', "\u00e9", "a\\b", "\n"] }),
  ];
  // Each pair of the same constructor; of two constructors, each with the
  // next in the list (they differ at the first comparison).
  CAPS.forEach((a, i) => {
    add("showCap", [a], () => caps.showCap(a));
    CAPS.forEach((b, j) => {
      if (a.ctor === b.ctor || j === (i + 1) % CAPS.length) relations(add, a, b);
    });
    // The scopes only where the effect is authorized: elsewhere the answer
    // is false whatever the scope.
    for (const effect of ["Fs.Read", "Fs.Write", "git.open_pr", "git.", "git", "gitx.y", "git.*", "Model", "deploy", "Data.Read", ".x", "", "x", "*", "Net"]) {
      const scopes = caps.capAuthorizes(a, effect) ? [undefined, [], ["/a/b"], ["acme/api"]] : [undefined];
      for (const scope of scopes) add("capAuthorizes", [a, effect, scope], () => caps.capAuthorizes(a, effect, scope));
    }
  });
  // node:path's posix: every string of up to five of `a`, `.` and `/`, and some more.
  const alphabet = ["a", ".", "/"];
  const strings = [""];
  for (let len = 1, layer = [""]; len <= 5; len++) {
    layer = layer.flatMap((s) => alphabet.map((ch) => s + ch));
    strings.push(...layer);
  }
  strings.push("\u00e9/..", "\u00e9\u00e9/../x", "ab/\u00e9/..", "\u{1F600}/./..", "a/\u{1F600}\u{1F600}/../..", "//a//b//", "./../a", "../../a/b/../c", "/./../", "a/b/c/./../../d/", "a/../../..", "../a/../..");
  for (const s of strings) {
    add("posix.normalize", [s], () => posix.normalize(s));
    if (s.length <= 2) add("posix.isAbsolute", [s], () => posix.isAbsolute(s));
  }
  // Globs: the defaults through governanceKind below, and these against
  // every file name here.
  const GLOBS = [
    "","*", "**", "***", "**/", "/**", "a/**", "**/a", "a/**/b", "a/**b", "a**/b", "?", "a?c", "??", ".", "a+b", "a(b)", "[x]", "{a}", "$", "^", "|", "\\", "a.b", "a/b",
    "\u00e9", "\u{1F600}", "?.md", "*.\u{1F600}", "**/x\ny", "a\u2028b", "a\rb", "*/*", "deploy/**", "*.tf", "**/**", "**/*/", "a/*", "*a*a*a*b", "x/**/**/y",
  ];
  const FILES = [
    "", "a", "b", "a/b", "a/b/c", "x/a", "ab", "abc", "a+b", "a(b)", "[x]", "x", "{a}", "$", "^", "|", "\\", "a.b", "axb", "a/c", "a/x/b", "a/x/y/b", "ab/b",
    ".github/workflows/ci.yml", ".github/workflows/", ".github/workflows", ".github/actions/a/b.yml", ".gitlab-ci.yml", "x/.gitlab-ci.yml", "Jenkinsfile", "a/Jenkinsfile", "a/b/Jenkinsfile",
    "package-lock.json", "a/package-lock.json", "/package-lock.json", "a//package-lock.json", "xpackage-lock.json", "CLAUDE.md", "docs/CLAUDE.md", ".claude/settings.json", ".claude", ".claude/",
    "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS", "x/CODEOWNERS", "mandate.lock.json", "a/mandate.runtime.json", "deploy/x.yml", "deploy", "main.tf", "a/main.tf",
    "\u00e9", "\u{1F600}", "x.md", "\u{1F600}.md", "a.\u{1F600}", "x\ny", "a/x\ny", "x\ny/x\ny", "a\u2028b", "a\rb", "aab", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "x/y", "x/a/y", "x//y", "a/b/", "/", "//", "a/",
  ];
  for (const g of [...Object.values(gov.GOVERNANCE_FILES).flat(), ...GLOBS]) add("globRegExp.source", [g], () => gov.globRegExp(g).source);
  // The names of governance-class files are read through governanceKind.
  const NAMES = FILES.filter((f) => !/github|gitlab|Jenkins|lock|CLAUDE|claude|CODEOWNERS|mandate|deploy|\.tf$/.test(f));
  for (const g of GLOBS) for (const f of NAMES) add("globRegExp.test", [g, f], () => gov.globRegExp(g).test(f));
  const PATTERNS = ["", "a", "a/b", "/a", "a/", "a//b", "./a", "a/.", "a/..", "..", "...", ".a", "a\\b", "a:b", "a\u0000b", "**/x", "\u00e9", "a/./b"];
  for (const g of PATTERNS) add("patternProblem", [g], () => gov.patternProblem(g));
  const EXTRAS = [[], ["*.tf", "deploy/**"], ["**"], [""]];
  for (const f of FILES) for (const extra of EXTRAS) add("governanceKind", [f, extra], () => gov.governanceKind(f, extra));
  const LISTS = [[], ["b", "a"], FILES, [...FILES].reverse(), ["\uFF5E", "\u{1F600}", "\u00e9", "CODEOWNERS", "CODEOWNERS", "z/yarn.lock", "A/yarn.lock"], ["main.tf", "x/main.tf", "deploy/a"]];
  for (const files of LISTS) for (const extra of EXTRAS) add("governanceFiles", [files, extra], () => gov.governanceFiles(files, extra));
  // pathProblem and isPath.
  const PATH_EDGES = ["", "a", "a/b", "/a", "a/", "a//b", ".", "..", "./a", "a/.", "a/..", "...", ".a", "..a", "a.", "a..", "a\\b", "a:b", "a\u0000b", "\u00e9", "\u{1F600}", "a/\u{1F600}/b", "\\", ":", "/", "//", "a/./b", "C:/x", "a/b/c/d/e"];
  for (const s of PATH_EDGES) {
    add("pathProblem", [s], () => pathTs.pathProblem(s));
    add("isPath", [s], () => pathTs.isPath(s));
  }
  return { cases, tables, thrown: thrown() };
}

// ---------------------------------------------------------------- sweep

function randomPath() {
  const segs = Array.from({ length: below(5) }, () => pick(["a", "b", "c", "..", ".", "", "ab"]));
  return (chance(0.6) ? "/" : "") + segs.join("/") + (chance(0.15) ? "/" : "");
}
function randomString(alphabet, max) {
  return Array.from({ length: below(max + 1) }, () => pick(alphabet)).join("");
}
function maybe(p, f) {
  return chance(p) ? undefined : f();
}
function list(max, f) {
  return Array.from({ length: below(max + 1) }, f);
}

function sweepPaths() {
  const { cases, add, thrown } = collector();
  for (let i = 0; i < 500; i++) {
    const a = randomPath();
    const b = chance(0.3) ? a + pick(["/x", "/..", "/.", "", "x"]) : randomPath();
    add("within", [a, b], () => caps.within(a, b));
    add("pathsOverlap", [b, a], () => caps.pathsOverlap(b, a));
  }
  for (let i = 0; i < 270; i++) {
    const s = randomPath();
    add("segments", [s], () => caps.segments(s));
  }
  for (let i = 0; i < 400; i++) {
    const ctor = pick(["fs.read", "fs.write", "git.pr", "exec", "net.https"]);
    const item = () => (ctor.startsWith("fs.") ? randomPath() : pick(["a", "b", "c", "acme/api"]));
    const inner = maybe(0.15, () => list(3, item));
    const outer = maybe(0.15, () => list(3, item));
    add("scopeWithin", [ctor, inner, outer], () => caps.scopeWithin(ctor, inner, outer));
  }
  for (let i = 0; i < 270; i++) {
    const prefix = () => list(3, () => pick(["run", "test", "ci", ""]));
    const inner = maybe(0.15, () => list(3, prefix));
    const outer = maybe(0.15, () => list(3, prefix));
    add("prefixesWithin", [inner, outer], () => caps.prefixesWithin(inner, outer));
  }
  for (let i = 0; i < 700; i++) {
    const g = randomString(["a", "b", "/", "*", "?", ".", "**/"], 6);
    const f = randomString(["a", "b", "/", ".", "\n"], 7);
    add("globRegExp.test", [g, f], () => gov.globRegExp(g).test(f));
    if (i % 4 === 0) add("globRegExp.source", [g], () => gov.globRegExp(g).source);
  }
  for (let i = 0; i < 700; i++) {
    const s = randomString(["a", ".", "/", "\\", ":", "\u0000", "\u00e9", "\u{1F600}", "b"], 7);
    add("pathProblem", [s], () => pathTs.pathProblem(s));
    add("isPath", [s], () => pathTs.isPath(s));
    if (i % 2 === 0) add("patternProblem", [s], () => gov.patternProblem(s));
  }
  for (let i = 0; i < 500; i++) {
    const s = randomString(["a", ".", "/", "..", "\u00e9", "b"], 9);
    add("posix.normalize", [s], () => posix.normalize(s));
  }
  return { cases, thrown: thrown() };
}

const CTORS = [
  ["fs.read", "Fs.Read", false],
  ["fs.write", "Fs.Write", true],
  ["git.pr", "git.*", true],
  ["exec", "Exec", false],
  ["net.https", "Net", false],
  ["model.infer", "Model", false],
  ["env.deploy", "deploy", true],
];

function randomCap() {
  const [ctor, effect, write] = pick(CTORS);
  const c = { ctor, effect, write };
  if (chance(0.2)) c.name = pick(["src", "", "a.narrow"]);
  if (chance(0.15)) c.via = pick(["component.read(api)", ""]);
  if (chance(0.8)) c.scope = list(3, () => (ctor.startsWith("fs.") ? randomPath() : pick(["a", "b", "acme/api", "staging"])));
  if (ctor === "model.infer" && chance(0.8)) c.maxClass = pick(std.DATA_CLASSES);
  if (chance(0.25)) c.tier = pick(["standard", "fast"]);
  if (ctor === "exec" && chance(0.7)) c.argsPrefix = list(2, () => list(2, () => pick(["run", "test"])));
  if (chance(0.3)) c.methods = list(3, () => pick(["GET", "POST", "PUT"]));
  if (chance(0.1)) c.write = !c.write;
  return c;
}

function sweepCaps() {
  const { cases, add, thrown } = collector();
  for (let i = 0; i < 300; i++) {
    const a = randomCap();
    const b = chance(0.4) ? { ...a, ...(chance(0.5) ? { scope: a.scope && [...a.scope, ...list(1, randomPath)] } : {}) } : randomCap();
    if (b.scope === undefined) delete b.scope;
    relations(add, a, b);
  }
  for (let i = 0; i < 300; i++) {
    const a = randomCap();
    const effect = pick(["Fs.Read", "Fs.Write", "git.open_pr", "git.merge", "git", "gitx.y", "Exec", "Net", "Model", "deploy"]);
    const scope = maybe(0.3, () => list(2, () => (a.ctor.startsWith("fs.") ? randomPath() : pick(["a", "b", "acme/api"]))));
    add("capAuthorizes", [a, effect, scope], () => caps.capAuthorizes(a, effect, scope));
    if (i % 3 === 0) add("showCap", [a], () => caps.showCap(a));
  }
  return { cases, thrown: thrown() };
}

// ---------------------------------------------------------------- std

function stdTables() {
  const names = ["fs.read", "git.open_pr", "fs.read_text", "Fs.Read", "Human", "threshold", "Receipt", "Other", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "", "deploy", "exec"];
  return {
    DATA_CLASSES: std.DATA_CLASSES,
    classRank: std.DATA_CLASSES.map((c) => [c, std.classRank(c)]),
    BUILTIN_EFFECTS: [...std.BUILTIN_EFFECTS],
    UNGATED_EFFECTS: [...std.UNGATED_EFFECTS],
    CAP_CTORS: Object.entries(std.CAP_CTORS),
    DEFAULT_MODEL_MAX_CLASS: std.DEFAULT_MODEL_MAX_CLASS,
    STD_EFFECTS: Object.entries(std.STD_EFFECTS),
    STD_FNS: Object.entries(std.STD_FNS),
    DECISION_POLICIES: [...std.DECISION_POLICIES],
    PROTECTED_TYPES: [...std.PROTECTED_TYPES],
    OUT_OF_SCOPE_OPTIONS: [...std.OUT_OF_SCOPE_OPTIONS],
    MAX_RESTARTS: std.MAX_RESTARTS,
    MAX_CHOICE_OPTIONS: std.MAX_CHOICE_OPTIONS,
    lookups: names.map((k) => [
      k,
      std.CAP_CTORS[k] ?? null,
      std.STD_EFFECTS[k] ?? null,
      std.STD_FNS[k] ?? null,
      std.BUILTIN_EFFECTS.has(k),
      std.UNGATED_EFFECTS.has(k),
      std.DECISION_POLICIES.has(k),
      std.PROTECTED_TYPES.has(k),
      std.OUT_OF_SCOPE_OPTIONS.has(k),
    ]),
    HTTP_METHODS: [...caps.HTTP_METHODS],
    GOVERNANCE_KINDS: [...gov.GOVERNANCE_KINDS],
    GOVERNANCE_FILES: Object.entries(gov.GOVERNANCE_FILES),
    PATH_PATTERN: pathTs.PATH_PATTERN,
  };
}

// ---------------------------------------------------------------- output

const DATA = new URL("crates/mandate-check/tests/data/", root);
const FORMAT = "mandate-check/caps-vectors/0.1";
const GENERATOR = "scripts/caps-vectors.mjs";
const LIMIT = 900 * 1000;

const ascii = (text) => text.replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
const line = (x) => ascii(JSON.stringify(x));

/** The text of a file: one member a line, and each element of `cases` a line. */
function fileText(name, object) {
  const parts = Object.entries(object).map(([k, val]) =>
    k === "cases" ? `${JSON.stringify(k)}: [\n${val.join(",\n")}\n]` : `${JSON.stringify(k)}: ${line(val)}`,
  );
  const text = `{\n${parts.join(",\n")}\n}\n`;
  if (/[^\x00-\x7f]/.test(text)) throw new Error(`${name}: not ASCII`);
  if (/\d\.\d|\d[eE][+-]?\d/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) throw new Error(`${name}: a number that is not an integer`);
  if (text.length > LIMIT) throw new Error(`${name}: ${text.length} bytes, over 900 KB`);
  return text;
}

const TOTAL_LIMIT = 2000000;
const written = [];
let total = 0;
function write(name, text) {
  writeFileSync(new URL(name, DATA), text);
  written.push(`${name} ${text.length}`);
  total += text.length;
}

/**
 * Writes the cases of `source` as `<source>-1.json`, `<source>-2.json`, …, each
 * with the header and as many cases as keep it under the limit.
 */
function writeCases(source, header, cases) {
  const lines = cases.map(line);
  const headerBytes = JSON.stringify(header).length + 200;
  let part = 1;
  for (let i = 0; i < lines.length || part === 1; part++) {
    const chunk = [];
    let bytes = headerBytes;
    while (i < lines.length && (chunk.length === 0 || bytes + lines[i].length + 2 < LIMIT - 40 * 1000)) {
      bytes += lines[i].length + 2;
      chunk.push(lines[i++]);
    }
    const name = `${source}-${part}.json`;
    write(name, fileText(name, { format: FORMAT, generator: GENERATOR, source, part, ...header, cases: chunk }));
    if (i >= lines.length) break;
  }
}

const p = programCases();
const e = edgeCases();
const sp = sweepPaths();
const sc = sweepCaps();

// The directory is this script's: what it wrote before goes, so that a part
// that is no longer written does not stay.
mkdirSync(DATA, { recursive: true });
for (const name of readdirSync(DATA)) if (name.endsWith(".json")) rmSync(new URL(name, DATA));
write("std.json", fileText("std.json", { format: FORMAT, generator: GENERATOR, std: stdTables() }));
writeCases("programs", { sources: p.sources, tables: p.tables }, [...p.cases, ...p.rel]);
writeCases("edges", { tables: e.tables }, e.cases);
writeCases("sweep", { tables: [] }, [...sp.cases, ...sc.cases]);

const thrown = p.thrown + e.thrown + sp.thrown + sc.thrown;
const count = (cs) => {
  const by = {};
  for (const [fn] of cs) by[fn] = (by[fn] ?? 0) + 1;
  return Object.entries(by)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
};
process.stdout.write(
  `programs (${p.sources.length} programs): ${p.cases.length + p.rel.length} cases: ${count([...p.cases, ...p.rel])}\n` +
    `edges: ${e.cases.length} cases: ${count(e.cases)}\n` +
    `sweep: ${sp.cases.length + sc.cases.length} cases: ${count([...sp.cases, ...sc.cases])}\n` +
    `files: ${written.join(", ")}\n` +
    `calls that threw in TypeScript, left out: ${thrown}\n` +
    `total: ${total} bytes; cases: programs ${p.cases.length + p.rel.length}, edges ${e.cases.length}, sweep ${sp.cases.length + sc.cases.length}\n`,
);
if (thrown) process.exitCode = 1;
// What every clone carries: more is a decision, made here, not an accident.
if (total > TOTAL_LIMIT) {
  process.stderr.write(`the test data is ${total} bytes, over ${TOTAL_LIMIT}\n`);
  process.exitCode = 1;
}
