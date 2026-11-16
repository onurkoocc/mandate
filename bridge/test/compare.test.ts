// How the Rust compiler's answers are held to the reference compiler's in the bridge's tests (test/compare.ts, which
// test/roundtrip.test.ts uses): what "the input is of language 0.6" means, and the named exemptions, each standing on
// an entry of vectors/README.md. Nothing of this is in the bridge itself: one compiler, the Rust's, answers.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareOutcomes, CompilerDivergence, EXEMPTIONS, exemptionCounts, LANGUAGE_06, takeDivergences, type Outcome } from "./compare.js";
import { DOOR_BACKED, type DoorBacked } from "../src/doors.js";
import { repoRoot } from "./tree.js";

const read = (p: string): string => readFileSync(join(repoRoot, p), "utf8");

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
