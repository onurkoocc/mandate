// The world of the acceptance rehearsal of 0.7 (spec/attention.md "Acceptance"; slice B10), as pieces a later live kit
// can take: the acceptance fixture fixtures/attention/invoices.mdt with its library and its lock as a deployment writes
// it, a simulated mailbox and ERP (fake-mcp.ts) holding a small book of invoices and orders, the matcher as an agent of
// its own, what every simulator answered (so that a test can hold a notification or a page to holding none of it), a
// scripted authoring agent that drives the Node MCP server (bridge/src/mcp.ts) over its stdio transport, and the
// command line in-process (`main` of src/cli.ts) as a person types it, with keys made by `mandate key new`.
//
// Nothing here is a secret: keys are made at run time (GitGuardian scans each commit), and the values are plain words.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { LibrarySource, Lock } from "@mandate/bridge";
import { serveStdio } from "../../bridge/src/mcp.js";
import { makeBook } from "../../scripts/lib/live-world.mjs";
import { main } from "../src/cli.js";
import { McpClient, type McpFetch } from "../src/mcp-client.js";
import { SimAgents } from "../src/sim.js";
import { isObj, type Obj, type Value } from "../src/values.js";
import { declaredErp, declaredMailbox, INJECTION, type FakeMcp } from "./fake-mcp.js";

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

export const ERP = "acme.connectors.erp";
export const MAIL = "acme.connectors.mailbox";
export const DAY = 86_400_000;

/** The acceptance fixture as it is written, and its lock as the repository holds it (no member's key, no tool digest). */
export const SOURCE = read("fixtures/attention/invoices.mdt");
export const FIXTURE_LOCK = JSON.parse(read("fixtures/attention/invoices.lock.json")) as Obj;
/** The fixture's last role declaration, after which a variant declares a role that looks without being asked. */
const OBSERVED = 'role finance_lead "Finance lead"';
/** The fixture with a third role, `observer`, that no workflow asks or reports to. */
export const OBSERVER_SOURCE = SOURCE.replace(OBSERVED, `${OBSERVED}\nrole observer    "Observer"`);

/** A library of fixtures/library/, as the compiler is given it. */
export function fixtureLibrary(dir: string): LibrarySource {
  const manifest = read(`fixtures/library/${dir}/mandate.library.json`);
  const files = Object.fromEntries((JSON.parse(manifest).modules as string[]).map((f) => [f, read(`fixtures/library/${dir}/${f}`)]));
  return { manifest, files };
}
export const ACME = fixtureLibrary("acme.connectors");

/**
 * The directory of libraries a deployment reads its pins from (spec/library.md "The local directory"):
 * `<dir>/acme.connectors/<version>/`, the files of fixtures/library/acme.connectors as they are.
 */
export function libraryDir(dir: string): string {
  const version = (JSON.parse(ACME.manifest) as { version: string }).version;
  const at = join(dir, "acme.connectors", version);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "mandate.library.json"), ACME.manifest);
  for (const [f, text] of Object.entries(ACME.files)) writeFileSync(join(at, f), text);
  return dir;
}

// ── the book: six invoices and their orders ─────────────────────────────

// The book is the kit's (scripts/lib/live-world.mjs), with this rehearsal's names: the live session takes the same code
// with names of its own.
const BOOK = makeBook();
export const N = BOOK.N;
/** Off in total by 5%: they fail `totals` alone, the criterion the accountant and the finance lead may waive. */
export const TOTALS = BOOK.TOTALS;
/** Matched to an order of another vendor: they fail `vendor`, which nobody may waive, and are declined without asking. */
export const VENDOR = BOOK.VENDOR;
export const ALL = BOOK.ALL;
/** What passes every criterion, and is committed without a question. */
export const PASSED = BOOK.PASSED;

export const invoiceNo = (i: number): string => BOOK.invoiceNo(i);
export const orderNo = (i: number): string => BOOK.orderNo(i);
export const invoice = (i: number): Obj => BOOK.invoice(i);
export const order = (i: number): Obj => BOOK.order(i);

/** Every value of the book: each text (invoice and order numbers, vendors) and each total, of the invoices and of the orders. */
export function book(): { texts: string[]; numbers: number[] } {
  return BOOK.values();
}

// ── the simulators ──────────────────────────────────────────────────────

export interface Simulators {
  erp: ReturnType<typeof declaredErp>;
  mailbox: ReturnType<typeof declaredMailbox>;
  /** The connectors' transport a runtime is given in place of its gateways: each request to the server of its host. */
  transport: { fetch(gateway: { spec: { host: string } }): McpFetch };
  /** The body of every answer either server gave a `tools/call`, as it was sent. */
  answered: string[];
  /** The tools each server was called with, in order. */
  calls(f: FakeMcp): string[];
  /** Every value a server's `tools/call` answered with: each text and number of its structured content, and the words of its texts. */
  returned(): { texts: string[]; numbers: number[] };
}

