// The egress proxy's gateway sessions (spec/egress.md "Gateway sessions"):
// for the runtime's own HTTP clients, which take a base URL instead of a
// proxy. A gateway session has one destination and takes origin-form
// requests; every rule of the data path holds as it does for a forward one.

import { request } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, OTHER_SECRET, seenHeader, send, sid, world, type World } from "./egress-world.js";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});
beforeEach(() => {
  w.up.seen.length = 0;
  w.dials.length = 0;
  w.dns.clear();
  w.up.handler = (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ key: req.headers["x-api-key"] ?? null }));
  };
});

async function gateway(methods: string[] | null = ["POST"]) {
  const id = sid();
  const s = await w.client.openSession({ session: id, tenant: "acme", run: "r1", command: "c1", kind: "gateway", destinations: [{ host: "api.anthropic.com", methods, credential: "model" }], ttl_ms: 60_000 });
  return { id, base: s.base_url, port: Number(new URL(s.base_url).port), ph: s.placeholders["model"]! };
}

async function lastWhy(id: string): Promise<string | undefined> {
  return (await w.client.denials(id)).denials.at(-1)?.why;
}

describe("a gateway session", () => {
  it("takes origin-form requests at its base URL from a plain HTTP client and sends them to its one destination with the secret", async () => {
    const g = await gateway();
    const body = await new Promise<{ status: number; text: string }>((ok, fail) => {
      const req = request(`${g.base}/v1/messages`, { method: "POST", headers: { "x-api-key": g.ph, "content-type": "application/json" } }, (res) => {
        let text = "";
        res.setEncoding("latin1");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => ok({ status: res.statusCode!, text }));
      });
      req.on("error", fail);
      req.end('{"model":"m"}');
    });
    expect(body.status).toBe(200);
    // The upstream got the secret; the client got back the placeholder in its place.
    expect(seenHeader(w.up.seen[0]!, "x-api-key")).toEqual([OTHER_SECRET]);
    expect(JSON.parse(body.text)).toEqual({ key: g.ph });
    expect(seenHeader(w.up.seen[0]!, "host")).toEqual(["api.anthropic.com"]);
    expect(w.up.seen[0]!.url).toBe("/v1/messages");
    expect(w.up.seen[0]!.body).toBe('{"model":"m"}');
    expect(w.dials).toEqual([{ host: "api.anthropic.com", address: "93.184.215.14", port: 443, tls: true }]);
  });

  it("has exactly one destination", async () => {
    await expect(
      w.client.openSession({ session: sid(), tenant: "acme", run: "r1", command: "c1", kind: "gateway", destinations: [{ host: "api.anthropic.com", methods: null, credential: "model" }, { host: "example.org", methods: null, credential: null }], ttl_ms: 1000 }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("refuses a method the destination does not list", async () => {
    const g = await gateway();
    const r = await send(g.port, http(["GET /v1/models HTTP/1.1", "host: x"]));
    expect(r.header("x-mandate-egress-denied")).toBe("method_not_allowed");
    expect(await lastWhy(g.id)).toBe("method_not_allowed");
    expect(w.up.seen).toEqual([]);
  });

  it("refuses the placeholder anywhere but the configured header", async () => {
    const g = await gateway();
    const r = await send(g.port, http([`POST /v1/messages?k=${g.ph} HTTP/1.1`, "host: x", "content-length: 0"]));
    expect(r.header("x-mandate-egress-denied")).toBe("placeholder_misuse");
    const r2 = await send(g.port, http(["POST /v1/messages HTTP/1.1", "host: x", `authorization: Bearer ${g.ph}`, "content-length: 0"]));
    expect(r2.header("x-mandate-egress-denied")).toBe("placeholder_misuse");
    expect(w.up.seen).toEqual([]);
  });

  it("refuses CONNECT, even to a destination with neither credential nor method restriction", async () => {
    const s = await w.client.openSession({ session: sid(), tenant: "acme", run: "r1", command: "c1", kind: "gateway", destinations: [{ host: "registry.npmjs.org", methods: null, credential: null }], ttl_ms: 60_000 });
    const r = await send(Number(new URL(s.base_url).port), http(["CONNECT registry.npmjs.org:443 HTTP/1.1", "host: registry.npmjs.org:443"]));
    expect(r.header("x-mandate-egress-denied")).toBe("connect_not_allowed");
    expect(w.dials).toEqual([]);
  });

  it("refuses CONNECT, and an absolute-form request that names another host", async () => {
    const g = await gateway(null);
    expect((await send(g.port, http(["CONNECT api.anthropic.com:443 HTTP/1.1", "host: api.anthropic.com:443"]))).header("x-mandate-egress-denied")).toBe("connect_not_allowed");
    expect((await send(g.port, http(["GET http://evil.example/ HTTP/1.1", "host: evil.example"]))).header("x-mandate-egress-denied")).toBe("malformed_request");
    expect(w.up.seen).toEqual([]);
  });

  it("refuses a destination that resolves to a private address, and connects to the address it checked", async () => {
    const g = await gateway();
    w.dns.set("api.anthropic.com", ["169.254.169.254"]);
    expect((await send(g.port, http(["POST /v1/messages HTTP/1.1", "host: x", "content-length: 0"]))).header("x-mandate-egress-denied")).toBe("resolved_private");
    w.dns.set("api.anthropic.com", ["140.82.112.6"]);
    expect((await send(g.port, http(["POST /v1/messages HTTP/1.1", "host: x", "content-length: 0"]))).status).toBe(200);
    expect(w.dials.map((d) => d.address)).toEqual(["140.82.112.6"]);
  });

  it("refuses the request-smuggling framings a forward session refuses", async () => {
    const g = await gateway();
    const r = await send(g.port, http(["POST /v1/messages HTTP/1.1", "host: x", "content-length: 3", "transfer-encoding: chunked"], "0\r\n\r\n"));
    expect(r.header("x-mandate-egress-denied")).toBe("malformed_request");
    expect(w.up.seen).toEqual([]);
  });
});
