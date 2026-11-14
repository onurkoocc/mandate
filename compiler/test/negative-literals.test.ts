// A negative int, dec or money literal in IR changes the program hash on a text
// round trip (the text `-5` reads as `unary neg` over `5`). From 0.5 the IR
// refuses such a literal (E0104, spec/ir.md "What 0.5 adds"); a program of 0.1
// to 0.4 is read as before. The digests of the 0.4 programs below were taken on
// the compiler before the rule existed, and must not move.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { printProgram } from "../src/print/printer.js";
import { checkJson } from "./helpers.js";

const INT = { op: "int", value: -5 };
const MONEY = { op: "money", micros: -1500000, currency: "USD" };
const DEC = { op: "dec", value: "-1.5" };

function program(language: string, value: unknown): Record<string, unknown> {
  return { language, module: "m", version: "0.1", defs: { x: { kind: "const", value } } };
}

const said = (p: unknown): [string, string | undefined, unknown][] => checkJson(p).diagnostics.map((d) => [d.code, d.at.path, d.facts]);

describe("a negative literal in a 0.5 program is refused (E0104)", () => {
  it.each([
    ["int", INT],
    ["money", MONEY],
    ["dec", DEC],
  ])("%s, at the literal", (op, lit) => {
    expect(said(program("mandate/0.5", lit))).toEqual([["MDT-E0104", "/defs/x/value", { op, language: "mandate/0.5" }]]);
  });

  it("names the way to write it", () => {
    const [d] = checkJson(program("mandate/0.5", INT)).diagnostics;
    expect(d!.message).toBe("A negative 'int' literal is not allowed in mandate/0.5: from mandate/0.5 a negative literal is written as the negation of a positive one (unary neg).");
  });

  it("finds one nested in a list and a binary, each at its own path", () => {
    const value = { op: "list", items: [{ op: "int", value: 1 }, INT, { op: "binary", bop: "+", left: MONEY, right: { op: "money", micros: 1, currency: "USD" } }] };
    expect(said(program("mandate/0.5", value))).toEqual([
      ["MDT-E0104", "/defs/x/value/items/1", { op: "int", language: "mandate/0.5" }],
      ["MDT-E0104", "/defs/x/value/items/2/left", { op: "money", language: "mandate/0.5" }],
    ]);
  });

  it("finds one in a workflow body", () => {
    const p = {
      language: "mandate/0.5",
      module: "m",
      version: "0.1",
      defs: { W: { kind: "workflow", body: [{ op: "let", name: "n", value: INT }] } },
    };
    // The workflow is not complete, so schema errors come too; the gate is the one that names the literal.
    const found = said(p).filter(([, , facts]) => (facts as { op?: string } | undefined)?.op === "int");
    expect(found).toEqual([["MDT-E0104", "/defs/W/body/0/value", { op: "int", language: "mandate/0.5" }]]);
  });

  it("accepts zero, positive literals and the negation of one", () => {
    const neg = { op: "unary", uop: "neg", of: { op: "int", value: 5 } };
    for (const v of [{ op: "int", value: 0 }, { op: "int", value: 5 }, { op: "dec", value: "1.5" }, { op: "money", micros: 0, currency: "USD" }, neg]) {
      expect(said(program("mandate/0.5", v))).toEqual([]);
    }
  });
});

describe("the same literals in a program of 0.4 or older are read as before", () => {
  // Taken on origin/main (7c039ae), before the rule.
  const DIGESTS: [string, unknown, string][] = [
    ["int", INT, "sha256:7e7ad6f30184df3703b5e742af3c6b86ebcef885be1d29af9d9e91f9a26d745e"],
    ["money", MONEY, "sha256:4c09aeadad95fa4c47c13279af595af791d8e854a2154fbab4da114a8dcacda1"],
    ["dec", DEC, "sha256:2910256888871a517d74053e76e052913fdc8af9e4b22da04b6854648a8e5998"],
  ];
  it.each(DIGESTS)("%s is accepted with its digest", (_name, lit, digest) => {
    const r = checkJson(program("mandate/0.4", lit));
    expect(r.diagnostics).toEqual([]);
    expect(r.hashes!.program).toBe(digest);
  });

  it.each(["mandate/0.1", "mandate/0.2", "mandate/0.3"])("%s is accepted too", (language) => {
    expect(said(program(language, INT))).toEqual([]);
  });
});

describe("text keeps its hash through fmt in 0.5", () => {
  const SRC = "mandate @ 0.5\n\nmodule m @ 0.1\n\nlet a = -5\nlet b = -1.5 USD\nlet c = -2.5\n";
  it("lowers a minus to unary neg and keeps the digest", () => {
    const first = check(SRC, "mdt");
    expect(first.diagnostics).toEqual([]);
    const defs = (first.program as unknown as { defs: Record<string, { value: unknown }> }).defs;
    expect(defs["a"]!.value).toEqual({ op: "unary", uop: "neg", of: { op: "int", value: 5 } });
    const again = check(printProgram(first.program!), "mdt");
    expect(again.diagnostics).toEqual([]);
    expect(again.hashes!.program).toBe(first.hashes!.program);
  });
});
