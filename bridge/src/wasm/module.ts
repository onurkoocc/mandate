// Where the bridge finds the Rust compiler's module, and the one compiled copy of it a process keeps.
//
// The module is the file `MANDATE_WASM` names, or else target/wasm32-wasip1/release/mandate-wasm.wasm under the
// repository root: the first directory, from this file's own up, that holds Cargo.toml and crates/mandate-wasm (and,
// failing that, from the working directory up). It is built by `npm run build:wasm` and never committed. It is
// read and compiled once, when the first call needs it, and checked then (host.ts, `validateModule`); a worker
// thread is handed the compiled module instead of reading the file again.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CompilerFailure } from "./errors.js";
import { validateModule } from "./host.js";

/** The module's place under the repository root. */
export const MODULE_PATH = ["target", "wasm32-wasip1", "release", "mandate-wasm.wasm"] as const;

/** How to build the module, as a failure that finds none says. */
export const BUILD_HINT =
  "build it with `npm run build:wasm` (cargo rustc --locked -p mandate-wasm --release --target wasm32-wasip1 --bin mandate-wasm -- -C link-arg=--max-memory=268435456 -C link-arg=-zstack-size=4194304 -C link-arg=--stack-first), or name a built module with MANDATE_WASM";

/** The repository root at or above `dir`: the directory that holds Cargo.toml and crates/mandate-wasm. */
function rootAbove(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, "Cargo.toml")) && existsSync(join(d, "crates", "mandate-wasm"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/** The file the module is read from: MANDATE_WASM, or its place under the repository root. */
export function modulePath(): string {
  const named = process.env["MANDATE_WASM"];
  if (named) return resolve(named);
  const here = dirname(fileURLToPath(import.meta.url));
  const root = rootAbove(here) ?? rootAbove(process.cwd());
  return root ? join(root, ...MODULE_PATH) : join(...MODULE_PATH);
}

/** Reads and compiles the module at `path`, and checks it is one the host runs. */
export function compileModuleFile(path: string): WebAssembly.Module {
  if (!existsSync(path)) throw new CompilerFailure("module_missing", undefined, `there is no module at ${path}: ${BUILD_HINT}`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new CompilerFailure("module_missing", undefined, `the module at ${path} cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"}): ${BUILD_HINT}`);
  }
  return compileModuleBytes(bytes, path);
}

/** Compiles the bytes of a module and checks it is one the host runs. */
export function compileModuleBytes(bytes: Uint8Array, from = "the bytes given"): WebAssembly.Module {
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
  } catch (e) {
    throw new CompilerFailure("module_invalid", undefined, `${from} is not a WebAssembly module V8 compiles (${e instanceof Error ? e.message : String(e)})`);
  }
  validateModule(module);
  return module;
}

let cached: { path: string; module: WebAssembly.Module } | undefined;

/** The process's compiled module, read the first time it is asked for (and again only when MANDATE_WASM changed). */
export function processModule(): WebAssembly.Module {
  const path = modulePath();
  if (cached?.path !== path) cached = { path, module: compileModuleFile(path) };
  return cached.module;
}
