// A lead's sub-program (0.4; spec/envelope.md "The sub-program").
//
// A lead agent writes a sub-program while a run is going, as a patch to a
// skeleton the runtime starts for it. Before any of it runs it is held to
// what the person who approved the envelope approved:
//
//   E1705  it defines only types, constants, capabilities, functions, local
//          agents and one workflow, which takes no parameters, has no envelope
//          and does not `plan`; what the skeleton says of the module stays
//   E1706  its workflow's `caps` and `budget`, its claim on the envelope, fit
//          what is left: every capability inside one of the envelope's and
//          clear of the writes still in flight, the budget within the
//          remainder in every dimension the run is limited in, and its time
//          before the run's deadline
//
// The rest of containment is checked where it always is (static.ts, with a
// `Claim`): the envelope's `max_concurrent` and `max_class` hold in the
// sub-program's workflow, and every model in it is held to the class of what
// the lead received.

import { diag, ptr, ptrToken, type Diagnostic } from "../diag.js";
import { atLeast, BUDGET_DIMENSIONS, budgetAmount, type Budget, type BudgetDimension, type Def, type LanguageVersion, type Program } from "../ir/types.js";
import { canonicalize } from "../json/jcs.js";
import type { Json } from "../json/strict-json.js";
import { capCovers, capsOf, showCap, writesOverlap, type CapOptions, type CapVal } from "./caps.js";

/**
 * The module the runtime starts for sub-program `n` of a lead in module `parent`. Its hash is the `base` of the lead's
 * patch. It is written in its parent's language, and in 0.4 at least, where `plan` begins: so a sub-program reads
 * its parent's definitions as its parent does, a capability's `methods` from 0.5 included.
 */
export function skeleton(parent: string, n: number, language: LanguageVersion = "mandate/0.4"): Program {
  return { language: atLeast(language, "mandate/0.4") ? language : "mandate/0.4", module: `${parent}.plan_${n}`, version: "0.1", uses: [{ module: parent }], defs: {} };
}

/**
 * The sub-program as the checks and the interpreter read it. Its `use` of its
 * parent names nothing, and stands for all the parent sees: every definition
 * of the parent, and everything the parent imports. Never hashed and never
 * stored: a sub-program's hash is that of what the lead wrote.
 */
export function opened(sub: Program, parent: Program): Program {
  return { ...sub, uses: [...(parent.uses ?? []), { module: parent.module, names: Object.keys(parent.defs).sort() }] };
}

/** The kinds a sub-program may define. */
const ALLOWED = new Set<Def["kind"]>(["type", "const", "capability", "fn", "agent", "workflow"]);

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** Every node under `v` whose `op` is `op`, by JSON Pointer. */
function nodes(v: unknown, op: string, path: string, found: string[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => nodes(x, op, `${path}/${i}`, found));
    return;
  }
  if (!v || typeof v !== "object") return;
  if ((v as { op?: unknown }).op === op) found.push(path);
  for (const [k, x] of Object.entries(v)) nodes(x, op, `${path}/${ptrToken(k)}`, found);
}

/**
 * E1705: what a sub-program may be. `parent` and `n` say which skeleton it
 * was patched from. Acceptance criteria, external effects, host code, people
 * and the system model belong to the program a person approved, so a
 * sub-program defines none of them; a remote agent is a network binding, and
 * an envelope or a `plan` of its own would be authority nobody approved.
 */
