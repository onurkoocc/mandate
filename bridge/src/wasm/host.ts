// The host of the Rust compiler's WebAssembly module (crates/mandate-wasm): a `wasm32-wasip1` command module that
// reads one request on its standard input and writes one answer on its standard output (crates/mandate-doors).
//
// The host is written by hand and gives the module nothing: no `node:wasi`, no file system, no network, no clock,
// no arguments, no environment. It serves exactly the seven imports of `wasi_snapshot_preview1` the module declares,
// with buffers in memory:
//
//   fd_read            on descriptor 0, the request; on any other, EBADF
//   fd_write           on 1, the answer, at most 64 MiB, in one buffer that grows to that and no further (more stops
//                      the call); on 2, what the module says when it fails, of which the first 64 KiB are kept to
//                      classify the failure and never shown; on any other, EBADF
//   random_get         random bytes (node:crypto), for each call afresh: its one caller is the seed of Rust's
//                      HashMap (SipHash), and part of what the module hashes is a model's writing (a sub-program,
//                      its patch, its scopes), so a seed anyone could know would let such input be made to fall in
//                      one bucket and slow the main thread down. No output depends on the seed: a test runs the
//                      recorded calls under fixed seeds and random ones and compares the answers byte for byte. A
//                      test may give a fixed fill (`HostOptions.random`)
//   environ_sizes_get  no variables; environ_get then writes nothing
//   clock_time_get     ENOSYS ("not supported"), and counted: nothing in the module should ask the time
//   proc_exit          ends the call with its status
//
// A read or a write names at most MAX_IOVECS buffers (Rust's std names one or two), each inside the module's memory;
// anything else stops the call (`host_error`). Every pointer the module gives is read as the unsigned number it is
// and checked against the memory before it is used.
//
// A module is taken only after its bytes were read (`validateBytes`): its imports are exactly the seven above, all
// functions; it has exactly one memory, its own, of 32 bits, not shared, declared with a maximum of at most 4096
// pages (256 MiB); it has no start function, so instantiating it runs nothing. Its exports are then checked on the
// compiled module (`memory` and `_start`). A module the host has not read the bytes of is refused, but one handed
// over by the thread that read them (mode.ts, `adoptCompiler`).
//
// Every call runs in a fresh instance of the compiled module, which is cached; nothing of an instance is kept after
// its call (V8 refuses a new memory once some sixteen thousand are alive). The stack of 4 MiB is fixed when the
// module is linked (the root's `build:wasm`).
//
// What can go wrong is a `CompilerFailure` of a kind of its own (errors.ts); a door's refusal of its input is a
// `DoorRefusal`, which the facade turns into what the TypeScript function throws.

import { randomFillSync } from "node:crypto";
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
/** The most buffers one fd_read or fd_write may name. */
export const MAX_IOVECS = 16;

const ESUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;

/** How a call ended inside the module: an exit of its own, or one of the host's stops. */
class Exit {
  constructor(readonly status: number) {}
}
class AnswerTooLarge {}
/** The module asked the host for what it does not do: too many buffers, or memory that is not its own. */
class HostRefusal {
  constructor(readonly reason: string) {}
}

export interface HostOptions {
  /**
   * What `random_get` writes into the module's buffer (a view into its memory, of the length it asked for, perhaps
   * none). Cryptographically random bytes unless a test gives a fixed fill.
   */
  random?: (into: Uint8Array) => void;
}

/** The bytes `random_get` gives by default: random, from node:crypto. */
export const randomBytes = (into: Uint8Array): void => {
  if (into.byteLength) randomFillSync(into);
};

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

// ── the module's bytes ──────────────────────────────────────────────────

const refused = (why: string): CompilerFailure => new CompilerFailure("module_refused", undefined, why);
const invalid = (why: string): CompilerFailure => new CompilerFailure("module_invalid", undefined, why);

/**
 * Reads a module's binary (https://webassembly.github.io/spec/core/binary/) and refuses, by name, one the host does
 * not run: an import that is not one of the seven functions, a memory that is imported, shared, of 64 bits, without a
 * maximum or with one past MAX_MEMORY_PAGES, other than exactly one memory, or a start function. Reads the section
 * headers and the import, memory and start sections, and nothing else.
 */
