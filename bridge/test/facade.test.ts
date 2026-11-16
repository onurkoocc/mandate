// The facade (src/index.ts) and its switch (src/mode.ts): which functions the Rust compiler answers and which stay
// in TypeScript, the constants, how the exports follow the mode, `both` and its named exemptions, and what "the input
// is of language 0.6" means.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as compiler from "../../compiler/src/index.js";
import * as bridge from "../src/index.js";
import * as reference from "../src/ts.js";
import { compareOutcomes, CompilerDivergence, EXEMPTIONS, exemptionCounts, LANGUAGE_06, takeDivergences, type Outcome } from "../src/compare.js";
import { DOOR_BACKED, KEPT, RUST_ONLY, type DoorBacked } from "../src/doors.js";
import { compilerMode, withCompiler } from "../src/mode.js";
import { rustCall } from "../src/wasm/call.js";
import { CompilerFailure } from "../src/wasm/errors.js";
import { modulePath } from "../src/wasm/module.js";
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
    // An error class is a function too: NoReference is what a Rust-only function throws in `ts` mode, not a door.
    const neither = functions.filter((n) => n !== "NoReference" && !lists.some((l) => l.includes(n)));
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

describe("the exports follow the mode", () => {
  it(`in the mode the process runs in (${compilerMode()}), a door-backed function is ${compilerMode() === "ts" ? "the reference compiler's very function" : "the facade's"}`, () => {
    for (const n of Object.keys(DOOR_BACKED)) {
      if (compilerMode() === "ts") expect(exported[n], n).toBe((reference as unknown as Record<string, unknown>)[n]);
      else expect(exported[n], n).not.toBe((reference as unknown as Record<string, unknown>)[n]);
    }
    expect(bridge.CODES === compiler.CODES).toBe(compilerMode() === "ts");
  });

  it("a block under `ts` is the reference compiler's, and everything is put back after it, also when it throws", () => {
    const before = bridge.check;
    withCompiler("ts", () => {
      expect(bridge.check).toBe(reference.check);
      expect(compilerMode()).toBe("ts");
    });
    expect(bridge.check).toBe(before);
    expect(() =>
      withCompiler("ts", () => {
        throw new Error("inside");
      }),
    ).toThrow("inside");
    expect(bridge.check).toBe(before);
    expect(() => withCompiler("tss" as never, () => 1)).toThrow(/no compiler mode/);
  });

  it("the constants are the reference compiler's in every mode, but CODES", () => {
    for (const [n, v] of Object.entries(compiler)) if (typeof v !== "function" && n !== "CODES") expect(exported[n], n).toBe(v);
  });
});

