// A sub-program checker that never answers: it spins in its thread, as a
// check of a pathological program would. Only ending the thread stops it.

import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => {
  for (;;) {
    // Busy, so that no timer or message of its own could end it.
  }
});
