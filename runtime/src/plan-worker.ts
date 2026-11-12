// The worker a lead's sub-program is checked in (spec/envelope.md "Limits").
// It runs in a thread of its own, so the runtime can stop a check that takes
// too long without stopping anything else. It holds nothing: each message is
// one check, and its answer is the check's result.

import { parentPort } from "node:worker_threads";
import { checkSubprogram, type SubprogramInput } from "@mandate/compiler";

parentPort?.on("message", (m: { id: number; input: SubprogramInput }) => {
  try {
    parentPort!.postMessage({ id: m.id, result: checkSubprogram(m.input) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
