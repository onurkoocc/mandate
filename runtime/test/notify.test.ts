// Notifications (spec/attention.md "Notifications", "Refusals"): a cursor pump that tells the roles of a 0.7 run what
// is asked of them and how the run ended, through a webhook that leaves only through the egress proxy, or a file.
//
// - The configuration (`notifications` in mandate.runtime.json) is refused by name, `bad_notification_channel`, for
//   each way it cannot be used, one case each.
// - The pump: in order per channel and run; a notification being retried keeps the cursor before it; six attempts and
//   it is given up (`notify_dead`) and the cursor moves past it; at least once, a repeat with the same id; two pumps
//   racing; a way out that is not there is no attempt.
// - The webhook: through the proxy and nowhere else, a redirect is an error and is not followed, a URL that is not
//   https never reaches the network, the credential's secret is in no reason, report or row; the session it is sent
//   in is scoped to the tenant and `notify:<channel>`.
// - The leak test: a run whose inputs, steps, results, errors and questions hold markers; no marker is in anything
//   either adapter emits, in either webhook format, and every payload has exactly the fixed members.
//
// The proxy is the egress tests' in-process one, with an in-process upstream and no network. Every secret is a made-up
// word.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/control.js";
import type { Db } from "../src/db.js";
import { EVENT_CLASSES } from "../src/classes.js";
import { payloadOf } from "../src/decisions.js";
import {
  backoffMs,
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
import { closeAll } from "./helpers.js";
import { answer, approveCard, count, DAY, inv, lines, msg, nworld, OWNED, REVIEW, scratch, sign, type NWorld } from "./notify-world.js";

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

/** A configuration as the operator writes it, read as the runtime reads it. */
function config(raw: unknown, where = dir()): NotificationsConfig {
  return readNotifications(raw, { file: join(where, "mandate.runtime.json"), at: (p) => join(where, p), egress: true });
}

/** A run of OWNED that asked the platform lead (no role), then the reviewer, and succeeded: three notifications to `hook`. */
async function ownedRun(): Promise<NWorld> {
  const w = await nworld(OWNED, "0.7");
  await approveCard(w);
  await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "o1" });
  await answer(w, "o1", w.who.pat, "because");
  await answer(w, "o1", w.who.rex, "yes");
  expect((await w.rt.getRun("o1")).state).toBe("succeeded");
  return w;
}

const HOOK_CONFIG = { channels: { hook: { webhook: { url: HOOK, credential: "acme_hook", format: "mandate" } } }, roles: { platform_lead: { channels: ["hook"] }, reviewer: { channels: ["hook"] } } };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A webhook's way out that answers as `answer` says, by the notification's id and how often it was sent; it records each request. */
function fakeWay(answer: (id: string, nth: number) => Response | Error = () => new Response("ok")) {
  const calls: Call[] = [];
  const opened: string[] = [];
  let ready: () => Promise<void> = async () => undefined;
  const transport = (): WebhookTransport => ({
    open: (channel, _spec, tenant) => {
      opened.push(`${channel} ${tenant}`);
      return {
        ready: () => ready(),
        fetch: (async (url: string, init?: RequestInit) => {
          const headers: Record<string, string> = {};
          new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
          calls.push({ url: String(url), headers, body: String(init?.body) });
          const id = headers[NOTIFICATION_HEADER]!;
          const a = answer(id, calls.filter((c) => c.headers[NOTIFICATION_HEADER] === id).length);
          if (a instanceof Error) throw a;
          return a;
        }) as typeof fetch,
      };
    },
    close: async () => undefined,
  });
  return { calls, opened, transport, setReady: (f: () => Promise<void>) => (ready = f) };
}

