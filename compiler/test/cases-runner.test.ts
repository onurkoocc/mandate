// The runner's own tests: the comparison, the patch applier and the reading of a subprogram case.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "../src/check.js";
import { skeleton } from "../src/check/subprogram.js";
import { hashProgram } from "../src/hash.js";
import type { Program } from "../src/ir/types.js";
import type { Json } from "../src/json/strict-json.js";
import { applyJsonPatch, CASES_DIR, caseFile, compareResult, runCompileCase, schemaProblems, subprogramInput, type Case, type CaseExpect, type CaseSubprogram, type Observed } from "./cases-runner.js";

function got(...ds: Array<[string, string, Record<string, unknown>?]>): Observed {
  return { ok: false, diagnostics: ds.map(([code, path, facts]) => ({ code, at: { path }, ...(facts ? { facts } : {}) })) };
}

const A = { code: "MDT-E0101", path: "/a" };
const B = { code: "MDT-E0102", path: "/b" };
const base = (...diagnostics: CaseExpect["diagnostics"]): CaseExpect => ({ ok: false, diagnostics });

describe("compareResult", () => {
  it("accepts an exact match, ignoring message and span", () => {
    const o = got(["MDT-E0101", "/a"], ["MDT-E0102", "/b"]);
    (o.diagnostics[0] as Record<string, unknown>)["message"] = "anything";
    expect(compareResult(base(A, B), o)).toEqual([]);
  });

  it("refuses a missing diagnostic", () => {
    expect(compareResult(base(A, B), got(["MDT-E0101", "/a"]))).toEqual(["diagnostic 1: missing MDT-E0102 at \"/b\""]);
  });

  it("refuses an extra diagnostic", () => {
    expect(compareResult(base(A), got(["MDT-E0101", "/a"], ["MDT-E0102", "/b"]))).toEqual(["diagnostic 1: unexpected MDT-E0102 at \"/b\""]);
  });

  it("refuses a wrong order", () => {
    expect(compareResult(base(A, B), got(["MDT-E0102", "/b"], ["MDT-E0101", "/a"])).length).toBeGreaterThan(0);
  });

  it("refuses a wrong path", () => {
    expect(compareResult(base(A), got(["MDT-E0101", "/x"]))).toHaveLength(1);
  });

  it("refuses a wrong ok", () => {
    expect(compareResult({ ok: true, diagnostics: [] }, { ok: false, diagnostics: [] })).toHaveLength(1);
  });

  it("refuses a fact with a different value, and a missing one", () => {
    const want = base({ ...A, facts: { found: "x", deep: { n: [1, 2] } } });
    expect(compareResult(want, got(["MDT-E0101", "/a", { found: "y", deep: { n: [1, 2] } }]))).toHaveLength(1);
    expect(compareResult(want, got(["MDT-E0101", "/a", { found: "x", deep: { n: [1, 3] } }]))).toHaveLength(1);
    expect(compareResult(want, got(["MDT-E0101", "/a"]))).toHaveLength(2);
  });

  it("accepts extra fact keys", () => {
    const want = base({ ...A, facts: { found: "x" } });
    expect(compareResult(want, got(["MDT-E0101", "/a", { found: "x", more: 1 }]))).toEqual([]);
  });

  it("compares hashes exactly when given", () => {
    const want: CaseExpect = { ok: true, diagnostics: [], hashes: { program: "h", defs: { T: "d" } } };
    expect(compareResult(want, { ok: true, diagnostics: [], hashes: { program: "h", defs: { T: "d" } } })).toEqual([]);
    expect(compareResult(want, { ok: true, diagnostics: [], hashes: { program: "h", defs: { T: "d", U: "e" } } })).toHaveLength(1);
  });
});

