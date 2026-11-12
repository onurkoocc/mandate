// A sub-program checker that keeps everything it makes, as a check of a
// pathological program would: it ends when its thread's heap is full.

import { parentPort } from "node:worker_threads";

parentPort?.on("message", () => {
  const kept: number[][] = [];
  for (;;) kept.push(new Array<number>(1 << 16).fill(kept.length));
});