needs("the facade on the Rust compiler", () => {
  const program = (): compiler.Program => compiler.check(read("fixtures/fixbug/fixbug.mdt"), "mdt").program!;

  it("a block under `rust` answers with the module, and a promise is waited for", async () => {
    const p = program();
    const ref = compiler.programRef(p);
    const ours = withCompiler("rust", () => {
      expect(bridge.programRef).not.toBe(reference.programRef);
      return bridge.programRef(p);
    });
    expect(ours).toEqual(ref);
    const later = await withCompiler("rust", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return compilerMode();
    });
    expect(later).toBe("rust");
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
        withCompiler("rust", () => bridge.programRef(program()), { module: bare });
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
    // only the Rust compiler reads"): the Rust's list has mandate/0.6 at its end, and its newest version is 0.6.
    expect(differ).toEqual(["LANGUAGE_VERSION", "LANGUAGE_VERSIONS"]);
    expect(tables["LANGUAGE_VERSIONS"]).toEqual([...compiler.LANGUAGE_VERSIONS, "mandate/0.6"]);
    expect([compiler.LANGUAGE_VERSION, tables["LANGUAGE_VERSION"]]).toEqual(["mandate/0.5", "mandate/0.6"]);
  });

  it("CODES outside `ts` is the Rust's table of codes, which has every row of the TypeScript's", () => {
    withCompiler("rust", () => {
      expect(bridge.CODES).not.toBe(compiler.CODES);
      for (const [k, v] of Object.entries(compiler.CODES)) expect(bridge.CODES[k], k).toEqual(v);
      expect(Object.keys(bridge.CODES)).toEqual(expect.arrayContaining(Object.keys(compiler.CODES)));
      expect("MDT-E0130" in bridge.CODES).toBe(true);
      expect(bridge.CODES["MDT-E9999"]).toBeUndefined();
      expect(bridge.CODES["toString" as never]).toBeUndefined();
      const entry = bridge.CODES["MDT-E0130"]!;
      expect({ code: "MDT-E0130", ...entry }).toEqual({ code: "MDT-E0130", ...compiler.CODES["MDT-E0130"] });
    });
  });

  describe("both", () => {
    it("gives the Rust's result when the two agree, and counts the call", () => {
      const before = exemptionCounts()["compared"]!;
      const p = program();
      expect(withCompiler("both", () => bridge.hashProgram(p as never))).toEqual(compiler.hashProgram(p as never));
      expect(exemptionCounts()["compared"]).toBe(before + 1);
    });

    it("throws a CompilerDivergence that names the function and shows both when the Rust answers otherwise, and keeps it", () => {
      takeDivergences();
      const wrong = MODULES.answering('{"ok":true,"output":{"module":"fixbug","version":"0.1.0","hash":"sha256:wrong"}}');
      let thrown: unknown;
      try {
        withCompiler("both", () => bridge.programRef(program()), { doors: { program_ref: wrong } });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(CompilerDivergence);
      expect((thrown as CompilerDivergence).fn).toBe("programRef");
      expect((thrown as Error).message).toContain("sha256:wrong");
      expect((thrown as Error).message).toContain(compiler.programRef(program()).hash);
      // Kept, so that a caller that catches it does not hide it: the test setup fails the test that made it.
      expect(takeDivergences()).toEqual([thrown]);
    });

    it("throws the Rust's failure as it is, never as an answer or a refusal", () => {
      const e = (() => {
        try {
          withCompiler("both", () => bridge.programRef(program()), { doors: { program_ref: MODULES.trap() } });
        } catch (x) {
          return x;
        }
      })();
      expect(e).toBeInstanceOf(CompilerFailure);
      expect(takeDivergences()).toEqual([]);
    });

    it("does not ask the TypeScript about an input of language 0.6, and counts it", () => {
      const before = exemptionCounts()["language-0.6"]!;
      const r = withCompiler("both", () => bridge.check(read("fixtures/library/minimal.mdt"), "mdt"));
      expect(r.ok).toBe(true);
      expect(r.program?.language).toBe("mandate/0.6");
      expect(exemptionCounts()["language-0.6"]).toBe(before + 1);
      expect(compiler.check(read("fixtures/library/minimal.mdt"), "mdt").diagnostics.map((d) => d.code)).toEqual(["MDT-E0103"]);
    });

    it("agrees when both throw: the TypeScript where the Rust's door refuses", () => {
      expect(() => withCompiler("both", () => bridge.toMarkdown({ title: 5 } as never))).toThrow();
      expect(takeDivergences()).toEqual([]);
    });
  });
});