describe("applyJsonPatch", () => {
  const doc = { a: { "b/c": [1, 2], "m~n": 0 }, list: ["x", "y"] };

  it("replaces, adds and removes, with ~0 and ~1 escapes", () => {
    const out = applyJsonPatch(doc, [
      { op: "replace", path: "/a/b~1c/0", value: 9 },
      { op: "add", path: "/a/new", value: true },
      { op: "remove", path: "/a/m~0n" },
    ]);
    expect(out).toEqual({ a: { "b/c": [9, 2], new: true }, list: ["x", "y"] });
    expect(doc.a["m~n"]).toBe(0);
  });

  it("appends with - and inserts by index", () => {
    expect(applyJsonPatch(doc, [{ op: "add", path: "/list/-", value: "z" }, { op: "add", path: "/list/0", value: "w" }])).toEqual({ ...doc, list: ["w", "x", "y", "z"] });
  });

  it("refuses other ops, missing targets and a bad index", () => {
    expect(() => applyJsonPatch(doc, [{ op: "move", path: "/a", from: "/list" } as never])).toThrow(/not supported/);
    expect(() => applyJsonPatch(doc, [{ op: "replace", path: "/a/zzz", value: 1 }])).toThrow(/no member/);
    expect(() => applyJsonPatch(doc, [{ op: "remove", path: "/list/5" }])).toThrow(/out of range/);
    expect(() => applyJsonPatch(doc, [{ op: "add", path: "/list/x", value: 1 }])).toThrow(/array index/);
  });
});

describe("case files", () => {
  it("refuses a path that leaves the repository or is absolute", () => {
    expect(() => caseFile("/", "x")).toThrow(/leaves the repository/);
    expect(() => caseFile(process.cwd(), "../../../../../../../../etc/passwd")).toThrow(/leaves the repository/);
    expect(() => caseFile(process.cwd(), "/etc/passwd")).toThrow(/absolute/);
  });

  it("refuses a case.json that does not match the schema", () => {
    expect(schemaProblems({ format: "mandate/conformance-case/0.1" }).length).toBeGreaterThan(0);
    const ok = {
      format: "mandate/conformance-case/0.1", id: "S01", kind: "compile", title: "t", spec: ["spec/ir.md"],
      input: { text: "{}", kind: "json" }, expect: { ok: false, diagnostics: [] },
    };
    expect(schemaProblems(ok)).toEqual([]);
    expect(schemaProblems({ ...ok, extra: 1 }).length).toBeGreaterThan(0);
    expect(schemaProblems({ ...ok, input: { file: "a", text: "b", kind: "json" } }).length).toBeGreaterThan(0);
    expect(schemaProblems({ ...ok, id: "s1" }).length).toBeGreaterThan(0);
    expect(schemaProblems({ ...ok, patch: [{ op: "move", path: "/a" }] }).length).toBeGreaterThan(0);
  });
});

