// The attention fixture run end to end with its own lock (spec/attention.md "Card approval", "Promotion", "Masking and
// how a value is known"; slices B4 and B6 together): fixtures/attention/invoices.mdt, whose workflow MatchInvoices is
// owned by the accountant, under fixtures/attention/invoices.lock.json as it is written (`role_classes` confidential
// for both roles, `promotion: required`). The lock keeps every member, role, class and pin; the test puts in only what
// it must make at run time: the members' keys, and the digests of the tools its fake servers list.
//
// One world: a mailbox holding six invoices and an ERP holding their orders (fake-mcp.ts), the matcher as an agent of
// its own. Invoice 1 is off in total by 5%, which fails only `totals`, the criterion a person may waive; invoice 2 names
// another vendor, which nobody may waive. Keys are made at run time (GitGuardian scans each commit); the values are
// plain words.

import { readFileSync } from "node:fs";
import type { LibrarySource, Lock } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import { payloadOf, shownPackage, signDecision, type SignedDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { McpClient, type McpFetch } from "../src/mcp-client.js";
import { SimAgents } from "../src/sim.js";
import { isObj, type Obj, type Value } from "../src/values.js";
import { runView } from "../src/views.js";
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
const DAY = 86_400_000;
const HEAVY = { timeout: 120_000 };

const N = 6;
const TOTALS = [1];
const VENDOR = [2];
const ALL = Array.from({ length: N }, (_, i) => i);
const invoiceNo = (i: number): string => `INV-0${i}`;
const orderTotal = (i: number): number => 10_000 + i * 100;
const invoice = (i: number): Obj => ({ invoice_no: invoiceNo(i), vendor_id: `V${i}`, total_cents: TOTALS.includes(i) ? Math.round(orderTotal(i) * 1.05) : orderTotal(i) });
const order = (i: number): Obj => ({ order_no: `PO-0${i}`, vendor_id: VENDOR.includes(i) ? "V9" : `V${i}`, total_cents: orderTotal(i) });

/** The digests of a server's tools as it lists them now. */
async function digests(f: FakeMcp): Promise<Record<string, string>> {
  const listed = await new McpClient({ url: `https://${f.host}/mcp`, fetch: f.fetch as McpFetch }).listTools();
  f.received.length = 0;
  return Object.fromEntries(listed.map((t) => [t.name, t.digest]));
}

interface Person {
  member: "ana" | "ben";
  key: EvidenceSigner;
}

interface IWorld extends World {
  ana: Person;
  ben: Person;
  erp: ReturnType<typeof declaredErp>;
  mailbox: ReturnType<typeof declaredMailbox>;
}

/** The fixture on a runtime whose connectors answer from the fakes, under its lock with `classes` in place of its `role_classes`, if given. */
async function invoices(classes?: Record<string, string>): Promise<IWorld> {
  const erp = declaredErp();
  const mailbox = declaredMailbox();
  for (const i of ALL) {
    mailbox.invoices.push(invoice(i) as never);
    erp.orders.push(order(i) as never);
  }
  const ana: Person = { member: "ana", key: EvidenceSigner.generate() };
  const ben: Person = { member: "ben", key: EvidenceSigner.generate() };
  const connectors = LOCK["connectors"] as Record<string, Obj>;
  const lock = {
    ...LOCK,
    connectors: { [ERP]: { ...connectors[ERP], tools: await digests(erp) }, [MAIL]: { ...connectors[MAIL], tools: await digests(mailbox) } },
    members: { ana: { keys: [ana.key.keyId] }, ben: { keys: [ben.key.keyId] } },
    ...(classes ? { role_classes: classes } : {}),
  } as unknown as Lock;
  const agents = new SimAgents().on("Matcher.match", (req) => {
    const i = Number(/INV-0(\d)/.exec(JSON.stringify(req.args[0]))![1]);
    return { ok: { invoice_no: invoiceNo(i), order: order(i) }, cost: { steps: 2 } };
  });
  const w = await world(SOURCE, { libraries: [fixtureLibrary("acme.connectors")], lock, decisions: { keys: new TrustedKeys([ana.key.publicKey, ben.key.publicKey]) }, agents });
  w.adapters.connectors = {
    fetch: (gateway: { spec: { host: string } }): McpFetch => {
      const server = gateway.spec.host === erp.host ? erp : mailbox;
      return (url, init) => server.fetch(url, init);
    },
  } as never;
  w.adapters.samples = { tool: (name: string) => (name === `${MAIL}.list_invoices` ? { result: ALL.map(invoice) } : name === `${ERP}.list_open_orders` ? { result: ALL.map(order) } : undefined) } as never;
  return { ...w, ana, ben, erp, mailbox };
}

const at = (w: World): Date => new Date(w.adapters.clock.now());
const start = (w: World, runId: string, mode: "design" | "read_only"): Promise<RunRow> => w.rt.startRun({ pkg: w.pkg, workflow: "MatchInvoices", input: {}, runId, mode });
const state = (r: RunRow): string => `${r.state} ${JSON.stringify(r.error ?? r.attention ?? null)}`;

let n = 0;
async function decide(w: World, runId: string, who: Person, d: { waive: number[]; decline: number[] }): Promise<RunRow> {
  const signed: SignedDecision = signDecision(who.key, await w.rt.shown(runId, "wait"), { kind: "review", member: who.member, payload: payloadOf.review(d), at: at(w) });
  return w.rt.decideReview(runId, { sender: "cli", messageId: `m${++n}` }, { signed, ...d });
}

async function promote(w: World, who: Person, runId: string): Promise<void> {
  const shown = await w.rt.promotionShown(runId, "read_only");
  await w.rt.promote(w.pkg, signDecision(who.key, { package: shown.package, run: shown.run, revision: shown.revision, subject: shown.subject, role: shown.role }, { kind: "promote", member: who.member, payload: payloadOf.promotion("read_only"), at: at(w) }));
}

/** What `role` is given of the run, by each path: its view, `WatchRun` and `ListWaits`, as one text each. */
async function given(w: World, runId: string, role: string) {
  const view = (await runView(w.rt, runId, { role })).view;
  const watched = await w.rt.watchRun(runId, { role }, { limit: 500 });
  const waits = (await w.rt.listWaits({ role })).filter((x) => x.run === runId);
  return { view, watched, waits, text: { view: JSON.stringify(view), watchRun: JSON.stringify(watched), listWaits: JSON.stringify(waits) } };
}

/** The value an item of a review question shows, as the role is given it. */
const itemsOf = (waiting: Value): Obj[] => ((isObj(waiting) ? ((waiting["request"] as Obj)["question"] as Obj) : {})["items"] as Obj[]) ?? [];

describe("the attention fixture fixtures/attention/invoices.mdt under its own lock", () => {
  it("has the owner approve its card, runs design, is promoted by the owner, runs read_only, and gives each role the values its cap allows", HEAVY, async () => {
    expect([LOCK["role_classes"], LOCK["promotion"]]).toEqual([{ accountant: "confidential", finance_lead: "confidential" }, "required"]);
    const w = await invoices();
    // The card first: the accountant owns the workflow; then the ladder: no read_only run before a promotion.
    await expect(start(w, "d0", "design")).rejects.toMatchObject({ code: "unapproved_envelope" });
    await w.rt.approveEnvelope(w.pkg, signDecision(w.ana.key, shownPackage(w.pkg.hash, "accountant"), { kind: "envelope", member: "ana", at: at(w) }));
    await expect(start(w, "r0", "read_only")).rejects.toMatchObject({ code: "unpromoted" });

    // The design run asks the accountant about invoice 1, whose values her cap (confidential) shows.
    const d = await start(w, "d1", "design");
    expect(d.state, state(d)).toBe("waiting");
    const asked = await given(w, "d1", "accountant");
    const items = itemsOf(asked.view.waiting);
    expect(items.map((i) => i["index"])).toEqual(TOTALS);
    expect(items[0]!["value"]).toMatchObject({ masked: false, value: expect.objectContaining({ invoice_no: invoiceNo(1) }) });
    for (const [where, text] of Object.entries(asked.text)) expect(text, where).toContain(invoiceNo(1));
    expect(asked.waits).toHaveLength(1);
    expect(asked.waits[0]!.shown.every((s) => "masked" in s && !s.masked)).toBe(true);
    // The finance lead is not asked yet: nothing of the wait.
    const lead = await given(w, "d1", "finance_lead");
    expect([lead.view.waiting, lead.waits]).toEqual([null, []]);
    for (const [where, text] of Object.entries(lead.text)) expect(text, where).not.toContain(invoiceNo(1));
    expect(state(await decide(w, "d1", w.ana, { waive: [1], decline: [] }))).toBe("succeeded null");

    // The owner promotes the design run; the read_only run starts under it, and asks the accountant, then the finance lead.
    await promote(w, w.ana, "d1");
    const r = await start(w, "r1", "read_only");
    expect(r.state, state(r)).toBe("waiting");
    w.clock.advance(DAY + 1);
    expect((await w.rt.tick("r1")).state).toBe("waiting");
    const escalated = await given(w, "r1", "finance_lead");
    expect(itemsOf(escalated.view.waiting)[0]!["value"]).toMatchObject({ masked: false, value: expect.objectContaining({ invoice_no: invoiceNo(1) }) });
    expect(escalated.waits).toHaveLength(1);
    expect(escalated.waits[0]!.shown.every((s) => "masked" in s && !s.masked)).toBe(true);
    const done = await decide(w, "r1", w.ben, { waive: [1], decline: [] });
    expect(state(done)).toBe("succeeded null");
    expect(w.erp.postings).toBe(0);

    // The promotion the run started under: to the owner role that signed it, the decision as it is (no wait's values),
    // and never the key; the finance lead is not given it. The manifest's section holds no promotion.
    const owner = await given(w, "r1", "accountant");
    const accepted = owner.watched.events.filter((e) => e.type === "promotion_accepted");
    expect(accepted).toHaveLength(1);
    expect(Object.keys(accepted[0]!.data!).sort()).toEqual(["decision", "from", "member", "role", "to"]);
    expect(accepted[0]!.data).toMatchObject({ member: "ana", role: "accountant", from: { run: "d1", mode: "design" }, to: "read_only" });
    expect(typeof accepted[0]!.data!["decision"]).toBe("string");
    expect((await given(w, "r1", "finance_lead")).watched.events.some((e) => e.type === "promotion_accepted")).toBe(false);
    expect(Object.keys(owner.view.manifest).sort()).toEqual(["components", "hash", "mode"]);
    expect(owner.view.manifest.mode).toBe("read_only");
  });

  it("masks the same values, on every path, for a role whose cap the lock sets below their class", HEAVY, async () => {
    const w = await invoices({ accountant: "internal", finance_lead: "confidential" });
    await w.rt.approveEnvelope(w.pkg, signDecision(w.ana.key, shownPackage(w.pkg.hash, "accountant"), { kind: "envelope", member: "ana", at: at(w) }));
    const d = await start(w, "d1", "design");
    expect(d.state, state(d)).toBe("waiting");
    const asked = await given(w, "d1", "accountant");
    expect(itemsOf(asked.view.waiting)[0]!["value"]).toMatchObject({ masked: true, class: "confidential" });
    expect(asked.waits).toHaveLength(1);
    expect(asked.waits[0]!.shown.length).toBeGreaterThan(0);
    expect(asked.waits[0]!.shown.every((s) => "masked" in s && s.masked)).toBe(true);
    for (const [where, text] of Object.entries(asked.text)) {
      for (const i of ALL) expect(text, `${where}: invoice ${i}`).not.toContain(invoiceNo(i));
    }
  });
});
