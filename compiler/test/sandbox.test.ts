// Sandbox requirements (Doc 4 §7.3, §11.3, §20): one platform-independent
// requirement per local agent, which a sandbox adapter turns into policy.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { requirementFor, sandboxRequirements, type SandboxRequirement } from "../src/target/sandbox.js";
import { readRepo } from "./helpers.js";

const FIXBUG = readRepo("examples/fixbug/fixbug.mdt");

function requirements(src: string): Record<string, SandboxRequirement> {
  const r = check(src, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return sandboxRequirements(r.program!);
}

/** A one-agent program around the given capability lines. */
function agentWith(caps: string, use: string, effects: string): string {
  return `module test.sandbox @ 0.1
use std.{fs, net, model, exec}
use company.domain.{Issue}
${caps}
agent A {
  caps   ${use}
  budget { steps: 5, time: 2m }
  skill run(issue: Issue) -> Inferred<Text> ! {${effects}}
}
`;
}

describe("sandbox requirements", () => {
  it("FixBug gets one requirement per agent, as §20 lists them", () => {
    const req = requirements(FIXBUG);
    expect(Object.keys(req)).toEqual(["Explorer", "Implementer", "Planner", "Reviewer", "TestWriter"]);
    const fs = Object.fromEntries(Object.entries(req).map(([k, r]) => [k, r.filesystem]));
    expect(fs).toEqual({
      Explorer: { read: ["/work/repo"], write: [] },
      Implementer: { read: ["/work/repo"], write: ["/work/repo/src"] },
      Planner: { read: [], write: [] },
      Reviewer: { read: ["/work/repo"], write: [] },
      TestWriter: { read: ["/work/repo"], write: ["/work/repo/test"] },
    });
    // The parallel agents' write scopes are disjoint, as C5 requires of their grants.
    expect(req["Implementer"]!.filesystem.write).not.toEqual(expect.arrayContaining(req["TestWriter"]!.filesystem.write));
  });

  it("Explorer's requirement matches the §11.3 example: read-only repo, a model, 900 seconds, no desktop", () => {
    const r = check(FIXBUG, "mdt");
    const explorer = sandboxRequirements(r.program!)["Explorer"]!;
    expect(explorer).toEqual({
      format: "mandate/sandbox-requirement/0.1",
      subject: { agent: "Explorer", def: r.hashes!.defs["Explorer"] },
      filesystem: { read: ["/work/repo"], write: [] },
      exec: [],
      network: { hosts: [] },
      models: [{ tier: "standard", max_class: "internal" }],
      ui: { desktop: false, clipboard: false },
      limits: { timeout_ms: 900_000 },
      unbounded: [],
    });
  });

  it("commands keep their argument prefixes; a git.pr capability is brokered, not sandboxed", () => {
    const req = requirements(FIXBUG);
    expect(req["Implementer"]!.exec).toEqual([{ command: "mvn", args_prefix: [["-q", "test"], ["-q", "verify"]] }]);
    expect(req["Explorer"]!.exec).toEqual([]);
    // FixBug's workflow holds PR; no agent does, and the workflow itself gets no sandbox.
    expect(Object.values(req).every((r) => !JSON.stringify(r).includes("company/backend"))).toBe(true);
  });

  it("an agent without a time budget has no timeout of its own", () => {
    const req = requirements(FIXBUG);
    expect(req["Planner"]!.limits.timeout_ms).toBeNull();
    expect(req["Implementer"]!.limits.timeout_ms).toBe(45 * 60_000);
  });

  it("paths are normalized by segment and nested paths fold into the outer one", () => {
    const req = requirements(
      agentWith(
        `capability Wide = fs.read("/work/repo/")
capability Deep = fs.read("/work/repo/src/../docs")
capability Other = fs.read("/work/repo2")`,
        "Wide, Deep, Other",
        "Fs.Read",
      ),
    );
    expect(req["A"]!.filesystem.read).toEqual(["/work/repo", "/work/repo2"]);
  });

  it("hosts come from net.https; a narrowed capability keeps only its narrower scope", () => {
    const req = requirements(
      agentWith(
        `capability Api = net.https(hosts: ["api.example.com", "ci.example.com"])
capability Repo = fs.read("/work/repo")`,
        `Api, Repo.narrow("/work/repo/src")`,
        "Net, Fs.Read",
      ),
    );
    expect(req["A"]!.network.hosts).toEqual(["api.example.com", "ci.example.com"]);
    expect(req["A"]!.filesystem.read).toEqual(["/work/repo/src"]);
    expect(req["A"]!.limits.timeout_ms).toBe(120_000);
  });

  it("a scope that is not static is listed as unbounded, never dropped or widened", () => {
    const req = requirements(
      agentWith(
        `let ROOT = "/work/repo"
capability Repo = fs.read(ROOT)`,
        "Repo",
        "Fs.Read",
      ),
    );
    expect(req["A"]!.filesystem.read).toEqual([]);
    expect(req["A"]!.unbounded).toEqual(["Repo = fs.read"]);
  });

  it("remote agents run elsewhere and get no requirement", () => {
    expect(requirements(readRepo("compiler/test/fixtures/syntax/remote.mdt"))).toEqual({});
  });
});

describe("exec without argument prefixes", () => {
  it("allows any arguments, also when another grant of the command has prefixes", () => {
    const cap = (argsPrefix?: string[][]) => ({ ctor: "exec", effect: "Exec", write: false, scope: ["npm"], ...(argsPrefix ? { argsPrefix } : {}) });
    const req = (caps: unknown[]) => requirementFor({ agent: "A", def: "sha256:x" }, caps as never, null).exec;
    expect(req([cap()])).toEqual([{ command: "npm" }]);
    expect(req([cap([["test"]]), cap()])).toEqual([{ command: "npm" }]);
    expect(req([cap([["test"]]), cap([["run", "build"]])])).toEqual([{ command: "npm", args_prefix: [["run", "build"], ["test"]] }]);
  });
});
