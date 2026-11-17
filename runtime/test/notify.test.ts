// Notifications (spec/attention.md "Notifications", "Refusals"): a cursor pump that tells the roles of a 0.7 run what
// is asked of them and how the run ended, through a webhook that leaves only through the egress proxy, or a file.
//
// - The configuration (`notifications` in mandate.runtime.json) is refused by name, `bad_notification_channel`, for
//   each way it cannot be used, one case each.
// - What a notification may carry: a run's id, a tenant, a workflow, a command and a package in their safe forms, the
//   names a lead chose inside a sub-program as a digest, a link that points where its template points.
// - The pump: one attempt per notification per pass, the attempts and the next try kept beside the cursor, which stays
//   before the notification meanwhile; the sixth attempt gives it up (`notify_dead`); at least once, a repeat with the
//   same id; two pumps racing; a way out that is not there is no attempt; a stop cuts a request in flight; halts; a
//   channel that meets a run for the first time; only runs with something new are visited.
// - The webhook: through the proxy's session and nowhere else, a redirect is an error and is not followed, a URL that
//   is not https never reaches the network, the credential's secret is in no reason, report or row; the session it is
//   sent in is scoped to the tenant and `notify:<channel>`; the proxy's denial of a request is a failed attempt.
// - The leak test: runs whose inputs, steps, results, errors, questions, an amendment's reason, a budget's and an
//   attention's details and a sub-program's names hold markers; no marker is in anything either adapter emits, in
//   either webhook format, and every payload has exactly the fixed members.
//
// The proxy is the egress tests' in-process one, with an in-process upstream and no network. The clock is the
// runtime's simulated one. Every secret is a made-up word.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/control.js";
import type { Db, Row } from "../src/db.js";
import { EVENT_CLASSES } from "../src/classes.js";
import { payloadOf } from "../src/decisions.js";
import {
  backoffMs,
  carried,
  CARRIED,
  commandShown,
  egressTransport,
  linkOf,
  NOTIFICATION_FORMAT,
  NOTIFICATION_HEADER,
  NOTIFICATION_MEMBERS,
  NOTIFIED,
  notifyPass,
  NotifyUnavailable,
  readNotifications,
  sentence,
  webhookNotifier,
  type Notification,
  type NotificationsConfig,
  type NotifyOptions,
  type WebhookTransport,
} from "../src/notify.js";
import { Violation } from "../src/signals.js";
import { tickPass } from "../src/tick.js";
import { digest, type Obj } from "../src/values.js";
import { seenHeader, world as egressWorld, type World as EgressWorld } from "./egress-world.js";
import { closeAll, until } from "./helpers.js";
import { answer, append, approveCard, count, DAY, inv, lines, msg, nworld, OWNED, REVIEW, REVIEW_AT, scratch, sign, BATCH, waitingRow, type NWorld } from "./notify-world.js";

const dirs: string[] = [];
afterAll(async () => {
  await closeAll();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = scratch();
  dirs.push(d);
  return d;
}

const HOOK_SECRET = "made-up-hook-word";
const HOOK = "https://hooks.acme.example/in";
const M = "LEAKMARK";

/** A configuration as the operator writes it, read as the runtime reads it: a path relative to the file, or absolute. */
function config(raw: unknown, where = dir()): NotificationsConfig {
  return readNotifications(raw, { file: join(where, "mandate.runtime.json"), at: (p) => resolve(where, p), egress: true });
}

/** A first pass of each configuration's channels, which meets them: a run that begins after it is told from its first event. */
async function meet(w: NWorld, ...configs: NotificationsConfig[]): Promise<void> {
  for (const c of configs) await notifyPass(w.db, { config: c, now: () => w.clock.now(), transport: fakeWay().transport });
}

/**
 * A run of OWNED that asks the platform lead (no role) and waits for the answer, after which its journal holds two
 * outcomes, a budget run out and a stop for a person (written as the runtime writes events, under the run's lock):
 * three notifications to `hook` (or the channels of `meets`), the question still asked. The channels are met in a new
 * world before its first run begins; a later run of the same world begins with them in use already.
 */
async function ownedRun(runId = "o1", tenant?: string, w0?: NWorld, meets: NotificationsConfig[] = [config(HOOK_CONFIG)]): Promise<NWorld> {
  const w = w0 ?? (await nworld(OWNED, "0.7"));
  if (!w0) {
    await approveCard(w);
    await meet(w, ...meets);
  }
  await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId, ...(tenant ? { tenant } : {}) });
  await append(w, runId, "budget_exceeded", { episode: 0, detail: { $tag: "BudgetExceeded", $args: [{ dimension: "steps" }] } });
  await append(w, runId, "run_attention_required", { attention: { violation: "made_up" } });
  expect((await w.rt.getRun(runId)).state).toBe("waiting");
  return w;
}

/** A run of OWNED that asked twice, was answered twice, and succeeded. */
async function endedRun(w: NWorld, runId: string): Promise<void> {
  await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId });
  await answer(w, runId, w.who.pat, "because");
  await answer(w, runId, w.who.rex, "yes");
  expect((await w.rt.getRun(runId)).state).toBe("succeeded");
}

/** The three notifications of `ownedRun`, in its order. */
const OWNED_TOLD = ["wait_opened platform_lead", "budget_exceeded platform_lead", "run_attention_required platform_lead"];

const HOOK_CONFIG = { channels: { hook: { webhook: { url: HOOK, credential: "acme_hook", format: "mandate" } } }, roles: { platform_lead: { channels: ["hook"] }, reviewer: { channels: ["hook"] } } };

interface Call {
  url: string;
  tenant: string;
  headers: Record<string, string>;
  body: string;
}

type Answer = (id: string, nth: number, signal: AbortSignal | undefined) => Response | Error | Promise<Response>;

/** A webhook's way out that answers as `answer` says, by the notification's id and how often it was sent; it records each request. */
function fakeWay(answer: Answer = () => new Response("ok")) {
  const calls: Call[] = [];
  const opened: string[] = [];
  let ready: (tenant: string) => Promise<void> = async () => undefined;
  const transport = (): WebhookTransport => ({
    open: (channel, _spec, tenant) => {
      opened.push(`${channel} ${tenant}`);
      return {
        ready: () => ready(tenant),
        fetch: (async (url: string, init?: RequestInit) => {
          const headers: Record<string, string> = {};
          new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
          calls.push({ url: String(url), tenant, headers, body: String(init?.body) });
          const id = headers[NOTIFICATION_HEADER]!;
          const a = await answer(id, calls.filter((c) => c.headers[NOTIFICATION_HEADER] === id).length, init?.signal ?? undefined);
          if (a instanceof Error) throw a;
          return a;
        }) as typeof fetch,
      };
    },
    close: async () => undefined,
  });
  return { calls, opened, transport, setReady: (f: (tenant: string) => Promise<void>) => (ready = f) };
}

/** An answer that never comes: it ends when the request is stopped. */
const never = (_id: string, _nth: number, signal: AbortSignal | undefined): Promise<Response> => new Promise((_, fail) => signal?.addEventListener("abort", () => fail(new Error("stopped"))));

const ids = (calls: Call[]): string[] => calls.map((c) => c.headers[NOTIFICATION_HEADER]!);
const bodies = (calls: Call[]): Notification[] => calls.map((c) => JSON.parse(c.body) as Notification);

/** The channel's cursor for the run, with what waits for its next attempt. */
async function cursorRow(db: Db, channel: string, run: string): Promise<{ seq: number; pending: number | null; attempts: number; retry_at: number | null } | null> {
  const [c] = await db.query<Row>("select seq, pending, attempts, retry_at from notify_cursors where channel = $1 and run_id = $2", [channel, run]);
  if (!c) return null;
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return { seq: Number(c["seq"]), pending: n(c["pending"]), attempts: Number(c["attempts"]), retry_at: n(c["retry_at"]) };
}

/** A pass of the pump over the world's database, by the world's clock. */
const pass = (w: NWorld, c: NotificationsConfig, o: Partial<NotifyOptions> = {}) => notifyPass(w.db, { config: c, now: () => w.clock.now(), ...o });

const lastSeq = async (w: NWorld, run: string): Promise<number> => (await w.rt.journal.events(run)).at(-1)!.seq;

// ── the configuration ───────────────────────────────────────────────────

