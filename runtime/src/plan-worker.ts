// The worker a lead's writing is checked in (spec/envelope.md "Limits"): a
// sub-program, or an amendment of the envelope. It runs in a thread of its
// own, so the runtime can stop a check that takes too long without stopping
// anything else. It holds nothing: each message is one check, and its answer
// is the check's result.

import { parentPort } from "node:worker_threads";
import { checkSubprogram, type SubprogramInput } from "@mandate/compiler";
import { checkAmended, type AmendedInput } from "./package.js";

parentPort?.on("message", (m: { id: number; input?: SubprogramInput; amendment?: AmendedInput }) => {
  try {
    parentPort!.postMessage({ id: m.id, result: m.amendment ? checkAmended(m.amendment) : checkSubprogram(m.input!) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
