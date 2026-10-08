// The Temporal workflow that schedules one Mandate run (Doc 4 §16.1: "a
// small workflow driver"). Temporal's history only holds scheduling: when
// to drive the run, when a deadline passes, when a control call wakes it.
// Everything the run decides, records or spends stays in PostgreSQL, which
// the activities read and write. There is no distributed transaction
// between the two: an activity that runs twice resumes the run against its
// journal, and the lease fence stops a stale attempt from writing.
//
// This file is bundled into Temporal's deterministic workflow sandbox, so it
// imports nothing but the workflow SDK and types.

import { condition, defineSignal, proxyActivities, setHandler, sleep } from "@temporalio/workflow";
import type { Activities } from "./activities.js";

/** Where a run stands after an activity drove it. */
export interface Progress {
  runId: string;
  state: string;
  /** Milliseconds until the deadline of the wait the run is in, if it has one. */
  wakeInMs: number | null;
}

/** Sent after a control call (input, decision, cancel, reconcile) changed the journal. */
export const wakeSignal = defineSignal("wake");

export const WORKFLOW = "mandateRun";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const PARKED = new Set(["waiting", "attention_required"]);

const { drive, expire } = proxyActivities<Activities>({
  startToCloseTimeout: "1 hour",
  // A worker that dies is noticed within a heartbeat and the run is resumed elsewhere.
  heartbeatTimeout: "30 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "1 minute" },
});

export async function mandateRun(runId: string): Promise<Progress> {
  let woken = false;
  setHandler(wakeSignal, () => {
    woken = true;
  });
  let p = await drive(runId);
  for (;;) {
    if (TERMINAL.has(p.state)) return p;
    if (!PARKED.has(p.state)) {
      // Another worker held a newer lease when this one returned; look again shortly.
      await sleep("1 second");
      p = await drive(runId);
      continue;
    }
    const signalled = p.wakeInMs === null ? (await condition(() => woken), true) : await condition(() => woken, Math.max(1, p.wakeInMs));
    woken = false;
    p = signalled ? await drive(runId) : await expire(runId);
  }
}
