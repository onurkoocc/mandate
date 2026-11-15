// The worker a lead's writing is checked in (spec/envelope.md "Limits"): a
// sub-program, or an amendment of the envelope. It runs in a thread of its
// own, so the runtime can stop a check that takes too long without stopping
// anything else. It holds nothing: each message is one check, and its answer
// is the check's result.
//
// It answers with the compiler the thread that started it answers with: the
// mode, and the Rust compiler's module already compiled, come in `workerData`
// (`compilerForWorker`), so that the module is not read again. The Rust
// compiler's memory is its module's own, at most 256 MiB, not this thread's
// heap: a check that reaches that ceiling is `check_limit` as one that
// reaches the heap's is. Any other failure of the compiler is the check's
// failure (`check_failed`), never a check that passed. What `both` mode found
// (a difference between the two compilers, and its counts) is sent back with
// the answer, for the thread that started the worker to keep and raise.

import { parentPort, workerData } from "node:worker_threads";
import { checkSubprogram, type SubprogramInput } from "@mandate/bridge";
import { adoptCompiler, CompilerDivergence, CompilerFailure, takeCounts, takeDivergences, type WorkerCompiler } from "@mandate/bridge/mode";
import { checkAmended, type AmendedInput } from "./package.js";

adoptCompiler((workerData as { compiler?: WorkerCompiler } | null)?.compiler);

/** The memory the Rust compiler's module may have, in MB: what a check that runs out of it needed more than. */
const MODULE_MB = 256;

parentPort?.on("message", (m: { id: number; input?: SubprogramInput; amendment?: AmendedInput }) => {
  let answer: Record<string, unknown>;
  try {
    answer = { result: m.amendment ? checkAmended(m.amendment) : checkSubprogram(m.input!) };
  } catch (e) {
    if (e instanceof CompilerFailure && e.kind === "out_of_memory") answer = { limit: { limit: "memory", max: MODULE_MB } };
    else if (e instanceof CompilerDivergence) answer = {};
    // What the lead is told: a failure of the compiler as it may be shown to a model.
    else answer = { error: e instanceof CompilerFailure ? e.shown : e instanceof Error ? e.message : String(e) };
  }
  const divergences = takeDivergences().map((d) => ({ fn: d.fn, where: d.where, typescript: d.typescript, rust: d.rust }));
  parentPort!.postMessage({ id: m.id, ...answer, ...(divergences.length ? { divergences } : {}), counts: takeCounts() });
});