describe("the notifications configuration", () => {
  const ok = { channels: { acct: { webhook: { url: HOOK, credential: "acme_hook", header: "authorization", template: "Bearer {secret}", format: "mandate" } }, local: { file: ".mandate/notifications.jsonl" } }, roles: { accountant: { channels: ["acct", "local"], outcomes: false } }, link: "https://mandate.acme.example/runs/{run}" };

  /** `mandate.runtime.json` with `notifications`, and with or without an egress proxy, read as every command reads it. */
  function read(notifications: unknown, egress = true) {
    const d = dir();
    const file = join(d, "mandate.runtime.json");
    writeFileSync(file, JSON.stringify({ database: "pglite:db", ...(egress ? { egress: { admin: "egress.sock" } } : {}), notifications }));
    return { file, d, read: () => readConfig(file) };
  }

  it("reads the spec's example: a webhook through the proxy, a file relative to the configuration, the roles and the link", () => {
    const { d, read: r } = read(ok);
    expect(r().notifications).toEqual({
      channels: { acct: { webhook: { url: HOOK, host: "hooks.acme.example", credential: "acme_hook", header: "authorization", template: "Bearer {secret}", format: "mandate" } }, local: { file: join(d, ".mandate/notifications.jsonl") } },
      roles: { accountant: { channels: ["acct", "local"], outcomes: false } },
      link: "https://mandate.acme.example/runs/{run}",
    });
    // A webhook's header and template default to a connector's; its format to the notification as JSON.
    expect(config({ channels: { h: { webhook: { url: HOOK, credential: "c" } } } }).channels["h"]).toEqual({ webhook: { url: HOOK, host: "hooks.acme.example", credential: "c", header: "authorization", template: "Bearer {secret}", format: "mandate" } });
    expect(config({}).roles).toEqual({});
    // Placeholders after the host: in the path, the query or the fragment.
    // A link with no placeholder, with no path even, is a link.
    for (const link of ["https://m.example/{run}", "https://m.example/r?run={run}&role={role}", "http://localhost:8080/runs/{run}#{command}", "https://m.example?r={run}", "https://m.example", "https://m.example/inbox"]) expect(config({ link }).link).toBe(link);
    expect(linkOf("https://m.example", { run: "r", role: null, command: null })).toBe("https://m.example");
  });

  const hook = (w: Record<string, unknown>): unknown => ({ ...ok, channels: { ...ok.channels, acct: { webhook: { ...ok.channels.acct.webhook, ...w } } } });
  const without = (k: string): unknown => {
    const { [k]: _gone, ...rest } = ok.channels.acct.webhook as Record<string, unknown>;
    return { ...ok, channels: { ...ok.channels, acct: { webhook: rest } } };
  };
  const refused: Array<[string, unknown, RegExp, boolean?]> = [
    ["notifications that are not an object", ["acct"], /"notifications" is \{/],
    ["an unknown member: there is no body template", { ...ok, template: "{{run}}" }, /unknown field notifications\.template/],
    ["channels that are not an object", { ...ok, channels: [] }, /notifications\.channels maps/],
    ["a channel's name that is not a name", { ...ok, channels: { ...ok.channels, "a b": { file: "x" } } }, /a channel's name is letters/],
    ["a channel that is not an object", { ...ok, channels: { ...ok.channels, acct: "https://x" } }, /notifications\.channels\.acct is \{/],
    ["a channel with no adapter", { ...ok, channels: { ...ok.channels, acct: {} } }, /has no adapter/],
    ["a channel with two adapters", { ...ok, channels: { ...ok.channels, acct: { webhook: ok.channels.acct.webhook, file: "x.jsonl" } } }, /has two adapters/],
    ["an adapter that does not exist", { ...ok, channels: { ...ok.channels, acct: { email: "acct@acme.example" } } }, /email is no adapter/],
    ["a webhook that is not an object", { ...ok, channels: { ...ok.channels, acct: { webhook: HOOK } } }, /webhook is \{/],
    ["a webhook with a body of its own", hook({ body: "{\"run\": \"{run}\"}" }), /unknown field .*webhook\.body: a webhook's body is fixed/],
    ["a webhook URL that is not https", hook({ url: "http://hooks.acme.example/in" }), /https:\/\/ URL/],
    ["a webhook URL in upper case", hook({ url: "HTTPS://hooks.acme.example/in" }), /https:\/\/ URL/],
    ["a webhook URL with no scheme", hook({ url: "hooks.acme.example/in" }), /https:\/\/ URL/],
    ["a webhook URL with a port", hook({ url: "https://hooks.acme.example:8443/in" }), /names no port/],
    ["a webhook URL with a user", hook({ url: "https://ann@hooks.acme.example/in" }), /no user or password/],
    ["a webhook URL with a query", hook({ url: "https://hooks.acme.example/in?key=x" }), /no query or fragment/],
    ["a webhook URL with a fragment", hook({ url: "https://hooks.acme.example/in#x" }), /no query or fragment/],
    ["a webhook URL whose host a parser would fold", hook({ url: "https://hooks%2eacme.example/in" }), /as written/],
    ["a webhook URL with an IPv6 host", hook({ url: "https://[::1]/in" }), /as written|no port/],
    ["a webhook URL that is not text", hook({ url: 443 }), /https:\/\/ URL/],
    ["a webhook URL longer than 2048 characters", hook({ url: `https://hooks.acme.example/${"a".repeat(2048)}` }), /at most 2048 characters/],
    ["a webhook with no credential's name", without("credential"), /credential is required/],
    ["a credential's name that is not a name", hook({ credential: "acme hook" }), /credential is a credential's name/],
    ["a header without a template", without("template"), /together, or neither/],
    ["a header in upper case", hook({ header: "Authorization" }), /header name in lower case/],
    ["a header the proxy sets", hook({ header: "host" }), /header name in lower case that neither/],
    ["the notification's own header", hook({ header: NOTIFICATION_HEADER }), /header name in lower case that neither/],
    ["a template without {secret}", hook({ template: "Bearer" }), /exactly once/],
    ["a template with {secret} twice", hook({ template: "{secret}{secret}" }), /exactly once/],
    ["a format that is neither mandate nor text", hook({ format: "xml" }), /format is "mandate"/],
    ["a webhook without an egress proxy", ok, /egress\.admin names none/, false],
    ["a file that is no path", { ...ok, channels: { ...ok.channels, local: { file: "" } } }, /file is the path/],
    ["two channels that write one file", { ...ok, channels: { ...ok.channels, other: { file: ".mandate/notifications.jsonl" } } }, /is the file of channel local too/],
    ["roles that are not an object", { ...ok, roles: ["accountant"] }, /notifications\.roles maps/],
    ["a role's name that is not a name", { ...ok, roles: { "1st": { channels: ["acct"] } } }, /a role's name is letters/],
    ["a role that is not an object", { ...ok, roles: { accountant: ["acct"] } }, /roles\.accountant is \{/],
    ["an unknown member of a role", { ...ok, roles: { accountant: { channels: ["acct"], body: "x" } } }, /unknown field notifications\.roles\.accountant\.body/],
    ["a role with no channel", { ...ok, roles: { accountant: { channels: [] } } }, /at least one channel/],
    ["a role naming a channel twice", { ...ok, roles: { accountant: { channels: ["acct", "acct"] } } }, /names a channel twice/],
    ["a role naming an unknown channel", { ...ok, roles: { accountant: { channels: ["acct", "slack"] } } }, /names "slack", which notifications\.channels does not define/],
    ["outcomes that are not true or false", { ...ok, roles: { accountant: { channels: ["acct"], outcomes: "yes" } } }, /outcomes is true or false/],
    ["a link that is no URL", { ...ok, link: "runs/{run}" }, /link is an absolute http/],
    ["a link longer than 2048 characters", { ...ok, link: `https://m.example/${"a".repeat(2048)}/{run}` }, /at most 2048 characters/],
    ["a link with another placeholder", { ...ok, link: "https://mandate.acme.example/{tenant}/{run}" }, /holds "\{tenant\}"/],
    ["a link with a step's value as a placeholder", { ...ok, link: "https://mandate.acme.example/{run}/{result}" }, /holds "\{result\}"/],
    ["a link with a brace left open", { ...ok, link: "https://mandate.acme.example/{run" }, /holds "\{run"/],
    ["a link with a brace that closes nothing", { ...ok, link: "https://mandate.acme.example/run}" }, /holds "\}"/],
    ["a link with a placeholder in its host", { ...ok, link: "https://{run}.acme.example/x" }, /placeholders after the host/],
    ["a link with a placeholder at the end of its host", { ...ok, link: "https://mandate.acme.example{run}" }, /placeholders after the host/],
    ["a link with a placeholder in its port", { ...ok, link: "https://mandate.acme.example:{run}/x" }, /placeholders after the host/],
  ];
  for (const [what, raw, why, egress] of refused) {
    it(`refuses ${what}: bad_notification_channel`, () => {
      const { read: r } = read(raw, egress ?? true);
      let thrown: unknown;
      try {
        r();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Violation);
      expect((thrown as Violation).code).toBe("bad_notification_channel");
      expect((thrown as Violation).message).toMatch(why);
    });
  }
});

// ── what a notification may carry ──────────────────────────────────────

describe("what a notification may carry", () => {
  it("carries ids of a narrow form as they are, and any other as a digest", () => {
    for (const id of ["0b9b6e1c-7c5e-4e2a-9b1d-1a2b3c4d5e6f", "default", "acme.finance", "run-12", "tenant_7:eu@a#b~c"]) expect(carried(id, CARRIED.id)).toBe(id);
    for (const id of ["two words", "<!channel>", "ünïcode", "a/b", "", "x".repeat(129), "line\nbreak", `${M}?q=1`]) {
      const shown = carried(id, CARRIED.id);
      expect(shown).toMatch(/^digest:[0-9a-f]{32}$/);
      expect(shown).toBe(carried(id, CARRIED.id));
    }
    expect(carried("Ship", CARRIED.workflow)).toBe("Ship");
    expect(carried("Ship it", CARRIED.workflow)).toMatch(/^digest:/);
    expect(carried(`sha256:${"a".repeat(64)}`, CARRIED.package)).toBe(`sha256:${"a".repeat(64)}`);
    expect(carried("sha256:short", CARRIED.package)).toMatch(/^digest:/);
  });

  it("carries a command as its IR path, and one inside a lead's sub-program as the sub-program's command and a digest of the rest", () => {
    const plan = "/defs/W/body/0/value/program/1";
    expect(commandShown("/defs/Ship/body/0/value", [plan])).toBe("/defs/Ship/body/0/value");
    expect(commandShown("/defs/W/body/0/branches/a/contract/accept/first/call", [])).toBe("/defs/W/body/0/branches/a/contract/accept/first/call");
    expect(commandShown("/defs/W/on/budget_exceeded@0", [])).toBe("/defs/W/on/budget_exceeded@0");
    const a = commandShown(`${plan}/defs/${M}Fix/body/0/value`, [plan]);
    const b = commandShown(`${plan}/defs/${M}Fix/body/1/value`, [plan]);
    expect(a).toMatch(new RegExp(`^${plan.replaceAll("/", "\\/")}\\/digest:[0-9a-f]{32}$`));
    expect(a).not.toBe(b);
    expect(a).not.toContain(M);
    // A command of no form a path has is a digest whole.
    expect(commandShown("not a path", [])).toMatch(/^digest:/);
    expect(commandShown(null, [])).toBeNull();
  });

  it("carries a sub-program's command whose shown form does not fit as the digest of its own id, which the database resolves", async () => {
    const own = (c: string): string => `digest:${createHash("sha256").update(c, "utf8").digest("hex").slice(0, 32)}`;
    const long = `/defs/W/body/0/value/${"x".repeat(250)}/program/1`;
    const inLong = `${long}/defs/${M}Fix/body/0/value`;
    const odd = "/defs/W/body/0/value with space/program/1";
    const inOdd = `${odd}/defs/Fix/body/0/value`;
    expect(commandShown(inLong, [long])).toBe(own(inLong));
    expect(commandShown(inOdd, [odd])).toBe(own(inOdd));
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "c1" });
    await waitingRow(w, "c1", inLong, "input");
    const hex = commandShown(inLong, [long])!.slice("digest:".length);
    expect(await w.db.query("select command_id from commands where run_id = 'c1' and left(encode(sha256(convert_to(command_id, 'UTF8')), 'hex'), 32) = $1", [hex])).toEqual([{ command_id: inLong }]);
  });

  it("makes a link from the three ids only, each URL-encoded, an absent one empty; one that would leave the template's origin is none", () => {
    expect(linkOf("https://m.example/runs/{run}?role={role}&at={command}", { run: "r 1/2", role: "accountant", command: "/defs/W/body/0" })).toBe("https://m.example/runs/r%201%2F2?role=accountant&at=%2Fdefs%2FW%2Fbody%2F0");
    expect(linkOf("https://m.example/{run}/{role}/{command}", { run: "r", role: null, command: null })).toBe("https://m.example/r//");
    expect(linkOf(null, { run: "r", role: null, command: null })).toBeNull();
    // A template the reader would refuse, given by hand: the run's id would move the link to another host.
    expect(linkOf("https://{run}/x", { run: "evil.example", role: null, command: null })).toBeNull();
    expect(linkOf("https://m.example{run}", { run: ".evil.example", role: null, command: null })).toBeNull();
  });

  it("puts a run's id and a tenant of no safe form in no member, the sentence and the link: only their digest, the id made of the true ones", async () => {
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    const run = `two words <!channel> ${M}`;
    const tenant = `${M} ${"t".repeat(300)}`;
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: run, tenant });
    const way = fakeWay();
    const c = config({ ...HOOK_CONFIG, channels: { hook: { webhook: { url: HOOK, credential: "acme_hook", format: "text" } } }, link: "https://m.acme.example/runs/{run}" });
    expect(await pass(w, c, { transport: way.transport })).toMatchObject({ sent: 1 });
    const [sent] = way.calls;
    expect(sent!.body).not.toContain(M);
    expect(sent!.body).not.toContain("<!channel>");
    expect(JSON.parse(sent!.body)).toEqual({ text: `Mandate: run ${carried(run, CARRIED.id)} of Ship (tenant ${carried(tenant, CARRIED.id)}) waits for platform_lead at /defs/Ship/body/0/value (wait_opened, event ${(await w.rt.journal.events(run)).find((e) => e.type === "wait_opened")!.seq}). https://m.acme.example/runs/${carried(run, CARRIED.id).replace(":", "%3A")}` });
    // The id is the true run's, so a repeat is known by it.
    const seq = (await w.rt.journal.events(run)).find((e) => e.type === "wait_opened")!.seq;
    expect(sent!.headers[NOTIFICATION_HEADER]).toBe(digest("operation", { format: NOTIFICATION_FORMAT, channel: "hook", run, seq }));
    // Every member is bounded.
    const json = fakeWay();
    await w.db.query("update notify_cursors set seq = 0");
    await pass(w, config(HOOK_CONFIG), { transport: json.transport });
    const n = bodies(json.calls)[0]!;
    expect([n.run, n.tenant]).toEqual([carried(run, CARRIED.id), carried(tenant, CARRIED.id)]);
    for (const v of Object.values(n)) if (typeof v === "string") expect(v.length).toBeLessThanOrEqual(300);
    // The operator finds the run and the tenant a digest stands for in the database (notify.ts `carried`).
    const hexOf = (d: string): string => d.slice("digest:".length);
    expect(await w.db.query("select run_id from runs where left(encode(sha256(convert_to(run_id, 'UTF8')), 'hex'), 32) = $1", [hexOf(n.run)])).toEqual([{ run_id: run }]);
    expect(await w.db.query("select distinct tenant from runs where left(encode(sha256(convert_to(tenant, 'UTF8')), 'hex'), 32) = $1", [hexOf(n.tenant)])).toEqual([{ tenant }]);
  });

  it("replaces a value that would pass for another's digest", async () => {
    const other = carried("two words", CARRIED.id);
    expect(other).toMatch(/^digest:[0-9a-f]{32}$/);
    // A run started with that very id is not carried as written: it reads as no other run's digest.
    const forged = carried(other, CARRIED.id);
    expect(forged).toMatch(/^digest:[0-9a-f]{32}$/);
    expect(forged).not.toBe(other);
    expect(carried("digest:x", CARRIED.id)).not.toBe("digest:x");
    // End to end: a run whose id is a digest's form.
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: other });
    const way = fakeWay();
    await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    expect(bodies(way.calls).map((x) => x.run)).toEqual([forged]);
  });

  it("finds the command a sub-program's digest stands for in the database", async () => {
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "c1" });
    const command = String((await w.db.query<{ command_id: string }>("select command_id from commands where run_id = 'c1' and state = 'waiting'"))[0]!.command_id);
    // As if the run's first wait stood inside a sub-program admitted at /defs/Ship: its command is carried as that and a digest.
    const prefix = "/defs/Ship";
    const shown = commandShown(command, [prefix])!;
    const hex = shown.slice(`${prefix}/digest:`.length);
    expect(
      await w.db.query("select command_id from commands where run_id = 'c1' and command_id like $1 and left(encode(sha256(convert_to(substr(command_id, $2), 'UTF8')), 'hex'), 32) = $3", [`${prefix}/%`, prefix.length + 2, hex]),
    ).toEqual([{ command_id: command }]);
  });
});

