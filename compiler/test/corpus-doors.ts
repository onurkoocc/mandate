// The front doors of the compiler as the compiled corpus records them (vectors/README.md, "corpus/"): for each, how
// a call's arguments become the stored `input` and how its return value becomes the stored `result`. Nothing here
// imports the compiler, so the recording layer (corpus-record.ts) can wrap the compiler's modules with it.

import { createHash } from "node:crypto";

/** The doors, by the name an entry carries, with the module that exports the function and its name there. */
export const DOORS = {
  load: { module: "check", fn: "load" },
  check: { module: "check", fn: "check" },
  load_modules: { module: "check", fn: "loadModules" },
  check_patch: { module: "check", fn: "checkPatch" },
  check_subprogram: { module: "check", fn: "checkSubprogram" },
  check_amendment: { module: "check", fn: "checkAmendment" },
  apply_patch: { module: "patch", fn: "applyPatch" },
  validate_lock: { module: "lock", fn: "validateLock" },
  acs_target: { module: "acs", fn: "acsTarget" },
  denial_diagnostics: { module: "sandbox", fn: "denialDiagnostics" },
} as const;

export type Door = keyof typeof DOORS;
export type DoorModule = (typeof DOORS)[Door]["module"];

/** The doors of one module, by the function's name. */
export function doorsOf(module: DoorModule): Array<[fn: string, door: Door]> {
  return (Object.entries(DOORS) as Array<[Door, (typeof DOORS)[Door]]>).filter(([, d]) => d.module === module).map(([door, d]) => [d.fn, door]);
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The key of a value in the table of shared values: the first 16 hex digits of the SHA-256 of its compact JSON text. */
export const valueKey = (text: string): string => sha256(text).slice(0, 16);

/** `sha256:<hex>` of a value's compact JSON text in member order, as `JSON.stringify` writes it. */
export const digestOf = (value: unknown): string => `sha256:${sha256(JSON.stringify(value))}`;

/** Code-unit order, the order every sorted list of the corpus is in. */
export const utf16 = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A span table (`Map<pointer, span>`) as `[[pointer, span], …]`, by pointer. */
export const spanList = (spans: Map<string, unknown>): Array<[string, unknown]> => [...spans].sort(([a], [b]) => utf16(a, b));

/** A value as plain JSON: what `JSON.stringify` keeps of it, in its member order. */
export const plain = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Thrown by an input serializer for an argument the corpus cannot carry; the call is then not recorded. */
export class Unrecordable extends Error {}

/** Puts a value in the table of shared values and gives its key. */
export type Share = (value: unknown) => string;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function only(o: Obj, keys: string[], what: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Unrecordable(`${what} has member ${k}`);
}

/** Loaded modules (`Record<name, Program>`) as `{ name: key }`, in their order. */
function modulesIn(m: unknown, share: Share): Obj {
  if (!isObj(m)) throw new Unrecordable("modules is not an object");
  return Object.fromEntries(Object.entries(m).map(([name, p]) => [name, share(p)]));
}

const optional = (o: Obj, key: string, f: (v: unknown) => unknown): Obj => (o[key] === undefined ? {} : { [key]: f(o[key]) });

/**
 * The stored input of a call: every argument, by name, with programs and modules as keys of the table of shared
 * values. An argument left out or `undefined` is left out; the door then takes its default.
 */
export function inputOf(door: Door, args: unknown[], share: Share): Obj {
  const arg = (i: number): unknown => args[i];
  const program = (v: unknown): string => {
    if (!isObj(v)) throw new Unrecordable("program is not an object");
    return share(v);
  };
  switch (door) {
    case "load":
      if (typeof arg(0) !== "string") throw new Unrecordable("text is not a string");
      return { source: arg(0), kind: arg(1) };
    case "check": {
      if (typeof arg(0) !== "string") throw new Unrecordable("text is not a string");
      const opts = (arg(2) ?? {}) as Obj;
      if (!isObj(opts)) throw new Unrecordable("options are not an object");
      only(opts, ["modules", "lock", "claim"], "options");
      return { source: arg(0), kind: arg(1), ...optional(opts, "modules", (m) => modulesIn(m, share)), ...optional(opts, "lock", share), ...optional(opts, "claim", plain) };
    }
    case "load_modules": {
      const sources = arg(0);
      if (!Array.isArray(sources)) throw new Unrecordable("sources is not an array");
      return {
        sources: sources.map((s: Obj) => {
          only(s, ["file", "text", "kind"], "a module source");
          return { file: s["file"], kind: s["kind"], text: s["text"] };
        }),
      };
    }
    case "check_patch":
    case "apply_patch":
      return { program: program(arg(0)), base: arg(1), ops: plain(arg(2)), ...(arg(3) === undefined ? {} : { modules: modulesIn(arg(3), share) }) };
    case "check_subprogram": {
      const i = arg(0) as Obj;
      if (!isObj(i)) throw new Unrecordable("the input is not an object");
      only(i, ["parent", "modules", "workflow", "number", "base", "ops", "lead", "room"], "the input");
      return { parent: program(i["parent"]), ...optional(i, "modules", (m) => modulesIn(m, share)), workflow: i["workflow"], number: i["number"], base: i["base"], ops: plain(i["ops"]), lead: i["lead"], room: plain(i["room"]) };
    }
    case "check_amendment": {
      const i = arg(0) as Obj;
      if (!isObj(i)) throw new Unrecordable("the input is not an object");
      only(i, ["parent", "modules", "workflow", "envelope"], "the input");
      return { parent: program(i["parent"]), ...optional(i, "modules", (m) => modulesIn(m, share)), workflow: i["workflow"], ...optional(i, "envelope", plain) };
    }
    case "validate_lock":
      return arg(0) === undefined ? {} : { value: plain(arg(0)) };
    case "acs_target":
      return { program: program(arg(0)), ...(arg(1) === undefined ? {} : { modules: modulesIn(arg(1), share) }), ...(arg(2) === undefined ? {} : { lock: share(arg(2)) }) };
    case "denial_diagnostics":
      return { program: program(arg(0)), report: plain(arg(1)) };
  }
}

/**
 * The stored result of a call: the return value in the compiler's member order, as plain JSON, except that a
 * program's IR (`program`, and each module `load_modules` returns) is its digest, and so is a span table
 * (`spans`, sorted by pointer).
 */
export function resultOf(door: Door, r: unknown): unknown {
  if (Array.isArray(r)) return plain(r);
  if (!isObj(r)) return plain(r);
  const out: Obj = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined) continue;
    if (v instanceof Map) out[k] = digestOf(spanList(v));
    else if (k === "program" && isObj(v)) out[k] = digestOf(v);
    else if (k === "modules" && door === "load_modules" && isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([name, p]) => [name, digestOf(p)]));
    else out[k] = plain(v);
  }
  return out;
}

