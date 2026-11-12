// Static capability values (Doc 4 §7): what a capability authorizes and over
// which scope, how narrowing works (C3), and whether write scopes overlap (C5).
//
// A capability over a component (design doc 9 §2.2) is written with the
// component's name and opens into the same values as the paths, commands and
// repositories it stands for, so every check and every sandbox treats it
// exactly like one written out:
//
//   component.read(c…)           fs.read(c.root…)
//   component.write(c, p…)       fs.write(c.root/p…), or c.root without paths
//   component.exec(c, build|test)  exec(command, args_prefix) per declared command
//   component.repo(c…)           git.pr(c.repo…)

import { posix } from "node:path";
import { diag, ptr, type Diagnostic } from "../diag.js";
import { atLeast, type Arg, type ComponentDef, type Def, type Expr, type LanguageVersion, type Program } from "../ir/types.js";
import { CAP_CTORS, DEFAULT_MODEL_MAX_CLASS, DATA_CLASSES, type DataClass } from "../std/std.js";

export interface CapVal {
  /** The capability's name when it comes from a `capability` definition. */
  name?: string;
  /** For a capability over components: what it was written as, e.g. `component.read(mcp)`. */
  via?: string;
  /** For a capability over components: their names. */
  components?: string[];
  /** For `component.exec`: the component's root, where its commands run. */
  root?: string;
  /** Constructor, e.g. `fs.write`. */
  ctor: string;
  /** Authorized effect: `Fs.Write`, `Model`, or a namespace such as `git.*`. */
  effect: string;
  write: boolean;
  /** Paths, hosts, commands or repositories; undefined means not statically known (treated as unbounded). */
  scope?: string[];
  /** For model.infer: the highest data class it may receive. */
  maxClass?: DataClass;
  /** For model.infer: the model tier, e.g. `standard`. */
  tier?: string;
  /** For exec: the argument prefixes a command may start with. */
  argsPrefix?: string[][];
  /**
   * For net.https from 0.5: the HTTP methods it allows, sorted, without duplicates. Undefined means any method.
   * Before 0.5 `methods` is not read, and a capability that writes it allows any method, as it always did.
   */
  methods?: string[];
}

/** The methods `net.https(methods: […])` may name, from 0.5 (spec/boundary.md). */
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Whether a capability read in `language` reads `methods`: from 0.5. */
export function readsMethods(language: LanguageVersion | undefined): boolean {
  return language !== undefined && atLeast(language, "mandate/0.5");
}

/** One problem with a `methods:` argument (E1801): where it is, below the argument's value, and what is there. */
export interface MethodProblem {
  /** JSON Pointer below the argument's value: "" for the value itself, "/items/<i>" for an item. */
  at: string;
  /** The name written, or null where no bare name is written. */
  found: string | null;
  problem: "not_a_list" | "empty" | "not_a_name" | "unknown";
}

/**
 * The methods a `methods:` value names, and what is wrong with it: it is a non-empty list of bare names from
 * HTTP_METHODS. Only names it knows are in `methods`; a value with a problem does not check (E1801).
 */
export function readMethods(v: Expr): { methods: string[]; problems: MethodProblem[] } {
  if (v.op !== "list") return { methods: [], problems: [{ at: "", found: null, problem: "not_a_list" }] };
  if (!v.items.length) return { methods: [], problems: [{ at: "", found: null, problem: "empty" }] };
  const methods = new Set<string>();
  const problems: MethodProblem[] = [];
  v.items.forEach((item, i) => {
    if (item.op !== "var") problems.push({ at: `/items/${i}`, found: item.op === "text" ? item.value : null, problem: "not_a_name" });
    else if (!(HTTP_METHODS as readonly string[]).includes(item.name)) problems.push({ at: `/items/${i}`, found: item.name, problem: "unknown" });
    else methods.add(item.name);
  });
  return { methods: [...methods].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), problems };
}

/**
 * How a capability expression is read. What it means can depend on the language of the program it is read in, as
 * a definition imported from a module is read in the program that imports it. Without a language it is read as
 * in 0.1 to 0.4.
 */
