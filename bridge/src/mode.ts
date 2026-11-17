// The bridge's second entry point, `@mandate/bridge/mode`: what is about the compiler behind the bridge rather than a
// function of it. There is one compiler behind the bridge: the Rust compiler's WebAssembly module (rust.ts). A
// process without the module fails by name (`CompilerFailure`, `module_missing`); it never falls back to another
// compiler.
//
// This entry gives the errors a caller tells apart (CompilerFailure and its kinds), a way for a test to run a block
// on another module, or on another module for some doors (`withCompiler`), the hand-over of the compiled module to a
// worker thread (`compilerForWorker`, `adoptCompiler`), and which module answers (`compilerIdentity`, for a run to
// record).

import { currentModule, place, placed } from "./wasm/call.js";
import { markChecked } from "./wasm/host.js";
import { compileModuleBytes, moduleIdentity, recordIdentity, type ModuleIdentity } from "./wasm/module.js";

export type { ModuleIdentity } from "./wasm/module.js";

export { CompilerFailure, FAILURE_KINDS, type FailureKind } from "./wasm/errors.js";

/** A module for a block: compiled already, or its bytes. */
export type ModuleLike = WebAssembly.Module | Uint8Array;

const compiled = (m: ModuleLike): WebAssembly.Module => (m instanceof WebAssembly.Module ? m : compileModuleBytes(m));

/** What a block may run on besides the process's module: another module, or another module for some doors (to make one fail). */
export interface CompilerBlock {
  module?: ModuleLike;
  doors?: Record<string, ModuleLike>;
}

/**
 * Runs `fn` with the facade answering on `o.module`, and on `o.doors` for the doors it names, when given, then puts
 * everything back, also when `fn` throws; a promise is waited for. Not for blocks that run at the same time as each
 * other.
 */
export function withCompiler<T>(fn: () => T, o: CompilerBlock = {}): T {
  const before = o.module || o.doors ? place({ ...(o.module ? { module: compiled(o.module) } : {}), ...(o.doors ? { doors: Object.fromEntries(Object.entries(o.doors).map(([d, x]) => [d, compiled(x)])) } : {}) }) : undefined;
  const restore = (): void => {
    if (before) place(before);
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
 * What a thread hands a worker it starts, through `workerData`, so that the worker answers as it does: the module
 * (and any placed on doors of their own), and which module it is.
 */
export interface WorkerCompiler {
  module?: WebAssembly.Module;
  identity?: ModuleIdentity;
  doors?: Record<string, WebAssembly.Module>;
}

/**
 * What to hand a worker thread now: the compiled module (a WebAssembly.Module is cloned into the worker; it is not
 * read or compiled again). Throws the CompilerFailure of a module that is missing or refused.
 */
export function compilerForWorker(): WorkerCompiler {
  const { doors } = placed();
  const module = currentModule();
  const identity = moduleIdentity(module);
  return { module, ...(identity ? { identity } : {}), ...(doors ? { doors } : {}) };
}

/**
 * In a worker: answers on the module the thread that started it handed over (`compilerForWorker`), when it handed
 * any. The modules it was handed are taken as checked: the thread that handed them read their bytes (wasm/module.ts).
 */
export function adoptCompiler(c: WorkerCompiler | undefined): void {
  if (!c?.module) return;
  markChecked(c.module);
  if (c.identity) recordIdentity(c.module, c.identity);
  for (const m of Object.values(c.doors ?? {})) markChecked(m);
  place({ module: c.module, ...(c.doors ? { doors: c.doors } : {}) });
}

/**
 * Which compiler answers now: the Rust compiler's module, by the SHA-256 and the length of its bytes and where it
 * came from (the bridge's own place, MANDATE_WASM, or bytes a test gave), for a run to record. Throws the
 * CompilerFailure of a module that is missing or refused.
 */
export function compilerIdentity(): { mode: "rust"; module?: ModuleIdentity } {
  const identity = moduleIdentity(currentModule());
  return { mode: "rust", ...(identity ? { module: identity } : {}) };
}
