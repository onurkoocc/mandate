// `both` mode: every call of a door-backed function asks the two compilers and compares what they give. The Rust's
// result is what the caller gets, so that `both` is `rust` with the TypeScript as its witness; a difference throws
// a CompilerDivergence that names the function and shows the two, and is kept besides, so that a caller that
// catches it does not hide it (the test setup of the bridge and of the runtime fails a test that made one).
//
// The two agree when both give the same value (same.ts: the same kinds, members in the same order, Maps, Sets and
// undefined told apart), or both throw: the TypeScript throws where the Rust's door refuses its input (`bad_input`,
// which rust.ts throws as an Error), and where the TypeScript throws an Error of its own making (not a TypeError of
// an input outside its types) the two messages are the same. A CompilerFailure of the Rust is not a refusal: it is
// thrown as it is, in `both` as in `rust`.
//
// What the TypeScript cannot be asked: an input of language 0.6 (`isV06`, the one place that says what that is),
// which only the Rust reads. The TypeScript is not run for it, and the call is counted under `language-0.6`.
//
// What the two are known to answer differently: the entries of vectors/README.md, "Where the Rust compiler is not
// held to the TypeScript", each a named rule below that says which functions and which shape of input or outcome
// it covers. A rule either normalizes (it changes one side in the one way the entry says, and the two are compared
// after) or covers (on the inputs of its shape, the outcomes are not compared). Each counts the calls it excused,
// and `exemptionCounts()` gives the counts; no other difference is excused.

import { writeSync } from "node:fs";
import { DOOR_BACKED, type DoorBacked } from "./doors.js";
import { difference } from "./same.js";
import { toWellFormed } from "./text.js";

/** What one compiler did with a call: gave a value, or threw. */
export type Outcome = { value: unknown } | { threw: unknown };

/** The two compilers answered one call differently. */
export class CompilerDivergence extends Error {
  override readonly name = "CompilerDivergence";

  constructor(
    /** The function of the facade, such as `check`. */
    readonly fn: string,
    /** Where they differ, and what each has there. */
    readonly where: string,
    readonly typescript: string,
    readonly rust: string,
  ) {
    super(`the TypeScript and the Rust compilers answer ${fn} differently: ${where}\n  TypeScript: ${typescript}\n  Rust:       ${rust}`);
  }
}

const divergences: CompilerDivergence[] = [];

/** The divergences since the last time they were taken, taken. */
export function takeDivergences(): CompilerDivergence[] {
  return divergences.splice(0);
}

/** Keeps a divergence another thread found (a worker's check, mode.ts). */
export function keepDivergence(d: CompilerDivergence): void {
  keep(d);
}

let watching = false;

/**
 * Keeps a divergence, and makes sure a process that ends with one still kept says so: a child process (the bundled
 * command line, a verifier) whose code caught it ends with exit status 70 and the divergences on its standard error,
 * so the test that started it sees it fail. A test file's own divergences are taken by its setup after each test.
 */
function keep(d: CompilerDivergence): void {
  divergences.push(d);
  if (watching) return;
  watching = true;
  process.on("exit", (code) => {
    if (!divergences.length) return;
    writeSync(2, `mandate bridge: ${divergences.length} call(s) the TypeScript and the Rust compilers answered differently, which nothing took:\n${divergences.map((x) => x.message).join("\n")}\n`);
    if (code === 0) process.exitCode = 70;
  });
}

// ── the input of language 0.6 ───────────────────────────────────────────