export function validateBytes(bytes: Uint8Array): void {
  let at = 0;
  const end = (): boolean => at >= bytes.length;
  const byte = (): number => {
    if (at >= bytes.length) throw invalid("the module's binary ends in the middle of a section");
    return bytes[at++]!;
  };
  const leb = (): number => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 63) throw invalid("the module's binary has a number longer than its format allows");
      const b = byte();
      n += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return n;
    }
  };
  const skip = (n: number): void => {
    if (n > bytes.length - at) throw invalid("the module's binary ends in the middle of a section");
    at += n;
  };
  const name = (): string => {
    const n = leb();
    const from = at;
    skip(n);
    return Buffer.from(bytes.subarray(from, at)).toString("utf8");
  };
  /** A memory's limits: its flags, and its maximum when it has one. */
  const limits = (): { flags: number; max?: number } => {
    const flags = leb();
    leb();
    return flags & 1 ? { flags, max: leb() } : { flags };
  };
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw invalid("the file is not a WebAssembly binary");
  if (bytes[4] !== 0x01 || bytes[5] !== 0x00 || bytes[6] !== 0x00 || bytes[7] !== 0x00) throw invalid("the module is of a version of the binary format the host does not read");
  at = 8;
  const memories: Array<{ flags: number; max?: number }> = [];
  const allowed = new Set<string>(WASI_IMPORTS);
  while (!end()) {
    const id = byte();
    const size = leb();
    const start = at;
    skip(size);
    const inner = at;
    at = start;
    if (id === 2) {
      for (let n = leb(); n > 0; n--) {
        const module = name();
        const field = name();
        const kind = byte();
        if (kind !== 0x00) throw refused(`the module imports ${module}.${field} as a ${["function", "table", "memory", "global", "tag"][kind] ?? `thing of kind ${kind}`}: the host serves functions only`);
        if (module !== WASI_MODULE || !allowed.has(field)) throw refused(`the module imports ${module}.${field}, which the host does not serve; it serves ${WASI_IMPORTS.map((f) => `${WASI_MODULE}.${f}`).join(", ")}`);
        leb();
      }
    } else if (id === 5) {
      for (let n = leb(); n > 0; n--) memories.push(limits());
    } else if (id === 8) {
      throw refused("the module has a start function, which instantiating it would run");
    }
    at = inner;
  }
  if (memories.length !== 1) throw refused(memories.length ? `the module has ${memories.length} memories; the host runs a module of one` : "the module has no memory of its own");
  const m = memories[0]!;
  if (m.flags & 2) throw refused("the module's memory is shared");
  if (m.flags & 4) throw refused("the module's memory is of 64 bits");
  if (m.flags & ~7) throw refused(`the module's memory has limits of a form the host does not read (${m.flags})`);
  if (m.max === undefined) throw refused(`the module's memory has no maximum; build it with \`npm run build:wasm\`, which sets one of ${MAX_MEMORY_PAGES} pages (256 MiB)`);
  if (m.max > MAX_MEMORY_PAGES) throw refused(`the module's memory may grow to ${m.max} pages, past the ${MAX_MEMORY_PAGES} pages (256 MiB) the host runs a module with`);
}

/**
 * Checks a compiled module's imports and exports: the imports exactly the seven above, each once, and the exports
 * a memory and `_start`. Throws `module_refused`, naming what is wrong.
 */
export function validateModule(module: WebAssembly.Module): void {
  const imports = WebAssembly.Module.imports(module);
  const allowed = new Set<string>(WASI_IMPORTS);
  const extra = imports.filter((i) => i.module !== WASI_MODULE || i.kind !== "function" || !allowed.has(i.name)).map((i) => `${i.module}.${i.name} (${i.kind})`);
  if (extra.length) throw refused(`the module imports ${extra.join(", ")}, which the host does not serve; it serves ${WASI_IMPORTS.map((n) => `${WASI_MODULE}.${n}`).join(", ")}`);
  const names = imports.map((i) => i.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length) throw refused(`the module imports ${[...new Set(twice)].join(", ")} more than once`);
  const missing = WASI_IMPORTS.filter((n) => !names.includes(n));
  if (missing.length) throw refused(`the module does not import ${missing.map((n) => `${WASI_MODULE}.${n}`).join(", ")}: it is not the module the host was written for`);
  const exports = WebAssembly.Module.exports(module);
  for (const [name, kind] of Object.entries(NEEDED_EXPORTS)) {
    if (!exports.some((e) => e.name === name && e.kind === kind)) throw refused(`the module does not export a ${kind} named ${name}`);
  }
}

/** The modules whose bytes were read and found to be ones the host runs (module.ts), or handed over by a thread that did. */
const checked = new WeakSet<WebAssembly.Module>();

/** Marks a compiled module as one whose bytes were checked (`validateBytes`) and whose imports and exports were. */
export function markChecked(module: WebAssembly.Module): void {
  checked.add(module);
}