// ── the pump ────────────────────────────────────────────────────────────

describe("the pump", () => {
  it("sends each event to the roles it is addressed to, in order, with the fixed payload; the cursor ends at the run's last event", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    const c = config(HOOK_CONFIG);
    expect(await pass(w, c, { transport: way.transport })).toEqual({ sent: 3, failed: 0, dead: 0, pending: 0, failures: [] });
    const sent = bodies(way.calls);
    expect(sent.map((n) => `${n.event} ${n.role}`)).toEqual(OWNED_TOLD);
    const events = await w.rt.journal.events("o1");
    const run = await w.rt.getRun("o1");
    for (const n of sent) {
      expect(Object.keys(n)).toEqual([...NOTIFICATION_MEMBERS]);
      expect(n).toMatchObject({ format: NOTIFICATION_FORMAT, tenant: "default", run: "o1", workflow: "Ship", package: w.pkg.hash, link: null });
      expect(n.id).toBe(digest("operation", { format: NOTIFICATION_FORMAT, channel: "hook", run: "o1", seq: n.seq }));
      expect(events.find((e) => e.seq === n.seq)?.type).toBe(n.event);
      expect(n.as_of).toEqual({ revision: run.revision, event: events.at(-1)!.seq });
    }
    expect(sent.map((n) => [n.kind, n.class])).toEqual([
      ["decision", "S0"],
      ["outcome", "S1"],
      ["outcome", "S1"],
    ]);
    expect(sent[0]!.command).toBe((events.find((e) => e.seq === sent[0]!.seq)!.data as Obj)["command"]);
    expect(sent[2]!.command).toBeNull();
    for (const call of way.calls) {
      expect(call.url).toBe(HOOK);
      expect(call.headers["content-type"]).toBe("application/json");
    }
    expect(ids(way.calls)).toEqual(sent.map((n) => n.id));
    expect(await cursorRow(w.db, "hook", "o1")).toEqual({ seq: events.at(-1)!.seq, pending: null, attempts: 0, retry_at: null });
    // A second pass has nothing to send.
    expect(await pass(w, c, { transport: way.transport })).toEqual({ sent: 0, failed: 0, dead: 0, pending: 0, failures: [] });
    expect(way.calls).toHaveLength(3);
  });

  it("a text webhook sends {text: a fixed sentence} made of the same members", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    await pass(w, config({ ...HOOK_CONFIG, channels: { hook: { webhook: { url: HOOK, credential: "acme_hook", format: "text" } } }, link: "https://m.acme.example/runs/{run}" }), { transport: way.transport });
    const sent = way.calls.map((c) => JSON.parse(c.body) as Obj);
    expect(sent.map((b) => Object.keys(b))).toEqual([["text"], ["text"], ["text"]]);
    expect(String(sent[0]!["text"])).toMatch(/^Mandate: run o1 of Ship \(tenant default\) waits for platform_lead at \/defs\/Ship\/body\/0\/value \(wait_opened, event \d+\)\. https:\/\/m\.acme\.example\/runs\/o1$/);
    expect(String(sent[2]!["text"])).toMatch(/^Mandate: run o1 of Ship \(tenant default\): run_attention_required \(event \d+\)\. https:\/\/m\.acme\.example\/runs\/o1$/);
    const n: Notification = { format: NOTIFICATION_FORMAT, id: "sha256:x", kind: "decision", event: "review_escalated", class: "S0", tenant: "t", run: "r", workflow: "W", package: "p", seq: 9, at: 1, role: "finance_lead", command: "/c", deadline: Date.UTC(2027, 0, 2), as_of: { revision: 3, event: 9 }, link: null };
    expect(sentence(n)).toBe("Mandate: run r of W (tenant t) waits for finance_lead at /c, deadline 2027-01-02T00:00:00.000Z (review_escalated, event 9).");
  });

  it("makes one attempt per pass: a failure keeps the cursor before it and the next attempt for later, by the runtime's clock, in the run's order", async () => {
    const w = await ownedRun();
    let first: string | undefined;
    const way = fakeWay((id, nth) => {
      first ??= id;
      return id === first && nth <= 2 ? new Response("busy", { status: 503 }) : new Response("ok");
    });
    const c = config(HOOK_CONFIG);
    expect(await pass(w, c, { transport: way.transport })).toEqual({ sent: 0, failed: 1, dead: 0, pending: 1, failures: [] });
    const seq = bodies(way.calls)[0]!.seq;
    expect(await cursorRow(w.db, "hook", "o1")).toEqual({ seq: seq - 1, pending: seq, attempts: 1, retry_at: w.clock.now() + 1000 });
    // Before its time the next pass asks nothing of the receiver, and says the notification waits.
    w.clock.advance(999);
    expect(await pass(w, c, { transport: way.transport })).toEqual({ sent: 0, failed: 0, dead: 0, pending: 1, failures: [] });
    expect(way.calls).toHaveLength(1);
    w.clock.advance(1);
    expect(await pass(w, c, { transport: way.transport })).toEqual({ sent: 0, failed: 1, dead: 0, pending: 1, failures: [] });
    expect(await cursorRow(w.db, "hook", "o1")).toEqual({ seq: seq - 1, pending: seq, attempts: 2, retry_at: w.clock.now() + 2000 });
    w.clock.advance(2000);
    expect(await pass(w, c, { transport: way.transport })).toEqual({ sent: 3, failed: 0, dead: 0, pending: 0, failures: [] });
    expect(ids(way.calls).slice(0, 3)).toEqual([first, first, first]);
    expect(bodies(way.calls).map((n) => n.seq)).toEqual([seq, seq, seq, ...bodies(way.calls).slice(3).map((n) => n.seq)]);
    expect(bodies(way.calls).slice(3).every((n) => n.seq > seq)).toBe(true);
    // The same notification, byte for byte, at every attempt.
    expect(new Set(way.calls.slice(0, 3).map((x) => x.body)).size).toBe(1);
    expect(await cursorRow(w.db, "hook", "o1")).toEqual({ seq: await lastSeq(w, "o1"), pending: null, attempts: 0, retry_at: null });
  });

  it("asks a receiver that failed nothing more in the pass: another run's notification waits for the next one", async () => {
    const w = await ownedRun("o1");
    await ownedRun("o2", undefined, w);
    const way = fakeWay(() => new Response("busy", { status: 503 }));
    expect(await pass(w, config(HOOK_CONFIG), { transport: way.transport })).toEqual({ sent: 0, failed: 1, dead: 0, pending: 1, failures: [] });
    expect(way.calls).toHaveLength(1);
    // The second run was not come to: it has no cursor yet, and will be told from its first event.
    expect(await cursorRow(w.db, "hook", "o2")).toBeNull();
  });

  it("gives a notification up at its sixth failed attempt, 1, 2, 4, 8 and 16 s apart: notify_dead, and the cursor moves past it", async () => {
    const w = await ownedRun();
    let first: string | undefined;
    const way = fakeWay((id) => {
      first ??= id;
      return id === first ? new Response("no", { status: 500 }) : new Response("ok");
    });
    const c = config(HOOK_CONFIG);
    const dead: unknown[] = [];
    const waits: number[] = [];
    for (let attempt = 1; attempt < 6; attempt++) {
      expect(await pass(w, c, { transport: way.transport }), `attempt ${attempt}`).toEqual({ sent: 0, failed: 1, dead: 0, pending: 1, failures: [] });
      const row = (await cursorRow(w.db, "hook", "o1"))!;
      expect(row.attempts).toBe(attempt);
      waits.push(row.retry_at! - w.clock.now());
      w.clock.advance(row.retry_at! - w.clock.now());
    }
    expect(waits).toEqual([1, 2, 3, 4, 5].map(backoffMs));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(await pass(w, c, { transport: way.transport, onDead: (d) => dead.push(d) })).toEqual({ sent: 2, failed: 0, dead: 1, pending: 0, failures: [] });
    expect(ids(way.calls).filter((i) => i === first)).toHaveLength(6);
    const seq = bodies(way.calls)[0]!.seq;
    const rows = await w.db.query<Obj>("select channel, run_id, seq, attempts, reason from notify_dead");
    expect(rows.map((x) => ({ ...x, seq: Number(x["seq"]), attempts: Number(x["attempts"]) }))).toEqual([{ channel: "hook", run_id: "o1", seq, attempts: 6, reason: "hooks.acme.example answered 500" }]);
    expect(dead).toEqual([{ channel: "hook", run: "o1", seq, id: first, attempts: 6, reason: "hooks.acme.example answered 500" }]);
    // A notification given up is not tried again.
    expect(await pass(w, c, { transport: way.transport })).toEqual({ sent: 0, failed: 0, dead: 0, pending: 0, failures: [] });
    expect(await count(w, "select count(*) as n from notify_dead")).toBe(1);
  });

  it("gives up at once what trying again would not change, a 4xx, and goes on with the run's next notifications", async () => {
    const w = await ownedRun();
    const way = fakeWay(() => new Response("gone", { status: 404 }));
    expect(await pass(w, config(HOOK_CONFIG), { transport: way.transport })).toEqual({ sent: 0, failed: 0, dead: 3, pending: 0, failures: [] });
    expect((await w.db.query<{ attempts: unknown; reason: string }>("select attempts, reason from notify_dead order by seq")).map((x) => [Number(x.attempts), x.reason])).toEqual(Array(3).fill([1, "hooks.acme.example answered 404"]));
  });

  it("tries again after a 408, a 429 and no answer in time", async () => {
    const w = await ownedRun();
    const answers: Answer[] = [() => new Response("", { status: 408 }), () => new Response("", { status: 429 }), never, () => new Response("ok")];
    let i = 0;
    const way = fakeWay((id, nth, signal) => answers[Math.min(i++, answers.length - 1)]!(id, nth, signal));
    const c = config(HOOK_CONFIG);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await pass(w, c, { transport: way.transport, timeoutMs: 50 }), `attempt ${attempt}`).toMatchObject({ sent: 0, failed: 1, pending: 1 });
      expect((await cursorRow(w.db, "hook", "o1"))!.attempts).toBe(attempt);
      w.clock.advance(backoffMs(attempt));
    }
    expect(await pass(w, c, { transport: way.transport })).toMatchObject({ sent: 3, failed: 0, pending: 0 });
    // A timeout given up says so: six times no answer.
    const slow = await ownedRun("o2", undefined, w);
    const quiet = fakeWay(never);
    for (let attempt = 1; attempt <= 6; attempt++) {
      await pass(slow, c, { transport: quiet.transport, timeoutMs: 20 });
      w.clock.advance(backoffMs(attempt));
    }
    expect(await w.db.query("select attempts, reason from notify_dead where run_id = 'o2'")).toEqual([{ attempts: 6, reason: "hooks.acme.example gave no answer within 20 ms" }]);
  });

  it("stops at once when the pass is stopped, a request in flight among it: no attempt is counted, and the next pass sends it", async () => {
    const w = await ownedRun();
    const stop = new AbortController();
    const way = fakeWay(never);
    const going = pass(w, config(HOOK_CONFIG), { transport: way.transport, signal: stop.signal });
    await until(() => way.calls.length === 1, "the first request");
    stop.abort();
    expect(await going).toEqual({ sent: 0, failed: 0, dead: 0, pending: 0, failures: [] });
    const seq = bodies(way.calls)[0]!.seq;
    expect(await cursorRow(w.db, "hook", "o1")).toEqual({ seq: seq - 1, pending: null, attempts: 0, retry_at: null });
    const again = fakeWay();
    expect(await pass(w, config(HOOK_CONFIG), { transport: again.transport })).toMatchObject({ sent: 3 });
    expect(ids(again.calls)[0]).toBe(ids(way.calls)[0]);
  });

  it("counts no attempt while the way out is not there: the channel waits, its cursor where it was", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    way.setReady(async () => {
      throw new NotifyUnavailable("the egress proxy at made-up.sock: it does not answer");
    });
    const failures: string[] = [];
    expect(await pass(w, config(HOOK_CONFIG), { transport: way.transport, onFailure: (c, m) => failures.push(`${c}: ${m}`) })).toEqual({
      sent: 0,
      failed: 0,
      dead: 0,
      pending: 0,
      failures: [{ channel: "hook", message: "the egress proxy at made-up.sock: it does not answer" }],
    });
    expect(failures).toEqual(["hook: the egress proxy at made-up.sock: it does not answer"]);
    expect(way.calls).toEqual([]);
    const firstSeq = (await w.rt.journal.events("o1")).find((e) => e.type === "wait_opened")!.seq;
    expect(await cursorRow(w.db, "hook", "o1")).toEqual({ seq: firstSeq - 1, pending: null, attempts: 0, retry_at: null });
    expect(await count(w, "select count(*) as n from notify_dead")).toBe(0);
    way.setReady(async () => undefined);
    expect(await pass(w, config(HOOK_CONFIG), { transport: way.transport })).toMatchObject({ sent: 3 });
  });

  it("serves several tenants: one whose way out is not there waits, and the other's notifications go", async () => {
    const w = await ownedRun("a1", "acme");
    await ownedRun("b1", "beta", w);
    const way = fakeWay();
    way.setReady(async (tenant) => {
      if (tenant === "acme") throw new NotifyUnavailable("the egress proxy refused acme's session");
    });
    const r = await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    expect(r).toMatchObject({ sent: 3, failures: [{ channel: "hook", message: "the egress proxy refused acme's session" }] });
    expect(new Set(way.calls.map((c) => c.tenant))).toEqual(new Set(["beta"]));
    expect(bodies(way.calls).every((n) => n.tenant === "beta" && n.run === "b1")).toBe(true);
    expect((await cursorRow(w.db, "hook", "a1"))!.seq).toBeLessThan(await lastSeq(w, "a1"));
    expect((await cursorRow(w.db, "hook", "b1"))!.seq).toBe(await lastSeq(w, "b1"));
  });

  it("tries again a file that cannot be written, and gives it up at the sixth attempt", async () => {
    const d = dir();
    const path = join(d, "a-directory.jsonl");
    mkdirSync(path);
    const c = config({ channels: { local: { file: path } }, roles: { platform_lead: { channels: ["local"] } } });
    expect(c.channels["local"]).toEqual({ file: path });
    const w = await ownedRun("o1", undefined, undefined, [c]);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await pass(w, c), `attempt ${attempt}`).toMatchObject({ sent: 0, failed: 1, pending: 1 });
      w.clock.advance(backoffMs(attempt));
    }
    expect(await pass(w, c)).toMatchObject({ dead: 1 });
    const [row] = await w.db.query<{ reason: string }>("select reason from notify_dead");
    expect(row!.reason).toMatch(/^could not append to .*a-directory\.jsonl \(E[A-Z]+\)$/);
  });

  it("delivers at least once: a pump that stopped after a delivery and before its cursor sends it again, with the same id", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    const firstSeq = (await w.rt.journal.events("o1")).find((e) => e.type === "wait_opened")!.seq;
    let fail = true;
    const crashing: Db = {
      query: (async (sql: string, params?: unknown[]) => {
        if (fail && sql.includes("update notify_cursors set seq") && params?.[2] === firstSeq) {
          fail = false;
          throw new Error("the process died");
        }
        return w.db.query(sql, params);
      }) as Db["query"],
      tx: (fn) => w.db.tx(fn),
      close: () => w.db.close(),
    };
    await expect(notifyPass(crashing, { config: config(HOOK_CONFIG), transport: way.transport, now: () => w.clock.now() })).rejects.toThrow("the process died");
    expect(way.calls).toHaveLength(1);
    await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    const got = ids(way.calls);
    expect(got).toHaveLength(4);
    expect(got[1]).toBe(got[0]);
    expect(way.calls[1]!.body).toBe(way.calls[0]!.body);
    expect(new Set(got).size).toBe(3);
  });

  it("two pumps racing deliver each notification at least once, the first of each in order, and the cursor ends at the end", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    const c = config(HOOK_CONFIG);
    const [a, b] = await Promise.all([pass(w, c, { transport: way.transport }), pass(w, c, { transport: way.transport })]);
    expect(a.sent + b.sent).toBeGreaterThanOrEqual(3);
    expect(a.dead + b.dead).toBe(0);
    const got = bodies(way.calls);
    const firsts = got.filter((n, i) => got.findIndex((m) => m.id === n.id) === i);
    expect(firsts.map((n) => `${n.event} ${n.role}`)).toEqual(OWNED_TOLD);
    for (const n of got) expect({ ...n, as_of: null }).toEqual({ ...firsts.find((f) => f.id === n.id)!, as_of: null });
    expect((await cursorRow(w.db, "hook", "o1"))!.seq).toBe(await lastSeq(w, "o1"));
  });

  it("two pumps racing on a failing receiver spend six attempts in all, and report one dead letter", async () => {
    const w = await ownedRun();
    let first: string | undefined;
    const way = fakeWay((id) => {
      first ??= id;
      return id === first ? new Response("no", { status: 500 }) : new Response("ok");
    });
    const c = config(HOOK_CONFIG);
    const dead: unknown[] = [];
    for (let round = 0; round < 12 && !dead.length; round++) {
      await Promise.all([pass(w, c, { transport: way.transport, onDead: (d) => dead.push(d) }), pass(w, c, { transport: way.transport, onDead: (d) => dead.push(d) })]);
      const row = await cursorRow(w.db, "hook", "o1");
      if (row?.retry_at) w.clock.advance(Math.max(0, row.retry_at - w.clock.now()));
    }
    expect(ids(way.calls).filter((i) => i === first)).toHaveLength(6);
    expect(dead).toHaveLength(1);
    expect(await count(w, "select count(*) as n from notify_dead")).toBe(1);
  });

  // These two run by the real clock: a send's deadline is a timer's, and the claim must outlast it in the same time.
  it("bounds the whole send by one deadline the claim outlasts: a slow way out and a second pump make one request and one attempt", async () => {
    const w = await ownedRun();
    let slow = true;
    const way = fakeWay(() => new Response("busy", { status: 503 }));
    way.setReady(async () => {
      // The first answer of the proxy takes longer than a request's limit and a second together.
      if (slow) {
        slow = false;
        await new Promise((r) => setTimeout(r, 1300));
      }
    });
    const real = { transport: way.transport, now: () => Date.now(), timeoutMs: 100 };
    const first = pass(w, config(HOOK_CONFIG), real);
    // A second pump comes once a claim held for the request's limit and a second alone would have run out.
    await new Promise((r) => setTimeout(r, 1200));
    const [a] = await Promise.all([first, pass(w, config(HOOK_CONFIG), real)]);
    expect(way.calls).toHaveLength(1);
    expect((await cursorRow(w.db, "hook", "o1"))!.attempts).toBe(1);
    // The first pump's send ended at its deadline, its way out not having answered: no attempt of its own.
    expect(a.failures).toEqual([{ channel: "hook", message: "the egress proxy did not say within 100 ms whether it can serve hooks.acme.example" }]);
  });

  it("ends a send whose way out never answers at the deadline, as the way out not being there: no attempt", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    way.setReady(() => new Promise<void>(() => undefined));
    const r = await pass(w, config(HOOK_CONFIG), { transport: way.transport, now: () => Date.now(), timeoutMs: 50 });
    expect(r).toMatchObject({ sent: 0, failed: 0, dead: 0, pending: 0, failures: [{ channel: "hook" }] });
    expect(way.calls).toEqual([]);
    expect(await cursorRow(w.db, "hook", "o1")).toMatchObject({ pending: null, attempts: 0, retry_at: null });
  });

  it("takes a next attempt that a clock stepped back would put far ahead as due", async () => {
    const w = await ownedRun();
    let n = 0;
    const way = fakeWay(() => (n++ === 0 ? new Response("busy", { status: 503 }) : new Response("ok")));
    const c = config(HOOK_CONFIG);
    expect(await pass(w, c, { transport: way.transport })).toMatchObject({ failed: 1, pending: 1 });
    // The host's clock steps back an hour: the next attempt, due in a second, would be an hour and a second away.
    w.clock.t -= 3_600_000;
    expect(await pass(w, c, { transport: way.transport })).toMatchObject({ sent: 3, pending: 0 });
  });

  it("asks the halt again before each send: a halt committed during a pass stops its sends for the tenant", async () => {
    const w = await ownedRun("h1");
    await ownedRun("h2", undefined, w);
    const way = fakeWay(async () => {
      // The operator halts the tenant while the first request is in flight.
      if (way.calls.length === 1) await w.rt.halt({ tenant: "default" }, { by: "ops" });
      return new Response("ok");
    });
    await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    expect(way.calls).toHaveLength(1);
    await w.rt.liftHalt({ tenant: "default" }, "ops");
    await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    // After the lift, the rest: each run's two outcomes and its run_cancelled; h2's question ended with its run.
    expect(bodies(way.calls).slice(1).map((n) => `${n.run} ${n.event}`)).toEqual([
      "h1 budget_exceeded",
      "h1 run_attention_required",
      "h1 run_cancelled",
      "h2 budget_exceeded",
      "h2 run_attention_required",
      "h2 run_cancelled",
    ]);
  });

  it("sends no event outside the S0 and S1 lists; asks_exhausted joins them once slice B3 gives it its class", () => {
    for (const [type, kind] of Object.entries(NOTIFIED)) {
      if (type === "asks_exhausted") expect(Object.hasOwn(EVENT_CLASSES, type), "B3 adds asks_exhausted to EVENT_CLASSES as S1; then this line goes").toBe(false);
      else expect(EVENT_CLASSES[type], type).toBe(kind === "decision" ? "S0" : "S1");
    }
    expect(Object.keys(NOTIFIED).sort()).toEqual(["amendment_requested", "asks_exhausted", "budget_exceeded", "review_escalated", "review_requested", "run_attention_required", "run_cancelled", "run_failed", "run_succeeded", "wait_opened"]);
  });

  it("pairs an amendment's request with the wait after it, also across a page of the pump's reads", async () => {
    for (const batch of [500, 2]) {
      const w = await nworld(OWNED, "0.7");
      await approveCard(w);
      await meet(w, config(HOOK_CONFIG));
      await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "am" });
      // An amendment a lead asked for, as the journal holds one: the request, then its wait, in one transaction.
      const command = "/defs/Ship/body/0/value/step/0/tool/0/amendment";
      const at = await w.db.tx(async (tx) => {
        await w.rt.journal.lock(tx, "am");
        const asked = await w.rt.journal.event(tx, "am", "amendment_requested", { plan: "/defs/Ship/body/0/value", step: "s", lead: "Lead.finish", from: w.pkg.hash, package: w.pkg.hash, diff: "sha256:d" });
        await w.rt.journal.event(tx, "am", "wait_opened", { command, kind: "amendment", request: { role: "platform_lead", reason: `${M} a lead's words`, deadline: 1234 } });
        return asked.seq;
      });
      await waitingRow(w, "am", command, "amendment");
      // A page that ends at the amendment's request, its wait on the next page: [at - 1, at], then [at + 1]. (The
      // cursor is placed by hand: this is about the pages, not about where a cursor starts.)
      if (batch === 2) await w.db.query("insert into notify_cursors (channel, run_id, seq, at, start_seq) values ('hook', 'am', $1, 0, 0) on conflict (channel, run_id) do update set seq = excluded.seq", [at - 2]);
      const way = fakeWay();
      await pass(w, config(HOOK_CONFIG), { transport: way.transport, batch });
      const amendment = bodies(way.calls).find((n) => n.event === "amendment_requested");
      expect(amendment, `batch ${batch}`).toMatchObject({ seq: at, role: "platform_lead", command, deadline: 1234 });
      // Its wait_opened is not told again.
      expect(bodies(way.calls).filter((n) => n.seq === at + 1)).toEqual([]);
      expect(way.calls.map((c) => c.body).join("")).not.toContain(M);
    }
  });
});

