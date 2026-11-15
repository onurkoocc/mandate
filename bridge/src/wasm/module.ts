// Where the bridge finds the Rust compiler's module, and the one compiled copy of it a process keeps.
//
// The module is in the bridge's own package, and nowhere else the bridge would look: `wasm/mandate-wasm.wasm` beside
// its `src/` and `dist/`, found from this file's own address, with `wasm/mandate-wasm.digest.json` beside it, its
// SHA-256 and its length, which `npm run build:wasm` (scripts/build-wasm.mjs) writes when it builds the module and
// copies it there. Neither is committed. The bridge reads the digest before it compiles the module, and refuses a
// module whose bytes are not the ones it names, or that has none (`module_invalid`). Nothing is searched for: not
// the directories above, not the working directory, not a relative path, so that a project the bridge is installed
// in, or a checkout it runs in, cannot choose the compiler that checks it.
//
// The one other place is `MANDATE_WASM`, the operator's own choice of a module, by an absolute path only (a relative
// one is refused, `module_invalid`). No digest is known for it: it is the operator's.
//
// A module is read and compiled once, when the first call needs it, and checked then (host.ts, `validateBytes` and
// `validateModule`); a worker thread is handed the compiled module instead of reading the file again. Which module
// answers, its SHA-256 and where it came from, is `moduleIdentity` (mode.ts, `compilerIdentity`).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompilerFailure } from "./errors.js";
import { markChecked, validateBytes, validateModule } from "./host.js";

/** The bridge's own place for the module: `<bridge>/wasm/`, from `<bridge>/src/wasm/` or `<bridge>/dist/wasm/`. */
export const MODULE_DIR = fileURLToPath(new URL("../../wasm/", import.meta.url));
export const MODULE_FILE = join(MODULE_DIR, "mandate-wasm.wasm");
export const DIGEST_FILE = join(MODULE_DIR, "mandate-wasm.digest.json");
export const DIGEST_FORMAT = "mandate/wasm-digest/0.1";

/** How to build the module, as a failure that finds none says. */
export const BUILD_HINT = "build it with `npm run build:wasm`, which builds the Rust compiler's module and puts it, with its digest, in the bridge's wasm/, or name a built module by an absolute path with MANDATE_WASM; MANDATE_COMPILER=ts runs the reference compiler, which needs no module";

/** Where a module came from: the bridge's own place, the operator's MANDATE_WASM, or bytes a caller gave. */
export type ModuleSource = "bridge" | "MANDATE_WASM" | "given";

/** Which module answers: the SHA-256 and the length of its bytes, and where it came from. */
export interface ModuleIdentity {
  sha256: string;
  bytes: number;
  from: ModuleSource;
}

/** Where the module is read from: MANDATE_WASM when it names one (an absolute path), else the bridge's own place. */
export function modulePlace(): { path: string; from: "bridge" | "MANDATE_WASM" } {
  const named = process.env["MANDATE_WASM"];
  if (named) {
    if (!isAbsolute(named)) throw new CompilerFailure("module_invalid", undefined, `MANDATE_WASM is ${JSON.stringify(named)}, a relative path: it names a module by an absolute path only`);
    return { path: named, from: "MANDATE_WASM" };
  }
  return { path: MODULE_FILE, from: "bridge" };
}

/** The file the module is read from. */
export function modulePath(): string {
  return modulePlace().path;
}

const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** The digest `build:wasm` wrote beside the module in the bridge's own place, or why there is none to trust. */
function recordedDigest(): { sha256: string; bytes: number } | string {
  if (!existsSync(DIGEST_FILE)) return "there is no digest beside it";
  try {
    const d = JSON.parse(readFileSync(DIGEST_FILE, "utf8")) as { format?: unknown; sha256?: unknown; bytes?: unknown };
    if (d.format !== DIGEST_FORMAT || typeof d.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(d.sha256) || !Number.isSafeInteger(d.bytes)) return `its digest is not of the format ${DIGEST_FORMAT}`;
    return { sha256: d.sha256, bytes: d.bytes as number };
  } catch {
    return "its digest cannot be read";
  }
}

const identities = new WeakMap<WebAssembly.Module, ModuleIdentity>();

/** Which module `module` is, when the bridge compiled it or was told (a worker's). */
export function moduleIdentity(module: WebAssembly.Module): ModuleIdentity | undefined {
  return identities.get(module);
}

/** Records which module a worker was handed (mode.ts). */
export function recordIdentity(module: WebAssembly.Module, identity: ModuleIdentity): void {
  identities.set(module, identity);
}

/** Reads and compiles the module at `place`, checks it is one the host runs, and, from the bridge's own place, that its bytes are the ones its digest names. */
export function compileModuleAt(place: { path: string; from: "bridge" | "MANDATE_WASM" }): WebAssembly.Module {
  const { path, from } = place;
  if (!existsSync(path)) throw new CompilerFailure("module_missing", undefined, `there is no module at ${path}: ${BUILD_HINT}`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new CompilerFailure("module_missing", undefined, `the module at ${path} cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"}): ${BUILD_HINT}`);
  }
  const digest = sha256(bytes);
  if (from === "bridge") {
    const recorded = recordedDigest();
    if (typeof recorded === "string") throw new CompilerFailure("module_invalid", undefined, `the module at ${path} is not taken: ${recorded}; ${BUILD_HINT}`);
    if (recorded.sha256 !== digest || recorded.bytes !== bytes.length) throw new CompilerFailure("module_invalid", undefined, `the module at ${path} is not the one its digest names (${recorded.sha256}, ${recorded.bytes} bytes; it is ${digest}, ${bytes.length} bytes); ${BUILD_HINT}`);
  }
  return compileModuleBytes(bytes, path, from, digest);
}

/** Reads and compiles the module at `path` (an absolute path the operator named, or the bridge's own place). */
export function compileModuleFile(path: string): WebAssembly.Module {
  return compileModuleAt({ path, from: path === MODULE_FILE ? "bridge" : "MANDATE_WASM" });
}

/** Compiles the bytes of a module, after checking from them that it is one the host runs. */
export function compileModuleBytes(bytes: Uint8Array, label = "the bytes given", from: ModuleSource = "given", digest = sha256(bytes)): WebAssembly.Module {
  validateBytes(bytes);
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
  } catch (e) {
    throw new CompilerFailure("module_invalid", undefined, `${label} is not a WebAssembly module V8 compiles (${e instanceof Error ? e.message : String(e)})`);
  }
  validateModule(module);
  markChecked(module);
  identities.set(module, { sha256: digest, bytes: bytes.length, from });
  return module;
}

let cached: { key: string; module: WebAssembly.Module } | undefined;

/** The process's compiled module, read the first time it is asked for (and again only when MANDATE_WASM changed). */
export function processModule(): WebAssembly.Module {
  const place = modulePlace();
  const key = `${place.from}:${place.path}`;
  if (cached?.key !== key) cached = { key, module: compileModuleAt(place) };
  return cached.module;
}
