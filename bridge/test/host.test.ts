// The host of the Rust compiler's module (src/wasm/): what the module is (its imports, exports, memory and stack,
// pinned), that every recorded call of the two crates' doors gives through it the output the TypeScript gave
// (twice, and with random bytes for the seed of Rust's HashMap instead of zeros), and every way a call can fail,
// each produced for real and classified.
//
// It needs the module (`npm run build:wasm`): without it, in the default mode, these tests are skipped and say so;
// in `rust` and `both` the run does not start without it (test/compiler-setup.ts).

import { createHash, randomFillSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    const zeros = there ? new WasmHost(module) : undefined;
    const random = there ? new WasmHost(module, { random: (b) => void randomFillSync(b) }) : undefined;
    const tables = EXEMPTIONS.find((e) => e.name === "versions-only-rust-reads")!;

    it(`gives the TypeScript's output, twice, and the same with random bytes for the seed: ${calls.length} calls`, () => {
      const wrong: string[] = [];
      let changedByRule = 0;
      for (const c of calls) {
        const request = Buffer.from(requestText(c.door, c.input), "utf8");
        const runs = [zeros!.run(request), zeros!.run(request), random!.run(request)];
        const texts = runs.map((r) => Buffer.from(r.stdout).toString("utf8"));
        if (texts[1] !== texts[0] || texts[2] !== texts[0]) wrong.push(`${c.name}: the answer differs between runs`);
        if (c.expected.error) {
          const a = JSON.parse(texts[0]!) as { ok: boolean; error?: { kind: string } };
          if (a.ok !== false || a.error?.kind !== "bad_input") wrong.push(`${c.name}: not bad_input: ${texts[0]!.slice(0, 200)}`);
          continue;
        }
        let out = outputText(runs[0]!);
        if (c.expected.output !== undefined ? out !== c.expected.output : sha(out) !== c.expected.sha256) {
          // The one rule of the Rust's own (vectors/README.md, "The versions only the Rust compiler reads").
          const parsed = JSON.parse(out) as unknown;
          const n = tables.normalize!(undefined, c.door === "tables" ? tablesAsTypescript(parsed) : parsed);
          out = JSON.stringify(n.rust);
          if (c.expected.output !== undefined ? out !== c.expected.output : sha(out) !== c.expected.sha256) wrong.push(`${c.name}: ${outputText(runs[0]!).slice(0, 300)}`);
          else changedByRule++;
        }
      }
      expect(wrong).toEqual([]);
      // The tables call alone: as rust_only::PINNED pins it for these calls.
      expect(changedByRule).toBe(1);
      expect(zeros!.imported["clock_time_get"]).toBe(0);
      expect(zeros!.imported["random_get"]).toBeGreaterThan(0);
    }, 120_000);
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
      ] as Array<[unknown, string]>) {
        const f = failureOf(() => new WasmHost(module).call("canonicalize", { value: { a: [v] } }));
        expect(f.kind).toBe("unrepresentable");
        expect(f.message).toContain(why);
        expect(f.message).toContain("/value/a/0");
      }
      const cycle: Record<string, unknown> = {};
      cycle["self"] = cycle;
      expect(unrepresentable(cycle)).toContain("holds itself");
      let deep: unknown = 1;
      for (let i = 0; i < 200; i++) deep = [deep];
      expect(unrepresentable(deep)).toContain("deeper than the 128 levels");
      // The message names the kind of value, never a string's text.
      expect(failureOf(() => new WasmHost(module).call("canonicalize", { value: "secret words \ud800" })).message).not.toContain("secret words");
    });

    it("a missing module, which says how to build one", () => {
      const f = failureOf(() => compileModuleFile(`${path}.not-there`));
      expect(f.kind).toBe("module_missing");
      expect(f.message).toContain("npm run build:wasm");
      // What a model may be shown of it does not say where the module is on this machine.
      expect(f.shown).toBe("the Rust compiler failed (module_missing)");
      expect(failureOf(() => new WasmHost(module).call("canonicalize", { value: 0.5 })).shown).toContain("the number 0.5");
    });

    it("a file that is not a module", () => {
      expect(failureOf(() => compileModuleBytes(new Uint8Array([0, 1, 2, 3]))).kind).toBe("module_invalid");
    });

    it("a module with an eighth import, refused by its name", () => {
      const f = failureOf(() => compileModuleBytes(MODULES.extraImport()));
      expect(f.kind).toBe("module_refused");
      expect(f.message).toContain("wasi_snapshot_preview1.fd_close");
    });

    it("a module whose memory has no ceiling, or a higher one", () => {
      expect(failureOf(() => compileModuleBytes(MODULES.noCeiling())).kind).toBe("module_refused");
      expect(failureOf(() => compileModuleBytes(MODULES.highCeiling())).message).toContain("4096 pages");
    });
  });
});

/** The `tables` output with the Rust's newest version as the TypeScript's (rust_only.rs, NEWEST_VERSION). */
function tablesAsTypescript(v: unknown): unknown {
  const o = { ...(v as Record<string, unknown>) };
  if (Array.isArray(o["LANGUAGE_VERSIONS"])) o["LANGUAGE_VERSIONS"] = (o["LANGUAGE_VERSIONS"] as string[]).filter((x) => x !== "mandate/0.6");
  if (o["LANGUAGE_VERSION"] === "mandate/0.6") o["LANGUAGE_VERSION"] = "mandate/0.5";
  return o;
}

function sha(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
