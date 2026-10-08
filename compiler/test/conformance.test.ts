// Conformance cases about representation (Doc 4 §25): S01, S02, S03, S10,
// S11, S12. The static cases (S04–S08, V01–V08) are in static.test.ts.

import { describe, expect, it } from "vitest";
import { check, load } from "../src/check.js";
import { hashProgram } from "../src/hash.js";
import type { Program } from "../src/ir/types.js";
import type { Json } from "../src/json/strict-json.js";
import { applyPatch } from "../src/patch/patch.js";
import { checkJson, codes, minimal } from "./helpers.js";

describe("S01 duplicate JSON key", () => {
  it("is rejected before schema validation", () => {
    const text = `{"language":"mandate/0.1","module":"m","version":"0.1","defs":{},"defs":{}}`;
    const r = check(text, "json");
    expect(r.ok).toBe(false);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0102"]);
    expect(r.diagnostics[0]!.at.path).toBe("/defs");
    expect(r.diagnostics[0]!.at.span?.[0]).toBe(1);
  });

  it("is rejected inside nested objects too", () => {
    const text = `{"language":"mandate/0.1","module":"m","version":"0.1",
      "defs":{"T":{"kind":"type","type":{"ref":"Text","ref":"Int"}}}}`;
    const r = check(text, "json");
    expect(codes(r.diagnostics)).toEqual(["MDT-E0102"]);
    expect(r.diagnostics[0]!.at.path).toBe("/defs/T/type/ref");
  });
});

describe("S02 unknown field or language version", () => {
  it("rejects an unknown language version explicitly", () => {
    const r = checkJson({ ...minimal(), language: "mandate/0.2" });
    expect(codes(r.diagnostics)).toEqual(["MDT-E0103"]);
    expect(r.diagnostics[0]!.facts).toMatchObject({ expected: "mandate/0.1", found: "mandate/0.2" });
  });

  it("rejects a missing language field", () => {
    const p = minimal();
    delete p["language"];
    expect(codes(checkJson(p).diagnostics)).toEqual(["MDT-E0103"]);
  });

  it("rejects an unknown top-level field instead of ignoring it", () => {
    const r = checkJson({ ...minimal(), extensions: {} });
    expect(codes(r.diagnostics)).toEqual(["MDT-E0104"]);
    expect(r.diagnostics[0]!.at.path).toBe("/extensions");
  });

  it("rejects an unknown field deep inside a definition", () => {
    const p = minimal();
    p["defs"] = { Greeting: { kind: "type", type: { ref: "Text", nullable: true } } };
    const r = checkJson(p);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.at.path)).toContain("/defs/Greeting/type/nullable");
  });

  it("rejects an unknown definition kind", () => {
    const p = minimal();
    p["defs"] = { X: { kind: "macro" } };
    const r = checkJson(p);
    expect(codes(r.diagnostics)).toContain("MDT-E0104");
  });
});

