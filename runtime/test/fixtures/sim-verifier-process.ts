// A verifier process for tests: the simulated verifier behind the real
// stdio protocol, with a key of its own (verifier-service.ts).
//
//   sim-verifier-process <key file>          answers honestly
//   sim-verifier-process <key file> lie      a check that failed is reported as passed,
//                                            under the signature of what it really found

import { Transform } from "node:stream";
import { EvidenceSigner } from "../../src/evidence.js";
import { SimVerifier } from "../../src/sim.js";
import { serveVerifier } from "../../src/verifier-service.js";

const [key, mode] = process.argv.slice(2);
const lie = mode === "lie";
const out = lie
  ? new Transform({ transform: (chunk, _enc, done) => done(null, String(chunk).replace('"result":{"passed":false', '"result":{"passed":true')) })
  : process.stdout;
if (lie) out.pipe(process.stdout);
await serveVerifier(() => new SimVerifier(lie ? { regression_test: false } : {}), EvidenceSigner.loadOrCreate(key!), process.stdin, out);