const V06 = "mandate/0.6";
const LOCK_06 = "mandate/lock/0.6";
/** The members a lock has only from format 0.6 on (spec/library.md): a lock that has one is of 0.6 whatever it says. */
const LOCK_06_MEMBERS = ["libraries", "connectors"];
/** The capability constructors only language 0.6 has (spec/library.md, `tool.call`). */
const CTORS_06 = new Set(["tool.call"]);

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A program (IR) of 0.6. */
const program06 = (p: unknown): boolean => obj(p) && p["language"] === V06;
/** A record of programs by name (Modules) with one of 0.6. */
const modules06 = (m: unknown): boolean => obj(m) && Object.values(m).some(program06);
/** A lock of format 0.6, or one with a member only 0.6 has. */
const lock06 = (l: unknown): boolean => obj(l) && (l["lock"] === LOCK_06 || LOCK_06_MEMBERS.some((k) => Object.hasOwn(l, k)));
/** `{ before?, after? }` of two locks, one of 0.6. */
const locks06 = (l: unknown): boolean => obj(l) && (lock06(l["before"]) || lock06(l["after"]));
/** A program's text of 0.6: `.mdt` whose header is `mandate @ 0.6`, or JSON IR whose `language` is mandate/0.6. */
function text06(text: unknown, kind?: unknown): boolean {
  if (typeof text !== "string") return false;
  if (kind === "json" || (kind === undefined && text.trimStart().startsWith("{"))) {
    try {
      return program06(JSON.parse(text));
    } catch {
      return false;
    }
  }
  return /^(?:\s|\/\/[^\n]*\n)*mandate\s*@\s*0\.6(?![0-9.])/.test(text);
}
/** Options with a `language`, a `lock` or `modules` of 0.6. */
const opts06 = (o: unknown): boolean => obj(o) && (o["language"] === V06 || lock06(o["lock"]) || modules06(o["modules"]));
/** A capability, or a list of them, of a constructor only 0.6 has, anywhere in `v`. */
function caps06(v: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (Array.isArray(v)) return v.some((x) => caps06(x, depth + 1));
  if (!obj(v)) return false;
  if (typeof v["ctor"] === "string" && CTORS_06.has(v["ctor"])) return true;
  return Object.values(v).some((x) => caps06(x, depth + 1));
}

/**
 * Whether a call's input is of language 0.6, by function: what it carries that has a language (a program, a
 * program's text, a lock, a language parameter, a module, a capability) and is of 0.6. A function whose input has
 * no language (a document, a view, a JSON value) is never of 0.6.
 */
export const LANGUAGE_06: Record<DoorBacked, (a: unknown[]) => boolean> = {
  load: (a) => text06(a[0], a[1]),
  check: (a) => text06(a[0], a[1]) || opts06(a[2]),
  loadModules: (a) => Array.isArray(a[0]) && a[0].some((s) => obj(s) && text06(s["text"], s["kind"])),
  parseStrictJson: () => false,
  canonicalize: () => false,
  hashProgram: (a) => program06(a[0]),
  packageHash: (a) => lock06(a[1]),
  domainHash: (a) => a[0] === "library" || a[2] === "0.6",
  printProgram: (a) => program06(a[0]),
  link: (a) => program06(a[0]) || modules06(a[1]),
  linkedProgram: (a) => program06(a[0]) || modules06(a[1]),
  references: () => false,
  rolesNamed: () => false,
  programRef: (a) => program06(a[0]),
  leadClasses: (a) => program06(a[0]),
  workflowBounds: (a) => caps06(a[0]),
  capsOf: (a) => opts06(a[2]) || caps06(a[1]),
  showCap: (a) => caps06(a[0]),
  governanceFiles: () => false,
  skeleton: (a) => a[2] === V06,
  subprogramLinked: (a) => program06(a[0]) || program06(a[1]) || modules06(a[2]),
  validateLock: (a) => lock06(a[0]),
  roleLockChecks: (a) => program06(a[0]) || lock06(a[2]),
  sandboxLockChecks: (a) => program06(a[0]) || lock06(a[1]),
  bindingChecks: (a) => program06(a[0]) || lock06(a[1]),
  modelTiers: (a) => program06(a[0]),
  packagedLock: (a) => lock06(a[0]),
  agentModels: (a) => program06(a[0]),
  sandboxRequirements: (a) => program06(a[0]) || modules06(a[1]) || lock06(a[2]),
  requirementFor: (a) => caps06(a[1]) || opts06(a[3]),
  denialDiagnostics: (a) => program06(a[0]),
  applyPatch: (a) => program06(a[0]) || modules06(a[3]),
  checkPatch: (a) => program06(a[0]) || modules06(a[3]),
  checkSubprogram: (a) => obj(a[0]) && (program06(a[0]["parent"]) || modules06(a[0]["modules"])),
  checkAmendment: (a) => obj(a[0]) && (program06(a[0]["parent"]) || modules06(a[0]["modules"])),
  semanticDiff: (a) => program06(a[0]) || program06(a[1]) || locks06(a[2]),
  governanceChanges: (a) => program06(a[0]) || program06(a[1]) || modules06(a[2]),
  envelopeChanges: (a) => program06(a[0]) || program06(a[1]) || modules06(a[3]),
  grant: (a) => caps06(a[0]),
  narrow: (a) => caps06(a[0]),
  mapScopes: (a) => caps06(a[0]),
  inFlightOverlap: (a) => caps06(a[0]),
  architecture: (a) => program06(a[0]),
  architectureBlocks: () => false,
  authority: (a) => program06(a[0]),
  authorityBlocks: () => false,
  cost: (a) => program06(a[0]) || lock06(a[1]),
  programDoc: (a) => program06(a[0]) || lock06(a[1]) || modules06(a[2]),
  diffDoc: (a) => program06(a[0]) || program06(a[1]) || locks06(a[2]),
  envelopeWorkflows: (a) => program06(a[0]),
  card: (a) => program06(a[0]) || opts06(a[2]),
  cardDoc: (a) => program06(a[0]) || opts06(a[2]),
  acsTarget: (a) => program06(a[0]) || modules06(a[1]) || lock06(a[2]),
  toMarkdown: () => false,
  toHtml: () => false,
};