/**
 * The test files whose calls the corpus leaves out: they write vectors of their own (vectors/README.md, sections
 * reader.json to diagnostics/), and what they call is in those files already.
 */
export const VECTOR_WRITERS = ["compiler/test/diagnostic-vectors.test.ts", "compiler/test/schema-vectors.test.ts", "compiler/test/vectors.test.ts"];

/** Whether a string has no lone surrogate. */
export function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/** A text longer than this is stored as pieces, when they are less than half as long. */
export const PARTS_FROM = 4096;
/** The shortest run that pieces stand for. */
const RUN_FROM = 64;

/**
 * A text as `[[piece, count], …]`: each piece repeated `count` times, all joined, give the text. At each place the
 * longest run of one unit is taken (a unit of 1 to 16 code units, or the line that starts there), when it is at
 * least 64 code units long; what lies between runs is a piece of count 1. No piece holds a lone surrogate (a run
 * that would split a pair is not taken).
 */
export function partsOf(s: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  let literal = 0;
  let i = 0;
  while (i < s.length) {
    let best: [unit: string, count: number] | undefined;
    const nl = s.indexOf("\n", i);
    const line = nl - i + 1;
    const periods = [...Array.from({ length: 16 }, (_, k) => k + 1), ...(nl >= 0 && line > 16 && line <= PARTS_FROM ? [line] : [])];
    for (const p of periods) {
      if (i + 2 * p > s.length) continue;
      const unit = s.slice(i, i + p);
      let k = 1;
      while (s.startsWith(unit, i + k * p)) k++;
      if (k >= 2 && k * p >= RUN_FROM && (!best || k * p > best[0].length * best[1]) && wellFormed(unit)) best = [unit, k];
    }
    if (best && wellFormed(s.slice(literal, i))) {
      if (i > literal) out.push([s.slice(literal, i), 1]);
      out.push(best);
      i += best[0].length * best[1];
      literal = i;
    } else i++;
  }
  if (s.length > literal) out.push([s.slice(literal), 1]);
  return out;
}
