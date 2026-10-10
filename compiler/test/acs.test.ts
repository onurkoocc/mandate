// The ACS target (spec/executors.md, "ACS target"; BACKLOG item 40, K82):
// case X05. The structure always runs. The generated Rego is evaluated by a
// real OPA when MANDATE_OPA names one: a path to the `opa` binary, or
// `docker` for the openpolicyagent/opa:1.4.2 image.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acsTarget, check, domainHash, hashProgram, type Json, type Lock } from "../src/index.js";

const fixbug = readFileSync(new URL("../../fixtures/fixbug/fixbug.mdt", import.meta.url), "utf8");
const lock = JSON.parse(readFileSync(new URL("../../fixtures/fixbug/mandate.lock.json", import.meta.url), "utf8")) as Lock;

function target(src = fixbug, l: Lock | undefined = lock) {
  const r = check(src, "mdt", l ? { lock: l } : {});
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return acsTarget(r.program!, {}, l);
}

describe("mandate target acs (X05)", () => {
  it("writes one manifest and Rego bundle per local agent, bound to the package hash", () => {
    const t = target();
    expect(Object.keys(t.agents).sort()).toEqual(["Explorer", "Implementer", "Planner", "Reviewer", "TestWriter"]);
    const { lock: _f, ...pinned } = lock;
    const program = hashProgram(check(fixbug, "mdt").program! as unknown as Json).program;
    expect(t.binding).toBe(domainHash("package", { program, lock: pinned } as unknown as Json));
    const m = t.agents["Implementer"]!.manifest as Record<string, Record<string, unknown>>;
    expect(m["agent_control_specification_version"]).toBe("0.4.0-alpha.1");
    expect(Object.keys(m["intervention_points"]!).sort()).toEqual(["agent_shutdown", "agent_startup", "input", "output", "post_model_call", "post_tool_call", "pre_model_call", "pre_tool_call"]);
    expect(Object.keys(m["tools"]!)).toEqual(["read_file", "list_dir", "grep", "write_file", "run", "finish"]);
    expect(m["policies"]).toEqual({ mandate: { type: "rego", bundle: "./Implementer", query: "data.mandate.implementer.verdict" } });
    const rego = t.agents["Implementer"]!.rego;
    expect(rego).toContain(`binding := "${t.binding}"`);
    expect(rego).toContain('write_roots := ["/work/repo/src"]');
    expect(rego).toContain('models := ["claude-opus-5-5"]');
    // The reviewer may not write: it gets no write_file tool.
    expect(Object.keys((t.agents["Reviewer"]!.manifest as Record<string, Record<string, unknown>>)["tools"]!)).not.toContain("write_file");
  });

  it("names what it does not carry (W0907) and gives the profile", () => {
    const t = target();
    expect(t.diagnostics.map((d) => d.code)).toEqual(["MDT-W0907"]);
    expect(t.profile["effects.prepare_authorize_commit"]!.level).toBe("none");
    expect(t.profile["caps.paths_commands"]!.level).toBe("partial");
  });

  it("leaves out an agent whose budget is not in USD, by name (E0906)", () => {
    const src = `mandate @ 0.3

module acs.eur @ 0.1

use std.{fs, model}

capability RepoRead = fs.read("/work/repo")
capability ModelStd = model.infer(tier: standard)

agent Reader {
  caps   RepoRead, ModelStd
  budget { tokens: 100k, spend: 2 EUR, steps: 4 }
  skill look(task: Text) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow Look(task: Text) -> Inferred<Text>
  caps   RepoRead, ModelStd
  budget { time: 1h }
{
  delegate Reader.look(task)
}
`;
    const eur: Lock = {
      lock: "mandate/lock/0.3",
      modules: {},
      models: { standard: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", max_input_tokens: 10_000, max_output_tokens: 1_000 } },
      tariffs: { "claude-opus-5-5": { currency: "EUR", as_of: "2026-10-10", micros_per_mtok: { input: 4_000_000, output: 20_000_000, cache_read: 200_000, cache_write: 5_000_000 } } },
    };
    const t = target(src, eur);
    expect(t.diagnostics.map((d) => d.code)).toEqual(["MDT-E0906"]);
    expect(t.agents).toEqual({});
  });
});

const OPA = process.env["MANDATE_OPA"];

describe.skipIf(!OPA)("the generated Rego on a real OPA (X05)", () => {
  it("allows calls inside the grant and denies everything else, failing closed", () => {
    const t = target();
    const dir = mkdtempSync(join(tmpdir(), "mandate-acs-"));
    try {
      mkdirSync(join(dir, "Implementer"));
      writeFileSync(join(dir, "Implementer", "policy.rego"), t.agents["Implementer"]!.rego);
      const budgets = { token_count: 10, cost_usd: 0.5, elapsed_seconds: 3, tool_call_count: 1 };
      const pi = (point: string, value: unknown, extra: Record<string, unknown>, version = t.binding, b: Record<string, number> = budgets) => ({
        intervention_point: point,
        policy_target: { kind: null, path: "", value },
        snapshot: { envelope: { agent: { id: "Implementer", version }, budgets: b }, ...extra },
        annotations: {},
        tool: null,
      });
      const tool = (name: string, args: Record<string, unknown>, version?: string, b?: Record<string, number>) => pi("pre_tool_call", args, { tool_call: { name, args } }, version, b);
      const cases: Record<string, [unknown, string]> = {
        binding_mismatch: [tool("finish", {}, "1.0"), "mandate_binding_mismatch"],
        counter_missing: [tool("finish", {}, undefined, { token_count: 1 }), "mandate_budget_counter_missing"],
        exhausted: [tool("finish", {}, undefined, { ...budgets, cost_usd: 17.6 }), "mandate_budget_exhausted"],
        write_ok: [tool("write_file", { path: "src/a.ts", content: "x" }), "allow"],
        write_outside: [tool("write_file", { path: "test/x.ts", content: "x" }), "mandate_outside_grant"],
        traversal: [tool("write_file", { path: "src/../../etc/passwd", content: "x" }), "mandate_outside_grant"],
        prefix_trick: [tool("write_file", { path: "/work/repo/srcevil/x", content: "x" }), "mandate_outside_grant"],
        read_outside: [tool("read_file", { path: "/etc/passwd" }), "mandate_outside_grant"],
        run_ok: [tool("run", { command: "mvn", args: ["-q", "test", "-Dx"] }), "allow"],
        run_bad_prefix: [tool("run", { command: "mvn", args: ["deploy"] }), "mandate_outside_grant"],
        effect_tool: [tool("create_pull_request", { repo: "x" }), "mandate_outside_grant"],
        missing_path: [tool("read_file", {}), "mandate_outside_grant"],
        model_ok: [pi("pre_model_call", {}, { model: { name: "claude-opus-5-5" } }), "allow"],
        model_other: [pi("pre_model_call", {}, { model: { name: "other" } }), "mandate_model_not_locked"],
        input_ok: [pi("input", {}, { input: { body: "x", ifc: { source_labels: ["internal", "public"] } } }), "allow"],
        input_confidential: [pi("input", {}, { input: { body: "x", ifc: { source_labels: ["confidential"] } } }), "mandate_data_class"],
        input_empty: [pi("input", {}, { input: { body: "x", ifc: { source_labels: [] } } }), "mandate_labels_missing"],
        input_no_labels: [pi("input", {}, { input: { body: "x" } }), "mandate_labels_missing"],
      };
      for (const [name, [input, expected]] of Object.entries(cases)) {
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(input));
        const args = ["eval", "-f", "raw", "-d", "Implementer", "-i", `${name}.json`, "data.mandate.implementer.verdict"];
        const out =
          OPA === "docker"
            ? execFileSync("docker", ["run", "--rm", "-v", `${dir}:/w`, "-w", "/w", "openpolicyagent/opa:1.4.2", ...args], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } })
            : execFileSync(OPA!, args, { cwd: dir, encoding: "utf8" });
        const verdict = JSON.parse(out) as { decision: string; reason?: string };
        expect({ name, got: verdict.decision === "allow" ? "allow" : verdict.reason }).toEqual({ name, got: expected });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
