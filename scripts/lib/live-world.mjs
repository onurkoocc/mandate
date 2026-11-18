// The world of the live acceptance session of 0.7 (fixtures/attention/live/README.md; slice B11), as pieces that
// both scripts/live-session.mjs and the rehearsal's tests take: the book of invoices and orders, a fake ERP and a fake
// mailbox that speak the MCP of revision 2026-07-28 over HTTP, the loopback guard, the lock and the configuration
// filled from their templates, the session's clock, and `startWorld`, which brings the whole of it up behind the egress
// proxy the runtime requires.
//
// Nothing here is a secret and nothing here is a real system. The secrets the two fakes check (what the egress proxy
// puts in the header of each request) are made at run time, held in this process, and never written or printed. Only
// Node's own modules are imported; the egress proxy is handed in (`deps`), so that the script gives the one the build
// made (runtime/dist) and a test gives the one of the sources (runtime/src).

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── the book ────────────────────────────────────────────────────────────

/**
 * A small book: `n` invoices, and for each the open order it belongs to. `totals` are off in total by 5%: they fail
 * the criterion `totals`, which the accountant and the finance lead may waive. `within` are off by 1%, inside the 2% the
 * contract allows, and pass. `vendor` are matched to an order of another vendor: they fail `vendor`, which nobody may
 * waive. Every other invoice passes every criterion.
 *
 * @param {{ invoice?: string, order?: string, vendor?: string, other?: string, n?: number, totals?: number[], within?: number[], vendors?: number[], base?: number, step?: number }} [o]
 */
export function makeBook(o = {}) {
  const prefix = { invoice: o.invoice ?? "INV-B10-0", order: o.order ?? "PO-B10-0", vendor: o.vendor ?? "VENDOR-B10-0", other: o.other ?? "VENDOR-B10-99" };
  const N = o.n ?? 6;
  const TOTALS = o.totals ?? [1, 4];
  const WITHIN = o.within ?? [];
  const VENDOR = o.vendors ?? [2];
  const base = o.base ?? 10_000;
  const step = o.step ?? 100;
  const ALL = Array.from({ length: N }, (_, i) => i);
  const PASSED = ALL.filter((i) => !TOTALS.includes(i) && !VENDOR.includes(i));
  const invoiceNo = (i) => `${prefix.invoice}${i}`;
  const orderNo = (i) => `${prefix.order}${i}`;
  const vendorOf = (i) => `${prefix.vendor}${i}`;
  const orderTotal = (i) => base + i * step;
  const invoice = (i) => ({ invoice_no: invoiceNo(i), vendor_id: vendorOf(i), total_cents: TOTALS.includes(i) ? Math.round(orderTotal(i) * 1.05) : WITHIN.includes(i) ? Math.round(orderTotal(i) * 1.01) : orderTotal(i) });
  const order = (i) => ({ order_no: orderNo(i), vendor_id: VENDOR.includes(i) ? prefix.other : vendorOf(i), total_cents: orderTotal(i) });
  /** Every value of the book: each text (invoice and order numbers, vendors) and each total, of the invoices and of the orders. */
  const values = () => {
    const rows = ALL.flatMap((i) => [invoice(i), order(i)]);
    return {
      texts: [...new Set(rows.flatMap((r) => Object.values(r).filter((v) => typeof v === "string")))],
      numbers: [...new Set(rows.flatMap((r) => Object.values(r).filter((v) => typeof v === "number")))],
    };
  };
  return { N, TOTALS, WITHIN, VENDOR, ALL, PASSED, invoiceNo, orderNo, vendorOf, invoice, order, values };
}

/** The book of the live session: eight invoices, five that pass (one a little off, inside the 2%), two 5% off, one of another vendor. */
export const LIVE = makeBook({ invoice: "INV-2026-010", order: "PO-2026-010", vendor: "VND-010", other: "VND-0999", n: 8, totals: [2, 5], within: [3], vendors: [6], base: 125_000, step: 7_500 });

