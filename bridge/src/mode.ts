// Which compiler answers: `MANDATE_COMPILER=ts|rust|both`, read once, when the bridge is loaded. `ts` (the default
// until the next slice) is the reference compiler and nothing else: the facade exports its very functions and no
// call reaches the module. `rust` is the Rust compiler's module (rust.ts). `both` asks the two on every call and
// compares them (compare.ts), and gives the Rust's result.
//
// This is also the bridge's second entry point, `@mandate/bridge/mode`, for what is not a compiler's: the mode and a
// way for a test to run a block under another (or under another module), the hand-over of the compiled module to a
// worker thread, which compiler answers (`compilerIdentity`, for a run to record), the errors a caller tells apart
// (CompilerFailure, CompilerDivergence), and the counts of `both`.

import { CODES as TS_CODES } from "@mandate/compiler";
import { compareOutcomes, countLanguage06, keepDivergence, CompilerDivergence, LANGUAGE_06, type Outcome } from "./compare.js";
import { DOOR_BACKED, type DoorBacked } from "./doors.js";
import * as rust from "./rust.js";
import * as ts from "./ts.js";
import { currentModule, place, placed, rustCall } from "./wasm/call.js";
import { CompilerFailure } from "./wasm/errors.js";
import { markChecked } from "./wasm/host.js";
import { compileModuleBytes, moduleIdentity, recordIdentity, type ModuleIdentity } from "./wasm/module.js";

export type { ModuleIdentity } from "./wasm/module.js";

export { addCounts, CompilerDivergence, exemptionCounts, EXEMPTIONS, keepDivergence, takeCounts, takeDivergences } from "./compare.js";
export { CompilerFailure, FAILURE_KINDS, type FailureKind } from "./wasm/errors.js";

export const MODES = ["ts", "rust", "both"] as const;
export type CompilerMode = (typeof MODES)[number];

/** The mode MANDATE_COMPILER names; unset or empty is `ts`, and any other value is refused rather than guessed at. */
function fromEnvironment(): CompilerMode {
  const v = process.env["MANDATE_COMPILER"];
  if (v === undefined || v === "") return "ts";
  if ((MODES as readonly string[]).includes(v)) return v as CompilerMode;
  throw new Error(`MANDATE_COMPILER is ${JSON.stringify(v)}: it is ts, rust or both`);
}

let mode: CompilerMode = fromEnvironment();
const listeners: Array<(m: CompilerMode) => void> = [];

/** The mode calls are answered in now. */
export function compilerMode(): CompilerMode {
  return mode;
}

/** The mode the process was started in (MANDATE_COMPILER), whatever a block runs under. */
export const PROCESS_MODE: CompilerMode = mode;

/** For index.ts: `f` is told the mode now and each time it changes, to bind the facade's exports to it. */
export function onCompilerMode(f: (m: CompilerMode) => void): void {
  listeners.push(f);
  f(mode);
}

function setMode(m: CompilerMode): void {
  mode = m;
  for (const f of listeners) f(m);
}

/** A module for a block: compiled already, or its bytes. */
export type ModuleLike = WebAssembly.Module | Uint8Array;

const compiled = (m: ModuleLike): WebAssembly.Module => (m instanceof WebAssembly.Module ? m : compileModuleBytes(m));

/** What a block may run under besides a mode: another module, or another module for some doors (to make one fail). */
export interface CompilerBlock {
  module?: ModuleLike;
  doors?: Record<string, ModuleLike>;
}

/**
 * Runs `fn` with the facade answering in `m` (and on `o.module`, or `o.doors`, when given), then puts everything
 * back, also when `fn` throws; a promise is waited for. Code that took a function of the facade before the block
 * (a variable holding `check`) keeps the one it took: the exports themselves change. Not for blocks that run at the
 * same time as each other.
 */
