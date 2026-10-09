// `changeset` (design doc 9 §3; BACKLOG item 32, B4): one mutation per rule
// on a Kervan change set: the order against the interface graph, the order
// listing its members, breaking changes, critical members on their
// component's repository, and a verified plan.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { printProgram } from "../src/print/printer.js";
import { architecture, authority } from "../src/views/views.js";
import { readRepo } from "./helpers.js";

const LAND = readRepo("examples/kervan/programs/land.mdt");

const modules = { "kervan.system": check(readRepo("examples/kervan/kervan-system/system/kervan.system.mdt"), "mdt").program! };

function mutate(from: string, to: string): string {
  expect(LAND.includes(from), from).toBe(true);
  return LAND.replace(from, to);
}

function errors(src: string): string[] {
  return check(src, "mdt", { modules }).diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

describe("changeset checks (B4)", () => {
  it("accepts Kervan's change set, prints it back to the same hash, and refuses it in 0.2", () => {
    const r = check(LAND, "mdt", { modules });
    expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
    const again = check(printProgram(r.program!), "mdt", { modules });
    expect(again.hashes!.program).toBe(r.hashes!.program);
    expect(errors(LAND.replace("mandate @ 0.3", "mandate @ 0.2"))).toContain("MDT-E0104");
  });

  it("E1101: the provider of an additive change lands before its consumers", () => {
    expect(errors(mutate("order auth, core, mcp", "order auth, mcp, core"))).toEqual(["MDT-E1101"]);
  });

  it("E1101: an interface that changes has its provider in the set", () => {
    expect(errors(mutate("    change CoreApi additive\n", "    change CoreApi additive\n    change SearchApi additive\n").replace("TokenIssuance, CoreApi}", "TokenIssuance, CoreApi, SearchApi}"))).toEqual(["MDT-E1101"]);
  });

  it("E1102: the order lists every member once", () => {
    expect(errors(mutate("order auth, core, mcp", "order auth, mcp"))).toEqual(["MDT-E1102"]);
    expect(errors(mutate("order auth, core, mcp", "order auth, core, mcp, core"))).toEqual(["MDT-E1102"]);
  });

  it("E1103: a breaking change is never one change set", () => {
    expect(errors(mutate("change TokenIssuance additive", "change TokenIssuance breaking"))).toEqual(["MDT-E1103"]);
  });

  it("E1104: members are critical effects", () => {
    const src = mutate("member core = git.merge(c)", "member core = note(c)").replace("type Plan = { summary: Text }", "type Plan = { summary: Text }\neffect note(c: Verified<Change>) -> Text");
    expect(errors(src)).toEqual(["MDT-E1104"]);
  });

  it("E1105: a change set lands a verified plan", () => {
    expect(errors(mutate("let landed = changeset(plan) {", "let landed = changeset(Plan { summary: task }) {"))).toEqual(["MDT-E1105"]);
  });

  it("E0301: the workflow holds each member's repository", () => {
    expect(errors(mutate("capability Repos = component.repo(auth, mcp, core)", "capability Repos = component.repo(auth, mcp)"))).toEqual(["MDT-E0301"]);
  });

  it("E0403 and E0120: a change set needs a business key, and its members are components", () => {
    expect(errors(mutate("} idempotent_by task", "}"))).toEqual(["MDT-E0403"]);
    expect(errors(mutate("member core = git.merge(c)", "member cor = git.merge(c)").replace("order auth, core, mcp", "order auth, cor, mcp"))).toContain("MDT-E0120");
  });

  it("shows who approves what, in which order, in the architecture and authority views", () => {
    const p = { ...check(LAND, "mdt", { modules }).program! };
    p.defs = { ...modules["kervan.system"].defs, ...p.defs };
    const node = architecture(p).workflows[0]!.nodes.find((n) => n.kind === "changeset")!;
    expect(node.label).toBe("change set auth → core → mcp");
    expect(node.detail).toEqual([
      "1. auth: git.merge (approved by identity_owner)",
      "2. core: git.merge (approved by core_owner)",
      "3. mcp: git.merge (approved by support_platform_owner)",
      "TokenIssuance: additive",
      "CoreApi: additive",
      "the set approved by architect",
    ]);
    expect(authority(p).rows.find((r) => r.who === "Land")!.effects).toContain("git.merge on core (change set: its owner and architect authorize)");
  });
});
