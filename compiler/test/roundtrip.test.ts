// The text form is a projection of the IR (Doc 4 §3.3): every example parses,
// resolves, prints, and parses back to the same program hash.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { formatDiagnostic } from "../src/diag.js";
import { canonicalize } from "../src/json/jcs.js";
import type { Json } from "../src/json/strict-json.js";
import { printProgram } from "../src/print/printer.js";
import { readRepo, syntaxFixtures } from "./helpers.js";

const files = ["examples/fixbug/fixbug.mdt", ...syntaxFixtures()];

describe.each(files)("%s", (file) => {
  const r = check(readRepo(file), "mdt");

  it("checks without diagnostics", () => {
    expect(r.diagnostics.map((d) => formatDiagnostic(d, file))).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("prints back to text with the same hash", () => {
    const printed = printProgram(r.program!);
    const again = check(printed, "mdt");
    expect(again.diagnostics.map((d) => formatDiagnostic(d, "printed"))).toEqual([]);
    expect(again.hashes!.program).toBe(r.hashes!.program);
    expect(printProgram(again.program!)).toBe(printed);
  });

  it("goes through JSON IR with the same hash", () => {
    const viaJson = check(canonicalize(r.program as unknown as Json), "json");
    expect(viaJson.ok).toBe(true);
    expect(viaJson.hashes!.program).toBe(r.hashes!.program);
  });
});

describe("FixBug", () => {
  it("matches the committed canonical IR, which is the source of truth in 0.1", () => {
    const fromText = check(readRepo("examples/fixbug/fixbug.mdt"), "mdt");
    const fromIr = check(readRepo("examples/fixbug/fixbug.ir.json"), "json");
    expect(fromIr.ok).toBe(true);
    expect(fromIr.hashes).toEqual(fromText.hashes);
  });

  it("lowers the workflow as the design describes", () => {
    const p = check(readRepo("examples/fixbug/fixbug.mdt"), "mdt").program!;
    const wf = p.defs["FixBug"]!;
    expect(wf.kind).toBe("workflow");
    if (wf.kind !== "workflow") return;
    expect(wf.budget).toEqual({ spend: { micros: 20_000_000, currency: "USD" }, time: { ms: 3 * 3_600_000 } });
    expect(wf.body.map((s) => s.op)).toEqual(["let", "let", "par", "let", "let", "let", "expr"]);
    const last = wf.body[6]!;
    expect(last).toMatchObject({ op: "expr", value: { op: "effect", name: "git.open_pr", compensate: "git.close_pr" } });
    expect(wf.on).toEqual([
      {
        event: "budget_exceeded",
        then: {
          op: "pause",
          then: {
            op: "call",
            callee: { op: "field", of: { op: "var", name: "human" }, name: "ask" },
            args: [{ value: { op: "text", value: "Budget exceeded. Continue or cancel?" } }],
          },
        },
      },
    ]);
    const planner = p.defs["Planner"]!;
    expect(planner.kind === "agent" && planner.budget).toEqual({ tokens: 150_000, spend: { micros: 1_500_000, currency: "USD" }, steps: 10 });
  });
});