const ids = (calls: Call[]): string[] => calls.map((c) => c.headers[NOTIFICATION_HEADER]!);
const bodies = (calls: Call[]): Notification[] => calls.map((c) => JSON.parse(c.body) as Notification);
const cursor = async (db: Db, channel: string, run: string): Promise<number | null> => {
  const [c] = await db.query<{ seq: unknown }>("select seq from notify_cursors where channel = $1 and run_id = $2", [channel, run]);
  return c ? Number(c.seq) : null;
};

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
    ["a link with another placeholder", { ...ok, link: "https://mandate.acme.example/{tenant}/{run}" }, /holds "\{tenant\}"/],
    ["a link with a step's value as a placeholder", { ...ok, link: "https://mandate.acme.example/{run}/{result}" }, /holds "\{result\}"/],
    ["a link with a brace left open", { ...ok, link: "https://mandate.acme.example/{run" }, /holds "\{run"/],
    ["a link with a brace that closes nothing", { ...ok, link: "https://mandate.acme.example/run}" }, /holds "\}"/],
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

  it("makes a link from the three ids only, each URL-encoded, an absent one empty", () => {
    expect(linkOf("https://m.example/runs/{run}?role={role}&at={command}", { run: "r 1/2", role: "accountant", command: "/defs/W/body/0" })).toBe("https://m.example/runs/r%201%2F2?role=accountant&at=%2Fdefs%2FW%2Fbody%2F0");
    expect(linkOf("https://m.example/{run}/{role}/{command}", { run: "r", role: null, command: null })).toBe("https://m.example/r//");
    expect(linkOf(null, { run: "r", role: null, command: null })).toBeNull();
  });
});

// ── the pump ────────────────────────────────────────────────────────────

