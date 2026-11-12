// The egress proxy over real sockets and real TLS (spec/egress.md "Upstream
// TLS"): a key and certificate made at test time with openssl, a local HTTPS
// server that stands in for the upstream, the configuration's `ca` pointed at
// the certificate, and the proxy's own dialer, which verifies the upstream's
// certificate for the host the request named. Linux with openssl only; no key
// or certificate is committed. The only thing injected is the resolver, which
// maps the test's host names to 127.0.0.1, and the upstream port, since a test
// cannot listen on 443.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressClient } from "../src/egress/client.js";
import { serveEgress, type EgressServer } from "../src/egress/main.js";
import { adminPath, http, SECRET, send } from "./egress-world.js";

const hasOpenssl = ((): boolean => {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)("the proxy's own dialer, against a local TLS server", () => {
  const dir = mkdtempSync(join(tmpdir(), "mdt-egtls-"));
  const where = adminPath();
  let upstream: Server;
  let proxy: EgressServer;
  let client: EgressClient;
  const seen: (string | undefined)[] = [];

  beforeAll(async () => {
    const [key, cert] = [join(dir, "key.pem"), join(dir, "cert.pem")];
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=upstream.test", "-addext", "subjectAltName=DNS:upstream.test"], { stdio: "ignore" });
    upstream = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      seen.push(req.headers["authorization"]);
      res.writeHead(200, { "content-type": "text/plain", "x-echo": String(req.headers["authorization"]) });
      res.end(`got ${String(req.headers["authorization"])}`);
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
    const config = join(dir, "mandate.egress.json");
    writeFileSync(config, JSON.stringify({ admin: where.path, allow_private: true, ca: cert, credentials: { github: { env: "MANDATE_EGRESS_GITHUB", hosts: ["upstream.test", "other.test"], header: "authorization", template: "Bearer {secret}" } } }));
    proxy = await serveEgress({
      config,
      env: { MANDATE_EGRESS_GITHUB: SECRET },
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      upstreamPort: (upstream.address() as { port: number }).port,
    });
    client = await EgressClient.connect(where.path);
  });

  afterAll(async () => {
    client?.close();
    await proxy?.stop();
    await new Promise<void>((ok) => (upstream ? upstream.close(() => ok()) : ok()));
    rmSync(dir, { recursive: true, force: true });
    where.cleanup();
  });

  it("swaps the placeholder, verifies the certificate for the host, and scrubs the echoed secret", async () => {
    const s = await client.openSession({ session: "tls-1", tenant: "acme", run: "r1", command: "c1", kind: "forward", destinations: [{ host: "upstream.test", methods: ["GET"], credential: "github" }, { host: "other.test", methods: ["GET"], credential: "github" }], ttl_ms: 60_000 });
    const port = Number(new URL(s.proxy_url).port);
    const ph = s.placeholders["github"]!;
    const r = await send(port, http(["GET http://upstream.test/x HTTP/1.1", "host: upstream.test", `authorization: Bearer ${ph}`]));
    expect(r.status, r.raw).toBe(200);
    expect(seen).toEqual([`Bearer ${SECRET}`]);
    expect(r.raw).not.toContain(SECRET);
    expect(r.header("x-echo")).toBe(`Bearer ${ph}`);
    expect(r.body).toBe(`got Bearer ${ph}`);
    // The same server, reached for a name its certificate does not carry, is refused before anything is sent.
    const wrong = await send(port, http(["GET http://other.test/x HTTP/1.1", "host: other.test", `authorization: Bearer ${ph}`]));
    expect(wrong.status).toBe(502);
    expect(seen).toHaveLength(1);
  });
});
