// The system model in the IR (design doc 9 §2; BACKLOG item 30, B2): Kervan's
// model checks; each system-model rule fires on one mutation of it; programs
// import it and write capabilities over its components; the lock pins it; and
// changing it is a governance change.

import { describe, expect, it } from "vitest";
import { check, loadModules } from "../src/check.js";
import { hashProgram } from "../src/hash.js";
import type { Json } from "../src/json/strict-json.js";
import { applyPatch } from "../src/patch/patch.js";
import type { Program } from "../src/ir/types.js";
import type { Lock } from "../src/lock.js";
import { sandboxRequirements } from "../src/target/sandbox.js";
import { semanticDiff, system } from "../src/views/views.js";
import { readRepo } from "./helpers.js";

const KERVAN = readRepo("examples/kervan/kervan-system/system/kervan.system.mdt");

function kervan(): Program {
  const r = check(KERVAN, "mdt");
  expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return r.program!;
}

/** Kervan's model with one textual change; fails loudly if the text is gone. */
function mutate(from: string, to: string): string {
  expect(KERVAN.includes(from), from).toBe(true);
  return KERVAN.replace(from, to);
}

function codesOf(src: string, opts: Parameters<typeof check>[2] = {}): string[] {
  return check(src, "mdt", opts).diagnostics.map((d) => d.code);
}

/** A program that works on Kervan's mcp and core components. */
const PROGRAM = `mandate @ 0.3
module kervan.tasks.sample @ 0.1
use std.{component, model}
use kervan.system.{mcp, core, prod_sim}

capability McpRead  = component.read(mcp)
capability McpSrc   = component.write(mcp, "src", "test")
capability McpTest  = component.exec(mcp, test)
capability CoreSrc  = component.write(core, "src")
capability CoreRead = component.read(core)
capability Model    = model.infer(tier: standard)

type Patch = { files: List<Path> }

agent McpDev {
  caps   McpRead, McpSrc, McpTest, Model
  budget { steps: 10 }
  skill change(task: Text) -> Inferred<Patch> ! {Fs.Read, Fs.Write, Exec, Model}
}

agent CoreDev {
  caps   CoreRead, CoreSrc, Model
  budget { steps: 10 }
  skill change(task: Text) -> Inferred<Patch> ! {Fs.Read, Fs.Write, Model}
}

workflow Change(task: Text) -> Text
  caps McpRead, McpSrc, McpTest, CoreRead, CoreSrc, Model
{
  par {
    a = delegate McpDev.change(task)
    b = delegate CoreDev.change(task)
  }
  "done"
}
`;

const modules = (): Record<string, Program> => ({ "kervan.system": kervan() });