/**
 * The simulated Matcher: what a model that read the ERP would answer for an invoice (the order its number belongs to,
 * which may be an order of another vendor), as the rehearsal's matcher does. `args` is the delegation's arguments.
 *
 * @param {ReturnType<typeof makeBook>} book
 */
export function simulatedMatch(book, args) {
  const text = JSON.stringify(args);
  for (const i of book.ALL) if (text.includes(`"${book.invoiceNo(i)}"`)) return { ok: { invoice_no: book.invoiceNo(i), order: book.order(i) }, cost: { steps: 2 } };
  return { error: { tag: "SkillFailed", args: [{ kind: "unknown_invoice", detail: "the simulated matcher knows only the invoices of the session's mailbox" }] }, cost: {} };
}

// ── the loopback guard ──────────────────────────────────────────────────

/** An address on the loopback interface: 127.x.y.z. */
export function isLoopbackAddress(a) {
  return isIP(a) === 4 && a.split(".")[0] === "127";
}

/** A name reserved for documentation and tests (RFC 2606, RFC 6761): it never reaches a real system. */
export function isReservedName(host) {
  return /(^|\.)(example|test|invalid|localhost)$/.test(host) || /(^|\.)example\.(com|net|org)$/.test(host);
}

/**
 * Refuses an address a fake would be served on that is not loopback, and a host a connector would be reached at that
 * is neither loopback nor a name reserved for documentation: the kit must never be pointed at a real system.
 */
export function assertLocalOnly(what, host) {
  if (isLoopbackAddress(host) || (isIP(host) === 0 && isReservedName(host))) return;
  throw new Error(`${what} is ${host}, which is neither a loopback address nor a name reserved for documentation (.example, .test, .invalid): the live kit serves fakes only and will not be pointed at a real system`);
}

/** The hosts of the `https://…` URLs in a text (a lock, a connector declaration). */
export function hostsIn(text) {
  return [...new Set([...text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1].toLowerCase()))];
}

// ── the fake MCP servers ────────────────────────────────────────────────

const MCP_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const invoiceSchema = obj({ invoice_no: { type: "string" }, vendor_id: { type: "string" }, total_cents: { type: "integer" } }, ["invoice_no", "vendor_id", "total_cents"]);
const orderSchema = obj({ order_no: { type: "string" }, vendor_id: { type: "string" }, total_cents: { type: "integer" } }, ["order_no", "vendor_id", "total_cents"]);
const matchSchema = obj({ invoice_no: { type: "string" }, order: orderSchema }, ["invoice_no", "order"]);

/**
 * A fake server of the stateless MCP, as a function from a request to an answer. It answers `tools/list` and
 * `tools/call` of its tools, and nothing else, and only to a request that carries `secret` in `header`, which the egress
 * proxy puts there (a client holds a placeholder, never the secret): a request that did not go through the proxy is 401.
 *
 * @param {{ tools: Array<{ name: string, title: string, description: string, inputSchema: object, outputSchema: object, annotations: object, run: (args: object) => { structured: object, text: string } | { error: string } }>, header: string, secret: string, log?: (line: string) => void }} o
 */