describe("the input of language 0.6", () => {
  const p05 = { language: "mandate/0.5", module: "m", version: "0.1", defs: {} };
  const p06 = { ...p05, language: "mandate/0.6" };
  const lock06 = { lock: "mandate/lock/0.6", modules: {} };
  const tool = { ctor: "tool.call", effect: "Tool", write: false };

  it("is told by a program's language, a text's header, a lock's format or 0.6 members, a language parameter, a 0.6 constructor", () => {
    const yes: Array<[DoorBacked, unknown[]]> = [
      ["check", ["// a comment\nmandate @ 0.6\nmodule m", "mdt"]],
      ["check", [JSON.stringify(p06), "json"]],
      ["check", ["mandate @ 0.5\nmodule m", "mdt", { lock: lock06 }]],
      ["check", ["mandate @ 0.5\nmodule m", "mdt", { modules: { x: p06 } }]],
      ["load", ["mandate @ 0.6", undefined]],
      ["loadModules", [[{ file: "a", text: "mandate @ 0.6\nmodule a", kind: "mdt" }]]],
      ["hashProgram", [p06]],
      ["link", [p05, { x: p06 }]],
      ["validateLock", [{ lock: "mandate/lock/0.5", modules: {}, libraries: {} }]],
      ["domainHash", ["library", {}, "0.6"]],
      ["skeleton", ["m", 1, "mandate/0.6"]],
      ["checkSubprogram", [{ parent: p06 }]],
      ["semanticDiff", [p05, p06]],
      ["grant", [{ context: { bounds: [tool], given: [], handed: [] }, delegation: null }]],
      ["requirementFor", [{ agent: "a", def: "d" }, [], null, { language: "mandate/0.6" }]],
      ["cardDoc", [p05, "W", { lock: lock06 }]],
    ];
    for (const [fn, args] of yes) expect(LANGUAGE_06[fn](args), `${fn} ${JSON.stringify(args).slice(0, 80)}`).toBe(true);
    const no: Array<[DoorBacked, unknown[]]> = [
      ["check", ["mandate @ 0.5\nmodule m", "mdt"]],
      ["check", ["mandate @ 0.60\nmodule m", "mdt"]],
      ["check", [JSON.stringify(p05), "json"]],
      ["hashProgram", [p05]],
      ["toMarkdown", [{ title: "mandate @ 0.6", meta: [], blocks: [] }]],
      ["grant", [{ context: { bounds: [{ ...tool, ctor: "fs.read" }], given: [], handed: [] }, delegation: null }]],
    ];
    for (const [fn, args] of no) expect(LANGUAGE_06[fn](args), `${fn} ${JSON.stringify(args).slice(0, 80)}`).toBe(false);
  });

  it("has a rule for every door-backed function", () => {
    expect(Object.keys(LANGUAGE_06).sort()).toEqual(Object.keys(DOOR_BACKED).sort());
  });
});

