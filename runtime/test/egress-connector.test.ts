// A connector's gateway (spec/library.md "Egress"; spec/egress.md "Gateway
// sessions"): a gateway made from a spec rather than one of the two built-in
// names, to the host of the connector's URL, POST only, with the credential
// the lock binds, in the lock's header and template. The built-in model and
// GitHub gateways are two such specs, with the values they always had
// (egress-gateways.test.ts holds them to what they do). Sessions go through
// the egress tests' in-process proxy, with an in-process upstream and no
// network. The secrets are made-up words.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONNECTOR_HEADER, connectorGateway, EgressLink, Gateway, GATEWAYS, gatewaySpec, type GatewaySpec } from "../src/gateway.js";
import { Violation } from "../src/signals.js";
import { seenHeader, world as egressWorld, type World } from "./egress-world.js";

const ERP_SECRET = "made-up-erp-secret";
const MAIL_SECRET = "made-up-mail-secret";
const ERP_URL = "https://erp.acme.example/mcp";

describe("the built-in gateways' specs", () => {
  it("are today's: any method, toward one host, in the header the API expects", () => {
    expect(gatewaySpec("model", "anthropic")).toEqual({ name: "model", host: "api.anthropic.com", methods: null, credential: "anthropic", header: "x-api-key", template: "{secret}" });
    expect(gatewaySpec("github", "github")).toEqual({ name: "github", host: "api.github.com", methods: null, credential: "github", header: "authorization", template: "Bearer {secret}" });
    expect(GATEWAYS.model.secrets).toEqual(["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"]);
    expect(GATEWAYS.github.secrets).toEqual(["MANDATE_GITHUB_TOKEN"]);
  });
});