describe("Kervan's system model (B2)", () => {
  it("checks clean as mandate/0.3", () => {
    expect(kervan().language).toBe("mandate/0.3");
  });

  it("is shown as a system: components, interfaces with provider and consumers, environments", () => {
    const v = system(kervan());
    expect(v.components.map((c) => c.name)).toEqual(["auth", "core", "evals", "mcp", "search", "voice"]);
    const tokens = v.interfaces.find((i) => i.name === "TokenIssuance")!;
    expect(tokens).toMatchObject({ protocol: "oauth", provider: "auth", consumers: ["mcp", "voice"] });
    expect(v.interfaces.every((i) => i.provider !== null)).toBe(true);
    const prod = v.environments.find((e) => e.name === "prod_sim")!;
    expect(prod.class).toBe("confidential");
    expect(prod.reads.map((r) => r.name)).toEqual(["shipment_overview", "shipment_events", "tickets_since", "mcp_errors", "core_warnings"]);
    expect(prod.authorize).toEqual([
      { effect: "deploy", tier: "a person (release_manager)" },
      { effect: "migrate", tier: "a person (db_owner)" },
    ]);
    expect(v.mermaid).toContain("c_mcp -->|CoreApi| c_core");
  });

  it("is refused in a mandate/0.2 program (E0104)", () => {
    expect(codesOf(KERVAN.replace("mandate @ 0.3", "mandate @ 0.2"))).toContain("MDT-E0104");
  });

  it("E1001: an interface needs exactly one provider", () => {
    expect(codesOf(mutate("  provides TokenIssuance\n}", "}"))).toEqual(["MDT-E1001"]);
    expect(codesOf(mutate("  provides SearchApi\n", "  provides SearchApi, TokenIssuance\n"))).toEqual(["MDT-E1001"]);
  });

  it("E1003: two components never share a working copy", () => {
    expect(codesOf(mutate('root     "/work/kervan-mcp"', 'root     "/work/kervan-auth/mcp"'))).toEqual(["MDT-E1003"]);
  });

  it("E0120: provides and consumes name interfaces; a read names a component", () => {
    expect(codesOf(mutate("consumes CoreApi, SearchApi, TokenIssuance", "consumes CoreApi, SearchApi, TokenIsuance"))).toEqual(["MDT-E0120"]);
    expect(codesOf(mutate("read mcp_errors from mcp", "read mcp_errors from mpc"))).toEqual(["MDT-E0120"]);
  });

  it("E1004: a read's placeholders and parameters match, it is one SELECT, and its parameters are scalars", () => {
    expect(codesOf(mutate("where tracking_no = :tracking_no order by at", "where tracking_no = :tracking order by at"))).toEqual(["MDT-E1004"]);
    expect(codesOf(mutate('sql "select ticket_id', 'sql "delete from tickets; select ticket_id'))).toEqual(["MDT-E1004"]);
    expect(codesOf(mutate("params (since: Text)\n    returns TicketRow", "params (since: List<Text>)\n    returns TicketRow"))).toEqual(["MDT-E1004"]);
  });

  it("E0201: a log filter is a Bool over the row's fields and the read's parameters", () => {
    expect(codesOf(mutate('logs where (level == "error" or level == "warn") and ts >= since', "logs where status + 1"))).toEqual(["MDT-E0201"]);
    expect(codesOf(mutate('logs where (level == "error" or level == "warn") and ts >= since', 'logs where severity == "error"'))).toEqual(["MDT-E0120"]);
  });

  it("E1005: a read cannot return data above its environment's class", () => {
    // staging holds internal data; the overview row carries customers' names and phones.
    const src = mutate("    returns ShipmentStatusRow\n    max_rows 1\n  authorize deploy by policy", "    returns ShipmentRow\n    max_rows 1\n  authorize deploy by policy");
    expect(codesOf(src)).toEqual(["MDT-E1005"]);
  });

  it("E1006: an environment's tier names a critical effect; on anything else it would bind nothing", () => {
    const src = mutate("  authorize deploy by policy", "  authorize page by policy\n  authorize deploy by policy") + "\neffect page(text: Text) -> Bool\n";
    expect(codesOf(src)).toEqual(["MDT-E1006"]);
  });

  it("deploy is a std effect: it needs env.deploy over the environment it deploys to (E0301)", () => {
    const ship = (envs: string) => `mandate @ 0.3
module kervan.tasks.ship @ 0.1
use std.{env, human}
use kervan.system.{staging, prod_sim, mcp}
capability Deploys = env.deploy(${envs})
type Release = { version: Text }
contract Approved(r: Release) {
  accept approved "A person approved the release" by human.approve(role: "release_manager")
}
workflow Ship(version: Text) -> Text
  caps Deploys
{
  let r = verify Release { version: version } against Approved(Release { version: version })
  let p = effect deploy(r, prod_sim) idempotent_by version
  "shipped"
}
`;
    expect(codesOf(ship("staging, prod_sim"), { modules: modules() })).toEqual([]);
    // env.deploy(staging) does not deploy to prod_sim; it is also never used.
    expect(codesOf(ship("staging"), { modules: modules() })).toEqual(["MDT-E0301", "MDT-W0310"]);
    expect(codesOf(ship("staging, mcp"), { modules: modules() })).toContain("MDT-E1002");
  });

  it("E0120: an environment authorizes only known effects", () => {
    expect(codesOf(mutate('authorize deploy by human(role: "release_manager")', 'authorize deploi by human(role: "release_manager")'))).toEqual(["MDT-E0120"]);
  });
});