export interface CapOptions {
  /** The language of the program the capability is read in. */
  language?: LanguageVersion;
}

/** Dotted path of a callee such as `fs.read` or `git.pr`, if it is one. */
export function calleePath(e: Expr): string | undefined {
  if (e.op === "var") return e.name;
  if (e.op === "field") {
    const base = calleePath(e.of);
    return base === undefined ? undefined : `${base}.${e.name}`;
  }
  return undefined;
}

function literalStrings(e: Expr): string[] | undefined {
  if (e.op === "text") return [e.value];
  if (e.op === "list") {
    const out: string[] = [];
    for (const i of e.items) {
      const s = literalStrings(i);
      if (!s) return undefined;
      out.push(...s);
    }
    return out;
  }
  return undefined;
}

function symbol(e: Expr): string | undefined {
  return e.op === "var" ? e.name : e.op === "text" ? e.value : undefined;
}

/**
 * Evaluates a capability constructor call such as `fs.write("/work/repo/src")`.
 * Returns undefined when the expression is not a known constructor.
 */
export function capFromCall(e: Expr, opts: CapOptions = {}): CapVal | undefined {
  if (e.op !== "call") return undefined;
  const ctor = calleePath(e.callee);
  if (!ctor) return undefined;
  const spec = CAP_CTORS[ctor];
  if (!spec) return undefined;
  const cap: CapVal = { ctor, effect: spec.effect, write: spec.write };
  const named = (n: string): Arg | undefined => e.args.find((a) => a.name === n);
  switch (spec.scope) {
    case "positional": {
      const pos = e.args.filter((a) => a.name === undefined);
      const vals = pos.map((a) => literalStrings(a.value));
      if (pos.length && vals.every((v) => v !== undefined)) cap.scope = vals.flat() as string[];
      break;
    }
    case "hosts": {
      const h = named("hosts");
      const v = h && literalStrings(h.value);
      if (v) cap.scope = v;
      // From 0.5 a capability may allow only some methods. Before, `methods` is written and means nothing.
      const m = readsMethods(opts.language) ? named("methods") : undefined;
      if (m) cap.methods = readMethods(m.value).methods;
      break;
    }
    case "commands": {
      const c = named("commands");
      const v = c && literalStrings(c.value);
      if (v) cap.scope = v;
      const p = named("args_prefix");
      if (p && p.value.op === "list") {
        const prefixes = p.value.items.map((i) => (i.op === "list" ? literalStrings(i) : undefined));
        if (prefixes.every((x) => x !== undefined)) cap.argsPrefix = prefixes as string[][];
      }
      break;
    }
  }
  if (ctor === "model.infer") {
    const m = named("max_class");
    const s = m && symbol(m.value);
    cap.maxClass = s && (DATA_CLASSES as string[]).includes(s) ? (s as DataClass) : DEFAULT_MODEL_MAX_CLASS;
    const t = named("tier");
    const tier = t && symbol(t.value);
    if (tier) cap.tier = tier;
  }
  return cap;
}

/**
 * E1804: a program of 0.1 to 0.4 reads every capability in its own language, so a `net.https` written with
 * `methods` in a module of 0.5 or later, which it reaches through an import, would allow any method there. Each
 * imported definition that holds such a call is refused, at the import that brings it in. What the program writes
 * itself, and what a module below 0.5 writes, are read as they always were and not looked at.
 */
export function importedMethods(program: Program, linked: { defs: Record<string, Def>; origin: Record<string, string> }, modules: Record<string, Program> = {}): Diagnostic[] {
  if (readsMethods(program.language)) return [];
  const out: Diagnostic[] = [];
  const holds = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(holds);
    if (!v || typeof v !== "object") return false;
    const e = v as Expr;
    if (e.op === "call" && calleePath(e.callee) === "net.https" && e.args.some((a) => a.name === "methods")) return true;
    return Object.values(v).some(holds);
  };
  for (const name of Object.keys(linked.origin).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const module = linked.origin[name]!;
    const m = Object.hasOwn(modules, module) ? modules[module] : undefined;
    if (!m || !readsMethods(m.language) || !holds(linked.defs[name])) continue;
    const i = (program.uses ?? []).findIndex((u) => u.module === module);
    out.push(
      diag("E1804", `${name}, imported from ${module}, holds a net.https capability that allows only some methods, as ${m.language} reads it. This program is ${program.language}, which would read it without the limit, allowing any method. Write the program in mandate/0.5 or later.`, { path: i < 0 ? "/uses" : ptr("uses", i) }, {
        facts: { definition: name, module, module_language: m.language, language: program.language },
      }),
    );
  }
  return out;
}