describe("S03 reference to a missing node", () => {
  const src = (body: string): string => `module m @ 0.1\nuse company.domain.{Issue}\n${body}\n`;

  it("reports an unknown type with a repair when one name is close", () => {
    const r = check(src("type Finding = { file: Pathh }"), "mdt");
    expect(codes(r.diagnostics)).toEqual(["MDT-E0120"]);
    const d = r.diagnostics[0]!;
    expect(d.at.path).toBe("/defs/Finding/type/record/file/ref");
    expect(d.at.span?.[0]).toBe(3);
    expect(d.facts).toMatchObject({ name: "Pathh", did_you_mean: "Path" });
    expect(d.repair?.[0]?.patch[0]).toEqual({ op: "replace", path: "/defs/Finding/type/record/file/ref", value: "Path" });
  });

  it("reports unknown capabilities, agents, skills, contracts and variables", () => {
    const r = check(
      src(`
capability Read = fs.read("/repo")
agent A {
  caps Read, Writ
  skill go(i: Issue) -> Inferred<Text> ! {Model}
}
workflow W(issue: Issue) -> Text
  caps Read
{
  let a = delegate A.goo(issue)
  let b = delegate B.go(issue)
  let c = verify a against Missing(issue)
  isue
}`),
      "mdt",
    );
    const byName = Object.fromEntries(r.diagnostics.map((d) => [String(d.facts?.["name"]), d]));
    expect(Object.keys(byName).sort()).toEqual(["B", "Missing", "Writ", "fs", "goo", "isue"].sort());
    expect(byName["Writ"]!.facts?.["expected"]).toBe("capability");
    expect(byName["goo"]!.facts?.["did_you_mean"]).toBe("go");
    expect(byName["isue"]!.facts?.["did_you_mean"]).toBe("issue");
    expect(r.diagnostics.every((d) => d.code === "MDT-E0120")).toBe(true);
  });

  it("does not let par branches see each other", () => {
    const r = check(
      src(`
agent A {
  skill go(i: Issue) -> Inferred<Text> ! {Model}
}
workflow W(issue: Issue) -> Text
  caps A
{
  par {
    x = delegate A.go(issue)
    y = delegate A.go(x)
  }
  y
}`),
      "mdt",
    );
    // `caps A` names an agent, not a capability; `x` is not visible to the sibling branch.
    expect(r.diagnostics.map((d) => d.facts?.["name"]).sort()).toEqual(["A", "x"]);
  });

  it("checks the JSON IR the same way as text", () => {
    const p = minimal();
    p["defs"] = { Greeting: { kind: "type", type: { ref: "Txt" } } };
    const r = checkJson(p);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0120"]);
    expect(r.diagnostics[0]!.at.span).toBeDefined();
  });
});

describe("S10 key order does not change the hash", () => {
  it("hashes two key orders of the same program identically", () => {
    const a = `{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"A":{"kind":"type","type":{"ref":"Text"}},"B":{"kind":"type","type":{"ref":"Int"}}}}`;
    const b = `{"defs":{"B":{"type":{"ref":"Int"},"kind":"type"},"A":{"type":{"ref":"Text"},"kind":"type"}},"version":"0.1","module":"m","language":"mandate/0.1"}`;
    const ra = check(a, "json");
    const rb = check(b, "json");
    expect(ra.ok && rb.ok).toBe(true);
    expect(ra.hashes!.program).toBe(rb.hashes!.program);
    expect(ra.hashes!.defs).toEqual(rb.hashes!.defs);
  });

  it("hashes text written in a different order identically", () => {
    const a = `module m @ 0.1
use std.{fs, net}
capability R = fs.read("/a")
type T = { x: Int, y: Text }
agent A {
  caps R
  skill s(t: T) -> Inferred<T> ! {Model, Fs.Read}
}`;
    const b = `module m @ 0.1
use std.{net, fs}
agent A {
  skill s(t: T) -> Inferred<T> ! {Fs.Read, Model}
  caps R
}
type T = { y: Text, x: Int }
capability R = fs.read("/a")`;
    // Hashing does not depend on the static checks (this agent has no step budget).
    const hash = (t: string): string => hashProgram(load(t, "mdt").program as unknown as Json).program;
    expect(hash(a)).toBe(hash(b));
  });
});

