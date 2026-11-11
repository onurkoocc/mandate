// The runner's own tests: the comparison and the patch applier.

import { describe, expect, it } from "vitest";
import { applyJsonPatch, caseFile, compareResult, schemaProblems, type CaseExpect, type Observed } from "./cases-runner.js";

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
