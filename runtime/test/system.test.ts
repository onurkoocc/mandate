// A run over a system model (design doc 9 §2; BACKLOG item 30, B2): the
// package carries the imported model, pinned by hash in its lock; delegates
// get capabilities over components opened into paths and commands; a model
// that differs from its pin is refused at load time (S09, INV-02).

import { afterAll, describe, expect, it } from "vitest";
import { buildPackage, verifyPackage } from "../src/runtime.js";
import { closeAll, world } from "./helpers.js";
import { ACME_SOURCE, acmeModule, acmeModules, lockFor, TWO_COMPONENTS } from "./acme.js";
import { check } from "@mandate/compiler";

afterAll(closeAll);

describe("a run over Acme's system model", () => {
  it("hands each delegate its components' paths and commands, and its sandbox requirement says the same", async () => {
    const modules = acmeModules();
    const w = await world(TWO_COMPONENTS, { modules, lock: lockFor(modules) });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Change", input: { task: "add a field" } });
    expect(run.state).toBe("succeeded");
    const mcp = w.agents.calls.find((c) => c.agent === "McpDev")!;
    expect(mcp.caps).toEqual([
      { ctor: "exec", scope: ["npm"] },
      { ctor: "fs.read", scope: ["/work/acme-mcp"] },
      { ctor: "fs.write", scope: ["/work/acme-mcp/src", "/work/acme-mcp/test"] },
      { ctor: "model.infer" },
    ]);
    expect(mcp.sandbox!.filesystem).toEqual({ read: ["/work/acme-mcp"], write: ["/work/acme-mcp/src", "/work/acme-mcp/test"] });
    expect(mcp.sandbox!.exec).toEqual([{ command: "npm", args_prefix: [["test"]] }]);
    const core = w.agents.calls.find((c) => c.agent === "CoreDev")!;
    expect(core.sandbox!.filesystem).toEqual({ read: ["/work/acme-core"], write: ["/work/acme-core/src"] });
    expect(core.sandbox!.exec).toEqual([]);
  });

  it("refuses at load time a system model other than the one the lock pins", () => {
    const modules = acmeModules();
    const program = check(TWO_COMPONENTS, "mdt", { modules }).program!;
    expect(() => verifyPackage(buildPackage(program, lockFor(modules), modules))).not.toThrow();
    // Someone changes the model after the lock was written: core gets another owner.
    const changed = { "acme.system": acmeModule(ACME_SOURCE.replace('role "core_owner"', 'role "anyone"')) };
    expect(() => verifyPackage(buildPackage(program, lockFor(modules), changed))).toThrow(/module_hash_mismatch|hashes to/);
    expect(() => verifyPackage(buildPackage(program, { modules: {} }, modules))).toThrow(/not locked/);
  });
});