/** The mailbox and the ERP, holding the book; every answer to a tool call is kept. */
export function simulators(): Simulators {
  const erp = declaredErp();
  const mailbox = declaredMailbox();
  for (const i of ALL) {
    mailbox.invoices.push(invoice(i) as never);
    erp.orders.push(order(i) as never);
  }
  const answered: string[] = [];
  const s: Simulators = {
    erp,
    mailbox,
    answered,
    transport: {
      fetch: (gateway) => async (url, init) => {
        const server = gateway.spec.host === erp.host ? erp : gateway.spec.host === mailbox.host ? mailbox : undefined;
        if (!server) throw new Error(`no simulator at ${gateway.spec.host}`);
        const res = await server.fetch(url, init);
        const body = typeof init.body === "string" ? init.body : "";
        if (/"method":"tools\/call"/.test(body)) answered.push(await res.clone().text());
        return res;
      },
    },
    calls: (f) => f.received.flatMap((r) => (isObj(r.body as Value) && (r.body as Obj)["method"] === "tools/call" ? [String(((r.body as Obj)["params"] as Obj)["name"])] : [])),
    returned: () => {
      const texts = new Set<string>([INJECTION]);
      const numbers = new Set<number>();
      const walk = (v: unknown): void => {
        if (typeof v === "string") texts.add(v);
        else if (typeof v === "number") numbers.add(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (isObj(v as Value)) Object.values(v as Obj).forEach(walk);
      };
      for (const a of answered) {
        const r = (JSON.parse(a) as Obj)["result"];
        if (!isObj(r ?? null)) continue;
        walk((r as Obj)["structuredContent"]);
        // The text content: each text whole, and each of its words.
        for (const c of ((r as Obj)["content"] ?? []) as Obj[]) {
          if (typeof c["text"] !== "string") continue;
          walk(c["text"]);
          for (const word of c["text"].split(/\s+/)) if (word.length >= 6) walk(word);
        }
      }
      return { texts: [...texts], numbers: [...numbers] };
    },
  };
  return s;
}

/** The digests of a server's tools as it lists them now; the listing is not kept among what it received. */
export async function digests(f: FakeMcp): Promise<Record<string, string>> {
  const listed = await new McpClient({ url: `https://${f.host}/mcp`, fetch: f.fetch as McpFetch }).listTools();
  f.received.length = 0;
  return Object.fromEntries(listed.map((t) => [t.name, t.digest]));
}

/** The sample results a design run reads in place of the servers (spec/library.md "Run modes and samples"). */
export function samples(): { tool(name: string): { result: Value } | undefined } {
  return { tool: (name) => (name === `${MAIL}.list_invoices` ? { result: ALL.map(invoice) as Value } : name === `${ERP}.list_open_orders` ? { result: ALL.map(order) as Value } : undefined) };
}

/** The matcher as an agent of its own: the order of the invoice's number, as a model that read the ERP would give it. */
export function matcher(): SimAgents {
  return new SimAgents().on("Matcher.match", (req) => {
    const i = Number(/INV-B10-0(\d)/.exec(JSON.stringify(req.args[0]))![1]);
    return { ok: { invoice_no: invoiceNo(i), order: order(i) }, cost: { steps: 2 } };
  });
}

/**
 * The fixture's lock as a deployment writes it: every member, role, class and pin as the repository has them, the
 * members' key ids made at run time, and the digests of the tools the simulators list. With `observer`, the lock also
 * binds the role `observer` (of OBSERVER_SOURCE) to the member cy, capped at `public`. `classes` replaces caps of the
 * fixture's roles.
 */
export async function deploymentLock(s: Simulators, keys: Record<string, string>, o: { observer?: boolean; classes?: Record<string, string> } = {}): Promise<Lock> {
  const connectors = FIXTURE_LOCK["connectors"] as Record<string, Obj>;
  const classes = { ...(FIXTURE_LOCK["role_classes"] as Obj), ...(o.classes ?? {}), ...(o.observer ? { observer: "public" } : {}) };
  return {
    ...FIXTURE_LOCK,
    connectors: { [ERP]: { ...connectors[ERP], tools: await digests(s.erp) }, [MAIL]: { ...connectors[MAIL], tools: await digests(s.mailbox) } },
    members: Object.fromEntries(Object.entries(keys).map(([m, id]) => [m, { keys: [id] }])),
    ...(o.observer ? { roles: { ...(FIXTURE_LOCK["roles"] as Obj), observer: ["cy"] } } : {}),
    role_classes: classes,
  } as unknown as Lock;
}

// ── the command line, as a person types it ──────────────────────────────

export interface Said {
  code: number;
  out: string;
  err: string;
}

/**
 * One call of the control CLI in this process (`main` of src/cli.ts), with `--config config`: what it prints, what it
 * writes on standard error, and its exit status. `input` is what a person types, a line per prompt: a line as it is,
 * or the answer a person gives to what the command has printed so far, when the prompt is shown.
 *
 * The environment the command is given is empty: no secret is in it, as a deployment with an egress proxy needs. A
 * live kit that reaches real servers passes the real one.
 */
export async function mandate(config: string, args: string[], input?: Array<string | ((printed: string) => string)>): Promise<Said> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  const lines = input === undefined ? undefined : (async function* (): AsyncGenerator<string> {
    for (const l of input) yield typeof l === "string" ? l : l(out);
  })();
  try {
    const code = await main([...args, "--config", config], (s) => (out += s), {}, async () => "", lines);
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

export interface PersonKey {
  /** The private key's file, which `--key` names. */
  file: string;
  /** Its key id, which the lock lists under the member. */
  id: string;
}

/** A person's key made by `mandate key new`, its public half put in the runtime's `decisions.keys` directory. */
export async function personKey(config: string, home: string, name: string, trusted: string): Promise<PersonKey> {
  mkdirSync(home, { recursive: true });
  mkdirSync(trusted, { recursive: true });
  const file = join(home, `${name}.key`);
  const made = await mandate(config, ["key", "new", "--out", file]);
  if (made.code !== 0) throw new Error(`mandate key new: ${made.err}`);
  const id = /^key (sha256:[0-9a-f]{64})\n/.exec(made.out)![1]!;
  const pem = `${id.slice("sha256:".length)}.pem`;
  copyFileSync(join(home, pem), join(trusted, pem));
  return { file, id };
}

// ── the authoring agent's side: the MCP server over stdio ───────────────

/** The `_meta` of every modern request of the session, as the recorded conversations send it. */
export const MODERN_META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };

/**
 * A live session with the Node MCP server (`serveStdio` of bridge/src/mcp.ts, serving `language`): each request is
 * written as a line on its standard input, and its answer is the next line it writes. What the agent sends next is
 * its own to choose from what it was answered.
 */
export class McpSession {
  private readonly input = new PassThrough();
  private buffered = "";
  private readonly answers: string[] = [];
  private waiting: ((line: string) => void) | undefined;
  private readonly served: Promise<void>;
  /** Every line the session wrote, and every line it was answered, in order. */
  readonly sent: string[] = [];
  readonly received: string[] = [];
  private id = 0;

  constructor(language = "mandate/0.7") {
    const output = new Writable({
      write: (chunk, _encoding, done) => {
        this.buffered += Buffer.from(chunk as Buffer).toString("utf8");
        for (let at = this.buffered.indexOf("\n"); at >= 0; at = this.buffered.indexOf("\n")) {
          const line = this.buffered.slice(0, at);
          this.buffered = this.buffered.slice(at + 1);
          if (this.waiting) {
            const w = this.waiting;
            this.waiting = undefined;
            w(line);
          } else this.answers.push(line);
        }
        done();
      },
    });
    this.served = serveStdio(this.input, output, {}, language);
  }

  /** Sends one request, and gives its answer: the line as the server wrote it, and the message it holds. */
  async request(method: string, params: Obj = {}): Promise<{ line: string; message: Obj }> {
    const line = JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params: { ...params, _meta: MODERN_META } });
    this.sent.push(line);
    const answered = new Promise<string>((resolve) => {
      const ready = this.answers.shift();
      if (ready !== undefined) resolve(ready);
      else this.waiting = resolve;
    });
    this.input.write(`${line}\n`);
    const got = await answered;
    this.received.push(got);
    return { line: got, message: JSON.parse(got) as Obj };
  }

  /** A tool call: its structured content, or the text of a tool error. */
  async tool(name: string, args: Obj): Promise<{ line: string; result: Obj; isError: boolean }> {
    const { line, message } = await this.request("tools/call", { name, arguments: args as Value });
    const r = (message["result"] ?? {}) as Obj;
    return { line, result: (r["structuredContent"] ?? { text: ((r["content"] as Obj[] | undefined)?.[0] as Obj | undefined)?.["text"] ?? null }) as Obj, isError: r["isError"] === true };
  }

  /** Ends the session: the server's input ends, and it stops. */
  async close(): Promise<void> {
    this.input.end();
    await this.served;
  }
}
