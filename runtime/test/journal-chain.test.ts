// The chained journal (spec/journal.md): anchors signed at every state
// change, the export, and the verifier that reads only the export and keys.

import { afterAll, describe, expect, it } from "vitest";
import { ANCHOR_FORMAT, anchorStatement } from "../src/journal-chain.js";
import { closeAll, start, world, type World } from "./helpers.js";
import { ASK } from "./programs.js";

afterAll(closeAll);

const STATE = /^run_(accepted|running|waiting|cancelling|attention_required|succeeded|failed|cancelled)$/;

async function rows(w: World, runId: string) {
  const events = await w.db.query<{ seq: unknown; type: string; at: unknown; hash: string | null }>("select seq, type, at, hash from events where run_id = $1 order by seq", [runId]);
  const anchors = await w.db.query<{ seq: unknown; hash: string; at: unknown; key_id: string; signature: string }>("select seq, hash, at, key_id, signature from journal_anchors where run_id = $1 order by seq", [runId]);
  return {
    events: events.map((e) => ({ seq: Number(e.seq), type: e.type, at: Number(e.at), hash: e.hash })),
    anchors: anchors.map((a) => ({ seq: Number(a.seq), hash: a.hash, at: Number(a.at), key_id: a.key_id, signature: a.signature })),
  };
}

/** Answers the question the ASK run waits for. */
async function answer(w: World, runId: string, messageId = "m1") {
  const run = await w.rt.getRun(runId);
  return w.rt.submitInput(runId, { sender: "ann", messageId }, { commandId: String((run.waiting as { command: string }).command), revision: run.revision, value: "yes" });
}

describe("anchors (spec/journal.md)", () => {
  it("are signed by the evidence key at every state change, over the state event's seq, hash and time", async () => {
    const w = await world(ASK);
    await start(w, "Ask", "a1");
    expect((await answer(w, "a1")).state).toBe("succeeded");
    const { events, anchors } = await rows(w, "a1");
    const states = events.filter((e) => STATE.test(e.type));
    expect(states.map((e) => e.type)).toEqual(["run_accepted", "run_running", "run_waiting", "run_running", "run_succeeded"]);
    expect(anchors.map((a) => a.seq)).toEqual(states.map((e) => e.seq));
    for (const a of anchors) {
      const e = events.find((x) => x.seq === a.seq)!;
      expect([a.hash, a.at, a.key_id]).toEqual([e.hash, e.at, w.rt.signer.keyId]);
      expect(w.rt.trusted.verifyStatement(ANCHOR_FORMAT, anchorStatement("a1", a.seq, a.hash, a.at), a)).toBe(true);
    }
  });

  it("are never events: the event list is what it was", async () => {
    const w = await world(ASK);
    await start(w, "Ask", "a2");
    expect((await w.rt.journal.events("a2")).map((e) => e.type)).toEqual(["run_accepted", "lease_acquired", "run_running", "wait_opened", "run_waiting"]);
  });

  it("are not written for a run begun before the chain", async () => {
    const w = await world(ASK);
    await start(w, "Ask", "a3");
    await w.db.query("update events set hash = null where run_id = $1", ["a3"]);
    await w.db.query("delete from journal_anchors where run_id = $1", ["a3"]);
    expect((await answer(w, "a3")).state).toBe("succeeded");
    expect((await rows(w, "a3")).anchors).toEqual([]);
  });
});
