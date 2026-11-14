// Activities run in a Temporal worker and do the run's real work through
// the Runtime, against PostgreSQL. Temporal may run an activity more than
// once; that is safe because the Runtime resumes from the journal and fences
// out older attempts. Activity retries are never the business idempotency
// (§16.1): commands and actions are deduplicated in PostgreSQL.

import { ApplicationFailure, Context } from "@temporalio/activity";
import type { RunRow } from "../journal.js";
import type { Runtime } from "../runtime.js";
import { Violation } from "../signals.js";
import { isObj } from "../values.js";
import { UNFIT_HOST, type Progress } from "./workflows.js";

/**
 * How many times an activity is tried before a refusal of its worker's host (`unfit_host`) fails the run's workflow.
 * The tries before the last are retried as any failure is, after 1 s and then 2 s, so a fit worker on the same task
 * queue can take the activity; the last is not retried. Counted by the activity's attempt, which a worker that died
 * also raises.
 */
export const UNFIT_ATTEMPTS = 3;

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
    } catch (e) {
      // This worker's host does not meet the package's lock: it took nothing and wrote nothing, and the run is as it
      // was. Another worker may be fit; once the attempts are spent, the failure is not retried and ends the workflow.
      if (e instanceof Violation && e.code === UNFIT_HOST) {
        throw ctx.info.attempt < UNFIT_ATTEMPTS ? ApplicationFailure.retryable(e.message, UNFIT_HOST) : ApplicationFailure.nonRetryable(e.message, UNFIT_HOST);
      }
      throw e;
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