// ── which runs, and when ────────────────────────────────────────────────

describe("which runs a pass tells, and when", () => {
  it("tells a channel that is new only of the waits still open of the runs already there, the latest question of each; its cursors start at their ends", async () => {
    // Before the channel exists: one run asked the platform lead, was answered, and now asks the reviewer; another ended.
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "late" });
    await answer(w, "late", w.who.pat, "because");
    await endedRun(w, "done");
    const way = fakeWay();
    expect(await pass(w, config(HOOK_CONFIG), { transport: way.transport })).toMatchObject({ sent: 1 });
    expect(bodies(way.calls).map((n) => `${n.run} ${n.event} ${n.role}`)).toEqual(["late wait_opened reviewer"]);
    expect((await cursorRow(w.db, "hook", "late"))!.seq).toBe(await lastSeq(w, "late"));
    expect((await cursorRow(w.db, "hook", "done"))!.seq).toBe(await lastSeq(w, "done"));
    expect(await w.db.query("select channel from notify_channels")).toEqual([{ channel: "hook" }]);
    // A role added to the channel later is told only of what comes after its cursors.
    const more = fakeWay();
    await pass(w, config({ ...HOOK_CONFIG, roles: { ...HOOK_CONFIG.roles, finance_lead: { channels: ["hook"], outcomes: true } } }), { transport: more.transport });
    expect(more.calls).toEqual([]);
    // A channel removed from the configuration and given again under its name goes on from its cursors: it is not met
    // again (the reviewer's wait is not told twice), and what came since is told.
    await pass(w, config({ channels: { other: { file: join(dir(), "other.jsonl") } }, roles: { reviewer: { channels: ["other"] } } }));
    await append(w, "late", "run_attention_required", { attention: { violation: "made_up" } });
    const back = fakeWay();
    await pass(w, config(HOOK_CONFIG), { transport: back.transport });
    expect(bodies(back.calls).map((n) => `${n.run} ${n.event}`)).toEqual(["late run_attention_required"]);
  });

  it("tells a new channel of a run that needs a person now, by its last run_attention_required", async () => {
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "stuck" });
    // The run stops for a person, as the runtime stops one: its state and the event, under its lock.
    await w.db.tx(async (tx) => {
      await w.rt.journal.lock(tx, "stuck");
      await w.rt.journal.setState(tx, "stuck", "attention_required", { attention: { violation: "made_up", message: `${M} details` } });
    });
    const way = fakeWay();
    await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    // Its question is still open, and it needs a person: both are told, in the run's order.
    expect(bodies(way.calls).map((n) => `${n.event} ${n.role}`)).toEqual(["wait_opened platform_lead", "run_attention_required platform_lead"]);
    expect(way.calls.map((c) => c.body).join("")).not.toContain(M);
    // A run that only needs a person, its waits closed, is told that alone.
    await w.db.query("update commands set state = 'failed' where run_id = 'stuck'");
    const fresh = fakeWay();
    await pass(w, config({ channels: { fresh: { webhook: { url: HOOK, credential: "acme_hook" } } }, roles: { platform_lead: { channels: ["fresh"] } } }), { transport: fresh.transport });
    expect(bodies(fresh.calls).map((n) => `${n.event} ${n.role}`)).toEqual(["run_attention_required platform_lead"]);
  });

  it("tells a run that began after the channel was in use from its first event, though it asked and ended between two passes", async () => {
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    const c = config(HOOK_CONFIG);
    // The channel meets run a.
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "a" });
    const way = fakeWay();
    await pass(w, c, { transport: way.transport });
    expect(bodies(way.calls).map((n) => `${n.run} ${n.event}`)).toEqual(["a wait_opened"]);
    // Run b begins, asks twice, is answered twice and succeeds, all before the next pass.
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "b" });
    await answer(w, "b", w.who.pat, "because");
    await answer(w, "b", w.who.rex, "yes");
    expect((await w.rt.getRun("b")).state).toBe("succeeded");
    await pass(w, c, { transport: way.transport });
    // From its first event, and a question only while it is still asked: b's two were answered, so its outcome alone.
    expect(bodies(way.calls).map((n) => `${n.run} ${n.event} ${n.role}`)).toEqual(["a wait_opened platform_lead", "b run_succeeded platform_lead"]);
  });

  // A question is told only while it is still asked; an outcome always. The pump asks right before the send, so a
  // question answered between that and the send may still be told: that is no error, the receiver finds it decided.
  it("tells of runs that asked and ended between two passes only how they ended", async () => {
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    await meet(w, config(HOOK_CONFIG));
    for (const run of ["f1", "f2", "f3"]) await endedRun(w, run);
    const way = fakeWay();
    await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    expect(bodies(way.calls).map((n) => `${n.run} ${n.event}`)).toEqual(["f1 run_succeeded", "f2 run_succeeded", "f3 run_succeeded"]);
  });

  it("tells a question still asked, and drops one whose wait closed while it waited for its next attempt, with no dead letter", async () => {
    const w = await ownedRun();
    let first: string | undefined;
    const way = fakeWay((id) => {
      first ??= id;
      return id === first ? new Response("busy", { status: 503 }) : new Response("ok");
    });
    const c = config(HOOK_CONFIG);
    expect(await pass(w, c, { transport: way.transport })).toMatchObject({ failed: 1, pending: 1 });
    expect(bodies(way.calls).map((n) => n.event)).toEqual(["wait_opened"]);
    // The platform lead answers before the next attempt: the run now asks the reviewer.
    await answer(w, "o1", w.who.pat, "because");
    w.clock.advance(backoffMs(1));
    expect(await pass(w, c, { transport: way.transport })).toMatchObject({ sent: 3, dead: 0, pending: 0 });
    expect(bodies(way.calls).slice(1).map((n) => `${n.event} ${n.role}`)).toEqual(["budget_exceeded platform_lead", "run_attention_required platform_lead", "wait_opened reviewer"]);
    expect(ids(way.calls).filter((i) => i === first)).toHaveLength(1);
    expect(await count(w, "select count(*) as n from notify_dead")).toBe(0);
  });

  it("two pumps that meet one new channel at once tell each open question once, and record the channel once", async () => {
    // On PGlite the two are serialized by its one connection; on PostgreSQL they race, and the advisory lock decides.
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    for (const run of ["m1", "m2"]) await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: run });
    const way = fakeWay();
    const c = config(HOOK_CONFIG);
    await Promise.all([pass(w, c, { transport: way.transport }), pass(w, c, { transport: way.transport })]);
    expect(bodies(way.calls).map((n) => `${n.run} ${n.event}`).sort()).toEqual(["m1 wait_opened", "m2 wait_opened"]);
    expect(await count(w, "select count(*) as n from notify_channels")).toBe(1);
  });

  it("tells a run halted and lifted between two passes, its run_cancelled after the lift", async () => {
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    await meet(w, config(HOOK_CONFIG));
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "hl" });
    await w.rt.halt({ tenant: "default" }, { by: "ops" });
    await w.rt.liftHalt({ tenant: "default" }, "ops");
    const way = fakeWay();
    await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    // Its question ended with the run: the outcome alone.
    expect(bodies(way.calls).map((n) => `${n.event} ${n.role}`)).toEqual(["run_cancelled platform_lead"]);
  });

  it("tells a run created while the channel is being met from its first event", async () => {
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    await endedRun(w, "before");
    // A run is started while the meeting is under way, just before the channel is recorded as in use.
    let started: Promise<unknown> | undefined;
    const during: Db = {
      query: ((sql: string, p?: unknown[]) => w.db.query(sql, p)) as Db["query"],
      tx: (fn) =>
        w.db.tx((tx) =>
          fn({
            query: (async (sql: string, p?: unknown[]) => {
              if (sql.startsWith("insert into notify_channels")) started ??= w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "during" });
              return tx.query(sql, p);
            }) as Db["query"],
          }),
        ),
      close: () => w.db.close(),
    };
    const way = fakeWay();
    await notifyPass(during, { config: config(HOOK_CONFIG), transport: way.transport, now: () => w.clock.now() });
    await started;
    expect(way.calls).toEqual([]);
    await answer(w, "during", w.who.pat, "because");
    await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    // From its first event: the platform lead's question was answered, the reviewer's is asked.
    expect(bodies(way.calls).map((n) => `${n.run} ${n.event} ${n.role}`)).toEqual(["during wait_opened reviewer"]);
  });

  it("tells a channel meeting an escalated review the escalation alone, and not the request it replaced", async () => {
    const w = await nworld(REVIEW, "0.7");
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "rv" });
    w.clock.advance(DAY);
    await w.rt.tick("rv");
    const way = fakeWay();
    const c = config({ channels: { hook: { webhook: { url: HOOK, credential: "acme_hook" } } }, roles: { accountant: { channels: ["hook"] }, finance_lead: { channels: ["hook"] } } });
    await pass(w, c, { transport: way.transport });
    expect(bodies(way.calls).map((n) => `${n.event} ${n.role} ${n.command}`)).toEqual([`review_escalated finance_lead ${REVIEW_AT}`]);
  });

  it("visits only the runs with something new past the channel's cursor", async () => {
    const w = await ownedRun("v1");
    await ownedRun("v2", undefined, w);
    const way = fakeWay();
    await pass(w, config(HOOK_CONFIG), { transport: way.transport });
    const asked: string[] = [];
    const counting: Db = { query: (async (sql: string, p?: unknown[]) => (asked.push(sql), w.db.query(sql, p))) as Db["query"], tx: (fn) => w.db.tx(fn), close: () => w.db.close() };
    await notifyPass(counting, { config: config(HOOK_CONFIG), transport: way.transport, now: () => w.clock.now() });
    // No run is read one by one: none has anything new.
    expect(asked.filter((s) => s.includes("select r.revision"))).toEqual([]);
    expect(way.calls).toHaveLength(6);
    // One run moves on: that one alone is read.
    await append(w, "v2", "run_cancelled", {});
    asked.length = 0;
    await notifyPass(counting, { config: config(HOOK_CONFIG), transport: way.transport, now: () => w.clock.now() });
    expect(asked.filter((s) => s.includes("select r.revision"))).toHaveLength(1);
  });

  it("tells nothing of a run under a halt, opens no session and moves no cursor; once it is lifted, all of it in order", async () => {
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    await meet(w, config(HOOK_CONFIG));
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "h1" });
    await w.rt.halt({ tenant: "default" }, { reason: "made up", by: "ops" });
    expect((await w.rt.getRun("h1")).state).toBe("cancelled");
    const way = fakeWay();
    expect(await pass(w, config(HOOK_CONFIG), { transport: way.transport })).toEqual({ sent: 0, failed: 0, dead: 0, pending: 0, failures: [] });
    expect(way.opened).toEqual([]);
    expect(await cursorRow(w.db, "hook", "h1")).toBeNull();
    // A halt of every tenant holds the same.
    await w.rt.liftHalt({ tenant: "default" }, "ops");
    await w.rt.halt({ all: true }, { by: "ops" });
    expect(await pass(w, config(HOOK_CONFIG), { transport: way.transport })).toMatchObject({ sent: 0 });
    await w.rt.liftHalt({ all: true }, "ops");
    // The halt ended the run, and its question with it: what is told after the lift is how it ended.
    expect(await pass(w, config(HOOK_CONFIG), { transport: way.transport })).toMatchObject({ sent: 1 });
    expect(bodies(way.calls).map((n) => `${n.event} ${n.role}`)).toEqual(["run_cancelled platform_lead"]);
  });
});

