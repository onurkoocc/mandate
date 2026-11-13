// Activities run in a Temporal worker and do the run's real work through
// the Runtime, against PostgreSQL. Temporal may run an activity more than
// once; that is safe because the Runtime resumes from the journal and fences
// out older attempts. Activity retries are never the business idempotency
// (§16.1): commands and actions are deduplicated in PostgreSQL.

import { Context } from "@temporalio/activity";
import type { RunRow } from "../journal.js";
import type { Runtime } from "../runtime.js";
import { Violation } from "../signals.js";
import { isObj } from "../values.js";
import type { Progress } from "./workflows.js";

export interface Activities {
  /** Takes the run's lease and drives it until it waits, needs attention or ends. */
  drive(runId: string): Promise<Progress>;
  /** A wait's deadline passed: expires it, then drives the run on. */
  expire(runId: string): Promise<Progress>;
}

export function createActivities(rt: Runtime): Activities {
  const heartbeating = async (fn: () => Promise<RunRow>): Promise<Progress> => {
    const ctx = Context.current();
    const timer = setInterval(() => ctx.heartbeat(), 5_000);
    try {
      return progress(rt, await fn());
    } finally {
      clearInterval(timer);
    }
  };
  return {
    // A run in a halted scope is not resumed (spec/boundary.md "Violations and halt"). That is where it stays until the
    // halt is lifted, not a failure to retry: the run is reported as it is, and its workflow parks or ends with it.
    drive: (runId) =>
      heartbeating(async () => {
        try {
          return await rt.resume(runId);
        } catch (e) {
          if (e instanceof Violation && e.code === "halted") return rt.getRun(runId);
          throw e;
        }
      }),
    expire: (runId) => heartbeating(() => rt.tick(runId)),
  };
}

export function progress(rt: Runtime, run: RunRow): Progress {
  const req = isObj(run.waiting) ? run.waiting["request"] : null;
  const deadline = run.state === "waiting" && isObj(req) ? req["deadline"] : null;
  return { runId: run.run_id, state: run.state, wakeInMs: typeof deadline === "number" ? Math.max(0, deadline - rt.adapters.clock.now()) : null };
}
