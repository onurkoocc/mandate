// Temporal scheduling for the Mandate runtime (step 3b). A separate entry
// point, `@mandate/runtime/temporal`, so the core runtime does not load the
// Temporal SDK.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError, type Client } from "@temporalio/client";
import { Worker, type NativeConnection, type WorkerOptions } from "@temporalio/worker";
import type { Driver, Runtime } from "../runtime.js";
import { createActivities } from "./activities.js";
import { WORKFLOW, wakeSignal, type Progress } from "./workflows.js";

export { createActivities, progress, type Activities } from "./activities.js";
export { WORKFLOW, type Progress } from "./workflows.js";

/** One Temporal workflow per run, identified by the run id. */
export function workflowId(runId: string): string {
  return `mandate-run/${runId}`;
}

/** The Runtime's driver when Temporal schedules runs: control calls start or signal the run's workflow. */
export class TemporalDriver implements Driver {
  constructor(
    readonly client: Client,
    readonly taskQueue: string,
  ) {}

  async start(runId: string): Promise<void> {
    try {
      await this.client.workflow.start(WORKFLOW, { args: [runId], taskQueue: this.taskQueue, workflowId: workflowId(runId) });
    } catch (e) {
      // StartRun retried by its caller: the run already has its workflow.
      if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
    }
  }

  async wake(runId: string): Promise<void> {
    try {
      await this.client.workflow.getHandle(workflowId(runId)).signal(wakeSignal);
    } catch (e) {
      // The workflow already finished: the run is terminal and nothing needs waking.
      if (!(e instanceof WorkflowNotFoundError)) throw e;
    }
  }

  /** Waits for the run's workflow to finish. */
  result(runId: string): Promise<Progress> {
    return this.client.workflow.getHandle(workflowId(runId)).result();
  }
}

/** The workflow source, for `bundleWorkflowCode` or `workflowsPath`. */
export function workflowsPath(): string {
  const js = fileURLToPath(new URL("./workflows.js", import.meta.url));
  return existsSync(js) ? js : fileURLToPath(new URL("./workflows.ts", import.meta.url));
}

/**
 * A worker for Mandate runs. `runtime` must drive inline (no driver): it is
 * the one the activities call.
 */
export function createWorker(o: {
  connection: NativeConnection;
  taskQueue: string;
  runtime: Runtime;
  namespace?: string;
  workflowBundle?: WorkerOptions["workflowBundle"];
}): Promise<Worker> {
  if (o.runtime.driver) throw new Error("The worker's Runtime must drive runs inline; give it no driver.");
  return Worker.create({
    connection: o.connection,
    taskQueue: o.taskQueue,
    ...(o.namespace ? { namespace: o.namespace } : {}),
    ...(o.workflowBundle ? { workflowBundle: o.workflowBundle } : { workflowsPath: workflowsPath() }),
    activities: createActivities(o.runtime),
  });
}
