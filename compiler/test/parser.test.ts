import { describe, expect, it } from "vitest";
import { check, load } from "../src/check.js";
import type { Expr } from "../src/ir/types.js";
import { RESERVED } from "../src/parse/parser.js";
import { printProgram } from "../src/print/printer.js";
import { codes } from "./helpers.js";

/** Lowers one expression; names are not resolved here. */
const constOf = (src: string): Expr => {
  const r = load(`module m @ 0.1\nlet x = ${src}\n`, "mdt");
  expect(r.diagnostics).toEqual([]);
  const d = r.program!.defs["x"]!;
  if (d.kind !== "const") throw new Error("not a const");
  return d.value;
};

describe("lexical forms", () => {
  it("keeps the reserved keyword set within the C1 limit of 40", () => {
    expect(RESERVED.size).toBeLessThanOrEqual(40);
  });

  it("lowers money to integer micro-units", () => {
    expect(constOf("1.5 USD")).toEqual({ op: "money", micros: 1_500_000, currency: "USD" });
    expect(constOf("20 EUR")).toEqual({ op: "money", micros: 20_000_000, currency: "EUR" });
    expect(codes(check("module m @ 0.1\nlet x = 0.0000001 USD\n", "mdt").diagnostics)).toEqual(["MDT-E0101"]);
  });

  it("lowers durations to milliseconds and counts with k and M", () => {
    expect(constOf("15m")).toEqual({ op: "duration", ms: 900_000 });
    expect(constOf("1.5h")).toEqual({ op: "duration", ms: 5_400_000 });
    expect(constOf("250ms")).toEqual({ op: "duration", ms: 250 });
    expect(constOf("400k")).toEqual({ op: "int", value: 400_000 });
    expect(constOf("2M")).toEqual({ op: "int", value: 2_000_000 });
    expect(codes(check("module m @ 0.1\nlet x = 1.5ms\n", "mdt").diagnostics)).toEqual(["MDT-E0101"]);
  });

  it("keeps string text exactly and turns interpolation into template parts", () => {
    expect(constOf('"a \\{b\\} c"')).toEqual({ op: "text", value: "a {b} c" });
    expect(constOf('"n = {n}"')).toEqual({
      op: "template",
      parts: [{ text: "n = " }, { expr: { op: "var", name: "n" } }],
    });
  });
});

describe("expressions", () => {
  it("binds verifier operands tighter than `and`", () => {
    const r = load(
      `module m @ 0.1
use std.{human}
use company.domain.{D}
contract C(d: D) {
  accept a "x" by static not d.blocked and human.approve(role: "owner")
}`,
      "mdt",
    );
    expect(r.diagnostics).toEqual([]);
    const c = r.program!.defs["C"]!;
    expect(c.kind === "contract" && c.accept["a"]!.by).toMatchObject({
      all: [{ static: { op: "unary", uop: "not" } }, { call: { op: "call" } }],
    });
  });

  it("rejects chained comparisons", () => {
    expect(codes(check("module m @ 0.1\nlet x = 1 < 2 < 3\n", "mdt").diagnostics)).toEqual(["MDT-E0101"]);
  });

  it("parses `in` with a range", () => {
    expect(constOf("n in 1..12")).toEqual({
      op: "binary",
      bop: "in",
      left: { op: "var", name: "n" },
      right: { op: "range", from: { op: "int", value: 1 }, to: { op: "int", value: 12 } },
    });
  });

  it("does not read a following block as a record literal", () => {
    const r = load(
      `module m @ 0.1
use std.{fs}
capability R = fs.read("/a")
workflow W(x: Int) -> Int
  caps R
{
  if x > 1 { return x }
  x
}`,
      "mdt",
    );
    expect(r.diagnostics).toEqual([]);
  });
});

describe("line breaks", () => {
  const body = (src: string) => {
    const r = load(`module m @ 0.1\nfn f(a: Int, b: Int) -> Int {\n${src}\n}\n`, "mdt");
    expect(r.diagnostics).toEqual([]);
    const d = r.program!.defs["f"]!;
    if (d.kind !== "fn") throw new Error("not a fn");
    return d.body;
  };

  it("starts a new statement at a `(` on a new line", () => {
    expect(body("let x = a\n(b)").map((s) => s.op)).toEqual(["let", "expr"]);
    expect(body("let x = a(b)")[0]).toMatchObject({ value: { op: "call" } });
  });

  it("takes a return value only from the same line", () => {
    expect(body("return\na")).toEqual([{ op: "return" }, { op: "expr", value: { op: "var", name: "a" } }]);
  });

  it("lets a binary operator lead a continuation line", () => {
    expect(body("a\n  and b")).toHaveLength(1);
  });

  it("prints a leading minus so it does not join the previous statement", () => {
    const src = "module m @ 0.1\nfn f(a: Int) -> Int {\n  let x = a\n  (-a)\n}\n";
    const r = check(src, "mdt");
    expect(r.ok).toBe(true);
    const again = check(printProgram(r.program!), "mdt");
    expect(again.hashes!.program).toBe(r.hashes!.program);
  });
});

