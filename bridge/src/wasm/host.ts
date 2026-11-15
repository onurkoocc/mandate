// The host of the Rust compiler's WebAssembly module (crates/mandate-wasm): a `wasm32-wasip1` command module that
// reads one request on its standard input and writes one answer on its standard output (crates/mandate-doors).
//
// The host is written by hand and gives the module nothing: no `node:wasi`, no file system, no network, no clock,
// no arguments, no environment. It serves exactly the seven imports of `wasi_snapshot_preview1` the module declares,
// with buffers in memory:
//
//   fd_read            on descriptor 0, the request; on any other, EBADF
//   fd_write           on 1, the answer, at most 64 MiB (more stops the call); on 2, what the module says when it
//                      fails, of which the first 64 KiB are kept to classify the failure and never shown; on any
//                      other, EBADF
//   random_get         zeros: its only caller is the seeding of Rust's HashMap, no output depends on it (a test holds
//                      that with random bytes), and zeros keep a call reproducible
//   environ_sizes_get  no variables; environ_get then writes nothing
//   clock_time_get     ENOSYS ("not supported"), and counted: nothing in the module should ask the time
//   proc_exit          ends the call with its status
//
// Every call runs in a fresh instance of the compiled module, which is cached; nothing of an instance is kept after
// its call (V8 refuses a new memory once some sixteen thousand are alive). The module's memory is at most 4096 pages
// (256 MiB) and its stack 4 MiB, both fixed when it was linked (the root's `build:wasm`); the host refuses, when it
// takes a module, one whose memory may grow further.
//
// What can go wrong is a `CompilerFailure` of a kind of its own (errors.ts); a door's refusal of its input is a
// `DoorRefusal`, which the facade turns into what the TypeScript function throws.

import { isWellFormed } from "../text.js";
import { CompilerFailure, DoorRefusal } from "./errors.js";

/** The imports the module declares, all of `wasi_snapshot_preview1`, and all the host serves. */
export const WASI_IMPORTS = ["random_get", "environ_get", "environ_sizes_get", "clock_time_get", "fd_read", "fd_write", "proc_exit"] as const;
export const WASI_MODULE = "wasi_snapshot_preview1";
/** The exports the host needs: the memory it reads and writes, and the entry it runs. */
export const NEEDED_EXPORTS = { memory: "memory", _start: "function" } as const;
/** The most pages of 64 KiB the module's memory may have: 256 MiB. */
export const MAX_MEMORY_PAGES = 4096;
/** The most bytes of answer the host takes. */
export const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
/** The most bytes of standard error the host keeps (to classify a failure; never shown). */
export const MAX_STDERR_BYTES = 64 * 1024;
/** The deepest a request may be nested (crates/mandate-doors, `MAX_REQUEST_DEPTH`): the request object is level 1. */
export const MAX_REQUEST_DEPTH = 128;

const ESUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;
const PAGE = 65536;

/** How a call ended inside the module: an exit of its own, or one of the host's two stops. */
class Exit {
  constructor(readonly status: number) {}
}
class AnswerTooLarge {}

export interface HostOptions {
  /** What `random_get` writes into the module's buffer. Zeros unless a test asks otherwise. */
  random?: (into: Uint8Array) => void;
}

/** What one run of the module gave, before it is read as an answer. */
export interface Run {
  stdout: Uint8Array;
  /** The first MAX_STDERR_BYTES of standard error, for classification only. */
  stderr: Uint8Array;
  stderrBytes: number;
  /** The exit status, when the module called proc_exit; undefined when `_start` returned. */
  status?: number;
  /** What stopped the run, when something did: a trap or an exception, or the host's stop for a long answer. */
  stopped?: unknown;
  /** The size of the module's memory when the run ended, in bytes. */
  memoryBytes: number;
}

/**
 * Takes a compiled module, after checking that it is one the host can run: its imports are exactly the seven above,
 * it exports a memory and `_start`, and its memory cannot grow past MAX_MEMORY_PAGES. Throws `module_refused`, naming
 * what is wrong.
 */