export function mcpServer(o) {
  const respond = (status, body) => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
  return (req) => {
    if (req.method !== "POST" || req.url !== "/mcp") return { status: req.method === "POST" ? 404 : 405, headers: { "content-type": "text/plain" }, body: "not found" };
    if (req.headers[o.header] !== o.secret) {
      o.log?.(`refused a request without the credential (${req.headers[o.header] === undefined ? "no" : "a wrong"} ${o.header} header)`);
      return respond(401, { error: "unauthorized" });
    }
    let body;
    try {
      body = JSON.parse(req.body);
    } catch {
      body = undefined;
    }
    if (!isObj(body) || body["jsonrpc"] !== "2.0" || typeof body["method"] !== "string" || !("id" in body)) return respond(200, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    const id = body["id"] ?? null;
    const params = isObj(body["params"]) ? body["params"] : {};
    const meta = isObj(params["_meta"]) ? params["_meta"] : {};
    if (meta[PROTOCOL_VERSION_META] !== MCP_PROTOCOL_VERSION) return respond(200, { jsonrpc: "2.0", id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: [MCP_PROTOCOL_VERSION] } } });
    const ok = (result) => respond(200, { jsonrpc: "2.0", id, result: { ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "1.0.0" } } } });
    if (body["method"] === "tools/list") {
      const tools = o.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations }));
      return ok({ tools, ttlMs: 60_000, cacheScope: "shared" });
    }
    if (body["method"] === "tools/call") {
      const tool = typeof params["name"] === "string" ? o.tools.find((t) => t.name === params["name"]) : undefined;
      if (!tool) return respond(200, { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${String(params["name"])}` } });
      const r = tool.run(isObj(params["arguments"]) ? params["arguments"] : {});
      o.log?.(`${tool.name}${"error" in r ? ` (refused: ${r.error})` : ` (${r.text})`}`);
      if ("error" in r) return ok({ content: [{ type: "text", text: r.error }], isError: true });
      return ok({ content: [{ type: "text", text: r.text }], structuredContent: r.structured });
    }
    return respond(200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(body["method"])}` } });
  };
}

/**
 * The state and the tools of the fake ERP, as `acme.connectors` declares it: `list_open_orders` and
 * `find_draft_invoice` read; `post_draft_invoice` and `delete_draft_invoice` write, each applied once for a key
 * however often it is sent. `drafts` holds what a live run wrote.
 *
 * @param {ReturnType<typeof makeBook>} book
 */
export function erpState(book) {
  const orders = book.ALL.map((i) => book.order(i));
  /** @type {Map<string, { draft_id: string, invoice_no: string, order_no: string, key: string }>} */
  const drafts = new Map();
  /** @type {Map<string, { draft_id: string, invoice_no: string, order_no: string, key: string }>} */
  const byKey = new Map();
  const tools = [
    { name: "list_open_orders", title: "List open orders", description: "Lists a vendor's open orders.", inputSchema: obj({ vendor_id: { type: "string" } }, ["vendor_id"]), outputSchema: obj({ result: { type: "array", items: orderSchema } }, ["result"]), annotations: { readOnlyHint: true },
      run: (a) => (typeof a["vendor_id"] !== "string" ? { error: "vendor_id is required." } : { structured: { result: orders.filter((o) => o.vendor_id === a["vendor_id"]) }, text: "orders" }) },
    { name: "find_draft_invoice", title: "Find a draft invoice", description: "Finds the draft an operation key posted.", inputSchema: obj({ key: { type: "string" } }, ["key"]), outputSchema: obj({ result: { anyOf: [obj({ draft_id: { type: "string" } }, ["draft_id"]), { type: "null" }] } }, ["result"]), annotations: { readOnlyHint: true },
      run: (a) => {
        const d = typeof a["key"] === "string" ? byKey.get(a["key"]) : undefined;
        return { structured: { result: d ? { draft_id: d.draft_id } : null }, text: d ? "found" : "none" };
      } },
    { name: "post_draft_invoice", title: "Post a draft invoice", description: "Posts a draft invoice for a match.", inputSchema: obj({ m: matchSchema, key: { type: "string" } }, ["m", "key"]), outputSchema: obj({ draft_id: { type: "string" } }, ["draft_id"]), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: (a) => {
        const m = a["m"];
        const order = isObj(m) ? m["order"] : undefined;
        if (!isObj(m) || typeof m["invoice_no"] !== "string" || !isObj(order) || typeof order["order_no"] !== "string" || typeof a["key"] !== "string") return { error: "a match and a key are required." };
        const had = byKey.get(a["key"]);
        const d = had ?? { draft_id: `D-${m["invoice_no"]}`, invoice_no: m["invoice_no"], order_no: order["order_no"], key: a["key"] };
        if (!had) {
          byKey.set(a["key"], d);
          drafts.set(d.invoice_no, d);
        }
        return { structured: { draft_id: d.draft_id }, text: had ? "already posted" : "posted a draft" };
      } },
    { name: "delete_draft_invoice", title: "Delete a draft invoice", description: "Deletes a draft invoice.", inputSchema: obj({ id: obj({ draft_id: { type: "string" } }, ["draft_id"]), key: { type: "string" } }, ["id", "key"]), outputSchema: obj({ draft_id: { type: "string" } }, ["draft_id"]), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      run: (a) => {
        const id = a["id"];
        if (!isObj(id) || typeof id["draft_id"] !== "string") return { error: "a draft is required." };
        for (const [k, d] of drafts) if (d.draft_id === id["draft_id"]) drafts.delete(k);
        return { structured: { draft_id: id["draft_id"] }, text: "deleted" };
      } },
  ];
  return { orders, drafts, tools };
}