// ── the named exemptions ────────────────────────────────────────────────

/** Asks the TypeScript again on other arguments: what a rule that names how the Rust reads an input compares with. */
export type Again = (args: unknown[]) => Outcome;

/**
 * A known difference: the functions it covers, the entry of vectors/README.md it stands on, and either `normalize`
 * (the one change the entry names, made to one side's value before the two are compared, and whether it changed
 * anything) or `covers` (whether the call has the shape the entry names, on both sides, so that it is not compared).
 * Each excuses its entry and nothing beside it: an input that also differs otherwise still diverges.
 */
export interface Exemption {
  name: string;
  /** The entry of vectors/README.md ("Where the Rust compiler is not held to the TypeScript") it stands on. */
  readme: string;
  functions: readonly DoorBacked[];
  normalize?: (ts: unknown, rust: unknown, args: unknown[], fn: DoorBacked) => { ts: unknown; rust: unknown; changed: boolean };
  covers?: (fn: DoorBacked, args: unknown[], ts: Outcome, rust: Outcome, again?: Again) => boolean;
}

/** The functions whose result holds diagnostics, wherever: what a rule about a diagnostic applies to. */
const DIAGNOSING: readonly DoorBacked[] = ["load", "check", "loadModules", "parseStrictJson", "link", "validateLock", "roleLockChecks", "sandboxLockChecks", "bindingChecks", "denialDiagnostics", "applyPatch", "checkPatch", "checkSubprogram", "checkAmendment", "acsTarget"];
/** The functions that read a sub-program's or a patch's operations. */
const PATCHING: readonly DoorBacked[] = ["applyPatch", "checkPatch", "checkSubprogram"];
/** The functions that check a program (and so can meet a type named like a member of Object.prototype). */
const CHECKING: readonly DoorBacked[] = ["check", "applyPatch", "checkPatch", "checkSubprogram", "checkAmendment", "loadModules"];

/** A copy of `v` with `f` applied to every diagnostic in it (an object with a string `code` and `message`), and whether that changed one. */
function mapDiagnostics(v: unknown, f: (d: Record<string, unknown>) => Record<string, unknown>): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x instanceof Map) return new Map([...x].map(([k, y]) => [k, walk(y)]));
    if (!obj(x)) return x;
    if (typeof x["code"] === "string" && typeof x["message"] === "string") {
      const y = f(x);
      if (difference(y, x)) changed = true;
      return y;
    }
    return Object.fromEntries(Object.keys(x).map((k) => [k, walk(x[k])]));
  };
  return { value: walk(v), changed };
}

/** The Rust's E0103 without the versions only it reads (crates/mandate-testkit/src/rust_only.rs, the same rule). */
function e0103AsTypescript(v: unknown): { value: unknown; changed: boolean } {
  return mapDiagnostics(v, (d) => {
    if (d["code"] !== "MDT-E0103") return d;
    const out: Record<string, unknown> = { ...d, message: (d["message"] as string).replaceAll(` or "${V06}"`, "").replaceAll(` or '${V06}'`, "") };
    if (obj(out["facts"]) && Array.isArray(out["facts"]["expected"])) out["facts"] = { ...out["facts"], expected: out["facts"]["expected"].filter((e) => e !== V06) };
    return out;
  });
}

/** Whether `v` holds a value of `f`, anywhere within a few levels. */
function holds(v: unknown, f: (x: unknown) => boolean, depth = 0): boolean {
  if (f(v)) return true;
  if (depth > 16) return false;
  if (Array.isArray(v)) return v.some((x) => holds(x, f, depth + 1));
  if (obj(v)) return Object.values(v).some((x) => holds(x, f, depth + 1));
  return false;
}

