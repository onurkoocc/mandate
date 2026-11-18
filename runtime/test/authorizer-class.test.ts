// The runtime's configuration may hand an authorization to another role than the program names
// (spec/attention.md "Effects and the runtime's configuration"): `authorize[E] = { by: "human", role }` overrides an
// irreversible action's `owner`. E1909 compares what the authorization shows with the role the program names; the
// start compares it with the role the configuration names, and refuses a run that would ask a role to decide on data
// above its cap (`authorizer_below_class`) before anything is written.
import type { Lock } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import { signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { SimTool } from "../src/sim.js";
import { closeAll, world } from "./helpers.js";

afterAll(closeAll);

/** An irreversible merge of a confidential change the owner approved: under the default policy the role `owner` decides it. */
const SRC = `mandate @ 0.7

module example.authorizer @ 0.1

use std.{human, git}

role owner  "Owner"
role intern "Intern"

type Change = { files: List<Text> } classified confidential

capability Pr = git.pr("example/api")

contract Ready(c: Change) {
  accept owned "The owner approves the change" by human.approve(role: owner)
}

workflow Merging(c: Change) -> Text
  caps   Pr
  budget { steps: 4, asks: 3 }
{
  let ok = verify c against Ready(c)
  let merged = effect git.merge(ok) idempotent_by "merge"
  "merged"
}
`;

const AT = "/defs/Merging/body/1/value";
const ana = EvidenceSigner.generate();
const cy = EvidenceSigner.generate();

/** Ana is the owner and Cy the intern; the owner may be shown confidential data, the intern `intern`'s class. */
function lockWith(intern?: string): Lock {
  return {
    modules: {},
    members: { ana: { keys: [ana.keyId] }, cy: { keys: [cy.keyId] } },
    roles: { owner: ["ana"], intern: ["cy"] },
    role_classes: { owner: "confidential", ...(intern ? { intern } : {}) },
  } as unknown as Lock;
}

const input = { c: { files: ["a.ts"] } };
const toIntern = { "git.merge": { by: "human" as const, role: "intern" } };

describe("an authorization the configuration hands to another role", () => {
  it("is refused at the start when that role's cap is below what it shows, before anything is written", async () => {
    const w = await world(SRC, { tools: [new SimTool("git.merge", "reconcilable")], lock: lockWith(), decisions: { keys: new TrustedKeys([ana.publicKey, cy.publicKey]) } });
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Merging", runId: "low", input, authorize: toIntern })).rejects.toThrow(
      /authorizer_below_class: The runtime's configuration hands the authorization of git\.merge to role intern, which may be shown data up to internal .*, and it shows confidential data \(the program names owner for it\)/,
    );
    const rows = await w.db.query<{ n: unknown }>("select count(*) as n from runs where run_id = $1", ["low"]);
    expect(Number(rows[0]!.n)).toBe(0);
    expect(await w.rt.listWaits({ member: "cy" })).toEqual([]);
    // Without the configuration the owner, whose cap covers it, is asked.
    const own = await w.rt.startRun({ pkg: w.pkg, workflow: "Merging", runId: "own", input });
    expect(own.state).toBe("waiting");
    // Handed to policy, nobody is asked, and the run starts.
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Merging", runId: "policy", input, authorize: { "git.merge": { by: "policy" } } })).resolves.toBeDefined();
  });

  it("runs when that role's cap covers it, and asks that role, unmasked", async () => {
    const w = await world(SRC, { tools: [new SimTool("git.merge", "reconcilable")], lock: lockWith("confidential"), decisions: { keys: new TrustedKeys([ana.publicKey, cy.publicKey]) } });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Merging", runId: "high", input, authorize: toIntern });
    expect(r.state).toBe("waiting");
    // The owner approves the change; the merge then waits for the intern.
    const signed = signDecision(ana, await w.rt.shown("high", "wait"), { kind: "approve", member: "ana", at: new Date(w.adapters.clock.now()) });
    expect((await w.rt.decideAction("high", { sender: "t", messageId: "m1" }, { signed })).state).toBe("waiting");
    const waits = await w.rt.listWaits({ member: "cy" });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ command: `${AT}/authorize`, role: "intern" });
    expect(JSON.stringify(waits[0])).not.toContain('"masked":true');
  });
});
