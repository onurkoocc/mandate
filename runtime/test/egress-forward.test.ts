// The egress proxy's forward sessions (spec/egress.md "Forward sessions"):
// a sandbox's HTTP/1.1 proxy. Every request here goes through a real loopback
// port of a session to an in-process fake upstream, reached through the
// injected dialer; nothing touches the network. The upstream receives the
// real secret in the configured header and never the placeholder; the client
// never sees the secret; and each refusal is a named denial with nothing sent
// upstream.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isPublicAddress } from "../src/egress/addresses.js";
import { scrubBytes } from "../src/egress/http1.js";
import { PLACEHOLDER, type Destination } from "../src/egress/proxy.js";
import { http, OTHER_SECRET, portOf, SECRET, seenHeader, send, sid, world, type Response, type World } from "./egress-world.js";

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
  w.resolved.length = 0;
  w.dns.clear();
  w.up.handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  };
});

const GITHUB: Destination = { host: "api.github.com", methods: ["GET", "POST"], credential: "github" };
const MODEL: Destination = { host: "api.anthropic.com", methods: ["POST"], credential: "model" };
const OPEN: Destination = { host: "registry.npmjs.org", methods: null, credential: null };
const READONLY: Destination = { host: "example.org", methods: ["GET"], credential: null };

/** A forward session over the usual destinations; returns its port and placeholders. */
async function session(destinations: Destination[] = [GITHUB, MODEL, OPEN, READONLY], o: { tenant?: string; run?: string } = {}) {
  const id = sid();
  const s = await w.client.openSession({ session: id, tenant: o.tenant ?? "acme", run: o.run ?? "r1", command: "c1", kind: "forward", destinations, ttl_ms: 60_000 });
  return { id, port: portOf(s.proxy_url), ph: s.placeholders, url: s.proxy_url };
}

async function denials(id: string) {
  return (await w.client.denials(id)).denials;
}

/** The denial a response names, checked against what the session recorded; nothing went upstream. */
async function denied(r: Response, id: string, why: string, detail?: string): Promise<void> {
  expect(r.header("x-mandate-egress-denied"), r.raw).toBe(why);
  expect(JSON.parse(r.body)).toMatchObject({ error: "egress_denied", why });
  // Where two rules would refuse the same request, the detail says which one did.
  if (detail !== undefined) expect((JSON.parse(r.body) as { detail: string }).detail).toContain(detail);
  expect(r.status).toBe(why === "malformed_request" ? 400 : 403);
  expect((await denials(id)).at(-1)?.why).toBe(why);
  expect(w.up.seen).toEqual([]);
  expect(w.dials).toEqual([]);
}

const get = (url: string, extra: string[] = [], method = "GET"): string => http([`${method} ${url} HTTP/1.1`, `host: ${new URL(url).host}`, ...extra]);