describe("programs import the system model", () => {
  it("open capabilities over components into paths, commands and repositories", () => {
    const r = check(PROGRAM, "mdt", { modules: modules() });
    expect(r.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    const req = sandboxRequirements(r.program!, modules());
    expect(req["McpDev"]!.filesystem).toEqual({ read: ["/work/kervan-mcp"], write: ["/work/kervan-mcp/src", "/work/kervan-mcp/test"] });
    expect(req["McpDev"]!.exec).toEqual([{ command: "npm", args_prefix: [["test"]] }]);
    expect(req["CoreDev"]!.filesystem).toEqual({ read: ["/work/kervan-core"], write: ["/work/kervan-core/src"] });
  });

  it("without the module loaded, its names are opaque and capabilities over them cannot be opened (E1002)", () => {
    expect(codesOf(PROGRAM)).toContain("MDT-E1002");
  });

  it("C5 holds across components: two par branches may write two components, never one", () => {
    expect(codesOf(PROGRAM, { modules: modules() })).toEqual([]);
    const same = PROGRAM.replace('capability CoreSrc  = component.write(core, "src")', 'capability CoreSrc  = component.write(mcp, "src/core")').replace("capability CoreRead = component.read(core)", "capability CoreRead = component.read(mcp)");
    expect(codesOf(same, { modules: modules() })).toEqual(["MDT-E0320"]);
  });

  it("E1002: component capabilities take components, paths inside them and declared commands", () => {
    const with_ = (line: string): string[] => codesOf(PROGRAM.replace('capability CoreSrc  = component.write(core, "src")', line), { modules: modules() });
    expect(with_('capability CoreSrc  = component.write(prod_sim, "src")')).toContain("MDT-E1002");
    expect(with_('capability CoreSrc  = component.write(core, "../kervan-auth")')).toContain("MDT-E1002");
    expect(with_("capability CoreSrc  = component.exec(search, build)")).toContain("MDT-E1002");
    expect(with_("capability CoreSrc  = component.exec(mcp, deploy)")).toContain("MDT-E1002");
  });

  it("E1002: a capability that stands for several commands is not narrowed as one", () => {
    // mcp builds with node and tests with npm here: two exec capabilities, one per command.
    const twoCommands = mutate('  build    exec("npm", ["ci", "--ignore-scripts"]), exec("npm", ["run", "build"])\n  test     exec("npm", ["test"])\n  provides CustomerTools', '  build    exec("node", ["build.js"])\n  test     exec("npm", ["test"])\n  provides CustomerTools');
    const m = check(twoCommands, "mdt").program!;
    const src = PROGRAM.replace("capability Model    = model.infer(tier: standard)", 'capability Model    = model.infer(tier: standard)\ncapability McpAll   = component.exec(mcp, build, test)\ncapability McpCi    = McpAll.narrow("npm")');
    expect(codesOf(src, { modules: { "kervan.system": m } })).toContain("MDT-E1002");
  });

  it("E0120 and E0121: imported names exist in the module and do not collide with local ones", () => {
    expect(codesOf(PROGRAM.replace("use kervan.system.{mcp, core, prod_sim}", "use kervan.system.{mcp, core, prod_sim, ledger}"), { modules: modules() })).toContain("MDT-E0120");
    expect(codesOf(PROGRAM.replace("type Patch = { files: List<Path> }", "type Patch = { files: List<Path> }\ntype ShipmentRow = Text"), { modules: modules() })).toContain("MDT-E0121");
  });

  it("E0142: the lock pins the system model by its hash", () => {
    const hash = hashProgram(kervan() as unknown as Json).program;
    const models = JSON.parse(readRepo("examples/fixbug/mandate.lock.json")) as Lock;
    const lock = (pin?: string): Lock => ({ ...models, modules: pin ? { "kervan.system": pin } : {} });
    expect(codesOf(PROGRAM, { modules: modules(), lock: lock(hash) })).toEqual([]);
    expect(codesOf(PROGRAM, { modules: modules(), lock: lock("sha256:00") })).toEqual(["MDT-E0142"]);
    expect(codesOf(PROGRAM, { modules: modules(), lock: lock() })).toEqual(["MDT-E0142"]);
  });

  it("loadModules checks each module and keys it by name", () => {
    const { modules: m, problems } = loadModules([{ file: "kervan.system.mdt", text: KERVAN, kind: "mdt" }]);
    expect(problems).toEqual([]);
    expect(Object.keys(m)).toEqual(["kervan.system"]);
    const bad = loadModules([{ file: "bad.mdt", text: mutate("  provides TokenIssuance\n}", "}"), kind: "mdt" }]);
    expect(bad.problems.flatMap((p) => p.diagnostics.map((d) => d.code))).toEqual(["MDT-E1001"]);
  });
});

describe("changing the system model is a governance change (doc 9 §1, §5.3)", () => {
  it("is reported by a patch", () => {
    const p = kervan();
    const base = hashProgram(p as unknown as Json).program;
    const r = applyPatch(p, base, [{ op: "replace", path: "/defs/prod_sim/authorize/deploy", value: { by: "policy" } }]);
    expect(r.ok).toBe(true);
    expect(r.governance).toEqual([{ kind: "system_model_changed", path: "/defs/prod_sim", detail: "environment 'prod_sim' changed" }]);
  });

  it("is listed under governance in the semantic diff", () => {
    const before = kervan();
    const after = check(mutate('owner    role "core_owner"', 'owner    role "platform_owner"'), "mdt").program!;
    const v = semanticDiff(before, after);
    expect(v.governance.map((g) => g.text)).toEqual(['~ component core.owner: "core_owner" → "platform_owner"']);
    expect(v.behavior).toEqual([]);
  });
});