export function withCompiler<T>(m: CompilerMode, fn: () => T, o: CompilerBlock = {}): T {
  if (!(MODES as readonly string[]).includes(m)) throw new Error(`no compiler mode ${String(m)}: it is ts, rust or both`);
  const beforeMode = mode;
  const beforePlace = o.module || o.doors ? place({ ...(o.module ? { module: compiled(o.module) } : {}), ...(o.doors ? { doors: Object.fromEntries(Object.entries(o.doors).map(([d, x]) => [d, compiled(x)])) } : {}) }) : undefined;
  setMode(m);
  const restore = (): void => {
    setMode(beforeMode);
    if (beforePlace) place(beforePlace);
  };
  let r: T;
  try {
    r = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (r instanceof Promise) return r.finally(restore) as T;
  restore();
  return r;
}

// ── a worker thread ─────────────────────────────────────────────────────

/**
 * What a thread hands a worker it starts, through `workerData`, so that the worker answers as it does: the mode, the
 * module (and any placed on doors of their own), and which module it is.
 *
 * What a worker finds in `both` (a divergence, the counts) reaches the thread that started it only with the
 * worker's answer (runtime/src/plan-worker.ts). A worker stopped at its time limit, or ended by its memory limit,
 * sends no answer, so what it found in that check is lost: `both` does not see into a check that did not end.
 */
export interface WorkerCompiler {
  mode: CompilerMode;
  module?: WebAssembly.Module;
  identity?: ModuleIdentity;
  doors?: Record<string, WebAssembly.Module>;
}

/**
 * What to hand a worker thread now: the mode, and in `rust` and `both` the compiled module (a WebAssembly.Module
 * is cloned into the worker; it is not read or compiled again). Throws the CompilerFailure of a module that is
 * missing or refused.
 */
export function compilerForWorker(): WorkerCompiler {
  if (mode === "ts") return { mode };
  const { doors } = placed();
  const module = currentModule();
  const identity = moduleIdentity(module);
  return { mode, module, ...(identity ? { identity } : {}), ...(doors ? { doors } : {}) };
}

/**
 * In a worker: answers as the thread that started it said (`compilerForWorker`), when it said anything. The modules
 * it was handed are taken as checked: the thread that handed them read their bytes (wasm/module.ts).
 */
export function adoptCompiler(c: WorkerCompiler | undefined): void {
  if (!c || !(MODES as readonly string[]).includes(c.mode)) return;
  if (c.module) {
    markChecked(c.module);
    if (c.identity) recordIdentity(c.module, c.identity);
    for (const m of Object.values(c.doors ?? {})) markChecked(m);
    place({ module: c.module, ...(c.doors ? { doors: c.doors } : {}) });
  }
  setMode(c.mode);
}

/**
 * Which compiler answers now: the mode, and outside `ts` the module, by the SHA-256 and the length of its bytes and
 * where it came from (the bridge's own place, MANDATE_WASM, or bytes a test gave), for a run to record. Throws the
 * CompilerFailure of a module that is missing or refused.
 */
export function compilerIdentity(): { mode: CompilerMode; module?: ModuleIdentity } {
  if (mode === "ts") return { mode };
  const identity = moduleIdentity(currentModule());
  return { mode, ...(identity ? { module: identity } : {}) };
}

// ── the functions of the facade in `rust` and `both` ────────────────────

type Fn = (...args: unknown[]) => unknown;

/** The function of the facade for `name` outside `ts` mode: the Rust's, or both compared. */
function dispatcher(name: DoorBacked): Fn {
  const t = (ts as unknown as Record<string, Fn>)[name]!;
  const r = (rust as unknown as Record<string, Fn>)[name]!;
  const f = (...args: unknown[]): unknown => {
    if (mode === "ts") return t(...args);
    if (mode === "rust") return r(...args);
    if (LANGUAGE_06[name](args)) {
      countLanguage06();
      return r(...args);
    }
    // The Rust first: its request is written from the arguments before the TypeScript could change them.
    let theirs: Outcome;
    try {
      theirs = { value: r(...args) };
    } catch (e) {
      if (e instanceof CompilerFailure || e instanceof CompilerDivergence) throw e;
      theirs = { threw: e };
    }
    const asked = (a: unknown[]): Outcome => {
      try {
        return { value: t(...a) };
      } catch (e) {
        return { threw: e };
      }
    };
    // A rule may ask the TypeScript again, on the input as the README entry it stands on says the Rust reads it.
    compareOutcomes(name, args, asked(args), theirs, asked);
    if ("threw" in theirs) throw theirs.threw;
    return theirs.value;
  };
  Object.defineProperty(f, "name", { value: name });
  return f;
}

/** Every door-backed function as the facade gives it outside `ts` mode. */
export const facade = Object.fromEntries(Object.keys(DOOR_BACKED).map((n) => [n, dispatcher(n as DoorBacked)])) as unknown as typeof ts;

/**
 * CODES outside `ts` mode: the Rust's table of codes (the door `codes`), which explains every code the Rust gives,
 * those it has from language 0.6 on included; read when it is first looked into. In `both`, its rows that the
 * TypeScript's table has are held to them, and a row only the Rust has is of 0.6.
 */
export function rustCodes(): typeof TS_CODES {
  let table: Record<string, unknown> | undefined;
  const rows = (): Record<string, unknown> => {
    if (table) return table;
    const got = rustCall("codes", {}) as Record<string, unknown>;
    if (mode === "both") {
      const shared = Object.fromEntries(Object.keys(got).filter((k) => Object.hasOwn(TS_CODES, k)).map((k) => [k, got[k]]));
      compareOutcomes("CODES", [], { value: { ...TS_CODES } }, { value: shared });
      if (Object.keys(got).length > Object.keys(shared).length) countLanguage06();
    }
    return (table = got);
  };
  return new Proxy({} as typeof TS_CODES, {
    get: (_t, k) => (typeof k === "string" && Object.hasOwn(rows(), k) ? rows()[k] : undefined),
    has: (_t, k) => typeof k === "string" && Object.hasOwn(rows(), k),
    ownKeys: () => Reflect.ownKeys(rows()),
    getOwnPropertyDescriptor: (_t, k) => {
      const d = Reflect.getOwnPropertyDescriptor(rows(), k);
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}