describe("syntax and duplicate errors", () => {
  it("points at the offending token", () => {
    const r = check("module m @ 0.1\ntype T = \n", "mdt");
    expect(codes(r.diagnostics)).toEqual(["MDT-E0101"]);
    expect(r.diagnostics[0]!.at.span?.[0]).toBe(3);
  });

  it("rejects a reserved keyword as a name", () => {
    expect(codes(check("module m @ 0.1\ntype par = Text\n", "mdt").diagnostics)).toEqual(["MDT-E0101"]);
  });

  it("reports duplicate definitions, fields and parameters", () => {
    const r = check(
      `module m @ 0.1
type T = Text
type T = Int
type R = { a: Int, a: Text }
fn f(x: Int, x: Int) -> Int { x }`,
      "mdt",
    );
    expect(codes(r.diagnostics)).toEqual(["MDT-E0121", "MDT-E0121", "MDT-E0121"]);
  });

  it("requires a skill to declare its effects", () => {
    const r = check("module m @ 0.1\nagent A {\n  skill s() -> Text\n}\n", "mdt");
    expect(codes(r.diagnostics)).toEqual(["MDT-E0101"]);
  });

  it("rejects a handler whose target is not a workflow", () => {
    const r = check("module m @ 0.1\ntype T = Text\non budget_exceeded in T => pause\n", "mdt");
    expect(codes(r.diagnostics)).toEqual(["MDT-E0120"]);
  });

  it("rejects an unknown budget field", () => {
    const r = check("module m @ 0.1\nagent A {\n  budget { coins: 3 }\n}\n", "mdt");
    expect(codes(r.diagnostics)).toEqual(["MDT-E0101"]);
  });
});

describe("data classes", () => {
  it("reads `classified` after a type into the IR and prints it back", () => {
    const src = "module m @ 0.1\ntype R = { a: Text } classified restricted\n";
    const r = load(src, "mdt");
    expect(r.diagnostics).toEqual([]);
    expect(r.program!.defs["R"]).toEqual({ kind: "type", type: { record: { a: { ref: "Text" } } }, class: "restricted" });
    expect(printProgram(r.program!)).toContain("type R = { a: Text } classified restricted");
  });

  it("rejects an unknown class", () => {
    expect(codes(load("module m @ 0.1\ntype R = Text classified secret\n", "mdt").diagnostics)).toEqual(["MDT-E0101"]);
  });
});

describe("language version", () => {
  const body = "module m @ 0.1\nlet x = 1\n";

  it("reads a file without a header as 0.1 and `mandate @ 0.2` as 0.2", () => {
    expect(load(body, "mdt").program!.language).toBe("mandate/0.1");
    const r = load(`mandate @ 0.2\n\n${body}`, "mdt");
    expect(r.diagnostics).toEqual([]);
    expect(r.program!.language).toBe("mandate/0.2");
    expect(printProgram(r.program!)).toMatch(/^mandate @ 0\.2\n\nmodule m @ 0\.1\n/);
    expect(printProgram(load(body, "mdt").program!)).toMatch(/^module m @ 0\.1\n/);
  });

  it("hashes the same program differently in 0.1 and 0.2", () => {
    const a = check(body, "mdt");
    const b = check(`mandate @ 0.2\n${body}`, "mdt");
    expect(a.ok && b.ok).toBe(true);
    expect(a.hashes!.program).not.toBe(b.hashes!.program);
    expect(a.hashes!.defs["x"]).not.toBe(b.hashes!.defs["x"]);
  });

  it("rejects a language version it does not read", () => {
    expect(codes(load(`mandate @ 0.9\n${body}`, "mdt").diagnostics)).toEqual(["MDT-E0103"]);
  });
});

describe("agent loop strategy and progress (0.2)", () => {
  const agent = (lang: string, extra: string) => `${lang}module m @ 0.1

use std.{model}

capability M = model.infer(tier: standard)

agent A {
  caps   M
  budget { steps: 5 }
${extra}
  skill s(x: Text) -> Inferred<Text> ! {Model}
}
`;

  it("reads and prints `loop` and `progress`", () => {
    const r = check(agent("mandate @ 0.2\n\n", "  loop   plan_execute\n  progress { window: 6, repeats: 2, stall: 4 }"), "mdt");
    expect(r.diagnostics).toEqual([]);
    const a = r.program!.defs["A"]!;
    expect(a.kind === "agent" && { loop: a.loop, progress: a.progress }).toEqual({ loop: "plan_execute", progress: { window: 6, repeats: 2, stall: 4 } });
    const printed = printProgram(r.program!);
    expect(printed).toContain("  loop   plan_execute\n  progress { window: 6, repeats: 2, stall: 4 }");
    expect(check(printed, "mdt").hashes!.program).toBe(r.hashes!.program);
  });

  it("refuses them in a 0.1 program, and more repeats than the window", () => {
    expect(codes(check(agent("", "  loop   react"), "mdt").diagnostics)).toEqual(["MDT-E0104"]);
    expect(codes(check(agent("mandate @ 0.2\n", "  progress { window: 3, repeats: 4 }"), "mdt").diagnostics)).toEqual(["MDT-E0104"]);
    expect(codes(check(agent("mandate @ 0.2\n", "  loop   wander"), "mdt").diagnostics)).toEqual(["MDT-E0101"]);
  });
});
