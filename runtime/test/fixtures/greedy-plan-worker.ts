// A sub-program checker that keeps everything it makes, as a check of a
// pathological program would. It stops at 128 MB and says so: a worker whose
// heap is limited below that ends before it gets there.

import { parentPort } from "node:worker_threads";

parentPort?.on("message", (m: { id: number }) => {
  const kept: number[][] = [];
  // 2^16 numbers are half a megabyte.
  while (kept.length < 256) kept.push(new Array<number>(1 << 16).fill(kept.length));
  parentPort?.postMessage({ id: m.id, error: `kept ${kept.length / 2} MB` });
});
