// The host of the Rust compiler's module (src/wasm/): what the module is (its imports, exports, memory and stack,
// pinned), that every recorded call of the two crates' doors and of the authority decisions gives through it the
// output the TypeScript gave, byte for byte the same whatever the seed of Rust's HashMap (random bytes, the host's
// default, and three fixed seeds), and every way a call can fail, each produced for real and classified.
//
// It needs the module (`npm run build:wasm`): without it, in `ts` mode (MANDATE_COMPILER=ts), these tests are skipped
// and say so; in `rust` (the default) and `both` the run does not start without it (test/compiler-setup.ts).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODES as TS_CODES } from "../../compiler/src/index.js";
import { EXEMPTIONS } from "../src/compare.js";
import { answerOf, MAX_ANSWER_BYTES, requestText, unrepresentable, WasmHost, WASI_IMPORTS } from "../src/wasm/host.js";
import { CompilerFailure, DoorRefusal } from "../src/wasm/errors.js";
import { compileModuleBytes, compileModuleFile, modulePath } from "../src/wasm/module.js";
import { callsOf, CRATES, expectedOf } from "./calls.js";
import { MODULES } from "./wasm-bytes.js";

const path = modulePath();
const there = existsSync(path);
const needs = there ? describe : describe.skip;
if (!there) process.stdout.write(`host.test.ts: no module at ${path}; the tests of the Rust compiler's module are skipped (npm run build:wasm)\n`);

/** The sections of a module's binary, by id: the first of each. */
function sections(bytes: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  let at = 8;
  const leb = (): number => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[at++]!;
      n += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) return n;
    }
  };
  while (at < bytes.length) {
    const id = bytes[at++]!;
    const size = leb();
    if (!out.has(id)) out.set(id, bytes.subarray(at, at + size));
    at += size;
  }
  return out;
}

/** An unsigned LEB128 number at `at` of `b`, and where it ends. */
function readLeb(b: Uint8Array, at: number, signed = false): [number, number] {
  let n = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = b[at++]!;
    n += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  if (signed && byte & 0x40) n -= 2 ** shift;
  return [n, at];
}

/** The memory's limits: its first and its most pages. */
function memoryLimits(bytes: Uint8Array): { min: number; max: number | null } {
  const s = sections(bytes).get(5)!;
  const [count, a] = readLeb(s, 0);
  expect(count).toBe(1);
  const flag = s[a]!;
  const [min, b] = readLeb(s, a + 1);
  return { min, max: flag & 1 ? readLeb(s, b)[0] : null };
}

/** The first global's initial value: the stack pointer, an i32.const. */
function stackPointer(bytes: Uint8Array): number {
  const s = sections(bytes).get(6)!;
  const [, a] = readLeb(s, 0);
  expect([s[a], s[a + 1], s[a + 2]]).toEqual([0x7f, 0x01, 0x41]);
  return readLeb(s, a + 3, true)[0];
}

/** The output text of an answer `{"ok":true,"output":…}`, as the module wrote it. */
function outputText(run: { stdout: Uint8Array }): string {
  const text = Buffer.from(run.stdout).toString("utf8");
  const head = '{"ok":true,"output":';
  return text.startsWith(head) ? text.slice(head.length, -1) : `(not an output: ${text.slice(0, 200)})`;
}

/** Throws the failure of `f`, for `expect(...).toThrow`. */
function failureOf(f: () => unknown): CompilerFailure {
  try {
    f();
  } catch (e) {
    if (e instanceof CompilerFailure) return e;
    throw e;
  }
  throw new Error("no failure");
}