/** What a capability expression stands for, or why it stands for nothing. */
export interface CapResult {
  caps: CapVal[];
  problem?: string;
}

const COMPONENT_CTORS = new Set(["component.read", "component.write", "component.exec", "component.repo"]);

/**
 * A capability constructor call, with the component definitions in `defs`
 * for `component.*`. Undefined when the expression is no constructor; a
 * constructor that cannot be opened (an argument that is not a component, a
 * command kind it does not declare) has a `problem` and no capabilities.
 */
export function capsFromCall(e: Expr, defs: Record<string, Def> = {}, opts: CapOptions = {}): CapResult | undefined {
  if (e.op !== "call") return undefined;
  const ctor = calleePath(e.callee);
  if (ctor && COMPONENT_CTORS.has(ctor)) return componentCaps(ctor, e.args, defs);
  if (ctor === "data.read") return readCaps(e.args, defs);
  if (ctor === "env.deploy" || ctor === "env.migrate") return envCaps(ctor, e.args, defs);
  const c = capFromCall(e, opts);
  return c ? { caps: [c] } : undefined;
}

function componentCaps(ctor: string, args: Arg[], defs: Record<string, Def>): CapResult {
  const fail = (problem: string): CapResult => ({ caps: [], problem });
  const named = (a: Arg | undefined): [string, ComponentDef] | string => {
    const n = a?.value.op === "var" ? a.value.name : undefined;
    const d = n && Object.hasOwn(defs, n) ? defs[n] : undefined;
    return n && d?.kind === "component" ? [n, d] : `${ctor} takes components; ${n ? `'${n}' is not a component` : "an argument is not a component name"}`;
  };
  const shown = `${ctor}(${args.map((a) => (a.value.op === "var" ? a.value.name : a.value.op === "text" ? JSON.stringify(a.value.value) : "…")).join(", ")})`;
  if (!args.length) return fail(`${ctor} needs a component`);
  if (ctor === "component.read" || ctor === "component.repo") {
    const cs: Array<[string, ComponentDef]> = [];
    for (const a of args) {
      const c = named(a);
      if (typeof c === "string") return fail(c);
      cs.push(c);
    }
    const names = cs.map(([n]) => n);
    if (ctor === "component.read") return { caps: [{ ctor: "fs.read", effect: "Fs.Read", write: false, scope: cs.map(([, c]) => c.root), via: shown, components: names }] };
    return { caps: [{ ctor: "git.pr", effect: "git.*", write: true, scope: [...new Set(cs.map(([, c]) => c.repo))], via: shown, components: names }] };
  }
  const c = named(args[0]);
  if (typeof c === "string") return fail(c);
  const [name, comp] = c;
  if (ctor === "component.write") {
    const paths: string[] = [];
    for (const a of args.slice(1)) {
      if (a.value.op !== "text") return fail(`${ctor} takes paths inside the component as text`);
      const rel = posix.normalize(a.value.value);
      if (posix.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return fail(`${JSON.stringify(a.value.value)} is not a path inside ${name}`);
      paths.push(rel === "." ? comp.root : `${comp.root.replace(/\/$/, "")}/${rel}`);
    }
    return { caps: [{ ctor: "fs.write", effect: "Fs.Write", write: true, scope: paths.length ? paths : [comp.root], via: shown, components: [name] }] };
  }
  // component.exec(c, build | test …): one exec capability per declared command, with exactly its argument prefixes.
  const kinds = args.slice(1).map((a) => (a.value.op === "var" ? a.value.name : ""));
  if (!kinds.length) return fail(`${ctor} names what to run: build or test`);
  const byCommand = new Map<string, string[][]>();
  for (const k of kinds) {
    if (k !== "build" && k !== "test") return fail(`${ctor} runs build or test, not '${k || "an expression"}'`);
    const declared = comp[k];
    if (!declared) return fail(`${name} declares no ${k} commands`);
    for (const cmd of declared) byCommand.set(cmd.command, [...(byCommand.get(cmd.command) ?? []), cmd.args]);
  }
  return {
    caps: [...byCommand.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([command, prefixes]) => ({ ctor: "exec", effect: "Exec", write: false, scope: [command], argsPrefix: uniquePrefixes(prefixes), via: shown, components: [name], root: comp.root })),
  };
}

/**
 * `data.read(env, read…)`: the authority to run those declared reads of an
 * environment through the read broker (design doc 9 §5.1); without read
 * names, every read the environment declares. Scope items are `env.read`.
 */
/** `env.deploy(staging, prod)`: deploy (or migrate) in those environments of the system model, and nowhere else. */
function envCaps(ctor: string, args: Arg[], defs: Record<string, Def>): CapResult {
  const envs: string[] = [];
  for (const a of args) {
    const n = a.value.op === "var" ? a.value.name : undefined;
    if (!n || !Object.hasOwn(defs, n) || defs[n]!.kind !== "environment") return { caps: [], problem: `${ctor} takes environments; ${n ? `'${n}' is not one` : "an argument is not an environment name"}` };
    envs.push(n);
  }
  if (!envs.length) return { caps: [], problem: `${ctor} needs an environment` };
  const spec = CAP_CTORS[ctor]!;
  return { caps: [{ ctor, effect: spec.effect, write: spec.write, scope: [...new Set(envs)].sort(), via: `${ctor}(${envs.join(", ")})` }] };
}

function readCaps(args: Arg[], defs: Record<string, Def>): CapResult {
  const env = args[0]?.value.op === "var" ? args[0].value.name : undefined;
  const d = env && Object.hasOwn(defs, env) ? defs[env] : undefined;
  if (!env || d?.kind !== "environment") return { caps: [], problem: `data.read takes an environment first; ${env ? `'${env}' is not one` : "the first argument is not an environment name"}` };
  const declared = Object.keys(d.reads ?? {});
  const named: string[] = [];
  for (const a of args.slice(1)) {
    const r = a.value.op === "var" ? a.value.name : a.value.op === "text" ? a.value.value : undefined;
    if (!r || !declared.includes(r)) return { caps: [], problem: `${env} declares no read ${r ? `'${r}'` : "named by that argument"}` };
    named.push(r);
  }
  const reads = (named.length ? named : declared).sort();
  if (!reads.length) return { caps: [], problem: `${env} declares no reads` };
  return { caps: [{ ctor: "data.read", effect: "Data.Read", write: false, scope: reads.map((r) => `${env}.${r}`), via: `data.read(${[env, ...named].join(", ")})` }] };
}

function uniquePrefixes(ps: string[][]): string[][] {
  const seen = new Set<string>();
  return ps.filter((p) => {
    const k = JSON.stringify(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The capabilities an expression stands for: a named capability, a
 * constructor (including `component.*`), or `c.narrow(…)`. A narrowing whose
 * scope is not literal leaves the scope unknown, never the base's wider one.
 * The checker reports what cannot be evaluated; here it stands for nothing.
 */
export function capsOf(defs: Record<string, Def>, e: Expr, opts: CapOptions = {}, within: ReadonlySet<string> = new Set()): CapVal[] {
  if (e.op === "var") {
    const d = Object.hasOwn(defs, e.name) ? defs[e.name] : undefined;
    // A capability that names itself, directly or through another, is nothing.
    if (d?.kind !== "capability" || within.has(e.name)) return [];
    return capsOf(defs, d.value, opts, new Set(within).add(e.name)).map((c) => ({ ...c, name: e.name }));
  }
  if (e.op === "call" && e.callee.op === "field" && e.callee.name === "narrow") {
    const bases = capsOf(defs, e.callee.of, opts, within);
    const scope = e.args.flatMap((a) => (a.value.op === "text" ? [a.value.value] : []));
    return bases.map((base) => {
      const { scope: _wide, ...rest } = base;
      return bases.length === 1 && scope.length === e.args.length ? { ...rest, scope, name: `${base.name ?? base.ctor}.narrow` } : rest;
    });
  }
  return capsFromCall(e, defs, opts)?.caps ?? [];
}

/** Normalizes an absolute path into segments; `..` and `.` are resolved, trailing slashes dropped. */
export function segments(path: string): string[] {
  const out: string[] = [];
  for (const s of path.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out;
}

/** True when path `inner` lies at or below `outer`, segment by segment (not by string prefix). */
export function within(inner: string, outer: string): boolean {
  const a = segments(inner);
  const b = segments(outer);
  return b.length <= a.length && b.every((s, i) => a[i] === s);
}

export function pathsOverlap(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

function scopeItemWithin(ctor: string, item: string, outer: string): boolean {
  return ctor.startsWith("fs.") ? within(item, outer) : item === outer;
}

/** C3: every item of `inner` lies inside some item of `outer`. Unknown scopes are not provably inside. */
export function scopeWithin(ctor: string, inner: string[] | undefined, outer: string[] | undefined): boolean {
  if (outer === undefined) return true;
  if (inner === undefined) return false;
  return inner.every((i) => outer.some((o) => scopeItemWithin(ctor, i, o)));
}

/** Every argument prefix in `inner` extends one in `outer`. No prefixes means any arguments. */
export function prefixesWithin(inner: string[][] | undefined, outer: string[][] | undefined): boolean {
  if (outer === undefined) return true;
  if (inner === undefined) return false;
  return inner.every((p) => outer.some((o) => o.length <= p.length && o.every((s, i) => p[i] === s)));
}

/** Does `cap` authorize everything `need` authorizes? */
export function capCovers(cap: CapVal, need: CapVal): boolean {
  if (cap.ctor !== need.ctor) return false;
  if (!scopeWithin(cap.ctor, need.scope, cap.scope)) return false;
  if (need.maxClass && cap.maxClass && DATA_CLASSES.indexOf(need.maxClass) > DATA_CLASSES.indexOf(cap.maxClass)) return false;
  // Tiers are not ordered: a capability without a tier allows any, one with a tier allows only that one.
  if (cap.tier !== undefined && need.tier !== cap.tier) return false;
  if (!prefixesWithin(need.argsPrefix, cap.argsPrefix)) return false;
  // Methods (0.5): a capability without them allows any method, so only one without them covers one without them.
  if (cap.methods !== undefined && (need.methods === undefined || !need.methods.every((m) => cap.methods!.includes(m)))) return false;
  return true;
}

/** Does `cap` authorize effect `effect`, optionally over `scope`? */
export function capAuthorizes(cap: CapVal, effect: string, scope?: string[]): boolean {
  if (cap.effect.endsWith(".*")) {
    if (!effect.startsWith(cap.effect.slice(0, -1))) return false;
  } else if (cap.effect !== effect) {
    return false;
  }
  return scope === undefined || scopeWithin(cap.ctor, scope, cap.scope);
}

/** C5: two write capabilities whose scopes intersect. Unknown scopes are assumed to overlap. */
export function writesOverlap(a: CapVal, b: CapVal): boolean {
  if (!a.write || !b.write || a.ctor !== b.ctor) return false;
  if (a.scope === undefined || b.scope === undefined) return true;
  const fs = a.ctor.startsWith("fs.");
  return a.scope.some((x) => b.scope!.some((y) => (fs ? pathsOverlap(x, y) : x === y)));
}

export function showCap(c: CapVal): string {
  const args = [...(c.scope ?? []).map((s) => JSON.stringify(s)), ...(c.methods ? [`methods: [${c.methods.join(", ")}]`] : [])];
  const scope = c.scope || c.methods ? `(${args.join(", ")})` : "";
  return `${c.name ? `${c.name} = ` : ""}${c.via ? `${c.via} → ` : ""}${c.ctor}${scope}`;
}
