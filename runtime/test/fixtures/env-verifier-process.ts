// A verifier process for tests that says what environment it was started
// with, in place of verifier-main.ts:
//
//   env-verifier-process --config <file>     serve checks, signed with the configuration's verifier.process key;
//                                            each passes, and its detail lists the variables this process has
//   env-verifier-process --init-key <file>   create the key and <file>.pub, and write <file>.env.json, the same list

import { writeFileSync } from "node:fs";
import { readConfig } from "../../src/control.js";
import { EvidenceSigner } from "../../src/evidence.js";
import { serveVerifier } from "../../src/verifier-service.js";

const args = process.argv.slice(2);
const at = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const seen = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

const init = at("--init-key");
if (init) {
  const signer = EvidenceSigner.loadOrCreate(init);
  writeFileSync(`${init}.pub`, signer.publicKeyPem());
  writeFileSync(`${init}.env.json`, JSON.stringify(seen()));
} else {
  const config = readConfig(at("--config")!);
  await serveVerifier(() => ({ check: async () => ({ passed: true, detail: { env: seen() } }) }), EvidenceSigner.loadOrCreate(config.verifier!.process!.key), process.stdin, process.stdout);
}
