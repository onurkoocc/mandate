// Declared reads (design doc 9 §5.1, K43; BACKLOG item 34, B6): data.read of
// a read an environment declares, its parameters by name, masking by class.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { readRepo } from "./helpers.js";

const modules = { "kervan.system": check(readRepo("examples/kervan/kervan-system/system/kervan.system.mdt"), "mdt").program! };
const INCIDENT = readRepo("examples/kervan/programs/incident.mdt");

function mutate(from: string, to: string): string {
  expect(INCIDENT.includes(from), from).toBe(true);
  return INCIDENT.replace(from, to);
}

const errors = (src: string): string[] => check(src, "mdt", { modules }).diagnostics.filter((d) => d.severity === "error").map((d) => d.code);

describe("data.read (B6)", () => {
  it("checks the incident review: masked rows reach a model limited to internal data", () => {
    expect(check(INCIDENT, "mdt", { modules }).diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  it("E0220: without masking, the customers' confidential fields would reach the model", () => {
    expect(errors(mutate("tracking_no: incident.tracking_no, max_class: internal)\n  delegate", "tracking_no: incident.tracking_no)\n  delegate"))).toContain("MDT-E0220");
  });

  it("E0201: a field the program needs unmasked does not check; the class is never lowered", () => {
    expect(errors(mutate("full_name: Masked", "full_name: Text"))).toContain("MDT-E0201");
  });

  it("E1201: a read the environment declares, every parameter once by name, nothing else", () => {
    expect(errors(mutate("data.read(prod_sim.mcp_errors,", "data.read(prod_sim.mcp_logs,"))).toContain("MDT-E1201");
    expect(errors(mutate("data.read(prod_sim.mcp_errors, since: incident.since,", "data.read(prod_sim.mcp_errors,"))).toContain("MDT-E1201");
    expect(errors(mutate("data.read(prod_sim.mcp_errors, since: incident.since,", "data.read(prod_sim.mcp_errors, since: incident.since, level: \"error\","))).toContain("MDT-E1201");
    expect(errors(mutate("max_class: internal)\n  let warnings", "max_class: secret)\n  let warnings"))).toContain("MDT-E1201");
  });

  it("E0301: each read needs data.read authority for it", () => {
    expect(errors(mutate("data.read(prod_sim, mcp_errors, core_warnings, shipment_events, shipment_overview)", "data.read(prod_sim, mcp_errors, core_warnings, shipment_events)"))).toEqual(["MDT-E0301"]);
  });

  it("E1002: data.read authority names an environment and reads it declares", () => {
    expect(errors(mutate("data.read(prod_sim, mcp_errors,", "data.read(staging, mcp_errors,"))).toContain("MDT-E1002");
  });
});