/**
 * The state and the tool of the fake mailbox: `list_invoices`.
 *
 * @param {ReturnType<typeof makeBook>} book
 */
export function mailboxState(book) {
  const invoices = book.ALL.map((i) => book.invoice(i));
  const tools = [{ name: "list_invoices", title: "List invoices", description: "Lists the invoices in the mailbox.", inputSchema: obj({}, []), outputSchema: obj({ result: { type: "array", items: invoiceSchema } }, ["result"]), annotations: { readOnlyHint: true }, run: () => ({ structured: { result: invoices }, text: `${invoices.length} invoices` }) }];
  return { invoices, tools };
}

/** An HTTP server over a function of a request, on a port of `host` (0: any). Gives the server and its port. */
export async function listen(handler, host = "127.0.0.1") {
  assertLocalOnly("a fake server's address", host);
  const server = createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const headers = {};
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
      const r = handler({ method: req.method ?? "GET", url: req.url ?? "/", headers, body: Buffer.concat(parts).toString("utf8") });
      Promise.resolve(r).then(
        (a) => {
          res.writeHead(a.status, a.headers);
          res.end(a.body);
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
  });
  await new Promise((ok) => server.listen(0, host, ok));
  return { server, port: server.address().port };
}

// ── the session's clock ─────────────────────────────────────────────────

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `90m`, `25h`, `2d`, `1500ms`: a duration in milliseconds. */
export function durationMs(text) {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(String(text).trim());
  if (!m) throw new Error(`${JSON.stringify(text)} is not a duration such as 90m, 25h or 2d`);
  return Number(m[1]) * UNITS[m[2]];
}