describe("the credential swap", () => {
  it("sends the real secret upstream in the configured header, never the placeholder, over TLS to port 443 of the checked address", async () => {
    const s = await session();
    const r = await send(s.port, get("http://api.github.com/repos/acme/app?per_page=1", [`authorization: Bearer ${s.ph["github"]}`]));
    expect(r.status, r.raw).toBe(200);
    expect(r.body).toBe("ok");
    expect(w.up.seen).toHaveLength(1);
    const seen = w.up.seen[0]!;
    expect(seenHeader(seen, "authorization")).toEqual([`Bearer ${SECRET}`]);
    expect(seen.url).toBe("/repos/acme/app?per_page=1");
    expect(JSON.stringify(seen)).not.toContain("mdt-ph-");
    expect(w.dials).toEqual([{ host: "api.github.com", address: "93.184.215.14", port: 443, tls: true }]);
    expect(r.raw).not.toContain(SECRET);
  });

  it("gives each session its own placeholders: mdt-ph- and 128 random bits", async () => {
    const a = await session();
    const b = await session();
    expect(Object.keys(a.ph).sort()).toEqual(["github", "model"]);
    for (const p of [...Object.values(a.ph), ...Object.values(b.ph)]) expect(p).toMatch(/^mdt-ph-[0-9a-f]{32}$/);
    expect(a.ph["github"]).not.toBe(b.ph["github"]);
    expect(a.port).not.toBe(b.port);
  });

  it("forwards a request to a credentialed destination without the placeholder without the credential", async () => {
    const s = await session();
    const r = await send(s.port, get("http://api.github.com/zen"));
    expect(r.status).toBe(200);
    expect(seenHeader(w.up.seen[0]!, "authorization")).toEqual([]);
  });

  it("scrubs the secret from response headers and body when the upstream echoes it back", async () => {
    w.up.handler = (req, res) => {
      res.writeHead(200, { "x-echo": String(req.headers["authorization"]), "content-type": "text/plain" });
      res.end(`you sent ${String(req.headers["authorization"])} and ${SECRET}${SECRET}.`);
    };
    const s = await session();
    const r = await send(s.port, get("http://api.github.com/echo", [`authorization: Bearer ${s.ph["github"]}`]));
    expect(seenHeader(w.up.seen[0]!, "authorization")).toEqual([`Bearer ${SECRET}`]);
    expect(r.raw).not.toContain(SECRET);
    expect(r.header("x-echo")).toBe(`Bearer ${s.ph["github"]}`);
    expect(r.body).toBe(`you sent Bearer ${s.ph["github"]} and ${s.ph["github"]}${s.ph["github"]}.`);
  });

  it("scrubs a secret split across chunks of the upstream's body", async () => {
    w.up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const pieces = ["a", SECRET.slice(0, 1), SECRET.slice(1, 9), SECRET.slice(9), " b ", SECRET.slice(0, -1), SECRET.slice(-1), " c ", OTHER_SECRET.slice(0, 4), OTHER_SECRET.slice(4)];
      let i = 0;
      const next = (): void => {
        if (i === pieces.length) return void res.end();
        res.write(pieces[i++]);
        setTimeout(next, 5);
      };
      next();
    };
    const s = await session();
    const r = await send(s.port, get("http://api.github.com/stream"));
    expect(r.raw).not.toContain(SECRET);
    expect(r.raw).not.toContain(OTHER_SECRET);
    expect(r.body).toBe(`a${s.ph["github"]} b ${s.ph["github"]} c ${s.ph["model"]}`);
  });

  it("scrubs at every split point, and holds back no more than a secret's length", () => {
    const secret = Buffer.from(SECRET);
    const text = Buffer.from(`xx${SECRET}yy${SECRET}`);
    const pairs = [{ secret, replacement: Buffer.from("P") }];
    for (let cut = 0; cut <= text.length; cut++) {
      const a = scrubBytes(text.subarray(0, cut), pairs, secret.length - 1);
      const b = scrubBytes(Buffer.concat([a.rest, text.subarray(cut)]), pairs, 0);
      expect(Buffer.concat([a.out, b.out]).toString()).toBe("xxPyyP");
    }
  });

  it("asks upstream for the identity encoding, and refuses a coded response it cannot scrub", async () => {
    w.up.handler = (_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end("not really gzip");
    };
    const s = await session();
    const r = await send(s.port, get("http://api.github.com/x", ["accept-encoding: gzip, br"]));
    expect(seenHeader(w.up.seen[0]!, "accept-encoding")).toEqual(["identity"]);
    expect(r.status).toBe(502);
    expect(r.body).not.toContain("not really gzip");
  });
});

describe("where a placeholder may be", () => {
  it("is a denial in another header", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://api.github.com/x", [`x-token: ${s.ph["github"]}`])), s.id, "placeholder_misuse");
  });

  it("is a denial in the URL", async () => {
    const s = await session();
    await denied(await send(s.port, get(`http://api.github.com/x?token=${s.ph["github"]}`)), s.id, "placeholder_misuse");
  });

  it("is a denial toward a destination bound to another credential, in that credential's header or in its own", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://api.anthropic.com/v1/messages", [`x-api-key: ${s.ph["github"]}`], "POST")), s.id, "placeholder_misuse");
    await denied(await send(s.port, get("http://api.anthropic.com/v1/messages", [`authorization: Bearer ${s.ph["github"]}`], "POST")), s.id, "placeholder_misuse");
  });

  it("is a denial toward a destination with no credential", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://registry.npmjs.org/x", [`authorization: Bearer ${s.ph["github"]}`])), s.id, "placeholder_misuse");
  });

  it("is a denial in the configured header when the value is not exactly the template, or the header is repeated", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://api.github.com/x", [`authorization: token ${s.ph["github"]}`])), s.id, "placeholder_misuse");
    await denied(await send(s.port, get("http://api.github.com/x", [`authorization: Bearer ${s.ph["github"]}`, "authorization: Bearer other"])), s.id, "placeholder_misuse");
  });

  it("is a denial when it is another session's: two sessions cannot use each other's placeholders", async () => {
    const a = await session();
    const b = await session();
    await denied(await send(a.port, get("http://api.github.com/x", [`authorization: Bearer ${b.ph["github"]}`])), a.id, "placeholder_misuse");
    expect(await denials(b.id)).toEqual([]);
  });

  it("is a denial in a CONNECT", async () => {
    const s = await session();
    await denied(await send(s.port, http(["CONNECT registry.npmjs.org:443 HTTP/1.1", "host: registry.npmjs.org:443", `proxy-authorization: Bearer ${s.ph["github"]}`])), s.id, "placeholder_misuse");
  });
});

