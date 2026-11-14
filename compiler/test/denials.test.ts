// Denial reports (Doc 4 §11.3, §12.2): what sandboxes in learning mode denied during a run, as `mandate check
// --denials <report>` reads it. Each denial is feedback on an agent's policy (W0311), never a grant.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { hashProgram } from "../src/hash.js";
import type { Json } from "../src/json/strict-json.js";
import { denialDiagnostics, SANDBOX_DENIALS_FORMAT, type DenialReport } from "../src/target/sandbox.js";
import { readRepo } from "./helpers.js";

const r = check(readRepo("fixtures/fixbug/fixbug.mdt"), "mdt");
const program = r.program!;
const hash = hashProgram(program as unknown as Json).program;

const report = (denials: DenialReport["denials"], over: Partial<DenialReport> = {}): DenialReport => ({ format: SANDBOX_DENIALS_FORMAT, program: hash, denials, ...over });

describe("denial reports", () => {
  it("checks FixBug, the program the reports below are for", () => {
    expect(r.ok).toBe(true);
  });

  it("gives one W0311 per agent, access and resource, at the agent's capabilities", () => {
    const d = denialDiagnostics(
      program,
      report([
        { agent: "Explorer", resource: "/home/other/notes.txt", access: "read" },
        { agent: "Explorer", resource: "/home/other/notes.txt", access: "read" },
        { agent: "Explorer", resource: "/home/other/notes.txt", access: "write" },
        { agent: "Implementer", resource: "/work/repo/.github/workflows/ci.yml", access: "write" },
      ]),
    );
    expect(d.map((x) => [x.code, x.severity, x.at.path, x.facts])).toEqual([
      ["MDT-W0311", "warning", "/defs/Explorer/caps", { agent: "Explorer", access: "read", resource: "/home/other/notes.txt" }],
      ["MDT-W0311", "warning", "/defs/Explorer/caps", { agent: "Explorer", access: "write", resource: "/home/other/notes.txt" }],
      ["MDT-W0311", "warning", "/defs/Implementer/caps", { agent: "Implementer", access: "write", resource: "/work/repo/.github/workflows/ci.yml" }],
    ]);
  });

  it("puts a denial of a name that is not an agent of the program at the root", () => {
    expect(denialDiagnostics(program, report([{ agent: "FixBug", resource: "api.example.com", access: "connect" }])).map((x) => [x.code, x.at.path])).toEqual([["MDT-W0311", ""]]);
  });

  it("gives nothing for a report without denials", () => {
    expect(denialDiagnostics(program, report([]))).toEqual([]);
  });

  it("refuses a report made for another program, and one of another format", () => {
    const other = denialDiagnostics(program, report([{ agent: "Explorer", resource: "/home/other/notes.txt", access: "read" }], { program: `sha256:${"0".repeat(64)}` }));
    expect(other.map((x) => [x.code, x.at.path, x.facts])).toEqual([["MDT-E0104", "", { report: `sha256:${"0".repeat(64)}`, program: hash }]]);
    const format = denialDiagnostics(program, report([], { format: "mandate/sandbox-denials/0.2" as never }));
    expect(format.map((x) => [x.code, x.at.path])).toEqual([["MDT-E0104", ""]]);
  });
});