describe("the pump", () => {
  it("sends each event to the roles it is addressed to, in order, with the fixed payload; the cursor ends at the run's last event", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    const c = config(HOOK_CONFIG);
    const r = await notifyPass(w.db, { config: c, transport: way.transport });
    expect(r).toEqual({ sent: 3, retried: 0, dead: 0, failures: [] });
    const sent = bodies(way.calls);
    expect(sent.map((n) => `${n.event} ${n.role}`)).toEqual(["wait_opened platform_lead", "wait_opened reviewer", "run_succeeded platform_lead"]);
    const events = await w.rt.journal.events("o1");
    for (const n of sent) {
      expect(Object.keys(n)).toEqual([...NOTIFICATION_MEMBERS]);
      expect(n).toMatchObject({ format: NOTIFICATION_FORMAT, tenant: "default", run: "o1", workflow: "Ship", package: w.pkg.hash, link: null });
      expect(n.id).toBe(digest("operation", { format: NOTIFICATION_FORMAT, channel: "hook", run: "o1", seq: n.seq }));
      expect(events.find((e) => e.seq === n.seq)?.type).toBe(n.event);
      expect(n.as_of).toEqual({ revision: (await w.rt.getRun("o1")).revision, event: events.at(-1)!.seq });
    }
    expect(sent.map((n) => [n.kind, n.class])).toEqual([
      ["decision", "S0"],
      ["decision", "S0"],
      ["outcome", "S1"],
    ]);
    expect(sent[0]!.command).toBe((events.find((e) => e.seq === sent[0]!.seq)!.data as Obj)["command"]);
    expect(sent[2]!.command).toBeNull();
    // Each request: POST to the webhook, JSON, the id in its header.
    for (const call of way.calls) {
      expect(call.url).toBe(HOOK);
      expect(call.headers["content-type"]).toBe("application/json");
    }
    expect(ids(way.calls)).toEqual(sent.map((n) => n.id));
    expect(await cursor(w.db, "hook", "o1")).toBe(events.at(-1)!.seq);
    // A second pass has nothing to send.
    expect(await notifyPass(w.db, { config: c, transport: way.transport })).toEqual({ sent: 0, retried: 0, dead: 0, failures: [] });
    expect(way.calls).toHaveLength(3);
  });

  it("a text webhook sends {text: a fixed sentence} made of the same members", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    await notifyPass(w.db, { config: config({ ...HOOK_CONFIG, channels: { hook: { webhook: { url: HOOK, credential: "acme_hook", format: "text" } } }, link: "https://m.acme.example/runs/{run}" }), transport: way.transport });
    const sent = way.calls.map((c) => JSON.parse(c.body) as Obj);
    expect(sent.map((b) => Object.keys(b))).toEqual([["text"], ["text"], ["text"]]);
    expect(String(sent[0]!["text"])).toMatch(/^Mandate: run o1 of Ship \(tenant default\) waits for platform_lead at \/defs\/Ship\/body\/0\/value \(wait_opened, event \d+\)\. https:\/\/m\.acme\.example\/runs\/o1$/);
    expect(String(sent[2]!["text"])).toMatch(/^Mandate: run o1 of Ship \(tenant default\): run_succeeded \(event \d+\)\. https:\/\/m\.acme\.example\/runs\/o1$/);
    const n: Notification = { format: NOTIFICATION_FORMAT, id: "sha256:x", kind: "decision", event: "review_escalated", class: "S0", tenant: "t", run: "r", workflow: "W", package: "p", seq: 9, at: 1, role: "finance_lead", command: "/c", deadline: Date.UTC(2027, 0, 2), as_of: { revision: 3, event: 9 }, link: null };
    expect(sentence(n)).toBe("Mandate: run r of W (tenant t) waits for finance_lead at /c, deadline 2027-01-02T00:00:00.000Z (review_escalated, event 9).");
  });

  it("retries with a backoff, the cursor standing before the notification meanwhile, and keeps the run's order", async () => {
    const w = await ownedRun();
    let first: string | undefined;
    const way = fakeWay((id, nth) => {
      first ??= id;
      return id === first && nth <= 2 ? new Response("busy", { status: 503 }) : new Response("ok");
    });
    const waits: Array<[number, number | null]> = [];
    const r = await notifyPass(w.db, { config: config(HOOK_CONFIG), transport: way.transport, sleep: async (ms) => void waits.push([ms, await cursor(w.db, "hook", "o1")]) });
    expect(r).toEqual({ sent: 3, retried: 2, dead: 0, failures: [] });
    const firstSeq = bodies(way.calls)[0]!.seq;
    // Each wait came while the cursor stood just before the notification being retried.
    expect(waits).toEqual([
      [1000, firstSeq - 1],
      [2000, firstSeq - 1],
    ]);
    const order = ids(way.calls);
    expect(order.slice(0, 3)).toEqual([first, first, first]);
    expect(new Set(order.slice(3)).size).toBe(2);
    expect(bodies(way.calls).map((n) => n.seq)).toEqual([firstSeq, firstSeq, firstSeq, ...bodies(way.calls).slice(3).map((n) => n.seq)]);
    expect(bodies(way.calls).slice(3).every((n) => n.seq > firstSeq)).toBe(true);
    // The same notification, byte for byte, at every attempt.
    expect(new Set(way.calls.slice(0, 3).map((c) => c.body)).size).toBe(1);
  });

  it("gives a notification up after six attempts, records it in notify_dead and moves past it; the next ones go on", async () => {
    const w = await ownedRun();
    let first: string | undefined;
    const way = fakeWay((id) => {
      first ??= id;
      return id === first ? new Response("no", { status: 500 }) : new Response("ok");
    });
    const waits: number[] = [];
    const dead: unknown[] = [];
    const r = await notifyPass(w.db, { config: config(HOOK_CONFIG), transport: way.transport, sleep: async (ms) => void waits.push(ms), onDead: (d) => dead.push(d) });
    expect(r).toEqual({ sent: 2, retried: 5, dead: 1, failures: [] });
    expect(ids(way.calls).filter((i) => i === first)).toHaveLength(6);
    expect(waits).toEqual([1, 2, 3, 4, 5].map(backoffMs));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    const seq = bodies(way.calls)[0]!.seq;
    const rows = await w.db.query<Obj>("select channel, run_id, seq, attempts, reason from notify_dead");
    expect(rows.map((x) => ({ ...x, seq: Number(x["seq"]), attempts: Number(x["attempts"]) }))).toEqual([{ channel: "hook", run_id: "o1", seq, attempts: 6, reason: "hooks.acme.example answered 500" }]);
    expect(dead).toEqual([{ channel: "hook", run: "o1", seq, id: first, attempts: 6, reason: "hooks.acme.example answered 500" }]);
    // A notification given up is not tried again.
    expect(await notifyPass(w.db, { config: config(HOOK_CONFIG), transport: way.transport })).toEqual({ sent: 0, retried: 0, dead: 0, failures: [] });
    expect(await count(w, "select count(*) as n from notify_dead")).toBe(1);
  });

  it("gives up at once what trying again would not change: a 4xx answer", async () => {
    const w = await ownedRun();
    const way = fakeWay((_id, _nth) => new Response("gone", { status: 404 }));
    const waits: number[] = [];
    const r = await notifyPass(w.db, { config: config(HOOK_CONFIG), transport: way.transport, sleep: async (ms) => void waits.push(ms) });
    expect(r).toEqual({ sent: 0, retried: 0, dead: 3, failures: [] });
    expect(waits).toEqual([]);
    expect((await w.db.query<{ attempts: unknown }>("select attempts from notify_dead")).map((x) => Number(x.attempts))).toEqual([1, 1, 1]);
  });

  it("counts no attempt while the way out is not there: the channel stops for the pass, its cursor where it was", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    way.setReady(async () => {
      throw new NotifyUnavailable("the egress proxy at made-up.sock: it does not answer");
    });
    const failures: string[] = [];
    const r = await notifyPass(w.db, { config: config(HOOK_CONFIG), transport: way.transport, onFailure: (c, m) => failures.push(`${c}: ${m}`) });
    expect(r).toEqual({ sent: 0, retried: 0, dead: 0, failures: [{ channel: "hook", message: "the egress proxy at made-up.sock: it does not answer" }] });
    expect(failures).toEqual(["hook: the egress proxy at made-up.sock: it does not answer"]);
    expect(way.calls).toEqual([]);
    const before = await cursor(w.db, "hook", "o1");
    const firstSeq = (await w.rt.journal.events("o1")).find((e) => e.type === "wait_opened")!.seq;
    expect(before).toBe(firstSeq - 1);
    expect(await count(w, "select count(*) as n from notify_dead")).toBe(0);
    // Once it is there, everything goes, in order.
    way.setReady(async () => undefined);
    expect(await notifyPass(w.db, { config: config(HOOK_CONFIG), transport: way.transport })).toMatchObject({ sent: 3 });
  });

  it("delivers at least once: a pump that stopped after a delivery and before its cursor sends it again, with the same id", async () => {
    const w = await ownedRun();
    const way = fakeWay();
    const firstSeq = (await w.rt.journal.events("o1")).find((e) => e.type === "wait_opened")!.seq;
    let fail = true;
    const crashing: Db = {
      query: (async (sql: string, params?: unknown[]) => {
        if (fail && sql.includes("insert into notify_cursors") && params?.[2] === firstSeq) {
          fail = false;
          throw new Error("the process died");
        }
        return w.db.query(sql, params);
      }) as Db["query"],
      tx: (fn) => w.db.tx(fn),
      close: () => w.db.close(),
    };
    await expect(notifyPass(crashing, { config: config(HOOK_CONFIG), transport: way.transport })).rejects.toThrow("the process died");
    expect(way.calls).toHaveLength(1);
    await notifyPass(w.db, { config: config(HOOK_CONFIG), transport: way.transport });
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
    const [a, b] = await Promise.all([notifyPass(w.db, { config: c, transport: way.transport }), notifyPass(w.db, { config: c, transport: way.transport })]);
    expect(a.sent + b.sent).toBeGreaterThanOrEqual(3);
    expect(a.dead + b.dead).toBe(0);
    const got = bodies(way.calls);
    const firsts = got.filter((n, i) => got.findIndex((m) => m.id === n.id) === i);
    expect(firsts.map((n) => `${n.event} ${n.role}`)).toEqual(["wait_opened platform_lead", "wait_opened reviewer", "run_succeeded platform_lead"]);
    for (const n of got) expect({ ...n, as_of: null }).toEqual({ ...firsts.find((f) => f.id === n.id)!, as_of: null });
    expect(await cursor(w.db, "hook", "o1")).toBe((await w.rt.journal.events("o1")).at(-1)!.seq);
  });

  it("sends no event outside the S0 and S1 lists; asks_exhausted joins them once slice B3 gives it its class", () => {
    for (const [type, kind] of Object.entries(NOTIFIED)) {
      if (type === "asks_exhausted") expect(Object.hasOwn(EVENT_CLASSES, type), "B3 adds asks_exhausted to EVENT_CLASSES as S1; then this line goes").toBe(false);
      else expect(EVENT_CLASSES[type], type).toBe(kind === "decision" ? "S0" : "S1");
    }
    expect(Object.keys(NOTIFIED).sort()).toEqual(["amendment_requested", "asks_exhausted", "budget_exceeded", "review_escalated", "review_requested", "run_attention_required", "run_cancelled", "run_failed", "run_succeeded", "wait_opened"]);
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
    ew.up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    };
  });

  /** Runs `f` with the process's `fetch` replaced: every URL it is called with is recorded, and any but a proxy session's fails. */
  async function onlyThroughTheProxy<T>(f: () => Promise<T>): Promise<{ value: T; urls: string[] }> {
    const real = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error(`the adapter opened a connection of its own, to ${url}`);
      return real(input, init);
    }) as typeof fetch;
    try {
      return { value: await f(), urls };
    } finally {
      globalThis.fetch = real;
    }
  }

  const opts = (o: Partial<NotifyOptions> = {}): Omit<NotifyOptions, "config"> => ({ transport: egressTransport({ admin: ew.config.admin }), sleep: async () => undefined, ...o });

  it("is sent to the proxy's session and nowhere else; the proxy puts the secret in, the runtime holds a placeholder", async () => {
    const w = await ownedRun();
    const { value: r, urls } = await onlyThroughTheProxy(() => notifyPass(w.db, { config: config(HOOK_CONFIG), ...opts() }));
    expect(r).toEqual({ sent: 3, retried: 0, dead: 0, failures: [] });
    expect(urls).toHaveLength(3);
    expect(urls.every((u) => /^http:\/\/127\.0\.0\.1:\d+\/in$/.test(u))).toBe(true);
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

  it("would fail if the adapter sent the webhook its own way (the test of the test)", async () => {
    const { value } = await onlyThroughTheProxy(async () => {
      try {
        await fetch(HOOK, { method: "POST", body: "{}" });
        return "sent";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(value).toBe(`the adapter opened a connection of its own, to ${HOOK}`);
  });

  it("opens its session for the run's tenant and notify:<channel>: a halt of the tenant and a revocation of the channel cut it", async () => {
    const spec = config(HOOK_CONFIG).channels["hook"]! as { webhook: Parameters<typeof webhookNotifier>[1] };
    const t = egressTransport({ admin: ew.config.admin })();
    try {
      const acme = t.open("hook", spec.webhook, "acme");
      const beta = t.open("hook", spec.webhook, "beta");
      await acme.ready();
      expect((await acme.fetch(HOOK, { method: "POST", body: "{}" })).status).toBe(200);
      expect((await beta.fetch(HOOK, { method: "POST", body: "{}" })).status).toBe(200);
      // `revoke { tenant }` (a halt) cuts the tenant's notification session, and not the other tenant's.
      const cut = await ew.client.revoke({ tenant: "acme" });
      expect(cut).toEqual([expect.stringMatching(/^gw\.notify\.hook\.[0-9a-f]{16}$/)]);
      const denied = await acme.fetch(HOOK, { method: "POST", body: "{}" });
      expect(denied.headers.get("x-mandate-egress-denied")).toBe("session_revoked");
      await expect(acme.fetch(HOOK, { method: "POST", body: "{}" })).rejects.toThrow(/session_revoked/);
      expect((await beta.fetch(HOOK, { method: "POST", body: "{}" })).status).toBe(200);
      // `revoke { run: "notify:hook" }` cuts the channel's sessions.
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
    const r = await notifyPass(w.db, { config: config(HOOK_CONFIG), ...opts() });
    expect(r).toEqual({ sent: 0, retried: 0, dead: 3, failures: [] });
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
    await expect(notifyPass(w.db, { config: bad, ...opts() })).rejects.toMatchObject({ code: "bad_notification_channel" });
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
    const r = await notifyPass(w.db, { config: config(HOOK_CONFIG), ...opts({ onDead: (d) => told.push(JSON.stringify(d)), onFailure: (c, m) => told.push(`${c} ${m}`) }) });
    expect(r).toMatchObject({ sent: 0, dead: 3 });
    expect(ew.up.seen).toHaveLength(18);
    const rows = JSON.stringify(await w.db.query("select * from notify_dead"));
    for (const text of [rows, JSON.stringify(r), ...told]) {
      expect(text).not.toContain(HOOK_SECRET);
      expect(text).not.toMatch(/mdt-ph-/);
    }
    expect(rows).toContain("hooks.acme.example answered 500");
  });

  it("is no attempt when the proxy does not bind the credential to the webhook's host: the channel waits, nothing is given up", async () => {
    const w = await ownedRun();
    const r = await notifyPass(w.db, { config: config({ ...HOOK_CONFIG, channels: { hook: { webhook: { url: "https://other.acme.example/in", credential: "acme_hook" } } } }), ...opts() });
    expect(r.sent + r.dead).toBe(0);
    expect(r.failures).toEqual([{ channel: "hook", message: expect.stringMatching(/^egress_unavailable: .*does not bind credential acme_hook to other\.acme\.example/) }]);
    expect(ew.up.seen).toEqual([]);
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

  const M = "LEAKMARK";
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

  it("holds no marker planted in a run's inputs, steps, results, errors and questions, in either adapter or format, and exactly the fixed members", async () => {
    const items = [0, 1, 2].map((i) => inv(`${M}-invoice-${i}`, 1000, `${M}-vendor-${i}`));
    const w = await nworld(PROGRAM, "0.7", {
      ...Object.fromEntries(items.map((i) => [String(i["invoice_no"]), { ...i, total_cents: 1100, vendor_id: i["vendor_id"] }])),
      [`${M}-fails`]: { fail: `${M}-error: the matcher broke` },
    });
    const d = dir();
    mkdirSync(join(d, "out"));
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
    const notify = { config: c, transport: egressTransport({ admin: ew.config.admin }), sleep: async () => undefined };
    const pass = () => tickPass(w.db, { runtimeFor: async () => ({ rt: w.rt }), notify });

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
    await answer(w, "leak-ship", w.who.rex, `${M}-answer-2`);
    await pass();
    expect([(await w.rt.getRun("leak-review")).state, (await w.rt.getRun("leak-fail")).state, (await w.rt.getRun("leak-ship")).state]).toEqual(["succeeded", "failed", "succeeded"]);

    // The markers are in the journal: in requests, questions, results and errors.
    for (const type of ["wait_opened", "run_waiting", "run_succeeded", "run_failed"]) {
      expect(await count(w, "select count(*) as n from events where type = $1 and data::text like $2", [type, `%${M}%`]), type).toBeGreaterThan(0);
    }
    // And in the steps' results, as the journal's commands hold them.
    expect(await count(w, "select count(*) as n from commands where kind = 'delegate' and result::text like $1", [`%${M}%`])).toBeGreaterThan(0);

    // Everything either adapter emitted: each request the webhook's receiver got, whole, and the file, whole.
    const file = readFileSync(join(d, "out/notifications.jsonl"), "utf8");
    const requests = ew.up.seen.map((s) => ({ url: s.url, headers: s.headers.filter((_, i) => i % 2 === 0 || s.headers[i - 1]!.toLowerCase() !== "authorization"), body: s.body }));
    const emitted = [file, ...requests.map((r) => JSON.stringify(r))];
    for (const text of emitted) expect(text).not.toContain(M);

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
    // And it is not empty: every kind of event was told, through every adapter.
    expect(new Set(local.map((n) => n["event"]))).toEqual(new Set(["review_requested", "review_escalated", "run_succeeded", "run_failed", "wait_opened"]));
    expect(json.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(new Set(local.map((n) => n["run"]))).toEqual(new Set(["leak-review", "leak-fail", "leak-ship"]));
  });
});