describe("S11 no implicit Unicode or number normalization", () => {
  const withText = (value: string): string =>
    JSON.stringify({ ...minimal(), defs: { G: { kind: "const", value: { op: "text", value } } } });

  it("keeps NFC and NFD text distinct", () => {
    const nfc = "café";
    const nfd = "café";
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    const a = check(withText(nfc), "json");
    const b = check(withText(nfd), "json");
    expect(a.ok && b.ok).toBe(true);
    expect(a.hashes!.program).not.toBe(b.hashes!.program);
  });

  it("rejects a lone surrogate with a defined error", () => {
    const text = withText("x").replace('"x"', '"\\ud800"');
    expect(codes(check(text, "json").diagnostics)).toEqual(["MDT-E0107"]);
  });

  it("rejects fractional and exponent numbers instead of rounding", () => {
    for (const n of ["1.0", "1e3", "0.1"]) {
      const text = `{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"N":{"kind":"const","value":{"op":"int","value":${n}}}}}`;
      expect(codes(check(text, "json").diagnostics)).toEqual(["MDT-E0106"]);
    }
  });

  it("rejects integers outside ±(2^53−1) and negative zero", () => {
    for (const n of ["9007199254740992", "-9007199254740992", "-0"]) {
      const text = `{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"N":{"kind":"const","value":{"op":"int","value":${n}}}}}`;
      expect(codes(check(text, "json").diagnostics)).toEqual(["MDT-E0106"]);
    }
  });

  it("rejects non-ASCII identifiers in text and in IR", () => {
    expect(codes(check("module m @ 0.1\ntype Ünlü = Text\n", "mdt").diagnostics)).toEqual(["MDT-E0101"]);
    const p = minimal();
    p["defs"] = { "Ünlü": { kind: "type", type: { ref: "Text" } } };
    expect(codes(checkJson(p).diagnostics)).toContain("MDT-E0104");
  });

  it("keeps decimals as written, as strings", () => {
    const r = check("module m @ 0.1\nlet x = 0.850\n", "mdt");
    expect(r.ok).toBe(true);
    expect(r.program!.defs["x"]).toEqual({ kind: "const", value: { op: "dec", value: "0.850" } });
  });
});

describe("S12 patch against a stale base", () => {
  const program = (): Program => check(`module m @ 0.1\ntype T = Text\n`, "mdt").program!;

  it("is refused with stale_base", () => {
    const p = program();
    const r = applyPatch(p, "sha256:" + "0".repeat(64), [{ op: "add", path: "/defs/U", value: { kind: "type", type: { ref: "Int" } } }]);
    expect(r.ok).toBe(false);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0130"]);
    expect(r.diagnostics[0]!.facts?.["current"]).toBe(hashProgram(p as unknown as Json).program);
  });

  it("applies against the current base and returns the new hash", () => {
    const p = program();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "add", path: "/defs/U", value: { kind: "type", type: { ref: "Int" } } }]);
    expect(r.ok).toBe(true);
    expect(r.hash).not.toBe(base);
    expect(Object.keys(r.program!.defs).sort()).toEqual(["T", "U"]);
    // The input is not modified.
    expect(Object.keys(p.defs)).toEqual(["T"]);
  });

  it("validates the patched program", () => {
    const p = program();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "replace", path: "/defs/T/type/ref", value: "Txt" }]);
    expect(r.ok).toBe(false);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0120"]);
  });

  it("reports a path that does not exist", () => {
    const p = program();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "remove", path: "/defs/Nope" }]);
    expect(codes(r.diagnostics)).toEqual(["MDT-E0131"]);
  });
});

describe("governance changes (§13.2)", () => {
  const src = `module m @ 0.1
use std.{fs, human}
use company.domain.{Issue}
capability Read = fs.read("/repo")
capability Write = fs.write("/repo")
contract Done(i: Issue) {
  accept owner "Owner approved" by human.approve(role: "owner")
  accept tests "Tests pass" by human.approve(role: "qa")
}
agent A {
  caps Read
  budget { tokens: 1000, steps: 5 }
  skill go(i: Issue) -> Inferred<Text> ! {Model}
}`;

  it("flags added capabilities, larger budgets and dropped criteria", () => {
    const p = check(src, "mdt").program!;
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [
      { op: "add", path: "/defs/A/caps/-", value: { op: "var", name: "Write" } },
      { op: "replace", path: "/defs/A/budget/steps", value: 50 },
      { op: "remove", path: "/defs/Done/accept/tests" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.governance.map((g) => g.kind).sort()).toEqual(["budget_increased", "capability_added", "criterion_removed"]);
  });

  it("reports nothing for a change that narrows authority", () => {
    const p = check(src, "mdt").program!;
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "replace", path: "/defs/A/budget/steps", value: 3 }]);
    expect(r.ok).toBe(true);
    expect(r.governance).toEqual([]);
  });
});