/** Whether a result holds a diagnostic of `code`. */
const holdsCode = (v: unknown, code: string): boolean => holds(v, (x) => obj(x) && x["code"] === code);

/** The operations of a call of a patching function, and the arguments with other operations in their place. */
function opsOf(fn: DoorBacked, args: unknown[]): unknown[] {
  const ops = fn === "checkSubprogram" ? (obj(args[0]) ? args[0]["ops"] : undefined) : args[2];
  return Array.isArray(ops) ? ops : [];
}
function withOps(fn: DoorBacked, args: unknown[], ops: unknown[]): unknown[] {
  if (fn === "checkSubprogram") return [{ ...(args[0] as Record<string, unknown>), ops }, ...args.slice(1)];
  return [args[0], args[1], ops, ...args.slice(3)];
}

/** The deepest nesting of brackets in a text, or of arrays and objects in a value, in `args`. */
function nesting(v: unknown, textOnly = false): number {
  let most = 0;
  const stack: Array<[unknown, number]> = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (typeof x === "string") {
      let depth = 0;
      for (const c of x) {
        if (c === "(" || c === "[" || c === "{") most = Math.max(most, ++depth);
        else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      }
    } else if (Array.isArray(x)) {
      if (!textOnly) most = Math.max(most, d);
      if (d < 4096) for (const y of x) stack.push([y, d + 1]);
    } else if (obj(x)) {
      if (!textOnly) most = Math.max(most, d);
      if (d < 4096) for (const y of Object.values(x)) stack.push([y, d + 1]);
    }
  }
  return most;
}

/** Whether `args` name a type `name`: in a text's `type name`, a JSON text's or an IR's definitions, or a patch's add of one. */
function namesType(args: unknown[], name: string): boolean {
  const defines = (p: unknown): boolean => obj(p) && obj(p["defs"]) && obj(p["defs"][name]) && p["defs"][name]["kind"] === "type";
  return holds(args, (x) => {
    if (typeof x === "string") {
      if (new RegExp(`\\btype\\s+${name}\\b`).test(x)) return true;
      if (!x.trimStart().startsWith("{")) return false;
      try {
        return defines(JSON.parse(x));
      } catch {
        return false;
      }
    }
    return defines(x) || (obj(x) && x["op"] === "add" && x["path"] === `/defs/${name}` && obj(x["value"]) && x["value"]["kind"] === "type");
  });
}

const threw = (o: Outcome): o is { threw: unknown } => "threw" in o;
const astral = /[\u{10000}-\u{10FFFF}]/u;
const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);
/** What the Rust says of a patch operation whose path is not a string (crates/mandate-views/tests/vectors.rs). */
const NOT_A_POINTER = "path must be a JSON Pointer starting with '/'";