export function validateModule(module: WebAssembly.Module): void {
  const imports = WebAssembly.Module.imports(module);
  const allowed = new Set<string>(WASI_IMPORTS);
  const extra = imports.filter((i) => i.module !== WASI_MODULE || i.kind !== "function" || !allowed.has(i.name)).map((i) => `${i.module}.${i.name} (${i.kind})`);
  if (extra.length) throw new CompilerFailure("module_refused", undefined, `the module imports ${extra.join(", ")}, which the host does not serve; it serves ${WASI_IMPORTS.map((n) => `${WASI_MODULE}.${n}`).join(", ")}`);
  const names = imports.map((i) => i.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length) throw new CompilerFailure("module_refused", undefined, `the module imports ${[...new Set(twice)].join(", ")} more than once`);
  const missing = WASI_IMPORTS.filter((n) => !names.includes(n));
  if (missing.length) throw new CompilerFailure("module_refused", undefined, `the module does not import ${missing.map((n) => `${WASI_MODULE}.${n}`).join(", ")}: it is not the module the host was written for`);
  const exports = WebAssembly.Module.exports(module);
  for (const [name, kind] of Object.entries(NEEDED_EXPORTS)) {
    if (!exports.some((e) => e.name === name && e.kind === kind)) throw new CompilerFailure("module_refused", undefined, `the module does not export a ${kind} named ${name}`);
  }
  // The ceiling of the memory, read from an instance that runs nothing: a memory may not grow one page past it.
  const probe = new WebAssembly.Instance(module, { [WASI_MODULE]: Object.fromEntries(WASI_IMPORTS.map((n) => [n, () => ENOSYS])) });
  const memory = probe.exports["memory"] as WebAssembly.Memory;
  const pages = memory.buffer.byteLength / PAGE;
  if (pages > MAX_MEMORY_PAGES) throw new CompilerFailure("module_refused", undefined, `the module's memory starts at ${pages} pages, past the ceiling of ${MAX_MEMORY_PAGES}`);
  let grew = false;
  try {
    memory.grow(MAX_MEMORY_PAGES + 1 - pages);
    grew = true;
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  if (grew) throw new CompilerFailure("module_refused", undefined, `the module's memory can grow past ${MAX_MEMORY_PAGES} pages (256 MiB); build it with \`npm run build:wasm\`, which sets that ceiling`);
}

/**
 * The module, run once per call. `call(door, input)` writes the request, runs a fresh instance, reads the answer
 * and gives the door's output, or throws: a `DoorRefusal` for `bad_input`, a `CompilerFailure` for anything else.
 */
export class WasmHost {
  /** How many times the module called each import, over this host's life. */
  readonly imported: Record<string, number> = Object.fromEntries(WASI_IMPORTS.map((n) => [n, 0]));
  private readonly random: (into: Uint8Array) => void;

  constructor(
    readonly module: WebAssembly.Module,
    options: HostOptions = {},
  ) {
    validateModule(module);
    this.random = options.random ?? ((into) => into.fill(0));
  }

  /** The output of `door` for `input`: what the door's answer holds as `output`. */
  call(door: string, input: unknown): unknown {
    const run = this.run(Buffer.from(requestText(door, input), "utf8"));
    return answerOf(door, run);
  }

  /** One run of a fresh instance over `request`, as it ended. */
  run(request: Uint8Array): Run {
    const stdout: Uint8Array[] = [];
    let stdoutBytes = 0;
    const stderr: Uint8Array[] = [];
    let stderrBytes = 0;
    let read = 0;
    let memory: WebAssembly.Memory | undefined;
    const count = (name: string): void => void (this.imported[name] = (this.imported[name] ?? 0) + 1);
    const view = (): DataView => new DataView(memory!.buffer);
    const bytes = (at: number, length: number): Uint8Array => new Uint8Array(memory!.buffer, at, length);
    const iovecs = (at: number, n: number): Array<[number, number]> => {
      const v = view();
      return Array.from({ length: n }, (_, i): [number, number] => [v.getUint32(at + i * 8, true), v.getUint32(at + i * 8 + 4, true)]);
    };
    const wasi: Record<(typeof WASI_IMPORTS)[number], (...a: number[]) => number> = {
      random_get: (at, length) => {
        count("random_get");
        this.random(bytes(at!, length!));
        return ESUCCESS;
      },
      environ_sizes_get: (countAt, sizeAt) => {
        count("environ_sizes_get");
        view().setUint32(countAt!, 0, true);
        view().setUint32(sizeAt!, 0, true);
        return ESUCCESS;
      },
      environ_get: () => {
        count("environ_get");
        return ESUCCESS;
      },
      clock_time_get: () => {
        count("clock_time_get");
        return ENOSYS;
      },
      fd_read: (fd, iovs, n, readAt) => {
        count("fd_read");
        if (fd !== 0) return EBADF;
        let total = 0;
        for (const [at, length] of iovecs(iovs!, n!)) {
          const take = Math.min(length, request.length - read);
          if (take > 0) bytes(at, take).set(request.subarray(read, read + take));
          read += take;
          total += take;
          if (take < length) break;
        }
        view().setUint32(readAt!, total, true);
        return ESUCCESS;
      },
      fd_write: (fd, iovs, n, writtenAt) => {
        count("fd_write");
        if (fd !== 1 && fd !== 2) return EBADF;
        let total = 0;
        for (const [at, length] of iovecs(iovs!, n!)) {
          if (fd === 1) {
            stdoutBytes += length;
            if (stdoutBytes > MAX_ANSWER_BYTES) throw new AnswerTooLarge();
            stdout.push(bytes(at, length).slice());
          } else {
            const keep = Math.max(0, Math.min(length, MAX_STDERR_BYTES - stderrBytes));
            if (keep) stderr.push(bytes(at, keep).slice());
            stderrBytes += length;
          }
          total += length;
        }
        view().setUint32(writtenAt!, total, true);
        return ESUCCESS;
      },
      proc_exit: (status) => {
        count("proc_exit");
        throw new Exit(status!);
      },
    };
    let status: number | undefined;
    let stopped: unknown;
    try {
      const instance = new WebAssembly.Instance(this.module, { [WASI_MODULE]: wasi });
      memory = instance.exports["memory"] as WebAssembly.Memory;
      (instance.exports["_start"] as () => void)();
    } catch (e) {
      if (e instanceof Exit) status = e.status;
      else stopped = e;
    }
    return {
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      stderrBytes,
      ...(status !== undefined ? { status } : {}),
      ...(stopped !== undefined ? { stopped } : {}),
      memoryBytes: memory ? memory.buffer.byteLength : 0,
    };
  }
}

/** The text of the request `{ door, input }`, or `unrepresentable` when the input holds what the module cannot read. */
export function requestText(door: string, input: unknown): string {
  const problem = unrepresentable(input);
  if (problem) throw new CompilerFailure("unrepresentable", door, problem);
  return JSON.stringify({ door, input });
}

/**
 * What in `value` the module's strict reader refuses or JSON cannot carry, with where it is (a JSON Pointer into the
 * input), or undefined when there is nothing. Walked without recursion. It names the kind of value, never a string's
 * text: what a program or a model wrote stays out of the message.
 */
export function unrepresentable(value: unknown): string | undefined {
  // Each entry: the value, its pointer, its depth (the request is 1 and its input 2), and its holders, for a cycle.
  const stack: Array<{ v: unknown; at: string; depth: number; holders: unknown[] }> = [{ v: value, at: "", depth: 2, holders: [] }];
  const where = (at: string): string => (at === "" ? "the input" : `the input at ${at}`);
  const token = (k: string): string => k.replaceAll("~", "~0").replaceAll("/", "~1");
  while (stack.length) {
    const { v, at, depth, holders } = stack.pop()!;
    if (v === null || typeof v === "boolean") continue;
    if (typeof v === "string") {
      if (!isWellFormed(v)) return `${where(at)} is a string with a lone surrogate, which the request reader refuses`;
      continue;
    }
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) return `${where(at)} is the number ${Object.is(v, -0) ? "-0" : String(v)}, and a request holds integers within ±(2^53−1) only`;
      continue;
    }
    if (typeof v !== "object") return `${where(at)} is a ${typeof v}, which JSON cannot carry`;
    if (depth > MAX_REQUEST_DEPTH) return `${where(at)} is nested deeper than the ${MAX_REQUEST_DEPTH} levels a request may have`;
    if (holders.includes(v)) return `${where(at)} holds itself`;
    const inner = [...holders, v];
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i] === undefined ? null : v[i], at: `${at}/${i}`, depth: depth + 1, holders: inner });
      continue;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return `${where(at)} is a ${(v as { constructor?: { name?: string } }).constructor?.name ?? "object"}, not a plain object`;
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i]!;
      if (!isWellFormed(k)) return `${where(at)} has a member name with a lone surrogate`;
      const x = (v as Record<string, unknown>)[k];
      // A member that is undefined is left out, as JSON.stringify leaves it out (the door contract's absent member).
      if (x !== undefined) stack.push({ v: x, at: `${at}/${token(k)}`, depth: depth + 1, holders: inner });
    }
  }
  return undefined;
}

