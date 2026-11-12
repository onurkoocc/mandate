// A sub-program checker that fails on whatever it is given: it throws, and
// nothing catches it, so its thread ends with an error.

import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => {
  throw new Error("the checker broke");
});
