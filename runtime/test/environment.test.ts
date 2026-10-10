// Environment tiers (design doc 9 §5.3; BACKLOG item 37, B9). An environment
// sets the least authorization for effects in it, and it is the
// organization's, not the program's: Acme's prod_sim wants the release
// manager for a deploy, staging is fine with policy. A run whose policy would
// let policy authorize every deploy still waits for the release manager on
// prod_sim; the tier is never lowered.

import { afterAll, describe, expect, it } from "vitest";
import type { RunRow } from "../src/journal.js";
import { SimTool } from "../src/sim.js";
import { isObj, type Obj } from "../src/values.js";
import { closeAll, world, type World } from "./helpers.js";
import { acmeModules, lockFor } from "./acme.js";

afterAll(closeAll);

const SHIP = `mandate @ 0.3
module acme.tasks.ship @ 0.1
use std.{env, human}
use acme.system.{staging, prod_sim}

capability Deploys = env.deploy(staging, prod_sim)

type Release = { version: Text }

contract Approved(r: Release) {
  accept tagged "The release names its version" by static len(r.version) >= 1
  accept approved "A person approved the release" by human.approve(role: "release_manager")
}

workflow Ship(version: Text) -> Text
  caps Deploys
{
  let r = verify Release { version: version } against Approved(Release { version: version })
  let s = effect deploy(r, staging) idempotent_by version
  let p = effect deploy(r, prod_sim) idempotent_by version
  "shipped"
}
`;

async function decide(w: World, run: RunRow, approve: boolean): Promise<RunRow> {
  const wait = run.waiting as Obj;
  const req = wait["request"] as Obj;
  return w.rt.decideAction(run.run_id, { sender: String(req["role"]), messageId: `${String(wait["command"])}-${approve}` }, { commandId: String(wait["command"]), revision: run.revision, digest: String(req["subject_digest"] ?? req["action_digest"]), approve, by: String(req["role"]) });
}

describe("environment tiers (B9)", () => {
  it("authorizes staging's deploy by policy, and waits for the release manager on prod_sim although the run's policy says policy", async () => {
    const modules = acmeModules();
    const tool = new SimTool("deploy", "reconcilable");
    const w = await world(SHIP, { modules, lock: lockFor(modules), tools: [tool] });
    let run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { version: "1.4.0" }, authorize: { deploy: { by: "policy" } } });
    // The release itself is approved first (the contract's criterion).
    run = await decide(w, run, true);
    // staging's deploy went out on policy; prod_sim's waits for the role its environment names.
    expect(tool.executions).toHaveLength(1);
    expect(run.state).toBe("waiting");
    const req = (run.waiting as Obj)["request"] as Obj;
    expect(req).toMatchObject({ effect: "deploy", role: "release_manager", environment: "prod_sim", tier: { by: "human", role: "release_manager" } });
    run = await decide(w, run, true);
    expect(run.state, JSON.stringify(run.error ?? run.attention)).toBe("succeeded");
    expect(tool.executions).toHaveLength(2);
  });

  it("sends nothing to prod_sim when the release manager declines", async () => {
    const modules = acmeModules();
    const tool = new SimTool("deploy", "reconcilable");
    const w = await world(SHIP, { modules, lock: lockFor(modules), tools: [tool] });
    let run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { version: "1.4.1" }, authorize: { deploy: { by: "policy" } } });
    run = await decide(w, run, true);
    run = await decide(w, run, false);
    expect(run.state).toBe("failed");
    expect(isObj(run.error) && JSON.stringify(run.error)).toContain("Rejected");
    expect(tool.executions).toHaveLength(1);
  });
});