describe("a connector's spec, from its URL and its lock entry", () => {
  it("is the URL's host, POST only, the lock's credential, the default header and template, and the path kept", () => {
    expect(connectorGateway("acme.connectors.erp", ERP_URL, { credential: "acme_erp" })).toEqual({
      spec: { name: "acme.connectors.erp", host: "erp.acme.example", methods: ["POST"], credential: "acme_erp", header: "authorization", template: "Bearer {secret}" },
      endpoint: ERP_URL,
    });
    expect(CONNECTOR_HEADER).toEqual({ header: "authorization", template: "Bearer {secret}" });
    const mail = connectorGateway("acme.connectors.mailbox", "https://Mail.Acme.example/v1/mcp", { credential: "acme_mail", header: "x-api-key", template: "{secret}" });
    expect(mail).toEqual({ spec: { name: "acme.connectors.mailbox", host: "mail.acme.example", methods: ["POST"], credential: "acme_mail", header: "x-api-key", template: "{secret}" }, endpoint: "https://mail.acme.example/v1/mcp" });
    expect(connectorGateway("m.c", "https://erp.acme.example", { credential: "c" }).endpoint).toBe("https://erp.acme.example/");
    expect(connectorGateway("m.c", "https://10.0.0.7/mcp", { credential: "c" }).spec.host).toBe("10.0.0.7");
  });

  const refused: Array<[string, string, { credential: string; header?: string; template?: string }, RegExp]> = [
    ["plain http", "http://erp.acme.example/mcp", { credential: "c" }, /https:\/\//],
    ["no scheme", "erp.acme.example/mcp", { credential: "c" }, /https:\/\//],
    ["a port", "https://erp.acme.example:8443/mcp", { credential: "c" }, /no port/],
    ["the default port, written", "https://erp.acme.example:443/mcp", { credential: "c" }, /no port/],
    ["an empty port", "https://erp.acme.example:/mcp", { credential: "c" }, /no port/],
    ["a user", "https://ann@erp.acme.example/mcp", { credential: "c" }, /no user or password/],
    ["a user and a password", "https://ann:pw@erp.acme.example/mcp", { credential: "c" }, /no user or password/],
    ["a query", "https://erp.acme.example/mcp?x=1", { credential: "c" }, /no query/],
    ["a fragment", "https://erp.acme.example/mcp#top", { credential: "c" }, /no query or fragment/],
    ["an IPv6 host", "https://[::1]/mcp", { credential: "c" }, /host name or an IPv4 address/],
    ["an underscore in the host", "https://erp_x.acme.example/mcp", { credential: "c" }, /host name/],
    ["no host", "https:///mcp", { credential: "c" }, /as written/],
    ["a backslash a parser would fold", "https://erp.acme.example\\mcp", { credential: "c" }, /as written/],
    ["a percent-encoded host", "https://erp%2eacme.example/mcp", { credential: "c" }, /as written/],
    ["a Unicode host", "https://érp.acme.example/mcp", { credential: "c" }, /as written/],
    ["a credential that is not a name", ERP_URL, { credential: "1erp" }, /credential is a name/],
    ["a credential with a space", ERP_URL, { credential: "acme erp" }, /credential is a name/],
    ["a header without a template", ERP_URL, { credential: "c", header: "x-api-key" }, /together, or neither/],
    ["a template without a header", ERP_URL, { credential: "c", template: "{secret}" }, /together, or neither/],
    ["a header in upper case", ERP_URL, { credential: "c", header: "X-Api-Key", template: "{secret}" }, /lower case/],
    ["a header the proxy sets", ERP_URL, { credential: "c", header: "host", template: "{secret}" }, /does not set itself/],
    ["a template without {secret}", ERP_URL, { credential: "c", header: "x-api-key", template: "Bearer" }, /exactly once/],
    ["a template with {secret} twice", ERP_URL, { credential: "c", header: "x-api-key", template: "{secret}{secret}" }, /exactly once/],
    ["a template with a trailing space", ERP_URL, { credential: "c", header: "x-api-key", template: "{secret} " }, /printable ASCII/],
  ];
  for (const [what, url, binding, why] of refused) {
    it(`refuses ${what}: bad_connector`, () => {
      let thrown: unknown;
      try {
        connectorGateway("acme.connectors.erp", url, binding);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Violation);
      expect((thrown as Violation).code).toBe("bad_connector");
      expect((thrown as Violation).message).toMatch(/^bad_connector: connector acme\.connectors\.erp: /);
      expect((thrown as Violation).message).toMatch(why);
    });
  }
});

describe("a connector's gateway session", () => {
  let w: World;
  beforeAll(async () => {
    w = await egressWorld({
      credentials: {
        acme_erp: { hosts: ["erp.acme.example"], header: "authorization", template: "Bearer {secret}", secret: ERP_SECRET },
        acme_mail: { hosts: ["mail.acme.example"], header: "x-api-key", template: "{secret}", secret: MAIL_SECRET },
      },
    });
  });
  afterAll(async () => {
    await w.close();
  });
  beforeEach(() => {
    w.up.seen.length = 0;
    w.up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
  });

  /** What the runtime's side of the gateway sent: every request's URL and headers, as the gateway handed them on. */
  function sending(): { sent: Array<{ url: string; headers: Record<string, string> }>; send: typeof fetch } {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const send = (async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      sent.push({ url: String(url), headers });
      return fetch(url, init);
    }) as typeof fetch;
    return { sent, send };
  }

  function gatewayFor(run: string, spec: GatewaySpec, send?: typeof fetch): { link: EgressLink; gw: Gateway } {
    const link = new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run } });
    return { link, gw: new Gateway(link, spec, undefined, send) };
  }

  it("reaches its own host with POST and the lock's credential; the runtime's side holds the placeholder only", async () => {
    const { spec, endpoint } = connectorGateway("acme.connectors.erp", ERP_URL, { credential: "acme_erp" });
    const { sent, send } = sending();
    const { link, gw } = gatewayFor("c1", spec, send);
    expect((await gw.fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    expect(w.up.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /mcp"]);
    expect(seenHeader(w.up.seen[0]!, "host")).toEqual(["erp.acme.example"]);
    expect(seenHeader(w.up.seen[0]!, "authorization")).toEqual([`Bearer ${ERP_SECRET}`]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(sent[0]!.headers["authorization"]).toMatch(/^Bearer mdt-ph-[0-9a-f]{32}$/);
    expect(JSON.stringify(sent)).not.toContain(ERP_SECRET);
    expect(JSON.stringify(await gw.session())).not.toContain(ERP_SECRET);
    // One session, the run's, named for the connector, so that revoking the run cuts it.
    expect(await w.client.revoke({ run: "c1" })).toEqual([expect.stringMatching(/^gw\.acme\.connectors\.erp\.[0-9a-f]{16}$/)]);
    await link.closeAll();
  });

  it("sends the credential in the lock's own header and template", async () => {
    const { spec, endpoint } = connectorGateway("acme.connectors.mailbox", "https://mail.acme.example/mcp", { credential: "acme_mail", header: "x-api-key", template: "{secret}" });
    const { sent, send } = sending();
    const { link, gw } = gatewayFor("c2", spec, send);
    expect((await gw.fetch(endpoint, { method: "POST", body: "{}" })).status).toBe(200);
    expect(seenHeader(w.up.seen[0]!, "x-api-key")).toEqual([MAIL_SECRET]);
    expect(seenHeader(w.up.seen[0]!, "authorization")).toEqual([]);
    expect(sent[0]!.headers["x-api-key"]).toMatch(/^mdt-ph-[0-9a-f]{32}$/);
    await link.closeAll();
  });

  it("denies another method, and refuses another host before anything is sent", async () => {
    const { spec, endpoint } = connectorGateway("acme.connectors.erp", ERP_URL, { credential: "acme_erp" });
    const { link, gw } = gatewayFor("c3", spec);
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const r = await gw.fetch(endpoint, { method, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }) });
      expect(r.status, method).toBe(403);
      expect(r.headers.get("x-mandate-egress-denied")).toBe("method_not_allowed");
    }
    await expect(gw.fetch("https://evil.example/mcp", { method: "POST", body: "{}" })).rejects.toThrow(/reaches erp\.acme\.example only, not evil\.example/);
    await expect(gw.fetch("http://erp.acme.example/mcp", { method: "POST", body: "{}" })).rejects.toThrow(/reaches erp\.acme\.example only/);
    expect(w.up.seen).toEqual([]);
    // The proxy recorded each denial, by method.
    const [id] = await w.client.revoke({ run: "c3" });
    expect((await w.client.denials(id!, { after: 0, limit: 10 })).denials.map((d) => [d.method, d.why])).toEqual([
      ["GET", "method_not_allowed"],
      ["PUT", "method_not_allowed"],
      ["DELETE", "method_not_allowed"],
      ["PATCH", "method_not_allowed"],
    ]);
    await link.closeAll();
  });

  it("is refused by the proxy when the lock binds a credential the proxy does not bind to the host, or does not hold", async () => {
    const { spec } = connectorGateway("acme.connectors.erp", ERP_URL, { credential: "acme_mail" });
    const { link, gw } = gatewayFor("c4", spec);
    await expect(gw.fetch(ERP_URL, { method: "POST", body: "{}" })).rejects.toThrow(/^egress_unavailable: .*does not bind credential acme_mail to erp\.acme\.example/);
    const { spec: unknown } = connectorGateway("acme.connectors.erp", ERP_URL, { credential: "nobody" });
    const g2 = gatewayFor("c5", unknown);
    await expect(g2.gw.fetch(ERP_URL, { method: "POST", body: "{}" })).rejects.toThrow(/^egress_unavailable: .*holds no credential nobody/);
    expect(w.up.seen).toEqual([]);
    await link.closeAll();
    await g2.link.closeAll();
  });

  it("names a session whose connector name is too long for a session id by its digest", async () => {
    const long = `acme.${"connectors.".repeat(12)}erp`;
    const { spec, endpoint } = connectorGateway(long, ERP_URL, { credential: "acme_erp" });
    const { link, gw } = gatewayFor("c6", spec);
    expect((await gw.fetch(endpoint, { method: "POST", body: "{}" })).status).toBe(200);
    expect(await w.client.revoke({ run: "c6" })).toEqual([expect.stringMatching(/^gw\.h[0-9a-f]{32}\.[0-9a-f]{16}$/)]);
    await link.closeAll();
  });
});