describe("hosts and methods", () => {
  it("refuses a host the session does not list", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://evil.example/collect")), s.id, "host_not_allowed");
  });

  it("refuses a method the destination does not list", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://api.github.com/repos/acme/app", [], "DELETE")), s.id, "method_not_allowed");
    await denied(await send(s.port, get("http://example.org/", [], "POST")), s.id, "method_not_allowed");
  });

  it("allows any method toward a destination whose methods are null", async () => {
    const s = await session();
    expect((await send(s.port, get("http://registry.npmjs.org/x", [], "PATCH"))).status).toBe(200);
  });

  it("refuses a URL that names a port other than 80 or 443", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://api.github.com:8443/x")), s.id, "port_not_allowed");
    expect((await send(s.port, get("http://api.github.com:443/x"))).status).toBe(200);
  });

  it("cannot reach another session's destinations", async () => {
    const a = await session([GITHUB]);
    const b = await session([OPEN]);
    await denied(await send(a.port, get("http://registry.npmjs.org/x")), a.id, "host_not_allowed");
    await denied(await send(b.port, get("http://api.github.com/x")), b.id, "host_not_allowed");
  });

  it("refuses an origin-form request: a forward session takes absolute-form", async () => {
    const s = await session();
    await denied(await send(s.port, http(["GET /x HTTP/1.1", "host: api.github.com"])), s.id, "malformed_request");
  });
});

describe("CONNECT", () => {
  it("tunnels to port 443 of a destination with neither credential nor method restriction", async () => {
    const s = await session();
    const r = await send(s.port, http(["CONNECT registry.npmjs.org:443 HTTP/1.1", "host: registry.npmjs.org:443"]) + http(["GET /inside HTTP/1.1", "host: registry.npmjs.org", "connection: close"]));
    expect(r.raw).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 OK/);
    expect(w.dials).toEqual([{ host: "registry.npmjs.org", address: "93.184.215.14", port: 443, tls: false }]);
    expect(w.up.seen.map((x) => x.url)).toEqual(["/inside"]);
  });

  it("refuses a destination with a credential", async () => {
    const s = await session();
    await denied(await send(s.port, http(["CONNECT api.github.com:443 HTTP/1.1", "host: api.github.com:443"])), s.id, "connect_not_allowed");
  });

  it("refuses a destination with a method restriction", async () => {
    const s = await session();
    await denied(await send(s.port, http(["CONNECT example.org:443 HTTP/1.1", "host: example.org:443"])), s.id, "connect_not_allowed");
  });

  it("refuses a port other than 443", async () => {
    const s = await session();
    await denied(await send(s.port, http(["CONNECT registry.npmjs.org:22 HTTP/1.1", "host: registry.npmjs.org:22"])), s.id, "connect_not_allowed");
  });

  it("refuses a host the session does not list", async () => {
    const s = await session();
    await denied(await send(s.port, http(["CONNECT evil.example:443 HTTP/1.1", "host: evil.example:443"])), s.id, "host_not_allowed");
  });
});