export function subprogramShape(sub: Program, parent: string, n: number, language?: LanguageVersion): Diagnostic[] {
  const out: Diagnostic[] = [];
  const no = (message: string, path: string, facts: Record<string, unknown>): void => void out.push(diag("E1705", message, { path }, { facts }));
  const base = skeleton(parent, n, language);
  const same = (a: unknown, b: unknown): boolean => canonicalize((a ?? null) as Json) === canonicalize((b ?? null) as Json);
  for (const field of ["language", "module", "version", "uses", "tests"] as const) {
    if (same(sub[field], base[field])) continue;
    no(`A sub-program adds definitions and nothing else: '${field}' stays as the runtime gave it (spec/envelope.md "The sub-program").`, `/${field}`, { field });
  }
  const workflows: string[] = [];
  for (const [name, d] of Object.entries(sub.defs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const at = ptr("defs", name);
    if (!ALLOWED.has(d.kind)) {
      no(`A sub-program cannot define ${/^[aeiou]/.test(d.kind) ? "an" : "a"} ${d.kind} ('${name}'). It defines only types, constants, capabilities, functions, local agents and one workflow; the rest belongs to the program a person approved (spec/envelope.md "The sub-program").`, at, { def: name, kind: d.kind });
      continue;
    }
    if (d.kind === "agent" && d.remote) {
      no(`A sub-program cannot define a remote agent ('${name}'): a network binding is a governance change (G11).`, `${at}/remote`, { def: name, kind: "remote agent" });
    }
    if (d.kind === "workflow") {
      workflows.push(name);
      if (d.envelope) no(`A sub-program's workflow has no envelope of its own ('${name}'): it runs inside the one a person approved, and its caps and budget are its claim on it.`, `${at}/envelope`, { def: name, kind: "envelope" });
      if (d.params.length) {
        no(`A sub-program's workflow takes no parameters ('${name}' takes ${d.params.length}): nothing calls it with arguments. Write the values it works on into the sub-program.`, `${at}/params`, { def: name, kind: "parameters", params: d.params.length });
      }
    }
    const plans: string[] = [];
    nodes(d, "plan", at, plans);
    for (const path of plans.sort()) no(`A sub-program cannot 'plan': only the program a person approved starts a lead (spec/envelope.md "The sub-program").`, path, { def: name, kind: "plan" });
  }
  if (workflows.length !== 1) {
    no(
      workflows.length ? `A sub-program has exactly one workflow, and this one has ${workflows.length}: ${list(workflows)}.` : "A sub-program has exactly one workflow, which is what runs. This one has none.",
      "/defs",
      { kind: "workflow", workflows },
    );
  }
  return out;
}

/** The name of a sub-program's one workflow, once `subprogramShape` has passed it. */
export function subprogramWorkflow(sub: Program): string | undefined {
  return Object.keys(sub.defs).find((n) => sub.defs[n]!.kind === "workflow");
}

/** What is left of an envelope when a sub-program asks for a part of it. The runtime reads it from the run's ledger. */
export interface Room {
  /**
   * What the run has left in each ledger dimension it is limited in: `limit −
   * settled − active reservations`. The dimensions are `tokens`, `steps`,
   * `agents` and `spend:<currency>` in micro-units.
   */
  left: Record<string, number>;
  /** Milliseconds to the run's deadline, its start plus the envelope's `time`. Absent when the envelope names no time. */
  time_left_ms?: number;
  /** The write capabilities that sub-programs and map items still in flight hold. */
  writes: CapVal[];
}

/** A budget's amount in each ledger dimension it names, and where it is written under the budget. */
function claimed(b: Budget | undefined): Array<{ dimension: string; field: BudgetDimension; amount: number }> {
  const out: Array<{ dimension: string; field: BudgetDimension; amount: number }> = [];
  for (const field of BUDGET_DIMENSIONS) {
    const amount = budgetAmount(b, field);
    if (amount === undefined || field === "time") continue;
    out.push({ dimension: field === "spend" ? `spend:${b!.spend!.currency}` : field, field, amount });
  }
  return out;
}

/**
 * E1706: whether a sub-program's claim fits what is left of the envelope
 * (N01, INV-15). `defs` is every definition the sub-program sees, its own and
 * its parent's; `workflow` is its one workflow; `envelope` holds the
 * envelope's capabilities, evaluated; `opts` says how the sub-program's own are
 * read (its language). Each diagnostic names the dimension
 * that does not fit, with the numbers, so that the lead can ask for less.
 */
export function containment(defs: Record<string, Def>, workflow: string, envelope: CapVal[], room: Room, opts: CapOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const wf = Object.hasOwn(defs, workflow) ? defs[workflow] : undefined;
  if (wf?.kind !== "workflow") return out;
  const at = ptr("defs", workflow);
  const no = (message: string, path: string, facts: Record<string, unknown>): void => void out.push(diag("E1706", message, { path }, { facts }));

  // C2: every capability lies inside one the envelope holds. C5 across the run: none may write where
  // something still in flight writes.
  wf.caps.forEach((e, i) => {
    for (const c of capsOf(defs, e, opts)) {
      const shown = showCap(c);
      if (!envelope.some((w) => capCovers(w, c))) {
        no(`${workflow} asks for ${shown}, which lies inside no capability of the envelope. A sub-program holds only what the envelope's owner approved (C2).`, `${at}/caps/${i}`, {
          dimension: "capability",
          capability: shown,
          envelope: envelope.map(showCap),
        });
        continue;
      }
      const held = room.writes.find((w) => writesOverlap(w, c));
      if (held) {
        no(`${workflow} asks for ${shown}, and ${showCap(held)} is still held by a part of the run that has not ended. Two parts of a run do not write the same place at once (C5).`, `${at}/caps/${i}`, {
          dimension: "write_scope",
          capability: shown,
          in_flight: showCap(held),
        });
      }
    }
  });

  // The budget is what admission reserves, so it names every dimension the run is limited in, and fits.
  const asked = claimed(wf.budget);
  for (const dimension of Object.keys(room.left).sort()) {
    if (asked.some((a) => a.dimension === dimension)) continue;
    no(`${workflow}'s budget names no ${dimension}. A sub-program reserves what it may use of the envelope in every dimension the run is limited in.`, wf.budget ? `${at}/budget` : at, {
      dimension,
      asked: null,
      left: room.left[dimension],
    });
  }
  for (const a of asked) {
    const left = Object.hasOwn(room.left, a.dimension) ? room.left[a.dimension]! : undefined;
    // A dimension the run has no limit in is not held to one; money in a currency the envelope does not give is.
    if (left === undefined && !(a.field === "spend" && Object.keys(room.left).some((d) => d.startsWith("spend:")))) continue;
    if (a.amount <= (left ?? 0)) continue;
    no(`${workflow} asks for ${a.amount} ${a.dimension}, and the envelope has ${left ?? 0} left.`, `${at}/budget/${a.field}`, { dimension: a.dimension, asked: a.amount, left: left ?? 0 });
  }
  if (room.time_left_ms !== undefined) {
    const time = wf.budget?.time?.ms;
    if (time === undefined) {
      no(`${workflow}'s budget names no time. A sub-program says how long it may take, which must end before the run's deadline.`, wf.budget ? `${at}/budget` : at, { dimension: "time", asked: null, left: room.time_left_ms });
    } else if (time > room.time_left_ms) {
      no(`${workflow} asks for ${time} ms, and the run's deadline is ${Math.max(room.time_left_ms, 0)} ms away.`, `${at}/budget/time`, { dimension: "time", asked: time, left: room.time_left_ms });
    }
  }
  return out;
}
