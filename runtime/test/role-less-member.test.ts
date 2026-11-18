// A member the lock lists and binds to no role may answer a wait that asks no role (`roleRefusal`): it has the cap of a
// role the lock does not name, `internal` (spec/attention.md "Lock 0.7"). E1909 holds such a wait to it, so a package
// whose wait that asks no role shows more is refused at load, also under a lock that binds no role at all; one that
// shows no more runs, `ListWaits` lists the wait to that member in no role (`role: null`) at that cap, and the member's
// answer is taken. Nothing else is listed to such a member.
import type { Lock } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import { payloadOf, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { waitsText } from "../src/person.js";
import { closeAll, world, type World } from "./helpers.js";

afterAll(closeAll);

/** A program that asks no role about a value of `cls`, declaring the role reviewer when `withRole`, which it asks once too. */
const src = (cls: string, withRole = true): string => `mandate @ 0.7

module example.roleless @ 0.1

use std.{human}

${withRole ? 'role reviewer "Reviewer"\n\n' : ""}type Secret = Text classified ${cls}

workflow Ask(secret: Secret) -> Untrusted<Text>
  caps   []
  budget { time: 5m, steps: 4 }
{
  let a = human.ask("Is {secret} right?")
  a
}
${
  withRole
    ? `
workflow Reviewed(secret: Secret) -> Untrusted<Text>
  caps   []
  budget { time: 5m, steps: 4 }
{
  let a = human.ask("Is {secret} right?", role: reviewer)
  a
}
`
    : ""
}`;

const ana = EvidenceSigner.generate();
const zed = EvidenceSigner.generate();
const keys = new TrustedKeys([ana.publicKey, zed.publicKey]);

/** The reviewer's lock: Ana the reviewer, who may be shown confidential data; Zed listed, and bound to no role. */
const withReviewer = { modules: {}, members: { ana: { keys: [ana.keyId] }, zed: { keys: [zed.keyId] } }, roles: { reviewer: ["ana"] }, role_classes: { reviewer: "confidential" } } as unknown as Lock;
/** A lock that binds no role: Zed alone. */
const noRoles = { modules: {}, members: { zed: { keys: [zed.keyId] } } } as unknown as Lock;

const msg = (() => {
  let n = 0;
  return () => ({ sender: "test", messageId: `m${++n}` });
})();
const start = (w: World, runId: string, workflow = "Ask") => w.rt.startRun({ pkg: w.pkg, workflow, input: { secret: "the figure" }, runId });

async function answerAs(w: World, runId: string, who: EvidenceSigner, member: string, value: string) {
  const signed = signDecision(who, await w.rt.shown(runId, "wait"), { kind: "answer", member, payload: payloadOf.answer(value), at: new Date(w.adapters.clock.now()) });
  return w.rt.submitInput(runId, msg(), { value, signed });
}

describe("a member the lock lists and binds to no role", () => {
  it("holds a wait that asks no role to internal: above it, the package is refused at load (E1909), also under a lock that binds no role", async () => {
    for (const [lock, withRole] of [
      [withReviewer, true],
      [noRoles, false],
    ] as const) {
      const w = await world(src("confidential", withRole), { lock, decisions: { keys } });
      await expect(start(w, "high")).rejects.toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("MDT-E1909") });
      expect(await w.db.query("select run_id from runs")).toEqual([]);
      expect(await w.rt.listWaits({ member: "zed" })).toEqual([]);
    }
  });

  it("is listed a wait that asks no role at internal, in no role, and its answer is the run's", async () => {
    for (const cls of ["internal", "public"]) {
      for (const [lock, withRole] of [
        [withReviewer, true],
        [noRoles, false],
      ] as const) {
        const w = await world(src(cls, withRole), { lock, decisions: { keys } });
        expect((await start(w, "any")).state).toBe("waiting");
        const listed = await w.rt.listWaits({ member: "zed" });
        expect(listed.map((x) => [x.run, x.asked_of, x.role])).toEqual([["any", null, null]]);
        expect(listed[0]!.shown).toEqual([expect.objectContaining({ masked: false, value: "Is the figure right?", class: cls })]);
        expect(waitsText({ member: "zed" }, listed)).toContain("asked of nobody in particular, listed to a member of no role; shown as a member of no role (internal)");
        // A member who holds a role is listed it in that role, as before.
        if (withRole) expect((await w.rt.listWaits({ member: "ana" })).map((x) => x.role)).toEqual(["reviewer"]);
        const done = await answerAs(w, "any", zed, "zed", "yes");
        expect(done.state).toBe("succeeded");
        expect(done.result).toBe("yes");
      }
    }
  });

  it("is listed no wait asked of a role", async () => {
    const v = await world(src("internal"), { lock: withReviewer, decisions: { keys } });
    expect((await start(v, "asked", "Reviewed")).state).toBe("waiting");
    expect(await v.rt.listWaits({ member: "zed" })).toEqual([]);
    expect((await v.rt.listWaits({ member: "ana" })).map((x) => x.role)).toEqual(["reviewer"]);
  });
});