describe("the named exemptions", () => {
  const counted = (name: string, f: () => void): number => {
    const before = exemptionCounts()[name]!;
    f();
    return exemptionCounts()[name]! - before;
  };
  const value = (v: unknown): Outcome => ({ value: v });

  it("each stands on an entry of vectors/README.md's list of where the Rust is not held to the TypeScript", () => {
    const readme = read("vectors/README.md");
    const list = readme.slice(readme.indexOf("## Where the Rust compiler is not held to the TypeScript"));
    const patchList = "KNOWN_PATCH_DIFFERENCES";
    const titles: Record<string, string> = {
      "versions-only-rust-reads": "The versions only the Rust compiler reads",
      "lone-surrogate-in-a-message": "A lone UTF-16 surrogate",
      "rendering-lone-surrogate": "A lone UTF-16 surrogate in a document",
      "patch-proto-token": patchList,
      "patch-path-not-text": patchList,
      "type-named-like-a-prototype-member": "THROWS_IN_TYPESCRIPT",
      "deepest-programs": "The deepest programs",
      "packaged-lock-astral-string": "KNOWN_DIFFERENCES",
      "timeout-not-a-number": "KNOWN_DIFFERENCES",
    };
    expect(EXEMPTIONS.map((e) => e.name).sort()).toEqual(Object.keys(titles).sort());
    for (const e of EXEMPTIONS) expect(list, e.name).toContain(titles[e.name]!);
  });

  it("versions-only-rust-reads: an E0103 that lists mandate/0.6, in its message and its facts, and only that", () => {
    const ts = { ok: false, diagnostics: [{ code: "MDT-E0103", message: `this compiler reads "mandate/0.4" or "mandate/0.5".`, facts: { expected: ["mandate/0.4", "mandate/0.5"], found: "mandate/0.9" } }] };
    const rust = { ok: false, diagnostics: [{ code: "MDT-E0103", message: `this compiler reads "mandate/0.4" or "mandate/0.5" or "mandate/0.6".`, facts: { expected: ["mandate/0.4", "mandate/0.5", "mandate/0.6"], found: "mandate/0.9" } }] };
    expect(counted("versions-only-rust-reads", () => compareOutcomes("check", [], value(ts), value(rust)))).toBe(1);
    const other = structuredClone(rust);
    other.diagnostics[0]!.facts.found = "mandate/0.8";
    expect(() => compareOutcomes("check", [], value(ts), value(other))).toThrow(CompilerDivergence);
    takeDivergences();
  });

  const diverges = (f: () => void): void => {
    expect(f).toThrow(CompilerDivergence);
    takeDivergences();
  };

  it("the lone surrogates: in a diagnostic's message of the TypeScript, and in a rendered document that held one", () => {
    const diag = (message: string): unknown => ({ ok: false, diagnostics: [{ code: "MDT-E0101", severity: "error", message }] });
    expect(counted("lone-surrogate-in-a-message", () => compareOutcomes("check", [], value(diag("found '\ud83d'")), value(diag("found '�'"))))).toBe(1);
    expect(counted("rendering-lone-surrogate", () => compareOutcomes("toHtml", [{ title: "\udc00", meta: [], blocks: [] }], value("<p>\udc00</p>"), value("<p>�</p>")))).toBe(1);
    // A lone surrogate in a member name, or anywhere but a diagnostic's message, is not this rule's.
    diverges(() => compareOutcomes("check", [], value({ ["\ud83d"]: 1 }), value({ ["�"]: 1 })));
    diverges(() => compareOutcomes("check", [], value({ ok: false, program: { name: "a\ud83d" } }), value({ ok: false, program: { name: "a�" } })));
    // A rendered document whose input held none is compared as it is.
    diverges(() => compareOutcomes("toHtml", [{ title: "t", meta: [], blocks: [] }], value("<p>\udc00</p>"), value("<p>�</p>")));
    diverges(() => compareOutcomes("toHtml", [], value("<p>a</p>"), value("<p>b</p>")));
  });

  describe("the patches", () => {
    const p = { language: "mandate/0.5" };
    const proto = { op: "add", path: "/defs/x/__proto__", value: {} };
    const other = { op: "add", path: "/defs/W/caps/-", value: "Anything" };
    const refuses = { value: { ok: false, diagnostics: [{ code: "MDT-E0301" }] } };
    const passes = { value: { ok: true, diagnostics: [] } };

    it("an add whose path ends in __proto__: excused when the Rust gives what the TypeScript gives for the patch without it", () => {
      const asked: unknown[][] = [];
      const again = (a: unknown[]): Outcome => (asked.push(a), passes);
      expect(counted("patch-proto-token", () => compareOutcomes("checkPatch", [p, "sha256:x", [proto, other], {}], refuses, passes, again))).toBe(1);
      expect(asked).toEqual([[p, "sha256:x", [other], {}]]);
      expect(counted("patch-proto-token", () => compareOutcomes("checkSubprogram", [{ parent: p, ops: [other, proto] }], refuses, passes, () => passes))).toBe(1);
    });

    it("but not when the patch without it still differs (the review's decoy), nor when the TypeScript is not asked again", () => {
      // One __proto__ add beside another operation that the TypeScript refuses and the Rust lets through.
      diverges(() => compareOutcomes("checkPatch", [{}, 1, [proto, other], {}], refuses, passes, () => refuses));
      diverges(() => compareOutcomes("checkPatch", [{}, 1, [other], {}], refuses, passes, () => refuses));
      diverges(() => compareOutcomes("checkPatch", [{}, 1, [proto, other], {}], refuses, passes));
    });

    it("a path that is not text: only its operation's E0131, its message's reason and its at.path, as the Rust writes them", () => {
      const e0131 = (message: string, at: object): unknown => ({ ok: false, diagnostics: [{ code: "MDT-E0131", severity: "error", message, at, docs: "mandate explain MDT-E0131", facts: { index: 1 } }], governance: [] });
      const ops = [other, { op: "add", path: 5, value: {} }];
      const ts = e0131("Patch operation 1 (add 5) failed: path.startsWith is not a function", { path: 5 });
      const rust = e0131("Patch operation 1 (add 5) failed: path must be a JSON Pointer starting with '/'", { path: "5" });
      expect(counted("patch-path-not-text", () => compareOutcomes("applyPatch", [p, "sha256:x", ops], value(ts), value(rust)))).toBe(1);
      const missing = [{ op: "add", value: {} }];
      const tsMissing = { ok: false, diagnostics: [{ code: "MDT-E0131", message: "Patch operation 0 (add undefined) failed: Cannot read properties of undefined (reading 'startsWith')", at: {}, facts: { index: 0 } }] };
      const rustMissing = { ok: false, diagnostics: [{ code: "MDT-E0131", message: "Patch operation 0 (add undefined) failed: path must be a JSON Pointer starting with '/'", at: { path: "undefined" }, facts: { index: 0 } }] };
      expect(counted("patch-path-not-text", () => compareOutcomes("checkPatch", [p, "sha256:x", missing], value(tsMissing), value(rustMissing)))).toBe(1);
      // Any other difference of the same call still diverges: another operation's result, the Rust passing.
      diverges(() => compareOutcomes("applyPatch", [p, "sha256:x", ops], value(ts), value({ ok: true, diagnostics: [], governance: [] })));
      diverges(() => compareOutcomes("applyPatch", [p, "sha256:x", ops], value({ ...(ts as object), governance: ["x"] }), value(rust)));
      // A diagnostic of an operation whose path is text is not this rule's.
      diverges(() => compareOutcomes("applyPatch", [p, "sha256:x", [other, other]], value(ts), value(rust)));
    });
  });

  describe("the TypeScript's throws", () => {
    const e0201 = (message: string): Outcome => ({ value: { ok: false, diagnostics: [{ code: "MDT-E0201", severity: "error", message, at: { path: "/defs/f/body/0/value" } }] } });
    const ir = JSON.stringify({ language: "mandate/0.1", module: "m", version: "0.1", defs: { toString: { kind: "type", type: { record: { a: { ref: "Int" } } } } } });

    it("a type named like a member of Object.prototype: the Rust's E0201 names it, the input defines it, and there is no other error", () => {
      expect(counted("type-named-like-a-prototype-member", () => compareOutcomes("check", [ir, "json"], { threw: new TypeError("x.includes is not a function") }, e0201("Expected Int but got toString.")))).toBe(1);
      expect(counted("type-named-like-a-prototype-member", () => compareOutcomes("check", ["mandate @ 0.4\nmodule m @ 0.1\ntype toString = { a: Int }\n", "mdt"], { threw: new TypeError("x") }, e0201("Expected Int but got toString.")))).toBe(1);
    });

    it("but not a word in a comment with the Rust passing (the review's case), nor an E0201 of another type, nor another error beside it", () => {
      const pass = { value: { ok: true, diagnostics: [], spans: new Map() } };
      const src = "mandate @ 0.4\n\n// the constructor of the report\nmodule t @ 0.1\n";
      diverges(() => compareOutcomes("check", [src], { threw: new TypeError("Cannot read properties of undefined (reading 'kind')") }, pass));
      diverges(() => compareOutcomes("check", [src.replace("constructor", "builder")], { threw: new TypeError("x") }, pass));
      diverges(() => compareOutcomes("check", [ir, "json"], { threw: new TypeError("x") }, e0201("Expected Int but got Text.")));
      const both = { value: { ok: false, diagnostics: [{ code: "MDT-E0201", severity: "error", message: "Expected Int but got toString." }, { code: "MDT-E0120", severity: "error", message: "x" }] } };
      diverges(() => compareOutcomes("check", [ir, "json"], { threw: new TypeError("x") }, both));
      diverges(() => compareOutcomes("check", ["type Foo = Int"], { threw: new TypeError("x") }, e0201("Expected Int but got toString.")));
    });

    it("the deepest programs: only an input as deep as the entry says, and a text nested past 64 only with the Rust's E0105", () => {
      const overflow = { threw: new RangeError("Maximum call stack size exceeded") };
      let deepIr: unknown = { ref: "Int" };
      for (let i = 0; i < 64; i++) deepIr = { list: deepIr };
      expect(counted("deepest-programs", () => compareOutcomes("check", [{ defs: { T: { kind: "type", type: deepIr } } }], overflow, value({ ok: true, diagnostics: [] })))).toBe(1);
      const deepText = `mandate @ 0.4\nmodule m @ 0.1\nconst c = ${"f(".repeat(3000)}1${")".repeat(3000)}\n`;
      const e0105 = { value: { ok: false, diagnostics: [{ code: "MDT-E0105", severity: "error", message: "nested too deep" }] } };
      expect(counted("deepest-programs", () => compareOutcomes("check", [deepText, "mdt"], overflow, e0105))).toBe(1);
      // A three-line program the TypeScript overflows on and the Rust passes (the review's case).
      diverges(() => compareOutcomes("check", ["mandate @ 0.4\n\nmodule t @ 0.1\n"], overflow, value({ ok: true, diagnostics: [], spans: new Map() })));
      // The deep text with the Rust passing it, no E0105.
      diverges(() => compareOutcomes("check", [deepText, "mdt"], overflow, value({ ok: true, diagnostics: [] })));
    });
  });

  it("the two of json_doors.rs: a lock that is a string outside the BMP, a time that is not a number", () => {
    expect(counted("packaged-lock-astral-string", () => compareOutcomes("packagedLock", ["a\u{1F600}"], value(1), value(2)))).toBe(1);
    expect(counted("packaged-lock-astral-string", () => compareOutcomes("packageHash", ["sha256:x", "a\u{1F600}"], value(1), value(2)))).toBe(1);
    expect(counted("timeout-not-a-number", () => compareOutcomes("sandboxRequirements", [{ defs: { A: { budget: { time: { ms: "20m" } } } } }], value(1), value(2)))).toBe(1);
    expect(counted("timeout-not-a-number", () => compareOutcomes("requirementFor", [{}, [], "20m"], value(1), { threw: new Error("bad_input") }))).toBe(1);
    expect(() => compareOutcomes("packagedLock", ["abc"], value(1), value(2))).toThrow(CompilerDivergence);
    takeDivergences();
  });

  it("excuse nothing else: another function, another shape, or one side throwing where a rule does not say so", () => {
    expect(() => compareOutcomes("hashProgram", [{}], value({ program: "a" }), value({ program: "b" }))).toThrow(CompilerDivergence);
    expect(() => compareOutcomes("hashProgram", [{}], { threw: new Error("x") }, value({}))).toThrow(CompilerDivergence);
    expect(() => compareOutcomes("checkSubprogram", [{}], { threw: new Error("a workflow with no envelope") }, { threw: new Error("another message") })).toThrow(CompilerDivergence);
    expect(() => compareOutcomes("link", [{}], value(new Map([["a", 1]])), value({ a: 1 }))).toThrow(CompilerDivergence);
    expect(() => compareOutcomes("link", [{}], value({ a: undefined }), value({}))).toThrow(CompilerDivergence);
    takeDivergences();
  });
});

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) yield* walk(join(dir, e.name));
    else if (e.name.endsWith(".ts")) yield join(dir, e.name);
  }
}