describe("subprogram cases", () => {
  const ROOM = { left: { tokens: 50000, steps: 100, agents: 10, "spend:USD": 10000000 }, time_left_ms: 1800000 };
  /** A subprogram case on the parent and sub-program of N01a, with `sub` merged into its subprogram member. */
  const subCase = (sub: Partial<CaseSubprogram> = {}, extra: Partial<Case> = {}): Case => ({
    format: "mandate/conformance-case/0.1", id: "N01a", kind: "compile", title: "t", spec: ["spec/envelope.md#the-sub-program"],
    input: { file: "../N01/parent.mdt", kind: "mdt" }, modules: ["../N01/domain.mdt"],
    subprogram: { workflow: "Run", defs: { file: "sub.mdt", kind: "mdt" }, room: ROOM, ...sub },
    expect: { ok: false, diagnostics: [] },
    ...extra,
  });
  const parent = (): Program => load(readFileSync(join(CASES_DIR, "N01", "parent.mdt"), "utf8"), "mdt").program!;
  const input = (sub: Partial<CaseSubprogram> = {}): ReturnType<typeof subprogramInput> =>
    subprogramInput(join(CASES_DIR, "N01a"), { workflow: "Run", defs: { file: "sub.mdt", kind: "mdt" }, room: ROOM, ...sub }, parent(), {});

  it("is number 1 with a public lead when the case does not say, on the skeleton of that number", () => {
    const i = input();
    expect(i.number).toBe(1);
    expect(i.lead).toBe("public");
    expect(i.base).toBe(hashProgram(skeleton("example.parent", 1) as unknown as Json).program);
    expect(i.room).toEqual({ ...ROOM, writes: [] });
    const two = input({ number: 2, lead: "internal" });
    expect([two.number, two.lead, two.base]).toEqual([2, "internal", hashProgram(skeleton("example.parent", 2) as unknown as Json).program]);
  });

  it("adds each definition of defs in order, then appends patch as it is written", () => {
    const i = input({ patch: [{ op: "remove", path: "/defs/Wa" }] });
    expect(i.ops.map((o) => [o.op, o.path])).toEqual([["add", "/defs/Wa"], ["add", "/defs/Fix"], ["remove", "/defs/Wa"]]);
    expect((i.ops[1]!.value as { kind: string }).kind).toBe("workflow");
  });

  it("turns a write in flight into a capability that reaches the check", () => {
    const writes = [{ ctor: "fs.write", scope: ["/work/a/src"] }];
    expect(input({ room: { ...ROOM, writes } }).room.writes).toEqual([{ ctor: "fs.write", effect: "Fs.Write", write: true, scope: ["/work/a/src"] }]);
    // The sub-program of N01a writes /work/a: with this much left it fits, and the write in flight is in its way.
    const left = { ...ROOM.left, tokens: 50001 };
    expect(runCompileCase("N01a", subCase({ room: { ...ROOM, left } })).ok).toBe(true);
    const r = runCompileCase("N01a", subCase({ room: { ...ROOM, left, writes } }));
    expect(r.diagnostics.map((d) => [d.code, d.at.path, d.facts?.["dimension"]])).toEqual([["MDT-E1706", "/defs/Fix/caps/2", "write_scope"]]);
  });

  it("refuses a constructor that is no write capability, and defs that do not load", () => {
    expect(() => input({ room: { ...ROOM, writes: [{ ctor: "fs.read", scope: ["/work"] }] } })).toThrow(/not a write capability constructor/);
    expect(() => input({ room: { ...ROOM, writes: [{ ctor: "fs.nothing", scope: [] }] } })).toThrow(/not a write capability constructor/);
    expect(() => input({ defs: { text: "workflow {", kind: "mdt" } })).toThrow(/defs of a subprogram case must load/);
  });

  it("refuses a parent that does not check", () => {
    const broken = "mandate @ 0.4\n\nmodule example.parent @ 0.1\n\nfn f() -> Text {\n  missing\n}\n";
    expect(() => runCompileCase("N01a", subCase({}, { input: { text: broken, kind: "mdt" } }))).toThrow(/parent of a subprogram case must check without errors/);
  });

  it("refuses a top-level patch or lock beside a subprogram, in the schema and in the runner", () => {
    const withPatch = subCase({}, { patch: [{ op: "remove", path: "/defs/label" }] });
    expect(schemaProblems(subCase()).length).toBe(0);
    expect(schemaProblems(withPatch).length).toBeGreaterThan(0);
    expect(schemaProblems(subCase({}, { lock: null })).length).toBeGreaterThan(0);
    expect(() => runCompileCase("N01a", withPatch)).toThrow(/no top-level patch or lock/);
  });

  it("keeps the subprogram member closed", () => {
    expect(schemaProblems(subCase({ extra: 1 } as Partial<CaseSubprogram>)).length).toBeGreaterThan(0);
    expect(schemaProblems(subCase({ lead: "secret" as never })).length).toBeGreaterThan(0);
    expect(schemaProblems(subCase({ room: { left: { tokens: -1 } } })).length).toBeGreaterThan(0);
    expect(schemaProblems(subCase({ room: { ...ROOM, writes: [{ ctor: "fs.read", scope: [] }] } })).length).toBeGreaterThan(0);
  });
});