// ── the host ────────────────────────────────────────────────────────────

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
    if (!checked.has(module)) throw refused("the host was given a module whose bytes it has not read; compile it with compileModuleBytes");
    validateModule(module);
    this.random = options.random ?? randomBytes;
  }

  /** The output of `door` for `input`: what the door's answer holds as `output`. */
  call(door: string, input: unknown): unknown {
    const run = this.run(Buffer.from(requestText(door, input), "utf8"));
    return answerOf(door, run);
  }

  /** One run of a fresh instance over `request`, as it ended. */
  run(request: Uint8Array): Run {
    // The answer, in one buffer that grows by doubling up to the cap; what standard error says, in one of 64 KiB.
    let stdout = new Uint8Array(64 * 1024);
    let stdoutBytes = 0;
    const stderr = new Uint8Array(MAX_STDERR_BYTES);
    let stderrBytes = 0;
    let read = 0;
    let memory: WebAssembly.Memory | undefined;
    const count = (name: string): void => void (this.imported[name] = (this.imported[name] ?? 0) + 1);
    // An i32 the module passes arrives as a signed number: a pointer or a length is read as the unsigned one it is.
    const unsigned = (x: number): number => (x < 0 ? x >>> 0 : x);
    /** `length` bytes of the module's memory at `at`; refused when not all of them are inside it. */
    const bytes = (at: number, length: number): Uint8Array => {
      const buffer = memory!.buffer;
      const from = unsigned(at);
      const n = unsigned(length);
      if (from > buffer.byteLength || n > buffer.byteLength - from) throw new HostRefusal("the module named memory past the end of its own");
      return new Uint8Array(buffer, from, n);
    };
    const put32 = (at: number, v: number): void => {
      const b = bytes(at, 4);
      new DataView(b.buffer, b.byteOffset, 4).setUint32(0, v, true);
    };
    /** Each buffer an fd_read or fd_write names, in order, the empty ones left out; at most MAX_IOVECS of them. */
    const eachIovec = (iovs: number, n: number, f: (at: number, length: number) => boolean | void): void => {
      const count = unsigned(n);
      if (count > MAX_IOVECS) throw new HostRefusal(`the module named ${count} buffers in one call; the host takes at most ${MAX_IOVECS}`);
      for (let i = 0; i < count; i++) {
        const entry = bytes(unsigned(iovs) + i * 8, 8);
        const v = new DataView(entry.buffer, entry.byteOffset, 8);
        const at = v.getUint32(0, true);
        const length = v.getUint32(4, true);
        if (length === 0) continue;
        if (f(at, length) === false) return;
      }
    };
    const wasi: Record<(typeof WASI_IMPORTS)[number], (...a: number[]) => number> = {
      random_get: (at, length) => {
        count("random_get");
        this.random(bytes(at!, length!));
        return ESUCCESS;
      },
      environ_sizes_get: (countAt, sizeAt) => {
        count("environ_sizes_get");
        put32(countAt!, 0);
        put32(sizeAt!, 0);
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
        eachIovec(iovs!, n!, (at, length) => {
          const take = Math.min(length, request.length - read);
          if (take > 0) bytes(at, take).set(request.subarray(read, read + take));
          read += take;
          total += take;
          return take === length;
        });
        put32(readAt!, total);
        return ESUCCESS;
      },
      fd_write: (fd, iovs, n, writtenAt) => {
        count("fd_write");
        if (fd !== 1 && fd !== 2) return EBADF;
        let total = 0;
        eachIovec(iovs!, n!, (at, length) => {
          const chunk = bytes(at, length);
          if (fd === 1) {
            if (length > MAX_ANSWER_BYTES - stdoutBytes) throw new AnswerTooLarge();
            if (stdoutBytes + length > stdout.length) {
              const grown = new Uint8Array(Math.min(MAX_ANSWER_BYTES, Math.max(stdoutBytes + length, stdout.length * 2)));
              grown.set(stdout.subarray(0, stdoutBytes));
              stdout = grown;
            }
            stdout.set(chunk, stdoutBytes);
            stdoutBytes += length;
          } else {
            const keep = Math.min(length, MAX_STDERR_BYTES - Math.min(stderrBytes, MAX_STDERR_BYTES));
            if (keep > 0) stderr.set(chunk.subarray(0, keep), stderrBytes);
            stderrBytes += length;
          }
          total += length;
        });
        put32(writtenAt!, total);
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
      stdout: stdout.slice(0, stdoutBytes),
      stderr: stderr.slice(0, Math.min(stderrBytes, MAX_STDERR_BYTES)),
      stderrBytes,
      ...(status !== undefined ? { status } : {}),
      ...(stopped !== undefined ? { stopped } : {}),
      memoryBytes: memory ? memory.buffer.byteLength : 0,
    };
  }
}