// ── the webhook, through the egress proxy ──────────────────────────────

describe("a webhook through the egress proxy", () => {
  let ew: EgressWorld;
  beforeAll(async () => {
    ew = await egressWorld({ credentials: { acme_hook: { hosts: ["hooks.acme.example"], header: "authorization", template: "Bearer {secret}", secret: HOOK_SECRET } } });
  });
  afterAll(async () => {
    await ew.close();
  });
  beforeEach(() => {
    ew.up.seen.length = 0;
    ew.dials.length = 0;
    ew.resolved.length = 0;
    ew.dns.clear();
    ew.up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    };
  });

  /** The ports of the proxy's open sessions for channel `hook`: the one place its requests may go. */
  const sessionPorts = (): number[] =>
    [...(ew.proxy as unknown as { sessions: Map<string, { id: string; port: number }> }).sessions.values()].filter((s) => s.id.startsWith("gw.notify.hook.")).map((s) => s.port);

  /** Runs `f` with the process's `fetch` replaced: every URL is recorded, and any but the base URL of a session of the channel fails. */
  async function onlyThroughTheProxy<T>(f: () => Promise<T>): Promise<{ value: T; urls: string[] }> {
    const real = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const at = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(url);
      if (!at || !sessionPorts().includes(Number(at[1]))) throw new Error(`the adapter opened a connection of its own, to ${url}`);
      return real(input, init);
    }) as typeof fetch;
    try {
      return { value: await f(), urls };
    } finally {
      globalThis.fetch = real;
    }
  }

  const opts = (o: Partial<NotifyOptions> = {}): Partial<NotifyOptions> => ({ transport: egressTransport({ admin: ew.config.admin }), ...o });

  it("is sent to its session's own address and nowhere else; the proxy puts the secret in, the runtime holds a placeholder", async () => {
    const w = await ownedRun();
    const { value: r, urls } = await onlyThroughTheProxy(() => pass(w, config(HOOK_CONFIG), opts()));
    expect(r).toEqual({ sent: 3, failed: 0, dead: 0, pending: 0, failures: [] });
    expect(urls).toHaveLength(3);
    expect(ew.up.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /in", "POST /in", "POST /in"]);
    expect(ew.dials.map((d) => `${d.host}:${d.port}`)).toEqual(["hooks.acme.example:443", "hooks.acme.example:443", "hooks.acme.example:443"]);
    for (const s of ew.up.seen) {
      expect(seenHeader(s, "host")).toEqual(["hooks.acme.example"]);
      expect(seenHeader(s, "authorization")).toEqual([`Bearer ${HOOK_SECRET}`]);
      const body = JSON.parse(s.body) as Notification;
      expect(seenHeader(s, NOTIFICATION_HEADER)).toEqual([body.id]);
      expect(seenHeader(s, "content-type")).toEqual(["application/json"]);
    }
  });

  it("would fail if the adapter sent the webhook its own way, or to another local port (the test of the test)", async () => {
    const { value } = await onlyThroughTheProxy(async () => {
      const out: string[] = [];
      for (const url of [HOOK, `http://127.0.0.1:${ew.up.port}/in`]) {
        try {
          await fetch(url, { method: "POST", body: "{}" });
          out.push("sent");
        } catch (e) {
          out.push((e as Error).message);
        }
      }
      return out;
    });
    expect(value).toEqual([`the adapter opened a connection of its own, to ${HOOK}`, `the adapter opened a connection of its own, to http://127.0.0.1:${ew.up.port}/in`]);
  });

  it("opens its session for the run's tenant and notify:<channel>: a revocation of the tenant and of the channel cut it", async () => {
    const spec = config(HOOK_CONFIG).channels["hook"]! as { webhook: Parameters<typeof webhookNotifier>[1] };
    const t = egressTransport({ admin: ew.config.admin })();
    try {
      const acme = t.open("hook", spec.webhook, "acme");
      const beta = t.open("hook", spec.webhook, "beta");
      await acme.ready();
      expect((await acme.fetch(HOOK, { method: "POST", body: "{}" })).status).toBe(200);
      expect((await beta.fetch(HOOK, { method: "POST", body: "{}" })).status).toBe(200);
      const cut = await ew.client.revoke({ tenant: "acme" });
      expect(cut).toEqual([expect.stringMatching(/^gw\.notify\.hook\.[0-9a-f]{16}$/)]);
      const denied = await acme.fetch(HOOK, { method: "POST", body: "{}" });
      expect(denied.headers.get("x-mandate-egress-denied")).toBe("session_revoked");
      await expect(acme.fetch(HOOK, { method: "POST", body: "{}" })).rejects.toThrow(/session_revoked/);
      expect((await beta.fetch(HOOK, { method: "POST", body: "{}" })).status).toBe(200);
      expect(await ew.client.revoke({ run: "notify:hook" })).toEqual(expect.arrayContaining([expect.stringMatching(/^gw\.notify\.hook\./)]));
    } finally {
      await t.close();
    }
  });

  it("refuses a redirect and does not follow it: the notification is given up after one attempt", async () => {
    const w = await ownedRun();
    ew.up.handler = (_req, res) => {
      res.writeHead(302, { location: "https://evil.example/x" });
      res.end();
    };
    expect(await pass(w, config(HOOK_CONFIG), opts())).toEqual({ sent: 0, failed: 0, dead: 3, pending: 0, failures: [] });
    expect(ew.up.seen).toHaveLength(3);
    expect(ew.resolved.filter((h) => h !== "hooks.acme.example")).toEqual([]);
    expect(ew.dials.every((d) => d.host === "hooks.acme.example")).toBe(true);
    const rows = await w.db.query<{ attempts: unknown; reason: string }>("select attempts, reason from notify_dead order by seq");
    expect(rows.map((x) => [Number(x.attempts), x.reason])).toEqual(Array(3).fill([1, "hooks.acme.example answered with a redirect, which is not followed"]));
  });

  it("never reaches the network with a URL that is not https", async () => {
    const w = await ownedRun();
    const plain = { url: "http://hooks.acme.example/in", host: "hooks.acme.example", credential: "acme_hook", header: "authorization", template: "Bearer {secret}", format: "mandate" as const };
    const bad: NotificationsConfig = { channels: { hook: { webhook: plain } }, roles: { platform_lead: { channels: ["hook"], outcomes: false } }, link: null };
    await expect(pass(w, bad, opts())).rejects.toMatchObject({ code: "bad_notification_channel" });
    expect(() => webhookNotifier("hook", plain, () => ({ fetch, ready: async () => undefined }))).toThrow(/https:\/\/ only/);
    expect(ew.up.seen).toEqual([]);
    expect(ew.dials).toEqual([]);
    expect(ew.resolved).toEqual([]);
  });

  it("keeps the secret out of every reason, report and row, even when the receiver echoes it back", async () => {
    const w = await ownedRun();
    ew.up.handler = (req, res) => {
      res.writeHead(500, { "content-type": "text/plain", "x-echo": String(req.headers["authorization"]) });
      res.end(JSON.stringify(req.headers));
    };
    const told: string[] = [];
    const reports: unknown[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      reports.push(await pass(w, config(HOOK_CONFIG), opts({ onDead: (d) => told.push(JSON.stringify(d)), onFailure: (c, m) => told.push(`${c} ${m}`) })));
      w.clock.advance(backoffMs(attempt));
    }
    expect(await count(w, "select count(*) as n from notify_dead")).toBe(1);
    const rows = JSON.stringify(await w.db.query("select * from notify_dead"));
    const cursors = JSON.stringify(await w.db.query("select * from notify_cursors"));
    for (const t of [rows, cursors, JSON.stringify(reports), ...told]) {
      expect(t).not.toContain(HOOK_SECRET);
      expect(t).not.toMatch(/mdt-ph-/);
    }
    expect(rows).toContain("hooks.acme.example answered 500");
  });

  it("is no attempt when the proxy refuses the session: the channel waits, nothing is given up", async () => {
    const w = await ownedRun();
    const r = await pass(w, config({ ...HOOK_CONFIG, channels: { hook: { webhook: { url: "https://other.acme.example/in", credential: "acme_hook" } } } }), opts());
    expect(r.sent + r.dead + r.failed).toBe(0);
    expect(r.failures).toEqual([{ channel: "hook", message: expect.stringMatching(/^egress_unavailable: .*does not bind credential acme_hook to other\.acme\.example/) }]);
    expect(ew.up.seen).toEqual([]);
  });

  it("counts the proxy's denial of one request as a failed attempt: denied six times, it is given up and the channel goes on", async () => {
    const w = await ownedRun();
    // The webhook's host now names a private address: the proxy denies each request, and the session stands.
    ew.dns.set("hooks.acme.example", ["10.0.0.7"]);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await pass(w, config(HOOK_CONFIG), opts()), `attempt ${attempt}`).toEqual({ sent: 0, failed: 1, dead: 0, pending: 1, failures: [] });
      w.clock.advance(backoffMs(attempt));
    }
    // The sixth denial gives the first up; the next one is denied too, and waits.
    expect(await pass(w, config(HOOK_CONFIG), opts())).toEqual({ sent: 0, failed: 1, dead: 1, pending: 1, failures: [] });
    expect(await w.db.query("select attempts, reason from notify_dead")).toEqual([{ attempts: 6, reason: "the egress proxy denied the request to hooks.acme.example (resolved_private)" }]);
    expect(ew.up.seen).toEqual([]);
    // Once the proxy lets it through, the channel goes on: nothing blocks it for good.
    ew.dns.clear();
    w.clock.advance(backoffMs(1));
    expect(await pass(w, config(HOOK_CONFIG), opts())).toMatchObject({ sent: 2, pending: 0 });
  });
});

