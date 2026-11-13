// A verifier process for tests of the model gateway, in place of
// verifier-main.ts: each check sends one request to the model's API the way
// the verifier's model client does (gateway.ts `givenGateway`, from this
// process's environment), and its detail says what came back and what
// environment the process was started with.
//
//   gateway-verifier-process --config <file>     serve checks, signed with the configuration's verifier.process key
//   gateway-verifier-process --init-key <file>   create the key and <file>.pub

import { writeFileSync } from "node:fs";
import { readConfig } from "../../src/control.js";
import { EvidenceSigner } from "../../src/evidence.js";
import { givenGateway } from "../../src/gateway.js";
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
} else {
  const config = readConfig(at("--config")!);
  const send = givenGateway(process.env);
  await serveVerifier(
    () => ({
      check: async () => {
        const res = await send("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: '{"model":"m"}' });
        return { passed: res.status === 200, detail: { env: seen(), status: res.status, body: await res.text() } };
      },
    }),
    EvidenceSigner.loadOrCreate(config.verifier!.process!.key),
    process.stdin,
    process.stdout,
  );
}