needs("the module", () => {
  const bytes = there ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const module = there ? compileModuleFile(path) : (undefined as unknown as WebAssembly.Module);

  it("imports exactly the seven functions of wasi_snapshot_preview1 the host serves, and nothing else", () => {
    expect(WebAssembly.Module.imports(module)).toEqual(WASI_IMPORTS.map((name) => ({ module: "wasi_snapshot_preview1", name, kind: "function" })));
  });

  it("exports its memory, _start and __main_void, and nothing else", () => {
    expect(WebAssembly.Module.exports(module)).toEqual([
      { name: "memory", kind: "memory" },
      { name: "_start", kind: "function" },
      { name: "__main_void", kind: "function" },
    ]);
  });

  it("has a memory of at most 4096 pages (256 MiB) and a stack of 4 MiB, first in memory: what build:wasm links", () => {
    const { min, max } = memoryLimits(bytes);
    expect(max).toBe(4096);
    expect(stackPointer(bytes)).toBe(4 * 1024 * 1024);
    expect(min).toBeGreaterThanOrEqual(64);
    expect(min).toBeLessThan(128);
  });

  describe("every recorded call of the doors", () => {
    const calls = CRATES.flatMap((crate) => {
      const expected = new Map(expectedOf(crate).map((e) => [e.name, e]));
      return callsOf(crate).map((c) => ({ ...c, expected: expected.get(c.name)! }));
    });
    // The host as the bridge runs it (random bytes for the seed of Rust's HashMap, fresh for each call), and three
    // fixed seeds: what each call answers may not depend on which.
    const fixed = (f: (i: number) => number) => (b: Uint8Array) => void b.forEach((_, i) => (b[i] = f(i)));
    const hosts = there
      ? {
          random: new WasmHost(module),
          zeros: new WasmHost(module, { random: fixed(() => 0) }),
          ones: new WasmHost(module, { random: fixed(() => 0xff) }),
          pattern: new WasmHost(module, { random: fixed((i) => (i * 37 + 11) & 0xff) }),
        }
      : undefined;
    const tables = EXEMPTIONS.find((e) => e.name === "versions-only-rust-reads")!;
    /** The answer texts of one request: twice under the random default, once under each fixed seed. */
    const answers = (request: Uint8Array): Array<[string, string]> =>
      (["random", "random", "zeros", "ones", "pattern"] as const).map((k) => [k, Buffer.from(hosts![k].run(request).stdout).toString("utf8")]);
    const seedless = (label: string, texts: Array<[string, string]>, wrong: string[]): void => {
      for (const [k, t] of texts.slice(1)) if (t !== texts[0]![1]) wrong.push(`${label}: the answer under the seed ${k} is not the one under random bytes`);
    };

    it(`gives the TypeScript's output, the same under random bytes for the seed (twice) and under three fixed seeds, byte for byte: ${calls.length} calls`, () => {
      const wrong: string[] = [];
      let changedByRule = 0;
      for (const c of calls) {
        const request = Buffer.from(requestText(c.door, c.input), "utf8");
        const texts = answers(request);
        seedless(c.name, texts, wrong);
        const runs = [{ stdout: Buffer.from(texts[0]![1], "utf8") }];
        if (c.expected.error) {
          const a = JSON.parse(texts[0]![1]) as { ok: boolean; error?: { kind: string } };
          if (a.ok !== false || a.error?.kind !== "bad_input") wrong.push(`${c.name}: not bad_input: ${texts[0]![1].slice(0, 200)}`);
          continue;
        }
        let out = outputText(runs[0]!);
        if (c.expected.output !== undefined ? out !== c.expected.output : sha(out) !== c.expected.sha256) {
          // The rules of the Rust's own (vectors/README.md, "The versions only the Rust compiler reads" and "The
          // codes only the Rust compiler has"; crates/mandate-testkit/src/rust_only.rs).
          const parsed = JSON.parse(out) as unknown;
          const as = c.door === "tables" ? tablesAsTypescript(parsed) : c.door === "codes" ? codesAsTypescript(parsed) : parsed;
          out = JSON.stringify(tables.normalize!(undefined, as, [], "check").rust);
          if (c.expected.output !== undefined ? out !== c.expected.output : sha(out) !== c.expected.sha256) wrong.push(`${c.name}: ${outputText(runs[0]!).slice(0, 300)}`);
          else changedByRule++;
        }
      }
      expect(wrong).toEqual([]);
      // The tables call and the codes call: as rust_only::PINNED pins them for these calls.
      expect(changedByRule).toBe(2);
      for (const h of Object.values(hosts!)) {
        expect(h.imported["clock_time_get"]).toBe(0);
        expect(h.imported["random_get"]).toBeGreaterThan(0);
      }
    }, 300_000);

    it("and so does every recorded case of the run-time authority decisions, through their doors", () => {
      const cases = JSON.parse(readFileSync(new URL("./authority-cases.json", import.meta.url), "utf8")) as Array<{ name: string; fn: string; input: unknown; output: unknown }>;
      const door: Record<string, string> = { grant: "grant", narrow: "narrow", mapScopes: "map_scopes", inFlightOverlap: "in_flight_overlap" };
      const wrong: string[] = [];
      for (const c of cases) {
        const texts = answers(Buffer.from(requestText(door[c.fn]!, { input: c.input }), "utf8"));
        seedless(`${c.fn}: ${c.name}`, texts, wrong);
        if (texts[0]![1] !== JSON.stringify({ ok: true, output: c.output })) wrong.push(`${c.fn}: ${c.name}: not the recorded output`);
      }
      expect(wrong).toEqual([]);
    }, 120_000);

    it("the seed is random by default: what random_get gives a module differs from call to call", () => {
      // A module that asks random_get for 32 bytes and writes them as its answer.
      const echo = new WasmHost(compileModuleBytes(MODULES.randomEcho(32)));
      const seen = Array.from({ length: 4 }, () => Buffer.from(echo.run(new Uint8Array()).stdout).toString("hex"));
      for (const s of seen) expect(s).toHaveLength(64);
      expect(new Set(seen).size).toBe(4);
      expect(seen).not.toContain("00".repeat(32));
      // A fixed fill stays one a test can give.
      const zeros = new WasmHost(compileModuleBytes(MODULES.randomEcho(32)), { random: (b) => void b.fill(0) });
      expect(Buffer.from(zeros.run(new Uint8Array()).stdout).toString("hex")).toBe("00".repeat(32));
      // A request for no bytes is answered with none.
      expect(new WasmHost(compileModuleBytes(MODULES.randomEcho(0))).run(new Uint8Array()).stopped).toBeUndefined();
    });
  });

  describe("each failure, produced for real and classified", () => {
    const host = (b: Uint8Array): WasmHost => new WasmHost(compileModuleBytes(b));

    it("a trap", () => {
      const f = failureOf(() => host(MODULES.trap()).call("check", {}));
      expect(f.kind).toBe("trap");
      expect(f.message).toContain("(unreachable)");
    });

    it("a panic, whose message (with the source paths of the machine that built the module) is not shown", () => {
      const f = failureOf(() => host(MODULES.panic()).call("check", {}));
      expect(f.kind).toBe("trap");
      expect(f.message).toContain("panicked");
      expect(f.message).not.toContain("/home/builder");
      expect(f.message).not.toContain("index out of bounds");
    });

    it("the memory ceiling, reached by a real request: an HTML page whose title is 8 MiB of '&'", () => {
      const f = failureOf(() => new WasmHost(module).call("to_html", { doc: { title: "&".repeat(8 * 1024 * 1024), meta: [], blocks: [] } }));
      expect(f.kind).toBe("out_of_memory");
      expect(f.message).not.toContain("memory allocation of");
    });

    it("the memory ceiling, as the module says it on its standard error", () => {
      expect(failureOf(() => host(MODULES.outOfMemory()).call("check", {})).kind).toBe("out_of_memory");
    });

    it("an exhausted stack", () => {
      expect(failureOf(() => host(MODULES.recursion()).call("check", {})).kind).toBe("stack_exhausted");
    });

    it("too much answer: more than 64 MiB stops the call", () => {
      const f = failureOf(() => host(MODULES.flood()).call("check", {}));
      expect(f.kind).toBe("output_too_large");
      expect(f.message).toContain(String(MAX_ANSWER_BYTES));
    });

    it("an exit with a status other than 0", () => {
      const f = failureOf(() => host(MODULES.exit3()).call("check", {}));
      expect(f.kind).toBe("exit_status");
      expect(f.message).toContain("status 3");
    });

    it("an answer cut short, an answer of another shape, no answer, and an answer beside a word on standard error", () => {
      for (const text of ['{"ok":true,"outp', '{"ok":true}', '{"ok":true,"output":1,"more":2}', '{"ok":false,"error":{"kind":"made-up","message":"x"}}', "[]", ""]) {
        expect(failureOf(() => host(MODULES.answering(text)).call("check", {})).kind, text).toBe("bad_answer");
      }
      expect(failureOf(() => host(MODULES.answeringAndSaying('{"ok":true,"output":1}')).call("check", {})).kind).toBe("bad_answer");
      expect(host(MODULES.answering('{"ok":true,"output":1}')).call("check", {})).toBe(1);
    });

    it("an answer that is not UTF-8", () => {
      expect(() => answerOf("check", { stdout: new Uint8Array([0x7b, 0xff, 0x7d]), stderr: new Uint8Array(), stderrBytes: 0, memoryBytes: 0 })).toThrow(/not UTF-8/);
    });

    it("an oversized request, refused by the module before it reads it", () => {
      const f = failureOf(() => new WasmHost(module).call("canonicalize", { value: "x".repeat(33_554_432) }));
      expect(f.kind).toBe("refused");
      expect(f.answerKind).toBe("too_large");
    });

    it("a request that is not JSON, and a door the module does not have", () => {
      const h = new WasmHost(module);
      expect(failureOf(() => answerOf("check", h.run(Buffer.from('{"door":"check","input":{}')))).answerKind).toBe("bad_request");
      expect(failureOf(() => h.call("nothing", {})).answerKind).toBe("unknown_door");
    });

    it("a door's refusal of its input is not a failure of the compiler: it is what the TypeScript throws on", () => {
      expect(() => new WasmHost(module).call("canonicalize", {})).toThrow(DoorRefusal);
    });

    it("an input the request cannot carry, never changed to fit", () => {
      for (const [v, why] of [
        [0.5, "the number 0.5"],
        [-0, "-0"],
        [2 ** 53, "the number 9007199254740992"],
        [Number.NaN, "the number NaN"],
        ["\ud800", "lone surrogate"],
        [{ ["\udc00"]: 1 }, "member name with a lone surrogate"],
        [new Map(), "a Map, not a plain object"],
        [new Set([1]), "a Set, not a plain object"],
        [() => 1, "a function"],
        [10n, "a bigint"],
        [undefined, "is undefined, which JSON would write as null"],
      ] as Array<[unknown, string]>) {
        const f = failureOf(() => new WasmHost(module).call("canonicalize", { value: { a: [v] } }));
        expect(f.kind).toBe("unrepresentable");
        expect(f.message).toContain(why);
        expect(f.message).toContain("/value/a/0");
      }
      // A hole in an array: the TypeScript and JSON.stringify read it otherwise (`[1,,2]`, `[1,null,2]`).
      // eslint-disable-next-line no-sparse-arrays
      expect(failureOf(() => new WasmHost(module).call("canonicalize", { value: [1, , 2] })).message).toContain("has a hole at 1");
      const cycle: Record<string, unknown> = {};
      cycle["self"] = cycle;
      expect(unrepresentable(cycle)).toContain("holds itself");
      let deep: unknown = 1;
      for (let i = 0; i < 200; i++) deep = [deep];
      expect(unrepresentable(deep)).toContain("deeper than the 128 levels");
      // The message names the kind of value and where it is, never a string's text.
      expect(failureOf(() => new WasmHost(module).call("canonicalize", { value: "secret words \ud800" })).message).not.toContain("secret words");
      expect(failureOf(() => new WasmHost(module).call("canonicalize", { value: 0.5 })).shown).toContain("the number 0.5");
    });

    it("an input is read once: what the request says of a member is what the member gave the one time it was read", () => {
      let reads = 0;
      const value = {
        get a(): number {
          reads++;
          return reads;
        },
      };
      expect(new WasmHost(module).call("canonicalize", { value })).toBe('{"a":1}');
      expect(reads).toBe(1);
      expect(requestText("canonicalize", { value: { b: [true, null, "x"], c: undefined, a: -3 } })).toBe(JSON.stringify({ door: "canonicalize", input: { value: { b: [true, null, "x"], a: -3 } } }));
    });
  });
});

