// What the accountant is shown of the attention fixture from a terminal and from the pages (spec/attention.md "The
// command line", "Acceptance"; slice B5): fixtures/attention/invoices.mdt under its own lock, a design run that asks the
// accountant about the one invoice that is off in total. The text `mandate waits --role accountant` prints and the page
// `mandate watch --member ana --out DIR` writes for the run are the functions the commands call over the same runtime;
// the commands themselves are held in cli-person.test.ts. With B5_ARTIFACTS set to a directory, the test saves both
// there as they are, for the pull request. Keys are made at run time; the values are plain words.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LibrarySource, Lock } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import { shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { McpClient, type McpFetch } from "../src/mcp-client.js";
import { pass, waitsText } from "../src/person.js";
import { SimAgents } from "../src/sim.js";
import type { Obj } from "../src/values.js";
import { declaredErp, declaredMailbox, type FakeMcp } from "./fake-mcp.js";
import { closeAll, world, type World } from "./helpers.js";

afterAll(closeAll);

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function fixtureLibrary(dir: string): LibrarySource {
  const manifest = read(`fixtures/library/${dir}/mandate.library.json`);
  const files = Object.fromEntries((JSON.parse(manifest).modules as string[]).map((f) => [f, read(`fixtures/library/${dir}/${f}`)]));
  return { manifest, files };
}

const SOURCE = read("fixtures/attention/invoices.mdt");
const LOCK = JSON.parse(read("fixtures/attention/invoices.lock.json")) as Obj;
const ERP = "acme.connectors.erp";
const MAIL = "acme.connectors.mailbox";
const N = 6;
const TOTALS = [1];
const VENDOR = [2];
const ALL = Array.from({ length: N }, (_, i) => i);
const invoiceNo = (i: number): string => `INV-0${i}`;
const orderTotal = (i: number): number => 10_000 + i * 100;
const invoice = (i: number): Obj => ({ invoice_no: invoiceNo(i), vendor_id: `V${i}`, total_cents: TOTALS.includes(i) ? Math.round(orderTotal(i) * 1.05) : orderTotal(i) });
const order = (i: number): Obj => ({ order_no: `PO-0${i}`, vendor_id: VENDOR.includes(i) ? "V9" : `V${i}`, total_cents: orderTotal(i) });

async function digests(f: FakeMcp): Promise<Record<string, string>> {
  const listed = await new McpClient({ url: `https://${f.host}/mcp`, fetch: f.fetch as McpFetch }).listTools();
  f.received.length = 0;
  return Object.fromEntries(listed.map((t) => [t.name, t.digest]));
}

/** The fixture on a runtime whose connectors answer from the fakes, under its lock with `classes` in place of its `role_classes`, if given. */
async function invoices(classes?: Record<string, string>): Promise<World & { ana: EvidenceSigner }> {
  const erp = declaredErp();
  const mailbox = declaredMailbox();
  for (const i of ALL) {
    mailbox.invoices.push(invoice(i) as never);
    erp.orders.push(order(i) as never);
  }
  const ana = EvidenceSigner.generate();
  const ben = EvidenceSigner.generate();
  const connectors = LOCK["connectors"] as Record<string, Obj>;
  const lock = {
    ...LOCK,
    connectors: { [ERP]: { ...connectors[ERP], tools: await digests(erp) }, [MAIL]: { ...connectors[MAIL], tools: await digests(mailbox) } },
    members: { ana: { keys: [ana.keyId] }, ben: { keys: [ben.keyId] } },
    ...(classes ? { role_classes: classes } : {}),
  } as unknown as Lock;
  const agents = new SimAgents().on("Matcher.match", (req) => {
    const i = Number(/INV-0(\d)/.exec(JSON.stringify(req.args[0]))![1]);
    return { ok: { invoice_no: invoiceNo(i), order: order(i) }, cost: { steps: 2 } };
  });
  const w = await world(SOURCE, { libraries: [fixtureLibrary("acme.connectors")], lock, decisions: { keys: new TrustedKeys([ana.publicKey, ben.publicKey]) }, agents });
  w.adapters.connectors = {
    fetch: (gateway: { spec: { host: string } }): McpFetch => {
      const server = gateway.spec.host === erp.host ? erp : mailbox;
      return (url, init) => server.fetch(url, init);
    },
  } as never;
  w.adapters.samples = { tool: (name: string) => (name === `${MAIL}.list_invoices` ? { result: ALL.map(invoice) } : name === `${ERP}.list_open_orders` ? { result: ALL.map(order) } : undefined) } as never;
  return { ...w, ana };
}

/** The design run, waiting on the accountant's review of the invoice that is off. */
async function waiting(classes?: Record<string, string>): Promise<World> {
  const w = await invoices(classes);
  await w.rt.approveEnvelope(w.pkg, signDecision(w.ana, shownPackage(w.pkg.hash, "accountant"), { kind: "envelope", member: "ana", at: new Date(w.adapters.clock.now()) }));
  const run = await w.rt.startRun({ pkg: w.pkg, workflow: "MatchInvoices", input: {}, runId: "d1", mode: "design" });
  expect(run.state, JSON.stringify(run.error ?? run.attention ?? null)).toBe("waiting");
  return w;
}

/** The pages of the member as `mandate watch --member M --out DIR` writes them, in a directory of the test's own. */
async function pagesOf(w: World, member: string): Promise<{ dir: string; files: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "mandate-person-invoices-"));
  const made = await pass(w.rt, member, dir, { state: { content: new Map(), runs: new Map() } });
  expect(made.problems).toEqual([]);
  return { dir, files: readdirSync(dir).sort() };
}

const keep = process.env["B5_ARTIFACTS"];

describe("the attention fixture, as the accountant is shown it", () => {
  it("lists the review with its deadline, its no-answer behaviour and the invoice, and writes script-free pages", { timeout: 120_000 }, async () => {
    const w = await waiting();
    const text = waitsText({ role: "accountant" }, await w.rt.listWaits({ role: "accountant" }));
    expect(text).toMatch(/^1 open decision for role accountant\n/);
    expect(text).toContain("run d1  MatchInvoices");
    expect(text).toContain("review, asked of accountant");
    expect(text).toMatch(/deadline {2}\d{4}-\d\d-\d\dT/);
    expect(text).toContain("if nobody answers  ");
    expect(text).toContain(invoiceNo(1));
    expect(text).toContain("class confidential");
    const { dir, files } = await pagesOf(w, "ana");
    try {
      expect(files).toContain("d1.accountant.html");
      expect(files).toContain("index.html");
      const page = readFileSync(join(dir, "d1.accountant.html"), "utf8");
      expect(page).not.toMatch(/<script|\son[a-z]+\s*=|javascript:|href=|src=/i);
      expect(page).toContain(invoiceNo(1));
      if (keep) {
        writeFileSync(join(keep, "b5-waits.txt"), text);
        writeFileSync(join(keep, "b5-page.html"), page);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows no invoice, in a line or on a page, to an accountant whose cap the lock sets below the invoice's class", { timeout: 120_000 }, async () => {
    const w = await waiting({ accountant: "internal", finance_lead: "confidential" });
    const text = waitsText({ role: "accountant" }, await w.rt.listWaits({ role: "accountant" }));
    expect(text).toContain("masked");
    for (const i of ALL) expect(text, `invoice ${i}`).not.toContain(invoiceNo(i));
    const { dir, files } = await pagesOf(w, "ana");
    try {
      for (const f of files) {
        const html = readFileSync(join(dir, f), "utf8");
        for (const i of ALL) expect(html, `${f}: invoice ${i}`).not.toContain(invoiceNo(i));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
