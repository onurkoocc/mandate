// The verifier process (BACKLOG P2-11; verifier-service.ts). The runtime
// starts it when `mandate.runtime.json` sets `verifier.process`:
//
//   node verifier-main.js --config mandate.runtime.json    serve checks over stdio
//   node verifier-main.js --init-key <file>                 create the key and <file>.pub
//
// It reads the same configuration as the runtime, runs the checks the same
// way (each test in a sandbox of its own), and signs each result with its
// own key, which the runtime process never reads. Its stdout carries only
// the protocol.

import { writeFileSync } from "node:fs";
import { localVerifier, readConfig } from "./control.js";
import { EvidenceSigner } from "./evidence.js";
import { serveVerifier } from "./verifier-service.js";

const args = process.argv.slice(2);
const at = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const init = at("--init-key");
const file = at("--config");
if (init) {
  const signer = EvidenceSigner.loadOrCreate(init);
  writeFileSync(`${init}.pub`, signer.publicKeyPem());
} else if (file) {
  const config = readConfig(file);
  const key = config.verifier?.process?.key;
  if (!key) {
    process.stderr.write(`${file}: verifier.process is not set\n`);
    process.exit(2);
  }
  await serveVerifier((pkg) => localVerifier(config, pkg.program, pkg.lock), EvidenceSigner.loadOrCreate(key), process.stdin, process.stdout);
} else {
  process.stderr.write("usage: verifier-main --config <mandate.runtime.json> | --init-key <file>\n");
  process.exit(2);
}