export const EXEMPTIONS: readonly Exemption[] = [
  {
    name: "versions-only-rust-reads",
    readme: "The versions only the Rust compiler reads: E0103's message and its facts.expected list mandate/0.6, which the Rust reads and the TypeScript does not",
    functions: DIAGNOSING,
    normalize: (ts, rust) => {
      const r = e0103AsTypescript(rust);
      return { ts, rust: r.value, changed: r.changed };
    },
  },
  {
    name: "lone-surrogate-in-a-message",
    readme: "A lone UTF-16 surrogate: where the TypeScript's message quotes half of a surrogate pair, the Rust holds U+FFFD. Only a diagnostic's message is read so.",
    functions: DIAGNOSING,
    normalize: (ts, rust) => {
      const t = mapDiagnostics(ts, (d) => ({ ...d, message: toWellFormed(d["message"] as string) }));
      return { ts: t.value, rust, changed: t.changed };
    },
  },
  {
    name: "rendering-lone-surrogate",
    readme: "A lone UTF-16 surrogate in a document: toMarkdown and toHtml are given it as U+FFFD by the bridge, which a request cannot carry otherwise; the TypeScript writes it through. Only for a document that holds one.",
    functions: ["toMarkdown", "toHtml"],
    normalize: (ts, rust, args) => {
      if (typeof ts !== "string" || !holds(args, (x) => typeof x === "string" && toWellFormed(x) !== x)) return { ts, rust, changed: false };
      const t = toWellFormed(ts);
      return { ts: t, rust, changed: t !== ts };
    },
  },
  {
    name: "patch-proto-token",
    readme: "KNOWN_PATCH_DIFFERENCES: an add whose path ends in __proto__, which in JavaScript sets the prototype of a plain object and in Rust adds no member, so that the Rust gives what the TypeScript gives for the patch without those adds",
    functions: PATCHING,
    covers: (fn, args, _ts, rust, again) => {
      const ops = opsOf(fn, args);
      const proto = (op: unknown): boolean => obj(op) && op["op"] === "add" && typeof op["path"] === "string" && op["path"].split("/").pop() === "__proto__";
      if (!again || !ops.some(proto)) return false;
      return !disagreement(again(withOps(fn, args, ops.filter((op) => !proto(op)))), rust);
    },
  },
  {
    name: "patch-path-not-text",
    readme: "KNOWN_PATCH_DIFFERENCES: an operation whose path is not a string: the TypeScript throws a TypeError, whose message its E0131 holds, and puts the value itself in at.path; the Rust's E0131 says the path is not a JSON Pointer and holds the value as a template's text",
    functions: PATCHING,
    normalize: (ts, rust, args, fn) => {
      const ops = opsOf(fn, args);
      const t = mapDiagnostics(ts, (d) => {
        const i = obj(d["facts"]) ? d["facts"]["index"] : undefined;
        const op = typeof i === "number" ? ops[i] : undefined;
        if (d["code"] !== "MDT-E0131" || !obj(op) || typeof op["path"] === "string") return d;
        const message = d["message"] as string;
        const cut = message.indexOf(" failed: ");
        return { ...d, message: `${cut < 0 ? message : message.slice(0, cut)} failed: ${NOT_A_POINTER}`, at: { path: `${op["path"] as string}` } };
      });
      return { ts: t.value, rust, changed: t.changed };
    },
  },
  {
    name: "type-named-like-a-prototype-member",
    readme: "THROWS_IN_TYPESCRIPT: a type named like a member of Object.prototype (toString) where another is expected: the TypeScript throws a TypeError, and the Rust gives the E0201 that names it, and no other error",
    functions: CHECKING,
    covers: (_fn, args, ts, rust) => {
      if (!threw(ts) || !(ts.threw instanceof TypeError) || threw(rust)) return false;
      const ds = obj(rust.value) && Array.isArray(rust.value["diagnostics"]) ? (rust.value["diagnostics"] as unknown[]) : [];
      const errors = ds.filter((d) => obj(d) && d["severity"] === "error") as Array<Record<string, unknown>>;
      if (!errors.length || errors.some((d) => d["code"] !== "MDT-E0201")) return false;
      return errors.some((d) => {
        const named = [...String(d["message"]).matchAll(/\b(?:got|Expected) (\w+)/g)].map((m) => m[1]!).filter((n) => PROTOTYPE_NAMES.includes(n));
        return named.some((n) => namesType(args, n));
      });
    },
  },
  {
    name: "deepest-programs",
    readme: "The deepest programs: a program as deep as one that loads can be (an IR some 64 deep), or a text whose calls and records nest far past 64, on which Node's default stack is too small for the TypeScript (it throws RangeError); the Rust checks the first and gives E0105 for the second",
    functions: Object.keys(DOOR_BACKED) as DoorBacked[],
    covers: (_fn, args, ts, rust) => {
      if (!threw(ts) || !(ts.threw instanceof RangeError) || !/call stack/i.test(ts.threw.message) || threw(rust)) return false;
      if (nesting(args) < 60) return false;
      return nesting(args, true) <= 64 || holdsCode(rust.value, "MDT-E0105");
    },
  },
  {
    name: "packaged-lock-astral-string",
    readme: "KNOWN_DIFFERENCES (json_doors.rs): packaged_lock of a lock that is a string with a character outside the Basic Multilingual Plane, spread by code unit in the TypeScript and by code point in the Rust, and so the package hash",
    functions: ["packagedLock", "packageHash"],
    covers: (fn, args) => {
      const lock = fn === "packagedLock" ? args[0] : args[1];
      return typeof lock === "string" && astral.test(lock);
    },
  },
  {
    name: "timeout-not-a-number",
    readme: "KNOWN_DIFFERENCES (json_doors.rs): sandbox_requirements of an agent whose budget.time.ms is not a number (the TypeScript writes the value, the Rust null), and requirement_for with timeoutMs a string (the TypeScript writes it, the Rust's door refuses it); acsTarget carries each agent's requirement",
    functions: ["sandboxRequirements", "requirementFor", "acsTarget"],
    covers: (fn, args) => (fn === "requirementFor" ? typeof args[2] === "string" : holds(args[0], (x) => obj(x) && obj(x["time"]) && "ms" in x["time"] && typeof x["time"]["ms"] !== "number")),
  },
];

