// Small WebAssembly command modules written as bytes, for the tests of the host: each imports what the Rust
// compiler's module imports (the seven functions of wasi_snapshot_preview1, and an extra one when a test asks), has
// a memory with a ceiling, and exports `memory` and `_start`, whose body is the test's. No tool builds them: the
// binary format is written here (https://webassembly.github.io/spec/core/binary/).

/** The seven imports, each with its type: what the Rust compiler's module declares. */
const WASI: Array<[string, number]> = [
  ["random_get", 0],
  ["environ_get", 0],
  ["environ_sizes_get", 0],
  ["clock_time_get", 1],
  ["fd_read", 2],
  ["fd_write", 2],
  ["proc_exit", 3],
];

/** The index of each import, as a function: what a body calls. */
export const FN = { random_get: 0, environ_get: 1, environ_sizes_get: 2, clock_time_get: 3, fd_read: 4, fd_write: 5, proc_exit: 6, start: 7 } as const;

const I32 = 0x7f;
const I64 = 0x7e;

/** An unsigned LEB128 number. */
export function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

/** A signed LEB128 number (for i32.const). */
export function sleb(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const name = (s: string): number[] => [...uleb(Buffer.byteLength(s)), ...Buffer.from(s)];
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

/** Instructions, for the bodies below. */
export const op = {
  unreachable: [0x00],
  end: [0x0b],
  drop: [0x1a],
  call: (f: number): number[] => [0x10, ...uleb(f)],
  i32: (n: number): number[] => [0x41, ...sleb(n)],
  localGet: (i: number): number[] => [0x20, ...uleb(i)],
  localSet: (i: number): number[] => [0x21, ...uleb(i)],
  localTee: (i: number): number[] => [0x22, ...uleb(i)],
  add: [0x6a],
  ltU: [0x49],
  loop: [0x03, 0x40],
  br: (d: number): number[] => [0x0c, ...uleb(d)],
  brIf: (d: number): number[] => [0x0d, ...uleb(d)],
  /** fd_write(fd, iovecs at `iov`, 1 of them, written count at `nwritten`), its errno dropped. */
  write: (fd: number, iov: number, nwritten = 8): number[] => [...op.i32(fd), ...op.i32(iov), ...op.i32(1), ...op.i32(nwritten), ...op.call(FN.fd_write), ...op.drop],
};

export interface ModuleSpec {
  /** The body of `_start`, without its final `end`. */
  body: number[];
  /** How many i32 locals `_start` has. */
  locals?: number;
  /** Pages of memory at the start, and at most (undefined: no ceiling). */
  pages?: number;
  maxPages?: number | null;
  /** Bytes put in memory at an address before `_start` runs. */
  data?: Array<[number, Uint8Array | number[]]>;
  /** Imports besides the seven, as `wasi_snapshot_preview1.<name>` of type (i32) -> i32. */
  extraImports?: string[];
  /** Imports left out of the seven. */
  without?: string[];
  /** The memories, as their limits' flags (1: a maximum; 2: shared; 4: 64 bits), first pages and most; one of `pages` and `maxPages` unless given. */
  memories?: Array<{ flags: number; min: number; max?: number }>;
  /** A start section, naming `_start`. */
  start?: boolean;
}

/** The bytes of a module. */
export function wasmModule(s: ModuleSpec): Uint8Array {
  const types = section(1, vec([
    [0x60, ...vec([[I32], [I32]]), ...vec([[I32]])],
    [0x60, ...vec([[I32], [I64], [I32]]), ...vec([[I32]])],
    [0x60, ...vec([[I32], [I32], [I32], [I32]]), ...vec([[I32]])],
    [0x60, ...vec([[I32]]), ...vec([])],
    [0x60, ...vec([]), ...vec([])],
    [0x60, ...vec([[I32]]), ...vec([[I32]])],
  ]));
  // Calls in a body go by index (FN): a module whose imports differ from the seven has a body that calls none.
  const imports = [...WASI.filter(([n]) => !s.without?.includes(n)), ...(s.extraImports ?? []).map((n): [string, number] => [n, 5])];
  const importSection = section(2, vec(imports.map(([n, t]) => [...name("wasi_snapshot_preview1"), ...name(n), 0x00, ...uleb(t)])));
  const start = imports.length;
  const functions = section(3, vec([[4]]));
  const max = s.maxPages === undefined ? 4096 : s.maxPages;
  const pages = s.pages ?? 1;
  const memories = s.memories ?? [max === null ? { flags: 0, min: pages } : { flags: 1, min: pages, max }];
  const memory = section(5, vec(memories.map((m) => [...uleb(m.flags), ...uleb(m.min), ...(m.flags & 1 ? uleb(m.max ?? m.min) : [])])));
  const exports = section(7, vec([[...name("memory"), 0x02, 0], [...name("_start"), 0x00, ...uleb(start)]]));
  const startSection = s.start ? section(8, uleb(start)) : [];
  const locals = s.locals ? vec([[...uleb(s.locals), I32]]) : vec([]);
  const body = [...locals, ...s.body, ...op.end];
  const code = section(10, vec([[...uleb(body.length), ...body]]));
  const data = s.data?.length ? section(11, vec(s.data.map(([at, bytes]) => [0x00, ...op.i32(at), ...op.end, ...uleb(bytes.length), ...bytes]))) : [];
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...types, ...importSection, ...functions, ...memory, ...exports, ...startSection, ...code, ...data]);
}

