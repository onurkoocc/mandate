// The facade (src/index.ts) and the block a test runs on another module (src/mode.ts): which functions the Rust
// compiler answers and which stay in TypeScript, the constants, and what the facade does with a module that fails.
// How the Rust's answers are held to the reference compiler's is test/compare.test.ts and test/roundtrip.test.ts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as compiler from "../../compiler/src/index.js";
import * as bridge from "../src/index.js";
import * as rust from "../src/rust.js";
import * as reference from "../src/ts.js";
import { DOOR_BACKED, KEPT, RUST_ONLY } from "../src/doors.js";
import { withCompiler } from "../src/mode.js";
import { rustCall } from "../src/wasm/call.js";
import { CompilerFailure } from "../src/wasm/errors.js";
import { modulePath } from "../src/wasm/module.js";
import { RUST_ONLY_LANGUAGES } from "./compare.js";
import { repoRoot } from "./tree.js";
import { MODULES } from "./wasm-bytes.js";

const there = existsSync(modulePath());
const needs = there ? describe : describe.skip;
const read = (p: string): string => readFileSync(join(repoRoot, p), "utf8");
const exported = bridge as unknown as Record<string, unknown>;

describe("what the Rust compiler answers and what stays in TypeScript", () => {
  const functions = Object.keys(bridge).filter((n) => typeof exported[n] === "function");

  it("every function the bridge exports is door-backed, Rust-only (0.6) or kept in TypeScript with a reason, in one list alone", () => {
    const lists = [Object.keys(DOOR_BACKED), Object.keys(RUST_ONLY), Object.keys(KEPT)];
    const neither = functions.filter((n) => !lists.some((l) => l.includes(n)));
    expect(neither, "a function with no door and no reason to stay in TypeScript").toEqual([]);
    const all = lists.flat();
    expect(all.filter((n, i) => all.indexOf(n) !== i)).toEqual([]);
    for (const n of all) expect(functions, n).toContain(n);
    for (const [n, k] of Object.entries(KEPT)) expect(Object.values(k)[0]!.length, n).toBeGreaterThan(10);
  });

  it("each door-backed function has its TypeScript counterpart in ts.ts, with as many parameters as its door takes", () => {
    for (const [n, d] of Object.entries(DOOR_BACKED)) {
      const f = (reference as unknown as Record<string, (...a: unknown[]) => unknown>)[n];
      expect(typeof f, n).toBe("function");
      expect(f!.length, n).toBeLessThanOrEqual(d.params.length);
    }
    expect(Object.keys(reference).sort()).toEqual(Object.keys(DOOR_BACKED).sort());
  });

  it("no function kept because nothing calls it is called by the runtime, the command line or the MCP server", () => {
    const uncalled = new Set(Object.entries(KEPT).filter(([, k]) => "uncalled" in k).map(([n]) => n));
    const found: string[] = [];
    const files = [...walk(join(repoRoot, "runtime", "src")), join(repoRoot, "bridge", "src", "cli.ts"), join(repoRoot, "bridge", "src", "mcp.ts")];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && ["@mandate/bridge", "./index.js"].includes(node.moduleSpecifier.text)) {
          const b = node.importClause?.namedBindings;
          if (b && ts.isNamedImports(b)) for (const el of b.elements) if (!el.isTypeOnly && uncalled.has((el.propertyName ?? el.name).text)) found.push(`${relative(repoRoot, file)}: ${(el.propertyName ?? el.name).text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(found, "give these a door, or a reason to stay in TypeScript").toEqual([]);
  });

  it("the helpers the runtime and the command line do call are on the list as helpers", () => {
    for (const n of ["kindOf", "calleePath", "atLeast", "classRank", "budgetAmount", "formatDiagnostic", "hasErrors", "globRegExp"]) expect(KEPT[n], n).toHaveProperty("helper");
  });
});

describe("the exports", () => {
  it("a door-backed function is the facade's very function (src/rust.ts), never the reference compiler's, and CODES is the Rust's table", () => {
    for (const n of Object.keys(DOOR_BACKED)) {
      expect(exported[n], n).toBe((rust as unknown as Record<string, unknown>)[n]);
      expect(exported[n], n).not.toBe((reference as unknown as Record<string, unknown>)[n]);
    }
    expect(bridge.CODES).not.toBe(compiler.CODES);
  });

  it("the constants are the reference compiler's, but CODES", () => {
    for (const [n, v] of Object.entries(compiler)) if (typeof v !== "function" && n !== "CODES") expect(exported[n], n).toBe(v);
  });
});

needs("the facade on the Rust compiler", () => {
  const program = (): compiler.Program => compiler.check(read("fixtures/fixbug/fixbug.mdt"), "mdt").program!;

  it("a block on another module answers with it, puts everything back after it, also when it throws, and a promise is waited for", async () => {
    const p = program();
    const ref = compiler.programRef(p);
    const wrong = MODULES.answering('{"ok":true,"output":{"module":"fixbug","version":"0.1.0","hash":"sha256:wrong"}}');
    expect(bridge.programRef(p)).toEqual(ref);
    expect(withCompiler(() => bridge.programRef(p), { doors: { program_ref: wrong } })).toEqual({ module: "fixbug", version: "0.1.0", hash: "sha256:wrong" });
    expect(bridge.programRef(p)).toEqual(ref);
    expect(() =>
      withCompiler(() => {
        throw new Error("inside");
      }, { doors: { program_ref: wrong } }),
    ).toThrow("inside");
    expect(bridge.programRef(p)).toEqual(ref);
    const later = await withCompiler(
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return bridge.programRef(p).hash;
      },
      { doors: { program_ref: wrong } },
    );
    expect(later).toBe("sha256:wrong");
    expect(bridge.programRef(p)).toEqual(ref);
  });

  it("checks the module's table of doors when it loads it: every door the facade calls, with the parameters it sends", () => {
    const table = rustCall("doors", {}) as { doors: Array<{ name: string; ts: string | null; params: string[] }> };
    for (const [n, d] of Object.entries(DOOR_BACKED)) expect(table.doors.find((r) => r.name === d.door), n).toEqual(expect.objectContaining({ ts: n, params: d.params }));
    // A Rust-only door stands for no TypeScript function.
    for (const [n, d] of Object.entries(RUST_ONLY)) expect(table.doors.find((r) => r.name === d.door), n).toEqual(expect.objectContaining({ ts: null, params: d.params }));
    // A module whose table lacks them answers no call.
    const bare = MODULES.answering('{"ok":true,"output":{"format":"mandate/doors/0.1","doors":[]}}');
    const e = (() => {
      try {
        withCompiler(() => bridge.programRef(program()), { module: bare });
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(CompilerFailure);
    expect((e as CompilerFailure).kind).toBe("doors_mismatch");
    expect((e as CompilerFailure).message).toContain("program_ref is not in it");
  });

  it("the constants equal the `tables` door's output, but for the two rules of the versions only the Rust reads", () => {
    const tables = rustCall("tables", {}) as Record<string, unknown>;
    const values = Object.fromEntries(Object.entries(compiler).filter(([, v]) => typeof v !== "function"));
    // The door gives them in the order of their names, by UTF-16 code unit.
    expect(Object.keys(tables)).toEqual(Object.keys(values).sort());
    const differ: string[] = [];
    for (const [n, v] of Object.entries(values)) {
      const ours = JSON.stringify(v, (_k, x: unknown) => (x instanceof Set ? [...x] : x instanceof Map ? Object.fromEntries(x) : x));
      if (ours !== JSON.stringify(tables[n])) differ.push(n);
    }
    // KNOWN_VERSIONS and NEWEST_VERSION of crates/mandate-testkit/src/rust_only.rs (vectors/README.md, "The versions
    // only the Rust compiler reads"): the Rust's list has the versions only it reads (mandate/0.6 and mandate/0.7,
    // test/compare.ts's RUST_ONLY_LANGUAGES, which this holds to the Rust's) at its end, and its newest version is the
    // last of them, 0.7.
    expect(differ).toEqual(["LANGUAGE_VERSION", "LANGUAGE_VERSIONS"]);
    expect(RUST_ONLY_LANGUAGES).toEqual(["mandate/0.6", "mandate/0.7"]);
    expect(tables["LANGUAGE_VERSIONS"]).toEqual([...compiler.LANGUAGE_VERSIONS, ...RUST_ONLY_LANGUAGES]);
    expect([compiler.LANGUAGE_VERSION, tables["LANGUAGE_VERSION"]]).toEqual(["mandate/0.5", RUST_ONLY_LANGUAGES.at(-1)]);
  });

  it("CODES is the Rust's table of codes, which has every row of the TypeScript's", () => {
    expect(bridge.CODES).not.toBe(compiler.CODES);
    for (const [k, v] of Object.entries(compiler.CODES)) expect(bridge.CODES[k], k).toEqual(v);
    expect(Object.keys(bridge.CODES)).toEqual(expect.arrayContaining(Object.keys(compiler.CODES)));
    expect("MDT-E0130" in bridge.CODES).toBe(true);
    expect(bridge.CODES["MDT-E9999"]).toBeUndefined();
    expect(bridge.CODES["toString" as never]).toBeUndefined();
    const entry = bridge.CODES["MDT-E0130"]!;
    expect({ code: "MDT-E0130", ...entry }).toEqual({ code: "MDT-E0130", ...compiler.CODES["MDT-E0130"] });
  });

  it("throws the module's failure as it is, never as an answer or a refusal", () => {
    const e = (() => {
      try {
        withCompiler(() => bridge.programRef(program()), { doors: { program_ref: MODULES.trap() } });
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(CompilerFailure);
  });

  it("reads a program of language 0.6, which the reference compiler refuses (E0103)", () => {
    const r = bridge.check(read("fixtures/library/minimal.mdt"), "mdt");
    expect(r.ok).toBe(true);
    expect(r.program?.language).toBe("mandate/0.6");
    expect(compiler.check(read("fixtures/library/minimal.mdt"), "mdt").diagnostics.map((d) => d.code)).toEqual(["MDT-E0103"]);
  });

  it("a document its door refuses is an Error", () => {
    expect(() => bridge.toMarkdown({ title: 5 } as never)).toThrow();
  });
});

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) yield* walk(join(dir, e.name));
    else if (e.name.endsWith(".ts")) yield join(dir, e.name);
  }
}
