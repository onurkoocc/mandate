// A verifier process for tests: the simulated verifier behind the real
// stdio protocol, with a key of its own (verifier-service.ts).
//
//   sim-verifier-process <key file>          answers honestly
//   sim-verifier-process <key file> lie      a check that failed is reported as passed,
//                                            under the signature of what it really found
//   sim-verifier-process <key file> v01      signs each check as mandate/check-attestation/0.1,
//                                            as a verifier that does not read the binding would
//   sim-verifier-process <key file> rebind   signs each check for another part than the one it was sent

import { createInterface } from "node:readline";
import { PassThrough, Transform } from "node:stream";
import { EvidenceSigner } from "../../src/evidence.js";
import { SimVerifier } from "../../src/sim.js";
import { serveVerifier } from "../../src/verifier-service.js";

const [key, mode] = process.argv.slice(2);
const lie = mode === "lie";
const out = lie
  ? new Transform({ transform: (chunk, _enc, done) => done(null, String(chunk).replace('"result":{"passed":false', '"result":{"passed":true')) })
  : process.stdout;
if (lie) out.pipe(process.stdout);

/** What the service reads: each check's binding taken out (v01) or changed (rebind) on the way in. */
function input(): NodeJS.ReadableStream {
  if (mode !== "v01" && mode !== "rebind") return process.stdin;
  const through = new PassThrough();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const msg = JSON.parse(line) as { method?: string; params?: { binding?: { run: string; part: string } } };
    if (msg.method === "check" && msg.params?.binding) {
      if (mode === "v01") delete msg.params.binding;
      else msg.params.binding = { ...msg.params.binding, part: `${msg.params.binding.part}/elsewhere` };
    }
    through.write(`${JSON.stringify(msg)}\n`);
  });
  lines.on("close", () => through.end());
  return through;
}

await serveVerifier(() => new SimVerifier(lie ? { regression_test: false } : {}), EvidenceSigner.loadOrCreate(key!), input(), out);