describe("modules the host refuses, by name, from their bytes", () => {
  it("a missing module, which says how to build one, and shows a model nothing of where", () => {
    const f = failureOf(() => compileModuleFile(join(tmpdir(), "mandate-no-such-module.wasm")));
    expect(f.kind).toBe("module_missing");
    expect(f.message).toContain("npm run build:wasm");
    expect(f.shown).toBe("the Rust compiler failed (module_missing)");
  });

  it("a file that is not a module", () => {
    expect(failureOf(() => compileModuleBytes(new Uint8Array([0, 1, 2, 3]))).kind).toBe("module_invalid");
  });

  it.each([
    ["an eighth import", MODULES.extraImport, "imports wasi_snapshot_preview1.fd_close, which the host does not serve"],
    ["a memory without a maximum", MODULES.noCeiling, "has no maximum"],
    ["a maximum of 4097 pages", MODULES.highCeiling, "may grow to 4097 pages, past the 4096 pages"],
    ["a second memory", MODULES.twoMemories, "has 2 memories"],
    ["a shared memory", MODULES.sharedMemory, "memory is shared"],
    ["a memory of 64 bits", MODULES.memory64, "memory is of 64 bits"],
    ["a start function", MODULES.startFunction, "has a start function"],
  ])("%s", (_what, make, why) => {
    const f = failureOf(() => compileModuleBytes(make()));
    expect(f.kind).toBe("module_refused");
    expect(f.message).toContain(why);
  });

  it("a module the host has not read the bytes of", () => {
    const unread = new WebAssembly.Module(MODULES.trap() as Uint8Array<ArrayBuffer>);
    expect(failureOf(() => new WasmHost(unread)).message).toContain("whose bytes it has not read");
  });

  it("and, of a module it took, a call that names more buffers than it takes, or memory past the module's own", () => {
    for (const make of [MODULES.manyBuffers, MODULES.bufferPastMemory, MODULES.randomPastMemory]) {
      const f = failureOf(() => new WasmHost(compileModuleBytes(make())).call("check", {}));
      expect(f.kind).toBe("host_error");
    }
    expect(failureOf(() => new WasmHost(compileModuleBytes(MODULES.manyBuffers())).call("check", {})).message).toContain("17 buffers in one call; the host takes at most 16");
    expect(failureOf(() => new WasmHost(compileModuleBytes(MODULES.bufferPastMemory())).call("check", {})).message).toContain("past the end of its own");
  });

  it("an answer that grows past 64 MiB is stopped, and the host holds no more than that", () => {
    const run = new WasmHost(compileModuleBytes(MODULES.flood())).run(new Uint8Array());
    expect(run.stopped).toBeDefined();
    expect(run.stdout.length).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
  });
});

/** The `tables` output with the Rust's newest version as the TypeScript's (rust_only.rs, NEWEST_VERSION). */
function tablesAsTypescript(v: unknown): unknown {
  const o = { ...(v as Record<string, unknown>) };
  if (Array.isArray(o["LANGUAGE_VERSIONS"])) o["LANGUAGE_VERSIONS"] = (o["LANGUAGE_VERSIONS"] as string[]).filter((x) => x !== "mandate/0.6" && x !== "mandate/0.7");
  if (o["LANGUAGE_VERSION"] === "mandate/0.7") o["LANGUAGE_VERSION"] = "mandate/0.5";
  return o;
}

/**
 * The `codes` output without the rows only the Rust compiler has (rust_only.rs, RUST_CODES: the codes of 0.6, whose
 * reference is the Rust), read here as the rows the TypeScript's table lacks.
 */
function codesAsTypescript(v: unknown): unknown {
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => Object.hasOwn(TS_CODES, k)));
}

function sha(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