describe("resolution and pinning", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
    it(`refuses a name that resolves to ${address}`, async () => {
      w.dns.set("api.github.com", [address]);
      const s = await session();
      const r = await send(s.port, get("http://api.github.com/x", [`authorization: Bearer ${s.ph["github"]}`]));
      expect(r.header("x-mandate-egress-denied")).toBe("resolved_private");
      expect((await denials(s.id)).at(-1)?.why).toBe("resolved_private");
      expect(w.dials).toEqual([]);
      expect(w.up.seen).toEqual([]);
    });
  }

  it("refuses a name when any of its addresses is private, not only the first", async () => {
    w.dns.set("api.github.com", ["93.184.215.14", "10.1.2.3"]);
    const s = await session();
    expect((await send(s.port, get("http://api.github.com/x"))).header("x-mandate-egress-denied")).toBe("resolved_private");
  });

  it("treats an IP literal as host the same way, without resolving it", async () => {
    const s = await session([{ host: "10.0.0.1", methods: null, credential: null }, { host: "::1", methods: null, credential: null }]);
    await denied(await send(s.port, get("http://10.0.0.1/x")), s.id, "resolved_private");
    await denied(await send(s.port, get("http://[::1]/x")), s.id, "resolved_private");
    expect(w.resolved).toEqual([]);
  });

  it("connects to the address it checked: the name is resolved once, and a change after it is not followed", async () => {
    let calls = 0;
    w.dns.set("api.github.com", () => (++calls === 1 ? ["93.184.215.14"] : ["127.0.0.1"]));
    const s = await session();
    expect((await send(s.port, get("http://api.github.com/x"))).status).toBe(200);
    expect(w.resolved).toEqual(["api.github.com"]);
    expect(w.dials.map((d) => d.address)).toEqual(["93.184.215.14"]);
    // The next connection resolves again, and is refused for what it resolves to then.
    expect((await send(s.port, get("http://api.github.com/x"))).header("x-mandate-egress-denied")).toBe("resolved_private");
    expect(w.dials).toHaveLength(1);
  });

  it("makes one upstream connection per request", async () => {
    const s = await session();
    await send(s.port, get("http://api.github.com/a"));
    await send(s.port, get("http://api.github.com/b"));
    expect(w.dials).toHaveLength(2);
    expect(w.up.seen.map((x) => seenHeader(x, "connection"))).toEqual([["close"], ["close"]]);
  });

  it("knows the private, loopback, link-local, unique-local, multicast and metadata ranges", () => {
    for (const a of ["0.0.0.0", "10.255.0.1", "100.100.100.200", "127.8.8.8", "169.254.169.254", "172.31.255.255", "192.168.1.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "2002:a00:1::", "fe80::1%eth0", "not an address"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ["93.184.215.14", "140.82.112.6", "172.32.0.1", "2606:4700::1111", "::ffff:140.82.112.6", "2002:8c52:7006::"]) expect(isPublicAddress(a), a).toBe(true);
  });
});

describe("reading a request", () => {
  it("refuses Content-Length with Transfer-Encoding", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://registry.npmjs.org/x", ["content-length: 5", "transfer-encoding: chunked"], "POST") + "0\r\n\r\n"), s.id, "malformed_request", "both Content-Length and Transfer-Encoding");
  });

  it("refuses a repeated Content-Length, even with one value", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://registry.npmjs.org/x", ["content-length: 2", "content-length: 2"], "POST") + "ab"), s.id, "malformed_request", "Content-Length is repeated");
  });

  it("refuses a Content-Length that is not one number", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://registry.npmjs.org/x", ["content-length: 2, 2"], "POST") + "ab"), s.id, "malformed_request", "not a single decimal number");
  });

  it("refuses a transfer coding other than chunked alone", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://registry.npmjs.org/x", ["transfer-encoding: gzip, chunked"], "POST") + "0\r\n\r\n"), s.id, "malformed_request", "other than chunked");
  });

  it("refuses obsolete line folding", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://registry.npmjs.org/x", ["x-a: one", " two"])), s.id, "malformed_request", "obsolete line folding");
  });

  it("refuses a bare LF", async () => {
    const s = await session();
    await denied(await send(s.port, "GET http://registry.npmjs.org/x HTTP/1.1\r\nhost: registry.npmjs.org\nx-a: b\r\n\r\n"), s.id, "malformed_request", "bare CR or LF");
  });

  it("refuses white space before a header's colon", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://registry.npmjs.org/x", ["transfer-encoding : chunked"], "POST") + "0\r\n\r\n"), s.id, "malformed_request", "white space before the colon");
  });

  it("refuses an Expect other than 100-continue", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://registry.npmjs.org/x", ["expect: 200-ok"])), s.id, "malformed_request", "Expect");
  });

  it("refuses an Upgrade, and h2c", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://registry.npmjs.org/x", ["connection: upgrade", "upgrade: websocket"])), s.id, "upgrade_not_allowed");
    await denied(await send(s.port, get("http://registry.npmjs.org/x", ["connection: upgrade, http2-settings", "upgrade: h2c", "http2-settings: AAMAAABkAAQAAP__"])), s.id, "upgrade_not_allowed");
  });

  it("refuses HTTP/2's preface", async () => {
    const s = await session();
    await denied(await send(s.port, "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"), s.id, "upgrade_not_allowed", "HTTP/2 is not spoken");
  });

  it("refuses a version other than HTTP/1.1", async () => {
    const s = await session();
    await denied(await send(s.port, "GET http://registry.npmjs.org/x HTTP/1.0\r\n\r\n"), s.id, "malformed_request", "is not HTTP/1.1");
  });

  it("refuses a URL with user information", async () => {
    const s = await session();
    await denied(await send(s.port, get("http://user:pw@registry.npmjs.org/x")), s.id, "malformed_request", "authority");
  });

  it("forwards a body framed by Content-Length, and a chunked one, with 100 Continue when asked", async () => {
    const s = await session();
    const a = await send(s.port, get("http://api.github.com/a", ["content-length: 11", "expect: 100-continue"], "POST") + "hello world");
    expect(a.raw.startsWith("HTTP/1.1 100 Continue\r\n\r\n")).toBe(true);
    expect(a.status).toBe(200);
    const b = await send(s.port, get("http://api.github.com/b", ["transfer-encoding: chunked"], "POST") + "5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nx-trailer: t\r\n\r\n");
    expect(b.status).toBe(200);
    expect(w.up.seen.map((x) => [x.body, seenHeader(x, "content-length"), seenHeader(x, "transfer-encoding")])).toEqual([
      ["hello world", ["11"], []],
      ["hello world", [], ["chunked"]],
    ]);
  });

  it("reads one request per connection: bytes after the first are not a second request", async () => {
    const s = await session();
    const r = await send(s.port, get("http://api.github.com/a") + get("http://evil.example/b"));
    expect(r.status).toBe(200);
    expect(w.up.seen.map((x) => x.url)).toEqual(["/a"]);
    expect(await denials(s.id)).toEqual([]);
  });

  it("rewrites the Host header to the URL's host, and refuses a repeated one", async () => {
    const s = await session();
    await send(s.port, http(["GET http://api.github.com/x HTTP/1.1", "host: internal.corp"]));
    expect(seenHeader(w.up.seen[0]!, "host")).toEqual(["api.github.com"]);
    w.up.seen.length = 0;
    w.dials.length = 0;
    await denied(await send(s.port, http(["GET http://api.github.com/x HTTP/1.1", "host: api.github.com", "host: internal.corp"])), s.id, "malformed_request");
  });

  it("drops hop-by-hop headers and those the Connection header names", async () => {
    const s = await session();
    await send(s.port, get("http://api.github.com/x", ["connection: keep-alive, x-hop", "x-hop: 1", "keep-alive: 5", "proxy-authorization: Basic eA==", "te: trailers", "x-end: 2"]));
    const seen = w.up.seen[0]!;
    for (const h of ["x-hop", "keep-alive", "proxy-authorization", "te"]) expect(seenHeader(seen, h), h).toEqual([]);
    expect(seenHeader(seen, "x-end")).toEqual(["2"]);
  });
});

