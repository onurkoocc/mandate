// The MCP client through a connector's gateway session (spec/library.md
// "Egress", "The MCP the runtime speaks"): the fake MCP server is the egress
// tests' in-process upstream, behind the in-process proxy, with no network.
// The client holds the placeholder only; the upstream gets the secret. The
// secrets are made-up words.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectorGateway, EgressLink, Gateway, type GatewaySpec } from "../src/gateway.js";
import { McpClient, McpDenied } from "../src/mcp-client.js";
import { seenHeader, world as egressWorld, type World } from "./egress-world.js";
import { fakeErp, fakeMailbox, type FakeMcp } from "./fake-mcp.js";

const ERP_SECRET = "made-up-erp-secret";
const MAIL_SECRET = "made-up-mail-secret";
const ERP_URL = "https://erp.acme.example/mcp";
const MATCH = { invoice_no: "INV-1", order: { order_no: "PO-1", vendor_id: "V1", total_cents: 10_000 } };

let w: World;
let erp: FakeMcp;
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
  erp = fakeErp();
  erp.orders.push({ order_no: "PO-1", vendor_id: "V1", total_cents: 10_000 });
  w.up.handler = erp.handler();
});

/** What the runtime's side of the gateway sent: every request's URL and headers, as the gateway handed them on. */
function sending(): { sent: Array<{ url: string; headers: Record<string, string>; body: string }>; send: typeof fetch } {
  const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const send = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(url), headers, body: String(init?.body ?? "") });
    return fetch(url, init);
  }) as typeof fetch;
  return { sent, send };
}

function gatewayFor(run: string, spec: GatewaySpec, send?: typeof fetch): { link: EgressLink; gw: Gateway } {
  const link = new EgressLink({ admin: w.config.admin, scope: { tenant: "acme", run } });
  return { link, gw: new Gateway(link, spec, undefined, send) };
}

describe("the MCP client through a connector's gateway", () => {
  it("lists and calls through the proxy; only the placeholder is ever on the runtime's side", async () => {
    const { spec, endpoint } = connectorGateway("acme.connectors.erp", ERP_URL, { credential: "acme_erp" });
    const { sent, send } = sending();
    const { link, gw } = gatewayFor("m1", spec, send);
    const client = new McpClient({ url: endpoint, fetch: gw.fetch });
    expect((await client.listTools()).map((t) => t.name)).toEqual(["list_open_orders", "find_draft_invoice", "post_draft_invoice"]);
    expect(await client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" })).toEqual({ draft_id: "D-INV-1" });
    expect(erp.posted).toBe(1);

    // Upstream, the server: the connector's host and path, POST, the secret in the lock's header and template.
    expect(w.up.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /mcp", "POST /mcp"]);
    for (const s of w.up.seen) {
      expect(seenHeader(s, "host")).toEqual(["erp.acme.example"]);
      expect(seenHeader(s, "authorization")).toEqual([`Bearer ${ERP_SECRET}`]);
      expect(JSON.stringify(s)).not.toMatch(/mdt-ph-/);
    }
    // The runtime's side: the session's base URL, the placeholder, never the secret.
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(s.headers).toEqual({ "content-type": "application/json", accept: "application/json, text/event-stream", authorization: expect.stringMatching(/^Bearer mdt-ph-[0-9a-f]{32}$/) });
      expect(JSON.stringify(s)).not.toContain(ERP_SECRET);
    }
    expect(await w.client.revoke({ run: "m1" })).toEqual([expect.stringMatching(/^gw\.acme\.connectors\.erp\.[0-9a-f]{16}$/)]);
    await link.closeAll();
  });

  it("sends the mailbox's credential in its lock's own header and template", async () => {
    const mail = fakeMailbox();
    mail.invoices.push({ invoice_no: "INV-1", vendor_id: "V1", total_cents: 10_100 });
    w.up.handler = mail.handler();
    const { spec, endpoint } = connectorGateway("acme.connectors.mailbox", "https://mail.acme.example/mcp", { credential: "acme_mail", header: "x-api-key", template: "{secret}" });
    const { sent, send } = sending();
    const { link, gw } = gatewayFor("m2", spec, send);
    expect(await new McpClient({ url: endpoint, fetch: gw.fetch }).callTool("list_invoices", {})).toEqual({ invoices: [{ invoice_no: "INV-1", vendor_id: "V1", total_cents: 10_100 }] });
    expect(seenHeader(w.up.seen[0]!, "x-api-key")).toEqual([MAIL_SECRET]);
    expect(sent[0]!.headers["x-api-key"]).toMatch(/^mdt-ph-[0-9a-f]{32}$/);
    await link.closeAll();
  });

  it("surfaces the proxy's denial as its own error, definite; then the gateway refuses before sending", async () => {
    const { spec, endpoint } = connectorGateway("acme.connectors.erp", ERP_URL, { credential: "acme_erp" });
    const { link, gw } = gatewayFor("m3", spec);
    const client = new McpClient({ url: endpoint, fetch: gw.fetch });
    expect(await client.listTools()).toHaveLength(3);
    await w.client.revoke({ run: "m3" });
    w.up.seen.length = 0;
    const denied = await client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" }).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(McpDenied);
    expect(denied).toMatchObject({ kind: "egress_denied", reason: "session_revoked", definite: true, status: 403 });
    // As for the model and GitHub gateways, a revoked session is not replaced: the gateway's own refusal passes through.
    await expect(client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" })).rejects.toThrow(/^egress_denied: session_revoked/);
    expect(w.up.seen).toEqual([]);
    expect(erp.posted).toBe(0);
    await link.closeAll();
  });

  it("a write whose answer the upstream lost after applying it is not definite", async () => {
    const { spec, endpoint } = connectorGateway("acme.connectors.erp", ERP_URL, { credential: "acme_erp" });
    const { link, gw } = gatewayFor("m4", spec);
    const client = new McpClient({ url: endpoint, fetch: gw.fetch });
    erp.writeFaults.push("lose_response");
    const e = await client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" }).catch((x: unknown) => x);
    // The proxy answers a cut upstream with its own 502, which is not the server's answer.
    expect(e).toMatchObject({ kind: "connector_protocol", rule: "status", status: 502, definite: false });
    expect(erp.posted).toBe(1);
    // Sent again: the same draft, counted once.
    expect(await client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" })).toEqual({ draft_id: "D-INV-1" });
    expect(erp.posted).toBe(1);
    await link.closeAll();
  });
});