// ── the leak test ───────────────────────────────────────────────────────

describe("what a notification carries", () => {
  let ew: EgressWorld;
  beforeAll(async () => {
    ew = await egressWorld({ credentials: { acme_hook: { hosts: ["hooks.acme.example"], header: "authorization", template: "Bearer {secret}", secret: HOOK_SECRET } } });
  });
  afterAll(async () => {
    await ew.close();
  });

  /** The review program with markers in its criteria's words and its questions, and a workflow under an envelope. */
  const PROGRAM =
    REVIEW.replace("The total is within 2% of the invoice's", `${M}-criterion: the total is within 2%`) +
    `
role platform_lead "Platform lead"
role reviewer      "Reviewer"

capability Note = fs.read("/tmp/notes")

workflow Ship(title: Text) -> Untrusted<Text>
  envelope {
    owner  platform_lead
    caps   Note
    budget { steps: 5, agents: 2 }
  }
{
  let why = human.ask("${M}-question-1: why ship it?")
  human.ask("${M}-question-2: is it good?", role: reviewer)
}
`;

  it("holds no marker planted in a run's inputs, steps, results, errors, questions and details, in either adapter or format, and exactly the fixed members", async () => {
    const items = [0, 1, 2].map((i) => inv(`${M}-invoice-${i}`, 1000, `${M}-vendor-${i}`));
    const w = await nworld(PROGRAM, "0.7", {
      ...Object.fromEntries(items.map((i) => [String(i["invoice_no"]), { ...i, total_cents: 1100, vendor_id: i["vendor_id"] }])),
      [`${M}-fails`]: { fail: `${M}-error: the matcher broke` },
    });
    const d = dir();
    mkdirSync(join(d, "out"));
    const channels = ["hook_json", "hook_text", "local"];
    const c = config(
      {
        channels: {
          hook_json: { webhook: { url: "https://hooks.acme.example/json", credential: "acme_hook", format: "mandate" } },
          hook_text: { webhook: { url: "https://hooks.acme.example/text", credential: "acme_hook", header: "authorization", template: "Bearer {secret}", format: "text" } },
          local: { file: "out/notifications.jsonl" },
        },
        roles: {
          accountant: { channels: ["hook_json", "local"], outcomes: false },
          finance_lead: { channels: ["hook_text", "local"], outcomes: true },
          platform_lead: { channels: ["hook_json", "hook_text", "local"] },
          reviewer: { channels: ["hook_text", "local"], outcomes: true },
        },
        link: "https://mandate.acme.example/runs/{run}?role={role}&at={command}",
      },
      d,
    );
    const notify = { config: c, transport: egressTransport({ admin: ew.config.admin }), now: () => w.clock.now() };
    const pass = () => tickPass(w.db, { runtimeFor: async () => ({ rt: w.rt }), notify, now: () => w.clock.now() });
    // The channels are in use before the runs begin, so that everything the runs do is told.
    await pass();
    expect((await w.db.query<{ channel: string }>("select channel from notify_channels order by channel")).map((r) => r.channel)).toEqual(channels);

    // A review of three matches, escalated, and decided by the finance lead.
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items }, runId: "leak-review" });
    await pass();
    w.clock.advance(DAY);
    await pass();
    const lists = { waive: [0], decline: [1, 2] };
    await w.rt.decideReview("leak-review", msg(), { ...lists, signed: await sign(w, "leak-review", w.who.ben, "review", payloadOf.review(lists)) });
    // A run that fails with an error that holds a marker.
    await w.rt.startRun({ pkg: w.pkg, workflow: "Fail", input: { inv: inv(`${M}-fails`, 5, `${M}-vendor`) }, runId: "leak-fail" });
    // Two questions with markers, one that asks no role (the owner), and answers with markers, which are the result.
    await approveCard(w);
    await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: `${M}-title` }, runId: "leak-ship" });
    await pass();
    await answer(w, "leak-ship", w.who.pat, `${M}-answer-1`);
    await pass();
    // What a lead can write, and what an exception holds, as the journal holds them: an amendment's reason, a wait of a
    // sub-program whose definition names a lead chose, the details of a budget run out and of a run that needs attention.
    const plan = "/defs/Ship/body/1/value";
    await append(w, "leak-ship", "amendment_requested", { plan, step: `${plan}/step/0/tool/0`, lead: `${M}Lead.finish`, from: w.pkg.hash, package: w.pkg.hash, diff: `sha256:${M}` });
    await append(w, "leak-ship", "wait_opened", { command: `${plan}/step/0/tool/0/amendment`, kind: "amendment", request: { role: "platform_lead", reason: `${M}-reason: three more repositories`, envelope: { owner: `${M}` }, deadline: null } });
    await waitingRow(w, "leak-ship", `${plan}/step/0/tool/0/amendment`, "amendment");
    await append(w, "leak-ship", "program_admitted", { plan, number: 1, command: `${plan}/program/1`, workflow: `${M}Fix` });
    await append(w, "leak-ship", "wait_opened", { command: `${plan}/program/1/defs/${M}Fix/body/0/value`, kind: "input", request: { question: `${M}-sub-question`, role: "reviewer" } });
    await waitingRow(w, "leak-ship", `${plan}/program/1/defs/${M}Fix/body/0/value`, "input");
    await append(w, "leak-ship", "budget_exceeded", { episode: 0, detail: { $tag: "BudgetExceeded", $args: [{ dimension: `${M}-dimension`, requested: 1 }] } });
    await append(w, "leak-ship", "run_attention_required", { attention: { violation: `${M}_code`, message: `${M}-attention message` } });
    await pass();
    await answer(w, "leak-ship", w.who.rex, `${M}-answer-2`);
    await pass();
    expect([(await w.rt.getRun("leak-review")).state, (await w.rt.getRun("leak-fail")).state, (await w.rt.getRun("leak-ship")).state]).toEqual(["succeeded", "failed", "succeeded"]);

    // The markers are in the journal: in requests, questions, results, errors and details.
    for (const type of ["wait_opened", "run_waiting", "run_succeeded", "run_failed", "amendment_requested", "budget_exceeded", "run_attention_required", "program_admitted"]) {
      expect(await count(w, "select count(*) as n from events where type = $1 and data::text like $2", [type, `%${M}%`]), type).toBeGreaterThan(0);
    }
    expect(await count(w, "select count(*) as n from commands where kind = 'delegate' and result::text like $1", [`%${M}%`])).toBeGreaterThan(0);

    // Everything either adapter emitted: each request the webhook's receiver got, whole, and the file, whole.
    const file = readFileSync(join(d, "out/notifications.jsonl"), "utf8");
    const requests = ew.up.seen.map((s) => ({ url: s.url, headers: s.headers.filter((_, i) => i % 2 === 0 || s.headers[i - 1]!.toLowerCase() !== "authorization"), body: s.body }));
    for (const t of [file, ...requests.map((r) => JSON.stringify(r))]) expect(t).not.toContain(M);

    // Every payload has exactly the fixed members; every text body is {text} alone.
    const json = ew.up.seen.filter((s) => s.url === "/json").map((s) => JSON.parse(s.body) as Obj);
    const text = ew.up.seen.filter((s) => s.url === "/text").map((s) => JSON.parse(s.body) as Obj);
    const local = lines(join(d, "out/notifications.jsonl"));
    for (const n of [...json, ...local]) {
      expect(Object.keys(n)).toEqual([...NOTIFICATION_MEMBERS]);
      expect(Object.keys(n["as_of"] as Obj).sort()).toEqual(["event", "revision"]);
      expect(Object.hasOwn(NOTIFIED, String(n["event"]))).toBe(true);
      expect(["S0", "S1"]).toContain(n["class"]);
      for (const k of ["role", "command", "link"]) expect(n[k] === null || typeof n[k] === "string", k).toBe(true);
      for (const k of ["seq", "at"]) expect(typeof n[k], k).toBe("number");
      expect(n["deadline"] === null || typeof n["deadline"] === "number").toBe(true);
    }
    for (const t of text) {
      expect(Object.keys(t)).toEqual(["text"]);
      expect(typeof t["text"]).toBe("string");
    }
    for (const s of ew.up.seen) expect(seenHeader(s, NOTIFICATION_HEADER)).toHaveLength(1);
    // And it is not empty: every kind of event was told, through every adapter, the sub-program's wait by its plan.
    expect(new Set(local.map((n) => n["event"]))).toEqual(new Set(["review_requested", "review_escalated", "run_succeeded", "run_failed", "wait_opened", "amendment_requested", "budget_exceeded", "run_attention_required"]));
    expect(local.some((n) => String(n["command"]).startsWith(`${plan}/program/1/digest:`))).toBe(true);
    expect(json.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(new Set(local.map((n) => n["run"]))).toEqual(new Set(["leak-review", "leak-fail", "leak-ship"]));
  });
});