describe("responses", () => {
  it("passes a redirect back as it is and does not follow it", async () => {
    w.up.handler = (_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    };
    const s = await session();
    const r = await send(s.port, get("http://api.github.com/x"));
    expect(r.status).toBe(302);
    expect(r.header("location")).toBe("http://169.254.169.254/latest/meta-data/");
    expect(w.up.seen).toHaveLength(1);
    expect(w.dials).toHaveLength(1);
  });

  it("frames the body as chunked and closes, and a HEAD response has no body", async () => {
    const s = await session();
    const r = await send(s.port, get("http://api.github.com/x"));
    expect([r.header("transfer-encoding"), r.header("connection"), r.header("content-length")]).toEqual(["chunked", "close", undefined]);
    const h = await send(s.port, get("http://registry.npmjs.org/x", [], "HEAD"));
    expect(h.status).toBe(200);
    expect(h.raw.endsWith("\r\n\r\n")).toBe(true);
  });
});

describe("the denials a session records", () => {
  it("names the host, method and reason, and a digest of the path, never the path, a header or a body", async () => {
    const s = await session();
    await send(s.port, get("http://evil.example/secret/path?q=1", ["x-note: private"]));
    const [d] = await denials(s.id);
    expect(d).toEqual({ id: expect.any(Number), host: "evil.example", method: "GET", why: "host_not_allowed", path_digest: `sha256:${createHash("sha256").update("/secret/path?q=1").digest("hex")}`, at: expect.any(String) });
    expect(JSON.stringify(d)).not.toContain("secret/path");
    expect(JSON.stringify(d)).not.toContain("private");
  });

  it("does not record a placeholder that was put in the host", async () => {
    const s = await session();
    const ph = s.ph["github"]!;
    await send(s.port, get(`http://${ph}.evil.example/x`));
    const [d] = await denials(s.id);
    expect(d?.why).toBe("placeholder_misuse");
    expect(d?.host).toBeNull();
    expect(JSON.stringify(d)).not.toMatch(PLACEHOLDER);
  });
});