/** How far the session's clock stands ahead of the wall clock, in milliseconds (the file `clock-offset-ms`). */
export function clockOffsetMs(dir) {
  try {
    const n = Number(readFileSync(join(dir, "clock-offset-ms"), "utf8").trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Moves the session's clock forward by `ms`; the clock never goes back. Gives the new offset. */
export function advanceClock(dir, ms) {
  const next = clockOffsetMs(dir) + ms;
  writeFileSync(join(dir, "clock-offset-ms"), `${next}\n`);
  return next;
}

// ── the templates ───────────────────────────────────────────────────────

/** A JSON value with every `<placeholder>` (as a string, or as a key) replaced; one that is not given, or one left over, is an error. */
export function fill(value, given) {
  const left = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      const m = /^<([a-z-]+)>$/.exec(v);
      if (m) {
        if (!Object.hasOwn(given, m[1])) left.add(m[0]);
        return Object.hasOwn(given, m[1]) ? given[m[1]] : v;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [walk(k), walk(x)]));
    return v;
  };
  const out = walk(value);
  if (left.size) throw new Error(`no value for ${[...left].join(", ")}`);
  return out;
}

/** The placeholders (`<name>`) of a JSON text. */
export function placeholders(text) {
  return [...new Set([...text.matchAll(/"<([a-z-]+)>"/g)].map((m) => m[1]))];
}

/**
 * The lock for the session from fixtures/attention/live/invoices.lock.template.json: the two members, their keys and
 * the roles they hold. `people`: `{ accountant: { member, keyId }, finance_lead: { member, keyId } }`.
 */
export function lockFrom(template, people) {
  return fill(template, {
    "accountant-member": people.accountant.member,
    "accountant-key": people.accountant.keyId,
    "finance-lead-member": people.finance_lead.member,
    "finance-lead-key": people.finance_lead.keyId,
  });
}

// ── the world ───────────────────────────────────────────────────────────

/**
 * The egress proxy's own configuration for the session: no secret in it (each credential names the variable of this
 * process that holds its secret).
 */
export function egressConfigFor(admin, real) {
  return {
    admin,
    // The fakes' two names resolve to loopback (the kit's own resolver says so, and answers for no other name).
    allow_private: true,
    credentials: {
      acme_erp: { env: "MANDATE_LIVE_ERP_SECRET", hosts: ["erp.acme.example"], header: "authorization", template: "Bearer {secret}" },
      acme_mail: { env: "MANDATE_LIVE_MAIL_SECRET", hosts: ["mail.acme.example"], header: "x-api-key", template: "{secret}" },
      ...(real ? { anthropic: { env: real.env, hosts: ["api.anthropic.com"], header: "x-api-key", template: "{secret}" } } : {}),
    },
  };
}

/** The runtime configuration of the session, from its template; the real model, with its gateway and its sandbox, when asked for. */
export function runtimeConfigFor(template, o) {
  const config = fill(template, { database: o.database, "egress-admin": o.admin });
  if (!o.real) return config;
  const sandbox = process.platform === "win32" ? { host: "mxc", toolchain: [join(process.execPath, "..")], isolation: "process" } : { host: "mxc", mode: "enforcement" };
  return { ...config, model: { provider: "anthropic" }, sandbox, egress: { ...config.egress, gateways: { model: "anthropic" } } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Brings the world up in `dir`: the session's directories and files (the runtime's configuration, the egress proxy's,
 * the libraries, the decision-keys directory the lock step fills), the fake ERP and the fake mailbox, and the egress
 * proxy in front of them with the two credentials (and the model's, with `real`). Nothing else is reached: the proxy's
 * dialer connects the two names of the connectors to the two fakes whatever address they resolve to, and the model's
 * host to the real API when `real` is given, and refuses every other host. Gives the world, with `stop()`.
 *
 * @param {{ dir: string, repo: string, book: ReturnType<typeof makeBook>, database?: string, real?: { env: string }, log?: (line: string) => void }} o
 * @param {{ serveEgress: (o: { config: string, env: Record<string, string>, resolve: Function, dial: Function }) => Promise<{ stop(): Promise<void> }>, defaultDialer?: (ca?: string) => Function, isPublicAddress?: (a: string) => boolean }} deps
 */
export async function startWorld(o, deps) {
  const { dir, repo, book } = o;
  const read = (p) => readFileSync(join(repo, p), "utf8");
  const lockTemplate = read("fixtures/attention/live/invoices.lock.template.json");
  const libraryDir = join(repo, "fixtures", "library", "acme.connectors");
  // The kit's guard: every host of the lock and of the library's connectors is loopback or reserved for documentation.
  const declared = readFileSync(join(libraryDir, "connectors.mdt"), "utf8");
  for (const host of [...hostsIn(lockTemplate), ...hostsIn(declared)]) assertLocalOnly("a connector's host", host);
  if (o.database !== undefined && !/^(pglite:|postgres(ql)?:\/\/)/.test(o.database)) throw new Error("the database is a PostgreSQL URL (postgresql://…) or pglite:<directory>");

  mkdirSync(dir, { recursive: true });
  for (const d of ["people", "decision-keys", "libraries", "pages"]) mkdirSync(join(dir, d), { recursive: true });
  const version = JSON.parse(readFileSync(join(libraryDir, "mandate.library.json"), "utf8")).version;
  cpSync(libraryDir, join(dir, "libraries", "acme.connectors", version), { recursive: true });
  if (!existsSync(join(dir, "clock-offset-ms"))) writeFileSync(join(dir, "clock-offset-ms"), "0\n");

  const id = randomBytes(4).toString("hex");
  const admin = process.platform === "win32" ? `\\\\.\\pipe\\mandate-live-${id}` : join(dir, "egress.sock");
  const secrets = { MANDATE_LIVE_ERP_SECRET: randomBytes(24).toString("hex"), MANDATE_LIVE_MAIL_SECRET: randomBytes(24).toString("hex") };
  const log = o.log ?? (() => {});

  const erp = erpState(book);
  const mailbox = mailboxState(book);
  const erpServer = await listen(mcpServer({ tools: erp.tools, header: "authorization", secret: `Bearer ${secrets.MANDATE_LIVE_ERP_SECRET}`, log: (l) => log(`ERP      ${l}`) }));
  const mailServer = await listen(mcpServer({ tools: mailbox.tools, header: "x-api-key", secret: secrets.MANDATE_LIVE_MAIL_SECRET, log: (l) => log(`mailbox  ${l}`) }));

  const database = o.database ?? "pglite:store";
  const config = runtimeConfigFor(JSON.parse(read("fixtures/attention/live/mandate.runtime.template.json")), { database, admin, ...(o.real ? { real: o.real } : {}) });
  writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify(config, null, 2) + "\n");
  // A design run reads these in place of the servers (it touches nothing): what the fake mailbox and the fake ERP would list.
  const samples = { "acme.connectors.mailbox.list_invoices": { result: mailbox.invoices }, "acme.connectors.erp.list_open_orders": { result: erp.orders } };
  writeFileSync(join(dir, "samples.json"), JSON.stringify(samples, null, 2) + "\n");
  writeFileSync(join(dir, "mandate.egress.json"), JSON.stringify(egressConfigFor(admin, o.real), null, 2) + "\n");

  const ports = new Map([["erp.acme.example", erpServer.port], ["mail.acme.example", mailServer.port]]);
  const real = o.real && deps.defaultDialer ? deps.defaultDialer() : undefined;
  /** A name the fakes stand for resolves to an address of no meaning (documentation's), the model's host to what it really is; no other host resolves. */
  const resolve = async (host) => {
    if (ports.has(host)) return [{ address: "127.0.0.1", family: 4 }];
    if (real && host === "api.anthropic.com") {
      const { lookup } = await import("node:dns/promises");
      return (await lookup(host, { all: true, order: "verbatim" })).filter((a) => deps.isPublicAddress(a.address));
    }
    throw new Error(`the live kit's proxy does not resolve ${host}`);
  };
  const dial = async (r) => {
    const port = ports.get(r.host);
    if (port !== undefined) {
      return new Promise((ok, fail) => {
        const s = connect({ host: "127.0.0.1", port });
        s.once("connect", () => ok(s));
        s.once("error", fail);
      });
    }
    if (real && r.host === "api.anthropic.com") return real(r);
    throw new Error(`the live kit's proxy does not dial ${r.host}`);
  };
  const env = { ...secrets, ...(o.real ? { [o.real.env]: process.env[o.real.env] ?? "" } : {}) };
  const egress = await deps.serveEgress({ config: join(dir, "mandate.egress.json"), env, resolve, dial });

  return {
    dir,
    config: join(dir, "mandate.runtime.json"),
    erp,
    mailbox,
    ports: { erp: erpServer.port, mailbox: mailServer.port },
    admin,
    async stop() {
      await egress.stop();
      for (const s of [erpServer.server, mailServer.server]) {
        s.closeAllConnections();
        await new Promise((ok) => s.close(() => ok()));
      }
      await sleep(0);
    },
  };
}

/** The directory of a new session, outside the repository: under the operating system's temporary directory. */
export function newSessionDir() {
  return join(tmpdir(), `mandate-live-${randomBytes(4).toString("hex")}`);
}