/** Little-endian u32s. */
export const u32s = (...n: number[]): number[] => n.flatMap((x) => [x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff]);

/** A module that writes `text` to descriptor `fd` (1 or 2), then does `after` (nothing: it returns). */
export function writing(parts: Array<[fd: number, text: string]>, after: number[] = []): Uint8Array {
  const data: Array<[number, number[]]> = [];
  const body: number[] = [];
  let at = 1024;
  parts.forEach(([fd, text], i) => {
    const bytes = [...Buffer.from(text, "utf8")];
    const iov = 16 + i * 8;
    data.push([iov, u32s(at, bytes.length)]);
    data.push([at, bytes]);
    body.push(...op.write(fd, iov, 8));
    at += bytes.length + 16;
  });
  return wasmModule({ body: [...body, ...after], data, pages: Math.max(1, Math.ceil((at + 1) / 65536)) });
}

/** The modules the tests use. */
export const MODULES = {
  /** Traps at once. */
  trap: (): Uint8Array => wasmModule({ body: op.unreachable }),
  /** Never ends. */
  loop: (): Uint8Array => wasmModule({ body: [...op.loop, ...op.br(0), ...op.end] }),
  /** Calls itself until a stack runs out. */
  recursion: (): Uint8Array => wasmModule({ body: op.call(FN.start) }),
  /** Exits with status 3, having written nothing. */
  exit3: (): Uint8Array => wasmModule({ body: [...op.i32(3), ...op.call(FN.proc_exit)] }),
  /** Writes 1 MiB of answer 70 times. */
  flood: (): Uint8Array =>
    wasmModule({
      pages: 17,
      locals: 1,
      data: [[16, u32s(0, 1 << 20)]],
      body: [...op.loop, ...op.write(1, 16, 8), ...op.localGet(0), ...op.i32(1), ...op.add, ...op.localTee(0), ...op.i32(70), ...op.ltU, ...op.brIf(0), ...op.end],
    }),
  /** Says on standard error what Rust's handler of a failed allocation says, and traps, as the compiler does at its ceiling. */
  outOfMemory: (): Uint8Array => writing([[2, "memory allocation of 1048576 bytes failed\n"]], op.unreachable),
  /** Panics as Rust does, with a source path of the machine that built it, and traps. */
  panic: (): Uint8Array => writing([[2, "\nthread 'main' panicked at /home/builder/secret-place/src/lib.rs:7:9:\nindex out of bounds\n"]], op.unreachable),
  /** Asks random_get for `n` bytes at 1024 and writes them on standard output. */
  randomEcho: (n: number): Uint8Array =>
    wasmModule({ data: [[16, u32s(1024, n)]], body: [...op.i32(1024), ...op.i32(n), ...op.call(FN.random_get), ...op.drop, ...op.write(1, 16, 8)] }),
  /** Answers with `text` and returns. */
  answering: (text: string): Uint8Array => writing([[1, text]]),
  /** Answers and also writes to standard error. */
  answeringAndSaying: (text: string): Uint8Array => writing([[1, text], [2, "a note"]]),
  /** Names 17 buffers in one fd_write. */
  manyBuffers: (): Uint8Array =>
    wasmModule({ data: [[16, u32s(...Array.from({ length: 17 }, () => [1024, 1]).flat())]], body: [...op.i32(1), ...op.i32(16), ...op.i32(17), ...op.i32(8), ...op.call(FN.fd_write), ...op.drop] }),
  /** Names a buffer past the end of its memory in an fd_write. */
  bufferPastMemory: (): Uint8Array => wasmModule({ data: [[16, u32s(0xfffffff0, 64)]], body: op.write(1, 16, 8) }),
  /** Asks random_get to fill memory past its end. */
  randomPastMemory: (): Uint8Array => wasmModule({ body: [...op.i32(0x7ffffff0), ...op.i32(64), ...op.call(FN.random_get), ...op.drop] }),
  /** Has two memories. */
  twoMemories: (): Uint8Array => wasmModule({ body: op.unreachable, memories: [{ flags: 1, min: 1, max: 16 }, { flags: 1, min: 1, max: 16 }] }),
  /** Has a shared memory. */
  sharedMemory: (): Uint8Array => wasmModule({ body: op.unreachable, memories: [{ flags: 3, min: 1, max: 16 }] }),
  /** Has a memory of 64 bits. */
  memory64: (): Uint8Array => wasmModule({ body: op.unreachable, memories: [{ flags: 5, min: 1, max: 16 }] }),
  /** Has a start function (its `_start`, which traps). */
  startFunction: (): Uint8Array => wasmModule({ body: op.unreachable, start: true }),
  /** Has an eighth import. */
  extraImport: (): Uint8Array => wasmModule({ body: op.unreachable, extraImports: ["fd_close"] }),
  /** Has a memory with no ceiling. */
  noCeiling: (): Uint8Array => wasmModule({ body: op.unreachable, maxPages: null }),
  /** Has a memory whose ceiling is 4097 pages. */
  highCeiling: (): Uint8Array => wasmModule({ body: op.unreachable, maxPages: 4097 }),
};
