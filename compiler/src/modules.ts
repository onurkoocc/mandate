// Imported modules (Doc 4 §4.1, §19; design doc 9 §2.1). A program that
// imports names from a module the caller has loaded sees those definitions:
// a system model such as `kervan.system` is an ordinary module, and programs
// import its components, interfaces and environments with `use`.
//
// Linking does not change the program or its hash. It builds the table of
// definitions the program can see: its own, the ones it imports by name, and
// what those refer to inside their module (a component's interfaces, a
// read's row type). The program may name only the first two; the rest are
// there so that checks of imported definitions see what they mean. A module
// the caller has not loaded stays opaque, as before: its names resolve and
// their types are unknown.
//
// The lock file pins every imported module by its program hash, so a run's
// system model cannot change under it (INV-02, S09).

import { diag, ptr, type Diagnostic } from "./diag.js";
import type { Def, Program } from "./ir/types.js";

/** Loaded modules by name. */
export type Modules = Record<string, Program>;

export interface Linked {
  /** Every definition visible to the checks: local, imported, and what imports refer to. */
  defs: Record<string, Def>;
  /** The module an imported definition comes from. */
  origin: Record<string, string>;
  diagnostics: Diagnostic[];
}

export function link(program: Program, modules: Modules = {}): Linked {
  const defs: Record<string, Def> = { ...program.defs };
  const origin: Record<string, string> = {};
  const diagnostics: Diagnostic[] = [];
  (program.uses ?? []).forEach((u, i) => {
    const m = Object.hasOwn(modules, u.module) ? modules[u.module] : undefined;
    if (!m || !u.names) return;
    for (const name of u.names) {
      if (!Object.hasOwn(m.defs, name)) {
        diagnostics.push(diag("E0120", `Module ${u.module} has no definition '${name}'.`, { path: ptr("uses", i, "names") }, { facts: { name, module: u.module, expected: "definition" } }));
        continue;
      }
      for (const dep of closure(m, name)) {
        if (origin[dep] === u.module) continue;
        if (Object.hasOwn(defs, dep)) {
          const where = origin[dep] ? `module ${origin[dep]}` : "a definition of this module";
          diagnostics.push(diag("E0121", `'${dep}' from ${u.module} collides with ${where}.`, { path: ptr("uses", i) }, { facts: { name: dep, module: u.module } }));
          continue;
        }
        defs[dep] = m.defs[dep]!;
        origin[dep] = u.module;
      }
    }
  });
  return { defs, origin, diagnostics };
}

/** A program whose definitions are the linked ones: for checks, views and the interpreter, never for hashing. */
export function linkedProgram(program: Program, modules: Modules = {}): Program {
  return { ...program, defs: link(program, modules).defs };
}

/** `name` and every definition of `m` it refers to, transitively. */
function closure(m: Program, name: string): string[] {
  const out = new Set<string>();
  const visit = (n: string): void => {
    if (out.has(n) || !Object.hasOwn(m.defs, n)) return;
    out.add(n);
    for (const r of references(m.defs[n]!)) visit(r);
    // An interface comes with its provider: who answers for a change to it (doc 9 §2.1, §3.3).
    if (m.defs[n]!.kind === "interface") {
      for (const [c, d] of Object.entries(m.defs)) if (d.kind === "component" && d.provides?.includes(n)) visit(c);
    }
  };
  visit(name);
  return [...out].sort();
}

/** Names a definition refers to: types, variables, agents, contracts, effects, interfaces and components. */
export function references(d: Def): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o["ref"] === "string") out.add(o["ref"]);
    if (o["op"] === "var" && typeof o["name"] === "string") out.add(o["name"]);
    if (o["op"] === "effect" && typeof o["name"] === "string") out.add(o["name"]);
    for (const k of ["agent", "contract", "effect", "compensate", "compensation", "from"]) if (typeof o[k] === "string") out.add(o[k]);
    for (const k of ["provides", "consumes"]) if (Array.isArray(o[k])) for (const x of o[k]) if (typeof x === "string") out.add(x);
    Object.values(o).forEach(walk);
  };
  walk(d);
  return out;
}