const counts: Record<string, number> = Object.fromEntries([...EXEMPTIONS.map((e) => e.name), "language-0.6", "compared"].map((n) => [n, 0]));

/** How many calls each exemption excused, how many calls of language 0.6 skipped the TypeScript, how many were compared. */
export function exemptionCounts(): Record<string, number> {
  return { ...counts };
}

/** Adds a worker's counts (mode.ts). */
export function addCounts(more: Record<string, number>): void {
  for (const [k, n] of Object.entries(more)) if (Number.isSafeInteger(n)) counts[k] = (counts[k] ?? 0) + n;
}

/** The counts since they were last taken, taken: what a worker sends the thread that started it. */
export function takeCounts(): Record<string, number> {
  const out = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
  for (const k of Object.keys(counts)) counts[k] = 0;
  return out;
}

/** Counts one use of a rule outside a call of the facade: the test of the constants (`tables`). */
export function countRule(name: string): void {
  counts[name] = (counts[name] ?? 0) + 1;
}

/** Text of a value for a divergence: as the door contract writes it, short. */
function shown(o: Outcome): string {
  if (threw(o)) return `throws ${o.threw instanceof Error ? `${o.threw.name}: ${o.threw.message}` : String(o.threw)}`;
  try {
    const t = JSON.stringify(o.value, (_k, x: unknown) => (x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x)) ?? "undefined";
    return t.length > 4000 ? `${t.slice(0, 4000)}… (${t.length} characters)` : t;
  } catch (e) {
    return `(cannot be shown: ${String(e)})`;
  }
}

/** Where two outcomes differ, or undefined when they agree. */
function disagreement(ts: Outcome, rust: Outcome): string | undefined {
  if (threw(ts) && threw(rust)) {
    const a = ts.threw;
    const b = rust.threw;
    // An Error of the TypeScript's own making says why; the Rust says the same where a caller reads it.
    if (a instanceof Error && a.constructor === Error && b instanceof Error && a.message !== b.message) return `both throw, with other messages`;
    return undefined;
  }
  if (threw(ts)) return "the TypeScript throws and the Rust answers";
  if (threw(rust)) return "the Rust refuses and the TypeScript answers";
  return difference(ts.value, rust.value);
}

/**
 * Compares the two outcomes of a call of `fn` with `args`: returns when they agree or a rule excuses them, and
 * throws (and keeps) a CompilerDivergence when not. `again` asks the TypeScript on other arguments, for the rule
 * that compares the Rust with what the TypeScript gives for the input as the Rust reads it.
 */
export function compareOutcomes(fn: DoorBacked | "CODES", args: unknown[], ts: Outcome, rust: Outcome, again?: Again): void {
  counts["compared"]!++;
  let a = ts;
  let b = rust;
  let first = disagreement(a, b);
  if (!first) return;
  const rules = fn === "CODES" ? [] : EXEMPTIONS.filter((e) => e.functions.includes(fn));
  for (const rule of rules) {
    if (rule.covers?.(fn as DoorBacked, args, ts, rust, again)) {
      counts[rule.name]!++;
      return;
    }
  }
  // Normalizing rules apply one after another, each to what the others left; each that changed something and left
  // the two agreeing counts.
  const used: string[] = [];
  for (const rule of rules) {
    if (!rule.normalize || threw(a) || threw(b)) continue;
    const n = rule.normalize(a.value, b.value, args, fn as DoorBacked);
    if (n.changed) {
      used.push(rule.name);
      a = { value: n.ts };
      b = { value: n.rust };
    }
  }
  if (used.length && !disagreement(a, b)) {
    for (const u of used) counts[u]!++;
    return;
  }
  first = disagreement(a, b) ?? first;
  const d = new CompilerDivergence(fn, first, shown(ts), shown(rust));
  keep(d);
  throw d;
}

/** Counts a call the TypeScript was not asked, its input being of 0.6. */
export function countLanguage06(): void {
  counts["language-0.6"]!++;
}