/** What a run of `door` gave: its output, or the failure, classified. */
export function answerOf(door: string, run: Run): unknown {
  if (run.stopped !== undefined) throw stoppedFailure(door, run);
  if (run.status !== undefined && run.status !== 0) throw new CompilerFailure("exit_status", door, `the module exited with status ${run.status}`);
  if (run.stderrBytes > 0) throw new CompilerFailure("bad_answer", door, `the module wrote ${run.stderrBytes} bytes to its standard error, which it does only when it fails`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(run.stdout);
  } catch {
    throw new CompilerFailure("bad_answer", door, "the answer is not UTF-8");
  }
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    throw new CompilerFailure("bad_answer", door, text.length ? `the answer is not one JSON text (${run.stdout.length} bytes)` : "the module wrote no answer");
  }
  const a = answer as { ok?: unknown; output?: unknown; error?: { kind?: unknown; message?: unknown } };
  const members = answer && typeof answer === "object" && !Array.isArray(answer) ? Object.keys(answer) : [];
  if (a.ok === true && members.length === 2 && members.includes("output")) return a.output;
  if (a.ok === false && members.length === 2 && members.includes("error") && a.error && typeof a.error === "object" && typeof a.error.kind === "string" && typeof a.error.message === "string" && Object.keys(a.error).length === 2) {
    if (a.error.kind === "bad_input") throw new DoorRefusal(door, a.error.message);
    if (["too_large", "bad_request", "unknown_door"].includes(a.error.kind)) throw new CompilerFailure("refused", door, `${a.error.kind}: ${a.error.message}`, a.error.kind);
  }
  throw new CompilerFailure("bad_answer", door, "the answer is not { ok: true, output } nor { ok: false, error: { kind, message } } of a kind the bridge knows");
}