// ── the request ─────────────────────────────────────────────────────────

/**
 * The text of the request `{ door, input }`, written in the same walk that checks the input, so that each value is
 * read once (a getter that answered otherwise the second time could not make the two compilers see two inputs).
 * `unrepresentable` when the input holds what the module's strict reader refuses or JSON cannot carry.
 */
export function requestText(door: string, input: unknown): string {
  const written = writeRequest(input);
  if (typeof written !== "string") throw new CompilerFailure("unrepresentable", door, written.problem);
  return `{"door":${JSON.stringify(door)},"input":${written}}`;
}

/** What in `value` a request cannot carry, with where it is, or undefined when there is nothing. */
export function unrepresentable(value: unknown): string | undefined {
  const w = writeRequest(value);
  return typeof w === "string" ? undefined : w.problem;
}

/**
 * The JSON text of `value` as a request's input carries it, as JSON.stringify writes it (a member that is undefined
 * left out, as the door contract's absent member), or what in it a request cannot carry: a number that is not an
 * integer within ±(2^53−1), or -0; a string or a member name with a lone surrogate; a hole or undefined in an array
 * (JSON.stringify would write null, which the TypeScript does not see); a value that is not JSON (a function, a
 * symbol, a bigint, an object that is not a plain one); nesting past MAX_REQUEST_DEPTH; a value that holds itself.
 * The problem says where, as a JSON Pointer into the input (whose tokens are the input's member names), and the kind
 * of the value; it never quotes a string the input holds.
 */
function writeRequest(value: unknown): string | { problem: string } {
  const out: string[] = [];
  const holders = new Set<object>();
  const where = (at: string): string => (at === "" ? "the input" : `the input at ${at}`);
  const token = (k: string): string => k.replaceAll("~", "~0").replaceAll("/", "~1");
  /** Writes `v` at `at`, `depth` levels down (the request is 1 and its input 2); a problem stops the walk. */
  const write = (v: unknown, at: string, depth: number): string | undefined => {
    if (v === null) return void out.push("null");
    switch (typeof v) {
      case "boolean":
        return void out.push(v ? "true" : "false");
      case "string":
        if (!isWellFormed(v)) return `${where(at)} is a string with a lone surrogate, which the request reader refuses`;
        return void out.push(JSON.stringify(v));
      case "number":
        if (!Number.isSafeInteger(v) || Object.is(v, -0)) return `${where(at)} is the number ${Object.is(v, -0) ? "-0" : String(v)}, and a request holds integers within ±(2^53−1) only`;
        return void out.push(String(v));
      case "object":
        break;
      default:
        return `${where(at)} is a ${typeof v}, which JSON cannot carry`;
    }
    if (depth > MAX_REQUEST_DEPTH) return `${where(at)} is nested deeper than the ${MAX_REQUEST_DEPTH} levels a request may have`;
    const o = v as object;
    if (holders.has(o)) return `${where(at)} holds itself`;
    holders.add(o);
    try {
      if (Array.isArray(o)) {
        out.push("[");
        for (let i = 0; i < o.length; i++) {
          if (i) out.push(",");
          if (!(i in o)) return `${where(at)} has a hole at ${i}, which the TypeScript and JSON read otherwise`;
          const x: unknown = o[i];
          if (x === undefined) return `${where(`${at}/${i}`)} is undefined, which JSON would write as null and the TypeScript does not read so`;
          const p = write(x, `${at}/${i}`, depth + 1);
          if (p) return p;
        }
        out.push("]");
        return undefined;
      }
      const proto = Object.getPrototypeOf(o);
      if (proto !== Object.prototype && proto !== null) return `${where(at)} is a ${(o as { constructor?: { name?: string } }).constructor?.name ?? "object"}, not a plain object`;
      out.push("{");
      let first = true;
      for (const k of Object.keys(o)) {
        if (!isWellFormed(k)) return `${where(at)} has a member name with a lone surrogate`;
        // Each member is read once: its value is what is checked and what is written.
        const x: unknown = (o as Record<string, unknown>)[k];
        if (x === undefined) continue;
        if (!first) out.push(",");
        first = false;
        out.push(JSON.stringify(k), ":");
        const p = write(x, `${at}/${token(k)}`, depth + 1);
        if (p) return p;
      }
      out.push("}");
      return undefined;
    } finally {
      holders.delete(o);
    }
  };
  const problem = write(value, "", 2);
  return problem ? { problem } : out.join("");
}

// ── the answer ──────────────────────────────────────────────────────────

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
  if (e instanceof HostRefusal) return new CompilerFailure("host_error", door, `the host stopped the call: ${e.reason}`);
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