/** The failure a run that was stopped is: what stopped it, read without showing what the module wrote. */
function stoppedFailure(door: string, run: Run): CompilerFailure {
  const e = run.stopped;
  if (e instanceof AnswerTooLarge) return new CompilerFailure("output_too_large", door, `the answer passed ${MAX_ANSWER_BYTES} bytes and the call was stopped`);
  const said = Buffer.from(run.stderr).toString("utf8");
  if (e instanceof WebAssembly.RuntimeError) {
    // Rust's handler of a failed allocation says so on standard error before it traps; a panic says "panicked at".
    // Neither text is kept: only which of them it was.
    if (said.startsWith("memory allocation of ")) return new CompilerFailure("out_of_memory", door, `the module could not allocate memory with ${Math.round(run.memoryBytes / 1048576)} MiB of its 256 MiB in use`);
    // With the stack first in memory (--stack-first), a stack that runs out reaches below address 0: an access out
    // of bounds, which safe Rust makes in no other way. A worker thread, whose own stack is small, shows it so.
    if (e.message.includes("memory access out of bounds")) return new CompilerFailure("stack_exhausted", door, "the module ran past the end of its 4 MiB stack");
    return new CompilerFailure("trap", door, said.includes("panicked at") ? "the module panicked" : `the module trapped (${trapName(e.message)})`);
  }
  // On the main thread V8's own stack runs out before the module's does.
  if (e instanceof RangeError && /call stack/i.test(e.message)) return new CompilerFailure("stack_exhausted", door, "the module exhausted the stack it runs on");
  return new CompilerFailure("host_error", door, e instanceof Error ? `${e.name}: ${e.message}` : "the host stopped with something that is not an error");
}

/** The trap's name as V8 gives it (`unreachable`, `divide by zero`, …), without anything the module said. */
function trapName(message: string): string {
  const known = ["unreachable", "divide by zero", "integer overflow", "invalid conversion to integer", "table index is out of bounds", "null function or function signature mismatch", "out of bounds memory access", "data segment out of bounds", "element segment out of bounds"];
  return known.find((k) => message.toLowerCase().includes(k)) ?? "a trap V8 names otherwise";
}
